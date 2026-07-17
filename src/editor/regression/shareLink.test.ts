import { useCircuitStore } from "@store/circuitStore.js";
import {
  encodeSnapshot, decodeSnapshot, encodeSnapshotCompressed, decodeSnapshotCompressed,
} from "@store/persistence.js";
import { usePlotStore } from "@simulation/plotStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { createSpiceComponent, createSubcircuitComponent } from "@editor/componentFactory.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import type { Edge, Node } from "@xyflow/react";
import type { TestReport } from "./svgExport.test.js";

/**
 * A share link (and the QR code, which encodes the same URL) carries the circuit
 * as a compressed snapshot: `exportSnapshot` → deflate → base64url → hash, and
 * back through `loadFromSnapshot`. The contract is the same as for a saved file:
 * opening the link must restore every parameter, so that saving the reopened
 * circuit as `.asc` yields byte-identical output.
 *
 * The snapshot used to store `getProperties()`, which only lists the fields the
 * UI currently shows — a DC source saved no sine fields, so a phase set earlier
 * vanished — and it rebuilt a library part with the generic in/out/gnd ports, so
 * its edges no longer matched any port id and it came back disconnected.
 */

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> | void };

const st = () => useCircuitStore.getState();

/** The `.asc` the Save button would write for the current store state. */
const currentAsc = () =>
  LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags);

/** Place a component in a fresh circuit, mirroring what the editor does. */
function place(type: ComponentType, id: string, label: string, set: Record<string, string | number>, x: number) {
  const comp = createSpiceComponent(type, id, label, x, 0);
  const node: Node = { id, type: "component", position: { x, y: 0 }, data: { componentType: type, label } };
  st().addComponent(comp, node);
  // Go through the store, so node data (valueLabel, sourceType) is updated just
  // as it is when the user edits the properties panel.
  for (const [k, v] of Object.entries(set)) st().updateComponentProperty(id, k, v);
}

/** The circuit under test: one part of every kind that carries hidden state. */
function buildCircuit(): void {
  st().clearCircuit();
  place("isource", "i1", "I1", { sourceType: "Sine", sAmpl: 2, sFreq: 50, sPhi: 90, sTheta: 3, sTd: 0.01 }, 0);
  place("vsource", "v1", "V1", { sourceType: "DC", dcValue: 12, acAmplitude: 1, seriesR: 0.5, parallelC: 1e-9, showParasitics: "yes" }, 160);
  place("vsource", "v2", "V2", { sourceType: "Pulse", pV1: 1, pV2: 9, pTd: 2e-3, pTr: 1e-6, pTf: 2e-6, pPw: 3e-3, pPer: 8e-3 }, 320);
  place("zener", "d1", "D1", { model: "BZX55C5V1" }, 480);
  place("opamp", "u1", "U1", { model: "LM741" }, 640);
  place("resistor", "r1", "R1", { resistance: "{Rvar}" }, 800);

  // A library part: its own `.asy` symbol, `.subckt` body and external pins.
  const pins = ["GND", "TRIG", "OUT", "RESET"];
  const sub = createSubcircuitComponent("x1", "X1", 960, 0, ".subckt NE555 GND TRIG OUT RESET\n.ends", pins);
  st().addComponent(sub, {
    id: "x1", type: "component", position: { x: 960, y: 0 },
    data: { componentType: "subcircuit", label: "X1", pins, subName: "NE555", symbolName: "NE555" },
  });

  st().setEdges([
    { id: "e1", source: "i1", sourceHandle: "p", target: "r1", targetHandle: "p", type: "wire", data: { waypoints: [] } },
    { id: "e2", source: "x1", sourceHandle: "OUT", target: "r1", targetHandle: "n", type: "wire", data: { waypoints: [] } },
  ] as Edge[]);
  st().setSpiceDirectives(".param Rvar=1k\n.tran 1m");
  st().addDataFlag(10, 20, "V(out)");
}

const propsOf = (c?: SpiceComponent) =>
  Object.fromEntries((c?.getProperties() ?? []).map((p) => [p.key, p.value]));

const CASES: Case[] = [
  { name: "share link: reopening yields a byte-identical .asc", run: async (fail) => {
    buildCircuit();
    const asc = currentAsc();
    const snapshot = st().exportSnapshot();

    const reopened = await decodeSnapshotCompressed(await encodeSnapshotCompressed(snapshot));
    if (!reopened) { fail("compressed share payload did not decode"); return; }
    st().loadFromSnapshot(reopened);

    const asc2 = currentAsc();
    if (asc2 !== asc) {
      const a = asc.split("\n"), b = asc2.split("\n");
      const first = a.findIndex((l, i) => l !== b[i]);
      fail(`.asc differs after reopening the link (line ${first}): "${a[first]}" → "${b[first] ?? "(missing)"}"`);
    }
  } },

  { name: "share link: every component keeps all its properties", run: async (fail) => {
    buildCircuit();
    const before = new Map([...st().circuit.components].map(([id, c]) => [id, propsOf(c)]));
    const reopened = await decodeSnapshotCompressed(await encodeSnapshotCompressed(st().exportSnapshot()));
    st().loadFromSnapshot(reopened!);

    for (const [id, want] of before) {
      const got = propsOf(st().circuit.components.get(id));
      for (const [k, v] of Object.entries(want)) {
        if (String(got[k]) !== String(v)) fail(`${id}.${k}: ${v} → ${got[k] ?? "(lost)"}`);
      }
    }
  } },

  { name: "share link: netlist is unchanged (incl. library subcircuit pins)", run: async (fail) => {
    buildCircuit();
    st().rebuildConnections();
    const before = [...st().circuit.components.values()].map((c) => c.getNetlistLine()).join("\n");
    const reopened = await decodeSnapshotCompressed(await encodeSnapshotCompressed(st().exportSnapshot()));
    st().loadFromSnapshot(reopened!);
    st().rebuildConnections();
    const after = [...st().circuit.components.values()].map((c) => c.getNetlistLine()).join("\n");
    if (after !== before) fail(`netlist changed:\n    before: ${before}\n    after:  ${after}`);
    // The part's ports must be its own pins; the generic in/out/gnd trio would
    // match no edge handle and silently disconnect it.
    const x1 = st().circuit.components.get("x1");
    const ports = x1?.ports.map((p) => p.name).join(",");
    if (ports !== "GND,TRIG,OUT,RESET") fail(`subcircuit ports ${ports} != GND,TRIG,OUT,RESET`);
  } },

  { name: "share link: directives, data flags and the diagram name survive", run: async (fail) => {
    buildCircuit();
    st().setCircuitName("Astabile Kippstufe");
    const snapshot = st().exportSnapshot();
    const reopened = await decodeSnapshotCompressed(await encodeSnapshotCompressed(snapshot));
    st().loadFromSnapshot(reopened!);

    if (st().spiceDirectives !== ".param Rvar=1k\n.tran 1m") fail(`directives lost: ${JSON.stringify(st().spiceDirectives)}`);
    if (st().circuitName !== "Astabile Kippstufe") fail(`circuit name lost: ${st().circuitName}`);
    const df = st().dataFlags;
    if (df.length !== 1 || df[0].expr !== "V(out)" || df[0].x !== 10) fail(`data flags lost: ${JSON.stringify(df)}`);
    if (st().simulationConfig.type !== snapshot.simulationConfig.type) fail("simulation config lost");
  } },

  { name: "share link: named nets survive the reload", run: async (fail) => {
    buildCircuit();
    st().rebuildConnections();
    const netId = st().circuit.components.get("r1")?.ports[0]?.netId;
    if (!netId) { fail("R1 has no net after rebuild"); return; }
    st().renameNet(netId, "OUT");

    const reopened = await decodeSnapshotCompressed(await encodeSnapshotCompressed(st().exportSnapshot()));
    st().loadFromSnapshot(reopened!);
    // loadFromSnapshot rebuilds the nets and re-applies the names on the next
    // tick (net ids are only stable once the connections exist), so wait for it.
    await new Promise((r) => setTimeout(r, 0));
    // Port-anchored labels are re-applied on load (netLabelPorts).
    const port = st().circuit.components.get("r1")?.ports[0];
    const label = port?.netId ? st().circuit.nets.get(port.netId)?.nodeLabel : undefined;
    if (label !== "OUT") fail(`net name ${label} != OUT`);
  } },

  { name: "share link: the diagram (.plt) config survives the reload", run: async (fail) => {
    buildCircuit();
    // A non-default diagram: two panels, a custom axis, a colour and a function.
    usePlotStore.getState().importSettings({
      version: 1,
      panels: [{ id: "panel-0", yMin: -5, yMax: 5, yTicks: 4 }, { id: "panel-1", logX: true }],
      traceToPanel: { "V(out)": "panel-1" },
      colors: { "V(out)": "#ff8800" },
      expressions: ["V(a)-V(b)"],
      hiddenExpressions: ["V(a)-V(b)"],
      syncX: true,
      svgLight: true,
    });
    const reopened = await decodeSnapshotCompressed(await encodeSnapshotCompressed(st().exportSnapshot()));
    if (!reopened) { fail("compressed share payload did not decode"); return; }
    // Wipe the live plot store, then load — proving the config comes from the link.
    usePlotStore.getState().resetSettings();
    st().loadFromSnapshot(reopened);

    const s = usePlotStore.getState();
    if (s.panels.length !== 2) fail(`panels lost: ${JSON.stringify(s.panels)}`);
    if (s.panels[0]?.yMin !== -5 || s.panels[0]?.yMax !== 5) fail(`panel-0 y-bounds lost: ${JSON.stringify(s.panels[0])}`);
    if (s.panels[1]?.logX !== true) fail("panel-1 logX lost");
    if (s.traceToPanel["V(out)"] !== "panel-1") fail(`trace→panel lost: ${JSON.stringify(s.traceToPanel)}`);
    if (s.colors["V(out)"] !== "#ff8800") fail(`colour lost: ${JSON.stringify(s.colors)}`);
    if (!s.expressions.includes("V(a)-V(b)")) fail(`expression lost: ${JSON.stringify(s.expressions)}`);
    if (!s.hiddenExpressions.includes("V(a)-V(b)")) fail("hidden expression lost");
    if (s.syncX !== true) fail("syncX lost");
    if (s.svgLight !== true) fail("svgLight lost");
  } },

  { name: "share link: the active scope probes are restored (as pending)", run: async (fail) => {
    buildCircuit();
    // The scope the author left active — a mix of a resolved run and pending.
    useSimulationStore.getState().loadProbes(["v(out)", "@r1[i]"]);
    const reopened = await decodeSnapshotCompressed(await encodeSnapshotCompressed(st().exportSnapshot()));
    if (!reopened) { fail("compressed share payload did not decode"); return; }
    // A different circuit's scope is live before the load — it must be replaced.
    useSimulationStore.getState().loadProbes(["v(somethingelse)"]);
    st().loadFromSnapshot(reopened);

    const sim = useSimulationStore.getState();
    // No result yet, so they land in pendingProbes (resolved on the next run).
    const got = [...sim.pendingProbes].sort();
    if (JSON.stringify(got) !== JSON.stringify(["@r1[i]", "v(out)"])) {
      fail(`pending probes ${JSON.stringify(sim.pendingProbes)} != [@r1[i], v(out)]`);
    }
    if (sim.selectedVariables.length !== 0) fail(`selectedVariables should be empty before a run: ${JSON.stringify(sim.selectedVariables)}`);
  } },

  { name: "legacy (uncompressed) share links still open", run: (fail) => {
    buildCircuit();
    const asc = currentAsc();
    const reopened = decodeSnapshot(encodeSnapshot(st().exportSnapshot()));
    if (!reopened) { fail("plain base64 payload did not decode"); return; }
    st().loadFromSnapshot(reopened);
    if (currentAsc() !== asc) fail(".asc differs after reopening a legacy link");
  } },
];

export async function runShareLinkTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    await tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

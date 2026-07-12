import { useCircuitStore } from "@store/circuitStore.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Net-label consistency. A net's name exists in two places — the `NetLabel`
 * terminal placed on the schematic, and `Net.nodeLabel` — and they must never
 * disagree: `regenerateNetlist` re-imposes a terminal's label on its net, so a
 * rename that only touched `nodeLabel` was silently reverted on the next rebuild.
 *
 * Deleting a terminal must also not shred the net it sat on: an imported net is
 * routed as a star from its first pin, so when that pin is the label, *every*
 * wire of the net hangs off it and used to disappear with it.
 */

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> | void };

const st = () => useCircuitStore.getState();
const tick = () => new Promise((r) => setTimeout(r, 0));

// A wire with a net label (UB) on it and two resistors on the same net. The label
// is the *first* pin of that net, so the import hangs both wires off it.
// res pins sit at the symbol origin + (16, 16) and + (16, 96), so a symbol at
// y = 0 hangs its top terminal on the wire running along y = 16.
const ASC = `Version 4
SHEET 1 880 680
FLAG 16 16 UB
WIRE 16 16 128 16
WIRE 128 16 240 16
WIRE 128 96 240 96
SYMBOL res 112 0 R0
SYMATTR InstName R1
SYMATTR Value 1k
SYMBOL res 224 0 R0
SYMATTR InstName R2
SYMATTR Value 2k
`;

/** The net the given component's first pin sits on. */
const netOf = (label: string) => {
  const comp = [...st().circuit.components.values()].find((c) => c.label === label);
  const netId = comp?.ports[0]?.netId;
  return netId ? st().circuit.nets.get(netId) : undefined;
};

const netLabelNode = () => st().nodes.find((n) => (n.data as { componentType?: string }).componentType === "netlabel");

const CASES: Case[] = [
  { name: "deleting a net label keeps the wires it sat on", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    const label = netLabelNode();
    if (!label) { fail("no net label imported"); return; }
    const edgesBefore = st().edges.length;
    // The two resistors are on one net through the label — that must survive.
    const netBefore = netOf("R1")?.id;
    if (!netBefore || netOf("R2")?.id !== netBefore) { fail("R1/R2 not on one net before the delete"); return; }

    st().removeComponent(label.id);
    await tick();
    st().rebuildConnections();

    if (st().edges.length === 0) fail(`all ${edgesBefore} wires were deleted with the label`);
    const a = netOf("R1")?.id, b = netOf("R2")?.id;
    if (!a || a !== b) fail(`R1 (${a}) and R2 (${b}) fell apart when the label was deleted`);
  } },

  { name: "renaming the net renames its label terminal (no double bookkeeping)", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const net = netOf("R1");
    if (!net) { fail("R1 has no net"); return; }

    st().renameNet(net.id, "VCC");
    // The terminal carries the name, so it has to follow — otherwise the next
    // netlist rebuild imposes the *old* label again and the rename is lost.
    const comp = [...st().circuit.components.values()].find((c) => c.getNetLabel() !== null);
    if (comp?.label !== "VCC") fail(`the label terminal still reads "${comp?.label}", not VCC`);
    const node = netLabelNode();
    if ((node?.data as { label?: string })?.label !== "VCC") fail("the label on the canvas did not follow the rename");

    // And the rename must still be there after a rebuild.
    st().regenerateNetlist();
    if (netOf("R1")?.nodeLabel !== "VCC") fail(`the rename was reverted to "${netOf("R1")?.nodeLabel}" by the rebuild`);
    if (!st().netlist.includes("VCC")) fail("the netlist does not use the new name");
  } },

  { name: "renaming the terminal renames the net (the other direction)", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = netLabelNode();
    if (!label) { fail("no net label imported"); return; }

    st().updateComponentProperty(label.id, "label", "OUT");
    if (netOf("R1")?.nodeLabel !== "OUT") fail(`the net is called "${netOf("R1")?.nodeLabel}", not OUT`);
  } },

  { name: "naming a net creates a visible label (no invisible net names)", run: async (fail) => {
    // A name that lives only inside the net object is the shadow structure we do
    // not want: nothing on the schematic shows it, yet it drives the netlist.
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    // R1's *lower* pin is a plain, unnamed net.
    const r1 = [...st().circuit.components.values()].find((c) => c.label === "R1");
    const netId = r1?.ports[1]?.netId;
    if (!netId) { fail("R1 has no second net"); return; }
    const before = st().nodes.filter((n) => (n.data as { componentType?: string }).componentType === "netlabel").length;

    st().renameNet(netId, "MID");

    const after = st().nodes.filter((n) => (n.data as { componentType?: string }).componentType === "netlabel");
    if (after.length !== before + 1) fail(`naming the net did not add a label terminal (${before} → ${after.length})`);
    const created = after.find((n) => (n.data as { label?: string }).label === "MID");
    if (!created) fail("no terminal carries the new name");
    st().regenerateNetlist();
    if (st().circuit.nets.get(netId)?.nodeLabel !== "MID") fail("the name did not survive a netlist rebuild");
  } },

  { name: "deleting the label takes the net's name with it", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = netLabelNode();
    if (!label) { fail("no net label imported"); return; }
    const netId = netOf("R1")?.id;
    if (netId === undefined) { fail("R1 has no net"); return; }
    if (netOf("R1")?.nodeLabel !== "UB") fail(`the net is not called UB but ${netOf("R1")?.nodeLabel}`);

    st().removeComponent(label.id);
    await tick();
    st().rebuildConnections();

    // The name must be gone with the symbol — a nameless net falls back to its id.
    const net = netOf("R1");
    if (net?.nodeLabel === "UB") fail("the net kept the name UB although its label is gone");
    st().regenerateNetlist();
    if (st().netlist.includes(" UB ")) fail("the netlist still uses the deleted label's name");
  } },

  { name: "a wire's net resolves to exactly one net (what the panel shows)", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    // The panel resolves the selected wire's net through its source port — the
    // same lookup, so a wire can only ever surface a single label field.
    for (const e of st().edges) {
      const comp = st().circuit.components.get(e.source);
      const port = comp?.ports.find((p) => p.id === `${e.source}-${e.sourceHandle}`);
      if (!port?.netId) fail(`wire ${e.id} does not resolve to a net`);
    }
  } },
];

export async function runNetLabelTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    await tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

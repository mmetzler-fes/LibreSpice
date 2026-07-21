import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { createSpiceComponent, nextComponentId } from "@editor/componentFactory.js";
import type { ComponentNodeData, ComponentType } from "@editor/nodes/ComponentNode.js";
import type { Node, Edge } from "@xyflow/react";
import type { PortType } from "@core/components/special/Special.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Net labels and net connectors must survive a save and a re-open.
 *
 * The existing `ASC examples round-trip` suite deliberately skips them — its
 * `isDevice` filter drops every `netlabel_*` id, because those terminals are
 * re-materialised from FLAG lines and legitimately change identity on the way.
 * That left the terminals themselves untested: a label could vanish entirely on
 * save and every one of those checks would still pass.
 *
 * The case that matters most is a terminal on a pin that is otherwise
 * unconnected — naming a dangling output, which is exactly what you do to probe
 * it. Nothing else holds that net together, so if the terminal is dropped the
 * net disappears with it.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> };

/** Place a component and return its node. */
function place(type: ComponentType, label: string, x: number, y: number, extra: Partial<ComponentNodeData> = {}): Node {
  const id = nextComponentId(type, st().nodes.map((n) => n.id));
  const component = createSpiceComponent(type, id, label, x, y);
  const node: Node = {
    id,
    type: "component",
    position: { x, y },
    data: { componentType: type, label, ...extra } as ComponentNodeData,
  };
  st().addComponent(component, node);
  return node;
}

/** Wire two pins together. */
function connect(a: Node, aHandle: string, b: Node, bHandle: string): void {
  const edge: Edge = {
    id: `edge_${a.id}_${b.id}`,
    source: a.id, sourceHandle: aHandle,
    target: b.id, targetHandle: bHandle,
    type: "wire", data: { waypoints: [] },
  };
  st().setEdges([...st().edges, edge]);
  st().connectPorts(`${a.id}-${aHandle}`, `${b.id}-${bHandle}`);
}

/** Every net terminal in the store, as `name|type|portType`, sorted. */
function terminals(): string[] {
  return st().nodes
    .filter((n) => {
      const t = (n.data as ComponentNodeData).componentType;
      return t === "netlabel" || t === "netconnector";
    })
    .map((n) => {
      const d = n.data as ComponentNodeData;
      return `${d.label}|${d.componentType}|${d.portType ?? "-"}`;
    })
    .sort();
}

/** Save to `.asc` and read it back, exactly as the app's Save→Open does. */
async function roundTrip(): Promise<string> {
  const asc = LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags);
  st().clearCircuit();
  st().loadFromAsc(asc);
  await tick();
  await tick();
  return asc;
}

/**
 * A voltage source with a net terminal on its lower pin and nothing else
 * attached — the "named dangling output" shape.
 *
 * A source rather than a resistor on purpose: the regression harness loads no
 * `.asy` symbols (see scripts/glob-shim.js), so parts that draw from one have no
 * pins here at all. The sources and ground are drawn by hand and keep their pins
 * either way, which makes them the only reliable parts to build a fixture from.
 */
async function danglingTerminal(type: "netlabel" | "netconnector", name: string, portType?: PortType) {
  st().clearCircuit();
  await tick();
  const v = place("vsource", "V1", 200, 200);
  const term = place(type, name, 200, 320, portType ? { portType } : {});
  // Dock the terminal onto the source's negative pin via a real wire, as the
  // canvas does when a label is dropped on a pin.
  connect(v, "n", term, "t");
  st().rebuildConnections();
  await tick();
}

const CASES: Case[] = [
  {
    name: "a net label on an otherwise unconnected pin survives a save",
    run: async (fail) => {
      await danglingTerminal("netlabel", "Q4");
      const before = terminals();
      if (before.length !== 1) return fail(`setup produced ${before.length} terminals: ${before.join(", ")}`);
      await roundTrip();
      const after = terminals();
      if (after.join() !== before.join()) fail(`before: [${before.join(", ")}] after: [${after.join(", ")}]`);
    },
  },
  {
    name: "a net connector on an otherwise unconnected pin survives a save",
    run: async (fail) => {
      await danglingTerminal("netconnector", "OUT", "Out");
      const before = terminals();
      if (before.length !== 1) return fail(`setup produced ${before.length} terminals: ${before.join(", ")}`);
      await roundTrip();
      const after = terminals();
      if (after.join() !== before.join()) fail(`before: [${before.join(", ")}] after: [${after.join(", ")}]`);
    },
  },
  {
    name: "the connector's port type survives a save",
    run: async (fail) => {
      for (const pt of ["In", "Out", "BiDir"] as PortType[]) {
        await danglingTerminal("netconnector", `P_${pt}`, pt);
        await roundTrip();
        const after = terminals();
        if (!after.some((t) => t.endsWith(`|netconnector|${pt}`))) {
          fail(`port type ${pt} came back as [${after.join(", ")}]`);
        }
      }
    },
  },
  {
    name: "a terminal between two parts survives a save",
    run: async (fail) => {
      // The easy case, which the exporter has always handled: the net exists
      // independently of the label. Here to tell a general loss apart from one
      // specific to dangling terminals.
      st().clearCircuit();
      await tick();
      const v1 = place("vsource", "V1", 200, 200);
      const v2 = place("vsource", "V2", 400, 200);
      const term = place("netlabel", "MID", 300, 200);
      connect(v1, "n", term, "t");
      connect(term, "t", v2, "n");
      st().rebuildConnections();
      await tick();
      const before = terminals();
      await roundTrip();
      const after = terminals();
      if (after.join() !== before.join()) fail(`before: [${before.join(", ")}] after: [${after.join(", ")}]`);
    },
  },
  {
    name: "two terminals sharing a name both survive a save",
    run: async (fail) => {
      // Same-named labels are how distant parts are joined without a wire; if
      // the import collapses them to one, the connection they encode is lost.
      st().clearCircuit();
      await tick();
      const v1 = place("vsource", "V1", 200, 200);
      const v2 = place("vsource", "V2", 600, 200);
      const t1 = place("netlabel", "VBUS", 200, 320);
      const t2 = place("netlabel", "VBUS", 600, 320);
      connect(v1, "n", t1, "t");
      connect(v2, "n", t2, "t");
      st().rebuildConnections();
      await tick();
      const before = terminals();
      if (before.length !== 2) return fail(`setup produced ${before.length} terminals`);
      await roundTrip();
      const after = terminals();
      if (after.length !== 2) fail(`expected 2 terminals, got ${after.length}: [${after.join(", ")}]`);
    },
  },
  {
    // The reported case: the last flip-flop of the counter has an unused Q, and
    // naming it is how you get it onto the scope. Built from a flip-flop rather
    // than a source because the loss may well depend on the part — its pins come
    // from a different table than a two-terminal part's.
    name: "a net label on a flip-flop's unused Q survives a save",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const ff = place("dff", "U1", 300, 300, { kind: "dff", edge: "rising", asyncPolarity: "high" });
      const term = place("netlabel", "Q4", 300, 200);
      connect(ff, "q", term, "t");
      st().rebuildConnections();
      await tick();
      const before = terminals();
      if (before.length !== 1) return fail(`setup produced ${before.length} terminals: ${before.join(", ")}`);
      const asc = await roundTrip();
      const after = terminals();
      if (after.join() !== before.join()) {
        fail(`before: [${before.join(", ")}] after: [${after.join(", ")}]\n${asc}`);
      }
    },
  },
  {
    name: "the saved file actually carries a FLAG for every terminal",
    run: async (fail) => {
      // One level below the round trip: if the FLAG is missing from the file,
      // no importer could bring the terminal back, and the loss is the
      // exporter's. If it is present but the terminal does not return, the
      // parser is at fault. Splitting the two makes the failure say which.
      await danglingTerminal("netlabel", "Q4");
      const asc = LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags);
      if (!/^FLAG\s+-?\d+\s+-?\d+\s+Q4$/m.test(asc)) {
        fail(`no "FLAG x y Q4" line in the export:\n${asc}`);
      }
    },
  },
];

export async function runNetTerminalRoundTripTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    await c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}

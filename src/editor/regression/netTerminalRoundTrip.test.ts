import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { createSpiceComponent, nextComponentId } from "@editor/componentFactory.js";
import { getNodePins } from "@editor/pinGeometry.js";
import type { ComponentNodeData, ComponentType } from "@editor/nodes/ComponentNode.js";
import type { Node, Edge } from "@xyflow/react";
import type { PortType } from "@core/components/special/Special.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Names must survive a save and a re-open.
 *
 * The `ASC examples round-trip` suite cannot see this: it compares *devices*, and
 * a name is not one — a schematic could lose every name it has and every check
 * there would still pass.
 *
 * The case that matters most is a name on a pin that is otherwise unconnected —
 * naming a dangling output, which is exactly what you do to probe it. Nothing
 * else holds that net together: before names became coordinates the label node
 * was the net's only other member, and now the name is the only reason the net
 * exists at all (see rebuildConnections). If it is dropped, the net goes with it.
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

/** Where a pin sits on the sheet — where a name has to land to name it. */
function pinAt(node: Node, handle: string): { x: number; y: number } {
  const p = getNodePins(st().nodes.find((n) => n.id === node.id) ?? node).find((q) => q.handleId === handle);
  if (!p) throw new Error(`${node.id} has no pin ${handle}`);
  return { x: p.x, y: p.y };
}

/** Put a name on a component's pin, as dropping one from the palette does. */
function nameAt(node: Node, handle: string, name: string, portType?: PortType): string {
  const p = pinAt(node, handle);
  return st().addNetAnchor(p.x, p.y, name, portType);
}

/** Every name on the sheet, as `name|portType`, sorted. */
function names(): string[] {
  return st().netAnchors.map((a) => `${a.name}|${a.portType ?? "-"}`).sort();
}

/** Save to `.asc` and read it back, exactly as the app's Save→Open does. */
async function roundTrip(): Promise<string> {
  const asc = exportAsc();
  st().clearCircuit();
  st().loadFromAsc(asc);
  await tick();
  await tick();
  return asc;
}

function exportAsc(): string {
  const s = st();
  return LTSpiceExporter.export(s.nodes, s.edges, s.spiceDirectives, s.circuit, s.dataFlags, [], [], { anchors: s.netAnchors });
}

/**
 * A voltage source with a name on its lower pin and nothing else attached — the
 * "named dangling output" shape.
 *
 * A source rather than a resistor on purpose: the regression harness loads no
 * `.asy` symbols (see scripts/glob-shim.js), so parts that draw from one have no
 * pins here at all. The sources and ground are drawn by hand and keep their pins
 * either way, which makes them the only reliable parts to build a fixture from.
 */
async function danglingName(name: string, portType?: PortType) {
  st().clearCircuit();
  await tick();
  const v = place("vsource", "V1", 200, 200);
  nameAt(v, "n", name, portType);
  st().rebuildConnections();
  await tick();
}

const CASES: Case[] = [
  {
    name: "a name on an otherwise unconnected pin survives a save",
    run: async (fail) => {
      await danglingName("Q4");
      const before = names();
      if (before.length !== 1) return fail(`setup produced ${before.length} names: ${before.join(", ")}`);
      await roundTrip();
      const after = names();
      if (after.join() !== before.join()) fail(`before: [${before.join(", ")}] after: [${after.join(", ")}]`);
    },
  },
  {
    name: "a connector on an otherwise unconnected pin survives a save",
    run: async (fail) => {
      await danglingName("OUT", "Out");
      const before = names();
      if (before.length !== 1) return fail(`setup produced ${before.length} names: ${before.join(", ")}`);
      await roundTrip();
      const after = names();
      if (after.join() !== before.join()) fail(`before: [${before.join(", ")}] after: [${after.join(", ")}]`);
    },
  },
  {
    name: "the connector's port type survives a save",
    run: async (fail) => {
      for (const pt of ["In", "Out", "BiDir"] as PortType[]) {
        await danglingName(`P_${pt}`, pt);
        await roundTrip();
        const after = names();
        if (!after.some((t) => t.endsWith(`|${pt}`))) fail(`port type ${pt} came back as [${after.join(", ")}]`);
      }
    },
  },
  {
    name: "a name between two parts survives a save",
    run: async (fail) => {
      // The easy case: the net exists independently of the name. Here to tell a
      // general loss apart from one specific to dangling names.
      st().clearCircuit();
      await tick();
      const v1 = place("vsource", "V1", 200, 200);
      const v2 = place("vsource", "V2", 400, 200);
      connect(v1, "n", v2, "n");
      st().rebuildConnections();
      await tick();
      nameAt(v1, "n", "MID");
      st().rebuildConnections();
      await tick();
      const before = names();
      await roundTrip();
      const after = names();
      if (after.join() !== before.join()) fail(`before: [${before.join(", ")}] after: [${after.join(", ")}]`);
    },
  },
  {
    name: "two names reading the same thing both survive a save",
    run: async (fail) => {
      // Same-named flags are how distant parts are joined without a wire; if the
      // import collapses them to one, the connection they encode is lost.
      st().clearCircuit();
      await tick();
      const v1 = place("vsource", "V1", 200, 200);
      const v2 = place("vsource", "V2", 600, 200);
      nameAt(v1, "n", "VBUS");
      nameAt(v2, "n", "VBUS");
      st().rebuildConnections();
      await tick();
      const before = names();
      if (before.length !== 2) return fail(`setup produced ${before.length} names`);
      await roundTrip();
      const after = names();
      if (after.length !== 2) fail(`expected 2 names, got ${after.length}: [${after.join(", ")}]`);
    },
  },
  {
    // The reported case: the last flip-flop of the counter has an unused Q, and
    // naming it is how you get it onto the scope. Built from a flip-flop rather
    // than a source because the loss may well depend on the part — its pins come
    // from a different table than a two-terminal part's.
    name: "a name on a flip-flop's unused Q survives a save",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const ff = place("dff", "U1", 300, 300, { kind: "dff", edge: "rising", asyncPolarity: "high" });
      nameAt(ff, "q", "Q4");
      st().rebuildConnections();
      await tick();
      const before = names();
      if (before.length !== 1) return fail(`setup produced ${before.length} names: ${before.join(", ")}`);
      const asc = await roundTrip();
      const after = names();
      if (after.join() !== before.join()) fail(`before: [${before.join(", ")}] after: [${after.join(", ")}]\n${asc}`);
    },
  },
  {
    // A net may carry several names, and LTSpice files do: `leitungstest.asc` has
    // `x1` and `x2` on one net and the connectors `nc1`/`nc2` on another. This
    // used to make the newcomer adopt the existing name, which read well on
    // screen but rewrote the user's file the moment it was opened.
    name: "a second name on a net keeps its own text, the net keeps the first",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const v = place("vsource", "V1", 200, 200);
      nameAt(v, "n", "N9");
      st().rebuildConnections();
      await tick();
      // Now name the same net a second time, as adding a probe point does.
      nameAt(v, "n", "Q4");
      st().rebuildConnections();
      await tick();

      const before = names();
      if (before.join() !== "N9|-,Q4|-") return fail(`a name was lost: [${before.join(", ")}]`);
      // The netlist needs one node name, and it must be the one that was there
      // first — the original complaint was a net losing its name to a newcomer.
      const netId = st().circuit.components.get(v.id)?.ports.find((p) => p.id.endsWith("-n"))?.netId;
      const netName = netId ? st().circuit.nets.get(netId)?.nodeLabel : undefined;
      if (netName !== "N9") return fail(`the net should still be called N9, not ${netName}`);

      await roundTrip();
      const after = names();
      if (after.join() !== before.join()) fail(`before: [${before.join(", ")}] after: [${after.join(", ")}]`);
    },
  },
  {
    name: "renaming the net rewrites the winning name and leaves the alias alone",
    run: async (fail) => {
      // The counterpart of the case above: aliases are the author's, so a rename
      // touches the one name that is actually in the netlist and nothing else.
      st().clearCircuit();
      await tick();
      const v = place("vsource", "V1", 200, 200);
      nameAt(v, "n", "N9");
      nameAt(v, "n", "ALIAS");
      st().rebuildConnections();
      await tick();
      const netId = st().circuit.components.get(v.id)?.ports.find((p) => p.id.endsWith("-n"))?.netId;
      if (!netId) return fail("the names ended up on no net");
      st().renameNet(netId, "VOUT");
      await tick();
      st().rebuildConnections();
      await tick();

      const after = names();
      if (after.join() !== "ALIAS|-,VOUT|-") fail(`expected [ALIAS, VOUT], got [${after.join(", ")}]`);
    },
  },
  {
    name: "a wire never carries a name of its own",
    run: async (fail) => {
      // There used to be two ways to show a net's name — a terminal, or the wire
      // itself — and a net with both said it twice. Only one remains, and this is
      // what says so: nothing about a name is stored on an edge.
      st().clearCircuit();
      await tick();
      const v = place("vsource", "V1", 200, 200);
      const w = place("vsource", "V2", 400, 200);
      connect(v, "n", w, "n");
      nameAt(v, "n", "N9");
      st().rebuildConnections();
      await tick();
      const dirty = st().edges.filter((e) => {
        const d = (e.data ?? {}) as Record<string, unknown>;
        return d.netName !== undefined || d.showLabel !== undefined;
      });
      if (dirty.length > 0) fail(`${dirty.length} wire(s) carry a name of their own`);
    },
  },
  {
    // Reported: putting a connector on a named wire wiped the wire's name and
    // replaced it with the next free NET1 — exactly the wrong way round. The name
    // belongs to the net, and one dropped on it is there to read it.
    name: "a name dropped on a named net does not steal the net's name",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const v = place("vsource", "V1", 200, 200);
      const r = place("vsource", "V2", 400, 200);
      connect(v, "n", r, "n");
      st().rebuildConnections();
      await tick();

      const netId = st().circuit.components.get(v.id)?.ports.find((p) => p.id.endsWith("-n"))?.netId;
      if (!netId) return fail("the two sources ended up on no net");
      st().renameNet(netId, "UB");
      await tick();

      // Now drop a connector on that net.
      nameAt(v, "n", "PORT1", "Out");
      st().rebuildConnections();
      await tick();

      // The connector keeping its own `PORT1` is not the bug; it is what LTSpice
      // does, and overwriting it would destroy a name in the file.
      const all = names();
      if (!all.some((n) => n.startsWith("UB|"))) fail(`the net's own name is gone: [${all.join(", ")}]`);
      if (!all.includes("PORT1|Out")) fail(`the connector lost its own name: [${all.join(", ")}]`);
      const net = st().circuit.nets.get(
        st().circuit.components.get(v.id)!.ports.find((p) => p.id.endsWith("-n"))!.netId!,
      );
      if (net?.nodeLabel !== "UB") fail(`the net lost its name, now "${net?.nodeLabel}"`);
    },
  },
  {
    // The whole point of placing a flag on rename: a name typed on a wire used to
    // live nowhere the file could hold it, so it was gone after a save.
    name: "a name given in the properties panel survives a save",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const a = place("vsource", "V1", 200, 200);
      const b = place("vsource", "V2", 400, 200);
      connect(a, "n", b, "n");
      st().rebuildConnections();
      await tick();
      const netId = st().circuit.components.get(a.id)!.ports.find((p) => p.id.endsWith("-n"))!.netId!;
      st().renameNet(netId, "UB");
      await tick();

      const asc = exportAsc();
      if (!/^FLAG\s+-?\d+\s+-?\d+\s+UB$/m.test(asc)) return fail(`the name never reached the file:\n${asc}`);
      st().clearCircuit();
      st().loadFromAsc(asc);
      await tick();
      await tick();
      if (![...st().circuit.nets.values()].some((n) => n.nodeLabel === "UB")) {
        fail("the name did not come back after a reload");
      }
    },
  },
  {
    name: "clearing the name removes the flag again",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const a = place("vsource", "V1", 200, 200);
      const b = place("vsource", "V2", 400, 200);
      connect(a, "n", b, "n");
      st().rebuildConnections();
      await tick();
      const netId = () => st().circuit.components.get(a.id)!.ports.find((p) => p.id.endsWith("-n"))!.netId!;
      st().renameNet(netId(), "UB");
      await tick();
      if (names().length !== 1) return fail(`naming placed ${names().length} flags, expected 1`);
      // Back to the auto id: the tag says nothing now, so it goes.
      const id = netId();
      st().renameNet(id, id);
      await tick();
      if (names().length !== 0) fail(`clearing left ${names().length} flag(s): [${names().join(", ")}]`);
    },
  },
  {
    name: "the saved file actually carries a FLAG for every name",
    run: async (fail) => {
      // One level below the round trip: if the FLAG is missing from the file, no
      // importer could bring the name back, and the loss is the exporter's. If it
      // is present but the name does not return, the parser is at fault.
      // Splitting the two makes the failure say which.
      await danglingName("Q4");
      const asc = exportAsc();
      if (!/^FLAG\s+-?\d+\s+-?\d+\s+Q4$/m.test(asc)) fail(`no "FLAG x y Q4" line in the export:\n${asc}`);
    },
  },
];

export async function runNetTerminalRoundTripTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const c of CASES) {
    let f = false;
    await c.run((reason) => { if (!f) { f = true; failures.push({ name: c.name, reason }); } });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

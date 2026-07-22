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
    // The reported loss. A net carries one name; a second terminal on it used to
    // claim the net for itself, and whichever claim was applied last renamed the
    // other. After a save/reload the label you had added came back under a
    // different name — indistinguishable from having vanished.
    // A second name on a net does not displace the first, and does not lose
    // itself either. Both are kept, as LTSpice keeps them: `leitungstest.asc`,
    // drawn in LTSpice, carries `x1` and `x2` on one net and two connectors
    // `nc1`/`nc2` on another. This used to make the newcomer adopt the existing
    // name, which read well on screen but rewrote the user's file the moment it
    // was opened — the second name was simply gone.
    name: "a second terminal on a net keeps its own name, the net keeps the first",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const v = place("vsource", "V1", 200, 200);
      const first = place("netlabel", "N9", 200 + 80, 300);
      connect(v, "n", first, "t");
      st().rebuildConnections();
      await tick();
      // Now name the same net a second time, as adding a probe point does.
      const second = place("netlabel", "Q4", 200 - 80, 300);
      connect(v, "n", second, "t");
      st().rebuildConnections();
      await tick();

      const before = terminals();
      if (before.join() !== "N9|netlabel|-,Q4|netlabel|-") {
        return fail(`a terminal lost its own name: [${before.join(", ")}]`);
      }
      // The netlist needs one node name, and it must be the one that was there
      // first — the original complaint was a net losing its name to a newcomer.
      const netId = st().circuit.components.get(v.id)?.ports.find((p) => p.id.endsWith("-n"))?.netId;
      const netName = netId ? st().circuit.nets.get(netId)?.nodeLabel : undefined;
      if (netName !== "N9") return fail(`the net should still be called N9, not ${netName}`);

      await roundTrip();
      const after = terminals();
      if (after.join() !== before.join()) fail(`before: [${before.join(", ")}] after: [${after.join(", ")}]`);
    },
  },
  {
    name: "renaming a terminal renames the net and every other terminal on it",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const v = place("vsource", "V1", 200, 200);
      const a = place("netlabel", "N9", 280, 300);
      const b = place("netlabel", "N9", 120, 300);
      connect(v, "n", a, "t");
      connect(v, "n", b, "t");
      st().rebuildConnections();
      await tick();
      const netId = st().circuit.components.get(a.id)?.ports[0]?.netId;
      if (!netId) return fail("the terminal ended up on no net");
      st().renameNet(netId, "VOUT");
      await tick();
      const after = terminals();
      if (after.join() !== "VOUT|netlabel|-,VOUT|netlabel|-") {
        fail(`renaming did not reach both terminals: [${after.join(", ")}]`);
      }
      if (st().circuit.nets.get(netId)?.nodeLabel !== "VOUT") {
        fail(`the net kept the name ${st().circuit.nets.get(netId)?.nodeLabel}`);
      }
    },
  },
  {
    name: "a net with a terminal does not also show its name on the wire",
    run: async (fail) => {
      // Two ways to show a net's name exist on purpose — a net without a
      // terminal carries it on the wire — but a net with both showed it twice.
      st().clearCircuit();
      await tick();
      const v = place("vsource", "V1", 200, 200);
      const term = place("netlabel", "N9", 280, 300);
      connect(v, "n", term, "t");
      st().setEdges(st().edges.map((e) => ({ ...e, data: { ...e.data, netName: "N9", showLabel: true } })));
      st().rebuildConnections();
      await tick();
      const shown = st().edges.filter((e) => (e.data as { showLabel?: boolean }).showLabel);
      if (shown.length > 0) fail(`${shown.length} wire(s) still show the name next to the terminal`);
    },
  },
  {
    // Reported: putting a connector on a named wire wiped the wire's name and
    // replaced it with the next free NET1 — exactly the wrong way round. The
    // name belongs to the net, and a terminal dropped on it is there to read it.
    name: "a terminal dropped on a named net adopts that name",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const v = place("vsource", "V1", 200, 200);
      const r = place("vsource", "V2", 400, 200);
      connect(v, "n", r, "n");
      st().rebuildConnections();
      await tick();

      // Name the wire, as the wire properties panel does.
      const netId = st().circuit.components.get(v.id)?.ports.find((p) => p.id.endsWith("-n"))?.netId;
      if (!netId) return fail("the two sources ended up on no net");
      st().renameNet(netId, "UB");
      await tick();

      // Now drop a connector on that net.
      const term = place("netconnector", "PORT1", 300, 320, { portType: "Out" });
      connect(v, "n", term, "t");
      st().rebuildConnections();
      await tick();

      // What was reported is that the *net* lost its name: dropping the connector
      // replaced `UB` with the next free `NET1`. That must not happen — the name
      // belongs to the net, and the terminal that was there first defines it.
      // The connector keeping its own `PORT1` is not the bug; it is what LTSpice
      // does, and overwriting it would destroy a name in the file.
      const names = terminals();
      if (!names.some((n) => n.startsWith("UB|"))) {
        fail(`the net's own label is gone: [${names.join(", ")}]`);
      }
      if (!names.some((n) => n === "PORT1|netconnector|Out")) {
        fail(`the connector lost its own name: [${names.join(", ")}]`);
      }
      const net = st().circuit.nets.get(
        st().circuit.components.get(v.id)!.ports.find((p) => p.id.endsWith("-n"))!.netId!,
      );
      if (net?.nodeLabel !== "UB") fail(`the net lost its name, now "${net?.nodeLabel}"`);
    },
  },
  {
    name: "renaming the terminal afterwards still takes",
    run: async (fail) => {
      // The wire name outranks a terminal on every rebuild, so a later rename has
      // to reach the wire too — otherwise the next rebuild quietly undoes it.
      st().clearCircuit();
      await tick();
      const v = place("vsource", "V1", 200, 200);
      const r = place("vsource", "V2", 400, 200);
      connect(v, "n", r, "n");
      st().rebuildConnections();
      await tick();
      const netId = st().circuit.components.get(v.id)!.ports.find((p) => p.id.endsWith("-n"))!.netId!;
      st().renameNet(netId, "UB");
      await tick();
      const term = place("netlabel", "NET1", 300, 320);
      connect(v, "n", term, "t");
      st().rebuildConnections();
      await tick();

      const nid2 = st().circuit.components.get(v.id)!.ports.find((p) => p.id.endsWith("-n"))!.netId!;
      st().renameNet(nid2, "VCC");
      await tick();
      st().rebuildConnections();
      await tick();
      const names = terminals();
      if (!names.length || !names.every((n) => n.startsWith("VCC|"))) {
        fail(`after renaming: [${names.join(", ")}], all should read VCC`);
      }
      const net = st().circuit.nets.get(
        st().circuit.components.get(v.id)!.ports.find((p) => p.id.endsWith("-n"))!.netId!,
      );
      if (net?.nodeLabel !== "VCC") fail(`the net fell back to "${net?.nodeLabel}"`);
    },
  },
  {
    // The whole point of placing a label on rename: a name typed on a wire used
    // to live nowhere the file could hold it, so it was gone after a save.
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

      const asc = LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags);
      if (!/^FLAG\s+-?\d+\s+-?\d+\s+UB$/m.test(asc)) {
        return fail(`the name never reached the file:\n${asc}`);
      }
      st().clearCircuit();
      st().loadFromAsc(asc);
      await tick();
      await tick();
      const back = [...st().circuit.nets.values()].some((n) => n.nodeLabel === "UB");
      if (!back) fail("the name did not come back after a reload");
    },
  },
  {
    name: "clearing the name removes the label again",
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
      if (terminals().length !== 1) return fail(`naming placed ${terminals().length} labels, expected 1`);
      // Back to the auto id: the tag says nothing now, so it goes.
      const id = netId();
      st().renameNet(id, id);
      await tick();
      if (terminals().length !== 0) fail(`clearing left ${terminals().length} label(s): [${terminals().join(", ")}]`);
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

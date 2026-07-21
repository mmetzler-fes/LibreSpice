import { useCircuitStore } from "@store/circuitStore.js";
import { createSpiceComponent, nextComponentId } from "@editor/componentFactory.js";
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

// V1 in series with R1, the bottom rail grounded (the flag sits on V1's − pin).
const ASC_GND = `Version 4
SHEET 1 880 680
FLAG 16 96 0
WIRE 16 16 128 16
WIRE 16 96 128 96
SYMBOL voltage 16 0 R0
SYMATTR InstName V1
SYMATTR Value 5
SYMBOL res 112 0 R0
SYMATTR InstName R1
SYMATTR Value 1k
`;

/**
 * The device lines of the netlist, with the auto-generated net ids canonicalised
 * (a rebuild renumbers them, which says nothing about connectivity). "V1 net7 0"
 * and "V1 net9 0" are the same circuit — this makes them compare equal.
 */
const devices = () => {
  const seen = new Map<string, string>();
  return st().netlist
    .split("\n")
    .filter((l) => /^[RCVLID]\w*\s/i.test(l))
    .join(" | ")
    .replace(/\bnet\d+\b/g, (m) => {
      if (!seen.has(m)) seen.set(m, `n${seen.size + 1}`);
      return seen.get(m)!;
    });
};

const CASES: Case[] = [
  { name: "a net label on the ground net (named GND) changes nothing, and deletes cleanly", run: async (fail) => {
    st().loadFromAsc(ASC_GND);
    await tick();
    st().rebuildConnections();
    const before = devices();

    // Hang a label named GND straight onto the ground terminal.
    const gnd = [...st().circuit.components.values()].find((c) => c.id.startsWith("ground_"));
    if (!gnd) { fail("no ground imported"); return; }
    const id = nextComponentId("netlabel", st().nodes.map((n) => n.id));
    st().addComponent(createSpiceComponent("netlabel", id, "GND", 0, 0), {
      id, type: "component", position: { x: 0, y: 0 }, data: { componentType: "netlabel", label: "GND" },
    });
    st().setEdges([...st().edges, {
      id: `w_${id}`, source: id, sourceHandle: "t", target: gnd.id, targetHandle: "gnd", type: "wire", data: {},
    }]);
    st().rebuildConnections();
    if (devices() !== before) fail(`the netlist changed:\n    before: ${before}\n    after:  ${devices()}`);

    // …and removing it again leaves the circuit exactly as it was.
    st().removeComponent(id);
    await tick();
    st().rebuildConnections();
    if (devices() !== before) fail(`deleting the GND label changed the netlist: ${devices()}`);
  } },

  { name: "naming a net GND grounds it (no second node called GND)", run: async (fail) => {
    st().loadFromAsc(ASC_GND);
    await tick();
    st().rebuildConnections();
    const r1 = [...st().circuit.components.values()].find((c) => c.label === "R1");
    const top = r1?.ports[0]?.netId;
    if (!top || top === "0") { fail("R1's top pin is not on a floating net"); return; }

    st().renameNet(top, "GND");
    await tick();               // the merge happens on the rebuild renameNet schedules
    st().rebuildConnections();

    // The net must *be* ground, not a SPICE node that merely reads GND — that
    // looked earthed but was floating next to node 0.
    if (r1?.ports[0]?.netId !== "0") fail(`R1's pin is on net ${r1?.ports[0]?.netId}, not on ground`);
    if (/\bGND\b/.test(devices())) fail(`a node literally called GND is in the netlist: ${devices()}`);
    const named = [...st().circuit.nets.values()].filter((n) => n.nodeLabel === "GND");
    if (named.length > 1) fail(`${named.length} nets display the name GND`);
  } },

  { name: "clearing a GND wire's name un-grounds it again", run: async (fail) => {
    st().loadFromAsc(ASC_GND);
    await tick();
    st().rebuildConnections();
    const r1 = () => [...st().circuit.components.values()].find((c) => c.label === "R1");
    const top = r1()?.ports[0]?.netId;
    if (!top) { fail("R1 has no net"); return; }

    st().renameNet(top, "GND");
    await tick();
    st().rebuildConnections();
    if (r1()?.ports[0]?.netId !== "0") { fail("the net did not become ground"); return; }

    // The label placed by the rename is what grounds it, so clearing the name
    // must drop that label and let the net float again.
    const gnd = st().nodes.find((n) => (n.data as { label?: string }).label === "GND");
    if (!gnd) { fail("no label carries the GND name"); return; }
    st().renameNet("0", "0");           // clearing ground's own name is a no-op…
    const netNow = r1()?.ports[0]?.netId;
    st().renameNet(netNow!, netNow!);   // …so clear it back to the auto id
    st().rebuildConnections();

    const a = r1()?.ports[0]?.netId, b = r1()?.ports[1]?.netId;
    if (a === "0") fail("R1's top pin is still grounded after the name was cleared");
    if (!a || a === b) fail(`R1 is shorted (both pins on ${a})`);
  } },

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

  { name: "naming a net places a net label on it", run: async (fail) => {
    // A name that lived only on a wire was never written to the `.asc` and so
    // vanished on the first save. Naming a net therefore places a label — the
    // file's own way of naming a net — and the two acts become one.
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    // R1's *lower* pin is a plain, unnamed net (a wire to R2's lower pin).
    const r1 = [...st().circuit.components.values()].find((c) => c.label === "R1");
    const netId = r1?.ports[1]?.netId;
    if (!netId) { fail("R1 has no second net"); return; }
    const before = st().nodes.filter((n) => (n.data as { componentType?: string }).componentType === "netlabel").length;

    st().renameNet(netId, "MID");

    const after = st().nodes.filter((n) => (n.data as { componentType?: string }).componentType === "netlabel").length;
    if (after !== before + 1) fail(`naming the net did not place a label (${before} → ${after})`);
    const placed = st().nodes.find((n) => (n.data as { label?: string; componentType?: string }).componentType === "netlabel"
      && (n.data as { label?: string }).label === "MID");
    if (!placed) { fail("no label carries the name MID"); return; }
    // A plain label, not a connector: typing a name is not a claim about
    // direction, and a connector would write an IOPIN the user never asked for.
    if ((placed.data as { portType?: string }).portType) fail("naming the net declared a port direction");
    st().regenerateNetlist();
    if (st().circuit.nets.get(netId)?.nodeLabel !== "MID") fail("the name did not survive a netlist rebuild");
    // …and it survives a *full* rebuild (net ids get renumbered).
    st().rebuildConnections();
    if (![...st().circuit.nets.values()].some((n) => n.nodeLabel === "MID")) fail("the name was lost on a full rebuild");
  } },

  { name: "deleting a net-connector keeps the wire's name", run: async (fail) => {
    // The name belongs to the wire, not to the connector symbol: deleting the
    // connector must leave the net named (and shown on the bridging wire).
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = netLabelNode();
    if (!label) { fail("no net label imported"); return; }
    if (netOf("R1")?.nodeLabel !== "UB") fail(`the net is not called UB but ${netOf("R1")?.nodeLabel}`);

    st().removeComponent(label.id);
    await tick();
    st().rebuildConnections();

    // The name stays, and no net-label node remains.
    if (netOf("R1")?.nodeLabel !== "UB") fail(`the net lost its name UB (now ${netOf("R1")?.nodeLabel})`);
    if (netLabelNode()) fail("a net-label node is still on the canvas");
    if (!st().edges.some((e) => (e.data as { netName?: string }).netName === "UB")) fail("no wire carries the name UB after the delete");
    st().regenerateNetlist();
    if (!st().netlist.includes("UB")) fail("the netlist no longer uses the name UB");
  } },

  { name: "delete a label, place a new one, name it — it stays its own component", run: async (fail) => {
    // The reported bug: the placement counter started at 1 while the import had
    // already handed out `netlabel_2`, so a newly placed label got an id that was
    // in use. It *replaced* the imported component in the circuit map while both
    // nodes stayed on the canvas — renaming the new one edited the old one, and
    // the name appeared elsewhere in the schematic.
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();

    const first = netLabelNode();
    if (!first) { fail("no net label imported"); return; }
    st().removeComponent(first.id);
    await tick();

    // Place a fresh label exactly as the canvas does.
    const id = nextComponentId("netlabel", st().nodes.map((n) => n.id));
    if (st().nodes.some((n) => n.id === id)) { fail(`the new label reuses the id ${id}`); return; }
    const comp = createSpiceComponent("netlabel", id, "NET", 0, 0);
    st().addComponent(comp, { id, type: "component", position: { x: 0, y: 0 }, data: { componentType: "netlabel", label: "NET" } });

    // Ids stay unique, and every node has its own component behind it.
    const ids = st().nodes.map((n) => n.id);
    if (new Set(ids).size !== ids.length) fail(`duplicate node ids: ${ids.join(", ")}`);
    if (st().circuit.components.size !== ids.length) {
      fail(`${ids.length} nodes but ${st().circuit.components.size} components — one overwrote another`);
    }

    // Naming it must rename *this* label and no other.
    st().updateComponentProperty(id, "label", "U2");
    const named = st().nodes.filter((n) => (n.data as { label?: string }).label === "U2");
    if (named.length !== 1 || named[0].id !== id) {
      fail(`"U2" ended up on ${named.map((n) => n.id).join(", ") || "nothing"} instead of ${id}`);
    }
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

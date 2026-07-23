import { useCircuitStore } from "@store/circuitStore.js";
import type { TestReport } from "./svgExport.test.js";
import { withSymbols } from "./withSymbols.js";

/**
 * Where a net's name lives, and that it lives in exactly one place.
 *
 * A name is an anchor: a string at a coordinate, naming whatever net passes
 * underneath. `Net.nodeLabel` is derived from that on every rebuild, never the
 * other way round — which is what makes "the two disagree" impossible rather
 * than merely tested for. Under the old model the name existed twice, as a
 * terminal component *and* as `nodeLabel`, and a rename that touched only one of
 * them was silently reverted by the next rebuild.
 *
 * What still has to be checked is the rest of it: that naming a net puts a flag
 * where the file can keep it, that clearing the name takes the flag away, that
 * ground is grounded by name, and that a name is not a part — deleting parts
 * around it must not shred the net it sits on.
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

/** The first name on the sheet. */
const anchorByName = (name: string) => st().netAnchors.find((a) => a.name === name);

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
  { name: "a name reading GND on the ground net changes nothing, and deletes cleanly", run: async (fail) => {
    st().loadFromAsc(ASC_GND);
    await tick(); await tick();
    st().rebuildConnections();
    const before = devices();

    // Put a name reading GND straight on the ground symbol's pin.
    const gnd = st().nodes.find((n) => (n.data as { componentType?: string }).componentType === "ground");
    if (!gnd) { fail("no ground imported"); return; }
    const id = st().addNetAnchor(16, 96, "GND");
    st().rebuildConnections();
    if (devices() !== before) fail(`the netlist changed:\n    before: ${before}\n    after:  ${devices()}`);

    // …and removing it again leaves the circuit exactly as it was.
    st().removeNetAnchor(id);
    await tick();
    st().rebuildConnections();
    if (devices() !== before) fail(`deleting the GND name changed the netlist: ${devices()}`);
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

    // The flag placed by the rename is what grounds it, so clearing the name
    // must take that flag away and let the net float again.
    if (!anchorByName("GND")) { fail("no flag carries the GND name"); return; }
    st().renameNet("0", "0");           // clearing ground's own name is a no-op…
    const netNow = r1()?.ports[0]?.netId;
    st().renameNet(netNow!, netNow!);   // …so clear it back to the auto id
    st().rebuildConnections();

    const a = r1()?.ports[0]?.netId, b = r1()?.ports[1]?.netId;
    if (a === "0") fail("R1's top pin is still grounded after the name was cleared");
    if (!a || a === b) fail(`R1 is shorted (both pins on ${a})`);
  } },

  { name: "deleting a name keeps the wires it sat on", run: async (fail) => {
    // The old failure this guards: a label was a node with a pin, an imported net
    // is routed as a star from its first pin, and when that pin was the label
    // *every* wire of the net hung off it and vanished with it. A name owns no
    // wire at all now, so deleting one cannot take anything with it.
    st().loadFromAsc(ASC);
    await tick(); await tick();
    st().rebuildConnections();
    const label = anchorByName("UB");
    if (!label) { fail("no name imported"); return; }
    const edgesBefore = st().edges.length;
    const netBefore = netOf("R1")?.id;
    if (!netBefore || netOf("R2")?.id !== netBefore) { fail("R1/R2 not on one net before the delete"); return; }

    st().removeNetAnchor(label.id);
    await tick();
    st().rebuildConnections();

    if (st().edges.length !== edgesBefore) fail(`${edgesBefore} wires before, ${st().edges.length} after`);
    const a = netOf("R1")?.id, b = netOf("R2")?.id;
    if (!a || a !== b) fail(`R1 (${a}) and R2 (${b}) fell apart when the name was deleted`);
  } },

  { name: "renaming the net rewrites its flag (there is nowhere else to put it)", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick(); await tick();
    st().rebuildConnections();
    const net = netOf("R1");
    if (!net) { fail("R1 has no net"); return; }

    st().renameNet(net.id, "VCC");
    await tick();
    st().rebuildConnections();
    // The flag carries the name, so it has to follow — the net's own nodeLabel is
    // re-derived from it on every rebuild and would otherwise revert.
    if (!anchorByName("VCC")) fail(`no flag reads VCC; names are [${st().netAnchors.map((a) => a.name).join(", ")}]`);
    if (anchorByName("UB")) fail("the old name UB is still on the sheet");

    st().regenerateNetlist();
    if (netOf("R1")?.nodeLabel !== "VCC") fail(`the rename was reverted to "${netOf("R1")?.nodeLabel}" by the rebuild`);
    if (!st().netlist.includes("VCC")) fail("the netlist does not use the new name");
  } },

  { name: "renaming the flag renames the net (the other direction)", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick(); await tick();
    st().rebuildConnections();
    const label = anchorByName("UB");
    if (!label) { fail("no name imported"); return; }

    st().updateNetAnchor(label.id, { name: "OUT" });
    await tick();
    if (netOf("R1")?.nodeLabel !== "OUT") fail(`the net is called "${netOf("R1")?.nodeLabel}", not OUT`);
  } },

  { name: "naming a net puts a flag on it", run: async (fail) => {
    // A name that lived only on a wire was never written to the `.asc` and so
    // vanished on the first save. Naming a net therefore places a flag — the
    // file's own way of naming a net — and the two acts become one.
    st().loadFromAsc(ASC);
    await tick(); await tick();
    st().rebuildConnections();
    // R1's *lower* pin is a plain, unnamed net (a wire to R2's lower pin).
    const r1 = [...st().circuit.components.values()].find((c) => c.label === "R1");
    const netId = r1?.ports[1]?.netId;
    if (!netId) { fail("R1 has no second net"); return; }
    const before = st().netAnchors.length;

    st().renameNet(netId, "MID");
    await tick();

    if (st().netAnchors.length !== before + 1) fail(`naming the net placed no flag (${before} → ${st().netAnchors.length})`);
    const placed = anchorByName("MID");
    if (!placed) { fail("no flag carries the name MID"); return; }
    // A plain label, not a connector: typing a name is not a claim about
    // direction, and a connector would write an IOPIN the user never asked for.
    if (placed.portType) fail("naming the net declared a port direction");
    st().regenerateNetlist();
    if (st().circuit.nets.get(netId)?.nodeLabel !== "MID") fail("the name did not survive a netlist rebuild");
    // …and it survives a *full* rebuild (net ids get renumbered).
    st().rebuildConnections();
    if (![...st().circuit.nets.values()].some((n) => n.nodeLabel === "MID")) fail("the name was lost on a full rebuild");
  } },

  { name: "two names on one net are both kept (they are aliases)", run: async (fail) => {
    // A net may carry several names and LTSpice files do. One wins for the
    // netlist; the others must stay on the sheet, or opening and saving the file
    // would quietly destroy a name the author put there.
    st().loadFromAsc(ASC);
    await tick(); await tick();
    st().rebuildConnections();
    const netId = netOf("R1")?.id;
    if (!netId) { fail("R1 has no net"); return; }

    // A second name on the same run of wire.
    st().addNetAnchor(200, 16, "UB_ALT");
    st().rebuildConnections();

    if (!anchorByName("UB") || !anchorByName("UB_ALT")) fail("one of the two names was dropped");
    // The older one wins the netlist; both survive on the sheet.
    if (netOf("R1")?.nodeLabel !== "UB") fail(`the net is called ${netOf("R1")?.nodeLabel}, not UB`);
  } },

  { name: "a name moved onto another net renames that one instead", run: async (fail) => {
    // The behaviour that only a coordinate model can have: what a name names is
    // decided by where it lies, so moving it is a rename of two nets at once.
    st().loadFromAsc(ASC);
    await tick(); await tick();
    st().rebuildConnections();
    const label = anchorByName("UB");
    if (!label) { fail("no name imported"); return; }
    // The lower net, looked up *after* the move: a rebuild renumbers net ids, so
    // an id captured beforehand names a net that no longer exists.
    const lowerNet = () => {
      const r1 = [...st().circuit.components.values()].find((c) => c.label === "R1");
      const id = r1?.ports[1]?.netId;
      return id ? st().circuit.nets.get(id) : undefined;
    };

    // Onto the lower run of wire (y = 96), which is R1/R2's other net.
    st().moveNetAnchor(label.id, 180, 96);
    await tick();
    st().rebuildConnections();

    if (lowerNet()?.nodeLabel !== "UB") fail(`the lower net is called ${lowerNet()?.nodeLabel}, not UB`);
    if (netOf("R1")?.nodeLabel === "UB") fail("the upper net kept the name it no longer carries");
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
  // With the real symbols: a name finds its net by lying on a wire, and where the
  // wires run depends on where the pins are.
  return withSymbols(async () => {
    const failures: { name: string; reason: string }[] = [];
    let failed = 0;
    for (const tc of CASES) {
      let f = false;
      await tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
      if (f) failed++;
    }
    return { total: CASES.length, passed: CASES.length - failed, failures };
  });
}

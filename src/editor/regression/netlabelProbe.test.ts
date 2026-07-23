import { useCircuitStore } from "@store/circuitStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { netVoltageExpr, netCurrentExpr, currentExprDevice } from "@core/circuit/dataExpr.js";
import { getCurrentProbeCandidates } from "@core/circuit/probeUtils.js";
import { resolveAnchors } from "@editor/anchorNets.js";
import { withSymbols } from "./withSymbols.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Right-clicking a name must offer the potential of the node it names, the same
 * probe a wire on that net offers — so a named net is reachable however you point
 * at it.
 *
 * The menu builds its expression exactly as the canvas does, and since names left
 * the topology that means *resolving the name against the geometry* first: an
 * anchor has no port to read a net off (see anchorNets). That extra step is the
 * part worth guarding — a name that stops resolving would not fail loudly, it
 * would just quietly offer nothing.
 */

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> | void };

const st = () => useCircuitStore.getState();
const tick = () => new Promise((r) => setTimeout(r, 0));

// A net label UB on a wire shared by two resistors (same fixture as netLabel.test).
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

/** The first name on the sheet, whatever it is called at the moment. */
const anchor = () => st().netAnchors[0];

/** The net under a name — the step the canvas takes before building the menu. */
const netOfAnchor = (id: string): string | null => resolveAnchors(st(), "en").get(id) ?? null;

/** The expression the menu would show for a name, or null. */
const menuExpr = (id: string): string | null => netVoltageExpr(st().circuit, netOfAnchor(id));

/** The current expression the menu would show for a name, or null. */
const menuCurrentExpr = (id: string): string | null => netCurrentExpr(st().circuit, netOfAnchor(id));

const CASES: Case[] = [
  { name: "a name offers V(<name>) for the net it names", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = anchor();
    if (!label) { fail("no name imported"); return; }
    const expr = menuExpr(label.id);
    if (expr !== "V(UB)") fail(`the menu would probe ${expr ?? "nothing"}, not V(UB)`);
  } },

  { name: "the offered potential follows a rename of the net", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = anchor();
    if (!label) { fail("no name imported"); return; }
    const netId = netOfAnchor(label.id);
    if (!netId) { fail("the name sits on no net"); return; }

    st().renameNet(netId, "VCC");
    await tick();
    const expr = menuExpr(label.id);
    if (expr !== "V(VCC)") fail(`after the rename the menu still shows ${expr ?? "nothing"}, not V(VCC)`);
  } },

  { name: "naming the net GND turns the probe into V(0) (the reference)", run: async (fail) => {
    // Renaming a net to GND grounds it (netId 0); its potential is the reference,
    // written V(0) — the menu must not offer a floating V(GND).
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = anchor();
    if (!label) { fail("no name imported"); return; }
    const netId = netOfAnchor(label.id);
    if (!netId) { fail("the name sits on no net"); return; }

    st().renameNet(netId, "GND");
    await tick();
    st().rebuildConnections();
    const expr = menuExpr(label.id);
    if (expr !== "V(0)") fail(`a grounded label offers ${expr ?? "nothing"}, not V(0)`);
  } },
  { name: "a name offers the series current; it is not a third terminal", run: async (fail) => {
    // The name sits on the node between R1 and R2. It is not a part at all, so
    // it cannot count as a third terminal and hide the series current.
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = anchor();
    if (!label) { fail("no name imported"); return; }
    const expr = menuCurrentExpr(label.id);
    if (expr !== "I(R1)" && expr !== "I(R2)") {
      fail(`the menu offers ${expr ?? "no current"}, not the series current I(R1)/I(R2)`);
    }
  } },

  { name: "the offered current reaches the scope as probe candidates", run: async (fail) => {
    // The whole chain the menu button runs: net current → device name → probe
    // candidates → scope. Guards the seam between them, so a change to the
    // `I(dev)` format cannot leave the button silently doing nothing.
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = anchor();
    if (!label) { fail("no name imported"); return; }

    const iExpr = menuCurrentExpr(label.id);
    const dev = currentExprDevice(iExpr);
    if (!dev) { fail(`the current ${iExpr ?? "(none)"} yields no device name to probe`); return; }

    const sim = useSimulationStore.getState();
    sim.setSelectedVariables([]);
    useSimulationStore.setState({ pendingProbes: [], result: null });
    sim.addProbeCandidates(getCurrentProbeCandidates(dev));

    // Without a result the probes queue up as pending; `I(R1)` must be among them.
    const pending = useSimulationStore.getState().pendingProbes;
    if (!pending.some((p) => p.toUpperCase() === `I(${dev.toUpperCase()})`)) {
      fail(`the scope received ${JSON.stringify(pending)}, which does not probe ${dev}`);
    }
  } },

  { name: "a grounded name offers no current", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = anchor();
    if (!label) { fail("no name imported"); return; }
    const netId = netOfAnchor(label.id);
    if (!netId) { fail("the name sits on no net"); return; }

    st().renameNet(netId, "GND");
    await tick();
    st().rebuildConnections();
    const expr = menuCurrentExpr(label.id);
    if (expr !== null) fail(`the ground net offers ${expr}, but its current is not a single branch`);
  } },
];

export async function runNetlabelProbeTests(): Promise<TestReport> {
  // With the real symbols loaded: a name finds its net by lying on a wire, and
  // where the wires run depends on where the pins are.
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

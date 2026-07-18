import { useCircuitStore } from "@store/circuitStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { netVoltageExpr, netCurrentExpr, currentExprDevice } from "@core/circuit/dataExpr.js";
import { getCurrentProbeCandidates } from "@core/circuit/probeUtils.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * The net-label context menu must offer the potential of the node it names, the
 * same probe a wire on that net offers — so a named net is reachable however you
 * right-click it. The menu builds its expression exactly as the canvas does:
 * resolve the label terminal's port to a net, then `netVoltageExpr(circuit, netId)`.
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

const netLabelNode = () => st().nodes.find((n) => (n.data as { componentType?: string }).componentType === "netlabel");

/** The expression the net-label menu would show, or null. */
const menuExpr = (nodeId: string): string | null => {
  const netId = st().circuit.components.get(nodeId)?.ports[0]?.netId ?? null;
  return netVoltageExpr(st().circuit, netId);
};

/** The current expression the net-label menu would show, or null. */
const menuCurrentExpr = (nodeId: string): string | null => {
  const netId = st().circuit.components.get(nodeId)?.ports[0]?.netId ?? null;
  return netCurrentExpr(st().circuit, netId);
};

const CASES: Case[] = [
  { name: "a net label offers V(<name>) for the net it names", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = netLabelNode();
    if (!label) { fail("no net label imported"); return; }
    const expr = menuExpr(label.id);
    if (expr !== "V(UB)") fail(`the menu would probe ${expr ?? "nothing"}, not V(UB)`);
  } },

  { name: "the offered potential follows a rename of the net", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = netLabelNode();
    if (!label) { fail("no net label imported"); return; }
    const netId = st().circuit.components.get(label.id)?.ports[0]?.netId;
    if (!netId) { fail("the label sits on no net"); return; }

    st().renameNet(netId, "VCC");
    await tick();
    const expr = menuExpr(label.id);
    if (expr !== "V(VCC)") fail(`after the rename the menu still shows ${expr ?? "nothing"}, not V(VCC)`);
  } },

  { name: "naming the net GND turns the label's probe into V(0) (the reference)", run: async (fail) => {
    // Renaming a net to GND grounds it (netId 0); its potential is the reference,
    // written V(0) — the menu must not offer a floating V(GND).
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = netLabelNode();
    if (!label) { fail("no net label imported"); return; }
    const netId = st().circuit.components.get(label.id)?.ports[0]?.netId;
    if (!netId) { fail("the label sits on no net"); return; }

    st().renameNet(netId, "GND");
    await tick();
    st().rebuildConnections();
    const expr = menuExpr(label.id);
    if (expr !== "V(0)") fail(`a grounded label offers ${expr ?? "nothing"}, not V(0)`);
  } },
  { name: "a net label offers the series current, ignoring its own terminal", run: async (fail) => {
    // The label sits on the node between R1 and R2. It emits no device line, so
    // it must not count as a third terminal and hide the series current.
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = netLabelNode();
    if (!label) { fail("no net label imported"); return; }
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
    const label = netLabelNode();
    if (!label) { fail("no net label imported"); return; }

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

  { name: "a grounded label offers no current", run: async (fail) => {
    st().loadFromAsc(ASC);
    await tick();
    st().rebuildConnections();
    const label = netLabelNode();
    if (!label) { fail("no net label imported"); return; }
    const netId = st().circuit.components.get(label.id)?.ports[0]?.netId;
    if (!netId) { fail("the label sits on no net"); return; }

    st().renameNet(netId, "GND");
    await tick();
    st().rebuildConnections();
    const expr = menuCurrentExpr(label.id);
    if (expr !== null) fail(`the ground net offers ${expr}, but its current is not a single branch`);
  } },
];

export async function runNetlabelProbeTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    await tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

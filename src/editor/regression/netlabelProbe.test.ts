import { useCircuitStore } from "@store/circuitStore.js";
import { netVoltageExpr } from "@core/circuit/dataExpr.js";
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

import { renameNetInProbe } from "@core/circuit/probeUtils.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { usePlotStore } from "@simulation/plotStore.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Renaming a net must carry through everywhere the old name is written on the
 * diagram: scope traces, functions, and component data-points. The single-node
 * form `V(a)` was already followed; the differential `V(a,b)` a component
 * data-point emits was not, so a renamed net kept its old name on those badges.
 * `renameNetInProbe` is the one rewrite all those sinks share.
 */

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> | void };

const st = () => useCircuitStore.getState();
const plot = () => usePlotStore.getState();
const tick = () => new Promise((r) => setTimeout(r, 0));

// V1 (5 V) in series with R1; the bottom rail grounded (flag on V1's − pin).
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

const CASES: Case[] = [
  // ── the pure rewrite ──────────────────────────────────────────────────────
  { name: "V(a) renames to V(b)", run: (fail) => {
    const out = renameNetInProbe("V(net1)", "net1", "vin");
    if (out !== "V(vin)") fail(`got ${out}`);
  } },

  { name: "-V(a) keeps its sign", run: (fail) => {
    const out = renameNetInProbe("-V(net1)", "net1", "vin");
    if (out !== "-V(vin)") fail(`got ${out}`);
  } },

  { name: "the differential V(a,b) renames its first operand", run: (fail) => {
    const out = renameNetInProbe("V(net1,gnd)", "net1", "vin");
    if (out !== "V(vin,gnd)") fail(`got ${out}`);
  } },

  { name: "the differential V(a,b) renames its second operand", run: (fail) => {
    const out = renameNetInProbe("V(out,net1)", "net1", "gnd");
    if (out !== "V(out,gnd)") fail(`got ${out}`);
  } },

  { name: "a whole expression renames every occurrence, single and differential", run: (fail) => {
    const out = renameNetInProbe("V(net1)-V(out,net1)", "net1", "a");
    if (out !== "V(a)-V(out,a)") fail(`got ${out}`);
  } },

  { name: "currents are never touched (they reference devices, not nets)", run: (fail) => {
    const out = renameNetInProbe("I(net1)", "net1", "vin");
    if (out !== "I(net1)") fail(`I() was rewritten to ${out}`);
  } },

  { name: "a net name that only partly matches is left alone", run: (fail) => {
    const out = renameNetInProbe("V(net10)", "net1", "vin");
    if (out !== "V(net10)") fail(`a substring match leaked: ${out}`);
  } },

  // ── the sinks that share the rewrite ──────────────────────────────────────
  { name: "renaming a net updates a V(a,b) data-point on the schematic", run: async (fail) => {
    st().loadFromAsc(ASC_GND);
    await tick();
    st().rebuildConnections();
    const r1 = [...st().circuit.components.values()].find((c) => c.label === "R1");
    const top = r1?.ports[0]?.netId;
    if (!top || top === "0") { fail("R1's top pin is not on a floating net"); return; }
    const topName = st().circuit.nets.get(top)?.nodeLabel;
    if (!topName) { fail("the top net has no name"); return; }

    // A differential data-point across R1: V(<top>,0).
    st().addDataFlag(200, 40, `V(${topName},0)`);
    st().renameNet(top, "VIN");
    await tick();

    const flags = st().dataFlags.map((d) => d.expr);
    if (!flags.includes("V(VIN,0)")) {
      fail(`the data-point still reads ${flags.join(", ")}, not V(VIN,0)`);
    }
  } },

  { name: "renaming a net updates a scope function that uses V(a,b)", run: async (fail) => {
    st().loadFromAsc(ASC_GND);
    await tick();
    st().rebuildConnections();
    const r1 = [...st().circuit.components.values()].find((c) => c.label === "R1");
    const top = r1?.ports[0]?.netId;
    if (!top || top === "0") { fail("R1's top pin is not on a floating net"); return; }
    const topName = st().circuit.nets.get(top)?.nodeLabel;
    if (!topName) { fail("the top net has no name"); return; }

    plot().resetSettings();
    plot().addExpression(`V(${topName},0)`);
    st().renameNet(top, "VIN");

    if (!plot().expressions.includes("V(VIN,0)")) {
      fail(`the function still reads ${plot().expressions.join(", ")}, not V(VIN,0)`);
    }
  } },
];

export async function runNetRenameTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    await tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import type { Edge, Node } from "@xyflow/react";
import type { TestReport } from "./svgExport.test.js";

/**
 * LTSpice connects a terminal, ground or net-label flag dropped straight onto a
 * component pin (no wire in between). A voltage source with such a flag on each
 * terminal — as in InvSummierverstaerker.asc, where the ±15 V supply flags sit
 * directly on the source pins — must import with both terminals connected;
 * otherwise the pins land on separate isolated nets and ngspice reports a
 * "shorted VSRC". Pin at (0,16) / (0,96) matches vsource's PIN_OFFSETS.
 */
const ASC = `Version 4
SHEET 1 880 680
FLAG 0 16 VP
FLAG 0 96 0
SYMBOL voltage 0 0 R0
SYMATTR InstName V1
SYMATTR Value 5
`;

const linked = (edges: Edge[], a: string, ha: string, b: string, hb: string) =>
  edges.some((e) =>
    (e.source === a && e.sourceHandle === ha && e.target === b && e.targetHandle === hb) ||
    (e.source === b && e.sourceHandle === hb && e.target === a && e.targetHandle === ha),
  );

const nodeBy = (nodes: Node[], pred: (d: { componentType?: string; label?: string }) => boolean) =>
  nodes.find((n) => pred(n.data as { componentType?: string; label?: string }));

type Case = { name: string; run: (fail: (r: string) => void) => void };

// A localized op-amp symbol (path-qualified + "_EN" suffix) must import as the
// 5-pin op-amp, not fall back to a 2-pin resistor (Rechteckgenerator.asc).
const ASC_OPAMP = `Version 4
SHEET 1 880 680
SYMBOL Opamps\\\\UniversalOpAmp2_EN 368 128 R0
SYMATTR InstName U1
`;

// LTSpice stores a multi-line directive TEXT as one line with literal "\\n".
const ASC_TEXT = `Version 4
SHEET 1 880 680
TEXT 0 0 Left 2 !.meas TRAN a TRIG 1\\n.meas TRAN b TRIG 2
`;

// PULSE(V1 V2 Tdelay Trise Tfall Ton Tperiod): every field must be read. Rise,
// fall and delay were skipped, so a triangle PULSE(0V 10V 0s 10s 10s 0s 20s)
// kept default 1 ns edges and collapsed to a spike once the verbatim rawSpec
// was dropped (e.g. after any edit in the properties panel). Units (V/s) too.
const ASC_PULSE = `Version 4
SHEET 1 880 680
FLAG 0 96 0
FLAG 0 16 OUT
SYMBOL voltage 0 0 R0
SYMATTR InstName V2
SYMATTR Value PULSE(0V 10V 0s 10s 10s 0s 20s)
`;

const CASES: Case[] = [
  { name: "flag-on-pin connects source terminals (no bridging wire)", run: (fail) => {
    const { nodes, edges } = LTSpiceParser.parse(ASC);
    const v1 = nodeBy(nodes, (d) => d.label === "V1");
    const vp = nodeBy(nodes, (d) => d.componentType === "netlabel" && d.label === "VP");
    const gnd = nodeBy(nodes, (d) => d.componentType === "ground");
    if (!v1 || !vp || !gnd) { fail("missing imported node(s)"); return; }
    if (!linked(edges, v1.id, "p", vp.id, "t")) fail("source + terminal not connected to the VP flag");
    if (!linked(edges, v1.id, "n", gnd.id, "gnd")) fail("source - terminal not connected to ground");
  } },
  { name: "localized UniversalOpAmp2_EN imports as an op-amp", run: (fail) => {
    const { nodes } = LTSpiceParser.parse(ASC_OPAMP);
    const u1 = nodeBy(nodes, (d) => d.label === "U1");
    if (!u1) { fail("U1 not imported"); return; }
    if ((u1.data as { componentType?: string }).componentType !== "opamp") {
      fail(`expected op-amp, got ${(u1.data as { componentType?: string }).componentType}`);
    }
  } },
  { name: "multi-line TEXT splits its literal \\n into separate directives", run: (fail) => {
    const { directives } = LTSpiceParser.parse(ASC_TEXT);
    if (directives.includes("\\n")) fail("literal \\n left in directives");
    const measLines = directives.split("\n").filter((l) => l.trim().startsWith(".meas"));
    if (measLines.length !== 2) fail(`expected 2 .meas lines, got ${measLines.length}`);
  } },
  { name: "PULSE reads rise/fall/delay (triangle, unit suffixes)", run: (fail) => {
    const { components } = LTSpiceParser.parse(ASC_PULSE);
    const v2 = components.find((c) => c.label === "V2");
    if (!v2) { fail("V2 not imported"); return; }
    const p = Object.fromEntries(v2.getProperties().map((x) => [x.key, x.value]));
    if (p.riseTime !== 10) fail(`riseTime ${p.riseTime} != 10`);
    if (p.fallTime !== 10) fail(`fallTime ${p.fallTime} != 10`);
    if (p.pulseWidth !== 0) fail(`pulseWidth ${p.pulseWidth} != 0`);
    if (p.period !== 20) fail(`period ${p.period} != 20`);
  } },
];

export function runAscConnectivityTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

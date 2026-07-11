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

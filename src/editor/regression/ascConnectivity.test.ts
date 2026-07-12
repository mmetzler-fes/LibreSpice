import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { createSpiceComponent, createSubcircuitComponent, getValueLabel } from "@editor/componentFactory.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
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

// A localized AC current source (current_EN) carrying a SINE waveform must
// import as a current source (not fall back to a resistor) AND keep its
// frequency/amplitude in the netlist (RLC_Reihenschwingkreis.asc). Before the
// fix, current_EN mapped to a resistor and CurrentSource dropped the SINE spec.
const ASC_ISINE = `Version 4
SHEET 1 880 680
FLAG 0 96 0
FLAG 0 16 U
SYMBOL current_EN 0 0 R0
SYMATTR InstName I1
SYMATTR Value SINE(0 1.414 50Hz)
`;

// ── Save → load round-trip ───────────────────────────────────────────────────
// Saving writes an `.asc` (LTSpiceExporter) and loading reads it back. The
// exporter used to write only a bare DC number or a 3-field SINE, so every save
// silently dropped the source's waveform type, phase, AC amplitude, parasitics
// and a semiconductor's model: an AC current source with Phi=90 came back as a
// plain DC source. Build a circuit, export it, re-import it, and require every
// property to survive.

type Spec = { type: ComponentType; label: string; set: Record<string, string | number> };
type Snapshot = { comp?: SpiceComponent; props: Record<string, string | number | undefined> };

const propsOf = (comp?: SpiceComponent): Snapshot => ({
  comp,
  props: Object.fromEntries((comp?.getProperties() ?? []).map((p) => [p.key, p.value])),
});

/** Build the given components, export them as `.asc`, and parse the result back. */
function roundTrip(specs: Spec[]) {
  const nodes: Node[] = [];
  const components = new Map<string, SpiceComponent>();
  specs.forEach((s, i) => {
    const id = `c_${i}`;
    const comp = createSpiceComponent(s.type, id, s.label, i * 160, 0);
    for (const [k, v] of Object.entries(s.set)) comp.setProperty(k, v);
    components.set(id, comp);
    nodes.push({
      id, type: "component", position: { x: i * 160, y: 0 },
      data: { componentType: s.type, label: s.label, valueLabel: getValueLabel(comp, s.type) },
    });
  });
  const asc = LTSpiceExporter.export(nodes, [], "", { components, nets: new Map() }, []);
  const parsed = LTSpiceParser.parse(asc);
  const find = (list: SpiceComponent[], label: string) => list.find((c) => c.label === label);
  return {
    asc,
    nodes: parsed.nodes,
    before: (label: string) => propsOf(find([...components.values()], label)),
    after: (label: string) => propsOf(find(parsed.components, label)),
    nodeType: (label: string) =>
      (parsed.nodes.find((n) => (n.data as { label?: string }).label === label)?.data as { componentType?: string })
        ?.componentType,
  };
}

/**
 * Every placeable component type, each with non-default values in every field —
 * the table is the contract for "a saved circuit reloads unchanged". Each entry
 * must survive export→import with identical properties, component type and
 * netlist line.
 */
const ROUNDTRIP_SPECS: { type: ComponentType; label: string; set: Record<string, string | number> }[] = [
  { type: "resistor", label: "R1", set: { resistance: 4700 } },
  { type: "capacitor", label: "C1", set: { capacitance: 1e-7 } },
  { type: "capacitor_polarized", label: "C2", set: { capacitance: 4.7e-5 } },
  { type: "inductor", label: "L1", set: { inductance: 1e-3 } },
  { type: "diode", label: "D1", set: { model: "1N4148" } },
  { type: "led", label: "D2", set: { model: "LED_RED", color: "green" } },
  // Zener/Schottky had no LTSpice symbol mapping: they were saved as "res" and
  // came back as 1 kΩ resistors, model and all.
  { type: "zener", label: "D3", set: { model: "BZX55C5V1" } },
  { type: "schottky", label: "D4", set: { model: "BAT54" } },
  { type: "opamp", label: "U1", set: { model: "LM741" } },
  { type: "bjt_npn", label: "Q1", set: { model: "BC547" } },
  { type: "bjt_pnp", label: "Q2", set: { model: "BC557" } },
  { type: "mosfet_n", label: "M1", set: { model: "IRF540" } },
  { type: "mosfet_p", label: "M2", set: { model: "IRF9540" } },
  { type: "vsource", label: "V1", set: { sourceType: "DC", dcValue: 12, acAmplitude: 1, seriesR: 0.5, parallelC: 1e-9, showParasitics: "yes" } },
  { type: "vsource", label: "V2", set: { sourceType: "Sine", sOffset: 1, sAmpl: 3, sFreq: 60, sTd: 0.02, sTheta: 5, sPhi: 90, sNcycles: 4 } },
  { type: "vsource", label: "V3", set: { sourceType: "Pulse", pV1: 1, pV2: 9, pTd: 2e-3, pTr: 1e-6, pTf: 2e-6, pPw: 3e-3, pPer: 8e-3, pNp: 7 } },
  // The reported bug: an AC current source came back as DC, with Phi lost.
  { type: "isource", label: "I1", set: { sourceType: "Sine", sOffset: 1e-3, sAmpl: 2, sFreq: 50, sTd: 0.01, sTheta: 3, sPhi: 90 } },
  { type: "isource", label: "I2", set: { sourceType: "DC", dcValue: 5e-3, acAmplitude: 1 } },
  { type: "netlabel", label: "VCC", set: {} },
  { type: "ground", label: "0", set: {} },
];

/** One case per type: all properties, the component type and the netlist line must match. */
const ROUNDTRIP_CASES: Case[] = ROUNDTRIP_SPECS.map((spec) => ({
  name: `round-trip: ${spec.type} (${spec.label}) keeps every property`,
  run: (fail) => {
    const { before, after, nodeType } = roundTrip([spec]);
    const a = before(spec.label), b = after(spec.label);
    if (!b.comp) { fail(`${spec.label} not re-imported`); return; }
    if (nodeType(spec.label) !== spec.type) fail(`component type ${nodeType(spec.label)} != ${spec.type}`);
    for (const [k, want] of Object.entries(a.props)) {
      if (String(b.props[k]) !== String(want)) fail(`${k}: ${want} → ${b.props[k] ?? "(lost)"}`);
    }
    if (a.comp!.getNetlistLine() !== b.comp.getNetlistLine()) {
      fail(`netlist changed:\n    before: ${a.comp!.getNetlistLine()}\n    after:  ${b.comp.getNetlistLine()}`);
    }
  },
}));

// A sine source must also reload with the right *symbol*: the node picks it from
// data.sourceType, so a source that loses it renders (and reads) as DC.
ROUNDTRIP_CASES.push({ name: "round-trip: sine source keeps its symbol (node sourceType)", run: (fail) => {
  const { nodes } = roundTrip([ROUNDTRIP_SPECS.find((s) => s.label === "I1")!]);
  const d = nodes.find((n) => (n.data as { label?: string }).label === "I1")?.data as { sourceType?: string };
  if (d?.sourceType !== "Sine") fail(`node data sourceType ${d?.sourceType} != Sine`);
} });

// A library part (own `.asy` symbol + `.subckt` pins) was exported as "res": it
// returned as a 1 kΩ resistor and every wire on it was dropped. It must keep its
// symbol, its subcircuit name, its pin order — and its connections.
ROUNDTRIP_CASES.push({ name: "round-trip: library subcircuit keeps symbol, pins and wires", run: (fail) => {
  const pins = ["GND", "TRIG", "OUT", "RESET"];
  const comp = createSubcircuitComponent("x1", "X1", 100, 100, ".subckt NE555 GND TRIG OUT RESET\n.ends", pins);
  const nodes: Node[] = [{
    id: "x1", type: "component", position: { x: 100, y: 100 },
    data: { componentType: "subcircuit", label: "X1", pins, subName: "NE555", symbolName: "NE555" },
  }];
  const edges: Edge[] = [
    { id: "e1", source: "x1", sourceHandle: "OUT", target: "x1", targetHandle: "TRIG", type: "wire", data: {} },
  ];
  const asc = LTSpiceExporter.export(nodes, edges, "", { components: new Map([["x1", comp]]), nets: new Map() }, []);
  if (!/^SYMBOL NE555 /m.test(asc)) fail(`symbol not written as NE555:\n${asc}`);
  const back = LTSpiceParser.parse(asc);
  const d = back.nodes[0]?.data as { componentType?: string; pins?: string[]; subName?: string };
  if (d?.componentType !== "subcircuit") fail(`came back as ${d?.componentType}, not a subcircuit`);
  if (d?.subName !== "NE555") fail(`subName ${d?.subName} != NE555`);
  if (d?.pins?.join(",") !== pins.join(",")) fail(`pins ${d?.pins} != ${pins}`);
  if (back.edges.length === 0) fail("wires on the subcircuit were dropped");
} });

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
  { name: "localized SINE current source keeps its frequency in the netlist", run: (fail) => {
    const { nodes, components } = LTSpiceParser.parse(ASC_ISINE);
    const i1n = nodeBy(nodes, (d) => d.label === "I1");
    if (i1n && (i1n.data as { componentType?: string }).componentType !== "isource") {
      fail(`expected isource, got ${(i1n.data as { componentType?: string }).componentType}`);
    }
    const i1 = components.find((c) => c.label === "I1");
    if (!i1) { fail("I1 not imported"); return; }
    const line = i1.getNetlistLine();
    if (!/SIN\(/i.test(line) || !/50/.test(line) || !/1\.414/.test(line)) {
      fail(`SINE spec/frequency missing from netlist: ${line}`);
    }
    const p = Object.fromEntries(i1.getProperties().map((x) => [x.key, x.value]));
    if (p.sFreq !== 50) fail(`sFreq ${p.sFreq} != 50`);
    if (p.sAmpl !== 1.414) fail(`sAmpl ${p.sAmpl} != 1.414`);
  } },
  { name: "PULSE reads rise/fall/delay (triangle, unit suffixes)", run: (fail) => {
    const { components } = LTSpiceParser.parse(ASC_PULSE);
    const v2 = components.find((c) => c.label === "V2");
    if (!v2) { fail("V2 not imported"); return; }
    const p = Object.fromEntries(v2.getProperties().map((x) => [x.key, x.value]));
    if (p.sourceType !== "Pulse") fail(`sourceType ${p.sourceType} != Pulse`);
    if (p.pTr !== 10) fail(`pTr (Trise) ${p.pTr} != 10`);
    if (p.pTf !== 10) fail(`pTf (Tfall) ${p.pTf} != 10`);
    if (p.pPw !== 0) fail(`pPw (Ton) ${p.pPw} != 0`);
    if (p.pPer !== 20) fail(`pPer (Tperiod) ${p.pPer} != 20`);
  } },
  ...ROUNDTRIP_CASES,
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

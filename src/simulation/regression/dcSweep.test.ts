import { parseStepDirectives, isTempSweep, withTemp, withParam, withDcSource, parseMeasurements } from "../paramSweep.js";
import { buildMeasurementSweep } from "../simulationEngine.js";
import type { StepSpec } from "../paramSweep.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * `.dc` sweeps combined with `.step`, as in `examples/05-2-4-1_TempDiode.asc`:
 *
 *     .dc V1 0V 1V 0.01V
 *     .step lin temp 0 100 10
 *
 * Three things have to hold for that plot to mean anything: the x-axis is the
 * swept source (not time), the sweep vector is not also drawn as a curve, and
 * `temp` actually changes the simulation temperature rather than being taken for
 * a source of that name.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const CASES: Case[] = [
  { name: "`.step temp` is recognised as the temperature, not a source", run: (fail) => {
    // Both spellings mean the ambient temperature in LTSpice. Without the
    // `param` keyword the parser calls it a source, so the *name* has to decide.
    for (const line of [".step lin temp 0 100 10", ".step param temp 0 100 10", ".STEP TEMP 0 100 10"]) {
      const [spec] = parseStepDirectives(line);
      if (!spec) { fail(`"${line}" did not parse at all`); continue; }
      if (!isTempSweep(spec.name)) fail(`"${line}" → name "${spec.name}" not recognised as a temperature sweep`);
    }
    // A source or param that merely *contains* "temp" is not the temperature.
    for (const name of ["temp1", "Vtemp", "tempco"]) {
      if (isTempSweep(name)) fail(`"${name}" must not count as the temperature sweep`);
    }
  } },

  { name: "withTemp sets .temp before .end and replaces any earlier one", run: (fail) => {
    const base = "* t\nV1 n1 0 DC 1\n.dc V1 0 1 0.01\n.end\n";
    const out = withTemp(base, 50);
    if (!/^\.temp 50$/m.test(out)) fail(`no ".temp 50" in:\n${out}`);
    const lines = out.split("\n");
    const t = lines.findIndex((l) => /^\.temp\b/.test(l));
    const e = lines.findIndex((l) => /^\.end\s*$/.test(l));
    if (!(t >= 0 && e >= 0 && t < e)) fail(`".temp" must come before ".end" (temp@${t}, end@${e})`);
    // A second sweep step must not stack another .temp on top of the first.
    const again = withTemp(out, 75);
    const count = (again.match(/^\.temp\b/gm) ?? []).length;
    if (count !== 1) fail(`expected exactly one .temp line, got ${count}`);
    if (!/^\.temp 75$/m.test(again)) fail("the later value did not replace the earlier one");
  } },

  { name: "a temp sweep does not fall through to the source/param substitutions", run: (fail) => {
    // The old behaviour: `.step temp` parsed as a source, and withDcSource then
    // matched no component line — so every run silently used the same default
    // temperature and the sweep drew identical curves.
    const base = "* t\nV1 n1 0 DC 1\nD1 n1 0 DMOD\n.dc V1 0 1 0.01\n.end\n";
    if (withDcSource(base, "temp", 50) !== base) {
      fail("withDcSource unexpectedly rewrote a line for a source named 'temp' — the guard would be moot");
    }
    // A real param sweep still goes the .param route, untouched by any of this.
    if (!/^\.param RM=50$/m.test(withParam(base, "RM", 50))) fail("a normal param sweep broke");
  } },
];

CASES.push(
  { name: "a .meas result without a time window is still read", run: (fail) => {
    // ngspice prints AVG/RMS with a `from=…to=` trailer but a PARAM measurement
    // bare, because it has no time window. Requiring the trailer dropped exactly
    // those — the pr1 curve of A08_PWM4 was missing for that reason alone.
    const log = [
      "===== ngspice output =====",
      "Circuit: * PWM",
      ".param T=1ms",                       // must not be mistaken for a result
      "",
      "  Measurements for Transient Analysis",
      "",
      "u1mittel            =  5.00001e+00 from=  0.00000e+00 to=  4.00000e-03",
      "u1eff               =  7.07107e+00 from=  1.00000e-11 to=  4.00000e-03",
      "pr1                 =  5.00001e+00",
      "",
    ].join("\n");
    const m = parseMeasurements(log);
    const by = (n: string) => m.find((x) => x.name === n)?.value;
    if (m.length !== 3) fail(`expected 3 measurements, got ${m.length}: ${m.map((x) => x.name).join(", ")}`);
    if (by("pr1") !== "5.00001e+00") fail(`the trailer-less PARAM result was not read (got ${by("pr1")})`);
    if (by("u1eff") !== "7.07107e+00") fail(`u1eff came back as ${by("u1eff")}`);
    // The echoed netlist sits before the block header and must stay out of it.
    if (m.some((x) => x.name === "T")) fail("`.param T=1ms` from the netlist echo was read as a measurement");
  } },
);

/** A fake sweep log: the block ngspice prints, with the given values. */
const measLog = (vals: Record<string, number | "failed">) =>
  ["  Measurements for Transient Analysis", "",
   ...Object.entries(vals).map(([n, v]) =>
     `${n.padEnd(20)}= ${v === "failed" ? " failed" : `${v.toExponential(5)} from=  0.0 to=  4.0e-03`}`),
  ].join("\n");

const gStep: StepSpec = { name: "g", values: [0, 50, 100], isSource: false, truncated: false };
const runsFor = (perStep: Record<string, number | "failed">[]) =>
  perStep.map((vals, i) => ({ combo: { assignments: [{ name: "g", value: gStep.values[i] }] }, log: measLog(vals) }));

CASES.push(
  { name: "measurement sweep puts each .meas on the stepped parameter", run: (fail) => {
    // The A08_PWM4 shape: u1eff rises as sqrt(duty), u1mittel linearly.
    const r = buildMeasurementSweep(runsFor([
      { u1mittel: 0, u1eff: 0.008 },
      { u1mittel: 5, u1eff: 7.07107 },
      { u1mittel: 9.99625, u1eff: 9.99875 },
    ]), [gStep]);
    if (!r) { fail("no measurement result was built"); return; }
    if (r.xLabel !== "g") fail(`x-axis is "${r.xLabel}", expected the stepped param "g"`);
    if (r.xUnit !== undefined) fail("a .step param has no knowable unit, so the axis must stay unitless");
    if (![...r.time!].every((v, i) => v === gStep.values[i])) fail("the x values are not the step values");
    const eff = r.data["u1eff"];
    if (!eff) { fail("u1eff missing from the series"); return; }
    if (Math.abs(eff[1] - 7.07107) > 1e-4) fail(`u1eff at g=50 is ${eff[1]}, expected 7.07107`);
    if (r.data["u1mittel"]?.[2] === undefined) fail("u1mittel missing");
  } },

  { name: "a measurement that fails for some steps leaves gaps, not zeros", run: (fail) => {
    // A zero would be plotted as a real reading and read as "the value dropped".
    const r = buildMeasurementSweep(runsFor([
      { pr1: "failed" }, { pr1: 5 }, { pr1: 10 },
    ]), [gStep]);
    if (!r) { fail("no result"); return; }
    const pr1 = r.data["pr1"]!;
    if (!Number.isNaN(pr1[0])) fail(`the failed step became ${pr1[0]}, expected NaN so the curve breaks`);
    if (pr1[1] !== 5 || pr1[2] !== 10) fail("the surviving steps were not carried through");
  } },

  { name: "nothing to plot yields no measurement result at all", run: (fail) => {
    // No .meas in the netlist: the scope must not offer an empty second view.
    if (buildMeasurementSweep(runsFor([{}, {}, {}]), [gStep])) fail("a result was built from logs without measurements");
    // A single step is a point, not a curve.
    const one: StepSpec = { name: "g", values: [0], isSource: false, truncated: false };
    const single = [{ combo: { assignments: [{ name: "g", value: 0 }] }, log: measLog({ u1eff: 1 }) }];
    if (buildMeasurementSweep(single, [one])) fail("a one-step sweep produced a curve");
  } },

  { name: "a second stepped param fans the measurements into tagged curves", run: (fail) => {
    const tStep: StepSpec = { name: "T", values: [1, 2], isSource: false, truncated: false };
    const runs = [];
    for (const T of tStep.values) for (const g of gStep.values) {
      runs.push({ combo: { assignments: [{ name: "g", value: g }, { name: "T", value: T }] },
                  log: measLog({ u1eff: g / 10 + T }) });
    }
    const r = buildMeasurementSweep(runs, [gStep, tStep]);
    if (!r) { fail("no result"); return; }
    const names = r.variables.filter((v) => v !== "time");
    if (!names.some((n) => n.includes("@T=1")) || !names.some((n) => n.includes("@T=2"))) {
      fail(`expected one curve per T, got: ${names.join(", ")}`);
    }
    if (r.step?.param !== "T") fail(`the outer step is reported as "${r.step?.param}", expected "T"`);
  } },
);

export function runDcSweepTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

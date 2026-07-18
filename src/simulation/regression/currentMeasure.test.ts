import { useSimulationStore, type SimulationResult } from "@store/simulationStore.js";
import { splitMeasDirectives, evaluateMeasurements, needsAppSideEval } from "../measure.js";
import { evalExpression, isExpression, resolveSeries } from "../expression.js";
import { insertCurrentSenses } from "@core/circuit/currentSense.js";
import { canonicalProbe, dedupeProbes, matchResultVariable, getCurrentProbeCandidates } from "@core/circuit/probeUtils.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * Device currents reaching the user — the "currents read as zero" family.
 *
 * Reported against A05_Wechselspannung4.asc, a teaching circuit that compares an
 * AC branch (10 V peak sine into 10 Ω) with a DC branch (7.071 V into 10 Ω): both
 * must dissipate the same 5 W. Four of its six `.meas` directives silently
 * produced nothing, and every one of those four involved a current.
 *
 * Three independent defects, all verified against the bundled ngspice:
 *
 *  1. `.meas TRAN Ieff RMS I(R1)` fails in the engine with "no such vector as
 *     'i(r1)'". Only devices with a real branch equation (V/E/H/L) have an
 *     `i(name)` vector; a resistor's current exists solely because
 *     `.options savecurrents` saves it, under the name `@r1[i]`. A composite
 *     like `V(U1)*I(R1)` fails regardless — `.meas` takes a vector, not a
 *     formula — and `par('…')` hangs the bundled engine. So the app evaluates
 *     that whole family itself, where `I(R1)` resolves through the same
 *     canonical matching the scope already uses.
 *
 *  2. AVG/RMS were sample means, but they are defined as time integrals. A
 *     transient run has an adaptive timestep, so unweighted averaging
 *     over-weights the densely sampled stretches.
 *
 *  3. A probe restored from a `.plt` (`V(U1)`) was matched against ngspice's
 *     answer (`v(u1)`) by exact string compare, so it was dropped on every run.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const sim = () => useSimulationStore.getState();

/** The six `.meas` directives of A05_Wechselspannung4.asc, verbatim. */
const A05_MEAS = [
  ".meas TRAN PAC AVG V(U1)*I(R1)",
  ".meas TRAN PDC AVG V(U2)*I(R2)",
  ".meas TRAN Umittel AVG V(U1)",
  ".meas TRAN Imittel AVG I(R1)",
  ".meas TRAN Ueff RMS V(U1)",
  ".meas TRAN Ieff RMS I(R1)",
];

/**
 * One period of a 50 Hz sine on a deliberately *non-uniform* grid, mimicking an
 * adaptive transient timestep: densely sampled around the positive peak, sparse
 * everywhere else.
 *
 * The lopsidedness is the point — it has to defeat a sample mean for both
 * statistics. Clustering the samples where |sin| is largest biases an unweighted
 * RMS *high* (toward the peak value rather than A/√2) and an unweighted AVG high
 * too (toward +A rather than 0). A time-weighted integral is unmoved by where
 * the samples happen to fall.
 */
function sineResult(amp: number): SimulationResult {
  const f = 50, T = 1 / f;
  const ts = new Set<number>();
  // Sparse over the whole period…
  for (let i = 0; i <= 60; i++) ts.add((i / 60) * T);
  // …dense in a narrow window straddling the peak at T/4.
  for (let i = 0; i <= 2000; i++) ts.add(0.2 * T + (i / 2000) * 0.1 * T);
  const sorted = [...ts].sort((a, b) => a - b);
  const time = new Float64Array(sorted);
  const cur = new Float64Array(sorted.map((t) => amp * Math.sin(2 * Math.PI * f * t)));
  return { variables: ["time", "i(@r1[i])"], data: { time, "i(@r1[i])": cur }, time };
}

const measure = (result: SimulationResult, directive: string) => {
  const { appSide } = splitMeasDirectives(directive);
  return evaluateMeasurements(result, appSide)[0];
};

const CASES: Case[] = [
  // ── 1. routing ────────────────────────────────────────────────────────────
  { name: "a resistor current is evaluated app-side, a source current is not", run: (fail) => {
    if (!needsAppSideEval("I(R1)")) fail("I(R1) was left to ngspice, which has no i(r1) vector");
    if (!needsAppSideEval("I(C1)")) fail("I(C1) was left to ngspice");
    if (!needsAppSideEval("I(Q1)")) fail("I(Q1) was left to ngspice");
    // V/E/H/L do have a branch current; ngspice measures those natively.
    if (needsAppSideEval("I(V1)")) fail("I(V1) was taken app-side although ngspice handles it");
    if (needsAppSideEval("I(L1)")) fail("I(L1) was taken app-side although ngspice handles it");
  } },

  { name: "a plain node voltage stays with ngspice, a composite does not", run: (fail) => {
    if (needsAppSideEval("V(U1)")) fail("V(U1) was taken app-side unnecessarily");
    // `.meas` takes a vector, not a formula — even an all-voltage product fails.
    if (!needsAppSideEval("V(U1)*I(R1)")) fail("the power product was left to ngspice");
    if (!needsAppSideEval("V(A)-V(B)")) fail("a difference was left to ngspice");
  } },

  { name: "A05's six measurements split 4 app-side / 2 engine-side", run: (fail) => {
    const { netlist, appSide } = splitMeasDirectives(A05_MEAS.join("\n"));
    const app = appSide.map((s) => s.name).sort().join(",");
    if (app !== "Ieff,Imittel,PAC,PDC") fail(`app-side = ${app || "(none)"}, expected Ieff,Imittel,PAC,PDC`);
    const kept = netlist.split("\n").filter((l) => l.trim()).map((l) => l.split(/\s+/)[2]).sort().join(",");
    if (kept !== "Ueff,Umittel") fail(`engine-side = ${kept || "(none)"}, expected Ueff,Umittel`);
  } },

  // ── 2. AVG / RMS are integrals, not sample means ──────────────────────────
  { name: "RMS of a sine is A/√2 even on an adaptive timestep", run: (fail) => {
    const amp = 1;
    const m = measure(sineResult(amp), ".meas TRAN Ieff RMS I(R1)");
    const got = Number(m?.value);
    const want = amp / Math.SQRT2;
    // 0.5% — well inside the trapezoid's error, well outside the ~8% a sample
    // mean lands on for this deliberately lopsided grid.
    if (!isFinite(got) || Math.abs(got - want) / want > 0.005) {
      fail(`RMS = ${m?.value}, expected ≈ ${want.toFixed(6)} (a sample mean gives the wrong answer here)`);
    }
  } },

  { name: "AVG of a full sine period is zero, not skewed by sample density", run: (fail) => {
    const m = measure(sineResult(1), ".meas TRAN Imittel AVG I(R1)");
    const got = Number(m?.value);
    // The dense half is the positive one, so an unweighted mean is biased high.
    if (!isFinite(got) || Math.abs(got) > 0.005) {
      fail(`AVG = ${m?.value}, expected ≈ 0 (sample density is biasing the mean)`);
    }
  } },

  { name: "a measurement over a single sample still returns that sample", run: (fail) => {
    // An `.op`-style result has no x extent: the trapezoid has nothing to
    // integrate over and must not produce NaN.
    const time = new Float64Array([0]);
    const r: SimulationResult = { variables: ["time", "i(@r1[i])"], data: { time, "i(@r1[i])": new Float64Array([0.25]) }, time };
    const m = measure(r, ".meas TRAN Ix AVG I(R1)");
    if (Math.abs(Number(m?.value) - 0.25) > 1e-9) fail(`AVG over one sample = ${m?.value}, expected 0.25`);
  } },

  // ── 3. probes surviving a run ─────────────────────────────────────────────
  { name: "a probe restored from a .plt survives the run across ngspice's casing", run: (fail) => {
    const time = new Float64Array([0, 1, 2]);
    const result: SimulationResult = {
      variables: ["time", "v(u1)", "i(@r2[i])"],
      data: { time, "v(u1)": new Float64Array([1, 2, 3]), "i(@r2[i])": new Float64Array([0.7, 0.7, 0.7]) },
      time,
    };
    sim().reset();
    // Exactly what A05_Wechselspannung4.plt restores.
    sim().setSelectedVariables(["i(@r2[i])", "V(U1)"]);
    sim().setResult(result);
    const sel = sim().selectedVariables;
    if (!sel.includes("v(u1)")) fail(`V(U1) was dropped on the run; kept: ${sel.join(", ") || "nothing"}`);
    if (!sel.includes("i(@r2[i])")) fail(`the current was dropped; kept: ${sel.join(", ") || "nothing"}`);
  } },

  // ── 4. the same product as a *plotted* trace ──────────────────────────────
  { name: "V(U2)*I(R2) is recognised as a formula and yields the real power", run: (fail) => {
    // A05's DC branch: 7.071 V across 10 Ω, so V*I is a flat 5 W. The plot only
    // evaluated a trace as a formula when it was in the registered expression
    // list; anything else went to resolveSeries, which returns null for a
    // product — drawn as nothing, and easily read as "the current is zero".
    const time = new Float64Array([0, 1, 2]);
    const result: SimulationResult = {
      variables: ["time", "v(u2)", "i(@r2[i])"],
      data: {
        time,
        "v(u2)": new Float64Array([7.071, 7.071, 7.071]),
        "i(@r2[i])": new Float64Array([0.7071, 0.7071, 0.7071]),
      },
      time,
    };
    if (!isExpression(result, "V(U2)*I(R2)")) fail("the product was not recognised as a formula");
    // Resolving it as a probe name must fail rather than silently half-match:
    // `V(U2)*I(R2)` starts with `V(` and greedily looks like a node voltage.
    if (resolveSeries(result, "V(U2)*I(R2)") !== null) fail("the product resolved as if it were a probe name");
    const r = evalExpression(result, "V(U2)*I(R2)");
    if (r.error) return fail(`evaluation failed: ${r.error}`);
    const p = r.values?.[0] ?? NaN;
    // Casing differs from ngspice's (v(u2) / i(@r2[i])) on purpose.
    if (Math.abs(p - 5) > 0.01) fail(`V(U2)*I(R2) = ${p}, expected ≈ 5 W`);
  } },

  // ── 5. AC: currents via series sense sources ──────────────────────────────
  // ngspice reports no R/C current in an `.ac` run, and *asking* for one breaks
  // its result write and then hangs runSim() forever — verified to be neither
  // device-specific (R, C, even L alone all hang) nor an artefact of
  // `savecurrents` being blunt (a targeted `.save @r1[i]` hangs identically).
  // A 0 V source in series gives the device a branch current the engine can
  // report; measured against theory on an R-C divider it is exact to all
  // printed digits, phase included.
  { name: "AC: a resistor and a capacitor get a series sense source", run: (fail) => {
    const out = insertCurrentSenses(["V1 in 0 AC 1", "R1 in mid 1k", "C1 mid 0 100n"]);
    const want = [
      "V1 in 0 AC 1",              // a source already has a branch current
      "V__i_R1 in __i_R1 0",
      "R1 __i_R1 mid 1k",
      "V__i_C1 mid __i_C1 0",
      "C1 __i_C1 0 100n",
    ];
    if (out.join(" | ") !== want.join(" | ")) fail(`rewrote to:\n  ${out.join("\n  ")}`);
  } },

  { name: "AC: devices that already have a branch current are left alone", run: (fail) => {
    // V/E/H/L report `i(name)` natively; an extra source is pure overhead.
    for (const line of ["V1 in 0 AC 1", "L1 a b 10m", "E1 a b c d 2"]) {
      const out = insertCurrentSenses([line]);
      if (out.length !== 1 || out[0] !== line) fail(`${line} was rewritten to ${out.join(" | ")}`);
    }
    // A transistor has no single "the current"; one sense source would misname
    // whichever terminal happened to come first, so it stays untouched.
    const q = insertCurrentSenses(["Q1 c b e 2N2222"]);
    if (q.length !== 1) fail(`a BJT was rewritten to ${q.join(" | ")}`);
  } },

  { name: "AC: the sense source is reported as the device's own current", run: (fail) => {
    const c = canonicalProbe("i(v__i_r1)");
    if (c?.display !== "I(R1)") fail(`shown as ${c?.display}, expected I(R1)`);
    if (c?.key !== "I:R1") fail(`key ${c?.key}, expected I:R1 (so I(R1) resolves to it)`);
    // The probe the schematic asks for must find it.
    const time = new Float64Array([0, 1]);
    const result: SimulationResult = {
      variables: ["frequency", "v(in)", "v(__i_r1)", "i(v__i_r1)"],
      data: {
        frequency: time, "v(in)": new Float64Array([1, 1]),
        "v(__i_r1)": new Float64Array([1, 1]), "i(v__i_r1)": new Float64Array([5.32e-4, 8.93e-4]),
      },
      time,
    };
    if (matchResultVariable(result, getCurrentProbeCandidates("R1")) !== "i(v__i_r1)") {
      fail("I(R1) did not resolve to its sense source");
    }
    // …and the node the source introduced is plumbing, not a signal the user
    // should have to scroll past (it duplicates v(in): 0 V across the source).
    const shown = dedupeProbes(result.variables).map((p) => p.display);
    if (shown.includes("V(__i_r1)")) fail(`the synthetic node is offered as a probe: ${shown.join(", ")}`);
    if (!shown.includes("I(R1)")) fail(`I(R1) is missing from the probe list: ${shown.join(", ")}`);
  } },

  // ── 6. AC differentials are phasor subtractions ───────────────────────────
  { name: "AC: V(a,b) subtracts phasors, not magnitudes", run: (fail) => {
    // Two signals of equal magnitude, 90° apart: |Va| − |Vb| = 0, while the true
    // |Va − Vb| = √2. The degenerate case is the point — subtracting magnitudes
    // reports exactly zero for a difference that is nothing of the sort, which
    // is how this hid: a flat zero trace reads as "no signal", not "wrong maths".
    const f = new Float64Array([1000]);
    const result: SimulationResult = {
      variables: ["frequency", "v(a)", "v(b)"],
      data: { frequency: f, "v(a)": new Float64Array([1]), "v(b)": new Float64Array([1]) },
      complex: {
        "v(a)": { re: new Float64Array([1]), im: new Float64Array([0]) },
        "v(b)": { re: new Float64Array([0]), im: new Float64Array([1]) },
      },
      time: f,
    };
    const d = resolveSeries(result, "V(a,b)")?.[0] ?? NaN;
    if (Math.abs(d - Math.SQRT2) > 1e-9) fail(`V(a,b) = ${d}, expected √2 ≈ 1.41421`);
  } },

  { name: "AC: a differential against ground is the node's own magnitude", run: (fail) => {
    const f = new Float64Array([1000]);
    const result: SimulationResult = {
      variables: ["frequency", "v(a)"],
      data: { frequency: f, "v(a)": new Float64Array([5]) },
      complex: { "v(a)": { re: new Float64Array([3]), im: new Float64Array([4]) } },
      time: f,
    };
    const d = resolveSeries(result, "V(a,0)")?.[0] ?? NaN;
    if (Math.abs(d - 5) > 1e-9) fail(`V(a,0) = ${d}, expected 5 (|3+4j|)`);
  } },

  { name: "a transient differential keeps subtracting the real samples", run: (fail) => {
    // Real data carries no phase, and there the plain difference is correct —
    // the phasor path must not disturb it.
    const time = new Float64Array([0, 1, 2]);
    const result: SimulationResult = {
      variables: ["time", "v(a)", "v(b)"],
      data: { time, "v(a)": new Float64Array([5, 5, 5]), "v(b)": new Float64Array([2, 2, 2]) },
      time,
    };
    const d = resolveSeries(result, "V(a,b)");
    if (!d || Math.abs(d[0] - 3) > 1e-9) fail(`V(a,b) = ${d?.[0]}, expected 3`);
  } },

  { name: "asking for one current adds one trace, not one per spelling", run: (fail) => {
    const time = new Float64Array([0, 1, 2]);
    const result: SimulationResult = {
      variables: ["time", "i(@r2[i])"],
      data: { time, "i(@r2[i])": new Float64Array([0.7, 0.7, 0.7]) },
      time,
    };
    sim().reset();
    sim().setResult(result);
    // The four alternative spellings of one quantity, as the schematic offers them.
    sim().addProbeCandidates(["I(R2)", "i(R2)", "@R2[i]", "@r2[i]"]);
    const sel = sim().selectedVariables;
    if (sel.length !== 1) fail(`added ${sel.length} traces (${sel.join(", ")}), expected 1`);
  } },
];

export function runCurrentMeasureTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

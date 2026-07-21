import type { SimulationResult } from "@store/simulationStore.js";
import { evalExpression, exprCheckResult, stepView, parametricXSeries } from "../expression.js";
import { inferUnit } from "../units.js";

export interface TestReport {
  total: number;
  passed: number;
  failures: { name: string; reason: string }[];
}

/** Build a tiny result with a shared time base and named series. */
function makeResult(series: Record<string, number[]>): SimulationResult {
  const time = new Float64Array([0, 1, 2]);
  const data: Record<string, Float64Array> = { time };
  for (const [k, v] of Object.entries(series)) data[k] = new Float64Array(v);
  return { variables: ["time", ...Object.keys(series)], data, time };
}

type Case = { name: string; run: (fail: (r: string) => void) => void };

const CASES: Case[] = [
  {
    name: "arithmetic over two probes",
    run: (fail) => {
      const res = makeResult({ "v(a)": [3, 4, 5], "v(b)": [1, 1, 1] });
      const r = evalExpression(res, "V(a)-V(b)");
      if (r.error) return fail(r.error);
      if (!r.values || Array.from(r.values).join(",") !== "2,3,4") fail(`got ${r.values && Array.from(r.values)}`);
    },
  },
  {
    name: "{param} resolves a component value (I(R1)*{R1})",
    run: (fail) => {
      const res = makeResult({ "i(r1)": [0.1, 0.2, 0.3] });
      const r = evalExpression(res, "I(R1)*{R1}", { R1: 100 });
      if (r.error) return fail(r.error);
      // 0.1*100, 0.2*100, 0.3*100
      const got = r.values && Array.from(r.values).map((v) => Math.round(v));
      if (!got || got.join(",") !== "10,20,30") fail(`got ${got}`);
    },
  },
  {
    name: "{param} lookup is case-insensitive",
    run: (fail) => {
      const res = makeResult({ "v(a)": [2, 2, 2] });
      const r = evalExpression(res, "V(a)*{r1}", { R1: 3 });
      if (r.error) return fail(r.error);
      if (!r.values || Array.from(r.values).join(",") !== "6,6,6") fail(`got ${r.values && Array.from(r.values)}`);
    },
  },
  {
    name: "unknown {param} reports an error",
    run: (fail) => {
      const res = makeResult({ "v(a)": [1, 1, 1] });
      const r = evalExpression(res, "V(a)*{Rx}", { R1: 3 });
      if (!r.error) fail("expected an error for unknown parameter");
    },
  },
  {
    name: "trailing [unit] annotation is ignored when evaluating",
    run: (fail) => {
      const res = makeResult({ "i(d2)": [0.1, 0.2, 0.3] });
      const r = evalExpression(res, "{R1}*I(D2) [V]", { R1: 100 });
      if (r.error) return fail(r.error);
      const got = r.values && Array.from(r.values).map((v) => Math.round(v));
      if (!got || got.join(",") !== "10,20,30") fail(`got ${got}`);
    },
  },
  {
    name: "explicit [V] annotation overrides inferred unit",
    run: (fail) => {
      // {R1}*I(D2) can't be dimensionally inferred (a {param} has no unit) → "",
      // but the annotation forces "V" so it shares the voltage axis.
      if (inferUnit("{R1}*I(D2)") !== "") fail(`bare inferUnit = ${inferUnit("{R1}*I(D2)")}`);
      if (inferUnit("{R1}*I(D2) [V]") !== "V") fail(`annotated inferUnit = ${inferUnit("{R1}*I(D2) [V]")}`);
      // Annotation must not disturb a device-current suffix like @r1[i].
      if (inferUnit("I(@r1[i])") !== "A") fail(`device current inferUnit = ${inferUnit("I(@r1[i])")}`);
    },
  },
  {
    // A `.step` sweep tags every vector (`v(u2+) @1`, `@2`, …). The user writes
    // the expression the way the probe list shows it — `V(u2+)-V(u2-)` — so
    // validating it against the *raw* result found no such variable and rejected
    // every function on a stepped run ("Unknown variable"), even though the plot
    // evaluates them per step without trouble. Names with `+`/`-` (a B2U bridge
    // labels its output U2+ / U2-) were a red herring: it hit any expression.
    // A6_B2U-Schaltung1_Glaeetung1.asc.
    name: "a function resolves on a .step run (validated against one step's view)",
    run: (fail) => {
      const stepped: SimulationResult = {
        variables: ["time", "v(u2+) @1", "v(u2-) @1", "v(u2+) @2", "v(u2-) @2"],
        time: new Float64Array([0, 1, 2]),
        data: {
          "v(u2+) @1": new Float64Array([10, 11, 12]),
          "v(u2-) @1": new Float64Array([2, 3, 4]),
          "v(u2+) @2": new Float64Array([20, 21, 22]),
          "v(u2-) @2": new Float64Array([5, 5, 5]),
        },
      };
      const expr = "V(u2+)-V(u2-)";

      // The raw result cannot resolve it — this is what the add-function check used.
      if (!evalExpression(stepped, expr).error) fail("the raw stepped result should not resolve a plain name");

      // The view the check must use: one step, plain names.
      const checked = evalExpression(exprCheckResult(stepped, ["1", "2"]), expr);
      if (checked.error) { fail(`the function was rejected on a stepped run: ${checked.error}`); return; }
      if (!checked.values) { fail("no values"); return; }
      if (checked.values[0] !== 8 || checked.values[2] !== 8) {
        fail(`step 1 values ${[...checked.values]} ≠ 8,8,8`);
      }

      // And each step evaluates on its own data (that is what the plot draws).
      const s2 = evalExpression(stepView(stepped, "2"), expr);
      if (s2.error) { fail(`step 2 failed: ${s2.error}`); return; }
      if (s2.values?.[0] !== 15) fail(`step 2 value ${s2.values?.[0]} ≠ 15`);

      // Without a step sweep the raw result is used unchanged.
      const plain: SimulationResult = {
        variables: ["time", "v(a)"], time: new Float64Array([0, 1]),
        data: { "v(a)": new Float64Array([1, 2]) },
      };
      if (exprCheckResult(plain, null) !== plain) fail("an unstepped result must be passed through unchanged");
    },
  },
  {
    // A Bode plot needs both curves at once, so the phase has to land on its own
    // y-axis. Panels split their axes by unit, and the unit is inferred from the
    // trace name — so `ph(V(out))` reporting "V" put a ±180° swing on the volt
    // axis, where it squashed the magnitude flat.
    name: "ph() is an angle, not the unit of its argument",
    run: (fail) => {
      if (inferUnit("ph(V(out))") !== "°") fail(`ph(V(out)) unit = "${inferUnit("ph(V(out))")}"`);
      if (inferUnit("phase(V(out))") !== "°") fail(`phase() unit = "${inferUnit("phase(V(out))")}"`);
      if (inferUnit("PH(I(R1))") !== "°") fail(`PH(I(R1)) unit = "${inferUnit("PH(I(R1))")}"`);
      // The magnitude of the same signal keeps its own unit, which is what puts
      // the two on separate axes of one panel.
      if (inferUnit("V(out)") !== "V") fail(`V(out) unit = "${inferUnit("V(out)")}"`);
      // Only a whole-expression call is a phase. A plain probe whose node
      // happens to start with "ph" must not be mistaken for one.
      if (inferUnit("V(phase1)") !== "V") fail(`V(phase1) unit = "${inferUnit("V(phase1)")}"`);
    },
  },
  {
    // "How far apart are U1 and U2?" is a difference of two phases, so the
    // degrees have to survive the subtraction — otherwise the answer lands back
    // on the volt axis, which is the whole problem this fixes.
    name: "a phase difference is still degrees",
    run: (fail) => {
      const u = (e: string) => inferUnit(e);
      if (u("ph(V(U1))-ph(V(U2))") !== "°") fail(`difference unit = "${u("ph(V(U1))-ph(V(U2))")}"`);
      if (u("ph(V(U1)) - ph(V(U2))") !== "°") fail(`spaced difference = "${u("ph(V(U1)) - ph(V(U2))")}"`);
      if (u("ph(I(R1))-ph(V(U1))") !== "°") fail(`mixed-argument difference = "${u("ph(I(R1))-ph(V(U1))")}"`);
      // A phase plus a voltage is not a quantity — it must not claim either axis.
      if (u("ph(V(U1))+V(U2)") !== "") fail(`phase+voltage = "${u("ph(V(U1))+V(U2)")}"`);
      // The argument is skipped whole, so what follows still parses: a phase
      // scaled by a number stays an angle.
      if (u("2*ph(V(U1))") !== "°") fail(`scaled phase = "${u("2*ph(V(U1))")}"`);
    },
  },
  {
    name: "a phase difference evaluates to the angle between two signals",
    run: (fail) => {
      // U1 at +90°, U2 at +30° → U1 leads U2 by 60°.
      const res: SimulationResult = {
        variables: ["frequency", "v(u1)", "v(u2)"],
        time: new Float64Array([1]),
        data: { "v(u1)": new Float64Array([1]), "v(u2)": new Float64Array([1]) },
        complex: {
          "v(u1)": { re: new Float64Array([0]), im: new Float64Array([1]) },
          "v(u2)": { re: new Float64Array([Math.cos(Math.PI / 6)]), im: new Float64Array([Math.sin(Math.PI / 6)]) },
        },
      };
      const r = evalExpression(res, "ph(V(U1))-ph(V(U2))");
      if (r.error) return fail(r.error);
      if (!r.values || Math.abs(r.values[0] - 60) > 1e-6) fail(`got ${r.values?.[0]} ≠ 60`);
    },
  },
  {
    name: "ph() returns degrees from the .ac phasors",
    run: (fail) => {
      // Three points at 0°, +90° and −45°.
      const res: SimulationResult = {
        variables: ["frequency", "v(out)"],
        time: new Float64Array([1, 2, 3]),
        data: { "v(out)": new Float64Array([1, 1, Math.SQRT2]) },
        complex: { "v(out)": { re: new Float64Array([1, 0, 1]), im: new Float64Array([0, 1, -1]) } },
      };
      const r = evalExpression(res, "ph(V(out))");
      if (r.error) return fail(r.error);
      const got = r.values && Array.from(r.values).map((v) => Math.round(v));
      if (!got || got.join(",") !== "0,90,-45") fail(`got ${got}`);
    },
  },
  {
    name: "ph() on a transient result explains itself",
    run: (fail) => {
      // No phasors — the message must name the reason rather than claim the
      // variable is unknown, since the variable is right there.
      const res = makeResult({ "v(out)": [1, 2, 3] });
      const r = evalExpression(res, "ph(V(out))");
      if (!r.error) return fail("expected an error without an .ac result");
      if (!/\.ac/.test(r.error)) fail(`unhelpful message: ${r.error}`);
    },
  },
];

/** A stepped result: one run per tag, each with its own v(c) and Ic. */
function makeStepped(): SimulationResult {
  const time = new Float64Array([0, 10, 20]);   // sweep base V1
  const data: Record<string, Float64Array> = { time };
  const variables = ["time"];
  // Higher base current -> more collector current -> more drop across R1, so
  // each run ends at its own v(c). That difference is the whole point.
  for (const [tag, drop] of [["I1=1m", 1.5], ["I1=20m", 10]] as const) {
    data[`v(c) @${tag}`] = new Float64Array([0, 10 - drop / 2, 20 - drop]);
    data[`i(@q1[ic]) @${tag}`] = new Float64Array([0, drop / 20, drop / 10]);
    variables.push(`v(c) @${tag}`, `i(@q1[ic]) @${tag}`);
  }
  return { variables, data, time, step: { param: "I1", values: ["I1=1m", "I1=20m"] } };
}

CASES.push(
  { name: "parametric x-axis picks each curve's own run", run: (fail) => {
    const r = makeStepped();
    const tags = r.step!.values;
    const a = parametricXSeries(r, "V(C)", "i(@q1[ic]) @I1=1m", tags);
    const b = parametricXSeries(r, "V(C)", "i(@q1[ic]) @I1=20m", tags);
    if (!a || !b) { fail("V(C) did not resolve for a stepped run"); return; }
    // Sharing one x-series would lay both curves over the first step's x — the
    // failure that made an output-characteristic family collapse into one line.
    if (a[2] === b[2]) fail(`both steps got the same x (${a[2]}); each needs its own run`);
    if (a[2] !== 18.5) fail(`step I1=1m ends at x=${a[2]}, expected 18.5`);
    if (b[2] !== 10) fail(`step I1=20m ends at x=${b[2]}, expected 10`);
  } },

  { name: "parametric x-axis resolves however the quantity is spelled", run: (fail) => {
    const r = makeStepped();
    const tags = r.step!.values;
    // ngspice answers "v(c)"; the user types what the schematic shows.
    for (const name of ["V(C)", "v(c)", "  V(c) "]) {
      if (!parametricXSeries(r, name, "i(@q1[ic]) @I1=1m", tags)) fail(`"${name}" did not resolve`);
    }
    if (parametricXSeries(r, "", "i(@q1[ic]) @I1=1m", tags)) fail("an empty quantity must mean the sweep base");
    if (parametricXSeries(r, "V(nonexistent)", "i(@q1[ic]) @I1=1m", tags)) fail("an unknown quantity must resolve to null");
  } },

  { name: "parametric x-axis works without any stepping", run: (fail) => {
    const r = makeResult({ "v(c)": [0, 5, 10], "i(r1)": [0, 1, 2] });
    const xs = parametricXSeries(r, "V(C)", "i(r1)", null);
    if (!xs) { fail("V(C) did not resolve for a plain run"); return; }
    if (xs[2] !== 10) fail(`expected x to end at 10, got ${xs[2]}`);
  } },
);

export function runExpressionTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];

  let failedCases = 0;
  for (const tc of CASES) {
    let failed = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); failed = true; });
    if (failed) failedCases++;
  }
  return { total: CASES.length, passed: CASES.length - failedCases, failures };
}
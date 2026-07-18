import { parseSpiceNumber } from "@core/circuit/NetlistGenerator.js";
import type { SimulationResult } from "@store/simulationStore.js";
import { evalExpression } from "./expression.js";

/**
 * `.meas` directives evaluated in the app rather than by ngspice.
 *
 * Two forms have to be handled here:
 *  - `.meas OP …` — ngspice has no `op` measurement mode, and with `.step` the
 *    stepped dataset only exists app-side (the sweep is orchestrated by
 *    {@link ../simulation/paramSweep}), so LTSpice's "measure across the steps"
 *    semantics are unreachable from inside the engine.
 *  - any `.meas` whose `WHEN …=X` / `AT X` target names an earlier `.meas`
 *    result — ngspice's parameter-substitution pass reads `X` as a `.param`,
 *    fails with "Undefined parameter", and then never returns a result vector,
 *    leaving `runSim()` pending forever.
 *
 * Such lines are removed from the netlist and computed from the result instead.
 */

export type MeasFn = "max" | "min" | "avg" | "rms" | "pp" | "find" | "when";

export interface MeasSpec {
  /** The directive as written, for error reporting. */
  raw: string;
  name: string;
  /** `op`, `tran`, `ac`, … as written. */
  analysis: string;
  fn: MeasFn;
  /** Expression to measure, e.g. `V(UKL)*I(RMotor)`. */
  expr: string;
  /** `WHEN expr=<target>` or `FIND expr AT <target>`: a number or a `.meas` name. */
  target?: string;
  /** Set when the directive could not be parsed into a supported form. */
  unsupported?: boolean;
}

export interface Measurement {
  name: string;
  value: string;
}

const MEAS_RE = /^\s*\.meas(?:ure)?\s+(op|tran|ac|dc|sp|noise)\s+(\w+)\s+(.*)$/i;

/** Parse the part after `.meas <analysis> <name>` into a supported measurement. */
function parseMeasBody(body: string): Pick<MeasSpec, "fn" | "expr" | "target"> | null {
  const reduce = body.match(/^(max|min|avg|rms|pp|peak_to_peak)\s+(.+)$/i);
  if (reduce) {
    const fn = reduce[1].toLowerCase();
    return { fn: (fn === "peak_to_peak" ? "pp" : fn) as MeasFn, expr: reduce[2].trim() };
  }
  const when = body.match(/^when\s+(.+?)\s*=\s*([^\s=]+)\s*$/i);
  if (when) return { fn: "when", expr: when[1].trim(), target: when[2].trim() };

  const find = body.match(/^find\s+(.+?)\s+at\s+(\S+)\s*$/i);
  if (find) return { fn: "find", expr: find[1].trim(), target: find[2].trim() };

  return null;
}

/**
 * A bare identifier target (`… = Pmax`, `AT RLPmax`) names a `.meas` result or a
 * `.param`. ngspice runs it through parameter substitution, and an unresolved
 * name aborts the run *without* settling `runSim()`. A `v(b)` / `1meg` target is
 * fine for ngspice and stays in the netlist.
 */
function isNameTarget(target: string | undefined): boolean {
  return target != null && parseSpiceNumber(target) == null && /^[A-Za-z_]\w*$/.test(target);
}

/**
 * ngspice devices that carry a real branch current, so `I(name)` resolves inside
 * `.meas`. Everything else (R, C, D, Q, M, …) only has a current because
 * `.options savecurrents` saves it, and that vector is named `@r1[i]` — `i(r1)`
 * simply does not exist and the measurement fails.
 */
const BRANCH_CURRENT_DEVICES = /^[vehl]/i;

/**
 * True when ngspice cannot evaluate this `.meas` expression itself, so the app
 * has to. Two cases, both observed against the bundled engine:
 *
 *  - a device current ngspice has no vector for: `.meas TRAN Ieff RMS I(R1)`
 *    fails with "no such vector as 'i(r1)'". Rewriting it to `@r1[i]` does work
 *    for a bare vector, but not inside a product (below), and `par('…')` hangs
 *    the engine — so the app evaluates the whole family instead, uniformly.
 *  - any composite expression: `.meas TRAN PAC AVG V(U1)*I(R1)` fails with
 *    "no such vector as 'v(u1)*i(r1)'" — `.meas` takes a vector, not a formula.
 *
 * The app-side evaluator handles both: `evalExpression` resolves `I(R1)` to the
 * engine's `i(@r1[i])` through the same canonical matching the scope uses.
 */
export function needsAppSideEval(expr: string): boolean {
  if (!expr) return false;
  // Composite (an operator outside the parentheses of a probe reference).
  if (/[-+*/]/.test(expr.replace(/[A-Za-z_@][\w.]*\s*\([^()]*\)/g, ""))) return true;
  // A device current ngspice has no vector for.
  for (const m of expr.matchAll(/\bi\s*\(\s*([^\s,()]+)\s*\)/gi)) {
    if (!BRANCH_CURRENT_DEVICES.test(m[1])) return true;
  }
  return false;
}

/**
 * Split the netlist into the part ngspice can run and the `.meas` directives the
 * app has to evaluate itself. Measurements ngspice handles natively (a `.meas
 * tran/ac/dc` with a literal target over a vector it knows) stay in the netlist
 * and are read back from its log as before.
 */
export function splitMeasDirectives(netlist: string): { netlist: string; appSide: MeasSpec[] } {
  const appSide: MeasSpec[] = [];
  const kept: string[] = [];

  for (const line of netlist.split(/\r?\n/)) {
    const m = line.match(MEAS_RE);
    if (!m) { kept.push(line); continue; }
    const [, analysis, name, body] = m;
    const parsed = parseMeasBody(body.trim());
    // `.meas op` has no ngspice equivalent; a name target aborts its parser; and
    // an expression it has no vector for fails outright (see needsAppSideEval).
    const isOp = analysis.toLowerCase() === "op";
    const appExpr = !!parsed && needsAppSideEval(parsed.expr);
    if (!isOp && !isNameTarget(parsed?.target) && !appExpr) { kept.push(line); continue; }

    appSide.push(
      parsed
        ? { raw: line.trim(), name, analysis, ...parsed }
        : { raw: line.trim(), name, analysis, fn: "max", expr: "", unsupported: true },
    );
  }
  return { netlist: kept.join("\n"), appSide };
}

/**
 * Time-weighted mean of `f(y)` over the x axis, by the trapezoidal rule.
 *
 * AVG and RMS are *integrals* (`(1/T)∫f dt`), not sample averages — and a
 * transient run has an adaptive timestep, so ngspice packs samples where the
 * signal moves fast. Averaging the samples unweighted therefore over-weights
 * those regions: the RMS of a 10 V / 10 Ω sine came out 0.7043 A instead of
 * 0.7071 A, which is exactly the kind of small, plausible-looking error that
 * makes a measurement worse than useless in a teaching circuit.
 *
 * Falls back to the plain mean when the x axis has no extent (an `.op` sweep,
 * or a single sample), where a trapezoid has nothing to integrate over.
 */
function timeMean(xs: Float64Array, ys: Float64Array, f: (y: number) => number): number {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return NaN;
  const span = xs[n - 1] - xs[0];
  if (n === 1 || span <= 0) {
    let s = 0;
    for (let i = 0; i < n; i++) s += f(ys[i]);
    return s / n;
  }
  let area = 0;
  for (let i = 1; i < n; i++) area += ((f(ys[i - 1]) + f(ys[i])) / 2) * (xs[i] - xs[i - 1]);
  return area / span;
}

/** Linear interpolation of `ys` at `x`, over an ascending `xs`. */
function interpolate(xs: Float64Array, ys: Float64Array, x: number): number {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return NaN;
  if (n === 1 || x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  for (let i = 1; i < n; i++) {
    if (x <= xs[i]) {
      const span = xs[i] - xs[i - 1];
      if (span === 0) return ys[i];
      return ys[i - 1] + ((x - xs[i - 1]) / span) * (ys[i] - ys[i - 1]);
    }
  }
  return ys[n - 1];
}

/**
 * The x value at which `ys` first reaches `target` (exact hit or sign change).
 * `target` may be a constant or a second series (`WHEN v(a)=v(b)`).
 */
function crossing(xs: Float64Array, ys: Float64Array, target: number | Float64Array): number {
  const at = (i: number) => (typeof target === "number" ? target : target[i]);
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) if (ys[i] === at(i)) return xs[i];
  for (let i = 1; i < n; i++) {
    const a = ys[i - 1] - at(i - 1);
    const b = ys[i] - at(i);
    if (a < 0 !== b < 0) return xs[i - 1] + (a / (a - b)) * (xs[i] - xs[i - 1]);
  }
  return NaN;
}

/** Six significant digits, without the trailing zeros `toPrecision` leaves behind. */
function fmt(v: number): string {
  if (!isFinite(v)) return String(v);
  return String(Number(v.toPrecision(6)));
}

/**
 * Evaluate app-side `.meas` directives against a result. The result's x-axis is
 * the measurement domain: time for `.tran`, and for a `.step`ped `.op` the
 * stepped parameter — which is what makes `WHEN …` return e.g. the load
 * resistance at maximum power.
 *
 * Earlier measurements are visible to later ones by name (LTSpice behaviour), so
 * `FIND V(UKL) AT RLPmax` picks up the `RLPmax` computed one line above.
 */
export function evaluateMeasurements(
  result: SimulationResult,
  specs: MeasSpec[],
  params: Record<string, number> = {},
): Measurement[] {
  const xs = result.time;
  const out: Measurement[] = [];
  const scalars = new Map<string, number>();

  /** A `.meas` target: a literal, an earlier measurement, or a probe expression. */
  const resolveTarget = (t: string): number | Float64Array => {
    const lit = parseSpiceNumber(t);
    if (lit != null) return lit;
    const s = scalars.get(t.toLowerCase());
    if (s != null) return s;
    const { values, error } = evalExpression(result, t, params);
    if (error || !values) throw new Error(`unknown reference "${t}"`);
    return values;
  };
  const resolveScalar = (t: string): number => {
    const v = resolveTarget(t);
    if (typeof v !== "number") throw new Error(`"${t}" is not a single value`);
    return v;
  };

  for (const spec of specs) {
    try {
      if (spec.unsupported) throw new Error("unsupported .meas form");
      if (!xs || xs.length === 0) throw new Error("no data");
      const { values, error } = evalExpression(result, spec.expr, params);
      if (error || !values) throw new Error(error ?? "cannot evaluate expression");

      let v: number;
      switch (spec.fn) {
        case "max": v = values.reduce((a, b) => Math.max(a, b), -Infinity); break;
        case "min": v = values.reduce((a, b) => Math.min(a, b), Infinity); break;
        case "pp":
          v = values.reduce((a, b) => Math.max(a, b), -Infinity) - values.reduce((a, b) => Math.min(a, b), Infinity);
          break;
        case "avg": v = timeMean(xs, values, (y) => y); break;
        case "rms": v = Math.sqrt(timeMean(xs, values, (y) => y * y)); break;
        case "when": v = crossing(xs, values, resolveTarget(spec.target!)); break;
        case "find": v = interpolate(xs, values, resolveScalar(spec.target!)); break;
      }
      if (isFinite(v)) scalars.set(spec.name.toLowerCase(), v);
      out.push({ name: spec.name, value: fmt(v) });
    } catch (e) {
      out.push({ name: spec.name, value: `error: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return out;
}

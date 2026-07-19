import { matchResultVariable } from "@core/circuit/probeUtils.js";
import type { SimulationResult } from "@store/simulationStore.js";
import { splitUnitAnnotation } from "./units.js";

/**
 * Arithmetic expressions over probe variables, e.g. `V(punkt1)-V(punkt2)`,
 * `I(R1)*V(out)` or `(V(a)+V(b))/2`. Supports `+ - * /`, parentheses and
 * unary minus. References are resolved against the current simulation result
 * via {@link matchResultVariable}, so both `V(node)`/`v(node)` and raw ngspice
 * vector names work.
 *
 * A `{name}` token resolves to a scalar parameter — a component value (e.g.
 * `{R1}` → R1's resistance) or a `.param` — so expressions like `I(R1)*{R1}`
 * (the power in R1) work. Parameter values come from the `params` map.
 */

/** `V(a,b)` — the potential difference between two nodes, as LTSpice writes it. */
const DIFF_RE = /^\s*v\s*\(\s*([^\s,()]+)\s*,\s*([^\s,()]+)\s*\)\s*$/i;

/** Node voltage of a single node; the ground node `0` is identically zero. */
function nodeVoltage(result: SimulationResult, node: string, length: number): Float64Array | null {
  if (node === "0") return new Float64Array(length);
  const match = matchResultVariable(result, [`V(${node})`]);
  return match ? result.data[match] ?? null : null;
}

/**
 * Complex node voltage of a single node, for an `.ac` result. The ground node is
 * identically zero; a node the run doesn't have yields null.
 */
function nodePhasor(result: SimulationResult, node: string, length: number) {
  if (!result.complex) return null;
  if (node === "0") return { re: new Float64Array(length), im: new Float64Array(length) };
  const match = matchResultVariable(result, [`V(${node})`]);
  return match ? result.complex[match] ?? null : null;
}

/**
 * Complex series behind a reference — a raw variable, or a `V(a,b)` differential
 * subtracted as phasors. Null for a transient result, which carries no phase.
 */
export function resolvePhasor(
  result: SimulationResult, ref: string,
): { re: Float64Array; im: Float64Array } | null {
  if (!result.complex) return null;
  if (result.complex[ref]) return result.complex[ref];
  const diff = ref.match(DIFF_RE);
  if (diff) {
    const len = result.time?.length ?? 0;
    const a = nodePhasor(result, diff[1], len);
    const b = nodePhasor(result, diff[2], len);
    if (!a || !b) return null;
    const n = Math.min(a.re.length, b.re.length);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { re[i] = a.re[i] - b.re[i]; im[i] = a.im[i] - b.im[i]; }
    return { re, im };
  }
  const match = matchResultVariable(result, [ref]);
  return match ? result.complex[match] ?? null : null;
}

/** Resolve a single reference token (e.g. `V(out)`) to a data series. */
export function resolveSeries(result: SimulationResult, ref: string): Float64Array | null {
  if (result.data[ref]) return result.data[ref];
  // A differential probe has no result vector of its own — subtract the two
  // node voltages. ngspice never emits `v(a,b)`, so this must happen app-side.
  const diff = ref.match(DIFF_RE);
  if (diff) {
    const len = result.time?.length ?? 0;
    // An AC result must be subtracted as *phasors*: |Va| − |Vb| is not
    // |Va − Vb| unless the two happen to be in phase, and the error is large
    // (71% across the resistor of an RC divider at 1 kHz). Transient data is
    // real, so there the two are the same thing and the magnitude path stands.
    const pa = nodePhasor(result, diff[1], len);
    const pb = nodePhasor(result, diff[2], len);
    if (pa && pb) {
      const n = Math.min(pa.re.length, pb.re.length);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = Math.hypot(pa.re[i] - pb.re[i], pa.im[i] - pb.im[i]);
      return out;
    }
    const a = nodeVoltage(result, diff[1], len);
    const b = nodeVoltage(result, diff[2], len);
    if (!a || !b) return null;
    const out = new Float64Array(Math.min(a.length, b.length));
    for (let i = 0; i < out.length; i++) out[i] = a[i] - b[i];
    return out;
  }
  const match = matchResultVariable(result, [ref]);
  return match ? result.data[match] ?? null : null;
}

/** Names that mean "the phase of", in degrees (LTSpice writes `ph()`). */
const PHASE_FNS = new Set(["ph", "phase"]);

/** A value node compiled to `(sampleIndex) => number`. */
type Eval = (i: number) => number;

type Tok =
  | { t: "num"; v: number }
  | { t: "ref"; v: string }
  | { t: "param"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Tok[] {
  const re =
    /\s+|([0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)|\{\s*([A-Za-z_@][\w.]*)\s*\}|([A-Za-z_@][\w.]*\s*\([^()]*\))|([A-Za-z_@][\w.]*)|([+\-*/()])/g;
  const toks: Tok[] = [];
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index !== last) throw new Error(`Unexpected "${src.slice(last, m.index)}"`);
    last = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: "num", v: parseFloat(m[1]) });
    else if (m[2] !== undefined) toks.push({ t: "param", v: m[2] });
    else if (m[3] !== undefined) toks.push({ t: "ref", v: m[3].replace(/\s+/g, "") });
    else if (m[4] !== undefined) toks.push({ t: "ref", v: m[4] });
    else if (m[5] !== undefined) toks.push({ t: "op", v: m[5] });
    // whitespace: skip
  }
  if (last !== src.length) throw new Error(`Unexpected "${src.slice(last)}"`);
  return toks;
}

/** Recursive-descent parser: expr → term (('+'|'-') term)*, term → factor, etc. */
function compile(src: string, result: SimulationResult, params: Record<string, number>): Eval {
  const toks = tokenize(src);
  let pos = 0;

  const peek = () => toks[pos];
  const peekAt = (n: number) => toks[pos + n];
  const eat = (op?: string): Tok => {
    const t = toks[pos];
    if (!t) throw new Error("Unexpected end of expression");
    if (op && !(t.t === "op" && t.v === op)) throw new Error(`Expected "${op}"`);
    pos++;
    return t;
  };

  const parseExpr = (): Eval => {
    let left = parseTerm();
    while (peek()?.t === "op" && (peek().v === "+" || peek().v === "-")) {
      const op = eat().v;
      const right = parseTerm();
      const l = left, r = right;
      left = op === "+" ? (i) => l(i) + r(i) : (i) => l(i) - r(i);
    }
    return left;
  };

  const parseTerm = (): Eval => {
    let left = parseFactor();
    while (peek()?.t === "op" && (peek().v === "*" || peek().v === "/")) {
      const op = eat().v;
      const right = parseFactor();
      const l = left, r = right;
      left = op === "*" ? (i) => l(i) * r(i) : (i) => l(i) / r(i);
    }
    return left;
  };

  const parseFactor = (): Eval => {
    const t = peek();
    if (!t) throw new Error("Unexpected end of expression");
    if (t.t === "op" && t.v === "-") {
      eat();
      const inner = parseFactor();
      return (i) => -inner(i);
    }
    if (t.t === "op" && t.v === "+") {
      eat();
      return parseFactor();
    }
    if (t.t === "op" && t.v === "(") {
      eat("(");
      const inner = parseExpr();
      eat(")");
      return inner;
    }
    if (t.t === "num") {
      eat();
      return () => t.v;
    }
    if (t.t === "param") {
      eat();
      const key = Object.keys(params).find((k) => k.toLowerCase() === t.v.toLowerCase());
      if (key === undefined) throw new Error(`Unknown parameter "{${t.v}}"`);
      const val = params[key];
      return () => val;
    }
    if (t.t === "ref") {
      // `ph(V(out))` — the phase of a signal, for a Bode plot. Tokenised as the
      // bare name `ph` followed by `(`, since the reference pattern rejects
      // nested parentheses. Only a *single* signal has a phase, so the argument
      // is one reference rather than a general expression: phase arithmetic
      // would need the whole evaluator to carry complex values, and `ph(a)+ph(b)`
      // is not the phase of anything in particular.
      if (PHASE_FNS.has(t.v.toLowerCase()) && peekAt(1)?.t === "op" && peekAt(1)?.v === "(") {
        eat(); eat("(");
        const arg = peek();
        if (!arg || arg.t !== "ref") throw new Error(`${t.v}() takes one signal, e.g. ${t.v}(V(out))`);
        eat(); eat(")");
        const ph = resolvePhasor(result, arg.v);
        if (!ph) {
          throw new Error(
            resolveSeries(result, arg.v)
              ? `"${arg.v}" has no phase — only an .ac run carries one`
              : `Unknown variable "${arg.v}"`,
          );
        }
        return (i) => (Math.atan2(ph.im[i], ph.re[i]) * 180) / Math.PI;
      }
      eat();
      const series = resolveSeries(result, t.v);
      if (!series) throw new Error(`Unknown variable "${t.v}"`);
      return (i) => series[i];
    }
    throw new Error(`Unexpected "${t.v}"`);
  };

  const fn = parseExpr();
  if (pos !== toks.length) throw new Error(`Unexpected "${peek()?.v}"`);
  return fn;
}

export interface ExprResult {
  values?: Float64Array;
  error?: string;
}

/** True if `name` is not a raw result variable, i.e. should be treated as a formula. */
export function isExpression(result: SimulationResult, name: string): boolean {
  return !result.data[name] && matchResultVariable(result, [name]) === null;
}

/**
 * Evaluate `expr` sample-by-sample over the result's time base. `params` maps
 * `{name}` tokens (component values, `.param`s) to scalar values.
 */
export function evalExpression(result: SimulationResult, expr: string, params: Record<string, number> = {}): ExprResult {
  const length = result.time?.length ?? 0;
  if (length === 0) return { error: "No data" };
  try {
    // Drop any trailing ` [unit]` annotation — it only steers axis grouping.
    const { body } = splitUnitAnnotation(expr);
    const fn = compile(body, result, params);
    const values = new Float64Array(length);
    for (let i = 0; i < length; i++) values[i] = fn(i);
    return { values };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * One step's data under the plain variable names. A `.step` sweep tags every
 * vector (`v(out) @1`, `v(out) @2`, …), while a user writes an expression the way
 * the probe list shows it — `V(out)`.
 */
export function stepView(result: SimulationResult, tag: string): SimulationResult {
  const suffix = ` @${tag}`;
  const data: Record<string, Float64Array> = {};
  for (const k of Object.keys(result.data)) {
    if (k.endsWith(suffix)) data[k.slice(0, -suffix.length)] = result.data[k];
  }
  return { variables: Object.keys(data), data, time: result.time };
}

/**
 * The result an expression must be *validated* against. For a stepped run that
 * is a single step's view: checking against the raw, tagged names rejected every
 * function on a `.step` sweep ("Unknown variable V(out)") even though the plot
 * evaluates them per step without trouble.
 */
export function exprCheckResult(result: SimulationResult, stepTags: string[] | null | undefined): SimulationResult {
  return stepTags?.length ? stepView(result, stepTags[0]) : result;
}

/**
 * The x-axis series for one y-trace on a parametric panel — the quantity named
 * by `xTrace`, taken from the same run as `yTrace`.
 *
 * Two things this must get right, and neither is obvious from the panel state:
 *
 * The quantity is resolved from the result, not from the traces the user has
 * probed. Requiring V(C) to be ticked in the probe list before it can go on the
 * x-axis is a trap — nothing says so, and the field then silently keeps showing
 * the sweep base.
 *
 * A stepped family carries one run per step, so `V(C)` is not one series but
 * one per curve. The y-trace's own step tag (`… @I1=5m`) selects the matching
 * run; sharing a single x-series would draw every curve against the first
 * step's x, which for an output-characteristic family collapses them onto one.
 */
export function parametricXSeries(
  result: SimulationResult,
  xTrace: string | undefined,
  yTrace: string | undefined,
  stepTags: string[] | null,
  params: Record<string, number> = {},
): Float64Array | null {
  const name = xTrace?.trim();
  if (!name) return null;
  const at = yTrace ? yTrace.lastIndexOf(" @") : -1;
  const tag = at >= 0 && stepTags?.includes(yTrace!.slice(at + 2)) ? yTrace!.slice(at + 2) : null;
  const view = tag ? stepView(result, tag) : result;
  if (isExpression(view, name)) return evalExpression(view, name, params).values ?? null;
  return resolveSeries(view, name);
}

import { matchResultVariable } from "@core/circuit/probeUtils.js";
import type { SimulationResult } from "@store/simulationStore.js";

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

/** Resolve a single reference token (e.g. `V(out)`) to a data series. */
export function resolveSeries(result: SimulationResult, ref: string): Float64Array | null {
  if (result.data[ref]) return result.data[ref];
  const match = matchResultVariable(result, [ref]);
  return match ? result.data[match] ?? null : null;
}

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
    const fn = compile(expr, result, params);
    const values = new Float64Array(length);
    for (let i = 0; i < length; i++) values[i] = fn(i);
    return { values };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

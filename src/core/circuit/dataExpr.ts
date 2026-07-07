import type { Circuit } from "./Circuit.js";
import type { SpiceComponent } from "../components/base/SpiceComponent.js";
import type { SimulationResult } from "@store/simulationStore.js";
import { matchResultVariable, netLabel } from "./probeUtils.js";

/**
 * Evaluation of LTSpice-style data expressions (the strings stored in a
 * `DATAFLAG`, e.g. `V(u1)`, `-I(V1)`, `V(U1,U2)`, `round(V(a)*I(R1)*1000)/1000`)
 * against a simulation result.
 *
 * Expressions evaluate per-sample to a series so differences/products are
 * correct sample-by-sample, then reduce to a single number depending on the
 * analysis: the operating point value for `.op`, the RMS (Effektivwert) for a
 * transient run, or the final swept value otherwise.
 */

/**
 * A positioned data-point annotation, mirroring LTSpice's `DATAFLAG x y "expr"`.
 * `x`/`y` are flow (≈ LTSpice) coordinates; `expr` is evaluated for display.
 */
export interface DataFlag {
  id: string;
  x: number;
  y: number;
  expr: string;
}

/** A scalar (broadcast) or a per-sample series. */
type Val = number | Float64Array;

class EvalError extends Error {}

export type AnalysisKind = "op" | "rms" | "value";

function sampleLen(result: SimulationResult): number {
  for (const k in result.data) return result.data[k].length;
  return 0;
}

/** How a per-sample series collapses to one displayed number. */
export function analysisKind(result: SimulationResult): AnalysisKind {
  const len = sampleLen(result);
  if (len <= 1) return "op";
  if (result.time && result.time.length > 1) return "rms";
  return "value";
}

function rms(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}

function reduce(val: Val, kind: AnalysisKind): number {
  if (typeof val === "number") return kind === "rms" ? Math.abs(val) : val;
  if (val.length === 0) return NaN;
  if (kind === "op") return val[0];
  if (kind === "value") return val[val.length - 1];
  return rms(val);
}

// ── elementwise helpers ──────────────────────────────────────────────────────
function lift(a: Val, b: Val, f: (x: number, y: number) => number): Val {
  if (typeof a === "number" && typeof b === "number") return f(a, b);
  const n = typeof a === "number" ? (b as Float64Array).length : a.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = typeof a === "number" ? a : a[i];
    const y = typeof b === "number" ? b : b[i];
    out[i] = f(x, y);
  }
  return out;
}
function map1(a: Val, f: (x: number) => number): Val {
  if (typeof a === "number") return f(a);
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = f(a[i]);
  return out;
}

const FUNCS: Record<string, (args: Val[]) => Val> = {
  round: (a) => map1(a[0], Math.round),
  abs: (a) => map1(a[0], Math.abs),
  sqrt: (a) => map1(a[0], Math.sqrt),
  sin: (a) => map1(a[0], Math.sin),
  cos: (a) => map1(a[0], Math.cos),
  exp: (a) => map1(a[0], Math.exp),
  ln: (a) => map1(a[0], Math.log),
  log: (a) => map1(a[0], Math.log10),
  min: (a) => lift(a[0], a[1], Math.min),
  max: (a) => lift(a[0], a[1], Math.max),
  pow: (a) => lift(a[0], a[1], Math.pow),
};

// ── result lookups ───────────────────────────────────────────────────────────
function nodeVoltage(result: SimulationResult, name: string): Val {
  if (name === "0" || name.toLowerCase() === "gnd") return 0;
  const v = matchResultVariable(result, [`V(${name})`, `v(${name})`]);
  if (!v) throw new EvalError(`unknown node ${name}`);
  return result.data[v];
}
function deviceCurrent(result: SimulationResult, name: string): Val {
  const lower = name.toLowerCase();
  const v = matchResultVariable(result, [
    `I(${name})`, `i(${name})`,
    // ngspice's `.options savecurrents` names device currents `i(@r1[i])`, so
    // match that form exactly rather than relying on the fuzzy fallback (which
    // could latch onto an unrelated vector that merely contains the name).
    `i(@${name}[i])`, `i(@${lower}[i])`,
    `@${name}[i]`, `@${lower}[i]`, `${name}#branch`,
  ]);
  if (!v) throw new EvalError(`unknown device ${name}`);
  return result.data[v];
}

const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_.]*|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+|[()+\-*/,]/g;

/** Parse and evaluate an expression to a Val, or throw EvalError. */
function evalExpr(expr: string, result: SimulationResult): Val {
  const tokens = expr.match(TOKEN_RE) ?? [];
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (t?: string) => {
    const tok = tokens[pos++];
    if (t && tok !== t) throw new EvalError(`expected '${t}' got '${tok ?? "<end>"}'`);
    return tok;
  };

  const parseSum = (): Val => {
    let v = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const op = eat();
      const r = parseTerm();
      v = lift(v, r, op === "+" ? (a, b) => a + b : (a, b) => a - b);
    }
    return v;
  };
  const parseTerm = (): Val => {
    let v = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const op = eat();
      const r = parseFactor();
      v = lift(v, r, op === "*" ? (a, b) => a * b : (a, b) => a / b);
    }
    return v;
  };
  const parseFactor = (): Val => {
    if (peek() === "-") { eat(); return map1(parseFactor(), (x) => -x); }
    if (peek() === "+") { eat(); return parseFactor(); }
    return parsePrimary();
  };
  const parsePrimary = (): Val => {
    const tok = peek();
    if (tok === undefined) throw new EvalError("unexpected end");
    if (tok === "(") { eat("("); const v = parseSum(); eat(")"); return v; }
    if (/^[A-Za-z_]/.test(tok)) {
      const name = eat();
      if (peek() === "(") {
        eat("(");
        const fn = name.toLowerCase();
        if (fn === "v") {
          const a = eat();
          let v = nodeVoltage(result, a);
          if (peek() === ",") { eat(","); const b = eat(); v = lift(v, nodeVoltage(result, b), (x, y) => x - y); }
          eat(")");
          return v;
        }
        if (fn === "i") { const d = eat(); eat(")"); return deviceCurrent(result, d); }
        const args: Val[] = [parseSum()];
        while (peek() === ",") { eat(","); args.push(parseSum()); }
        eat(")");
        const f = FUNCS[fn];
        if (!f) throw new EvalError(`unknown function ${name}`);
        return f(args);
      }
      throw new EvalError(`unexpected symbol ${name}`);
    }
    if (/^[.\d]/.test(tok)) { eat(); return parseFloat(tok); }
    throw new EvalError(`unexpected token ${tok}`);
  };

  const v = parseSum();
  if (pos < tokens.length) throw new EvalError(`trailing '${peek()}'`);
  return v;
}

/** Evaluate `expr` to a single number, or `null` if it can't be resolved. */
export function evalDataFlag(expr: string, result: SimulationResult): number | null {
  try {
    return reduce(evalExpr(expr, result), analysisKind(result));
  } catch {
    return null;
  }
}

// ── formatting ───────────────────────────────────────────────────────────────
const PREFIXES = [
  { e: 9, s: "G" }, { e: 6, s: "M" }, { e: 3, s: "k" }, { e: 0, s: "" },
  { e: -3, s: "m" }, { e: -6, s: "µ" }, { e: -9, s: "n" }, { e: -12, s: "p" },
];

/** Engineering-notation number with an SI prefix and unit, e.g. `1.50 mA`. */
export function formatEng(value: number, unit: string): string {
  if (!isFinite(value)) return "–";
  const a = Math.abs(value);
  if (a < 1e-15) return `0 ${unit}`.trim();
  const exp = Math.max(-12, Math.min(9, Math.floor(Math.log10(a) / 3) * 3));
  const p = PREFIXES.find((x) => x.e === exp) ?? PREFIXES[3];
  const scaled = value / 10 ** exp;
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${p.s}${unit}`.trim();
}

/** Best-effort physical unit for a data expression (V, A, W, or none). */
export function guessUnit(expr: string): string {
  const hasMul = /[*/]/.test(expr);
  const vCount = (expr.match(/[vV]\s*\(/g) ?? []).length;
  const iCount = (expr.match(/[iI]\s*\(/g) ?? []).length;
  if (!hasMul && vCount > 0 && iCount === 0) return "V";
  if (!hasMul && iCount > 0 && vCount === 0) return "A";
  if (hasMul && vCount >= 1 && iCount >= 1) return "W";
  return "";
}

/** Formatted value for a data-flag badge, or `null` if unresolved. */
export function formatDataFlag(expr: string, result: SimulationResult): string | null {
  const v = evalDataFlag(expr, result);
  if (v === null) return null;
  return formatEng(v, guessUnit(expr));
}

// ── expression builders (used by the schematic context menus) ────────────────
/** Raw net name for use inside a probe: `0` for ground, else the net label. */
export function rawNetName(circuit: Circuit, netId: string | null): string | null {
  if (!netId) return null;
  if (netId === "0") return "0";
  return netLabel(circuit, netId) ?? netId;
}

/** `V(net)` expression for a net's potential (ground reads as `V(0)` = 0). */
export function netVoltageExpr(circuit: Circuit, netId: string | null): string | null {
  const name = rawNetName(circuit, netId);
  return name ? `V(${name})` : null;
}

/**
 * `I(dev)` for the current through a net, but only when it is a clean series
 * node — exactly two device terminals — so the current is unambiguous.
 */
export function netCurrentExpr(circuit: Circuit, netId: string | null): string | null {
  if (!netId || netId === "0") return null;
  const labels: string[] = [];
  for (const comp of circuit.components.values()) {
    if (comp.id.startsWith("ground")) continue;
    for (const port of comp.ports) if (port.netId === netId) labels.push(comp.label);
  }
  return labels.length === 2 ? `I(${labels[0]})` : null;
}

/** `V(a,b)` (or `V(a)` / `-V(b)`) for the voltage across a component. */
export function compVoltageExpr(circuit: Circuit, comp: SpiceComponent): string | null {
  const raw = (netId: string | null) => { const n = rawNetName(circuit, netId); return n === "0" ? null : n; };
  const a = raw(comp.ports[0]?.netId ?? null);
  const b = raw(comp.ports[1]?.netId ?? null);
  if (a && b) return `V(${a},${b})`;
  if (a) return `V(${a})`;
  if (b) return `-V(${b})`;
  return null;
}

/** `I(dev)` for the current through a component. */
export function compCurrentExpr(comp: SpiceComponent): string {
  return `I(${comp.label})`;
}

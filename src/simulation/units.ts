/**
 * Infer the physical unit of a trace so panels can group traces onto separate
 * y-axes (LTSpice shows one axis per distinct unit: left, then further right).
 *
 * Units are tracked as a dimension in volts/amperes; expressions combine them
 * (`V/I` → Ω, `V*I` → W). A `+`/`-` between mismatched units is treated as
 * dimensionless/unknown, matching how such traces get their own axis.
 */

/**
 * Volts and amperes, plus `d` for degrees.
 *
 * An angle is not a combination of the other two — `ph(V(out))` is degrees no
 * matter what is inside it — so it needs its own slot rather than a special
 * case. Carrying it through the arithmetic is what lets a phase *difference*
 * (`ph(V(U1))-ph(V(U2))`, the usual way to ask how far two signals are apart)
 * come out as degrees too.
 */
interface Dim { v: number; a: number; d: number }

type Tok =
  | { t: "num" }
  | { t: "ref"; v: string }
  | { t: "op"; v: string };

function tokenize(src: string): Tok[] | null {
  const re =
    /\s+|([0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)|([A-Za-z_@][\w.]*\s*\([^()]*\))|([A-Za-z_@][\w.]*(?:\[\w+\])?)|([+\-*/()])/g;
  const toks: Tok[] = [];
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(src)) !== null) {
    if (m.index !== last) return null;
    last = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: "num" });
    else if (m[2] !== undefined) toks.push({ t: "ref", v: m[2].replace(/\s+/g, "") });
    else if (m[3] !== undefined) toks.push({ t: "ref", v: m[3] });
    else if (m[4] !== undefined) toks.push({ t: "op", v: m[4] });
  }
  return last === src.length ? toks : null;
}

/** Dimension of a single reference: currents vs. power vs. (default) voltage. */
function refDim(ref: string): Dim {
  const s = ref.toLowerCase();
  // `i(...)` and the terminal currents `ic(q1)` / `id(m1)`, plus the raw
  // `@dev[i]` / `@q1[ic]` vectors — all amperes.
  if (/\[i\w*\]$/.test(s) || /^i[a-z]?\s*\(/.test(s)) return { v: 0, a: 1, d: 0 };
  if (/\[p\]$/.test(s)) return { v: 1, a: 1, d: 0 };
  return { v: 1, a: 0, d: 0 }; // node voltages: V(...) or bare node names
}

const eq = (x: Dim | null, y: Dim | null) =>
  !!x && !!y && x.v === y.v && x.a === y.a && x.d === y.d;

function compile(toks: Tok[]): Dim | null {
  let pos = 0;
  const peek = () => toks[pos];
  /** Operator char at the current position, or null. */
  const opAt = (): string | null => {
    const p = toks[pos];
    return p && p.t === "op" ? p.v : null;
  };

  const factor = (): Dim | null => {
    const t = peek();
    if (!t) return null;
    if (t.t === "op" && (t.v === "-" || t.v === "+")) { pos++; return factor(); }
    if (t.t === "op" && t.v === "(") {
      pos++;
      const inner = expr();
      if (opAt() === ")") pos++;
      return inner;
    }
    if (t.t === "num") { pos++; return { v: 0, a: 0, d: 0 }; }
    if (t.t === "ref") {
      pos++;
      // `ph(...)` tokenises as the bare name `ph` followed by a parenthesised
      // group, because the reference pattern refuses nested parens. Skip over
      // the argument — whatever signal it names, the result is an angle.
      const next = toks[pos];
      if (PHASE_FNS.has(t.v.toLowerCase()) && next && next.t === "op" && next.v === "(") {
        pos++;
        for (let depth = 1; pos < toks.length && depth > 0; pos++) {
          const x = toks[pos];
          if (x.t !== "op") continue;
          if (x.v === "(") depth++;
          else if (x.v === ")") depth--;
        }
        return { v: 0, a: 0, d: 1 };
      }
      return refDim(t.v);
    }
    pos++;
    return null;
  };

  const term = (): Dim | null => {
    let left = factor();
    for (let op = opAt(); op === "*" || op === "/"; op = opAt()) {
      pos++;
      const right = factor();
      if (!left || !right) { left = null; continue; }
      left = op === "*"
        ? { v: left.v + right.v, a: left.a + right.a, d: left.d + right.d }
        : { v: left.v - right.v, a: left.a - right.a, d: left.d - right.d };
    }
    return left;
  };

  const expr = (): Dim | null => {
    let left = term();
    for (let op = opAt(); op === "+" || op === "-"; op = opAt()) {
      pos++;
      const right = term();
      left = eq(left, right) ? left : null; // mismatched sum → unknown
    }
    return left;
  };

  return expr();
}

function label(dim: Dim | null): string {
  if (!dim) return "";
  const { v, a, d } = dim;
  // A plain angle. Anything else involving degrees (°², V/°) has no meaningful
  // axis, so it falls through to "" and gets the dimensionless one.
  if (d === 1 && v === 0 && a === 0) return "°";
  if (d !== 0) return "";
  if (v === 0 && a === 0) return "";
  if (v === 1 && a === 0) return "V";
  if (v === 0 && a === 1) return "A";
  if (v === 1 && a === 1) return "W";
  if (v === 1 && a === -1) return "Ω";
  if (v === -1 && a === 1) return "℧";
  const parts: string[] = [];
  if (v) parts.push(`V${v === 1 ? "" : `^${v}`}`);
  if (a) parts.push(`A${a === 1 ? "" : `^${a}`}`);
  return parts.join("·");
}

/**
 * An expression may carry an explicit unit as a trailing ` [unit]`, e.g.
 * `{R1}*I(D2) [V]`. This lets the user force which y-axis it shares when the
 * unit can't be inferred (a `{param}` has no known dimension on its own). The
 * required space before `[` distinguishes it from a device-current suffix like
 * `@r1[i]`. Returns the expression body and the annotated unit (or null).
 */
export function splitUnitAnnotation(name: string): { body: string; unit: string | null } {
  const m = name.match(/^(.*\S)\s+\[([^\]]+)\]\s*$/);
  return m ? { body: m[1], unit: m[2].trim() } : { body: name, unit: null };
}

/** Names that mean "the phase of", in degrees (LTSpice writes `ph()`). */
export const PHASE_FNS = new Set(["ph", "phase"]);

/** Human-readable unit label for a trace (`""` = dimensionless/unknown). */
export function inferUnit(name: string): string {
  // An explicit ` [unit]` annotation wins over dimensional inference.
  const { body, unit } = splitUnitAnnotation(name);
  if (unit !== null) return unit;
  const toks = tokenize(body);
  return toks ? label(compile(toks)) : "";
}

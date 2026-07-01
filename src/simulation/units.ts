/**
 * Infer the physical unit of a trace so panels can group traces onto separate
 * y-axes (LTSpice shows one axis per distinct unit: left, then further right).
 *
 * Units are tracked as a dimension in volts/amperes; expressions combine them
 * (`V/I` → Ω, `V*I` → W). A `+`/`-` between mismatched units is treated as
 * dimensionless/unknown, matching how such traces get their own axis.
 */

interface Dim { v: number; a: number }

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
  if (/\[i\]$/.test(s) || /^i\s*\(/.test(s)) return { v: 0, a: 1 };
  if (/\[p\]$/.test(s)) return { v: 1, a: 1 };
  return { v: 1, a: 0 }; // node voltages: V(...) or bare node names
}

const eq = (x: Dim | null, y: Dim | null) => !!x && !!y && x.v === y.v && x.a === y.a;

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
    if (t.t === "num") { pos++; return { v: 0, a: 0 }; }
    if (t.t === "ref") { pos++; return refDim(t.v); }
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
        ? { v: left.v + right.v, a: left.a + right.a }
        : { v: left.v - right.v, a: left.a - right.a };
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

function label(d: Dim | null): string {
  if (!d) return "";
  const { v, a } = d;
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

/** Human-readable unit label for a trace (`""` = dimensionless/unknown). */
export function inferUnit(name: string): string {
  const toks = tokenize(name);
  return toks ? label(compile(toks)) : "";
}

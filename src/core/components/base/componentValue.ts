/**
 * Parsing of a component's value field, shared by the properties panel and the
 * component models so both agree on what the user typed.
 *
 * A value is either a number with an optional SI prefix (`4.7k`, `10n`, `1MEG`)
 * or a parametric expression in LTSpice braces (`{RM}`, `{R1*2}`), which is
 * stored verbatim and resolved by ngspice from a `.param`.
 */

const SI_MULT: Record<string, number> = {
  p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, "": 1,
};

/** A value is parametric when it carries a complete `{…}` group. */
export function isParametricValue(value: unknown): value is string {
  return typeof value === "string" && /\{[^{}]+\}/.test(value);
}

/**
 * Parse a number with an optional SI prefix. Returns `null` when the text is not
 * numeric — notably for a parametric `{…}` value, which has no number at all.
 */
export function parseSI(s: string): number | null {
  const t = s.trim();
  if (t === "") return null;
  // Deliberately unanchored: a trailing unit ("10 ohm") is tolerated, as before.
  const m = t.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zµ]*)/i);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (!isFinite(base)) return null;
  const suffix = m[2];
  // "MEG"/"meg" (LTSpice) and a lone "M" both mean 1e6 here; a lone "m" is milli.
  if (/^meg/i.test(suffix)) return base * 1e6;
  return base * (SI_MULT[suffix[0] ?? ""] ?? 1);
}

/**
 * Coerce a property value to a number, understanding SI prefixes. `Number("4.7k")`
 * is `NaN`, which used to silently wipe a component's value when the user typed a
 * prefixed number into the plain-text field a parametric value leaves behind.
 * Non-numeric input keeps `fallback`.
 */
export function toComponentNumber(value: string | number, fallback: number): number {
  if (typeof value === "number") return isFinite(value) ? value : fallback;
  const n = parseSI(value);
  return n ?? fallback;
}

/** Format a number with a compact SI prefix (no unit), e.g. 1000 → "1k". */
export function fmtSIShort(v: number): string {
  if (!isFinite(v)) return "0";
  if (v === 0) return "0";
  const a = Math.abs(v);
  const steps: [number, string][] = [
    [1e9, "G"], [1e6, "MEG"], [1e3, "k"], [1, ""],
    [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"],
  ];
  for (const [f, suffix] of steps) {
    if (a >= f) return `${+(v / f).toPrecision(4)}${suffix}`;
  }
  return `${+(v * 1e12).toPrecision(4)}p`;
}

/** How a stored value (a number or a `{expr}`) is shown in the value field. */
export function valueFieldText(value: string | number): string {
  return typeof value === "number" ? fmtSIShort(value) : value;
}

/** What the user typed into a value field, once it is committed. */
export type ValueInput =
  | { kind: "number"; value: number }
  | { kind: "expr"; value: string };

/**
 * Interpret a value field's text. `null` means "not committable" — an empty or
 * half-typed entry, which must leave the stored value untouched rather than
 * collapse it to 0/NaN.
 */
export function parseValueInput(text: string): ValueInput | null {
  const t = text.trim();
  if (t === "") return null;
  if (isParametricValue(t)) return { kind: "expr", value: t };
  const n = parseSI(t);
  return n === null ? null : { kind: "number", value: n };
}

import { normalizeMicro } from "./Sources.js";

/**
 * Read a measurement file into a PWL breakpoint list.
 *
 * ngspice's own `PWL file=…` cannot be used here: the simulator runs as
 * WebAssembly with no access to the user's filesystem, and the engine does not
 * expose its in-memory one. So the file is read in the browser and expanded
 * into the source's points instead — the circuit then carries the data and
 * needs nothing at simulation time.
 *
 * Accepts what measurement tools actually emit: one `time value` pair per line
 * or a flat run of numbers, separated by whitespace, tabs, commas or
 * semicolons, with `*`, `;`, `#` and `//` comment lines. SI suffixes are kept
 * verbatim (`10m` stays `10m`) so the file's own precision survives.
 */
export interface PwlFileResult {
  /** Breakpoints as `time value` pairs, ready for `pwlPoints`. */
  points: string;
  /** Number of breakpoints read. */
  count: number;
}

/** A token that parses as a number, with or without an SI suffix. */
const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?\s*(?:meg|mil|[fpnumkgt])?[a-z]*$/i;

const SI: Record<string, number> = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3,
  k: 1e3, meg: 1e6, g: 1e9, t: 1e12, mil: 25.4e-6,
};

/** Numeric value of a token, for validation only — the token itself is kept. */
function valueOf(token: string): number {
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-z]*)$/i.exec(token);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const suffix = m[2].toLowerCase();
  if (!suffix) return n;
  // Longest suffix first: "meg" must not be read as "m".
  for (const key of ["meg", "mil", "f", "p", "n", "u", "m", "k", "g", "t"]) {
    if (suffix.startsWith(key)) return n * SI[key];
  }
  return n; // A trailing unit ("5V", "10mA") — already covered by the suffix scan.
}

/**
 * Whether commas in this text are decimal points rather than separators.
 *
 * German measurement exports write `0,001` and separate with tabs or
 * semicolons. Guessing wrong turns one column into two, so the decimal reading
 * is only taken when another separator is present *and* every comma sits
 * between two digits.
 */
function hasDecimalCommas(text: string): boolean {
  if (!/[;\t]/.test(text)) return false;
  const commas = text.match(/,/g)?.length ?? 0;
  if (commas === 0) return false;
  return (text.match(/\d,\d/g)?.length ?? 0) === commas;
}

export function parsePwlFile(input: string): PwlFileResult {
  // Normalise up front: both micro signs are outside [a-z], so a token like
  // "10µ" would otherwise be rejected as non-numeric before it is ever fixed.
  const text = normalizeMicro(input);
  const decimalCommas = hasDecimalCommas(text);

  const tokens: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip comments. A leading ";" is a comment, but ";" also separates
    // columns — only treat it as a comment when it opens the line.
    let line = rawLine.trim();
    if (!line || /^([*#]|\/\/|;)/.test(line)) continue;
    line = line.replace(/\s+([*#]|\/\/).*$/, "");

    if (decimalCommas) line = line.replace(/(\d),(\d)/g, "$1.$2");
    for (const t of line.split(/[\s,;\t]+/)) if (t) tokens.push(t);
  }

  if (tokens.length === 0) throw new Error("Datei enthält keine Zahlenwerte");

  const bad = tokens.find((t) => !NUMBER.test(t) || Number.isNaN(valueOf(t)));
  if (bad) throw new Error(`"${bad}" ist keine Zahl`);

  if (tokens.length % 2 !== 0) {
    throw new Error(`ungerade Anzahl Werte (${tokens.length}) — es fehlt ein Zeit- oder Messwert`);
  }

  // ngspice needs strictly increasing time; an unsorted file would otherwise
  // simulate silently and wrongly.
  let previous = -Infinity;
  for (let i = 0; i < tokens.length; i += 2) {
    const t = valueOf(tokens[i]);
    if (t < previous) {
      throw new Error(`Zeitwerte nicht aufsteigend (${tokens[i]} nach ${previous})`);
    }
    previous = t;
  }

  return { points: tokens.join(" "), count: tokens.length / 2 };
}

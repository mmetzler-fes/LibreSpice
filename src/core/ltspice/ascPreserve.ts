/**
 * `.asc` passthrough — keeping a saved file close to the one we opened.
 *
 * The exporter used to *re-generate* every line of a schematic from our own data
 * model. Anything the model does not represent was therefore lost on the first
 * save, and anything it spells differently was silently rewritten. Opening
 * `06-2-2_RC_HP1.asc`, rotating one capacitor and saving rewrote 13 of 31 lines:
 * `100nF` became `1.0000000000000001e-7`, `15.915k` became `15915`, a source's
 * `WINDOW 123`/`WINDOW 39` vanished, every symbol was given caption windows it
 * never had, and the `.ac` directive jumped from (88, 272) to (10, 100). In
 * LTSpice the result was unreadable — captions stacked on one line and rotated
 * to vertical, because a `WINDOW … Right` justification rotates with its symbol.
 *
 * The fix is to treat the source file as authoritative for everything the user
 * did not change: the parser keeps the original lines (`AscRaw`), and the
 * exporter hands them straight back unless the corresponding value actually
 * differs now.
 *
 * Whether something "actually differs" is decided by *comparing values*, not by
 * tracking edits. A dirty flag would have to be threaded through every store
 * mutation that can touch a component and would silently rot the moment one path
 * forgot to set it; `sameAttrValue` instead asks the only question that matters —
 * would re-reading the raw line give us what we hold now? — and cannot drift out
 * of sync with the model.
 */

/**
 * A `.asc` reduced to the lines that matter for comparison, so two files can be
 * checked for "the same schematic" rather than "the same bytes".
 *
 * Normalises the two differences that carry no meaning: line *order* (the
 * exporter groups by kind, LTSpice interleaves) is handled by the caller
 * comparing as a multiset, and a `WIRE`'s endpoint *order* — `WIRE 160 64 112 64`
 * and `WIRE 112 64 160 64` are one and the same segment — is handled here.
 */
export function canonicalAscLines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const w = l.match(/^WIRE\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/i);
    if (!w) return l;
    const [x1, y1, x2, y2] = w.slice(1, 5).map(Number);
    return (x1 < x2 || (x1 === x2 && y1 <= y2))
      ? `WIRE ${x1} ${y1} ${x2} ${y2}`
      : `WIRE ${x2} ${y2} ${x1} ${y1}`;
  });
}

/** Raw `.asc` text a component was imported with, carried on its node data. */
export interface AscRaw {
  /** Verbatim `WINDOW <id> …` lines, keyed by window id. */
  windows?: Record<number, string>;
  /** Verbatim `SYMATTR` values, keyed by attribute name, exactly as written. */
  attrs?: Record<string, string>;
}

/** A directive `TEXT` line kept verbatim, keyed by the directive text it carries. */
export interface DirectiveRaw {
  /** The directive body, as it appears in the store's `spiceDirectives`. A single
   *  `TEXT` line may carry several directives separated by literal `\n`. */
  text: string;
  /** The whole original `TEXT x y Just Size !…` line. */
  raw: string;
}

/** Everything the exporter hands back unchanged from the file it was loaded from. */
export interface AscPreserved {
  directiveRaw?: DirectiveRaw[];
  /** The `Version` / `SHEET` lines, keyed by keyword. */
  header?: Record<string, string>;
  /** `WIRE` lines the pin-to-pin edge model cannot represent (stubs, spurs).
   *  Written back untouched — see LTSpiceParser for why that is safe. */
  orphanWires?: string[];
}

/**
 * Move an existing `WINDOW` line by a caption drag, keeping everything else
 * about it — most importantly its justification.
 *
 * A `WINDOW` is stored in the symbol's *own* frame and LTSpice rotates it (and
 * its justification) together with the part, which is why the exporter must not
 * invent one: writing `Right` on an `R270` symbol renders the caption vertically.
 * So a drag is applied as a *delta to the line the file already had*, with the
 * screen-space delta rotated back into symbol space (the inverse of
 * ltspiceGeometry's rotateOffsets, with the `M` mirror undone afterwards).
 *
 * Returns `null` when the line can't be parsed, so the caller falls back to
 * passing the original through untouched rather than writing something worse.
 */
export function shiftWindowLine(
  raw: string, dx: number, dy: number, deg: number, mirrored: boolean,
): string | null {
  const m = raw.trim().match(/^(WINDOW\s+\d+\s+)(-?\d+)\s+(-?\d+)(\s.*)?$/i);
  if (!m) return null;
  let px = dx, py = dy;
  if (deg === 90) { px = dy; py = -dx; }
  else if (deg === 180) { px = -dx; py = -dy; }
  else if (deg === 270) { px = -dy; py = dx; }
  if (mirrored) px = -px;
  return `${m[1]}${Math.round(parseInt(m[2], 10) + px)} ${Math.round(parseInt(m[3], 10) + py)}${m[4] ?? ""}`;
}

/** Decimal exponent of an SI/SPICE suffix — mirrors the parser's `siExp`. */
function siExp(suffix: string): number {
  const s = suffix.trim().toLowerCase();
  if (s.startsWith("meg")) return 6;
  if (s.startsWith("g")) return 9;
  if (s.startsWith("t")) return 12;
  if (s.startsWith("k")) return 3;
  if (s.startsWith("m")) return -3;
  if (s.startsWith("u") || s.startsWith("µ")) return -6;
  if (s.startsWith("n")) return -9;
  if (s.startsWith("p")) return -12;
  if (s.startsWith("f")) return -15;
  return 0;
}

/** Fold the suffix into the literal — see the parser's `applySI` for why this
 *  must not be a multiplication. */
function applySI(mantissa: string, suffix: string): number {
  const exp = siExp(suffix);
  if (exp === 0) return Number(mantissa);
  return /[eE]/.test(mantissa)
    ? Number(mantissa) * Math.pow(10, exp)
    : Number(`${mantissa}e${exp}`);
}

/**
 * Numeric value of a single token, or `null` if it isn't a number. Accepts the
 * SPICE forms a `.asc` mixes freely: `100nF`, `15.915k`, `1e-7`, `1MEGHz`, `4R7`.
 */
export function numericToken(tok: string): number | null {
  const t = tok.trim();
  if (!t) return null;
  // European infix notation (4R7 = 4.7), same rule as the parser's parseSI.
  const infix = t.match(/^(\d+)(meg|[rpnuµmkgtf])(\d+)$/i);
  if (infix) return applySI(`${infix[1]}.${infix[3]}`, infix[2]);
  const m = t.match(/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/);
  if (!m) return null;
  const n = applySI(m[0], t.slice(m[0].length));
  return isNaN(n) ? null : n;
}

/**
 * Tokens of an attribute value, normalised for comparison: an empty LTSpice
 * value (`""`) and a bare `DC 0` both reduce to nothing, so a source whose value
 * we render as `DC 0` still matches a file that left it blank.
 */
function tokens(val: string): string[] {
  const t = val.trim();
  if (t === '""' || t === "''") return [];
  // A zero-valued parasitic (`Rser=0`, `Cpar=0`) is the same as not stating it —
  // which is what we generate — so it must not count as a difference.
  const out = t.split(/\s+/).filter(Boolean).filter((tok) => {
    const kv = tok.match(/^([A-Za-z_]\w*)=(.+)$/);
    return !(kv && numericToken(kv[2]) === 0);
  });
  // `DC` is optional in SPICE: LTSpice writes a plain DC source as `10V`, while
  // we render it as `DC 10`. Dropping the keyword lets the two compare equal, so
  // a source nobody touched keeps the file's spelling.
  if (out.length && out[0].toUpperCase() === "DC") out.shift();
  // An explicit zero is what an empty value (`""`) means.
  if (out.length === 1 && numericToken(out[0]) === 0) return [];
  return out;
}

/**
 * Would writing `raw` instead of `generated` change the circuit? Compared token
 * by token, numerically where both sides are numbers, so the file's own spelling
 * survives (`100nF` vs `1e-7`, `AC 1V` vs `AC 1`, `1MEGHz` vs `1MEG`) while a
 * real edit (`100nF` → `220n`) does not.
 */
export function sameAttrValue(raw: string, generated: string): boolean {
  if (raw.trim() === generated.trim()) return true;
  const a = tokens(raw), b = tokens(generated);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].toUpperCase() === b[i].toUpperCase()) continue;
    const na = numericToken(a[i]), nb = numericToken(b[i]);
    if (na === null || nb === null) return false;
    // Relative tolerance: `100nF` parses to 1.0000000000000001e-7 through the
    // usual float path, which must still count as unchanged.
    const scale = Math.max(Math.abs(na), Math.abs(nb));
    if (Math.abs(na - nb) > (scale === 0 ? 1e-18 : scale * 1e-9)) return false;
  }
  return true;
}

const SI_STEPS: [number, string][] = [
  [1e12, "T"], [1e9, "G"], [1e6, "Meg"], [1e3, "k"],
  [1, ""], [1e-3, "m"], [1e-6, "u"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"],
];

/**
 * A number as SPICE engineering notation — `1e-7` → `100n`, `15915` → `15.915k`.
 * Used for a value the user has actually edited, so a freshly typed component
 * reads like one LTSpice wrote instead of like a float dump.
 */
export function formatEng(n: number): string {
  if (!isFinite(n)) return String(n);
  if (n === 0) return "0";
  const abs = Math.abs(n);
  for (const [f, suffix] of SI_STEPS) {
    if (abs >= f) {
      // 6 significant digits is enough for every value a schematic carries and
      // keeps 1e-7/1e-9 from coming back out as 99.9999n.
      const scaled = parseFloat((n / f).toPrecision(6));
      return `${scaled}${suffix}`;
    }
  }
  return `${parseFloat((n / 1e-15).toPrecision(6))}f`;
}

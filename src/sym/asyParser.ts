import type { ComponentType } from "@editor/nodes/ComponentNode.js";

/**
 * Minimal parser for LTSpice `.asy` symbol files.
 *
 * Supported primitives: LINE, RECTANGLE, CIRCLE, ARC, PIN (+ PINATTR),
 * WINDOW and SYMATTR. The geometry uses LTSpice's coordinate system where the
 * y-axis points downwards. We keep the raw coordinates and let the renderer map
 * them into screen space.
 */

export interface AsyLine {
  x1: number; y1: number; x2: number; y2: number;
}

/** Axis-aligned rectangle (two opposite corners). */
export interface AsyRect {
  x1: number; y1: number; x2: number; y2: number;
}

/** Ellipse described by its bounding box (two opposite corners). */
export interface AsyCircle {
  x1: number; y1: number; x2: number; y2: number;
}

/**
 * Elliptical arc. `(x1,y1)-(x2,y2)` is the ellipse bounding box; the arc runs
 * (visually counter-clockwise) from the start edge point to the end edge point.
 */
export interface AsyArc {
  x1: number; y1: number; x2: number; y2: number;
  sx: number; sy: number; ex: number; ey: number;
}

export interface AsyPin {
  x: number; y: number;
  name: string;
  /** SPICE pin order (1-based) as declared by PINATTR SpiceOrder. */
  order: number;
}

/**
 * A text drawn as part of the symbol (LTSpice `TEXT x y <just> <size> <text>`),
 * e.g. the supply markings on the op-amp. Distinct from the captions the editor
 * draws around a part (reference and value): those belong to the instance, this
 * belongs to the drawing and turns with it.
 */
export interface AsyText {
  x: number;
  y: number;
  /** LTSpice justification keyword (Left, Center, Right, …). */
  just: string;
  /** LTSpice font-size index; 0 and 1 are the small ones. */
  size: number;
  text: string;
}

export interface AsySymbol {
  lines: AsyLine[];
  rects: AsyRect[];
  circles: AsyCircle[];
  arcs: AsyArc[];
  texts: AsyText[];
  pins: AsyPin[];
  attrs: Record<string, string>;
}

export interface SymbolBounds {
  minX: number; minY: number; maxX: number; maxY: number;
  cx: number; cy: number;
  width: number; height: number;
}

function emptySymbol(): AsySymbol {
  return { lines: [], rects: [], circles: [], arcs: [], texts: [], pins: [], attrs: {} };
}

export function parseAsy(text: string): AsySymbol {
  const sym = emptySymbol();
  let pendingPin: { x: number; y: number } | null = null;
  let pinName = "";
  let pinOrder = 0;

  const flushPin = () => {
    if (pendingPin) {
      sym.pins.push({ x: pendingPin.x, y: pendingPin.y, name: pinName, order: pinOrder || sym.pins.length + 1 });
    }
    pendingPin = null;
    pinName = "";
    pinOrder = 0;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tok = line.split(/\s+/);
    const kw = tok[0].toUpperCase();

    switch (kw) {
      case "LINE":
        // LINE Normal x1 y1 x2 y2 [style]
        sym.lines.push({ x1: +tok[2], y1: +tok[3], x2: +tok[4], y2: +tok[5] });
        break;
      case "RECTANGLE":
        sym.rects.push({ x1: +tok[2], y1: +tok[3], x2: +tok[4], y2: +tok[5] });
        break;
      case "CIRCLE":
        sym.circles.push({ x1: +tok[2], y1: +tok[3], x2: +tok[4], y2: +tok[5] });
        break;
      case "ARC":
        // ARC Normal x1 y1 x2 y2 sx sy ex ey
        sym.arcs.push({
          x1: +tok[2], y1: +tok[3], x2: +tok[4], y2: +tok[5],
          sx: +tok[6], sy: +tok[7], ex: +tok[8], ey: +tok[9],
        });
        break;
      case "TEXT":
        // TEXT x y <justification> <size> <text…> — the text runs to the end of
        // the line and may contain spaces, so it is taken from the raw line
        // rather than from the whitespace split.
        if (tok.length >= 6) {
          const body = line.split(/\s+/).slice(5).join(" ");
          sym.texts.push({ x: +tok[1], y: +tok[2], just: tok[3], size: +tok[4] || 0, text: body });
        }
        break;
      case "PIN":
        flushPin();
        pendingPin = { x: +tok[1], y: +tok[2] };
        break;
      case "PINATTR":
        if (tok[1] === "PinName") pinName = tok.slice(2).join(" ");
        else if (tok[1] === "SpiceOrder") pinOrder = +tok[2];
        break;
      case "SYMATTR":
        if (tok.length >= 3) sym.attrs[tok[1]] = tok.slice(2).join(" ");
        break;
      default:
        // Version, SymbolType, WINDOW, TEXT … ignored for rendering.
        break;
    }
  }
  flushPin();
  return sym;
}

/** Bounding box over all drawable geometry plus pins. */
export function symbolBounds(sym: AsySymbol): SymbolBounds {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const l of sym.lines) { acc(l.x1, l.y1); acc(l.x2, l.y2); }
  for (const r of sym.rects) { acc(r.x1, r.y1); acc(r.x2, r.y2); }
  for (const c of sym.circles) { acc(c.x1, c.y1); acc(c.x2, c.y2); }
  // Sample the swept arc, not its ellipse bounding box — a shallow arc (e.g. an
  // electrolytic cap's plate) would otherwise inflate the bounds far past the
  // visible curve and shrink the whole symbol.
  for (const a of sym.arcs) {
    const cx = (a.x1 + a.x2) / 2, cy = (a.y1 + a.y2) / 2;
    const rx = Math.abs(a.x2 - a.x1) / 2 || 0.001;
    const ry = Math.abs(a.y2 - a.y1) / 2 || 0.001;
    const a0 = Math.atan2((a.sy - cy) / ry, (a.sx - cx) / rx);
    let a1 = Math.atan2((a.ey - cy) / ry, (a.ex - cx) / rx);
    while (a1 > a0) a1 -= Math.PI * 2;
    const steps = Math.max(2, Math.ceil(Math.abs(a0 - a1) / (Math.PI / 16)));
    for (let i = 0; i <= steps; i++) {
      const ang = a0 + ((a1 - a0) * i) / steps;
      acc(cx + rx * Math.cos(ang), cy + ry * Math.sin(ang));
    }
  }
  for (const p of sym.pins) acc(p.x, p.y);
  if (!isFinite(minX)) { minX = -10; minY = -10; maxX = 10; maxY = 10; }
  return {
    minX, minY, maxX, maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

// --- Symbol library ----------------------------------------------------------

const rawModules = import.meta.glob("./**/*.asy", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** All parsed symbols keyed by their bare filename without extension. */
export const SYMBOL_LIBRARY: Record<string, AsySymbol> = {};
/** Case-insensitive lookup index (filename variants use inconsistent casing). */
const LIB_INDEX: Record<string, AsySymbol> = {};
/**
 * The `.asy` text each symbol was parsed from, keyed like {@link LIB_INDEX}.
 *
 * Kept because a parsed symbol cannot be turned back into a file: the parser
 * reads the geometry it draws and drops the rest. The LTSpice bundle export
 * hands these sources out verbatim, which is the only form LTSpice will read
 * (see ltspiceBundle).
 */
const LIB_SOURCE: Record<string, string> = {};
for (const [path, raw] of Object.entries(rawModules)) {
  const name = path.split("/").pop()!.replace(/\.asy$/i, "");
  const sym = parseAsy(raw);
  SYMBOL_LIBRARY[name] = sym;
  LIB_INDEX[name.toLowerCase()] = sym;
  LIB_SOURCE[name.toLowerCase()] = raw;
}

export type SymbolNorm = "default" | "ansi" | "en";

/**
 * Maps an editor component type to the *base* LTSpice symbol name. Norm variants
 * (ANSI/EN) are derived from the base name. Types without an entry fall back to
 * the hand-drawn React symbols.
 */
const TYPE_TO_SYMBOL: Partial<Record<ComponentType, string>> = {
  resistor: "res",
  jumper: "jumper",
  capacitor: "cap",
  capacitor_polarized: "polcap",
  inductor: "ind",
  diode: "diode",
  led: "LED",
  zener: "zener",
  schottky: "schottky",
  bjt_npn: "npn",
  bjt_pnp: "pnp",
  mosfet_n: "nmos",
  mosfet_p: "pmos",
  // Voltage sources render via the hand-drawn symbols (chosen by sourceType),
  // so they are intentionally NOT mapped to an .asy symbol here.
  isource: "current",
  opamp: "UniversalOpAmp2",
  vswitch: "sw",
};

/** Resolves a base symbol name + norm to a parsed symbol, with graceful fallback. */
function resolveSymbol(base: string, norm: SymbolNorm): AsySymbol | undefined {
  const candidates: string[] = [];
  if (norm === "ansi") candidates.push(`${base}_ANSI`, `${base}__ANSI`);
  else if (norm === "en") candidates.push(`${base}_EN`, `${base}__EN`);
  candidates.push(base); // default and ultimate fallback
  for (const c of candidates) {
    const sym = LIB_INDEX[c.toLowerCase()];
    if (sym) return sym;
  }
  return undefined;
}

export function symbolForType(type: ComponentType, norm: SymbolNorm = "default"): AsySymbol | undefined {
  const base = TYPE_TO_SYMBOL[type];
  return base ? resolveSymbol(base, norm) : undefined;
}

/**
 * Resolves a symbol by its bare name (case-insensitive), honouring norm
 * variants. Used for library components whose symbol is not tied to a fixed
 * editor {@link ComponentType} (e.g. user `.asy` files loaded at runtime).
 */
export function symbolByName(name: string, norm: SymbolNorm = "default"): AsySymbol | undefined {
  return resolveSymbol(name, norm);
}

/**
 * The `.asy` source a symbol was read from, for handing it back out as a file.
 * The bare name only: a path-qualified LTSpice name (`Misc\\EuropeanResistor`)
 * belongs to LTSpice's own library and is never ours to export.
 */
export function symbolSource(name: string): string | undefined {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase();
  return LIB_SOURCE[base];
}

/**
 * Registers an `.asy` symbol at runtime (e.g. fetched from the server library),
 * so it becomes resolvable via {@link symbolByName} exactly like a bundled one.
 * Re-registering the same name replaces the previous definition.
 */
export function registerSymbol(name: string, rawAsy: string): AsySymbol {
  const sym = parseAsy(rawAsy);
  LIB_SOURCE[name.toLowerCase()] = rawAsy;
  SYMBOL_LIBRARY[name] = sym;
  LIB_INDEX[name.toLowerCase()] = sym;
  return sym;
}

/**
 * Removes a symbol registered by {@link registerSymbol}, so lookups fall back to
 * whatever they resolved to before.
 *
 * The registry is module-level state shared by everything that draws, which is
 * fine in the browser — the bundled symbols load once and never change. The
 * regression harness has no bundled symbols at all (its `import.meta.glob` stub
 * returns nothing), so a suite that needs real geometry has to add it; without a
 * way to take it out again that suite would silently change the ones that run
 * after it, several of which assert the *fallback* geometry on purpose.
 */
export function unregisterSymbol(name: string): void {
  delete LIB_SOURCE[name.toLowerCase()];
  delete SYMBOL_LIBRARY[name];
  delete LIB_INDEX[name.toLowerCase()];
}

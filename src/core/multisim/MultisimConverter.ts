/**
 * Multisim Live (`.msjs`) → LTSpice (`.asc`) conversion.
 *
 * Multisim Live was retired; this recovers the schematics from its export. The
 * `.msjs` container is `"msjs-2.0"` + a uint32-LE payload length + UTF-8 JSON +
 * an `XXXX` trailer. Everything needed sits in four places:
 *
 *   blueprints.components       part *types* (name, refdes prefix, conn↔pin map)
 *   blueprints.symbols          SVG artwork; pin coordinates live in `oecl:` attrs
 *   sheettemplates[].template   the placed schematic: parts, wires, connectors
 *   sheettemplates[].instances  per-part refdes and model parameter values
 *
 * Multisim places parts with an SVG matrix {a,b,c,d,e,f} on a 1-unit grid and
 * draws wires as polylines on that same grid. One Multisim unit is 16 LTSpice
 * units, so geometry carries over directly — but three things do not, and each
 * produced a silently wrong schematic before it was handled:
 *
 *  - `nets[].objects[].pin` is the *symbol* pin id, not the connection name.
 *    Multisim's stock parts routinely map conn "1" to symbol pin "2".
 *  - The two tools' stock artwork has no common resting orientation (Multisim
 *    draws a resistor horizontally, LTSpice vertically), so Multisim's rotation
 *    cannot be reused — see fitOrientation.
 *  - Multisim marks connections with explicit junctions, so two of its wires may
 *    cross while staying separate nets. LTSpice has no such notion — see
 *    cutCrossings.
 *
 * The document is external, untyped JSON, so `any` is the honest type wherever
 * it is touched.
 *
 * The CLI wrapper (scripts/convert-multisim.mjs) adds file I/O and the batch
 * report; both it and the in-app importer share this module so they cannot
 * drift apart.
 */

import { outwardDir } from "@core/geometry/ortho.js";

/** A point or a symbol-local offset, in LTSpice units. */
type Pt = [number, number];
/** A wire segment: x1, y1, x2, y2. */
type Wire = [number, number, number, number];
/** Flattened model parameters, `{ Resistance: "4.7k" }`. */
type Params = Record<string, string | undefined>;
/** `<part guid>/<symbol pin id>` → the pin's final LTSpice position. */
type PinPos = Record<string, Pt>;

interface Fit { deg: number; mirrored: boolean; origin: Pt; str?: string }

interface PartType {
  sym: string;
  euro?: string;
  prefix: string;
  /** Overrides the Multisim refdes prefix where SPICE needs a different one. */
  forcePrefix?: string;
  /** Multisim connection names, in the LTSpice symbol's pin order. */
  pins: (string | null)[];
  value: (p: Params) => string;
  /**
   * Extra `SYMATTR` lines, verbatim. Library parts need `Prefix`/`SpiceModel`
   * rather than a `Value`, because they are a `.subckt` call rather than a
   * device with a magnitude.
   */
  attrs?: string[];
}

interface SwitchSpec {
  paths: [string, string][];
  stateDrivesPath: boolean;
  drop?: string[];
}

interface Ctx {
  symbolLines: string[];
  flags: string[];
  directives: string[];
  pinPos: PinPos;
  used: Set<string>;
  wires: Wire[];
  to: (v: number) => number;
}

export interface ConversionResult {
  /** The LTSpice schematic. */
  asc: string;
  /** Multisim part names with no LibreSpice equivalent; these were left out. */
  skipped: string[];
  /** Parts converted via a stand-in (switches, potentiometers). */
  substituted: string[];
  /** Multisim nets the emitted drawing shorted together. */
  shorts: string[];
}

/**
 * Unwrap the `.msjs` container and return its JSON payload.
 *
 * Takes an ArrayBuffer rather than a Node Buffer so the browser importer and
 * the CLI can share it.
 */
export function readMsjs(buffer: ArrayBuffer): any {
  const bytes = new Uint8Array(buffer);
  const magic = new TextDecoder("ascii").decode(bytes.subarray(0, 8));
  if (magic !== "msjs-2.0") throw new Error("Keine msjs-2.0-Datei");
  const length = new DataView(buffer).getUint32(8, true);
  return JSON.parse(new TextDecoder("utf-8").decode(bytes.subarray(12, 12 + length)));
}

/** LTSpice units per Multisim grid unit. */
const GRID = 16;

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Part type mapping
// ---------------------------------------------------------------------------

/**
 * Multisim component name → how we render it. `sym` is the LTSpice symbol,
 * `pins` maps Multisim connection names to that symbol's pin order, and `value`
 * builds the SYMATTR Value from the part's model parameters.
 *
 * Multisim already stores values with SI suffixes ("2.2k", "0.1μ"), so the
 * numeric ones only need µ normalised for SPICE.
 */
const TYPES: Record<string, PartType> = {
  Resistor: { sym: "res", euro: "Misc\\EuropeanResistor", prefix: "R", pins: ["1", "2"], value: (p) => si(p.Resistance) },
  Capacitor: { sym: "cap", euro: "Misc\\EuropeanCap", prefix: "C", pins: ["1", "2"], value: (p) => si(p.Capacitance) },
  Inductor: { sym: "ind", euro: "Misc\\EuropeanInductor", prefix: "L", pins: ["1", "2"], value: (p) => si(p.Inductance) },

  "DC Voltage": { sym: "voltage", prefix: "V", pins: ["1", "2"], value: (p) => si(p.DC_mag) },
  "DC Current": { sym: "current", prefix: "I", pins: ["1", "2"], value: (p) => si(p.DC_mag) },
  "AC Voltage": { sym: "voltage", prefix: "V", pins: ["1", "2"], value: sine },
  "AC Current": { sym: "current", prefix: "I", pins: ["1", "2"], value: sine },
  "Pulse Voltage": { sym: "voltage", prefix: "V", pins: ["1", "2"], value: pulse },
  "Clock Voltage": { sym: "voltage", prefix: "V", pins: ["1", "2"], value: pulse },
  "Step Voltage": { sym: "voltage", prefix: "V", pins: ["1", "2"], value: pulse },
  "Triangular Voltage": { sym: "voltage", prefix: "V", pins: ["1", "2"], value: pulse },
  "Arbitrary Voltage Source": { sym: "voltage", prefix: "V", pins: ["1", "2"], value: pwl },
  "Arbitrary Current Source": { sym: "current", prefix: "I", pins: ["1", "2"], value: pwl },

  // A lamp is a plain resistor to SPICE. Multisim rates it by voltage and power
  // rather than resistance, so derive R = U²/P — the hot-filament value, which
  // is what these circuits switch. Its refdes prefix is forced to R because
  // SPICE reads a leading "X" as a subcircuit call.
  Lamp: { sym: "res", euro: "Misc\\EuropeanResistor", prefix: "R", forcePrefix: "R", pins: ["1", "2"], value: lampResistance },

  Diode: { sym: "diode", prefix: "D", pins: ["A", "K"], value: () => "D" },
  LED: { sym: "LED", prefix: "D", pins: ["A", "K"], value: () => "LED" },
  Zener: { sym: "zener", prefix: "D", pins: ["A", "K"], value: () => "D" },
  // Multisim's "Diode Switch" is a switching diode, not a contact.
  "Diode Switch": { sym: "diode", prefix: "D", pins: ["A", "K"], value: () => "D" },
  NPN: { sym: "npn", prefix: "Q", pins: ["C", "B", "E"], value: () => "NPN" },
  PNP: { sym: "pnp", prefix: "Q", pins: ["C", "B", "E"], value: () => "PNP" },
  "JFET N": { sym: "njf", prefix: "J", pins: ["D", "G", "S"], value: () => "NJF" },

  // Multisim's 3-terminal op-amp has no supply pins; the 5-terminal one does.
  // Both map onto UniversalOpAmp2, whose pin order is In+ In- V+ V- OUT.
  "3 Terminal Opamp": { sym: "UniversalOpAmp2", prefix: "U", pins: ["IN+", "IN-", null, null, "OUT"], value: () => "UniversalOpAmp2" },
  "5 Terminal Opamp": { sym: "UniversalOpAmp2", prefix: "U", pins: ["IN+", "IN-", "V+", "V-", "OUT"], value: () => "UniversalOpAmp2" },
  // The LM317 is a library part, not a primitive: the `Ureg` symbol plus the
  // `LM317/TI` subcircuit from library/sub/LM317.lib, which the netlist
  // generator pulls in because the schematic references it by name. Pin order
  // follows Ureg.asy's SpiceOrder — in, adj, out.
  LM317: {
    sym: "Ureg", prefix: "X", forcePrefix: "X", pins: ["IN", "ADJ", "OUT"],
    value: () => "", attrs: ["Prefix X", "SpiceModel LM317/TI"],
  },

  // The three MCR thyristors all map onto one generic SCR (library/sub/
  // Thyristor.lib): the classic two-transistor equivalent, which latches on a
  // gate pulse and drops out when the anode current does. It is a generic part,
  // not a type — trigger current, holding current and blocking voltage match no
  // particular datasheet.
  ...Object.fromEntries(["MCR08B", "MCR8SN", "MCR716"].map((n) => [n, {
    sym: "SCR", prefix: "X", forcePrefix: "X", pins: ["A", "G", "K"],
    value: () => "", attrs: ["Prefix X", "SpiceModel SCR"],
  }])),

  // The BZB84 is a dual Zener in one package, but Multisim places one *section*
  // at a time — a plain two-terminal Zener. The second section's cathode is
  // spelled "2K", so both names map onto the same pin.
  "BZB84-B6V2": { sym: "zener", prefix: "D", pins: ["A", "K"], value: () => "BZB84B6V2" },

  // The 74LS93 ripple counter, as a library part: four counting flip-flops and
  // the reset NAND, in library/sub/74LS93.lib. Multisim's VCC and Ground pins
  // have no counterpart — the behavioural cells carry their own fixed logic
  // levels — so they are dropped like the 3-terminal op-amp's supplies.
  "74LS93N": {
    sym: "74LS93", prefix: "U", forcePrefix: "X",
    pins: ["INA", "INB", "R01", "R02", "QA", "QB", "QC", "QD"],
    value: () => "", attrs: ["Prefix X", "SpiceModel 74LS93"],
  },

  // Multisim's ideal comparator is an op-amp with no supply pins and a defined
  // output swing (Output_level, Rise_fall_time). Mapped onto the generic op-amp
  // it keeps the comparison but not the output levels: the converted stage
  // swings to whatever its supply rails allow rather than to Output_level, and
  // the specified edge time is lost. Close enough for a threshold decision,
  // which is what these circuits use it for.
  "Ideal Comparator": { sym: "UniversalOpAmp2", prefix: "U", pins: ["IN+", "IN-", null, null, "OUT"], value: () => "UniversalOpAmp2" },

  // The INA333 is an instrumentation amplifier, not an op-amp: its gain is set
  // by an external resistor across RG1/RG2 and its output is referred to REF.
  // Mapped onto the generic op-amp those three pins have no counterpart, so the
  // converted stage has open-loop gain instead of the gain the circuit set, and
  // REF is lost. It converts so the schematic is complete — the amplification
  // has to be rebuilt by hand.
  INA333: { sym: "UniversalOpAmp2", prefix: "U", pins: ["IN+", "IN-", "VS+", "VS-", "OUT"], value: () => "UniversalOpAmp2" },
};

/**
 * Discrete parts Multisim names after the real device. They all use the generic
 * symbol plus the part number as the model, so a `.model`/`.lib` line added
 * later resolves them.
 */
const DISCRETES = {
  BC817: "npn", "2N2222A": "npn", "2N3904": "npn", BD244: "pnp", MJ15024: "npn",
  BDP948: "npn", BDP949: "pnp", BC846BM3: "npn", MMBTA14L: "npn", MMBTA63L: "pnp",
  MJD122: "npn", "1N4148": "diode", MMBF4393L: "njf",
};
const DISCRETE_PINS: Record<string, string[]> = { npn: ["C", "B", "E"], pnp: ["C", "B", "E"], njf: ["D", "G", "S"], diode: ["A", "K"] };
const DISCRETE_PREFIX: Record<string, string> = { npn: "Q", pnp: "Q", njf: "J", diode: "D" };

for (const [name, sym] of Object.entries(DISCRETES)) {
  TYPES[name] = { sym, prefix: DISCRETE_PREFIX[sym], pins: DISCRETE_PINS[sym], value: () => name };
}

/** LTSpice pin offsets from the symbol origin, before rotation. */
const PIN_OFFSETS: Record<string, Pt[]> = {
  res: [[16, 16], [16, 96]],
  "Misc\\EuropeanResistor": [[16, 16], [16, 96]],
  cap: [[16, 0], [16, 64]],
  "Misc\\EuropeanCap": [[16, 0], [16, 64]],
  ind: [[16, 16], [16, 96]],
  "Misc\\EuropeanInductor": [[16, 16], [16, 96]],
  voltage: [[0, 16], [0, 96]],
  current: [[0, 0], [0, 80]],
  diode: [[16, 0], [16, 64]],
  LED: [[16, 0], [16, 64]],
  zener: [[16, 0], [16, 64]],
  npn: [[64, 0], [0, 48], [64, 96]],
  pnp: [[64, 0], [0, 48], [64, 96]],
  njf: [[64, 0], [0, 48], [64, 96]],
  UniversalOpAmp2: [[-32, 16], [-32, -16], [0, -32], [0, 32], [32, 0]],
  // library/sym/Ureg.asy, in SpiceOrder: in, adj, out.
  Ureg: [[-48, -16], [0, 32], [48, -16]],
  // library/sym/SCR.asy, in SpiceOrder: A, G, K.
  SCR: [[0, -64], [48, 40], [0, 64]],
  // library/sym/74LS93.asy, in SpiceOrder: CKA CKB R01 R02 QA QB QC QD.
  "74LS93": [[-48, -48], [-48, -16], [-48, 16], [-48, 48], [48, -48], [48, -16], [48, 16], [48, 48]],
  // D, CLK, SET, RESET, Q, ~Q — the same numbers as ltspiceGeometry's `dff`
  // entry, which is what the editor places the pins on.
  "Digital\\dflop": [[-32, -24], [-32, 24], [0, -48], [0, 48], [32, -24], [32, 24]],
};

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

/** Normalise a Multisim value for SPICE (µ → u, strip blanks). */
function si(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  return String(v).replace(/[μµ]/g, "u").trim();
}

/** `AC Voltage`/`AC Current` carry a SPICE SIN() source's parameters. */
function sine(p: Params): string {
  const f = (k: string, d: string) => si(p[k]) || d;
  return `SINE(${f("VO", "0")} ${f("VA", "1")} ${f("Freq", "1k")} ${f("TD", "0")} ${f("DF", "0")} ${f("Phase", "0")})`;
}

/**
 * Assign a unique reference designator.
 *
 * Multisim leaves the number off single-instance parts and lets a lamp share
 * the resistor prefix once we force one, so numbering naively produced two
 * parts called `R1` in the same netlist — SPICE keeps only the last. Explicit
 * numbers are reserved up front (see `reserveNames`) and win; anything else
 * takes the lowest number still free.
 */
function uniqueName(prefix: string, number: string | null | undefined, used: Set<string>): string {
  let n: string | number | null | undefined = number;
  if (n === null || n === undefined || used.has(`${prefix}${n}`)) {
    let next = 1;
    while (used.has(`${prefix}${next}`)) next++;
    n = next;
  }
  const name = `${prefix}${n}`;
  used.add(name);
  return name;
}

/**
 * Flatten Multisim's `{modelGuid: {param: {stringvalue}}}` levels into one
 * plain `{param: value}` map. Later arguments win.
 */

/**
 * Lamp resistance from its ratings: R = U²/P.
 *
 * Falls back to 1 kΩ if a lamp carries no ratings, so it stays a finite load
 * instead of shorting the branch it sits in.
 */
function lampResistance(p: Params): string {
  const u = parseFloat(si(p["Maximum rated voltage"]));
  const w = parseFloat(si(p["Maximum rated power"]));
  if (!Number.isFinite(u) || !Number.isFinite(w) || w <= 0) return "1k";
  return String(Number((u * u / w).toPrecision(4)));
}

/** SI-suffixed SPICE number ("1m", "4.7k", "1n") as a plain number. */
function siNum(s: string): number {
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*([a-zµ]*)/i.exec(s ?? "");
  if (!m) return NaN;
  const mult: Record<string, number> = {
    t: 1e12, g: 1e9, meg: 1e6, k: 1e3, m: 1e-3, u: 1e-6, µ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15,
  };
  const suf = m[2].toLowerCase();
  // "meg" before "m": SPICE spells a million "MEG" and a milli "m".
  const f = suf.startsWith("meg") ? mult.meg : mult[suf[0]] ?? 1;
  return parseFloat(m[1]) * f;
}

/**
 * The period of every periodic source in the sheet, read back off the `Value`
 * lines already emitted — one pass over the finished symbols rather than a
 * period threaded through each emitter.
 */
function sourcePeriods(symbolLines: string[]): number[] {
  const out: number[] = [];
  for (const line of symbolLines) {
    const v = /^SYMATTR Value (.+)$/.exec(line)?.[1];
    if (!v) continue;
    const pulse = /^PULSE\(\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/i.exec(v);
    if (pulse) { const t = siNum(pulse[7]); if (t > 0) out.push(t); continue; }
    const sin = /^SINE?\(\s*(\S+)\s+(\S+)\s+(\S+)/i.exec(v);
    if (sin) { const f = siNum(sin[3]); if (f > 0) out.push(1 / f); continue; }
    // A PWL source is not periodic, but its last breakpoint is how long it has
    // anything to say — which serves the same purpose here.
    const pwl = /^PWL\(([^)]*)\)/i.exec(v);
    if (pwl) {
      const tok = pwl[1].trim().split(/\s+/).filter((t) => !/^r\s*=/i.test(t));
      const last = siNum(tok[tok.length - 2] ?? "");
      if (last > 0) out.push(last);
    }
  }
  return out;
}

/**
 * How many periods of the slowest source the converted schematic should run for.
 * Enough to fill a 4-bit counter (16 clocks) and still see it wrap, which is what
 * the counter and shift-register exercises are about.
 */
const TRAN_PERIODS = 20;
/** Points per period of the *fastest* source — plenty to draw a clean edge. */
const TRAN_RESOLUTION = 100;

/**
 * The `.tran` line for a converted sheet, sized from its own sources.
 *
 * Multisim stores no transient settings we can read, and the app's fallback is
 * 1 µs / 1 ms — meaningless for these schematics, whose clocks run at 10 Hz. Left
 * at the fallback a counter shows a hundredth of one clock period; corrected by
 * hand to a useful stop time while keeping the 1 µs step, it is 1.6 million
 * points and takes minutes. Both failure modes look like a broken simulation, so
 * the stop time and the step are derived here instead.
 */
function tranDirective(symbolLines: string[]): string | null {
  const periods = sourcePeriods(symbolLines);
  if (periods.length === 0) return null;
  const stop = Math.max(...periods) * TRAN_PERIODS;
  const step = Math.min(...periods) / TRAN_RESOLUTION;
  const fmt = (v: number) => Number(v.toPrecision(3)).toExponential().replace("e+0", "").replace(/e([-+]\d+)/, "e$1");
  return `.tran ${fmt(step)} ${fmt(stop)}`;
}

/** Pulse/clock/step/triangle sources all map onto SPICE PULSE(). */
/**
 * How far apart two PWL breakpoints are pushed when Multisim gave them the same
 * timestamp. A nanosecond is far below anything these schematics resolve (their
 * waveforms run in tens of milliseconds and up) but is a real, finite edge.
 */
const PWL_EDGE = 1e-9;

/**
 * The arbitrary sources are Multisim's name for a PWL source: the parameter is
 * already a list of `time value` pairs, just one pair per line. `Repeat` is a
 * separate flag ("pwlrepeat" = replay forever), which becomes ngspice's `r=0`.
 *
 * The pairs go through `si` for the micro sign but are otherwise passed
 * through, so SI suffixes survive exactly as they do for a hand-typed PWL.
 */
function pwl(p: Params): string {
  const tok = si(p["Time/Voltage pairs"] ?? p["Time/Current pairs"]).split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let prev = -Infinity;
  for (let i = 0; i + 1 < tok.length; i += 2) {
    const t = Number(tok[i]);
    // Multisim draws a vertical edge as two points sharing one timestamp.
    // ngspice warns about "non-increasing PWL time points" and its reading of a
    // duplicate is not defined, so the second point is nudged into a real (very
    // fast) edge. Only plain decimals are touched: anything with an SI suffix or
    // a `{param}` is passed through, since it cannot be compared numerically.
    if (Number.isFinite(t) && String(t) === tok[i] && t <= prev) {
      // Rounded, or binary floating point leaves "0.32000000100000003" in the
      // schematic; 15 digits is well inside a double's exact range.
      const nudged = Number((prev + PWL_EDGE).toPrecision(15));
      out.push(String(nudged), tok[i + 1]);
      prev = nudged;
    } else {
      out.push(tok[i], tok[i + 1]);
      if (Number.isFinite(t)) prev = t;
    }
  }
  // An odd trailing token would be a time without its value; keep it rather than
  // dropping data silently, and let the netlist show the problem.
  if (tok.length % 2) out.push(tok[tok.length - 1]);
  const repeat = /pwlrepeat/i.test(String(p.Repeat ?? "")) ? " r=0" : "";
  return `PWL(${out.join(" ")}${repeat})`;
}

function pulse(p: Params): string {
  const f = (k: string, d: string) => si(p[k]) || d;
  return `PULSE(${f("VI", "0")} ${f("VP", "1")} ${f("TD", "0")} ${f("TR", "1n")} ${f("TF", "1n")} ${f("PW", "0.5m")} ${f("Per", "1m")})`;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------


/** Scale a Multisim point to LTSpice units, keeping the tuple shape. */
const scaled = (p: Pt, to: (v: number) => number): Pt => [to(p[0]), to(p[1])];

/** Apply a Multisim placement matrix to a symbol-local point. */
function applyMatrix(m: any, [x, y]: Pt): Pt {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

/** The eight orientations LTSpice can place a symbol in. */
const ORIENTATIONS = [
  { deg: 0, mirrored: false }, { deg: 90, mirrored: false },
  { deg: 180, mirrored: false }, { deg: 270, mirrored: false },
  { deg: 0, mirrored: true }, { deg: 90, mirrored: true },
  { deg: 180, mirrored: true }, { deg: 270, mirrored: true },
];

/**
 * Pick the LTSpice orientation that best reproduces Multisim's pin layout.
 *
 * The placement matrix can't be carried over directly: the two tools' stock
 * artwork does not share a resting orientation (Multisim draws a resistor
 * horizontally, LTSpice vertically), so reusing Multisim's angle rotates the
 * symbol away from its wires. Fitting against the pins themselves sidesteps
 * every such per-symbol convention — including mirroring — and works the same
 * for 2-pin passives, transistors and op-amps.
 *
 * Each candidate is anchored on the first pin, then scored by how far the
 * remaining pins land from where Multisim had them.
 */
function fitOrientation(offsets: Pt[], want: (Pt | null)[], anchorIdx: number): Fit {
  let best: (Fit & { err: number }) | null = null;
  const anchor = want[anchorIdx]!;
  for (const o of ORIENTATIONS) {
    const rot = rotate(offsets[anchorIdx], o.deg, o.mirrored);
    const origin: Pt = [anchor[0] - rot[0], anchor[1] - rot[1]];
    let err = 0;
    for (let i = 0; i < offsets.length; i++) {
      const target = want[i];
      if (!target || !offsets[i]) continue;
      const r = rotate(offsets[i], o.deg, o.mirrored);
      err += (origin[0] + r[0] - target[0]) ** 2 + (origin[1] + r[1] - target[1]) ** 2;
    }
    if (best === null || err < best.err) best = { ...o, origin, err };
  }
  const f = best!;
  return { ...f, str: `${f.mirrored ? "M" : "R"}${f.deg}` };
}

/** Rotate a symbol-local offset the way LTSpice does: R90 maps (x,y)→(-y,x). */
function rotate([x, y]: Pt, deg: number, mirrored: boolean): Pt {
  if (mirrored) x = -x;
  switch (deg) {
    case 90: return [-y, x];
    case 180: return [-x, -y];
    case 270: return [y, -x];
    default: return [x, y];
  }
}

/**
 * Multisim's logic gates, as gate kind plus input connection names.
 *
 * They convert to LibreSpice's behavioural gate, which is ideal: no propagation
 * delay and no fan-out limit. That is the right abstraction for the logic
 * exercises these come from, but it means a circuit relying on gate delay (a
 * ring oscillator, a race) will not behave as it did in Multisim.
 */
const GATES: Record<string, { gate: string; ins: string[] }> = {
  Inverter: { gate: "not", ins: ["A"] },
  Buffer: { gate: "buffer", ins: ["A"] },
  "2-Input AND": { gate: "and", ins: ["A", "B"] },
  "3-Input AND": { gate: "and", ins: ["A", "B", "C"] },
  "4-Input AND": { gate: "and", ins: ["A", "B", "C", "D"] },
  "2-Input OR": { gate: "or", ins: ["A", "B"] },
  "3-Input OR": { gate: "or", ins: ["A", "B", "C"] },
  "4-Input OR": { gate: "or", ins: ["A", "B", "C", "D"] },
  "5-Input OR": { gate: "or", ins: ["A", "B", "C", "D", "E"] },
  "2-Input NAND": { gate: "nand", ins: ["A", "B"] },
  "2-Input NOR": { gate: "nor", ins: ["A", "B"] },
  "2-Input XOR": { gate: "xor", ins: ["A", "B"] },
};

/** LTSpice's Digital library spells NOT and Buffer differently. */
const GATE_SYMBOL: Record<string, string> = { not: "inv", buffer: "buf" };

/** Logic levels the converted gates and digital sources use. */
import type { MsPart, MsSchematic, MsNet } from "./model.js";

const LOGIC_HIGH = 5;
const LOGIC_THRESHOLD = 2.5;

/**
 * Pin offsets of a converted gate, mirroring ltspiceGeometry.logicGatePinOffsets
 * so the emitted `.asc` and the editor agree on where the pins sit.
 */
function gatePinOffsets(n: number): Pt[] {
  const span = 48;
  const offs: Pt[] = [];
  for (let i = 0; i < n; i++) {
    offs.push([0, 40 + (n === 1 ? 0 : Math.round(-span / 2 + (span * i) / (n - 1)))]);
  }
  offs.push([72, 40]);
  return offs;
}

/**
 * Emit a logic gate.
 *
 * Anchored on its output, because that pin exists on every gate and is the one
 * the following stage is wired to; the inputs then fall out of the symbol's own
 * geometry and the net-list reconciliation labels whatever does not line up.
 */
function emitGate(part: MsPart, spec: { gate: string; ins: string[] }, ctx: Ctx): void {
  const { symbolLines, pinPos, used } = ctx;
  const name = uniqueName(part.refdes.prefix || "U", part.refdes.number, used);

  const at = (conn: string, p: Pt) => { const id = part.connPin[conn]; if (id !== undefined) pinPos[`${part.guid}/${id}`] = p; };

  const offs = gatePinOffsets(spec.ins.length);
  const outLocal = part.pins["Y"];
  const outAbs: Pt = outLocal ? scaled(applyMatrix(part.matrix, outLocal), ctx.to) : [0, 0];
  const origin: Pt = [outAbs[0] - offs[offs.length - 1][0], outAbs[1] - offs[offs.length - 1][1]];

  const symName = `Digital\\${GATE_SYMBOL[spec.gate] ?? spec.gate}`;
  const pinNames = [...spec.ins.map((_, i) => `In${i + 1}`), "Out"];
  symbolLines.push(`SYMBOL ${symName} ${origin[0]} ${origin[1]} R0`);
  symbolLines.push(`SYMATTR InstName ${name}`);
  symbolLines.push(`SYMATTR Value ${spec.gate.toUpperCase()}`);
  symbolLines.push(
    `SYMATTR LibreSpice gate=${spec.gate};inputs=${spec.ins.length};` +
    `vth=${LOGIC_THRESHOLD};vhigh=${LOGIC_HIGH};pins=${pinNames.join(",")}`,
  );

  spec.ins.forEach((conn, i) => at(conn, [origin[0] + offs[i][0], origin[1] + offs[i][1]]));
  at("Y", outAbs);
}

/**
 * Multisim connection names of a D flip-flop, in the order of the symbol's pin
 * offsets above. The offsets have to be exactly what `offsetsForNode` returns
 * for the `dff` type, because the converter anchors the SYMBOL origin so that
 * origin + offset lands on the Multisim pin — an offset that disagrees puts the
 * part a fixed distance away from every wire that should meet it.
 */
/**
 * The Multisim connection names for each kind, in the pin-offset order above.
 * Only the first two differ: the data input and the clock/enable.
 */
const FF_CONNS: Record<string, string[]> = {
  dff: ["D", "CLK", "SET", "RESET", "Q", "~Q"],
  tff: ["T", "CLK", "SET", "RESET", "Q", "~Q"],
  dlatch: ["D", "EN", "SET", "RESET", "Q", "~Q"],
};
const ffPins = (kind: string): { conn: string; off: Pt }[] =>
  FF_CONNS[kind].map((conn, i) => ({ conn, off: PIN_OFFSETS["Digital\\dflop"][i] }));

/**
 * Emit a D flip-flop.
 *
 * Multisim carries the trigger edge and the Set/Reset sense as model generics
 * rather than as different parts, so both are read off the instance and written
 * into the LibreSpice attribute; the LTSpice `dflop` symbol has nowhere to put
 * them. The converted part is ideal — the `*_delay` generics Multisim also
 * stores (1 ns rise, fall, clock, set and reset) have no equivalent and are
 * dropped, so a circuit that races on those delays will not behave as it did.
 *
 * Anchored on Q, the pin that exists on every flip-flop and that the following
 * stage is wired to.
 */
function emitDFlipFlop(part: MsPart, kind: string, ctx: Ctx): void {
  const { symbolLines, pinPos, used } = ctx;
  const name = uniqueName(part.refdes.prefix || "U", part.refdes.number, used);

  const p = part.params;
  const edge = p.Negative_Edge_Trigg_CLOCK === "1" ? "falling" : "rising";
  const asyncPol = p.ACTIVE_LOW_SET_and_RESET === "1" ? "low" : "high";

  const qLocal = part.pins["Q"];
  const qAbs: Pt = qLocal ? scaled(applyMatrix(part.matrix, qLocal), ctx.to) : [0, 0];
  const pins = ffPins(kind);
  const qOff = pins.find((x) => x.conn === "Q")!.off;
  const origin: Pt = [qAbs[0] - qOff[0], qAbs[1] - qOff[1]];

  symbolLines.push(`SYMBOL Digital\\dflop ${origin[0]} ${origin[1]} R0`);
  symbolLines.push(`SYMATTR InstName ${name}`);
  const mark = { dff: "DFF", tff: "TFF", dlatch: "DLATCH" }[kind] ?? "DFF";
  symbolLines.push(`SYMATTR Value ${kind === "dlatch" ? mark : mark + (edge === "falling" ? "-" : "+")}`);
  symbolLines.push(
    `SYMATTR LibreSpice kind=${kind};edge=${edge};async=${asyncPol};` +
    `vth=${LOGIC_THRESHOLD};vhigh=${LOGIC_HIGH};pins=${pins.map((x) => x.conn).join(",")}`,
  );

  // Multisim spells the complement "~Q" on some symbols and "Qneg" on others.
  for (const { conn, off } of pins) {
    const id = part.connPin[conn] ?? (conn === "~Q" ? part.connPin["Qneg"] : undefined);
    if (id !== undefined) pinPos[`${part.guid}/${id}`] = [origin[0] + off[0], origin[1] + off[1]];
  }
}

/**
 * Emit a digital constant or clock as an ordinary voltage source.
 *
 * Both have a single pin in Multisim and are implicitly referenced to ground, so
 * the source's negative terminal gets its own ground flag rather than being left
 * floating — which ngspice would reject as an open circuit.
 */
function emitDigitalSource(part: MsPart, kind: "constant" | "clock", ctx: Ctx): void {
  const { symbolLines, pinPos, flags, used } = ctx;
  const name = uniqueName(`V${part.refdes.prefix || "DG"}`, part.refdes.number, used);
  const p = part.params;

  let value: string;
  if (kind === "clock") {
    const freq = parseFloat(si(p.Frequency)) || 1000;
    const duty = (parseFloat(si(p.Duty)) || 50) / 100;
    const delay = si(p.Delay) || "0";
    const period = 1 / freq;
    value = `PULSE(0 ${LOGIC_HIGH} ${delay} 1n 1n ${(period * duty).toPrecision(6)} ${period.toPrecision(6)})`;
  } else {
    // A digital constant is a fixed level; anything non-zero is logic high.
    const lvl = si(p.Value ?? p.State ?? p.Level);
    value = String(lvl === "" || parseFloat(lvl) !== 0 ? LOGIC_HIGH : 0);
  }

  const conn = part.connNames[0] ?? "1";
  const local = part.pins[conn];
  const outAbs: Pt = local ? scaled(applyMatrix(part.matrix, local), ctx.to) : [0, 0];

  const VS = PIN_OFFSETS.voltage;
  const origin: Pt = [outAbs[0] - VS[0][0], outAbs[1] - VS[0][1]];
  symbolLines.push(`SYMBOL voltage ${origin[0]} ${origin[1]} R0`);
  symbolLines.push(`SYMATTR InstName ${name}`);
  symbolLines.push(`SYMATTR Value ${value}`);

  const minus: Pt = [origin[0] + VS[1][0], origin[1] + VS[1][1]];
  flags.push(`FLAG ${minus[0]} ${minus[1]} 0`);
  const id = part.connPin[conn];
  if (id !== undefined) pinPos[`${part.guid}/${id}`] = outAbs;
}

// ---------------------------------------------------------------------------
// Switches
// ---------------------------------------------------------------------------

/** Resistance standing in for a closed / open switch contact. */
export const R_CLOSED = "1n";
export const R_OPEN = "1G";

/**
 * Switches modelled as parameter resistors.
 *
 * `paths` lists the contacts as [from, to] connection names; each becomes one
 * resistor. `closed` names the contact the Multisim `State` selects (index into
 * `paths`), so the converted schematic starts in the position it was saved in.
 * `drop` are control pins with no counterpart in a resistor model.
 *
 * The voltage-controlled variants lose their control input entirely: a resistor
 * cannot follow a gate signal. They convert so the schematic is complete, but
 * their contacts become static — see the note this produces in the report.
 */
const SWITCHES: Record<string, SwitchSpec> = {
  SPST: { paths: [["1", "2"]], stateDrivesPath: false },
  // Pin 3 sits alone on one side of the symbol and is the common terminal;
  // connections "1" and "3" are the two throws.
  SPDT: { paths: [["2", "1"], ["2", "3"]], stateDrivesPath: true },
  "Transistor Switch": { paths: [["pos", "neg"]], drop: ["control"], stateDrivesPath: false },
  "Voltage Controlled SPST": { paths: [["inA", "outA"]], drop: ["ctrlp", "ctrln"], stateDrivesPath: false },
  "Voltage Controlled SPDT": {
    paths: [["inA", "outA1"], ["inA", "outA2"]], drop: ["ctrlp", "ctrln"], stateDrivesPath: true,
  },
};

/**
 * Replace a switch with one parameter resistor per contact.
 *
 * Each contact gets its own `.param`, so a contact is re-closed by editing that
 * one value rather than by touching the schematic. Where a switch has two
 * contacts they are emitted complementary — the position the circuit was saved
 * in closed, the other open.
 */
function emitSwitch(part: MsPart, spec: SwitchSpec, ctx: Ctx): string[] {
  const { symbolLines, directives, pinPos, used } = ctx;

  const base = uniqueName(`R${part.refdes.prefix || "S"}`, part.refdes.number, used);

  const state = parseInt(part.params.State ?? "0", 10) || 0;


  const RES = PIN_OFFSETS.res;
  const anchorConn = spec.paths[0][0];
  const anchorLocal = part.pins[anchorConn];
  const anchor: Pt = anchorLocal ? scaled(applyMatrix(part.matrix, anchorLocal), ctx.to) : [0, 0];

  const at = (conn: string, p: Pt) => { const id = part.connPin[conn]; if (id !== undefined) pinPos[`${part.guid}/${id}`] = p; };

  spec.paths.forEach(([from, to], i) => {
    // With two contacts, `State` picks which one is closed; a single contact is
    // simply open or closed as saved.
    const closed = spec.stateDrivesPath ? state === i : state === 1;
    const name = spec.paths.length > 1 ? `${base}${"ab"[i]}` : base;
    directives.push(`.param ${name}=${closed ? R_CLOSED : R_OPEN}`);

    // Contacts of a changeover switch share their first terminal, so set them
    // side by side and tie the shared ends together rather than stacking them.
    const origin: Pt = [anchor[0] - RES[0][0] + i * 96, anchor[1] - RES[0][1]];
    symbolLines.push(`SYMBOL res ${origin[0]} ${origin[1]} R0`);
    symbolLines.push(`SYMATTR InstName ${name}`);
    symbolLines.push(`SYMATTR Value {${name}}`);

    const top: Pt = [origin[0] + RES[0][0], origin[1] + RES[0][1]];
    const bottom: Pt = [origin[0] + RES[1][0], origin[1] + RES[1][1]];
    if (i === 0) at(from, top);
    else ctx.wires.push([anchor[0], anchor[1], top[0], top[1]]);
    at(to, bottom);
  });

  return spec.drop ?? [];
}

// ---------------------------------------------------------------------------
// Potentiometer
// ---------------------------------------------------------------------------

/**
 * Expand a potentiometer into the two series resistors SPICE needs.
 *
 * There is no pot primitive: the track becomes an upper and a lower resistor
 * meeting at the wiper. Driving both from one wiper-position parameter keeps
 * them summing to the track resistance, so the pot can still be swept from a
 * single `.param` — the point of the exercise sheets it appears on. The `+1n`
 * guard keeps either half from collapsing to a 0 Ω node at the end stops, which
 * ngspice rejects as a voltage-source loop.
 *
 * Names are derived from the pot's refdes because a schematic may hold several
 * pots, and one shared `T1`/`R0` would tie them all to the same position.
 */
function emitPotentiometer(part: MsPart, ctx: Ctx): void {
  const { symbolLines, directives, pinPos, used } = ctx;

  // A pot's refdes already carries an R prefix ("R4", "Rp"), so use it as is.
  const base = uniqueName(part.refdes.prefix || "Rp", part.refdes.number, used);

  const total = si(part.params.Res) || "1k";
  const pos = parseFloat(part.params.PosPercent ?? "50") / 100;

  const tName = `T_${base}`;
  const rName = `R_${base}`;
  const upper = `${base}a`;
  const lower = `${base}b`;
  directives.push(
    `.param ${tName}=${Number.isFinite(pos) ? pos : 0.5}`,
    `.param ${rName}=${total}`,
    `.param ${upper}=(1-${tName})*${rName}+1n`,
    `.param ${lower}=${tName}*${rName}+1n`,
  );

  // Stack the two halves along the track, anchored where the pot's first
  // terminal sat. They need not line up with the old wiring — the net-list
  // reconciliation below labels them onto the right nets either way.
  const svgPins = part.pinsById;
  const end1: Pt = svgPins["1"] ? scaled(applyMatrix(part.matrix, svgPins["1"]), ctx.to) : [0, 0];
  const RES = PIN_OFFSETS.res;
  const span = RES[1][1] - RES[0][1];
  const originA: Pt = [end1[0] - RES[0][0], end1[1] - RES[0][1]];
  const originB: Pt = [originA[0], originA[1] + span];

  symbolLines.push(`SYMBOL res ${originA[0]} ${originA[1]} R0`);
  symbolLines.push(`SYMATTR InstName ${upper}`);
  symbolLines.push(`SYMATTR Value {${upper}}`);
  symbolLines.push(`SYMBOL res ${originB[0]} ${originB[1]} R0`);
  symbolLines.push(`SYMATTR InstName ${lower}`);
  symbolLines.push(`SYMATTR Value {${lower}}`);

  // Terminal 1 → top of the upper half, wiper → the shared node, terminal 3 →
  // bottom of the lower half. Keyed by symbol pin id, as the net list is.
  const at = (conn: string, p: Pt) => { const id = part.connPin[conn]; if (id !== undefined) pinPos[`${part.guid}/${id}`] = p; };
  at("1", [originA[0] + RES[0][0], originA[1] + RES[0][1]]);
  at("2", [originB[0] + RES[0][0], originB[1] + RES[0][1]]);
  at("3", [originB[0] + RES[1][0], originB[1] + RES[1][1]]);
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/** Union-find over schematic points. */
class Union {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    while (this.parent.get(x) !== x) {
      this.parent.set(x, this.parent.get(this.parent.get(x)!)!);
      x = this.parent.get(x)!;
    }
    return x;
  }
  union(a: string, b: string): void {
    a = this.find(a); b = this.find(b);
    if (a !== b) this.parent.set(a, b);
  }
}

const key = (p: Pt) => `${p[0]},${p[1]}`;

/**
 * Which points the emitted wiring ties together.
 *
 * LTSpice joins two wires wherever they share a point — including a T, where one
 * wire's end touches another's interior — so a plain endpoint union would miss
 * the taps that make up most of these schematics.
 */
function wireGroups(wires: Wire[], points: Pt[]): Union {
  const uf = new Union();
  for (const [x1, y1, x2, y2] of wires) {
    uf.union(key([x1, y1]), key([x2, y2]));
    // Any point of interest sitting on this (axis-aligned) segment joins it too.
    for (const p of points) {
      const on = x1 === x2
        ? p[0] === x1 && p[1] >= Math.min(y1, y2) && p[1] <= Math.max(y1, y2)
        : y1 === y2 && p[1] === y1 && p[0] >= Math.min(x1, x2) && p[0] <= Math.max(x1, x2);
      if (on) uf.union(key(p), key([x1, y1]));
    }
  }
  return uf;
}

/**
 * Length of the stub between a component pin and a net label placed on it — one
 * visible grid square.
 *
 * The editor no longer leaves a lead of its own (a name is an anchor and simply
 * sits on the pin), but a converted file still gets one: it is written for
 * LTSpice as much as for us, and there a flag on a pin with no wire between them
 * reads as a terminal rather than a labelled net.
 */
const LEAD = 16;
/**
 * Shortest a lead may be shrunk to when the preferred one is blocked: 0.3 cm at
 * the editor's 96 dpi, rounded up to LTSpice's 4-unit grid. Below this the
 * connector's tag sits on whatever it connects to — two of them on one point
 * draw on top of each other.
 */
const MIN_LEAD = 12;

/**
 * Which way a lead should point to get *out* of the part, or null when there is
 * no sensible direction.
 *
 * Taken from the pin's position relative to the centre of its own part's pins,
 * which the `guid/pinid` key makes available without threading a direction
 * through every emitter. The dominant axis wins, so the stub stays orthogonal.
 * A one-pin part (a ground connector) has no such centre and gets no lead.
 */
function leadDirection(pinKey: string, pinPos: PinPos): Pt | null {
  const prefix = pinKey.slice(0, pinKey.lastIndexOf("/") + 1);
  const siblings = Object.entries(pinPos).filter(([k]) => k.startsWith(prefix)).map(([, p]) => p);
  if (siblings.length < 2) return null;
  const p = pinPos[pinKey];
  const cx = siblings.reduce((s, q) => s + q[0], 0) / siblings.length;
  const cy = siblings.reduce((s, q) => s + q[1], 0) / siblings.length;
  const dx = p[0] - cx, dy = p[1] - cy;
  if (dx === 0 && dy === 0) return null;
  return Math.abs(dx) >= Math.abs(dy) ? [Math.sign(dx), 0] : [0, Math.sign(dy)];
}

/**
 * Where a label's lead should end, or null when nothing is free.
 *
 * The preferred spot is `LEAD` out along the pin's own axis. If that is taken
 * the length is varied (never below {@link MIN_LEAD}) and then the other three
 * directions are tried, so a crowded pin still gets a real stub instead of the
 * label dropping back onto the terminal.
 */
function leadTip(p: Pt, dir: Pt | null, pinPos: PinPos, wires: Wire[], placed: Pt[]): Pt | null {
  if (!dir) return null;
  const free = (q: Pt) => !occupied(q, pinPos, wires) && !placed.some((r) => r[0] === q[0] && r[1] === q[1]);
  const dirs: Pt[] = [dir, [-dir[0], -dir[1]], [dir[1], dir[0]], [-dir[1], -dir[0]]];
  for (const d of dirs) {
    for (let len = LEAD; len >= MIN_LEAD; len -= 4) {
      const q: Pt = [p[0] + d[0] * len, p[1] + d[1] * len];
      if (free(q)) return q;
    }
    for (let len = LEAD + 4; len <= LEAD + 32; len += 4) {
      const q: Pt = [p[0] + d[0] * len, p[1] + d[1] * len];
      if (free(q)) return q;
    }
  }
  return null;
}

/** True when a point already carries a pin or lies anywhere on a wire. */
function occupied(p: Pt, pinPos: PinPos, wires: Wire[]): boolean {
  for (const q of Object.values(pinPos)) if (q[0] === p[0] && q[1] === p[1]) return true;
  for (const [x1, y1, x2, y2] of wires) {
    const on = x1 === x2
      ? p[0] === x1 && p[1] >= Math.min(y1, y2) && p[1] <= Math.max(y1, y2)
      : y1 === y2 && p[1] === y1 && p[0] >= Math.min(x1, x2) && p[0] <= Math.max(x1, x2);
    if (on) return true;
  }
  return false;
}

/**
 * Add net labels wherever the drawn geometry leaves one Multisim net split
 * across several disconnected islands. Returns the FLAG lines to append.
 *
 * A label is set one grid square off its pin and joined to it by a short wire,
 * rather than placed on the pin itself. On the pin the tag covers the terminal
 * and reads as part of the symbol — and since it is a component of its own, it
 * can then be dragged away from a part it looked welded to. The stub makes the
 * connection something the schematic actually shows. Any lead that would land on
 * another pin or on an existing wire is dropped back onto the pin, since a stub
 * into an occupied point would invent a connection Multisim never had.
 */
function reconcile(netList: MsNet[], pinPos: PinPos, wires: Wire[], existingFlags: string[]): string[] {
  // Ground already has FLAGs from the connector symbols; take their points into
  // account so a grounded pin isn't labelled a second time under another name.
  const flagPts: Pt[] = [];
  for (const f of existingFlags) {
    const m = /^FLAG (-?\d+) (-?\d+)/.exec(f);
    if (m) flagPts.push([Number(m[1]), Number(m[2])]);
  }

  const allPts = [...Object.values(pinPos), ...flagPts];
  const uf = wireGroups(wires, allPts);

  const out: string[] = [];
  // Label points already handed out, so two labels never land on one another.
  const placed: Pt[] = [...flagPts];
  for (const net of netList) {
    const pts: { p: Pt; key: string }[] = [];
    for (const obj of net.pins) {
      const k = `${obj.component}/${obj.pin}`;
      const p = pinPos[k];
      if (p) pts.push({ p, key: k });
    }
    if (pts.length < 2) continue;

    // Multisim's node 0 is ground; LTSpice spells that label "0" as well.
    const netName = net.name ?? "";
    const name = /^\d+$/.test(netName) ? (netName === "0" ? "0" : `N${netName}`) : netName;

    const islands = new Map<string, { p: Pt; key: string }>();
    for (const it of pts) {
      const root = uf.find(key(it.p));
      if (!islands.has(root)) islands.set(root, it);
    }
    // One island means the wires already join every pin on this net.
    if (islands.size < 2) continue;
    for (const { p, key: pinKey } of islands.values()) {
      const tip = leadTip(p, leadDirection(pinKey, pinPos), pinPos, wires, placed);
      if (tip) {
        wires.push([p[0], p[1], tip[0], tip[1]]);
        placed.push(tip);
        out.push(`FLAG ${tip[0]} ${tip[1]} ${name}`);
      } else {
        placed.push(p);
        out.push(`FLAG ${p[0]} ${p[1]} ${name}`);
      }
    }
  }
  return out;
}

/**
 * Drop wire segments that cross another wire at a point Multisim did not mark
 * as a junction.
 *
 * Multisim records connections explicitly, so two of its wires may cross while
 * staying separate nets. LTSpice has no such notion — wires meeting at a point
 * are one node — and carrying such a crossing over verbatim shorts the two nets.
 * Removing the segment leaves its net split, which the net-list reconciliation
 * then rejoins with a label; a label connects by name and cannot cross anything.
 */
function cutCrossings(wires: Wire[], junctions: Pt[]): Wire[] {
  const marked = new Set(junctions.map((p) => key(p)));
  const drop = new Set<number>();

  for (let i = 0; i < wires.length; i++) {
    for (let k = i + 1; k < wires.length; k++) {
      if (drop.has(i) || drop.has(k)) continue;
      const a = wires[i], b = wires[k];
      const aVert = a[0] === a[2], bVert = b[0] === b[2];
      if (aVert === bVert) continue;
      const [v, h, hIdx] = aVert ? [a, b, k] : [b, a, i];
      const x = v[0], y = h[1];
      const onV = y >= Math.min(v[1], v[3]) && y <= Math.max(v[1], v[3]);
      const onH = x >= Math.min(h[0], h[2]) && x <= Math.max(h[0], h[2]);
      if (!onV || !onH || marked.has(key([x, y]))) continue;
      // A shared endpoint is a corner of one routed path, not a crossing.
      const ends = [[v[0], v[1]], [v[2], v[3]], [h[0], h[1]], [h[2], h[3]]]
        .filter((p) => p[0] === x && p[1] === y).length;
      if (ends >= 2) continue;
      drop.add(hIdx);
    }
  }
  return wires.filter((_, i) => !drop.has(i));
}

/**
 * Report Multisim nets that the emitted schematic has shorted together.
 *
 * Multisim marks a connection with an explicit junction, so two of its wires may
 * cross without touching. LTSpice has no such notion — wires sharing a point are
 * one node — so a crossing that was harmless in the original becomes a short
 * here. This is the one error the drawing can introduce that a reader is
 * unlikely to spot, so it is checked rather than assumed.
 */
function findShorts(netList: MsNet[], pinPos: PinPos, wires: Wire[], flags: string[]): string[] {
  const pts = Object.values(pinPos);
  const uf = wireGroups(wires, pts);
  for (const f of flags) {
    const m = /^FLAG (-?\d+) (-?\d+) (.+)/.exec(f);
    if (m) uf.union(key([Number(m[1]), Number(m[2])]), `label:${m[3].trim()}`);
  }

  // Which Multisim net each group ended up carrying; a group holding two is a
  // short between them.
  const groupNet = new Map<string, string>();
  const shorts = new Set<string>();
  for (const net of netList) {
    for (const obj of net.pins) {
      const p = pinPos[`${obj.component}/${obj.pin}`];
      if (!p) continue;
      const root = uf.find(key(p));
      const prev = groupNet.get(root);
      const nm = net.name ?? "";
      if (prev === undefined) groupNet.set(root, nm);
      else if (prev !== nm) shorts.add([prev, nm].sort().join(" = "));
    }
  }
  return [...shorts];
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export function convert(sch: MsSchematic): ConversionResult {
  const skipped: string[] = [];
  /** Parts replaced by a stand-in rather than converted one-to-one. */
  const substituted: string[] = [];

  const wires: Wire[] = [];
  const flags: string[] = [];
  const symbolLines: string[] = [];
  /** SPICE directives the conversion itself needs (pot parameters, …). */
  const directives: string[] = [];
  /** `<part guid>/<conn name>` → the pin's final LTSpice position. */
  const pinPos: PinPos = {};

  const to = (v: number) => Math.round(v * GRID);

  // Reserve every refdes Multisim spelled out, so auto-numbering cannot take a
  // name a later part already claims.
  const used = new Set<string>();
  for (const part of sch.parts) {
    const name = part.typeName;
    const num = part.refdes.number;
    if (num === null || num === undefined) continue;
    const prefix = TYPES[name]?.forcePrefix
      || (SWITCHES[name] || name === "Potentiometer" ? "R" : null)
      || (name === "Digital Constant" || name === "Digital Clock" ? `V${part.refdes.prefix ?? "DG"}` : null)
      || part.refdes.prefix || TYPES[name]?.prefix;
    if (prefix) used.add(`${prefix}${num}`);
  }

  // --- placed parts -------------------------------------------------------
  for (const part of sch.parts) {
    const bp = { name: part.typeName };

    const ctx: Ctx = { symbolLines, flags, directives, pinPos, used, wires, to };

    if (bp.name === "Potentiometer") {
      emitPotentiometer(part, ctx);
      continue;
    }

    if (GATES[bp.name]) {
      emitGate(part, GATES[bp.name], ctx);
      substituted.push(`${bp.name} (ideales Gatter, ohne Laufzeit)`);
      continue;
    }

    // The T flip-flop and the D latch are the same storage cell wired
    // differently, so they share the emitter; `kind` picks the variant and the
    // pin names that go with it.
    const FF_KINDS: Record<string, string> = {
      "D Flip-Flop": "dff", "T Flip-flop": "tff", "D Latch": "dlatch",
    };
    if (FF_KINDS[bp.name]) {
      const kind = FF_KINDS[bp.name];
      emitDFlipFlop(part, kind, ctx);
      substituted.push(`${bp.name} (${kind === "dlatch" ? "ideales Latch" : "ideales Flipflop"}, ohne Laufzeit)`);
      continue;
    }

    if (bp.name === "Digital Constant" || bp.name === "Digital Clock") {
      emitDigitalSource(part, bp.name === "Digital Clock" ? "clock" : "constant", ctx);
      substituted.push(`${bp.name} (als Spannungsquelle)`);
      continue;
    }

    if (SWITCHES[bp.name]) {
      const dropped = emitSwitch(part, SWITCHES[bp.name], ctx);
      if (dropped.length) substituted.push(`${bp.name} (Steuereingang ${dropped.join("/")} entfällt)`);
      else substituted.push(bp.name);
      continue;
    }

    const type = TYPES[bp.name];
    if (!type) {
      skipped.push(bp.name);
      continue;
    }
    const offsets = PIN_OFFSETS[type.sym] ?? [];

    // Prefer the IEC artwork when Multisim used it — these are German teaching
    // schematics and the box resistor is what the source drawings show.
    const isIec = /:IEC:/.test(part.symbolDescription);
    const symName = isIec && type.euro ? type.euro : type.sym;
    const useOffsets = PIN_OFFSETS[symName] ?? offsets;

    // Where each pin sits on the Multisim sheet, in LTSpice coordinates.
    const want: (Pt | null)[] = [];
    for (let i = 0; i < type.pins.length; i++) {
      const conn = type.pins[i];
      const local = conn === null ? undefined : part.pins[conn];
      want.push(local ? scaled(applyMatrix(part.matrix, local), to) : null);
    }
    const anchorIdx = want.findIndex((p) => p !== null);
    if (anchorIdx === -1) { skipped.push(bp.name); continue; }

    const { deg, mirrored, str, origin } = fitOrientation(useOffsets, want, anchorIdx);
    symbolLines.push(`SYMBOL ${symName} ${origin[0]} ${origin[1]} ${str}`);

    // Refdes: Multisim leaves the number null on single-instance designs, so
    // number those ourselves per prefix rather than emitting a bare "R".
    const prefix = type.forcePrefix || part.refdes.prefix || type.prefix;
    symbolLines.push(`SYMATTR InstName ${uniqueName(prefix, part.refdes.number, used)}`);

    // Ratings can sit on either level — a lamp keeps its voltage and power in
    // `modeldefinitiondata` while a resistor keeps its value in
    // `modelinstancedata`. Instance data wins where both carry a key.
    const flat = part.params;
    const value = type.value(flat);
    if (value) symbolLines.push(`SYMATTR Value ${value}`);
    for (const a of type.attrs ?? []) symbolLines.push(`SYMATTR ${a}`);

    // Where LTSpice's pin spacing differs from Multisim's, the Multisim wire
    // still ends at the original point — bridge the gap with a stub so the net
    // stays connected instead of silently breaking.
    // Every pin of this part, so a stub can be told which way leads *out* of the
    // symbol (see outwardAxis) rather than along its flank.
    const pinPts: Pt[] = useOffsets
      .map((o) => (o ? rotate(o, deg, mirrored) : null))
      .filter((r): r is Pt => r !== null)
      .map((r) => [origin[0] + r[0], origin[1] + r[1]]);

    for (let i = 0; i < want.length; i++) {
      if (!useOffsets[i]) continue;
      const r = rotate(useOffsets[i], deg, mirrored);
      const ax = origin[0] + r[0];
      const ay = origin[1] + r[1];
      // The net list identifies a pin by its *symbol* pin id, which is not the
      // connection name — Multisim's stock parts routinely map conn "1" to
      // symbol pin "2". Keying these by connection name silently tied each part
      // to the wrong net.
      const conn = type.pins[i];
      const pid = conn === null ? undefined : part.connPin[conn];
      if (pid !== undefined) pinPos[`${part.guid}/${pid}`] = [ax, ay];
      const target = want[i];
      if (!target) continue;
      if (ax !== target[0] || ay !== target[1]) {
        // Route the stub as an L so it stays on the orthogonal grid rather than
        // cutting diagonally across the sheet — leading with the axis the pin
        // faces, so it leaves the symbol squarely. Led with a fixed horizontal
        // leg, the supply stubs of an op-amp (whose pins face up and down) ran
        // sideways along the top and bottom edges and then down the flank,
        // straight across both inputs.
        const dir = outwardDir({ x: ax, y: ay }, pinPts.map(([x, y]) => ({ x, y })));
        const alongFlank = dir && (dir.x !== 0 ? ax === target[0] : ay === target[1]);
        if (alongFlank) {
          // The Multisim point lies straight off the *side* of the pin, so an L
          // has no corner to place and the whole stub would run flush against
          // the symbol's edge. Step out perpendicular first, then come back:
          // a small jog, but the wire visibly leaves the part.
          const mx = ax + dir!.x * LEAD, my = ay + dir!.y * LEAD;
          wires.push([ax, ay, mx, my]);
          if (dir!.x !== 0) {
            wires.push([mx, my, mx, target[1]]);
            wires.push([mx, target[1], target[0], target[1]]);
          } else {
            wires.push([mx, my, target[0], my]);
            wires.push([target[0], my, target[0], target[1]]);
          }
        } else if (dir?.y) {
          wires.push([ax, ay, ax, target[1]]);
          wires.push([ax, target[1], target[0], target[1]]);
        } else {
          wires.push([ax, ay, target[0], ay]);
          wires.push([target[0], ay, target[0], target[1]]);
        }
      }
    }
  }

  // --- ground and other connectors ---------------------------------------
  for (const c of sch.connectors) {
    if (c.kind === "ground") {
      const [x, y] = applyMatrix(c.matrix, [0, 0]);
      flags.push(`FLAG ${to(x)} ${to(y)} 0`);
      // Ground appears in the net list like any other pin, so record it.
      pinPos[`${c.guid}/1`] = [to(x), to(y)];
    } else {
      // A plain connector is Multisim's net label: it names the node it sits on
      // and joins every other connector carrying that name. Registering its
      // position is what makes those joins survive — the reconciliation below
      // then emits the matching LTSpice FLAGs.
      const [x, y] = applyMatrix(c.matrix, [0, 0]);
      pinPos[`${c.guid}/1`] = [to(x), to(y)];
    }
  }

  // --- wires --------------------------------------------------------------
  for (const w of sch.wires) {
    const path = w.path;
    for (let i = 0; i + 1 < path.length; i++) {
      wires.push([to(path[i][0]), to(path[i][1]), to(path[i + 1][0]), to(path[i + 1][1])]);
    }
  }

  // --- close gaps against the authoritative net list ----------------------
  // `doc.nets` is what Multisim actually simulated, and it is not always
  // reproduced by the drawing: parts whose pins abut directly carry no wire at
  // all, and the two tools' pin spacings don't always leave a stub that lands on
  // one. Rather than guess at extra routing, reconcile geometry against the net
  // list and bridge whatever is still split with an LTSpice net label — which
  // connects by name and so cannot introduce a false crossing.
  const routed = cutCrossings(wires, sch.junctions.map((j): Pt => [to(j[0]), to(j[1])]));
  wires.length = 0;
  wires.push(...routed);
  flags.push(...reconcile(sch.nets, pinPos, wires, flags));

  // --- free-standing text -------------------------------------------------
  const texts: string[] = [];
  for (const t of sch.texts) {
    // LTSpice keeps a comment on one line; Multisim's free text is multi-line.
    const body = t.text.split("\n").map((l) => l.trim()).filter(Boolean).join(" \\n ");
    texts.push(`TEXT ${to(t.position[0])} ${to(t.position[1])} Left 2 ;${body}`);
  }

  // L-routed stubs collapse to a zero-length segment whenever only one axis
  // differed, and Multisim paths can repeat a segment; neither adds anything.
  const seen = new Set();
  const cleanWires = wires.filter(([x1, y1, x2, y2]) => {
    if (x1 === x2 && y1 === y2) return false;
    const key = [[x1, y1], [x2, y2]].sort().join();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Directives go under the schematic, stacked so they don't overlap.
  const tran = tranDirective(symbolLines);
  if (tran) directives.push(tran);
  const dirY = Math.max(0, ...Object.values(pinPos).map((p) => p[1])) + 64;
  const directiveLines = directives.map((d, i) => `TEXT 64 ${dirY + i * 32} Left 2 !${d}`);

  const lines = [
    "Version 4",
    "SHEET 1 880 680",
    ...cleanWires.map((w) => `WIRE ${w[0]} ${w[1]} ${w[2]} ${w[3]}`),
    ...flags,
    ...symbolLines,
    ...directiveLines,
    ...texts,
  ];
  return {
    asc: lines.join("\n") + "\n",
    skipped: [...new Set(skipped)],
    substituted: [...new Set(substituted)],
    shorts: findShorts(sch.nets, pinPos, cleanWires, flags),
  };
}
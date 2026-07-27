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
 *    cross while staying separate nets. LTSpice has no such notion: wires sharing
 *    a point are one node. So the wiring is not carried over at all but drawn
 *    fresh between our own pins, from the net list — see router.ts.
 *
 * The document is external, untyped JSON, so `any` is the honest type wherever
 * it is touched.
 *
 * The CLI wrapper (scripts/convert-multisim.mjs) adds file I/O and the batch
 * report; both it and the in-app importer share this module so they cannot
 * drift apart.
 */

import { routeNets, type RouteReport } from "./router.js";
import { parseSI } from "../components/base/componentValue.js";
// The gate's pin table, so the converter cannot drift from the one the parser
// and the canvas share (see gatePinOffsets).
import { CENTER } from "../ltspice/ltspiceGeometry.js";

/**
 * Normalise a Multisim value for SPICE (µ → u, M → Meg, strip blanks).
 *
 * The `M` is the one that bites. Multisim writes a megohm `1M` and a milliohm
 * `100 m`, telling them apart by case; SPICE is case-insensitive and reads both
 * as milli, so `1M` arrives as a thousandth of an ohm — nine orders of magnitude
 * out, in the direction that turns an open circuit into a short.
 *
 * It stayed hidden because the two ways a value reaches the netlist do not agree.
 * A `SYMATTR Value` is read back by `parseSI`, which already knows a lone `M` is
 * mega, so the 180 megohm resistors in the bundled files were always right. A
 * `SYMATTR SpiceLine` is passed through *verbatim* — and that is where a switch
 * keeps its open-contact resistance. Every converted voltage-controlled switch
 * therefore had `Roff=1M`, i.e. a milliohm, and stood permanently closed: the
 * `Tiefsetzsteller` chopped nothing and delivered its input voltage straight
 * through to the load, with no error anywhere.
 *
 * Only an `M` that ends a number is touched, and never the `M` of `Meg`.
 */
function si(v: unknown): string {
  if (v === undefined || v === null || v === "") return "";
  return String(v).replace(/[μµ]/g, "u").replace(/(\d)M(?![eE])\b/g, "$1Meg").trim();
}

/** A Multisim number as a plain one; NaN where there is no number to read. */
const siNum = (s: string): number => parseSI(s ?? "") ?? NaN;

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
  /**
   * `SYMATTR SpiceLine` for this instance — the trailing `name=value` list on
   * the `X` line of a `.subckt` declared with `params:`. Unlike `attrs` it is
   * built from the part's own parameters, because that is the point: the
   * potentiometer's track resistance and wiper position differ per instance.
   */
  spiceLine?: (p: Params) => string;
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
  /**
   * Wiring an emitter draws itself, which is only the switch stand-in tying its
   * contacts together. Everything between *parts* is the router's (see router.ts).
   */
  wires: Wire[];
  /**
   * Every terminal any emitter has placed, whether or not Multisim names it.
   *
   * `pinPos` cannot serve here: it is keyed by Multisim's own pin ids and so
   * skips a terminal the file's `connPin` does not mention — and the pruning
   * below has to know about *all* of them, or it lays a route across one and
   * welds two nets together. Filled as the parts are drawn, because the alternative
   * (reading the emitted SYMBOL lines back) cannot work for the gates, whose
   * offsets depend on their input count.
   */
  terminals: Pt[];
  /**
   * Every instance placed, so the conversion can say afterwards which of them the
   * *original* leaves with fewer than two nodes (see `unconnected`).
   */
  instances: Instance[];
  /**
   * The digital sources' invented grounds, as indices into `symbolLines` and
   * `flags` plus the output pin the symbol hangs from (see `seatDigitalGrounds`).
   */
  grounds: { symbol: number; flag: number; out: Pt }[];
  to: (v: number) => number;
}

/**
 * A placed instance, and what it takes to tell whether it can have two nodes.
 *
 * `extraNodes` counts terminals this conversion invented and wired itself — the
 * digital source's implied ground is one. They are nodes the Multisim net list
 * knows nothing about, so they have to be added by hand.
 */
interface Instance { name: string; guid: string; extraNodes: number }

export interface ConversionResult {
  /** The LTSpice schematic. */
  asc: string;
  /** Multisim part names with no LibreSpice equivalent; these were left out. */
  skipped: string[];
  /** Parts converted via a stand-in (switches, potentiometers). */
  substituted: string[];
  /** Multisim nets the emitted drawing shorted together. */
  shorts: string[];
  /** What the router managed to draw, and what it had to leave to a name. */
  route: RouteReport;
  /**
   * Instances the original leaves with fewer than two nodes, by their emitted
   * name — the parts of a task sheet the student is meant to wire up.
   *
   * These are not converted badly, they are converted faithfully: there is no
   * connection in the file to draw. It has to be *reported*, because the symptom
   * looks like a conversion fault from the outside — every terminal of such a part
   * lands on node 0, and a source with both terminals there is one ngspice refuses
   * to start on. Without this list the two are indistinguishable.
   */
  unconnected: string[];
  /**
   * Connections a part type declares that the placed part does not have.
   *
   * A name that misses yields no pin, so the wiring on it is dropped without a
   * word — which is how thirteen op-amps came to have both supply rails left off
   * and their output pinned to 0 V. Reported rather than assumed correct: the
   * mapping is a table of names typed by hand against a format that spells them
   * its own way (`VS+`, not `V+`).
   */
  unmapped: string[];
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

  // The behavioural sources: the same two symbols, with an expression where a
  // waveform would be. `V = …` in the Value is what makes the source a `B`
  // device on the way to the netlist (see Sources.ts) — and it has to be forced
  // to a `B` refdes too, or ngspice reads the leading V as a plain source and
  // rejects the expression.
  "Behavioral Voltage Source": {
    sym: "voltage", prefix: "V", forcePrefix: "B", pins: ["1", "2"],
    value: (p) => `V = ${p.Expression ?? "0"}`,
  },
  "Behavioral Current Source": {
    sym: "current", prefix: "I", forcePrefix: "B", pins: ["1", "2"],
    value: (p) => `I = ${p.Expression ?? "0"}`,
  },

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

  // Multisim's 3-terminal op-amp has no supply pins, and so has ours: the ideal
  // three-terminal part (library/sub/opamp.lib), which both formats have.
  //
  // It used to map onto the 5-terminal UniversalOpAmp2 with the supply pins left
  // unconnected, and that is not a small inaccuracy — `Rvp`/`Rvn` tie an open
  // rail to ground, so the output clamp became min(max(ng,0),0) and every
  // converted 3-terminal op-amp sat at 0 V whatever its input did. A voltage
  // follower on 2.5 V put out 0.25 uV.
  "3 Terminal Opamp": {
    sym: "opamp", prefix: "U", forcePrefix: "X", pins: ["IN+", "IN-", "OUT"],
    value: () => "", attrs: ["Prefix X", "SpiceModel opamp"],
  },
  // No `Value`: for a symbol the editor knows, a Value *is* the model name, and
  // `UniversalOpAmp2` is the symbol's name, not the subcircuit's — that is
  // `level2`. Written out, every converted op-amp asked ngspice for a subcircuit
  // that does not exist ("unknown subckt: universalopamp2") and the sheet did not
  // start at all. Left out, the part keeps its default model, which is how the
  // hand-drawn examples have always done it.
  //
  // Multisim spells the supply connections `VS+`/`VS-`, not `V+`/`V-` — the
  // INA333 below had it right, this one did not, and a name that does not exist
  // on the part yields no pin at all. Both rails were then left off the symbol,
  // so the supply nets never reached it and the model saw 0 V on each: the
  // output clamp became min(max(ng,0),0) and the part sat at 0 V. 13 op-amps
  // across the bundled schematics were in that state (see `unmapped` below,
  // which is there so this cannot be silent again).
  "5 Terminal Opamp": { sym: "UniversalOpAmp2", prefix: "U", pins: ["IN+", "IN-", "VS+", "VS-", "OUT"], value: () => "" },
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

  // Multisim's "Digital Hexadecimal 7-Segment Display" is decoder and display in
  // one: four binary inputs, no segment pins. `GND`/`VCC` are listed but never
  // placed, so they are left out here as they are on every other digital part.
  //
  // Until now it was skipped outright, which is why four schematics had counter
  // outputs running into nothing — and in the Dual-Slope ADC a node that only a
  // gate reads and nothing drives, which ngspice answers with "singular matrix".
  "Digital Hexadecimal 7-Segment Display": {
    sym: "seg7hex", prefix: "U", forcePrefix: "X", pins: ["1", "2", "3", "4"],
    value: () => "seg7hex", attrs: ["Prefix X", "SpiceModel seg7hex"],
  },

  // The 74LS138, as a library part: the decoder as B-sources, in
  // library/sub/74LS138.lib. `GND`/`VCC` are shared by the whole package and
  // drawn on no section, so they arrive without a position and are left out like
  // every other digital part's supplies. Multisim spells the two active-low
  // enables with the bar in the name.
  "74LS138": {
    sym: "74LS138", prefix: "U", forcePrefix: "X",
    pins: ["A", "B", "C", "G1", "~G2A", "~G2B", "Y0", "Y1", "Y2", "Y3", "Y4", "Y5", "Y6", "Y7"],
    value: () => "", attrs: ["Prefix X", "SpiceModel 74LS138"],
  },

  // The 74LS139: the 138's smaller twin, and one *half* of the real package —
  // Multisim places a section at a time, so what is on the sheet is a 1-of-4
  // decoder with its own enable (library/sub/74LS139.lib). Two sections on a
  // sheet are two instances, which is electrically what they are.
  //
  // Both spellings, because the Live format names it after the ordering code and
  // the 14 format after the type; the entry is the same either way.
  ...Object.fromEntries(["74LS139", "74LS139D"].map((n) => [n, {
    sym: "74LS139", prefix: "U", forcePrefix: "X",
    pins: ["A", "B", "~G", "Y0", "Y1", "Y2", "Y3"],
    value: () => "", attrs: ["Prefix X", "SpiceModel 74LS139"],
  }])),

  // Multisim's thermal-noise source: a resistor whose *noise* is the point. It
  // states the resistance, the temperature and the bandwidth, and the RMS that
  // follows from them is Johnson noise, sqrt(4kTRB) — 129 nV for the 1 kΩ at
  // 27 °C over 1 kHz in the Wien oscillator here.
  //
  // It converts to the resistor it is. That is right for the operating point and
  // right for a `.noise` run, where ngspice models a resistor's thermal noise
  // itself — but *not* for a transient, which ngspice computes noiselessly. In
  // the Wien oscillator that matters: the noise is what kicks the loop into
  // oscillation, so the converted sheet sits at its operating point instead of
  // swinging. Said out loud in the report rather than papered over.
  //
  // A behavioural source over `trrandom(2, …)` would model it properly and was
  // tried; this ngspice build has no such function and stops with a fatal error.
  "Thermal Noise": {
    sym: "res", euro: "Misc\\EuropeanResistor", prefix: "R", forcePrefix: "R",
    pins: ["1", "2"], value: (p) => si(p.Resistance) || "1k",
  },

  // The bare seven-segment display — decoder and display are two parts here,
  // unlike the `seg7hex` above which is both in one. Seven LEDs on a shared
  // anode (library/sub/seg7a.lib), so the segment lines are active low.
  "7-Segment Display Common Anode": {
    sym: "seg7a", prefix: "U", forcePrefix: "X",
    pins: ["A", "B", "C", "D", "E", "F", "G", "COM"],
    value: () => "seg7a", attrs: ["Prefix X", "SpiceModel seg7a"],
  },

  // The wattmeter, the one virtual instrument that has to stay a part: it lies
  // across the load *and* in series with it, so leaving it out breaks the branch
  // its current path carries (library/sub/wattmeter.lib). Multisim numbers its
  // four connections; the pairs are 1/2 across and 3/4 through.
  Wattmeter: {
    sym: "wattmeter", prefix: "XWM", forcePrefix: "X", pins: ["1", "2", "3", "4"],
    value: () => "wattmeter", attrs: ["Prefix X", "SpiceModel wattmeter"],
  },

  // The transformer, as the ideal two-port its own netlist describes: the turns
  // ratio and nothing else carried over (library/sub/xfmr.lib). Multisim states
  // the two winding counts, and `ratio` is what they come to.
  Transformer: {
    sym: "xfmr", prefix: "T", forcePrefix: "X",
    pins: ["p1pos", "p1neg", "s1pos", "s1neg"],
    value: () => "xfmr", attrs: ["Prefix X", "SpiceModel xfmr"],
    spiceLine: (p) => {
      const n = (k: string, d: string) => si(p[k]) || d;
      return `ratio=${n("Ratio", "1")} Lm=${n("Lm", "50u")} Rp=${n("Rp", "10m")} Rs=${n("Rs", "10m")}`;
    },
  },

  // The switches, as parts rather than as a pair of parameter resistors.
  //
  // Same story as the potentiometer: two resistor bodies took roughly three
  // times the room of the part they replaced. The two voltage-controlled ones
  // gain more than room — a resistor cannot follow a gate signal, so their
  // control input used to be dropped outright and the contacts went static.
  // Their models keep it (library/sub/vcspst.lib, vcspdt.lib).
  //
  // `State` says which way a manual switch was saved; for the changeover it
  // picks the throw, and `pos` is exactly that index. The rest position is the
  // first path in Multisim's own order, which is our NC.
  SPST: {
    sym: "spst", prefix: "S", forcePrefix: "X", pins: ["1", "2"],
    value: () => "spst", attrs: ["Prefix X", "SpiceModel spst"],
    spiceLine: (p) => `pos=${manualSwitchClosed(p) ? 1 : 0}${switchContacts(p)}`,
  },
  // The changeover keeps the plain reading: with no state recorded it rests on
  // NC, and unlike the make-contact above it conducts *somewhere* either way, so
  // an unknown position never leaves the sheet dead.
  SPDT: {
    sym: "spdt", prefix: "S", forcePrefix: "X", pins: ["2", "1", "3"],
    value: () => "spdt", attrs: ["Prefix X", "SpiceModel spdt"],
    spiceLine: (p) => `pos=${(parseInt(p.State ?? "0", 10) || 0) === 1 ? 1 : 0}${switchContacts(p)}`,
  },
  // The dependent source SPICE has as a primitive (`E`), wrapped in a `.subckt`
  // so it can be a part with named pins like everything else. Multisim numbers
  // its four connections and its template says which is which:
  // `e%p %t4 %t3 %t2 %t1 #1` — the right-hand pair is the output, the left the
  // control, and slot 1 is the gain.
  "Voltage Controlled Voltage Source": {
    sym: "vcvs", prefix: "E", forcePrefix: "X", pins: ["4", "3", "2", "1"],
    value: () => "vcvs", attrs: ["Prefix X", "SpiceModel vcvs"],
    spiceLine: (p) => `Gain=${si(p.Gain) || "1"}`,
  },

  // The DIP switch pack: four independent make-contacts in one housing, and one
  // placed part with eight pins (library/sub/dipsw4.lib). Opposite pins belong
  // to the same switch, which is the real package's numbering.
  "DIP Switch 4": {
    sym: "dipsw4", prefix: "S", forcePrefix: "X",
    pins: ["1", "2", "3", "4", "5", "6", "7", "8"],
    value: () => "dipsw4", attrs: ["Prefix X", "SpiceModel dipsw4"],
    spiceLine: () => "pos1=0 pos2=0 pos3=0 pos4=0",
  },

  // A transistor used as a switch, with the body diode that makes a switching
  // converter computable at all (library/sub/transw.lib). Unlike the Live
  // format's plain "Transistor Switch" — still a parameter resistor below — this
  // one keeps its control input, which for a part whose whole job is chopping is
  // the difference between the circuit working and doing nothing.
  //
  // The control is single-ended against ground, exactly as Multisim's own
  // subcircuit has it (`s1 upper lower_ ctrlp 0`).
  "Transistor Switch with Diode": {
    sym: "transw", prefix: "S", forcePrefix: "X", pins: ["pos", "neg", "control"],
    value: () => "transw", attrs: ["Prefix X", "SpiceModel transw"],
    spiceLine: (p) => {
      const n = (k: string, d: string) => si(p[k]) || d;
      return `Von=${n("CtrlOn", "5")} Voff=0 Ron=${n("TranRon", "1m")} Roff=${n("TranRoff", "1G")}`
        + ` Vdrop=${n("TranVon", "0")} Drs=${n("DiodeRon", "10m")}`;
    },
  },

  "Voltage Controlled SPST": {
    sym: "vcspst", prefix: "S", forcePrefix: "X", pins: ["inA", "outA", "ctrlp", "ctrln"],
    value: () => "vcspst", attrs: ["Prefix X", "SpiceModel vcspst"],
    spiceLine: switchThresholds,
  },
  "Voltage Controlled SPDT": {
    sym: "vcspdt", prefix: "S", forcePrefix: "X", pins: ["inA", "outA1", "outA2", "ctrlp", "ctrln"],
    value: () => "vcspdt", attrs: ["Prefix X", "SpiceModel vcspdt"],
    spiceLine: switchThresholds,
  },

  // The potentiometer, as one part: the `pot` symbol plus the `pot` subcircuit
  // from library/sub/pot.lib. It used to be expanded into two stacked resistors
  // driven by a shared `.param`, which is what SPICE needs but not what fits on
  // the sheet — two resistor bodies where the source drawing had one part took
  // roughly three times the room, and on the denser exercise sheets the halves
  // landed on top of neighbouring parts. Inside a `.subckt` the same two
  // resistors take no space at all.
  //
  // Track resistance and wiper position ride on the instance line, so several
  // pots on one sheet keep their own settings. `wiper` counts from terminal 1
  // towards terminal 3, matching Multisim's own model (`posPercent` measured
  // from T1) — the old expansion had it the other way round, so an imported pot
  // sat at the mirror image of the position it was saved in.
  Potentiometer: {
    sym: "pot", prefix: "R", forcePrefix: "X", pins: ["1", "2", "3"],
    value: () => "", attrs: ["Prefix X", "SpiceModel pot"],
    spiceLine: (p) => {
      const pos = parseFloat(si(p.PosPercent) || "50") / 100;
      return `Rtot=${si(p.Res) || "10k"} wiper=${Number.isFinite(pos) ? pos : 0.5}`;
    },
  },

  // Multisim's ideal comparator has three terminals and carries its output
  // levels as parameters (`Output_level`, `Rise_fall_time`) rather than on
  // supply pins — so it maps onto our own three-terminal comparator, which is
  // built the same way (library/sub/comparator.lib).
  //
  // It used to map onto the five-terminal op-amp with the supply pins left
  // unconnected, which grounded both rails and left the output stuck at 0 V; the
  // specified output level was lost on top of that. Now the level rides on the
  // instance, and the edge time with it.
  //
  // Multisim states one level and means 0..Output_level: in
  // `8_2_3_Dual_Slope_ADC` the comparator drives the logic stages, which sit on
  // 0/5 V. A bipolar output is a matter of setting Vlow by hand.
  "Ideal Comparator": {
    sym: "comparator", prefix: "U", forcePrefix: "X", pins: ["IN+", "IN-", "OUT"],
    value: () => "comparator", attrs: ["Prefix X", "SpiceModel comparator"],
    spiceLine: (p) => `Vhigh=${si(p.Output_level) || "5"} Vlow=0 Trf=${si(p.Rise_fall_time) || "10n"}`,
  },

  // The INA333 is an instrumentation amplifier, not an op-amp: its gain is set
  // by an external resistor across RG1/RG2 and its output is referred to REF.
  // Mapped onto the generic op-amp those three pins have no counterpart, so the
  // converted stage has open-loop gain instead of the gain the circuit set, and
  // REF is lost. It converts so the schematic is complete — the amplification
  // has to be rebuilt by hand.
  INA333: { sym: "UniversalOpAmp2", prefix: "U", pins: ["IN+", "IN-", "VS+", "VS-", "OUT"], value: () => "" },
};

/**
 * Parts that convert through the ordinary table but are not quite the same
 * thing afterwards — worth a line in the report, since nothing on the sheet
 * would say so.
 */
const SUBSTITUTE_NOTES: Record<string, string> = {
  "Thermal Noise": "Thermal Noise (als Widerstand; das Rauschen selbst hat im "
    + "Transienten kein Gegenstueck, ein Oszillator schwingt damit nicht von "
    + "allein an)",
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
  // src/sym/opamp.asy, in SpiceOrder: In+, In-, OUT. The same three positions the
  // 5-pin symbol uses, so a converted sheet keeps its shape either way. The
  // comparator is drawn from the same geometry (see comparator.asy).
  opamp: [[-32, 16], [-32, -16], [32, 0]],
  comparator: [[-32, 16], [-32, -16], [32, 0]],
  // library/sym/Ureg.asy, in SpiceOrder: in, adj, out.
  Ureg: [[-48, -16], [0, 32], [48, -16]],
  // library/sym/SCR.asy, in SpiceOrder: A, G, K.
  SCR: [[0, -64], [48, 40], [0, 64]],
  // library/sym/pot.asy, in SpiceOrder: A (terminal 1), W (wiper), B (terminal 3).
  // A and B sit exactly where `res`'s two pins do, so a pot fits the space the
  // resistor it replaces was drawn in.
  pot: [[16, 16], [64, 48], [16, 96]],
  // src/sym/seg7hex.asy, in SpiceOrder: D8 D4 D2 D1 — on Multisim's own raster.
  seg7hex: [[0, 0], [32, 0], [64, 0], [96, 0]],
  // src/sym/seg7a.asy, in SpiceOrder: A B C D E F G COM. Segments 16 apart in a
  // row, the common anode 208 above the first — Multisim's own raster again.
  seg7a: [[0, 0], [16, 0], [32, 0], [48, 0], [64, 0], [80, 0], [96, 0], [0, -208]],
  // src/sym/wattmeter.asy, in SpiceOrder: VP VN IP IN.
  wattmeter: [[0, 0], [32, 0], [64, 0], [96, 0]],
  // src/sym/xfmr.asy, in SpiceOrder: P1 P2 S1 S2.
  xfmr: [[0, 0], [0, 64], [128, 0], [128, 64]],
  // src/sym/transw.asy, in SpiceOrder: P N CTRL.
  transw: [[0, 0], [0, 96], [-48, 48]],
  // src/sym/dipsw4.asy, in SpiceOrder: P1..P4 along the bottom, P5..P8 back
  // along the top — so that opposite pins are one switch, as on the package.
  dipsw4: [[0, 0], [16, 0], [32, 0], [48, 0], [48, -80], [32, -80], [16, -80], [0, -80]],
  // src/sym/74LS139.asy, in SpiceOrder: A B G Y0..Y3 — on Multisim's own raster.
  "74LS139": [[0, 0], [0, 16], [0, 48], [192, 0], [192, 16], [192, 32], [192, 48]],
  // src/sym/74LS138.asy, in SpiceOrder: A B C G1 G2A G2B Y0..Y7.
  "74LS138": [
    [0, 0], [0, 16], [0, 32], [0, 64], [0, 80], [0, 96],
    [192, 0], [192, 16], [192, 32], [192, 48], [192, 64], [192, 80], [192, 96], [192, 112],
  ],
  // The switch family, in SpiceOrder. src/sym/{spst,spdt,vcspst,vcspdt}.asy —
  // drawn on Multisim's own pin raster, so a converted switch needs no bridge
  // and the wiring lands straight on the pins.
  spst: [[0, 0], [112, 0]],
  spdt: [[0, 0], [112, -48], [112, 0]],
  vcspst: [[0, 0], [128, 0], [48, 64], [80, 64]],
  // src/sym/vcvs.asy, in SpiceOrder: output pair right, control pair left.
  vcvs: [[48, 0], [48, 112], [0, 0], [0, 112]],
  vcspdt: [[0, 0], [128, -16], [128, 16], [48, 80], [80, 80]],
  // library/sym/74LS93.asy, in SpiceOrder: CKA CKB R01 R02 QA QB QC QD.
  "74LS93": [[-48, -48], [-48, -16], [-48, 16], [-48, 48], [48, -48], [48, -16], [48, 16], [48, 48]],
  // D, CLK, SET, RESET, Q, ~Q — the same numbers as ltspiceGeometry's `dff`
  // entry, which is what the editor places the pins on.
  //
  // NOTE: these were briefly moved to Multisim's own raster (body 160 wide, the
  // asynchronous pins 104 out) so a converted flip-flop would need no bridge. It
  // draws far better — the corpus went from 1056 dead wire ends to 681 — but the
  // offsets are *our* convention, not LTSpice's, so changing them reinterprets
  // every `.asc` already saved: `examples/Rahm/6_2_1_Asynchroner_Frequenzteiler_Lsg.asc`
  // came apart, its wires still drawn to the old positions. A published
  // schematic that worked has to keep working, so the raster stays.
  "Digital\\dflop": [[-32, -24], [-32, 24], [0, -48], [0, 48], [32, -24], [32, 24]],
  // The JK's seventh pin, in FF_CONNS order: J and K at the other kinds' two
  // heights, the clock between them (see DFlipFlop.createPorts).
  "Digital\\dflop:jk": [[-32, -24], [-32, 24], [-32, 0], [0, -48], [0, 48], [32, -24], [32, 24]],
};

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

/**
 * A parameter Multisim spells with markup in the name.
 *
 * Its switch parameters arrive as `V<sub>ON</sub>`, `R<sub>OFF</sub>` and so on —
 * the subscript of the printed symbol, carried into the key. Read under both the
 * plain and the tagged spelling so neither a tidied file nor the original is the
 * one that fails.
 */
function param(p: Params, name: string): string {
  const tagged = name.replace(/^([A-Z])_?(.+)$/, "$1<sub>$2</sub>");
  return si(p[name] ?? p[tagged] ?? p[name.replace("_", "")] ?? "");
}

/**
 * Switching thresholds and contact resistances for a voltage-controlled switch,
 * as the instance line wants them.
 *
 * Multisim states an on and an off threshold; the model turns that pair into
 * ngspice's centre plus hysteresis, so both numbers travel unchanged.
 */
function switchThresholds(p: Params): string {
  const v = (k: string, d: string) => param(p, k) || d;
  return `Von=${v("V_ON", "1")} Voff=${v("V_OFF", "0")} Ron=${v("R_ON", "10m")} Roff=${v("R_OFF", "1G")}`;
}

/**
 * Whether a hand-operated switch should come over closed.
 *
 * Multisim Live saves the position in `State` and that is what is read. Multisim
 * 14 saves it *nowhere*: its interactive switch keeps only the hotkey that
 * toggles it (`Space`) and its two contact resistances, so a file says nothing
 * about which way the switch was left. Read as "not 1, therefore open" — which
 * is what this did — every switch imported from a `.ms14` came over open, and a
 * switch in series with the supply takes the whole sheet with it: the
 * `Tiefsetzsteller` converted correctly in every other respect and simulated a
 * circuit with no source connected to it.
 *
 * So a missing state means the switch's own resting position, which for a
 * make-contact is the one its symbol declares (`spst.asy`: `pos=1`). An explicit
 * state still wins wherever the format records one.
 */
function manualSwitchClosed(p: Params): boolean {
  const state = p.State;
  if (state === undefined || state === "") return true;
  return (parseInt(state, 10) || 0) === 1;
}

/**
 * A switch's contact resistances, where the file states them.
 *
 * Multisim 14 gives them per instance (100 µΩ closed, 100 MΩ open in the
 * `Tiefsetzsteller`), and they belong on the instance here too — the models take
 * both as parameters. Left off, every switch fell back to the model's own
 * defaults, which are not the same numbers.
 */
function switchContacts(p: Params): string {
  const ron = param(p, "R_ON");
  const roff = param(p, "R_OFF");
  return (ron ? ` Ron=${ron}` : "") + (roff ? ` Roff=${roff}` : "");
}

/**
 * `AC Voltage`/`AC Current` carry a SPICE SIN() source's parameters — and its
 * small-signal amplitude, which is a different thing entirely.
 *
 * `SINE(...)` drives a `.tran` run. A `.ac` sweep is linear about the operating
 * point and reads only the `AC` magnitude, so a source without one contributes
 * exactly zero at every node and every frequency — no error, no warning, just a
 * flat nothing. Every converted filter behaved that way: sweep the active
 * bandpass and the answer was 0 across the band.
 *
 * Multisim's part is the one place the two are *not* independent. It is called
 * an AC source and its amplitude is what its own AC analysis uses, so the same
 * number belongs in both fields. A user who wants them apart can still say so;
 * arriving with the frequency response blanked out is not a starting point
 * anyone would choose.
 */
function sine(p: Params): string {
  const f = (k: string, d: string) => si(p[k]) || d;
  const amp = f("VA", "1");
  return `AC ${amp} SINE(${f("VO", "0")} ${amp} ${f("Freq", "1k")} ${f("TD", "0")} ${f("DF", "0")} ${f("Phase", "0")})`;
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
const SINGLE_GATES: Record<string, { gate: string; ins: string[] }> = {
  Inverter: { gate: "not", ins: ["A"] },
  Buffer: { gate: "buffer", ins: ["A"] },
};

/**
 * Multisim names a gate by its input count and its function ("3-Input NAND"),
 * and the two are independent: our own gate takes any number of inputs, so
 * spelling out every combination only decides which of them we happen to accept.
 * The list did decide that, and a five-input AND — the sort of thing a decoder
 * is built from — came out as a part we had no entry for.
 */
const GATES: Record<string, { gate: string; ins: string[] }> = new Proxy(SINGLE_GATES, {
  get(target, key: string) {
    if (key in target) return target[key];
    const m = /^(\d+)-Input (AND|OR|NAND|NOR|XOR|XNOR)$/.exec(key);
    if (!m) return undefined;
    const n = Number(m[1]);
    // A, B, C … as far as the count goes; Multisim names them the same way.
    return { gate: m[2].toLowerCase(), ins: Array.from({ length: n }, (_, i) => String.fromCharCode(65 + i)) };
  },
  has(target, key: string) {
    return key in target || /^\d+-Input (AND|OR|NAND|NOR|XOR|XNOR)$/.test(key);
  },
});

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
    offs.push([CENTER - 32, CENTER + (n === 1 ? 0 : Math.round(-span / 2 + (span * i) / (n - 1)))]);
  }
  offs.push([CENTER + 32, CENTER]);
  return offs;
}

/**
 * Emit a logic gate.
 *
 * Fitted over *all* its pins, like every other part, and anchored on the input
 * column rather than on the output. The wiring no longer depends on that — the
 * router draws to wherever the pins end up — but the *reading* does: the gate
 * lands where the original drawing had it, facing the way it faced, so the sheet
 * still looks like the sheet it came from.
 *
 *   - The inputs are where the fit is exact: our gate spaces them 16 apart and so
 *     does Multisim. Anchored on the output instead — as this did — the whole
 *     column lands 56 units off, and that was before mirroring.
 *   - `R0` was written unconditionally, so a gate Multisim had mirrored (its
 *     matrix carries `a = -1`) came out facing the wrong way, with its inputs 200
 *     units from where the original had them.
 */
function emitGate(part: MsPart, spec: { gate: string; ins: string[] }, ctx: Ctx): void {
  const { symbolLines, pinPos, used } = ctx;
  const name = uniqueName(part.refdes.prefix || "U", part.refdes.number, used);
  ctx.instances.push({ name, guid: part.guid, extraNodes: 0 });

  const at = (conn: string, p: Pt) => { const id = part.connPin[conn]; if (id !== undefined) pinPos[`${part.guid}/${id}`] = p; };

  const offs = gatePinOffsets(spec.ins.length);
  const conns = [...spec.ins, "Y"];
  const want: (Pt | null)[] = conns.map((c) => {
    const local = part.pins[c];
    return local ? scaled(applyMatrix(part.matrix, local), ctx.to) : null;
  });
  // Anchor on the first input that exists; the output is the fallback for a
  // gate whose inputs the file does not place.
  const anchorIdx = want.findIndex((p) => p !== null);
  if (anchorIdx === -1) return;
  const { deg, mirrored, str, origin } = fitOrientation(offs, want, anchorIdx);

  const symName = `Digital\\${GATE_SYMBOL[spec.gate] ?? spec.gate}`;
  const pinNames = [...spec.ins.map((_, i) => `In${i + 1}`), "Out"];
  symbolLines.push(`SYMBOL ${symName} ${origin[0]} ${origin[1]} ${str}`);
  symbolLines.push(`SYMATTR InstName ${name}`);
  symbolLines.push(`SYMATTR Value ${spec.gate.toUpperCase()}`);
  symbolLines.push(
    `SYMATTR LibreSpice gate=${spec.gate};inputs=${spec.ins.length};` +
    `vth=${LOGIC_THRESHOLD};vhigh=${LOGIC_HIGH};pins=${pinNames.join(",")}`,
  );

  const pinPts: Pt[] = offs.map((o) => {
    const r = rotate(o, deg, mirrored);
    return [origin[0] + r[0], origin[1] + r[1]] as Pt;
  });
  conns.forEach((c, i) => {
    at(c, pinPts[i]);
    ctx.terminals.push(pinPts[i]);
  });
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
  jkff: ["J", "K", "CLK", "SET", "RESET", "Q", "~Q"],
};
const ffPins = (kind: string): { conn: string; off: Pt }[] => {
  const offs = PIN_OFFSETS[kind === "jkff" ? "Digital\\dflop:jk" : "Digital\\dflop"];
  return FF_CONNS[kind].map((conn, i) => ({ conn, off: offs[i] }));
};

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
 *
 * NOTE: fitting this over all six pins the way `emitGate` now is — with the
 * orientation and the mirror taken from Multisim's matrix — was tried and taken
 * back. It draws better on paper (80 fewer invented net names across the corpus,
 * and the shift register goes from 177 dead wire ends to 117), but it moves the
 * part far enough that `6_2_1_Asynchroner_Frequenzteiler_Lsg` stops simulating
 * at all: ngspice reports a singular matrix and the operating point never
 * settles. A schematic that draws better and no longer runs is the worse of the
 * two, so the flip-flop keeps the single anchor until the placement can be moved
 * without breaking the net it lands on.
 */
function emitDFlipFlop(part: MsPart, kind: string, ctx: Ctx): void {
  const { symbolLines, pinPos, used } = ctx;
  const name = uniqueName(part.refdes.prefix || "U", part.refdes.number, used);
  ctx.instances.push({ name, guid: part.guid, extraNodes: 0 });

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
  const mark = { dff: "DFF", tff: "TFF", dlatch: "DLATCH", jkff: "JKFF" }[kind] ?? "DFF";
  symbolLines.push(`SYMATTR Value ${kind === "dlatch" ? mark : mark + (edge === "falling" ? "-" : "+")}`);
  symbolLines.push(
    `SYMATTR LibreSpice kind=${kind};edge=${edge};async=${asyncPol};` +
    `vth=${LOGIC_THRESHOLD};vhigh=${LOGIC_HIGH};pins=${pins.map((x) => x.conn).join(",")}`,
  );

  // Multisim spells the complement "~Q" on some symbols and "Qneg" on others.
  for (const { conn, off } of pins) {
    const at: Pt = [origin[0] + off[0], origin[1] + off[1]];
    const id = part.connPin[conn] ?? (conn === "~Q" ? part.connPin["Qneg"] : undefined);
    if (id !== undefined) pinPos[`${part.guid}/${id}`] = at;
    ctx.terminals.push(at);
  }
}

/**
 * Emit a digital constant or clock as an ordinary voltage source.
 *
 * Both have a single pin in Multisim and are implicitly referenced to ground, so
 * the source's negative terminal gets its own ground flag rather than being left
 * floating — which ngspice would reject as an open circuit.
 *
 * That invented terminal needs somewhere to go, and where it goes cannot be
 * decided here: it has to keep clear of every other terminal on the sheet, and
 * most of those are not placed yet. So the SYMBOL and the FLAG are written with
 * placeholder coordinates and seated afterwards — see `seatDigitalGrounds`.
 */
function emitDigitalSource(part: MsPart, kind: "constant" | "clock", ctx: Ctx): void {
  const { symbolLines, pinPos, flags, used } = ctx;
  const name = uniqueName(`V${part.refdes.prefix || "DG"}`, part.refdes.number, used);
  // The ground this emitter invents below is a node the net list does not carry.
  ctx.instances.push({ name, guid: part.guid, extraNodes: 1 });
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
  const id = part.connPin[conn];
  if (id !== undefined) pinPos[`${part.guid}/${id}`] = outAbs;
  ctx.terminals.push(outAbs);

  // Written now, placed later: the two lines are kept by index so the seating
  // pass can rewrite them once every terminal is known.
  const symbol = symbolLines.length;
  symbolLines.push("SYMBOL voltage 0 0 R0");
  symbolLines.push(`SYMATTR InstName ${name}`);
  symbolLines.push(`SYMATTR Value ${value}`);
  const flag = flags.length;
  flags.push("FLAG 0 0 0");
  ctx.grounds.push({ symbol, flag, out: outAbs });
}

/**
 * Turn each digital source so its invented ground lands on nothing.
 *
 * The ground terminal is not in the net list — it is this conversion's own
 * addition — so nothing stops it from coming down on a neighbour's pin, and there
 * it does not merely look wrong: it grounds that pin's net, and the source whose
 * ground it is reads as shorted. ngspice then refuses to start on the sheet.
 *
 * Which is not hypothetical. Multisim stacks the five digital constants of
 * `6_3_3_Universal_Schieberegister_Lsg` 32 units apart, while our `voltage` symbol
 * puts 80 between its terminals — so the ground of one sits squarely on the output
 * of another two rows down.
 *
 * `R0` is tried first, so a source with room keeps the upright shape these sheets
 * were drawn with; the turns are only reached when it is in the way. The output pin
 * stays put through all four, since the symbol is placed *from* it.
 */
function seatDigitalGrounds(ctx: Ctx): void {
  const VS = PIN_OFFSETS.voltage;
  for (const g of ctx.grounds) {
    const seats = [0, 180, 90, 270].map((deg) => {
      const plus = rotate(VS[0], deg, false);
      const origin: Pt = [g.out[0] - plus[0], g.out[1] - plus[1]];
      const off = rotate(VS[1], deg, false);
      return { deg, origin, minus: [origin[0] + off[0], origin[1] + off[1]] as Pt };
    });
    // Clear of every other terminal, and by more than a hair: a name binds to the
    // pin it is *nearest*, within half a grid step, and our own pin centres sit up
    // to 8 units off the file's for a source. A ground flag 16 units from a
    // neighbouring output is therefore already a coin toss — and losing it grounds
    // that output. Multisim stacks its digital constants 32 apart, so this is not
    // a corner case: it is the shift registers.
    //
    // All four seats crowded happens on a sheet whose sources sit on top of each
    // other; upright is then the least confusing of four wrong answers.
    const clearance = (p: Pt) => Math.min(
      ...ctx.terminals.map((t) => Math.abs(t[0] - p[0]) + Math.abs(t[1] - p[1])), Infinity);
    const seat = seats.find((s) => clearance(s.minus) >= 24)
      ?? seats.find((s) => clearance(s.minus) > 0)
      ?? seats[0];
    ctx.symbolLines[g.symbol] = `SYMBOL voltage ${seat.origin[0]} ${seat.origin[1]} R${seat.deg}`;
    ctx.flags[g.flag] = `FLAG ${seat.minus[0]} ${seat.minus[1]} 0`;
    ctx.terminals.push(seat.minus);
  }
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
  // The only one left on the resistor stand-in. It is not a contact but a
  // transistor used as one, and its "control" is a base drive rather than a
  // gate signal — a switch model with a threshold would say something about it
  // that Multisim does not.
  "Transistor Switch": { paths: [["pos", "neg"]], drop: ["control"], stateDrivesPath: false },
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
  // One resistor per contact, but they share the part's pins, so they share its
  // count too. Only the single-contact transistor switch is left on this path.
  ctx.instances.push({ name: base, guid: part.guid, extraNodes: 0 });

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
    ctx.terminals.push(top, bottom);
  });

  return spec.drop ?? [];
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
 * How far a part's body reaches past its terminals, across the line they sit on.
 *
 * A two-terminal part's pins share one coordinate, so the box they span is a line
 * with no width — and a line is nothing a route can be *inside* of, so every test
 * against it passes and the router happily draws through the symbol. One grid
 * square either side is about the width these symbols are drawn at (a resistor's
 * body is 32 wide, a source 40 across).
 */
const BODY_HALF = GRID;

/**
 * The bounding box of every placed symbol, from the emitted SYMBOL lines.
 *
 * A router has to keep its wires off the part bodies, not only off other wires.
 * Read back rather than collected while emitting, because the pin offsets are
 * exactly what the SYMBOL line already says.
 */
function symbolBodies(symbolLines: string[]): Wire[] {
  const out: Wire[] = [];
  for (let i = 0; i < symbolLines.length; i++) {
    const m = /^SYMBOL (\S+) (-?\d+) (-?\d+) (\S+)$/.exec(symbolLines[i]);
    if (!m) continue;
    // A gate's pin count is a property, not a table: its offsets are spread over
    // the input column and a three-input gate is half as tall again as a
    // two-input one. Read against the fixed table, the body came out too small,
    // and the router laid corners inside gates it thought it was going round.
    let offs = PIN_OFFSETS[m[1]];
    for (let j = i + 1; j < symbolLines.length && /^SYMATTR /.test(symbolLines[j]); j++) {
      const g = /^SYMATTR LibreSpice .*\bpins=([^;]+)/.exec(symbolLines[j]);
      if (g && /^Digital\\(and|or|nand|nor|xor|xnor|inv|buf)$/.test(m[1])) {
        offs = gatePinOffsets(g[1].split(",").length - 1);
      }
    }
    if (!offs?.length) continue;
    const deg = Number(m[4].slice(1)) || 0;
    const mir = m[4].startsWith("M");
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const o of offs) {
      if (!o) continue;
      const r = rotate(o, deg, mir);
      const x = Number(m[2]) + r[0], y = Number(m[3]) + r[1];
      x1 = Math.min(x1, x); y1 = Math.min(y1, y);
      x2 = Math.max(x2, x); y2 = Math.max(y2, y);
    }
    if (!Number.isFinite(x1)) continue;
    // Flat in one direction means a two-pin part standing along that line; give
    // it the width it is drawn with, or nothing can be "through" it.
    if (x1 === x2) { x1 -= BODY_HALF; x2 += BODY_HALF; }
    if (y1 === y2) { y1 -= BODY_HALF; y2 += BODY_HALF; }
    out.push([x1, y1, x2, y2]);
  }
  return out;
}

/** True when a point lies on an axis-aligned segment, endpoints included. */
function onSegment(p: Pt, [x1, y1, x2, y2]: Wire): boolean {
  return x1 === x2
    ? p[0] === x1 && p[1] >= Math.min(y1, y2) && p[1] <= Math.max(y1, y2)
    : y1 === y2 && p[1] === y1 && p[0] >= Math.min(x1, x2) && p[0] <= Math.max(x1, x2);
}

/**
 * Add net labels wherever the drawn geometry leaves one Multisim net split
 * across several disconnected islands. Returns the FLAG lines to append.
 *
 * Ground is a special case and the reason it reads well: it is not routed at all
 * (see the router call), so every ground pin is its own island and gets its own
 * `FLAG … 0` — which is how LTSpice draws ground, a symbol per pin rather than a
 * net snaking across the sheet. A ground net with a single pin is labelled too,
 * where any other net with nothing to join is left alone.
 *
 * A label is set one grid square off its pin and joined to it by a short wire,
 * rather than placed on the pin itself. On the pin the tag covers the terminal
 * and reads as part of the symbol — and since it is a component of its own, it
 * can then be dragged away from a part it looked welded to. The stub makes the
 * connection something the schematic actually shows. Any lead that would land on
 * another pin or on an existing wire is dropped back onto the pin, since a stub
 * into an occupied point would invent a connection Multisim never had.
 */
function reconcile(netList: MsNet[], pinPos: PinPos, wires: Wire[], existingFlags: string[], named: Set<string>): string[] {
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

    // Multisim's node 0 is ground; LTSpice spells that label "0" as well.
    const netName = net.name ?? "";
    const ground = netName === "0";
    const numbered = /^\d+$/.test(netName);
    const name = ourNetName(netName);
    // A net Multisim *named* is one the original drawing showed a name for, via a
    // connector symbol — `+Ub`, `-Ub`, `Ut`. Those connectors are not carried over
    // (see the connector note in `convert`), so the name has to come from here,
    // and it is written whether or not the wiring needs it: without that the sheet
    // loses the label the reader recognises it by, and a supply net with one pin
    // on it loses the node as well.
    // A behavioural source's expression names its nodes, and a name only reaches
    // a node if the sheet carries it: a numbered net is otherwise left unlabelled
    // where the wiring already joins it, and the netlist then calls it something
    // of its own. The expression would go on reading `V(N2)` at a node nobody
    // calls N2 — no error anywhere, just a source stuck at zero.
    const shown = ground || (netName !== "" && !numbered) || named.has(netName);
    // A net the original *did* connect, but of which we placed a single pin: the
    // other end is a part that could not be converted (see `skipped`/`unmapped`),
    // or a pin a stand-in does not have — the transistor switch loses its control
    // input, and the clock driving it was left with its terminal on no node at
    // all, which reads to ngspice as a shorted source. The name goes on anyway:
    // the node the original had then exists, with one device on it.
    const lost = pts.length === 1 && net.pins.length >= 2;
    if (pts.length < 2 && !shown && !lost) continue;

    const islands = new Map<string, { p: Pt; key: string }>();
    for (const it of pts) {
      const root = uf.find(key(it.p));
      if (!islands.has(root)) islands.set(root, it);
    }
    // One island means the wires already join every pin on this net — except for
    // the named ones, where the label is wanted for its own sake, and for the one
    // whose counterpart went missing.
    if (islands.size < 2 && !shown && !lost) continue;
    for (const [, { p }] of islands) {
      // Already named, by a connector symbol or by another net's pin sharing the
      // point: a second FLAG on the same spot says nothing and draws twice.
      if (placed.some((q) => q[0] === p[0] && q[1] === p[1])) continue;
      // The name goes *on* the pin. Always — a bare pin included.
      //
      // Two stubs have stood here and both are gone. The first hung the flag off
      // a 16-unit lead on the grounds that LTSpice reads a flag sitting directly
      // on a pin as a terminal rather than as a net name. It does not.
      //
      // This used to draw a 16-unit lead and hang the flag off its far end, on
      // the grounds that LTSpice reads a flag sitting directly on a pin as a
      // terminal rather than as a net name. It does not — `InvSummierverstaerker.asc`
      // is an LTSpice-authored file with its ±15 V flags straight on the source
      // pins, and the connectivity suite exists because of it.
      //
      // What the lead did instead was rebuild the model the editor moved away
      // from. A name is a coordinate: it owns no pin and no wire, and dragging it
      // moves nothing but itself. Hung on a stub, the stub stayed behind when the
      // name was dragged, and the stub's far end came back from the parser as a
      // junction — one that could be neither selected nor deleted.
      //
      // The second survived only at the gates, where a name written at the file's
      // pin missed the canvas's by 18 units and bound to nothing. That was a
      // defect in the gate's pin table, not a fact about names, and it has been
      // fixed at the source (see ltspiceGeometry.logicGatePinOffsets). With the
      // two frames agreeing, a name on any bare pin binds to it — pins are
      // zero-length routes (anchorNets.netRoutes) and a name landing on one that
      // no wire reaches creates the net there (circuitStore.rebuildConnections),
      // which is how LTSpice ties a supply pin to its rail with a flag alone.
      placed.push(p);
      out.push(`FLAG ${p[0]} ${p[1]} ${name}`);
    }
  }
  return out;
}

/**
 * What a Multisim net is called here.
 *
 * Multisim numbers the nets it was not given a name for, and a bare number is no
 * node name for us, so it gets an `N` in front — except node 0, which is ground
 * in both. Named for its own sake because a *second* reader of it appeared: a
 * behavioural source states its expression in terms of node names
 * (`(4*V(1,2))-V(2,3)`), and those have to be the same names the rest of the
 * sheet ends up with, or the expression quietly reads nodes that do not exist.
 */
function ourNetName(netName: string): string {
  if (netName === "0") return "0";
  return /^\d+$/.test(netName) ? `N${netName}` : netName;
}

/**
 * A behavioural source's expression, in this schematic's node names.
 *
 * `V(1,2)` and `I(vV7)` are Multisim's own — its numbered nets and its refdes for
 * a source, with the device letter stuck on the front. Both have counterparts
 * here and neither survives being copied verbatim: the nets are renamed on the
 * way out, and a current is read through whatever *we* called that source.
 *
 * Anything else in the expression is arithmetic and passes through untouched. A
 * reference that matches nothing is left as it stands rather than guessed at —
 * ngspice then names it in its own error, which is more use than a silent
 * substitution.
 */
function abmExpression(expr: string, nets: MsNet[]): string {
  const known = new Set(nets.map((n) => n.name ?? ""));
  return expr
    // V(a) and V(a,b): every argument is a node.
    .replace(/\bV\s*\(([^)]*)\)/gi, (whole, args: string) => {
      const parts = args.split(",").map((a) => a.trim());
      if (!parts.every((a) => known.has(a))) return whole;
      return `V(${parts.map(ourNetName).join(",")})`;
    })
    // I(…) reads a current through a source. Multisim writes the refdes with its
    // device letter stuck on the front ("vV7" is the source V7); the refdes
    // itself survives the conversion — they are all reserved before any part is
    // named — so dropping that one leading letter is the whole translation.
    .replace(/\bI\s*\(\s*([vi])([VI]\w*)\s*\)/g, (_whole, _lead: string, ref: string) => `I(${ref})`);
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
  /** Declared connection names the placed part turned out not to have. */
  const unmapped: string[] = [];

  const wires: Wire[] = [];
  /** Every instance placed on the sheet (see Ctx.instances). */
  const instances: Instance[] = [];
  /** The digital sources still to be seated (see Ctx.grounds). */
  const grounds: { symbol: number; flag: number; out: Pt }[] = [];
  /** Every terminal placed on the sheet (see Ctx.terminals). */
  const terminals: Pt[] = [];

  const flags: string[] = [];
  const symbolLines: string[] = [];
  /** SPICE directives the conversion itself needs (pot parameters, …). */
  const directives: string[] = [];
  /** `<part guid>/<conn name>` → the pin's final LTSpice position. */
  const pinPos: PinPos = {};

  // The file's own grid, in our units. Rounded to the LTSpice grid afterwards so
  // parts and wire ends land on it whatever the source drew on.
  const to = (v: number) => Math.round((v * sch.unit) / GRID) * GRID;

  // Reserve every refdes Multisim spelled out, so auto-numbering cannot take a
  // name a later part already claims.
  const used = new Set<string>();
  for (const part of sch.parts) {
    const name = part.typeName;
    const num = part.refdes.number;
    if (num === null || num === undefined) continue;
    const prefix = TYPES[name]?.forcePrefix
      || (SWITCHES[name] ? "R" : null)  // the transistor switch, still a resistor
      || (name === "Digital Constant" || name === "Digital Clock" ? `V${part.refdes.prefix ?? "DG"}` : null)
      || part.refdes.prefix || TYPES[name]?.prefix;
    if (prefix) used.add(`${prefix}${num}`);
  }

  const ctx: Ctx = { symbolLines, flags, directives, pinPos, used, wires, terminals, instances, grounds, to };

  // A behavioural source's expression names nodes, and those names are ours to
  // decide (see ourNetName) — so it is translated here, where the net list is,
  // rather than in the reader, which cannot know.
  for (const part of sch.parts) {
    if (part.params.Expression) {
      part.params = { ...part.params, Expression: abmExpression(part.params.Expression, sch.nets) };
    }
  }

  // --- placed parts -------------------------------------------------------
  for (const part of sch.parts) {
    const bp = { name: part.typeName };

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
      "JK Flip-Flop": "jkff",
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
    // A part that converts to something it is not quite says so. The switches and
    // the gates report themselves above; these are the ones that come through the
    // ordinary table and would otherwise arrive silently changed.
    const note = SUBSTITUTE_NOTES[bp.name];
    if (note) substituted.push(note);
    const offsets = PIN_OFFSETS[type.sym] ?? [];

    // Prefer the IEC artwork when Multisim used it — these are German teaching
    // schematics and the box resistor is what the source drawings show.
    const isIec = /:IEC:/.test(part.symbolDescription);
    const symName = isIec && type.euro ? type.euro : type.sym;
    const useOffsets = PIN_OFFSETS[symName] ?? offsets;

    // A declared name the part does not carry: say so. Silently, this drops
    // every wire on that pin.
    for (const conn of type.pins) {
      if (conn !== null && !(conn in part.pins)) {
        const note = `${bp.name}: Anschluss ${conn} gibt es nicht (vorhanden: ${part.connNames.join(", ")})`;
        if (!unmapped.includes(note)) unmapped.push(note);
      }
    }

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
    const inst = uniqueName(prefix, part.refdes.number, used);
    symbolLines.push(`SYMATTR InstName ${inst}`);
    instances.push({ name: inst, guid: part.guid, extraNodes: 0 });

    // Ratings can sit on either level — a lamp keeps its voltage and power in
    // `modeldefinitiondata` while a resistor keeps its value in
    // `modelinstancedata`. Instance data wins where both carry a key.
    const flat = part.params;
    const value = type.value(flat);
    if (value) symbolLines.push(`SYMATTR Value ${value}`);
    const spiceLine = type.spiceLine?.(flat);
    if (spiceLine) symbolLines.push(`SYMATTR SpiceLine ${spiceLine}`);
    for (const a of type.attrs ?? []) symbolLines.push(`SYMATTR ${a}`);

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
      ctx.terminals.push([ax, ay]);
    }
  }

  // Now that every terminal is known, the digital sources can be turned so their
  // invented grounds land on none of them.
  seatDigitalGrounds(ctx);

  // --- ground and other connectors ---------------------------------------
  // Left out on purpose, both kinds. A Multisim connector is a *name* on a net,
  // not a terminal: the ground symbol says "node 0" and a plain connector says
  // "+Ub", and in both cases the net list has already recorded that — the nets
  // these sheets carry are literally named `0`, `+Ub`, `Uc`. So there is nothing
  // to place. Carried over as a point it would only be a terminal with no device
  // behind it: the router would run a wire out to it, and the reconciliation
  // would hang a second ground symbol in the empty space beside the pin that
  // already has one.

  // --- wires --------------------------------------------------------------
  // Drawn between our own pins, not copied from Multisim (see router.ts). What
  // the router is given, and why each part of it:
  //
  //   - the nets as *our* terminals, from the net list Multisim simulated, since
  //     that says what belongs together where the drawing only shows it;
  //   - the part bodies, so a wire prefers going round a symbol to through it;
  //   - the wiring the emitters drew themselves (a changeover switch ties its two
  //     contacts together), which is fixed and has to be routed around;
  //   - every terminal on the sheet, so no route is laid across a foreign pin.
  //     `terminals` and not `pinPos`: the invented ground of a digital source is
  //     a terminal Multisim never named, and running over that one grounds a net.
  //
  // Ground is left out on purpose. It is the widest net on nearly every sheet, so
  // routing it first (nets go longest-first) would spend the whole sheet's
  // crossing budget on it, and it is the one net that needs no wire: LTSpice draws
  // a ground symbol per pin, which is what the reconciliation below emits.
  // Which net each pin sits on, by pin and by point. Only a net with two pins on
  // it is a connection: Multisim writes a one-pin net for a terminal that goes
  // nowhere, and these teaching sheets are full of them — the parts of an exercise
  // the student is meant to wire up.
  const netOfPin = new Map<string, string>();
  const ofNet = new Map<string, string>();
  for (const net of sch.nets) {
    if (net.pins.length < 2) continue;
    for (const obj of net.pins) {
      const k = `${obj.component}/${obj.pin}`;
      netOfPin.set(k, net.name ?? "");
      const p = pinPos[k];
      if (p) ofNet.set(key(p), net.name ?? "");
    }
  }

  // What the original leaves with fewer than two nodes. Nothing can be drawn for
  // these — there is no connection to draw — and the netlist puts every terminal
  // of them on node 0, which for a source reads to ngspice as a short. Said out
  // loud so that it is not mistaken for the conversion's own doing: this is the
  // sheet as it was drawn.
  const unconnected = instances.filter((inst) => {
    const nodes = new Set<string>();
    for (const [k, name] of netOfPin) if (k.startsWith(`${inst.guid}/`)) nodes.add(name);
    return nodes.size + inst.extraNodes < 2;
  }).map((i) => i.name);
  const bodies = symbolBodies(symbolLines);
  const { wires: laid, report: route } = routeNets({
    nets: sch.nets
      .filter((n) => (n.name ?? "") !== "0")
      .map((n) => ({
        name: n.name ?? "",
        pts: n.pins.map((q) => pinPos[`${q.component}/${q.pin}`]).filter((q): q is Pt => !!q),
      }))
      .filter((n) => n.pts.length >= 2),
    bodies,
    fixed: wires.map((seg) => ({ what: seg, net: ofNet.get(key([seg[0], seg[1]])) ?? null })),
    keepClear: terminals.map((pt) => ({ what: pt, net: ofNet.get(key(pt)) ?? null })),
  });
  wires.push(...laid);

  // --- close gaps against the authoritative net list ----------------------
  // Whatever the router could not draw without touching another net is joined by
  // name instead — a label connects without geometry and so cannot short
  // anything. This is also where ground gets its symbols, one per pin.
  // Nets a behavioural expression reads by name; they have to be labelled on the
  // sheet or the name reaches nothing (see reconcile).
  const namedByExpr = new Set<string>();
  for (const part of sch.parts) {
    for (const m of (part.params.Expression ?? "").matchAll(/\bV\s*\(([^)]*)\)/gi)) {
      for (const a of m[1].split(",")) {
        const n = a.trim();
        // Back to Multisim's spelling: that is what the net list is keyed on.
        if (/^N\d+$/.test(n)) namedByExpr.add(n.slice(1));
      }
    }
  }
  flags.push(...reconcile(sch.nets, pinPos, wires, flags, namedByExpr));

  // --- prune what reaches nothing -----------------------------------------
  // A wire end that meets no terminal, no other wire and no name connects
  // nothing. It is the stump of a connection the conversion could not draw, and
  // the net it belonged to has been rejoined by name above — so the stump costs
  // only clarity, and a sheet full of leads running into blank space reads as
  // broken even where it is not.
  //
  // Two things make this safe, and both were missing in the attempts that put
  // terminals on ground: the protected points come from `terminals`, which every
  // emitter fills as it draws (so a pin Multisim does not name still counts),
  // and a segment carrying a name is never cut, because the name binds to its net
  // *through* that segment.
  //
  // Repeated, because removing a stub exposes the corner behind it.
  {
    const held = new Set<string>(terminals.map(key));
    for (const f of flags) {
      const m = /^FLAG (-?\d+) (-?\d+)/.exec(f);
      if (m) held.add(key([Number(m[1]), Number(m[2])]));
    }
    for (const p of Object.values(pinPos)) held.add(key(p));
    for (;;) {
      const deg = new Map<string, number>();
      for (const [x1, y1, x2, y2] of wires) {
        for (const k of [key([x1, y1]), key([x2, y2])]) deg.set(k, (deg.get(k) ?? 0) + 1);
      }
      const loose = (p: Pt) => {
        const k = key(p);
        if ((deg.get(k) ?? 0) !== 1 || held.has(k)) return false;
        // A T is held: another wire runs through the point rather than ending on it.
        return !wires.some((w) =>
          onSegment(p, w) && key([w[0], w[1]]) !== k && key([w[2], w[3]]) !== k);
      };
      // A stub is only cut where it does not strand the terminal it hangs on.
      // Cutting the last wire off a pin leaves it on no net at all, and a source
      // whose two terminals are then both "no net" reads to ngspice as shorted —
      // it refuses to start, where before it merely delivered nothing. So the
      // terminal keeps one lead and the sheet keeps a short stub there.
      const strands = (held_end: Pt) => (deg.get(key(held_end)) ?? 0) <= 1;
      const keep = wires.filter((w) => {
        const a: Pt = [w[0], w[1]], b: Pt = [w[2], w[3]];
        if (loose(b) && !strands(a)) return false;
        if (loose(a) && !strands(b)) return false;
        return true;
      });
      if (keep.length === wires.length) break;
      wires.length = 0;
      wires.push(...keep);
    }
  }

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
    unmapped,
    route,
    unconnected,
  };
}
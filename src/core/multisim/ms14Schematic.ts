import type { MsSchematic, MsPart, MsConnector, MsNet, Pt } from "./model.js";
import { parseSI } from "../components/base/componentValue.js";

/**
 * Reading a Multisim 14 document into the neutral schematic model.
 *
 * `ms14.ts` gets the XML out of the container; this makes a schematic of it. The
 * document is a serialized MFC object graph, so nothing is where a schematic
 * format would put it — but everything needed is there, in four kinds of object:
 *
 *   CiComponent   a part: its refdes, its type name and its parameter values
 *   CiPort        one connection of one part, by name — the netlist's unit
 *   CiNode        one net: its name and the ports on it
 *   CIITSymbolComp  the *placed* symbol, with a pin per port and its transform
 *   CIITLinkComp    one drawn wire run, and the net it carries
 *
 * The two halves are tied together by ids: a placed pin carries `PortID`, which
 * is the `CiID` of its `CiPort`, and that port names both its part and its
 * connection. So the geometry and the connectivity can be read independently and
 * joined without guessing — which is the one thing the Live format makes hard
 * (see msjs.ts, where a pin has to be found through a symbol's SVG).
 *
 * Three things need translating rather than copying, and they are the reason this
 * is a reader and not a parser:
 *
 *  - **Strings** are tagged with their encoding: `&ASC…` for plain text, `&UNI…`
 *    for text with non-ASCII in it, where each such character is escaped as
 *    `_uc1<hex>` (`0.1_uc103bc` is `0.1µ`). The tags are stripped here so nothing
 *    downstream has to know.
 *  - **Parameters are positional.** A part carries a SPICE template
 *    (`r%p %t1 %t2 #1`) and a flat list of values; `#n` indexes that list. The
 *    neutral model wants them by name, as Multisim Live spells them, so each type
 *    says which slot is which (see `TYPES`).
 *  - **Type names** are Multisim 14's internal ones (`RESISTOR_VIRTUAL`,
 *    `DC_POWER`), not Live's (`Resistor`, `DC Voltage`). The converter knows the
 *    latter, so they are mapped here.
 *
 * The document is not well-formed XML — Multisim writes unescaped quotes into
 * some attribute values (`InfoBoxText="&ASC V: --"ShowInfo="1"`), which a strict
 * parser rejects and every one of the 91 bundled files contains. Hence the
 * tolerant scan below rather than `DOMParser`.
 */

/**
 * One element of the document: its tag, attributes and children.
 *
 * The tag is what identifies an object, not the `Class` attribute — every object
 * sits in an `<Item Class="…">` wrapper carrying the *same* class, so matching on
 * the attribute finds the wrapper (which holds no data) half the time.
 */
interface El {
  tag: string;
  attrs: Record<string, string>;
  kids: El[];
}

/**
 * Multisim's own string escapes, undone.
 *
 * `&ASC` and `&UNI` say how the rest is encoded, and in a `&UNI` string every
 * character outside ASCII is written `_uc1<codepoint in hex>`. Both markers are
 * dropped; the `_uc1` escapes become the characters they name, so a capacitance
 * arrives as `0.1µ` and `si()` can turn the µ into SPICE's `u`.
 */
function text(raw: string | undefined): string {
  if (!raw) return "";
  // XML's own escapes first — the markers themselves arrive as `&amp;ASC`.
  const plain = raw.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_m, e: string) => {
    if (e === "amp") return "&";
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    return String.fromCodePoint(e.startsWith("#x") ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
  return plain
    .replace(/^&(ASC|UNI)/, "")
    .replace(/_uc1([0-9a-fA-F]{4})/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

/** Attributes of one tag body, tolerant of a stray quote in a value. */
function attrsOf(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/**
 * The document as a tree.
 *
 * Only tags matter: every value in this format lives in an attribute, so element
 * text is not collected. A tag ending in `/` closes itself and does not go on the
 * stack; anything else does, and a closing tag pops it.
 */
export function parseMs14Xml(xml: string): El {
  const root: El = { tag: "#document", attrs: {}, kids: [] };
  const stack: El[] = [root];
  for (const m of xml.matchAll(/<([!?/]?)([\w:.-]+)((?:[^>"]|"[^"]*")*)>/g)) {
    const [, kind, tag, body] = m;
    if (kind === "!" || kind === "?") continue;
    if (kind === "/") {
      // Only ever pop back to the root, so a stray close cannot unbalance the
      // rest of the document.
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el: El = { tag, attrs: attrsOf(body), kids: [] };
    stack[stack.length - 1].kids.push(el);
    // The closing slash has to be read off the body: it is not quoted, so a
    // pattern that scans up to ">" swallows it, and every `<Item …/>` then stayed
    // open — which flattens the whole document into one branch. Each placed
    // symbol then saw every pin in the file.
    if (!/\/\s*$/.test(body)) stack.push(el);
  }
  return root;
}

/** Every element under `el`, in document order. */
function* walk(el: El): Generator<El> {
  for (const kid of el.kids) {
    yield kid;
    yield* walk(kid);
  }
}

/** The first descendant object of a given class, or undefined. */
function firstOf(el: El, cls: string): El | undefined {
  for (const d of walk(el)) if (d.tag === cls) return d;
  return undefined;
}

/**
 * The `<strings>` of an object's first `CiaCollString`.
 *
 * Multisim keeps a part's catalogue entry in one of these, and the entry's second
 * string is the part type — `RESISTOR_VIRTUAL`, `AC_VOLTAGE`, `AND2`. The first
 * is its family (`RESISTOR`, `SIGNAL_VOLTAGE_SOURCES`), which is not specific
 * enough to convert from.
 */
function catalogue(el: El): string[] {
  // The *first* such collection is not always the catalogue entry. A virtual
  // instrument — the multimeter, the oscilloscope, the wattmeter — carries an
  // all-blank one where a part has its family and type, and states what it is in
  // the next collection along ("Mulmeter", "Oscilloscope"). Read as the first
  // one regardless, every instrument came out with an empty type name, and the
  // converter reported it as a part it had no entry for.
  //
  // So the first collection that says anything wins. For an ordinary part that
  // is the same collection as before — theirs is filled.
  for (const d of walk(el)) {
    if (d.tag !== "CiaCollString") continue;
    const strings = d.kids.find((k) => k.tag === "strings");
    const values = (strings?.kids ?? []).map((i) => text(i.attrs.Value));
    if (values.some((v) => v !== "")) return values;
  }
  return [];
}

/**
 * A part's *string* parameters, which a template indexes as `%Sn`.
 *
 * A separate list from the numeric one and easy to miss: they sit side by side
 * under the same `CiaParamList`. Only the behavioural sources use it, and for
 * them it holds the whole part — the expression.
 */
function stringValues(el: El): string[] {
  const list = firstOf(el, "CiaParamList");
  const strings = list?.kids.find((k) => k.tag === "strings");
  return (strings?.kids ?? []).map((i) => text(i.attrs.Value));
}

/** A part's parameter values, in the order `#n` indexes them. */
function paramValues(el: El): string[] {
  const list = firstOf(el, "CiaParamList");
  const params = list?.kids.find((k) => k.tag === "parameters");
  return (params?.kids ?? []).map((i) => text(i.attrs.Value));
}

/**
 * What a Multisim 14 part is, in the vocabulary the converter already speaks.
 *
 * `name` is the Multisim Live type name — the neutral model's naming, so both
 * readers hand the converter the same thing (see model.ts). `params` maps the
 * parameter names Live uses onto the slot `#n` this type keeps them in, read off
 * the part's own SPICE template: `r%p %t1 %t2 #1` puts the resistance in slot 1,
 * and `sin(#3 #1 #5 …)` puts an AC source's offset in 3 and its amplitude in 1.
 *
 * Only the types the bundled corpus actually contains are listed, most-used
 * first. Anything missing arrives with its Multisim 14 name and is reported by
 * the converter as a part it cannot place, which is the same treatment an unknown
 * Live part gets.
 */
const TYPES: Record<string, {
  name: string;
  params?: Record<string, number>;
  fixed?: Record<string, string>;
  /** Connections this part spells differently from the type it maps onto. */
  conns?: Record<string, string>;
}> = {
  RESISTOR_VIRTUAL: { name: "Resistor", params: { Resistance: 1 } },
  RESISTOR: { name: "Resistor", params: { Resistance: 1 } },
  CAPACITOR_VIRTUAL: { name: "Capacitor", params: { Capacitance: 1 } },
  CAPACITOR: { name: "Capacitor", params: { Capacitance: 1 } },
  INDUCTOR_VIRTUAL: { name: "Inductor", params: { Inductance: 1 } },
  INDUCTOR: { name: "Inductor", params: { Inductance: 1 } },

  DC_POWER: { name: "DC Voltage", params: { DC_mag: 1 } },
  DC_CURRENT: { name: "DC Current", params: { DC_mag: 1 } },
  // `dc #3 ac #13 #15 … sin(#3 #1 #5 #7 #9 #11)`: offset, amplitude, frequency,
  // delay, damping, phase — the same six SPICE's SIN() takes.
  AC_VOLTAGE: { name: "AC Voltage", params: { VO: 3, VA: 1, Freq: 5, TD: 7, DF: 9, Phase: 11 } },
  AC_CURRENT: { name: "AC Current", params: { VO: 3, VA: 1, Freq: 5, TD: 7, DF: 9, Phase: 11 } },
  // The clock states frequency and duty cycle where SPICE wants a period and a
  // pulse width; `derived` below does that arithmetic.
  CLOCK_VOLTAGE: { name: "Clock Voltage", params: { VP: 5, TR: 7, TF: 9 } },
  PULSE_VOLTAGE: { name: "Pulse Voltage", params: { VI: 1, VP: 3, TD: 5, TR: 7, TF: 9, PW: 11, Per: 13 } },
  // Both come out as a pulse, but neither is a slot mapping — the step needs a
  // period that never comes round and the triangle's peak is a sum (see derived).
  STEP_VOLTAGE: { name: "Pulse Voltage" },
  TRIANGULAR_VOLTAGE: { name: "Pulse Voltage" },

  OPAMP_3T_VIRTUAL: { name: "3 Terminal Opamp" },
  OPAMP_5T_VIRTUAL: { name: "5 Terminal Opamp" },
  COMPARATOR_VIRTUAL: { name: "Ideal Comparator" },

  DIODE: { name: "Diode" },
  MYDIODE: { name: "Diode" },
  ZENER: { name: "Zener" },
  MYZENER: { name: "Zener" },
  LED_RED_RATED: { name: "LED" },
  // Multisim's configurable LED, which is the same part with its forward current
  // and its capacitance exposed as parameters. Neither reaches our LED — it
  // carries the model name and nothing else — so this is the alias alone.
  LED_red: { name: "LED" },
  BJT_NPN: { name: "NPN" },
  "2N2222": { name: "NPN" },
  MMBF4393LT1G: { name: "JFET N" },

  NOT: { name: "Inverter" },
  BUFFER: { name: "Buffer" },

  // An SR latch is the storage cell without its clock: our flip-flop already
  // asserts on SET and RESET whatever the clock does, so wiring S and R to those
  // and leaving the data and clock pins open *is* the latch. It is a stand-in —
  // the part comes out with two pins it did not have — and the conversion says so.
  SR_FF: { name: "D Flip-Flop", conns: { S: "SET", R: "RESET" } },

  // Multisim 14 files the adjustable regulator under the housing letter and
  // carries a vendor SPICE model with it; the converter knows the part under its
  // plain name and pulls in library/sub/LM317.lib. IN/ADJ/OUT are spelled the
  // same on both sides, so this is the alias and nothing more.
  LM317H: { name: "LM317" },

  POTENTIOMETER_VIRTUAL: { name: "Potentiometer", params: { Resistance: 5, Key: 3 } },

  // The hand-operated switches. Their two contact resistances are the only
  // thing the format states about them — the position is not saved at all, only
  // the hotkey that toggles it (see `manualSwitchClosed` in the converter).
  SPST: { name: "SPST", params: { R_ON: 3, R_OFF: 5 } },
  SPDT: { name: "SPDT", params: { R_ON: 3, R_OFF: 5 } },

  // The voltage-controlled switches. Multisim's own `.subckt VC_SPST/VC_SPDT`
  // takes `Von Voff Ron Roff` in that order, and its parameter list keeps each
  // value in the odd slot after its flag — so the four numbers sit in 1, 3, 5, 7.
  // Our models take the same two thresholds and two resistances (see
  // library/sub/vcspst.lib), which is why they can be handed straight over.
  VOLTAGE_CONTROLLED_SPST: {
    name: "Voltage Controlled SPST",
    params: { V_ON: 1, V_OFF: 3, R_ON: 5, R_OFF: 7 },
  },
  VOLTAGE_CONTROLLED_SPDT: {
    name: "Voltage Controlled SPDT",
    params: { V_ON: 1, V_OFF: 3, R_ON: 5, R_OFF: 7 },
  },

  D_FF: { name: "D Flip-Flop" },
  JK_FF: { name: "JK Flip-Flop" },

  // The behavioural sources: a value stated as an expression over the circuit
  // rather than as a waveform. Their parameter is a string, not a number (see
  // stringValues), and the node names in it are rewritten by the converter.
  ABM_VOLTAGE: { name: "Behavioral Voltage Source" },
  ABM_CURRENT: { name: "Behavioral Current Source" },
  VOLTAGE_CONTROLLED_VOLTAGE_SOURCE: { name: "Voltage Controlled Voltage Source", params: { Gain: 1 } },

  // Multisim 14 names the instrumentation amplifier after the ordering code; the
  // converter already knows it under the Live name, with the same connection
  // names on both sides, so this is the alias and nothing more.
  INA333AIDGKR: { name: "INA333" },

  // The PWL source is the converter's "Arbitrary Voltage Source": it takes the
  // time/value pairs as one string and turns them into a SPICE `PWL(...)`,
  // nudging Multisim's duplicated timestamps apart on the way. Only the pairs
  // themselves have to be dug out of the slots (see derived).
  PIECEWISE_LINEAR_VOLTAGE: { name: "Arbitrary Voltage Source" },

  // Measuring instruments are not parts of the circuit, but leaving them out
  // takes their node with them. Each becomes the thing SPICE measures with: an
  // ammeter is a source of 0 V (the classic current probe, and it even reads out
  // as I(V…)), a voltmeter the high resistance it is.
  AMMETER_H: { name: "DC Voltage", fixed: { DC_mag: "0" } },
  AMMETER_V: { name: "DC Voltage", fixed: { DC_mag: "0" } },
  VOLTMETER_H: { name: "Resistor", fixed: { Resistance: "10Meg" } },
  VOLTMETER_V: { name: "Resistor", fixed: { Resistance: "10Meg" } },

  // The 74LS138 and the display it drives. Both are library parts on our side;
  // the connection names are the same on both, so nothing has to be renamed.
  "74LS138D": { name: "74LS138" },
  SEVEN_SEG_COM_A: { name: "7-Segment Display Common Anode" },

  // The DIP switch pack. Its four positions are not read: Multisim files the
  // same value pair for all four switches whatever their drawn state, so there
  // is nothing to carry over (see dipsw4.lib).
  DSWPK_4: { name: "DIP Switch 4" },

  // The transistor switch with its body diode. `.subckt TRANSISTOR_DIODE_S1
  // upper lower ctrlp params: CtrlOn TranRon TranRoff TranVon DiodeRon DiodeRoff
  // DiodeVon` — seven values, each in the odd slot after its flag.
  TRANSISTOR_DIODE: {
    name: "Transistor Switch with Diode",
    params: {
      CtrlOn: 1, TranRon: 3, TranRoff: 5, TranVon: 7,
      DiodeRon: 9, DiodeRoff: 11, DiodeVon: 13,
    },
  },

  // The transformer states its windings in an embedded XML block rather than in
  // the parameter slots, so its numbers are dug out separately (see `derived`).
  "1P1S": { name: "Transformer" },

  // The wattmeter is the two meters in one housing: a voltage path across the
  // load and a current path through it. Both halves have to stay, or the branch
  // the current path carries is broken — so it is the one instrument that
  // becomes a part rather than a name (library/sub/wattmeter.lib).
  Wattmtr: { name: "Wattmeter" },
};

/** How the multimeter is wired decides what it is; see `settleMultimeters`. */
const MULTIMETER = "Mulmeter";

/**
 * The oscilloscope's inputs, as the net-name suffix each one earns.
 *
 * A scope reads and does not load: carried over as a part it would be four
 * terminals with nothing behind them. So it goes the way a probe does — dropped,
 * with its *name* left on the nodes it watched, which is the one thing about them
 * worth keeping. Multisim numbers the connections and lays them out in pairs:
 * 1/4 is channel A, 2/5 channel B, 3/6 the external trigger. Only the positive
 * of each pair is named; the negatives are the returns and are normally grounded,
 * so a name there would fight with the ground the net already has.
 */
const SCOPE_CHANNELS: Record<string, string> = { "1": "A", "2": "B", "3": "T" };

/**
 * The 74xx logic packages, by the gate one of their sections is.
 *
 * A package holds four (or six) gates and Multisim places one *section* at a
 * time, so what is on the sheet is a gate — with its pins named for the section
 * it belongs to (`1A`, `1B`, `1Y` for the first). Which gate the package is, is
 * the only thing that has to be looked up; how many inputs it has, the placed
 * section says itself.
 *
 * The supply pins are shared by every section and drawn on none of them, so they
 * arrive without a position (see the pin loop) and are simply not placed.
 */
const LOGIC_ICS: Record<string, string> = {
  "7400N": "NAND", "7402N": "NOR", "7404N": "Inverter", "7408N": "AND", "7432N": "OR",
  "7428N": "NOR", "74LS04D": "Inverter", "74LS27N": "NOR", "74S11N": "AND", "74F11D": "AND",
};

/** The Live name of a gate with `n` inputs, as the converter's table spells it. */
function gateName(kind: string, n: number): string {
  if (kind === "Inverter" || kind === "Buffer") return kind;
  return `${n}-Input ${kind}`;
}

/**
 * Multisim's measuring probes: a name on a node, not a part.
 *
 * A probe has one pin and no model — it marks a node the author wanted to watch.
 * Carried over as a part it would be a terminal connected to nothing; carried
 * over as nothing, the node it marks loses the one thing about it worth keeping.
 * So the probe is dropped and its *name* goes onto its net, which is what the
 * converted schematic then shows as a label.
 */
const PROBES = /^PROBE(_|$)/;

/**
 * Parameters this type states differently from the way SPICE wants them.
 *
 * The clock is the case: Multisim gives frequency and duty cycle, its own
 * template turns them into `<#3*0.01/#1>` and `<1/#1>`, and the converter's
 * `pulse()` expects the period and the pulse width outright. The arithmetic
 * belongs to the reading, not to the emitter — the Live format states the same
 * two numbers the same way.
 */
/**
 * The transformer's windings, out of the `<ComponentDefinition>` it carries.
 *
 * This one part keeps its numbers in an XML document stuffed into a string
 * attribute rather than in the parameter slots, so it has to be dug out by hand:
 * `<Primary turns="0.2" Resistance="10m"/>`, `<Secondary turns="1" …/>`,
 * `<ConstantInductance value="50u"/>`.
 *
 * *Two* such blocks are present, and they disagree — the catalogue's default
 * (turns 10 : 1) and the instance's own, edited copy (0.2 : 1). The instance's
 * comes second, and it is the one Multisim's own generated netlist agrees with:
 * that netlist reads `Es1 s1pos s1neg value={V(p1pos,p1neg)*1/0.2}`, i.e. a
 * secondary five times the primary, which is 1 / 0.2 and not 1 / 10. So the last
 * block wins. Read the first instead and this transformer would come out fifty
 * times off — with nothing anywhere to say so.
 */
function transformerWindings(def: El): Record<string, string> {
  let out: Record<string, string> = {};
  for (const d of walk(def)) {
    const xml = text(d.attrs.Value);
    if (!xml.includes("<Transformer")) continue;
    const primary = /<Primary\b[^>]*\bturns="([^"]+)"/.exec(xml);
    const secondary = /<Secondary\b[^>]*\bturns="([^"]+)"/.exec(xml);
    const np = parseSI(primary?.[1] ?? "");
    const ns = parseSI(secondary?.[1] ?? "");
    if (!np || !ns) continue;
    const found: Record<string, string> = { Ratio: String(ns / np) };
    const lm = /<ConstantInductance\b[^>]*\bvalue="([^"]+)"/.exec(xml)?.[1];
    if (lm) found.Lm = lm;
    const rp = /<Primary\b[^>]*\bResistance="([^"]+)"/.exec(xml)?.[1];
    if (rp) found.Rp = rp;
    const rs = /<Secondary\b[^>]*\bResistance="([^"]+)"/.exec(xml)?.[1];
    if (rs) found.Rs = rs;
    out = found;
  }
  return out;
}

function derived(type: string, slots: string[], def: El): Record<string, string> {
  // Multisim states these with SI suffixes ("100m"), so plain parseFloat would
  // read a hundred milliseconds as a hundred seconds.
  const num = (i: number) => parseSI(slots[i] ?? "") ?? NaN;

  if (type === "CLOCK_VOLTAGE") {
    const freq = num(1);
    const duty = num(3);
    if (!Number.isFinite(freq) || freq <= 0) return {};
    const period = 1 / freq;
    const width = Number.isFinite(duty) ? (period * duty) / 100 : period / 2;
    return { Per: period.toPrecision(6), PW: width.toPrecision(6) };
  }

  // A step is one edge and then nothing, which SPICE has no source for: the
  // nearest is a pulse whose period outlasts the analysis. Multisim writes it as
  // `pwl(0 #1 #5 #1 {#5+#7} #3 …)` — start at #1, reach #3 at #5, taking #7 to
  // get there. `NEVER` is what "and then nothing" costs: a pulse that would come
  // back after eleven days.
  if (type === "STEP_VOLTAGE") {
    const step = num(5);
    if (!Number.isFinite(step)) return {};
    return {
      VI: slots[1] ?? "0", VP: slots[3] ?? "0",
      TD: slots[5] ?? "0", TR: slots[7] || "1n", TF: "1n",
      PW: NEVER, Per: NEVER,
    };
  }

  // A triangle is a pulse with no flat top, all of whose period is spent rising
  // and falling: `pulse(#9 {#1+#9} #7 {#3-#5} #5 0 #3)`. The one sum in there —
  // the peak sits #1 above the offset #9 — is why this cannot be a slot mapping.
  if (type === "TRIANGULAR_VOLTAGE") {
    const amp = num(1), period = num(3), fall = num(5), offset = num(9);
    if (![amp, period, fall, offset].every(Number.isFinite) || period <= 0) return {};
    return {
      VI: String(offset), VP: String(offset + amp),
      TD: slots[7] || "0", TR: String(period - fall), TF: String(fall),
      PW: "0", Per: String(period),
    };
  }

  // Multisim keeps the pairs as a run of slots with their *count* in front:
  // the template says `pwl(%f11:10:1)` — read from slot 11, as many as slot 10
  // says. Written out as the one string the converter's `pwl()` expects, so the
  // reading of the format stays here and the SPICE end of it stays there.
  if (type === "PIECEWISE_LINEAR_VOLTAGE") {
    const count = num(10);
    if (!Number.isFinite(count) || count < 2) return {};
    const pairs = slots.slice(11, 11 + count).filter((v) => v !== undefined && v !== "");
    if (pairs.length < 2) return {};
    return { "Time/Voltage pairs": pairs.join(" ") };
  }

  if (type === "1P1S") return transformerWindings(def);

  return {};
}

/**
 * A pulse period long enough that the pulse never repeats — for the sources that
 * are one edge rather than a train. Eleven days: past any transient analysis
 * these sheets ask for, and still far short of where a double loses resolution.
 */
const NEVER = "1e6";

/** Multisim 14's connectors: parts in the file, a symbol on the sheet for us. */
const CONNECTORS: Record<string, string> = {
  GROUND: "ground",
  DGND: "ground",
  // A supply rail is a name on a net, exactly like Live's plain connector.
  VCC: "VCC",
  V_REF2: "V_REF2",
};

/** Rename one connection of a part, keeping every table that mentions it in step. */
function rename(
  from: string, to: string,
  pins: Record<string, Pt>, connPin: Record<string, string>, connNames: string[],
): void {
  if (pins[from]) { pins[to] = pins[from]; delete pins[from]; }
  if (connPin[from]) { connPin[to] = connPin[from]; delete connPin[from]; }
  const i = connNames.indexOf(from);
  if (i >= 0) connNames[i] = to;
}

/** The transform an object carries, in the converter's matrix vocabulary. */
function matrixOf(attrs: Record<string, string>): Record<string, number> {
  const n = (k: string, d: number) => {
    const v = parseFloat(attrs[k]);
    return Number.isFinite(v) ? v : d;
  };
  return {
    a: n("Transformer-M00", 1), b: n("Transformer-M01", 0),
    c: n("Transformer-M10", 0), d: n("Transformer-M11", 1),
    e: n("Transformer-M20", 0), f: n("Transformer-M21", 0),
  };
}

/**
 * Decide what each multimeter is, from how it was wired.
 *
 * Multisim's multimeter is one part with a front panel: whether it reads volts
 * or amperes is a setting of the *instrument window*, not of the circuit, and it
 * is not in the file at all. But the wiring says it anyway, and unambiguously —
 * a meter in series is an ammeter, a meter across something is a voltmeter — so
 * that is what is read here.
 *
 * A terminal sitting on a net with exactly two pins is the tell: the meter is
 * then the only way out of that node, so the branch runs *through* it. Anything
 * else and the meter hangs across a node the circuit already joins elsewhere.
 *
 * Getting it wrong is not symmetrical, which is why it is worth deciding rather
 * than defaulting. A voltmeter mistaken for an ammeter puts 0 V across two live
 * nodes — the sheet is then shorted and the answer is not merely inaccurate. An
 * ammeter mistaken for a voltmeter puts 10 MΩ in a branch, which starves it but
 * leaves the rest of the circuit standing.
 *
 * Both stand-ins are the ones Multisim's own dedicated meters already map onto,
 * so a converted multimeter reads out exactly like a converted ammeter does.
 */
function settleMultimeters(parts: MsPart[], nets: MsNet[]): void {
  /** Port id → how many pins sit on its net. */
  const netSize = new Map<string, number>();
  for (const net of nets) {
    for (const q of net.pins) netSize.set(q.pin, net.pins.length);
  }
  for (const part of parts) {
    if (part.typeName !== MULTIMETER) continue;
    const inSeries = Object.values(part.connPin).some((id) => netSize.get(id) === 2);
    part.typeName = inSeries ? "DC Voltage" : "Resistor";
    part.params = inSeries ? { DC_mag: "0" } : { Resistance: "10Meg" };
  }
}

/**
 * The neutral schematic a Multisim 14 document describes.
 *
 * Coordinates stay in the file's own units, as with the Live reader; the
 * schematic says what one of them is worth (`unit`) and the converter scales.
 */
export function ms14ToSchematic(xml: string): MsSchematic {
  const doc = parseMs14Xml(xml);

  // ── the object graph, by id ───────────────────────────────────────────────
  // Every object sits in an `<Item>` carrying its id: `CiID` for the electrical
  // half (components, ports, nodes), `ID` for the drawn half.
  const byCiId = new Map<string, El>();
  for (const el of walk(doc)) {
    if (el.tag !== "Item" || !el.attrs.CiID || !el.attrs.Class) continue;
    const obj = el.kids.find((k) => k.tag === el.attrs.Class);
    if (obj) byCiId.set(el.attrs.CiID, obj);
  }

  /** Port id → the part it belongs to and the connection it is. */
  const ports = new Map<string, { component: string; conn: string; type: string }>();
  for (const [id, obj] of byCiId) {
    if (obj.tag !== "CiPort") continue;
    ports.set(id, {
      component: obj.attrs.Component ?? "",
      conn: text(obj.attrs.LocalName),
      type: catalogue(obj)[1] ?? "",
    });
  }

  // ── parts ────────────────────────────────────────────────────────────────
  // A placed symbol names its definition (`CiComponent`), and its pins name
  // their ports — so a part can be assembled from both halves at once.
  const parts: MsPart[] = [];
  const connectors: MsConnector[] = [];
  /** Port a probe was attached to → the probe's name (see PROBES). */
  const probeNames = new Map<string, string>();
  for (const sym of walk(doc)) {
    if (sym.tag !== "CIITSymbolComp") continue;
    const defId = sym.attrs.CiComponent;
    const def = defId ? byCiId.get(defId) : undefined;
    if (!def) continue;

    const ms14Type = catalogue(def)[1] ?? "";
    const slots = paramValues(def);
    const strings = stringValues(def);
    const refdes = text(def.attrs.LocalName);

    // Pins: the connector inside a pin holds the point, and it is symbol-local —
    // where the symbol sits is a transform, which the two writers of this format
    // put in different places. Most files state it on the placed symbol; some
    // state it on every pin instead and leave the symbol without one. Whichever
    // is present is the placement, and the symbol wins where both are: taking the
    // pin's there put a whole sheet's parts on top of each other at the corner,
    // because a pin that is not itself displaced carries the identity. Checked
    // against the drawn wire ends, which land on the symbol's transform.
    const pins: Record<string, Pt> = {};
    const pinsById: Record<string, Pt> = {};
    const connPin: Record<string, string> = {};
    const connNames: string[] = [];
    let matrix = sym.attrs["Transformer-M20"] !== undefined ? matrixOf(sym.attrs) : undefined;
    for (const pin of walk(sym)) {
      if (pin.tag !== "CIITPinSymbolComp") continue;
      const portId = pin.attrs.PortID;
      const spot = firstOf(pin, "CIITPinConnectorComp");
      if (!portId || !spot) continue;
      // The port says what this connection is called; the pin's own `PinName` is
      // what the *symbol* prints, which for a two-terminal part is the pin
      // number and for an op-amp is the same name by a different route.
      const conn = ports.get(portId)?.conn ?? text(pin.attrs.PinName);
      connPin[conn] = portId;
      if (!connNames.includes(conn)) connNames.push(conn);

      // A pin the symbol does not draw carries no transform, and its connector
      // sits at the symbol's own origin. It is a real connection all the same —
      // the supply pins of a 74xx package are shared by all four of its gates and
      // appear on none of their symbols — so it keeps its entry in `connPin`,
      // which is what the net list refers to, and gets no *coordinate*. Given one
      // it would be a terminal at (0,0), i.e. wherever the sheet's corner is.
      if (pin.attrs["Transformer-M20"] === undefined) continue;
      const at: Pt = [parseFloat(spot.attrs.ptCenterX ?? "0"), parseFloat(spot.attrs.ptCenterY ?? "0")];
      pins[conn] = at;
      pinsById[portId] = at;
      matrix ??= matrixOf(pin.attrs);
    }

    // A probe is dropped, and its name noted for the net it sat on (see PROBES).
    if (PROBES.test(ms14Type)) {
      for (const portId of Object.values(connPin)) probeNames.set(portId, refdes);
      continue;
    }

    // The oscilloscope goes the same way, one name per channel (see
    // SCOPE_CHANNELS): `XSC1_A`, `XSC1_B`. The nets it watched then carry the
    // reading the author set the scope up to take, instead of a bare number.
    if (ms14Type === "scope") {
      for (const [conn, channel] of Object.entries(SCOPE_CHANNELS)) {
        const portId = connPin[conn];
        if (portId !== undefined) probeNames.set(portId, `${refdes}_${channel}`);
      }
      continue;
    }

    // Ground and the supply rails are parts in this format and symbols on the
    // sheet for us, exactly as in the Live reader.
    const kind = CONNECTORS[ms14Type];
    if (kind) {
      const spot = firstOf(sym, "CIITPinConnectorComp");
      const m = matrix ?? matrixOf(sym.attrs);
      // The connector's own point, so it lands where its pin does.
      const at: Pt = spot
        ? [parseFloat(spot.attrs.ptCenterX ?? "0"), parseFloat(spot.attrs.ptCenterY ?? "0")]
        : [0, 0];
      connectors.push({
        guid: defId!,
        kind,
        matrix: { ...m, e: m.a * at[0] + m.c * at[1] + m.e, f: m.b * at[0] + m.d * at[1] + m.f },
      });
      continue;
    }

    // A gate is named by its function and its input count in both worlds, only
    // spelled differently: `AND3` here, "3-Input AND" there.
    const gate = /^(AND|OR|NAND|NOR|XOR|XNOR)(\d+)$/.exec(ms14Type);
    let typeName = TYPES[ms14Type]?.name ?? (gate ? `${gate[2]}-Input ${gate[1]}` : ms14Type);

    // Connections the mapped-to type spells differently (an SR latch's S and R
    // are our flip-flop's asynchronous SET and RESET).
    for (const [from, to] of Object.entries(TYPES[ms14Type]?.conns ?? {})) {
      rename(from, to, pins, connPin, connNames);
    }

    // A 74xx section is a gate, and its pins carry the section number. Strip it,
    // so the connections are the `A`, `B`, `Y` the converter's gate table names —
    // each section is its own placed part, so two of them cannot collide.
    if (LOGIC_ICS[ms14Type]) {
      for (const conn of [...connNames]) {
        const m = /^\d+([A-Z]+)$/.exec(conn);
        if (!m || m[1] === conn) continue;
        rename(conn, m[1], pins, connPin, connNames);
      }
      typeName = gateName(LOGIC_ICS[ms14Type], connNames.filter((c) => c !== "Y").length);
    }

    const mapped = TYPES[ms14Type];
    const params: Record<string, string> = { ...mapped?.fixed };
    for (const [name, slot] of Object.entries(mapped?.params ?? {})) {
      const v = slots[slot];
      if (v !== undefined && v !== "") params[name] = v;
    }
    Object.assign(params, derived(ms14Type, slots, def));
    // A behavioural source *is* its expression (`%S0` in its template), and it
    // still speaks Multisim's node names here — the converter translates them,
    // because only it knows what the nets end up being called.
    if (/^ABM_(VOLTAGE|CURRENT)$/.test(ms14Type) && strings[0]) params.Expression = strings[0];

    // Multisim 14 writes the refdes as one string ("R1", "Uh"), where Live keeps
    // the prefix and the number apart. Split it the way Live would.
    const rd = /^([^\d]*)(\d*)$/.exec(refdes) ?? [];

    parts.push({
      guid: defId!,
      typeName,
      refdes: { prefix: rd[1] || undefined, number: rd[2] || null },
      matrix: matrix ?? matrixOf(sym.attrs),
      pins,
      pinsById,
      connPin,
      connNames,
      // Multisim 14 has no second standard to choose between: its schematic
      // symbols are the DIN ones these sheets were drawn with.
      symbolDescription: ":IEC:",
      params,
    });
  }

  // ── nets ─────────────────────────────────────────────────────────────────
  // Nets are collected by name, not one per node object: Multisim 14 keeps a
  // *node per sheet region* and calls every one of them "0", so a file has half a
  // dozen ground nodes that are one net. Two nets with the same name are the same
  // net — that is what a name is for — and left apart the conversion connects
  // each of them separately and none of them to the others.
  const byName = new Map<string, MsNet>();
  for (const [, obj] of byCiId) {
    if (obj.tag !== "CiNode") continue;
    const list = obj.kids.find((k) => k.tag === "Ports");
    const pins: { component: string; pin: string }[] = [];
    for (const item of list?.kids ?? []) {
      const id = item.attrs.CiID;
      const port = id ? ports.get(id) : undefined;
      if (port) pins.push({ component: port.component, pin: id! });
    }
    if (!pins.length) continue;
    // A net Multisim only numbered, but which carried a probe, takes the probe's
    // name: that is what the author called the node, and a numbered net comes out
    // of the conversion as `N5`. A name the file gave the net itself always wins.
    const named = text(obj.attrs.LocalName);
    const probe = pins.map((q) => probeNames.get(q.pin)).find(Boolean);
    const name = probe && /^\d+$/.test(named) ? probe : named;
    const known = byName.get(name);
    if (known) known.pins.push(...pins);
    else byName.set(name, { name, pins });
  }
  const nets = [...byName.values()];
  settleMultimeters(parts, nets);

  // ── wires ────────────────────────────────────────────────────────────────
  // One `CIITLinkComp` is one run of points, already in sheet coordinates. It
  // also names the net it carries, which nothing needs — the ports say that
  // authoritatively — but it is what makes a wire a wire rather than a line.
  const wires = [];
  for (const link of walk(doc)) {
    if (link.tag !== "CIITLinkComp") continue;
    const pts = link.kids.find((k) => k.tag === "Points");
    const path: Pt[] = (pts?.kids ?? []).map((i) => [
      parseFloat(i.attrs.X ?? "0"), parseFloat(i.attrs.Y ?? "0"),
    ]);
    if (path.length >= 2) wires.push({ path });
  }

  // Multisim 14 draws nine units to the grid square, ours is 16.
  return { unit: 16 / 9, parts, connectors, wires, junctions: [], texts: [], nets };
}

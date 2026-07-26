import type { MsSchematic, MsPart, MsConnector, MsNet, Pt } from "./model.js";

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
  const coll = firstOf(el, "CiaCollString");
  const strings = coll?.kids.find((k) => k.tag === "strings");
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
const TYPES: Record<string, { name: string; params?: Record<string, number> }> = {
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

  OPAMP_3T_VIRTUAL: { name: "3 Terminal Opamp" },
  OPAMP_5T_VIRTUAL: { name: "5 Terminal Opamp" },
  COMPARATOR_VIRTUAL: { name: "Ideal Comparator" },

  DIODE: { name: "Diode" },
  MYDIODE: { name: "Diode" },
  ZENER: { name: "Zener" },
  MYZENER: { name: "Zener" },
  LED_RED_RATED: { name: "LED" },
  BJT_NPN: { name: "NPN" },
  "2N2222": { name: "NPN" },
  MMBF4393LT1G: { name: "JFET N" },

  NOT: { name: "Inverter" },
  AND2: { name: "2-Input AND" },
  AND3: { name: "3-Input AND" },
  AND4: { name: "4-Input AND" },
  OR2: { name: "2-Input OR" },
  OR3: { name: "3-Input OR" },
  XOR2: { name: "2-Input XOR" },

  POTENTIOMETER_VIRTUAL: { name: "Potentiometer", params: { Resistance: 5, Key: 3 } },
};

/**
 * Parameters this type states differently from the way SPICE wants them.
 *
 * The clock is the case: Multisim gives frequency and duty cycle, its own
 * template turns them into `<#3*0.01/#1>` and `<1/#1>`, and the converter's
 * `pulse()` expects the period and the pulse width outright. The arithmetic
 * belongs to the reading, not to the emitter — the Live format states the same
 * two numbers the same way.
 */
function derived(type: string, slots: string[]): Record<string, string> {
  if (type !== "CLOCK_VOLTAGE") return {};
  const freq = parseFloat(slots[1] ?? "");
  const duty = parseFloat(slots[3] ?? "");
  if (!Number.isFinite(freq) || freq <= 0) return {};
  const period = 1 / freq;
  const width = Number.isFinite(duty) ? (period * duty) / 100 : period / 2;
  return { Per: period.toPrecision(6), PW: width.toPrecision(6) };
}

/** Multisim 14's connectors: parts in the file, a symbol on the sheet for us. */
const CONNECTORS: Record<string, string> = {
  GROUND: "ground",
  DGND: "ground",
  // A supply rail is a name on a net, exactly like Live's plain connector.
  VCC: "VCC",
  V_REF2: "V_REF2",
};

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
 * The neutral schematic a Multisim 14 document describes.
 *
 * Coordinates stay in the file's own units, as with the Live reader — the
 * converter scales. Multisim 14 draws on a 9-unit grid where Live uses 1, so the
 * two differ by a factor the converter applies via `GRID`.
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
  for (const sym of walk(doc)) {
    if (sym.tag !== "CIITSymbolComp") continue;
    const defId = sym.attrs.CiComponent;
    const def = defId ? byCiId.get(defId) : undefined;
    if (!def) continue;

    const ms14Type = catalogue(def)[1] ?? "";
    const slots = paramValues(def);
    const refdes = text(def.attrs.LocalName);

    // Pins: the connector inside a pin holds the point, the pin itself holds the
    // placement. Both are needed — the point is symbol-local.
    const pins: Record<string, Pt> = {};
    const pinsById: Record<string, Pt> = {};
    const connPin: Record<string, string> = {};
    const connNames: string[] = [];
    let matrix: Record<string, number> | undefined;
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

    const mapped = TYPES[ms14Type];
    const params: Record<string, string> = {};
    for (const [name, slot] of Object.entries(mapped?.params ?? {})) {
      const v = slots[slot];
      if (v !== undefined && v !== "") params[name] = v;
    }
    Object.assign(params, derived(ms14Type, slots));

    // Multisim 14 writes the refdes as one string ("R1", "Uh"), where Live keeps
    // the prefix and the number apart. Split it the way Live would.
    const rd = /^([^\d]*)(\d*)$/.exec(refdes) ?? [];

    parts.push({
      guid: defId!,
      typeName: mapped?.name ?? ms14Type,
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
  const nets: MsNet[] = [];
  for (const [, obj] of byCiId) {
    if (obj.tag !== "CiNode") continue;
    const list = obj.kids.find((k) => k.tag === "Ports");
    const pins: { component: string; pin: string }[] = [];
    for (const item of list?.kids ?? []) {
      const id = item.attrs.CiID;
      const port = id ? ports.get(id) : undefined;
      if (port) pins.push({ component: port.component, pin: id! });
    }
    if (pins.length) nets.push({ name: text(obj.attrs.LocalName), pins });
  }

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

  return { parts, connectors, wires, junctions: [], texts: [], nets };
}

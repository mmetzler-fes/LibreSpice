#!/usr/bin/env node
/**
 * Multisim Live (`.msjs`) → LTSpice (`.asc`) converter.
 *
 * Multisim Live was retired; this recovers the schematics from a backup export.
 * The `.msjs` container is `"msjs-2.0"` + a uint32-LE payload length + UTF-8
 * JSON + a `XXXX` trailer. Everything we need sits in three places:
 *
 *   blueprints.components   part *types* (name, refdes prefix, conn↔pin map)
 *   blueprints.symbols      SVG artwork; pin coordinates live in `oecl:` attrs
 *   sheettemplates[].template   the placed schematic: parts, wires, connectors
 *   sheettemplates[].instances  per-part refdes and model parameter values
 *
 * Multisim places parts with an SVG matrix {a,b,c,d,e,f} on a 1-unit grid and
 * draws wires as polylines on that same grid. One Multisim unit is 16 LTSpice
 * units, and Multisim's rotation convention (x,y)→(-y,x) at 90° is LTSpice's
 * `R90`, so geometry carries over directly — see GRID and orientation() below.
 *
 * Usage: node scripts/convert-multisim.mjs <input-dir> [--out <dir>]
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

/** LTSpice units per Multisim grid unit. */
const GRID = 16;

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

/** Unwrap the `.msjs` container and return its JSON payload. */
function readMsjs(path) {
  const buf = readFileSync(path);
  if (buf.subarray(0, 8).toString("ascii") !== "msjs-2.0") {
    throw new Error("not an msjs-2.0 file");
  }
  const len = buf.readUInt32LE(8);
  return JSON.parse(buf.subarray(12, 12 + len).toString("utf8"));
}

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
const TYPES = {
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
const DISCRETE_PINS = { npn: ["C", "B", "E"], pnp: ["C", "B", "E"], njf: ["D", "G", "S"], diode: ["A", "K"] };
const DISCRETE_PREFIX = { npn: "Q", pnp: "Q", njf: "J", diode: "D" };

for (const [name, sym] of Object.entries(DISCRETES)) {
  TYPES[name] = { sym, prefix: DISCRETE_PREFIX[sym], pins: DISCRETE_PINS[sym], value: () => name };
}

/** LTSpice pin offsets from the symbol origin, before rotation. */
const PIN_OFFSETS = {
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
};

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

/** Normalise a Multisim value for SPICE (µ → u, strip blanks). */
function si(v) {
  if (v === undefined || v === null || v === "") return "";
  return String(v).replace(/[μµ]/g, "u").trim();
}

/** `AC Voltage`/`AC Current` carry a SPICE SIN() source's parameters. */
function sine(p) {
  const f = (k, d) => si(p[k]) || d;
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
function uniqueName(prefix, number, used) {
  let n = number;
  if (n === null || n === undefined || used.has(`${prefix}${n}`)) {
    n = 1;
    while (used.has(`${prefix}${n}`)) n++;
  }
  const name = `${prefix}${n}`;
  used.add(name);
  return name;
}

/**
 * Flatten Multisim's `{modelGuid: {param: {stringvalue}}}` levels into one
 * plain `{param: value}` map. Later arguments win.
 */
function flatten(...levels) {
  const out = {};
  for (const level of levels) {
    for (const params of Object.values(level ?? {})) {
      for (const [k, v] of Object.entries(params ?? {})) {
        if (v?.stringvalue !== undefined) out[k] = v.stringvalue;
      }
    }
  }
  return out;
}

/**
 * Lamp resistance from its ratings: R = U²/P.
 *
 * Falls back to 1 kΩ if a lamp carries no ratings, so it stays a finite load
 * instead of shorting the branch it sits in.
 */
function lampResistance(p) {
  const u = parseFloat(si(p["Maximum rated voltage"]));
  const w = parseFloat(si(p["Maximum rated power"]));
  if (!Number.isFinite(u) || !Number.isFinite(w) || w <= 0) return "1k";
  return String(Number((u * u / w).toPrecision(4)));
}

/** Pulse/clock/step/triangle sources all map onto SPICE PULSE(). */
function pulse(p) {
  const f = (k, d) => si(p[k]) || d;
  return `PULSE(${f("VI", "0")} ${f("VP", "1")} ${f("TD", "0")} ${f("TR", "1n")} ${f("TF", "1n")} ${f("PW", "0.5m")} ${f("Per", "1m")})`;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Pin coordinates of a Multisim symbol, in Multisim grid units.
 *
 * The artwork is SVG: an outer `<g transform="scale(s) translate(tx,ty)">`
 * wraps one `<g oecl:pinid="N">` per pin, each holding a `<g transform=
 * "translate(x,y)" oecl:pin=...>` at the connection point. Multisim's own
 * comment notes the scale exists "to make it match the OECL Pin Grid"; after it,
 * ten SVG units are one grid unit.
 */
function symbolPins(svg) {
  const outer = /<g transform="scale\(([-\d.]+)\)\s*translate\(([-\d.]+),\s*([-\d.]+)\)"/.exec(svg);
  const s = outer ? parseFloat(outer[1]) : 1;
  const tx = outer ? parseFloat(outer[2]) : 0;
  const ty = outer ? parseFloat(outer[3]) : 0;

  const pins = {};
  const groups = svg.split(/<g oecl:pinid="/).slice(1);
  for (const g of groups) {
    const id = g.slice(0, g.indexOf('"'));
    // The connection point is the inner group carrying `oecl:pin`.
    const m = /<g[^>]*transform="translate\(([-\d.]+),\s*([-\d.]+)\)"[^>]*oecl:pin=/.exec(g);
    if (!m) continue;
    pins[id] = [
      ((parseFloat(m[1]) + tx) * s) / 10,
      ((parseFloat(m[2]) + ty) * s) / 10,
    ];
  }
  return pins;
}

/** Apply a Multisim placement matrix to a symbol-local point. */
function applyMatrix(m, [x, y]) {
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
function fitOrientation(offsets, want, anchorIdx) {
  let best = null;
  for (const o of ORIENTATIONS) {
    const rot = rotate(offsets[anchorIdx], o.deg, o.mirrored);
    const origin = [want[anchorIdx][0] - rot[0], want[anchorIdx][1] - rot[1]];
    let err = 0;
    for (let i = 0; i < offsets.length; i++) {
      if (!want[i] || !offsets[i]) continue;
      const r = rotate(offsets[i], o.deg, o.mirrored);
      err += (origin[0] + r[0] - want[i][0]) ** 2 + (origin[1] + r[1] - want[i][1]) ** 2;
    }
    if (best === null || err < best.err) best = { ...o, origin, err };
  }
  return { ...best, str: `${best.mirrored ? "M" : "R"}${best.deg}` };
}

/** Rotate a symbol-local offset the way LTSpice does: R90 maps (x,y)→(-y,x). */
function rotate([x, y], deg, mirrored) {
  if (mirrored) x = -x;
  switch (deg) {
    case 90: return [-y, x];
    case 180: return [-x, -y];
    case 270: return [y, -x];
    default: return [x, y];
  }
}

// ---------------------------------------------------------------------------
// Switches
// ---------------------------------------------------------------------------

/** Resistance standing in for a closed / open switch contact. */
const R_CLOSED = "1n";
const R_OPEN = "1G";

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
const SWITCHES = {
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
function emitSwitch(part, inst, doc, spec, ctx) {
  const { symbolLines, directives, pinPos, used } = ctx;

  const base = uniqueName(`R${inst?.refdes?.prefix || "S"}`, inst?.refdes?.number, used);

  const params = Object.values(inst?.modelinstancedata ?? {})[0] ?? {};
  const state = parseInt(params.State?.stringvalue ?? "0", 10) || 0;

  const symId = inst?.activesymbol;
  const map = {};
  const bp = doc.blueprints?.components?.[part.component]?.component;
  for (const sc of bp?.symbolConfigurations ?? []) {
    for (const sec of sc.sections ?? []) {
      if (sec.id === symId) for (const cp of sec.connPinMap ?? []) map[cp.connName] = cp.symbolPinID;
    }
  }
  const svgPins = symbolPins(doc.blueprints?.symbols?.[symId]?.svg ?? "");

  const RES = PIN_OFFSETS.res;
  const span = RES[1][1] - RES[0][1];
  const anchorConn = spec.paths[0][0];
  const anchorLocal = svgPins[map[anchorConn]];
  const anchor = anchorLocal ? applyMatrix(part.matrix, anchorLocal).map(ctx.to) : [0, 0];

  const at = (conn, p) => { const id = map[conn]; if (id !== undefined) pinPos[`${part.guid}/${id}`] = p; };

  spec.paths.forEach(([from, to], i) => {
    // With two contacts, `State` picks which one is closed; a single contact is
    // simply open or closed as saved.
    const closed = spec.stateDrivesPath ? state === i : state === 1;
    const name = spec.paths.length > 1 ? `${base}${"ab"[i]}` : base;
    directives.push(`.param ${name}=${closed ? R_CLOSED : R_OPEN}`);

    // Contacts of a changeover switch share their first terminal, so set them
    // side by side and tie the shared ends together rather than stacking them.
    const origin = [anchor[0] - RES[0][0] + i * 96, anchor[1] - RES[0][1]];
    symbolLines.push(`SYMBOL res ${origin[0]} ${origin[1]} R0`);
    symbolLines.push(`SYMATTR InstName ${name}`);
    symbolLines.push(`SYMATTR Value {${name}}`);

    const top = [origin[0] + RES[0][0], origin[1] + RES[0][1]];
    const bottom = [origin[0] + RES[1][0], origin[1] + RES[1][1]];
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
function emitPotentiometer(part, inst, doc, ctx) {
  const { symbolLines, directives, pinPos, used } = ctx;

  // A pot's refdes already carries an R prefix ("R4", "Rp"), so use it as is.
  const base = uniqueName(inst?.refdes?.prefix || "Rp", inst?.refdes?.number, used);

  const params = Object.values(inst?.modelinstancedata ?? {})[0] ?? {};
  const total = si(params.Res?.stringvalue) || "1k";
  const pos = parseFloat(params.PosPercent?.stringvalue ?? "50") / 100;

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

  const symId = inst?.activesymbol;

  // Stack the two halves along the track, anchored where the pot's first
  // terminal sat. They need not line up with the old wiring — the net-list
  // reconciliation below labels them onto the right nets either way.
  const svgPins = symbolPins(doc.blueprints?.symbols?.[symId]?.svg ?? "");
  const end1 = svgPins["1"] ? applyMatrix(part.matrix, svgPins["1"]).map(ctx.to) : [0, 0];
  const RES = PIN_OFFSETS.res;
  const span = RES[1][1] - RES[0][1];
  const originA = [end1[0] - RES[0][0], end1[1] - RES[0][1]];
  const originB = [originA[0], originA[1] + span];

  symbolLines.push(`SYMBOL res ${originA[0]} ${originA[1]} R0`);
  symbolLines.push(`SYMATTR InstName ${upper}`);
  symbolLines.push(`SYMATTR Value {${upper}}`);
  symbolLines.push(`SYMBOL res ${originB[0]} ${originB[1]} R0`);
  symbolLines.push(`SYMATTR InstName ${lower}`);
  symbolLines.push(`SYMATTR Value {${lower}}`);

  // Terminal 1 → top of the upper half, wiper → the shared node, terminal 3 →
  // bottom of the lower half. Keyed by symbol pin id, as the net list is.
  const map = {};
  const bp = doc.blueprints?.components?.[part.component]?.component;
  for (const sc of bp?.symbolConfigurations ?? []) {
    for (const sec of sc.sections ?? []) {
      if (sec.id === symId) for (const cp of sec.connPinMap ?? []) map[cp.connName] = cp.symbolPinID;
    }
  }
  const at = (conn, p) => { const id = map[conn]; if (id !== undefined) pinPos[`${part.guid}/${id}`] = p; };
  at("1", [originA[0] + RES[0][0], originA[1] + RES[0][1]]);
  at("2", [originB[0] + RES[0][0], originB[1] + RES[0][1]]);
  at("3", [originB[0] + RES[1][0], originB[1] + RES[1][1]]);
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

/** Union-find over schematic points. */
class Union {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    while (this.parent.get(x) !== x) {
      this.parent.set(x, this.parent.get(this.parent.get(x)));
      x = this.parent.get(x);
    }
    return x;
  }
  union(a, b) {
    a = this.find(a); b = this.find(b);
    if (a !== b) this.parent.set(a, b);
  }
}

const key = (p) => `${p[0]},${p[1]}`;

/**
 * Which points the emitted wiring ties together.
 *
 * LTSpice joins two wires wherever they share a point — including a T, where one
 * wire's end touches another's interior — so a plain endpoint union would miss
 * the taps that make up most of these schematics.
 */
function wireGroups(wires, points) {
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
 * Add net labels wherever the drawn geometry leaves one Multisim net split
 * across several disconnected islands. Returns the FLAG lines to append.
 */
function reconcile(netList, pinPos, wires, existingFlags) {
  // Ground already has FLAGs from the connector symbols; take their points into
  // account so a grounded pin isn't labelled a second time under another name.
  const flagPts = existingFlags.map((f) => {
    const m = /^FLAG (-?\d+) (-?\d+)/.exec(f);
    return m ? [Number(m[1]), Number(m[2])] : null;
  }).filter(Boolean);

  const allPts = [...Object.values(pinPos), ...flagPts];
  const uf = wireGroups(wires, allPts);

  const out = [];
  for (const net of netList) {
    const pts = [];
    for (const obj of net.objects ?? []) {
      const p = pinPos[`${obj.component}/${obj.pin}`];
      if (p) pts.push(p);
    }
    if (pts.length < 2) continue;

    // Multisim's node 0 is ground; LTSpice spells that label "0" as well.
    const name = /^\d+$/.test(net.name) ? (net.name === "0" ? "0" : `N${net.name}`) : net.name;

    const islands = new Map();
    for (const p of pts) {
      const root = uf.find(key(p));
      if (!islands.has(root)) islands.set(root, p);
    }
    // One island means the wires already join every pin on this net.
    if (islands.size < 2) continue;
    for (const p of islands.values()) out.push(`FLAG ${p[0]} ${p[1]} ${name}`);
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
function cutCrossings(wires, junctions) {
  const marked = new Set(junctions.map((p) => key(p)));
  const drop = new Set();

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
function findShorts(netList, pinPos, wires, flags) {
  const pts = Object.values(pinPos);
  const uf = wireGroups(wires, pts);
  for (const f of flags) {
    const m = /^FLAG (-?\d+) (-?\d+) (.+)/.exec(f);
    if (m) uf.union(key([Number(m[1]), Number(m[2])]), `label:${m[3].trim()}`);
  }

  // Which Multisim net each group ended up carrying; a group holding two is a
  // short between them.
  const groupNet = new Map();
  const shorts = new Set();
  for (const net of netList) {
    for (const obj of net.objects ?? []) {
      const p = pinPos[`${obj.component}/${obj.pin}`];
      if (!p) continue;
      const root = uf.find(key(p));
      const prev = groupNet.get(root);
      if (prev === undefined) groupNet.set(root, net.name);
      else if (prev !== net.name) shorts.add([prev, net.name].sort().join(" = "));
    }
  }
  return [...shorts];
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function convert(doc) {
  const tpl = doc.sheettemplates?.[0];
  if (!tpl) throw new Error("no sheet template");
  const sheet = tpl.template;
  const skipped = [];
  /** Parts replaced by a stand-in rather than converted one-to-one. */
  const substituted = [];

  // Blueprint lookups: part type info and symbol artwork by id.
  const blueprints = doc.blueprints?.components ?? {};
  const symbols = doc.blueprints?.symbols ?? {};

  // Instance data (refdes, parameter values) is keyed by the placed part's guid.
  const instances = {};
  for (const inst of tpl.instances ?? []) {
    for (const cs of inst.componentsections ?? []) instances[cs.guid] = cs;
  }

  const wires = [];
  const flags = [];
  const symbolLines = [];
  /** SPICE directives the conversion itself needs (pot parameters, …). */
  const directives = [];
  /** `<part guid>/<conn name>` → the pin's final LTSpice position. */
  const pinPos = {};

  const to = (v) => Math.round(v * GRID);

  // Reserve every refdes Multisim spelled out, so auto-numbering cannot take a
  // name a later part already claims.
  const used = new Set();
  for (const part of sheet.parts ?? []) {
    const bp = blueprints[part.component]?.component;
    const cs = instances[part.guid];
    const num = cs?.refdes?.number;
    if (!bp || num === null || num === undefined) continue;
    const prefix = TYPES[bp.name]?.forcePrefix
      || (SWITCHES[bp.name] || bp.name === "Potentiometer" ? "R" : null)
      || cs?.refdes?.prefix || TYPES[bp.name]?.prefix;
    if (prefix) used.add(`${prefix}${num}`);
  }

  // --- placed parts -------------------------------------------------------
  for (const part of sheet.parts ?? []) {
    const bp = blueprints[part.component]?.component;
    if (!bp) continue;

    const ctx = { symbolLines, directives, pinPos, used, wires, to };

    if (bp.name === "Potentiometer") {
      emitPotentiometer(part, instances[part.guid], doc, ctx);
      continue;
    }

    if (SWITCHES[bp.name]) {
      const dropped = emitSwitch(part, instances[part.guid], doc, SWITCHES[bp.name], ctx);
      if (dropped.length) substituted.push(`${bp.name} (Steuereingang ${dropped.join("/")} entfällt)`);
      else substituted.push(bp.name);
      continue;
    }

    const type = TYPES[bp.name];
    if (!type) {
      skipped.push(bp.name);
      continue;
    }
    const inst = instances[part.guid];
    const offsets = PIN_OFFSETS[type.sym] ?? [];

    // The symbol Multisim actually drew tells us which pin id belongs to which
    // logical connection — the same part has different pin ids per symbol
    // variant (IEC vs ANSI), so the map has to come from the active symbol.
    const symId = inst?.activesymbol;
    let connToPin = {};
    for (const sc of bp.symbolConfigurations ?? []) {
      for (const sec of sc.sections ?? []) {
        if (sec.id === symId) {
          for (const cp of sec.connPinMap ?? []) connToPin[cp.connName] = cp.symbolPinID;
        }
      }
    }
    const svgPins = symbolPins(symbols[symId]?.svg ?? "");

    // Prefer the IEC artwork when Multisim used it — these are German teaching
    // schematics and the box resistor is what the source drawings show.
    const isIec = /:IEC:/.test(symbols[symId]?.description ?? "");
    const symName = isIec && type.euro ? type.euro : type.sym;
    const useOffsets = PIN_OFFSETS[symName] ?? offsets;

    // Where each pin sits on the Multisim sheet, in LTSpice coordinates.
    const want = [];
    for (let i = 0; i < type.pins.length; i++) {
      const conn = type.pins[i];
      const pid = conn === null ? undefined : connToPin[conn];
      const local = pid !== undefined ? svgPins[pid] : undefined;
      want.push(local ? applyMatrix(part.matrix, local).map(to) : null);
    }
    const anchorIdx = want.findIndex((p) => p !== null);
    if (anchorIdx === -1) { skipped.push(bp.name); continue; }

    const { deg, mirrored, str, origin } = fitOrientation(useOffsets, want, anchorIdx);
    symbolLines.push(`SYMBOL ${symName} ${origin[0]} ${origin[1]} ${str}`);

    // Refdes: Multisim leaves the number null on single-instance designs, so
    // number those ourselves per prefix rather than emitting a bare "R".
    const prefix = type.forcePrefix || inst?.refdes?.prefix || type.prefix;
    symbolLines.push(`SYMATTR InstName ${uniqueName(prefix, inst?.refdes?.number, used)}`);

    // Ratings can sit on either level — a lamp keeps its voltage and power in
    // `modeldefinitiondata` while a resistor keeps its value in
    // `modelinstancedata`. Instance data wins where both carry a key.
    const flat = flatten(inst?.modeldefinitiondata, inst?.modelinstancedata);
    const value = type.value(flat);
    if (value) symbolLines.push(`SYMATTR Value ${value}`);

    // Where LTSpice's pin spacing differs from Multisim's, the Multisim wire
    // still ends at the original point — bridge the gap with a stub so the net
    // stays connected instead of silently breaking.
    for (let i = 0; i < want.length; i++) {
      if (!useOffsets[i]) continue;
      const r = rotate(useOffsets[i], deg, mirrored);
      const ax = origin[0] + r[0];
      const ay = origin[1] + r[1];
      // The net list identifies a pin by its *symbol* pin id, which is not the
      // connection name — Multisim's stock parts routinely map conn "1" to
      // symbol pin "2". Keying these by connection name silently tied each part
      // to the wrong net.
      const pid = type.pins[i] === null ? undefined : connToPin[type.pins[i]];
      if (pid !== undefined) pinPos[`${part.guid}/${pid}`] = [ax, ay];
      if (!want[i]) continue;
      if (ax !== want[i][0] || ay !== want[i][1]) {
        // Route the stub as an L so it stays on the orthogonal grid rather than
        // cutting diagonally across the sheet.
        wires.push([ax, ay, want[i][0], ay]);
        wires.push([want[i][0], ay, want[i][0], want[i][1]]);
      }
    }
  }

  // --- ground and other connectors ---------------------------------------
  for (const c of sheet.connectors ?? []) {
    if (c.component === "ground") {
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
  for (const w of sheet.wires ?? []) {
    const path = w.path ?? [];
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
  const routed = cutCrossings(wires, (sheet.junctions ?? []).map((j) => [to(j.position.x), to(j.position.y)]));
  wires.length = 0;
  wires.push(...routed);
  flags.push(...reconcile(doc.nets ?? [], pinPos, wires, flags));

  // --- free-standing text -------------------------------------------------
  const texts = [];
  const textValue = {};
  for (const inst of tpl.instances ?? []) {
    for (const t of inst.texts ?? []) textValue[t.guid] = t.variableName;
  }
  for (const t of sheet.texts ?? []) {
    if (!t.standalone || !t.visibility) continue;
    const v = textValue[t.guid];
    if (!v) continue;
    // LTSpice keeps a comment on one line; Multisim's free text is multi-line.
    const body = v.split("\n").map((l) => l.trim()).filter(Boolean).join(" \\n ");
    texts.push(`TEXT ${to(t.matrix.e)} ${to(t.matrix.f)} Left 2 ;${body}`);
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
    shorts: findShorts(doc.nets ?? [], pinPos, cleanWires, flags),
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/**
 * Write up what the conversion could not carry over.
 *
 * Ordered by how many schematics each missing part blocks, because that is the
 * order in which adding support pays off.
 */
function buildReport(results) {
  const L = [];
  const total = results.length;
  const clean = results.filter((r) => !r.error && !r.skipped.length);

  L.push("Konvertierung Multisim Live (.msjs) -> LTSpice (.asc)");
  L.push("=".repeat(60));
  L.push("");
  L.push(`Erzeugt am:            ${new Date().toISOString().slice(0, 10)}`);
  L.push(`Schaltungen gesamt:    ${total}`);
  L.push(`Vollstaendig:          ${clean.length}`);
  L.push(`Mit fehlenden Teilen:  ${total - clean.length}`);
  L.push("");

  // --- 1. by part type ---
  const byPart = new Map();
  for (const r of results) {
    for (const p of r.skipped) {
      if (!byPart.has(p)) byPart.set(p, []);
      byPart.get(p).push(r.name);
    }
  }
  L.push("1. FEHLENDE BAUTEILE (nach betroffenen Schaltungen)");
  L.push("-".repeat(60));
  L.push("");
  if (!byPart.size) L.push("  keine");
  for (const [part, hits] of [...byPart].sort((a, b) => b[1].length - a[1].length)) {
    L.push(`  ${String(hits.length).padStart(3)}x  ${part}`);
  }
  L.push("");

  // --- 2. per schematic ---
  L.push("2. BETROFFENE SCHALTUNGEN");
  L.push("-".repeat(60));
  L.push("");
  for (const r of results) {
    if (r.error) L.push(`  ${r.name}\n        FEHLER: ${r.error}`);
    else if (r.skipped.length) L.push(`  ${r.name}\n        ${r.skipped.join(", ")}`);
  }
  L.push("");

  // --- 3. substitutions ---
  const subs = results.filter((r) => r.substituted.length);
  L.push("3. ERSETZTE BAUTEILE (konvertiert, aber als Ersatzmodell)");
  L.push("-".repeat(60));
  L.push("");
  L.push("  Schalter werden als Parameterwiderstand abgebildet:");
  L.push(`    geschlossen = ${R_CLOSED}   offen = ${R_OPEN}`);
  L.push("  Der Wert steht als .param in der Schaltung und laesst sich dort");
  L.push("  umschalten. Die gespeicherte Schalterstellung ist voreingestellt.");
  L.push("");
  L.push("  Potentiometer werden als zwei Widerstaende mit gemeinsamem");
  L.push("  Stellungsparameter T_<name> abgebildet.");
  L.push("");
  L.push("  ACHTUNG: Spannungsgesteuerte Schalter verlieren ihren Steuer-");
  L.push("  eingang - ein Widerstand kann keinem Steuersignal folgen. Diese");
  L.push("  Kontakte sind danach statisch, die Schaltung simuliert also nicht");
  L.push("  mehr dasselbe Verhalten wie im Original.");
  L.push("");
  for (const r of subs) L.push(`  ${r.name}\n        ${r.substituted.join(", ")}`);
  L.push("");

  // --- 4. shorts ---
  const sh = results.filter((r) => r.shorts.length);
  L.push("4. KURZGESCHLOSSENE NETZE");
  L.push("-".repeat(60));
  L.push("");
  L.push("  Hier verbindet die uebernommene Verdrahtung zwei Netze, die in");
  L.push("  Multisim getrennt waren. Diese Schaltungen vor Gebrauch pruefen.");
  L.push("");
  if (!sh.length) L.push("  keine");
  for (const r of sh) L.push(`  ${r.name}\n        ${r.shorts.join(", ")}`);
  L.push("");

  return L.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const inDir = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outDir = outIdx !== -1 ? args[outIdx + 1] : "converted_from_multisim";
  if (!inDir) {
    console.error("usage: node scripts/convert-multisim.mjs <input-dir> [--out <dir>]");
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const files = readdirSync(inDir).filter((f) => f.endsWith(".msjs")).sort();
  let ok = 0;
  const gaps = [];
  const shorted = [];
  const results = [];
  for (const f of files) {
    const name = basename(f, ".msjs");
    try {
      const { asc, skipped, substituted, shorts } = convert(readMsjs(join(inDir, f)));
      writeFileSync(join(outDir, `${name}.asc`), asc, "latin1");
      ok++;
      results.push({ name, skipped, substituted, shorts });
      if (skipped.length) gaps.push(`  ${name}: ${skipped.join(", ")}`);
      if (shorts.length) shorted.push(`  ${name}: ${shorts.join(", ")}`);
    } catch (e) {
      results.push({ name, skipped: [], substituted: [], shorts: [], error: e.message });
      gaps.push(`  ${name}: FEHLER ${e.message}`);
    }
  }

  const reportPath = join(outDir, "Konvertierungsfehler.txt");
  writeFileSync(reportPath, buildReport(results), "utf8");
  console.log(`${ok}/${files.length} Dateien nach ${outDir}/ konvertiert`);
  if (shorted.length) {
    console.log(`\n${shorted.length} Schaltungen mit kurzgeschlossenen Netzen (Drahtkreuzung):`);
    console.log(shorted.join("\n"));
  }
  if (gaps.length) {
    console.log(`\n${gaps.length} Schaltungen mit nicht abbildbaren Bauteilen:`);
    console.log(gaps.join("\n"));
  }
}

main();

/**
 * What a Multisim schematic is, once it has been read.
 *
 * There are two Multisim file formats and they look nothing alike: Multisim
 * Live's `.msjs` is JSON with a part-type catalogue and SVG artwork, Multisim
 * 14's `.ms14` is a serialized MFC object graph (see ms14.ts). The conversion to
 * LTSpice is the same work in both cases, so it happens once, on this.
 *
 * The shape is deliberately *not* either format's. It is what the emitters
 * actually need, already resolved — the two readers do the resolving, each in
 * its own way, and neither leaks into the converter:
 *
 *   - the part's type is a **name** (`"Resistor"`, `"DC Power"`), not an id into
 *     a catalogue held somewhere else;
 *   - its pins are **coordinates**, not SVG to be parsed at use time;
 *   - its parameters are a **flat map** of Multisim's own parameter names.
 *
 * Coordinates are Multisim's own units throughout; the converter scales them.
 */

export type Pt = [number, number];

/** Multisim's 2D placement matrix, as the file spells it. */
export interface Matrix {
  m00?: number; m01?: number; m10?: number; m11?: number; m20?: number; m21?: number;
  [key: string]: number | undefined;
}

/** A part placed on the sheet. */
export interface MsPart {
  /** Identity within the sheet; the net list refers to parts by this. */
  guid: string;
  /** Multisim's part-type name, e.g. `Resistor`, `Potentiometer`, `AND2`. */
  typeName: string;
  /** Reference designator as Multisim spelled it, if it had one. */
  refdes: { prefix?: string; number?: string | null };
  /** Where and how the part sits. */
  matrix: Matrix;
  /** Connection name (`"1"`, `"Q"`, `"Y"`) → pin position in symbol-local units. */
  pins: Record<string, Pt>;
  /**
   * The same positions keyed by the *artwork's* pin id.
   *
   * Both are kept because both are used: a part's connections are named
   * (`"Q"`, `"Y"`), but a potentiometer is taken apart by walking the symbol's
   * own terminals, and the two namings do not always coincide.
   */
  pinsById: Record<string, Pt>;
  /**
   * Connection name → the artwork's pin id.
   *
   * The net list names a pin by its *id*, so this is what ties "the part's Q
   * output" to the entry the file's own connectivity refers to.
   */
  connPin: Record<string, string>;
  /** The type's connection names, in its own order. */
  connNames: string[];
  /**
   * The chosen artwork's description, verbatim.
   *
   * Multisim draws the same part in several standards and says which in here
   * (`:IEC:` for the box resistor). These are German teaching schematics, so
   * which one the author picked decides which symbol we write.
   */
  symbolDescription: string;
  /** Model and instance parameters, flattened to `name → value`. */
  params: Record<string, string>;
}

/** A ground or other connector placed directly on the sheet. */
export interface MsConnector {
  guid: string;
  /** `"ground"` for a ground symbol; other kinds keep Multisim's own name. */
  kind: string;
  matrix: Matrix;
}

/** A drawn wire, as the run of points it passes through. */
export interface MsWire {
  path: Pt[];
}

/** A free-standing text on the sheet. */
export interface MsText {
  text: string;
  position: Pt;
}

/**
 * One net as the file records it: the pins that belong together.
 *
 * Kept because it is *authoritative* where geometry is not — two pins Multisim
 * calls one net are one net even if our reconstruction of the wiring does not
 * quite touch (see `reconcile`).
 */
export interface MsNet {
  name?: string;
  /** Each entry names a part and one of its connections. */
  pins: { component: string; pin: string }[];
}

/** A whole schematic, ready to convert. */
export interface MsSchematic {
  /**
   * LTSpice units per unit of this file, so the converter can scale it.
   *
   * The two formats do not draw on the same grid, and neither draws on ours:
   * Multisim Live puts one grid square in one unit, Multisim 14 in nine. Left to
   * the converter this was a constant, and every `.ms14` came out nine times too
   * large — with the parts still their own size, which is how a sheet ends up
   * with its symbols scattered like dust.
   */
  unit: number;
  parts: MsPart[];
  connectors: MsConnector[];
  wires: MsWire[];
  /** Points where wires deliberately join rather than cross. */
  junctions: Pt[];
  texts: MsText[];
  nets: MsNet[];
}

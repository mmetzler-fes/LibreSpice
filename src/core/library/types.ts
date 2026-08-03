/**
 * Data model for the LTSpice-compatible component library.
 *
 * A library entry is either a `.model` directive (a parametrised device model
 * such as a diode or transistor) or a `.subckt` block (a multi-pin subcircuit).
 * Both carry the raw SPICE text so they can be re-emitted verbatim into the
 * generated netlist, plus a structured representation for the UI.
 */

/**
 * Where an imported entry lives:
 *   - `local`  persists to localStorage in this browser.
 *   - `temp`   lives only for the current session.
 *   - `server` comes from the file-backed library served by the backend
 *              (re-fetched on load; never written to localStorage).
 */
export type LibraryScope = "local" | "temp" | "server";

/**
 * A placeable component descriptor (LTSpice `cmp/`): links a graphical symbol
 * to an optional SPICE model and its pin order, so it can be dropped from the
 * "Insert Component" menu.
 */
export interface ComponentDescriptor {
  /** Component name shown in the menu, e.g. `1N4148`. */
  name: string;
  /** Base name of the `.asy` symbol to render. */
  symbol: string;
  /** SPICE instance prefix, e.g. `D`, `Q`, `X`. */
  prefix?: string;
  /** Linked `.model`/`.subckt` name, if any. */
  model?: string;
  /** Ordered pin names (falls back to the symbol's own pins when omitted). */
  pins?: string[];
  /**
   * Default instance parameters (`Rtot=10k wiper=0.5`), from the symbol's
   * `SYMATTR SpiceLine`. They go onto the `X` line of a newly placed part, so a
   * `.subckt` declared with `params:` is adjustable without the user having to
   * know its parameter names.
   */
  params?: string;
}

/**
 * Canonical base component a `.model` maps onto. `unknown` means the model type
 * is not one we have a dedicated symbol for – it is still registered so the user
 * can reference it manually, but it cannot be drag-placed as a typed device.
 */
export type ModelDeviceClass =
  | "diode"
  | "bjt_npn"
  | "bjt_pnp"
  | "mosfet_n"
  | "mosfet_p"
  | "jfet_n"
  | "jfet_p"
  | "resistor"
  | "capacitor"
  | "inductor"
  | "unknown";

/**
 * What a library file says about an entry for the reader's benefit, as opposed
 * to the simulator's: a readable name and a sentence about the part.
 *
 * Needed because a SPICE name is not always a part name. LTSpice's universal
 * op-amp is the plainest case: its symbol asks for `.subckt level2` (the "level"
 * is the model's complexity, not the device), so every schematic that uses it
 * writes `level2` — the name cannot be changed without breaking every saved
 * sheet — and the parts list read "level2", which names nothing at all.
 *
 * Written in the `.lib` as ordinary SPICE comments above the directive:
 *
 * ```
 * * Label: UniversalOpAmp2
 * * Description: Generic op-amp macromodel …
 * * Symbol: UniversalOpAmp2
 * .subckt level2 1 2 3 4 5
 * ```
 *
 * Comments, so the file stays a plain library that LTSpice and ngspice read
 * unchanged (see ModelParser.collectAnnotations).
 */
export interface EntryAnnotations {
  /** Readable name for the parts list; the SPICE name stays authoritative. */
  label?: string;
  /** One sentence on what the part is, shown as the entry's tooltip. */
  description?: string;
  /**
   * Base name of the `.asy` to draw the part with, e.g. `UniversalOpAmp2`.
   *
   * Without one a subcircuit is placed as the generic numbered box, which for a
   * part that has a symbol in the bundle is a worse drawing of something we can
   * already draw. The server library reaches the same conclusion from the other
   * side — it derives a descriptor from any `.asy` that names its model (see
   * libraryStore.fetchServerLibrary) — but that needs a backend, and the bundled
   * parts have to look right without one.
   */
  symbol?: string;
}

export interface SpiceModelDef extends EntryAnnotations {
  kind: "model";
  /** Model name, e.g. `1N4148`. */
  name: string;
  /** Raw type token as written, e.g. `D`, `NPN`, `VDMOS`. */
  type: string;
  /** Device class this maps onto for symbol/placement purposes. */
  deviceClass: ModelDeviceClass;
  /** Parsed `key=value` parameters (keys upper-cased). */
  params: Record<string, string>;
  /** Verbatim SPICE source, ready to splice into a netlist. */
  raw: string;
  /** Non-fatal issues encountered while parsing (unknown params, etc.). */
  warnings: string[];
}

export interface SubcircuitDef extends EntryAnnotations {
  kind: "subckt";
  /** Subcircuit name, e.g. `LM741`. */
  name: string;
  /** Ordered external pin names as declared on the `.subckt` line. */
  pins: string[];
  /** Body lines between `.subckt` and `.ends` (excluding both). */
  body: string;
  /** Verbatim SPICE source (including `.subckt`/`.ends`). */
  raw: string;
  warnings: string[];
}

export type LibraryEntry = SpiceModelDef | SubcircuitDef;

export interface ParseResult {
  entries: LibraryEntry[];
  /** Top-level warnings not attached to a specific entry. */
  warnings: string[];
}

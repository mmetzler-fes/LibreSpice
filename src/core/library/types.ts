/**
 * Data model for the LTSpice-compatible component library.
 *
 * A library entry is either a `.model` directive (a parametrised device model
 * such as a diode or transistor) or a `.subckt` block (a multi-pin subcircuit).
 * Both carry the raw SPICE text so they can be re-emitted verbatim into the
 * generated netlist, plus a structured representation for the UI.
 */

/** Where an imported entry lives. */
export type LibraryScope = "local" | "temp";

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
  | "jfet"
  | "resistor"
  | "capacitor"
  | "inductor"
  | "unknown";

export interface SpiceModelDef {
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

export interface SubcircuitDef {
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

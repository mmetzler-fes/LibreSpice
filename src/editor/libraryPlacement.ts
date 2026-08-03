import type { ModelDeviceClass } from "@core/library/types.js";
import type { ComponentDescriptor, LibraryEntry } from "@core/library/types.js";
import type { ComponentType } from "./nodes/ComponentNode.js";
import type { PendingLibraryPlacement } from "@store/uiStore.js";
import { symbolByName } from "@sym/asyParser.js";

/**
 * Maps a parsed model's device class onto an editor component type. Returns null
 * for classes we have no placeable symbol for (`unknown`, the switch models) –
 * those entries are still registered into the netlist but cannot be drag-placed.
 */
export function deviceClassToComponentType(cls: ModelDeviceClass): ComponentType | null {
  switch (cls) {
    case "diode": return "diode";
    case "bjt_npn": return "bjt_npn";
    case "bjt_pnp": return "bjt_pnp";
    case "mosfet_n": return "mosfet_n";
    case "mosfet_p": return "mosfet_p";
    case "jfet_n": return "jfet_n";
    case "jfet_p": return "jfet_p";
    case "resistor": return "resistor";
    case "capacitor": return "capacitor";
    case "inductor": return "inductor";
    default: return null;
  }
}

/** Builds the click-to-place payload for a library entry, or null if unplaceable. */
export function placementForEntry(entry: LibraryEntry): PendingLibraryPlacement | null {
  if (entry.kind === "subckt") {
    // A `.lib` may name the `.asy` it is drawn with (see EntryAnnotations); the
    // generic numbered box is the fallback for a subcircuit that has none. Only
    // a symbol we actually have counts — a name that resolves to nothing would
    // leave the part with no graphics at all rather than with the box.
    const sym = entry.symbol ? symbolByName(entry.symbol) : undefined;
    // With a symbol the pins get their real names: a `.subckt` declares them as
    // bare node numbers (`level2 1 2 3 4 5`), while the symbol says which is
    // In+ and which is a rail. Only when both agree on the count — a symbol for
    // a different part would silently re-label the wrong terminals — and by
    // SpiceOrder, which is the order the `X` line writes them in.
    const symPins = sym && sym.pins.length === entry.pins.length
      ? [...sym.pins].sort((a, b) => a.order - b.order).map((p) => p.name)
      : undefined;
    return {
      componentType: "subcircuit", name: entry.name, pins: symPins ?? entry.pins, raw: entry.raw,
      ...(sym ? { symbolName: entry.symbol } : {}),
    };
  }
  const type = deviceClassToComponentType(entry.deviceClass);
  if (!type) return null;
  return { componentType: type, name: entry.name, model: entry.name };
}

/**
 * Builds the placement payload for a server `cmp` descriptor. Resolves the
 * linked model/subckt entry (via `findEntry`) so the placed part simulates
 * correctly, while carrying the descriptor's custom `.asy` symbol for drawing.
 */
export function placementForDescriptor(
  d: ComponentDescriptor,
  findEntry: (name: string) => LibraryEntry | undefined,
): PendingLibraryPlacement | null {
  if (d.model) {
    const entry = findEntry(d.model);
    if (entry?.kind === "subckt") {
      return {
        componentType: "subcircuit",
        name: d.name,
        pins: d.pins ?? entry.pins,
        raw: entry.raw,
        symbolName: d.symbol,
        ...(d.params ? { params: d.params } : {}),
      };
    }
    if (entry?.kind === "model") {
      const type = deviceClassToComponentType(entry.deviceClass);
      if (type) return { componentType: type, name: d.name, model: entry.name };
    }
  }
  // No resolvable typed device: place as a subcircuit-style part with a custom
  // symbol (requires declared pins to build handles).
  if (d.pins && d.pins.length > 0) {
    return { componentType: "subcircuit", name: d.name, pins: d.pins, raw: "", symbolName: d.symbol };
  }
  return null;
}

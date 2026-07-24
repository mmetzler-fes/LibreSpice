import type { ModelDeviceClass } from "@core/library/types.js";
import type { ComponentDescriptor, LibraryEntry } from "@core/library/types.js";
import type { ComponentType } from "./nodes/ComponentNode.js";
import type { PendingLibraryPlacement } from "@store/uiStore.js";

/**
 * Maps a parsed model's device class onto an editor component type. Returns null
 * for classes we have no placeable symbol for (e.g. JFET, unknown) – those
 * entries are still registered into the netlist but cannot be drag-placed.
 */
export function deviceClassToComponentType(cls: ModelDeviceClass): ComponentType | null {
  switch (cls) {
    case "diode": return "diode";
    case "bjt_npn": return "bjt_npn";
    case "bjt_pnp": return "bjt_pnp";
    case "mosfet_n": return "mosfet_n";
    case "mosfet_p": return "mosfet_p";
    case "resistor": return "resistor";
    case "capacitor": return "capacitor";
    case "inductor": return "inductor";
    default: return null;
  }
}

/** Builds the click-to-place payload for a library entry, or null if unplaceable. */
export function placementForEntry(entry: LibraryEntry): PendingLibraryPlacement | null {
  if (entry.kind === "subckt") {
    return { componentType: "subcircuit", name: entry.name, pins: entry.pins, raw: entry.raw };
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

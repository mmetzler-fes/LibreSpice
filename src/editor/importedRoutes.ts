import type { Edge } from "@xyflow/react";
import type { WireData } from "./WireTool.js";

/**
 * When a part moves, the wires hanging off it may still be drawn along a path
 * copied from an imported schematic — a detour around where that part used to
 * be. This decides which of those paths to forget so the wire re-routes itself.
 *
 * Only wires flagged `autoRoute` are candidates; the flag is set by
 * LTSpiceParser for paths it reconstructed from the source drawing, and by
 * nothing else. Three kinds are deliberately left alone even so:
 *
 *  - a wire the user routed by hand (no flag) — re-routing would discard a
 *    decision they made on purpose;
 *  - one following a diagonal segment, which has to stay verbatim or its
 *    right-angle replacement can overlap a neighbouring net on re-import;
 *  - one tapped onto another wire, whose fixed tap point re-routing would
 *    strand.
 *
 * Pure, so the rule is testable without React (see importedRoutes.test).
 */
export function forgetImportedRoutes(edges: Edge[], movedIds: Set<string>): Edge[] | null {
  let changed = false;
  const next = edges.map((e) => {
    const d = e.data as WireData | undefined;
    if (!d?.autoRoute || d.diagonal || d.sourceTap || d.targetTap) return e;
    if (!movedIds.has(e.source) && !movedIds.has(e.target)) return e;
    changed = true;
    // Drop the flag with the path: once forgotten, the wire is an ordinary
    // straight-routed one and a later move has nothing left to reconsider.
    const { autoRoute: _drop, ...rest } = d;
    return { ...e, data: { ...rest, waypoints: [] } };
  });
  return changed ? next : null;
}

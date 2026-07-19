import type { FlowPoint } from "./WireTool.js";

/**
 * Geometry for the net-name tag a *wire* carries.
 *
 * Shared by the editor's `WireEdge` and the SVG export so the two cannot drift —
 * the same role `netLabelShape` plays for the node-based net label and net
 * connector. Pure geometry: no React, no store, no theme, so the export can call
 * it.
 *
 * Coordinates are in flow space, absolute (unlike `netLabelShape`, which is
 * node-local): a wire has no node box to anchor to.
 */

/** Character advance of the 10px monospace font used for the name tag. */
const CHAR_W = 6.8;
/** Height of a name tag box. */
const TAG_H = 15;

/**
 * The wire's net-name tag, which sits just above its anchor point (the dock
 * point plus the user's drag offset).
 */
export function wireNameTag(anchor: FlowPoint, name: string) {
  const width = name.length * CHAR_W + 8;
  return {
    x: anchor.x - width / 2, y: anchor.y - 19, width, height: TAG_H,
    textX: anchor.x, textY: anchor.y - 8,
  };
}

import type { ArrowDir, FlowPoint } from "./WireTool.js";

/**
 * Geometry for the labels a *wire* carries: the net-name tag and the
 * net-connector symbol (docking circle + direction arrow + its own name box).
 *
 * Shared by the editor's `WireEdge` and the SVG export so the two cannot drift —
 * the same role `netLabelShape` plays for the node-based net label. Both are
 * pure geometry: no React, no store, no theme, so the export can call them.
 *
 * Everything is in flow coordinates, absolute (unlike `netLabelShape`, which is
 * node-local): a wire has no node box to anchor to.
 */

/** Unit vector per connector arrow direction. */
export const ARROW_VEC: Record<ArrowDir, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

/** Character advance of the 10px monospace font used for both name tags. */
const CHAR_W = 6.8;
/** Height of a name tag box. */
const TAG_H = 15;

export interface WireConnectorShape {
  /** Hollow dock circle, sitting on the wire itself. */
  circle: { cx: number; cy: number; r: number };
  /** Arrow stem, from just outside the circle outward. */
  stem: { x1: number; y1: number; x2: number; y2: number };
  /** Arrowhead as an SVG polygon `points` string. */
  head: string;
  /** Name box just past the arrow tip, and its centred text anchor. */
  tag: { x: number; y: number; width: number; height: number; textX: number; textY: number };
}

/**
 * Connector symbol at a wire's dock point. The name box is centred just past the
 * arrow tip, offset along whichever axis the arrow runs, so it clears the head
 * in all four directions.
 */
export function wireConnectorShape(dock: FlowPoint, arrowDir: ArrowDir, name: string): WireConnectorShape {
  const [dx, dy] = ARROW_VEC[arrowDir] ?? ARROW_VEC.right;
  const r = 3.5, gap = 5, len = 22, headLen = 8, headHalf = 4.5;
  const x2 = dock.x + dx * len, y2 = dock.y + dy * len;
  const bx = dock.x + dx * (len - headLen), by = dock.y + dy * (len - headLen);
  const px = -dy, py = dx;
  const head = [
    `${x2},${y2}`,
    `${bx + px * headHalf},${by + py * headHalf}`,
    `${bx - px * headHalf},${by - py * headHalf}`,
  ].join(" ");
  const width = name.length * CHAR_W + 8;
  const tx = dock.x + dx * (len + 6 + (dx !== 0 ? width / 2 : 0));
  const ty = dock.y + dy * (len + 6 + (dy !== 0 ? TAG_H / 2 : 0));
  return {
    circle: { cx: dock.x, cy: dock.y, r },
    stem: { x1: dock.x + dx * gap, y1: dock.y + dy * gap, x2, y2 },
    head,
    tag: { x: tx - width / 2, y: ty - TAG_H / 2, width, height: TAG_H, textX: tx, textY: ty + 3.5 },
  };
}

/**
 * The wire's own net-name tag, which sits just above its anchor point (the dock
 * point plus the user's drag offset).
 */
export function wireNameTag(anchor: FlowPoint, name: string) {
  const width = name.length * CHAR_W + 8;
  return {
    x: anchor.x - width / 2, y: anchor.y - 19, width, height: TAG_H,
    textX: anchor.x, textY: anchor.y - 8,
  };
}

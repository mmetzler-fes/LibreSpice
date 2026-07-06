import { NODE_SIZE } from "./pinGeometry.js";

/** Local-space centre of the node box; the net-label terminal sits here. */
const C = NODE_SIZE / 2;

export interface NetLabelShape {
  /** Hollow terminal circle (the connection point / port). */
  circle: { cx: number; cy: number; r: number };
  /** Direction-arrow stem, from the circle edge outward. */
  stem: { x1: number; y1: number; x2: number; y2: number };
  /** Arrowhead as an SVG polygon `points` string. */
  head: string;
  /** Anchor for the (always upright) name tag, placed clear of the arrow. */
  tag: { x: number; y: number; anchor: "start" | "middle"; baseline: "middle" | "bottom" };
}

/** Unit arrow direction per 90° rotation step: 0 = up, 90 = right, 180 = down, 270 = left. */
const DIRS: Record<number, [number, number]> = {
  0: [0, -1],
  90: [1, 0],
  180: [0, 1],
  270: [-1, 0],
};

/**
 * Geometry for a net-label / port connector: a hollow terminal circle, a
 * direction arrow that follows the node rotation, and a horizontally-readable
 * name tag. Shared by the editor node and the SVG export so the two look
 * identical. The terminal always stays at the node centre, so wiring (and
 * {@link getLocalPins}) is unaffected by rotation.
 */
export function netLabelShape(rotation = 0): NetLabelShape {
  const r = 5;
  const norm = (((Math.round(rotation / 90) * 90) % 360) + 360) % 360;
  const [dx, dy] = DIRS[norm] ?? DIRS[0];
  const len = 24, headLen = 8, headHalf = 4.5, gap = r + 1;
  const x2 = C + dx * len, y2 = C + dy * len;
  const bx = C + dx * (len - headLen), by = C + dy * (len - headLen);
  const perpX = -dy, perpY = dx;
  const head = [
    `${x2},${y2}`,
    `${bx + perpX * headHalf},${by + perpY * headHalf}`,
    `${bx - perpX * headHalf},${by - perpY * headHalf}`,
  ].join(" ");
  // Tag to the right of the circle for up / down / left arrows; only the
  // right-pointing arrow would collide there, so its tag goes above instead.
  // Always drawn upright for readability.
  const tag = dx > 0
    ? { x: C, y: C - r - 7, anchor: "middle" as const, baseline: "bottom" as const }
    : { x: C + r + 7, y: C, anchor: "start" as const, baseline: "middle" as const };
  return {
    circle: { cx: C, cy: C, r },
    stem: { x1: C + dx * gap, y1: C + dy * gap, x2, y2 },
    head,
    tag,
  };
}

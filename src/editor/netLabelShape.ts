import { NODE_SIZE } from "./pinGeometry.js";
import type { PortType } from "@core/components/special/Special.js";

/** Local-space centre of the node box; the net-label terminal sits here. */
const C = NODE_SIZE / 2;

export interface NetLabelShape {
  /** Hollow terminal circle (the connection point / port). */
  circle: { cx: number; cy: number; r: number };
  /** Direction-arrow stem, from the circle edge outward. Absent for `None`. */
  stem: { x1: number; y1: number; x2: number; y2: number } | null;
  /**
   * Arrowheads as SVG polygon `points` strings — one for `In`/`Out`, two for
   * `BiDir`, none for `None`.
   */
  heads: string[];
  /** Anchor for the (always upright) name tag, placed clear of the arrow. */
  tag: { x: number; y: number; anchor: "start" | "middle"; baseline: "middle" | "bottom" };
}

/**
 * The arrow axis: straight up, out of the node centre.
 *
 * Fixed, not rotatable. LTSpice stores a flag as `FLAG x y name` (plus an
 * `IOPIN` for a connector) and records no orientation at all, so a turned symbol
 * could not survive a round-trip through `.asc` — the direction a connector
 * carries is its *port type*, not its angle.
 */
const DX = 0, DY = -1;

const R = 5, LEN = 24, HEAD_LEN = 8, HEAD_HALF = 4.5;

/**
 * Triangle with its tip at (tx,ty) pointing along (dx,dy), as polygon points.
 */
function arrowHead(tx: number, ty: number, dx: number, dy: number): string {
  const bx = tx - dx * HEAD_LEN, by = ty - dy * HEAD_LEN;
  const px = -dy, py = dx;
  return [
    `${tx},${ty}`,
    `${bx + px * HEAD_HALF},${by + py * HEAD_HALF}`,
    `${bx - px * HEAD_HALF},${by - py * HEAD_HALF}`,
  ].join(" ");
}

/**
 * Geometry for a net-label / net-connector: a hollow terminal circle, an
 * optional direction arrow, and a horizontally-readable name tag. Shared by the
 * editor node and the SVG export so the two look identical.
 *
 * The terminal sits at the node centre and the symbol has one fixed
 * orientation (see {@link DX}), so wiring — and `getLocalPins` — never has to
 * follow the drawing.
 *
 * The four port types map to the four shapes the schematic needs: `None` is a
 * bare docking circle (a plain label), `Out` points away from the circle, `In`
 * points back into it, and `BiDir` carries a head at each end.
 */
export function netLabelShape(portType: PortType = "None"): NetLabelShape {
  const dx = DX, dy = DY;

  const gap = R + 1;
  // Inner end (just clear of the circle) and outer end of the arrow axis.
  const ix = C + dx * gap, iy = C + dy * gap;
  const ox = C + dx * LEN, oy = C + dy * LEN;

  const heads: string[] = [];
  if (portType === "Out" || portType === "BiDir") heads.push(arrowHead(ox, oy, dx, dy));
  if (portType === "In" || portType === "BiDir") heads.push(arrowHead(ix, iy, -dx, -dy));

  // The tag sits centred above the symbol — above the bare circle for a label,
  // above the arrow tip for a connector, so it never overlaps either. Always
  // drawn upright for readability.
  const tag = {
    x: C,
    y: C - (portType === "None" ? R : LEN) - 7,
    anchor: "middle" as const,
    baseline: "bottom" as const,
  };

  return {
    circle: { cx: C, cy: C, r: R },
    stem: portType === "None" ? null : { x1: ix, y1: iy, x2: ox, y2: oy },
    heads,
    tag,
  };
}

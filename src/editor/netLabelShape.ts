import { NODE_SIZE } from "./pinGeometry.js";
import type { PortType } from "@core/components/special/Special.js";
import type { FlowPoint } from "./WireTool.js";

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
  /**
   * Anchor for the (always upright) name tag, placed clear of the symbol.
   * `anchor`/`baseline` say which corner of the tag box the point refers to.
   */
  tag: {
    x: number;
    y: number;
    anchor: "start" | "middle" | "end";
    baseline: "top" | "middle" | "bottom";
  };
}

const R = 5, LEN = 24, HEAD_LEN = 8, HEAD_HALF = 4.5;

/** Default direction: straight up, used when nothing is wired to the dock. */
const UP: FlowPoint = { x: 0, y: -1 };

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
 * The terminal stays at the node centre whichever way the symbol faces, so
 * wiring — and `getLocalPins` — never has to follow the drawing.
 *
 * `dir` is the axis the symbol extends along, away from its wire (see
 * {@link terminalDirection}); it is derived from the wiring at render time
 * rather than stored, exactly as LTSpice does it.
 *
 * The four port types map to the four shapes the schematic needs: `None` is a
 * bare docking circle (a plain label), `Out` points away from the circle, `In`
 * points back into it, and `BiDir` carries a head at each end.
 */
export function netLabelShape(portType: PortType = "None", dir: FlowPoint = UP): NetLabelShape {
  const dx = dir.x, dy = dir.y;

  const gap = R + 1;
  // Inner end (just clear of the circle) and outer end of the arrow axis.
  const ix = C + dx * gap, iy = C + dy * gap;
  const ox = C + dx * LEN, oy = C + dy * LEN;

  const heads: string[] = [];
  if (portType === "Out" || portType === "BiDir") heads.push(arrowHead(ox, oy, dx, dy));
  if (portType === "In" || portType === "BiDir") heads.push(arrowHead(ix, iy, -dx, -dy));

  // The tag sits just past the symbol along the same axis — past the bare circle
  // for a label, past the arrow tip for a connector — so it never overlaps
  // either, and always reads upright.
  const reach = (portType === "None" ? R : LEN) + 7;
  const tag = {
    x: C + dx * reach,
    y: C + dy * reach,
    // The tag box hangs off the side the symbol points away from, so it grows
    // outward rather than back across the circle.
    anchor: (dx > 0 ? "start" : dx < 0 ? "end" : "middle") as "start" | "middle" | "end",
    baseline: (dy > 0 ? "top" : dy < 0 ? "bottom" : "middle") as "top" | "middle" | "bottom",
  };

  return {
    circle: { cx: C, cy: C, r: R },
    stem: portType === "None" ? null : { x1: ix, y1: iy, x2: ox, y2: oy },
    heads,
    tag,
  };
}

/** CSS `transform` that pins a tag box to its {@link NetLabelShape.tag} anchor. */
export function tagTransform(tag: NetLabelShape["tag"]): string {
  const tx = tag.anchor === "start" ? "0" : tag.anchor === "end" ? "-100%" : "-50%";
  const ty = tag.baseline === "top" ? "0" : tag.baseline === "bottom" ? "-100%" : "-50%";
  return `translate(${tx}, ${ty})`;
}

/** Top-left corner of a tag box of the given size at its anchor. */
export function tagBoxOrigin(tag: NetLabelShape["tag"], width: number, height: number) {
  return {
    x: tag.x - (tag.anchor === "start" ? 0 : tag.anchor === "end" ? width : width / 2),
    y: tag.y - (tag.baseline === "top" ? 0 : tag.baseline === "bottom" ? height : height / 2),
  };
}

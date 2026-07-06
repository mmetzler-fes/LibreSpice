import { NODE_SIZE } from "./pinGeometry.js";

/** Gap (px) between a caption and the symbol's drawn bounding box. */
export const CAPTION_GAP = 5;
/** Fallback half-extents for symbols we can't measure (hand-drawn fallbacks). */
export const DEFAULT_HALF = { w: 18, h: 26 };

/**
 * Readable caption placement that hugs the symbol's actual shape: captions sit
 * just left of a narrow part (e.g. resistor) or further out for a wide one
 * (e.g. voltage source), and move above/below when the part lies horizontal.
 * Text always stays upright. `halfW`/`halfH` are the drawn symbol's pixel
 * half-extents (before rotation). Shared by the editor node and the SVG export
 * so a dragged label lands at the same spot in both.
 */
export function captionLayout(
  kind: "label" | "value",
  rotation: number,
  halfW: number,
  halfH: number,
): { left: number; top: number; transform: string } {
  const c = NODE_SIZE / 2;
  const horizontal = rotation === 90 || rotation === 270;
  const extentX = horizontal ? halfH : halfW; // horizontal reach after rotation
  const extentY = horizontal ? halfW : halfH; // vertical reach after rotation
  if (horizontal) {
    // Above / below the part, centered.
    return kind === "label"
      ? { left: c, top: c - extentY - CAPTION_GAP, transform: "translate(-50%, -100%)" }
      : { left: c, top: c + extentY + CAPTION_GAP, transform: "translate(-50%, 0)" };
  }
  // Left of the part, stacked near the vertical centre.
  const rightEdge = c - extentX - CAPTION_GAP;
  return kind === "label"
    ? { left: rightEdge, top: c - 8, transform: "translate(-100%, -50%)" }
    : { left: rightEdge, top: c + 9, transform: "translate(-100%, -50%)" };
}

type TextBaseline = "central" | "text-after-edge" | "text-before-edge";

/**
 * SVG-text equivalent of a {@link captionLayout} placement plus the persisted
 * user offset: absolute `x`/`y` and the `text-anchor` / `dominant-baseline` that
 * reproduce the editor's CSS `translate(...)` anchoring.
 */
export function captionSvgPlacement(
  kind: "label" | "value",
  rotation: number,
  halfW: number,
  halfH: number,
  offset?: { x: number; y: number },
): { x: number; y: number; textAnchor: "start" | "middle" | "end"; baseline: TextBaseline } {
  const l = captionLayout(kind, rotation, halfW, halfH);
  const off = offset ?? { x: 0, y: 0 };
  const anchor: Record<string, { textAnchor: "start" | "middle" | "end"; baseline: TextBaseline }> = {
    "translate(-100%, -50%)": { textAnchor: "end", baseline: "central" },
    "translate(-50%, -100%)": { textAnchor: "middle", baseline: "text-after-edge" },
    "translate(-50%, 0)": { textAnchor: "middle", baseline: "text-before-edge" },
  };
  const a = anchor[l.transform] ?? { textAnchor: "end" as const, baseline: "central" };
  return { x: l.left + off.x, y: l.top + off.y, ...a };
}

import { NODE_SIZE } from "./pinGeometry.js";

/** Gap (px) between a caption and the symbol's drawn bounding box. */
export const CAPTION_GAP = 5;
/** Fallback half-extents for symbols we can't measure (hand-drawn fallbacks). */
export const DEFAULT_HALF = { w: 18, h: 26 };

/**
 * Height of a caption's line box, as a multiple of its font size. The editor
 * pins its caption `<div>` to this rather than leaving `line-height: normal`,
 * because the SVG export has to know the box it is reproducing — `normal`
 * resolves from the user's font metrics, which the export cannot see.
 * See {@link captionSvgPlacement}.
 */
export const CAPTION_LINE_HEIGHT = 1.2;

/** Caption font sizes (px). The editor and the SVG export must agree: the
 *  placement is derived from the line box, which is a multiple of these. */
export const LABEL_FONT_SIZE = 11;
export const VALUE_FONT_SIZE = 10;

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

/**
 * SVG-text equivalent of a {@link captionLayout} placement plus the persisted
 * user offset: absolute `x`/`y` and the `text-anchor` / `dominant-baseline` that
 * reproduce the editor's CSS `translate(...)` anchoring.
 *
 * The vertical anchor is always `central`, never `text-before-edge` /
 * `text-after-edge`. Those align to the font's em box, while the editor's CSS
 * `translate(…%)` aligns to the line box — the two differ by the half-leading,
 * so an exported caption above or below a rotated part drifted toward the
 * symbol by ~1px, and by a different amount for every font. `central` cancels
 * the ascent/descent terms, so the only quantity the export still needs is the
 * line box height, which {@link CAPTION_LINE_HEIGHT} pins on both sides. The
 * `%`-anchored edges are therefore converted to a shift of half a line box.
 */
export function captionSvgPlacement(
  kind: "label" | "value",
  rotation: number,
  halfW: number,
  halfH: number,
  fontSize: number,
  offset?: { x: number; y: number },
): { x: number; y: number; textAnchor: "start" | "middle" | "end"; baseline: "central" } {
  const l = captionLayout(kind, rotation, halfW, halfH);
  const off = offset ?? { x: 0, y: 0 };
  const halfLine = (CAPTION_LINE_HEIGHT * fontSize) / 2;
  // dy moves the CSS box's anchored edge to its centre, which is what `central`
  // measures from.
  const anchor: Record<string, { textAnchor: "start" | "middle" | "end"; dy: number }> = {
    "translate(-100%, -50%)": { textAnchor: "end", dy: 0 },          // centre already
    "translate(-50%, -100%)": { textAnchor: "middle", dy: -halfLine }, // bottom edge → centre
    "translate(-50%, 0)": { textAnchor: "middle", dy: +halfLine },     // top edge → centre
  };
  const a = anchor[l.transform] ?? { textAnchor: "end" as const, dy: 0 };
  return { x: l.left + off.x, y: l.top + off.y + a.dy, textAnchor: a.textAnchor, baseline: "central" };
}

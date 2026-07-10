/**
 * Geometry of the on-schematic SPICE directive text box, shared by the editor's
 * {@link ../editor/DirectiveBox} and the SVG export so the exported box lands on
 * the spot the user dragged it to.
 *
 * The editor draws it as an HTML `<div>` whose `left`/`top` is the **border box**
 * corner (CSS absolute positioning), with a 1px border and padding inside. The
 * export must reproduce that box, not just the text origin — hence the constants
 * live here rather than in either renderer.
 */

/** Font size (px) of a directive line. */
export const DIRECTIVE_FONT_SIZE = 12;
/** Line box height (px). Pinned, so the export can place baselines. */
export const DIRECTIVE_LINE_HEIGHT = 16;
export const DIRECTIVE_PADDING_X = 8;
export const DIRECTIVE_PADDING_Y = 4;
export const DIRECTIVE_BORDER = 1;
export const DIRECTIVE_RADIUS = 4;
export const DIRECTIVE_FONT_FAMILY = "'Cascadia Code', 'Fira Code', monospace";

/**
 * Advance width of one character, as a fraction of the font size. The box is
 * monospace, so its width follows from the longest line. This is an estimate —
 * the export cannot measure the user's font — so it is only used to size the
 * frame, never to place text.
 */
const CHAR_ADVANCE = 0.6;

/**
 * Slack added to the right of the estimated text extent, so the frame never cuts
 * a line short. {@link CHAR_ADVANCE} is exact for Cascadia Code and Fira Code,
 * but a fallback monospace can run wider; the proportional term absorbs that on
 * long lines, the constant one keeps short lines from hugging the last glyph.
 * Erring wide is harmless — erring narrow clips the text.
 */
const WIDTH_SLACK_FACTOR = 1.05;
const WIDTH_SLACK_PX = 6;

/** Estimated width of the longest line's glyphs, before any slack. */
export function estimatedTextWidth(directives: string): number {
  const longest = directiveLines(directives).reduce((n, l) => Math.max(n, l.length), 0);
  return longest * DIRECTIVE_FONT_SIZE * CHAR_ADVANCE;
}

/** A comment line (`*` or `;`) is dimmed, like in the editor. */
export function isDirectiveComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith(";");
}

/** The directive text as it is rendered: trailing blank lines dropped. */
export function directiveLines(directives: string): string[] {
  return directives.replace(/\n+$/, "").split("\n");
}

export interface DirectiveBoxGeometry {
  /** Border-box rectangle, in flow coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** One entry per line: its baseline anchor (`dominant-baseline="central"`). */
  lines: { text: string; x: number; y: number; comment: boolean }[];
}

/**
 * Lay out the box at `pos` (its border-box top-left, exactly what the editor's
 * drag stores). Each line's `y` is the centre of its line box, so the export can
 * anchor at `central` and stay independent of the font's ascent/descent — the
 * same reasoning as {@link ./captionLayout.captionSvgPlacement}.
 */
export function directiveBoxGeometry(directives: string, pos: { x: number; y: number }): DirectiveBoxGeometry {
  const lines = directiveLines(directives);
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  const contentX = pos.x + DIRECTIVE_BORDER + DIRECTIVE_PADDING_X;
  const contentY = pos.y + DIRECTIVE_BORDER + DIRECTIVE_PADDING_Y;
  const textWidth = longest * DIRECTIVE_FONT_SIZE * CHAR_ADVANCE;
  return {
    x: pos.x,
    y: pos.y,
    width: textWidth * WIDTH_SLACK_FACTOR + WIDTH_SLACK_PX + 2 * (DIRECTIVE_PADDING_X + DIRECTIVE_BORDER),
    height: lines.length * DIRECTIVE_LINE_HEIGHT + 2 * (DIRECTIVE_PADDING_Y + DIRECTIVE_BORDER),
    lines: lines.map((text, i) => ({
      text,
      x: contentX,
      y: contentY + i * DIRECTIVE_LINE_HEIGHT + DIRECTIVE_LINE_HEIGHT / 2,
      comment: isDirectiveComment(text),
    })),
  };
}

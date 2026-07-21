/**
 * A free text box on the sheet: an annotation, not a part. It has no pins, no
 * netlist line and no bearing on the simulation, so it lives beside the circuit
 * (like the data-point flags) rather than in it.
 */
export interface TextBox {
  id: string;
  /** Top-left corner, in flow coordinates. */
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
  /** Render the text as Markdown instead of showing it verbatim. */
  markdown: boolean;
}

export const TEXTBOX_MIN_W = 80;
export const TEXTBOX_MIN_H = 40;
export const TEXTBOX_DEFAULT_W = 240;
export const TEXTBOX_DEFAULT_H = 120;

/**
 * Text boxes are stored as LTSpice comment lines: `TEXT x y Left 2 ;<text>`.
 * That is the same shape LTSpice uses for a sheet comment, so a file written
 * here still opens there — and, the other way round, the exercise texts already
 * sitting in every converted Multisim schematic become editable text boxes
 * instead of being dropped on import.
 *
 * LTSpice has nowhere to keep a box's size or its Markdown flag. Those ride in a
 * short header at the front of the comment, which LTSpice simply shows as part
 * of the text — visible, but harmless, and it round-trips.
 */
const HEADER = /^\[w=(\d+)\s+h=(\d+)(\s+md)?\]\s?/;

/** The comment body for an `.asc` TEXT line, header included. */
export function encodeTextBox(box: TextBox): string {
  const head = `[w=${Math.round(box.width)} h=${Math.round(box.height)}${box.markdown ? " md" : ""}]`;
  // LTSpice keeps a comment on one physical line and spells a break "\n".
  return `${head} ${box.text.replace(/\r?\n/g, "\\n")}`;
}

/** Rendering metrics the size estimate is built on (see TextBoxLayer). */
const FONT_SIZE = 11;
const LINE_HEIGHT = FONT_SIZE * 1.45;
/** Average glyph width of the sans-serif face at FONT_SIZE. */
const CHAR_W = 5.9;
/** Horizontal padding of the body. */
const PAD_X = 14;
/** Body padding plus the box's title bar (grip, MD and edit buttons). */
const PAD_Y = 26;

/**
 * A box big enough to show `text` without scrolling.
 *
 * Needed for comments that arrive without a size — a converted Multisim sheet
 * or a file written by LTSpice. Those texts are long (a full exercise runs to
 * some 30 lines), and dropping them into the default 240x120 box would hide
 * almost all of it behind a scrollbar, which reads as if the import had
 * truncated them.
 *
 * The text arrives already broken into lines by whoever wrote it, so the line
 * count is taken as-is rather than re-wrapped; the width follows the longest
 * line. Both are capped so a stray long line cannot produce a box the size of
 * the sheet.
 */
export function estimateSize(text: string): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  const width = Math.min(460, Math.max(TEXTBOX_MIN_W, Math.round(longest * CHAR_W + PAD_X)));
  // Lines that still exceed the capped width wrap, so count what they become.
  const perLine = Math.max(1, Math.floor((width - PAD_X) / CHAR_W));
  const rows = lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  const height = Math.min(560, Math.max(TEXTBOX_MIN_H, Math.round(rows * LINE_HEIGHT + PAD_Y)));
  return { width, height };
}

/**
 * Read a comment body back into a text box. A comment without our header is a
 * plain LTSpice (or converted Multisim) comment: it still becomes a text box,
 * sized to its content and shown verbatim rather than as Markdown — reading
 * someone else's comment as Markdown would reflow text that was laid out by
 * hand, and its `-----` underlines would turn into horizontal rules.
 */
export function decodeTextBox(body: string, id: string, x: number, y: number): TextBox {
  const m = HEADER.exec(body);
  const text = (m ? body.slice(m[0].length) : body).replace(/\\n/g, "\n");
  const size = m
    ? { width: Number(m[1]), height: Number(m[2]) }
    : estimateSize(text);
  return { id, x, y, width: size.width, height: size.height, markdown: m ? !!m[3] : false, text };
}

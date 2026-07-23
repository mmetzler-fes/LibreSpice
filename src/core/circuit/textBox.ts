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
  /**
   * The box size was estimated from the text, not chosen by the user — true for a
   * plain LTSpice comment, which carries no box size at all. Such a box writes no
   * `[w= h=]` header, so opening and saving a foreign file doesn't graft our
   * metadata onto every comment it has. Cleared as soon as the box is resized.
   */
  autoSized?: boolean;
  /**
   * LTSpice's justification keyword, verbatim: `Left`, `Center`, `Right`, `Top`,
   * `Bottom` and the `V…` variants, which set the text on its side.
   *
   * Kept as the keyword rather than decomposed into "alignment + vertical?"
   * because that is what the file holds and what has to go back into it. What we
   * *draw* from it is a narrower thing — see {@link textFlow}.
   */
  justify: Justification;
  /** Index into {@link TEXT_SIZES}; 2 (=1.5) is LTSpice's default. */
  size: number;
}

/**
 * LTSpice's text-size dropdown, in its own order — the `.asc` stores the index,
 * not the number. `1.5` is the default and the one every text we have written so
 * far carries, which is why it is also the size our own rendering has always
 * been drawn at.
 */
export const TEXT_SIZES = [0.625, 1.0, 1.5, 2.0, 2.5, 3.5, 5.0, 7.0] as const;

/** The index LTSpice starts a new text at. */
export const TEXT_SIZE_DEFAULT = 2;

/** The multiplier for a stored size index, relative to the 1.5 default. */
export function textScale(size: number): number {
  const v = TEXT_SIZES[Math.max(0, Math.min(TEXT_SIZES.length - 1, Math.round(size)))];
  return v / TEXT_SIZES[TEXT_SIZE_DEFAULT];
}

export const JUSTIFICATIONS = [
  "Left", "Center", "Right", "Top", "Bottom",
  "VLeft", "VCenter", "VRight", "VTop", "VBottom",
] as const;
export type Justification = typeof JUSTIFICATIONS[number];

/**
 * How a justification is actually drawn: which way the text runs, and how it is
 * aligned across the box.
 *
 * A `V…` keyword turns the text on its side — read bottom to top, the way
 * LTSpice sets it. The rest of the keyword still chooses the alignment, so
 * `VLeft` is left-aligned text running upwards. `Top`/`Bottom` describe where
 * LTSpice hangs the text off its anchor point; our boxes have an extent of their
 * own, so they align like `Left` and are kept only so the file round-trips.
 */
export function textFlow(j: Justification): { vertical: boolean; align: "left" | "center" | "right" } {
  const vertical = j.startsWith("V");
  const base = vertical ? j.slice(1) : j;
  const align = base === "Center" ? "center" : base === "Right" ? "right" : "left";
  return { vertical, align };
}

/** The justification keyword of a `TEXT` line, or `Left` when it is not one. */
export function asJustification(word: string): Justification {
  const hit = JUSTIFICATIONS.find((j) => j.toLowerCase() === word.toLowerCase());
  return hit ?? "Left";
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
  // LTSpice keeps a comment on one physical line and spells a break "\n".
  const body = box.text.replace(/\r?\n/g, "\\n");
  // A box whose size we only estimated has nothing worth recording: re-reading
  // it re-estimates the same size. Omitting the header keeps a plain comment a
  // plain comment.
  if (box.autoSized && !box.markdown) return body;
  const head = `[w=${Math.round(box.width)} h=${Math.round(box.height)}${box.markdown ? " md" : ""}]`;
  return `${head} ${body}`;
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
export function decodeTextBox(
  body: string, id: string, x: number, y: number,
  justify: Justification = "Left", size: number = TEXT_SIZE_DEFAULT,
): TextBox {
  const m = HEADER.exec(body);
  const text = (m ? body.slice(m[0].length) : body).replace(/\\n/g, "\n");
  const box = m
    ? { width: Number(m[1]), height: Number(m[2]) }
    : estimateSize(text);
  return {
    id, x, y, width: box.width, height: box.height,
    markdown: m ? !!m[3] : false, text, justify, size,
    ...(m ? {} : { autoSized: true }),
  };
}

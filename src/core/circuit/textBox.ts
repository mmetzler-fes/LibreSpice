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
  /**
   * The width the text is laid out in, in flow units.
   *
   * For an {@link TextBox.autoSized} box this is measured from the text and kept
   * up to date as it is typed — it is a derived value, not a setting, and never
   * reaches the file. Only a box the user has resized by hand carries a width of
   * its own.
   */
  width: number;
  height: number;
  text: string;
  /** Render the text as Markdown instead of showing it verbatim. */
  markdown: boolean;
  /**
   * The box follows its text rather than a size the user chose — the normal
   * state, and the only one LTSpice knows: a comment there is as wide as its
   * longest line and breaks only where the text says so.
   *
   * Such a box writes no `[w= h=]` header, so opening and saving a foreign file
   * doesn't graft our metadata onto every comment it has. Cleared as soon as the
   * box is resized by hand, and restored by the panel's "Auto".
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
 * What LTSpice's own format holds, and all it holds:
 *   - `x y` — the text's anchor point,
 *   - the justification keyword and the size index,
 *   - `;` for a comment (`!` marks a directive, which is not a text box),
 *   - the text, on one physical line, with `\n` spelled out for a line break.
 *
 * There is no width and no height in it. A comment there is as wide as its
 * longest line and breaks only where a `\n` says so, which is exactly what an
 * {@link TextBox.autoSized} box does here — so the normal case now writes a line
 * LTSpice would have written itself, with nothing of ours in the text.
 *
 * A box the user resized by hand, and the Markdown flag, have nowhere to go in
 * that format. Those ride in a short header at the front of the comment, which
 * LTSpice simply shows as part of the text — visible, but harmless, and it
 * round-trips. Kept as short as the box needs: `[md]` alone when the size is the
 * text's own.
 */
const HEADER = /^\[(?:w=(\d+)\s+h=(\d+))?(\s*md)?\]\s?/;

/** The comment body for an `.asc` TEXT line, header included. */
export function encodeTextBox(box: TextBox): string {
  // LTSpice keeps a comment on one physical line and spells a break "\n".
  const body = box.text.replace(/\r?\n/g, "\\n");
  // A box that follows its text has no size worth recording: re-reading it
  // measures the same box again. Omitting the header keeps a plain comment a
  // plain comment — and keeps ours plain for LTSpice.
  const size = box.autoSized ? "" : `w=${Math.round(box.width)} h=${Math.round(box.height)}`;
  if (!size && !box.markdown) return body;
  const head = `[${size}${size && box.markdown ? " " : ""}${box.markdown ? "md" : ""}]`;
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
 * The widest a measured box may get, in flow units. Only a guard against a
 * pasted line with no breaks in it at all — a normal note stays far below.
 */
export const AUTO_MAX_W = 1600;

/**
 * The box `text` needs: as wide as its longest line, as tall as its line count.
 *
 * This is LTSpice's own behaviour, and since it stores no width it is also the
 * only behaviour that survives the round trip: a comment breaks where the text
 * says so and nowhere else. Typing Return is therefore the one way to make a
 * line, and the box widens with the line being typed instead of re-flowing what
 * is already there.
 *
 * The size index scales the glyphs, so it scales the box with them — a heading
 * at seven times the base size needs seven times the width for the same words.
 *
 * @param text the note, with real newlines
 * @param size index into {@link TEXT_SIZES}
 */
export function estimateSize(text: string, size: number = TEXT_SIZE_DEFAULT): { width: number; height: number } {
  const scale = textScale(size);
  const lines = text.split("\n");
  const longest = lines.reduce((n, l) => Math.max(n, l.length), 0);
  const ideal = longest * CHAR_W * scale + PAD_X;
  const width = Math.min(AUTO_MAX_W, Math.max(TEXTBOX_MIN_W, Math.round(ideal)));
  // Every line fits by construction — unless the guard above cut the width, and
  // then the lines beyond it wrap and have to be counted as what they become.
  const perLine = Math.max(1, Math.floor((width - PAD_X) / (CHAR_W * scale)));
  const rows = ideal <= AUTO_MAX_W
    ? lines.length
    : lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
  const height = Math.max(TEXTBOX_MIN_H, Math.round(rows * LINE_HEIGHT * scale + PAD_Y));
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
  // A header without `w=`/`h=` (`[md]`) says only how the text is read; the box
  // still follows the text, exactly as a headerless comment does.
  const sized = !!(m && m[1]);
  const box = sized ? { width: Number(m![1]), height: Number(m![2]) } : estimateSize(text, size);
  return {
    id, x, y, width: box.width, height: box.height,
    markdown: m ? !!m[3] : false, text, justify, size,
    ...(sized ? {} : { autoSized: true }),
  };
}

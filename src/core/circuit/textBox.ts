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

/**
 * Read a comment body back into a text box. A comment without our header is a
 * plain LTSpice (or converted Multisim) comment: it still becomes a text box, at
 * a default size and verbatim rather than as Markdown — interpreting someone
 * else's comment as Markdown would reflow text that was laid out by hand.
 */
export function decodeTextBox(body: string, id: string, x: number, y: number): TextBox {
  const m = HEADER.exec(body);
  const text = (m ? body.slice(m[0].length) : body).replace(/\\n/g, "\n");
  return {
    id, x, y,
    width: m ? Number(m[1]) : TEXTBOX_DEFAULT_W,
    height: m ? Number(m[2]) : TEXTBOX_DEFAULT_H,
    markdown: m ? !!m[3] : false,
    text,
  };
}

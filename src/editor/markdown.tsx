import type { ReactNode } from "react";

/**
 * A deliberately small Markdown subset, rendered to React elements.
 *
 * Two reasons it is written here rather than pulled from a package:
 *
 *  1. Security. A schematic travels as a share link, so its text boxes are
 *     attacker-supplied whenever a link comes from someone else. Producing React
 *     elements means every piece of text goes through React's own escaping —
 *     there is no HTML string anywhere, and so no `dangerouslySetInnerHTML` to
 *     get wrong. Raw HTML in the source is *not* interpreted; it is shown as the
 *     characters the author typed.
 *  2. This is schematic annotation, not documentation. Headings, emphasis,
 *     lists, inline code and rules cover it; a full CommonMark implementation
 *     would be several times the size of the feature it serves.
 *
 * Supported: `#`…`######` headings, `-`/`*`/`1.` lists, `>` quotes, `---` rules,
 * ``` fenced and `inline` code, **bold**, *italic*, ~~strikethrough~~, and blank
 * lines as paragraph breaks. Anything else is literal text.
 */

/** One laid-out line for the SVG export, which has no flow layout of its own. */
export interface FlatLine {
  text: string;
  bold: boolean;
  /** Font size relative to the box's base size. */
  scale: number;
  /** Indent in characters (list items). */
  indent: number;
}

/** Strip the inline markers, keeping the text they wrapped. */
function stripInline(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
}

/**
 * Flatten a text box to styled, wrapped lines for the SVG export.
 *
 * SVG has no flow layout: every line has to be positioned individually, so the
 * export cannot reuse the React renderer. It approximates instead — headings
 * come out bold and larger, list items get a bullet and an indent, inline
 * emphasis is dropped to plain text. Enough for a printed sheet; the canvas
 * remains the faithful rendering.
 *
 * `charsPerLine` is derived from the box width by the caller, since only it
 * knows the font size in use.
 */
export function flattenForExport(src: string, markdown: boolean, charsPerLine: number): FlatLine[] {
  const out: FlatLine[] = [];
  const push = (text: string, bold: boolean, scale: number, indent: number) => {
    // Greedy word wrap; a word longer than the line is left to overflow rather
    // than being cut mid-word.
    const width = Math.max(4, Math.floor(charsPerLine / scale) - indent);
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) { out.push({ text: "", bold, scale, indent }); return; }
    let line = "";
    for (const w of words) {
      if (line === "") line = w;
      else if (line.length + 1 + w.length <= width) line += " " + w;
      else { out.push({ text: line, bold, scale, indent }); line = w; }
    }
    if (line) out.push({ text: line, bold, scale, indent });
  };

  if (!markdown) {
    for (const raw of src.split(/\r?\n/)) push(raw, false, 1, 0);
    return out;
  }

  let inFence = false;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^```/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) { out.push({ text: line, bold: false, scale: 1, indent: 1 }); continue; }
    if (line.trim() === "") { out.push({ text: "", bold: false, scale: 1, indent: 0 }); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      push(stripInline(heading[2]), true, level <= 2 ? 1.3 : 1.1, 0);
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { out.push({ text: "—".repeat(12), bold: false, scale: 1, indent: 0 }); continue; }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { push(stripInline(quote[1]), false, 1, 1); continue; }
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) { push("• " + stripInline(bullet[1]), false, 1, 1); continue; }
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) { push(`${numbered[1]}. ${stripInline(numbered[2])}`, false, 1, 1); continue; }
    push(stripInline(line), false, 1, 0);
  }
  return out;
}

/** Inline spans: **bold**, *italic*, ~~strike~~, `code`. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  // One pass, longest markers first so `**` is not read as two `*`.
  const pattern = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\*[^*]+\*|_[^_]+_)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyPrefix}i${i++}`;
    if (tok.startsWith("**")) out.push(<strong key={key}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("~~")) out.push(<s key={key}>{tok.slice(2, -2)}</s>);
    else if (tok.startsWith("`")) {
      out.push(
        <code key={key} style={{ fontFamily: "monospace", fontSize: "0.92em", padding: "0 3px", borderRadius: 3, background: "#8881" }}>
          {tok.slice(1, -1)}
        </code>,
      );
    } else out.push(<em key={key}>{tok.slice(1, -1)}</em>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const HEADING_SIZE = ["1.6em", "1.4em", "1.2em", "1.1em", "1em", "0.9em"];

/**
 * Render a Markdown source string as React nodes.
 *
 * Block-level parsing is line-based: enough for the supported subset, and it
 * keeps the whole thing a single pass with no intermediate tree.
 */
export function renderMarkdown(src: string): ReactNode {
  const lines = src.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: string[] | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(
      <p key={`p${blocks.length}`} style={{ margin: "0 0 0.5em" }}>
        {inline(para.join(" "), `p${blocks.length}`)}
      </p>,
    );
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, `l${blocks.length}_${i}`)}</li>);
    blocks.push(
      list.ordered
        ? <ol key={`b${blocks.length}`} style={{ margin: "0 0 0.5em", paddingLeft: "1.4em" }}>{items}</ol>
        : <ul key={`b${blocks.length}`} style={{ margin: "0 0 0.5em", paddingLeft: "1.4em" }}>{items}</ul>,
    );
    list = null;
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (const raw of lines) {
    const line = raw.trimEnd();

    // A fenced code block swallows everything until its closing fence, so no
    // marker inside it is interpreted.
    if (/^```/.test(line.trim())) {
      if (fence === null) { flushAll(); fence = []; }
      else {
        blocks.push(
          <pre key={`b${blocks.length}`} style={{ margin: "0 0 0.5em", padding: "6px 8px", borderRadius: 4, background: "#8881", overflowX: "auto", fontFamily: "monospace", fontSize: "0.92em" }}>
            {fence.join("\n")}
          </pre>,
        );
        fence = null;
      }
      continue;
    }
    if (fence !== null) { fence.push(raw); continue; }

    if (line.trim() === "") { flushAll(); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      blocks.push(
        <div key={`b${blocks.length}`} style={{ fontSize: HEADING_SIZE[level - 1], fontWeight: 600, margin: "0.2em 0 0.3em" }}>
          {inline(heading[2], `h${blocks.length}`)}
        </div>,
      );
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      blocks.push(<hr key={`b${blocks.length}`} style={{ border: "none", borderTop: "1px solid currentColor", opacity: 0.3, margin: "0.4em 0" }} />);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushAll();
      blocks.push(
        <blockquote key={`b${blocks.length}`} style={{ margin: "0 0 0.5em", paddingLeft: "0.7em", borderLeft: "3px solid currentColor", opacity: 0.8 }}>
          {inline(quote[1], `q${blocks.length}`)}
        </blockquote>,
      );
      continue;
    }

    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushPara();
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  // An unterminated fence still shows its content rather than swallowing it.
  if (fence !== null) para.push(...fence);
  flushAll();

  return <>{blocks}</>;
}

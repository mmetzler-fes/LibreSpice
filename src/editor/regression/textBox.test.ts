import { renderToStaticMarkup } from "react-dom/server";
import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { encodeTextBox, decodeTextBox, estimateSize, type TextBox } from "@core/circuit/textBox.js";
import { renderMarkdown, flattenForExport } from "../markdown.js";
import { parseSheetShape, formatSheetShape, dashArray } from "@core/circuit/sheetShape.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Text boxes: the annotation layer, its `.asc` round trip and the Markdown
 * subset.
 *
 * The security case is the one that earns its place here. A schematic travels as
 * a share link, so a text box can carry text written by whoever sent the link.
 * The renderer therefore produces React elements and never an HTML string —
 * these tests hold that line by feeding it markup and requiring it back as
 * visible characters rather than as tags.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> | void };

const box = (over: Partial<TextBox> = {}): TextBox =>
  ({ id: "tb_1", x: 10, y: 20, width: 240, height: 120, text: "Hallo", markdown: false, ...over });

const html = (src: string, markdown = true) =>
  renderToStaticMarkup(markdown ? renderMarkdown(src) as never : (src as never));

const CASES: Case[] = [
  {
    name: "a text box survives the .asc round trip with size, text and mode",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const id = st().addTextBox(100, 200);
      st().updateTextBox(id, { text: "Zeile 1\nZeile 2", width: 321, height: 89, markdown: true });
      const before = st().textBoxes[0];
      const asc = LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags, st().textBoxes);
      st().clearCircuit();
      st().loadFromAsc(asc);
      await tick();
      await tick();
      const after = st().textBoxes[0];
      if (!after) return fail(`no text box came back:\n${asc}`);
      for (const k of ["x", "y", "width", "height", "text", "markdown"] as const) {
        if (String(after[k]) !== String(before[k])) fail(`${k}: ${String(before[k])} -> ${String(after[k])}`);
      }
    },
  },
  {
    name: "a multi-line text stays one physical line in the file",
    run: (fail) => {
      // LTSpice keeps a comment on one line and spells a break "\\n"; a real
      // newline in the file would end the TEXT and orphan the rest.
      const asc = `TEXT 0 0 Left 2 ;${encodeTextBox(box({ text: "a\nb\nc" }))}`;
      if (asc.split("\n").length !== 1) fail(`the encoded comment spans ${asc.split("\n").length} lines`);
      if (!asc.includes("a\\nb\\nc")) fail(`breaks not escaped: ${asc}`);
    },
  },
  {
    name: "a plain LTSpice comment becomes a readable text box",
    run: (fail) => {
      // Every converted Multisim schematic carries its exercise text this way.
      // These used to be dropped on import; they must come back verbatim and
      // *not* be reflowed as Markdown, which would mangle hand-laid-out text.
      const t = decodeTextBox("Arbeitsauftrag: \\n 1. Messen Sie U.", "tb_1", 96, 736);
      if (t.markdown) fail("a foreign comment was taken as Markdown");
      if (!t.text.includes("\n")) fail(`no real line break: ${JSON.stringify(t.text)}`);
      if (t.text.includes("\\n")) fail(`the literal escape survived: ${JSON.stringify(t.text)}`);
    },
  },
  {
    name: "a comment with no size is fitted to its text",
    run: (fail) => {
      // The exercise texts in the converted schematics run to some 30 lines.
      // Dropped into the default box they would sit behind a scrollbar, which
      // reads as if the import had truncated them.
      const long = Array.from({ length: 27 }, (_, i) => `Zeile ${i + 1} mit etwas Text darin`).join("\n");
      const big = decodeTextBox(long, "tb_1", 0, 0);
      const small = decodeTextBox("kurz", "tb_2", 0, 0);
      if (!(big.height > small.height * 3)) fail(`27 lines got ${big.height}px, 1 line ${small.height}px`);
      if (!(big.width > small.width)) fail(`wide text got ${big.width}px, short ${small.width}px`);

      // Enough room for every line, and capped so one runaway line cannot
      // produce a box the size of the sheet.
      const est = estimateSize(long);
      if (est.height < 27 * 15) fail(`27 lines only got ${est.height}px`);
      const runaway = estimateSize("x".repeat(5000));
      if (runaway.width > 460 || runaway.height > 560) fail(`uncapped: ${JSON.stringify(runaway)}`);
    },
  },
  {
    name: "the header round-trips exactly",
    run: (fail) => {
      const original = box({ text: "x", width: 173, height: 44, markdown: true });
      const back = decodeTextBox(encodeTextBox(original), "tb_1", 0, 0);
      if (back.width !== 173 || back.height !== 44 || !back.markdown || back.text !== "x") {
        fail(JSON.stringify(back));
      }
    },
  },

  // ── Markdown ──────────────────────────────────────────────────────────────
  {
    name: "markdown renders headings, emphasis and lists",
    run: (fail) => {
      const out = html("# Titel\n\nEin **fetter** Text\n\n- eins\n- zwei");
      if (!out.includes("Titel")) fail("heading text missing");
      if (!out.includes("<strong>fetter</strong>")) fail(`no bold: ${out}`);
      if (!out.includes("<ul") || !out.includes("<li>eins</li>")) fail(`no list: ${out}`);
    },
  },
  {
    name: "every source line breaks inside a paragraph",
    run: (fail) => {
      // A note pinned to a schematic: pressing Return has to show as a break.
      // <br> is no way out here — raw HTML is shown, not interpreted — so the
      // newline itself must do it.
      const out = html("Zeile eins\nZeile zwei");
      if (!out.includes("<br/>") && !out.includes("<br />")) fail(`no break: ${out}`);
      if (out.includes("Zeile eins Zeile zwei")) fail("the lines were joined into one");
    },
  },
  {
    name: "a trailing backslash is a break marker, not text",
    run: (fail) => {
      // CommonMark's hard break. Every line breaks here anyway, so it only has
      // to disappear rather than show up as a stray backslash.
      const out = html("Zeile eins\\\nZeile zwei");
      if (out.includes("\\")) fail(`the backslash reached the output: ${out}`);
    },
  },
  {
    name: "a blank line still separates paragraphs",
    run: (fail) => {
      const out = html("Absatz eins\n\nAbsatz zwei");
      if ((out.match(/<p/g) ?? []).length !== 2) fail(`expected two paragraphs: ${out}`);
    },
  },
  {
    name: "markdown does not interpret HTML in the source",
    run: (fail) => {
      // The whole point of rendering to React elements: a share link from
      // someone else must not be able to inject markup, let alone a script.
      const out = html('<img src=x onerror="alert(1)"> <b>bold?</b> <script>alert(2)</script>');
      if (/<img|<script|<b>/i.test(out)) fail(`raw HTML survived into the output: ${out}`);
      if (!out.includes("&lt;script&gt;")) fail(`the markup was not shown as text: ${out}`);
    },
  },
  {
    name: "a code fence is not interpreted",
    run: (fail) => {
      const out = html("```\n**nicht fett**\n```");
      if (out.includes("<strong>")) fail("emphasis was applied inside a fence");
      if (!out.includes("**nicht fett**")) fail(`fence content missing: ${out}`);
    },
  },
  {
    name: "an unterminated fence still shows its text",
    run: (fail) => {
      const out = html("```\nirgendwas");
      if (!out.includes("irgendwas")) fail(`content swallowed: ${out}`);
    },
  },

  // ── SVG export ────────────────────────────────────────────────────────────
  {
    name: "the export wraps long text to the box width",
    run: (fail) => {
      const lines = flattenForExport("wort ".repeat(40).trim(), false, 20);
      if (lines.length < 5) fail(`40 words wrapped into only ${lines.length} lines`);
      for (const l of lines) if (l.text.length > 20) fail(`line longer than the wrap width: "${l.text}"`);
    },
  },
  {
    name: "the export marks headings and strips inline markers",
    run: (fail) => {
      const lines = flattenForExport("# Titel\n\nein **fetter** Text\n- punkt", true, 40);
      const head = lines.find((l) => l.text.includes("Titel"));
      if (!head?.bold || head.scale <= 1) fail(`heading not emphasised: ${JSON.stringify(head)}`);
      if (lines.some((l) => l.text.includes("**"))) fail("inline markers reached the export");
      if (!lines.some((l) => l.text.startsWith("• punkt"))) fail("list item lost its bullet");
    },
  },
];

const SHAPE_CASES: Case[] = [
  {
    name: "a sheet rectangle survives the .asc round trip",
    run: async (fail) => {
      // Dropped on import until now, so a file carrying a frame lost it on the
      // next save — the same silent loss the sheet comments had.
      const asc = `Version 4
SHEET 1 880 680
FLAG 0 96 0
SYMBOL voltage 0 0 R0
SYMATTR InstName V1
RECTANGLE Normal 224 320 -16 32 1
`;
      st().clearCircuit();
      st().loadFromAsc(asc);
      await tick();
      await tick();
      const shapes = st().sheetShapes;
      if (shapes.length !== 1) return fail(`${shapes.length} shapes read, expected 1`);
      const s = shapes[0];
      if (s.kind !== "rect") fail(`kind ${s.kind}`);
      if ([s.x1, s.y1, s.x2, s.y2].join() !== "224,320,-16,32") fail(`corners ${[s.x1, s.y1, s.x2, s.y2].join()}`);
      if (s.dash !== 1) fail(`dash ${s.dash}, expected 1`);

      const out = LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags, st().textBoxes, st().sheetShapes);
      if (!/^RECTANGLE Normal 224 320 -16 32 1$/m.test(out)) fail(`not written back:\n${out}`);
    },
  },
  {
    name: "the three shape kinds and their dash patterns round-trip",
    run: (fail) => {
      for (const line of [
        "RECTANGLE Normal 0 0 10 20",
        "RECTANGLE Normal 224 320 -16 32 1",
        "LINE Normal -5 -5 40 60 2",
        "CIRCLE Normal 0 0 64 64 3",
      ]) {
        const s = parseSheetShape(line, "s1");
        if (!s) { fail(`not parsed: ${line}`); continue; }
        if (formatSheetShape(s) !== line) fail(`${line} → ${formatSheetShape(s)}`);
      }
      // A solid line writes no trailing number, and asks for no dash pattern.
      if (dashArray(0) !== undefined) fail("solid produced a dash pattern");
      if (!dashArray(1)) fail("dashed produced none");
    },
  },
  {
    name: "a symbol's own LINE is not mistaken for a sheet drawing",
    run: async (fail) => {
      // Inside a SYMBOL block the same keyword belongs to the part's artwork.
      const asc = `Version 4
SHEET 1 880 680
SYMBOL voltage 0 0 R0
LINE Normal 0 0 10 10
SYMATTR InstName V1
`;
      st().clearCircuit();
      st().loadFromAsc(asc);
      await tick();
      await tick();
      if (st().sheetShapes.length !== 0) fail(`a symbol's line became a sheet shape`);
    },
  },
];

export async function runSheetShapeTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  for (const c of SHAPE_CASES) {
    let failed = false;
    await c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: SHAPE_CASES.length, passed: SHAPE_CASES.length - failures.length, failures };
}

export async function runTextBoxTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    await c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}

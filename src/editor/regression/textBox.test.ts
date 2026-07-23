import { renderToStaticMarkup } from "react-dom/server";
import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { buildSchematicSvg } from "@editor/svgExport.js";
import { encodeTextBox, decodeTextBox, estimateSize, TEXT_SIZES, TEXT_SIZE_DEFAULT, textScale, textFlow, type TextBox } from "@core/circuit/textBox.js";
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
  ({ id: "tb_1", x: 10, y: 20, width: 240, height: 120, text: "Hallo", markdown: false,
     justify: "Left", size: 2, ...over });

const html = (src: string, markdown = true) =>
  renderToStaticMarkup(markdown ? renderMarkdown(src) as never : (src as never));

const CASES: Case[] = [
  {
    // The box used to be a fixed rectangle with the overflow scrolled out of
    // sight on the canvas and dropped outright in the export. That quietly hid
    // the end of a long note — and once a text could be set at seven times the
    // base size, most of a short one.
    name: "a long note is exported whole, not cut off at the box height",
    run: (fail) => {
      const lines = Array.from({ length: 30 }, (_, i) => `Zeile ${i + 1}`);
      // A height far too small for the text: it must not decide what is drawn.
      const b = box({ text: lines.join("\n"), height: 40, width: 240 });
      const svg = buildSchematicSvg([], [], "default", undefined, undefined, [b]);
      const drawn = (svg.match(/<text /g) ?? []).length;
      if (drawn < lines.length) fail(`${drawn} of ${lines.length} lines reached the export`);
      if (!svg.includes("Zeile 30")) fail("the last line is missing from the export");
      // …and the sheet grew to hold them.
      const m = /viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg);
      if (!m) { fail("no viewBox"); return; }
      const [, , minY, , h] = m.map(Number);
      if (minY + h < b.y + lines.length * 11 * 1.45) fail(`viewBox height ${h} cannot hold ${lines.length} lines`);
    },
  },
  {
    name: "a bigger size makes the exported sheet taller",
    run: (fail) => {
      const text = "eins\nzwei\ndrei";
      const height = (size: number) => {
        const svg = buildSchematicSvg([], [], "default", undefined, undefined, [box({ text, size })]);
        const m = /viewBox="[-\d.]+ [-\d.]+ [\d.]+ ([\d.]+)"/.exec(svg);
        return m ? Number(m[1]) : 0;
      };
      // Index 2 is 1.5 (the default), index 7 is 7.0 — the sheet has to follow.
      if (!(height(7) > height(2))) fail(`size 7 gave ${height(7)}, size 2 gave ${height(2)}`);
    },
  },

  {
    // LTSpice keeps two things on a `TEXT` line that we used to throw away and
    // overwrite with `Left 2`: how the text is set, and how big it is. Opening
    // and saving a file therefore stood its sideways captions upright and shrank
    // every heading to the default.
    name: "a comment keeps its justification and size through a round trip",
    run: async (fail) => {
      const src = [
        "Version 4",
        "SHEET 1 880 680",
        "TEXT 104 112 Left 0 ;klein",
        "TEXT -56 -24 VLeft 2 ;senkrecht",
        "TEXT 496 32 Right 7 ;gross",
        "TEXT 112 -72 Center 4 ;mittig",
        "",
      ].join("\n");
      st().clearCircuit();
      st().loadFromAsc(src);
      await tick(); await tick();

      const got = st().textBoxes.map((b) => `${b.justify} ${b.size}`).sort();
      const want = ["Center 4", "Left 0", "Right 7", "VLeft 2"];
      if (got.join(" | ") !== want.join(" | ")) return fail(`read back as [${got.join(", ")}]`);

      const asc = LTSpiceExporter.export(st().nodes, st().edges, "", st().circuit, [], st().textBoxes);
      for (const line of ["Left 0 ;klein", "VLeft 2 ;senkrecht", "Right 7 ;gross", "Center 4 ;mittig"]) {
        if (!asc.includes(line)) fail(`the export lost "${line}":\n${asc}`);
      }
    },
  },
  {
    // The dropdown LTSpice offers, in its order. 1.5 is its default and the size
    // our own rendering has always used, so that entry must scale by exactly 1 —
    // otherwise every existing schematic changes size on this release.
    name: "the size table matches LTSpice, and its default scales by one",
    run: (fail) => {
      const want = [0.625, 1.0, 1.5, 2.0, 2.5, 3.5, 5.0, 7.0];
      if (TEXT_SIZES.join() !== want.join()) fail(`size table is [${TEXT_SIZES.join(", ")}]`);
      if (TEXT_SIZES[TEXT_SIZE_DEFAULT] !== 1.5) fail("the default index is not 1.5");
      if (textScale(TEXT_SIZE_DEFAULT) !== 1) fail(`the default scales by ${textScale(TEXT_SIZE_DEFAULT)}, not 1`);
      if (textScale(0) >= 1 || textScale(7) <= 1) fail("the table does not run small to large");
      // Out of range is clamped rather than yielding NaN — a foreign file may
      // carry an index from a version with a longer list.
      if (!Number.isFinite(textScale(99)) || !Number.isFinite(textScale(-1))) fail("an unknown index gave NaN");
    },
  },
  {
    name: "a V-justification sets the text on its side and keeps its alignment",
    run: (fail) => {
      const cases: [string, boolean, string][] = [
        ["Left", false, "left"],
        ["Center", false, "center"],
        ["Right", false, "right"],
        ["VLeft", true, "left"],
        ["VRight", true, "right"],
        // Top/Bottom hang the text off an anchor point; our boxes have an extent
        // of their own, so they read as Left and survive only to be written back.
        ["Top", false, "left"],
        ["Bottom", false, "left"],
      ];
      for (const [j, vertical, align] of cases) {
        const f = textFlow(j as never);
        if (f.vertical !== vertical || f.align !== align) {
          fail(`${j} drew as ${f.vertical ? "vertical" : "horizontal"}/${f.align}`);
        }
      }
    },
  },

  {
    name: "a text box survives the .asc round trip with size, text and mode",
    run: async (fail) => {
      st().clearCircuit();
      await tick();
      const id = st().addTextBox(100, 200);
      st().updateTextBox(id, { text: "Zeile 1\nZeile 2", width: 321, height: 89, markdown: true });
      const before = st().textBoxes[0];
      const asc = LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags, st().textBoxes, [], { anchors: st().netAnchors, busTaps: st().busTaps });
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

      const out = LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags, st().textBoxes, st().sheetShapes, { anchors: st().netAnchors, busTaps: st().busTaps });
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

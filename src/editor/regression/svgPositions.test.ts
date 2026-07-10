import type { Node, Edge } from "@xyflow/react";
import { buildSchematicSvg } from "../svgExport.js";
import { orthoVertices, type FlowPoint } from "../WireTool.js";
import { captionLayout, CAPTION_LINE_HEIGHT, DEFAULT_HALF } from "../captionLayout.js";
import { NODE_SIZE, getNodePins } from "../pinGeometry.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Position fidelity of the SVG export against the on-screen editor.
 *
 * Symbols and wires are easy: both sides consume the same geometry helpers, so
 * the export must reproduce them exactly.
 *
 * Captions are the hard part, and the reason this suite exists. The editor
 * places a caption as an HTML `<div>` anchored by a CSS `transform:
 * translate(px%, py%)`, i.e. relative to the text's **line box**. The export
 * places an SVG `<text>` anchored by `text-anchor` / `dominant-baseline`, i.e.
 * relative to the font's **em box**. The two only coincide when the line box
 * carries no leading, which is why anchoring to `text-before-edge` /
 * `text-after-edge` drifted by the half-leading — a different amount for every
 * font.
 *
 * The anchor attributes therefore cannot be compared directly. Each side is
 * resolved down to the one thing observable in both: where the glyphs land —
 * the left edge of the text run and its baseline. Doing that for two fonts with
 * different ascent/descent splits pins the property that matters: the placement
 * must not depend on metrics neither side can see.
 */

// ── Font model ───────────────────────────────────────────────────────────────

/** The metrics that decide where a glyph box sits, in px for a given font size. */
interface FontMetrics {
  ascent: number;
  descent: number;
  /** Height of the CSS line box. */
  lineHeight: number;
}

/**
 * A font, described by how its em box splits into ascent and descent. The line
 * box is pinned (see {@link CAPTION_LINE_HEIGHT}), so the only free variable is
 * that split — and a faithful export must not depend on it, because neither the
 * editor's CSS box nor the export knows the user's actual monospace font.
 *
 * That is exactly what the two `caption glyphs` cases probe: run the same
 * placement through two different fonts and require both to land on the editor's
 * box. A mapping anchored to the em box (`text-before-edge` / `text-after-edge`)
 * cannot satisfy that; one anchored to the box centre (`central`) can, since the
 * ascent/descent terms cancel.
 */
function metrics(fontSize: number, ascentEm: number, descentEm: number): FontMetrics {
  return {
    ascent: ascentEm * fontSize,
    descent: descentEm * fontSize,
    lineHeight: CAPTION_LINE_HEIGHT * fontSize,
  };
}

/** Two plausible monospace fonts with different ascent/descent splits. */
const FONTS: { name: string; ascentEm: number; descentEm: number }[] = [
  { name: "ascent 0.80 / descent 0.20", ascentEm: 0.8, descentEm: 0.2 },
  { name: "ascent 0.93 / descent 0.27", ascentEm: 0.93, descentEm: 0.27 },
];

/** Where the glyphs sit: left edge of the text run and its alphabetic baseline. */
interface GlyphBox {
  left: number;
  baseline: number;
}

/** Resolve the editor's CSS placement (`left`/`top` + `translate(%)`) to glyphs. */
function cssGlyphBox(
  base: { left: number; top: number; transform: string },
  offset: { x: number; y: number },
  textWidth: number,
  fm: FontMetrics,
): GlyphBox {
  // A component is either a percentage of the box's own size or an absolute
  // length; CSS writes a zero length as a bare `0` (`translate(-50%, 0)`).
  const comp = String.raw`(-?[\d.]+)(%?)`;
  const m = base.transform.match(new RegExp(`translate\\(\\s*${comp}\\s*,\\s*${comp}\\s*\\)`));
  if (!m) throw new Error(`unsupported transform ${base.transform}`);
  const shift = (v: string, unit: string, size: number) => (unit === "%" ? (Number(v) / 100) * size : Number(v));
  const boxLeft = base.left + offset.x + shift(m[1], m[2], textWidth);
  const boxTop = base.top + offset.y + shift(m[3], m[4], fm.lineHeight);
  // Inside the line box the em box is centred: half the leading above it.
  const halfLeading = (fm.lineHeight - (fm.ascent + fm.descent)) / 2;
  return { left: boxLeft, baseline: boxTop + halfLeading + fm.ascent };
}

/** Vertical centre of the editor's CSS box — what `dominant-baseline="central"` measures from. */
function cssBoxCentre(base: { left: number; top: number; transform: string }, offset: { x: number; y: number }, fontSize: number): number {
  const h = CAPTION_LINE_HEIGHT * fontSize;
  const m = base.transform.match(/translate\(\s*-?[\d.]+%?\s*,\s*(-?[\d.]+)(%?)\s*\)/)!;
  const boxTop = base.top + offset.y + (m[2] === "%" ? (Number(m[1]) / 100) * h : Number(m[1]));
  return boxTop + h / 2;
}

/** Resolve an exported `<text>`'s anchoring to the same glyph box. */
function svgGlyphBox(t: SvgText, textWidth: number, fm: FontMetrics): GlyphBox {
  const left = t.anchor === "middle" ? t.x - textWidth / 2 : t.anchor === "end" ? t.x - textWidth : t.x;
  let baseline: number;
  switch (t.baseline) {
    case "text-before-edge": baseline = t.y + fm.ascent; break;
    case "text-after-edge": baseline = t.y - fm.descent; break;
    case "central": baseline = t.y + (fm.ascent - fm.descent) / 2; break;
    case "": baseline = t.y; break; // no dominant-baseline → alphabetic
    default: throw new Error(`unsupported dominant-baseline ${t.baseline}`);
  }
  return { left, baseline };
}

// ── SVG scraping ─────────────────────────────────────────────────────────────

interface SvgText {
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  baseline: string;
  fontSize: number;
  content: string;
}

const attr = (tag: string, name: string): string | null => {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
};

function texts(svg: string): SvgText[] {
  const out: SvgText[] = [];
  const re = /<text\b([^>]*)>([^<]*)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const [, a, content] = m;
    out.push({
      x: Number(attr(a, "x")), y: Number(attr(a, "y")),
      anchor: (attr(a, "text-anchor") ?? "start") as SvgText["anchor"],
      baseline: attr(a, "dominant-baseline") ?? "",
      fontSize: Number(attr(a, "font-size")),
      content,
    });
  }
  return out;
}

/** The `transform` of every top-level node group, in document order. */
function nodeTransforms(svg: string): string[] {
  const out: string[] = [];
  const re = /<g transform="(translate\([^"]*\))"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) out.push(m[1]);
  return out;
}

function polylinePoints(svg: string): string[] {
  const out: string[] = [];
  const re = /<polyline[^>]*\spoints="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) out.push(m[1]);
  return out;
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/**
 * The test bundle stubs Vite's `import.meta.glob`, so no `.asy` symbols load and
 * every part falls back to its hand-drawn symbol. That is what makes the
 * geometry deterministic here: captions use {@link DEFAULT_HALF}, and pins come
 * from `FALLBACK_PINS` — which only covers sources, grounds and transistors, so
 * wire fixtures have to be sources.
 */
function part(id: string, x: number, y: number, extra: Record<string, unknown> = {}): Node {
  return {
    id, type: "component", position: { x, y },
    data: { componentType: "resistor", label: id, valueLabel: "1k", ...extra },
  } as Node;
}

/** A part with fallback pins (`p` top-centre, `n` bottom-centre), for wire cases. */
function wired(id: string, x: number, y: number): Node {
  return {
    id, type: "component", position: { x, y },
    data: { componentType: "vsource", label: id, valueLabel: "1k", sourceType: "DC" },
  } as Node;
}

/** Monospace advance width — only used where the two models must cancel it out. */
const advance = (text: string, fontSize: number) => text.length * fontSize * 0.6;

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

type Case = { name: string; run: (fail: (r: string) => void) => void };

const CASES: Case[] = [
  // ── Components ────────────────────────────────────────────────────────────
  {
    name: "each component group is translated to its node position",
    run: (fail) => {
      const nodes = [part("R1", 0, 0), part("R2", 160, 240), part("R3", -40, 80)];
      const ts = nodeTransforms(buildSchematicSvg(nodes, [], "default"));
      for (const n of nodes) {
        const want = `translate(${n.position.x} ${n.position.y})`;
        if (!ts.includes(want)) fail(`missing group ${want}; got ${ts.join(" | ")}`);
      }
    },
  },
  {
    name: "rotation and mirroring pivot on the node centre",
    run: (fail) => {
      const c = NODE_SIZE / 2;
      const svg = buildSchematicSvg([part("R1", 0, 0, { rotation: 90 })], [], "default");
      if (!svg.includes(`rotate(90 ${c} ${c})`) && !svg.includes(`rotate(90 0 0)`)) {
        fail("no centre-anchored rotate found");
      }
      const m = buildSchematicSvg([part("R2", 0, 0, { mirrored: true })], [], "default");
      // Fallback symbols draw around the origin, so the mirror pivot is 0.
      if (!/translate\(0 0\) scale\(-1 1\)|translate\(80 0\) scale\(-1 1\)/.test(m)) {
        fail("no horizontal-mirror transform found");
      }
    },
  },
  {
    name: "ground carries no caption text",
    run: (fail) => {
      const g = part("GND", 0, 0, { componentType: "ground", label: "0", valueLabel: "" });
      const t = texts(buildSchematicSvg([g], [], "default"));
      if (t.length !== 0) fail(`expected no <text>, got ${t.map((x) => x.content).join(",")}`);
    },
  },

  // ── Wires ─────────────────────────────────────────────────────────────────
  {
    name: "exported wire reproduces orthoVertices exactly",
    run: (fail) => {
      const a = wired("V1", 0, 0), b = wired("V2", 200, 200);
      const waypoints = [{ x: 40, y: 150 }, { x: 240, y: 150 }];
      const edge = { id: "w", source: "V1", sourceHandle: "n", target: "V2", targetHandle: "p", data: { waypoints } } as Edge;
      const pins = new Map(
        [...getNodePins(a, "default"), ...getNodePins(b, "default")].map((p) => [`${p.nodeId}-${p.handleId}`, p]),
      );
      const start = pins.get("V1-n"), end = pins.get("V2-p");
      if (!start || !end) return fail("fixture pins missing — check handle ids");
      const want = orthoVertices([start as FlowPoint, ...waypoints, end as FlowPoint])
        .map((p) => `${p.x},${p.y}`).join(" ");
      const got = polylinePoints(buildSchematicSvg([a, b], [edge], "default"));
      if (got.length !== 1) return fail(`expected 1 polyline, got ${got.length}`);
      if (got[0] !== want) fail(`polyline\n  got  ${got[0]}\n  want ${want}`);
    },
  },
  {
    name: "every exported wire segment stays axis-aligned",
    run: (fail) => {
      const a = wired("V1", 0, 0), b = wired("V2", 173, 91);
      const edge = { id: "w", source: "V1", sourceHandle: "n", target: "V2", targetHandle: "p", data: { waypoints: [] } } as Edge;
      const pts = polylinePoints(buildSchematicSvg([a, b], [edge], "default"))[0]?.split(" ") ?? [];
      if (pts.length < 2) return fail("no wire exported");
      for (let i = 1; i < pts.length; i++) {
        const [x1, y1] = pts[i - 1].split(",").map(Number);
        const [x2, y2] = pts[i].split(",").map(Number);
        if (x1 !== x2 && y1 !== y2) fail(`segment ${i} (${pts[i - 1]} → ${pts[i]}) is diagonal`);
      }
    },
  },

  // ── Captions: anchor point ────────────────────────────────────────────────
  {
    // `dominant-baseline="central"` measures from the box centre, so that is
    // where the anchor must sit — derived from the editor's CSS box, not from
    // the export's own placement helper.
    name: "caption anchor sits at the centre of the editor's CSS box",
    run: (fail) => {
      for (const rotation of [0, 90, 180, 270]) {
        const svg = buildSchematicSvg([part("R1", 0, 0, { rotation })], [], "default");
        const t = texts(svg);
        for (const [kind, content] of [["label", "R1"], ["value", "1k"]] as const) {
          const txt = t.find((x) => x.content === content);
          if (!txt) return fail(`rotation ${rotation}: ${kind} text missing`);
          if (txt.baseline !== "central") {
            fail(`rotation ${rotation} ${kind}: baseline "${txt.baseline}" is font-dependent, want "central"`);
          }
          const l = captionLayout(kind, rotation, DEFAULT_HALF.w, DEFAULT_HALF.h);
          const want = cssBoxCentre(l, { x: 0, y: 0 }, txt.fontSize);
          if (!near(txt.x, l.left)) fail(`rotation ${rotation} ${kind}: x ${txt.x} ≠ captionLayout.left ${l.left}`);
          if (!near(txt.y, want)) fail(`rotation ${rotation} ${kind}: y ${txt.y} ≠ box centre ${want}`);
        }
      }
    },
  },
  {
    name: "caption anchor point shifts by the user's dragged offset",
    run: (fail) => {
      const off = { x: 7, y: -13 };
      const svg = buildSchematicSvg([part("R1", 0, 0, { labelOffset: off, valueOffset: off })], [], "default");
      const t = texts(svg);
      for (const [kind, content] of [["label", "R1"], ["value", "1k"]] as const) {
        const txt = t.find((x) => x.content === content)!;
        const l = captionLayout(kind, 0, DEFAULT_HALF.w, DEFAULT_HALF.h);
        if (!near(txt.x, l.left + off.x)) fail(`${kind}: x ${txt.x} ≠ ${l.left + off.x}`);
        if (!near(txt.y, cssBoxCentre(l, off, txt.fontSize))) {
          fail(`${kind}: y ${txt.y} ≠ ${cssBoxCentre(l, off, txt.fontSize)}`);
        }
      }
    },
  },

  // ── Captions: glyph position (the actual fidelity check) ──────────────────
  ...FONTS.map((f) => ({
    name: `caption glyphs land where the editor draws them (${f.name})`,
    run: (fail: (r: string) => void) => checkGlyphs(fail, f),
  })),
];

/**
 * For every rotation and both captions, resolve the editor's CSS box and the
 * exported `<text>` to their glyph boxes and require them to coincide for the
 * given font.
 */
function checkGlyphs(fail: (r: string) => void, font: (typeof FONTS)[number]): void {
  for (const rotation of [0, 90, 180, 270]) {
    const svg = buildSchematicSvg([part("R1", 0, 0, { rotation })], [], "default");
    const t = texts(svg);
    for (const [kind, content] of [["label", "R1"], ["value", "1k"]] as const) {
      const txt = t.find((x) => x.content === content);
      if (!txt) return fail(`rotation ${rotation}: ${kind} text missing`);
      const fm = metrics(txt.fontSize, font.ascentEm, font.descentEm);
      const w = advance(content, txt.fontSize);
      const want = cssGlyphBox(captionLayout(kind, rotation, DEFAULT_HALF.w, DEFAULT_HALF.h), { x: 0, y: 0 }, w, fm);
      const got = svgGlyphBox(txt, w, fm);
      if (!near(got.left, want.left, 1e-6)) {
        fail(`rotation ${rotation} ${kind}: text left ${got.left.toFixed(3)} ≠ editor ${want.left.toFixed(3)}`);
      }
      if (!near(got.baseline, want.baseline, 1e-6)) {
        fail(
          `rotation ${rotation} ${kind}: baseline ${got.baseline.toFixed(3)} ≠ editor ${want.baseline.toFixed(3)} ` +
            `(off by ${(got.baseline - want.baseline).toFixed(3)}px; anchored to "${txt.baseline}")`,
        );
      }
    }
  }
}

export function runSvgPositionTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failedCases = 0;
  for (const tc of CASES) {
    let failed = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); failed = true; });
    if (failed) failedCases++;
  }
  return { total: CASES.length, passed: CASES.length - failedCases, failures };
}

import type { Node, Edge } from "@xyflow/react";
import { buildSchematicSvg } from "../svgExport.js";
import { orthoVertices } from "../WireTool.js";

export interface TestReport {
  total: number;
  passed: number;
  failures: { name: string; reason: string }[];
}

/** Minimal voltage-source node (uses fallback pins: `p` @ top, `n` @ bottom). */
function vsource(id: string, x: number, y: number): Node {
  return {
    id,
    type: "component",
    position: { x, y },
    data: { componentType: "vsource", label: id, sourceType: "DC" },
  } as Node;
}

/** Extracts the `points` attribute of every <polyline> in the SVG markup. */
function polylinePoints(svg: string): string[] {
  const out: string[] = [];
  const re = /<polyline[^>]*\spoints="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) out.push(m[1]);
  return out;
}

/** Extracts the SVG's `viewBox` as [minX, minY, width, height]. */
function viewBoxOf(svg: string): number[] | null {
  const m = /viewBox="([^"]*)"/.exec(svg);
  return m ? m[1].split(/\s+/).map(Number) : null;
}

/**
 * Two sources joined by one wire, exported with the given names on the sheet.
 *
 * A wire carries no name of its own any more: a name is a flag at a point, so
 * what the export draws is the anchor list, not something read off the edge.
 */
function labelledWireSvg(anchors: { id: string; x: number; y: number; name: string }[]): string {
  const a = vsource("V1", 0, 0), b = vsource("V2", 200, 200);
  const edge: Edge = {
    id: "w1", source: "V1", sourceHandle: "n", target: "V2", targetHandle: "p",
    data: { waypoints: [] },
  } as Edge;
  return buildSchematicSvg([a, b], [edge], "default", undefined, undefined, [], [], anchors);
}

type Case = { name: string; run: (fail: (r: string) => void) => void };

const CASES: Case[] = [
  {
    // A segment with an end on no pin has no edge to carry it, and used to be
    // invisible because of that. Names leaving the topology made the case
    // common: the stub between a part and a connector is exactly this shape, so
    // a schematic could appear to have lost a connection it still had.
    name: "wire segments no edge carries are still drawn",
    run: (fail) => {
      const a = vsource("V1", 0, 0);
      const orphans = ["WIRE 176 176 160 176", "WIRE 304 288 320 288"];
      const svg = buildSchematicSvg([a], [], "default", undefined, undefined, [], [], [], [], orphans);
      for (const [x1, y1, x2, y2] of [[176, 176, 160, 176], [304, 288, 320, 288]]) {
        const re = new RegExp(`x1="${x1}"[^>]*y1="${y1}"[^>]*x2="${x2}"[^>]*y2="${y2}"`);
        if (!re.test(svg)) fail(`no line for WIRE ${x1} ${y1} ${x2} ${y2}:\n${svg}`);
      }
    },
  },
  {
    name: "and they widen the sheet so nothing is clipped",
    run: (fail) => {
      const a = vsource("V1", 0, 0);
      const svg = buildSchematicSvg([a], [], "default", undefined, undefined, [], [], [], [], ["WIRE 600 600 640 600"]);
      const vb = viewBoxOf(svg);
      if (!vb) { fail("no viewBox"); return; }
      const [minX, minY, w, h] = vb;
      if (minX + w < 640 || minY + h < 600) fail(`viewBox ${vb.join(" ")} cuts off the segment at 640,600`);
    },
  },

  {
    // Pure routing helper: a diagonal step must expand to a right-angle corner,
    // never a slanted segment (which is what "verzieht die Linien" looked like).
    name: "orthoVertices inserts a right-angle corner",
    run: (fail) => {
      const v = orthoVertices([{ x: 0, y: 0 }, { x: 100, y: 40 }]);
      if (v.length !== 3) return fail(`expected 3 vertices, got ${v.length}`);
      // Horizontal lead (dx >= dy): corner shares the start's y.
      if (!(v[1].x === 100 && v[1].y === 0)) fail(`unexpected corner ${JSON.stringify(v[1])}`);
      for (let i = 1; i < v.length; i++) {
        const a = v[i - 1], b = v[i];
        if (a.x !== b.x && a.y !== b.y) fail(`segment ${i} is not axis-aligned`);
      }
    },
  },
  {
    // Regression: the export used to hard-code a 2-segment route and drop the
    // user's stored waypoints, so a hand-routed wire came out warped.
    name: "exported wire routes through its stored waypoints",
    run: (fail) => {
      const a = vsource("V1", 0, 0);
      const b = vsource("V2", 200, 200);
      const edge: Edge = {
        id: "w1", source: "V1", sourceHandle: "n", target: "V2", targetHandle: "p",
        data: { waypoints: [{ x: 40, y: 150 }, { x: 240, y: 150 }] },
      } as Edge;
      const svg = buildSchematicSvg([a, b], [edge], "default");
      const pts = polylinePoints(svg);
      if (pts.length !== 1) return fail(`expected 1 polyline, got ${pts.length}`);
      if (!pts[0].includes("40,150")) fail(`waypoint 40,150 missing: ${pts[0]}`);
      if (!pts[0].includes("240,150")) fail(`waypoint 240,150 missing: ${pts[0]}`);
    },
  },
  {
    // The exported endpoints must be the true pin centres. The source's fallback
    // pins sit 8 px inside the node box — a multiple of the grid, so the terminal
    // lands on a grid line (and can therefore meet a wire at all). V1 `n` is thus
    // at (40, 72), V2 `p` at (240, 208).
    name: "exported wire starts and ends on the pin centres",
    run: (fail) => {
      const a = vsource("V1", 0, 0);
      const b = vsource("V2", 200, 200);
      const edge: Edge = {
        id: "w1", source: "V1", sourceHandle: "n", target: "V2", targetHandle: "p",
        data: { waypoints: [] },
      } as Edge;
      const pts = polylinePoints(buildSchematicSvg([a, b], [edge], "default"));
      if (pts.length !== 1) return fail(`expected 1 polyline, got ${pts.length}`);
      const verts = pts[0].split(" ");
      if (verts[0] !== "40,72") fail(`start ${verts[0]} ≠ 40,72`);
      if (verts[verts.length - 1] !== "240,208") fail(`end ${verts[verts.length - 1]} ≠ 240,208`);
    },
  },
  {
    // A wire that taps an existing wire must draw to the junction point, not to
    // the electrical target pin.
    name: "exported wire honours source/target taps",
    run: (fail) => {
      const a = vsource("V1", 0, 0);
      const b = vsource("V2", 200, 200);
      const edge: Edge = {
        id: "w1", source: "V1", sourceHandle: "n", target: "V2", targetHandle: "p",
        data: { waypoints: [], targetTap: { x: 88, y: 96 } },
      } as Edge;
      const pts = polylinePoints(buildSchematicSvg([a, b], [edge], "default"));
      if (pts.length !== 1) return fail(`expected 1 polyline, got ${pts.length}`);
      const verts = pts[0].split(" ");
      if (verts[verts.length - 1] !== "88,96") fail(`tapped end ${verts[verts.length - 1]} ≠ 88,96`);
    },
  },
  {
    // A wire whose endpoint pins can't be resolved is skipped, not rendered as a
    // degenerate segment.
    name: "wire with unresolved endpoints is skipped",
    run: (fail) => {
      const a = vsource("V1", 0, 0);
      const edge: Edge = {
        id: "w1", source: "V1", sourceHandle: "n", target: "GHOST", targetHandle: "p",
        data: { waypoints: [] },
      } as Edge;
      const pts = polylinePoints(buildSchematicSvg([a], [edge], "default"));
      if (pts.length !== 0) fail(`expected 0 polylines, got ${pts.length}`);
    },
  },

  // ── Wire-carried labels ────────────────────────────────────────────────────
  // A wire stores only *whether* to show a label (`showLabel`), never the text:
  // the name is resolved through the circuit model (source port → net →
  // nodeLabel). The export had no access to it, so wire labels were silently
  // missing from an exported SVG while node-based net labels were drawn. It now
  // takes the lookup as its last argument.
  {
    name: "a name on the sheet is exported",
    run: (fail) => {
      // On the wire's corner (40,140), so it resolves to that run.
      const svg = labelledWireSvg([{ id: "a1", x: 40, y: 140, name: "VCC" }]);
      if (!svg.includes(">VCC<")) fail(`no VCC label in the export:\n${svg}`);
    },
  },
  {
    name: "an unnamed wire stays unnamed",
    run: (fail) => {
      // The same net, with no flag on it — a wire never shows a name by itself.
      if (labelledWireSvg([]).includes(">VCC<")) fail("net name drawn on a wire that carries no flag");
    },
  },
  {
    // Without the lookup the export must degrade quietly, not crash or invent a
    // name — every existing caller (and every other test here) omits it.
    name: "no circuit lookup → no wire label, no crash",
    run: (fail) => {
      const a = vsource("V1", 0, 0), b = vsource("V2", 200, 200);
      const edge: Edge = {
        id: "w1", source: "V1", sourceHandle: "n", target: "V2", targetHandle: "p",
        data: { waypoints: [], showLabel: true },
      } as Edge;
      const svg = buildSchematicSvg([a, b], [edge], "default");
      if (svg.includes(">VCC<")) fail("a name appeared without a circuit lookup");
      if (!svg.includes("<polyline")) fail("the wire itself went missing");
    },
  },
  {
    // A name tag steps clear of the wire, so the bounding box has to account for
    // it or the label is cropped at the sheet edge. Assert the property that
    // matters (the tag lies inside the viewBox) rather than that the box grew:
    // for a short name in the middle of the sheet it legitimately need not grow
    // at all.
    name: "names are never clipped by the viewBox",
    run: (fail) => {
      const cases = [
        // Each end of the wire and its corner, plus a long name at the far end.
        [{ id: "a1", x: 40, y: 72, name: "VCC" }],
        [{ id: "a1", x: 240, y: 208, name: "VCC" }],
        [{ id: "a1", x: 40, y: 140, name: "VCC" }],
        [{ id: "a1", x: 240, y: 140, name: "SEHR_LANGER_NETZNAME" }],
      ];
      for (const data of cases) {
        const svg = labelledWireSvg(data);
        const vb = viewBoxOf(svg);
        if (!vb) { fail("no viewBox found"); continue; }
        const [minX, minY, w, h] = vb;
        // Every drawn box must sit inside the viewBox.
        const re = /<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)"/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(svg)) !== null) {
          const [x, y, rw, rh] = m.slice(1).map(Number);
          // The sheet's own background rect is the viewBox; skip it.
          if (rw === w && rh === h) continue;
          if (x < minX || y < minY || x + rw > minX + w || y + rh > minY + h) {
            fail(`${JSON.stringify(data)}: label box (${x},${y},${rw},${rh}) escapes viewBox (${minX},${minY},${w},${h})`);
          }
        }
      }
    },
  },
];

export function runSvgExportTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failedCases = 0;
  for (const tc of CASES) {
    let failed = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); failed = true; });
    if (failed) failedCases++;
  }
  return { total: CASES.length, passed: CASES.length - failedCases, failures };
}

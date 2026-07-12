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

type Case = { name: string; run: (fail: (r: string) => void) => void };

const CASES: Case[] = [
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

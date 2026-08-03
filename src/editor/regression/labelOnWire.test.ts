import { useCircuitStore } from "@store/circuitStore.js";
import { netRoutes } from "../anchorNets.js";
import { nearestRoute } from "../anchorMagnet.js";
import { withSymbols } from "./withSymbols.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Dropping a net name on a wire — including a short one between two parts.
 *
 * The reactive-power sheet has a lead of 32 units between the switch and the
 * series resistor, and no name could be put on it. Not for want of a net: the
 * segment is a wire like any other, and the magnet finds it. The click never
 * arrived. A wire carries a 14 px hit area, so React Flow delivers an *edge*
 * click, and the edge handler only cleared the selection — placing hung off the
 * pane alone. Everywhere else that goes unnoticed, because clicking a few pixels
 * beside a wire lands on the pane and the magnet pulls the name over. On a
 * segment hemmed in by parts there is no such spot.
 *
 * The click routing itself cannot be exercised here — the harness renders no
 * React Flow (see canvas notes) — so it is held by a source check below, while
 * the two cases above it hold the half that *is* testable: that such a segment
 * is a legitimate target and that a name landing there names its net.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> | void };

/**
 * Two resistors in series with a 32-unit lead between them, the shape the
 * reactive-power sheet has around its switch: R1's right pin at (64,48), R2's
 * left pin at (96,48), one wire between them and no free space beside it.
 */
const ASC = [
  "Version 4",
  "SHEET 1 880 680",
  "WIRE 96 48 64 48",
  "WIRE -16 48 -16 128",
  "WIRE -16 128 176 128",
  "WIRE 176 128 176 48",
  "FLAG -16 128 0",
  "SYMBOL res -32 64 R270",
  "SYMATTR InstName R1",
  "SYMATTR Value 1k",
  "SYMBOL res 80 64 R270",
  "SYMATTR InstName R2",
  "SYMATTR Value 2k",
  "TEXT 0 300 Left 2 !.op",
  "",
].join("\n");

/** The middle of that lead — where the user aimed. */
const AIM = { x: 80, y: 48 };

async function load() {
  st().clearCircuit();
  st().loadFromAsc(ASC);
  await tick(); await tick();
  st().rebuildConnections();
}

const CASES: Case[] = [
  {
    name: "the short lead between two parts is a wire the magnet finds",
    run: async (fail) => {
      await withSymbols(async () => {
        await load();
        const routes = netRoutes(st().nodes, st().edges, { netOf: (id) => id });
        const near = nearestRoute(AIM, routes);
        if (!near) { fail(`nothing within reach of (${AIM.x}, ${AIM.y})`); return; }
        // Aimed at the middle of the segment, the projection is the point itself.
        if (Math.abs(near.point.x - AIM.x) > 2 || Math.abs(near.point.y - AIM.y) > 2) {
          fail(`snapped to (${near.point.x}, ${near.point.y}) instead of the aim`);
        }
      });
    },
  },
  {
    name: "a name dropped on that lead names the net it lies on",
    run: async (fail) => {
      await withSymbols(async () => {
        await load();
        st().addNetAnchor(AIM.x, AIM.y, "MITTE");
        st().rebuildConnections();
        st().regenerateNetlist();
        const netlist = st().netlist;
        // Both resistors meet on that lead, so both must now name it.
        const r1 = netlist.split("\n").find((l) => /^R1\b/i.test(l.trim())) ?? "";
        const r2 = netlist.split("\n").find((l) => /^R2\b/i.test(l.trim())) ?? "";
        if (!/\bMITTE\b/.test(r1)) fail(`R1 does not touch the named net: ${r1}`);
        if (!/\bMITTE\b/.test(r2)) fail(`R2 does not touch the named net: ${r2}`);
      });
    },
  },
  {
    // The half the harness cannot click. Held as a source check because the
    // alternative is no guard at all: the bug was a handler that did everything
    // *except* place, and it read perfectly reasonably.
    name: "the wire and the part commit an armed placement, not just the pane",
    run: async (fail) => {
      const load = (m: string) => import(/* @vite-ignore */ m);
      const [fs] = await Promise.all([load("node:fs")]);
      const src: string = fs.readFileSync("src/editor/SchematicCanvas.tsx", "utf8");
      const body = (name: string): string => {
        // The declarations differ in shape (`const x = useCallback(` versus
        // `const x: NodeMouseHandler = useCallback(`), so the name is matched
        // rather than a fixed prefix.
        const at = src.search(new RegExp(`const ${name}\\b[^=]*= useCallback\\(`));
        if (at < 0) return "";
        // To the end of that callback's argument list — enough to see the calls.
        return src.slice(at, src.indexOf("\n  );", at));
      };
      for (const handler of ["onPaneClick", "onEdgeClick", "onNodeClick"]) {
        const text = body(handler);
        if (!text) { fail(`${handler} is gone or was renamed`); continue; }
        if (!/commitPlacement(Ref\.current)?\(/.test(text)) {
          fail(`${handler} no longer commits a pending placement — a name aimed there is swallowed`);
        }
      }
    },
  },
];

export async function runLabelOnWireTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    await c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}

import type { Edge } from "@xyflow/react";
import { forgetImportedRoutes } from "../importedRoutes.js";
import { orthoVertices } from "@core/geometry/ortho.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * An imported wire keeps the path the source file drew, so the schematic opens
 * looking like the original. That path is only right for the layout it came
 * from: move one of its parts and the wire is left detouring around where the
 * part used to be. It is then dropped, and the wire re-routes itself.
 *
 * The three exceptions are what these tests are really about — each one, if
 * re-routed, loses something that cannot be recovered.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const WP = [{ x: 50, y: 50 }, { x: 50, y: 90 }];

const edge = (id: string, data: Record<string, unknown>): Edge =>
  ({ id, source: "R1", sourceHandle: "p", target: "R2", targetHandle: "n", type: "wire", data }) as Edge;

/** An imported wire: a reconstructed path, flagged as not the user's doing. */
const imported = (id = "e1") => edge(id, { waypoints: WP, autoRoute: true });

const wpOf = (edges: Edge[] | null, id: string) =>
  ((edges ?? []).find((e) => e.id === id)?.data as { waypoints?: unknown[] } | undefined)?.waypoints;

const CASES: Case[] = [
  {
    name: "moving a part forgets the imported path of its wires",
    run: (fail) => {
      const out = forgetImportedRoutes([imported()], new Set(["R1"]));
      if (out === null) return fail("no change reported");
      const wp = wpOf(out, "e1");
      if (!Array.isArray(wp) || wp.length !== 0) fail(`waypoints = ${JSON.stringify(wp)}`);
    },
  },
  {
    name: "the flag goes with the path, so a later move has nothing to redo",
    run: (fail) => {
      const out = forgetImportedRoutes([imported()], new Set(["R1"]));
      const d = (out ?? [])[0].data as { autoRoute?: boolean };
      if (d.autoRoute) fail("autoRoute survived");
      if (forgetImportedRoutes(out ?? [], new Set(["R1"])) !== null) fail("second move still reported a change");
    },
  },
  {
    name: "a wire whose parts stayed put is untouched",
    run: (fail) => {
      if (forgetImportedRoutes([imported()], new Set(["R9"])) !== null) fail("an unrelated move changed the wire");
    },
  },
  {
    name: "a hand-routed wire keeps its path",
    run: (fail) => {
      // No autoRoute flag: the user placed these waypoints, and a move must not
      // silently discard that.
      const e = edge("e1", { waypoints: WP });
      if (forgetImportedRoutes([e], new Set(["R1"])) !== null) fail("a hand-routed wire was re-routed");
    },
  },
  {
    name: "a diagonal wire keeps its path",
    run: (fail) => {
      // Orthogonalising a diagonal can make its right-angle legs overlap a
      // neighbouring net and merge the two on re-import (see LTSpiceExporter).
      const e = edge("e1", { waypoints: WP, autoRoute: true, diagonal: true });
      if (forgetImportedRoutes([e], new Set(["R1"])) !== null) fail("a diagonal wire was re-routed");
    },
  },
  {
    name: "a wire tapped onto another wire keeps its path",
    run: (fail) => {
      // Its endpoint is a fixed point on the host wire, not a pin; re-routing
      // would strand it.
      for (const tap of ["sourceTap", "targetTap"]) {
        const e = edge("e1", { waypoints: WP, autoRoute: true, [tap]: { x: 10, y: 10 } });
        if (forgetImportedRoutes([e], new Set(["R1"])) !== null) fail(`a wire with ${tap} was re-routed`);
      }
    },
  },
  {
    name: "moving one part leaves the other wires of the sheet alone",
    run: (fail) => {
      const other = { ...imported("e2"), source: "R3", target: "R4" } as Edge;
      const out = forgetImportedRoutes([imported("e1"), other], new Set(["R1"]));
      const kept = wpOf(out, "e2");
      if (!Array.isArray(kept) || kept.length !== WP.length) fail(`e2 waypoints = ${JSON.stringify(kept)}`);
    },
  },
];

/**
 * A re-routed wire must not land on a terminal that is not its own.
 *
 * The rule the editor was missing. `orthoVertices` weighed part *bodies* — a
 * wire crossing a symbol is ugly, so it prefers a shape that does not — but a
 * pin sits on the body's edge, so a route could clear every body and still run
 * straight over somebody's terminal. There it is not a detour: the `.asc` has no
 * way to say "this wire merely passes by", so it is saved as a crossing and read
 * back as a connection.
 *
 * The case below is the one that was reported, reduced to its geometry: a wire
 * running left along y=128 from a flip-flop's Q at (480,128) to a display moved
 * up the sheet, straight through the same flip-flop's D at (416,128). The file
 * came back with D, Q and ~Q on one node.
 */
const PIN_D = { x: 416, y: 128 };

CASES.push(
  {
    name: "a re-routed wire steps around a foreign pin",
    run: (fail) => {
      const from = { x: 480, y: 128 };
      const to = { x: 312, y: 48 };
      const path = orthoVertices([from, to], { avoid: [PIN_D] });
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1];
        const on = a.x === b.x
          ? PIN_D.x === a.x && PIN_D.y >= Math.min(a.y, b.y) && PIN_D.y <= Math.max(a.y, b.y)
          : a.y === b.y && PIN_D.y === a.y && PIN_D.x >= Math.min(a.x, b.x) && PIN_D.x <= Math.max(a.x, b.x);
        if (on) {
          fail(`route ${JSON.stringify(path)} runs over the pin at ${PIN_D.x},${PIN_D.y}`);
          return;
        }
      }
    },
  },
  {
    name: "without the rule that same route would have crossed it",
    run: (fail) => {
      // The counter-check, so the test above cannot pass by accident on a
      // geometry that never had the problem: with no pin to avoid, the shortest
      // shape is the one straight along y=128 — over the pin.
      const path = orthoVertices([{ x: 480, y: 128 }, { x: 312, y: 48 }]);
      const crosses = path.some((p, i) => i > 0
        && path[i - 1].y === 128 && p.y === 128
        && PIN_D.x >= Math.min(path[i - 1].x, p.x) && PIN_D.x <= Math.max(path[i - 1].x, p.x));
      if (!crosses) fail(`the unguarded route no longer crosses the pin: ${JSON.stringify(path)}`);
    },
  },
  {
    name: "a pin the wire itself ends on is not an obstacle",
    run: (fail) => {
      // Excluding the wire's own ends is by identity, not by position: a route
      // must still be drawable to the very pin it connects.
      const to = { x: 312, y: 48 };
      const path = orthoVertices([{ x: 480, y: 128 }, to], { avoid: [PIN_D] });
      const last = path[path.length - 1];
      if (last.x !== to.x || last.y !== to.y) fail(`route does not reach its end: ${JSON.stringify(path)}`);
    },
  },
);

export function runImportedRouteTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}

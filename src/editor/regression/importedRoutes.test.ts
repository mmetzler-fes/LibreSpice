import type { Edge } from "@xyflow/react";
import { forgetImportedRoutes } from "../importedRoutes.js";
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

export function runImportedRouteTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}

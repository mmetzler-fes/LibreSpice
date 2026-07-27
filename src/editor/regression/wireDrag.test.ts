import { grabWire, movedWaypoints, distanceAlong, type DragPoint } from "../wireDrag.js";
import { orthoVertices } from "@core/geometry/ortho.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Correcting a wire by hand: pressing a point of it and moving that point.
 *
 * The wire is stored as its two ends plus waypoints, and the right-angled path
 * is made from those — so the spot a user presses is as often a corner the
 * router invented as a waypoint of its own, and the whole question is which
 * waypoint the press stands for. These check that answer, and that the route
 * really does come back through the point afterwards, which is the thing the
 * user can see.
 *
 * Kept pure so it needs no canvas: React Flow does not render in this harness.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const P = (x: number, y: number): DragPoint => ({ x, y });
/** The route as drawn, which is what a press lands on. */
const drawn = (a: DragPoint, wps: DragPoint[], b: DragPoint) => orthoVertices([a, ...wps, b]);
/** Does the drawn route pass through `p`? */
const passesThrough = (verts: DragPoint[], p: DragPoint) =>
  (distanceAlong(verts, p, 0.5) ?? null) !== null;

const CASES: Case[] = [
  {
    name: "a press on a plain wire inserts a waypoint, and the route comes back through it",
    run: (fail) => {
      const a = P(0, 0), b = P(200, 80);
      const verts = drawn(a, [], b);
      const grab = grabWire(verts, [], P(100, 0));
      if (!grab) { fail("nothing grabbed on the wire's own path"); return; }
      if (grab.replace) fail("an empty wire has no waypoint to replace");
      const wps = movedWaypoints([], grab, P(100, 160));
      if (wps.length !== 1) { fail(`${wps.length} waypoints after the drag`); return; }
      if (!passesThrough(drawn(a, wps, b), P(100, 160))) fail("the route misses the point it was dragged to");
    },
  },
  {
    name: "a press on an existing waypoint moves that one instead of adding a second",
    run: (fail) => {
      const a = P(0, 0), b = P(200, 80);
      const w = P(100, 0);
      const verts = drawn(a, [w], b);
      const grab = grabWire(verts, [w], P(100, 0));
      if (!grab) { fail("nothing grabbed"); return; }
      if (!grab.replace) fail("the waypoint under the press was not recognised");
      const wps = movedWaypoints([w], grab, P(60, 40));
      if (wps.length !== 1) fail(`${wps.length} waypoints — the dragged one was duplicated`);
      if (wps[0].x !== 60 || wps[0].y !== 40) fail(`waypoint at ${wps[0].x},${wps[0].y}`);
    },
  },
  {
    name: "a new point goes in between the waypoints it lies between",
    run: (fail) => {
      const a = P(0, 0), b = P(300, 0);
      const w1 = P(100, 0), w2 = P(200, 0);
      const verts = drawn(a, [w1, w2], b);
      // Halfway between the two, and well clear of both: a press *near* one of
      // them takes hold of that one instead (the case above).
      const grab = grabWire(verts, [w1, w2], P(150, 0));
      if (!grab) { fail("nothing grabbed between the two waypoints"); return; }
      if (grab.replace) { fail("took the press for one of the existing waypoints"); return; }
      if (grab.index !== 1) fail(`inserted at ${grab.index}, not between the two`);
      // 152, not 150: a dragged point snaps to the grid like everything else.
      // What this case is about is the *order*, which the snap does not touch.
      const wps = movedWaypoints([w1, w2], grab, P(150, 120));
      if (wps.map((p) => p.x).join(",") !== "100,152,200") fail(`order came out ${wps.map((p) => p.x).join(",")}`);
    },
  },
  {
    name: "a press beside the wire takes hold of nothing",
    run: (fail) => {
      const verts = drawn(P(0, 0), [], P(200, 0));
      if (grabWire(verts, [], P(100, 40))) fail("a press 40 px off the wire grabbed it");
    },
  },
  {
    name: "a route that doubles back is read along its length, not by coordinate",
    run: (fail) => {
      // Out to the right, up, and back to the left: the two horizontal runs share
      // their x range, so ordering by coordinate would put the press on the wrong
      // one and the correction would jump to the other end of the wire.
      const a = P(0, 0), b = P(0, 100);
      const wps = [P(200, 0), P(200, 100)];
      const verts = drawn(a, wps, b);
      const grab = grabWire(verts, wps, P(100, 100));
      if (!grab) { fail("nothing grabbed on the return run"); return; }
      if (grab.replace) { fail("took the press for one of the corners"); return; }
      if (grab.index !== 2) fail(`inserted at ${grab.index}, not after both corners`);
    },
  },
  {
    name: "dragging the same point twice does not leave a stray waypoint behind",
    run: (fail) => {
      const a = P(0, 0), b = P(200, 80);
      let wps: DragPoint[] = [];
      let verts = drawn(a, wps, b);
      const first = grabWire(verts, wps, P(100, 0));
      if (!first) { fail("first grab found nothing"); return; }
      wps = movedWaypoints(wps, first, P(100, 160));
      verts = drawn(a, wps, b);
      // Now grab the point where it now is and move it again.
      const second = grabWire(verts, wps, P(100, 160));
      if (!second?.replace) { fail("the second grab did not find the point it had just placed"); return; }
      wps = movedWaypoints(wps, second, P(40, 160));
      if (wps.length !== 1) fail(`${wps.length} waypoints after two drags of one point`);
    },
  },
  {
    name: "a dragged corner lands on the grid",
    run: (fail) => {
      const a = P(0, 0), b = P(300, 0);
      const grab = grabWire(drawn(a, [], b), [], P(150, 0));
      if (!grab) { fail("nothing grabbed"); return; }
      const [w] = movedWaypoints([], grab, P(151, 122));
      if (w.x % 4 !== 0 || w.y % 4 !== 0) fail(`landed at ${w.x},${w.y}`);
    },
  },
  {
    name: "a corner dragged near a straight line is pulled onto it",
    run: (fail) => {
      // The magnetism: aiming for alignment should *achieve* alignment, or every
      // correction leaves a small step behind and the wire grows a staircase.
      const w1 = P(100, 200), w2 = P(300, 200);
      const grab = { index: 1, replace: true };
      const [, mid] = movedWaypoints([w1, P(200, 208), w2], grab, P(200, 206));
      if (mid.y !== 200) fail(`corner stayed at y=${mid.y} instead of lining up with 200`);
    },
  },
  {
    name: "a corner dragged clear of the line is left where it is put",
    run: (fail) => {
      const w1 = P(100, 200), w2 = P(300, 200);
      const grab = { index: 1, replace: true };
      const [, mid] = movedWaypoints([w1, P(200, 208), w2], grab, P(200, 260));
      if (mid.y !== 260) fail(`corner was dragged to 260 but came out at ${mid.y}`);
    },
  },
  {
    name: "the ends attract too, so a corner lines up with its own pin",
    run: (fail) => {
      const a = P(0, 100), b = P(400, 100);
      const grab = { index: 0, replace: true };
      const [w] = movedWaypoints([P(200, 108)], grab, P(200, 106), [a, b]);
      if (w.y !== 100) fail(`corner stayed at y=${w.y} instead of lining up with the ends`);
    },
  },
  {
    name: "dragging simplifies rather than accumulates",
    run: (fail) => {
      // What the wire is *for*: a point that no longer makes the route turn is
      // dropped, so repeated corrections cannot pile up into a staircase.
      const wps = movedWaypoints(
        [P(100, 200), P(200, 200), P(300, 200)],
        { index: 1, replace: true }, P(200, 200),
      );
      // Two, not one: the *middle* point is the redundant one. The outer two are
      // the ends of the list and have no neighbour beyond them to be in line
      // with, so nothing says they are superfluous.
      if (wps.length !== 2 || wps[0].x !== 100 || wps[1].x !== 300) {
        fail(`three collinear points came out as ${wps.map((p) => `${p.x},${p.y}`).join(" ")}`);
      }
    },
  },
  {
    name: "a there-and-back the user drew is kept",
    run: (fail) => {
      // Only points *between* their neighbours are dropped. One beyond them is a
      // deliberate detour, and straightening it would undo an edit nobody asked
      // to undo.
      const wps = movedWaypoints(
        [P(100, 200), P(400, 200), P(300, 200)],
        { index: 1, replace: true }, P(400, 200),
      );
      if (wps.length !== 3) fail(`the detour was flattened to ${wps.length} points`);
    },
  },
  {
    name: "a rectangle loop is pulled out of the wire",
    run: (fail) => {
      // The shape from the report: the route leaves, turns, comes back across
      // its own path and turns again. Every corner looks necessary on its own —
      // what gives it away is the path running over itself.
      const ends: [DragPoint, DragPoint] = [P(0, 0), P(400, 0)];
      const knot = [P(300, 0), P(300, 100), P(100, 100), P(100, 0)];
      const before = orthoVertices([ends[0], ...knot, ends[1]]);
      if (!overlaps(before)) { fail("the fixture is not knotted, so the case proves nothing"); return; }
      const after = movedWaypoints(knot, { index: 0, replace: true }, P(300, 0), ends);
      const verts = orthoVertices([ends[0], ...after, ends[1]]);
      if (overlaps(verts)) {
        fail(`still knotted: ${verts.map((p) => `${p.x},${p.y}`).join(" ")}`);
      }
    },
  },
  {
    name: "a plain corner survives the untangling",
    run: (fail) => {
      // Right angles stay possible — only the knots go. A single corner off the
      // straight line makes no self-overlap and must be left alone.
      const ends: [DragPoint, DragPoint] = [P(0, 0), P(400, 0)];
      const after = movedWaypoints([P(200, 160)], { index: 0, replace: true }, P(200, 160), ends);
      if (after.length !== 1 || after[0].y !== 160) {
        fail(`the corner was removed: ${after.map((p) => `${p.x},${p.y}`).join(" ")}`);
      }
    },
  },
  {
    name: "a square tab is pulled flat",
    run: (fail) => {
      // The shape from the report: out, along, and back to the same line. Nothing
      // overlaps, every corner is a right angle — the wire is just longer than it
      // needs to be, and a rubber band would not hold that shape.
      const ends: [DragPoint, DragPoint] = [P(0, 200), P(400, 200)];
      const tab = [P(40, 150), P(140, 150)];
      const after = movedWaypoints(tab, { index: 1, replace: true }, P(140, 200), ends);
      const verts = orthoVertices([ends[0], ...after, ends[1]]);
      const ys = new Set(verts.map((p) => p.y));
      if (ys.size !== 1 || !ys.has(200)) {
        fail(`the tab survived: ${verts.map((p) => `${p.x},${p.y}`).join(" ")}`);
      }
    },
  },
  {
    name: "the corner under the cursor is never pulled away",
    run: (fail) => {
      // Slackening must not undo the edit being made. The held point stays even
      // though dropping it would shorten the route.
      const ends: [DragPoint, DragPoint] = [P(0, 200), P(400, 200)];
      const after = movedWaypoints([P(200, 200)], { index: 0, replace: true }, P(200, 120), ends);
      if (!after.some((p) => p.y === 120)) {
        fail(`the held corner went: ${after.map((p) => `${p.x},${p.y}`).join(" ")}`);
      }
    },
  },
];

/** Does a drawn route run over itself? (the test's own reading of "knotted") */
function overlaps(verts: DragPoint[]): boolean {
  const segs: [DragPoint, DragPoint][] = [];
  for (let i = 0; i < verts.length - 1; i++) {
    if (verts[i].x !== verts[i + 1].x || verts[i].y !== verts[i + 1].y) segs.push([verts[i], verts[i + 1]]);
  }
  const touch = ([a, b]: [DragPoint, DragPoint], [c, d]: [DragPoint, DragPoint]) =>
    Math.min(a.x, b.x) <= Math.max(c.x, d.x) && Math.min(c.x, d.x) <= Math.max(a.x, b.x)
    && Math.min(a.y, b.y) <= Math.max(c.y, d.y) && Math.min(c.y, d.y) <= Math.max(a.y, b.y);
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 2; j < segs.length; j++) if (touch(segs[i], segs[j])) return true;
  }
  return false;
}

export function runWireDragTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  for (const tc of CASES) tc.run((reason) => failures.push({ name: tc.name, reason }));
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}

import { orthoVertices } from "@core/geometry/ortho.js";
import { snapToGrid } from "./pinGeometry.js";

/**
 * Correcting a drawn wire by hand: which point of it a press has taken hold of,
 * and what the wire's waypoints become when that point is moved.
 *
 * The wire is not stored as the line you see. It is two endpoints plus a list of
 * waypoints, and `orthoVertices` makes the right-angled path through them — so a
 * press lands on a *corner the router invented* as often as on a waypoint, and
 * the answer to "what did I just grab" has to be given in terms of the waypoint
 * list. That is what this does, and it is kept apart from the drawing so it can
 * be checked without a canvas (see wireDrag.test).
 *
 * Two cases, and the distinction matters: a press on an existing waypoint *moves*
 * it, anything else *inserts* one where it lies along the route. Without the
 * first, correcting a corner twice would leave two waypoints a grid step apart
 * and the second drag would fight the first.
 */

export interface DragPoint { x: number; y: number }

/** What a press on a wire took hold of. */
export interface WireGrab {
  /** Index into the waypoint list. */
  index: number;
  /** True when the press was on that waypoint, false when it goes in front of it. */
  replace: boolean;
}

/** Distance from `p` to the segment `a`–`b`, and how far along it that lands. */
function project(p: DragPoint, a: DragPoint, b: DragPoint): { dist: number; along: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { dist: Math.hypot(p.x - a.x, p.y - a.y), along: 0 };
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { dist: Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y), along: t * Math.sqrt(len2) };
}

/**
 * How far along a polyline a point sits, or null when it is not on it.
 *
 * Distance along the route is what orders a press against the waypoints. Plain
 * coordinates cannot: a route that doubles back passes the same x twice.
 */
export function distanceAlong(verts: DragPoint[], p: DragPoint, tolerance = Infinity): number | null {
  let best: number | null = null;
  let bestDist = tolerance;
  let run = 0;
  for (let i = 0; i + 1 < verts.length; i++) {
    const { dist, along } = project(p, verts[i], verts[i + 1]);
    if (dist <= bestDist) { bestDist = dist; best = run + along; }
    run += Math.hypot(verts[i + 1].x - verts[i].x, verts[i + 1].y - verts[i].y);
  }
  return best;
}

/**
 * Which waypoint a press on the drawn route takes hold of.
 *
 * `verts` is the path as drawn (endpoints, waypoints and the router's own
 * corners); `waypoints` are the wire's own, in order. Returns null when the press
 * is not on the wire at all.
 */
export function grabWire(
  verts: DragPoint[], waypoints: DragPoint[], press: DragPoint, grab = 8,
): WireGrab | null {
  if (verts.length < 2) return null;
  const at = distanceAlong(verts, press, grab);
  if (at === null) return null;

  let index = 0;
  for (let i = 0; i < waypoints.length; i++) {
    // A waypoint lies on the route by construction, so its own distance along is
    // well defined; comparing there rather than in x/y keeps a doubled-back route
    // from matching the wrong one.
    const w = distanceAlong(verts, waypoints[i]);
    if (w === null) continue;
    if (Math.abs(w - at) <= grab) return { index: i, replace: true };
    if (w < at) index = i + 1;
  }
  return { index, replace: false };
}

/**
 * The waypoint list after the grabbed point has been moved to `to`.
 *
 * Snapped and tidied, not merely inserted. Both matter for the shape that comes
 * out, and neither was done:
 *
 *  - **Snapped**, like every part and every name. An off-grid waypoint puts a
 *    kink of one to three units into an otherwise straight run — invisible until
 *    it is saved, where it becomes a `WIRE` line that no longer meets the grid
 *    the rest of the sheet lives on.
 *  - **Tidied**, which is what stops the loops. Each leg between two consecutive
 *    points is right-angled *on its own*, so a waypoint that lies behind its
 *    neighbour makes the two legs run against each other: the wire leaves, comes
 *    back past where it started and goes out again, enclosing a rectangle. Drag
 *    a corner across the wire's own path and that is exactly what happens.
 *
 * Tidying is done on the waypoints, deliberately, and not on the drawn polyline.
 * The polyline is what a net name is resolved against (see anchorNets), so
 * shortening it could move a wire out from under a label; the waypoints are the
 * user's own marks, and dropping one that says nothing changes no geometry that
 * anything else depends on.
 */
export function movedWaypoints(
  waypoints: DragPoint[], grab: WireGrab, to: DragPoint, ends?: [DragPoint, DragPoint],
): DragPoint[] {
  const next = waypoints.slice();
  next.splice(grab.index, grab.replace ? 1 : 0, { x: snapToGrid(to.x), y: snapToGrid(to.y) });
  const held = next[grab.index];
  return slacken(unknot(tidyWaypoints(alignToNeighbours(next, grab.index, ends)), grab.index, ends), held, ends);
}

/**
 * Pull the slack out of a wire that has tied itself in a knot.
 *
 * `tidyWaypoints` drops points that say nothing — repeats, and corners on the
 * straight line between their neighbours. That is not enough for the shape this
 * is named after. A rectangle standing in the middle of a wire is made of points
 * that are *not* collinear with anything: the route leaves, turns, comes back
 * across its own path and turns again, and every one of its corners looks
 * necessary from where it stands.
 *
 * What gives it away is the path as a whole. A wire that runs over itself — two
 * legs that are not neighbours sharing any point at all — is knotted, whatever
 * its individual corners say. So the test is on the drawn polyline, and the cure
 * is to drop waypoints until it comes out simple: like letting a rubber band go
 * slack, right angles and all, rather than straightening it by force.
 *
 * The point just placed is kept if there is any way to keep it — it is the one
 * the user has hold of. The others are tried newest first, since the knot is
 * nearly always made of the corners left behind by earlier corrections.
 *
 * Bounded by the number of waypoints, and it gives up rather than emptying the
 * list: a wire the user has genuinely routed through a tight spot may have no
 * simple path at all, and forcing one would throw their work away.
 */
function unknot(
  waypoints: DragPoint[], keep: number, ends?: [DragPoint, DragPoint],
): DragPoint[] {
  if (!ends || waypoints.length < 2) return waypoints;
  let points = waypoints;
  let held = points[keep];
  for (let guard = points.length; guard > 0 && knotted(points, ends); guard--) {
    const order = points
      .map((_, i) => i)
      .filter((i) => points[i] !== held)
      .reverse();
    const next = order.find((i) => !knotted(without(points, i), ends));
    if (next !== undefined) { points = without(points, next); continue; }
    // Nothing on its own untangles it: drop the newest and try again, and let
    // the held point go last of all.
    const drop = order[0];
    if (drop === undefined) { held = undefined as unknown as DragPoint; continue; }
    points = without(points, drop);
  }
  return points;
}

const without = (points: DragPoint[], i: number) => points.filter((_, k) => k !== i);

/** Total length of the route these waypoints produce. */
function routeLength(waypoints: DragPoint[], ends: [DragPoint, DragPoint]): number {
  const v = orthoVertices([ends[0], ...waypoints, ends[1]]);
  let n = 0;
  for (let i = 0; i < v.length - 1; i++) n += Math.abs(v[i + 1].x - v[i].x) + Math.abs(v[i + 1].y - v[i].y);
  return n;
}

/**
 * Let the rest of the wire go slack.
 *
 * `unknot` deals with a route that runs over itself. It says nothing about the
 * other shape that keeps turning up: a square tab standing off an otherwise
 * straight run — out, along, and back to the same line. Nothing overlaps there,
 * every corner is a right angle, and the wire is simply longer than it needs to
 * be for no reason anyone can point at.
 *
 * A rubber band has no such shapes because it pulls itself in wherever it can.
 * So: any waypoint whose removal makes the route *shorter* without knotting it
 * is slack, and goes. What is left are the corners that actually take the wire
 * somewhere — and the one under the cursor, which is held whatever it costs.
 *
 * The held point is why this is safe to apply on every drag rather than only on
 * demand. Correcting a wire moves one corner and lets the rest settle; it never
 * takes away the corner being placed. Older corners do go, and that is the
 * intent — they are what a route accumulates while being tidied by hand, and
 * keeping them is how a wire ends up as a staircase nobody drew.
 */
function slacken(
  waypoints: DragPoint[], held: DragPoint | undefined, ends?: [DragPoint, DragPoint],
): DragPoint[] {
  if (!ends || waypoints.length === 0) return waypoints;
  let points = waypoints;
  for (let guard = points.length; guard > 0; guard--) {
    const now = routeLength(points, ends);
    let best: number | undefined;
    for (let i = 0; i < points.length; i++) {
      if (held && points[i].x === held.x && points[i].y === held.y) continue;
      const rest = without(points, i);
      if (routeLength(rest, ends) >= now) continue;
      if (knotted(rest, ends)) continue;
      best = i;
      break;
    }
    if (best === undefined) return points;
    points = without(points, best);
  }
  return points;
}

/** Does the drawn route run over itself? */
function knotted(waypoints: DragPoint[], ends: [DragPoint, DragPoint]): boolean {
  const verts = orthoVertices([ends[0], ...waypoints, ends[1]]);
  const segs: [DragPoint, DragPoint][] = [];
  for (let i = 0; i < verts.length - 1; i++) {
    if (verts[i].x !== verts[i + 1].x || verts[i].y !== verts[i + 1].y) segs.push([verts[i], verts[i + 1]]);
  }
  // Neighbouring legs share their corner by construction; anything further apart
  // touching at all means the path has come back to where it already was.
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 2; j < segs.length; j++) {
      if (segmentsTouch(segs[i], segs[j])) return true;
    }
  }
  return false;
}

/** Do two axis-aligned segments share any point? */
function segmentsTouch([a, b]: [DragPoint, DragPoint], [c, d]: [DragPoint, DragPoint]): boolean {
  const ax1 = Math.min(a.x, b.x), ax2 = Math.max(a.x, b.x);
  const ay1 = Math.min(a.y, b.y), ay2 = Math.max(a.y, b.y);
  const bx1 = Math.min(c.x, d.x), bx2 = Math.max(c.x, d.x);
  const by1 = Math.min(c.y, d.y), by2 = Math.max(c.y, d.y);
  return ax1 <= bx2 && bx1 <= ax2 && ay1 <= by2 && by1 <= ay2;
}

/**
 * How far a dragged corner reaches for a straight line with its neighbours.
 *
 * Three grid steps: close enough that it only catches a corner the user was
 * plainly aiming to line up, far enough that they do not have to hit the pixel.
 * The same idea as the anchor's magnet, for the same reason — the alternative to
 * a magnet is a tolerance nobody can see.
 */
const STRAIGHTEN = 12;

/**
 * Pull a dragged corner onto line with what sits either side of it.
 *
 * Wires want to be straight, and dragging one should make it more so, not less.
 * Without this every correction leaves a small step behind: the corner lands two
 * or six units off the run it belongs to, the route inserts a jog to reach it,
 * and the wire grows a staircase that no one drew and no one can quite remove.
 *
 * Only the point just moved is touched, and only across the axis it is already
 * near. Its neighbours are left alone — straightening those would move parts of
 * the wire the user is not pointing at.
 *
 * `ends` are the wire's two endpoints. They matter for the first and last
 * waypoint, whose neighbour on one side is a pin rather than another waypoint:
 * without them a corner dragged towards its own pin never quite lines up with
 * it, which is the commonest correction there is.
 */
function alignToNeighbours(
  points: DragPoint[], index: number, ends?: [DragPoint, DragPoint],
): DragPoint[] {
  const p = points[index];
  if (!p) return points;
  const before = points[index - 1] ?? ends?.[0];
  const after = points[index + 1] ?? ends?.[1];
  let { x, y } = p;
  for (const n of [before, after]) {
    if (!n) continue;
    if (Math.abs(n.x - x) <= STRAIGHTEN) x = n.x;
    if (Math.abs(n.y - y) <= STRAIGHTEN) y = n.y;
  }
  if (x === p.x && y === p.y) return points;
  const out = points.slice();
  out[index] = { x, y };
  return out;
}

/**
 * Drop the waypoints that say nothing: repeats, and points a route would pass
 * through anyway.
 *
 * A waypoint earns its place by making the wire turn somewhere it otherwise
 * would not. One that repeats its neighbour is noise; one that sits on the
 * straight line between its neighbours is a corner the router would have drawn
 * itself. Both survive a drag today and accumulate: every correction of the same
 * corner leaves another one behind, and the route starts folding over itself.
 *
 * Endpoints are not in this list — it is the waypoints alone — so nothing here
 * can detach a wire from a pin.
 */
export function tidyWaypoints(waypoints: DragPoint[]): DragPoint[] {
  const out: DragPoint[] = [];
  for (const p of waypoints) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push(p);
  }
  // Collinear middles, repeatedly: removing one can leave its neighbours in line
  // with each other.
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      const straight = (a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y);
      if (!straight) continue;
      // Only when `b` lies *between* its neighbours. A point beyond them is a
      // genuine there-and-back the user drew, and removing it would silently
      // straighten a detour they meant to keep.
      const between = a.x === c.x
        ? b.y >= Math.min(a.y, c.y) && b.y <= Math.max(a.y, c.y)
        : b.x >= Math.min(a.x, c.x) && b.x <= Math.max(a.x, c.x);
      if (!between) continue;
      out.splice(i, 1);
      changed = true;
      break;
    }
  }
  return out;
}

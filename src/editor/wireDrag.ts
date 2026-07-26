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

/** The waypoint list after the grabbed point has been moved to `to`. */
export function movedWaypoints(waypoints: DragPoint[], grab: WireGrab, to: DragPoint): DragPoint[] {
  const next = waypoints.slice();
  next.splice(grab.index, grab.replace ? 1 : 0, { x: to.x, y: to.y });
  return next;
}

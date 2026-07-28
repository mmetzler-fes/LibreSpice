import { ANCHOR_TOLERANCE } from "@core/circuit/anchorResolve.js";

/**
 * The magnet that puts a name on a wire.
 *
 * A name finds its net by lying on one, within `ANCHOR_TOLERANCE` — a third of a
 * grid step, deliberately too small to reach the parallel wire one step away and
 * far too small to aim at with a pointer. The magnet closes that gap: it reaches
 * a good deal further, and *snaps onto* the wire it found, so what is released
 * always lands well inside the resolving tolerance instead of balanced on its
 * edge.
 *
 * It lives on its own because two gestures need it and must agree: dragging a
 * name (NetAnchorLayer) and dropping a fresh one from the toolbar
 * (SchematicCanvas). A name that snapped while dragged but not while placed is
 * the same complaint twice.
 *
 * The other half of the rule is {@link isLooseAnchor}: the magnet is for a name
 * that is *not* on a wire yet. One that already names a net keeps it — dragging
 * its tag out of a crowded corner must never hand it to the wire it passes over.
 */

export interface Pt { x: number; y: number }

/**
 * How far the magnet reaches, in flow units — a grid step and a half.
 *
 * Wide enough to catch a name aimed roughly at a wire, narrow enough that it
 * cannot cross the gap to the next one on the 16-unit grid while the intended
 * wire is nearer.
 */
export const SNAP_REACH = 24;

/** The point on `verts` nearest `p`, with its distance. */
export function projectToRoute(p: Pt, verts: Pt[]): { point: Pt; dist: number } {
  let best: Pt = verts[0] ?? p;
  let dist = Infinity;
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i], b = verts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < dist) { dist = d; best = q; }
  }
  return { point: best, dist };
}

/**
 * The nearest wire within `reach`, as the point to snap to and the route to
 * light up — or null when the name is out in the open, which is allowed and has
 * to stay allowed (a name that reaches nothing names nothing, and LTSpice writes
 * those too).
 *
 * Zero-length routes (a bare pin) are skipped: a pin is drawn as a route so that
 * a name dropped straight on a terminal resolves, but there is no line there to
 * slide a name along, and snapping to one would drag names onto pins the user
 * only passed near.
 */
export function nearestRoute<R extends { netId: string; verts: Pt[] }>(
  p: Pt, routes: R[], reach: number = SNAP_REACH,
): { point: Pt; verts: Pt[]; netId: string } | null {
  let best: { point: Pt; verts: Pt[]; netId: string } | null = null;
  let bestDist = reach;
  for (const r of routes) {
    if (r.verts.length < 2) continue;
    const { point, dist } = projectToRoute(p, r.verts);
    if (dist <= bestDist) { bestDist = dist; best = { point, verts: r.verts, netId: r.netId }; }
  }
  return best;
}

/**
 * Is this point on no wire at all?
 *
 * Asked of a name's anchor, this is "does it name anything" — the same test the
 * resolver makes, in the same tolerance, so the answer here and the net the
 * store derives can never disagree. It decides which gesture a drag on the tag
 * is: re-aiming a loose name, or moving the label of one that is already
 * attached.
 */
export function isLooseAnchor<R extends { netId: string; verts: Pt[] }>(p: Pt, routes: R[]): boolean {
  for (const r of routes) {
    if (projectToRoute(p, r.verts).dist <= ANCHOR_TOLERANCE) return false;
  }
  return true;
}

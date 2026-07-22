import type { RoutePoint } from "@core/geometry/wireRoutes.js";

/**
 * Which net a coordinate-anchored name belongs to.
 *
 * This is the one genuinely new mechanism the anchor model needs. Today a net
 * label is wired into the topology, so its net comes for free from the edge it
 * hangs on; an anchor owns no edge and has to find its net the way LTSpice
 * does — by lying on a wire.
 *
 * The tolerance exists because an anchor is a *label*, placed to be read: users
 * put it beside the wire, not exactly on the pixel. Half a grid step is the
 * widest that cannot reach a neighbouring parallel wire, which is the failure
 * that would silently join two nets.
 *
 * An anchor that reaches nothing resolves to `null` — a name floating on the
 * sheet, naming nothing. LTSpice allows exactly that, and `leitungstest.asc`
 * contains two of them (`x3`, `nc3`).
 */

/** A wire, with the net it belongs to. */
export interface RoutedNet {
  netId: string;
  verts: RoutePoint[];
}

/** Half a grid step (GRID is 16), so a parallel wire one step away is out of reach. */
export const ANCHOR_TOLERANCE = 8;

/** Distance from a point to a segment. */
function distToSegment(p: RoutePoint, a: RoutePoint, b: RoutePoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

/** Distance from a point to a whole route, or Infinity for an empty one. */
export function distToRoute(p: RoutePoint, verts: RoutePoint[]): number {
  let best = Infinity;
  for (let i = 0; i < verts.length - 1; i++) best = Math.min(best, distToSegment(p, verts[i], verts[i + 1]));
  return best;
}

/**
 * The net under `p`, or `null` when nothing is close enough.
 *
 * The *nearest* wire wins rather than the first one found, so an anchor sitting
 * near a junction lands on the wire it actually touches instead of whichever
 * happened to be routed first.
 */
export function resolveAnchor(
  p: RoutePoint, routes: RoutedNet[], tolerance = ANCHOR_TOLERANCE,
): string | null {
  let bestNet: string | null = null;
  let bestDist = tolerance;
  for (const r of routes) {
    const d = distToRoute(p, r.verts);
    if (d <= bestDist) { bestDist = d; bestNet = r.netId; }
  }
  return bestNet;
}

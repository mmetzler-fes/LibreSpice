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
  /**
   * What this route *is*, independently of the net it currently forms part of:
   * `edge:<id>` for a wire, `pin:<portId>` for a bare terminal.
   *
   * The net is the wrong thing for a name to hold on to. It is derived from the
   * whole sheet, so an edit anywhere can renumber the net a name sits on while
   * the wire under that name has not moved at all. A wire keeps its identity
   * until it is deleted.
   */
  key?: string;
}

/**
 * Where a name is fastened: which route, how far along it, and how far off it.
 *
 * Measured in *units from the nearer end*, not as a fraction of the length. A
 * fraction only holds while the wire keeps its length, and re-routing is exactly
 * what changes it: move the part at one end of an L and the wire grows a long
 * detour, so "80% along" is suddenly somewhere else entirely. On two Schmitt
 * trigger sheets that walked `UE+` off the + input and onto a wire belonging to
 * another net — the failure this whole binding exists to prevent, reintroduced
 * by the measure. From the near end, the same name stays 16 units from the pin it
 * was 16 units from, whatever happened at the far end.
 *
 * The offset is not a refinement either — without it the binding is lossy. A
 * name may lie up to {@link ANCHOR_TOLERANCE} beside its wire and still name it,
 * which is what makes it something a person can place rather than a coordinate
 * they have to hit. Recomputing without it puts the name *on* the wire, so merely
 * loading a schematic and saving it again moved every such name.
 */
export interface AnchorBinding {
  key: string;
  /** Distance along the route from the end given by `fromEnd`. */
  s: number;
  /** Measured back from the route's last vertex rather than forward from its first. */
  fromEnd: boolean;
  /** Offset from that point, so an unchanged wire yields the coordinate back exactly. */
  ox: number;
  oy: number;
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

/** Distance from a point to the nearest of several routed nets. */
export function distToRoutes(p: RoutePoint, routes: RoutedNet[]): number {
  let best = Infinity;
  for (const r of routes) best = Math.min(best, distToRoute(p, r.verts));
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


/** Total length of a polyline. */
function routeLength(verts: RoutePoint[]): number {
  let n = 0;
  for (let i = 0; i < verts.length - 1; i++) n += Math.hypot(verts[i + 1].x - verts[i].x, verts[i + 1].y - verts[i].y);
  return n;
}

/**
 * How far along `verts` the point nearest `p` lies, in units from the first
 * vertex. Zero for a degenerate route (a bare pin): it has no length to be
 * partway along, and needs none.
 */
export function positionAlong(p: RoutePoint, verts: RoutePoint[]): number {
  const total = routeLength(verts);
  if (total === 0) return 0;
  let best = Infinity, at = 0, walked = 0;
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i], b = verts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy), len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < best) { best = d; at = walked + t * len; }
    walked += len;
  }
  return at;
}

/** The point `s` units along `verts` from its first vertex. */
export function pointAlong(verts: RoutePoint[], s: number): RoutePoint | null {
  if (verts.length === 0) return null;
  const total = routeLength(verts);
  if (total === 0) return { x: Math.round(verts[0].x), y: Math.round(verts[0].y) };
  let want = Math.max(0, Math.min(total, s));
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i], b = verts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (want <= len || i === verts.length - 2) {
      const f = len === 0 ? 0 : want / len;
      return { x: Math.round(a.x + (b.x - a.x) * f), y: Math.round(a.y + (b.y - a.y) * f) };
    }
    want -= len;
  }
  return null;
}

/**
 * Fasten a name to the route it is lying on.
 *
 * The same nearest-route test `resolveAnchor` makes, but it hands back *what* it
 * landed on rather than only which net that route belongs to — which is what
 * lets the name be carried along when the wire is re-routed under it.
 */
export function bindAnchor(
  p: RoutePoint, routes: RoutedNet[], tolerance = ANCHOR_TOLERANCE,
): (AnchorBinding & { netId: string }) | null {
  let best: RoutedNet | null = null;
  let bestDist = tolerance;
  for (const r of routes) {
    if (!r.key) continue;
    const d = distToRoute(p, r.verts);
    if (d <= bestDist) { bestDist = d; best = r; }
  }
  if (!best) return null;
  return bindAnchorTo(p, best);
}

/**
 * Fasten a name to one particular route, chosen by the caller.
 *
 * The caller that matters is the re-fastening at the end of a rebuild: a name
 * that is still lying on the wire it was already fastened to must be fastened to
 * *that* wire again, not to whichever route is now nearest. Otherwise a part
 * dragged so that one of its pins lands on a named point quietly takes the name
 * over — the binding hops to the pin, and from then on the name is that pin's.
 */
export function bindAnchorTo(
  p: RoutePoint, route: RoutedNet,
): (AnchorBinding & { netId: string }) | null {
  const best = route;
  if (!best.key) return null;
  const at = positionAlong(p, best.verts);
  // From whichever end is nearer: that is the end whose geometry the name is
  // about — the pin it labels, the corner it sits beside — and the one least
  // likely to be the end that moves.
  const total = routeLength(best.verts);
  const fromEnd = at > total / 2;
  const on = pointAlong(best.verts, at) ?? p;
  return {
    key: best.key!, s: fromEnd ? total - at : at, fromEnd,
    ox: p.x - on.x, oy: p.y - on.y, netId: best.netId,
  };
}

/** The coordinate a binding stands for on the route it names. */
export function anchorFromBinding(verts: RoutePoint[], b: AnchorBinding): RoutePoint | null {
  const on = pointAlong(verts, b.fromEnd ? routeLength(verts) - b.s : b.s);
  return on ? { x: Math.round(on.x + b.ox), y: Math.round(on.y + b.oy) } : null;
}

import type { Node, Edge } from "@xyflow/react";
import { wireRoutes, type PinLookup, type RoutePoint } from "@core/geometry/wireRoutes.js";
import { resolveAnchor, ANCHOR_TOLERANCE, type RoutedNet } from "@core/circuit/anchorResolve.js";
import type { NetAnchor } from "@core/circuit/netAnchor.js";
import { getNodePins, pinOutwardAxis, NODE_SIZE } from "./pinGeometry.js";
import type { SymbolNorm } from "@sym/asyParser.js";

/**
 * Which net each coordinate-anchored name belongs to.
 *
 * The glue between the pure geometry (`anchorResolve`) and the canvas's own
 * measurement of where things sit (`getNodePins`, flow space). It lives in the
 * editor layer on purpose: there are two pin coordinate systems in this app and
 * they are not interchangeable — the exporter measures in LTSpice symbol space,
 * everything on screen measures here (see wireRoutes' header). An anchor is
 * resolved against what the user sees, because that is what they aimed at.
 *
 * A pin is a zero-length route. That is not a trick to save code: with the lead
 * gone (a label dropped on a pin now simply sits there, as in LTSpice), an
 * anchor's net is just as often a bare pin as a wire, and `distToSegment`
 * already answers "distance to a degenerate segment" with the distance to the
 * point. One resolution rule covers both.
 */

/**
 * Pin lookup in flow space, for routing the wires an anchor may sit on.
 *
 * Falls back to the node's centre when the handle cannot be located. That case is
 * real: a part whose `.asy` has not loaded yet has no pins at all, and without
 * the fallback *no* wire routes, so every name on the sheet resolves to nothing
 * and the circuit briefly loses all its net names. Half a symbol off is wrong;
 * silently un-naming the whole schematic is worse, and it recovers on the next
 * rebuild once the symbol is there.
 */
function flowPins(nodes: Node[], norm: SymbolNorm): PinLookup {
  const at = new Map<string, RoutePoint>();
  const axis = new Map<string, ReturnType<typeof pinOutwardAxis>>();
  const centre = new Map<string, RoutePoint>();
  for (const n of nodes) {
    centre.set(n.id, { x: n.position.x + NODE_SIZE / 2, y: n.position.y + NODE_SIZE / 2 });
    for (const p of getNodePins(n, norm)) {
      at.set(`${n.id}|${p.handleId}`, { x: p.x, y: p.y });
      axis.set(`${n.id}|${p.handleId}`, pinOutwardAxis(n, p.handleId, norm));
    }
  }
  return {
    at: (nodeId, handle) => at.get(`${nodeId}|${handle}`) ?? centre.get(nodeId),
    axis: (nodeId, handle) => axis.get(`${nodeId}|${handle}`),
  };
}

/** The net a pin belongs to, keyed as the circuit keys its ports. */
export interface PortNets {
  netOf(portId: string): string | undefined;
}

/**
 * Every net that is visible on the sheet, as the polylines it occupies: its
 * wires, plus its pins as zero-length routes.
 *
 * Both are needed. A wire carries the name a user drops onto the middle of it;
 * a pin carries the name dropped straight onto a part's terminal, which used to
 * be impossible (the lead pushed it aside) and is now the LTSpice idiom.
 */
export function netRoutes(
  nodes: Node[], edges: Edge[], nets: PortNets, norm: SymbolNorm = "default", orphanWires: string[] = [],
): RoutedNet[] {
  const pins = flowPins(nodes, norm);
  const out: RoutedNet[] = [];

  for (const { edge, verts } of wireRoutes(edges, pins)) {
    const netId = nets.netOf(`${edge.source}-${edge.sourceHandle}`) ?? nets.netOf(`${edge.target}-${edge.targetHandle}`);
    if (netId) out.push({ netId, verts });
  }

  for (const n of nodes) {
    for (const p of getNodePins(n, norm)) {
      const netId = nets.netOf(`${n.id}-${p.handleId}`);
      if (netId) out.push({ netId, verts: [{ x: p.x, y: p.y }, { x: p.x, y: p.y }] });
    }
  }

  return [...out, ...attachedOrphans(orphanWires, out)];
}

/**
 * Everything on the sheet that decides which net a name lies on.
 *
 * Bundled into one argument because leaving a piece out is silent: forget the
 * orphan wires and a third of the names in the bundled examples stop resolving,
 * with nothing to show for it but net names quietly reverting to `net7`.
 */
export interface AnchorSheet {
  nodes: Node[];
  edges: Edge[];
  netAnchors: NetAnchor[];
  ascOrphanWires: string[];
  circuit: { components: Map<string, { ports: { id: string; netId?: string | null }[] }> };
}

/** Every net on the sheet as the polylines it occupies (see netRoutes). */
export function anchorRoutes(sheet: AnchorSheet, norm: SymbolNorm = "default"): RoutedNet[] {
  const nets: PortNets = {
    netOf: (portId) => {
      const compId = portId.slice(0, portId.lastIndexOf("-"));
      return sheet.circuit.components.get(compId)?.ports.find((p) => p.id === portId)?.netId ?? undefined;
    },
  };
  return netRoutes(sheet.nodes, sheet.edges, nets, norm, sheet.ascOrphanWires);
}

/** The net under each name, by anchor id — the one way to ask this question. */
export function resolveAnchors(sheet: AnchorSheet, norm: SymbolNorm = "default"): Map<string, string> {
  return anchorNets(sheet.netAnchors, anchorRoutes(sheet, norm));
}

/**
 * The net under each anchor, by anchor id. Anchors that reach nothing are left
 * out — a name floating on the sheet names nothing, which LTSpice allows and
 * `leitungstest.asc` contains two of (`x3`, `nc3`).
 */
export function anchorNets(anchors: NetAnchor[], routes: RoutedNet[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const a of anchors) {
    const netId = resolveAnchor({ x: a.x, y: a.y }, routes);
    if (netId) out.set(a.id, netId);
  }
  return out;
}

/**
 * Orphan wires as connected groups of segments.
 *
 * A wire our edge model cannot hold — a stub, a spur, a segment whose far end is
 * on no pin — is kept verbatim so a saved file stays faithful (see
 * LTSpiceParser.orphanWires). It used to be *only* that: inert scenery. It is not
 * inert any more, because names moved out of the topology.
 *
 * Grouped rather than taken one at a time, because these stubs chain: LTSpice
 * files run a supply rail out of an op-amp pin over two or three segments and
 * park the flag at the end. Only the whole chain touches both the pin and the
 * name, so only the whole chain can join them.
 */
export function orphanGroups(orphanWires: string[]): RoutePoint[][][] {
  const segments: RoutePoint[][] = [];
  for (const line of orphanWires) {
    const m = /^WIRE\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/i.exec(line.trim());
    if (m) segments.push([{ x: +m[1], y: +m[2] }, { x: +m[3], y: +m[4] }]);
  }

  // Union by shared endpoint, then by proximity — the ends of two segments that
  // meet are written as the same integer pair, so exact keys are enough.
  const key = (p: RoutePoint) => `${p.x},${p.y}`;
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r) ?? r;
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const seg of segments) {
    for (const p of seg) if (!parent.has(key(p))) parent.set(key(p), key(p));
    union(key(seg[0]), key(seg[1]));
  }
  // A segment ending *on* another one (a T-junction, not a shared endpoint) is
  // connected too, which is how a rail taps a run rather than meeting its end.
  for (const a of segments) {
    for (const b of segments) {
      if (a === b) continue;
      for (const p of a) {
        if (distToSeg(p, b[0], b[1]) <= 1) union(key(p), key(b[0]));
      }
    }
  }

  const groups = new Map<string, RoutePoint[][]>();
  for (const seg of segments) {
    const root = find(key(seg[0]));
    groups.set(root, [...(groups.get(root) ?? []), seg]);
  }
  return [...groups.values()];
}

/** Distance from a point to a segment. */
function distToSeg(p: RoutePoint, a: RoutePoint, b: RoutePoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

/** Distance from a point to the nearest segment of a group. */
export function distToGroup(p: RoutePoint, group: RoutePoint[][]): number {
  let best = Infinity;
  for (const seg of group) best = Math.min(best, distToSeg(p, seg[0], seg[1]));
  return best;
}

/** Does `p` lie on any segment of this group? */
export function touchesGroup(p: RoutePoint, group: RoutePoint[][], tolerance = ANCHOR_TOLERANCE): boolean {
  return group.some((seg) => distToSeg(p, seg[0], seg[1]) <= tolerance);
}

/** Orphan groups that reach a known net, each carrying that net. */
function attachedOrphans(orphanWires: string[], routes: RoutedNet[]): RoutedNet[] {
  const groups = orphanGroups(orphanWires);
  if (groups.length === 0) return [];

  const known = [...routes];
  const attached: RoutedNet[] = [];
  const pending = groups.map((segs) => ({ segs, done: false }));
  // Repeated because a group may only reach a net *through* another group.
  for (let pass = 0; pass < pending.length; pass++) {
    let progress = false;
    for (const g of pending) {
      if (g.done) continue;
      let netId: string | null = null;
      for (const seg of g.segs) {
        netId = resolveAnchor(seg[0], known) ?? resolveAnchor(seg[1], known);
        if (netId) break;
      }
      if (!netId) continue;
      g.done = true;
      progress = true;
      for (const seg of g.segs) {
        const r = { netId, verts: seg };
        known.push(r);
        attached.push(r);
      }
    }
    if (!progress) break;
  }
  return attached;
}

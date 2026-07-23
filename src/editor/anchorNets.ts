import type { Node, Edge } from "@xyflow/react";
import { wireRoutes, type PinLookup, type RoutePoint } from "@core/geometry/wireRoutes.js";
import { resolveAnchor, type RoutedNet } from "@core/circuit/anchorResolve.js";
import type { NetAnchor } from "@core/circuit/netAnchor.js";
import { getNodePins, pinOutwardAxis } from "./pinGeometry.js";
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

/** Pin lookup in flow space, for routing the wires an anchor may sit on. */
function flowPins(nodes: Node[], norm: SymbolNorm): PinLookup {
  const at = new Map<string, RoutePoint>();
  const axis = new Map<string, ReturnType<typeof pinOutwardAxis>>();
  for (const n of nodes) {
    for (const p of getNodePins(n, norm)) {
      at.set(`${n.id}|${p.handleId}`, { x: p.x, y: p.y });
      axis.set(`${n.id}|${p.handleId}`, pinOutwardAxis(n, p.handleId, norm));
    }
  }
  return {
    at: (nodeId, handle) => at.get(`${nodeId}|${handle}`),
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
export function netRoutes(nodes: Node[], edges: Edge[], nets: PortNets, norm: SymbolNorm = "default"): RoutedNet[] {
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
  return out;
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

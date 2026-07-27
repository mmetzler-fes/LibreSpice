import type { Node, Edge } from "@xyflow/react";
import { wireRoutes, type PinLookup, type RoutePoint } from "@core/geometry/wireRoutes.js";
import { resolveAnchor, type RoutedNet } from "@core/circuit/anchorResolve.js";
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
  nodes: Node[], edges: Edge[], nets: PortNets, norm: SymbolNorm = "default",
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

  return out;
}

/**
 * Everything on the sheet that decides which net a name lies on.
 *
 * One argument rather than four loose ones: this is asked from the store, the
 * properties panel, the context menu and the tests, and each of them getting the
 * pieces right separately is how they drift apart.
 */
export interface AnchorSheet {
  nodes: Node[];
  edges: Edge[];
  netAnchors: NetAnchor[];
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
  return netRoutes(sheet.nodes, sheet.edges, nets, norm);
}

/** The net under each name, by anchor id — the one way to ask this question. */
export function resolveAnchors(sheet: AnchorSheet, norm: SymbolNorm = "default"): Map<string, string> {
  return anchorNets(sheet.netAnchors, anchorRoutes(sheet, norm));
}

/**
 * The names sitting on the nets a given part is wired to, by port.
 *
 * The reverse of the question the anchor panel answers. A name knows which net
 * it lies on because it lies on it; a *part* has no idea what its nets are
 * called, and on a sheet where the wiring is mostly labels rather than lines
 * that is exactly what one wants to know from it — "this input of the display,
 * what is the net called, and where is the name that says so".
 *
 * One entry per port, including ports with no name on their net: an input whose
 * net nobody has named is worth showing as such, since it is the thing that has
 * to be fixed before two halves of a schematic join up.
 */
export function anchorsByPort(
  sheet: AnchorSheet, componentId: string, norm: SymbolNorm = "default",
): { portId: string; netId: string | null; anchorIds: string[] }[] {
  const comp = sheet.circuit.components.get(componentId);
  if (!comp) return [];
  const byAnchor = resolveAnchors(sheet, norm);
  return comp.ports.map((p) => {
    const netId = p.netId ?? null;
    return {
      portId: p.id,
      netId,
      anchorIds: netId
        ? sheet.netAnchors.filter((a) => byAnchor.get(a.id) === netId).map((a) => a.id)
        : [],
    };
  });
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

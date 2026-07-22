import type { Edge } from "@xyflow/react";
import { orthoVertices, type Axis, type RouteHints } from "./ortho.js";

/**
 * The polyline every wire is actually drawn along.
 *
 * Until now this was computed inside the `.asc` exporter and nowhere else, which
 * was fine while the only question was "what do I write to the file". It stops
 * being fine as soon as anything has to ask *where a wire runs* — resolving a
 * net label to the net beneath it, hit-testing, snapping. Extracted here so
 * there is one answer to that question instead of a second, subtly different
 * copy of the routing rules.
 *
 * **The pin coordinates are supplied by the caller, deliberately.** The app has
 * two of them and they are not interchangeable: the exporter measures pins in
 * LTSpice symbol space (`offsetsForNode`), while the canvas measures them in
 * flow space through the `.asy` mapping (`getNodePins`). The two agree to within
 * a few pixels but not exactly — the parser already works around the gap when it
 * filters waypoints. Hard-wiring either one here would silently give the other
 * caller routes that are slightly off the wires it draws.
 */

export interface RoutePoint { x: number; y: number }

/** Where a wire's ends sit, and which way they leave their part. */
export interface PinLookup {
  /** Pin position, or undefined when the part or handle is unknown. */
  at(nodeId: string, handle: string | null | undefined): RoutePoint | undefined;
  /** Outward direction, so a lead leaves the symbol squarely instead of along its flank. */
  axis?(nodeId: string, handle: string | null | undefined): Axis | undefined;
}

export interface WireRoute {
  edge: Edge;
  /** Corner points of the drawn wire, first to last. */
  verts: RoutePoint[];
}

/**
 * Route every edge whose two ends can be located. Edges with an unresolvable
 * end are skipped rather than guessed at — a wire to nowhere is not a wire.
 */
export function wireRoutes(edges: Edge[], pins: PinLookup): WireRoute[] {
  const out: WireRoute[] = [];
  for (const edge of edges) {
    const a = pins.at(edge.source, edge.sourceHandle);
    const b = pins.at(edge.target, edge.targetHandle);
    if (!a || !b) continue;
    out.push({ edge, verts: routeOf(edge, a, b, pins) });
  }
  return out;
}

/** The polyline for one edge between two known endpoints. */
export function routeOf(edge: Edge, a: RoutePoint, b: RoutePoint, pins: PinLookup): RoutePoint[] {
  const wps = ((edge.data?.waypoints as RoutePoint[] | undefined) ?? [])
    .map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }));

  // A wire imported along a diagonal LTSpice segment keeps its exact path:
  // orthogonalising it would insert a right-angle leg that can overlap a
  // neighbouring net's leg and merge the two on re-import (see LTSpiceParser).
  if (edge.data?.diagonal) return [a, ...wps, b];

  // A tapped end is pinned to a point on another wire, so it has no outward
  // direction of its own — forcing one would drag the tap off that wire.
  const hints: RouteHints = {
    startAxis: edge.data?.sourceTap ? undefined : pins.axis?.(edge.source, edge.sourceHandle),
    endAxis: edge.data?.targetTap ? undefined : pins.axis?.(edge.target, edge.targetHandle),
  };
  return orthoVertices([a, ...wps, b], hints);
}

import type { Node, Edge } from "@xyflow/react";
import { getNodePins, NODE_SIZE } from "./pinGeometry.js";

/**
 * Re-seat the wires of a two-terminal part after it has been rotated or
 * mirrored, so they meet the pin that is now nearest instead of crossing the
 * body to reach the one they were attached to.
 *
 * A part's pins belong to its *drawing*: `cap.asy` declares `SpiceOrder 1` for
 * the pin the current arrow points away from, and `Resistor.getNetlistLine`
 * emits `ports[0]` as the first SPICE node — so which wire meets which pin
 * decides the sign of `I(R1)`. Turning a part half a turn therefore has to swap
 * the wires *and* reverse that reference direction: the arrow in the symbol now
 * points the other way, and the netlist must agree with it. Keeping the netlist
 * fixed instead would leave the drawing lying about the measurement.
 *
 * Deliberately restricted to parts with exactly two pins. With three or more,
 * "nearest pin" is not a meaningful question and the same rule would silently
 * swap an op-amp's inverting and non-inverting inputs.
 *
 * Only a *strict* improvement swaps. A quarter turn moves the pins onto the
 * other axis, where both assignments cost the same by symmetry — that tie must
 * not flip anything, or repeated rotation would flap the current's sign.
 *
 * Pure, so the rule is testable without React (see pinReseat.test).
 */

/** Below this the two assignments count as equally good and nothing changes. */
const IMPROVEMENT_EPS = 0.5;

interface Pt { x: number; y: number }

/** Where a wire's far end sits: its tap point, else the pin, else the node centre. */
function farPoint(edge: Edge, nodes: Node[], selfId: string): Pt | null {
  const fromSource = edge.target === selfId;
  const farId = fromSource ? edge.source : edge.target;
  const farHandle = fromSource ? edge.sourceHandle : edge.targetHandle;
  const tap = (edge.data as { sourceTap?: Pt; targetTap?: Pt } | undefined)?.[fromSource ? "sourceTap" : "targetTap"];
  if (tap) return tap;
  const n = nodes.find((x) => x.id === farId);
  if (!n) return null;
  const p = farHandle ? getNodePins(n).find((q) => q.handleId === farHandle) : undefined;
  return p ? { x: p.x, y: p.y } : { x: n.position.x + NODE_SIZE / 2, y: n.position.y + NODE_SIZE / 2 };
}

/**
 * Edges with the part's two handles swapped, or `null` when the current seating
 * is already at least as good. `node` must already carry the new orientation.
 */
export function reseatTwoPinEdges(node: Node, nodes: Node[], edges: Edge[]): Edge[] | null {
  const pins = getNodePins(node);
  if (pins.length !== 2) return null;

  const incident = edges.filter((e) => e.source === node.id || e.target === node.id);
  if (incident.length === 0) return null;

  const at = (handle: string | null | undefined) => pins.find((p) => p.handleId === handle);
  const other = (handle: string | null | undefined) =>
    pins.find((p) => p.handleId !== handle)?.handleId;

  let cost = 0, swapped = 0;
  for (const e of incident) {
    const far = farPoint(e, nodes, node.id);
    if (!far) return null;
    const handle = e.source === node.id ? e.sourceHandle : e.targetHandle;
    const now = at(handle), alt = at(other(handle));
    if (!now || !alt) return null;
    cost += Math.hypot(now.x - far.x, now.y - far.y);
    swapped += Math.hypot(alt.x - far.x, alt.y - far.y);
  }
  if (swapped >= cost - IMPROVEMENT_EPS) return null;

  return edges.map((e) => {
    if (e.source !== node.id && e.target !== node.id) return e;
    return {
      ...e,
      ...(e.source === node.id ? { sourceHandle: other(e.sourceHandle) ?? e.sourceHandle } : {}),
      ...(e.target === node.id ? { targetHandle: other(e.targetHandle) ?? e.targetHandle } : {}),
    };
  });
}

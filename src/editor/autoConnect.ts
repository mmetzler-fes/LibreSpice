import { orthoVertices, projectToSegment, type FlowPoint } from "./WireTool.js";

/** A component pin resolved to flow coordinates. */
export interface DockPin {
  nodeId: string;
  handleId: string;
  x: number;
  y: number;
}

/** An existing wire, resolved to its orthogonal vertex chain in flow space. */
export interface WireGeom {
  id: string;
  /** The wire's electrical source (a docking pin joins this endpoint's net). */
  source: string;
  sourceHandle: string | null;
  verts: FlowPoint[];
}

/** A connection to create for a freshly placed pin. */
export interface AutoConnectEdge {
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
  /** Set when docking onto a wire: the junction point on the segment. */
  tap?: FlowPoint;
  /** Set when docking onto a wire: the wire the tap sits on. */
  hostEdgeId?: string;
}

/**
 * Decide which connections a set of freshly placed pins should form. A pin docks
 * onto a wire it lands on (a tap), or — the case a net connector needs — straight
 * onto a coincident pin of another component. The wire takes precedence, matching
 * the interactive wiring: a pin dropped on a wire taps it, and only a bare pin
 * looks for another bare pin.
 *
 * Pure and geometry-only, so the docking rule can be tested without React. `tol`
 * is the squared snap distance in flow units (default 4 = 2 px, one grid step's
 * worth of slack).
 */
export function autoConnectEdgesFor(
  newPins: DockPin[],
  otherPins: DockPin[],
  wires: WireGeom[],
  alreadyWired: (a: DockPin, bNode: string, bHandle: string) => boolean,
  tol = 4,
): AutoConnectEdge[] {
  const edges: AutoConnectEdge[] = [];
  for (const pin of newPins) {
    // 1) A wire under the pin → tap onto it.
    let tapped = false;
    for (const w of wires) {
      for (let i = 0; i < w.verts.length - 1; i++) {
        const { point, d2 } = projectToSegment(pin, w.verts[i], w.verts[i + 1]);
        if (d2 <= tol) {
          if (w.sourceHandle && !alreadyWired(pin, w.source, w.sourceHandle)) {
            edges.push({
              source: pin.nodeId, sourceHandle: pin.handleId,
              target: w.source, targetHandle: w.sourceHandle,
              tap: point, hostEdgeId: w.id,
            });
          }
          tapped = true;
          break;
        }
      }
      if (tapped) break;
    }
    if (tapped) continue;

    // 2) No wire — dock onto a coincident component pin.
    const hit = otherPins.find((q) => {
      const dx = q.x - pin.x, dy = q.y - pin.y;
      return dx * dx + dy * dy <= tol;
    });
    if (hit && !alreadyWired(pin, hit.nodeId, hit.handleId)) {
      edges.push({
        source: pin.nodeId, sourceHandle: pin.handleId,
        target: hit.nodeId, targetHandle: hit.handleId,
      });
    }
  }
  return edges;
}

/** Re-export so callers building {@link WireGeom} share one geometry routine. */
export { orthoVertices };

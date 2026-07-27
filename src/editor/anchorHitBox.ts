import type { Node, Edge } from "@xyflow/react";
import type { NetAnchor } from "@core/circuit/netAnchor.js";
import { tagOffset } from "@core/circuit/netAnchor.js";
import { netLabelShape, tagBoxOrigin } from "./netLabelShape.js";
import { terminalDirection, terminalTagSide, sampleWire } from "./netTerminalOrientation.js";
import { netRoutes } from "./anchorNets.js";
import { NODE_SIZE } from "./pinGeometry.js";
import type { SymbolNorm } from "@sym/asyParser.js";
import type { FlowPoint } from "./WireTool.js";

/**
 * Where each name's readable tag actually sits, in flow coordinates.
 *
 * A name is drawn by an overlay, so React Flow's rubber band cannot see it and
 * the selection has to hit-test it by hand. That test has to use the *same*
 * geometry the drawing uses, or the box a user drags around a label is not the
 * box that decides whether it was caught — which is the sort of disagreement
 * that is invisible until someone reports that selection "sometimes" works.
 * Hence this module: one description of where a tag is, shared by the layer that
 * draws it and the canvas that selects it.
 *
 * The width is estimated rather than measured. Measuring would mean reading back
 * the DOM node for every anchor on every rubber band, and the estimate only has
 * to be good enough to decide "inside the band or not" — the tags are monospace,
 * so character count is a genuinely good predictor, and the box is generous by a
 * couple of pixels on purpose: catching a label the band grazed is the friendly
 * error, missing one it clearly covered is not.
 */

/** Monospace 11px: advance per character, and the box's fixed extras. */
const CHAR_W = 6.7;
const PAD_X = 14;
const TAG_H = 17;

export interface AnchorBox {
  id: string;
  /** The tag, as a flow-space rectangle. */
  tag: { x: number; y: number; w: number; h: number };
  /** The anchor point itself — what actually decides the net. */
  point: FlowPoint;
}

/** How wide a tag showing `name` is drawn. */
export function tagWidth(name: string): number {
  return name.length * CHAR_W + PAD_X;
}

/**
 * The layout a name takes when nothing has been dragged: which way the symbol
 * faces and which side of the wire the tag steps to.
 *
 * Exported so the layer and this share one definition — the layer additionally
 * freezes it for the duration of a drag, which is a question of *when* to call
 * this, not of what it computes.
 */
export function autoLayout(
  a: NetAnchor, nodes: { position: { x: number; y: number } }[], routes: { verts: FlowPoint[] }[],
): { dir: FlowPoint; side: 1 | -1 } {
  const dock = { x: a.x, y: a.y };
  const dir = terminalDirection(dock, nearestSegment(dock, routes));
  return { dir, side: terminalTagSide(dock, dir, neighbourhood(dock, nodes, routes)) };
}

/** Every name's tag box and anchor point, for hit-testing a rubber band. */
export function anchorBoxes(
  anchors: NetAnchor[], nodes: Node[], edges: Edge[], symbolNorm: SymbolNorm = "default",
): AnchorBox[] {
  const routes = netRoutes(nodes, edges, { netOf: (id) => id }, symbolNorm);
  return anchors.map((a) => {
    const off = tagOffset(a);
    const w = tagWidth(a.name);
    let local: { x: number; y: number };
    if (off) {
      // A dragged tag is centred on the point it was dragged to (see the layer).
      local = { x: NODE_SIZE / 2 + off.dx - w / 2, y: NODE_SIZE / 2 + off.dy - TAG_H / 2 };
    } else {
      const { dir, side } = autoLayout(a, nodes, routes);
      local = tagBoxOrigin(netLabelShape(a.portType ?? "None", dir, side).tag, w, TAG_H);
    }
    // Local space is the old node box, whose centre is the anchor point.
    const originX = a.x - NODE_SIZE / 2;
    const originY = a.y - NODE_SIZE / 2;
    return {
      id: a.id,
      tag: { x: originX + local.x, y: originY + local.y, w, h: TAG_H },
      point: { x: a.x, y: a.y },
    };
  });
}

/** A rubber band, however it was dragged. */
export interface Band { x1: number; y1: number; x2: number; y2: number }

/** The band as a normalised rectangle. */
function normalise(b: Band) {
  return {
    x1: Math.min(b.x1, b.x2), y1: Math.min(b.y1, b.y2),
    x2: Math.max(b.x1, b.x2), y2: Math.max(b.y1, b.y2),
  };
}

/**
 * The names a rubber band catches.
 *
 * A name counts as caught when the band touches its tag *or* covers its anchor
 * point. Both, because the two can be far apart once a tag has been dragged off,
 * and either one being inside the band is a clear enough statement of intent —
 * a band drawn around the readable name should take it, and so should a band
 * drawn around the piece of circuit it is attached to.
 *
 * Touching rather than containing, for the tag. React Flow selects a node whose
 * box merely *intersects* the band, and a name that behaved differently from
 * every part beside it would read as a bug rather than as a rule.
 */
export function anchorsInBand(boxes: AnchorBox[], band: Band): string[] {
  const r = normalise(band);
  return boxes
    .filter((b) =>
      (b.tag.x <= r.x2 && b.tag.x + b.tag.w >= r.x1 && b.tag.y <= r.y2 && b.tag.y + b.tag.h >= r.y1)
      || (b.point.x >= r.x1 && b.point.x <= r.x2 && b.point.y >= r.y1 && b.point.y <= r.y2))
    .map((b) => b.id);
}

/**
 * The two ends of the wire segment nearest `p` (see NetAnchorLayer's copy of the
 * same question — this is the shared one).
 */
function nearestSegment(p: FlowPoint, routes: { verts: FlowPoint[] }[]): FlowPoint[] {
  let best = 24, ends: FlowPoint[] = [];
  for (const r of routes) {
    for (let i = 0; i < r.verts.length - 1; i++) {
      const a = r.verts[i], b = r.verts[i + 1];
      const d = distToSegment(p, a, b);
      if (d < best) { best = d; ends = [a, b]; }
    }
  }
  return ends;
}

/** Points near the dock that a name has to dodge: parts, and the wires. */
function neighbourhood(
  dock: FlowPoint, nodes: { position: { x: number; y: number } }[], routes: { verts: FlowPoint[] }[],
): FlowPoint[] {
  const out: FlowPoint[] = nodes.map((n) => ({ x: n.position.x + NODE_SIZE / 2, y: n.position.y + NODE_SIZE / 2 }));
  for (const r of routes) out.push(...sampleWire(r.verts, dock));
  return out;
}

/** Distance from a point to a segment. */
function distToSegment(p: FlowPoint, a: FlowPoint, b: FlowPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}

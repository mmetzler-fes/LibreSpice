import type { FlowPoint } from "./WireTool.js";

/**
 * Which way a net label / net connector lays itself out.
 *
 * LTSpice stores no orientation for a flag — `FLAG x y name` (plus an `IOPIN`
 * for a connector) is all there is — yet it redraws the same schematic pointing
 * the same way every time. It recomputes the direction from the wiring: the
 * symbol's tip sits on the flag coordinate and the body is laid out on the side
 * the wire does *not* occupy, so the name never runs back over its own net.
 *
 * Verified against `examples/04-4_AstabileKippstufe1.asc`, where all four
 * connectors are `In` yet two draw leftwards and two rightwards — proof that the
 * drawn direction comes from the geometry and not from the port type.
 *
 * Pure geometry, so the rule is testable without React and can be shared by the
 * editor node and the SVG export.
 */

/** Unit vector along the dominant axis of `to - from`, or null when coincident. */
export function axisDirection(from: FlowPoint, to: FlowPoint): FlowPoint | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return null;
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: Math.sign(dx), y: 0 }
    : { x: 0, y: Math.sign(dy) };
}

/**
 * The direction a terminal's symbol extends in, given the far ends of the wires
 * attached to its dock.
 *
 * The symbol points *away* from its wire, so the label clears the net. With
 * nothing attached — a terminal dropped on open canvas — it defaults to up,
 * which is where a supply label conventionally sits and matches the placement
 * ghost.
 *
 * Several wires can meet at the dock (a label sitting on a junction). The first
 * one that yields a direction wins, which keeps the choice stable as long as the
 * wiring is: an arbitrary but deterministic pick beats flipping the symbol
 * whenever the edge order changes.
 */
export function terminalDirection(dock: FlowPoint, farEnds: FlowPoint[]): FlowPoint {
  const axes: FlowPoint[] = [];
  for (const end of farEnds) {
    const a = axisDirection(dock, end);
    if (a) axes.push(a);
  }
  if (axes.length === 0) return { x: 0, y: -1 };

  // The symbol points away from its wire, along the wire's own axis — that is
  // what makes the arrow say which way the signal runs. Keeping clear of the
  // wire is the *name's* job, and it steps across the wire instead of along it
  // (see netLabelShape); doing it here as well would only turn the arrow.
  const first = axes[0];
  return { x: -first.x, y: -first.y };
}

/**
 * Which of the two sides across the wire the name should take.
 *
 * Across the wire there are always two: above or below a horizontal run, right
 * or left of a vertical one. The conventional side is above / right; the other
 * is taken when something already sits there, so a name never lands on a part
 * or on a neighbouring terminal.
 *
 * Derived from the surroundings rather than stored, so the file stays free of
 * layout hints and the same schematic always draws the same way. `neighbours`
 * are nearby points of interest in flow coordinates: other nodes' centres, and
 * points sampled along the wires (see {@link sampleWire}) — a wire running past
 * the terminal is just as much in the way as a part.
 */
export function terminalTagSide(dock: FlowPoint, dir: FlowPoint, neighbours: FlowPoint[]): 1 | -1 {
  // The axis the name may move along is the one the symbol does *not* use.
  const across = dir.x !== 0 ? "y" : "x";
  /** How crowded one side is, counting only what is close enough to collide. */
  const crowding = (sign: 1 | -1) => {
    let n = 0;
    for (const p of neighbours) {
      const along = across === "y" ? p.x - dock.x : p.y - dock.y;
      const off = across === "y" ? p.y - dock.y : p.x - dock.x;
      if (Math.abs(along) <= 48 && Math.sign(off) === sign && Math.abs(off) <= 56) n++;
    }
    return n;
  };
  // "Above" is negative y, "right" is positive x — hence the differing default.
  const preferred: 1 | -1 = across === "y" ? -1 : 1;
  const other: 1 | -1 = preferred === 1 ? -1 : 1;
  return crowding(preferred) > crowding(other) ? other : preferred;
}

/**
 * Points along an orthogonal wire, close enough to a dock to matter.
 *
 * The tag side is decided by counting what sits on either side, and a wire is
 * only known by its endpoints — a long run passing above the terminal has no
 * point near it at all unless the segment is sampled. `step` is fine enough that
 * nothing within the search box slips between two samples.
 */
export function sampleWire(verts: FlowPoint[], near: FlowPoint, radius = 80, step = 8): FlowPoint[] {
  const out: FlowPoint[] = [];
  for (let i = 0; i < verts.length - 1; i++) {
    const a = verts[i], b = verts[i + 1];
    // Skip a segment that cannot reach the box around `near`.
    if (Math.min(a.x, b.x) - radius > near.x || Math.max(a.x, b.x) + radius < near.x) {
      if (Math.min(a.y, b.y) - radius > near.y || Math.max(a.y, b.y) + radius < near.y) continue;
    }
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k <= n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      if (Math.abs(p.x - near.x) <= radius && Math.abs(p.y - near.y) <= radius) out.push(p);
    }
  }
  return out;
}

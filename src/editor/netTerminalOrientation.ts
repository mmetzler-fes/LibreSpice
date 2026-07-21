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

  const first = axes[0];
  // A wire that runs *through* the dock leaves along the same axis in both
  // directions, so neither side of it is free. Laying the symbol out along that
  // axis would put the name on top of the wire — and on a through wire that is
  // exactly where the next parts sit. Step off it at a right angle instead:
  // above a horizontal wire, to the right of a vertical one.
  const through = axes.some((a) => a.x === -first.x && a.y === -first.y);
  if (through) return first.x !== 0 ? { x: 0, y: -1 } : { x: 1, y: 0 };

  return { x: -first.x, y: -first.y };
}

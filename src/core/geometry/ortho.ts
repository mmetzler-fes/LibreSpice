/**
 * Orthogonal wire routing, shared by the canvas, the SVG export and the `.asc`
 * exporter — they drew the same wire from three copies of this before, so a
 * routing change had to be made three times to keep a saved file looking like
 * what was on screen.
 */

export interface Pt { x: number; y: number }

/** Which way a wire runs: along x (horizontal) or along y (vertical). */
export type Axis = "x" | "y";

/**
 * The axis a wire should leave a pin along, so it goes *out* of the part rather
 * than running alongside it.
 *
 * Taken from where the pin sits relative to the centre of its own part's pins:
 * an op-amp's inputs are left of that centre, so they lead out horizontally; a
 * resistor's terminals are above and below it, so they lead out vertically. The
 * dominant component wins, which keeps a pin on a diagonal square. A part with
 * one pin, or a pin exactly at the centre, has no direction to offer.
 */
export function outwardAxis(pin: Pt, siblings: Pt[]): Axis | undefined {
  const d = outwardDir(pin, siblings);
  return d ? (d.x !== 0 ? "x" : "y") : undefined;
}

/**
 * The same rule as {@link outwardAxis}, but as a unit step — which way, not just
 * which axis. Needed wherever a lead has to be pushed a real distance clear of
 * the symbol rather than merely aligned with an axis.
 */
export function outwardDir(pin: Pt, siblings: Pt[]): Pt | undefined {
  if (siblings.length < 2) return undefined;
  const cx = siblings.reduce((s, p) => s + p.x, 0) / siblings.length;
  const cy = siblings.reduce((s, p) => s + p.y, 0) / siblings.length;
  const dx = pin.x - cx, dy = pin.y - cy;
  if (dx === 0 && dy === 0) return undefined;
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: Math.sign(dx), y: 0 }
    : { x: 0, y: Math.sign(dy) };
}

/** Preferred leaving axis at each end of a wire; either may be unknown. */
export interface RouteHints {
  startAxis?: Axis;
  endAxis?: Axis;
}

/**
 * Route one leg between two points with right angles.
 *
 * With no hint the longer side leads, which is the old behaviour. A hint pins
 * the leg to leave (or arrive) along the pin's own axis. When both ends want the
 * *same* axis a single corner cannot satisfy them, so the leg takes a Z: out
 * along the axis, across, and back in along it. That is what keeps a wire off
 * the flank of a symbol whose pins face the same way, which is exactly the
 * op-amp's two inputs.
 */
function leg(a: Pt, b: Pt, startAxis?: Axis, endAxis?: Axis): Pt[] {
  if (a.x === b.x || a.y === b.y) return [b];

  if (startAxis && endAxis) {
    if (startAxis === endAxis) {
      const mid = startAxis === "x"
        ? { x: Math.round((a.x + b.x) / 2), y: 0 }
        : { x: 0, y: Math.round((a.y + b.y) / 2) };
      return startAxis === "x"
        ? [{ x: mid.x, y: a.y }, { x: mid.x, y: b.y }, b]
        : [{ x: a.x, y: mid.y }, { x: b.x, y: mid.y }, b];
    }
    // Different axes: one corner satisfies both ends at once.
    return startAxis === "x" ? [{ x: b.x, y: a.y }, b] : [{ x: a.x, y: b.y }, b];
  }

  const axis = startAxis
    ?? (endAxis ? (endAxis === "x" ? "y" : "x") : undefined)
    ?? (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? "x" : "y");
  return axis === "x" ? [{ x: b.x, y: a.y }, b] : [{ x: a.x, y: b.y }, b];
}

/**
 * Expand a vertex list into an orthogonal path. The hints apply to the first and
 * last legs only — the legs in between run between waypoints the user placed
 * deliberately, and second-guessing those would move a hand-routed wire.
 */
export function orthoVertices(points: Pt[], hints: RouteHints = {}): Pt[] {
  if (points.length === 0) return [];
  const out: Pt[] = [points[0]];
  const last = points.length - 1;
  for (let i = 1; i <= last; i++) {
    const a = out[out.length - 1];
    out.push(...leg(a, points[i], i === 1 ? hints.startAxis : undefined, i === last ? hints.endAxis : undefined));
  }
  return out;
}

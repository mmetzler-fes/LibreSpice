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

/** A part's body, as a box a wire should not be routed through. */
export interface Box { x1: number; y1: number; x2: number; y2: number }

/** Preferred leaving axis at each end of a wire; either may be unknown. */
export interface RouteHints {
  startAxis?: Axis;
  endAxis?: Axis;
  /**
   * Which way is *out* of the part at each end, as a unit step.
   *
   * The axis alone does not say which of the two directions leads away from the
   * symbol, and that is what a wire needs to know to leave a pin without cutting
   * back through the part it is leaving: a gate's input faces left, and a leg
   * that starts by stepping right runs the length of the gate's own body.
   */
  startDir?: Pt;
  endDir?: Pt;
  /**
   * Part bodies the route should avoid running through.
   *
   * A wire that crosses a symbol is not wrong — nothing is connected by it — but
   * it reads as if it were, and the piece inside the body is invisible: an
   * arriving wire looks like it stops at the symbol's edge. Where a route has a
   * choice of shapes, this decides between them.
   */
  obstacles?: Box[];
  /**
   * Terminals the route must not run over — every pin on the sheet except the
   * two this wire connects.
   *
   * A *hard* constraint, unlike `obstacles`. A wire crossing a part body is ugly
   * and nothing more; a wire crossing a foreign pin is a connection. It is drawn
   * that way, it is saved that way (the `.asc` has no notion of a wire merely
   * passing by), and on the next load the parser reads it back as exactly what
   * it looks like — two nets joined.
   *
   * That is not hypothetical. Moving a seven-segment display a little way up the
   * sheet re-routed the wire from a flip-flop's Q output straight across the same
   * flip-flop's D input, and the file came back with D, Q and ~Q on one node:
   * ngspice then reported a singular matrix at a node three parts away, which is
   * about as far from the cause as a symptom can get.
   *
   * The converter's router has had this rule from the start (`keepClear` in
   * multisim/router.ts) because it lays out whole sheets unattended. The editor
   * needs it for the same reason — a wire re-routes without being asked whenever
   * something it hangs on moves.
   */
  avoid?: Pt[];
}

/** Does a segment run through a body, rather than merely touch its edge? */
function entersBody(a: Pt, b: Pt, box: Box): boolean {
  return Math.max(a.x, b.x) > box.x1 && Math.min(a.x, b.x) < box.x2
      && Math.max(a.y, b.y) > box.y1 && Math.min(a.y, b.y) < box.y2;
}

/** How many times a path runs through a part body. */
function bodyHits(path: Pt[], from: Pt, obstacles: Box[]): number {
  let n = 0;
  let prev = from;
  for (const p of path) {
    for (const box of obstacles) if (entersBody(prev, p, box)) n++;
    prev = p;
  }
  return n;
}

/** Does a point lie on an axis-aligned segment, endpoints included? */
function onSegment(p: Pt, a: Pt, b: Pt): boolean {
  return a.x === b.x
    ? p.x === a.x && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
    : a.y === b.y && p.y === a.y && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
}

/** Does a path touch any terminal it must keep clear of? */
function hitsPin(path: Pt[], from: Pt, avoid: Pt[]): boolean {
  let prev = from;
  for (const p of path) {
    for (const q of avoid) if (onSegment(q, prev, p)) return true;
    prev = p;
  }
  return false;
}

/**
 * Route one leg between two points with right angles.
 *
 * With no hint the longer side leads, which is the old behaviour. A hint pins
 * the leg to leave (or arrive) along the pin's own axis.
 *
 * Every case offers more than one legal shape, and `obstacles` is what decides
 * between them: the first shape that runs through no part body wins, and where
 * every shape does, the one the hints asked for. A wire through a symbol is the
 * one kind of route a reader cannot follow — the piece inside the body is drawn
 * over by the symbol, so the wire appears to stop at its edge.
 */
function leg(
  a: Pt, b: Pt,
  startAxis?: Axis, endAxis?: Axis,
  obstacles?: Box[], startDir?: Pt, endDir?: Pt, avoid?: Pt[],
): Pt[] {
  if (a.x === b.x || a.y === b.y) return [b];

  /** The shape the hints ask for, and the ones to fall back on, best first. */
  const shapes: Pt[][] = [];
  const cornerX = [{ x: b.x, y: a.y }, b];   // along x first
  const cornerY = [{ x: a.x, y: b.y }, b];   // along y first
  const zAt = (axis: Axis, at: number): Pt[] => axis === "x"
    ? [{ x: at, y: a.y }, { x: at, y: b.y }, b]
    : [{ x: a.x, y: at }, { x: b.x, y: at }, b];

  if (startAxis && endAxis && startAxis === endAxis) {
    // Both ends want the same axis: a single corner cannot satisfy them, so the
    // leg takes a Z — out along the axis, across, and back in along it. That is
    // what keeps a wire off the flank of a symbol whose pins face the same way,
    // which is exactly the op-amp's two inputs.
    //
    // Where the crossing goes is free, and that is the room this has to dodge a
    // body: halfway is the tidy default, but the crossing can also be pushed
    // just past either end, which is what takes the wire around the part instead
    // of down through it.
    const [pa, pb] = startAxis === "x" ? [a.x, b.x] : [a.y, b.y];
    const step = pb >= pa ? GRID_STEP : -GRID_STEP;
    shapes.push(zAt(startAxis, Math.round((pa + pb) / 2)));
    shapes.push(zAt(startAxis, pb + step), zAt(startAxis, pa - step));
    shapes.push(cornerX, cornerY);
  } else if (startAxis && endAxis) {
    // Different axes: one corner satisfies both ends at once. The other corner
    // is still a legal wire, and better than one drawn through a symbol.
    shapes.push(startAxis === "x" ? cornerX : cornerY);
    shapes.push(startAxis === "x" ? cornerY : cornerX);
  } else {
    const axis = startAxis
      ?? (endAxis ? (endAxis === "x" ? "y" : "x") : undefined)
      ?? (Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? "x" : "y");
    shapes.push(axis === "x" ? cornerX : cornerY, axis === "x" ? cornerY : cornerX);
  }

  // Foreign terminals first, and separately from the bodies: this one is not a
  // preference to be weighed but a rule. A shape that runs over one is dropped
  // outright, and only if *every* shape does is the preferred one taken anyway —
  // an unroutable pair still needs a wire, and one drawn wrongly is at least
  // visible, where no wire at all would look like a part that was never
  // connected.
  let choices = shapes;
  if (avoid?.length) {
    const clear = shapes.filter((path) => !hitsPin(path, a, avoid));
    if (clear.length) choices = clear;
  }
  if (!obstacles?.length) return choices[0];

  // Last resort: step clear of the part first, then route from there. Only the
  // *direction* out of a pin can do this — a leg that merely honours the pin's
  // axis is free to set off into the symbol it is leaving, which is how a wire
  // ends up running the length of its own gate before turning round.
  const CLEAR = 16;
  const stepOut = (p: Pt, dir: Pt): Pt => ({ x: p.x + dir.x * CLEAR, y: p.y + dir.y * CLEAR });
  if (endDir) {
    const c = stepOut(b, endDir);
    if (c.x !== a.x && c.y !== a.y) {
      shapes.push([{ x: c.x, y: a.y }, c, b], [{ x: a.x, y: c.y }, c, b]);
    } else {
      shapes.push([c, b]);
    }
  }
  if (startDir) {
    const c = stepOut(a, startDir);
    if (c.x !== b.x && c.y !== b.y) {
      shapes.push([c, { x: c.x, y: b.y }, b], [c, { x: b.x, y: c.y }, b]);
    } else {
      shapes.push([c, b]);
    }
  }

  // The first shape that clears every body; the preferred one if none does, so a
  // part boxed in on all sides still gets its wire.
  return choices.find((path) => bodyHits(path, a, obstacles) === 0) ?? choices[0];
}

/** How far past an end a Z-bend's crossing is pushed to clear a body. */
const GRID_STEP = 16;

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
    out.push(...leg(
      a, points[i],
      i === 1 ? hints.startAxis : undefined,
      i === last ? hints.endAxis : undefined,
      hints.obstacles,
      i === 1 ? hints.startDir : undefined,
      i === last ? hints.endDir : undefined,
      hints.avoid,
    ));
  }
  return out;
}

import { GRID, GRID_DOTS, PX_PER_CM } from "./pinGeometry.js";
import type { FlowPoint } from "./WireTool.js";
import type { DockPin } from "./autoConnect.js";

/**
 * Placement rule for a net label or connector dropped from the palette.
 *
 * Dropped straight onto a component pin, the label used to land *on* the
 * terminal: its tag covered the pin and the auto-connect laid a zero-length
 * wire between the two coincident pins (a degenerate `WIRE x y x y` in the
 * exported `.asc`). Instead the label steps clear of the part and is joined by a
 * real, short lead — the LTSpice idiom, and a wire the user can then select,
 * name or turn into a connector like any other.
 *
 * Pure geometry, so the rule is testable without React (see netLabelLead.test).
 */

/** A component pin, plus the centre of the node it belongs to. */
export interface LeadPin extends DockPin {
  /** Centre of the owning node, which fixes "away from the part". */
  ownerCx: number;
  ownerCy: number;
}

export interface NetLabelPlacement {
  /** Where the net label's terminal goes (its node centre). */
  terminal: FlowPoint;
  /** The pin it docked onto, or null when it was dropped on open canvas. */
  pin: LeadPin | null;
}

/**
 * Shortest lead a terminal may sit on: 0.3 cm, rounded up to the snap grid so
 * the terminal still lands on a grid line and can meet a wire.
 *
 * Below this the connector's tag overlaps whatever it is connected to — most
 * visibly another connector, where the two tags end up drawn on top of each
 * other and neither can be read or grabbed.
 */
export const MIN_LEAD = Math.ceil((0.3 * PX_PER_CM) / GRID) * GRID;

/**
 * Unit step from a part towards (and past) one of its pins, snapped to an axis.
 * The dominant component wins, so a pin on a diagonal still leads out squarely
 * and the lead stays orthogonal like every other wire.
 */
function leadDirection(pin: LeadPin): FlowPoint {
  const dx = pin.x - pin.ownerCx;
  const dy = pin.y - pin.ownerCy;
  // A pin exactly at its node's centre gives no direction; lead upward, which is
  // where a supply label conventionally sits.
  if (dx === 0 && dy === 0) return { x: 0, y: -1 };
  return Math.abs(dx) >= Math.abs(dy)
    ? { x: Math.sign(dx), y: 0 }
    : { x: 0, y: Math.sign(dy) };
}

const near = (a: FlowPoint, b: FlowPoint, tol: number) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= tol;

/** The four axis directions, the preferred one first. */
function directions(first: FlowPoint): FlowPoint[] {
  const all = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  return [first, ...all.filter((d) => d.x !== first.x || d.y !== first.y)];
}

/**
 * Decide where a net label dropped at `drop` belongs.
 *
 * On a component pin (within `tol`, the auto-connect's squared tolerance) the
 * terminal steps clear of the owning part. `blocked` lists points the terminal
 * must not land on — other net terminals above all, which are not parts to lead
 * away from but are very much things to avoid sitting on top of.
 *
 * The preferred spot is one grid square out along the pin's own axis. If that is
 * taken the step grows, then the other three directions are tried, all at no
 * less than {@link MIN_LEAD}. Only when everything is occupied does the terminal
 * fall back onto the pin — an overlap is still better than a silent short.
 */
export function netLabelPlacement(
  drop: FlowPoint,
  pins: LeadPin[],
  blocked: FlowPoint[] = [],
  // One *visible* grid square (GRID_DOTS, LTSpice's 16-unit pitch), not the 4px
  // snap step GRID — a 4px lead reads as the label still sitting on the pin.
  step: number = GRID_DOTS,
  tol = 4,
): NetLabelPlacement {
  const hit = pins.find((p) => near(p, drop, tol));

  /**
   * A spot is only usable if it keeps MIN_LEAD from every terminal *other* than
   * the one it leads from. Merely not coinciding is not enough: a tag 4 px from
   * a neighbouring pin is unreadable, and squeezing between two close parts is
   * worse than admitting there is no room and staying put.
   */
  const clear = (p: FlowPoint) => {
    const others = [...pins.filter((q) => q !== hit), ...blocked];
    return !others.some((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 < MIN_LEAD ** 2);
  };
  const taken = (p: FlowPoint) => !clear(p);

  if (!hit) {
    // Not on a pin: the drop point stands, unless it lands on another terminal —
    // then step far enough away that the two tags no longer overlap.
    if (!taken(drop)) return { terminal: drop, pin: null };
    for (const dir of directions({ x: 0, y: -1 })) {
      for (let d = MIN_LEAD; d <= MIN_LEAD + 2 * GRID_DOTS; d += GRID) {
        const t = { x: drop.x + dir.x * d, y: drop.y + dir.y * d };
        if (!taken(t)) return { terminal: t, pin: null };
      }
    }
    return { terminal: drop, pin: null };
  }

  // A pin has exactly one sensible way out — away from its own part — so only
  // the *length* flexes here. Trying another direction would push the label
  // across the symbol it belongs to, and walking past an obstruction would
  // leapfrog a neighbouring part instead of leaving room for it.
  const dir = leadDirection(hit);
  const at = (d: number) => ({ x: hit.x + dir.x * d, y: hit.y + dir.y * d });
  const preferred = Math.max(step, MIN_LEAD);
  if (!taken(at(preferred))) return { terminal: at(preferred), pin: hit };
  // Preferred spot occupied: shorten towards MIN_LEAD before giving up, so a
  // tight corner still gets a real stub rather than an overlapping tag.
  for (let d = preferred - GRID; d >= MIN_LEAD; d -= GRID) {
    if (!taken(at(d))) return { terminal: at(d), pin: hit };
  }
  return { terminal: { x: hit.x, y: hit.y }, pin: hit };
}

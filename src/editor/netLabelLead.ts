import { GRID_DOTS } from "./pinGeometry.js";
import type { FlowPoint } from "./WireTool.js";
import type { DockPin } from "./autoConnect.js";

/**
 * Placement rule for a net label dropped from the palette.
 *
 * Dropped straight onto a component pin, the label used to land *on* the
 * terminal: its tag covered the pin and the auto-connect laid a zero-length
 * wire between the two coincident pins (a degenerate `WIRE x y x y` in the
 * exported `.asc`). Instead the label steps one grid square clear of the part
 * and is joined by a real, short lead — the LTSpice idiom, and a wire the user
 * can then select, name or turn into a connector like any other.
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

/**
 * Decide where a net label dropped at `drop` belongs. When it lands on a pin
 * (within `tol`, the same squared tolerance the auto-connect uses) the terminal
 * steps `step` px clear of the owning part; otherwise the drop point stands.
 *
 * A pin whose lead would land on *another* pin is left alone — stepping away
 * would silently short two terminals together, which is worse than the overlap.
 */
export function netLabelPlacement(
  drop: FlowPoint,
  pins: LeadPin[],
  // One *visible* grid square (GRID_DOTS, LTSpice's 16-unit pitch), not the 4px
  // snap step GRID — a 4px lead reads as the label still sitting on the pin.
  step: number = GRID_DOTS,
  tol = 4,
): NetLabelPlacement {
  const hit = pins.find((p) => (p.x - drop.x) ** 2 + (p.y - drop.y) ** 2 <= tol);
  if (!hit) return { terminal: drop, pin: null };

  const dir = leadDirection(hit);
  const terminal = { x: hit.x + dir.x * step, y: hit.y + dir.y * step };
  const blocked = pins.some((p) => (p.x - terminal.x) ** 2 + (p.y - terminal.y) ** 2 <= tol);
  return blocked ? { terminal: { x: hit.x, y: hit.y }, pin: hit } : { terminal, pin: hit };
}

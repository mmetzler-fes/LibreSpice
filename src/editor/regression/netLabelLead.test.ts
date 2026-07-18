import { netLabelPlacement, type LeadPin } from "../netLabelLead.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Placement of a net label dropped from the palette.
 *
 * Dropped on a component pin it used to land *on* the terminal: the tag covered
 * the pin and the auto-connect laid a zero-length wire between two coincident
 * pins, which the exporter then wrote as a degenerate `WIRE x y x y`. It must
 * instead step one grid square clear of the part, leaving a real short lead.
 */

/**
 * Length of that lead: one *visible* grid square. Asserted as a literal rather
 * than by importing the constant the rule uses — the first cut took `GRID` (the
 * 4px snap step) instead of `GRID_DOTS`, and tests written against the same
 * constant confirmed the 4px lead quite happily. The number is the contract.
 */
const LEAD = 16;

/** A pin of a part centred at (cx, cy). */
const pin = (x: number, y: number, cx: number, cy: number, id = "R1", h = "p"): LeadPin =>
  ({ nodeId: id, handleId: h, x, y, ownerCx: cx, ownerCy: cy });

// A resistor at the origin: 80px box centred (40,40), pins top (40,0) / bottom (40,80).
const R_TOP = pin(40, 0, 40, 40, "R1", "p");
const R_BOTTOM = pin(40, 80, 40, 40, "R1", "n");

type Case = { name: string; run: (fail: (r: string) => void) => void };

const CASES: Case[] = [
  {
    name: "dropped on open canvas the label stays put",
    run: (fail) => {
      const p = netLabelPlacement({ x: 200, y: 200 }, [R_TOP, R_BOTTOM]);
      if (p.pin) fail(`docked onto ${p.pin.handleId} from 200px away`);
      if (p.terminal.x !== 200 || p.terminal.y !== 200) fail(`terminal moved to ${JSON.stringify(p.terminal)}`);
    },
  },
  {
    // The whole point: never coincident with the pin, or the lead has zero length.
    name: "dropped on a pin the label steps one grid square clear",
    run: (fail) => {
      const p = netLabelPlacement({ x: 40, y: 0 }, [R_TOP, R_BOTTOM]);
      if (p.pin?.handleId !== "p") return fail(`docked onto ${p.pin?.handleId ?? "nothing"}, expected p`);
      // The top pin points up out of the part, so the label leads further up.
      if (p.terminal.x !== 40 || p.terminal.y !== -LEAD) fail(`terminal ${JSON.stringify(p.terminal)} != (40,${-LEAD})`);
      const len = Math.hypot(p.terminal.x - p.pin.x, p.terminal.y - p.pin.y);
      if (len !== LEAD) fail(`lead length ${len} != ${LEAD}`);
    },
  },
  {
    // The direction must follow the pin, not a fixed axis: the bottom pin leads
    // downward, away from the body, never back through the part.
    name: "the lead points away from the part, per pin",
    run: (fail) => {
      const top = netLabelPlacement({ x: 40, y: 0 }, [R_TOP, R_BOTTOM]);
      const bottom = netLabelPlacement({ x: 40, y: 80 }, [R_TOP, R_BOTTOM]);
      if (top.terminal.y >= R_TOP.y) fail(`top lead went down to ${top.terminal.y}`);
      if (bottom.terminal.y <= R_BOTTOM.y) fail(`bottom lead went up to ${bottom.terminal.y}`);
    },
  },
  {
    // A sideways pin (e.g. a transistor base) leads sideways.
    name: "a side pin leads sideways",
    run: (fail) => {
      const base = pin(0, 40, 40, 40, "Q1", "b");
      const p = netLabelPlacement({ x: 0, y: 40 }, [base]);
      if (p.terminal.x !== -LEAD || p.terminal.y !== 40) fail(`terminal ${JSON.stringify(p.terminal)} != (${-LEAD},40)`);
    },
  },
  {
    // Stepping away must not silently drop the label onto a *neighbouring* pin —
    // that would short two terminals. Better to leave it on the pin it was aimed
    // at (the old behaviour) than to wire up something the user never asked for.
    name: "a lead that would land on another pin is not taken",
    run: (fail) => {
      // A second part whose pin sits exactly one grid step above R1's top pin.
      const neighbour = pin(40, -LEAD, 40, -LEAD - 40, "R2", "n");
      const p = netLabelPlacement({ x: 40, y: 0 }, [R_TOP, R_BOTTOM, neighbour]);
      if (p.pin?.nodeId !== "R1") fail(`docked onto ${p.pin?.nodeId}, expected R1`);
      if (p.terminal.x !== 40 || p.terminal.y !== 0) {
        fail(`terminal ${JSON.stringify(p.terminal)} landed on R2's pin instead of staying put`);
      }
    },
  },
  {
    // Tolerance is the auto-connect's: a near-miss still docks, a clear miss does not.
    name: "docking tolerance matches the auto-connect",
    run: (fail) => {
      if (!netLabelPlacement({ x: 41, y: 0 }, [R_TOP]).pin) fail("a 1px miss did not dock");
      if (netLabelPlacement({ x: 48, y: 0 }, [R_TOP]).pin) fail("an 8px miss docked anyway");
    },
  },
];

export function runNetLabelLeadTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

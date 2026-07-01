import { ModelParser } from "../ModelParser.js";
import type { LibraryEntry } from "../types.js";
import { Circuit } from "../../circuit/Circuit.js";
import { NetlistGenerator } from "../../circuit/NetlistGenerator.js";
import { Diode, BJT, MOSFET } from "../../components/semiconductors/Semiconductors.js";
import { CustomSubcircuit } from "../../components/special/Special.js";
import type { SpiceComponent } from "../../components/base/SpiceComponent.js";
import { REGRESSION_CASES } from "./models.js";

export interface RegressionReport {
  total: number;
  passed: number;
  failures: { name: string; reason: string }[];
}

/** Builds a single device instance referencing the parsed entry, if possible. */
function instanceFor(entry: LibraryEntry): SpiceComponent | null {
  if (entry.kind === "subckt") {
    return new CustomSubcircuit("X1", "X1", { x: 0, y: 0 }, entry.raw, entry.pins);
  }
  switch (entry.deviceClass) {
    case "diode": return new Diode("D1", "D1", { x: 0, y: 0 }, entry.name);
    case "bjt_npn": return new BJT("Q1", "Q1", { x: 0, y: 0 }, "NPN", entry.name);
    case "bjt_pnp": return new BJT("Q1", "Q1", { x: 0, y: 0 }, "PNP", entry.name);
    case "mosfet_n": return new MOSFET("M1", "M1", { x: 0, y: 0 }, "NMOS", entry.name);
    case "mosfet_p": return new MOSFET("M1", "M1", { x: 0, y: 0 }, "PMOS", entry.name);
    default: return null; // jfet / passive: netlist-def only
  }
}

/** Runs every regression case through parse → register → netlist generation. */
export function runRegression(): RegressionReport {
  const failures: { name: string; reason: string }[] = [];

  for (const tc of REGRESSION_CASES) {
    const fail = (reason: string) => failures.push({ name: tc.name, reason });

    const { entries } = ModelParser.parse(tc.src);
    if (entries.length !== 1) {
      fail(`expected 1 entry, got ${entries.length}`);
      continue;
    }
    const entry = entries[0];

    if (entry.name !== tc.name) { fail(`name mismatch: ${entry.name}`); continue; }
    if (entry.kind !== tc.kind) { fail(`kind mismatch: ${entry.kind}`); continue; }

    if (entry.kind === "model" && tc.type && entry.type !== tc.type) {
      fail(`type mismatch: ${entry.type} ≠ ${tc.type}`);
      continue;
    }
    if (entry.kind === "subckt" && tc.pinCount !== undefined && entry.pins.length !== tc.pinCount) {
      fail(`pin count mismatch: ${entry.pins.length} ≠ ${tc.pinCount}`);
      continue;
    }

    // Generate a netlist with the entry registered as a library definition.
    const circuit = new Circuit();
    const inst = instanceFor(entry);
    if (inst) circuit.addComponent(inst);

    const netlist = new NetlistGenerator().generate(
      circuit,
      { type: "op" },
      "",
      "regression",
      entry.raw,
    );

    if (!netlist.includes(entry.name)) fail("netlist missing entry name");
    if (netlist.includes("UNKNOWN")) fail("netlist contains UNKNOWN placeholder");
    if (!netlist.trim().endsWith(".end")) fail("netlist not terminated with .end");
  }

  return { total: REGRESSION_CASES.length, passed: REGRESSION_CASES.length - failures.length, failures };
}

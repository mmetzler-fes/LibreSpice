import { LogicGate } from "@core/components/digital/LogicGate.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Logic gates are behavioural `B` sources, because the bundled ngspice has no
 * XSPICE: `d_and`, `adc_bridge` and friends are rejected as unknown device
 * types. The expression forms pinned here were verified against the actual
 * engine — `&&`, `||`, `!=` and the ternary parse; a leading `!` and `if()` do
 * not, so a negated gate must swap the ternary's arms instead.
 */
type Case = { name: string; run: (fail: (r: string) => void) => void };

/** A gate with every pin on its own net, and its emitted SPICE line. */
function line(gate: string, inputs: number): string {
  const g = new LogicGate("g1", "U1", undefined, gate as never, inputs);
  g.ports.forEach((p, i) => { p.netId = String(i + 1) as unknown as typeof p.netId; });
  return g.getNetlistLine();
}

const CASES: Case[] = [
  {
    name: "AND joins its inputs with &&",
    run: (fail) => {
      const l = line("and", 2);
      if (l !== "BU1 3 0 V = ((v(1)>2.5) && (v(2)>2.5)) ? 5 : 0") fail(l);
    },
  },
  {
    name: "NAND swaps the ternary arms rather than negating",
    run: (fail) => {
      const l = line("nand", 2);
      if (!l.endsWith("? 0 : 5")) fail(l);
      if (l.includes("!(")) fail("used an unsupported ! operator");
    },
  },
  {
    name: "input count drives both the expression and the pins",
    run: (fail) => {
      const g = new LogicGate("g1", "U1", undefined, "or", 4);
      if (g.ports.length !== 5) fail(`ports = ${g.ports.length}`);
      const l = line("or", 4);
      if ((l.match(/\|\|/g) ?? []).length !== 3) fail(l);
    },
  },
  {
    name: "NOT and Buffer are forced to a single input",
    run: (fail) => {
      // The base constructor builds ports before the subclass fields exist, so
      // a gate that ignored the rebuild came out with the fallback pin count.
      for (const gate of ["not", "buffer"]) {
        const g = new LogicGate("g1", "U1", undefined, gate as never, 4);
        if (g.inputs !== 1) fail(`${gate}: inputs = ${g.inputs}`);
        if (g.ports.length !== 2) fail(`${gate}: ports = ${g.ports.length}`);
      }
    },
  },
  {
    name: "switching the gate type rebuilds the pins",
    run: (fail) => {
      const g = new LogicGate("g1", "U1", undefined, "and", 3);
      g.setProperty("gateType", "not");
      if (g.ports.length !== 2) fail(`after NOT: ports = ${g.ports.length}`);
      g.setProperty("gateType", "or");
      if (g.ports.length < 3) fail(`back to OR: ports = ${g.ports.length}`);
    },
  },
  {
    name: "the reference keeps its B prefix for ngspice",
    run: (fail) => {
      // ngspice derives the device type from the first letter, so a gate the
      // user named "U1" must still be emitted as B-something.
      if (!line("and", 2).startsWith("BU1 ")) fail("lost the B prefix");
    },
  },
  {
    name: "clone carries the gate over",
    run: (fail) => {
      const g = new LogicGate("g1", "U1", undefined, "xor", 2);
      g.threshold = 1.4;
      const c = g.clone();
      if (c.gateType !== "xor" || c.threshold !== 1.4) fail("clone lost properties");
    },
  },
];

export function runLogicGateTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failedCases = 0;
  for (const tc of CASES) {
    let failed = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); failed = true; });
    if (failed) failedCases++;
  }
  return { total: CASES.length, passed: CASES.length - failedCases, failures };
}

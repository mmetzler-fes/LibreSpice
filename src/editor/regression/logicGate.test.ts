import { LogicGate } from "@core/components/digital/LogicGate.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
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

/**
 * A gate with `n` inputs, wired from a source into every one of them, as the
 * Multisim converter writes it. The gate sits at the origin, so its LTSpice pins
 * are at `(0, 40 ± spread)` for the inputs and `(72, 40)` for the output.
 */
function wiredGate(n: number): string {
  const span = 48;
  const ys = Array.from({ length: n }, (_, i) => 40 + (n === 1 ? 0 : Math.round(-span / 2 + (span * i) / (n - 1))));
  const wires = ys.map((y, i) => `WIRE -64 ${y} 0 ${y}\nFLAG -64 ${y} IN${i + 1}`);
  return [
    "Version 4", "SHEET 1 880 680",
    ...wires,
    "SYMBOL Digital\\and 0 0 R0",
    "SYMATTR InstName U1",
    "SYMATTR Value AND",
    `SYMATTR LibreSpice gate=and;inputs=${n};vth=2.5;vhigh=5;pins=${
      Array.from({ length: n }, (_, i) => `In${i + 1}`).join(",")},Out`,
    "",
  ].join("\n");
}

const CASES: Case[] = [
  {
    // Two faults, one symptom. The parser registered a gate's pins under their
    // *display* names (`In1`) while the ports are `…-in1`, so `connectPorts`
    // threw for every wire on a gate and was caught as "visual only"; and it
    // passed no pin list for a gate, so a three- or four-input one was laid out
    // as the default two-input gate and its wires met nothing at all. Both left
    // the same trace: gates drawn wired, netlisted with every input on node 0.
    // 489 dead inputs across the converted Multisim set.
    name: "a wired gate connects every input, whatever its width",
    run: (fail) => {
      // Two upwards: an AND with one input is not a thing, and the parts that
      // do have one (`not`, `buffer`) get their count from the gate type.
      for (const n of [2, 3, 4]) {
        const { components, edges } = LTSpiceParser.parse(wiredGate(n));
        const gate = components.find((c) => c.label === "U1");
        if (!gate) { fail(`${n} inputs: the gate did not import`); continue; }
        if (gate.ports.length !== n + 1) {
          fail(`${n} inputs: the gate came back with ${gate.ports.length} ports, expected ${n + 1}`);
          continue;
        }
        // One wire per input reached it.
        const onGate = edges.filter((e) => e.source === gate.id || e.target === gate.id);
        if (onGate.length !== n) fail(`${n} inputs: ${onGate.length} wires reached the gate, expected ${n}`);
        // And the handles they use are the ports' own, not the display names.
        const handles = onGate.map((e) => (e.source === gate.id ? e.sourceHandle : e.targetHandle));
        for (const h of handles) {
          if (!gate.ports.some((p) => p.id === `${gate.id}-${h}`)) {
            fail(`${n} inputs: handle "${h}" matches no port of the gate`);
          }
        }
      }
    },
  },

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

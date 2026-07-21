import { VoltageSource, CurrentSource } from "@core/components/sources/Sources.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import { parsePwlFile } from "@core/components/sources/pwlFile.js";
import { getValueLabel } from "../componentFactory.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * PWL is a first-class source type, not a verbatim string the importer happens
 * to carry through.
 *
 * Two regressions are pinned here:
 *  - PWL used to survive import only via `rawSpec`, which `setProperty` clears
 *    on the first edit of any waveform field. Opening the source's properties
 *    and touching anything silently turned a piecewise-linear waveform into a
 *    DC source.
 *  - Values written with a Unicode micro sign reached ngspice unchanged. Both
 *    U+00B5 and U+03BC render identically to `u` but are not understood as a
 *    suffix, so `10µ` was read as `10` — a 10 µs segment became 10 s.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

/** The SPICE spec a source emits, via its netlist line. */
function specOf(c: VoltageSource | CurrentSource): string {
  const line = c.getNetlistLine();
  return line.slice(line.indexOf("PWL")).trim();
}

const CASES: Case[] = [
  {
    name: "voltage source emits a PWL spec",
    run: (fail) => {
      const v = new VoltageSource("v1", "V1");
      v.setProperty("sourceType", "PWL");
      v.setProperty("pwlPoints", "0 0 10m 5V 20m 5V 25m 0V");
      const spec = specOf(v);
      if (spec !== "PWL(0 0 10m 5V 20m 5V 25m 0V)") fail(`spec = ${spec}`);
    },
  },
  {
    name: "current source emits a PWL spec",
    run: (fail) => {
      const i = new CurrentSource("i1", "I1");
      i.setProperty("sourceType", "PWL");
      i.setProperty("pwlPoints", "0 0mA 5m 10mA 15m 10mA 20m 0mA");
      const spec = specOf(i);
      if (spec !== "PWL(0 0mA 5m 10mA 15m 10mA 20m 0mA)") fail(`spec = ${spec}`);
    },
  },
  {
    name: "editing the points does not discard the waveform",
    run: (fail) => {
      const v = new VoltageSource("v1", "V1");
      v.setProperty("sourceType", "PWL");
      v.setProperty("pwlPoints", "0 0 1m 3");
      // The old failure: any setProperty cleared rawSpec, which was the only
      // place the waveform lived, so the source fell back to DC.
      v.setProperty("label", "V2");
      if (v.sourceType !== "PWL") fail(`sourceType = ${v.sourceType}`);
      if (!specOf(v).startsWith("PWL(")) fail("waveform lost after edit");
    },
  },
  {
    name: "both micro signs become u in the netlist",
    run: (fail) => {
      for (const [name, sign] of [["U+00B5", "µ"], ["U+03BC", "μ"]]) {
        const v = new VoltageSource("v1", "V1");
        v.setProperty("sourceType", "PWL");
        v.setProperty("pwlPoints", `0 0 10${sign} 5 20${sign} 0`);
        const spec = specOf(v);
        if (spec !== "PWL(0 0 10u 5 20u 0)") fail(`${name}: spec = ${spec}`);
      }
    },
  },
  {
    name: "an imported PWL keeps its points and stays editable",
    run: (fail) => {
      const asc = [
        "Version 4",
        "SHEET 1 880 680",
        "FLAG 16 240 0",
        "SYMBOL voltage 16 96 R0",
        "SYMATTR InstName V1",
        "SYMATTR Value PWL(0 0 10m 5 20m 5 25m 0)",
      ].join("\n");
      const parsed = LTSpiceParser.parse(asc);
      const v = parsed.components.find((c: SpiceComponent) => c.label === "V1") as VoltageSource | undefined;
      if (!v) return fail("source not parsed");
      if (v.sourceType !== "PWL") return fail(`sourceType = ${v.sourceType}`);
      if (v.pwlPoints !== "0 0 10m 5 20m 5 25m 0") fail(`points = ${v.pwlPoints}`);
      // Structured, not verbatim: rawSpec would be dropped on the first edit.
      if (v.rawSpec) fail("still stored as rawSpec");
    },
  },
  {
    name: "the caption names the waveform instead of showing a DC value",
    run: (fail) => {
      const v = new VoltageSource("v1", "V1");
      v.setProperty("sourceType", "PWL");
      const label = getValueLabel(v, "vsource");
      if (label !== "PWL") fail(`label = ${label}`);
    },
  },
  {
    name: "reads pairs from a plain measurement file",
    run: (fail) => {
      const r = parsePwlFile("0 0\n10m 5\n20m 5\n25m 0\n");
      if (r.points !== "0 0 10m 5 20m 5 25m 0") fail(`points = ${r.points}`);
      if (r.count !== 4) fail(`count = ${r.count}`);
    },
  },
  {
    name: "skips comments and blank lines",
    run: (fail) => {
      const r = parsePwlFile("* Messung\n\n0 0\n; Kommentar\n1m 2  # Ende\n");
      if (r.points !== "0 0 1m 2") fail(`points = ${r.points}`);
    },
  },
  {
    name: "accepts a German CSV export with decimal commas",
    run: (fail) => {
      // Semicolon-separated with "0,001" as a decimal — reading the comma as a
      // separator here would split one column into two and desync every pair.
      const r = parsePwlFile("0;0\n0,001;5\n0,002;0\n");
      if (r.points !== "0 0 0.001 5 0.002 0") fail(`points = ${r.points}`);
    },
  },
  {
    name: "treats commas as separators when they are not decimals",
    run: (fail) => {
      const r = parsePwlFile("0,0\n10m,5\n");
      if (r.points !== "0 0 10m 5") fail(`points = ${r.points}`);
    },
  },
  {
    name: "rejects an odd number of values",
    run: (fail) => {
      try {
        parsePwlFile("0 0\n10m 5\n20m\n");
        fail("accepted an incomplete pair");
      } catch { /* expected */ }
    },
  },
  {
    name: "rejects times that run backwards",
    run: (fail) => {
      // ngspice would simulate this without complaint and give a wrong answer.
      try {
        parsePwlFile("0 0\n20m 5\n10m 3\n");
        fail("accepted non-monotonic time");
      } catch { /* expected */ }
    },
  },
  {
    name: "rejects a non-numeric token",
    run: (fail) => {
      try {
        parsePwlFile("0 0\nzeit wert\n");
        fail("accepted a text token");
      } catch { /* expected */ }
    },
  },
  {
    name: "normalises micro signs read from a file",
    run: (fail) => {
      const r = parsePwlFile("0 0\n10\u03bc 5\n20\u00b5 0\n");
      if (r.points !== "0 0 10u 5 20u 0") fail(`points = ${r.points}`);
    },
  },
  {
    name: "the repeat flag is emitted as ngspice's r=0",
    run: (fail) => {
      // Verified against the engine: with `r=0` the breakpoints replay from
      // t = 0 forever, without it the source holds its last value.
      const v = new VoltageSource("v1", "V1");
      v.setProperty("sourceType", "PWL");
      v.setProperty("pwlPoints", "0 0 1m 5 1.1m 0");
      if (specOf(v) !== "PWL(0 0 1m 5 1.1m 0)") fail(`off: ${specOf(v)}`);
      v.setProperty("pwlRepeat", "yes");
      if (specOf(v) !== "PWL(0 0 1m 5 1.1m 0 r=0)") fail(`on: ${specOf(v)}`);
    },
  },
  {
    name: "a current source repeats too",
    run: (fail) => {
      const i = new CurrentSource("i1", "I1");
      i.setProperty("sourceType", "PWL");
      i.setProperty("pwlPoints", "0 0 1m 5m");
      i.setProperty("pwlRepeat", "yes");
      if (specOf(i) !== "PWL(0 0 1m 5m r=0)") fail(specOf(i));
    },
  },
  {
    name: "r= is split off the points on import, not kept as a breakpoint",
    run: (fail) => {
      // Left in the points text it would be read as a time/value pair, and the
      // next load from a measurement file would drop the repeat silently.
      const asc = `Version 4
SHEET 1 880 680
SYMBOL voltage 100 100 R0
SYMATTR InstName V1
SYMATTR Value PWL(0 0 1m 5 1.1m 0 r=0)
`;
      const comp = LTSpiceParser.parse(asc).components[0] as unknown as {
        sourceType: string; pwlPoints: string; pwlRepeat: boolean;
      };
      if (comp.sourceType !== "PWL") fail(`type = ${comp.sourceType}`);
      if (comp.pwlPoints !== "0 0 1m 5 1.1m 0") fail(`points = "${comp.pwlPoints}"`);
      if (comp.pwlRepeat !== true) fail("repeat lost");
    },
  },
  {
    name: "a PWL without r= imports as non-repeating",
    run: (fail) => {
      const asc = `Version 4
SHEET 1 880 680
SYMBOL voltage 100 100 R0
SYMATTR InstName V1
SYMATTR Value PWL(0 0 1m 5)
`;
      const comp = LTSpiceParser.parse(asc).components[0] as unknown as {
        pwlPoints: string; pwlRepeat: boolean;
      };
      if (comp.pwlRepeat !== false) fail("repeat invented");
      if (comp.pwlPoints !== "0 0 1m 5") fail(`points = "${comp.pwlPoints}"`);
    },
  },
  {
    name: "the repeat flag survives a save/load round trip",
    run: (fail) => {
      const v = new VoltageSource("v1", "V1");
      v.setProperty("sourceType", "PWL");
      v.setProperty("pwlPoints", "0 0 1m 5");
      v.setProperty("pwlRepeat", "yes");
      const back = new VoltageSource("v2", "V2");
      back.deserialize(v.serialize());
      if (back.pwlRepeat !== true) fail("serialize/deserialize lost it");
      if (v.clone().pwlRepeat !== true) fail("clone lost it");
    },
  },
];

export function runPwlSourceTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failedCases = 0;
  for (const tc of CASES) {
    let failed = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); failed = true; });
    if (failed) failedCases++;
  }
  return { total: CASES.length, passed: CASES.length - failedCases, failures };
}

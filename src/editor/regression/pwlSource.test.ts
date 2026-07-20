import { VoltageSource, CurrentSource } from "@core/components/sources/Sources.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
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

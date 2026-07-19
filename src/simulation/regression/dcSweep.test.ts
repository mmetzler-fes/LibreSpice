import { parseStepDirectives, isTempSweep, withTemp, withParam, withDcSource } from "../paramSweep.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * `.dc` sweeps combined with `.step`, as in `examples/05-2-4-1_TempDiode.asc`:
 *
 *     .dc V1 0V 1V 0.01V
 *     .step lin temp 0 100 10
 *
 * Three things have to hold for that plot to mean anything: the x-axis is the
 * swept source (not time), the sweep vector is not also drawn as a curve, and
 * `temp` actually changes the simulation temperature rather than being taken for
 * a source of that name.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const CASES: Case[] = [
  { name: "`.step temp` is recognised as the temperature, not a source", run: (fail) => {
    // Both spellings mean the ambient temperature in LTSpice. Without the
    // `param` keyword the parser calls it a source, so the *name* has to decide.
    for (const line of [".step lin temp 0 100 10", ".step param temp 0 100 10", ".STEP TEMP 0 100 10"]) {
      const [spec] = parseStepDirectives(line);
      if (!spec) { fail(`"${line}" did not parse at all`); continue; }
      if (!isTempSweep(spec.name)) fail(`"${line}" → name "${spec.name}" not recognised as a temperature sweep`);
    }
    // A source or param that merely *contains* "temp" is not the temperature.
    for (const name of ["temp1", "Vtemp", "tempco"]) {
      if (isTempSweep(name)) fail(`"${name}" must not count as the temperature sweep`);
    }
  } },

  { name: "withTemp sets .temp before .end and replaces any earlier one", run: (fail) => {
    const base = "* t\nV1 n1 0 DC 1\n.dc V1 0 1 0.01\n.end\n";
    const out = withTemp(base, 50);
    if (!/^\.temp 50$/m.test(out)) fail(`no ".temp 50" in:\n${out}`);
    const lines = out.split("\n");
    const t = lines.findIndex((l) => /^\.temp\b/.test(l));
    const e = lines.findIndex((l) => /^\.end\s*$/.test(l));
    if (!(t >= 0 && e >= 0 && t < e)) fail(`".temp" must come before ".end" (temp@${t}, end@${e})`);
    // A second sweep step must not stack another .temp on top of the first.
    const again = withTemp(out, 75);
    const count = (again.match(/^\.temp\b/gm) ?? []).length;
    if (count !== 1) fail(`expected exactly one .temp line, got ${count}`);
    if (!/^\.temp 75$/m.test(again)) fail("the later value did not replace the earlier one");
  } },

  { name: "a temp sweep does not fall through to the source/param substitutions", run: (fail) => {
    // The old behaviour: `.step temp` parsed as a source, and withDcSource then
    // matched no component line — so every run silently used the same default
    // temperature and the sweep drew identical curves.
    const base = "* t\nV1 n1 0 DC 1\nD1 n1 0 DMOD\n.dc V1 0 1 0.01\n.end\n";
    if (withDcSource(base, "temp", 50) !== base) {
      fail("withDcSource unexpectedly rewrote a line for a source named 'temp' — the guard would be moot");
    }
    // A real param sweep still goes the .param route, untouched by any of this.
    if (!/^\.param RM=50$/m.test(withParam(base, "RM", 50))) fail("a normal param sweep broke");
  } },
];

export function runDcSweepTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

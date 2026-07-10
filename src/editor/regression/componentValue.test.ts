import { Resistor } from "@core/components/passives/Resistor.js";
import { Capacitor } from "@core/components/passives/Capacitor.js";
import { Inductor } from "@core/components/passives/Inductor.js";
import { isParametricValue, parseSI, parseValueInput, toComponentNumber, valueFieldText } from "@core/components/base/componentValue.js";
import { getValueLabel } from "../componentFactory.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * A component's value must accept a parametric expression (`{RM}`) as well as an
 * SI number (`4.7k`), and survive the round trip through the properties panel.
 *
 * Two regressions are pinned here:
 *  - The value field parsed its text with `parseSI`, which returns `null` for
 *    `{RM}` — so the expression was never committed and the field snapped back
 *    to the old number on blur.
 *  - Coming back the other way, `setProperty` coerced with `Number("4.7k")` =
 *    `NaN`, silently destroying the component's value.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

/** Simulate the panel: text → parsed input → setProperty → what the panel shows. */
function typeIntoValueField(comp: { setProperty: (k: string, v: string | number) => void; getProperties: () => { key: string; value: string | number }[] }, key: string, text: string): string {
  const parsed = parseValueInput(text);
  if (parsed) comp.setProperty(key, parsed.value);
  const prop = comp.getProperties().find((p) => p.key === key)!;
  return valueFieldText(prop.value);
}

const CASES: Case[] = [
  {
    name: "parseValueInput classifies numbers, expressions and junk",
    run: (fail) => {
      const expect = (text: string, want: unknown) => {
        const got = parseValueInput(text);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          fail(`parseValueInput(${JSON.stringify(text)}) = ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
        }
      };
      expect("4.7k", { kind: "number", value: 4700 });
      expect("1MEG", { kind: "number", value: 1e6 });
      expect("10n", { kind: "number", value: 1e-8 });
      expect("12m", { kind: "number", value: 0.012 });
      expect("{RM}", { kind: "expr", value: "{RM}" });
      expect("  {R1*2}  ", { kind: "expr", value: "{R1*2}" });
      // Not committable: the stored value must stay untouched.
      expect("", null);
      expect("{R", null);
      expect("abc", null);
    },
  },
  {
    name: "isParametricValue needs a complete brace group",
    run: (fail) => {
      for (const yes of ["{RM}", "{R1*2}", "x{R}"]) {
        if (!isParametricValue(yes)) fail(`${yes} should be parametric`);
      }
      for (const no of ["{", "{}", "R1", "4.7k", 4700 as unknown as string]) {
        if (isParametricValue(no)) fail(`${JSON.stringify(no)} should not be parametric`);
      }
    },
  },
  {
    name: "toComponentNumber understands SI prefixes and keeps the fallback",
    run: (fail) => {
      const eq = (got: number, want: number) => { if (got !== want) fail(`got ${got}, want ${want}`); };
      eq(toComponentNumber("4.7k", 1), 4700);
      eq(toComponentNumber("1MEG", 1), 1e6);
      eq(toComponentNumber(220, 1), 220);
      eq(toComponentNumber("nonsense", 1000), 1000);
      eq(toComponentNumber("", 1000), 1000);
    },
  },
  {
    // Guards the component layer directly, not through the panel's parser:
    // `setProperty` must survive an SI *string*, which is what a snapshot
    // restore and the .asc importer hand it. `Number("4.7k")` is NaN.
    name: "setProperty accepts an SI string without producing NaN",
    run: (fail) => {
      const r = new Resistor("r1", "R1", undefined, 1000);
      r.setProperty("resistance", "4.7k");
      if (!isFinite(r.resistance)) return fail(`resistance is ${r.resistance} (NaN wipes the component)`);
      if (r.resistance !== 4700) fail(`resistance = ${r.resistance}, want 4700`);

      const c = new Capacitor("c1", "C1", undefined, 1e-6);
      c.setProperty("capacitance", "10n");
      if (c.capacitance !== 1e-8) fail(`capacitance = ${c.capacitance}, want 1e-8`);

      // Junk must leave the value alone rather than blank it.
      const keep = new Resistor("r2", "R2", undefined, 220);
      keep.setProperty("resistance", "oops");
      if (keep.resistance !== 220) fail(`junk changed resistance to ${keep.resistance}`);
    },
  },
  {
    // Why the panel used to snap back: its SI parser has no notion of `{…}`,
    // so nothing was ever committed and `onBlur` restored the old number.
    name: "the SI parser rejects an expression, so the value field must not rely on it alone",
    run: (fail) => {
      if (parseSI("{RM}") !== null) fail("parseSI unexpectedly parsed an expression");
      const parsed = parseValueInput("{RM}");
      if (parsed?.kind !== "expr") fail("parseValueInput must recognise what parseSI cannot");
    },
  },
  {
    name: "typing {RM} into a resistor stores it and the field keeps showing it",
    run: (fail) => {
      const r = new Resistor("r1", "R1", undefined, 1000);
      const shown = typeIntoValueField(r, "resistance", "{RM}");
      if (shown !== "{RM}") fail(`field shows ${JSON.stringify(shown)} after Enter, want "{RM}"`);
      if (r.valueExpr !== "{RM}") fail(`valueExpr = ${JSON.stringify(r.valueExpr)}`);
      const prop = r.getProperties().find((p) => p.key === "resistance")!;
      if (prop.value !== "{RM}") fail(`getProperties value = ${JSON.stringify(prop.value)}`);
    },
  },
  {
    name: "a parametric resistor emits its expression into the netlist and the caption",
    run: (fail) => {
      const r = new Resistor("r1", "RL", undefined, 1000);
      r.setProperty("resistance", "{Rvar}");
      const line = r.getNetlistLine();
      if (!line.includes("{Rvar}")) fail(`netlist line ${JSON.stringify(line)} lacks {Rvar}`);
      if (line.includes("1000")) fail(`netlist line ${JSON.stringify(line)} still carries the number`);
      const caption = getValueLabel(r, "resistor");
      if (caption !== "{Rvar}") fail(`caption ${JSON.stringify(caption)} ≠ "{Rvar}"`);
    },
  },
  {
    name: "switching a parametric value back to an SI number does not produce NaN",
    run: (fail) => {
      const r = new Resistor("r1", "R1", undefined, 1000);
      r.setProperty("resistance", "{RM}");
      const shown = typeIntoValueField(r, "resistance", "4.7k");
      if (r.valueExpr !== undefined) fail(`valueExpr should be cleared, got ${JSON.stringify(r.valueExpr)}`);
      if (r.resistance !== 4700) fail(`resistance = ${r.resistance}, want 4700`);
      if (shown !== "4.7k") fail(`field shows ${JSON.stringify(shown)}, want "4.7k"`);
    },
  },
  {
    name: "a half-typed expression never destroys the stored value",
    run: (fail) => {
      const r = new Resistor("r1", "R1", undefined, 1000);
      for (const keystroke of ["", "{", "{R", "{RM"]) {
        typeIntoValueField(r, "resistance", keystroke);
        if (r.resistance !== 1000) return fail(`after typing ${JSON.stringify(keystroke)}: resistance = ${r.resistance}`);
        if (r.valueExpr !== undefined) return fail(`after typing ${JSON.stringify(keystroke)}: valueExpr = ${r.valueExpr}`);
      }
      // Only the complete expression commits.
      typeIntoValueField(r, "resistance", "{RM}");
      if (r.valueExpr !== "{RM}") fail("complete expression did not commit");
    },
  },
  {
    name: "capacitor and inductor behave the same",
    run: (fail) => {
      const c = new Capacitor("c1", "C1", undefined, 1e-6);
      if (typeIntoValueField(c, "capacitance", "{Cvar}") !== "{Cvar}") fail("capacitor rejected {Cvar}");
      if (typeIntoValueField(c, "capacitance", "10n") !== "10n") fail("capacitor rejected 10n");
      if (c.capacitance !== 1e-8) fail(`capacitance = ${c.capacitance}, want 1e-8`);

      const l = new Inductor("l1", "L1", undefined, 1e-3);
      if (typeIntoValueField(l, "inductance", "{Lvar}") !== "{Lvar}") fail("inductor rejected {Lvar}");
      if (typeIntoValueField(l, "inductance", "4.7m") !== "4.7m") fail("inductor rejected 4.7m");
      if (Math.abs(l.inductance - 4.7e-3) > 1e-12) fail(`inductance = ${l.inductance}, want 4.7e-3`);
    },
  },
  {
    name: "clone preserves a parametric value",
    run: (fail) => {
      const r = new Resistor("r1", "R1", undefined, 1000);
      r.setProperty("resistance", "{RM}");
      if (r.clone().valueExpr !== "{RM}") fail("clone lost valueExpr");
    },
  },
];

export function runComponentValueTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failedCases = 0;
  for (const tc of CASES) {
    let failed = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); failed = true; });
    if (failed) failedCases++;
  }
  return { total: CASES.length, passed: CASES.length - failedCases, failures };
}

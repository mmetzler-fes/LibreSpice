import { useCircuitStore } from "@store/circuitStore.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * The pulse source must save what it loaded.
 *
 * This is the shape of a bug that already cost a schematic once: before commit
 * 6b320bb the parser read only some of `PULSE`'s fields, so delay, rise and fall
 * kept their defaults — and the next save wrote those defaults back over the
 * file. A triangle `PULSE(0 10 0 10 10 0 20)` came back as
 * `PULSE(0 10 0 1n 1n 0.0005 20)`: a 0.5 ms spike where a 20 s ramp had been.
 * Nothing warned, and the damage only showed as a flat line in the plot.
 *
 * The danger is structural rather than specific to those three fields: a source
 * carries eight numbers positionally, and any one of them silently defaulting
 * rewrites the waveform. So every field is checked, on both paths a value can
 * take:
 *
 *  - verbatim, where the imported text is kept and re-emitted (`rawSpec`);
 *  - reconstructed, after the user touches a field, which drops the verbatim
 *    text and rebuilds the spec from the parsed numbers. That is where a field
 *    the parser never read would fall back to its default.
 */

const tick = () => new Promise((r) => setTimeout(r, 0));
const st = () => useCircuitStore.getState();

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> };

/** A one-source schematic, so the round trip has something minimal to chew on. */
const asc = (value: string) => `Version 4
SHEET 1 880 680
FLAG 0 96 0
SYMBOL voltage 0 0 R0
SYMATTR InstName V1
SYMATTR Value ${value}
`;

/** The voltage source of the loaded circuit. */
const source = () =>
  [...st().circuit.components.values()].find((c) => (c as { pPer?: number }).pPer !== undefined) as unknown as
    Record<string, number> | undefined;

/** The seven (or eight) pulse numbers, as the component holds them. */
const fields = (): string => {
  const s = source();
  if (!s) return "(keine Quelle)";
  return [s.pV1, s.pV2, s.pTd, s.pTr, s.pTf, s.pPw, s.pPer, s.pNp].join(" ");
};

async function loadSpec(value: string): Promise<void> {
  st().clearCircuit();
  st().loadFromAsc(asc(value));
  await tick();
  await tick();
}

/** The `SYMATTR Value` an export would write for the current circuit. */
const written = (): string =>
  LTSpiceExporter.export(st().nodes, st().edges, st().spiceDirectives, st().circuit, st().dataFlags, st().textBoxes, [], { anchors: st().netAnchors })
    .split("\n").find((l) => l.startsWith("SYMATTR Value "))?.slice(14) ?? "(nichts)";

/** Every field the exercises rely on, in forms that stress the number parsing. */
const SPECS = [
  // A slow triangle: the waveform the loss above destroyed.
  "PULSE(0 10 0 10 10 0 20)",
  // SI suffixes on both fast and slow fields.
  "PULSE(0 10 0 1n 1n 500u 20)",
  // The same values spelled as decimals, which must parse identically.
  "PULSE(0 10 0 1e-9 1e-9 0.0005 20)",
  // Negative levels and a delay.
  "PULSE(-5 5 2m 1u 1u 10m 25m)",
  // A pulse count, the eighth field.
  "PULSE(0 10 0 1n 1n 0.0005 20 3)",
  // Milli and kilo next to each other.
  "PULSE(0 3.3 1m 10u 10u 1m 2m)",
];

/** Numeric value of a SPICE number, suffix or not. */
function si(v: string): number {
  const m = /^([-+]?[\d.]+(?:e[-+]?\d+)?)([a-zµ]*)$/i.exec(v);
  if (!m) return NaN;
  const mult: Record<string, number> = { t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, µ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
  const suf = m[2].toLowerCase();
  return parseFloat(m[1]) * (suf.startsWith("meg") ? 1e6 : mult[suf[0]] ?? 1);
}
/** The numbers inside a `PULSE(...)`, as written. */
const specNumbers = (spec: string) =>
  (spec.match(/PULSE\(([^)]*)\)/i)?.[1] ?? "").split(/[\s,]+/).filter(Boolean).map(si);

const CASES: Case[] = [
  {
    name: "every field of the source text reaches the component",
    run: async (fail) => {
      // Compared against the *text*, not against a second load of our own
      // output: a field the parser never reads defaults on the way in and is
      // written back as that default, so a load → save → load comparison finds
      // both sides equal and reports nothing. That is exactly how the triangle
      // was lost without a single test noticing.
      const NAMES = ["V1", "V2", "Tdelay", "Trise", "Tfall", "Ton", "Tperiod", "Ncycles"];
      for (const spec of SPECS) {
        await loadSpec(spec);
        const s = source();
        if (!s) { fail(`${spec}: keine Quelle geladen`); continue; }
        const want = specNumbers(spec);
        const got = [s.pV1, s.pV2, s.pTd, s.pTr, s.pTf, s.pPw, s.pPer, s.pNp];
        want.forEach((w, i) => {
          if (Math.abs(got[i] - w) > Math.max(Math.abs(w) * 1e-9, 1e-18)) {
            fail(`${spec}: ${NAMES[i]} geladen als ${got[i]}, in der Datei steht ${w}`);
          }
        });
      }
    },
  },
  {
    name: "every field survives load → save → load",
    run: async (fail) => {
      for (const spec of SPECS) {
        await loadSpec(spec);
        const before = fields();
        const out = written();
        await loadSpec(out);
        const after = fields();
        if (before !== after) fail(`${spec}\n      geladen:  ${before}\n      erneut:   ${after}\n      Datei:    ${out}`);
      }
    },
  },
  {
    name: "touching a field does not disturb the others",
    run: async (fail) => {
      // Editing any waveform field drops the verbatim spec, so the file is then
      // rebuilt from the parsed numbers — the path on which an unread field
      // would silently fall back to its default.
      for (const spec of SPECS) {
        await loadSpec(spec);
        const before = fields();
        const s = source()!;
        (s as unknown as { setProperty(k: string, v: number): void }).setProperty("pV2", s.pV2);
        const out = written();
        await loadSpec(out);
        const after = fields();
        if (before !== after) fail(`${spec}\n      vorher:   ${before}\n      nachher:  ${after}\n      Datei:    ${out}`);
      }
    },
  },
  {
    name: "the edges of a slow triangle are not reset to 1 ns",
    run: async (fail) => {
      // The concrete loss, pinned: a 10 s ramp must not come back as a 1 ns edge,
      // whichever path the value takes.
      await loadSpec("PULSE(0 10 0 10 10 0 20)");
      const s = source()!;
      if (s.pTr !== 10 || s.pTf !== 10) return fail(`geladen als Tr=${s.pTr} Tf=${s.pTf}, erwartet 10/10`);
      (s as unknown as { setProperty(k: string, v: number): void }).setProperty("pV2", s.pV2);
      const out = written();
      if (/\b1n\b|\b1e-9\b/.test(out)) fail(`nach dem Speichern auf eine Nanosekunden-Flanke zurueckgefallen: ${out}`);
      await loadSpec(out);
      const back = source()!;
      if (back.pTr !== 10 || back.pTf !== 10) fail(`erneut geladen als Tr=${back.pTr} Tf=${back.pTf}`);
    },
  },
  {
    name: "an SI suffix means the same as the decimal it stands for",
    run: async (fail) => {
      await loadSpec("PULSE(0 10 0 1n 1n 500u 20)");
      const withSuffix = fields();
      await loadSpec("PULSE(0 10 0 1e-9 1e-9 0.0005 20)");
      const withDecimals = fields();
      if (withSuffix !== withDecimals) fail(`${withSuffix} vs ${withDecimals}`);
    },
  },
  {
    name: "the netlist carries the same numbers as the file",
    run: async (fail) => {
      // A file that reads correctly but simulates something else would be the
      // worst of the three failures, since only the plot would show it.
      for (const spec of SPECS) {
        await loadSpec(spec);
        st().regenerateNetlist();
        const line = st().netlist.split("\n").find((l) => /^V/.test(l)) ?? "";
        const nums = (s: string) => (s.match(/PULSE\(([^)]*)\)/i)?.[1] ?? "").split(/\s+/).filter(Boolean);
        const fromNetlist = nums(line);
        const fromFile = nums(written());
        if (fromNetlist.length !== fromFile.length) {
          fail(`${spec}: Netzliste hat ${fromNetlist.length} Werte, Datei ${fromFile.length}`);
          continue;
        }
        // Compared as numbers, since the two may spell a value differently.
        const si = (v: string) => {
          const m = /^([-+]?[\d.]+(?:e[-+]?\d+)?)([a-zµ]*)$/i.exec(v);
          if (!m) return NaN;
          const mult: Record<string, number> = { t: 1e12, g: 1e9, k: 1e3, m: 1e-3, u: 1e-6, µ: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15 };
          const suf = m[2].toLowerCase();
          return parseFloat(m[1]) * (suf.startsWith("meg") ? 1e6 : mult[suf[0]] ?? 1);
        };
        fromFile.forEach((v, i) => {
          if (Math.abs(si(v) - si(fromNetlist[i])) > Math.abs(si(v)) * 1e-9) {
            fail(`${spec}: Wert ${i + 1} — Datei ${v}, Netzliste ${fromNetlist[i]}`);
          }
        });
      }
    },
  },
  {
    name: "a pulse count of zero is left out, a real one is kept",
    run: async (fail) => {
      await loadSpec("PULSE(0 10 0 1n 1n 0.0005 20 3)");
      if (source()!.pNp !== 3) return fail(`Ncycles = ${source()!.pNp}`);
      (source() as unknown as { setProperty(k: string, v: number): void }).setProperty("pV2", 10);
      if (!/\s3\)$/.test(written())) fail(`Ncycles beim Speichern verloren: ${written()}`);

      await loadSpec("PULSE(0 10 0 1n 1n 0.0005 20)");
      (source() as unknown as { setProperty(k: string, v: number): void }).setProperty("pV2", 10);
      const out = written();
      if ((out.match(/\s/g) ?? []).length !== 6) fail(`ein Ncycles=0 wurde mitgeschrieben: ${out}`);
    },
  },
];

export async function runPulseSourceTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    let failed = false;
    await c.run((reason) => { if (!failed) { failed = true; failures.push({ name: c.name, reason }); } });
  }
  return { total: CASES.length, passed: CASES.length - failures.length, failures };
}

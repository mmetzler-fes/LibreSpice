import { withSymbols } from "./withSymbols.js";
import { surveySheet } from "./sheetSurvey.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { ModelParser } from "@core/library/ModelParser.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Does every shipped schematic open correctly?
 *
 * Not "does it parse" — that much `ascExamples` already covers by round-tripping
 * the file. This asks the four things a user would see and the parser would not
 * complain about:
 *
 *   1. every part has pins at all (no symbol, no fallback ⇒ nothing can attach);
 *   2. every wire end names a handle its part actually has;
 *   3. every library part's `.subckt` is in the netlist (the `UNKNOWN` of
 *      `libraryLink.test.ts`, checked here across the whole corpus);
 *   4. every net name sits on a wire or a pin.
 *
 * The fourth is the one that keeps finding things. A name 25 px off its wire
 * looks right on screen and names nothing: it grounded two inputs of a display
 * in the frequency-divider sheet, and left an op-amp unpowered in five share
 * links, in both cases with no error anywhere. It is measured against the
 * canvas's own geometry, at `ANCHOR_TOLERANCE`, which is the same distance the
 * editor itself uses to decide what a name belongs to.
 *
 * Data-driven over four directories, so a newly added or converted sheet is
 * covered without touching this file. Absent directories are not a failure:
 * `examples/` is git-ignored (teaching material from third parties), so a fresh
 * clone legitimately has almost none of it — but `examples/` itself must exist
 * with files in it, or the suite would pass by measuring nothing.
 */

const DIRS = [
  "examples",
  "examples/Rahm",
  "examples/Multisim_converted",
  "examples/Multisim14_converted",
];

/**
 * Sheets with a known loose name, and why.
 *
 * Deliberately per file and with a reason, in the shape `ascExamples`'s
 * `KNOWN_ROUNDTRIP_ISSUES` already uses here: a bare count would say the corpus
 * got worse without saying where, and no list at all would mean the suite could
 * never be green and would stop being read.
 *
 * The Multisim entries are one fault, not four: the converter drops the name 16
 * units below the wire it names (`WIRE 308 320 368 320` / `FLAG 340 336 Ua` in
 * `10_1_Passiver_RC_Tiefpass.asc`). It is not fixed here because converter
 * geometry is not a thing to change casually — five rebuilds of it were taken
 * back in one day — and because the fix belongs with a before/after measurement
 * over the whole converted corpus (`scripts/measure-conversion.mjs`).
 *
 * Keyed by `<directory>/<file>`, not by file name: the same sheet name occurs in
 * several corpora — `1_3_2_PT100-Sensor_mit_Brueckenschaltung.asc` is loose
 * under `examples/Rahm` and clean in both converted sets — and a bare name would
 * have waived all three at once while reporting the clean ones as stale.
 */
const KNOWN_LOOSE: Record<string, string> = {
  // Ein doppelter FLAG-Block in der Vorlage: `FLAG 304 184 Ub-` ist die
  // Altfassung von `FLAG 304 160 Ub-`, 24 px daneben, benennt nichts.
  "examples/InvSummierverstaerker.asc": "doppelter FLAG-Block in der Vorlage",
  // Von Hand verschobene Namen (krumme Koordinaten: 481,291).
  "examples/Rahm/1_3_2_PT100-Sensor_mit_Brueckenschaltung.asc": "Namen von Hand verschoben, nicht auf dem Raster",
  // Konverter setzt den Namen 16-32 Einheiten neben die Leitung.
  "examples/Multisim_converted/10_1_Passiver_RC_Tiefpass.asc": "Konverter-Versatz",
  "examples/Multisim_converted/9_5_Dreieck-Rechteck-Generator.asc": "Konverter-Versatz",
  "examples/Multisim_converted/9_6_PWM_Dreieck-Rechteck-Generator (1).asc": "Konverter-Versatz",
  "examples/Multisim_converted/Trigger.asc": "Konverter-Versatz",
  "examples/Multisim14_converted/9_5_Dreieck-Rechteck-Generator.asc": "Konverter-Versatz",
};

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> };

/** Node's `fs`/`path`, via a runtime specifier so `tsc` stays out of it. */
async function nodeApi(): Promise<any> {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
  return { fs, path, proc: (globalThis as any).process };
}

/** The served library, as the app would have fetched it from `library/sub`. */
async function loadServedLibrary(): Promise<void> {
  const { fs, path, proc } = await nodeApi();
  const dir = path.join(proc.cwd(), "library/sub");
  const entries: { entry: unknown; scope: string }[] = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".lib")) continue;
      try {
        for (const e of ModelParser.parse(fs.readFileSync(path.join(dir, f), "latin1")).entries) {
          entries.push({ entry: e, scope: "server" });
        }
      } catch { /* a malformed drop-in is not this suite's business */ }
    }
  }
  useLibraryStore.setState({ entries, serverAvailable: true } as never);
}

/** One directory, every `.asc` in it, reported per file. */
function dirCase(dir: string): Case {
  return {
    name: `every sheet in ${dir} opens correctly`,
    run: async (fail) => {
      const { fs, path, proc } = await nodeApi();
      const full = path.join(proc.cwd(), dir);
      if (!fs.existsSync(full)) return; // git-ignored corpus, absent in a fresh clone
      const files: string[] = fs.readdirSync(full).filter((n: string) => n.endsWith(".asc")).sort();
      if (files.length === 0) {
        // `examples/` empty is a broken checkout, not an empty corpus; the other
        // three are generated and may legitimately not be there yet.
        if (dir === "examples") fail(`no .asc under ${full}`);
        return;
      }

      const problems: string[] = [];
      const staleWaivers: string[] = [];
      for (const f of files) {
        let s;
        try {
          s = await surveySheet(fs.readFileSync(path.join(full, f), "latin1"));
        } catch (err) {
          problems.push(`${f}: throws — ${String((err as Error)?.message ?? err)}`);
          continue;
        }
        const bad: string[] = [];
        // These three are faults under any circumstances: a part nothing can
        // attach to, a wire to a handle that does not exist, a part ngspice
        // cannot resolve. No sheet is allowed them, however it was made.
        if (s.pinlessNodes.length) bad.push(`no pins: ${s.pinlessNodes.join(", ")}`);
        if (s.danglingEdges.length) bad.push(`wire to nowhere: ${s.danglingEdges.join(", ")}`);
        if (s.danglingSubckts.length) bad.push(`subcircuit: ${s.danglingSubckts.join(", ")}`);

        const loose = s.looseAnchors.map((a) => `${a.name}@${a.x},${a.y} d=${a.dist.toFixed(0)}`);
        const waiver = KNOWN_LOOSE[`${dir}/${f}`];
        if (loose.length && !waiver) bad.push(`loose names: ${loose.join(" ")}`);
        // A waiver that no longer applies is itself a finding: the file was
        // fixed and the entry should go, or the suite quietly stops checking it.
        if (!loose.length && waiver) staleWaivers.push(f);

        if (bad.length) problems.push(`${f}: ${bad.join(" | ")}`);
      }

      for (const f of staleWaivers) {
        problems.push(`${dir}/${f}: is clean now — remove its KNOWN_LOOSE entry`);
      }
      if (problems.length) {
        fail(problems.slice(0, 8).join(" | ") + (problems.length > 8 ? ` (+${problems.length - 8} more)` : ""));
      }
    },
  };
}

export async function runSheetLoadTests(): Promise<TestReport> {
  return await withSymbols(async () => {
    await loadServedLibrary();
    const cases = DIRS.map(dirCase);
    const failures: { name: string; reason: string }[] = [];
    for (const c of cases) {
      try {
        await c.run((reason) => failures.push({ name: c.name, reason }));
      } catch (err) {
        failures.push({ name: c.name, reason: String((err as Error)?.message ?? err) });
      }
    }
    return { total: cases.length, passed: cases.length - failures.length, failures };
  });
}

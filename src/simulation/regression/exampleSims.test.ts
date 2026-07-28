import { runSimulation } from "../simulationEngine.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { ModelParser } from "@core/library/ModelParser.js";
import { withSymbols } from "@editor/regression/withSymbols.js";
import { surveySheet } from "@editor/regression/sheetSurvey.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * Does every sheet that carries an analysis directive actually run?
 *
 * The load suite (`sheetLoad.test.ts`) proves a schematic opens; this proves it
 * computes. They are not the same question, and the gap between them is where
 * the `unknown subckt` failure lived: the sheet drew perfectly, every wire in
 * place, and ngspice refused the netlist. Nothing short of pressing Run would
 * have shown it.
 *
 * What is judged is that ngspice *returns* something, not what it returns:
 *
 *   - no `Error:` in its output — the line that ends a run;
 *   - at least one data vector, since a run that aborts early still "succeeds"
 *     with nothing in it.
 *
 * Deliberately not the numbers. A teaching sheet's correct answer belongs to the
 * teacher, and pinning values here would turn every edited exercise into a red
 * suite. `models.test.ts` checks numbers where they are ours to check.
 *
 * This is the slow half of the corpus and lives in its own runner
 * (`npm run test:examples`, `scripts/run-example-sims.mjs`) rather than in
 * `test:editor`: a `.tran 1e-3 2` is legitimately slow, and the pre-commit run
 * has to stay one people actually run.
 */

const DIRS = [
  "examples",
  "examples/Rahm",
  "examples/Multisim_converted",
  "examples/Multisim14_converted",
];

/** Wall clock a single sheet may take before it is reported as too slow. */
const BUDGET_MS = 20_000;

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

/** What one sheet's run came to. */
type Outcome =
  | { kind: "ok"; vectors: number }
  | { kind: "slow"; ms: number }
  | { kind: "error"; detail: string };

/**
 * Runs one netlist, bounded by the budget.
 *
 * The race does not cancel the run — ngspice is a WASM call and keeps going —
 * so a sheet over budget is reported and the process moves on; the runner exits
 * when the report is written, which ends the stragglers with it.
 */
async function runBounded(netlist: string): Promise<Outcome> {
  const started = Date.now();
  useSimulationStore.getState().setStatus("running");
  useSimulationStore.getState().setLog("");
  const timeout = Symbol("timeout");
  let result: Awaited<ReturnType<typeof runSimulation>> | typeof timeout;
  try {
    result = await Promise.race([
      runSimulation(netlist),
      new Promise<typeof timeout>((r) => setTimeout(() => r(timeout), BUDGET_MS)),
    ]);
  } catch (err) {
    return { kind: "error", detail: `throws — ${String((err as Error)?.message ?? err)}` };
  }
  if (result === timeout) return { kind: "slow", ms: Date.now() - started };

  const log = useSimulationStore.getState().log ?? "";
  // ngspice reports a refused circuit on its own line; the message matters
  // because "unknown subckt: x1 … unknown" is a different fix from a singular
  // matrix, and a bare "it failed" would send the reader back to the terminal.
  const errLine = log.split(/\r?\n/).find((l) => /^\s*Error:/i.test(l));
  if (errLine) return { kind: "error", detail: errLine.trim() };

  const vectors = Object.keys(result.data ?? {}).length;
  if (vectors === 0) return { kind: "error", detail: "ngspice returned no data vectors" };
  return { kind: "ok", vectors };
}

type Case = { name: string; run: (fail: (r: string) => void) => Promise<void> };

function dirCase(dir: string): Case {
  return {
    name: `every analysed sheet in ${dir} runs`,
    run: async (fail) => {
      const { fs, path, proc } = await nodeApi();
      const full = path.join(proc.cwd(), dir);
      if (!fs.existsSync(full)) return; // git-ignored corpus, absent in a fresh clone
      const files: string[] = fs.readdirSync(full).filter((n: string) => n.endsWith(".asc")).sort();

      const failures: string[] = [];
      let ran = 0;
      let slow = 0;
      for (const f of files) {
        let survey;
        try {
          survey = await surveySheet(fs.readFileSync(path.join(full, f), "latin1"));
        } catch (err) {
          failures.push(`${f}: load throws — ${String((err as Error)?.message ?? err)}`);
          continue;
        }
        // No analysis line means the sheet is a drawing, not a simulation — the
        // exercise sheets are full of them and they are not failures.
        if (survey.analyses.length === 0) continue;

        const outcome = await runBounded(survey.netlist);
        if (outcome.kind === "ok") ran++;
        else if (outcome.kind === "slow") {
          // Over budget is reported, not failed: some sheets simulate two
          // seconds of real time and are entitled to take a while.
          slow++;
          console.log(`   ~ ${dir}/${f}: over ${BUDGET_MS / 1000}s (${survey.analyses.join(",")})`);
        } else failures.push(`${f} [${survey.analyses.join(",")}]: ${outcome.detail}`);
      }
      console.log(`   ${dir}: ${ran} gerechnet, ${slow} ueber Budget, ${failures.length} fehlerhaft`);
      if (failures.length) {
        fail(failures.slice(0, 10).join(" | ") + (failures.length > 10 ? ` (+${failures.length - 10} more)` : ""));
      }
    },
  };
}

export async function runExampleSimTests(only?: string[]): Promise<TestReport> {
  return await withSymbols(async () => {
    await loadServedLibrary();
    const cases = (only?.length ? only : DIRS).map(dirCase);
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

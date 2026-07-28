import { runSimulation } from "../simulationEngine.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { ModelParser } from "@core/library/ModelParser.js";
import { withSymbols } from "@editor/regression/withSymbols.js";
import { surveySheet } from "@editor/regression/sheetSurvey.js";

/**
 * Does a sheet that carries an analysis directive actually run?
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
 * **One sheet per module, on purpose.** This exports the run for a *single*
 * file; the walking, the timing out and the reporting live in
 * `scripts/run-example-sims.mjs`, which gives each sheet its own process. In one
 * process a budget cannot be enforced: ngspice is a WASM call, `Promise.race`
 * only stops waiting for it, and the abandoned run keeps a core busy while the
 * next sheets queue behind it. Measured before the split, 77 sheets took over
 * three quarters of an hour, most of it spent by runs nobody was waiting for any
 * more. A child process can simply be killed.
 */

/** What one sheet's run came to. */
export type SimOutcome =
  | { kind: "ok"; vectors: number; analyses: string[] }
  | { kind: "skip" }
  | { kind: "error"; detail: string; analyses: string[] };

/** The served library, as the app would have fetched it from `library/sub`. */
async function loadServedLibrary(): Promise<void> {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
  const proc = (globalThis as any).process;
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

/**
 * Load one `.asc`, netlist it, run it.
 *
 * Returns rather than throws for a refused circuit: "ngspice said no" is a
 * result to report, not an accident. A genuine exception (a sheet that will not
 * load at all) is left to the caller, whose process is about to end anyway.
 */
export async function simulateSheet(ascText: string): Promise<SimOutcome> {
  return await withSymbols(async () => {
    await loadServedLibrary();
    const survey = await surveySheet(ascText);
    // No analysis line means the sheet is a drawing, not a simulation — the
    // exercise sheets are full of them and they are not failures.
    if (survey.analyses.length === 0) return { kind: "skip" };

    useSimulationStore.getState().setStatus("running");
    useSimulationStore.getState().setLog("");
    let result;
    try {
      result = await runSimulation(survey.netlist);
    } catch (err) {
      return { kind: "error", detail: `throws — ${String((err as Error)?.message ?? err)}`, analyses: survey.analyses };
    }

    const log = useSimulationStore.getState().log ?? "";
    // ngspice reports a refused circuit on its own line; the message matters
    // because "unknown subckt: x1 … unknown" is a different fix from a singular
    // matrix, and a bare "it failed" would send the reader back to the terminal.
    const errLine = log.split(/\r?\n/).find((l) => /^\s*Error:/i.test(l));
    if (errLine) return { kind: "error", detail: errLine.trim(), analyses: survey.analyses };

    const vectors = Object.keys(result.data ?? {}).length;
    if (vectors === 0) {
      return { kind: "error", detail: "ngspice returned no data vectors", analyses: survey.analyses };
    }
    return { kind: "ok", vectors, analyses: survey.analyses };
  });
}

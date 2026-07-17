import { useSimulationStore, type SimulationResult } from "@store/simulationStore.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * Which traces the scope shows after a run.
 *
 * The rule: the scope plots what the user asked for and nothing else. A first
 * simulation with no requested probe comes up empty — the store used to auto-pick
 * the first non-constant variable, so every fresh run opened on an arbitrary
 * trace nobody chose (and which had to be found and unticked first).
 *
 * "Add to scope" fills `pendingProbes` *before* a result exists, so those probes
 * are spelled the way the schematic writes them (`I(R1)`). ngspice answers with
 * `i(r1)` / `@r1[i]`, so they have to be resolved by canonical identity rather
 * than by an exact string match — otherwise dropping the auto-pick would leave
 * the scope blank for exactly the user who did ask for a probe.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const sim = () => useSimulationStore.getState();

/** A transient result: a varying node voltage, a constant rail, a device current. */
function makeResult(): SimulationResult {
  const time = new Float64Array([0, 1, 2, 3]);
  return {
    variables: ["time", "V(out)", "V(vcc)", "i(r1)"],
    data: {
      time,
      "V(out)": new Float64Array([0, 1, 2, 3]),   // varies — the old auto-pick's favourite
      "V(vcc)": new Float64Array([5, 5, 5, 5]),   // constant rail
      "i(r1)": new Float64Array([0, 0.1, 0.2, 0.3]),
    },
    time,
  };
}

const CASES: Case[] = [
  { name: "a first simulation with no requested probe selects nothing", run: (fail) => {
    sim().reset();
    sim().setResult(makeResult());
    const sel = sim().selectedVariables;
    if (sel.length !== 0) fail(`the scope auto-selected ${sel.join(", ")} although nothing was requested`);
  } },

  { name: "\"add to scope\" before the run is what gets selected — and only that", run: (fail) => {
    sim().reset();
    sim().addProbe("V(vcc)"); // deliberately the *constant* rail: the user asked for it
    sim().setResult(makeResult());
    const sel = sim().selectedVariables;
    if (sel.length !== 1 || sel[0] !== "V(vcc)") {
      fail(`expected exactly V(vcc), got ${sel.join(", ") || "nothing"}`);
    }
  } },

  { name: "a pending probe resolves across ngspice's spelling (I(R1) → i(r1))", run: (fail) => {
    sim().reset();
    // The schematic menu writes the device's own casing; ngspice reports i(r1).
    sim().addProbeCandidates(["I(R1)"]);
    sim().setResult(makeResult());
    const sel = sim().selectedVariables;
    if (!sel.includes("i(r1)")) {
      fail(`the requested probe I(R1) was dropped instead of resolving to i(r1) (got ${sel.join(", ") || "nothing"})`);
    }
    if (sel.length !== 1) fail(`extra traces slipped in: ${sel.join(", ")}`);
  } },

  { name: "several \"add to scope\" probes all survive the run", run: (fail) => {
    sim().reset();
    sim().addProbe("V(out)");
    sim().addProbeCandidates(["I(R1)"]);
    sim().setResult(makeResult());
    const sel = sim().selectedVariables;
    if (!sel.includes("V(out)") || !sel.includes("i(r1)")) {
      fail(`expected V(out) and i(r1), got ${sel.join(", ") || "nothing"}`);
    }
  } },

  { name: "a re-run keeps the user's selection (panel/colour assignments survive)", run: (fail) => {
    sim().reset();
    sim().setResult(makeResult());
    sim().toggleVariable("i(r1)");   // picked by hand from the sidebar
    sim().setResult(makeResult());   // re-run
    const sel = sim().selectedVariables;
    if (sel.length !== 1 || sel[0] !== "i(r1)") {
      fail(`the re-run changed the selection to ${sel.join(", ") || "nothing"}`);
    }
  } },

  { name: "the time base is never selected as a trace", run: (fail) => {
    sim().reset();
    sim().addProbe("time");
    sim().setResult(makeResult());
    if (sim().selectedVariables.includes("time")) fail("the x-axis was plotted as a trace");
  } },

  { name: "a probe that the result does not contain is dropped, not selected", run: (fail) => {
    sim().reset();
    sim().addProbe("V(nonexistent)");
    sim().setResult(makeResult());
    const sel = sim().selectedVariables;
    if (sel.length !== 0) fail(`expected nothing, got ${sel.join(", ")}`);
  } },
];

export function runProbeSelectionTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

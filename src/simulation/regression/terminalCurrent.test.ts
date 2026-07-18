import { useSimulationStore, type SimulationResult } from "@store/simulationStore.js";
import { usePlotStore } from "../plotStore.js";
import { canonicalProbe, dedupeProbes, matchResultVariable, getCurrentProbeCandidates } from "@core/circuit/probeUtils.js";
import { evalExpression } from "../expression.js";
import { inferUnit } from "../units.js";
import { evalDataFlag } from "@core/circuit/dataExpr.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * Terminal currents of multi-terminal devices — what a transistor characteristic
 * is drawn from (04-3_Transistor2.asc plots B = Ic/Ib over Ic).
 *
 * A two-terminal part has one branch current, so `I(R1)` is unambiguous. A
 * transistor has one current *per pin*: LTSpice writes them `Ic(Q1)`, `Ib(Q1)`,
 * `Ie(Q1)`, `Is(Q1)`, and ngspice (via `.options savecurrents`) saves them as
 * `i(@q1[ic])`, `i(@q1[ib])`, … They used to collapse onto a single canonical
 * `I(Q1)` — the probe list showed one entry for four different quantities, the
 * one shown depended on variable order, and the LTSpice spelling a `.plt` or a
 * user types resolved to nothing at all.
 *
 * The trap in fixing it: a *diode's* only current is named `@d1[id]`, whose `d`
 * looks exactly like a terminal letter but is not one. Reading it as a terminal
 * renames `I(D1)` to a phantom `Id(D1)` that nothing ever asks for — so the
 * suffix only counts for devices that genuinely have terminals (Q/M/J).
 *
 * The variable names below are verbatim from the bundled ngspice.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

const plot = () => usePlotStore.getState();
const sim = () => useSimulationStore.getState();

/** A single empty panel and no probes — the state a fresh diagram starts in. */
function reset(): void {
  usePlotStore.setState({
    panels: [{ id: "panel-0" }], traceToPanel: {}, colors: {},
    expressions: [], hiddenExpressions: [], syncX: false, svgLight: false,
  });
  useSimulationStore.setState({ result: null, selectedVariables: [], pendingProbes: [] });
}

/** ngspice's answer for a BJT stage plus a diode, with `savecurrents` on. */
function makeResult(): SimulationResult {
  const time = new Float64Array([0, 1, 2, 3]);
  const ic = new Float64Array([0, 2e-3, 4e-3, 8e-3]);
  const ib = new Float64Array([0, 1e-5, 2e-5, 4e-5]);   // B = 200 throughout
  return {
    variables: [
      "time", "v(b)", "v(c)",
      "i(@q1[ib])", "i(@q1[ic])", "i(@q1[ie])", "i(@q1[is])",
      "i(@r1[i])", "i(@d1[id])",
    ],
    data: {
      time,
      "v(b)": new Float64Array([0, 0.6, 0.7, 0.75]),
      "v(c)": new Float64Array([12, 8, 5, 1]),
      "i(@q1[ib])": ib,
      "i(@q1[ic])": ic,
      "i(@q1[ie])": new Float64Array([0, -2.01e-3, -4.02e-3, -8.04e-3]),
      "i(@q1[is])": new Float64Array([0, 0, 0, 0]),
      "i(@r1[i])": new Float64Array([0, 1e-5, 2e-5, 4e-5]),
      "i(@d1[id])": new Float64Array([0, 1e-4, 2e-4, 3e-4]),
    },
    time,
  };
}

const CASES: Case[] = [
  { name: "the four BJT terminal currents stay four separate probes", run: (fail) => {
    const probes = dedupeProbes(makeResult().variables);
    const shown = probes.map((p) => p.display);
    for (const want of ["Ic(Q1)", "Ib(Q1)", "Ie(Q1)", "Is(Q1)"]) {
      if (!shown.includes(want)) fail(`the probe list offers ${shown.join(", ")} — no ${want}`);
    }
  } },

  { name: "a diode's @d1[id] stays I(D1) and does not become a terminal", run: (fail) => {
    const c = canonicalProbe("i(@d1[id])");
    if (c?.display !== "I(D1)") fail(`a diode current reads as ${c?.display ?? "nothing"}, not I(D1)`);
  } },

  { name: "the LTSpice spelling Ic(Q1) resolves to ngspice's vector", run: (fail) => {
    const result = makeResult();
    for (const [req, want] of [["Ic(Q1)", "i(@q1[ic])"], ["Ib(Q1)", "i(@q1[ib])"]]) {
      const got = matchResultVariable(result, [req]);
      if (got !== want) fail(`${req} resolved to ${got ?? "nothing"}, not ${want}`);
    }
  } },

  { name: "Ic(Q1) does not resolve to some other terminal's current", run: (fail) => {
    // The bug this guards: with one shared key, whichever vector came first won.
    const result = makeResult();
    if (matchResultVariable(result, ["Ic(Q1)"]) === "i(@q1[ib])") {
      fail("the collector current resolved to the base current");
    }
  } },

  { name: "right-clicking a transistor offers its terminal currents", run: (fail) => {
    const result = makeResult();
    const found = getCurrentProbeCandidates("Q1").filter((c) => matchResultVariable(result, [c]));
    if (!found.length) fail("the current menu on Q1 offers nothing the result contains");
  } },

  { name: "a terminal current carries amperes, not volts", run: (fail) => {
    // Wrong here and Ic(Q1) shares the volts axis, flattening it against the rails.
    if (inferUnit("Ic(Q1)") !== "A") fail(`Ic(Q1) inferred as "${inferUnit("Ic(Q1)")}", not A`);
    // A ratio of two currents is dimensionless — the current gain has no unit.
    if (inferUnit("Ic(Q1)/Ib(Q1)") !== "") fail("the current gain was given a unit");
  } },

  { name: "the current gain Ic(Q1)/Ib(Q1) evaluates as a trace", run: (fail) => {
    const r = evalExpression(makeResult(), "Ic(Q1)/Ib(Q1)", {});
    if (r.error) { fail(`the .plt trace of 04-3_Transistor2 fails: ${r.error}`); return; }
    const v = r.values![3];
    if (Math.abs(v - 200) > 1) fail(`B came out ${v}, not the fixture's 200`);
  } },

  { name: "a terminal current works in a schematic data-point too", run: (fail) => {
    const v = evalDataFlag("Ic(Q1)", makeResult());
    if (v === null) fail("a DATAFLAG showing Ic(Q1) stays empty");
  } },

  // ── the parametric x-axis behind the panel's "quantity" field ──────────────

  { name: "setting the x-axis quantity probes it, so the panel has a series", run: (fail) => {
    // Without this the panel would silently keep drawing against time: the
    // x-series is looked up among the plotted traces, and an unprobed quantity
    // is not among them.
    reset();
    plot().setPanelXQuantity("panel-0", "Ic(Q1)");
    if (plot().panels[0].xTrace !== "Ic(Q1)") fail(`xTrace is ${plot().panels[0].xTrace}, not Ic(Q1)`);
    const armed = [...sim().selectedVariables, ...sim().pendingProbes];
    if (!armed.includes("Ic(Q1)")) fail(`the quantity was not probed (armed: ${armed.join(", ") || "none"})`);
  } },

  { name: "the x-axis quantity is not added as a curve of its own", run: (fail) => {
    reset();
    plot().setPanelXQuantity("panel-0", "Ic(Q1)");
    if (plot().traceToPanel["Ic(Q1)"]) fail("the x-axis quantity was also assigned as a y-trace");
  } },

  { name: "an expression as x-axis quantity is registered as a function", run: (fail) => {
    reset();
    plot().setPanelXQuantity("panel-0", "Ic(Q1)/Ib(Q1)");
    if (!plot().expressions.includes("Ic(Q1)/Ib(Q1)")) {
      fail("a formula on the x-axis was not registered, so it can never be evaluated");
    }
  } },

  { name: "an empty quantity (or 'time') restores the time base", run: (fail) => {
    reset();
    plot().setPanelXQuantity("panel-0", "Ic(Q1)");
    plot().setPanelXQuantity("panel-0", "  ");
    if (plot().panels[0].xTrace !== undefined) fail("clearing the field left the panel parametric");
    plot().setPanelXQuantity("panel-0", "time");
    if (plot().panels[0].xTrace !== undefined) fail("'time' was taken as a parametric quantity");
  } },
];

export function runTerminalCurrentTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

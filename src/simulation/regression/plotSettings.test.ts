import { usePlotStore, type PlotPanel } from "../plotStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { buildPltDoc } from "../pltBuild.js";
import { serializePlt, parsePlt } from "../pltFormat.js";
import { applyPltText, decodePltBytes } from "../pltApply.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * Plot settings are saved as an LTSpice `.plt` file and loaded back through
 * `applyPltText`. Two things must hold:
 *
 *  1. Everything the user configured survives the round-trip — panel bounds and
 *     ticks, the logarithmic / decibel y-scale, trace colours, the active traces
 *     (which become the probed variables), functions toggled off, the parametric
 *     x-axis, synced x-axes and the light/dark diagram.
 *  2. The file stays loadable in LTSpice: the settings LTSpice has no field for
 *     ride in extra keys (Color/YScale/Hidden/SyncX/Light), and a plot with none
 *     of them must produce exactly the classic LTSpice structure.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void };

/** A circuit with no plot settings of its own — loading it must reset the diagram. */
const ASC_PLAIN = `Version 4
SHEET 1 880 680
SYMBOL res 0 0 R0
SYMATTR InstName R1
SYMATTR Value 1k
`;

const plot = () => usePlotStore.getState();
const sim = () => useSimulationStore.getState();

/** The plot configuration under test: one of every setting that can be lost. */
const PANELS: PlotPanel[] = [
  {
    id: "panel-0",
    xMin: 10, xMax: 1e5, xTicks: 10, logX: true,
    yMin: -40, yMax: 20, yTicks: 10,
    yScale: "db",                    // decibel — no LTSpice equivalent
    yLabel: "A [dB]",
    height: 240,
  },
  {
    id: "panel-1",
    xMin: 0, xMax: 0.01, xTicks: 0.001,
    yMin: 1, yMax: 1000, yTicks: 100,
    yScale: "log",                   // logarithmic — LTSpice's own Log flag
  },
  {
    id: "panel-2",
    xTrace: "I(RL)",                 // parametric x-axis
    xMin: 0, xMax: 0.02, xTicks: 0.005,
    yMin: 0, yMax: 12, yTicks: 2,
  },
];

const COLORS = { "V(out)": "#ff0000", "V(in)": "#00b0ff", "V(a)-V(b)": "#ffcc00" };

/** Put the store into that configuration, as the panel's controls would. */
function setUpPlot(): void {
  usePlotStore.setState({
    panels: PANELS.map((p) => ({ ...p })),
    traceToPanel: {
      "V(out)": "panel-0",
      "V(in)": "panel-1",
      "V(a)-V(b)": "panel-1",        // a function, toggled off below
      "V(kl)": "panel-2",
      "I(RL)": "panel-2",            // the parametric x-trace
    },
    colors: { ...COLORS },
    expressions: ["V(a)-V(b)"],
    hiddenExpressions: ["V(a)-V(b)"],
    syncX: true,
    svgLight: true,
  });
  useSimulationStore.setState({ result: null, selectedVariables: ["V(out)", "V(in)", "V(kl)", "I(RL)"] });
}

/** Save the current plot store as `.plt` text, as the Save button does. */
function savePlt(): string {
  const s = plot();
  const tracesOf = (panel: PlotPanel) =>
    Object.entries(s.traceToPanel)
      .filter(([t, id]) => id === panel.id && t !== panel.xTrace && !s.hiddenExpressions.includes(t))
      .map(([t]) => t);
  return serializePlt(
    buildPltDoc({
      analysis: "AC Analysis",
      panels: s.panels,
      colors: s.colors,
      syncX: s.syncX,
      svgLight: s.svgLight,
      tracesOf,
      hiddenOf: (panel) =>
        s.expressions.filter((e) => s.hiddenExpressions.includes(e) && s.traceToPanel[e] === panel.id),
      // The plot resolves these from the simulation result; the panel's own
      // bounds are what a saved file must carry, so use them directly here.
      yAxesOf: (panel) => [{ yMin: panel.yMin ?? -1, yMax: panel.yMax ?? 1, ticks: panel.yTicks }],
      xRangeOf: (panel) => ({ low: panel.xMin ?? 0, high: panel.xMax ?? 1, ticks: panel.xTicks }),
    }),
  );
}

/** Save, wipe the store, and load the file back — the full user round-trip. */
function roundTrip(fail: (r: string) => void): boolean {
  const plt = savePlt();
  usePlotStore.setState({
    panels: [{ id: "panel-0" }], traceToPanel: {}, colors: {},
    expressions: [], hiddenExpressions: [], syncX: false, svgLight: false,
  });
  useSimulationStore.setState({ selectedVariables: [] });
  if (!applyPltText(plt)) { fail(`the saved .plt did not parse back:\n${plt}`); return false; }
  return true;
}

const CASES: Case[] = [
  { name: "plt: panel axes (bounds, ticks, log-x, label, height) survive", run: (fail) => {
    setUpPlot();
    if (!roundTrip(fail)) return;
    const p = plot().panels;
    if (p.length !== 3) { fail(`${p.length} panels != 3`); return; }
    for (const [i, want] of PANELS.entries()) {
      const got = p[i];
      for (const k of ["xMin", "xMax", "xTicks", "yMin", "yMax", "yTicks", "logX", "yLabel", "height"] as const) {
        // logX round-trips as an explicit false where it was unset — same meaning.
        const norm = (v: unknown) => (k === "logX" ? !!v : v ?? undefined);
        if (norm(want[k]) !== norm(got[k])) fail(`panel ${i} ${k}: ${want[k]} → ${got[k]}`);
      }
    }
  } },

  { name: "plt: decibel and logarithmic y-scales survive", run: (fail) => {
    setUpPlot();
    if (!roundTrip(fail)) return;
    const [db, log, lin] = plot().panels;
    if (db.yScale !== "db") fail(`panel 0 yScale ${db.yScale} != db`);
    if (log.yScale !== "log") fail(`panel 1 yScale ${log.yScale} != log`);
    if ((lin.yScale ?? "linear") !== "linear") fail(`panel 2 yScale ${lin.yScale} != linear`);
  } },

  { name: "plt: trace colours survive", run: (fail) => {
    setUpPlot();
    if (!roundTrip(fail)) return;
    for (const [trace, want] of Object.entries(COLORS)) {
      const got = plot().colors[trace];
      if (got !== want) fail(`colour of ${trace}: ${want} → ${got ?? "(lost)"}`);
    }
  } },

  { name: "plt: active traces, their panels and the probed variables survive", run: (fail) => {
    setUpPlot();
    const wantProbes = ["V(out)", "V(in)", "V(kl)", "I(RL)"].sort();
    if (!roundTrip(fail)) return;
    for (const [trace, panel] of Object.entries({ "V(out)": "panel-0", "V(in)": "panel-1", "V(kl)": "panel-2" })) {
      if (plot().traceToPanel[trace] !== panel) fail(`${trace} on ${plot().traceToPanel[trace]} != ${panel}`);
    }
    // Loading must re-arm the probes, or the traces are gone on the next run.
    const probes = [...sim().selectedVariables].sort();
    if (probes.join(",") !== wantProbes.join(",")) fail(`probes ${probes} != ${wantProbes}`);
  } },

  { name: "plt: functions survive, including ones toggled off", run: (fail) => {
    setUpPlot();
    if (!roundTrip(fail)) return;
    if (!plot().expressions.includes("V(a)-V(b)")) fail("the function V(a)-V(b) was lost");
    if (!plot().hiddenExpressions.includes("V(a)-V(b)")) fail("V(a)-V(b) came back enabled, not toggled off");
    if (plot().colors["V(a)-V(b)"] !== "#ffcc00") fail("a hidden function lost its colour");
  } },

  { name: "plt: parametric x-axis, synced axes and the light diagram survive", run: (fail) => {
    setUpPlot();
    if (!roundTrip(fail)) return;
    if (plot().panels[2].xTrace !== "I(RL)") fail(`xTrace ${plot().panels[2].xTrace} != I(RL)`);
    if (!plot().syncX) fail("syncX was lost");
    if (!plot().svgLight) fail("the light diagram setting was lost");
  } },

  // ── LTSpice compatibility ──────────────────────────────────────────────────

  { name: "plt: a plot without extras writes a plain LTSpice file", run: (fail) => {
    usePlotStore.setState({
      panels: [{ id: "panel-0", xMin: 0, xMax: 1e-3, xTicks: 2e-4, yMin: -5, yMax: 5, yTicks: 1 }],
      traceToPanel: { "V(out)": "panel-0" },
      colors: {}, expressions: [], hiddenExpressions: [], syncX: false, svgLight: false,
    });
    const plt = savePlt();
    // No LibreSpice key may appear when nothing needs one — the file must look
    // exactly like the LTSpice output it always was.
    for (const key of ["Color:", "YScale:", "Hidden:", "SyncX:", "Light:", "YLabel:", "Height:"]) {
      if (plt.includes(key)) fail(`plain plot wrote a LibreSpice key (${key}):\n${plt}`);
    }
    for (const key of ["Npanes:", "traces:", "X:", "Y[0]:", "Log:", "GridStyle:"]) {
      if (!plt.includes(key)) fail(`LTSpice key ${key} missing:\n${plt}`);
    }
  } },

  // ── Loading a circuit resets the diagram ───────────────────────────────────

  { name: "load: a new circuit without a .plt resets the axes to linear/auto", run: (fail) => {
    setUpPlot();                       // dB axis, log axis, fixed bounds, colours…
    useSimulationStore.setState({ result: { time: new Float64Array([0, 1]) } as never });
    useCircuitStore.getState().loadFromAsc(ASC_PLAIN);

    const p = plot().panels;
    if (p.length !== 1) fail(`${p.length} panels != 1 (panels not reset)`);
    const only = p[0];
    for (const k of ["xMin", "xMax", "xTicks", "yMin", "yMax", "yTicks", "yScale", "yLabel", "height", "xTrace"] as const) {
      if (only[k] !== undefined) fail(`${k} survived the load as ${only[k]} — axes must be auto`);
    }
    if (only.logX) fail("logX survived — the x-axis must be linear");
    if (Object.keys(plot().colors).length) fail("colours of the previous circuit survived");
    if (plot().expressions.length || plot().hiddenExpressions.length) fail("functions of the previous circuit survived");
    if (Object.keys(plot().traceToPanel).length) fail("trace assignments of the previous circuit survived");
    if (plot().syncX) fail("syncX survived");
    // The old result and probes belong to the previous circuit's nets.
    if (sim().result !== null) fail("the previous circuit's simulation result survived");
    if (sim().selectedVariables.length) fail("the previous circuit's probes survived");
  } },

  { name: "new circuit: directives, analysis and diagram all start blank", run: (fail) => {
    setUpPlot();                       // dB axis, log axis, fixed bounds, colours…
    const circuit = useCircuitStore.getState();
    circuit.loadFromAsc(ASC_PLAIN);
    circuit.setSpiceDirectives(".tran 5m\n.step param R 1 10 1");
    circuit.setSimulationConfig({ type: "ac", sweep: "dec", points: 100, start: 1, stop: 1e6 } as never);
    useSimulationStore.setState({ result: { time: new Float64Array([0, 1]) } as never, selectedVariables: ["V(out)"] });

    useCircuitStore.getState().clearCircuit();

    const st = useCircuitStore.getState();
    // The old circuit's directives would otherwise still drive the next run — a
    // `.step`/`.meas` over parts that no longer exist.
    if (st.spiceDirectives !== "") fail(`directives survived: ${JSON.stringify(st.spiceDirectives)}`);
    if (st.simulationConfig.type !== "tran") fail(`analysis survived as ${st.simulationConfig.type}`);
    if (st.nodes.length || st.edges.length) fail("the schematic was not cleared");
    if (st.showDirectivesOnCanvas) fail("the on-canvas directive box survived");

    // …and the diagram is back on auto.
    const p = plot().panels;
    if (p.length !== 1) fail(`${p.length} panels != 1`);
    for (const k of ["xMin", "xMax", "yMin", "yMax", "yScale", "yLabel"] as const) {
      if (p[0][k] !== undefined) fail(`${k} survived as ${p[0][k]}`);
    }
    if (Object.keys(plot().colors).length || plot().expressions.length) fail("colours/functions survived");
    if (sim().result !== null || sim().selectedVariables.length) fail("the old result/probes survived");
  } },

  { name: "load: a sibling .plt still wins over the reset", run: (fail) => {
    setUpPlot();
    const plt = savePlt();
    // The toolbar loads the .asc first, then applies <name>.plt on top.
    useCircuitStore.getState().loadFromAsc(ASC_PLAIN);
    if (!applyPltText(plt)) { fail("the .plt did not apply after the load"); return; }
    if (plot().panels[0].yScale !== "db") fail("the .plt settings were not applied after the reset");
    if (plot().colors["V(out)"] !== "#ff0000") fail("the .plt colours were not applied");
  } },

  { name: "plt: an LTSpice-written file still loads (incl. its log y-axis)", run: (fail) => {
    // Written by LTSpice: no LibreSpice keys at all, y-axis logarithmic via the
    // standard Log flags.
    const LTSPICE_PLT = `[AC Analysis]
{
   Npanes: 1
   {
      traces: 2 {524290,0,"V(out)"} {524291,0,"V(in)"}
      X: ('K',0,10,10,100000)
      Y[0]: (' ',0,1,10,1000)
      Log: 1 1 0
      GridStyle: 1
   }
}
`;
    usePlotStore.setState({ panels: [{ id: "panel-0" }], traceToPanel: {}, colors: {}, expressions: [], hiddenExpressions: [], syncX: false, svgLight: false });
    useSimulationStore.setState({ result: null, selectedVariables: [] });
    if (!applyPltText(LTSPICE_PLT)) { fail("an LTSpice .plt failed to parse"); return; }
    const p = plot().panels[0];
    if (!p.logX) fail("log x flag lost");
    if (p.yScale !== "log") fail(`log y flag → yScale ${p.yScale} != log`);
    if (p.xMin !== 10 || p.xMax !== 100000) fail(`x bounds ${p.xMin}..${p.xMax} != 10..100000`);
    if (plot().traceToPanel["V(in)"] !== "panel-0") fail("traces not assigned");
    if (parsePlt(LTSPICE_PLT)?.panes[0].traces.length !== 2) fail("traces not parsed");
  } },

  { name: "a UTF-16 .plt (what LTSpice actually writes) decodes", run: (fail) => {
    // LTSpice writes UTF-16LE with no BOM. Read as UTF-8 the text comes back
    // NUL-interleaved and every LTSpice-authored .plt was rejected as invalid —
    // only the app's own UTF-8 output ever loaded.
    const text = `[Transient Analysis]\n{\n   Npanes: 1\n   {\n      traces: 1 {524290,0,"Ic(Q1)/Ib(Q1)"}\n      Parametric: "Ic(Q1)"\n      X: ('m',0,-0.01,0.01,0.1)\n      Y[0]: (' ',0,-20,20,220)\n   }\n}\n`;
    const utf16 = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      utf16[i * 2] = text.charCodeAt(i) & 0xff;
      utf16[i * 2 + 1] = text.charCodeAt(i) >> 8;
    }
    const decoded = decodePltBytes(utf16.buffer);
    if (!decoded.includes("Parametric")) { fail("a UTF-16LE .plt did not decode to readable text"); return; }
    if (parsePlt(decoded)?.panes[0].parametric !== "Ic(Q1)") {
      fail("the decoded .plt lost its parametric x-axis");
    }
    // A plain UTF-8 file must still decode unchanged.
    const utf8 = new TextEncoder().encode(text);
    if (decodePltBytes(utf8.buffer) !== text) fail("a UTF-8 .plt was mangled by the UTF-16 sniffing");
  } },
];

export function runPlotSettingsTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

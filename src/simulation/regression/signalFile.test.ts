import { decodeWav, encodeWav } from "@core/audio/wav.js";
import {
  decodeSignalFile, parseWaveDirective, pwlWindow, resampleUniform, scanFileSources, valueAt,
} from "@core/audio/signalFile.js";
import { VoltageSource } from "@core/components/sources/Sources.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import { useSourceFileStore } from "@store/sourceFileStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { withSymbols } from "@editor/regression/withSymbols.js";
import { surveySheet } from "@editor/regression/sheetSurvey.js";
import { runSimulation } from "../simulationEngine.js";
import { chunkBlocker, parseTran, resolveFileSources } from "../fileSources.js";
import { splitWaveDirectives } from "../waveOutput.js";
import type { TestReport } from "@editor/regression/svgExport.test.js";

/**
 * File-driven sources (`wavefile=`, `PWL file=`) and the `.wave` output.
 *
 * The decisive case is the last one: LTSpice's own example, an RC low-pass fed
 * with a song, simulated window by window and compared with the WAV file LTSpice
 * itself wrote for that circuit. The windowing is what makes a song feasible
 * at all (a single PWL run grows with the square of its length), so it has to
 * be shown to give LTSpice's answer and not merely *an* answer.
 */

type Case = { name: string; run: (fail: (r: string) => void) => void | Promise<void> };

async function node() {
  const load = (m: string) => import(/* @vite-ignore */ m);
  const [fs, path] = await Promise.all([load("node:fs"), load("node:path")]);
  const root = (globalThis as any).process.cwd();
  return {
    read: (rel: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(root, rel))),
    text: (rel: string): string => fs.readFileSync(path.join(root, rel), "latin1"),
  };
}

const CASES: Case[] = [
  {
    name: "WAV round-trips at 8, 16, 24 and 32 bit",
    run: (fail) => {
      const src = Float32Array.from([0, 0.5, -0.5, 0.25, -1, 0.999]);
      for (const bits of [8, 16, 24, 32]) {
        const back = decodeWav(encodeWav(src, 8000, bits));
        if (back.sampleRate !== 8000 || back.bitsPerSample !== bits) fail(`${bits} bit: header ${back.sampleRate}/${back.bitsPerSample}`);
        const tol = 2 / 2 ** bits;
        src.forEach((v, i) => { if (Math.abs(back.samples[i] - v) > tol) fail(`${bits} bit sample ${i}: ${back.samples[i]} ≠ ${v}`); });
      }
    },
  },
  {
    name: "WAV writing clips at ±1 V",
    run: (fail) => {
      const back = decodeWav(encodeWav([2, -3], 8000, 16));
      if (Math.abs(back.samples[0] - 32767 / 32768) > 1e-6 || back.samples[1] !== -1) fail(`${back.samples[0]}, ${back.samples[1]}`);
    },
  },
  {
    name: "stereo and non-PCM files are refused",
    run: (fail) => {
      const stereo = encodeWav([0, 0], 8000, 16);
      new DataView(stereo.buffer).setUint16(22, 2, true);
      try { decodeWav(stereo); fail("stereo accepted"); } catch (e) { if (!/Mono/.test(String(e))) fail(String(e)); }
      const float = encodeWav([0, 0], 8000, 32);
      new DataView(float.buffer).setUint16(20, 3, true);
      try { decodeWav(float); fail("float accepted"); } catch (e) { if (!/PCM/.test(String(e))) fail(String(e)); }
    },
  },
  {
    name: "LTSpice's example WAV decodes as 44.1 kHz mono",
    run: async (fail) => {
      const s = decodeSignalFile("Lied1mono.wav", (await node()).read("examples/Lied1mono.wav"));
      if (s.sampleRate !== 44100 || s.times.length !== 838656) fail(`${s.sampleRate} Hz, ${s.times.length} samples`);
    },
  },
  {
    name: "a text file becomes a signal",
    run: (fail) => {
      const s = decodeSignalFile("m.txt", new TextEncoder().encode("0 0\n1m 2\n2m 0\n"));
      if (valueAt(s, 0.5e-3) !== 1) fail(`v(0.5m) = ${valueAt(s, 0.5e-3)}`);
      if (valueAt(s, 1) !== 0) fail("holds last value");
    },
  },
  {
    name: "a PWL window is shifted to 0 and interpolated at both ends",
    run: (fail) => {
      const s = decodeSignalFile("m.txt", new TextEncoder().encode("0 0\n1 10\n2 0\n"));
      const w = pwlWindow(s, 0.5, 1.5);
      if (w.text !== "0 5 0.5 10 1 5") fail(w.text);
    },
  },
  {
    name: "wavefile= imports as a File source and saves back unchanged",
    run: async (fail) => {
      const parsed = LTSpiceParser.parse((await node()).text("examples/Lied1mono_TP1.asc"));
      const v = parsed.components.find((c) => c.label === "V1") as VoltageSource | undefined;
      if (!v) { fail("V1 missing"); return; }
      if (v.sourceType !== "File" || v.filePath !== "Lied1mono.wav") fail(`${v.sourceType} ${v.filePath}`);
      const line = v.getNetlistLine();
      if (!/wavefile=Lied1mono\.wav$/.test(line)) fail(line);
    },
  },
  {
    name: "a text file source is written as PWL file=",
    run: (fail) => {
      const v = new VoltageSource("v", "V1");
      v.setProperty("sourceType", "File");
      v.setProperty("filePath", "meine messung.txt");
      if (!v.getNetlistLine().endsWith('PWL file="meine messung.txt"')) fail(v.getNetlistLine());
      const found = scanFileSources([v.getNetlistLine()]);
      if (found[0]?.file !== "meine messung.txt") fail(JSON.stringify(found));
    },
  },
  {
    name: ".wave is parsed with SI sample rate",
    run: (fail) => {
      const w = parseWaveDirective(".wave Lied1mono_TP1.wav 16 44.1k V(UA)");
      if ("error" in w) { fail(w.error); return; }
      if (w.file !== "Lied1mono_TP1.wav" || w.bits !== 16 || w.sampleRate !== 44100 || w.exprs[0] !== "V(UA)") fail(JSON.stringify(w));
      const { netlist, waves } = splitWaveDirectives("V1 a 0 1\n.wave x.wav 16 8k V(a)\n.end");
      if (waves.length !== 1 || /wave/.test(netlist)) fail(netlist);
      if (!("error" in parseWaveDirective(".wave x.wav 12 8k V(a)"))) fail("12 bit accepted");
    },
  },
  {
    name: "resampling hits the grid exactly",
    run: (fail) => {
      const out = resampleUniform([0, 1], [0, 1], 4);
      if (out.length !== 5 || Math.abs(out[2] - 0.5) > 1e-6) fail(Array.from(out).join(","));
    },
  },
  {
    name: "a missing file and a second waveform source are reported",
    run: (fail) => {
      try { resolveFileSources(["V1 a 0 wavefile=nope.wav"], () => null); fail("no error"); }
      catch (e) { if (!/nope\.wav/.test(String(e))) fail(String(e)); }
      const lines = ["V1 a 0 wavefile=x.wav", "V2 b 0 SIN(0 1 50)", ".tran 1"];
      const msg = chunkBlocker(lines, [{ index: 0, head: "V1 a 0", ref: "V1", nodes: ["a", "0"] as [string, string], file: "x.wav", signal: { times: new Float64Array(1), values: new Float64Array(1) } }]);
      if (!msg || !/V2/.test(msg)) fail(String(msg));
      if (parseTran([".tran 0.1m 19.017"])?.tstop !== 19.017) fail("tran");
    },
  },
  {
    name: "LTSpice example: windowed run matches LTSpice's own .wave output",
    run: async (fail) => {
      const io = await node();
      useSourceFileStore.getState().addInput("Lied1mono.wav", io.read("examples/Lied1mono.wav"));
      // One second is long enough to need windows (44 100 samples) and short
      // enough for a test suite.
      const asc = io.text("examples/Lied1mono_TP1.asc").replace("!.tran 19.017s", "!.tran 1");
      await withSymbols(async () => {
        const survey = await surveySheet(asc);
        useSimulationStore.getState().setStatus("running");
        await runSimulation(survey.netlist);
      });
      const log = useSimulationStore.getState().log;
      if (!/abschnittsweise/.test(log)) fail("not windowed");
      const out = useSourceFileStore.getState().outputs["lied1mono_tp1.wav"];
      if (!out) { fail(`no output; log:\n${log.slice(0, 600)}`); return; }
      const mine = decodeWav(out.bytes).samples;
      const theirs = decodeWav(io.read("examples/Lied1mono_TP1.wav")).samples;
      const n = Math.min(mine.length, 44100);
      if (mine.length < 44000) fail(`only ${mine.length} samples`);
      let err = 0, sig = 0;
      for (let i = 0; i < n; i++) { err += (mine[i] - theirs[i]) ** 2; sig += theirs[i] ** 2; }
      const rel = Math.sqrt(err / sig);
      // 16-bit quantisation and LTSpice's own solver differ slightly; a wrong
      // filter or a lost state at a window boundary is tens of percent.
      if (!(rel < 0.02)) fail(`relative RMS deviation ${(rel * 100).toFixed(2)} %`);
    },
  },
];

export async function runSignalFileTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  for (const c of CASES) {
    try {
      await c.run((reason) => failures.push({ name: c.name, reason }));
    } catch (e) {
      failures.push({ name: c.name, reason: `threw: ${e instanceof Error ? e.stack ?? e.message : String(e)}` });
    }
  }
  return { passed: CASES.length - new Set(failures.map((f) => f.name)).size, total: CASES.length, failures };
}

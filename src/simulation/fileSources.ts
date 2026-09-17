import type { SimulationResult } from "@store/simulationStore.js";
import { parseSpiceNumber } from "@core/circuit/NetlistGenerator.js";
import {
  pointsUpTo, pwlWindow, pwlWindowArgs, scanFileSources, upperIndex, valueAt,
  type FileSourceLine, type Signal,
} from "@core/audio/signalFile.js";

/**
 * Running a circuit whose source is a file.
 *
 * ngspice has no filesystem here, so a file source is handed over as a PWL
 * breakpoint list. That is fine for a measurement of a few hundred points and
 * hopeless for a song: ngspice's PWL source searches its breakpoint list from
 * the start on *every* time step, so the run time grows with the square of the
 * length. Measured with the bundled engine at 44.1 kHz: 1 s of audio took 12 s,
 * 5 s took 277 s, and the 19 s example would take hours.
 *
 * A long file is therefore simulated in short windows, one after another, each
 * with a short breakpoint list. What carries the circuit across a window
 * boundary is its state: every node voltage (`.ic`) and every inductor current
 * (`ic=` on the inductor), applied with `uic` so ngspice starts from exactly
 * there instead of solving a fresh operating point. Measured against a single
 * run on an RLC circuit, the two agree to 0.02 %; the song then takes about
 * two seconds per second of audio.
 *
 * The limits of that are stated rather than hidden: other time-dependent
 * sources would restart at t = 0 in every window, and a `.step` would multiply
 * an already long run, so both are refused with a message for a long file.
 *
 * **Why the windows use a behavioural source.** Every breakpoint of a `PWL`
 * source is a point ngspice must step onto, and it takes about five time steps
 * per breakpoint — five per audio sample, all of them solved and stored. The
 * `pwl()` function of a `B` source interpolates the same data without asking
 * for a breakpoint, which leaves the step size to us (see STEPS_PER_SAMPLE);
 * `Tmax` has to be set from it, or the run would step straight over the audio.
 * Measured on the RC example: 2.2 s → 1.5 s per second of audio. The source
 * keeps its name and its terminals: the
 * `B` drives an internal node and the original `V` stays in series as a 0 V
 * sense source, so `I(V1)` remains probeable and the schematic still matches.
 */

/** Up to this many breakpoints a file is simply written into the netlist. */
export const INLINE_POINT_LIMIT = 20_000;
/**
 * Breakpoints per window. Fewer windows are cheaper (each one re-reads the
 * netlist and restarts the solver), more windows keep `pwl()`'s own lookup
 * short; 2000 measured best at 44.1 kHz.
 */
export const CHUNK_POINTS = 2_000;
/**
 * Time steps ngspice takes per sample of the file.
 *
 * Without breakpoints the step size is ours to choose, and it buys accuracy by
 * the step. Measured against the WAV file LTSpice wrote for the RC example, per
 * second of audio: one step 0.17 % in 1.1 s, two steps 0.050 % in 1.5 s, four
 * steps 0.017 % in 2.2 s. Two is the middle: the error sits some 66 dB down —
 * inaudible, and well under what the circuit's own tolerances do — while a long
 * clip still runs in a time someone will wait out.
 */
const STEPS_PER_SAMPLE = 2;
/** Upper bound on the merged result's length, to keep the plot and memory sane. */
const MAX_GRID_POINTS = 4_000_000;

export interface TranSpec {
  index: number;
  tstep: number;
  tstop: number;
  tstart: number;
  tmax?: number;
  uic: boolean;
}

/** The `.tran` line of a netlist, or null when there is none or it uses `{params}`. */
export function parseTran(lines: string[]): TranSpec | null {
  const index = lines.findIndex((l) => /^\s*\.tran\b/i.test(l));
  if (index < 0) return null;
  const tokens = lines[index].trim().split(/\s+/).slice(1);
  const uic = tokens.some((t) => /^uic$/i.test(t));
  const nums = tokens.filter((t) => !/^uic$/i.test(t)).map((t) => parseSpiceNumber(t));
  if (nums.length < 2 || nums.some((n) => n === undefined)) return null;
  const [tstep, tstop, tstart = 0, tmax] = nums as number[];
  if (!(tstop > 0)) return null;
  return { index, tstep, tstop, tstart, tmax, uic };
}

export interface ResolvedSource extends FileSourceLine {
  signal: Signal;
}

/**
 * Find the file sources in a netlist and look up their data. Throws with a
 * message the user can act on when a file has not been loaded.
 */
export function resolveFileSources(lines: string[], signalFor: (file: string) => Signal | null): ResolvedSource[] {
  return scanFileSources(lines).map((src) => {
    if (!src.file) throw new Error(`${src.ref}: keine Datei angegeben`);
    const signal = signalFor(src.file);
    if (!signal) {
      throw new Error(`${src.ref}: Datei "${src.file}" ist nicht geladen — bitte in den Eigenschaften der Quelle "Datei laden…" wählen`);
    }
    return { ...src, signal };
  });
}

/** Whether a long file has to be simulated in windows. */
export function needsChunks(sources: ResolvedSource[], tran: TranSpec | null): boolean {
  if (!tran) return false;
  const total = sources.reduce((n, s) => n + pointsUpTo(s.signal, tran.tstop), 0);
  return total > INLINE_POINT_LIMIT;
}

/**
 * Write every file source into the netlist as a plain PWL (or, without a
 * transient analysis, as its value at t = 0).
 */
export function inlineFileSources(lines: string[], sources: ResolvedSource[], tran: TranSpec | null): string[] {
  const out = [...lines];
  for (const s of sources) {
    if (!tran) {
      out[s.index] = `${s.head} DC ${valueAt(s.signal, 0)}`;
      continue;
    }
    const n = s.signal.times.length;
    const end = Math.max(tran.tstop, 0);
    const last = n ? s.signal.times[n - 1] : 0;
    // A file shorter than the run holds its last value, as a PWL does anyway.
    out[s.index] = `${s.head} PWL(${pwlWindow(s.signal, 0, Math.min(end, last) || end).text})`;
  }
  return out;
}

/** Why a long file cannot be windowed, or null when it can. */
export function chunkBlocker(lines: string[], sources: ResolvedSource[]): string | null {
  const fileLines = new Set(sources.map((s) => s.index));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\.step\b/i.test(l)) return ".step ist mit einer langen Datei-Quelle nicht möglich";
    if (fileLines.has(i) || /^\s*[.*+]/.test(l)) continue;
    if (/\b(sin|pulse|pwl|exp|sffm|am)\s*\(/i.test(l) || (/^\s*B/i.test(l) && /\btime\b/i.test(l))) {
      return `weitere zeitabhängige Quelle "${l.trim().split(/\s+/)[0]}" — bei einer langen Datei-Quelle ` +
        "wird abschnittsweise simuliert, und dabei würde diese Quelle in jedem Abschnitt neu starten";
    }
  }
  return null;
}

/** One simulator run as the chunk runner needs it. */
export interface ChunkRun {
  result: SimulationResult;
  /** Every vector ngspice returned, internal ones included (for the state). */
  raw: { name: string; values: ArrayLike<number> }[];
  log: string;
}

export interface ChunkDeps {
  runOnce: (netlist: string) => Promise<ChunkRun>;
  /** Report progress; resolve false to stop (the partial result is kept). */
  progress: (done: number, total: number) => Promise<boolean>;
}

/** The circuit state at the end of a window. */
interface CircuitState {
  nodes: [string, number][];
  inductors: Map<string, number>;
}

function stateOf(raw: ChunkRun["raw"]): CircuitState {
  const nodes: [string, number][] = [];
  const inductors = new Map<string, number>();
  for (const v of raw) {
    const last = v.values[v.values.length - 1];
    if (!Number.isFinite(last)) continue;
    const node = /^v\((.+)\)$/i.exec(v.name);
    // `#` marks a device-internal node, which `.ic` cannot address.
    if (node && !node[1].includes("#") && !node[1].includes(",")) nodes.push([node[1], last]);
    const cur = /^i\((l[^@.)]*)\)$/i.exec(v.name) ?? /^(l[^#.]*)#branch$/i.exec(v.name);
    if (cur) inductors.set(cur[1].toLowerCase(), last);
  }
  return { nodes, inductors };
}

/** The node and device the behavioural source adds for one file source. */
function innerName(ref: string): string {
  return `${ref}_wav`;
}

/**
 * Whether a result vector belongs to the internal source rather than the
 * circuit. `V(v1_wav)` and `I(Bv1_wav)` are ours, and the probe list should no
 * more offer them than it offers a solver variable.
 */
function isInternalVector(name: string, sources: ResolvedSource[]): boolean {
  const n = name.toLowerCase();
  return sources.some((s) => n.includes(innerName(s.ref).toLowerCase()));
}

/** The netlist for one window. `dt` is the sample period the grid is built on. */
export function chunkNetlist(
  lines: string[], sources: ResolvedSource[], tran: TranSpec,
  t0: number, t1: number, state: CircuitState | null, dt: number,
): { netlist: string; points: number } {
  const out = [...lines];
  let points = 0;
  for (const s of sources) {
    const w = pwlWindowArgs(s.signal, t0, t1);
    points += w.count;
    // The `B` carries the waveform between an internal node and the source's
    // own negative terminal; the original source stays in series at 0 V.
    const inner = innerName(s.ref);
    out[s.index] = `B${s.ref}_wav ${inner} ${s.nodes[1]} V=pwl(time,${w.text})
${s.ref} ${s.nodes[0]} ${inner} 0`;
  }
  const f = (v: number) => Number(v.toPrecision(12)).toString();
  const dur = t1 - t0;
  // Without breakpoints nothing else keeps the run on the samples.
  const tmax = Math.min(tran.tmax || dt, dt / STEPS_PER_SAMPLE, dur);
  out[tran.index] = `.tran ${f(Math.min(tran.tstep, dur))} ${f(dur)} 0 ${f(tmax)}${state || tran.uic ? " uic" : ""}`;

  if (state) {
    let inSubckt = false;
    for (let i = 0; i < out.length; i++) {
      const l = out[i];
      if (/^\s*\.subckt\b/i.test(l)) inSubckt = true;
      if (/^\s*\.ends\b/i.test(l)) inSubckt = false;
      // The previous window's state replaces the user's initial conditions.
      if (/^\s*\.ic\b/i.test(l)) { out[i] = "*"; continue; }
      if (/^\s*C/i.test(l)) out[i] = l.replace(/\s+ic\s*=\s*\S+/gi, "");
      // Only top-level inductors: the state names `l1`, and an `L1` inside a
      // subcircuit is a different part.
      if (/^\s*L/i.test(l) && !inSubckt) {
        const name = l.trim().split(/\s+/)[0].toLowerCase();
        const cur = state.inductors.get(name);
        const bare = l.replace(/\s+ic\s*=\s*\S+/gi, "");
        out[i] = cur === undefined ? bare : `${bare} ic=${f(cur)}`;
      }
    }
    const ics: string[] = [];
    for (let i = 0; i < state.nodes.length; i += 20) {
      ics.push(".ic " + state.nodes.slice(i, i + 20).map(([n, v]) => `V(${n})=${f(v)}`).join(" "));
    }
    const end = out.findIndex((l) => /^\s*\.end\s*$/i.test(l));
    out.splice(end < 0 ? out.length : end, 0, ...ics);
  }
  return { netlist: out.join("\n"), points };
}

/** Shorten the breakpoint lists of a netlist for the log. */
export function abbreviatePwl(netlist: string): string {
  return netlist.replace(/PWL\(([^)]{200,})\)/gi, (_, body: string) => {
    const n = Math.round(body.trim().split(/\s+/).length / 2);
    return `PWL(${body.slice(0, 60).trim()} … ${n} Stützstellen)`;
  });
}

/**
 * Simulate a long file source window by window and join the windows into one
 * result on an even time grid.
 */
export async function runChunked(
  lines: string[], sources: ResolvedSource[], tran: TranSpec, deps: ChunkDeps,
): Promise<{ result: SimulationResult; log: string }> {
  const total = sources.reduce((n, s) => n + pointsUpTo(s.signal, tran.tstop), 0);
  const chunks = Math.max(1, Math.ceil(total / CHUNK_POINTS));
  const dur = tran.tstop / chunks;

  // The grid: the finest sample spacing among the files, so a WAV comes back
  // sample for sample.
  let dt = Infinity;
  for (const s of sources) {
    const n = pointsUpTo(s.signal, tran.tstop);
    dt = Math.min(dt, s.signal.sampleRate ? 1 / s.signal.sampleRate : tran.tstop / Math.max(1, n));
  }
  dt = Math.max(dt, tran.tstop / MAX_GRID_POINTS);
  const gridLen = Math.floor(tran.tstop / dt + 1e-9) + 1;
  const time = new Float64Array(gridLen);
  for (let i = 0; i < gridLen; i++) time[i] = i * dt;

  const data: Record<string, Float64Array> = {};
  let variables: string[] = [];
  let state: CircuitState | null = null;
  let filled = 0;
  let firstNetlist = "";
  let lastLog = "";
  const started = Date.now();

  for (let k = 0; k < chunks; k++) {
    if (k > 0 && !(await deps.progress(k, chunks))) break;
    const t0 = k * dur;
    const t1 = k === chunks - 1 ? tran.tstop : (k + 1) * dur;
    const { netlist } = chunkNetlist(lines, sources, tran, t0, t1, state, dt);
    if (k === 0) firstNetlist = netlist;
    let run: ChunkRun;
    try {
      run = await deps.runOnce(netlist);
    } catch (e) {
      throw new Error(`Abschnitt ${k + 1}/${chunks} (${t0.toFixed(3)} s): ${e instanceof Error ? e.message : String(e)}`);
    }
    lastLog = run.log;
    state = stateOf(run.raw);

    const r = run.result;
    const rt = r.time;
    if (!rt || rt.length === 0) throw new Error(`Abschnitt ${k + 1}/${chunks} lieferte keine Daten`);
    if (k === 0) {
      variables = r.variables.filter((v) => v !== "time" && !isInternalVector(v, sources));
      for (const v of variables) data[v] = new Float64Array(gridLen).fill(NaN);
    }
    const from = k === 0 ? 0 : Math.ceil(t0 / dt - 1e-9);
    const to = Math.min(gridLen - 1, Math.floor(t1 / dt + 1e-9));
    for (const v of variables) {
      const src = r.data[v];
      const dst = data[v];
      if (!src) continue;
      let j = 0;
      for (let i = from; i <= to; i++) {
        const t = i * dt - t0;
        while (j < rt.length - 2 && rt[j + 1] <= t) j++;
        const ta = rt[j], tb = rt[Math.min(j + 1, rt.length - 1)];
        const a = src[j], b = src[Math.min(j + 1, rt.length - 1)];
        dst[i] = tb > ta ? a + (b - a) * Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : a;
      }
    }
    filled = to + 1;
  }
  await deps.progress(chunks, chunks);

  // Keep what was computed (all of it, or up to a Stop), from Tstart on.
  const first = Math.min(filled, upperIndex(time, tran.tstart - dt / 2));
  const cut = (a: Float64Array) => a.slice(first, filled);
  const out: SimulationResult = { variables: ["time", ...variables], data: { time: cut(time) }, time: undefined };
  for (const v of variables) out.data[v] = cut(data[v]);
  out.time = out.data.time;

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const log =
    `===== Datei-Quelle, abschnittsweise simuliert =====\n` +
    `${chunks} Abschnitte à ${(dur * 1000).toPrecision(3)} ms, Rechenzeit ${secs} s` +
    `${filled < gridLen ? ` — abgebrochen bei ${(filled * dt).toFixed(3)} s` : ""}\n` +
    `Ergebnis auf festem Raster (${(1 / dt).toPrecision(4)} Hz). Zustand zwischen den Abschnitten: ` +
    `Knotenspannungen (.ic) und Spulenströme (ic=), mit uic.\n` +
    `Die Datei speist eine Verhaltensquelle (B … V=pwl(time,…)); die Quelle selbst bleibt als ` +
    `0-V-Messquelle in Reihe, damit ihr Strom messbar bleibt.\n\n` +
    `===== Netlist (1. Abschnitt) =====\n${abbreviatePwl(firstNetlist).trim()}\n\n${lastLog}`;
  return { result: out, log };
}

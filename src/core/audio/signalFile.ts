import { decodeWav } from "./wav.js";
import { parsePwlNumbers } from "../components/sources/pwlFile.js";
import { parseSpiceNumber } from "../circuit/NetlistGenerator.js";

/**
 * A source driven by a file, and a `.wave` directive writing one — LTSpice's
 * two ways of getting sampled data into and out of a simulation.
 *
 *   V1 in 0 wavefile=Lied1mono.wav        a WAV file, ±1 full scale = ±1 V
 *   V1 in 0 PWL file=messung.txt          `time value` pairs as text
 *   .wave Lied1mono_TP1.wav 16 44.1k V(UA)
 *
 * The netlist names the file and nothing more. A song is close to a million
 * samples; written into the netlist as breakpoints it would bloat every share
 * link and freeze the netlist panel. The data lives next to the circuit instead
 * (see store/sourceFileStore) and is expanded only for the simulator.
 */

/** A sampled signal: `count` breakpoints, linearly interpolated in between. */
export interface Signal {
  times: Float64Array;
  values: Float64Array;
  /** Set for a WAV file, whose samples are evenly spaced. */
  sampleRate?: number;
  bitsPerSample?: number;
}

/**
 * The name a file is stored under. LTSpice writes whatever path the author
 * picked (`C:\Users\…\Lied.wav`); only the file name travels with a schematic,
 * so that is the key, compared without regard to case as Windows does.
 */
export function signalFileKey(path: string): string {
  return signalFileName(path).toLowerCase();
}

/** The bare file name of a path as LTSpice writes it (quotes and folders removed). */
export function signalFileName(path: string): string {
  return path.trim().replace(/^"(.*)"$/, "$1").split(/[\\/]/).pop() ?? "";
}

export function isWavName(path: string): boolean {
  return /\.wav$/i.test(signalFileName(path));
}

/** Read a source file: a WAV by its extension, anything else as PWL text. */
export function decodeSignalFile(name: string, bytes: Uint8Array): Signal {
  if (isWavName(name)) {
    const wav = decodeWav(bytes);
    const n = wav.samples.length;
    if (n === 0) throw new Error("WAV-Datei enthält keine Samples");
    const times = new Float64Array(n);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      times[i] = i / wav.sampleRate;
      values[i] = wav.samples[i];
    }
    return { times, values, sampleRate: wav.sampleRate, bitsPerSample: wav.bitsPerSample };
  }
  return parsePwlNumbers(new TextDecoder().decode(bytes));
}

/** One line of description for the properties panel. */
export function describeSignal(s: Signal): string {
  const n = s.times.length;
  const dur = n ? s.times[n - 1] : 0;
  const d = dur >= 1 ? `${dur.toFixed(2).replace(".", ",")} s` : `${(dur * 1000).toPrecision(3).replace(".", ",")} ms`;
  if (s.sampleRate) {
    const rate = `${(s.sampleRate / 1000).toString().replace(".", ",")} kHz`;
    return `${rate} · ${s.bitsPerSample} Bit · ${d}`;
  }
  return `${n} Stützstellen · ${d}`;
}

/** The value at time `t`, holding the first/last value outside the data. */
export function valueAt(s: Signal, t: number): number {
  const { times, values } = s;
  const n = times.length;
  if (n === 0) return 0;
  if (t <= times[0]) return values[0];
  if (t >= times[n - 1]) return values[n - 1];
  const i = upperIndex(times, t);
  const t0 = times[i - 1], t1 = times[i];
  return t1 === t0 ? values[i] : values[i - 1] + (values[i] - values[i - 1]) * (t - t0) / (t1 - t0);
}

/** First index whose time is strictly greater than `t` (binary search). */
export function upperIndex(times: ArrayLike<number>, t: number): number {
  let lo = 0, hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Number formatting for breakpoints: short, but exact enough for 192 kHz. */
function num(v: number): string {
  if (v === 0) return "0";
  return Number(v.toPrecision(10)).toString();
}

/**
 * The signal between `t0` and `t1` as PWL breakpoint text, shifted so that `t0`
 * becomes time 0. Both ends are interpolated, so a window cut between two
 * samples still starts and ends on the true waveform.
 */
export function pwlWindow(s: Signal, t0: number, t1: number): { text: string; count: number } {
  const parts = [`0 ${num(valueAt(s, t0))}`];
  let count = 1;
  const eps = 1e-12 * Math.max(1, t1);
  for (let i = upperIndex(s.times, t0 + eps); i < s.times.length && s.times[i] < t1 - eps; i++) {
    parts.push(`${num(s.times[i] - t0)} ${num(s.values[i])}`);
    count++;
  }
  if (t1 > t0) {
    parts.push(`${num(t1 - t0)} ${num(valueAt(s, t1))}`);
    count++;
  }
  return { text: parts.join(" "), count };
}

/** As {@link pwlWindow}, with commas — ngspice's `pwl()` function wants them. */
export function pwlWindowArgs(s: Signal, t0: number, t1: number): { text: string; count: number } {
  const w = pwlWindow(s, t0, t1);
  return { text: w.text.replace(/ /g, ","), count: w.count };
}

/** Breakpoints that fall inside `[0, tstop]` — what a run of that length needs. */
export function pointsUpTo(s: Signal, tstop: number): number {
  return Math.min(s.times.length, upperIndex(s.times, tstop) + 1);
}

// ---------------------------------------------------------------------------
// Netlist lines

/** A source line whose waveform is a file. */
export interface FileSourceLine {
  /** Index of the line in the netlist. */
  index: number;
  /** `V1 in 0` — reference and nodes, everything before the file spec. */
  head: string;
  ref: string;
  /** The two node names, in the order the line gives them. */
  nodes: [string, string];
  file: string;
}

const FILE_SOURCE_RE = /^\s*([VI]\S*\s+\S+\s+\S+)\s+(?:wavefile\s*=\s*("[^"]*"|\S+)|PWL\s+file\s*=\s*("[^"]*"|\S+)).*$/i;

export function scanFileSources(lines: string[]): FileSourceLine[] {
  const out: FileSourceLine[] = [];
  lines.forEach((line, index) => {
    const m = FILE_SOURCE_RE.exec(line);
    if (!m) return;
    const [ref, n1, n2] = m[1].split(/\s+/);
    out.push({ index, head: m[1], ref, nodes: [n1, n2], file: signalFileName(m[2] ?? m[3]) });
  });
  return out;
}

/** A `.wave` directive: where to write, in what format, and what. */
export interface WaveDirective {
  raw: string;
  file: string;
  bits: number;
  sampleRate: number;
  exprs: string[];
}

const WAVE_RE = /^\s*\.wave\s+("[^"]*"|\S+)\s+(\S+)\s+(\S+)\s+(.+)$/i;

/** Whether a directive line is `.wave …`. */
export function isWaveLine(line: string): boolean {
  return /^\s*\.wave\b/i.test(line);
}

/**
 * Parse `.wave "file" Nbits SampleRate V(a) [V(b) …]`. Returns an error text
 * instead of throwing, because a malformed line should be reported next to the
 * results, not stop a simulation that does not depend on it.
 */
export function parseWaveDirective(line: string): WaveDirective | { raw: string; error: string } {
  const raw = line.trim();
  const m = WAVE_RE.exec(raw);
  if (!m) return { raw, error: "Syntax: .wave <datei> <Bits> <Abtastrate> V(knoten)" };
  const bits = parseSpiceNumber(m[2]);
  const sampleRate = parseSpiceNumber(m[3]);
  if (!bits || ![8, 16, 24, 32].includes(bits)) return { raw, error: `${m[2]} Bit — erlaubt sind 8, 16, 24 oder 32` };
  if (!sampleRate || sampleRate <= 0) return { raw, error: `ungültige Abtastrate ${m[3]}` };
  const exprs = splitExpressions(m[4]);
  if (exprs.length === 0) return { raw, error: "keine Größe angegeben (z. B. V(out))" };
  return { raw, file: signalFileName(m[1]), bits, sampleRate, exprs };
}

/** Split `V(a) V(b,c) -I(R1)` at top-level whitespace, keeping brackets together. */
function splitExpressions(text: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of text.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A simulated trace, resampled onto an even grid at `sampleRate` from the first
 * to the last time point. ngspice steps adaptively; a WAV file needs one value
 * per sample period.
 */
export function resampleUniform(times: ArrayLike<number>, values: ArrayLike<number>, sampleRate: number): Float32Array {
  const n = Math.min(times.length, values.length);
  if (n === 0) return new Float32Array(0);
  const start = times[0];
  const count = Math.floor((times[n - 1] - start) * sampleRate + 1e-9) + 1;
  const out = new Float32Array(count);
  let j = 0;
  for (let i = 0; i < count; i++) {
    const t = start + i / sampleRate;
    while (j < n - 2 && times[j + 1] <= t) j++;
    const t0 = times[j], t1 = times[Math.min(j + 1, n - 1)];
    const v0 = values[j], v1 = values[Math.min(j + 1, n - 1)];
    out[i] = t1 > t0 ? v0 + (v1 - v0) * Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : v0;
  }
  return out;
}

/** A `.wave` output written as text instead: `time value` per sample. */
export function waveText(samples: Float32Array, sampleRate: number, expr: string, start = 0): string {
  const lines = [`time\t${expr}`];
  for (let i = 0; i < samples.length; i++) lines.push(`${num(start + i / sampleRate)}\t${num(samples[i])}`);
  return lines.join("\n") + "\n";
}

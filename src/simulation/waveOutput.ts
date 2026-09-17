import type { SimulationResult } from "@store/simulationStore.js";
import type { OutputFile } from "@store/sourceFileStore.js";
import { encodeWav } from "@core/audio/wav.js";
import {
  isWaveLine, isWavName, parseWaveDirective, resampleUniform, waveText, type WaveDirective,
} from "@core/audio/signalFile.js";
import { evalExpression, stepView } from "./expression.js";

/**
 * LTSpice's `.wave` directive, done after the run.
 *
 * ngspice has no `.wave` (and no file to write to), so the line is taken out of
 * the netlist before simulating and carried out on the result instead: the
 * named quantity is resampled to the requested rate and encoded. A name ending
 * in `.wav` gives PCM mono with ±1 V full scale, clipped as LTSpice does; any
 * other name gives a `time value` text file of the same samples.
 */

export type ParsedWave = WaveDirective | { raw: string; error: string };

/** Take the `.wave` lines out of a netlist. */
export function splitWaveDirectives(netlist: string): { netlist: string; waves: ParsedWave[] } {
  const waves: ParsedWave[] = [];
  const kept: string[] = [];
  for (const line of netlist.split(/\r?\n/)) {
    if (isWaveLine(line)) waves.push(parseWaveDirective(line));
    else kept.push(line);
  }
  return { netlist: kept.join("\n"), waves };
}

/** Build the output files of the `.wave` directives from a finished run. */
export function renderWaveOutputs(result: SimulationResult, waves: ParsedWave[]): { outputs: OutputFile[]; log: string } {
  const outputs: OutputFile[] = [];
  const rows: string[] = [];
  for (const w of waves) {
    if ("error" in w) { rows.push(`${w.raw}\n  Fehler: ${w.error}`); continue; }
    if (w.exprs.length > 1) {
      rows.push(`${w.raw}\n  Fehler: nur Mono wird unterstützt — bitte genau eine Größe angeben`);
      continue;
    }
    if (result.xLabel || !result.time || result.time.length < 2) {
      rows.push(`${w.raw}\n  Fehler: .wave braucht eine Transientenanalyse (.tran)`);
      continue;
    }
    // A `.step` run holds one trace per step; LTSpice writes the first.
    const view = result.step ? stepView(result, result.step.values[0]) : result;
    const ev = evalExpression(view, w.exprs[0]);
    if (!ev.values) { rows.push(`${w.raw}\n  Fehler: ${ev.error ?? "Größe nicht gefunden"}`); continue; }

    const samples = resampleUniform(view.time!, ev.values, w.sampleRate);
    const wav = isWavName(w.file);
    const bytes = wav
      ? encodeWav(samples, w.sampleRate, w.bits)
      : new TextEncoder().encode(waveText(samples, w.sampleRate, w.exprs[0], view.time![0]));
    outputs.push({ name: w.file, samples, sampleRate: w.sampleRate, bytes, mime: wav ? "audio/wav" : "text/plain" });

    let peak = 0;
    for (const s of samples) peak = Math.max(peak, Math.abs(s));
    const clip = wav && peak > 1 ? ` — Achtung: Spitzenwert ${peak.toFixed(2)} V, über ±1 V abgeschnitten` : "";
    const step = result.step ? ` (erster Schritt ${result.step.values[0]})` : "";
    rows.push(`${w.raw}\n  ${w.file}: ${samples.length} Samples, ${(samples.length / w.sampleRate).toFixed(2)} s${step}${clip}`);
  }
  return { outputs, log: rows.length ? `===== .wave =====\n${rows.join("\n")}\n\n` : "" };
}

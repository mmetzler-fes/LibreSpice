import { Simulation, type ResultType } from "eecircuit-engine";
import type { SimulationResult } from "@store/simulationStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { formatSpiceNumber } from "@core/circuit/NetlistGenerator.js";
import {
  parseStepDirective, stripStepDirectives, withParam, parseMeasurements, type Measurement,
} from "./paramSweep.js";

let sim: Simulation | null = null;

async function getSimulation(): Promise<Simulation> {
  if (!sim) {
    sim = new Simulation();
    await sim.start();
  }
  return sim;
}

/** ngspice stdout/stderr for the last run. */
function engineLog(engine: Simulation): string {
  const tryGet = (fn: () => string | string[]): string => {
    try {
      const v = fn();
      return Array.isArray(v) ? v.join("\n") : v;
    } catch {
      return "";
    }
  };
  const info = tryGet(() => engine.getInfo());
  const errors = tryGet(() => engine.getError());
  const parts: string[] = [];
  if (info.trim()) parts.push("===== ngspice output =====", info.trim());
  if (errors.trim()) parts.push("===== Errors / warnings =====", errors.trim());
  return parts.join("\n\n");
}

/** Run a single netlist and return its result plus the raw engine log. */
async function runOnce(netlist: string): Promise<{ result: SimulationResult; log: string }> {
  const engine = await getSimulation();
  engine.setNetList(netlist);
  const result: ResultType = await engine.runSim();
  return { result: convertResult(result), log: engineLog(engine) };
}

export async function runSimulation(netlist: string): Promise<SimulationResult> {
  const setLog = useSimulationStore.getState().setLog;
  const step = parseStepDirective(netlist);
  try {
    if (!step || step.values.length === 0) {
      // Strip any (unparseable) `.step` too — ngspice can't execute it.
      const nl = stripStepDirectives(netlist);
      const { result, log } = await runOnce(nl);
      setLog(`===== Netlist =====\n${nl.trim()}\n\n${log}`);
      return result;
    }

    // Parameter sweep: run once per value, merge the traces (suffixing each
    // signal with the step value) so the existing plot shows one curve per run.
    const base = stripStepDirectives(netlist);
    const merged: SimulationResult = { variables: [], data: {}, time: undefined, step: { param: step.name, values: [] } };
    const measRows: string[] = [];
    let lastLog = "";
    for (const value of step.values) {
      const nl = withParam(base, step.name, value);
      const { result, log } = await runOnce(nl);
      lastLog = log;
      const tag = `${step.name}=${formatSpiceNumber(value)}`;
      merged.step!.values.push(tag);
      if (!merged.time && result.time) {
        merged.time = result.time;
        merged.data["time"] = result.time;
        merged.variables.push("time");
      }
      for (const v of result.variables) {
        if (v === "time" || v === "frequency") continue;
        const key = `${v} @${tag}`;
        merged.data[key] = result.data[v];
        merged.variables.push(key);
      }
      const meas: Measurement[] = parseMeasurements(log);
      if (meas.length) measRows.push(`${tag}:  ${meas.map((m) => `${m.name} = ${m.value}`).join("   ")}`);
    }

    const measBlock = measRows.length ? `===== Measurements (.step ${step.name}) =====\n${measRows.join("\n")}\n\n` : "";
    setLog(`${measBlock}===== Netlist (last step) =====\n${base.trim()}\n\n${lastLog}`);
    return merged;
  } catch (e) {
    try { if (sim) setLog(engineLog(sim)); } catch { /* ignore */ }
    sim = null;
    throw new Error(`Simulation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function convertResult(result: ResultType): SimulationResult {
  const variables = result.variableNames;
  const data: Record<string, Float64Array> = {};

  if (result.dataType === "real") {
    for (const d of result.data) {
      data[d.name] = new Float64Array(d.values as number[]);
    }
  } else {
    for (const d of result.data) {
      const complexVals = d.values as Array<{ real: number; img: number }>;
      data[d.name] = new Float64Array(complexVals.map((v) => Math.sqrt(v.real ** 2 + v.img ** 2)));
    }
  }

  const time = data["time"] ?? data[variables[0]];
  return { variables, data, time };
}

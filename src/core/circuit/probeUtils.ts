import type { Circuit } from "./Circuit.js";
import type { SpiceComponent } from "../components/base/SpiceComponent.js";
import type { SimulationResult } from "@store/simulationStore.js";

/** Resolve a net id to the label used in the generated netlist. */
export function netLabel(circuit: Circuit, netId: string | null): string | null {
  if (!netId || netId === "0") return null;
  const net = circuit.nets.get(netId);
  return net?.nodeLabel ?? netId;
}

/**
 * Branch-current probe names for a component. Covers the classic `I(label)` form
 * plus ngspice's `@dev[i]` vectors produced by `.options savecurrents` (used for
 * R/C/L whose currents are not emitted by default).
 */
export function getCurrentProbeCandidates(label: string): string[] {
  return [`I(${label})`, `i(${label})`, `@${label}[i]`, `@${label.toLowerCase()}[i]`];
}

/** Build likely SPICE probe variable names for a component. */
export function getProbeCandidates(component: SpiceComponent, circuit: Circuit): string[] {
  const candidates: string[] = [];
  const { label } = component;

  // Branch current through the component
  candidates.push(...getCurrentProbeCandidates(label));

  // Node voltages at each port
  for (const port of component.ports) {
    const name = netLabel(circuit, port.netId);
    if (name) {
      candidates.push(`V(${name})`);
      candidates.push(`v(${name})`);
    }
  }

  return [...new Set(candidates)];
}

/** Build voltage probe candidates for a specific port net. */
export function getVoltageProbeForNet(circuit: Circuit, netId: string | null): string[] {
  const name = netLabel(circuit, netId);
  if (!name) return [];
  return [`V(${name})`, `v(${name})`];
}

/** Match a probe candidate to an actual variable name from simulation results. */
export function matchResultVariable(
  result: SimulationResult,
  candidates: string | string[],
): string | null {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const c of list) {
    const exact = result.variables.find((v) => v === c);
    if (exact) return exact;
  }
  for (const c of list) {
    const lower = c.toLowerCase();
    const ci = result.variables.find((v) => v.toLowerCase() === lower);
    if (ci) return ci;
  }
  // Fuzzy: match by node/component name inside parentheses
  for (const c of list) {
    const inner = c.replace(/^[vViI]\(/, "").replace(/\)$/, "").toLowerCase();
    const fuzzy = result.variables.find((v) => v.toLowerCase().includes(inner));
    if (fuzzy) return fuzzy;
  }
  return null;
}

/** Return probe variables for a component that exist in the current result. */
export function getActiveProbesForComponent(
  component: SpiceComponent,
  circuit: Circuit,
  result: SimulationResult,
  selectedVariables: string[],
): string[] {
  const candidates = getProbeCandidates(component, circuit);
  return selectedVariables.filter((sel) =>
    candidates.some((c) => matchResultVariable(result, [c, sel]) === sel),
  );
}

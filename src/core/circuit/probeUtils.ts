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

/** A branch current (`I`) or node voltage (`V`) probe, canonicalised. */
export interface CanonicalProbe {
  /** Stable identity: collapses duplicate raw forms of the same quantity. */
  key: string;
  /** Uniform display name, e.g. `I(L1)` or `V(out)`. */
  display: string;
  kind: "I" | "V";
}

/**
 * Canonicalise a raw ngspice variable name. ngspice exposes a device current in
 * several equivalent forms (`i(l1)`, `@l1[i]`, `l1#branch`) — these all collapse
 * to one `I(NAME)` probe so the user sees a single entry per device, and every
 * device (incl. R/C via `savecurrents`) gets an `I(name)` option. Returns `null`
 * for the time base and anything unrecognised.
 */
export function canonicalProbe(raw: string): CanonicalProbe | null {
  let m = raw.match(/^@(.+?)\[i\]$/i);            // @dev[i]  (savecurrents)
  if (m) { const d = m[1].toUpperCase(); return { key: `I:${d}`, display: `I(${d})`, kind: "I" }; }
  m = raw.match(/^i\((.+)\)$/i);                  // i(dev) / I(dev)
  if (m) { const d = m[1].toUpperCase(); return { key: `I:${d}`, display: `I(${d})`, kind: "I" }; }
  m = raw.match(/^(.+)#branch$/i);               // dev#branch
  if (m) { const d = m[1].toUpperCase(); return { key: `I:${d}`, display: `I(${d})`, kind: "I" }; }
  m = raw.match(/^v\((.+)\)$/i);                  // v(net) / V(net)
  if (m) { const n = m[1]; return { key: `V:${n.toUpperCase()}`, display: `V(${n})`, kind: "V" }; }
  return null;
}

/** One selectable probe row: the raw variable to plot plus its display name. */
export interface ProbeEntry { raw: string; display: string; kind: "I" | "V" | "other" }

/**
 * Collapse a result's raw variables into a deduplicated probe list: one entry
 * per node voltage and one per device current (preferring the friendly `i(dev)`
 * form over `@dev[i]`), so identical currents don't appear twice.
 */
export function dedupeProbes(variables: string[]): ProbeEntry[] {
  const byKey = new Map<string, ProbeEntry>();
  const others: ProbeEntry[] = [];
  for (const v of variables) {
    if (v === "time" || v === "frequency") continue;
    const c = canonicalProbe(v);
    if (!c) { others.push({ raw: v, display: v, kind: "other" }); continue; }
    const existing = byKey.get(c.key);
    // Prefer a non-`@` representative (matches matchResultVariable's ordering).
    if (!existing || (existing.raw.startsWith("@") && !v.startsWith("@"))) {
      byKey.set(c.key, { raw: v, display: c.display, kind: c.kind });
    }
  }
  const order = { V: 0, I: 1, other: 2 } as const;
  return [...byKey.values(), ...others].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.display.localeCompare(b.display),
  );
}

/**
 * Expression for the voltage across a component (its potential difference),
 * from the nets on its first two ports. Ground terms drop out. Returns `null`
 * when neither port carries a usable net.
 */
export function getVoltageDiffExpression(component: SpiceComponent, circuit: Circuit): string | null {
  const a = netLabel(circuit, component.ports[0]?.netId ?? null);
  const b = netLabel(circuit, component.ports[1]?.netId ?? null);
  if (a && b) return `V(${a})-V(${b})`;
  if (a) return `V(${a})`;
  if (b) return `-V(${b})`;
  return null;
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

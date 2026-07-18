import type { Circuit } from "./Circuit.js";
import type { SpiceComponent } from "../components/base/SpiceComponent.js";
import type { SimulationResult } from "@store/simulationStore.js";
import { senseDeviceOf, isSenseNode } from "./currentSense.js";

/** Resolve a net id to the label used in the generated netlist. */
export function netLabel(circuit: Circuit, netId: string | null): string | null {
  if (!netId || netId === "0") return null;
  const net = circuit.nets.get(netId);
  return net?.nodeLabel ?? netId;
}

/**
 * Terminals of a multi-terminal device, keyed by SPICE reference letter. A
 * two-terminal part has one branch current, but a transistor has one *per pin*
 * — LTSpice writes them `Ic(Q1)`, `Ib(Q1)`, … and ngspice (via `savecurrents`)
 * `@q1[ic]`, `@q1[ib]`, … There is no `I(Q1)`: asking for "the" current of a
 * transistor is meaningless, so the probes must stay separate.
 */
const DEVICE_TERMINALS: Record<string, string[]> = {
  q: ["c", "b", "e", "s"],   // BJT: collector, base, emitter, substrate
  m: ["d", "g", "s", "b"],   // MOSFET
  j: ["d", "g", "s"],        // JFET
};

/** The terminal letters of the device a reference designator names. */
export function deviceTerminals(label: string): string[] {
  return DEVICE_TERMINALS[label.trim()[0]?.toLowerCase() ?? ""] ?? [];
}

/**
 * Branch-current probe names for a component. Covers the classic `I(label)` form
 * plus ngspice's `@dev[i]` vectors produced by `.options savecurrents` (used for
 * R/C/L whose currents are not emitted by default). For a transistor the list is
 * its terminal currents instead — that is what the engine actually saves.
 */
export function getCurrentProbeCandidates(label: string): string[] {
  const terminals = deviceTerminals(label);
  if (terminals.length) {
    return terminals.flatMap((t) => [
      `I${t}(${label})`, `@${label.toLowerCase()}[i${t}]`, `i(@${label.toLowerCase()}[i${t}])`,
    ]);
  }
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
  const s = raw.trim();
  // Node voltage: v(net) / V(net).
  const vm = s.match(/^v\((.+)\)$/i);
  if (vm) { const n = vm[1]; return { key: `V:${n.toUpperCase()}`, display: `V(${n})`, kind: "V" }; }

  // Branch current — strip an optional i(...) wrapper first so nested engine
  // forms like i(@l1[i]) collapse onto @l1[i] / i(l1) / l1#branch.
  const outer = s.match(/^i\((.+)\)$/i);
  const body = outer ? outer[1].trim() : s;
  // A current-sense source stands in for the device it is in series with (an AC
  // run cannot report an R/C current any other way — see currentSense). Report
  // it as that device's current, so `i(v__i_r1)` is the `I(R1)` the user asked
  // for and never appears under its synthetic name.
  //
  // `term` is a transistor terminal letter (c/b/e, d/g/s, …) and is part of the
  // identity: `@q1[ic]` and `@q1[ib]` are different quantities and must not
  // collapse onto one another. Written the LTSpice way, `Ic(Q1)`.
  const cur = (d: string, term = ""): CanonicalProbe => {
    const dev = senseDeviceOf(d) ?? d;
    // Only a genuine multi-terminal device has terminal currents. A diode's sole
    // current is named `@d1[id]`, whose `d` is not a terminal letter — reading it
    // as one would turn `I(D1)` into a phantom `Id(D1)` that nothing requests.
    const t = term.toLowerCase();
    const isTerminal = t !== "" && deviceTerminals(dev).includes(t);
    return {
      key: `I:${dev.toUpperCase()}${isTerminal ? `:${t.toUpperCase()}` : ""}`,
      display: `I${isTerminal ? t : ""}(${dev.toUpperCase()})`,
      kind: "I",
    };
  };
  let m = body.match(/^@(.+?)\[i(\w*)\]$/i);      // @dev[i] / @dev[ic]  (savecurrents)
  if (m) return cur(m[1], m[2]);
  m = body.match(/^(.+)#branch$/i);              // dev#branch
  if (m) return cur(m[1]);
  if (outer && /^[a-z_][\w.]*$/i.test(body)) return cur(body); // i(dev)
  // LTSpice's terminal-current spelling, e.g. `Ic(Q1)` — the form a user types
  // and the one `.plt` files carry, so it must resolve to `@q1[ic]`.
  m = s.match(/^i([a-z])\(([a-z_][\w.]*)\)$/i);
  if (m) return cur(m[2], m[1]);
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
    // The node an AC sense source introduces is plumbing, not a signal: it
    // duplicates the node the device already sits on (0 V across the source).
    const vm = /^v\((.+)\)$/i.exec(v);
    if (vm && isSenseNode(vm[1])) continue;
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

/**
 * Rewrite voltage references to a renamed net inside a probe/expression string,
 * e.g. `V(net1)-V(gnd)` with net1→vin becomes `V(vin)-V(gnd)`. Only voltage
 * refs carry a net name (currents reference devices), so `I(...)` is untouched.
 *
 * Both LTSpice voltage forms are covered: the single-node `V(a)` and the
 * differential `V(a,b)` that a component data-point emits — either operand of
 * the pair renames independently, so `V(out,net1)` with net1→gnd becomes
 * `V(out,gnd)`. Matching a bare net name (not one already inside `V(...)`) would
 * be ambiguous with device names, so only names within `V(...)` are touched.
 */
export function renameNetInProbe(trace: string, oldLabel: string, newLabel: string): string {
  // Match V(...) with one or two comma-separated node names and rename any
  // operand that equals oldLabel, leaving the other(s) as they are.
  return trace.replace(/([vV])\(\s*([^(),]+?)\s*(?:,\s*([^(),]+?)\s*)?\)/g, (_m, fn, a, b) => {
    const rn = (name: string | undefined) => (name === oldLabel ? newLabel : name);
    return b !== undefined ? `${fn}(${rn(a)},${rn(b)})` : `${fn}(${rn(a)})`;
  });
}

/** Build voltage probe candidates for a specific port net. */
export function getVoltageProbeForNet(circuit: Circuit, netId: string | null): string[] {
  const name = netLabel(circuit, netId);
  if (!name) return [];
  return [`V(${name})`, `v(${name})`];
}

/**
 * Canonical key of a probe *request* (as opposed to a result variable). A bare
 * name is a node, so `UBat` asks for `V(UBat)` — that is how a wire probe and
 * an ngspice node reference are written.
 */
function requestKey(candidate: string): string | null {
  const c = canonicalProbe(candidate);
  if (c) return c.key;
  const bare = candidate.trim();
  return /^[A-Za-z_][\w.]*$/.test(bare) ? `V:${bare.toUpperCase()}` : null;
}

/**
 * Match a probe candidate to an actual variable name from simulation results.
 *
 * Matching is by canonical probe identity, never by substring: ngspice writes
 * one quantity several ways (`i(rl)`, `@rl[i]`, `rl#branch`), but a `V(...)`
 * request must never resolve to a current. A substring fallback used to do
 * exactly that — `V(Ri)` found `i(@ri[i])`, so a voltage trace silently showed
 * the device's current (and dragged the volts axis to its magnitude).
 */
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
  // Canonical: same quantity, different spelling. Prefer a non-`@` representative
  // so the friendly `i(rl)` wins over `@rl[i]` (dedupeProbes relies on this order).
  for (const c of list) {
    const key = requestKey(c);
    if (!key) continue;
    const same = result.variables.filter((v) => canonicalProbe(v)?.key === key);
    if (same.length) return same.find((v) => !v.startsWith("@")) ?? same[0];
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

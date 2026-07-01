import type { Node, Edge } from "@xyflow/react";
import type { SimulationConfig } from "@core/circuit/NetlistGenerator.js";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";

export const AUTOSAVE_KEY = "librespice-autosave";
export const URL_HASH_PREFIX = "c=";

export interface CircuitSnapshot {
  version: 1;
  nodes: Node[];
  edges: Edge[];
  spiceDirectives: string;
  simulationConfig: SimulationConfig;
  /** component id → property key → value */
  componentProps: Record<string, Record<string, string | number>>;
  netLabels: Record<string, string>;
}

export function createSnapshot(state: {
  nodes: Node[];
  edges: Edge[];
  spiceDirectives: string;
  simulationConfig: SimulationConfig;
  componentProps: Record<string, Record<string, string | number>>;
  netLabels: Record<string, string>;
}): CircuitSnapshot {
  return { version: 1, ...state };
}

export function encodeSnapshot(snapshot: CircuitSnapshot): string {
  const json = JSON.stringify(snapshot);
  return btoa(unescape(encodeURIComponent(json)));
}

export function decodeSnapshot(encoded: string): CircuitSnapshot | null {
  try {
    const json = decodeURIComponent(escape(atob(encoded)));
    const parsed = JSON.parse(json) as CircuitSnapshot;
    if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveToLocalStorage(snapshot: CircuitSnapshot): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(snapshot));
  } catch {
    /* quota exceeded – ignore */
  }
}

export function loadFromLocalStorage(): CircuitSnapshot | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CircuitSnapshot;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function getSnapshotFromUrl(): CircuitSnapshot | null {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(window.location.search);

  let encoded: string | null = null;
  if (hash.startsWith(URL_HASH_PREFIX)) {
    encoded = hash.slice(URL_HASH_PREFIX.length);
  } else if (params.has("circuit")) {
    encoded = params.get("circuit");
  }
  if (!encoded) return null;
  return decodeSnapshot(encoded);
}

export function buildShareUrl(snapshot: CircuitSnapshot): string {
  const encoded = encodeSnapshot(snapshot);
  const base = `${window.location.origin}${window.location.pathname}`;
  return `${base}#${URL_HASH_PREFIX}${encoded}`;
}

export function collectComponentProps(
  components: Map<string, { getProperties: () => { key: string; value: string | number }[] }>,
): Record<string, Record<string, string | number>> {
  const out: Record<string, Record<string, string | number>> = {};
  for (const [id, comp] of components) {
    const props: Record<string, string | number> = {};
    for (const p of comp.getProperties()) {
      props[p.key] = p.value;
    }
    out[id] = props;
  }
  return out;
}

export function collectNetLabels(
  nets: Map<string, { id: string; nodeLabel: string }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, net] of nets) {
    if (id !== "0" && net.nodeLabel !== id) {
      out[id] = net.nodeLabel;
    }
  }
  return out;
}

/** Extract component type from a node, falling back to id prefix. */
export function nodeComponentType(node: Node): ComponentType | null {
  const t = (node.data as { componentType?: ComponentType }).componentType;
  if (t) return t;
  const prefix = node.id.split("_")[0];
  return prefix as ComponentType;
}

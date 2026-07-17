import type { Node, Edge } from "@xyflow/react";
import type { SimulationConfig } from "@core/circuit/NetlistGenerator.js";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import type { PlotSettings } from "@simulation/plotStore.js";

export const AUTOSAVE_KEY = "librespice-autosave";

/**
 * Identifier of the running build, injected by Vite (`define`) from the git
 * commit or a build timestamp. Autosaved snapshots are stamped with it so a
 * snapshot written by an older build is not silently restored after an update —
 * its components may serialize differently (e.g. a source that has since gained
 * a Sine waveform), which would otherwise resurrect a stale representation over
 * a freshly opened file. Falls back to "dev" when the define is absent (tests).
 */
declare const __BUILD_ID__: string | undefined;
export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";
/** Legacy share links: plain base64 of the snapshot JSON. Still decoded. */
export const URL_HASH_PREFIX = "c=";
/** Current share links: deflate-compressed snapshot JSON, base64url. */
export const URL_HASH_PREFIX_Z = "z=";

export interface CircuitSnapshot {
  version: 1;
  nodes: Node[];
  edges: Edge[];
  /** User-facing diagram/circuit name (default file name). */
  circuitName?: string;
  spiceDirectives: string;
  simulationConfig: SimulationConfig;
  /** component id → property key → value */
  componentProps: Record<string, Record<string, string | number>>;
  /**
   * Custom net names keyed by internal net id. Fragile across reloads because
   * net ids are re-assigned on rebuild — kept only for backward compatibility.
   * Prefer {@link netLabelPorts}, which anchors names to a stable port id.
   */
  netLabels: Record<string, string>;
  /**
   * Custom net names keyed by a representative connected port id. Port ids are
   * stable across a rebuild (component id + handle), so these survive the
   * net-id reassignment that `rebuildConnections` performs on load.
   */
  netLabelPorts?: Record<string, string>;
  /** Positioned data-point annotations (LTSpice DATAFLAGs). */
  dataFlags?: DataFlag[];
  /** Show the SPICE directives as a text box on the schematic. */
  showDirectivesOnCanvas?: boolean;
  /** Position (flow coords) of the on-canvas directive text box. */
  directivesPos?: { x: number; y: number };
  /**
   * Diagram configuration (panels, axes, colours, functions — the `.plt`
   * shape). Tiny and highly compressible next to the nodes/edges, so it does
   * not meaningfully affect whether a share link still fits a QR code. Optional
   * so links written before this field still load.
   */
  plotSettings?: PlotSettings;
  /**
   * The active scope probes (ngspice-resolved trace names like `v(out)`,
   * `@r1[i]`). Restored as *pending* probes on load, so the next simulation run
   * immediately plots the signals the author cared about instead of an empty
   * scope. Optional — links written before this field simply restore no probes.
   */
  selectedVariables?: string[];
  /**
   * The {@link BUILD_ID} that wrote this snapshot. Stamped only on the
   * localStorage autosave (not on share links, which must always open); used to
   * skip auto-restoring a snapshot from a different build. Optional so older
   * autosaves and share payloads without it still validate.
   */
  appVersion?: string;
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
    return validateSnapshot(json);
  } catch {
    return null;
  }
}

function validateSnapshot(json: string): CircuitSnapshot | null {
  const parsed = JSON.parse(json) as CircuitSnapshot;
  if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) return null;
  return parsed;
}

// ── Compressed share payloads ────────────────────────────────────────────────
// The snapshot JSON is highly repetitive (React Flow node/edge keys), so deflate
// shrinks it ~3.5x. That is what makes a share link fit into a QR code at all:
// a QR code holds at most 2953 bytes, and the plain base64 of even a small
// circuit runs past 3000 characters.

/** base64url — no `+`, `/` or `=`, so the payload survives a URL untouched. */
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipeThrough(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart]);
  const piped = blob.stream().pipeThrough(stream as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

/** True when the browser can (de)compress — Safari/iOS gained this in 16.4. */
export function supportsCompression(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

export async function encodeSnapshotCompressed(snapshot: CircuitSnapshot): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(snapshot));
  return bytesToBase64Url(await pipeThrough(json, new CompressionStream("deflate-raw")));
}

export async function decodeSnapshotCompressed(encoded: string): Promise<CircuitSnapshot | null> {
  try {
    const bytes = await pipeThrough(base64UrlToBytes(encoded), new DecompressionStream("deflate-raw"));
    return validateSnapshot(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export function saveToLocalStorage(snapshot: CircuitSnapshot): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ ...snapshot, appVersion: BUILD_ID }));
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
    // Don't silently restore an autosave from a different build: component
    // serialization may have changed since (e.g. DC→Sine source), so restoring
    // it would resurrect a stale representation. Skip it and start clean; the
    // next autosave overwrites it stamped with the current build. The stored
    // data is left untouched (not deleted), so nothing is hard-lost.
    if (parsed.appVersion !== BUILD_ID) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getSnapshotFromUrl(): Promise<CircuitSnapshot | null> {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(window.location.search);

  if (hash.startsWith(URL_HASH_PREFIX_Z)) {
    return await decodeSnapshotCompressed(hash.slice(URL_HASH_PREFIX_Z.length));
  }
  let encoded: string | null = null;
  if (hash.startsWith(URL_HASH_PREFIX)) {
    encoded = hash.slice(URL_HASH_PREFIX.length);
  } else if (params.has("circuit")) {
    encoded = params.get("circuit");
  }
  if (!encoded) return null;
  return decodeSnapshot(encoded);
}

export async function buildShareUrl(snapshot: CircuitSnapshot): Promise<string> {
  // Point at the app's own base path (import.meta.env.BASE_URL, always trailing
  // "/") rather than the current pathname, so the link opens the app directly —
  // never the landing page that may sit next to it.
  const base = `${window.location.origin}${import.meta.env.BASE_URL}`;
  if (supportsCompression()) {
    return `${base}#${URL_HASH_PREFIX_Z}${await encodeSnapshotCompressed(snapshot)}`;
  }
  return `${base}#${URL_HASH_PREFIX}${encodeSnapshot(snapshot)}`;
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

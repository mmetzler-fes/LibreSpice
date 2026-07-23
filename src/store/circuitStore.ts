import { create } from "zustand";
import type { Node, Edge } from "@xyflow/react";
import { Circuit } from "@core/circuit/Circuit.js";
import { Net } from "@core/circuit/Net.js";
import { TEXTBOX_DEFAULT_W, TEXTBOX_DEFAULT_H, TEXT_SIZE_DEFAULT, type TextBox } from "@core/circuit/textBox.js";
import type { SheetShape } from "@core/circuit/sheetShape.js";
import { NetlistGenerator, parseAnalysisDirective, syncAnalysisDirective, type SimulationConfig } from "@core/circuit/NetlistGenerator.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import { getValueLabel, createSpiceComponent, createSubcircuitComponent } from "@editor/componentFactory.js";
import { getNodePins, NODE_SIZE } from "@editor/pinGeometry.js";
import { reseatTwoPinEdges } from "@editor/pinReseat.js";
import { useUIStore } from "./uiStore.js";
import type { FlowPoint } from "@editor/WireTool.js";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import type { DirectiveRaw } from "@core/ltspice/ascPreserve.js";
import { fragmentOrigin, fragmentModels, isFragment, pasteLabelFor } from "@core/ltspice/ascFragment.js";
import { renameNetInProbe } from "@core/circuit/probeUtils.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import type { NetAnchor, BusTap } from "@core/circuit/netAnchor.js";
import { resolveAnchors, orphanGroups, touchesGroup } from "@editor/anchorNets.js";
import { ANCHOR_TOLERANCE } from "@core/circuit/anchorResolve.js";
import type { PortType } from "@core/components/special/Special.js";
import { useLibraryStore } from "./libraryStore.js";
import { ModelParser } from "@core/library/ModelParser.js";
import { useSimulationStore } from "./simulationStore.js";
import { usePlotStore, currentPlotSettings } from "@simulation/plotStore.js";
import type { CircuitSnapshot } from "./persistence.js";

interface HistoryEntry {
  nodes: Node[];
  edges: Edge[];
}

interface CircuitState {
  circuit: Circuit;
  nodes: Node[];
  edges: Edge[];
  selectedComponentId: string | null;
  netlist: string;
  simulationConfig: SimulationConfig;
  spiceDirectives: string;
  /** The directive `TEXT` lines of the loaded `.asc`, verbatim. An unedited
   *  directive is written back from here instead of being re-laid-out at a
   *  hardcoded position (see ascPreserve.ts). */
  directiveRaw: DirectiveRaw[];
  /** The loaded file's `Version` / `SHEET` lines, written back verbatim. */
  ascHeader: Record<string, string>;
  /** `WIRE` lines of the loaded file that no edge represents; preserved on save. */
  ascOrphanWires: string[];
  /**
   * Last copied fragment, kept inside the app beside the system clipboard.
   *
   * Reading the system clipboard needs a permission step the user has to confirm
   * — on iPadOS a native "Paste" tap — which is a poor fit for a button pressed
   * repeatedly while building a circuit. Copying fills both, and the paste button
   * falls back to this one whenever the system clipboard cannot be read. The
   * keyboard path never touches it: there the browser hands us the data outright.
   */
  fragmentClipboard: string;
  /**
   * Net names a paste joined onto existing ones, or null when there were none.
   *
   * Keeping the names is LTSpice's behaviour and stays the default, but it wires
   * the pasted block into the original wherever they meet — invisible on screen
   * and expensive to find afterwards (it took reading the netlist to spot two
   * rectifiers running in parallel). The canvas shows this as a dismissible note.
   */
  pasteNotice: string[] | null;
  /** Show the SPICE directives as a text box on the schematic (LTSpice-style). */
  showDirectivesOnCanvas: boolean;
  /** Position (flow coords) of the on-canvas directive text box. */
  directivesPos: { x: number; y: number };
  /** User-facing diagram/circuit name; default file name for .asc and .plt. */
  circuitName: string;
  /** Positioned data-point annotations (LTSpice DATAFLAGs). */
  dataFlags: DataFlag[];
  /**
   * The names on the sheet (LTSpice `FLAG`, plus `IOPIN` for a connector).
   *
   * A name is a coordinate and a string, not a part: it owns no pin, no edge and
   * no netlist line, and finds its net by lying on one (see anchorNets). Ground
   * is the exception that stays a component — in the file it is a flag named `0`
   * like any other, but on our sheet it is a drawn symbol with a pin, and its
   * anchor is derived from the node (see anchorsFromNodes).
   */
  netAnchors: NetAnchor[];
  /** Bus taps on the sheet (see BusTap) — drawn, and written back on save. */
  busTaps: BusTap[];
  /** Free text annotations on the sheet (see textBox). */
  textBoxes: TextBox[];
  /** Frames and other shapes drawn on the sheet (see sheetShape). */
  sheetShapes: SheetShape[];
  propertyVersion: number;
  netVersion: number;
  /** Bumped after a full load (import / snapshot) so the canvas re-fits the view. */
  viewFitNonce: number;
  fileHandle: any | null;
  fileName: string | null;
  _history: HistoryEntry[];
  _future: HistoryEntry[];
}

interface CircuitActions {
  addComponent: (component: SpiceComponent, nodeData: Node) => void;
  removeComponent: (id: string) => void;
  updateComponentProperty: (id: string, key: string, value: string | number) => void;
  setLabelOffset: (id: string, kind: "label" | "value", offset: { x: number; y: number }) => void;
  /** Patch a node's `data` (visual-only fields, e.g. a net connector's port type). Undoable. */
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  /** Patch a wire edge's `data` (visible label, waypoints, …). Undoable. */
  updateEdgeData: (id: string, patch: Record<string, unknown>) => void;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  setSelectedComponentId: (id: string | null) => void;
  connectPorts: (portIdA: string, portIdB: string) => void;
  regenerateNetlist: () => void;
  setSimulationConfig: (config: SimulationConfig) => void;
  setSpiceDirectives: (text: string) => void;
  setShowDirectivesOnCanvas: (show: boolean) => void;
  moveDirectivesBox: (x: number, y: number) => void;
  setCircuitName: (name: string) => void;
  renameNet: (netId: string, label: string) => void;
  /** Put a name at a point. Returns the new anchor's id. */
  addNetAnchor: (x: number, y: number, name: string, portType?: PortType) => string;
  /** Rename an anchor, or change its port type. An empty name removes it. */
  updateNetAnchor: (id: string, patch: { name?: string; portType?: PortType }) => void;
  moveNetAnchor: (id: string, x: number, y: number) => void;
  removeNetAnchor: (id: string) => void;
  addDataFlag: (x: number, y: number, expr: string) => void;
  removeDataFlag: (id: string) => void;
  addTextBox: (x: number, y: number) => string;
  updateTextBox: (id: string, patch: Partial<TextBox>) => void;
  removeTextBox: (id: string) => void;
  moveDataFlag: (id: string, x: number, y: number) => void;
  loadFromAsc: (ascContent: string) => void;
  /** Insert a `.asc` fragment at `at` (flow coords); returns how many parts landed. */
  pasteFragment: (text: string, at?: { x: number; y: number }) => number;
  /** Remember a fragment in-app (see fragmentClipboard). */
  setFragmentClipboard: (text: string) => void;
  /** Dismiss the "these net names already existed" notice. */
  clearPasteNotice: () => void;
  clearCircuit: () => void;
  setFileHandle: (handle: any | null, name: string | null) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  rotateSelected: () => void;
  /** Rotate a specific component 90° left (used by the on-canvas connector tap). */
  rotateComponent: (id: string) => void;
  mirrorSelected: () => void;
  deleteSelected: () => void;
  rebuildConnections: () => void;
  exportSnapshot: () => CircuitSnapshot;
  loadFromSnapshot: (snapshot: CircuitSnapshot) => void;
}

const DEFAULT_CONFIG: SimulationConfig = {
  type: "tran",
  stepTime: 1e-6,
  stopTime: 1e-3,
};

/**
 * Where a net label placed by naming a wire should sit: the midpoint of that
 * wire, which is clear of both its ends and so of the parts it runs between.
 * Null when the wire's endpoints cannot be resolved.
 */
function labelAnchor(host: Edge, nodes: Node[]): FlowPoint | null {
  // Pin first; failing that the node's centre. The fallback matters: without it
  // a part whose symbol has not (yet) loaded yields no anchor, no label is
  // placed, and the name silently reverts to living nowhere — the very trap this
  // is meant to close.
  const at = (id?: string | null, handle?: string | null) => {
    const n = id ? nodes.find((x) => x.id === id) : undefined;
    if (!n) return null;
    const p = handle ? getNodePins(n).find((q) => q.handleId === handle) : undefined;
    return p ? { x: p.x, y: p.y } : { x: n.position.x + NODE_SIZE / 2, y: n.position.y + NODE_SIZE / 2 };
  };
  const a = (host.data as { sourceTap?: FlowPoint } | undefined)?.sourceTap ?? at(host.source, host.sourceHandle);
  const b = (host.data as { targetTap?: FlowPoint } | undefined)?.targetTap ?? at(host.target, host.targetHandle);
  if (!a || !b) return null;
  const snap = (v: number) => Math.round(v / 4) * 4;
  return { x: snap((a.x + b.x) / 2), y: snap((a.y + b.y) / 2) };
}

/**
 * Give every net the name of its *oldest* net terminal.
 *
 * A net needs exactly one name in the netlist — SPICE has one node per net — but
 * the *schematic* may carry several, and LTSpice files do: `leitungstest.asc`
 * has `x1` and `x2` on one net, and two net connectors `nc1`/`nc2` on another.
 * Those extra names are aliases, not mistakes, and they must survive a save.
 *
 * So the winner is chosen here and nowhere else. It used to be decided twice,
 * with different rules: this pass picked the oldest terminal, and
 * `regenerateNetlist` then re-imposed every terminal's name in map order, so the
 * last one silently won. Worse, the losing *terminal* was renamed to match,
 * which destroyed the name in the file — opening and saving `leitungstest.asc`
 * turned its `x2` into a second `x1`.
 *
 * Ids are handed out in ascending order (`anchor_3`, `anchor_7`), so the smallest
 * is the name that was there first — and on import, the first FLAG in the file,
 * which is the name LTSpice itself shows.
 */
/** `0` and `GND` name the ground net wherever they appear. */
function isGroundName(s: string): boolean {
  return /^(0|gnd)$/i.test(s.trim());
}

/**
 * The name-carrying nodes of a snapshot written before the switch, each with the
 * anchor that replaces it.
 *
 * The coordinate is the flag's, not the node's: a net terminal docked at its
 * centre, which is where the `.asc` put the `FLAG` and where the name was drawn.
 * Reading it as the node's top-left would shift every converted name by half a
 * symbol — far enough to land it on the wrong wire.
 */
function legacyNameNodes(nodes: Node[]): { id: string; anchor: NetAnchor }[] {
  const out: { id: string; anchor: NetAnchor }[] = [];
  for (const n of nodes) {
    const d = n.data as { componentType?: string; label?: string; portType?: PortType };
    if (d.componentType !== "netlabel" && d.componentType !== "netconnector") continue;
    const name = String(d.label ?? "").trim();
    if (!name) continue;
    const portType = d.componentType === "netconnector" ? d.portType ?? "BiDir" : undefined;
    out.push({
      id: n.id,
      anchor: {
        id: `anchor_${out.length + 1}`,
        x: Math.round(n.position.x + NODE_SIZE / 2),
        y: Math.round(n.position.y + NODE_SIZE / 2),
        name,
        ...(portType && portType !== "None" ? { portType } : {}),
      },
    });
  }
  return out;
}

/** Where a pin of `netId` sits on the sheet, or null when the net has none drawn. */
function pinOfNet(circuit: Circuit, nodes: Node[], netId: string): FlowPoint | null {
  for (const comp of circuit.components.values()) {
    for (const port of comp.ports) {
      if (port.netId !== netId) continue;
      const node = nodes.find((n) => n.id === comp.id);
      if (!node) continue;
      const handle = port.id.slice(port.id.lastIndexOf("-") + 1);
      const p = getNodePins(node, useUIStore.getState().symbolNorm).find((q) => q.handleId === handle);
      if (p) return { x: Math.round(p.x), y: Math.round(p.y) };
    }
  }
  return null;
}

/** The net a port is on, by the port id the circuit uses (`comp_1-a`). */
function portNet(circuit: Circuit, portId: string): string | undefined {
  const compId = portId.slice(0, portId.lastIndexOf("-"));
  return circuit.components.get(compId)?.ports.find((p) => p.id === portId)?.netId ?? undefined;
}

/** A net id nothing is using yet. */
function freeNetId(circuit: Circuit): string {
  let n = circuit.nets.size + 1;
  while (circuit.nets.has(`net${n}`)) n++;
  return `net${n}`;
}

/** Anchor ids ascend, and the order decides which of a net's names wins. */
function nextAnchorId(anchors: NetAnchor[]): string {
  const max = anchors.reduce((m, a) => Math.max(m, Number(a.id.split("_").pop()) || 0), 0);
  return `anchor_${max + 1}`;
}

function applyNetNames(circuit: Circuit, anchors: NetAnchor[], byAnchor: Map<string, string>): void {
  const ordinal = (id: string) => Number(id.split("_").pop()) || 0;
  const oldest = new Map<string, { id: string; name: string }>();
  for (const a of anchors) {
    const netId = byAnchor.get(a.id);
    const name = a.name.trim();
    if (!name || !netId || netId === "0") continue;
    const cur = oldest.get(netId);
    if (!cur || ordinal(a.id) < ordinal(cur.id)) oldest.set(netId, { id: a.id, name });
  }
  for (const [netId, winner] of oldest) {
    const net = circuit.nets.get(netId);
    if (net) net.nodeLabel = winner.name;
  }
}

export const useCircuitStore = create<CircuitState & CircuitActions>((set, get) => ({
  circuit: new Circuit(),
  nodes: [],
  edges: [],
  selectedComponentId: null,
  netlist: "",
  simulationConfig: DEFAULT_CONFIG,
  spiceDirectives: "",
  directiveRaw: [],
  ascHeader: {},
  ascOrphanWires: [],
  fragmentClipboard: "",
  pasteNotice: null,
  showDirectivesOnCanvas: false,
  directivesPos: { x: 40, y: 40 },
  circuitName: "Untitled",
  dataFlags: [],
  netAnchors: [],
  busTaps: [],
  textBoxes: [],
  sheetShapes: [],
  propertyVersion: 0,
  netVersion: 0,
  viewFitNonce: 0,
  fileHandle: null,
  fileName: null,
  _history: [],
  _future: [],

  addComponent: (component, nodeData) => {
    const snap = { nodes: get().nodes, edges: get().edges };
    get().circuit.addComponent(component);
    set((state) => ({
      nodes: [...state.nodes, nodeData],
      _history: [...state._history, snap],
      _future: [],
    }));
  },

  removeComponent: (id) => {
    const snap = { nodes: get().nodes, edges: get().edges };
    const node = get().nodes.find((n) => n.id === id);
    const doomed = get().edges.filter((e) => e.source === id || e.target === id);

    // Nothing here has to rescue a net's name any more. A name is an anchor, and
    // deleting a part cannot delete one — it sits on the wire, and the wire is
    // bridged below.

    get().circuit.removeComponent(id);

    // Wires that met at one *pin* of the removed part were one net through that
    // pin, so the remaining ends must stay connected to each other — otherwise
    // deleting e.g. a net label shreds the net it sat on. (An import routes a
    // whole net as a star from its first pin; when that is the label, every wire
    // of the net hangs off it.) Bridging is done per pin, never across pins, so
    // deleting a two-terminal part still separates its two nets.
    const pinCoord = new Map(
      (node ? getNodePins(node, useUIStore.getState().symbolNorm) : []).map((p) => [p.handleId, { x: p.x, y: p.y }]),
    );
    const byHandle = new Map<string, Edge[]>();
    for (const e of doomed) {
      const handle = (e.source === id ? e.sourceHandle : e.targetHandle) ?? "";
      if (!byHandle.has(handle)) byHandle.set(handle, []);
      byHandle.get(handle)!.push(e);
    }

    const bridges: Edge[] = [];
    for (const [handle, group] of byHandle) {
      if (group.length < 2) continue;
      // The far end of an edge, plus the route from the removed pin to it.
      const farEnd = (e: Edge) => {
        const atSource = e.source === id;
        const wps = ((e.data?.waypoints as FlowPoint[] | undefined) ?? []);
        return {
          node: atSource ? e.target : e.source,
          handle: atSource ? e.targetHandle : e.sourceHandle,
          // Waypoints are stored source → target; walk them from the removed pin.
          path: atSource ? wps : [...wps].reverse(),
        };
      };
      const first = farEnd(group[0]);
      const via = pinCoord.get(handle);
      for (let i = 1; i < group.length; i++) {
        const other = farEnd(group[i]);
        bridges.push({
          id: `wire_bridge_${first.node}-${first.handle}__${other.node}-${other.handle}_${Date.now()}_${i}`,
          source: first.node,
          sourceHandle: first.handle,
          target: other.node,
          targetHandle: other.handle,
          type: "wire",
          // Route the replacement through the two original paths and the point the
          // removed pin sat on, so the wire keeps the shape it was drawn with. A
          // deleted net terminal leaves its name on this bridging wire (visible).
          data: { waypoints: [...[...first.path].reverse(), ...(via ? [via] : []), ...other.path] },
        });
      }
    }

    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: [...state.edges.filter((e) => e.source !== id && e.target !== id), ...bridges],
      selectedComponentId: state.selectedComponentId === id ? null : state.selectedComponentId,
      _history: [...state._history, snap],
      _future: [],
    }));
    // The bridges are new connections, so the nets have to be rebuilt from them —
    // not every caller does that itself (a plain React Flow node removal doesn't).
    if (bridges.length > 0) setTimeout(() => get().rebuildConnections(), 0);
  },

  updateComponentProperty: (id, key, value) => {
    const component = get().circuit.components.get(id);
    if (!component) return;
    component.setProperty(key, value);
    const type = (get().nodes.find((n) => n.id === id)?.data as { componentType?: ComponentType })?.componentType;
    const valueLabel = type ? getValueLabel(component, type) : undefined;
    // Keep the node's sourceType in sync so the generalized source's symbol updates.
    const sourceType = (component as { sourceType?: string }).sourceType;
    // Likewise the net connector's port type: it is what picks the arrow the node
    // draws, so without this the symbol would keep the old direction.
    const portType = (component as { portType?: string }).portType;
    // A logic gate's symbol is drawn from these, so the node needs them too —
    // otherwise changing the gate or its input count redraws nothing.
    const gateType = (component as { gateType?: string }).gateType;
    const inputs = (component as { inputs?: number }).inputs;
    // Same for the flip-flop: the clock wedge and the Set/Reset bubbles are
    // drawn from these two.
    const edge = (component as { edge?: string }).edge;
    const asyncPolarity = (component as { asyncPolarity?: string }).asyncPolarity;
    const kind = (component as { kind?: string }).kind;
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          // `ascRaw.attrs` records the attribute lines this part was loaded with,
          // and the exporter hands them back verbatim while they still hold. An
          // edit here is exactly the event that invalidates them, so drop them
          // and let the exporter write what the component now says. The `windows`
          // half survives: a value edit says nothing about caption placement.
          ? { ...n, data: { ...n.data, label: component.label, ascRaw: { ...(n.data as { ascRaw?: { windows?: Record<number, string> } }).ascRaw, attrs: undefined }, ...(valueLabel !== undefined && { valueLabel }), ...(sourceType !== undefined && { sourceType }), ...(portType !== undefined && { portType }), ...(gateType !== undefined && { gateType }), ...(inputs !== undefined && { inputs }), ...(edge !== undefined && { edge }), ...(asyncPolarity !== undefined && { asyncPolarity }), ...(kind !== undefined && { kind }) } }
          : n,
      ),
      propertyVersion: state.propertyVersion + 1,
    }));
    get().regenerateNetlist();
  },

  setLabelOffset: (id, kind, offset) => {
    const key = kind === "label" ? "labelOffset" : "valueOffset";
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, [key]: offset } } : n)),
    }));
  },

  updateNodeData: (id, patch) => {
    const snap = { nodes: get().nodes, edges: get().edges };
    set((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
      _history: [...state._history, snap],
      _future: [],
    }));
  },

  updateEdgeData: (id, patch) => {
    const snap = { nodes: get().nodes, edges: get().edges };
    set((state) => ({
      edges: state.edges.map((e) => (e.id === id ? { ...e, data: { ...e.data, ...patch } } : e)),
      _history: [...state._history, snap],
      _future: [],
    }));
  },

  setNodes: (nodes) => set({ nodes }),

  setEdges: (edges) => {
    const snap = { nodes: get().nodes, edges: get().edges };
    set((state) => ({ edges, _history: [...state._history, snap], _future: [] }));
  },

  setSelectedComponentId: (id) => set({ selectedComponentId: id }),

  connectPorts: (portIdA, portIdB) => {
    get().circuit.connectPorts(portIdA, portIdB);
    set((state) => ({ netVersion: state.netVersion + 1 }));
    get().regenerateNetlist();
  },

  regenerateNetlist: () => {
    const { circuit, simulationConfig, spiceDirectives, netAnchors } = get();
    // Anchors name their net, so nets sharing a name collapse to one node (which
    // is how distant parts connect). Where several name one net, the same winner
    // is chosen as everywhere else — this used to impose each name in turn,
    // letting whichever came last win.
    applyNetNames(circuit, netAnchors, resolveAnchors(get(), useUIStore.getState().symbolNorm));
    const generator = new NetlistGenerator();
    const libraryBlocks = useLibraryStore.getState().getDefinitionBlocks();
    const netlist = generator.generate(circuit, simulationConfig, spiceDirectives, undefined, libraryBlocks);
    set({ netlist });
  },

  setSimulationConfig: (config) => {
    // If the SPICE-directives text carries an analysis line (e.g. imported from
    // an `.asc`), it overrides the config in the netlist — so rewrite that line
    // to the chosen analysis, otherwise switching the Analysis-Type dropdown
    // would have no effect.
    set((state) => ({ simulationConfig: config, spiceDirectives: syncAnalysisDirective(state.spiceDirectives, config) }));
    get().regenerateNetlist();
  },

  setSpiceDirectives: (text) => {
    set({ spiceDirectives: text });
    get().regenerateNetlist();
  },

  setShowDirectivesOnCanvas: (show) => set({ showDirectivesOnCanvas: show }),

  moveDirectivesBox: (x, y) => set({ directivesPos: { x, y } }),

  setCircuitName: (name) => set({ circuitName: name }),

  renameNet: (netId, label) => {
    const { circuit, edges, netAnchors, nodes } = get();
    const net = circuit.nets.get(netId);
    if (!net) return;
    const oldLabel = net.nodeLabel;
    const newLabel = label.trim() || netId;
    if (oldLabel === newLabel) return;
    net.nodeLabel = newLabel;

    // Naming a net *is* placing a flag on it. There is no other slot for the
    // name: the `.asc` writes `FLAG x y NAME` and nothing else, so a name held
    // anywhere but on an anchor would survive the session and vanish on save.
    //
    // Which anchors this touches: the ones lying on the net. Renaming rewrites
    // the one that currently names it (the oldest, the one applyNetNames picked)
    // and leaves the others alone — they are aliases the file records on purpose,
    // and rewriting them would turn `leitungstest.asc`'s `x2` into a second `x1`.
    const byAnchor = resolveAnchors(get(), useUIStore.getState().symbolNorm);
    const mine = netAnchors.filter((a) => byAnchor.get(a.id) === netId);
    const ordinal = (id: string) => Number(id.split("_").pop()) || 0;
    const winner = mine.slice().sort((a, b) => ordinal(a.id) - ordinal(b.id))[0];

    // Clearing the name back to the auto id takes the flag away with it, so a net
    // never keeps a tag that says nothing.
    const clearing = newLabel === netId;

    let next: NetAnchor[];
    if (clearing) {
      next = netAnchors.filter((a) => !mine.includes(a));
    } else if (winner) {
      next = netAnchors.map((a) => (a.id === winner.id ? { ...a, name: newLabel } : a));
    } else {
      // Nothing names this net yet: put the name on the wire the user is looking
      // at — the selected one, else any of the net — at its midpoint, which is
      // where a name reads best and is clear of the parts at either end.
      const onNetEdge = (e: Edge) =>
        portNet(circuit, `${e.source}-${e.sourceHandle}`) === netId || portNet(circuit, `${e.target}-${e.targetHandle}`) === netId;
      const host = edges.find((e) => e.selected && onNetEdge(e)) ?? edges.find(onNetEdge);
      // No wire at all — a net that is a single pin, or two pins docked directly
      // together. The name goes on the pin itself, which an anchor may now do:
      // with the lead gone a pin is just another place a name can sit, and it is
      // the only place this net has.
      const at = (host ? labelAnchor(host, nodes) : null) ?? pinOfNet(circuit, nodes, netId);
      next = at ? [...netAnchors, { id: nextAnchorId(netAnchors), x: at.x, y: at.y, name: newLabel }] : netAnchors;
    }

    set((state) => ({
      netVersion: state.netVersion + 1,
      netAnchors: next,
      // Keep data-point expressions pointing at the renamed net.
      dataFlags: state.dataFlags.map((d) => ({ ...d, expr: renameNetInProbe(d.expr, oldLabel, newLabel) })),
    }));
    // Naming a net "GND" / "0" makes it ground; the merge happens on the rebuild.
    if (/^(0|gnd)$/i.test(newLabel)) setTimeout(() => get().rebuildConnections(), 0);
    get().regenerateNetlist();
    // Carry the rename into the waveform so plotted traces follow the new name
    // (both immediately and after a re-run), instead of keeping the old label.
    useSimulationStore.getState().renameNetVariable(oldLabel, newLabel);
    usePlotStore.getState().renameTraceNet(oldLabel, newLabel);
  },

  addNetAnchor: (x, y, name, portType) => {
    const id = nextAnchorId(get().netAnchors);
    set((state) => ({
      netAnchors: [...state.netAnchors, { id, x: Math.round(x), y: Math.round(y), name, ...(portType && portType !== "None" ? { portType } : {}) }],
    }));
    get().rebuildConnections();
    return id;
  },

  updateNetAnchor: (id, patch) => {
    // An emptied name is a deleted flag, not a nameless one: `FLAG x y` with no
    // name is not a line LTSpice writes, and an invisible anchor could never be
    // grabbed again.
    if (patch.name !== undefined && !patch.name.trim()) { get().removeNetAnchor(id); return; }
    set((state) => ({ netAnchors: state.netAnchors.map((a) => (a.id === id ? { ...a, ...patch } : a)) }));
    get().rebuildConnections();
  },

  moveNetAnchor: (id, x, y) => {
    // Moving a name can move it onto a different wire, which renames two nets at
    // once — so the net rebuild runs on every move, not just at the end of the
    // drag. That is what makes the anchor model behave: the name follows the
    // geometry instead of remembering what it used to be attached to.
    set((state) => ({ netAnchors: state.netAnchors.map((a) => (a.id === id ? { ...a, x: Math.round(x), y: Math.round(y) } : a)) }));
    get().rebuildConnections();
  },

  removeNetAnchor: (id) => {
    set((state) => ({ netAnchors: state.netAnchors.filter((a) => a.id !== id) }));
    get().rebuildConnections();
  },

  addDataFlag: (x, y, expr) =>
    set((state) => ({
      dataFlags: [...state.dataFlags, { id: `df_${Date.now()}_${state.dataFlags.length}`, x, y, expr }],
    })),

  removeDataFlag: (id) => set((state) => ({ dataFlags: state.dataFlags.filter((d) => d.id !== id) })),

  addTextBox: (x, y) => {
    const id = `tb_${Date.now()}_${get().textBoxes.length}`;
    set((state) => ({
      textBoxes: [...state.textBoxes, {
        id, x, y,
        width: TEXTBOX_DEFAULT_W, height: TEXTBOX_DEFAULT_H,
        text: "", markdown: false,
        // A new box starts where LTSpice starts one: upright, at the default size.
        justify: "Left" as const, size: TEXT_SIZE_DEFAULT,
      }],
    }));
    return id;
  },

  updateTextBox: (id, patch) =>
    set((state) => ({
      textBoxes: state.textBoxes.map((t) => {
        if (t.id !== id) return t;
        // A box the user has actually resized is no longer auto-sized, so its
        // size must now be written to the file (see textBox.encodeTextBox).
        const resized = patch.width !== undefined || patch.height !== undefined;
        return { ...t, ...patch, ...(resized ? { autoSized: false } : {}) };
      }),
    })),

  removeTextBox: (id) => set((state) => ({ textBoxes: state.textBoxes.filter((t) => t.id !== id) })),

  moveDataFlag: (id, x, y) =>
    set((state) => ({ dataFlags: state.dataFlags.map((d) => (d.id === id ? { ...d, x, y } : d)) })),

  loadFromAsc: (ascContent) => {
    const { nodes, edges, directives, components, dataFlags, textBoxes, sheetShapes, directiveRaw, header, orphanWires, anchors, busTaps } = LTSpiceParser.parse(ascContent);
    const snap = { nodes: get().nodes, edges: get().edges };

    // A new circuit starts with a fresh diagram: linear axes on auto-range, no
    // colours or functions carried over from the circuit before it. A sibling
    // `.plt` is applied after this load and overrides it (see Toolbar). The
    // simulation state goes too — its result and probes belong to nets of the
    // previous circuit, so the plot would keep drawing the old curves.
    usePlotStore.getState().resetSettings();
    useSimulationStore.getState().reset();

    const newCircuit = new Circuit();
    for (const comp of components) {
      // A library part is referenced by name in the `.asc` (as in LTSpice); the
      // `.subckt` body itself lives in the library, so re-link it here. Without
      // it the netlist line would point at an undefined subcircuit.
      const sub = comp as unknown as { spiceModel?: string; label: string };
      if (sub.spiceModel === "") {
        const name = String((nodes.find((n) => n.id === comp.id)?.data as { subName?: string })?.subName ?? "");
        const entry = name ? useLibraryStore.getState().findByName(name)?.entry : undefined;
        if (entry?.kind === "subckt") sub.spiceModel = entry.raw;
      }
      newCircuit.addComponent(comp);
    }

    set((state) => ({
      circuit: newCircuit,
      nodes,
      edges,
      spiceDirectives: directives,
      directiveRaw,
      ascHeader: header,
      ascOrphanWires: orphanWires,
      dataFlags,
      netAnchors: anchors,
      busTaps,
      textBoxes,
      sheetShapes,
      selectedComponentId: null,
      viewFitNonce: state.viewFitNonce + 1,
      _history: [...state._history, snap],
      _future: [],
    }));
    setTimeout(() => {
      get().rebuildConnections();
      // A named `FLAG` already arrives as a net-label terminal, and
      // `applyNetNames` gives its net that name — so nothing more is needed here
      // for an imported `V(U1)` to resolve.
      //
      // This used to call `renameNet` once per flag, which renames *every*
      // terminal on the net. On a net carrying two names that meant the second
      // flag overwrote the first, and the file lost a name simply by being
      // opened. It stayed hidden for a while because `netNames` only lists flags
      // that could be tied to a real device pin: `leitungstest.asc` has no
      // devices at all, so it looked fine there while every real schematic was
      // affected.
      // Auto-apply the loaded directives: adopt the file's analysis command
      // (.tran/.ac/.dc/.op) into the sim config so the Simulation Panel and plot
      // match — no need to open the SPICE Directives dialog and press Apply.
      const analysis = directives.split("\n").map(parseAnalysisDirective).find((c): c is SimulationConfig => c !== null);
      if (analysis) get().setSimulationConfig(analysis);
      else get().regenerateNetlist();
    }, 0);
  },

  setFileHandle: (handle, name) => set({ fileHandle: handle, fileName: name }),

  /**
   * Inserts a `.asc` fragment (see ascFragment) and leaves it selected, so the
   * user can drag it straight into place.
   *
   * The fragment is parsed exactly like a file — same geometry, same attribute
   * handling — and then reconciled with what is already on the sheet:
   *   - ids start above the ones in use, so nothing collides,
   *   - devices are renumbered on a designator clash (two `R1` would be one part
   *     to SPICE), while net labels keep their name because that name *is* the
   *     connection the user is pasting for,
   *   - the whole block is shifted so its top-left lands on `at`.
   *
   * Returns the number of parts inserted, or 0 when the text was not a fragment.
   */
  pasteFragment: (text, at) => {
    if (!isFragment(text)) return 0;
    const { nodes: cur, edges: curEdges, circuit } = get();

    // Start the generated ids above everything in play.
    const usedNums = [...circuit.components.keys(), ...cur.map((n) => n.id)]
      .map((id) => parseInt(String(id).split("_").pop() ?? "", 10))
      .filter((n) => !isNaN(n));
    const idStart = (usedNums.length ? Math.max(...usedNums) : 0) + 1;

    const parsed = LTSpiceParser.parse(text, { idStart });
    if (parsed.nodes.length === 0) return 0;

    // Move the block so its top-left corner sits at the drop point.
    const origin = fragmentOrigin(parsed.nodes);
    const dx = at ? Math.round(at.x - origin.x) : 0;
    const dy = at ? Math.round(at.y - origin.y) : 0;

    // A `.subckt` the fragment brought along is taken into the library, so the
    // pasted part resolves even in a circuit that has never seen that model.
    // Scoped `temp`: it arrived with a paste rather than by a deliberate import,
    // so it serves this session without settling into localStorage.
    const carried = fragmentModels(parsed.directives);
    if (carried.length) {
      const lib = useLibraryStore.getState();
      const fresh = carried.filter((m) => !lib.findByName(m.name));
      if (fresh.length) {
        lib.addEntries(
          fresh.flatMap((m) => ModelParser.parse(m.raw).entries.filter((e) => e.kind === "subckt")),
          "temp",
        );
      }
    }

    const taken = new Set([...circuit.components.values()].map((c) => c.label));
    const snap = { nodes: cur, edges: curEdges };

    // Net names that the sheet already used. Keeping them is deliberate — it is
    // what LTSpice does and how a pasted block is meant to join an existing one —
    // but it is also invisible: the two circuits become one net without anything
    // on screen saying so. Collected here so the paste can report it.
    const existingNetNames = new Set(get().netAnchors.map((a) => a.name));
    const merged = new Set<string>();

    // The names inside the fragment come along, shifted like everything else. A
    // name whose text is already on the sheet joins that net — which is the point
    // of pasting one, and is what gets reported.
    let anchorSeed = get().netAnchors;
    const pastedAnchors = parsed.anchors.map((a) => {
      const id = nextAnchorId(anchorSeed);
      const shifted = { ...a, id, x: Math.round(a.x + dx), y: Math.round(a.y + dy) };
      anchorSeed = [...anchorSeed, shifted];
      if (!isGroundName(a.name) && existingNetNames.has(a.name)) merged.add(a.name);
      return shifted;
    });

    for (const comp of parsed.components) {
      const node = parsed.nodes.find((n) => n.id === comp.id);
      const type = (node?.data as { componentType?: ComponentType })?.componentType;
      const label = pasteLabelFor(type, comp.label, taken);
      if (label !== comp.label) comp.setProperty("label", label);
      taken.add(label);
      comp.position = { x: comp.position.x + dx, y: comp.position.y + dy };
      // Same re-link as loadFromAsc: the `.asc` names the subcircuit but does not
      // define it, and `CustomSubcircuit.getNetlistLine` reads the name back out
      // of `spiceModel` — left empty, the part netlists as `UNKNOWN`.
      const sub = comp as unknown as { spiceModel?: string };
      if (sub.spiceModel === "") {
        const name = String((node?.data as { subName?: string })?.subName ?? "");
        const entry = name ? useLibraryStore.getState().findByName(name)?.entry : undefined;
        if (entry?.kind === "subckt") sub.spiceModel = entry.raw;
      }
      circuit.addComponent(comp);
    }

    // Fresh ids for the pasted wires. The parser numbers edges from `edge_1` on
    // every run, so a fragment arrives carrying exactly the ids the sheet already
    // uses — and React Flow keys its elements by id, which made the *original*
    // wires disappear behind the pasted ones. (`idStart` covers the nodes; edges
    // are numbered separately and were missed.)
    const usedEdgeIds = new Set(curEdges.map((e) => e.id));
    const shift = (p?: { x: number; y: number }) => (p ? { x: p.x + dx, y: p.y + dy } : p);
    const pastedEdges = parsed.edges.map((e) => {
      let id = e.id;
      for (let n = 1; usedEdgeIds.has(id); n++) id = `${e.id}_${n}`;
      usedEdgeIds.add(id);
      // A wire's shape is not carried by its ends alone: the waypoints and tap
      // points are absolute coordinates too, and moving only the parts left them
      // where the block was copied from. The wire then ran from the pasted pin
      // all the way back to the original's coordinates and down again — long
      // strokes across the sheet that looked like the paste had wired itself
      // into the circuit it came from.
      const d = (e.data ?? {}) as { waypoints?: { x: number; y: number }[]; sourceTap?: { x: number; y: number }; targetTap?: { x: number; y: number } };
      return {
        ...e,
        id,
        data: {
          ...d,
          ...(d.waypoints ? { waypoints: d.waypoints.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : {}),
          ...(d.sourceTap ? { sourceTap: shift(d.sourceTap) } : {}),
          ...(d.targetTap ? { targetTap: shift(d.targetTap) } : {}),
        },
      };
    });

    const added = parsed.nodes.map((n) => ({
      ...n,
      position: { x: n.position.x + dx, y: n.position.y + dy },
      // Selected, so the paste can be dragged, rotated or deleted as one block
      // without hunting for the parts that just appeared.
      selected: true,
      data: { ...n.data, label: circuit.components.get(n.id)?.label ?? (n.data as { label?: string }).label },
    }));

    set((state) => ({
      nodes: [...state.nodes.map((n) => (n.selected ? { ...n, selected: false } : n)), ...added],
      edges: [...state.edges.map((e) => (e.selected ? { ...e, selected: false } : e)), ...pastedEdges],
      netAnchors: [...state.netAnchors, ...pastedAnchors],
      _history: [...state._history, snap],
      _future: [],
    }));
    setTimeout(() => get().rebuildConnections(), 0);
    if (merged.size) set({ pasteNotice: [...merged].sort() });
    return added.length;
  },

  setFragmentClipboard: (text) => set({ fragmentClipboard: text }),

  clearPasteNotice: () => set({ pasteNotice: null }),

  clearCircuit: () => {
    const snap = { nodes: get().nodes, edges: get().edges };
    const newCircuit = new Circuit();
    usePlotStore.getState().resetSettings();
    useSimulationStore.getState().reset();
    set((state) => ({
      circuit: newCircuit,
      nodes: [],
      edges: [],
      selectedComponentId: null,
      netlist: "",
      circuitName: "Untitled",
      dataFlags: [],
      netAnchors: [],
      busTaps: [],
      textBoxes: [],
      sheetShapes: [],
      // A new schematic starts blank: the previous circuit's SPICE directives
      // (and the analysis they configured) would otherwise still drive the next
      // simulation — a `.step`/`.meas` over parts that no longer exist.
      spiceDirectives: "",
      directiveRaw: [],
      ascHeader: {},
      ascOrphanWires: [],
      simulationConfig: DEFAULT_CONFIG,
      showDirectivesOnCanvas: false,
      directivesPos: { x: 40, y: 40 },
      fileHandle: null,
      fileName: null,
      _history: [...state._history, snap],
      _future: [],
    }));
  },

  undo: () => {
    const { _history, _future, nodes, edges } = get();
    if (_history.length === 0) return;
    const prev = _history[_history.length - 1];
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      _history: _history.slice(0, -1),
      _future: [{ nodes, edges }, ..._future],
    });
  },

  redo: () => {
    const { _history, _future, nodes, edges } = get();
    if (_future.length === 0) return;
    const next = _future[0];
    set({
      nodes: next.nodes,
      edges: next.edges,
      _history: [..._history, { nodes, edges }],
      _future: _future.slice(1),
    });
  },

  canUndo: () => get()._history.length > 0,
  canRedo: () => get()._future.length > 0,

  rotateSelected: () => {
    const { selectedComponentId, rotateComponent } = get();
    if (selectedComponentId) rotateComponent(selectedComponentId);
  },

  rotateComponent: (id) => {
    const { circuit } = get();
    const comp = circuit.components.get(id);
    if (!comp) return;
    const snap = { nodes: get().nodes, edges: get().edges };
    comp.rotate(270); // 270° CW == 90° counter-clockwise (rotate left)
    const nodes = get().nodes.map((n) =>
      n.id === id ? { ...n, data: { ...n.data, rotation: comp.rotation } } : n,
    );
    // The turned part's pins have moved; let its wires meet whichever pin is now
    // nearest instead of crossing the body. Half a turn therefore also reverses
    // the part's SPICE node order — which is the point, not a side effect: the
    // symbol's current arrow turned with it (see pinReseat).
    const turned = nodes.find((n) => n.id === id)!;
    const prevEdges = get().edges;
    const edges = reseatTwoPinEdges(turned, nodes, prevEdges) ?? prevEdges;
    // One `set`, one history entry: undo must put the orientation *and* the
    // wires back together, or half an undo leaves the schematic crossed.
    set((state) => ({ nodes, edges, _history: [...state._history, snap], _future: [] }));
    // Re-seating moved ports between nets, so the netlist has to be rebuilt.
    if (edges !== prevEdges) get().rebuildConnections();
  },

  mirrorSelected: () => {
    const { selectedComponentId } = get();
    if (!selectedComponentId) return;
    // Mirroring moves the pins just as a rotation does — and a flip along the
    // pin axis reverses their order, so the wires are re-seated by the same rule
    // and the part's SPICE node order turns with its drawing (see pinReseat).
    const snap = { nodes: get().nodes, edges: get().edges };
    const nodes = get().nodes.map((n) =>
      n.id === selectedComponentId
        ? { ...n, data: { ...n.data, mirrored: !(n.data as { mirrored?: boolean }).mirrored } }
        : n,
    );
    const flipped = nodes.find((n) => n.id === selectedComponentId)!;
    const prevEdges = get().edges;
    const edges = reseatTwoPinEdges(flipped, nodes, prevEdges) ?? prevEdges;
    set((state) => ({ nodes, edges, _history: [...state._history, snap], _future: [] }));
    if (edges !== prevEdges) get().rebuildConnections();
    set((state) => ({ netVersion: state.netVersion + 1 }));
  },

  deleteSelected: () => {
    const { selectedComponentId, nodes, removeComponent, edges, setEdges, rebuildConnections } = get();
    let changed = false;
    // Delete only what is *actually* selected in the canvas. Selecting a wire
    // deselects any node, so we must not fall back to a stale selectedComponentId
    // (that would also delete e.g. a previously-selected ground).
    const selectedNodes = nodes.filter((n) => n.selected);
    const nodeIds = selectedNodes.length > 0
      ? selectedNodes.map((n) => n.id)
      // No node carries the ReactFlow selection flag: only honour the tracked
      // selection when no wire is selected (keyboard/toolbar delete of a part).
      : (selectedComponentId && !edges.some((e) => e.selected) ? [selectedComponentId] : []);
    for (const id of nodeIds) {
      removeComponent(id);
      changed = true;
    }
    const selectedEdges = edges.filter(e => e.selected);
    if (selectedEdges.length > 0) {
      setEdges(edges.filter(e => !e.selected));
      changed = true;
    }
    if (changed) {
      setTimeout(() => rebuildConnections(), 0);
    }
  },

  rebuildConnections: () => {
    const { circuit, edges } = get();
    // Nothing is carried over from the previous nets. A name lives on an anchor
    // and nowhere else, so re-deriving it from the geometry below is the whole
    // point: a name restored from the last rebuild would outlive the anchor that
    // produced it, and deleting a flag would leave its name behind.

    // Disconnect all ports
    for (const comp of circuit.components.values()) {
      for (const port of comp.ports) {
        if (port.id !== `${comp.id}-gnd`) port.disconnect();
      }
    }
    
    // Remove all nets, then (re)create the single ground net "0" if any ground
    // component exists. Recreating it even when it was lost keeps GND robust.
    const prevGround = circuit.nets.get("0");
    circuit.nets.clear();
    const hasGround = [...circuit.components.values()].some((c) => c.id.startsWith("ground_"));
    if (hasGround) {
      const groundNet = prevGround ?? new Net("0", "GND");
      if (groundNet.nodeLabel === "0") groundNet.nodeLabel = "GND";
      groundNet.connectedPortIds.clear();
      for (const comp of circuit.components.values()) {
        if (comp.id.startsWith("ground_")) {
          comp.ports[0].connect("0");
          groundNet.addPort(`${comp.id}-gnd`);
        }
      }
      circuit.nets.set("0", groundNet);
    }

    // Reconnect based on edges
    for (const edge of edges) {
      if (edge.source && edge.sourceHandle && edge.target && edge.targetHandle) {
        try {
          circuit.connectPorts(`${edge.source}-${edge.sourceHandle}`, `${edge.target}-${edge.targetHandle}`);
        } catch { /* visual-only */ }
      }
    }

    // ── Where the names land ───────────────────────────────────────────────
    // Every name on the sheet is a coordinate, so this is the one place that
    // asks the geometry which net each one is sitting on. It has to run here,
    // after the edges have rebuilt the nets and before anything reads a name:
    // moving a wire out from under a name un-names its net, and that has to be
    // as true as moving the name out from under the wire.
    const anchors = get().netAnchors;
    const norm = useUIStore.getState().symbolNorm;
    let byAnchor = resolveAnchors(get(), norm);

    // A name dropped on a bare pin *makes* that pin a net.
    //
    // Until a wire touches it, a pin is on no net at all — so a flag sitting on
    // one had nothing to resolve to and named nothing. That is not what the
    // format means: LTSpice ties a supply pin to its rail with a flag and no wire
    // whatsoever, which is how `+UB`/`-UB` reach an op-amp in half our examples.
    // Two nets that end up with the same name are one node in the netlist, and
    // that is exactly how such a pin joins the rail.
    const unresolved = anchors.filter((a) => !byAnchor.has(a.id) && a.name.trim());
    if (unresolved.length > 0) {
      const bare: { portId: string; x: number; y: number }[] = [];
      for (const n of get().nodes) {
        for (const p of getNodePins(n, norm)) {
          const portId = `${n.id}-${p.handleId}`;
          if (!portNet(circuit, portId)) bare.push({ portId, x: p.x, y: p.y });
        }
      }
      // A name may reach its pin along a chain of stubs rather than sitting on
      // it: LTSpice runs a supply rail out of an op-amp's V+ over two or three
      // segments and parks the flag at the end. Neither the flag nor the pin is
      // on a net, so only the chain connects them.
      const groups = orphanGroups(get().ascOrphanWires);
      let made = false;
      for (const a of unresolved) {
        const via = groups.find((g) => touchesGroup({ x: a.x, y: a.y }, g));
        const reaches = (b: { x: number; y: number }) =>
          Math.hypot(b.x - a.x, b.y - a.y) <= ANCHOR_TOLERANCE || (!!via && touchesGroup(b, via));
        let best = Infinity, hit: typeof bare[number] | undefined;
        for (const b of bare) {
          if (!reaches(b)) continue;
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          if (d < best) { best = d; hit = b; }
        }
        if (!hit) continue;
        const comp = circuit.components.get(hit.portId.slice(0, hit.portId.lastIndexOf("-")));
        const port = comp?.ports.find((p) => p.id === hit!.portId);
        if (!port) continue;
        const netId = freeNetId(circuit);
        const net = new Net(netId, netId);
        circuit.nets.set(netId, net);
        port.connect(netId);
        net.addPort(port.id);
        made = true;
      }
      // Those pins are on nets now, so ask again — including for the names that
      // only reach one *through* such a pin.
      if (made) byAnchor = resolveAnchors(get(), norm);
    }

    // A name reading "0" or "GND" *is* ground — merge its net into net "0",
    // exactly as LTSpice treats a "0" flag. Otherwise it became a SPICE node
    // literally called GND, sitting next to the real ground node "0": the circuit
    // looked earthed but was floating, and two nets displayed the same name.
    const isGroundName = (s: string) => /^(0|gnd)$/i.test(s.trim());
    for (const a of anchors) {
      const netId = byAnchor.get(a.id);
      if (!isGroundName(a.name) || !netId || netId === "0") continue;

      const groundNet = circuit.nets.get("0") ?? new Net("0", "GND");
      circuit.nets.set("0", groundNet);
      // Move every port of that net over to ground, then drop the empty net.
      for (const other of circuit.components.values()) {
        for (const port of other.ports) {
          if (port.netId === netId) {
            port.connect("0");
            groundNet.addPort(port.id);
          }
        }
      }
      circuit.nets.delete(netId);
      // The merge renumbered the ports, so anything resolved against the old net
      // id now points at a net that is gone.
      for (const [anchorId, nid] of byAnchor) if (nid === netId) byAnchor.set(anchorId, "0");
    }

    // ── The net's name for the netlist ─────────────────────────────────────
    // One name wins (see applyNetNames); the net's other names stand. They are
    // aliases for the same net, exactly as LTSpice stores them, and rewriting
    // them here would change the user's file the moment they opened it.
    applyNetNames(circuit, anchors, byAnchor);

    set((state) => ({ netVersion: state.netVersion + 1 }));
    get().regenerateNetlist();
  },

  exportSnapshot: () => {
    const { nodes, edges, spiceDirectives, simulationConfig, circuit, circuitName, dataFlags, textBoxes, sheetShapes, showDirectivesOnCanvas, directivesPos } = get();
    const componentProps: Record<string, Record<string, string | number>> = {};
    // serialize(), not getProperties(): the property list only holds the fields
    // the UI currently shows, so a source in DC mode would save no sine fields
    // and lose e.g. a configured phase on reload.
    for (const [id, comp] of circuit.components) componentProps[id] = comp.serialize();
    // Persist the active scope: after a run these are ngspice-resolved names; if
    // the circuit was never run they still sit in pendingProbes. Union covers both.
    const sim = useSimulationStore.getState();
    const selectedVariables = [...new Set([...sim.selectedVariables, ...sim.pendingProbes])];
    return { version: 1, nodes, edges, netAnchors: get().netAnchors, busTaps: get().busTaps, circuitName, spiceDirectives, simulationConfig, componentProps, dataFlags, textBoxes, sheetShapes, showDirectivesOnCanvas, directivesPos, plotSettings: currentPlotSettings(), selectedVariables };
  },

  loadFromSnapshot: (snapshot) => {
    const newCircuit = new Circuit();
    const rebuiltNodes = snapshot.nodes.map((n) => ({ ...n }));
    // Anything written before names became coordinates carries them as nodes.
    // Those links are already out in the world — printed on worksheets, pasted
    // into course material — so they are converted here rather than rejected.
    const legacy = snapshot.netAnchors ? [] : legacyNameNodes(rebuiltNodes);

    for (const node of rebuiltNodes) {
      const type = (node.data as { componentType?: ComponentType }).componentType;
      if (!type) continue;
      const label = String((node.data as { label?: string }).label ?? node.id);
      const { x, y } = node.position;
      const props = snapshot.componentProps[node.id];
      // A library part's ports are its own external pins — createSpiceComponent
      // would give it the generic in/out/gnd trio, whose port ids no edge handle
      // matches, silently disconnecting the part on every share-link reload.
      const subPins = (node.data as { pins?: string[] }).pins;
      const comp = type === "subcircuit"
        ? createSubcircuitComponent(node.id, label, x, y, String(props?.spiceModel ?? ""), subPins ?? [])
        : createSpiceComponent(type, node.id, label, x, y);
      if (props) comp.deserialize(props);
      const rotation = (node.data as { rotation?: number }).rotation;
      if (rotation) {
        const steps = (rotation / 90) % 4;
        for (let i = 0; i < steps; i++) comp.rotate(90);
      }
      newCircuit.addComponent(comp);
    }

    set({
      circuit: newCircuit,
      nodes: rebuiltNodes,
      edges: snapshot.edges.map((e) => ({ ...e })),
      circuitName: snapshot.circuitName ?? "Untitled",
      spiceDirectives: snapshot.spiceDirectives,
      simulationConfig: snapshot.simulationConfig,
      dataFlags: snapshot.dataFlags ?? [],
      // The converted names go in as anchors; the nodes they came from are taken
      // out below, once the nets have been built from them — removing a node
      // bridges the wires that met at it, which is what keeps the net whole.
      netAnchors: snapshot.netAnchors ?? legacy.map((l) => l.anchor),
      busTaps: snapshot.busTaps ?? [],
      textBoxes: snapshot.textBoxes ?? [],
      sheetShapes: snapshot.sheetShapes ?? [],
      showDirectivesOnCanvas: snapshot.showDirectivesOnCanvas ?? false,
      directivesPos: snapshot.directivesPos ?? { x: 40, y: 40 },
      selectedComponentId: null,
      viewFitNonce: get().viewFitNonce + 1,
      fileHandle: null,
      fileName: null,
      _history: [],
      _future: [],
    });

    // Restore the saved diagram config (panels, axes, colours, functions). The
    // trace names were captured against this snapshot's own net labels, so they
    // are imported verbatim — no re-resolving needed. Legacy snapshots without
    // it leave the current plot config untouched. importSettings ignores an
    // invalid/empty payload.
    if (snapshot.plotSettings) usePlotStore.getState().importSettings(snapshot.plotSettings);
    // Restore the active scope as pending probes: the next run resolves them and
    // plots the author's chosen signals straight away. Done before the rename
    // pass below so renameNetVariable rewrites these probes too.
    useSimulationStore.getState().loadProbes(snapshot.selectedVariables ?? []);

    setTimeout(() => {
      get().rebuildConnections();

      if (snapshot.netAnchors) return;

      // ── Converting a snapshot from before the switch ────────────────────
      // The label nodes are gone from the model but still in this payload. They
      // are removed *after* the rebuild, through the normal delete path, because
      // that path bridges the wires that met at the node: an imported net is
      // routed as a star from its first pin, and when that pin is the label,
      // every wire of the net hangs off it. Dropping the node outright would
      // shred the net; the anchor is already sitting on the bridged wire.
      for (const l of legacy) get().removeComponent(l.id);

      // Names that were never a node — typed into the net-name field, kept only
      // in the payload's net maps. Naming the net places the anchor for them, so
      // a link written that way keeps its names too.
      const named = new Set(legacy.map((l) => l.anchor.name));
      for (const [portId, label] of Object.entries(snapshot.netLabelPorts ?? {})) {
        if (named.has(label)) continue;
        for (const comp of get().circuit.components.values()) {
          const port = comp.ports.find((p) => p.id === portId);
          if (port?.netId && port.netId !== "0") { get().renameNet(port.netId, label); named.add(label); break; }
        }
      }
      // Older still: keyed by net id, which the rebuild may have re-assigned.
      // Tried last and only for names nothing else has placed.
      for (const [netId, label] of Object.entries(snapshot.netLabels ?? {})) {
        if (!named.has(label)) get().renameNet(netId, label);
      }
    }, 0);
  },
}));

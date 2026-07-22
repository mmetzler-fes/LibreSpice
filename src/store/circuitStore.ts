import { create } from "zustand";
import type { Node, Edge } from "@xyflow/react";
import { Circuit } from "@core/circuit/Circuit.js";
import { Net } from "@core/circuit/Net.js";
import { TEXTBOX_DEFAULT_W, TEXTBOX_DEFAULT_H, type TextBox } from "@core/circuit/textBox.js";
import type { SheetShape } from "@core/circuit/sheetShape.js";
import { NetlistGenerator, parseAnalysisDirective, syncAnalysisDirective, type SimulationConfig } from "@core/circuit/NetlistGenerator.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import { getValueLabel, createSpiceComponent, createSubcircuitComponent, nextComponentId } from "@editor/componentFactory.js";
import { getNodePins, NODE_SIZE } from "@editor/pinGeometry.js";
import { reseatTwoPinEdges } from "@editor/pinReseat.js";
import { useUIStore } from "./uiStore.js";
import type { FlowPoint } from "@editor/WireTool.js";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import type { DirectiveRaw } from "@core/ltspice/ascPreserve.js";
import { fragmentOrigin, isFragment, pasteLabelFor } from "@core/ltspice/ascFragment.js";
import { renameNetInProbe } from "@core/circuit/probeUtils.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import { useLibraryStore } from "./libraryStore.js";
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
  /** Show the SPICE directives as a text box on the schematic (LTSpice-style). */
  showDirectivesOnCanvas: boolean;
  /** Position (flow coords) of the on-canvas directive text box. */
  directivesPos: { x: number; y: number };
  /** User-facing diagram/circuit name; default file name for .asc and .plt. */
  circuitName: string;
  /** Positioned data-point annotations (LTSpice DATAFLAGs). */
  dataFlags: DataFlag[];
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
  addDataFlag: (x: number, y: number, expr: string) => void;
  removeDataFlag: (id: string) => void;
  addTextBox: (x: number, y: number) => string;
  updateTextBox: (id: string, patch: Partial<TextBox>) => void;
  removeTextBox: (id: string) => void;
  moveDataFlag: (id: string, x: number, y: number) => void;
  loadFromAsc: (ascContent: string) => void;
  /** Insert a `.asc` fragment at `at` (flow coords); returns how many parts landed. */
  pasteFragment: (text: string, at?: { x: number; y: number }) => number;
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
  showDirectivesOnCanvas: false,
  directivesPos: { x: 40, y: 40 },
  circuitName: "Untitled",
  dataFlags: [],
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

    // Deleting a net terminal (a net label or a net connector) must *keep* the
    // net's name: the name belongs to the wire, not to the symbol. So we remember
    // it and re-show it on the wire that bridges the gap the terminal left
    // (below), instead of dropping it as the old behaviour did.
    const removed = get().circuit.components.get(id);
    const namedNetId = removed?.getNetLabel() !== null ? removed?.ports[0]?.netId : undefined;
    // The name a deleted terminal carried moves onto the bridging wire below.
    const keptName = namedNetId && namedNetId !== "0" ? removed!.getNetLabel() : null;

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
          data: { waypoints: [...[...first.path].reverse(), ...(via ? [via] : []), ...other.path], ...(keptName ? { netName: keptName, showLabel: true } : {}) },
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
    const { circuit, simulationConfig, spiceDirectives } = get();
    // Apply net-label terminals: each imposes its name on its connected net, so
    // nets sharing a name collapse to one node (connecting distant parts).
    for (const comp of circuit.components.values()) {
      const name = comp.getNetLabel();
      const netId = comp.ports[0]?.netId;
      if (name && netId && netId !== "0") {
        const net = circuit.nets.get(netId);
        if (net) net.nodeLabel = name;
      }
    }
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
    const { circuit, edges } = get();
    const net = circuit.nets.get(netId);
    if (!net) return;
    const oldLabel = net.nodeLabel;
    const newLabel = label.trim() || netId;
    if (oldLabel === newLabel) return;
    net.nodeLabel = newLabel;

    // Net terminals — net labels and net connectors alike (imported LTSpice
    // FLAGs) — *are* the net's name: regenerateNetlist re-imposes their label, so
    // renaming the net has to rename the terminal too or the new name is
    // overwritten on the next rebuild.
    const labelIds = new Set<string>();
    for (const comp of circuit.components.values()) {
      if (comp.getNetLabel() !== null && comp.ports[0]?.netId === netId) {
        comp.setProperty("label", newLabel);
        labelIds.add(comp.id);
      }
    }

    // No terminal yet: naming the net places a net label on it.
    //
    // A name that lives only on a wire is not saved — the `.asc` has no slot for
    // it, so it survived only in the session and in a share link, and vanished on
    // the first save. A label *is* the file's way of naming a net (`FLAG x y
    // NAME`), so naming and labelling are one and the same act. A plain label,
    // not a connector: a connector additionally declares a direction (`IOPIN`),
    // which is a claim the user has not made by typing a name.
    //
    // Clearing the name back to the auto id removes the label again, so a net
    // never keeps a tag that says nothing.
    const clearing = newLabel === netId;
    const onNetEdge = (e: Edge) =>
      circuit.components.get(e.source!)?.ports.find((p) => p.id === `${e.source}-${e.sourceHandle}`)?.netId === netId ||
      circuit.components.get(e.target!)?.ports.find((p) => p.id === `${e.target}-${e.targetHandle}`)?.netId === netId;

    /** A label to place, when the net has none and is being given a real name. */
    let spawn: { node: Node; comp: SpiceComponent; edge: Edge } | null = null;
    if (labelIds.size === 0 && !clearing) {
      // On the wire the user is looking at — the selected one, else any of the
      // net — at its midpoint, which is where a name reads best.
      const host = edges.find((e) => e.selected && onNetEdge(e)) ?? edges.find(onNetEdge);
      const at = host ? labelAnchor(host, get().nodes) : null;
      if (at) {
        const id = nextComponentId("netlabel", get().nodes.map((n) => n.id));
        const comp = createSpiceComponent("netlabel", id, newLabel, at.x - NODE_SIZE / 2, at.y - NODE_SIZE / 2);
        spawn = {
          comp,
          node: {
            id, type: "component",
            position: { x: at.x - NODE_SIZE / 2, y: at.y - NODE_SIZE / 2 },
            data: { componentType: "netlabel", label: newLabel },
          },
          edge: {
            id: `wire_label_${id}`,
            source: host!.source, sourceHandle: host!.sourceHandle,
            target: id, targetHandle: "t",
            type: "wire",
            data: { waypoints: [], targetTap: at, hostEdgeId: host!.id },
          },
        };
      }
    }
    /** Labels to drop, when the name is cleared back to the auto id. */
    const doomed = clearing ? [...labelIds] : [];

    if (spawn) {
      circuit.addComponent(spawn.comp);
      // Join it to the net at once. Waiting for the next rebuild would leave the
      // label unattached in between — invisible to the netlist, and invisible to
      // this very function on a second call, so clearing the name again would
      // find nothing to remove.
      try {
        circuit.connectPorts(`${spawn.edge.source}-${spawn.edge.sourceHandle}`, `${spawn.node.id}-t`);
      } catch { /* visual-only */ }
    }
    for (const id of doomed) circuit.removeComponent(id);

    const snap = { nodes: get().nodes, edges: get().edges };
    set((state) => ({
      netVersion: state.netVersion + 1,
      // Placing or dropping a label is a structural edit, so it belongs in the
      // undo history like any other.
      _history: [...state._history, snap],
      _future: [],
      nodes: [
        ...state.nodes
          .filter((n) => !doomed.includes(n.id))
          .map((n) => (labelIds.has(n.id) ? { ...n, data: { ...n.data, label: newLabel } } : n)),
        ...(spawn ? [spawn.node] : []),
      ],
      edges: [
        ...state.edges.filter((e) => !doomed.includes(e.source) && !doomed.includes(e.target)),
        ...(spawn ? [spawn.edge] : []),
      ],
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
    const { nodes, edges, directives, components, dataFlags, textBoxes, sheetShapes, netNames, directiveRaw, header, orphanWires } = LTSpiceParser.parse(ascContent);
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
      textBoxes,
      sheetShapes,
      selectedComponentId: null,
      viewFitNonce: state.viewFitNonce + 1,
      _history: [...state._history, snap],
      _future: [],
    }));
    setTimeout(() => {
      get().rebuildConnections();
      // Apply LTSpice net labels (named FLAGs) so imported DATAFLAG expressions
      // like V(U1) resolve. Skip GND — it is always net "0".
      for (const { compId, handle, name } of netNames) {
        const port = get().circuit.components.get(compId)?.ports.find((p) => p.id === `${compId}-${handle}`);
        if (port?.netId && port.netId !== "0") get().renameNet(port.netId, name);
      }
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

    const taken = new Set([...circuit.components.values()].map((c) => c.label));
    const snap = { nodes: cur, edges: curEdges };

    for (const comp of parsed.components) {
      const node = parsed.nodes.find((n) => n.id === comp.id);
      const type = (node?.data as { componentType?: ComponentType })?.componentType;
      const label = pasteLabelFor(type, comp.label, taken);
      if (label !== comp.label) comp.setProperty("label", label);
      taken.add(label);
      comp.position = { x: comp.position.x + dx, y: comp.position.y + dy };
      circuit.addComponent(comp);
    }

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
      edges: [...state.edges.map((e) => (e.selected ? { ...e, selected: false } : e)), ...parsed.edges],
      _history: [...state._history, snap],
      _future: [],
    }));
    setTimeout(() => get().rebuildConnections(), 0);
    return added.length;
  },

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
    // Save existing custom labels
    const customLabels = new Map<string, string>();
    for (const net of circuit.nets.values()) {
      if (net.id !== "0" && net.nodeLabel !== net.id) {
        if (net.connectedPortIds.size > 0) {
          customLabels.set(Array.from(net.connectedPortIds)[0], net.nodeLabel);
        }
      }
    }

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

    // A label reading "0" or "GND" *is* ground — merge its net into net "0",
    // exactly as LTSpice treats a "0" flag. Otherwise it became a SPICE node
    // literally called GND, sitting next to the real ground node "0": the circuit
    // looked earthed but was floating, and two nets displayed the same name.
    const isGroundName = (s: string) => /^(0|gnd)$/i.test(s.trim());
    for (const comp of circuit.components.values()) {
      const name = comp.getNetLabel();
      const netId = comp.ports[0]?.netId;
      if (!name || !isGroundName(name) || !netId || netId === "0") continue;

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
    }

    // Restore custom labels – never relabel the ground net "0".
    for (const [portId, label] of customLabels.entries()) {
      for (const comp of circuit.components.values()) {
        const port = comp.ports.find(p => p.id === portId);
        if (port && port.netId && port.netId !== "0") {
          const net = circuit.nets.get(port.netId);
          if (net) net.nodeLabel = label;
        }
      }
    }

    // Wire-carried names (`edge.data.netName`) are the persistent source of truth
    // for a labelled wire — they live on the edge and so survive every rebuild,
    // even after the net is renumbered or merged. Apply them onto the freshly
    // built nets (overriding the port-keyed restore above).
    for (const edge of edges) {
      const nm = (edge.data as { netName?: string } | undefined)?.netName;
      if (!nm) continue;
      const port = circuit.components.get(edge.source ?? "")?.ports.find((p) => p.id === `${edge.source}-${edge.sourceHandle}`);
      const nid = port?.netId;
      if (nid && nid !== "0") { const net = circuit.nets.get(nid); if (net) net.nodeLabel = nm; }
    }

    // A net whose *name* is ground — typed into the net-name field on a wire, with
    // no terminal node — is ground too (mirrors the terminal-based merge above).
    // Runs after the labels are restored, so the ground names are visible here.
    for (const [nid, net] of [...circuit.nets]) {
      if (nid === "0" || !isGroundName(net.nodeLabel)) continue;
      const groundNet = circuit.nets.get("0") ?? new Net("0", "GND");
      circuit.nets.set("0", groundNet);
      for (const comp of circuit.components.values()) {
        for (const port of comp.ports) {
          if (port.netId === nid) { port.connect("0"); groundNet.addPort(port.id); }
        }
      }
      circuit.nets.delete(nid);
    }

    // ── One name per net, shown in one place ──────────────────────────────
    // The name belongs to the net, not to the tag: a net carries at most one,
    // and a terminal placed on an already-named net adopts that name rather than
    // imposing its own. Without this, two terminals on one net each claimed it —
    // whichever was applied last won and silently renamed the other, so a label
    // added to name a probe point came back under a different name after a
    // save/reload, looking like it had vanished.
    //
    // Oldest terminal wins. Ids are handed out in ascending order
    // (`netlabel_3`, `netconnector_7`), so the smallest is the one that was
    // already there — and on import, the first FLAG in the file.
    const ordinal = (id: string) => Number(id.split("_").pop()) || 0;
    const byNet = new Map<string, { id: string; name: string }[]>();
    for (const comp of circuit.components.values()) {
      const nm = comp.getNetLabel();
      const nid = comp.ports[0]?.netId;
      if (nm === null || !nid || nid === "0") continue;
      const list = byNet.get(nid) ?? [];
      list.push({ id: comp.id, name: nm });
      byNet.set(nid, list);
    }
    /** New label for each terminal node whose name has to give way. */
    const renamed = new Map<string, string>();
    for (const [nid, terms] of byNet) {
      // A name the net already carried outranks a terminal placed later: a
      // terminal dropped on a named net is meant to *read* that name, not to
      // replace it with the next free NET1. The carried name comes from the
      // labels themselves now that naming a wire places one (see renameNet);
      // the oldest label is the one that was there first.
      const winner = terms.reduce((a, b) => (ordinal(a.id) <= ordinal(b.id) ? a : b));
      for (const t of terms) {
        if (t.name === winner.name) continue;
        circuit.components.get(t.id)?.setProperty("label", winner.name);
        renamed.set(t.id, winner.name);
      }
      const net = circuit.nets.get(nid);
      if (net) net.nodeLabel = winner.name;
    }

    // A named net shows its name at its terminal, so the wire must not repeat it.
    // Both mechanisms exist on purpose — a net without a terminal carries its
    // name on the wire — but a net with both said the same thing twice.
    const labelledNets = new Set(byNet.keys());
    const netOfEdge2 = (e: Edge) =>
      circuit.components.get(e.source ?? "")?.ports.find((p) => p.id === `${e.source}-${e.sourceHandle}`)?.netId
      ?? circuit.components.get(e.target ?? "")?.ports.find((p) => p.id === `${e.target}-${e.targetHandle}`)?.netId;

    set((state) => ({
      netVersion: state.netVersion + 1,
      nodes: renamed.size
        ? state.nodes.map((n) => (renamed.has(n.id) ? { ...n, data: { ...n.data, label: renamed.get(n.id) } } : n))
        : state.nodes,
      edges: state.edges.map((e) => {
        const nid = netOfEdge2(e);
        if (!nid || !labelledNets.has(nid) || !(e.data as { showLabel?: boolean } | undefined)?.showLabel) return e;
        const { showLabel: _hide, ...rest } = (e.data ?? {}) as Record<string, unknown>;
        return { ...e, data: rest };
      }),
    }));
    get().regenerateNetlist();
  },

  exportSnapshot: () => {
    const { nodes, edges, spiceDirectives, simulationConfig, circuit, circuitName, dataFlags, textBoxes, sheetShapes, showDirectivesOnCanvas, directivesPos } = get();
    const componentProps: Record<string, Record<string, string | number>> = {};
    // serialize(), not getProperties(): the property list only holds the fields
    // the UI currently shows, so a source in DC mode would save no sine fields
    // and lose e.g. a configured phase on reload.
    for (const [id, comp] of circuit.components) componentProps[id] = comp.serialize();
    const netLabels: Record<string, string> = {};
    // Anchor custom net names to a stable port id as well: net ids are
    // re-assigned when the circuit is rebuilt on load, so the net-id map alone
    // loses labels whose net happens to get a different id. A port id survives.
    const netLabelPorts: Record<string, string> = {};
    for (const [id, net] of circuit.nets) {
      if (id !== "0" && net.nodeLabel !== id) {
        netLabels[id] = net.nodeLabel;
        const anchor = net.connectedPortIds.size > 0 ? Array.from(net.connectedPortIds)[0] : null;
        if (anchor) netLabelPorts[anchor] = net.nodeLabel;
      }
    }
    // Persist the active scope: after a run these are ngspice-resolved names; if
    // the circuit was never run they still sit in pendingProbes. Union covers both.
    const sim = useSimulationStore.getState();
    const selectedVariables = [...new Set([...sim.selectedVariables, ...sim.pendingProbes])];
    // A terminal's name has no position of its own any more — it sits where the
    // wiring puts it. Any offset left over from an older snapshot is dropped, so
    // the same schematic draws the same way however it was opened.
    const cleanNodes = nodes.map((n) => {
      const t = (n.data as { componentType?: string }).componentType;
      if (t !== "netlabel" && t !== "netconnector") return n;
      const { labelOffset: _drop, ...rest } = n.data as Record<string, unknown>;
      return { ...n, data: rest };
    });
    return { version: 1, nodes: cleanNodes, edges, circuitName, spiceDirectives, simulationConfig, componentProps, netLabels, netLabelPorts, dataFlags, textBoxes, sheetShapes, showDirectivesOnCanvas, directivesPos, plotSettings: currentPlotSettings(), selectedVariables };
  },

  loadFromSnapshot: (snapshot) => {
    const newCircuit = new Circuit();
    const rebuiltNodes = snapshot.nodes.map((n) => ({ ...n }));

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
      // Legacy net-id-keyed labels first (may miss if net ids shifted on rebuild)…
      for (const [netId, label] of Object.entries(snapshot.netLabels)) {
        get().renameNet(netId, label);
      }
      // …then port-anchored labels, which reliably resolve the net a given port
      // now belongs to. These win, so a name is never lost to net-id churn.
      if (snapshot.netLabelPorts) {
        for (const [portId, label] of Object.entries(snapshot.netLabelPorts)) {
          for (const comp of get().circuit.components.values()) {
            const port = comp.ports.find((p) => p.id === portId);
            if (port?.netId && port.netId !== "0") {
              get().renameNet(port.netId, label);
              break;
            }
          }
        }
      }
    }, 0);
  },
}));

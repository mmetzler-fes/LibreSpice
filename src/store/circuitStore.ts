import { create } from "zustand";
import type { Node, Edge } from "@xyflow/react";
import { Circuit } from "@core/circuit/Circuit.js";
import { Net } from "@core/circuit/Net.js";
import { NetlistGenerator, parseAnalysisDirective, syncAnalysisDirective, type SimulationConfig } from "@core/circuit/NetlistGenerator.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import { getValueLabel, createSpiceComponent, createSubcircuitComponent, nextComponentId } from "@editor/componentFactory.js";
import { getNodePins, NODE_SIZE } from "@editor/pinGeometry.js";
import { useUIStore } from "./uiStore.js";
import type { FlowPoint } from "@editor/WireTool.js";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import { renameNetInProbe } from "@core/circuit/probeUtils.js";
import type { DataFlag } from "@core/circuit/dataExpr.js";
import { useLibraryStore } from "./libraryStore.js";
import { useSimulationStore } from "./simulationStore.js";
import { usePlotStore } from "@simulation/plotStore.js";
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
  /** Show the SPICE directives as a text box on the schematic (LTSpice-style). */
  showDirectivesOnCanvas: boolean;
  /** Position (flow coords) of the on-canvas directive text box. */
  directivesPos: { x: number; y: number };
  /** User-facing diagram/circuit name; default file name for .asc and .plt. */
  circuitName: string;
  /** Positioned data-point annotations (LTSpice DATAFLAGs). */
  dataFlags: DataFlag[];
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
  /** Patch a node's `data` (visual-only fields, e.g. the net-label connector flag). Undoable. */
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
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
  /** Internal: build the net-label terminal a freshly named net needs (see renameNet). */
  _createNetLabel: (netId: string, name: string) => { anchorPortId: string; node: Node; edge: Edge } | null;
  addDataFlag: (x: number, y: number, expr: string) => void;
  removeDataFlag: (id: string) => void;
  moveDataFlag: (id: string, x: number, y: number) => void;
  loadFromAsc: (ascContent: string) => void;
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

export const useCircuitStore = create<CircuitState & CircuitActions>((set, get) => ({
  circuit: new Circuit(),
  nodes: [],
  edges: [],
  selectedComponentId: null,
  netlist: "",
  simulationConfig: DEFAULT_CONFIG,
  spiceDirectives: "",
  showDirectivesOnCanvas: false,
  directivesPos: { x: 40, y: 40 },
  circuitName: "Untitled",
  dataFlags: [],
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

    // The label terminal *is* the net's name (see renameNet), so removing it takes
    // the name with it — otherwise the net kept a name with nothing on the
    // schematic to show for it, which is the very ghost-naming we want gone.
    const removed = get().circuit.components.get(id);
    const namedNetId = removed?.getNetLabel() !== null ? removed?.ports[0]?.netId : undefined;

    get().circuit.removeComponent(id);

    if (namedNetId && namedNetId !== "0") {
      const stillLabelled = [...get().circuit.components.values()].some(
        (c) => c.getNetLabel() !== null && c.ports[0]?.netId === namedNetId,
      );
      const net = get().circuit.nets.get(namedNetId);
      if (net && !stillLabelled) net.nodeLabel = namedNetId;
    }

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
          // removed pin sat on, so the wire keeps the shape it was drawn with.
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
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, label: component.label, ...(valueLabel !== undefined && { valueLabel }), ...(sourceType !== undefined && { sourceType }) } }
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

  /**
   * Build a net-label terminal for a net that has none, sitting on one of the
   * net's pins. Registers the component, and returns the node and the wire to it
   * for the caller to commit. `null` when the net has no component pin to hang it
   * on (nothing to attach to, so the name stays in the net object alone).
   */
  _createNetLabel: (netId, name) => {
    const { circuit, nodes } = get();
    // Anchor on a real part, not on another terminal (ground / a net label).
    const anchor = [...circuit.components.values()].find(
      (c) => c.getNetLabel() === null && c.label !== "0" && c.ports.some((p) => p.netId === netId),
    );
    const port = anchor?.ports.find((p) => p.netId === netId);
    const anchorNode = anchor ? nodes.find((n) => n.id === anchor.id) : undefined;
    if (!anchor || !port || !anchorNode) return null;

    const handle = port.id.slice(anchor.id.length + 1);
    // Sit on the pin; if the part has no pin geometry (a library subcircuit), the
    // anchor's centre still puts the label on the right net — the wire below
    // carries the connection either way.
    const pin = getNodePins(anchorNode, useUIStore.getState().symbolNorm).find((p) => p.handleId === handle)
      ?? { x: anchorNode.position.x + NODE_SIZE / 2, y: anchorNode.position.y + NODE_SIZE / 2 };

    const id = nextComponentId("netlabel", nodes.map((n) => n.id));
    // The terminal sits at the node's centre, so offset the box to put it on the pin.
    const x = pin.x - NODE_SIZE / 2, y = pin.y - NODE_SIZE / 2;
    const comp = createSpiceComponent("netlabel", id, name, x, y);
    circuit.addComponent(comp);

    return {
      anchorPortId: port.id,
      node: { id, type: "component", position: { x, y }, data: { componentType: "netlabel", label: name } } as Node,
      edge: {
        id: `wire_netlabel_${id}`,
        source: id, sourceHandle: "t",
        target: anchor.id, targetHandle: handle,
        type: "wire",
        data: { waypoints: [] },
      } as Edge,
    };
  },

  renameNet: (netId, label) => {
    const { circuit } = get();
    const net = circuit.nets.get(netId);
    if (!net) return;
    const oldLabel = net.nodeLabel;
    const newLabel = label.trim() || netId;
    if (oldLabel === newLabel) return;
    net.nodeLabel = newLabel;

    // A net-label terminal *is* the net's name: regenerateNetlist re-imposes its
    // label on the net every time. So renaming the net has to rename the terminal
    // too — otherwise the two disagree and the new name is silently overwritten on
    // the next rebuild. One name, one source of truth.
    const labelIds = new Set<string>();
    for (const comp of circuit.components.values()) {
      if (comp.getNetLabel() !== null && comp.ports[0]?.netId === netId) {
        comp.setProperty("label", newLabel);
        labelIds.add(comp.id);
      }
    }

    // No terminal yet: give the net one, on a pin of the net. A name that lives
    // only inside the net object is invisible on the schematic and is the second,
    // shadow structure we do not want — every named net now shows its label.
    const created = labelIds.size === 0 ? get()._createNetLabel(netId, newLabel) : null;

    set((state) => ({
      netVersion: state.netVersion + 1,
      nodes: labelIds.size
        ? state.nodes.map((n) => (labelIds.has(n.id) ? { ...n, data: { ...n.data, label: newLabel } } : n))
        : [...state.nodes, ...(created ? [created.node] : [])],
      edges: created ? [...state.edges, created.edge] : state.edges,
      // Keep data-point expressions pointing at the renamed net.
      dataFlags: state.dataFlags.map((d) => ({ ...d, expr: renameNetInProbe(d.expr, oldLabel, newLabel) })),
    }));
    if (created) get().connectPorts(`${created.node.id}-t`, created.anchorPortId);
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

  moveDataFlag: (id, x, y) =>
    set((state) => ({ dataFlags: state.dataFlags.map((d) => (d.id === id ? { ...d, x, y } : d)) })),

  loadFromAsc: (ascContent) => {
    const { nodes, edges, directives, components, dataFlags, netNames } = LTSpiceParser.parse(ascContent);
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
      dataFlags,
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
      // A new schematic starts blank: the previous circuit's SPICE directives
      // (and the analysis they configured) would otherwise still drive the next
      // simulation — a `.step`/`.meas` over parts that no longer exist.
      spiceDirectives: "",
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
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id
          ? { ...n, data: { ...n.data, rotation: comp.rotation } }
          : n,
      ),
      _history: [...state._history, snap],
      _future: [],
    }));
  },

  mirrorSelected: () => {
    const { selectedComponentId } = get();
    if (!selectedComponentId) return;
    // Mirror is purely visual (pin identity is unchanged, so the netlist stays
    // the same); it toggles a flag on the node that the renderer/pin geometry
    // read to flip the symbol and its handles horizontally.
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === selectedComponentId
          ? { ...n, data: { ...n.data, mirrored: !(n.data as { mirrored?: boolean }).mirrored } }
          : n,
      ),
    }));
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

    set((state) => ({ netVersion: state.netVersion + 1 }));
    get().regenerateNetlist();
  },

  exportSnapshot: () => {
    const { nodes, edges, spiceDirectives, simulationConfig, circuit, circuitName, dataFlags, showDirectivesOnCanvas, directivesPos } = get();
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
    return { version: 1, nodes, edges, circuitName, spiceDirectives, simulationConfig, componentProps, netLabels, netLabelPorts, dataFlags, showDirectivesOnCanvas, directivesPos };
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
      showDirectivesOnCanvas: snapshot.showDirectivesOnCanvas ?? false,
      directivesPos: snapshot.directivesPos ?? { x: 40, y: 40 },
      selectedComponentId: null,
      viewFitNonce: get().viewFitNonce + 1,
      fileHandle: null,
      fileName: null,
      _history: [],
      _future: [],
    });

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

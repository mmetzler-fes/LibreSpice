import { create } from "zustand";
import type { Node, Edge } from "@xyflow/react";
import { Circuit } from "@core/circuit/Circuit.js";
import { Net } from "@core/circuit/Net.js";
import { NetlistGenerator, type SimulationConfig } from "@core/circuit/NetlistGenerator.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import { getValueLabel, createSpiceComponent } from "@editor/componentFactory.js";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import { useLibraryStore } from "./libraryStore.js";
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
  propertyVersion: number;
  netVersion: number;
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
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  setSelectedComponentId: (id: string | null) => void;
  connectPorts: (portIdA: string, portIdB: string) => void;
  regenerateNetlist: () => void;
  setSimulationConfig: (config: SimulationConfig) => void;
  setSpiceDirectives: (text: string) => void;
  renameNet: (netId: string, label: string) => void;
  loadFromAsc: (ascContent: string) => void;
  clearCircuit: () => void;
  setFileHandle: (handle: any | null, name: string | null) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  rotateSelected: () => void;
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
  propertyVersion: 0,
  netVersion: 0,
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
    get().circuit.removeComponent(id);
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
      selectedComponentId: state.selectedComponentId === id ? null : state.selectedComponentId,
      _history: [...state._history, snap],
      _future: [],
    }));
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
    const generator = new NetlistGenerator();
    const libraryDefs = useLibraryStore.getState().getDefinitionsText();
    const netlist = generator.generate(circuit, simulationConfig, spiceDirectives, undefined, libraryDefs);
    set({ netlist });
  },

  setSimulationConfig: (config) => {
    set({ simulationConfig: config });
    get().regenerateNetlist();
  },

  setSpiceDirectives: (text) => {
    set({ spiceDirectives: text });
    get().regenerateNetlist();
  },

  renameNet: (netId, label) => {
    const net = get().circuit.nets.get(netId);
    if (!net) return;
    net.nodeLabel = label.trim() || netId;
    set((state) => ({ netVersion: state.netVersion + 1 }));
    get().regenerateNetlist();
  },

  loadFromAsc: (ascContent) => {
    const { nodes, edges, directives, components } = LTSpiceParser.parse(ascContent);
    const snap = { nodes: get().nodes, edges: get().edges };
    
    const newCircuit = new Circuit();
    for (const comp of components) {
      newCircuit.addComponent(comp);
    }
    
    set((state) => ({
      circuit: newCircuit,
      nodes,
      edges,
      spiceDirectives: directives,
      selectedComponentId: null,
      _history: [...state._history, snap],
      _future: [],
    }));
    setTimeout(() => get().rebuildConnections(), 0);
  },

  setFileHandle: (handle, name) => set({ fileHandle: handle, fileName: name }),

  clearCircuit: () => {
    const snap = { nodes: get().nodes, edges: get().edges };
    const newCircuit = new Circuit();
    set((state) => ({
      circuit: newCircuit,
      nodes: [],
      edges: [],
      selectedComponentId: null,
      netlist: "",
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
    const { selectedComponentId, circuit } = get();
    if (!selectedComponentId) return;
    const comp = circuit.components.get(selectedComponentId);
    if (!comp) return;
    comp.rotate(270); // 270° CW == 90° counter-clockwise (rotate left)
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === selectedComponentId
          ? { ...n, data: { ...n.data, rotation: comp.rotation } }
          : n,
      ),
    }));
  },

  deleteSelected: () => {
    const { selectedComponentId, removeComponent, edges, setEdges, rebuildConnections } = get();
    let changed = false;
    if (selectedComponentId) {
      removeComponent(selectedComponentId);
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
    const { nodes, edges, spiceDirectives, simulationConfig, circuit } = get();
    const componentProps: Record<string, Record<string, string | number>> = {};
    for (const [id, comp] of circuit.components) {
      const props: Record<string, string | number> = {};
      for (const p of comp.getProperties()) props[p.key] = p.value;
      componentProps[id] = props;
    }
    const netLabels: Record<string, string> = {};
    for (const [id, net] of circuit.nets) {
      if (id !== "0" && net.nodeLabel !== id) netLabels[id] = net.nodeLabel;
    }
    return { version: 1, nodes, edges, spiceDirectives, simulationConfig, componentProps, netLabels };
  },

  loadFromSnapshot: (snapshot) => {
    const newCircuit = new Circuit();
    const rebuiltNodes = snapshot.nodes.map((n) => ({ ...n }));

    for (const node of rebuiltNodes) {
      const type = (node.data as { componentType?: ComponentType }).componentType;
      if (!type) continue;
      const label = String((node.data as { label?: string }).label ?? node.id);
      const { x, y } = node.position;
      const comp = createSpiceComponent(type, node.id, label, x, y);
      const props = snapshot.componentProps[node.id];
      if (props) {
        for (const [key, val] of Object.entries(props)) comp.setProperty(key, val);
      }
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
      spiceDirectives: snapshot.spiceDirectives,
      simulationConfig: snapshot.simulationConfig,
      selectedComponentId: null,
      fileHandle: null,
      fileName: null,
      _history: [],
      _future: [],
    });

    setTimeout(() => {
      get().rebuildConnections();
      for (const [netId, label] of Object.entries(snapshot.netLabels)) {
        get().renameNet(netId, label);
      }
    }, 0);
  },
}));

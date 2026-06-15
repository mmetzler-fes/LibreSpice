import { create } from "zustand";
import type { Node, Edge } from "@xyflow/react";
import { Circuit } from "@core/circuit/Circuit.js";
import { NetlistGenerator, type SimulationConfig } from "@core/circuit/NetlistGenerator.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";

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
  _history: HistoryEntry[];
  _future: HistoryEntry[];
}

interface CircuitActions {
  addComponent: (component: SpiceComponent, nodeData: Node) => void;
  removeComponent: (id: string) => void;
  updateComponentProperty: (id: string, key: string, value: string | number) => void;
  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  setSelectedComponentId: (id: string | null) => void;
  connectPorts: (portIdA: string, portIdB: string) => void;
  regenerateNetlist: () => void;
  setSimulationConfig: (config: SimulationConfig) => void;
  clearCircuit: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  rotateSelected: () => void;
  deleteSelected: () => void;
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
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === id ? { ...n, data: { ...n.data, label: component.label } } : n,
      ),
    }));
    get().regenerateNetlist();
  },

  setNodes: (nodes) => set({ nodes }),

  setEdges: (edges) => {
    const snap = { nodes: get().nodes, edges: get().edges };
    set((state) => ({ edges, _history: [...state._history, snap], _future: [] }));
  },

  setSelectedComponentId: (id) => set({ selectedComponentId: id }),

  connectPorts: (portIdA, portIdB) => {
    get().circuit.connectPorts(portIdA, portIdB);
    get().regenerateNetlist();
  },

  regenerateNetlist: () => {
    const { circuit, simulationConfig } = get();
    const generator = new NetlistGenerator();
    const netlist = generator.generate(circuit, simulationConfig);
    set({ netlist });
  },

  setSimulationConfig: (config) => {
    set({ simulationConfig: config });
    get().regenerateNetlist();
  },

  clearCircuit: () => {
    const snap = { nodes: get().nodes, edges: get().edges };
    const newCircuit = new Circuit();
    set((state) => ({
      circuit: newCircuit,
      nodes: [],
      edges: [],
      selectedComponentId: null,
      netlist: "",
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
    comp.rotate(90);
    set((state) => ({
      nodes: state.nodes.map((n) =>
        n.id === selectedComponentId
          ? { ...n, data: { ...n.data, rotation: comp.rotation } }
          : n,
      ),
    }));
  },

  deleteSelected: () => {
    const { selectedComponentId, removeComponent } = get();
    if (selectedComponentId) removeComponent(selectedComponentId);
  },
}));

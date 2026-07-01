import { useCallback, useEffect, useRef } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  type Connection,
  type Node,
  type Edge,
  type NodeMouseHandler,
  BackgroundVariant,
  useReactFlow,
  ConnectionMode,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ComponentNode } from "./nodes/ComponentNode.js";
import { WireEdge, WireOverlay, type WireData } from "./WireTool.js";
import { PlacementGhost } from "./PlacementGhost.js";
import { NODE_SIZE } from "./pinGeometry.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { Toolbar } from "./Toolbar.js";
import { ComponentPalette } from "./ComponentPalette.js";
import { NetLabelsPanel } from "./NetLabelsPanel.js";
import { DockPanel } from "./DockPanel.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import type { ComponentDefinition } from "./componentDefinitions.js";
import { createSpiceComponent, createSubcircuitComponent, getNextLabel, getValueLabel } from "./componentFactory.js";
import type { PendingLibraryPlacement } from "@store/uiStore.js";
import { getProbeCandidates, getCurrentProbeCandidates } from "@core/circuit/probeUtils.js";
import type { ComponentType } from "./nodes/ComponentNode.js";

const NODE_TYPES = { component: ComponentNode };
const EDGE_TYPES = { wire: WireEdge };
const GRID_SIZE = 20;
let componentCounter = 1;
let wireCounter = 1;

function snapToGrid(v: number): number {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

function CanvasInner() {
  const reactFlowInstance = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragDefRef = useRef<ComponentDefinition | null>(null);

  const {
    nodes, edges,
    addComponent, removeComponent, setNodes, setEdges,
    setSelectedComponentId, connectPorts, regenerateNetlist,
    undo, redo, canUndo, canRedo,
    rotateSelected, deleteSelected, rebuildConnections,
    circuit,
  } = useCircuitStore();

  const {
    editorMode, pendingPlaceType, pendingLibraryPlacement,
    setEditorMode, startPlacing, cancelPlacing,
    showPropertiesPanel, showComponentPalette,
    setDockTab, autoProbeCurrent,
  } = useUIStore();

  const { result, addProbeCandidates } = useSimulationStore();

  // Reference designators already in use, for per-prefix auto-numbering.
  const existingLabels = () =>
    useCircuitStore.getState().nodes.map((n) => String((n.data as { label?: string }).label ?? "")).filter(Boolean);

  const placeComponent = useCallback(
    (type: ComponentType, cx: number, cy: number) => {
      // Center the node on the (snapped) cursor: node.position is its top-left.
      const x = snapToGrid(cx) - NODE_SIZE / 2;
      const y = snapToGrid(cy) - NODE_SIZE / 2;
      const id = `${type}_${componentCounter++}`;
      // Ground uses label "0" internally; display label is separate
      const label = type === "ground" ? "0" : getNextLabel(type, existingLabels());
      const component = createSpiceComponent(type, id, label, x, y);
      const valueLabel = getValueLabel(component, type);
      const node: Node = {
        id,
        type: "component",
        position: { x, y },
        data: { componentType: type, label, valueLabel },
      };
      addComponent(component, node);
    },
    [addComponent],
  );

  const placeLibraryComponent = useCallback(
    (placement: PendingLibraryPlacement, cx: number, cy: number) => {
      const x = snapToGrid(cx) - NODE_SIZE / 2;
      const y = snapToGrid(cy) - NODE_SIZE / 2;

      if (placement.componentType === "subcircuit") {
        const id = `subckt_${componentCounter++}`;
        const label = getNextLabel("subcircuit", existingLabels());
        const component = createSubcircuitComponent(id, label, x, y, placement.raw ?? "", placement.pins ?? []);
        const node: Node = {
          id,
          type: "component",
          position: { x, y },
          data: { componentType: "subcircuit", label, pins: placement.pins ?? [], subName: placement.name },
        };
        addComponent(component, node);
        return;
      }

      // Typed device backed by an imported .model – place the base symbol with
      // its model property pre-set so the netlist references the model.
      const id = `${placement.componentType}_${componentCounter++}`;
      const label = getNextLabel(placement.componentType, existingLabels());
      const component = createSpiceComponent(placement.componentType, id, label, x, y);
      if (placement.model) component.setProperty("model", placement.model);
      const valueLabel = getValueLabel(component, placement.componentType) || placement.model;
      const node: Node = {
        id,
        type: "component",
        position: { x, y },
        data: { componentType: placement.componentType, label, valueLabel },
      };
      addComponent(component, node);
    },
    [addComponent],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      if (e.key === "Escape") { cancelPlacing(); setEditorMode("select"); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); if (canUndo()) undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); if (canRedo()) redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "r") { e.preventDefault(); rotateSelected(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { deleteSelected(); return; }

      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        switch (e.key.toLowerCase()) {
          case "r": startPlacing("resistor"); break;
          case "c": startPlacing("capacitor"); break;
          case "l": startPlacing("inductor"); break;
          case "d": startPlacing("diode"); break;
          case "g": startPlacing("ground"); break;
          case "v": startPlacing("vsource"); break;
          case "i": startPlacing("isource"); break;
          case "q": startPlacing("bjt_npn"); break;
          case "m": startPlacing("mosfet_n"); break;
          case "w": setEditorMode("wire"); break;
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cancelPlacing, canUndo, canRedo, undo, redo, rotateSelected, deleteSelected, startPlacing, setEditorMode]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges(addEdge(
        { ...connection, type: "step", style: { stroke: "#1e293b", strokeWidth: 2 }, animated: false },
        edges,
      ));
      if (connection.source && connection.sourceHandle && connection.target && connection.targetHandle) {
        try {
          connectPorts(`${connection.source}-${connection.sourceHandle}`, `${connection.target}-${connection.targetHandle}`);
        } catch { /* visual-only */ }
      }
      regenerateNetlist();
    },
    [edges, setEdges, connectPorts, regenerateNetlist],
  );

  const onCreateWire = useCallback(
    (connection: Connection, data: WireData) => {
      const id = `wire_${connection.source}-${connection.sourceHandle}__${connection.target}-${connection.targetHandle}_${wireCounter++}`;
      const edge: Edge = { id, ...connection, type: "wire", data };
      setEdges(addEdge(edge, edges));
      if (connection.source && connection.sourceHandle && connection.target && connection.targetHandle) {
        try {
          connectPorts(`${connection.source}-${connection.sourceHandle}`, `${connection.target}-${connection.targetHandle}`);
        } catch { /* visual-only */ }
      }
      regenerateNetlist();
    },
    [edges, setEdges, connectPorts, regenerateNetlist],
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      setSelectedComponentId(node.id);
      if (!autoProbeCurrent) return;
      const comp = circuit.components.get(node.id);
      if (!comp || comp.id.startsWith("ground")) return;
      // Offer this component's branch current in the waveform sidebar (selected by default).
      addProbeCandidates(getCurrentProbeCandidates(comp.label));
      if (result) setDockTab("waveform");
    },
    [setSelectedComponentId, autoProbeCurrent, circuit, addProbeCandidates, result, setDockTab],
  );

  const onNodeDoubleClick: NodeMouseHandler = useCallback(
    (_, node) => {
      const comp = circuit.components.get(node.id);
      if (!comp) return;
      addProbeCandidates(getProbeCandidates(comp, circuit));
      setDockTab("waveform");
    },
    [circuit, addProbeCandidates, setDockTab],
  );

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      setSelectedComponentId(null);
      if (editorMode === "place") {
        const pos = reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        if (pendingLibraryPlacement) {
          placeLibraryComponent(pendingLibraryPlacement, pos.x, pos.y);
        } else if (pendingPlaceType) {
          placeComponent(pendingPlaceType, pos.x, pos.y);
        }
      }
    },
    [editorMode, pendingPlaceType, pendingLibraryPlacement, placeComponent, placeLibraryComponent, setSelectedComponentId, reactFlowInstance],
  );

  const onDragStart = useCallback((def: ComponentDefinition, event: React.DragEvent) => {
    dragDefRef.current = def;
    event.dataTransfer.effectAllowed = "move";
  }, []);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const def = dragDefRef.current;
      if (!def) return;
      const pos = reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      placeComponent(def.type as ComponentType, pos.x, pos.y);
      dragDefRef.current = null;
    },
    [reactFlowInstance, placeComponent],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const removals = changes.filter((c) => c.type === "remove" && "id" in c);
      removals.forEach((c) => removeComponent((c as any).id));
      setNodes(applyNodeChanges(changes, nodes));
    },
    [nodes, setNodes, removeComponent],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removals = changes.filter((c) => c.type === "remove" && "id" in c);
      setEdges(applyEdgeChanges(changes, edges));
      if (removals.length > 0) {
        setTimeout(() => rebuildConnections(), 0);
      }
    },
    [edges, setEdges, rebuildConnections],
  );

  const cursorStyle =
    editorMode === "place" ? "crosshair" :
    editorMode === "wire"  ? "cell" :
    editorMode === "pan"   ? "grab" : "default";

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      <Toolbar />
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {showComponentPalette && <ComponentPalette onDragStart={onDragStart} />}

        <div
          ref={wrapperRef}
          style={{ flex: 1, position: "relative", cursor: cursorStyle }}
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange as never}
            onEdgesChange={onEdgesChange as never}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onPaneClick={onPaneClick}
            snapToGrid
            snapGrid={[GRID_SIZE, GRID_SIZE]}
            fitView
            fitViewOptions={{ padding: 0.3 }}
            deleteKeyCode={null}
            panOnDrag={editorMode !== "wire"}
            nodesDraggable={editorMode === "select"}
            elementsSelectable={editorMode === "select"}
            connectionRadius={24}
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={{
              type: "step",
              style: { stroke: "#1e293b", strokeWidth: 2 },
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={GRID_SIZE} size={1} color="#cbd5e1" />
            <Controls position="bottom-right" />
            <MiniMap position="bottom-left" pannable zoomable nodeStrokeWidth={3} />
          </ReactFlow>

          {editorMode === "wire" && (
            <WireOverlay wrapperRef={wrapperRef} nodes={nodes} edges={edges} onCreateWire={onCreateWire} />
          )}

          {editorMode === "place" && pendingPlaceType && (
            <PlacementGhost wrapperRef={wrapperRef} type={pendingPlaceType} />
          )}
        </div>

        {showPropertiesPanel && (
          <aside style={{ display: "flex", flexDirection: "column", overflow: "auto" }}>
            <PropertiesPanel />
            <NetLabelsPanel />
          </aside>
        )}
      </div>
      <DockPanel />
    </div>
  );
}

export function SchematicCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

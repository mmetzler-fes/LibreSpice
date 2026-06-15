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
  type NodeMouseHandler,
  BackgroundVariant,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ComponentNode } from "./nodes/ComponentNode.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { Toolbar } from "./Toolbar.js";
import { ComponentPalette } from "./ComponentPalette.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import type { ComponentDefinition } from "./componentDefinitions.js";
import { Resistor } from "@core/components/passives/Resistor.js";
import { Capacitor } from "@core/components/passives/Capacitor.js";
import { Inductor } from "@core/components/passives/Inductor.js";
import { Diode, LED, BJT, MOSFET } from "@core/components/semiconductors/Semiconductors.js";
import { VoltageSource, CurrentSource, SineSource, PulseSource } from "@core/components/sources/Sources.js";
import { Ground } from "@core/components/special/Special.js";
import type { SpiceComponent } from "@core/components/base/SpiceComponent.js";
import type { ComponentType } from "./nodes/ComponentNode.js";

const NODE_TYPES = { component: ComponentNode };
const GRID_SIZE = 20;
let componentCounter = 1;

export function createSpiceComponent(
  type: ComponentType,
  id: string,
  label: string,
  x: number,
  y: number,
): SpiceComponent {
  const pos = { x, y };
  switch (type) {
    case "resistor":    return new Resistor(id, label, pos);
    case "capacitor":   return new Capacitor(id, label, pos);
    case "inductor":    return new Inductor(id, label, pos);
    case "diode":       return new Diode(id, label, pos);
    case "led":         return new LED(id, label, pos);
    case "bjt_npn":     return new BJT(id, label, pos, "NPN");
    case "bjt_pnp":     return new BJT(id, label, pos, "PNP");
    case "mosfet_n":    return new MOSFET(id, label, pos, "NMOS");
    case "mosfet_p":    return new MOSFET(id, label, pos, "PMOS");
    case "vsource":     return new VoltageSource(id, label, pos);
    case "isource":     return new CurrentSource(id, label, pos);
    case "sinesource":  return new SineSource(id, label, pos);
    case "pulsesource": return new PulseSource(id, label, pos);
    case "ground":      return new Ground(id, pos);
    default:            return new Resistor(id, label, pos);
  }
}

function getDefaultLabel(type: ComponentType, counter: number): string {
  const map: Partial<Record<ComponentType, string>> = {
    resistor: "R", capacitor: "C", inductor: "L", diode: "D", led: "D",
    bjt_npn: "Q", bjt_pnp: "Q", mosfet_n: "M", mosfet_p: "M",
    vsource: "V", isource: "I", sinesource: "V", pulsesource: "V", ground: "GND",
  };
  return `${map[type] ?? "X"}${counter}`;
}

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
    rotateSelected, deleteSelected,
  } = useCircuitStore();

  const {
    editorMode, pendingPlaceType,
    setEditorMode, startPlacing, cancelPlacing,
    showPropertiesPanel, showComponentPalette,
  } = useUIStore();

  const placeComponent = useCallback(
    (type: ComponentType, cx: number, cy: number) => {
      const x = snapToGrid(cx);
      const y = snapToGrid(cy);
      const id = `${type}_${componentCounter++}`;
      const label = getDefaultLabel(type, componentCounter - 1);
      const component = createSpiceComponent(type, id, label, x, y);
      const node: Node = {
        id,
        type: "component",
        position: { x, y },
        data: { componentType: type, label },
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

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => setSelectedComponentId(node.id),
    [setSelectedComponentId],
  );

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      setSelectedComponentId(null);
      if (editorMode === "place" && pendingPlaceType) {
        const pos = reactFlowInstance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
        placeComponent(pendingPlaceType, pos.x, pos.y);
      }
    },
    [editorMode, pendingPlaceType, placeComponent, setSelectedComponentId, reactFlowInstance],
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
    (changes: Array<{ type: string; id?: string; position?: { x: number; y: number }; dragging?: boolean }>) => {
      const removals = changes.filter((c) => c.type === "remove" && c.id);
      removals.forEach((c) => removeComponent(c.id!));
      setNodes(
        nodes
          .filter((n) => !removals.some((r) => r.id === n.id))
          .map((n) => {
            const ch = changes.find((c) => c.type === "position" && c.id === n.id);
            if (ch?.position) return { ...n, position: ch.position };
            return n;
          }),
      );
    },
    [nodes, setNodes, removeComponent],
  );

  const onEdgesChange = useCallback(
    (changes: Array<{ type: string; id?: string }>) => {
      const removals = changes.filter((c) => c.type === "remove" && c.id);
      if (removals.length > 0) {
        setEdges(edges.filter((e) => !removals.some((r) => r.id === e.id)));
      }
    },
    [edges, setEdges],
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
            onNodesChange={onNodesChange as never}
            onEdgesChange={onEdgesChange as never}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
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
            defaultEdgeOptions={{
              type: "step",
              style: { stroke: "#1e293b", strokeWidth: 2 },
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={GRID_SIZE} size={1} color="#cbd5e1" />
            <Controls position="bottom-right" />
            <MiniMap position="bottom-left" pannable zoomable nodeStrokeWidth={3} />
          </ReactFlow>
        </div>

        {showPropertiesPanel && <PropertiesPanel />}
      </div>
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

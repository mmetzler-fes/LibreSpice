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
  ConnectionMode,
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ComponentNode } from "./nodes/ComponentNode.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { Toolbar } from "./Toolbar.js";
import { ComponentPalette } from "./ComponentPalette.js";
import { NetLabelsPanel } from "./NetLabelsPanel.js";
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

/** Format a number with SI prefix for display on canvas */
function fmtSI(v: number, unit: string): string {
  const a = Math.abs(v);
  if (a === 0) return `0${unit}`;
  if (a >= 1e9)  return `${+(v / 1e9).toPrecision(3)}G${unit}`;
  if (a >= 1e6)  return `${+(v / 1e6).toPrecision(3)}M${unit}`;
  if (a >= 1e3)  return `${+(v / 1e3).toPrecision(3)}k${unit}`;
  if (a >= 1)    return `${+v.toPrecision(3)}${unit}`;
  if (a >= 1e-3) return `${+(v * 1e3).toPrecision(3)}m${unit}`;
  if (a >= 1e-6) return `${+(v * 1e6).toPrecision(3)}µ${unit}`;
  if (a >= 1e-9) return `${+(v * 1e9).toPrecision(3)}n${unit}`;
  return `${+(v * 1e12).toPrecision(3)}p${unit}`;
}

/** Derive a short value label from a SpiceComponent for display on the canvas */
export function getValueLabel(component: SpiceComponent, type: ComponentType): string {
  switch (type) {
    case "resistor":  {
      const r = component as unknown as { resistance: number };
      return fmtSI(r.resistance, "Ω");
    }
    case "capacitor": {
      const c = component as unknown as { capacitance: number };
      return fmtSI(c.capacitance, "F");
    }
    case "inductor":  {
      const l = component as unknown as { inductance: number };
      return fmtSI(l.inductance, "H");
    }
    case "vsource":   {
      const v = component as unknown as { dcValue: number };
      return `${fmtSI(v.dcValue, "V")} DC`;
    }
    case "isource":   {
      const i = component as unknown as { dcValue: number };
      return `${fmtSI(i.dcValue, "A")} DC`;
    }
    case "sinesource": {
      const s = component as unknown as { amplitude: number; frequency: number };
      return `${fmtSI(s.amplitude, "V")} ${fmtSI(s.frequency, "Hz")}`;
    }
    case "pulsesource": {
      const p = component as unknown as { pulsedValue: number; period: number };
      return `${fmtSI(p.pulsedValue, "V")} ${fmtSI(p.period, "s")}`;
    }
    default: return "";
  }
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
      // Ground uses label "0" internally; display label is separate
      const label = type === "ground" ? "0" : getDefaultLabel(type, componentCounter - 1);
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
        </div>

        {showPropertiesPanel && (
          <aside style={{ display: "flex", flexDirection: "column", overflow: "auto" }}>
            <PropertiesPanel />
            <NetLabelsPanel />
          </aside>
        )}
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

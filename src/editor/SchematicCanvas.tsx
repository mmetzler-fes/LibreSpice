import { useCallback, useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
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
import { WireEdge, WireOverlay, type WireData, orthoVertices, projectToSegment, type FlowPoint } from "./WireTool.js";
import { DataFlagLayer } from "./DataFlagLayer.js";
import { DirectiveBox } from "./DirectiveBox.js";
import { PlacementGhost } from "./PlacementGhost.js";
import { NODE_SIZE, GRID, getNodePins } from "./pinGeometry.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { Toolbar } from "./Toolbar.js";
import { ComponentPalette } from "./ComponentPalette.js";
import { NetLabelsPanel } from "./NetLabelsPanel.js";
import { DockPanel } from "./DockPanel.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { useSimulationStore } from "@store/simulationStore.js";
import type { ComponentDefinition } from "./componentDefinitions.js";
import { createSpiceComponent, createSubcircuitComponent, getNextLabel, getValueLabel } from "./componentFactory.js";
import type { PendingLibraryPlacement } from "@store/uiStore.js";
import { getProbeCandidates, getCurrentProbeCandidates, getVoltageDiffExpression } from "@core/circuit/probeUtils.js";
import { netVoltageExpr, netCurrentExpr, compVoltageExpr, compCurrentExpr } from "@core/circuit/dataExpr.js";
import { usePlotStore } from "@simulation/plotStore.js";
import type { ComponentType, ComponentNodeData } from "./nodes/ComponentNode.js";
import { isLongPressPointer, trackLongPress } from "./longPress.js";
import { trackPointerDrag } from "./pointerDrag.js";

const NODE_TYPES = { component: ComponentNode };
const EDGE_TYPES = { wire: WireEdge };
const GRID_SIZE = GRID;
let componentCounter = 1;
let wireCounter = 1;

function snapToGrid(v: number): number {
  return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

function CanvasInner() {
  const reactFlowInstance = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const dragDefRef = useRef<ComponentDefinition | null>(null);
  // Input kind of the last pointer that pressed the canvas. A touch/pen place is
  // committed on pointerup (below), so onPaneClick must not also place then and
  // create a duplicate; it stays the placement path for the mouse only.
  const lastPointerTypeRef = useRef<string>("mouse");

  const {
    nodes, edges,
    addComponent, removeComponent, setNodes, setEdges,
    setSelectedComponentId, connectPorts, regenerateNetlist,
    undo, redo, canUndo, canRedo,
    rotateSelected, mirrorSelected, deleteSelected, rebuildConnections,
    circuit, addDataFlag, renameNet, viewFitNonce, updateNodeData,
  } = useCircuitStore();

  // After a full load (import / snapshot) the content may sit off-screen (e.g.
  // LTSpice sheets with negative coordinates), so re-fit the view to it.
  useEffect(() => {
    if (viewFitNonce === 0) return;
    const id = setTimeout(() => reactFlowInstance.fitView({ padding: 0.3 }), 80);
    return () => clearTimeout(id);
  }, [viewFitNonce, reactFlowInstance]);

  const {
    editorMode, pendingPlaceType, pendingLibraryPlacement, placementRotation,
    setEditorMode, startPlacing, cancelPlacing, rotatePlacement, toggleInsertComponent,
    showPropertiesPanel, showComponentPalette,
    setDockTab, autoProbeCurrent,
  } = useUIStore();

  const theme = useTheme();
  const { result, addProbeCandidates } = useSimulationStore();
  const addExpression = usePlotStore((s) => s.addExpression);
  // Non-selected wire color; matches WireEdge so drag-connected and hand-drawn
  // wires read the same in each theme.
  const wireStroke = theme.wireStroke;
  // On-canvas zoom/fit/lock controls, themed to sit on the dark canvas.
  const canvasButton: React.CSSProperties = {
    ...canvasBtn, background: theme.panelBg, color: theme.symPreview, border: `1px solid ${theme.border}`,
  };

  /** Right-click menu on a component: probe current / voltage in the scope. */
  const [nodeMenu, setNodeMenu] = useState<{ id: string; label: string; x: number; y: number; fx: number; fy: number; isNetlabel?: boolean; connector?: boolean; isGround?: boolean } | null>(null);
  /** Right-click menu on a wire: annotate the net's potential / current. */
  const [wireMenu, setWireMenu] = useState<{ edgeId: string; netId: string | null; vExpr: string | null; iExpr: string | null; x: number; y: number; fx: number; fy: number } | null>(null);

  // Only auto-fit when the canvas already has content at mount. On an empty
  // canvas fitView would stay pending and first fire when the first node is
  // placed, jerking the zoom (shrinking the ghost and offsetting placement).
  const [fitOnInit] = useState(() => nodes.length > 0);
  // Freezes the canvas: no panning, no node dragging. On a touch device this
  // stops the schematic sliding around under a stray finger while you read or
  // draw. (Replaces React Flow's padlock, which did not respond to touch.)
  const [canvasLocked, setCanvasLocked] = useState(false);

  // Reference designators already in use, for per-prefix auto-numbering.
  const existingLabels = () =>
    useCircuitStore.getState().nodes.map((n) => String((n.data as { label?: string }).label ?? "")).filter(Boolean);

  const autoConnectNodePins = useCallback(
    (node: Node) => {
      const symbolNorm = useUIStore.getState().symbolNorm;
      const newPins = getNodePins(node, symbolNorm);
      const newEdges: Edge[] = [];
      const currentEdges = useCircuitStore.getState().edges;
      const currentNodes = useCircuitStore.getState().nodes;
      
      const getPinPos = (nId: string, hId: string | null | undefined): FlowPoint | null => {
        if (!hId) return null;
        const n = nId === node.id ? node : currentNodes.find((x) => x.id === nId);
        if (!n) return null;
        const p = getNodePins(n, symbolNorm).find((q) => q.handleId === hId);
        return p ? { x: p.x, y: p.y } : null;
      };

      for (const pin of newPins) {
        let bestWire: Edge | null = null;
        let bestTap: FlowPoint | null = null;
        
        for (const e of currentEdges) {
          const s = (e.data?.sourceTap as FlowPoint | undefined) ?? getPinPos(e.source, e.sourceHandle);
          const t = (e.data?.targetTap as FlowPoint | undefined) ?? getPinPos(e.target, e.targetHandle);
          if (!s || !t) continue;
          const wp = (e.data?.waypoints as FlowPoint[] | undefined) ?? [];
          const verts = orthoVertices([s, ...wp, t]);
          for (let i = 0; i < verts.length - 1; i++) {
            const { point, d2 } = projectToSegment({ x: pin.x, y: pin.y }, verts[i], verts[i + 1]);
            if (d2 <= 4) {
              bestWire = e;
              bestTap = point;
              break;
            }
          }
          if (bestWire) break;
        }
        
        if (bestWire && bestTap) {
          const edgeId = `wire_${node.id}-${pin.handleId}__${bestWire.source}-${bestWire.sourceHandle}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
          newEdges.push({
            id: edgeId,
            source: node.id,
            sourceHandle: pin.handleId,
            target: bestWire.source,
            targetHandle: bestWire.sourceHandle,
            type: "wire",
            data: {
              waypoints: [],
              targetTap: bestTap,
              hostEdgeId: bestWire.id,
            },
          });
        }
      }
      
      if (newEdges.length > 0) {
        const { setEdges, connectPorts, regenerateNetlist } = useCircuitStore.getState();
        setEdges([...currentEdges, ...newEdges]);
        for (const ne of newEdges) {
          try {
            connectPorts(`${ne.source}-${ne.sourceHandle}`, `${ne.target}-${ne.targetHandle}`);
          } catch { /* */ }
        }
        regenerateNetlist();
      }
    },
    [],
  );

  const placeComponent = useCallback(
    (type: ComponentType, cx: number, cy: number) => {
      // Center the node on the (snapped) cursor: node.position is its top-left.
      const x = snapToGrid(cx) - NODE_SIZE / 2;
      const y = snapToGrid(cy) - NODE_SIZE / 2;
      const id = `${type}_${componentCounter++}`;
      // Ground uses label "0" internally; display label is separate
      const label = type === "ground" ? "0" : getNextLabel(type, existingLabels());
      const component = createSpiceComponent(type, id, label, x, y);
      if (placementRotation) component.rotate(placementRotation as 90 | 180 | 270);
      const valueLabel = getValueLabel(component, type);
      const node: Node = {
        id,
        type: "component",
        position: { x, y },
        data: { componentType: type, label, valueLabel, rotation: placementRotation },
      };
      addComponent(component, node);
      setTimeout(() => autoConnectNodePins(node), 0);
    },
    [addComponent, placementRotation, autoConnectNodePins],
  );

  const placeLibraryComponent = useCallback(
    (placement: PendingLibraryPlacement, cx: number, cy: number) => {
      const x = snapToGrid(cx) - NODE_SIZE / 2;
      const y = snapToGrid(cy) - NODE_SIZE / 2;

      if (placement.componentType === "subcircuit") {
        const id = `subckt_${componentCounter++}`;
        const label = getNextLabel("subcircuit", existingLabels());
        const component = createSubcircuitComponent(id, label, x, y, placement.raw ?? "", placement.pins ?? []);
        if (placementRotation) component.rotate(placementRotation as 90 | 180 | 270);
        const node: Node = {
          id,
          type: "component",
          position: { x, y },
          data: { componentType: "subcircuit", label, pins: placement.pins ?? [], subName: placement.name, symbolName: placement.symbolName, rotation: placementRotation },
        };
        addComponent(component, node);
        setTimeout(() => autoConnectNodePins(node), 0);
        return;
      }

      // Typed device backed by an imported .model – place the base symbol with
      // its model property pre-set so the netlist references the model.
      const id = `${placement.componentType}_${componentCounter++}`;
      const label = getNextLabel(placement.componentType, existingLabels());
      const component = createSpiceComponent(placement.componentType, id, label, x, y);
      if (placementRotation) component.rotate(placementRotation as 90 | 180 | 270);
      if (placement.model) component.setProperty("model", placement.model);
      const valueLabel = getValueLabel(component, placement.componentType) || placement.model;
      const node: Node = {
        id,
        type: "component",
        position: { x, y },
        data: { componentType: placement.componentType, label, valueLabel, rotation: placementRotation },
      };
      addComponent(component, node);
      setTimeout(() => autoConnectNodePins(node), 0);
    },
    [addComponent, placementRotation, autoConnectNodePins],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      if (e.key === "Escape") { cancelPlacing(); setEditorMode("select"); return; }
      if (e.key === "F2") { e.preventDefault(); toggleInsertComponent(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); if (canUndo()) undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); if (canRedo()) redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "r") {
        e.preventDefault();
        if (editorMode === "place") rotatePlacement(); else rotateSelected();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "m") {
        e.preventDefault();
        mirrorSelected();
        return;
      }
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
  }, [cancelPlacing, canUndo, canRedo, undo, redo, rotateSelected, mirrorSelected, deleteSelected, startPlacing, setEditorMode, editorMode, rotatePlacement, toggleInsertComponent]);

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges(addEdge(
        { ...connection, type: "step", style: { stroke: wireStroke, strokeWidth: 2 }, animated: false },
        edges,
      ));
      if (connection.source && connection.sourceHandle && connection.target && connection.targetHandle) {
        try {
          connectPorts(`${connection.source}-${connection.sourceHandle}`, `${connection.target}-${connection.targetHandle}`);
        } catch { /* visual-only */ }
      }
      regenerateNetlist();
    },
    [edges, setEdges, connectPorts, regenerateNetlist, wireStroke],
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

  // Open the component menu at a screen position. Shared by the right-click
  // handler and the touch long-press, so both offer the same actions.
  const openNodeMenu = useCallback(
    (node: Node, clientX: number, clientY: number) => {
      const f = reactFlowInstance.screenToFlowPosition({ x: clientX, y: clientY });
      const data = node.data as ComponentNodeData;
      setWireMenu(null);
      setSelectedComponentId(node.id);
      // Net labels get their own menu (net label ↔ connector).
      if (data?.componentType === "netlabel") {
        setNodeMenu({ id: node.id, label: data.label || "NET", x: clientX, y: clientY, fx: f.x, fy: f.y, isNetlabel: true, connector: !!data.connector });
        return;
      }
      const comp = circuit.components.get(node.id);
      if (!comp) return;
      // Ground carries no probes, but it must still be deletable without a
      // keyboard — so it gets a menu too, with just that entry.
      const isGround = comp.id.startsWith("ground");
      setNodeMenu({ id: node.id, label: comp.label, x: clientX, y: clientY, fx: f.x, fy: f.y, isGround });
    },
    [circuit, setSelectedComponentId, reactFlowInstance],
  );

  const openEdgeMenu = useCallback(
    (edge: Edge, clientX: number, clientY: number) => {
      const port = circuit.components.get(edge.source)?.ports.find((p) => p.id === `${edge.source}-${edge.sourceHandle}`);
      const netId = port?.netId ?? null;
      const f = reactFlowInstance.screenToFlowPosition({ x: clientX, y: clientY });
      setNodeMenu(null);
      setWireMenu({
        edgeId: edge.id,
        netId,
        vExpr: netVoltageExpr(circuit, netId),
        iExpr: netCurrentExpr(circuit, netId),
        x: clientX, y: clientY, fx: f.x, fy: f.y,
      });
    },
    [circuit, reactFlowInstance],
  );

  // Right-click a component → menu to view its current / voltage in the scope.
  const onNodeContextMenu: NodeMouseHandler = useCallback(
    (event, node) => {
      event.preventDefault();
      const e = event as React.MouseEvent;
      openNodeMenu(node as Node, e.clientX, e.clientY);
    },
    [openNodeMenu],
  );

  // Right-click a wire → menu to annotate the net's potential / current.
  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.preventDefault();
      openEdgeMenu(edge, event.clientX, event.clientY);
    },
    [openEdgeMenu],
  );

  /**
   * Map a screen point onto the node or wire under it. React Flow tags both with
   * `data-id`; a port handle carries one too, so walk up until an id is one we
   * know. Used by the long-press, which has no React Flow event to read.
   */
  const hitTest = useCallback(
    (x: number, y: number): { node?: Node; edge?: Edge } => {
      let el: Element | null = document.elementFromPoint(x, y);
      while (el) {
        const id = el.getAttribute("data-id");
        if (id) {
          const node = nodes.find((n) => n.id === id);
          if (node) return { node };
          const edge = edges.find((e) => e.id === id);
          if (edge) return { edge };
        }
        el = el.parentElement;
      }
      return {};
    },
    [nodes, edges],
  );

  // Screen → flow using the wrapper's *live* rect and the current viewport, so
  // placement matches the ghost even on the very first click (ReactFlow's own
  // cached container rect can still be stale then, landing the node offset).
  const clientToFlow = useCallback(
    (clientX: number, clientY: number) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      const vp = reactFlowInstance.getViewport();
      return {
        x: (clientX - (rect?.left ?? 0) - vp.x) / vp.zoom,
        y: (clientY - (rect?.top ?? 0) - vp.y) / vp.zoom,
      };
    },
    [reactFlowInstance],
  );

  /** Touch/pen long-press stands in for the right-click there is no way to make. */
  const onWrapperPointerDown = useCallback(
    (e: React.PointerEvent) => {
      lastPointerTypeRef.current = e.pointerType;
      if (!isLongPressPointer(e)) return;
      // Placing a part: the ghost tracks the finger/stylus, so dropping it where
      // the pointer lifts is the natural gesture. ReactFlow never delivers a
      // pane click for touch, so without this the ghost could not be committed.
      // (No long-press here — it would swallow the release that places the part.)
      if (editorMode === "place") {
        trackPointerDrag(e, () => {}, (ev) => {
          // Drop only on a real lift; a cancel (palm rejection, system takeover)
          // must not scatter a part where the gesture happened to abort.
          if (ev.type !== "pointerup") return;
          const pos = clientToFlow(ev.clientX, ev.clientY);
          if (pendingLibraryPlacement) placeLibraryComponent(pendingLibraryPlacement, pos.x, pos.y);
          else if (pendingPlaceType) placeComponent(pendingPlaceType, pos.x, pos.y);
        });
        return;
      }
      trackLongPress(e, (x, y) => {
        const { node, edge } = hitTest(x, y);
        if (node) openNodeMenu(node, x, y);
        else if (edge) openEdgeMenu(edge, x, y);
      });
    },
    [editorMode, pendingPlaceType, pendingLibraryPlacement, placeComponent, placeLibraryComponent, clientToFlow, hitTest, openNodeMenu, openEdgeMenu],
  );

  /** Add a component data-point (voltage across / current through). Placed just
   *  to the right of the component so it never covers the symbol; U and I sit
   *  slightly apart so both are readable. */
  const addComponentDataFlag = (kind: "V" | "I") => {
    const m = nodeMenu;
    const comp = m && circuit.components.get(m.id);
    const node = m && nodes.find((n) => n.id === m.id);
    if (m && comp && node) {
      const expr = kind === "V" ? compVoltageExpr(circuit, comp) : compCurrentExpr(comp);
      if (expr) {
        const x = node.position.x + NODE_SIZE + 30;
        const y = node.position.y + NODE_SIZE / 2 + (kind === "V" ? -22 : 22);
        addDataFlag(x, y, expr);
      }
    }
    setNodeMenu(null);
  };

  const addWireDataFlag = (expr: string) => {
    if (wireMenu) addDataFlag(wireMenu.fx, wireMenu.fy, expr);
    setWireMenu(null);
  };

  // Name the clicked wire's net (LTSpice-style). Two nets sharing a name become
  // one node in the netlist, so this connects distant parts and gives a stable
  // label to probe the potential.
  const nameWireNet = () => {
    const netId = wireMenu?.netId;
    if (!netId) { setWireMenu(null); return; }
    const cur = circuit.nets.get(netId)?.nodeLabel;
    const name = window.prompt(
      "Netzname (gleiche Namen werden elektrisch verbunden):",
      cur && cur !== netId ? cur : "",
    );
    if (name != null && name.trim()) renameNet(netId, name.trim());
    setWireMenu(null);
  };

  // Switch a net label between a plain wire-name tag and a directional connector.
  const setNetlabelConnector = (connector: boolean) => {
    if (nodeMenu) updateNodeData(nodeMenu.id, { connector });
    setNodeMenu(null);
  };

  const probeCurrentInScope = () => {
    const comp = nodeMenu && circuit.components.get(nodeMenu.id);
    if (comp) { addProbeCandidates(getCurrentProbeCandidates(comp.label)); setDockTab("waveform"); }
    setNodeMenu(null);
  };

  const probeVoltageInScope = () => {
    const comp = nodeMenu && circuit.components.get(nodeMenu.id);
    if (comp) {
      const expr = getVoltageDiffExpression(comp, circuit);
      if (expr) { addExpression(expr); setDockTab("waveform"); }
    }
    setNodeMenu(null);
  };

  const onPaneClick = useCallback(
    (event: React.MouseEvent) => {
      setSelectedComponentId(null);
      // Touch/pen already placed on pointerup (onWrapperPointerDown); only the
      // mouse commits its placement here, on the pane click.
      if (editorMode === "place" && lastPointerTypeRef.current === "mouse") {
        const pos = clientToFlow(event.clientX, event.clientY);
        if (pendingLibraryPlacement) {
          placeLibraryComponent(pendingLibraryPlacement, pos.x, pos.y);
        } else if (pendingPlaceType) {
          placeComponent(pendingPlaceType, pos.x, pos.y);
        }
      }
    },
    [editorMode, pendingPlaceType, pendingLibraryPlacement, placeComponent, placeLibraryComponent, setSelectedComponentId, clientToFlow],
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
      const pos = clientToFlow(event.clientX, event.clientY);
      placeComponent(def.type as ComponentType, pos.x, pos.y);
      dragDefRef.current = null;
    },
    [clientToFlow, placeComponent],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const removals = changes.filter((c) => c.type === "remove" && "id" in c);
      removals.forEach((c) => removeComponent((c as any).id));

      const symbolNorm = useUIStore.getState().symbolNorm;
      
      const modifiedChanges = changes.map(change => {
        if (change.type === 'position' && change.position && change.id) {
          const node = nodes.find(n => n.id === change.id);
          if (node && node.data.componentType === "netlabel") {
            const tapEdge = edges.find(e => e.source === node.id && e.data?.targetTap);
            if (tapEdge && tapEdge.data?.hostEdgeId) {
              const hostWire = edges.find(e => e.id === tapEdge.data?.hostEdgeId);
              if (hostWire) {
                const pinX = change.position.x + NODE_SIZE / 2;
                const pinY = change.position.y + NODE_SIZE / 2;
                
                const getPinPos = (nId: string, hId: string | null | undefined): FlowPoint | null => {
                  if (!hId) return null;
                  const n = nodes.find((x) => x.id === nId);
                  if (!n) return null;
                  const p = getNodePins(n, symbolNorm).find((q) => q.handleId === hId);
                  return p ? { x: p.x, y: p.y } : null;
                };
                
                const s = (hostWire.data?.sourceTap as FlowPoint | undefined) ?? getPinPos(hostWire.source, hostWire.sourceHandle);
                const t = (hostWire.data?.targetTap as FlowPoint | undefined) ?? getPinPos(hostWire.target, hostWire.targetHandle);
                
                if (s && t) {
                  const wp = (hostWire.data?.waypoints as FlowPoint[] | undefined) ?? [];
                  const verts = orthoVertices([s, ...wp, t]);
                  let bestTap: FlowPoint | null = null;
                  let minD2 = Infinity;
                  for (let i = 0; i < verts.length - 1; i++) {
                    const { point, d2 } = projectToSegment({ x: pinX, y: pinY }, verts[i], verts[i + 1]);
                    if (d2 < minD2) {
                      minD2 = d2;
                      bestTap = point;
                    }
                  }
                  
                  if (bestTap) {
                    change.position.x = bestTap.x - NODE_SIZE / 2;
                    change.position.y = bestTap.y - NODE_SIZE / 2;
                    
                    // Update the tap edge so it visually remains attached at length 0
                    setTimeout(() => {
                      const latestEdges = useCircuitStore.getState().edges;
                      useCircuitStore.getState().setEdges(latestEdges.map(e => e.id === tapEdge.id ? { ...e, data: { ...e.data, targetTap: bestTap } } : e));
                    }, 0);
                  }
                }
              }
            }
          }
        }
        return change;
      });

      setNodes(applyNodeChanges(modifiedChanges, nodes));
    },
    [nodes, setNodes, removeComponent, edges],
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

  /** Delete the part the menu was opened on (its wires go with it). */
  const deleteMenuNode = useCallback(() => {
    if (!nodeMenu) return;
    removeComponent(nodeMenu.id);
    setNodeMenu(null);
    setTimeout(() => rebuildConnections(), 0);
  }, [nodeMenu, removeComponent, rebuildConnections]);

  /** Delete the wire the menu was opened on. */
  const deleteMenuEdge = useCallback(() => {
    if (!wireMenu) return;
    setEdges(edges.filter((e) => e.id !== wireMenu.edgeId));
    setWireMenu(null);
    setTimeout(() => rebuildConnections(), 0);
  }, [wireMenu, edges, setEdges, rebuildConnections]);

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
          onPointerDown={onWrapperPointerDown}
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
            onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu}
            onPaneClick={onPaneClick}
            snapToGrid
            snapGrid={[GRID_SIZE, GRID_SIZE]}
            fitView={fitOnInit}
            fitViewOptions={{ padding: 0.3 }}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            deleteKeyCode={null}
            panOnDrag={!canvasLocked && editorMode !== "wire"}
            nodesDraggable={!canvasLocked && editorMode === "select"}
            elementsSelectable={editorMode === "select"}
            connectionRadius={24}
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={{
              type: "step",
              style: { stroke: wireStroke, strokeWidth: 2 },
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={GRID_SIZE} size={1} color={theme.gridDot} />
          </ReactFlow>

          {/* Custom zoom/fit/lock buttons. React Flow's own <Controls> did not
              respond to touch; these live outside its subtree and stop the
              pointerdown from reaching the canvas (place/long-press) handler. */}
          <div
            onPointerDown={(e) => e.stopPropagation()}
            style={{ position: "absolute", right: 12, bottom: 12, zIndex: 8, display: "flex", flexDirection: "column", gap: 6, touchAction: "manipulation" }}
          >
            <button style={canvasButton} title="Vergrößern" onClick={() => reactFlowInstance.zoomIn()}>+</button>
            <button style={canvasButton} title="Verkleinern" onClick={() => reactFlowInstance.zoomOut()}>−</button>
            <button style={canvasButton} title="Einpassen" onClick={() => reactFlowInstance.fitView({ padding: 0.3 })}>▣</button>
            <button
              style={{ ...canvasButton, color: canvasLocked ? theme.accent : theme.symPreview }}
              title={canvasLocked ? "Ansicht entsperren" : "Ansicht sperren (kein Verschieben)"}
              onClick={() => setCanvasLocked((v) => !v)}
            >{canvasLocked ? "🔒" : "🔓"}</button>
          </div>

          <DataFlagLayer />
          <DirectiveBox />

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

      {/* Component right-click menu: view current / voltage in the scope */}
      {nodeMenu && (
        <>
          <div
            onClick={() => setNodeMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setNodeMenu(null); }}
            style={{ position: "fixed", inset: 0, zIndex: 3000 }}
          />
          <div style={{
            position: "fixed", left: nodeMenu.x, top: nodeMenu.y, zIndex: 3001,
            background: "#1e293b", border: "1px solid #334155", borderRadius: 6,
            padding: 4, fontSize: 12, boxShadow: "0 4px 12px #00000070", minWidth: 170,
          }}>
            <div style={{ padding: "3px 10px 5px", fontSize: 10, color: "#64748b", fontWeight: 600 }}>{nodeMenu.label}</div>
            {nodeMenu.isNetlabel ? (
              <>
                <button style={nodeMenuItem} onClick={() => setNetlabelConnector(false)}>
                  {nodeMenu.connector ? " " : "✓ "}Net label (Leitung benennen)
                </button>
                <button style={nodeMenuItem} onClick={() => setNetlabelConnector(true)}>
                  {nodeMenu.connector ? "✓ " : " "}Connector (Pfeil, verbindet entfernte Netze)
                </button>
              </>
            ) : nodeMenu.isGround ? null : (
              <>
                <button style={nodeMenuItem} onClick={() => addComponentDataFlag("V")}>Datenpunkt: Spannung U</button>
                <button style={nodeMenuItem} onClick={() => addComponentDataFlag("I")}>Datenpunkt: Strom I</button>
                <div style={{ height: 1, background: "#334155", margin: "4px 6px" }} />
                <button style={nodeMenuItem} onClick={probeCurrentInScope}>View I({nodeMenu.label}) in scope</button>
                <button style={nodeMenuItem} onClick={probeVoltageInScope}>View U({nodeMenu.label}) in scope</button>
              </>
            )}
            <div style={{ height: 1, background: "#334155", margin: "4px 6px" }} />
            <button style={dangerMenuItem} onClick={deleteMenuNode}>🗑 Löschen</button>
          </div>
        </>
      )}

      {/* Wire right-click menu: annotate the net's potential / current */}
      {wireMenu && (
        <>
          <div
            onClick={() => setWireMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setWireMenu(null); }}
            style={{ position: "fixed", inset: 0, zIndex: 3000 }}
          />
          <div style={{
            position: "fixed", left: wireMenu.x, top: wireMenu.y, zIndex: 3001,
            background: "#1e293b", border: "1px solid #334155", borderRadius: 6,
            padding: 4, fontSize: 12, boxShadow: "0 4px 12px #00000070", minWidth: 190,
          }}>
            <div style={{ padding: "3px 10px 5px", fontSize: 10, color: "#64748b", fontWeight: 600 }}>Leitung</div>
            <button style={nodeMenuItem} onClick={nameWireNet}>🏷 Netz benennen…</button>
            {wireMenu.vExpr
              ? <button style={nodeMenuItem} onClick={() => addWireDataFlag(wireMenu.vExpr!)}>Datenpunkt: Potential {wireMenu.vExpr}</button>
              : <div style={{ ...nodeMenuItem, color: "#64748b", cursor: "default" }}>Kein Potential verfügbar</div>}
            {wireMenu.iExpr
              ? <button style={nodeMenuItem} onClick={() => addWireDataFlag(wireMenu.iExpr!)}>Datenpunkt: Strom {wireMenu.iExpr}</button>
              : <div style={{ ...nodeMenuItem, color: "#64748b", cursor: "default" }}>Strom nur bei Reihenschaltung</div>}
            <div style={{ height: 1, background: "#334155", margin: "4px 6px" }} />
            <button style={dangerMenuItem} onClick={deleteMenuEdge}>🗑 Leitung löschen</button>
          </div>
        </>
      )}
    </div>
  );
}

/** Destructive entry: same shape as a normal one, warning colour. */
const dangerMenuItem: React.CSSProperties = {
  display: "block", width: "100%", padding: "5px 10px", textAlign: "left",
  border: "none", background: "transparent", color: "#fca5a5", cursor: "pointer",
  fontSize: 12, borderRadius: 4, whiteSpace: "nowrap",
};

const nodeMenuItem: React.CSSProperties = {
  display: "block", width: "100%", padding: "5px 10px", textAlign: "left",
  border: "none", background: "transparent", color: "#e2e8f0", cursor: "pointer",
  fontSize: 12, borderRadius: 4, whiteSpace: "nowrap",
};

/** Touch-friendly square button for the on-canvas zoom / fit / lock controls. */
const canvasBtn: React.CSSProperties = {
  width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center",
  border: "1px solid #cbd5e1", borderRadius: 6, background: "#fff", color: "#334155",
  fontSize: 17, lineHeight: 1, cursor: "pointer", boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
};

export function SchematicCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

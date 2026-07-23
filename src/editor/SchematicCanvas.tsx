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
import { autoConnectEdgesFor, type DockPin, type WireGeom } from "./autoConnect.js";
import { DataFlagLayer } from "./DataFlagLayer.js";
import { NetAnchorLayer } from "./NetAnchorLayer.js";
import { TextBoxLayer } from "./TextBoxLayer.js";
import { SheetShapeLayer } from "./SheetShapeLayer.js";
import { DirectiveBox } from "./DirectiveBox.js";
import { PlacementGhost } from "./PlacementGhost.js";
import { NODE_SIZE, GRID, GRID_DOTS, snapToGrid, getNodePins, edgeRouteHints } from "./pinGeometry.js";
import { PropertiesPanel } from "./PropertiesPanel.js";
import { Toolbar } from "./Toolbar.js";
import { ComponentPalette } from "./ComponentPalette.js";
import { NetLabelsPanel } from "./NetLabelsPanel.js";
import { WirePropertiesPanel } from "./WirePropertiesPanel.js";
import { DockPanel } from "./DockPanel.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { ClampedMenu } from "../ClampedMenu.js";
import { useSimulationStore } from "@store/simulationStore.js";
import type { ComponentDefinition } from "./componentDefinitions.js";
import { createSpiceComponent, createSubcircuitComponent, getNextLabel, getValueLabel, nextComponentId } from "./componentFactory.js";
import type { PendingLibraryPlacement } from "@store/uiStore.js";
import { getProbeCandidates, getCurrentProbeCandidates, getVoltageDiffExpression } from "@core/circuit/probeUtils.js";
import { netVoltageExpr, netCurrentExpr, currentExprDevice, compVoltageExpr, compCurrentExpr } from "@core/circuit/dataExpr.js";
import { usePlotStore } from "@simulation/plotStore.js";
import type { ComponentType, ComponentNodeData } from "./nodes/ComponentNode.js";
import { isLongPressPointer, trackLongPress } from "./longPress.js";
import { trackPointerDrag } from "./pointerDrag.js";
import { forgetImportedRoutes } from "./importedRoutes.js";
import { FragmentGhost } from "./FragmentGhost.js";
import { buildFragment, isFragment } from "@core/ltspice/ascFragment.js";

const NODE_TYPES = { component: ComponentNode };
const EDGE_TYPES = { wire: WireEdge };
let wireCounter = 1;

function CanvasInner() {
  const reactFlowInstance = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  /** Last pointer position (screen coords), so a paste lands under the cursor. */
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
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
    rotateSelected, rotateComponent, mirrorSelected, deleteSelected, rebuildConnections,
    circuit, addDataFlag, renameNet, viewFitNonce, pasteNotice, clearPasteNotice,
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
    setDockTab, autoProbeCurrent, areaSelect, pendingFragment,
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
  const [nodeMenu, setNodeMenu] = useState<{ id: string; label: string; x: number; y: number; fx: number; fy: number; isNetlabel?: boolean; connector?: boolean; isGround?: boolean; netId?: string | null; vExpr?: string | null; iExpr?: string | null } | null>(null);
  /** Right-click menu on a wire: annotate the net's potential / current. */
  const [wireMenu, setWireMenu] = useState<{ edgeId: string; netId: string | null; vExpr: string | null; iExpr: string | null; x: number; y: number; fx: number; fy: number } | null>(null);

  // Only auto-fit when the canvas already has content at mount. On an empty
  // canvas fitView would stay pending and first fire when the first node is
  // placed, jerking the zoom (shrinking the ghost and offsetting placement).
  const [fitOnInit] = useState(() => nodes.length > 0);
  // Freezes the canvas: components are pinned, the view does not pan. On a touch
  // device this stops the schematic sliding around under a stray finger while you
  // read or draw. It lives in the UI store so it also reaches the caption drags
  // and the connector tap-to-rotate inside the nodes (see ComponentNode).
  const canvasLocked = useUIStore((s) => s.canvasLocked);
  const toggleCanvasLocked = useUIStore((s) => s.toggleCanvasLocked);
  // One tap = one flip, whichever event the browser sends (see the lock button).
  const lockTapRef = useRef(0);
  const toggleLock = useCallback(() => {
    const now = Date.now();
    if (now - lockTapRef.current < 400) return;
    lockTapRef.current = now;
    toggleCanvasLocked();
  }, [toggleCanvasLocked]);

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

      // Pins of every *other* component, so a freshly placed pin that lands on
      // one can dock straight onto the part — not only onto a wire. (The placed
      // node is already in the store by the time this runs, so exclude it.)
      const otherPins: DockPin[] = currentNodes
        .filter((n) => n.id !== node.id)
        .flatMap((n) => getNodePins(n, symbolNorm))
        .map((p) => ({ nodeId: p.nodeId, handleId: p.handleId, x: p.x, y: p.y }));

      // Existing wires resolved to their vertex chains, so a pin can tap them.
      const wires: WireGeom[] = [];
      for (const e of currentEdges) {
        const s = (e.data?.sourceTap as FlowPoint | undefined) ?? getPinPos(e.source, e.sourceHandle);
        const t = (e.data?.targetTap as FlowPoint | undefined) ?? getPinPos(e.target, e.targetHandle);
        if (!s || !t) continue;
        const wp = (e.data?.waypoints as FlowPoint[] | undefined) ?? [];
        wires.push({ id: e.id, source: e.source, sourceHandle: e.sourceHandle ?? null, verts: orthoVertices([s, ...wp, t], edgeRouteHints(currentNodes, e, symbolNorm)) });
      }

      // True when a wire already joins these two pin endpoints (either
      // orientation), so a re-dock never lays a second identical edge.
      const alreadyWired = (a: DockPin, bNode: string, bHandle: string) =>
        currentEdges.some((e) =>
          (e.source === a.nodeId && e.sourceHandle === a.handleId && e.target === bNode && e.targetHandle === bHandle) ||
          (e.source === bNode && e.sourceHandle === bHandle && e.target === a.nodeId && e.targetHandle === a.handleId));

      const dockPins: DockPin[] = newPins.map((p) => ({ nodeId: p.nodeId, handleId: p.handleId, x: p.x, y: p.y }));
      for (const c of autoConnectEdgesFor(dockPins, otherPins, wires, alreadyWired)) {
        newEdges.push({
          id: `wire_${c.source}-${c.sourceHandle}__${c.target}-${c.targetHandle}_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          source: c.source,
          sourceHandle: c.sourceHandle,
          target: c.target,
          targetHandle: c.targetHandle,
          type: "wire",
          data: c.tap ? { waypoints: [], targetTap: c.tap, hostEdgeId: c.hostEdgeId } : { waypoints: [] },
        });
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
      // A name is not a part: it goes down as an anchor at the point the user
      // aimed at, and that is the whole of it. It used to be a node with a pin,
      // which is why dropping one on a terminal had to step it clear of the part
      // and join it with a short lead — otherwise the two coincident pins wrote a
      // zero-length `WIRE x y x y`. An anchor simply sits where it was dropped,
      // on the pin included, exactly as in LTSpice.
      if (type === "netlabel" || type === "netconnector") {
        const at = { x: snapToGrid(cx), y: snapToGrid(cy) };
        const isConnector = type === "netconnector";
        const name = getNextLabel(type, existingLabels());
        // A fresh connector defaults to a bi-directional port, the type that says
        // the least about the signal and reads as the plain double arrow.
        const id = useCircuitStore.getState().addNetAnchor(at.x, at.y, name, isConnector ? "BiDir" : undefined);
        useUIStore.getState().setSelectedAnchorId(id);
        return;
      }

      // Center the node on the (snapped) cursor: node.position is its top-left.
      const terminal = { x: snapToGrid(cx), y: snapToGrid(cy) };
      const x = terminal.x - NODE_SIZE / 2;
      const y = terminal.y - NODE_SIZE / 2;
      // Never reuse an id an import already handed out (see nextComponentId).
      const id = nextComponentId(type, useCircuitStore.getState().nodes.map((n) => n.id));
      // Ground uses label "0" internally; display label is separate
      const label = type === "ground" ? "0" : getNextLabel(type, existingLabels());
      const component = createSpiceComponent(type, id, label, x, y);
      if (placementRotation) component.rotate(placementRotation as 90 | 180 | 270);
      const valueLabel = getValueLabel(component, type);
      const node: Node = {
        id,
        type: "component",
        position: { x, y },
        data: {
          componentType: type, label, valueLabel, rotation: placementRotation,
        },
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
        const id = nextComponentId("subckt", useCircuitStore.getState().nodes.map((n) => n.id));
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
      const id = nextComponentId(placement.componentType, useCircuitStore.getState().nodes.map((n) => n.id));
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

      if (e.key === "Escape") {
        // A carried block is dropped first: Escape means "not this", and the
        // block is the most recent thing the user picked up.
        if (useUIStore.getState().pendingFragment) { useUIStore.getState().setPendingFragment(null); return; }
        cancelPlacing(); setEditorMode("select"); return;
      }
      if (e.key === "F2") { e.preventDefault(); toggleInsertComponent(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) { e.preventDefault(); if (canUndo()) undo(); return; }
      if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) { e.preventDefault(); if (canRedo()) redo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key === "r") {
        e.preventDefault();
        if (editorMode === "place") rotatePlacement(); else rotateSelected();
        return;
      }
      // Ctrl+E is LTSpice's "Mirror"; Ctrl+M is kept as our original binding.
      if ((e.ctrlKey || e.metaKey) && (e.key === "m" || e.key === "e")) {
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

  /**
   * Cut / copy / paste of the selection, carried as `.asc` text on the system
   * clipboard (see ascFragment) so a block can be pasted into a *different*
   * schematic, another tab, or after a reload.
   *
   * Driven by the clipboard *events* rather than `navigator.clipboard`: reading
   * the clipboard directly is unavailable to web pages in Firefox and needs a
   * permission prompt in Chrome, while `e.clipboardData` inside a real cut/copy/
   * paste gesture works everywhere and asks nothing. The browser only fires these
   * when the user actually pressed the keys, which is exactly the gate we want.
   */
  useEffect(() => {
    const editingText = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      const tag = el?.tagName;
      return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || el?.isContentEditable === true;
    };

    const onCopy = (e: ClipboardEvent, cut: boolean) => {
      // A dialog's text field owns its own clipboard behaviour.
      if (editingText(e.target)) return;
      const { nodes: ns, edges: es, circuit: c, netAnchors: as } = useCircuitStore.getState();
      const fragment = buildFragment(ns, es, c, as);
      if (!fragment) return;
      e.clipboardData?.setData("text/plain", fragment);
      e.preventDefault();
      if (cut) deleteSelected();
      // The block now rides on the cursor until it is clicked down, as it does in
      // LTSpice. The clipboard is filled too — that is what a paste into another
      // schematic later uses.
      useUIStore.getState().setPendingFragment(fragment);
    };

    const onPaste = (e: ClipboardEvent) => {
      if (editingText(e.target)) return;
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      // Anything that isn't a schematic fragment is left to the browser — the
      // user may be pasting into something else on the page.
      if (!isFragment(text)) return;
      e.preventDefault();
      // Drop it under the pointer when we know where that is, so a paste lands
      // where the user is looking rather than on top of the original.
      const p = lastPointer.current;
      const at = p ? reactFlowInstance.screenToFlowPosition(p) : undefined;
      useCircuitStore.getState().pasteFragment(text, at);
    };

    const copy = (e: ClipboardEvent) => onCopy(e, false);
    const cut = (e: ClipboardEvent) => onCopy(e, true);
    window.addEventListener("copy", copy);
    window.addEventListener("cut", cut);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("copy", copy);
      window.removeEventListener("cut", cut);
      window.removeEventListener("paste", onPaste);
    };
  }, [deleteSelected, reactFlowInstance]);

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
      // Net labels get their own menu (net label ↔ connector), plus the options
      // to plot the potential of the node they name and the current through it —
      // the same probes a wire on that net offers, so a named net is reachable
      // however you right-click it.
      if (data?.componentType === "netlabel" || data?.componentType === "netconnector") {
        const netId = circuit.components.get(node.id)?.ports[0]?.netId ?? null;
        setNodeMenu({
          id: node.id, label: data.label || "NET", x: clientX, y: clientY, fx: f.x, fy: f.y,
          isNetlabel: true, connector: !!data.connector,
          netId, vExpr: netVoltageExpr(circuit, netId), iExpr: netCurrentExpr(circuit, netId),
        });
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
  /**
   * Put down a block that is riding on the cursor after a cut or copy.
   *
   * Takes precedence over everything else a click on the pane does: while a
   * block is being carried, that is unambiguously what the click is for.
   */
  const dropPendingFragment = useCallback(
    (clientX: number, clientY: number) => {
      const text = useUIStore.getState().pendingFragment;
      if (!text) return false;
      const pos = clientToFlow(clientX, clientY);
      useCircuitStore.getState().pasteFragment(text, { x: snapToGrid(pos.x), y: snapToGrid(pos.y) });
      useUIStore.getState().setPendingFragment(null);
      return true;
    },
    [clientToFlow],
  );

  const onWrapperPointerDown = useCallback(
    (e: React.PointerEvent) => {
      lastPointerTypeRef.current = e.pointerType;
      if (!isLongPressPointer(e)) return;
      // Carrying a cut/copied block: the ghost follows the finger and the block
      // lands where it lifts. Without this a touch device could pick a block up
      // and never put it down — ReactFlow delivers no pane click for touch.
      if (useUIStore.getState().pendingFragment) {
        trackPointerDrag(e, () => {}, (ev) => {
          if (ev.type !== "pointerup") return;
          dropPendingFragment(ev.clientX, ev.clientY);
        });
        return;
      }
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
    [editorMode, pendingPlaceType, pendingLibraryPlacement, placeComponent, placeLibraryComponent, clientToFlow, hitTest, openNodeMenu, openEdgeMenu, dropPendingFragment],
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

  // Plot the potential of the net a label names, as a scope trace.
  const probeNetlabelVoltageInScope = () => {
    if (nodeMenu?.vExpr) { addExpression(nodeMenu.vExpr); setDockTab("waveform"); }
    setNodeMenu(null);
  };

  // Plot the potential of the wire's net, as a scope trace (same as a net label).
  const probeWireVoltageInScope = () => {
    if (wireMenu?.vExpr) { addExpression(wireMenu.vExpr); setDockTab("waveform"); }
    setWireMenu(null);
  };

  // Plot the current through the net a label names. `I(dev)` names one of the
  // two devices in series on that net; probing by candidates rather than the
  // bare expression also catches the `@dev[i]` forms of `.options savecurrents`.
  const probeNetlabelCurrentInScope = () => {
    const dev = currentExprDevice(nodeMenu?.iExpr);
    if (dev) { addProbeCandidates(getCurrentProbeCandidates(dev)); setDockTab("waveform"); }
    setNodeMenu(null);
  };

  // Pin a net probe (potential or current) as a data-point badge, next to the
  // label terminal; U and I sit slightly apart so both stay readable.
  const addNetlabelDataFlag = (kind: "V" | "I") => {
    const m = nodeMenu;
    const node = m && nodes.find((n) => n.id === m.id);
    const expr = kind === "V" ? m?.vExpr : m?.iExpr;
    if (expr && node) {
      addDataFlag(
        node.position.x + NODE_SIZE + 6,
        node.position.y + NODE_SIZE / 2 + (kind === "V" ? -11 : 11),
        expr,
      );
    }
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
      if (dropPendingFragment(event.clientX, event.clientY)) return;
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
    [editorMode, pendingPlaceType, pendingLibraryPlacement, placeComponent, placeLibraryComponent, setSelectedComponentId, clientToFlow, dropPendingFragment],
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

  /** Forget the imported path of the wires on a moved part (see importedRoutes). */
  const dropImportedRoutes = useCallback((movedIds: Set<string>) => {
    const next = forgetImportedRoutes(useCircuitStore.getState().edges, movedIds);
    if (next) useCircuitStore.getState().setEdges(next);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const removals = changes.filter((c) => c.type === "remove" && "id" in c);
      removals.forEach((c) => removeComponent((c as any).id));

      const symbolNorm = useUIStore.getState().symbolNorm;
      // Read the *current* nodes and wires, never the ones this callback closed
      // over. A click can change the store before React Flow's own change for the
      // same click arrives — putting down a cut/copied block is exactly that —
      // and rebuilding from the stale array then threw the new parts away again.
      // The paste had happened, the notice appeared, and the block never showed.
      const nodes = useCircuitStore.getState().nodes;
      const edges = useCircuitStore.getState().edges;
      
      const modifiedChanges = changes.map(change => {
        if (change.type === 'position' && change.position && change.id) {
          const node = nodes.find(n => n.id === change.id);
          if (node && (node.data.componentType === "netlabel" || node.data.componentType === "netconnector")) {
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
                  const verts = orthoVertices([s, ...wp, t], edgeRouteHints(nodes, hostWire, symbolNorm));
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

      // Once a part actually moves, the imported detours of the wires hanging off
      // it describe a layout that no longer exists. Drop them so those wires
      // re-route themselves squarely; every other wire, and anything the user
      // routed by hand, is left exactly as it is.
      const moved = new Set(
        modifiedChanges
          .filter((c): c is NodeChange & { id: string } => c.type === "position" && "id" in c && !!(c as any).position)
          .map((c) => c.id),
      );
      if (moved.size > 0) dropImportedRoutes(moved);
    },
    [setNodes, removeComponent, dropImportedRoutes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const removals = changes.filter((c) => c.type === "remove" && "id" in c);
      // Current wires, not the closed-over ones — same hazard as onNodesChange.
      setEdges(applyEdgeChanges(changes, useCircuitStore.getState().edges));
      if (removals.length > 0) {
        setTimeout(() => rebuildConnections(), 0);
      }
    },
    [setEdges, rebuildConnections],
  );

  const cursorStyle =
    editorMode === "place" ? "crosshair" :
    editorMode === "wire"  ? "cell" : "default";

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
          onPointerMove={(e) => { lastPointer.current = { x: e.clientX, y: e.clientY }; }}
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
            onNodeClick={onNodeClick}
            onNodeDoubleClick={onNodeDoubleClick}
            onNodeContextMenu={onNodeContextMenu}
            onEdgeContextMenu={onEdgeContextMenu}
            onPaneClick={onPaneClick}
            snapToGrid
            snapGrid={[GRID, GRID]}
            fitView={fitOnInit}
            fitViewOptions={{ padding: 0.3 }}
            defaultViewport={{ x: 0, y: 0, zoom: 1 }}
            deleteKeyCode={null}
            // Area select turns the empty-canvas drag into a rubber band; Shift+drag
            // does the same via React Flow's own selectionKeyCode and keeps working
            // either way (see uiStore.areaSelect).
            selectionOnDrag={areaSelect && editorMode === "select"}
            panOnDrag={!canvasLocked && editorMode !== "wire" && !(areaSelect && editorMode === "select")}
            nodesDraggable={!canvasLocked && editorMode === "select"}
            // A connector is a grab point for the part, not the start of a wire:
            // in select mode a press on it drags the part like any other spot on
            // it, and wires are drawn in wire mode, where the overlay covers the
            // canvas anyway. React Flow's own connection gesture would otherwise
            // fire on every press of a terminal — and it produced a plain "step"
            // edge, a second kind of wire beside the app's own.
            nodesConnectable={false}
            // Click-to-connect is a second way into the same gesture and does not
            // go through `isConnectable`: the handle's own click handler only
            // consults `isConnectableStart`, which defaults to true. Left on, a
            // click on a terminal started a connection and trailed a dashed line
            // after the cursor instead of picking the part up.
            connectOnClick={false}
            elementsSelectable={editorMode === "select"}
            connectionRadius={24}
            connectionMode={ConnectionMode.Loose}
            defaultEdgeOptions={{
              type: "step",
              style: { stroke: wireStroke, strokeWidth: 2 },
            }}
          >
            <Background variant={BackgroundVariant.Dots} gap={GRID_DOTS} size={1} color={theme.gridDot} />
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
              style={{
                ...canvasButton,
                color: canvasLocked ? "#fff" : theme.symPreview,
                background: canvasLocked ? theme.accent : canvasButton.background,
                borderColor: canvasLocked ? theme.accent : canvasButton.border as string,
              }}
              title={canvasLocked ? "Entsperren (Bauteile wieder verschiebbar)" : "Sperren (Bauteile fixieren)"}
              aria-pressed={canvasLocked}
              // Toggle on whichever event the device delivers. Relying on `click`
              // alone left the lock unreachable with the Apple Pencil; relying on
              // `pointerup` alone is just as brittle (Safari does not always let
              // preventDefault suppress the following click). Take both and
              // swallow the second one — the lock must flip exactly once per tap.
              onPointerUp={() => toggleLock()}
              onClick={() => toggleLock()}
            >
              <LockIcon locked={canvasLocked} />
            </button>
          </div>

          <SheetShapeLayer />
          <NetAnchorLayer />
          <DataFlagLayer />
          <TextBoxLayer />
          <DirectiveBox />

          {/* Keeping a pasted block's net names is LTSpice's behaviour and stays
              the default — but it wires the copy into the original wherever the
              names meet, and nothing on the schematic shows that. Saying so here
              is what makes the merge a decision instead of a surprise found later
              in the netlist. */}
          {pasteNotice && (
            <div
              style={{
                position: "absolute", left: "50%", top: 12, transform: "translateX(-50%)",
                zIndex: 20, maxWidth: "min(560px, 90%)",
                display: "flex", alignItems: "flex-start", gap: 10,
                padding: "8px 12px", borderRadius: 4, fontSize: 12, lineHeight: 1.45,
                background: theme.panelBg, color: theme.symPreview,
                border: `1px solid ${theme.border}`, boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
              }}
            >
              <span>
                Diese Netznamen gab es schon: <b>{pasteNotice.join(", ")}</b>. Der eingefügte
                Block ist dadurch mit der vorhandenen Schaltung verbunden — wie in LTSpice.
                Nicht gewollt? Mit Strg+Z rückgängig machen oder die Label umbenennen.
              </span>
              <button
                onClick={clearPasteNotice}
                title="Hinweis schließen"
                style={{
                  flexShrink: 0, border: "none", background: "transparent", cursor: "pointer",
                  color: "inherit", fontSize: 16, lineHeight: 1, padding: 0,
                }}
              >
                ×
              </button>
            </div>
          )}

          {pendingFragment && <FragmentGhost wrapperRef={wrapperRef} fragment={pendingFragment} />}

          {editorMode === "wire" && (
            <WireOverlay wrapperRef={wrapperRef} nodes={nodes} edges={edges} onCreateWire={onCreateWire} />
          )}

          {editorMode === "place" && pendingPlaceType && (
            <PlacementGhost wrapperRef={wrapperRef} type={pendingPlaceType} />
          )}
        </div>

        {showPropertiesPanel && (
          // keyboard-safe: its fields (component values, net names) can sit at the
          // bottom, where iPadOS' autofill bar would cover them (see index.css).
          <aside className="keyboard-safe" style={{ display: "flex", flexDirection: "column", overflow: "auto" }}>
            {edges.some((e) => e.selected) ? <WirePropertiesPanel /> : <PropertiesPanel />}
            <NetLabelsPanel />
          </aside>
        )}
      </div>
      <DockPanel />

      {/* Component right-click menu: view current / voltage in the scope */}
      {nodeMenu && (
        <ContextMenu x={nodeMenu.x} y={nodeMenu.y} minWidth={170} onClose={() => setNodeMenu(null)}>
            <div style={{ padding: "3px 10px 5px", fontSize: 10, color: "#64748b", fontWeight: 600 }}>{nodeMenu.label}</div>
            {nodeMenu.isNetlabel ? (
              <>
                {/* Label ↔ connector is no longer a toggle here: the two are
                    separate parts (LTSpice stores them differently), and the
                    connector's direction lives in its own properties panel. */}
                {nodeMenu.vExpr ? (
                  <>
                    <button style={nodeMenuItem} onClick={probeNetlabelVoltageInScope}>{nodeMenu.vExpr} im Oszi anzeigen</button>
                    <button style={nodeMenuItem} onClick={() => addNetlabelDataFlag("V")}>Datenpunkt: Potential {nodeMenu.vExpr}</button>
                  </>
                ) : (
                  <div style={{ ...nodeMenuItem, color: "#64748b", cursor: "default" }}>Kein Potential verfügbar</div>
                )}
                {nodeMenu.iExpr ? (
                  <>
                    <button style={nodeMenuItem} onClick={probeNetlabelCurrentInScope}>{nodeMenu.iExpr} im Oszi anzeigen</button>
                    <button style={nodeMenuItem} onClick={() => addNetlabelDataFlag("I")}>Datenpunkt: Strom {nodeMenu.iExpr}</button>
                  </>
                ) : (
                  <div style={{ ...nodeMenuItem, color: "#64748b", cursor: "default" }}>Strom nur bei Reihenschaltung</div>
                )}
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
            <button style={nodeMenuItem} onClick={() => { rotateComponent(nodeMenu.id); setNodeMenu(null); }}>↻ Drehen 90°</button>
            <button style={dangerMenuItem} onClick={deleteMenuNode}>🗑 Löschen</button>
        </ContextMenu>
      )}

      {/* Wire right-click menu: annotate the net's potential / current */}
      {wireMenu && (
        <ContextMenu x={wireMenu.x} y={wireMenu.y} minWidth={190} onClose={() => setWireMenu(null)}>
            <div style={{ padding: "3px 10px 5px", fontSize: 10, color: "#64748b", fontWeight: 600 }}>Leitung</div>
            <button style={nodeMenuItem} onClick={nameWireNet}>🏷 Netz benennen…</button>
            {wireMenu.vExpr && (
              <button style={nodeMenuItem} onClick={probeWireVoltageInScope}>{wireMenu.vExpr} im Oszi anzeigen</button>
            )}
            {wireMenu.vExpr
              ? <button style={nodeMenuItem} onClick={() => addWireDataFlag(wireMenu.vExpr!)}>Datenpunkt: Potential {wireMenu.vExpr}</button>
              : <div style={{ ...nodeMenuItem, color: "#64748b", cursor: "default" }}>Kein Potential verfügbar</div>}
            {wireMenu.iExpr
              ? <button style={nodeMenuItem} onClick={() => addWireDataFlag(wireMenu.iExpr!)}>Datenpunkt: Strom {wireMenu.iExpr}</button>
              : <div style={{ ...nodeMenuItem, color: "#64748b", cursor: "default" }}>Strom nur bei Reihenschaltung</div>}
            <div style={{ height: 1, background: "#334155", margin: "4px 6px" }} />
            <button style={dangerMenuItem} onClick={deleteMenuEdge}>🗑 Leitung löschen</button>
        </ContextMenu>
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

/**
 * Padlock, drawn rather than taken from the emoji font: iOS renders 🔓 (open) so
 * close to 🔒 that the button looked permanently locked. Here the open state is
 * unmistakable — the shackle stands off to the side.
 */
function LockIcon({ locked }: { locked: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="11" width="13" height="10" rx="2" />
      {locked
        // Shackle down on both sides, sitting on the body.
        ? <path d="M6 11V7a3.5 3.5 0 0 1 7 0v4" />
        // Open: the shackle is lifted clear of the body and swung to the right,
        // so the two states cannot be confused at 18 px (the emoji 🔓 could).
        : <path d="M6 11V7a3.5 3.5 0 0 1 7 0" />}
    </svg>
  );
}

/** Touch-friendly square button for the on-canvas zoom / fit / lock controls. */
const canvasBtn: React.CSSProperties = {
  width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center",
  border: "1px solid #cbd5e1", borderRadius: 6, background: "#fff", color: "#334155",
  fontSize: 17, lineHeight: 1, cursor: "pointer", boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
};

/** Right-click menu with the schematic's dark chrome; positioning + viewport
 *  clamping are handled by {@link ClampedMenu}. */
function ContextMenu({ x, y, minWidth, onClose, children }: {
  x: number;
  y: number;
  minWidth?: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <ClampedMenu x={x} y={y} onClose={onClose} style={{
      background: "#1e293b", border: "1px solid #334155", borderRadius: 6,
      padding: 4, fontSize: 12, boxShadow: "0 4px 12px #00000070", minWidth,
    }}>
      {children}
    </ClampedMenu>
  );
}

export function SchematicCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

import { useEffect, useState, type RefObject } from "react";
import { useReactFlow, useViewport } from "@xyflow/react";
import { SymbolPreview } from "./SymbolPreview.js";
import { NODE_SIZE, NODE_MARGIN } from "./pinGeometry.js";
import { useUIStore } from "@store/uiStore.js";
import type { ComponentType } from "./nodes/ComponentNode.js";

const GRID = 20;

interface PlacementGhostProps {
  wrapperRef: RefObject<HTMLDivElement | null>;
  type: ComponentType;
}

/**
 * Semi-transparent preview of the component about to be placed. It follows the
 * cursor (grid-snapped), is centered exactly where the node will land, and is
 * scaled with the current zoom so it matches the real component's size 1:1.
 */
export function PlacementGhost({ wrapperRef, type }: PlacementGhostProps) {
  const { screenToFlowPosition, flowToScreenPosition } = useReactFlow();
  const { zoom } = useViewport();
  const placementRotation = useUIStore((s) => s.placementRotation);
  const [flowPos, setFlowPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // Snap to the grid point where the node's center will land.
      setFlowPos({ x: Math.round(flow.x / GRID) * GRID, y: Math.round(flow.y / GRID) * GRID });
    };
    const onLeave = () => setFlowPos(null);
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
    };
  }, [wrapperRef, screenToFlowPosition]);

  if (!flowPos) return null;
  const rect = wrapperRef.current?.getBoundingClientRect();
  const screen = flowToScreenPosition(flowPos);
  const left = screen.x - (rect?.left ?? 0);
  const top = screen.y - (rect?.top ?? 0);

  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        // Center pinned at (left, top); scaled about center so size = NODE_SIZE * zoom.
        transform: `translate(-50%, -50%) scale(${zoom}) rotate(${placementRotation}deg)`,
        transformOrigin: "center center",
        pointerEvents: "none",
        opacity: 0.55,
        zIndex: 6,
      }}
    >
      <SymbolPreview type={type} size={NODE_SIZE} margin={NODE_MARGIN} strokeWidth={1.6} color="#2563eb" />
    </div>
  );
}

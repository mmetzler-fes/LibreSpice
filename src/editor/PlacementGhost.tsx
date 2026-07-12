import { useEffect, useState, type RefObject } from "react";
import { useReactFlow, useViewport } from "@xyflow/react";
import { SymbolPreview } from "./SymbolPreview.js";
import { NODE_SIZE, snapToGrid } from "./pinGeometry.js";
import { netLabelShape } from "./netLabelShape.js";
import { useUIStore } from "@store/uiStore.js";
import type { ComponentType } from "./nodes/ComponentNode.js";

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
    // Pointer events so a stylus previews the placement while it hovers, and a
    // finger while it is down. `pointerdown` seeds the ghost for a plain tap,
    // which produces no move beforehand.
    const onMove = (e: PointerEvent) => {
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      // The very snap the placement uses, so the ghost marks the exact spot the
      // component's docking point will land on.
      setFlowPos({ x: snapToGrid(flow.x), y: snapToGrid(flow.y) });
    };
    const onLeave = () => setFlowPos(null);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onMove);
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, [wrapperRef, screenToFlowPosition]);

  if (!flowPos) return null;
  const rect = wrapperRef.current?.getBoundingClientRect();
  const screen = flowToScreenPosition(flowPos);
  const left = screen.x - (rect?.left ?? 0);
  const top = screen.y - (rect?.top ?? 0);

  // A net label's terminal stays at the node centre at any rotation (only its
  // arrow turns, see netLabelShape), so the ghost must not be spun as a whole —
  // that would swing the docking point away from the cursor.
  const isNetLabel = type === "netlabel";
  const spin = isNetLabel ? "" : ` rotate(${placementRotation}deg)`;

  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        // Exactly the node's box, laid out as a grid cell: the preview is an
        // inline element, and its baseline strut made the box taller than the
        // symbol — so translate(-50%) centred the *box*, leaving the drawn symbol
        // ~2.5 px (× zoom) below the component that then appeared.
        width: NODE_SIZE,
        height: NODE_SIZE,
        display: "grid",
        placeItems: "center",
        lineHeight: 0,
        // Center pinned at (left, top); scaled about center so size = NODE_SIZE * zoom.
        transform: `translate(-50%, -50%) scale(${zoom})${spin}`,
        transformOrigin: "center center",
        pointerEvents: "none",
        opacity: 0.55,
        zIndex: 6,
      }}
    >
      {isNetLabel ? (
        <NetLabelGhost rotation={placementRotation} />
      ) : (
        /* nativeScale: render at the node's 1:1 size (not fit-to-box) so the
           ghost matches the placed component exactly, at any zoom. */
        <SymbolPreview type={type} size={NODE_SIZE} nativeScale strokeWidth={1.6} color="#2563eb" />
      )}
    </div>
  );
}

/**
 * The net-label/connector preview, drawn from the very geometry the placed node
 * uses ({@link netLabelShape}) — terminal circle at the node centre, the arrow in
 * the placement rotation, and the upright name tag. The generic glyph used before
 * put its terminal elsewhere, so the ghost pointed at a different docking spot
 * than the connector that appeared.
 */
function NetLabelGhost({ rotation }: { rotation: number }) {
  const shape = netLabelShape(rotation);
  const c = NODE_SIZE / 2;
  const color = "#2563eb";
  // The name tag is laid out exactly as NetLabelNode does it — same anchor, same
  // box — so the preview and the connector that appears are the same picture; an
  // SVG text drawn "roughly there" reads as a displaced label.
  const tagStyle: React.CSSProperties = shape.tag.baseline === "middle"
    ? { left: shape.tag.x, top: shape.tag.y, transform: "translate(0, -50%)" }
    : { left: shape.tag.x, top: shape.tag.y, transform: "translate(-50%, -100%)" };
  return (
    <div style={{ position: "relative", width: NODE_SIZE, height: NODE_SIZE }}>
      <svg width={NODE_SIZE} height={NODE_SIZE} style={{ overflow: "visible", color, display: "block" }}>
        <line
          x1={shape.stem.x1} y1={shape.stem.y1} x2={shape.stem.x2} y2={shape.stem.y2}
          stroke={color} strokeWidth={1.6} strokeLinecap="round"
        />
        <polygon points={shape.head} fill={color} />
        <circle cx={c} cy={c} r={shape.circle.r} fill="none" stroke={color} strokeWidth={1.6} />
      </svg>
      <div
        style={{
          position: "absolute", ...tagStyle,
          padding: "1px 6px", borderRadius: 4, fontSize: 11, fontFamily: "monospace", whiteSpace: "nowrap",
          lineHeight: 1.3, border: `1px solid ${color}`, color,
        }}
      >
        NET
      </div>
    </div>
  );
}

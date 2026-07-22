import { useEffect, useMemo, useState, type RefObject } from "react";
import { useReactFlow, useViewport } from "@xyflow/react";
import { LTSpiceParser } from "@core/ltspice/LTSpiceParser.js";
import { fragmentOrigin } from "@core/ltspice/ascFragment.js";
import { buildSchematicSvg } from "./svgExport.js";
import { snapToGrid } from "./pinGeometry.js";
import { useUIStore } from "@store/uiStore.js";

interface FragmentGhostProps {
  wrapperRef: RefObject<HTMLDivElement | null>;
  /** The `.asc` fragment about to be placed. */
  fragment: string;
}

/**
 * Semi-transparent preview of a cut/copied block, following the cursor until it
 * is put down — the way LTSpice carries a copied selection.
 *
 * Drawn with the very renderer the SVG export uses, so the ghost is the block
 * itself rather than an approximation of it: same symbols, same wire routing,
 * same captions. Its `viewBox` is in flow coordinates, which is what lets the
 * preview be positioned exactly where the parts will land.
 */
export function FragmentGhost({ wrapperRef, fragment }: FragmentGhostProps) {
  const { screenToFlowPosition, flowToScreenPosition } = useReactFlow();
  const { zoom } = useViewport();
  const symbolNorm = useUIStore((s) => s.symbolNorm);
  const [flowPos, setFlowPos] = useState<{ x: number; y: number } | null>(null);

  // Parsing and rendering the block is far too much work for a pointermove, so
  // both happen once per copied fragment and only the offset moves afterwards.
  const preview = useMemo(() => {
    try {
      const { nodes, edges } = LTSpiceParser.parse(fragment);
      if (nodes.length === 0) return null;
      const svg = buildSchematicSvg(nodes, edges, symbolNorm);
      const box = svg.match(/viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/);
      if (!box) return null;
      return {
        // The export paints itself onto white paper; a ghost must not hide the
        // schematic underneath, so that backdrop is dropped.
        svg: svg.replace(/<rect[^>]*fill="#ffffff"[^>]*\/>/, ""),
        view: { x: +box[1], y: +box[2], w: +box[3], h: +box[4] },
        origin: fragmentOrigin(nodes),
      };
    } catch {
      return null;
    }
  }, [fragment, symbolNorm]);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    // `pointerdown` seeds the position for a plain tap, which sends no move
    // beforehand — the same reason PlacementGhost listens for it.
    const onMove = (e: PointerEvent) => {
      const flow = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      setFlowPos({ x: snapToGrid(flow.x), y: snapToGrid(flow.y) });
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onMove);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onMove);
    };
  }, [wrapperRef, screenToFlowPosition]);

  if (!preview || !flowPos) return null;

  // The cursor carries the block's top-left corner, which is where
  // `pasteFragment` puts it — so what the ghost shows is where it lands.
  const dx = flowPos.x - preview.origin.x;
  const dy = flowPos.y - preview.origin.y;
  const screen = flowToScreenPosition({ x: preview.view.x + dx, y: preview.view.y + dy });
  const rect = wrapperRef.current?.getBoundingClientRect();

  return (
    <div
      style={{
        position: "absolute",
        left: screen.x - (rect?.left ?? 0),
        top: screen.y - (rect?.top ?? 0),
        width: preview.view.w * zoom,
        height: preview.view.h * zoom,
        opacity: 0.55,
        pointerEvents: "none",
        zIndex: 15,
      }}
      dangerouslySetInnerHTML={{ __html: preview.svg }}
    />
  );
}

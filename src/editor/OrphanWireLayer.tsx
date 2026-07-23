import { useViewport } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useTheme } from "../theme.js";
import { orphanGroups } from "./anchorNets.js";

/**
 * Wire segments the edge model cannot hold, drawn.
 *
 * A wire runs pin to pin here, so a segment with an end on no pin — a stub, a
 * spur — has no edge to carry it. It is kept verbatim so a saved file stays
 * faithful (see LTSpiceParser.orphanWires), and *that* used to be the whole of
 * it: while a net label was a node with a pin, such a segment was rare and the
 * ones that existed were inert leftovers nobody could see anyway.
 *
 * Names left the topology and made it common. The stub between a part and a
 * connector — the four cross-coupling stubs of `04-4_AstabileKippstufe1`, for one
 * — used to end on the label's pin and was an ordinary edge. Now its far end is a
 * name, which owns no pin, so the segment drops out of the edge model. It is
 * still in the file, still saved, still carrying its net (see anchorNets) — it
 * was simply no longer drawn, and the schematic appeared to have lost a
 * connection it still had.
 *
 * Drawn beneath everything and taking no pointer events, like the sheet shapes:
 * with no edge behind it there is nothing here to select or drag. Deleting one
 * means deleting the part or the name at its end.
 */
export function OrphanWireLayer() {
  const vp = useViewport();
  const orphans = useCircuitStore((s) => s.ascOrphanWires);
  const theme = useTheme();
  if (orphans.length === 0) return null;

  const segments = orphanGroups(orphans).flat();
  if (segments.length === 0) return null;

  return (
    <svg style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0, overflow: "visible" }}>
      <g transform={`translate(${vp.x} ${vp.y}) scale(${vp.zoom})`}>
        {segments.map((seg, i) => (
          <line
            key={i}
            x1={seg[0].x} y1={seg[0].y} x2={seg[1].x} y2={seg[1].y}
            stroke={theme.wireStroke} strokeWidth={2} strokeLinecap="round"
          />
        ))}
      </g>
    </svg>
  );
}

import { useRef } from "react";
import { useViewport } from "@xyflow/react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { useTheme } from "../theme.js";
import { formatDataFlag, analysisKind, type DataFlag } from "@core/circuit/dataExpr.js";
import { DRAG_TOUCH_ACTION, isDragPointer, trackPointerDrag } from "./pointerDrag.js";

/**
 * Renders the schematic's data-point annotations (LTSpice DATAFLAGs) at their
 * flow coordinates, showing each expression's value from the current result —
 * the operating point for `.op`, the RMS (Effektivwert) for a transient run.
 * Each badge has a grip handle to drag it anywhere on the sheet.
 */
export function DataFlagLayer() {
  const vp = useViewport();
  const dataFlags = useCircuitStore((s) => s.dataFlags);
  const removeDataFlag = useCircuitStore((s) => s.removeDataFlag);
  const moveDataFlag = useCircuitStore((s) => s.moveDataFlag);
  const result = useSimulationStore((s) => s.result);
  const theme = useTheme();
  // Re-render when net labels change so V(net) expressions stay resolvable.
  useCircuitStore((s) => s.netVersion);

  const drag = useRef<{ id: string; sx: number; sy: number; ox: number; oy: number; zoom: number } | null>(null);

  const startDrag = (e: React.PointerEvent, df: DataFlag) => {
    if (!isDragPointer(e)) return;
    e.preventDefault();
    e.stopPropagation();
    drag.current = { id: df.id, sx: e.clientX, sy: e.clientY, ox: df.x, oy: df.y, zoom: vp.zoom };
    trackPointerDrag(
      e,
      (ev) => {
        const d = drag.current;
        if (!d) return;
        moveDataFlag(d.id, d.ox + (ev.clientX - d.sx) / d.zoom, d.oy + (ev.clientY - d.sy) / d.zoom);
      },
      () => { drag.current = null; },
    );
  };

  if (dataFlags.length === 0) return null;
  const rms = result ? analysisKind(result) === "rms" : false;

  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 6 }}>
      {dataFlags.map((df) => {
        const left = vp.x + df.x * vp.zoom;
        const top = vp.y + df.y * vp.zoom;
        const value = result ? formatDataFlag(df.expr, result) : null;
        return (
          <div
            key={df.id}
            style={{
              position: "absolute", left, top, transform: "translate(-50%, -50%)",
              pointerEvents: "auto", display: "flex", alignItems: "stretch", gap: 2,
              padding: "2px 4px 2px 2px", fontFamily: "monospace", fontSize: 11, lineHeight: "14px",
              color: theme.textStrong, background: theme.flagBg,
              border: `1px solid ${theme.flagBorder}`, borderRadius: 4, whiteSpace: "nowrap",
              boxShadow: "0 1px 3px #0000001f",
            }}
          >
            <span
              onPointerDown={(e) => startDrag(e, df)}
              title="Datenpunkt verschieben"
              style={{
                ...DRAG_TOUCH_ACTION,
                display: "flex", alignItems: "center", padding: "0 3px", marginRight: 1,
                color: "#94a3b8", cursor: "move", userSelect: "none",
                borderRight: `1px solid ${theme.borderMuted}`, letterSpacing: -1,
              }}
            >
              ⠿
            </span>
            <span style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontWeight: 600, color: value == null ? "#94a3b8" : theme.flagValue }}>
                {value ?? "?"}{value != null && rms ? " (eff.)" : ""}
              </span>
              <span style={{ fontSize: 9, color: "#64748b" }}>{df.expr}</span>
            </span>
            <button
              onClick={() => removeDataFlag(df.id)}
              title="Datenpunkt entfernen"
              style={{
                border: "none", background: "transparent", color: "#94a3b8", cursor: "pointer",
                fontSize: 13, lineHeight: "13px", padding: "0 1px",
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

import { useRef, useCallback, useState } from "react";
import { LiveNetlistPanel } from "./LiveNetlistPanel.js";
import { SimulationPanel } from "@simulation/SimulationPanel.js";
import { OscilloscopePlot } from "@simulation/OscilloscopePlot.js";
import { LogPanel } from "@simulation/LogPanel.js";
import { WaveOutputBar } from "./WaveOutputBar.js";
import { useUIStore, type DockTab } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { NO_NATIVE_DRAG, isDragPointer, trackPointerDrag } from "./pointerDrag.js";

const TABS: { id: DockTab; label: string }[] = [
  { id: "netlist", label: "Netlist" },
  { id: "simulation", label: "Simulation" },
  { id: "waveform", label: "Waveform" },
  { id: "log", label: "Log" },
];

export function DockPanel() {
  const { dockOpen, dockHeight, dockTab, setDockHeight, setDockTab, toggleDock } = useUIStore();
  const theme = useTheme();
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  /** The resize bar is dragged or hovered — highlight it, like the plot's bar. */
  const [resizing, setResizing] = useState(false);
  const [resizeHover, setResizeHover] = useState(false);

  const onResizeStart = useCallback(
    (e: React.PointerEvent) => {
      if (!isDragPointer(e)) return;
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: dockHeight };
      // Hold on to the pen even when it slips off the bar.
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      // At most one height per frame — a pen reports far more moves than that.
      let pendingY: number | null = null;
      let frame = 0;
      const flush = () => {
        frame = 0;
        if (dragRef.current && pendingY !== null) setDockHeight(dragRef.current.startH + (dragRef.current.startY - pendingY));
      };
      setResizing(true);
      trackPointerDrag(
        e,
        (ev) => {
          pendingY = ev.clientY;
          if (!frame) frame = requestAnimationFrame(flush);
        },
        () => {
          if (frame) cancelAnimationFrame(frame);
          flush();
          dragRef.current = null;
          setResizing(false);
        },
      );
    },
    [dockHeight, setDockHeight],
  );

  if (!dockOpen) {
    return (
      <div
        style={{
          flexShrink: 0,
          borderTop: `1px solid ${theme.border}`,
          background: theme.panelBgAlt,
          display: "flex",
          alignItems: "center",
          padding: "0 8px",
          height: 28,
          gap: 4,
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setDockTab(tab.id)}
            style={{
              padding: "2px 10px",
              fontSize: 11,
              border: `1px solid ${theme.border}`,
              borderRadius: 3,
              background: theme.inputBg,
              color: theme.text,
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        ))}
        <button
          onClick={toggleDock}
          title="Expand panel"
          style={{ marginLeft: "auto", padding: "2px 8px", fontSize: 11, border: "none", background: "transparent", cursor: "pointer" }}
        >
          ▲
        </button>
      </div>
    );
  }

  return (
    <div style={{ flexShrink: 0, display: "flex", flexDirection: "column", height: dockHeight, minHeight: 120 }}>
      {/* Resize bar between schematic and dock — the whole bar is the grab area,
          and it turns blue on hover/drag like the plot panes' resize bar. */}
      <div
        onPointerDown={onResizeStart}
        onPointerEnter={() => setResizeHover(true)}
        onPointerLeave={() => setResizeHover(false)}
        title="Drag to resize the panel"
        style={{
          ...NO_NATIVE_DRAG,
          height: 16,
          cursor: "ns-resize",
          background: resizing || resizeHover ? theme.accent : theme.border,
          color: resizing || resizeHover ? theme.accentText : theme.textMuted,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
        }}
      >
        <span aria-hidden style={{ fontSize: 12, lineHeight: 1 }}>⇕</span>
        <span aria-hidden style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ width: 28, height: 2, borderRadius: 1, background: "currentColor" }} />
          <span style={{ width: 28, height: 2, borderRadius: 1, background: "currentColor" }} />
        </span>
      </div>
      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 30,
          borderTop: `1px solid ${theme.border}`,
          borderBottom: `1px solid ${theme.border}`,
          background: theme.panelBgAlt,
          padding: "0 6px",
          flexShrink: 0,
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setDockTab(tab.id)}
            style={{
              padding: "4px 12px",
              fontSize: 12,
              border: "none",
              borderBottom: dockTab === tab.id ? "2px solid #2563eb" : "2px solid transparent",
              background: "transparent",
              color: dockTab === tab.id ? "#2563eb" : "inherit",
              fontWeight: dockTab === tab.id ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {tab.label}
          </button>
        ))}
        <span style={{ marginLeft: "auto", paddingLeft: 12 }}><WaveOutputBar /></span>
        <button
          onClick={toggleDock}
          title="Collapse panel"
          style={{ marginLeft: "auto", padding: "2px 8px", fontSize: 11, border: "none", background: "transparent", cursor: "pointer", color: "#64748b" }}
        >
          ▼
        </button>
      </div>
      {/* Content */}
      <div style={{ flex: 1, overflow: "hidden", background: theme.inputBg }}>
        {dockTab === "netlist" && <LiveNetlistPanel />}
        {dockTab === "simulation" && <SimulationPanel compact />}
        {dockTab === "waveform" && <OscilloscopePlot compact />}
        {dockTab === "log" && <LogPanel />}
      </div>
    </div>
  );
}

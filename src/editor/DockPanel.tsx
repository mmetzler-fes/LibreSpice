import { useRef, useCallback } from "react";
import { LiveNetlistPanel } from "./LiveNetlistPanel.js";
import { SimulationPanel } from "@simulation/SimulationPanel.js";
import { OscilloscopePlot } from "@simulation/OscilloscopePlot.js";
import { LogPanel } from "@simulation/LogPanel.js";
import { useUIStore, type DockTab } from "@store/uiStore.js";

const TABS: { id: DockTab; label: string }[] = [
  { id: "netlist", label: "Netlist" },
  { id: "simulation", label: "Simulation" },
  { id: "waveform", label: "Waveform" },
  { id: "log", label: "Log" },
];

export function DockPanel() {
  const { dockOpen, dockHeight, dockTab, setDockHeight, setDockTab, toggleDock, darkMode } = useUIStore();
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startY: e.clientY, startH: dockHeight };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = dragRef.current.startY - ev.clientY;
        setDockHeight(dragRef.current.startH + delta);
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [dockHeight, setDockHeight],
  );

  if (!dockOpen) {
    return (
      <div
        style={{
          flexShrink: 0,
          borderTop: "1px solid #cbd5e1",
          background: darkMode ? "#1e293b" : "#f1f5f9",
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
              border: "1px solid #cbd5e1",
              borderRadius: 3,
              background: "#fff",
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
      {/* Resize handle */}
      <div
        onMouseDown={onResizeStart}
        style={{
          height: 5,
          cursor: "ns-resize",
          background: darkMode ? "#334155" : "#cbd5e1",
          flexShrink: 0,
        }}
      />
      {/* Tab bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 30,
          borderTop: "1px solid #cbd5e1",
          borderBottom: "1px solid #cbd5e1",
          background: darkMode ? "#1e293b" : "#f8fafc",
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
        <button
          onClick={toggleDock}
          title="Collapse panel"
          style={{ marginLeft: "auto", padding: "2px 8px", fontSize: 11, border: "none", background: "transparent", cursor: "pointer", color: "#64748b" }}
        >
          ▼
        </button>
      </div>
      {/* Content */}
      <div style={{ flex: 1, overflow: "hidden", background: darkMode ? "#0f172a" : "#fff" }}>
        {dockTab === "netlist" && <LiveNetlistPanel />}
        {dockTab === "simulation" && <SimulationPanel compact />}
        {dockTab === "waveform" && <OscilloscopePlot compact />}
        {dockTab === "log" && <LogPanel />}
      </div>
    </div>
  );
}

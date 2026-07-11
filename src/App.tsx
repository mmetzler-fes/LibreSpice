import { useEffect, useRef } from "react";
import { SchematicCanvas } from "@editor/SchematicCanvas.js";
import { SimulationPanel } from "@simulation/SimulationPanel.js";
import { OscilloscopeView } from "@simulation/OscilloscopeView.js";
import { LiveNetlistPanel } from "@editor/LiveNetlistPanel.js";
import { useUIStore, type ActiveTab } from "@store/uiStore.js";
import { useTheme } from "./theme.js";
import { useCircuitStore } from "@store/circuitStore.js";
import { getSnapshotFromUrl, loadFromLocalStorage } from "@store/persistence.js";
import { useAutosave } from "@store/useAutosave.js";
import { useKeyboardViewport } from "./useKeyboardViewport.js";

const TABS: { id: ActiveTab; label: string }[] = [
  { id: "schematic", label: "Schematic" },
  { id: "netlist", label: "Netlist" },
  { id: "oscilloscope", label: "Oscilloscope" },
];

export function App() {
  const { activeTab, setActiveTab, toggleDarkMode, darkMode } = useUIStore();
  const theme = useTheme();
  const loadFromSnapshot = useCircuitStore((s) => s.loadFromSnapshot);
  const initialized = useRef(false);

  useAutosave();
  useKeyboardViewport();

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    // A compressed share link has to be inflated asynchronously, so the autosave
    // fallback waits for it — otherwise a shared circuit would flash the last
    // locally edited one first.
    void (async () => {
      const fromUrl = await getSnapshotFromUrl();
      if (fromUrl) {
        loadFromSnapshot(fromUrl);
        return;
      }
      const saved = loadFromLocalStorage();
      if (saved && saved.nodes.length > 0) {
        loadFromSnapshot(saved);
      }
    })();
  }, [loadFromSnapshot]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "var(--app-height, 100vh)",
        fontFamily: "system-ui, sans-serif",
        background: theme.inputBg,
        color: theme.text,
      }}
    >
      {/* Menu bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          borderBottom: `1px solid ${theme.border}`,
          padding: "0 12px",
          height: 32,
          gap: 0,
          background: theme.headerBg,
          flexShrink: 0,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: "-0.3px", marginRight: 16 }}>
          ⚡ LibreSpice
        </span>

        <nav style={{ display: "flex", gap: 0, flex: 1 }}>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                padding: "0 14px",
                height: 32,
                border: "none",
                borderBottom: activeTab === tab.id ? "2px solid #2563eb" : "2px solid transparent",
                background: "transparent",
                color: activeTab === tab.id ? "#2563eb" : "inherit",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: activeTab === tab.id ? 600 : 400,
              }}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <button
          onClick={toggleDarkMode}
          style={{
            padding: "2px 10px",
            border: "1px solid #94a3b8",
            borderRadius: 3,
            background: "transparent",
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          {darkMode ? "☀" : "☾"}
        </button>
      </header>

      {/* Main content */}
      <main style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {activeTab === "schematic" && <SchematicCanvas />}
        {activeTab === "netlist" && <NetlistView />}
        {activeTab === "oscilloscope" && <OscilloscopeView />}
      </main>
    </div>
  );
}

function NetlistView() {
  const theme = useTheme();
  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      <div style={{ flex: 1, overflow: "hidden" }}>
        <LiveNetlistPanel />
      </div>
      <div style={{ width: 280, borderLeft: `1px solid ${theme.borderMuted}`, overflow: "auto" }}>
        <SimulationPanel />
      </div>
    </div>
  );
}

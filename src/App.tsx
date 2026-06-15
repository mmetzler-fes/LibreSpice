import { SchematicCanvas } from "@editor/SchematicCanvas.js";
import { SimulationPanel } from "@simulation/SimulationPanel.js";
import { useUIStore, type ActiveTab } from "@store/uiStore.js";
import { useCircuitStore } from "@store/circuitStore.js";

const TABS: { id: ActiveTab; label: string }[] = [
  { id: "schematic", label: "Schematic" },
  { id: "netlist", label: "Netlist" },
  { id: "oscilloscope", label: "Oscilloscope" },
];

export function App() {
  const { activeTab, setActiveTab, toggleDarkMode, darkMode } = useUIStore();

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        fontFamily: "system-ui, sans-serif",
        background: darkMode ? "#0f172a" : "#fff",
        color: darkMode ? "#e2e8f0" : "#1e293b",
      }}
    >
      {/* Menu bar */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          borderBottom: "1px solid #cbd5e1",
          padding: "0 12px",
          height: 32,
          gap: 0,
          background: darkMode ? "#1e293b" : "#e2e8f0",
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
        {activeTab === "oscilloscope" && <OscilloscopePlaceholder />}
      </main>
    </div>
  );
}

function NetlistView() {
  const { netlist } = useCircuitStore();
  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
      <pre
        style={{
          flex: 1,
          margin: 0,
          padding: 24,
          fontFamily: "'Cascadia Code', 'Fira Code', monospace",
          fontSize: 13,
          lineHeight: 1.6,
          background: "#1e293b",
          color: "#e2e8f0",
          overflowY: "auto",
          whiteSpace: "pre-wrap",
        }}
      >
        {netlist || "* Empty circuit – add components in the Schematic tab"}
      </pre>
      <div style={{ width: 280, borderLeft: "1px solid #e2e8f0", overflow: "auto" }}>
        <SimulationPanel />
      </div>
    </div>
  );
}

function OscilloscopePlaceholder() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 12,
        color: "#94a3b8",
      }}
    >
      <span style={{ fontSize: 48 }}>📊</span>
      <p style={{ margin: 0, fontSize: 14 }}>Oscilloscope – coming in Phase 5</p>
      <p style={{ margin: 0, fontSize: 12 }}>Run a simulation first, then plot results here</p>
    </div>
  );
}

import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore, type EditorMode } from "@store/uiStore.js";
import type { ComponentType } from "./nodes/ComponentNode.js";
import { DirectiveModal } from "./DirectiveModal.js";
import { ModelImportModal } from "./ModelImportModal.js";
import { InsertComponentModal } from "./InsertComponentModal.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { runSimulation } from "@simulation/simulationEngine.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { buildShareUrl } from "@store/persistence.js";
import { buildSchematicSvg } from "./svgExport.js";

// ── Tiny SVG icon components ──────────────────────────────────────────────────

const Ico = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

// Schematic-specific small symbols rendered as SVG
const SymR = () => (
  <svg width="18" height="18" viewBox="-9 -12 18 24">
    <rect x="-5" y="-9" width="10" height="18" rx="1" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);
const SymC = () => (
  <svg width="18" height="18" viewBox="-9 -12 18 24">
    <line x1="-7" y1="-3" x2="7" y2="-3" stroke="currentColor" strokeWidth="2" />
    <line x1="-7" y1="3" x2="7" y2="3" stroke="currentColor" strokeWidth="2" />
  </svg>
);
const SymL = () => (
  <svg width="18" height="18" viewBox="-9 -12 18 24">
    <path d="M-6,-8 Q0,-8 0,-2 Q0,4 6,4" fill="none" stroke="currentColor" strokeWidth="1.8" />
  </svg>
);
const SymD = () => (
  <svg width="18" height="18" viewBox="-9 -12 18 24">
    <polygon points="0,-9 8,6 -8,6" fill="currentColor" />
    <line x1="-9" y1="6" x2="9" y2="6" stroke="currentColor" strokeWidth="2" />
  </svg>
);
const SymGnd = () => (
  <svg width="18" height="18" viewBox="-9 -12 18 24">
    <line x1="0" y1="-10" x2="0" y2="-2" stroke="currentColor" strokeWidth="2" />
    <line x1="-8" y1="-2" x2="8" y2="-2" stroke="currentColor" strokeWidth="2.2" />
    <line x1="-5" y1="3" x2="5" y2="3" stroke="currentColor" strokeWidth="2.2" />
    <line x1="-2" y1="8" x2="2" y2="8" stroke="currentColor" strokeWidth="2.2" />
  </svg>
);
const SymV = () => (
  <svg width="18" height="18" viewBox="-9 -12 18 24">
    <circle cx="0" cy="0" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <text x="0" y="-1" textAnchor="middle" fontSize="9" fill="currentColor" stroke="none">V</text>
  </svg>
);
const SymI = () => (
  <svg width="18" height="18" viewBox="-9 -12 18 24">
    <circle cx="0" cy="0" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <text x="0" y="-1" textAnchor="middle" fontSize="9" fill="currentColor" stroke="none">I</text>
  </svg>
);
const SymQ = () => (
  <svg width="18" height="18" viewBox="-12 -12 24 24">
    <line x1="-4" y1="-10" x2="-4" y2="10" stroke="currentColor" strokeWidth="2" />
    <line x1="-10" y1="0" x2="-4" y2="0" stroke="currentColor" strokeWidth="1.8" />
    <line x1="-4" y1="-6" x2="8" y2="-10" stroke="currentColor" strokeWidth="1.8" />
    <line x1="-4" y1="6" x2="8" y2="10" stroke="currentColor" strokeWidth="1.8" />
    <polygon points="3,8 8,10 6,5" fill="currentColor" />
  </svg>
);
const SymM = () => (
  <svg width="18" height="18" viewBox="-12 -12 24 24">
    <line x1="-4" y1="-10" x2="-4" y2="10" stroke="currentColor" strokeWidth="2" strokeDasharray="3 2" />
    <line x1="2" y1="-7" x2="2" y2="7" stroke="currentColor" strokeWidth="2" />
    <line x1="-10" y1="0" x2="2" y2="0" stroke="currentColor" strokeWidth="1.8" />
    <line x1="2" y1="-6" x2="9" y2="-6" stroke="currentColor" strokeWidth="1.8" />
    <line x1="2" y1="6" x2="9" y2="6" stroke="currentColor" strokeWidth="1.8" />
    <line x1="9" y1="-6" x2="9" y2="-10" stroke="currentColor" strokeWidth="1.8" />
    <line x1="9" y1="6" x2="9" y2="10" stroke="currentColor" strokeWidth="1.8" />
    <polygon points="4,3 9,6 4,9" fill="currentColor" />
  </svg>
);
// ── Toolbar helpers ───────────────────────────────────────────────────────────

interface TBtnProps {
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}
function TBtn({ title, active, disabled, onClick, children }: TBtnProps) {
  const { darkMode } = useUIStore();
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 30,
        height: 28,
        border: "1px solid",
        borderColor: active ? "#2563eb" : "transparent",
        borderRadius: 3,
        background: active ? (darkMode ? "#1e3a5f" : "#dbeafe") : "transparent",
        color: active ? (darkMode ? "#60a5fa" : "#1d4ed8") : disabled ? "#94a3b8" : "inherit",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  const { darkMode } = useUIStore();
  return (
    <div style={{ width: 1, height: 24, background: darkMode ? "#334155" : "#cbd5e1", margin: "0 4px", flexShrink: 0 }} />
  );
}

// ── Main Toolbar ──────────────────────────────────────────────────────────────

export function Toolbar() {
  const {
    canUndo, canRedo, undo, redo,
    clearCircuit, rotateSelected, mirrorSelected, deleteSelected, netlist, selectedComponentId, spiceDirectives,
    circuit, nodes, edges, loadFromAsc, fileHandle, setFileHandle, exportSnapshot,
    circuitName, setCircuitName, dataFlags,
  } = useCircuitStore();
  const { editorMode, pendingPlaceType, setEditorMode, startPlacing, cancelPlacing, toggleDirectiveModal, toggleInsertComponent, setDockTab, symbolNorm, setSymbolNorm, darkMode } = useUIStore();
  const { status, setStatus, setResult, setErrorMessage } = useSimulationStore();

  const isPlacing = (type: ComponentType) => editorMode === "place" && pendingPlaceType === type;

  const handlePlace = (type: ComponentType) => {
    if (isPlacing(type)) cancelPlacing();
    else startPlacing(type);
  };

  const handleMode = (mode: EditorMode) => {
    if (editorMode === mode) return;
    setEditorMode(mode);
  };

  const handleRun = async () => {
    if (!netlist || status === "running") return;
    setStatus("running");
    try {
      const res = await runSimulation(netlist);
      setResult(res);
      setDockTab("waveform");
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Simulation error");
    }
  };

  // Filesystem-safe base name derived from the diagram name.
  const safeName = (circuitName.trim() || "circuit").replace(/[^\w.\- ]+/g, "_");

  const downloadBlob = (content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const fallbackSave = (content: string) => downloadBlob(content, `${safeName}.asc`, "text/plain");

  const handleExportSvg = () => {
    downloadBlob(buildSchematicSvg(nodes, edges, symbolNorm), `${safeName}_Schaltung.svg`, "image/svg+xml");
  };

  const handleSave = async (saveAs: boolean = false) => {
    const content = LTSpiceExporter.export(nodes, edges, spiceDirectives, circuit, dataFlags);
    if ("showSaveFilePicker" in window) {
      try {
        let handle = fileHandle;
        if (!handle || saveAs) {
          handle = await (window as any).showSaveFilePicker({
            suggestedName: `${safeName}.asc`,
            types: [{ description: "LTSpice Schematic", accept: { "text/plain": [".asc"] } }],
          });
          setFileHandle(handle, handle.name);
        }
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        return;
      } catch (err: any) {
        if (err.name !== "AbortError") {
          console.error(err);
          fallbackSave(content);
        }
        return;
      }
    }
    fallbackSave(content);
  };

  const handleOpen = async () => {
    let loadedText = "";
    let loadedHandle: any = null;
    let loadedName = "";

    if ("showOpenFilePicker" in window) {
      try {
        const [handle] = await (window as any).showOpenFilePicker({
          types: [{
            description: "LTSpice Schematic",
            accept: {
              "application/octet-stream": [".asc"],
              "text/plain": [".asc"],
              "application/x-asc": [".asc"]
            }
          }],
          multiple: false,
        });
        const file = await handle.getFile();
        // LTSpice writes .asc files in Windows-1252 (byte 0xB5 = µ).
        // Decoding as UTF-8 (the default) replaces 0xB5 with U+FFFD, which
        // breaks SI-suffix parsing (e.g. "14µF" → "14F" = 14 Farads).
        loadedText = new TextDecoder("windows-1252").decode(await file.arrayBuffer());
        loadedHandle = handle;
        loadedName = file.name;
      } catch (err: any) {
        if (err.name === "AbortError") return;
        console.error("showOpenFilePicker failed, falling back", err);
      }
    }

    if (!loadedText) {
      // Fallback
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".asc";
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          const text = new TextDecoder("windows-1252").decode(await file.arrayBuffer());
          loadFromAsc(text);
          setFileHandle(null, file.name);
          setCircuitName(file.name.replace(/\.asc$/i, ""));
        }
      };
      input.click();
      return;
    }

    loadFromAsc(loadedText);
    setFileHandle(loadedHandle, loadedName);
    setCircuitName(loadedName.replace(/\.asc$/i, ""));
  };

  const handleShareUrl = async () => {
    const url = buildShareUrl(exportSnapshot());
    try {
      await navigator.clipboard.writeText(url);
      alert("Share link copied to clipboard!");
    } catch {
      prompt("Copy this link to share your circuit:", url);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 36,
        padding: "0 6px",
        gap: 2,
        background: darkMode ? "#1e293b" : "#f8fafc",
        borderBottom: `1px solid ${darkMode ? "#334155" : "#cbd5e1"}`,
        color: darkMode ? "#e2e8f0" : "#1e293b",
        flexShrink: 0,
        overflowX: "auto",
        userSelect: "none",
      }}
    >
      {/* ── File ── */}
      <TBtn title="New circuit (Ctrl+N)" onClick={clearCircuit}>
        <Ico d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6" />
      </TBtn>
      <TBtn title="Open (Ctrl+O)" onClick={handleOpen}>
        <Ico d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </TBtn>
      <TBtn title="Save (Ctrl+S)" onClick={() => handleSave(false)}>
        <Ico d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z M17 21v-8H7v8 M7 3v5h8" />
      </TBtn>
      <TBtn title="Save As..." onClick={() => handleSave(true)}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
          <path d="M17 21v-8H7v8" />
          <path d="M7 3v5h8" />
          <path d="M12 11l0 4 M10 13l4 0" />
        </svg>
      </TBtn>
      <TBtn title="Copy Share URL" onClick={handleShareUrl}>
        <Ico d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71 M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </TBtn>
      <TBtn title="Export schematic as SVG" onClick={handleExportSvg}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12 M8 11l4 4 4-4 M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          <text x="12" y="9" textAnchor="middle" fontSize="7" fill="currentColor" stroke="none">SVG</text>
        </svg>
      </TBtn>

      <Divider />

      {/* ── Diagram name (default file name for .asc/.plt) ── */}
      <input
        title="Diagram name — used as the default file name when saving"
        value={circuitName}
        onChange={(e) => setCircuitName(e.target.value)}
        placeholder="Diagram name"
        style={{
          height: 26, width: 140, fontSize: 12, padding: "0 8px",
          border: `1px solid ${darkMode ? "#475569" : "#cbd5e1"}`,
          borderRadius: 4,
          background: darkMode ? "#0f172a" : "#fff",
          color: darkMode ? "#e2e8f0" : "#334155",
        }}
      />

      <Divider />

      {/* ── SPICE Directives ── */}
      <TBtn
        title="Edit SPICE Directives"
        active={spiceDirectives.trim().length > 0}
        onClick={toggleDirectiveModal}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="10" x2="14" y2="10" />
          <line x1="4" y1="14" x2="18" y2="14" />
          <line x1="4" y1="18" x2="12" y2="18" />
          <circle cx="20" cy="16" r="3" fill={spiceDirectives.trim() ? "#2563eb" : "none"} strokeWidth="1.5" />
        </svg>
      </TBtn>

      {/* ── Simulation ── */}
      <TBtn title="Run Simulation (F5)" onClick={handleRun} disabled={!netlist || status === "running"}>
        <svg width="18" height="18" viewBox="0 0 24 24">
          <polygon points="5,3 19,12 5,21" fill={netlist && status !== "running" ? "#16a34a" : "#94a3b8"} />
        </svg>
      </TBtn>
      <TBtn title="Stop Simulation" onClick={() => setStatus("idle")} disabled={status !== "running"}>
        <svg width="18" height="18" viewBox="0 0 24 24">
          <rect x="5" y="5" width="14" height="14" fill={status === "running" ? "#dc2626" : "#94a3b8"} />
        </svg>
      </TBtn>

      <Divider />

      {/* ── Edit modes ── */}
      <TBtn title="Select / Move (Esc)" active={editorMode === "select"} onClick={() => handleMode("select")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 3l14 9-7 1-4 7z" />
        </svg>
      </TBtn>
      <TBtn title="Draw Wire (W)" active={editorMode === "wire"} onClick={() => handleMode("wire")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="3,21 3,8 12,8 12,3 21,3" />
        </svg>
      </TBtn>
      <TBtn title="Pan (Space)" active={editorMode === "pan"} onClick={() => handleMode("pan")}>
        <Ico d="M18 11V6l-6-3-6 3v5l6 3 6-3z M12 22V12" />
      </TBtn>

      <Divider />

      {/* ── Symbol norm ── */}
      <select
        title="Symbol standard (drawing norm)"
        value={symbolNorm}
        onChange={(e) => setSymbolNorm(e.target.value as typeof symbolNorm)}
        style={{
          height: 28, fontSize: 12,
          border: `1px solid ${darkMode ? "#475569" : "#cbd5e1"}`,
          borderRadius: 4,
          background: darkMode ? "#0f172a" : "#fff",
          color: darkMode ? "#e2e8f0" : "#334155",
          padding: "0 4px", cursor: "pointer",
        }}
      >
        <option value="default">Symbols: EU</option>
        <option value="en">Symbols: EN</option>
        <option value="ansi">Symbols: ANSI</option>
      </select>

      <Divider />

      {/* ── Quick-place components ── */}
      <TBtn title="Place Resistor (R)" active={isPlacing("resistor")} onClick={() => handlePlace("resistor")}>
        <SymR />
      </TBtn>
      <TBtn title="Place Capacitor (C)" active={isPlacing("capacitor")} onClick={() => handlePlace("capacitor")}>
        <SymC />
      </TBtn>
      <TBtn title="Place Inductor (L)" active={isPlacing("inductor")} onClick={() => handlePlace("inductor")}>
        <SymL />
      </TBtn>
      <TBtn title="Place Diode (D)" active={isPlacing("diode")} onClick={() => handlePlace("diode")}>
        <SymD />
      </TBtn>
      <TBtn title="Place Ground (G)" active={isPlacing("ground")} onClick={() => handlePlace("ground")}>
        <SymGnd />
      </TBtn>

      <Divider />

      <TBtn title="Place Voltage Source (V)" active={isPlacing("vsource")} onClick={() => handlePlace("vsource")}>
        <SymV />
      </TBtn>
      <TBtn title="Place Current Source (I)" active={isPlacing("isource")} onClick={() => handlePlace("isource")}>
        <SymI />
      </TBtn>

      <Divider />

      <TBtn title="Place NPN Transistor (Q)" active={isPlacing("bjt_npn")} onClick={() => handlePlace("bjt_npn")}>
        <SymQ />
      </TBtn>
      <TBtn title="Place NMOSFET (M)" active={isPlacing("mosfet_n")} onClick={() => handlePlace("mosfet_n")}>
        <SymM />
      </TBtn>

      <Divider />

      {/* ── Transform ── */}
      <TBtn title="Rotate 90° left (Ctrl+R)" onClick={rotateSelected} disabled={!selectedComponentId}>
        <Ico d="M23 4v6h-6 M1 20v-6h6 M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15" />
      </TBtn>
      <TBtn title="Mirror Horizontal (Ctrl+M)" onClick={mirrorSelected} disabled={!selectedComponentId}>
        <Ico d="M12 3v18 M4 7l4 5-4 5 M20 7l-4 5 4 5" />
      </TBtn>

      <Divider />

      {/* ── Edit ── */}
      <TBtn title="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo()}>
        <Ico d="M9 14 4 9l5-5 M4 9h11a4 4 0 0 1 0 8h-1" />
      </TBtn>
      <TBtn title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo()}>
        <Ico d="M15 14l5-5-5-5 M20 9H9a4 4 0 0 0 0 8h1" />
      </TBtn>
      <TBtn title="Delete selected (Del)" onClick={deleteSelected} disabled={!selectedComponentId}>
        <Ico d="M3 6h18 M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </TBtn>

      <Divider />

      <TBtn title="Insert Component (F2)" onClick={toggleInsertComponent}>
        <Ico d="M4 5h16v14H4z M12 9v6 M9 12h6" />
      </TBtn>

      <Divider />

      {/* ── Mode hint ── */}
      {editorMode === "place" && pendingPlaceType && (
        <span style={{ fontSize: 11, color: "#2563eb", fontStyle: "italic", marginLeft: 4, whiteSpace: "nowrap" }}>
          Placing {pendingPlaceType} — click canvas or Esc to cancel
        </span>
      )}
      {editorMode === "wire" && (
        <span style={{ fontSize: 11, color: "#16a34a", fontStyle: "italic", marginLeft: 4, whiteSpace: "nowrap" }}>
          Wire mode — click a pin to start, click to bend 90°, click another pin to finish (right-click/Esc cancels)
        </span>
      )}
      <DirectiveModal />
      <ModelImportModal />
      <InsertComponentModal />
    </div>
  );
}

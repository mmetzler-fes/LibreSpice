import { useState } from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore, type EditorMode } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { applyPltText } from "@simulation/pltApply.js";
import type { ComponentType } from "./nodes/ComponentNode.js";
import { DirectiveModal } from "./DirectiveModal.js";
import { ModelImportModal } from "./ModelImportModal.js";
import { InsertComponentModal } from "./InsertComponentModal.js";
import { useSimulationStore } from "@store/simulationStore.js";
import { runSimulation } from "@simulation/simulationEngine.js";
import { LTSpiceExporter } from "@core/ltspice/LTSpiceExporter.js";
import { readMsjs, convert } from "@core/multisim/MultisimConverter.js";
import { buildShareUrl } from "@store/persistence.js";
import { buildSchematicSvg } from "./svgExport.js";
import { buildShareQrSvg } from "./qrExport.js";
import { buildFragment, isFragment } from "@core/ltspice/ascFragment.js";
import { SymbolPreview } from "./SymbolPreview.js";

// ── Tiny SVG icon components ──────────────────────────────────────────────────

const Ico = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

// Ground keeps its own dedicated toolbar glyph (no palette entry requested).
const SymGnd = () => (
  <svg width="18" height="18" viewBox="-9 -12 18 24">
    <line x1="0" y1="-10" x2="0" y2="-2" stroke="currentColor" strokeWidth="2" />
    <line x1="-8" y1="-2" x2="8" y2="-2" stroke="currentColor" strokeWidth="2.2" />
    <line x1="-5" y1="3" x2="5" y2="3" stroke="currentColor" strokeWidth="2.2" />
    <line x1="-2" y1="8" x2="2" y2="8" stroke="currentColor" strokeWidth="2.2" />
  </svg>
);

// Quick-place buttons reuse the sidebar palette's symbols (current norm variant),
// inheriting the button's text color so active/dark/disabled states still apply.
const TbSym = ({ type }: { type: ComponentType }) => (
  <SymbolPreview type={type} size={24} margin={3} strokeWidth={1.4} color="currentColor" />
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
  const theme = useTheme();
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
        background: active ? (theme.itemActive) : "transparent",
        color: active ? (theme.flagValue) : disabled ? "#94a3b8" : "inherit",
        cursor: disabled ? "not-allowed" : "pointer",
        padding: 0,
      }}
    >
      {children}
    </button>
  );
}

function Divider() {
  const theme = useTheme();
  return (
    <div style={{ width: 1, height: 24, background: theme.border, margin: "0 4px", flexShrink: 0 }} />
  );
}

// ── Main Toolbar ──────────────────────────────────────────────────────────────

export function Toolbar() {
  const {
    canUndo, canRedo, undo, redo,
    clearCircuit, rotateSelected, mirrorSelected, deleteSelected, netlist, selectedComponentId, spiceDirectives,
    circuit, nodes, edges, loadFromAsc, fileHandle, setFileHandle, exportSnapshot,
    circuitName, setCircuitName, dataFlags, netAnchors, busTaps, textBoxes, sheetShapes, directiveRaw, ascHeader, ascOrphanWires,
    showDirectivesOnCanvas, directivesPos, setFragmentClipboard,
  } = useCircuitStore();
  const { editorMode, pendingPlaceType, setEditorMode, startPlacing, cancelPlacing, toggleDirectiveModal, toggleInsertComponent, setDockTab, symbolNorm, setSymbolNorm, areaSelect, toggleAreaSelect, setPendingFragment } = useUIStore();
  const theme = useTheme();
  const { status, setStatus, setResult, setErrorMessage, progress } = useSimulationStore();

  // When an opened folder holds several .asc files, let the user pick one.
  const [folderPick, setFolderPick] = useState<{ dir: any; files: { name: string; handle: any }[] } | null>(null);

  const isPlacing = (type: ComponentType) => editorMode === "place" && pendingPlaceType === type;

  // A selected wire carries no `selectedComponentId`, so gating Delete on that
  // alone left wires undeletable without a keyboard (no Del key on an iPad).
  const hasSelection = !!selectedComponentId || nodes.some((n) => n.selected) || edges.some((e) => e.selected);

  const handlePlace = (type: ComponentType) => {
    if (isPlacing(type)) cancelPlacing();
    else startPlacing(type);
  };

  const handleMode = (mode: EditorMode) => {
    if (editorMode === mode) return;
    setEditorMode(mode);
  };

  const handleRun = async () => {
    if (status === "running") return;
    // Rebuild the netlist right before running so a freshly loaded circuit
    // simulates immediately — no need to open SPICE Directives and press Apply.
    // This also captures the asynchronously-loaded server library.
    useCircuitStore.getState().regenerateNetlist();
    const fresh = useCircuitStore.getState().netlist;
    if (!fresh) return;
    setStatus("running");
    try {
      const res = await runSimulation(fresh);
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

  /**
   * Drop a text box just above the circuit's top-left corner — where a title or
   * a task description belongs, and clear of the parts.
   *
   * Derived from the content rather than from the viewport on purpose: the
   * toolbar is rendered outside the React Flow provider in the regression
   * harness, so a `useReactFlow` here would break it, and content-relative
   * placement is deterministic anyway.
   */
  const handleAddTextBox = () => {
    const ns = useCircuitStore.getState().nodes;
    const x = ns.length ? Math.round(Math.min(...ns.map((n) => n.position.x))) : 0;
    const y = ns.length ? Math.round(Math.min(...ns.map((n) => n.position.y))) - 160 : 0;
    useCircuitStore.getState().addTextBox(x, y);
  };

  /**
   * Cut / copy / paste from the toolbar, for use without a keyboard.
   *
   * Ctrl/Cmd+C/X/V already work through the clipboard events (see
   * SchematicCanvas), but iOS only offers its copy/paste callout on editable
   * elements — on a canvas there is nothing to long-press, so on an iPad without
   * a keyboard the feature was unreachable. These buttons are the same actions
   * through the async Clipboard API, which *is* allowed inside a click.
   */
  const copySelectionToClipboard = async (cut: boolean) => {
    const fragment = buildFragment(nodes, edges, circuit, netAnchors);
    if (!fragment) return;
    // Kept in-app as well, so pasting works even where reading the system
    // clipboard is refused (see fragmentClipboard).
    setFragmentClipboard(fragment);
    try {
      await navigator.clipboard?.writeText(fragment);
    } catch {
      // No system clipboard — the in-app copy above still carries this session.
    }
    if (cut) deleteSelected();
    // The block now rides on the cursor until it is put down — on a touch device
    // that is the whole gesture: select, press Copy, drag, lift.
    setPendingFragment(fragment);
  };

  /**
   * Where a pasted block lands when the button is used: clear to the right of
   * everything already on the sheet, so it never drops on top of the original.
   *
   * Content-relative rather than viewport-relative on purpose — the toolbar is
   * rendered outside the React Flow provider in the regression harness, so it
   * cannot ask for the viewport (same reason as handleAddTextBox).
   */
  const pasteAnchor = () => {
    const ns = useCircuitStore.getState().nodes;
    if (ns.length === 0) return { x: 0, y: 0 };
    return {
      x: Math.round(Math.max(...ns.map((n) => n.position.x))) + 160,
      y: Math.round(Math.min(...ns.map((n) => n.position.y))),
    };
  };

  const handlePaste = async () => {
    let text = "";
    try {
      text = (await navigator.clipboard?.readText()) ?? "";
    } catch {
      // Refused or unsupported — fall through to what we copied ourselves.
    }
    if (!isFragment(text)) text = useCircuitStore.getState().fragmentClipboard;
    if (!isFragment(text)) return;
    useCircuitStore.getState().pasteFragment(text, pasteAnchor());
  };

  const handleExportSvg = () => {
    // "Display in circuit" puts the directives on the sheet, so they belong in
    // the export too — at the spot the user dragged the box to.
    const overlay = showDirectivesOnCanvas ? { text: spiceDirectives, pos: directivesPos } : undefined;
    // `circuit` resolves the wires' net names — a wire stores only *whether* to
    // show a label, never the text (see NetNameLookup).
    downloadBlob(buildSchematicSvg(nodes, edges, symbolNorm, overlay, circuit, textBoxes, sheetShapes, netAnchors, busTaps), `${safeName}_Schaltung.svg`, "image/svg+xml");
  };

  const handleSave = async (saveAs: boolean = false) => {
    const content = LTSpiceExporter.export(nodes, edges, spiceDirectives, circuit, dataFlags, textBoxes, sheetShapes, { directiveRaw, header: ascHeader, orphanWires: ascOrphanWires, anchors: netAnchors, busTaps });
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

  /**
   * Import a Multisim Live export.
   *
   * Multisim Live was retired, so its `.msjs` files are converted to an LTSpice
   * schematic and handed to the normal loader — the schematic then renders and
   * behaves exactly like an opened `.asc`, with no second drawing path to keep
   * in step.
   *
   * What could not be carried over is reported rather than passed over in
   * silence: a schematic missing a part still opens, and looks plausible, so
   * the gaps have to be stated.
   */
  const handleImportMultisim = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".msjs";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const { asc, skipped, substituted, shorts } = convert(readMsjs(await file.arrayBuffer()));
        loadFromAsc(asc);
        setFileHandle(null, file.name);
        setCircuitName(file.name.replace(/\.msjs$/i, ""));

        const notes: string[] = [];
        if (skipped.length) {
          notes.push(`Nicht abbildbare Bauteile (fehlen in der Schaltung):\n  ${skipped.join(", ")}`);
        }
        if (substituted.length) {
          notes.push(`Als Ersatzmodell konvertiert:\n  ${substituted.join(", ")}`);
        }
        if (shorts.length) {
          notes.push(`Achtung — kurzgeschlossene Netze: ${shorts.join(", ")}\nDiese Schaltung vor Gebrauch prüfen.`);
        }
        if (notes.length) alert(`${file.name}\n\n${notes.join("\n\n")}`);
      } catch (err) {
        alert(`Import fehlgeschlagen: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    input.click();
  };

  // Load one .asc from an opened folder, plus its sibling <name>.plt if present.
  const openAscFromFolder = async (dir: any, name: string, handle: any) => {
    const text = new TextDecoder("windows-1252").decode(await (await handle.getFile()).arrayBuffer());
    loadFromAsc(text);
    setFileHandle(handle, name);
    const base = name.replace(/\.asc$/i, "");
    setCircuitName(base);
    // Auto-load the matching plot settings if the folder has <name>.plt.
    try {
      const pltHandle = await dir.getFileHandle(`${base}.plt`);
      applyPltText(await (await pltHandle.getFile()).text());
    } catch {
      /* no sibling .plt — nothing to apply */
    }
    setFolderPick(null);
  };

  // Open a folder, then a .asc inside it, and auto-load its plot settings. This
  // needs directory access (showDirectoryPicker) — a single-file open cannot
  // read sibling files.
  const handleOpenFolder = async () => {
    if (!("showDirectoryPicker" in window)) {
      alert("Ordner öffnen wird von diesem Browser nicht unterstützt. Bitte 'Öffnen' verwenden.");
      return;
    }
    let dir: any;
    try {
      dir = await (window as any).showDirectoryPicker();
    } catch (err: any) {
      if (err?.name !== "AbortError") console.error(err);
      return;
    }
    const files: { name: string; handle: any }[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === "file" && /\.asc$/i.test(name)) files.push({ name, handle });
    }
    if (files.length === 0) {
      alert("Keine .asc-Datei in diesem Ordner gefunden.");
      return;
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    if (files.length === 1) {
      await openAscFromFolder(dir, files[0].name, files[0].handle);
      return;
    }
    setFolderPick({ dir, files });
  };

  const handleShareUrl = async () => {
    const url = await buildShareUrl(exportSnapshot());
    try {
      await navigator.clipboard.writeText(url);
      alert("Share link copied to clipboard!");
    } catch {
      prompt("Copy this link to share your circuit:", url);
    }
  };

  const handleExportQr = async () => {
    const svg = buildShareQrSvg(await buildShareUrl(exportSnapshot()));
    if (!svg) {
      alert(
        "Die Schaltung ist zu groß für einen QR-Code (Grenze: 2953 Zeichen).\n" +
          "Bitte den Share-Link direkt kopieren und weitergeben.",
      );
      return;
    }
    downloadBlob(svg, `${safeName}_QR-Code.svg`, "image/svg+xml");
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: 36,
        padding: "0 6px",
        gap: 2,
        background: theme.panelBgAlt,
        borderBottom: `1px solid ${theme.border}`,
        color: theme.text,
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
      {/* Deliberately not a folder glyph: this sits between two folder buttons,
          and a third folder was indistinguishable from them. An arrow dropping
          into a tray is the conventional "import" mark. */}
      <TBtn title="Multisim Live (.msjs) importieren" onClick={handleImportMultisim}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v10" />
          <path d="M8 9l4 4 4-4" />
          <path d="M3 15v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" />
        </svg>
      </TBtn>
      <TBtn title="Open folder — loads the .asc and its matching .plt plot settings" onClick={handleOpenFolder}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <path d="M8 13h8 M12 17v-8" />
        </svg>
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
      <TBtn title="Export share URL as QR code (SVG)" onClick={handleExportQr}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <path d="M14 14h3v3h-3z M20 14v0.01 M14 20v0.01 M20 20v0.01 M17 20v0.01 M20 17v0.01" />
        </svg>
      </TBtn>
      <TBtn title="Export schematic as SVG" onClick={handleExportSvg}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12 M8 11l4 4 4-4 M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
          <text x="12" y="9" textAnchor="middle" fontSize="7" fill="currentColor" stroke="none">SVG</text>
        </svg>
      </TBtn>

      <TBtn title="Textfeld einfügen — Doppelklick bearbeitet, MD schaltet Markdown ein" onClick={handleAddTextBox}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 5h14 M12 5v14 M9 19h6" />
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
          border: `1px solid ${theme.border}`,
          borderRadius: 4,
          background: theme.inputBg,
          color: theme.icon,
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
      {progress && progress.total > 1 && (
        <span style={{ fontSize: 12, color: "#64748b", whiteSpace: "nowrap", padding: "0 4px" }}>
          {`Sweep ${progress.done}/${progress.total}`}
        </span>
      )}

      <Divider />

      {/* ── Edit modes ── */}
      <TBtn title="Select / Move (Esc)" active={editorMode === "select"} onClick={() => handleMode("select")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 3l14 9-7 1-4 7z" />
        </svg>
      </TBtn>
      {/* Shift+drag already draws a rubber band, but that needs a keyboard — this
          is the same gesture for the iPad. */}
      <TBtn
        title="Select an area (or hold Shift and drag)"
        active={areaSelect && editorMode === "select"}
        disabled={editorMode !== "select"}
        onClick={toggleAreaSelect}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="1" strokeDasharray="4 3" />
        </svg>
      </TBtn>
      <TBtn title="Draw Wire (W)" active={editorMode === "wire"} onClick={() => handleMode("wire")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="3,21 3,8 12,8 12,3 21,3" />
        </svg>
      </TBtn>
      <TBtn title="Place Net Label" active={isPlacing("netlabel")} onClick={() => handlePlace("netlabel")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="3.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <path d="M3.5 12 h5" />
          <path d="M8.5 7.5 h11 a1.5 1.5 0 0 1 1.5 1.5 v6 a1.5 1.5 0 0 1 -1.5 1.5 h-11 z" />
          <path d="M11.5 12 h7" strokeWidth="1.4" />
        </svg>
      </TBtn>
      <TBtn title="Place Net Connector (Port)" active={isPlacing("netconnector")} onClick={() => handlePlace("netconnector")}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="3.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <path d="M3.5 12 h5" />
          {/* Double arrowhead: the bi-directional port a fresh connector is. */}
          <polygon points="8.5,12 5.8,10.4 5.8,13.6" fill="currentColor" stroke="none" />
          <polygon points="3.5,12 6.2,10.4 6.2,13.6" fill="currentColor" stroke="none" />
          <path d="M8.5 7.5 h11 a1.5 1.5 0 0 1 1.5 1.5 v6 a1.5 1.5 0 0 1 -1.5 1.5 h-11 z" />
          <path d="M11.5 12 h7" strokeWidth="1.4" />
        </svg>
      </TBtn>

      <Divider />

      {/* ── Symbol norm ── */}
      <select
        title="Symbol standard (drawing norm)"
        value={symbolNorm}
        onChange={(e) => setSymbolNorm(e.target.value as typeof symbolNorm)}
        style={{
          height: 28, fontSize: 12,
          border: `1px solid ${theme.border}`,
          borderRadius: 4,
          background: theme.inputBg,
          color: theme.icon,
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
        <TbSym type="resistor" />
      </TBtn>
      <TBtn title="Place Capacitor (C)" active={isPlacing("capacitor")} onClick={() => handlePlace("capacitor")}>
        <TbSym type="capacitor" />
      </TBtn>
      <TBtn title="Place Inductor (L)" active={isPlacing("inductor")} onClick={() => handlePlace("inductor")}>
        <TbSym type="inductor" />
      </TBtn>
      <TBtn title="Place Diode (D)" active={isPlacing("diode")} onClick={() => handlePlace("diode")}>
        <TbSym type="diode" />
      </TBtn>
      <Divider />

      <TBtn title="Place Voltage Source (V)" active={isPlacing("vsource")} onClick={() => handlePlace("vsource")}>
        <TbSym type="vsource" />
      </TBtn>
      <TBtn title="Place Current Source (I)" active={isPlacing("isource")} onClick={() => handlePlace("isource")}>
        <TbSym type="isource" />
      </TBtn>
      {/* Ground belongs with the sources: a source needs a reference node, and this
          is where the eye looks for it. */}
      <TBtn title="Place Ground (G)" active={isPlacing("ground")} onClick={() => handlePlace("ground")}>
        <SymGnd />
      </TBtn>

      <Divider />

      <TBtn title="Place NPN Transistor (Q)" active={isPlacing("bjt_npn")} onClick={() => handlePlace("bjt_npn")}>
        <TbSym type="bjt_npn" />
      </TBtn>
      <TBtn title="Place NMOSFET (M)" active={isPlacing("mosfet_n")} onClick={() => handlePlace("mosfet_n")}>
        <TbSym type="mosfet_n" />
      </TBtn>

      <Divider />

      {/* ── Transform ── */}
      <TBtn title="Rotate 90° left (Ctrl+R)" onClick={rotateSelected} disabled={!selectedComponentId}>
        <Ico d="M23 4v6h-6 M1 20v-6h6 M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15" />
      </TBtn>
      <TBtn title="Mirror horizontal (Ctrl+E)" onClick={mirrorSelected} disabled={!selectedComponentId}>
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
      <TBtn title="Copy selection (Ctrl+C) — then click where it should land" onClick={() => copySelectionToClipboard(false)} disabled={!hasSelection}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="12" height="12" rx="2" />
          <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
        </svg>
      </TBtn>
      <TBtn title="Cut selection (Ctrl+X) — then click where it should land" onClick={() => copySelectionToClipboard(true)} disabled={!hasSelection}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="6" cy="18" r="3" /><circle cx="18" cy="18" r="3" />
          <path d="M8.1 15.9 20 4M4 4l11.9 11.9" />
        </svg>
      </TBtn>
      <TBtn title="Paste (Ctrl+V)" onClick={handlePaste}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" />
        </svg>
      </TBtn>
      <TBtn title="Delete selected (Del)" onClick={deleteSelected} disabled={!hasSelection}>
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

      {/* Folder open: choose which .asc when the folder holds several. */}
      {folderPick && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setFolderPick(null); }}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <div style={{ background: theme.modalBg, border: `1px solid ${theme.border}`, borderRadius: 8, width: 380, maxWidth: "90vw", maxHeight: "70vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 25px 50px rgba(0,0,0,0.5)" }}>
            <div style={{ padding: "12px 16px", borderBottom: `1px solid ${theme.borderMuted}`, fontSize: 14, fontWeight: 600, color: theme.text }}>
              Schaltung wählen
            </div>
            <div style={{ overflowY: "auto", padding: 6 }}>
              {folderPick.files.map((f) => (
                <button
                  key={f.name}
                  onClick={() => openAscFromFolder(folderPick.dir, f.name, f.handle)}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", background: "transparent", color: theme.text, cursor: "pointer", fontSize: 13, borderRadius: 4, fontFamily: "monospace" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = theme.itemHover)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  📄 {f.name}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

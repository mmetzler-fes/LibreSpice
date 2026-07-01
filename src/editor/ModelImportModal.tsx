import { useEffect, useMemo, useState } from "react";
import { useUIStore } from "@store/uiStore.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { ModelParser } from "@core/library/ModelParser.js";
import type { LibraryScope } from "@core/library/types.js";
import { SpiceHighlight } from "./SpiceHighlight.js";

const EXAMPLE = `.model 1N4148 D(IS=2.52n RS=0.568 N=1.752 CJO=4p M=0.4 TT=20n BV=100 IBV=0.1u)
.model 2N2222 NPN(IS=1e-14 BF=200 VAF=100 IKF=0.3 RB=10 RC=1 RE=0.5)
.subckt OPAMP in+ in- vcc vee out
  R1 in+ in- 1MEG
  E1 out 0 in+ in- 100k
.ends OPAMP`;

export function ModelImportModal() {
  const { showLibraryImport, toggleLibraryImport } = useUIStore();
  const { addEntries } = useLibraryStore();
  const [text, setText] = useState("");
  const [scope, setScope] = useState<LibraryScope>("local");

  useEffect(() => {
    if (showLibraryImport) {
      setText("");
      setScope("local");
    }
  }, [showLibraryImport]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showLibraryImport) toggleLibraryImport();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showLibraryImport, toggleLibraryImport]);

  // Parse live so the preview/warnings update as the user pastes.
  const parsed = useMemo(() => (text.trim() ? ModelParser.parse(text) : null), [text]);

  if (!showLibraryImport) return null;

  const entryCount = parsed?.entries.length ?? 0;
  const allWarnings = [
    ...(parsed?.warnings ?? []),
    ...(parsed?.entries.flatMap((e) => e.warnings) ?? []),
  ];

  const handleImport = () => {
    if (!parsed || parsed.entries.length === 0) return;
    addEntries(parsed.entries, scope);
    toggleLibraryImport();
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) toggleLibraryImport(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, width: 680, maxWidth: "92vw", boxShadow: "0 25px 50px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #334155", background: "#0f172a" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📥</span>
            <span style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600 }}>Import LTSpice Model / Subcircuit</span>
          </div>
          <button onClick={toggleLibraryImport} style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 4px" }} title="Close (Esc)">×</button>
        </div>

        {/* Info */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid #334155", background: "#1a2744" }}>
          <p style={{ margin: 0, fontSize: 11, color: "#94a3b8", lineHeight: 1.6 }}>
            Paste one or more <code style={{ color: "#c084fc" }}>.model</code> or <code style={{ color: "#c084fc" }}>.subckt</code> blocks copied from an LTSpice library.
            Unknown parameters are kept but flagged – the import never fails on them.
          </p>
        </div>

        {/* Editor */}
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <SpiceHighlight value={text} onChange={setText} placeholder={EXAMPLE} minHeight={200}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleImport(); }} />

          {/* Parse preview */}
          {parsed && (
            <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", flexDirection: "column", gap: 4, maxHeight: 110, overflowY: "auto" }}>
              <div style={{ color: entryCount > 0 ? "#86efac" : "#f87171" }}>
                {entryCount > 0
                  ? `✓ Detected ${entryCount} ${entryCount === 1 ? "entry" : "entries"}: ${parsed.entries.map((e) => e.name).join(", ")}`
                  : "No .model or .subckt found."}
              </div>
              {allWarnings.slice(0, 8).map((w, i) => (
                <div key={i} style={{ color: "#fbbf24" }}>⚠ {w}</div>
              ))}
              {allWarnings.length > 8 && <div style={{ color: "#fbbf24" }}>…and {allWarnings.length - 8} more</div>}
            </div>
          )}

          {/* Scope selector (CircuitSim-style Local vs Temp) */}
          <div style={{ display: "flex", gap: 8 }}>
            {([
              ["local", "💾 Add to Local", "Persist in this browser across sessions"],
              ["temp", "⏱ Use Temp", "Keep only for the current session"],
            ] as const).map(([val, label, hint]) => (
              <button
                key={val}
                onClick={() => setScope(val)}
                title={hint}
                style={{
                  flex: 1, padding: "8px 10px", textAlign: "left",
                  border: `1px solid ${scope === val ? "#2563eb" : "#475569"}`,
                  background: scope === val ? "#1e3a5f" : "transparent",
                  color: scope === val ? "#bfdbfe" : "#94a3b8",
                  borderRadius: 6, cursor: "pointer", fontSize: 12,
                }}
              >
                <div style={{ fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 10, opacity: 0.8 }}>{hint}</div>
              </button>
            ))}
          </div>

          {/* Buttons */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button onClick={toggleLibraryImport} style={{ padding: "6px 14px", border: "1px solid #475569", background: "transparent", color: "#94a3b8", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>Cancel</button>
            <button onClick={handleImport} disabled={entryCount === 0}
              style={{ padding: "6px 16px", border: "none", background: entryCount === 0 ? "#334155" : "#2563eb", color: entryCount === 0 ? "#64748b" : "#fff", borderRadius: 4, cursor: entryCount === 0 ? "not-allowed" : "pointer", fontWeight: 600, fontSize: 12 }}
              title="Import (Ctrl+Enter)">
              ✓ Import {entryCount > 0 ? `(${entryCount})` : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

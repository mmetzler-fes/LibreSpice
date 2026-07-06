import { useState, useEffect, useRef } from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { formatAnalysisDirective, parseAnalysisDirective, type SimulationConfig } from "@core/circuit/NetlistGenerator.js";
import { SimDirectiveDialog, defaultConfig } from "./SimDirectiveDialog.js";
import { StepDirectiveDialog, defaultStepForm, parseStepForm, type StepForm } from "./StepDirectiveDialog.js";

const EXAMPLES = `.tran 1u 10m        * Transient: step=1µs, stop=10ms
.ac DEC 100 1 1MEG  * AC: 100pts/decade, 1Hz–1MHz
.dc V1 0 5 0.01     * DC sweep V1 from 0 to 5V
.param R=1k C=100n  * Parameter definitions
.model 2N2222 NPN (Bf=100 Vaf=100)`;

export function DirectiveModal() {
  const { spiceDirectives, setSpiceDirectives, showDirectivesOnCanvas, setShowDirectivesOnCanvas } = useCircuitStore();
  const { showDirectiveModal, toggleDirectiveModal } = useUIStore();
  const [text, setText] = useState(spiceDirectives);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Options dialog for one analysis directive. `lineIndex === null` means the
  // edited directive will be appended as a new line.
  const [optDialog, setOptDialog] = useState<{ config: SimulationConfig; lineIndex: number | null } | null>(null);
  // Options dialog for one `.step` directive (null lineIndex → append new).
  const [stepDialog, setStepDialog] = useState<{ form: StepForm; lineIndex: number | null } | null>(null);

  useEffect(() => {
    if (showDirectiveModal) {
      setText(spiceDirectives);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [showDirectiveModal, spiceDirectives]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showDirectiveModal) toggleDirectiveModal();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showDirectiveModal, toggleDirectiveModal]);

  if (!showDirectiveModal) return null;

  const handleApply = () => {
    setSpiceDirectives(text);
    toggleDirectiveModal();
  };

  // Analysis-command lines (.tran/.ac/.dc/.op) that can be edited via the dialog.
  const directiveLines = text.split("\n")
    .map((line, index) => ({ line, index, config: parseAnalysisDirective(line) }))
    .filter((d): d is { line: string; index: number; config: SimulationConfig } => d.config !== null);

  // Write an edited config back to its line (or append it as a new directive),
  // preserving any trailing `* comment`.
  const applyOptions = (cfg: SimulationConfig) => {
    const directive = formatAnalysisDirective(cfg);
    const lines = text.split("\n");
    if (optDialog?.lineIndex != null && optDialog.lineIndex < lines.length) {
      const existing = lines[optDialog.lineIndex];
      const c = existing.indexOf("*");
      lines[optDialog.lineIndex] = directive + (c >= 0 ? "  " + existing.slice(c) : "");
    } else {
      lines.push(directive);
    }
    setText(lines.join("\n").replace(/^\n/, ""));
    setOptDialog(null);
  };

  // `.step` directive lines that can be edited via the step dialog.
  const stepLines = text.split("\n")
    .map((line, index) => ({ line, index, form: parseStepForm(line) }))
    .filter((d): d is { line: string; index: number; form: StepForm } => d.form !== null);

  // Write a built `.step` directive back to its line, or append a new one.
  const applyStep = (directive: string) => {
    const lines = text.split("\n");
    if (stepDialog?.lineIndex != null && stepDialog.lineIndex < lines.length) {
      lines[stepDialog.lineIndex] = directive;
    } else {
      lines.push(directive);
    }
    setText(lines.join("\n").replace(/^\n/, ""));
    setStepDialog(null);
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) toggleDirectiveModal(); }}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 2000,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div style={{
        background: "#1e293b",
        border: "1px solid #334155",
        borderRadius: 8,
        width: 640,
        maxWidth: "90vw",
        boxShadow: "0 25px 50px rgba(0,0,0,0.5)",
        display: "flex", flexDirection: "column",
        overflow: "hidden",
      }}>
        {/* Header */}
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid #334155",
          background: "#0f172a",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>📋</span>
            <span style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600 }}>SPICE Directives</span>
          </div>
          <button
            onClick={toggleDirectiveModal}
            style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 4px" }}
            title="Close (Esc)"
          >×</button>
        </div>

        {/* Info */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid #334155", background: "#1a2744" }}>
          <p style={{ margin: 0, fontSize: 11, color: "#94a3b8", lineHeight: 1.6 }}>
            Enter SPICE directives, one per line. Lines starting with <code style={{ color: "#67e8f9", background: "#0f172a", padding: "1px 4px", borderRadius: 3 }}>*</code> are comments.
            An analysis command (<code style={{ color: "#67e8f9", background: "#0f172a", padding: "1px 4px", borderRadius: 3 }}>.tran</code>,{" "}
            <code style={{ color: "#67e8f9", background: "#0f172a", padding: "1px 4px", borderRadius: 3 }}>.ac</code>,{" "}
            <code style={{ color: "#67e8f9", background: "#0f172a", padding: "1px 4px", borderRadius: 3 }}>.dc</code>) overrides the Simulation Panel settings.
          </p>
        </div>

        {/* Textarea */}
        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={EXAMPLES}
            spellCheck={false}
            rows={10}
            style={{
              fontFamily: "'Cascadia Code', 'Fira Code', 'Courier New', monospace",
              fontSize: 13,
              lineHeight: 1.7,
              background: "#0f172a",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "10px 12px",
              resize: "vertical",
              minHeight: 200,
              outline: "none",
              width: "100%",
              boxSizing: "border-box",
              caretColor: "#67e8f9",
            }}
            onKeyDown={(e) => {
              // Ctrl+Enter applies
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleApply();
            }}
          />

          {/* Quick-insert buttons */}
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: "#64748b", alignSelf: "center" }}>Quick insert:</span>
            {[
              [".tran 1u 10m", "Transient"],
              [".ac DEC 100 1 1MEG", "AC"],
              [".dc V1 0 5 0.01", "DC Sweep"],
              [".op", "Op. Point"],
            ].map(([snippet, label]) => (
              <button
                key={label}
                onClick={() => setText((t) => t ? `${t}\n${snippet}` : snippet)}
                style={{
                  padding: "2px 8px", fontSize: 11,
                  background: "#1e3a5f", color: "#93c5fd",
                  border: "1px solid #2d5a9e", borderRadius: 4, cursor: "pointer",
                  fontFamily: "monospace",
                }}
              >{label}</button>
            ))}
          </div>

          {/* Analysis directive options — edit every parameter in a dialog
              instead of memorising the SPICE syntax. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "#1a2744", border: "1px solid #334155", borderRadius: 6, padding: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8" }}>Analysis options</span>
              <button
                onClick={() => setOptDialog({ config: defaultConfig("tran"), lineIndex: null })}
                style={{ padding: "2px 8px", fontSize: 11, background: "#1e3a5f", color: "#93c5fd", border: "1px solid #2d5a9e", borderRadius: 4, cursor: "pointer" }}
              >+ Add analysis…</button>
            </div>
            {directiveLines.length === 0 ? (
              <span style={{ fontSize: 11, color: "#64748b" }}>
                No analysis directive yet — click “Add analysis…” to configure one with all options.
              </span>
            ) : (
              directiveLines.map((d) => (
                <div key={d.index} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code style={{ flex: 1, minWidth: 0, fontSize: 12, color: "#67e8f9", background: "#0f172a", padding: "3px 6px", borderRadius: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {d.line.trim()}
                  </code>
                  <button
                    onClick={() => setOptDialog({ config: d.config, lineIndex: d.index })}
                    title="Edit all parameters for this directive"
                    style={{ padding: "3px 10px", fontSize: 11, background: "#1e293b", color: "#cbd5e1", border: "1px solid #475569", borderRadius: 4, cursor: "pointer", whiteSpace: "nowrap" }}
                  >⚙ Options</button>
                </div>
              ))
            )}
          </div>

          {/* Parameter sweep (.step) options — build a sweep without SPICE syntax. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, background: "#1a2744", border: "1px solid #334155", borderRadius: 6, padding: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: "#94a3b8" }}>Parameter sweep (.step)</span>
              <button
                onClick={() => setStepDialog({ form: defaultStepForm(), lineIndex: null })}
                style={{ padding: "2px 8px", fontSize: 11, background: "#1e3a5f", color: "#93c5fd", border: "1px solid #2d5a9e", borderRadius: 4, cursor: "pointer" }}
              >+ Add step…</button>
            </div>
            {stepLines.length === 0 ? (
              <span style={{ fontSize: 11, color: "#64748b" }}>
                No sweep yet — click “Add step…” to sweep a parameter and reference it as {"{name}"} in a value.
              </span>
            ) : (
              stepLines.map((d) => (
                <div key={d.index} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code style={{ flex: 1, minWidth: 0, fontSize: 12, color: "#67e8f9", background: "#0f172a", padding: "3px 6px", borderRadius: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {d.line.trim()}
                  </code>
                  <button
                    onClick={() => setStepDialog({ form: d.form, lineIndex: d.index })}
                    title="Edit this parameter sweep"
                    style={{ padding: "3px 10px", fontSize: 11, background: "#1e293b", color: "#cbd5e1", border: "1px solid #475569", borderRadius: 4, cursor: "pointer", whiteSpace: "nowrap" }}
                  >⚙ Options</button>
                </div>
              ))
            )}
          </div>

          {/* Buttons */}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#cbd5e1", cursor: "pointer", marginRight: "auto" }}
              title="Show these directives as a text box on the schematic">
              <input
                type="checkbox"
                checked={showDirectivesOnCanvas}
                onChange={(e) => setShowDirectivesOnCanvas(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              Display in circuit
            </label>
            <button
              onClick={() => { setSpiceDirectives(""); setText(""); toggleDirectiveModal(); }}
              style={{ padding: "6px 14px", border: "1px solid #475569", background: "transparent", color: "#94a3b8", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
            >Clear & Close</button>
            <button
              onClick={toggleDirectiveModal}
              style={{ padding: "6px 14px", border: "1px solid #475569", background: "transparent", color: "#94a3b8", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
            >Cancel</button>
            <button
              onClick={handleApply}
              style={{ padding: "6px 16px", border: "none", background: "#2563eb", color: "#fff", borderRadius: 4, cursor: "pointer", fontWeight: 600, fontSize: 12 }}
              title="Apply (Ctrl+Enter)"
            >✓ Apply</button>
          </div>
        </div>
      </div>

      {optDialog && (
        <SimDirectiveDialog
          open
          initialConfig={optDialog.config}
          onApply={applyOptions}
          onClose={() => setOptDialog(null)}
        />
      )}

      {stepDialog && (
        <StepDirectiveDialog
          open
          initial={stepDialog.form}
          onApply={applyStep}
          onClose={() => setStepDialog(null)}
        />
      )}
    </div>
  );
}

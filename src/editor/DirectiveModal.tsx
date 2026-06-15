import { useState, useEffect, useRef } from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";

const EXAMPLES = `.tran 1u 10m        * Transient: step=1µs, stop=10ms
.ac DEC 100 1 1MEG  * AC: 100pts/decade, 1Hz–1MHz
.dc V1 0 5 0.01     * DC sweep V1 from 0 to 5V
.param R=1k C=100n  * Parameter definitions
.model 2N2222 NPN (Bf=100 Vaf=100)`;

export function DirectiveModal() {
  const { spiceDirectives, setSpiceDirectives } = useCircuitStore();
  const { showDirectiveModal, toggleDirectiveModal } = useUIStore();
  const [text, setText] = useState(spiceDirectives);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

          {/* Buttons */}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
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
    </div>
  );
}

import React from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import {
  TEXT_SIZES, TEXT_SIZE_DEFAULT, TEXTBOX_MIN_W, textFlow, type Justification,
} from "@core/circuit/textBox.js";

/**
 * Settings of the selected text box: how big it is set, which way it reads, how
 * wide it wraps, and whether it is Markdown.
 *
 * Here rather than on the box itself. A note is read far more often than it is
 * changed, so a title bar of buttons sat on every one of them permanently to
 * serve the rare moment — and it was the only object on the sheet whose settings
 * were not in this panel.
 */
export function TextBoxPanel() {
  const boxes = useCircuitStore((s) => s.textBoxes);
  const update = useCircuitStore((s) => s.updateTextBox);
  const remove = useCircuitStore((s) => s.removeTextBox);
  const selectedId = useUIStore((s) => s.selectedTextBoxId);
  const setSelected = useUIStore((s) => s.setSelectedTextBoxId);
  const theme = useTheme();

  const box = boxes.find((b) => b.id === selectedId);
  if (!box) return null;

  const size = box.size ?? TEXT_SIZE_DEFAULT;
  const justify = box.justify ?? "Left";
  const flow = textFlow(justify);

  const fieldStyle: React.CSSProperties = {
    padding: "4px 6px", border: `1px solid ${theme.border}`, borderRadius: 4,
    width: "100%", boxSizing: "border-box", background: theme.inputBg, color: theme.text, fontSize: 12,
  };
  const labelStyle: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 };
  const capStyle: React.CSSProperties = { fontSize: 10, color: "#94a3b8" };

  /** Set the reading direction, keeping the alignment the keyword also carries. */
  const setVertical = (vertical: boolean) => {
    const base = justify.startsWith("V") ? justify.slice(1) : justify;
    update(box.id, { justify: (vertical ? `V${base}` : base) as Justification });
  };
  /** Set the alignment, keeping the reading direction. */
  const setAlign = (base: string) => {
    update(box.id, { justify: (flow.vertical ? `V${base}` : base) as Justification });
  };

  return (
    <div style={{ padding: "10px 16px", borderTop: `1px solid ${theme.borderMuted}` }}>
      <strong style={{ display: "block", marginBottom: 8, fontSize: 12, color: theme.heading }}>
        Textfeld
      </strong>

      <label style={labelStyle}>
        <span style={capStyle}>Schriftgröße</span>
        <select value={size} onChange={(e) => update(box.id, { size: Number(e.target.value) })} style={fieldStyle}>
          {TEXT_SIZES.map((v, i) => (
            <option key={i} value={i}>{v.toFixed(v < 1 ? 3 : 1)}{i === TEXT_SIZE_DEFAULT ? " (Standard)" : ""}</option>
          ))}
        </select>
      </label>

      <label style={labelStyle}>
        <span style={capStyle}>Richtung</span>
        <select value={flow.vertical ? "v" : "h"} onChange={(e) => setVertical(e.target.value === "v")} style={fieldStyle}>
          <option value="h">waagrecht</option>
          <option value="v">senkrecht (nach links gedreht)</option>
        </select>
      </label>

      <label style={labelStyle}>
        <span style={capStyle}>Ausrichtung</span>
        <select
          value={justify.startsWith("V") ? justify.slice(1) : justify}
          onChange={(e) => setAlign(e.target.value)}
          style={fieldStyle}
        >
          <option value="Left">linksbündig</option>
          <option value="Center">zentriert</option>
          <option value="Right">rechtsbündig</option>
        </select>
      </label>

      <label style={labelStyle}>
        <span style={capStyle}>Umbruchbreite</span>
        <input
          type="number"
          min={TEXTBOX_MIN_W}
          step={8}
          value={Math.round(box.width)}
          // Setting a width by hand is what takes the box off its text: from
          // here on the text wraps into this width instead of widening the box.
          onChange={(e) => update(box.id, { width: Math.max(TEXTBOX_MIN_W, Number(e.target.value) || TEXTBOX_MIN_W), autoSized: false })}
          style={fieldStyle}
          disabled={!!box.autoSized}
          title={box.autoSized ? "Die Breite folgt dem Text — dafür „Feste Breite“ einschalten" : undefined}
        />
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8 }}>
        <input
          type="checkbox"
          checked={!box.autoSized}
          // Off puts the box back on its text and drops the width from the file;
          // on freezes the width it currently has, as the starting point.
          onChange={(e) => update(box.id, e.target.checked
            ? { width: Math.round(box.width), autoSized: false }
            : { autoSized: true })}
        />
        <span style={{ fontSize: 12, color: theme.text }}>Feste Breite (umbrechen)</span>
      </label>

      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 8 }}>
        <input type="checkbox" checked={!!box.markdown} onChange={(e) => update(box.id, { markdown: e.target.checked })} />
        <span style={{ fontSize: 12, color: theme.text }}>Markdown auswerten</span>
      </label>

      <p style={{ margin: "0 0 8px", fontSize: 10, color: "#94a3b8", lineHeight: 1.4 }}>
        {box.autoSized
          ? "Das Feld ist so breit wie die längste Zeile; umgebrochen wird nur mit der Return-Taste. So speichert es auch LTSpice."
          : "Der Text bricht in der eingestellten Breite um. Diese Breite steht als [w= h=] im Kommentar — LTSpice zeigt sie als Text mit an."}
      </p>

      <button
        onClick={() => { remove(box.id); setSelected(null); }}
        style={{
          padding: "4px 8px", fontSize: 11, cursor: "pointer",
          border: `1px solid ${theme.border}`, borderRadius: 4,
          background: "transparent", color: "#dc2626",
        }}
      >
        Textfeld entfernen
      </button>
    </div>
  );
}

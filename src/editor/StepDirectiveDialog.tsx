import { useEffect, useState } from "react";
import { formatSpiceNumber, parseSpiceNumber } from "@core/circuit/NetlistGenerator.js";

/** Sweep kind of a `.step` directive. */
export type StepMode = "lin" | "dec" | "oct" | "list";

/** Editable form of a `.step param …` directive. */
export interface StepForm {
  name: string;
  mode: StepMode;
  start: number;
  stop: number;
  /** Increment (lin) or points-per-decade/octave (dec/oct). */
  incr: number;
  /** Space/comma separated values (list mode), kept as raw text. */
  list: string;
}

export function defaultStepForm(): StepForm {
  return { name: "R", mode: "lin", start: 1, stop: 10, incr: 1, list: "1 2 5 10" };
}

/** Render a {@link StepForm} as its `.step` SPICE directive. */
export function formatStepDirective(f: StepForm): string {
  const n = f.name.trim() || "X";
  if (f.mode === "list") {
    const vals = f.list.trim().split(/[\s,]+/).filter(Boolean).join(" ");
    return `.step param ${n} list ${vals}`;
  }
  const fmt = (v: number) => formatSpiceNumber(v);
  if (f.mode === "lin") return `.step param ${n} ${fmt(f.start)} ${fmt(f.stop)} ${fmt(f.incr)}`;
  return `.step ${f.mode} param ${n} ${fmt(f.start)} ${fmt(f.stop)} ${fmt(f.incr)}`;
}

/** Parse a `.step param …` line back into a {@link StepForm}, or null. */
export function parseStepForm(line: string): StepForm | null {
  const m = line.trim().match(/^\.step\s+(?:(lin|dec|oct)\s+)?param\s+(\S+)\s+(.*)$/i);
  if (!m) return null;
  const mode0 = (m[1]?.toLowerCase() as StepMode) || "lin";
  const name = m[2];
  const rest = m[3].trim();
  const d = defaultStepForm();
  const list = rest.match(/^list\s+(.*)$/i);
  if (list) return { ...d, name, mode: "list", list: list[1].trim() };
  const nums = rest.split(/[\s,]+/).map(parseSpiceNumber);
  if (nums.length < 3 || nums.some((x) => x == null)) return null;
  return { ...d, name, mode: mode0, start: nums[0]!, stop: nums[1]!, incr: nums[2]! };
}

interface Props {
  open: boolean;
  initial: StepForm;
  onApply: (directive: string) => void;
  onClose: () => void;
}

const MODE_LABEL: Record<StepMode, string> = {
  lin: "Linear (start, stop, increment)",
  dec: "Decade (log, points/decade)",
  oct: "Octave (log, points/octave)",
  list: "List (explicit values)",
};

/** Modal builder for a `.step` parameter sweep — no SPICE syntax to remember. */
export function StepDirectiveDialog({ open, initial, onApply, onClose }: Props) {
  const [f, setF] = useState<StepForm>(initial);

  useEffect(() => { if (open) setF(initial); }, [open, initial]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape" && open) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;
  const patch = (p: Partial<StepForm>) => setF((c) => ({ ...c, ...p }));
  const incrLabel = f.mode === "lin" ? "Increment" : f.mode === "dec" ? "Points per decade" : "Points per octave";

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 2100, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ background: "#1e293b", border: "1px solid #334155", borderRadius: 8, width: 420, maxWidth: "92vw", boxShadow: "0 25px 50px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #334155", background: "#0f172a" }}>
          <span style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 600 }}>Parameter Sweep (.step)</span>
          <button onClick={onClose} title="Close (Esc)" style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 20, lineHeight: 1, padding: "0 4px" }}>×</button>
        </div>

        <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label="Parameter name">
            <input value={f.name} onChange={(e) => patch({ name: e.target.value })} placeholder="e.g. R, Rvar, g" style={inputStyle} />
          </Field>
          <Field label="Sweep type">
            <select value={f.mode} onChange={(e) => patch({ mode: e.target.value as StepMode })} style={selectStyle}>
              {(Object.keys(MODE_LABEL) as StepMode[]).map((m) => <option key={m} value={m}>{MODE_LABEL[m]}</option>)}
            </select>
          </Field>

          {f.mode === "list" ? (
            <Field label="Values (space or comma separated)">
              <input value={f.list} onChange={(e) => patch({ list: e.target.value })} placeholder="10 25 40 100 1e9" style={inputStyle} />
            </Field>
          ) : (
            <>
              <NumField label="Start" value={f.start} onChange={(v) => patch({ start: v ?? 0 })} />
              <NumField label="Stop" value={f.stop} onChange={(v) => patch({ stop: v ?? 0 })} />
              <NumField label={incrLabel} value={f.incr} onChange={(v) => patch({ incr: v ?? 0 })} />
            </>
          )}

          <div style={{ fontSize: 11, color: "#64748b" }}>
            Directive:{" "}
            <code style={{ color: "#67e8f9", background: "#0f172a", padding: "2px 6px", borderRadius: 3 }}>{formatStepDirective(f)}</code>
          </div>
          <div style={{ fontSize: 10, color: "#64748b", lineHeight: 1.5 }}>
            Reference the parameter in a component value as <code style={{ color: "#93c5fd" }}>{`{${f.name.trim() || "X"}}`}</code>.
            Add a second <code style={{ color: "#93c5fd" }}>.step</code> for a nested sweep.
          </div>

          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
            <button onClick={onClose} style={{ padding: "6px 14px", border: "1px solid #475569", background: "transparent", color: "#94a3b8", borderRadius: 4, cursor: "pointer", fontSize: 12 }}>Cancel</button>
            <button onClick={() => onApply(formatStepDirective(f))} style={{ padding: "6px 16px", border: "none", background: "#2563eb", color: "#fff", borderRadius: 4, cursor: "pointer", fontWeight: 600, fontSize: 12 }}>OK</button>
          </div>
        </div>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", padding: "5px 8px", fontSize: 12,
  background: "#0f172a", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4,
};
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: "pointer" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12, color: "#cbd5e1" }}>
      {label}
      {children}
    </label>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: number | undefined) => void }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? (isFinite(value) ? formatSpiceNumber(value) : "");
  return (
    <Field label={label}>
      <input
        type="text"
        value={shown}
        onChange={(e) => {
          const s = e.target.value;
          setText(s);
          const n = parseSpiceNumber(s.trim());
          if (n !== undefined) onChange(n);
        }}
        onBlur={() => setText(null)}
        style={inputStyle}
      />
    </Field>
  );
}

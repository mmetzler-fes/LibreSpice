import { useState } from "react";
import { CATEGORIES, COMPONENT_DEFINITIONS, type ComponentDefinition } from "./componentDefinitions.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { useUIStore } from "@store/uiStore.js";
import { placementForEntry } from "./libraryPlacement.js";
import { SymbolPreview } from "./SymbolPreview.js";

interface ComponentPaletteProps {
  onDragStart: (def: ComponentDefinition, event: React.DragEvent) => void;
}

export function ComponentPalette({ onDragStart }: ComponentPaletteProps) {
  const [search, setSearch] = useState("");
  const [openCategory, setOpenCategory] = useState<string | null>("Passives");
  const { entries, removeEntry, setScope } = useLibraryStore();
  const { toggleLibraryImport, startPlacingLibrary, pendingLibraryPlacement } = useUIStore();

  const filtered = COMPONENT_DEFINITIONS.filter(
    (d) =>
      d.label.toLowerCase().includes(search.toLowerCase()) ||
      d.description.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <aside
      style={{
        width: 200,
        borderRight: "1px solid #e2e8f0",
        display: "flex",
        flexDirection: "column",
        background: "#fafafa",
        userSelect: "none",
      }}
    >
      <div style={{ padding: "8px" }}>
        <input
          type="text"
          placeholder="Search components..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            width: "100%",
            padding: "6px 8px",
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            fontSize: 12,
            boxSizing: "border-box",
          }}
        />
        <button
          onClick={toggleLibraryImport}
          title="Paste an LTSpice .model or .subckt"
          style={{
            width: "100%", marginTop: 6, padding: "6px 8px", fontSize: 12, fontWeight: 600,
            border: "1px solid #2563eb", borderRadius: 4, background: "#eff6ff", color: "#1d4ed8",
            cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
          }}
        >
          📥 Import LTSpice…
        </button>
      </div>
      <div style={{ overflowY: "auto", flex: 1 }}>
        {CATEGORIES.map((cat) => {
          const items = filtered.filter((d) => d.category === cat);
          if (items.length === 0) return null;
          const isOpen = search !== "" || openCategory === cat;
          return (
            <div key={cat}>
              <button
                onClick={() => setOpenCategory(isOpen ? null : cat)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "6px 12px",
                  background: "#e2e8f0",
                  border: "none",
                  borderBottom: "1px solid #cbd5e1",
                  cursor: "pointer",
                  fontWeight: 600,
                  fontSize: 12,
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                {cat}
                <span>{isOpen ? "▾" : "▸"}</span>
              </button>
              {isOpen &&
                items.map((def) => (
                  <div
                    key={def.type}
                    draggable
                    onDragStart={(e) => onDragStart(def, e)}
                    title={def.description}
                    style={{
                      padding: "6px 16px",
                      cursor: "grab",
                      fontSize: 12,
                      borderBottom: "1px solid #f1f5f9",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <SymbolPreview type={def.type} size={30} strokeWidth={1.1} />
                    <span style={{ fontFamily: "monospace", fontSize: 10, color: "#64748b", width: 14 }}>
                      {def.defaultLabel[0]}
                    </span>
                    {def.label}
                  </div>
                ))}
            </div>
          );
        })}

        {/* Imported LTSpice library */}
        {entries.length > 0 && (
          <div>
            <div style={{ padding: "6px 12px", background: "#e2e8f0", borderBottom: "1px solid #cbd5e1", fontWeight: 600, fontSize: 12 }}>
              Imported Library
            </div>
            {entries
              .filter((e) =>
                search === "" ||
                e.entry.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map(({ entry, scope }) => {
                const placement = placementForEntry(entry);
                const placeable = placement !== null;
                const active = pendingLibraryPlacement?.name === entry.name;
                return (
                  <div
                    key={entry.name}
                    title={placeable ? "Click to place, then click the canvas" : "No symbol – referenced in netlist only"}
                    onClick={() => placement && startPlacingLibrary(placement)}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      borderBottom: "1px solid #f1f5f9",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: placeable ? "pointer" : "default",
                      background: active ? "#dbeafe" : "transparent",
                      opacity: placeable ? 1 : 0.6,
                    }}
                  >
                    <span style={{ fontFamily: "monospace", fontSize: 9, color: "#64748b", width: 34, flexShrink: 0 }}>
                      {entry.kind === "subckt" ? "SUB" : entry.type}
                    </span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.name}
                    </span>
                    <span
                      onClick={(ev) => { ev.stopPropagation(); setScope(entry.name, scope === "local" ? "temp" : "local"); }}
                      title={scope === "local" ? "Local (click → Temp)" : "Temp (click → Local)"}
                      style={{
                        fontSize: 9, padding: "1px 4px", borderRadius: 3, cursor: "pointer", flexShrink: 0,
                        background: scope === "local" ? "#dcfce7" : "#fef9c3",
                        color: scope === "local" ? "#166534" : "#854d0e",
                      }}
                    >
                      {scope === "local" ? "LOCAL" : "TEMP"}
                    </span>
                    <span
                      onClick={(ev) => { ev.stopPropagation(); removeEntry(entry.name); }}
                      title="Remove"
                      style={{ color: "#94a3b8", cursor: "pointer", fontSize: 14, flexShrink: 0 }}
                    >×</span>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </aside>
  );
}

import { useState } from "react";
import { CATEGORIES, COMPONENT_DEFINITIONS, type ComponentDefinition } from "./componentDefinitions.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { placementForEntry } from "./libraryPlacement.js";
import { SymbolPreview } from "./SymbolPreview.js";

interface ComponentPaletteProps {
  onDragStart: (def: ComponentDefinition, event: React.DragEvent) => void;
}

export function ComponentPalette({ onDragStart }: ComponentPaletteProps) {
  const [search, setSearch] = useState("");
  const [openCategory, setOpenCategory] = useState<string | null>("Passives");
  const { entries, removeEntry, setScope } = useLibraryStore();
  const { toggleLibraryImport, startPlacing, startPlacingLibrary, pendingPlaceType, pendingLibraryPlacement } = useUIStore();
  const pal = useTheme();

  const filtered = COMPONENT_DEFINITIONS.filter(
    (d) =>
      d.label.toLowerCase().includes(search.toLowerCase()) ||
      d.description.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <aside
      style={{
        width: 200,
        borderRight: `1px solid ${pal.borderMuted}`,
        display: "flex",
        flexDirection: "column",
        background: pal.panelBg,
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
            border: `1px solid ${pal.border}`,
            borderRadius: 4,
            fontSize: 12,
            boxSizing: "border-box",
            background: pal.inputBg,
            color: pal.text,
          }}
        />
        <button
          onClick={toggleLibraryImport}
          title="Paste an LTSpice .model or .subckt"
          style={{
            width: "100%", marginTop: 6, padding: "6px 8px", fontSize: 12, fontWeight: 600,
            border: `1px solid ${pal.accent}`, borderRadius: 4, background: pal.importBg, color: pal.importText,
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
                  background: pal.categoryBg,
                  color: "inherit",
                  border: "none",
                  borderBottom: `1px solid ${pal.border}`,
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
                    onClick={() => startPlacing(def.type)}
                    title={`${def.description} — click to place, or drag onto the canvas`}
                    style={{
                      padding: "6px 16px",
                      cursor: "grab",
                      fontSize: 12,
                      borderBottom: `1px solid ${pal.rowBorder}`,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: pendingPlaceType === def.type ? pal.itemActive : "transparent",
                    }}
                  >
                    <SymbolPreview type={def.type} size={30} strokeWidth={1.1} color={pal.symPreview} />
                    <span style={{ fontFamily: "monospace", fontSize: 10, color: pal.textMuted, width: 14 }}>
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
            <div style={{ padding: "6px 12px", background: pal.categoryBg, borderBottom: `1px solid ${pal.border}`, fontWeight: 600, fontSize: 12 }}>
              Imported Library
            </div>
            {entries
              .filter((e) =>
                search === "" ||
                `${e.entry.name} ${e.entry.label ?? ""} ${e.entry.description ?? ""}`
                  .toLowerCase().includes(search.toLowerCase()),
              )
              .map(({ entry, scope }) => {
                const placement = placementForEntry(entry);
                const placeable = placement !== null;
                const active = pendingLibraryPlacement?.name === entry.name;
                // A SPICE name is not always a part name (`level2` is LTSpice's
                // universal op-amp), so a `.lib` may give one — see
                // EntryAnnotations. The SPICE name still rides along on the row,
                // because that is what the netlist and the `.asc` will say.
                const hint = [
                  entry.label ? `${entry.label} (${entry.name})` : entry.name,
                  entry.description,
                  placeable ? "Anklicken, dann auf die Zeichenfläche klicken" : "Kein Symbol – nur im Netzlisten-Verweis",
                ].filter(Boolean).join("\n");
                return (
                  <div
                    key={entry.name}
                    title={hint}
                    onClick={() => placement && startPlacingLibrary(placement)}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      borderBottom: `1px solid ${pal.rowBorder}`,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: placeable ? "pointer" : "default",
                      background: active ? pal.itemActive : "transparent",
                      opacity: placeable ? 1 : 0.6,
                    }}
                  >
                    <span style={{ fontFamily: "monospace", fontSize: 9, color: pal.textMuted, width: 34, flexShrink: 0 }}>
                      {entry.kind === "subckt" ? "SUB" : entry.type}
                    </span>
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.label ?? entry.name}
                      {entry.label && (
                        // The name the netlist will use, kept in sight: a part
                        // is looked up by it in an error message from ngspice.
                        <span style={{ fontFamily: "monospace", fontSize: 9, color: pal.textMuted, marginLeft: 5 }}>
                          {entry.name}
                        </span>
                      )}
                    </span>
                    <span
                      onClick={(ev) => { ev.stopPropagation(); setScope(entry.name, scope === "local" ? "temp" : "local"); }}
                      title={scope === "local" ? "Local (click → Temp)" : "Temp (click → Local)"}
                      style={{
                        fontSize: 9, padding: "1px 4px", borderRadius: 3, cursor: "pointer", flexShrink: 0,
                        background: scope === "local" ? pal.localBg : pal.tempBg,
                        color: scope === "local" ? pal.localText : pal.tempText,
                      }}
                    >
                      {scope === "local" ? "LOCAL" : "TEMP"}
                    </span>
                    <span
                      onClick={(ev) => { ev.stopPropagation(); removeEntry(entry.name); }}
                      title="Remove"
                      style={{ color: pal.textMuted, cursor: "pointer", fontSize: 14, flexShrink: 0 }}
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

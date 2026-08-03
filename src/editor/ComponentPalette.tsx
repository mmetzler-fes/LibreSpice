import { useState } from "react";
import { CATEGORIES, COMPONENT_DEFINITIONS, type ComponentDefinition } from "./componentDefinitions.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { useUIStore } from "@store/uiStore.js";
import { useTheme } from "../theme.js";
import { placementForEntry } from "./libraryPlacement.js";
import { SymbolPreview } from "./SymbolPreview.js";
import { SCOPE_BADGE, SCOPE_HINT, scopeStyle } from "./libraryScope.js";

interface ComponentPaletteProps {
  onDragStart: (def: ComponentDefinition, event: React.DragEvent) => void;
}

export function ComponentPalette({ onDragStart }: ComponentPaletteProps) {
  const [search, setSearch] = useState("");
  const [openCategory, setOpenCategory] = useState<string | null>("Passives");
  const { removeEntry, setScope, listEntries } = useLibraryStore();
  const { toggleLibraryImport, startPlacing, startPlacingLibrary, pendingPlaceType, pendingLibraryPlacement } = useUIStore();
  const pal = useTheme();

  // The imports and whatever a backend serves, plus the curated defaults behind
  // them (see libraryStore.listEntries) — so the list is the same list whether
  // or not this deployment has a library folder of its own. Recomputed on every
  // render rather than memoised: the defaults are static and `entries` is short,
  // so the merge costs less than tracking when it needs redoing.
  const libraryList = listEntries();

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

        {/* The library: curated defaults, what a backend serves, own imports */}
        {libraryList.length > 0 && (
          <div>
            <div style={{ padding: "6px 12px", background: pal.categoryBg, borderBottom: `1px solid ${pal.border}`, fontWeight: 600, fontSize: 12 }}>
              Library
            </div>
            {libraryList
              .filter((e) =>
                search === "" ||
                `${e.entry.name} ${e.entry.label ?? ""} ${e.entry.description ?? ""}`
                  .toLowerCase().includes(search.toLowerCase()),
              )
              .map(({ entry, scope }) => {
                const placement = placementForEntry(entry);
                const placeable = placement !== null;
                const active = pendingLibraryPlacement?.name === entry.name;
                // The user's own import, as opposed to something the app or the
                // backend brought: only those can be moved or removed here.
                const own = scope === "local" || scope === "temp";
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
                      // Only the user's own two scopes can be flipped. A served
                      // or bundled part is not this browser's to move — the
                      // badge read TEMP for all three before, and clicking it
                      // offered to copy a server part into localStorage.
                      onClick={(ev) => {
                        ev.stopPropagation();
                        if (own) setScope(entry.name, scope === "local" ? "temp" : "local");
                      }}
                      title={SCOPE_HINT[scope]}
                      style={{
                        fontSize: 9, padding: "1px 4px", borderRadius: 3, flexShrink: 0,
                        cursor: own ? "pointer" : "default",
                        ...scopeStyle(pal, scope),
                      }}
                    >
                      {SCOPE_BADGE[scope]}
                    </span>
                    {/* Removable only where removing means something: a default
                        comes back on the next load, and a served part lives in
                        the backend's folder, not here. */}
                    {own ? (
                      <span
                        onClick={(ev) => { ev.stopPropagation(); removeEntry(entry.name); }}
                        title="Entfernen"
                        style={{ color: pal.textMuted, cursor: "pointer", fontSize: 14, flexShrink: 0 }}
                      >×</span>
                    ) : (
                      <span style={{ width: 8, flexShrink: 0 }} />
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </aside>
  );
}

import { useEffect, useMemo, useState } from "react";
import { useUIStore } from "@store/uiStore.js";
import { useLibraryStore } from "@store/libraryStore.js";
import { COMPONENT_DEFINITIONS } from "./componentDefinitions.js";
import { placementForEntry, placementForDescriptor } from "./libraryPlacement.js";
import { SymbolPreview } from "./SymbolPreview.js";
import type { PendingLibraryPlacement } from "@store/uiStore.js";

/**
 * Unified "Insert Component" picker (LTSpice-style): lists the built-in standard
 * parts, imported library entries, and file-backed server `cmp` descriptors.
 * Clicking an item starts the click-to-place flow and closes the dialog.
 */
export function InsertComponentModal() {
  const { showInsertComponent, toggleInsertComponent, startPlacing, startPlacingLibrary } = useUIStore();
  const { entries, descriptors, findByName } = useLibraryStore();
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (showInsertComponent) setSearch("");
  }, [showInsertComponent]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && showInsertComponent) toggleInsertComponent();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [showInsertComponent, toggleInsertComponent]);

  const q = search.trim().toLowerCase();

  const standard = useMemo(
    () => COMPONENT_DEFINITIONS.filter((d) => q === "" || d.label.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)),
    [q],
  );

  // Server descriptors first, then imported entries. Descriptors already carry a
  // resolvable placement; entries fall back to placementForEntry.
  const libraryItems = useMemo(() => {
    const find = (name: string) => findByName(name)?.entry;
    const items: { key: string; name: string; badge: string; source: string; placement: PendingLibraryPlacement | null }[] = [];
    for (const d of descriptors) {
      if (q !== "" && !d.name.toLowerCase().includes(q)) continue;
      items.push({ key: `cmp:${d.name}`, name: d.name, badge: d.prefix ?? "X", source: "server", placement: placementForDescriptor(d, find) });
    }
    const seen = new Set(descriptors.map((d) => `${d.model ?? d.name}`.toLowerCase()));
    for (const { entry, scope } of entries) {
      if (q !== "" && !entry.name.toLowerCase().includes(q)) continue;
      if (seen.has(entry.name.toLowerCase())) continue; // already shown via its descriptor
      items.push({
        key: `entry:${entry.name}`,
        name: entry.name,
        badge: entry.kind === "subckt" ? "SUB" : entry.type,
        source: scope,
        placement: placementForEntry(entry),
      });
    }
    return items;
  }, [descriptors, entries, q, findByName]);

  if (!showInsertComponent) return null;

  const place = (p: PendingLibraryPlacement | null) => {
    if (!p) return;
    startPlacingLibrary(p);
    toggleInsertComponent();
  };

  const rowStyle = (placeable: boolean, active = false): React.CSSProperties => ({
    padding: "7px 12px", fontSize: 12, borderBottom: "1px solid #f1f5f9",
    display: "flex", alignItems: "center", gap: 8,
    cursor: placeable ? "pointer" : "default", opacity: placeable ? 1 : 0.5,
    background: active ? "#dbeafe" : "transparent",
  });

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) toggleInsertComponent(); }}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 2000, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ background: "#fff", borderRadius: 8, width: 520, maxWidth: "92vw", maxHeight: "82vh", boxShadow: "0 25px 50px rgba(0,0,0,0.5)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#0f172a" }}>➕ Insert Component</span>
          <button onClick={toggleInsertComponent} title="Close (Esc)" style={{ background: "none", border: "none", color: "#64748b", cursor: "pointer", fontSize: 20, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: "10px 16px", borderBottom: "1px solid #e2e8f0" }}>
          <input
            autoFocus
            type="text"
            placeholder="Search components…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: "100%", padding: "7px 10px", border: "1px solid #cbd5e1", borderRadius: 4, fontSize: 13, boxSizing: "border-box" }}
          />
        </div>

        <div style={{ overflowY: "auto", flex: 1 }}>
          {/* Standard parts */}
          {standard.length > 0 && (
            <>
              <div style={{ padding: "5px 12px", background: "#f1f5f9", fontWeight: 600, fontSize: 11, color: "#475569" }}>Standard</div>
              {standard.map((def) => (
                <div key={def.type} onClick={() => { startPlacing(def.type); toggleInsertComponent(); }} title={def.description} style={rowStyle(true)}>
                  <SymbolPreview type={def.type} size={28} strokeWidth={1.1} />
                  <span style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8", width: 16 }}>{def.defaultLabel[0]}</span>
                  <span style={{ flex: 1 }}>{def.label}</span>
                </div>
              ))}
            </>
          )}

          {/* Library (server + imported) */}
          {libraryItems.length > 0 && (
            <>
              <div style={{ padding: "5px 12px", background: "#f1f5f9", fontWeight: 600, fontSize: 11, color: "#475569" }}>Library</div>
              {libraryItems.map((it) => {
                const placeable = it.placement !== null;
                return (
                  <div key={it.key} onClick={() => place(it.placement)} title={placeable ? "Click, then click the canvas to place" : "No placeable symbol — referenced in netlist only"} style={rowStyle(placeable)}>
                    <span style={{ fontFamily: "monospace", fontSize: 9, color: "#64748b", width: 34, flexShrink: 0 }}>{it.badge}</span>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.name}</span>
                    <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 3, flexShrink: 0, background: it.source === "server" ? "#e0e7ff" : it.source === "local" ? "#dcfce7" : "#fef9c3", color: it.source === "server" ? "#3730a3" : it.source === "local" ? "#166534" : "#854d0e" }}>
                      {it.source.toUpperCase()}
                    </span>
                  </div>
                );
              })}
            </>
          )}

          {standard.length === 0 && libraryItems.length === 0 && (
            <div style={{ padding: 20, textAlign: "center", color: "#94a3b8", fontSize: 12 }}>No components match “{search}”.</div>
          )}
        </div>
      </div>
    </div>
  );
}

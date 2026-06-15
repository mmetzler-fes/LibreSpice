import { useState } from "react";
import { CATEGORIES, COMPONENT_DEFINITIONS, type ComponentDefinition } from "./componentDefinitions.js";

interface ComponentPaletteProps {
  onDragStart: (def: ComponentDefinition, event: React.DragEvent) => void;
}

export function ComponentPalette({ onDragStart }: ComponentPaletteProps) {
  const [search, setSearch] = useState("");
  const [openCategory, setOpenCategory] = useState<string | null>("Passives");

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
                    <span style={{ fontFamily: "monospace", fontSize: 10, color: "#64748b", width: 24 }}>
                      {def.defaultLabel[0]}
                    </span>
                    {def.label}
                  </div>
                ))}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

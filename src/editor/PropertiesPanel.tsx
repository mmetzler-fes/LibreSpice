import { useCircuitStore } from "@store/circuitStore.js";

export function PropertiesPanel() {
  // propertyVersion triggers a re-render whenever setProperty is called on any component
  const { circuit, selectedComponentId, updateComponentProperty, propertyVersion } = useCircuitStore();
  void propertyVersion; // consumed only for reactivity

  const component = selectedComponentId ? circuit.components.get(selectedComponentId) : null;

  if (!component) {
    return (
      <aside
        style={{
          width: 220,
          borderLeft: "1px solid #e2e8f0",
          padding: 16,
          background: "#fafafa",
          fontSize: 12,
          color: "#94a3b8",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        Select a component to edit its properties
      </aside>
    );
  }

  const properties = component.getProperties();

  return (
    <aside
      style={{
        width: 220,
        borderLeft: "1px solid #e2e8f0",
        padding: 16,
        background: "#fafafa",
        overflowY: "auto",
        fontSize: 12,
      }}
    >
      <h3 style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600 }}>
        Properties — {component.label}
      </h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {properties.map((prop) => (
          <label key={prop.key} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            <span style={{ color: "#64748b", fontWeight: 500 }}>
              {prop.label}
              {prop.unit && <span style={{ color: "#94a3b8" }}> ({prop.unit})</span>}
            </span>
            {prop.type === "select" && prop.options ? (
              <select
                value={String(prop.value)}
                onChange={(e) => updateComponentProperty(component.id, prop.key, e.target.value)}
                style={{ padding: "4px 6px", border: "1px solid #cbd5e1", borderRadius: 4 }}
              >
                {prop.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            ) : (
              <input
                type={prop.type === "number" ? "number" : "text"}
                value={String(prop.value)}
                onChange={(e) =>
                  updateComponentProperty(
                    component.id,
                    prop.key,
                    prop.type === "number" ? parseFloat(e.target.value) || 0 : e.target.value,
                  )
                }
                style={{
                  padding: "4px 6px",
                  border: "1px solid #cbd5e1",
                  borderRadius: 4,
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
            )}
          </label>
        ))}
      </div>
    </aside>
  );
}

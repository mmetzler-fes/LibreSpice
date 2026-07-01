import { useEffect, useRef } from "react";
import { useCircuitStore } from "@store/circuitStore.js";
import { saveToLocalStorage } from "@store/persistence.js";

const DEBOUNCE_MS = 1000;

export function useAutosave() {
  const exportSnapshot = useCircuitStore((s) => s.exportSnapshot);
  const nodes = useCircuitStore((s) => s.nodes);
  const edges = useCircuitStore((s) => s.edges);
  const spiceDirectives = useCircuitStore((s) => s.spiceDirectives);
  const simulationConfig = useCircuitStore((s) => s.simulationConfig);
  const propertyVersion = useCircuitStore((s) => s.propertyVersion);
  const netVersion = useCircuitStore((s) => s.netVersion);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      saveToLocalStorage(exportSnapshot());
    }, DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [nodes, edges, spiceDirectives, simulationConfig, propertyVersion, netVersion, exportSnapshot]);
}

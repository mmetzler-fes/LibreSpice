import { useCircuitStore } from "@store/circuitStore.js";
import { encodeSnapshotCompressed } from "@store/persistence.js";

/** Let the store's deferred rebuilds (scheduled via setTimeout) settle. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Turn an LTSpice `.asc` into the compressed share payload the app opens from a
 * `#z=…` link — exactly the pipeline the running app uses (loadFromAsc →
 * exportSnapshot → encodeSnapshotCompressed), so a baked link and one the app
 * would produce are byte-for-byte the same.
 */
export async function bakeAsc(asc: string, name: string): Promise<string> {
  const st = useCircuitStore.getState();
  st.loadFromAsc(asc);
  await tick();
  st.rebuildConnections();
  await tick();
  // Give the opened circuit the example's title instead of "Untitled".
  st.setCircuitName(name);
  return encodeSnapshotCompressed(st.exportSnapshot());
}

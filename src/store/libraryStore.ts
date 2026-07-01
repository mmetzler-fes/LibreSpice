import { create } from "zustand";
import type { LibraryEntry, LibraryScope } from "@core/library/types.js";

/**
 * Holds imported LTSpice models/subcircuits, mirroring CircuitSim's "Add to
 * Local" vs "Use Temp" split:
 *   - `local` entries persist to localStorage and survive reloads.
 *   - `temp`  entries live only for the current session.
 */
const STORAGE_KEY = "librespice.localLibrary.v1";

export interface StoredEntry {
  entry: LibraryEntry;
  scope: LibraryScope;
}

interface LibraryState {
  entries: StoredEntry[];
}

interface LibraryActions {
  /** Adds entries under the given scope, replacing any with the same name. */
  addEntries: (entries: LibraryEntry[], scope: LibraryScope) => void;
  removeEntry: (name: string) => void;
  /** Moves an existing entry to a different scope (e.g. promote Temp → Local). */
  setScope: (name: string, scope: LibraryScope) => void;
  clearTemp: () => void;
  /** Concatenated raw SPICE text of every registered model/subckt definition. */
  getDefinitionsText: () => string;
  findByName: (name: string) => StoredEntry | undefined;
}

function loadLocal(): StoredEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LibraryEntry[];
    return parsed.map((entry) => ({ entry, scope: "local" as LibraryScope }));
  } catch {
    return [];
  }
}

function persistLocal(entries: StoredEntry[]): void {
  try {
    const local = entries.filter((e) => e.scope === "local").map((e) => e.entry);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(local));
  } catch {
    /* storage may be unavailable (private mode, quota) – non-fatal */
  }
}

export const useLibraryStore = create<LibraryState & LibraryActions>((set, get) => ({
  entries: typeof localStorage !== "undefined" ? loadLocal() : [],

  addEntries: (newEntries, scope) => {
    const names = new Set(newEntries.map((e) => e.name.toLowerCase()));
    const merged = [
      ...get().entries.filter((e) => !names.has(e.entry.name.toLowerCase())),
      ...newEntries.map((entry) => ({ entry, scope })),
    ];
    persistLocal(merged);
    set({ entries: merged });
  },

  removeEntry: (name) => {
    const merged = get().entries.filter((e) => e.entry.name.toLowerCase() !== name.toLowerCase());
    persistLocal(merged);
    set({ entries: merged });
  },

  setScope: (name, scope) => {
    const merged = get().entries.map((e) =>
      e.entry.name.toLowerCase() === name.toLowerCase() ? { ...e, scope } : e,
    );
    persistLocal(merged);
    set({ entries: merged });
  },

  clearTemp: () => {
    const merged = get().entries.filter((e) => e.scope !== "temp");
    set({ entries: merged });
  },

  getDefinitionsText: () =>
    get()
      .entries.map((e) => e.entry.raw)
      .join("\n"),

  findByName: (name) => get().entries.find((e) => e.entry.name.toLowerCase() === name.toLowerCase()),
}));

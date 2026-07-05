import { create } from "zustand";
import type { ComponentDescriptor, LibraryEntry, LibraryScope } from "@core/library/types.js";
import { ModelParser } from "@core/library/ModelParser.js";
import { registerSymbol } from "@sym/asyParser.js";

/**
 * Holds imported LTSpice models/subcircuits, mirroring CircuitSim's "Add to
 * Local" vs "Use Temp" split, plus a third `server` scope:
 *   - `local`  entries persist to localStorage and survive reloads.
 *   - `temp`   entries live only for the current session.
 *   - `server` entries come from the file-backed library served by the backend
 *              (Docker volume). They are re-fetched on load and, unlike the
 *              other two, are shared across users of the same instance.
 */
const STORAGE_KEY = "librespice.localLibrary.v1";

/** Payload for persisting an imported entry into the server library. */
export interface SaveEntryPayload {
  name: string;
  /** `.model` / `.subckt` SPICE text → `sub/<name>.lib`. */
  modelText?: string;
  /** `.asy` symbol source → `sym/<symbol>.asy`. */
  asyText?: string;
  /** Descriptor written to `cmp/<name>.json`. */
  descriptor?: Omit<ComponentDescriptor, "name">;
}

export interface StoredEntry {
  entry: LibraryEntry;
  scope: LibraryScope;
}

interface LibraryState {
  entries: StoredEntry[];
  /** Placeable descriptors from the server `cmp/` folder. */
  descriptors: ComponentDescriptor[];
  /** Whether the backend library API responded (enables "save to server"). */
  serverAvailable: boolean;
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
  /** Fetches the file-backed library from the backend and merges it in. */
  fetchServerLibrary: () => Promise<void>;
  /** Persists an entry to the server library; returns true on success. */
  saveEntry: (payload: SaveEntryPayload) => Promise<boolean>;
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
  descriptors: [],
  serverAvailable: false,

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

  fetchServerLibrary: async () => {
    let data: { models?: string[]; symbols?: { name: string; raw: string }[]; components?: ComponentDescriptor[] };
    try {
      const res = await fetch("/api/library");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch {
      // No backend (static hosting / dev without server) – silently degrade.
      set({ serverAvailable: false });
      return;
    }

    // Register symbols so library components can render their own graphics.
    for (const sym of data.symbols ?? []) {
      try {
        registerSymbol(sym.name, sym.raw);
      } catch {
        /* skip a malformed .asy without failing the whole load */
      }
    }

    // Parse model/subckt files into entries under the `server` scope.
    const serverEntries: StoredEntry[] = [];
    for (const text of data.models ?? []) {
      for (const entry of ModelParser.parse(text).entries) {
        serverEntries.push({ entry, scope: "server" });
      }
    }
    const serverNames = new Set(serverEntries.map((e) => e.entry.name.toLowerCase()));

    // Replace any previous server entries; keep local/temp untouched.
    const merged = [
      ...get().entries.filter((e) => e.scope !== "server" && !serverNames.has(e.entry.name.toLowerCase())),
      ...serverEntries,
    ];

    set({
      entries: merged,
      descriptors: data.components ?? [],
      serverAvailable: true,
    });
  },

  saveEntry: async (payload) => {
    try {
      const res = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      return false;
    }
    // Re-read so entries, descriptors and symbols reflect what's on disk.
    await get().fetchServerLibrary();
    return true;
  },
}));

// Kick off the initial server fetch once, at module load (browser only).
if (typeof window !== "undefined") {
  void useLibraryStore.getState().fetchServerLibrary();
}

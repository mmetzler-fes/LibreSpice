import { create } from "zustand";
import type { ComponentDescriptor, LibraryEntry, LibraryScope } from "@core/library/types.js";
import { ModelParser } from "@core/library/ModelParser.js";
import { bundledEntries } from "@core/library/bundledLibrary.js";
import { registerSymbol } from "@sym/asyParser.js";

/** Library API endpoint, relative to the app's base path so it works under a
 *  subpath deployment (e.g. /librespice/app/) as well as at the root. */
const API_LIBRARY = `${import.meta.env.BASE_URL}api/library`;

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
  /**
   * Every model/subckt definition as a named block, so the netlist generator can
   * emit only the ones actually referenced (a curated library can hold far more
   * than any single circuit uses).
   */
  getDefinitionBlocks: () => { name: string; raw: string }[];
  findByName: (name: string) => StoredEntry | undefined;
  /** Every part the parts list should show: imported/served plus the defaults. */
  listEntries: () => StoredEntry[];
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
      .getDefinitionBlocks()
      .map((b) => b.raw)
      .join("\n"),

  // The imported entries plus every curated default no import shadows. The
  // defaults come last in precedence and are filtered by name, so a `seg7hex`
  // dropped into the served library replaces the bundled one rather than being
  // emitted beside it — two `.subckt` blocks of the same name is a redefinition
  // ngspice would take the last of.
  getDefinitionBlocks: () => {
    const claimed = new Set(get().entries.map((e) => e.entry.name.toLowerCase()));
    return [
      ...get().entries.map((e) => ({ name: e.entry.name, raw: e.entry.raw })),
      ...bundledEntries()
        .filter((e) => !claimed.has(e.name.toLowerCase()))
        .map((e) => ({ name: e.name, raw: e.raw })),
    ];
  },

  // Falls back to the curated defaults, under the `temp` scope: they are not
  // the user's import and must never be written to localStorage, but every
  // caller of this asks the same question — "is there a part by this name" —
  // and for a shipped example the answer has to be yes with or without a
  // backend (see bundledLibrary).
  /**
   * The parts list, and the same list on every deployment.
   *
   * The curated defaults are compiled into the app but were not shown anywhere:
   * the list held only what had been imported or what a backend served. Run with
   * the repo's `library/` mounted and every default appeared (as a *served*
   * part); run the image against a volume seeded before those parts existed, and
   * the same app showed almost nothing — while quietly resolving every one of
   * them by name, because `findByName` and `getDefinitionBlocks` always did
   * consult them. So the schematics worked and the parts could not be placed,
   * which reads as a broken installation rather than an invisible floor.
   *
   * Shadowing follows the same rule as the netlist (see getDefinitionBlocks): a
   * `local`/`temp`/`server` entry of the same name wins, and the default behind
   * it is not listed a second time.
   */
  listEntries: () => {
    const claimed = new Set(get().entries.map((e) => e.entry.name.toLowerCase()));
    return [
      ...get().entries,
      ...bundledEntries()
        .filter((e) => !claimed.has(e.name.toLowerCase()))
        .map((entry) => ({ entry, scope: "bundled" as LibraryScope })),
    ];
  },

  findByName: (name) => {
    const own = get().entries.find((e) => e.entry.name.toLowerCase() === name.toLowerCase());
    if (own) return own;
    const bundled = bundledEntries().find((e) => e.name.toLowerCase() === name.toLowerCase());
    return bundled ? { entry: bundled, scope: "temp" as LibraryScope } : undefined;
  },

  fetchServerLibrary: async () => {
    let data: { models?: string[]; symbols?: { name: string; raw: string }[]; components?: ComponentDescriptor[] };
    try {
      const res = await fetch(API_LIBRARY);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch {
      // No backend (static hosting / dev without server) – silently degrade.
      set({ serverAvailable: false });
      return;
    }

    // Register symbols so library components can render their own graphics.
    // Keep the parsed symbols around to auto-derive placeable descriptors below.
    const parsedSymbols: { name: string; sym: ReturnType<typeof registerSymbol> }[] = [];
    for (const s of data.symbols ?? []) {
      try {
        parsedSymbols.push({ name: s.name, sym: registerSymbol(s.name, s.raw) });
      } catch {
        /* skip a malformed .asy without failing the whole load */
      }
    }

    // Parse model/subckt files into entries under the `server` scope. Per file,
    // like the symbols above: without this a single unparsable drop-in would
    // throw out of the whole load, leaving the library empty — and an empty
    // library is not a quiet degradation. Every op-amp then fails with "unknown
    // subckt: level2", which reads as a broken circuit, not a missing file.
    const serverEntries: StoredEntry[] = [];
    for (const text of data.models ?? []) {
      try {
        for (const entry of ModelParser.parse(text).entries) {
          serverEntries.push({ entry, scope: "server" });
        }
      } catch {
        /* skip a malformed model file without failing the whole load */
      }
    }
    const serverNames = new Set(serverEntries.map((e) => e.entry.name.toLowerCase()));

    // Replace any previous server entries; keep local/temp untouched.
    const merged = [
      ...get().entries.filter((e) => e.scope !== "server" && !serverNames.has(e.entry.name.toLowerCase())),
      ...serverEntries,
    ];

    // Auto-derive a placeable descriptor from each symbol that declares a SPICE
    // prefix + pins and references a model/subckt we actually have. This makes a
    // dropped-in `.asy` (plus its `.lib`) usable without hand-writing cmp JSON.
    const available = new Set(merged.map((e) => e.entry.name.toLowerCase()));
    const explicit = new Set((data.components ?? []).map((d) => d.name.toLowerCase()));
    const autoDescriptors: ComponentDescriptor[] = [];
    for (const { name, sym } of parsedSymbols) {
      if (explicit.has(name.toLowerCase()) || sym.pins.length === 0) continue;
      const prefix = sym.attrs["Prefix"];
      const model = sym.attrs["SpiceModel"] || sym.attrs["Value"] || sym.attrs["Value2"];
      if (!prefix || !model || !available.has(model.toLowerCase())) continue;
      const pins = [...sym.pins].sort((a, b) => a.order - b.order).map((p) => p.name);
      const params = [sym.attrs["SpiceLine"], sym.attrs["SpiceLine2"]].filter(Boolean).join(" ").trim();
      autoDescriptors.push({ name, symbol: name, prefix, model, pins, ...(params ? { params } : {}) });
    }

    set({
      entries: merged,
      descriptors: [...(data.components ?? []), ...autoDescriptors],
      serverAvailable: true,
    });
  },

  saveEntry: async (payload) => {
    try {
      const res = await fetch(API_LIBRARY, {
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

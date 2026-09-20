import { create } from "zustand";
import { decodeSignalFile, signalFileKey, signalFileName, type Signal } from "@core/audio/signalFile.js";

/**
 * The files a circuit reads and writes: the input of a `wavefile=` / `PWL file=`
 * source, and what a `.wave` directive produced on the last run.
 *
 * A browser cannot open `Lied1mono.wav` next to the `.asc` by name the way
 * LTSpice does, so an input file is loaded once — by hand, or found in the
 * folder a schematic was opened from — and kept in IndexedDB under its file
 * name. It is deliberately not part of the circuit snapshot: a million samples
 * do not belong in a share link or the autosave.
 *
 * Outputs are not persisted: they are a product of the run and are rebuilt by
 * the next one.
 */

export interface InputFile {
  name: string;
  bytes: Uint8Array;
  signal: Signal | null;
  error: string | null;
}

export interface OutputFile {
  name: string;
  /** Samples at `sampleRate`, as simulated (not clipped); for playback. */
  samples: Float32Array;
  sampleRate: number;
  /** The file as written: WAV bytes or text. */
  bytes: Uint8Array;
  mime: string;
}

interface SourceFileState {
  inputs: Record<string, InputFile>;
  outputs: Record<string, OutputFile>;
  addInput: (name: string, bytes: Uint8Array) => InputFile;
  /** The decoded signal for a file name (any path; matched by base name). */
  signalFor: (path: string) => Signal | null;
  setOutputs: (outputs: OutputFile[]) => void;
  clearOutputs: () => void;
}

const DB_NAME = "librespice-files";
const STORE = "inputs";

function openDb(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === "undefined") return null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function persist(key: string, name: string, bytes: Uint8Array): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ name, bytes }, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (e) {
    // A private window or a full quota: the file still works for this session.
    console.warn("Datei konnte nicht dauerhaft gespeichert werden", e);
  }
}

function decode(name: string, bytes: Uint8Array): InputFile {
  try {
    return { name, bytes, signal: decodeSignalFile(name, bytes), error: null };
  } catch (e) {
    return { name, bytes, signal: null, error: e instanceof Error ? e.message : String(e) };
  }
}

export const useSourceFileStore = create<SourceFileState>((set, get) => ({
  inputs: {},
  outputs: {},

  addInput: (path, bytes) => {
    const name = signalFileName(path);
    const file = decode(name, bytes);
    set((s) => ({ inputs: { ...s.inputs, [signalFileKey(name)]: file } }));
    if (!file.error) void persist(signalFileKey(name), name, bytes);
    return file;
  },

  signalFor: (path) => get().inputs[signalFileKey(path)]?.signal ?? null,

  setOutputs: (list) => set({ outputs: Object.fromEntries(list.map((o) => [signalFileKey(o.name), o])) }),
  clearOutputs: () => set({ outputs: {} }),
}));

let hydration: Promise<void> | null = null;

/**
 * Load the files kept from earlier sessions. Called once at start-up, and
 * awaited by anything that would otherwise load a file the user already has:
 * the promise is kept, so a second caller waits on the same read instead of
 * starting another one.
 */
export function hydrateSourceFiles(): Promise<void> {
  hydration ??= readStoredFiles();
  return hydration;
}

async function readStoredFiles(): Promise<void> {
  try {
    const db = await openDb();
    if (!db) return;
    const rows = await new Promise<{ key: string; value: { name: string; bytes: Uint8Array } }[]>((resolve, reject) => {
      const out: { key: string; value: { name: string; bytes: Uint8Array } }[] = [];
      const req = db.transaction(STORE, "readonly").objectStore(STORE).openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) { resolve(out); return; }
        out.push({ key: String(cur.key), value: cur.value });
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
    db.close();
    const inputs = { ...useSourceFileStore.getState().inputs };
    for (const { key, value } of rows) {
      // A file loaded in this session before hydration finished wins.
      if (!inputs[key]) inputs[key] = decode(value.name, new Uint8Array(value.bytes));
    }
    useSourceFileStore.setState({ inputs });
  } catch (e) {
    console.warn("Gespeicherte Dateien konnten nicht geladen werden", e);
  }
}

import { decodeSignalFile, signalFileName } from "@core/audio/signalFile.js";
import { useCircuitStore } from "./circuitStore.js";
import { hydrateSourceFiles, useSourceFileStore } from "./sourceFileStore.js";

/**
 * The sample files shipped with the app, fetched for a circuit that names one.
 *
 * A share link carries the schematic, not the song: a `wavefile=` source names
 * `Hanuman_Sample.wav` and a browser has no folder to look in, so a demo link
 * used to open on a circuit that could not run until someone found the file on
 * disk and loaded it by hand. The files the published examples read are
 * therefore served next to the app, under `<base>/samples/`, and fetched by
 * name whenever a loaded circuit names one that is not in the store yet.
 *
 * Where those files come from is the deployment's business, not the bundle's:
 * they are a volume on the host (`samples/`, see its README), because the
 * recordings belong to third parties and stay out of the repository and the
 * image. Nothing here changes when the directory is empty.
 *
 * By name only: this is the same lookup LTSpice does next to the `.asc`, and a
 * file already loaded — by hand, from an opened folder, or kept in IndexedDB
 * from an earlier session — always wins, because it is what the user chose.
 *
 * Only the published samples live there. A circuit naming anything else simply
 * finds nothing and says so in the source's properties, exactly as before.
 */
const SAMPLE_DIR = "samples/";

/** The file names the current sheet's file sources read. */
function requestedFiles(): string[] {
  const out: string[] = [];
  for (const comp of useCircuitStore.getState().circuit.components.values()) {
    const c = comp as { sourceType?: string; filePath?: string };
    if (c.sourceType === "File" && c.filePath) out.push(signalFileName(c.filePath));
  }
  return out;
}

/**
 * Load every file the sheet names and does not have yet from `samples/`.
 * Quiet by design: a missing sample is the normal case for a user's own
 * circuit, not an error to report.
 */
export async function loadBundledSourceFiles(): Promise<void> {
  // What an earlier session kept is the user's own choice of file and wins
  // over the shipped sample, so the stored files are read first.
  await hydrateSourceFiles();
  const files = useSourceFileStore.getState();
  for (const name of requestedFiles()) {
    if (!name || files.signalFor(name)) continue;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}${SAMPLE_DIR}${encodeURIComponent(name)}`);
      // The server answers an unknown path under the app base with the SPA's
      // own index.html and a 200, so "did it 404" is not the question — what
      // came back has to be the file itself.
      if (!res.ok || (res.headers.get("content-type") ?? "").includes("text/html")) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Decoded before it is stored: a store entry that failed to decode would
      // replace the source's honest "Datei nicht geladen" with a decode error
      // about a file the user never picked.
      decodeSignalFile(name, bytes);
      files.addInput(name, bytes);
    } catch {
      /* offline, or no such sample — the source's properties say it is missing */
    }
  }
}

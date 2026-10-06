import { decodeSignalFile, signalFileKey, signalFileName } from "@core/audio/signalFile.js";
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
 *
 * A source can instead say where its file lives: a Nextcloud share link in
 * `fileUrl` (see loadRemoteSourceFile). Then nothing has to be put on the
 * server at all.
 */
const SAMPLE_DIR = "samples/";

interface FileSourceLike { id: string; sourceType?: string; filePath?: string; fileUrl?: string }

/** The current sheet's file sources. */
function fileSources(): FileSourceLike[] {
  return [...useCircuitStore.getState().circuit.components.values()]
    .filter((c) => (c as FileSourceLike).sourceType === "File") as FileSourceLike[];
}

/** Links fetched in this session, so reopening a sheet does not download again. */
const fetchedUrls = new Map<string, Promise<string>>();

/**
 * Fetch the file behind a source's share link and store it under the source's
 * file name — or, when the source names none yet, under the name the cloud
 * offers, which then becomes the source's file name.
 *
 * Through the app's own server (server/remoteFile.mjs): Nextcloud sends no CORS
 * header, so the browser could download the file but not read it.
 *
 * The link wins over a copy kept from an earlier session: naming a link is
 * saying where the file comes from. The copy it replaces is kept in IndexedDB
 * as before, so the sheet still runs offline with what was fetched last.
 *
 * Throws with a message for the properties panel; resolves to the stored name.
 */
export function loadRemoteSourceFile(url: string, name: string): Promise<string> {
  const key = `${url}\n${signalFileKey(name)}`;
  let job = fetchedUrls.get(key);
  if (!job) {
    job = fetchRemote(url, name);
    fetchedUrls.set(key, job);
    // A failure is not remembered: the next attempt (a button, a reload) retries.
    job.catch(() => fetchedUrls.delete(key));
  }
  return job;
}

async function fetchRemote(url: string, name: string): Promise<string> {
  await hydrateSourceFiles();
  const res = await fetch(`${import.meta.env.BASE_URL}api/remote-file?url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error((await res.text().catch(() => "")) || `Laden fehlgeschlagen (${res.status})`);
  if ((res.headers.get("content-type") ?? "").includes("text/html")) {
    throw new Error("Der Server kennt keine Link-Quellen (älterer Server?)");
  }
  const offered = decodeURIComponent(res.headers.get("x-file-name") ?? "");
  const stored = signalFileName(name) || offered;
  if (!stored) throw new Error("Unbekannter Dateiname — bitte unter „Datei\" eintragen");
  const bytes = new Uint8Array(await res.arrayBuffer());
  decodeSignalFile(stored, bytes); // throws on a file that is not what its name says
  useSourceFileStore.getState().addInput(stored, bytes);
  return stored;
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
  const sources = fileSources();
  // Linked files first, and quietly: one that fails falls through to the copy
  // kept from earlier and then to samples/, like any other named file.
  await Promise.all(sources.filter((c) => c.fileUrl).map(async (c) => {
    try {
      const name = await loadRemoteSourceFile(c.fileUrl!, c.filePath ?? "");
      if (!c.filePath) useCircuitStore.getState().updateComponentProperty(c.id, "filePath", name);
    } catch {
      /* unreachable or not allowed — the properties panel says why on retry */
    }
  }));
  const files = useSourceFileStore.getState();
  for (const name of sources.map((c) => signalFileName(c.filePath ?? ""))) {
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

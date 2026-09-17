import { create } from "zustand";

/**
 * Listening to a source file or a `.wave` result in the browser.
 *
 * One thing plays at a time — starting another stops the first — and the id of
 * what is playing is kept in a store, so every play button can show whether it
 * is the one running.
 */

export const usePlayback = create<{ playing: string | null }>(() => ({ playing: null }));

let ctx: AudioContext | null = null;
let node: AudioBufferSourceNode | null = null;

export function stopPlayback(): void {
  if (node) {
    node.onended = null;
    try { node.stop(); } catch { /* already ended */ }
    node = null;
  }
  usePlayback.setState({ playing: null });
}

/** Play `samples` (±1 = full scale), or stop if `id` is already playing. */
export async function togglePlayback(id: string, samples: ArrayLike<number>, sampleRate: number): Promise<void> {
  if (usePlayback.getState().playing === id) { stopPlayback(); return; }
  stopPlayback();
  ctx ??= new AudioContext();
  // Browsers start a context suspended until a user gesture; this is one.
  if (ctx.state === "suspended") await ctx.resume();
  const buffer = ctx.createBuffer(1, Math.max(1, samples.length), sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) channel[i] = samples[i];
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.onended = () => { if (node === src) { node = null; usePlayback.setState({ playing: null }); } };
  node = src;
  src.start();
  usePlayback.setState({ playing: id });
}

/** Offer a file for saving: the save dialog where available, a download otherwise. */
export async function saveFile(name: string, bytes: Uint8Array, mime: string): Promise<void> {
  const blob = new Blob([bytes as BlobPart], { type: mime });
  if ("showSaveFilePicker" in window) {
    try {
      const ext = name.match(/\.[^.]+$/)?.[0] ?? ".txt";
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: name,
        types: [{ description: mime === "audio/wav" ? "WAV-Datei" : "Textdatei", accept: { [mime]: [ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err: any) {
      if (err?.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

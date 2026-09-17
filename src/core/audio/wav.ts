/**
 * WAV files as LTSpice reads and writes them: uncompressed PCM, one channel.
 *
 * LTSpice's `wavefile=` source and its `.wave` directive both map full scale to
 * ±1 V — a sample of 32767 (16 bit) is +1 V, a voltage above 1 V is clipped
 * when written. The same convention is kept here, so a file round-trips
 * between the two programs unchanged.
 *
 * Only PCM mono is accepted. LTSpice can pick a channel out of a stereo file,
 * but a classroom exercise with a stereo file is more likely a mistake than a
 * choice, and saying so beats silently simulating the left channel.
 */

export interface WavData {
  sampleRate: number;
  bitsPerSample: number;
  /** Samples scaled to −1 … +1 (= −1 V … +1 V). */
  samples: Float32Array;
}

const PCM = 1;
const EXTENSIBLE = 0xfffe;

function tag(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

export function decodeWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 || tag(view, 0) !== "RIFF" || tag(view, 8) !== "WAVE") {
    throw new Error("keine WAV-Datei (RIFF/WAVE-Kopf fehlt)");
  }

  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  let data: { at: number; size: number } | null = null;
  for (let at = 12; at + 8 <= bytes.byteLength;) {
    const id = tag(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      let format = view.getUint16(body, true);
      // WAVE_FORMAT_EXTENSIBLE names the real format in its sub-format GUID,
      // whose first two bytes are the classic format code.
      if (format === EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true);
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      // A writer that streamed the file may leave the size open (0 or too big).
      data = { at: body, size: Math.min(size || Infinity, bytes.byteLength - body) };
    }
    at = body + size + (size & 1); // chunks are word-aligned
  }

  if (!fmt) throw new Error("WAV-Datei ohne fmt-Block");
  if (!data) throw new Error("WAV-Datei ohne Daten");
  if (fmt.format !== PCM) throw new Error("nur unkomprimiertes PCM wird unterstützt");
  if (fmt.channels !== 1) throw new Error(`nur Mono wird unterstützt (Datei hat ${fmt.channels} Kanäle)`);
  if (![8, 16, 24, 32].includes(fmt.bits)) throw new Error(`${fmt.bits} Bit werden nicht unterstützt`);
  if (!(fmt.sampleRate > 0)) throw new Error("ungültige Abtastrate");

  const width = fmt.bits / 8;
  const n = Math.floor(data.size / width);
  const samples = new Float32Array(n);
  for (let i = 0, at = data.at; i < n; i++, at += width) {
    switch (fmt.bits) {
      case 8: samples[i] = (view.getUint8(at) - 128) / 128; break; // 8 bit is unsigned
      case 16: samples[i] = view.getInt16(at, true) / 32768; break;
      case 24: samples[i] = ((view.getUint8(at + 2) << 24 >> 8) | view.getUint16(at, true)) / 8388608; break;
      default: samples[i] = view.getInt32(at, true) / 2147483648;
    }
  }
  return { sampleRate: fmt.sampleRate, bitsPerSample: fmt.bits, samples };
}

/** Write PCM mono. Values outside ±1 are clipped, as LTSpice does. */
export function encodeWav(samples: ArrayLike<number>, sampleRate: number, bitsPerSample = 16): Uint8Array {
  if (![8, 16, 24, 32].includes(bitsPerSample)) throw new Error(`${bitsPerSample} Bit werden nicht unterstützt`);
  const rate = Math.round(sampleRate);
  const width = bitsPerSample / 8;
  const size = samples.length * width;
  const bytes = new Uint8Array(44 + size);
  const view = new DataView(bytes.buffer);
  const put = (at: number, s: string) => { for (let i = 0; i < 4; i++) view.setUint8(at + i, s.charCodeAt(i)); };

  put(0, "RIFF"); view.setUint32(4, 36 + size, true); put(8, "WAVE");
  put(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, PCM, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * width, true);
  view.setUint16(32, width, true); view.setUint16(34, bitsPerSample, true);
  put(36, "data"); view.setUint32(40, size, true);

  const full = 2 ** (bitsPerSample - 1);
  for (let i = 0, at = 44; i < samples.length; i++, at += width) {
    const v = Number(samples[i]);
    const x = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    const q = Math.max(-full, Math.min(full - 1, Math.round(x * full)));
    switch (bitsPerSample) {
      case 8: view.setUint8(at, q + 128); break;
      case 16: view.setInt16(at, q, true); break;
      case 24: view.setUint16(at, q & 0xffff, true); view.setInt8(at + 2, q >> 16); break;
      default: view.setInt32(at, q, true);
    }
  }
  return bytes;
}

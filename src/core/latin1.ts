/**
 * Text encoding for the files LTSpice reads and writes.
 *
 * LTSpice's `.asc`, `.asy` and `.plt` are latin1 (windows-1252), one byte per
 * character, and it does not sniff for anything else. We read them that way —
 * `new TextDecoder("windows-1252")` on open — but wrote them back as UTF-8,
 * because a JavaScript string handed to a `Blob` or to a file handle is encoded
 * as UTF-8 without asking.
 *
 * The asymmetry is not cosmetic. Open a sheet with `10µF`, save it, open it in
 * LTSpice: the two UTF-8 bytes of `µ` arrive as `Âµ`, the value reads `10ÂµF`,
 * and LTSpice takes the number and drops the rest — a 10 µF capacitor becomes a
 * 10 F one. In the reactive-power example that turned a 31 mA branch current
 * into 10 A, which looks like a simulation error and is a save-encoding error.
 *
 * A character latin1 has no room for (an arrow, a Greek letter beyond µ, an em
 * dash in a note) becomes `?`. That is a real loss, and it is the same loss
 * LTSpice itself would suffer: the format has nowhere to put those bytes. The
 * alternative — writing UTF-8 — loses the µ as well *and* corrupts everything
 * around it.
 */

/** Text as latin1 bytes; anything above U+00FF becomes `?`. */
export function toLatin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[i] = c < 256 ? c : 0x3f;
  }
  return out;
}

/** A latin1 blob for download / file-handle writes, with the given MIME type. */
export function latin1Blob(text: string, mime = "text/plain"): Blob {
  return new Blob([toLatin1(text) as BlobPart], { type: mime });
}

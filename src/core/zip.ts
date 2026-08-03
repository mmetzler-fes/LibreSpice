/**
 * A minimal ZIP writer — enough to hand out a folder as one file.
 *
 * Stored (uncompressed) entries only. That is not a shortcut taken lightly: the
 * payload here is a handful of `.asc`/`.asy`/`.lib` text files totalling a few
 * kilobytes, where compression would save nothing worth a dependency, and the
 * "stored" format is the one part of the ZIP spec every unpacker on every
 * platform has always agreed on — including Windows Explorer's built-in one,
 * which is what a student will use.
 *
 * No external library, because the alternative costs more than it gives: a zip
 * package pulls a compressor, a stream abstraction and a licence into a bundle
 * that ships to the browser, for eighty lines of header writing.
 */

/** One file in the archive. `path` may contain `/` to make folders. */
export interface ZipEntry {
  path: string;
  /** File contents. A string is encoded as UTF-8 unless `latin1` is set. */
  data: string | Uint8Array;
  /**
   * Encode a string payload as latin1 rather than UTF-8.
   *
   * LTSpice reads and writes `.asc`/`.asy` in latin1: a `µF` written as UTF-8
   * arrives there as `ÂµF`. Our own files are latin1 on disk for the same
   * reason, so anything going back out to LTSpice has to be too.
   */
  latin1?: boolean;
}

/** CRC-32 (IEEE), the checksum every ZIP entry carries. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** latin1: one byte per code unit, anything above 0xFF replaced by `?`. */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i] = c < 256 ? c : 0x3f;
  }
  return out;
}

const utf8 = new TextEncoder();

/**
 * Build a ZIP archive from `entries`.
 *
 * Every entry is stored with a fixed timestamp rather than "now": the same
 * schematic exported twice then yields byte-identical archives, which is what
 * makes a regression test able to compare one at all.
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  // 1980-01-01 00:00, the earliest a DOS timestamp can express.
  const dosTime = 0, dosDate = (1 << 5) | 1;

  for (const entry of entries) {
    const name = utf8.encode(entry.path);
    const body = typeof entry.data === "string"
      ? (entry.latin1 ? latin1Bytes(entry.data) : utf8.encode(entry.data))
      : entry.data;
    const crc = crc32(body);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // local file header
    lv.setUint16(4, 20, true);           // version needed
    lv.setUint16(6, 0, true);            // flags
    lv.setUint16(8, 0, true);            // method: stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true); // compressed size
    lv.setUint32(22, body.length, true); // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);           // extra length
    local.set(name, 30);

    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);   // central directory header
    dv.setUint16(4, 20, true);           // version made by
    dv.setUint16(6, 20, true);           // version needed
    dv.setUint16(8, 0, true);
    dv.setUint16(10, 0, true);           // stored
    dv.setUint16(12, dosTime, true);
    dv.setUint16(14, dosDate, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, body.length, true);
    dv.setUint32(24, body.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);      // offset of the local header
    dir.set(name, 46);

    chunks.push(local, body);
    central.push(dir);
    offset += local.length + body.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);     // end of central directory
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of [...chunks, ...central, end]) { out.set(c, at); at += c.length; }
  return out;
}

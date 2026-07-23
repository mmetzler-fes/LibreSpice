/**
 * Reading a Multisim 14 `.ms14` file.
 *
 * Under the surface it is the same XML in both of its forms — a serialized
 * object graph headed `<MSMElectronicsWorkbench>`. Multisim writes it plainly
 * some of the time and packed the rest, and a packed file says so itself:
 * `MSMCompressedElectronicsWorkbenchXML`. Of the 87 bundled files 64 are packed,
 * so this is not an edge case but the normal shape.
 *
 * The packing is PKWARE's DCL "implode" (the Data Compression Library's, not
 * PKZIP's — a different algorithm despite the shared name), split into chunks of
 * 900 000 bytes. It is neither zlib, gzip, bzip2 nor lzma, which is why a file
 * looks like undifferentiated noise until you know what it is.
 *
 * The decoder below follows Mark Adler's `blast.c`, the reference implementation
 * of that format.
 */

/**
 * The three Huffman tables, in `blast.c`'s compact form: each byte holds a
 * repeat count in its high nibble (plus one) and a code length in its low one.
 */
const LIT_REP = [
  11, 124, 8, 7, 28, 7, 188, 13, 76, 4, 10, 8, 12, 10, 12, 10, 8, 23, 8,
  9, 7, 6, 7, 8, 7, 6, 55, 8, 23, 24, 12, 11, 7, 9, 11, 12, 6, 7, 22, 5,
  7, 24, 6, 11, 9, 6, 7, 22, 7, 11, 38, 7, 9, 8, 25, 11, 8, 11, 9, 12,
  8, 12, 5, 38, 5, 38, 5, 11, 7, 5, 6, 21, 6, 10, 53, 8, 7, 24, 10, 27,
  44, 253, 253, 253, 252, 252, 252, 13, 12, 45, 12, 45, 12, 61, 12, 45, 44, 173,
];
const LEN_REP = [2, 35, 36, 53, 38, 23];
const DIST_REP = [2, 20, 53, 230, 247, 151, 248];

/** Base length and extra bits for each of the 16 length codes. */
const LEN_BASE = [3, 2, 4, 5, 6, 7, 8, 9, 10, 12, 16, 24, 40, 72, 136, 264];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];

const MAX_BITS = 13;

interface Huffman {
  /** How many symbols have each code length. */
  count: number[];
  /** Symbols, ordered by code length then by symbol. */
  symbol: number[];
}

/** Expand a compact table and build the canonical Huffman decoder for it. */
function buildHuffman(rep: number[]): Huffman {
  const lengths: number[] = [];
  for (const b of rep) {
    const n = (b >> 4) + 1;
    for (let i = 0; i < n; i++) lengths.push(b & 15);
  }
  const count = new Array<number>(MAX_BITS + 1).fill(0);
  for (const l of lengths) if (l) count[l]++;
  const offs = new Array<number>(MAX_BITS + 2).fill(0);
  for (let i = 1; i <= MAX_BITS; i++) offs[i + 1] = offs[i] + count[i];
  const symbol = new Array<number>(lengths.length).fill(0);
  lengths.forEach((l, s) => { if (l) symbol[offs[l]++] = s; });
  return { count, symbol };
}

const LIT = buildHuffman(LIT_REP);
const LEN = buildHuffman(LEN_REP);
const DIST = buildHuffman(DIST_REP);

/** Least-significant-bit-first reader over the compressed stream. */
class BitReader {
  private buf = 0;
  private cnt = 0;
  private pos = 0;
  constructor(private readonly data: Uint8Array) {}

  bits(need: number): number {
    let val = this.buf;
    let cnt = this.cnt;
    while (cnt < need) {
      if (this.pos >= this.data.length) throw new Error("Datenstrom endet mitten im Symbol");
      val |= this.data[this.pos++] << cnt;
      cnt += 8;
    }
    this.buf = val >>> need;
    this.cnt = cnt - need;
    return val & ((1 << need) - 1);
  }
}

/**
 * One Huffman symbol. The codes are stored inverted — `blast.c` flips each bit
 * as it reads it, and a decoder that does not is subtly wrong rather than
 * obviously broken.
 */
function decodeSymbol(br: BitReader, h: Huffman): number {
  let code = 0, first = 0, index = 0;
  for (let len = 1; len <= MAX_BITS; len++) {
    code |= br.bits(1) ^ 1;
    const count = h.count[len];
    if (code - first < count) return h.symbol[index + (code - first)];
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new Error("ungültiger Huffman-Code");
}

/** Decompress one DCL stream. */
export function explode(data: Uint8Array): Uint8Array {
  const br = new BitReader(data);
  const literalsCoded = br.bits(8);
  const dictBits = br.bits(8);
  if (literalsCoded > 1) throw new Error(`unbekannter Literal-Modus ${literalsCoded}`);
  if (dictBits < 4 || dictBits > 6) throw new Error(`unbekannte Wörterbuchgröße ${dictBits}`);

  const out: number[] = [];
  for (;;) {
    if (br.bits(1)) {
      const sym = decodeSymbol(br, LEN);
      const extra = LEN_EXTRA[sym];
      const length = LEN_BASE[sym] + (extra ? br.bits(extra) : 0);
      if (length === 519) break;                 // end of stream
      // A two-byte match always uses a 2-bit low part; anything longer uses the
      // dictionary's width.
      const shift = length === 2 ? 2 : dictBits;
      const dist = (decodeSymbol(br, DIST) << shift) + br.bits(shift) + 1;
      if (dist > out.length) throw new Error("Rückverweis vor den Anfang der Daten");
      for (let i = 0; i < length; i++) out.push(out[out.length - dist]);
    } else {
      out.push(literalsCoded ? decodeSymbol(br, LIT) : br.bits(8));
    }
  }
  return Uint8Array.from(out);
}

const MAGIC_PACKED = "MSMCompressedElectronicsWorkbenchXML";

/**
 * The XML of a `.ms14`, packed or not.
 *
 * A packed file is a run of chunks, each headed by its unpacked and packed size,
 * after a header giving the total. Decoded as ASCII, which is what the document
 * declares: the strings inside carry their own escapes (`&ASC…`, `&UNI…`) rather
 * than relying on the file's encoding.
 */
export function readMs14(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder("ascii").decode(bytes.subarray(0, MAGIC_PACKED.length));
  if (head.startsWith("<?xml")) return new TextDecoder("ascii").decode(bytes);
  if (head !== MAGIC_PACKED) throw new Error("Keine Multisim-14-Datei");

  const view = new DataView(buffer);
  const total = view.getUint32(MAGIC_PACKED.length, true);
  let off = MAGIC_PACKED.length + 8;             // total + reserved
  const parts: Uint8Array[] = [];
  let done = 0;
  while (done < total) {
    const raw = view.getUint32(off, true);
    const packed = view.getUint32(off + 4, true);
    off += 8;
    const part = explode(bytes.subarray(off, off + packed));
    if (part.length !== raw) throw new Error(`Block ergab ${part.length} statt ${raw} Bytes`);
    parts.push(part);
    done += raw;
    off += packed;
  }

  const all = new Uint8Array(done);
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return new TextDecoder("ascii").decode(all);
}

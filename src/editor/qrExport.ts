import { encode } from "uqr";

/**
 * Render a share URL as a standalone QR-code SVG.
 *
 * The share URL carries the whole circuit as base64 in its hash, so it can grow
 * past what a QR code holds (2953 bytes at the lowest error-correction level).
 * Try the levels from most to least redundant and use the first that fits —
 * `null` means the circuit is too large to encode at all.
 */

/** Module edge length in the SVG's user units. */
const PIXEL = 4;
/** Quiet zone in modules; the QR spec requires at least 4 for reliable scanning. */
const BORDER = 4;

export function buildShareQrSvg(url: string): string | null {
  for (const ecc of ["M", "L"] as const) {
    let qr;
    try {
      qr = encode(url, { ecc, border: BORDER });
    } catch {
      continue; // too long for this level — retry with less error correction
    }
    const side = qr.size * PIXEL;
    const modules: string[] = [];
    for (let row = 0; row < qr.size; row++) {
      for (let col = 0; col < qr.size; col++) {
        if (qr.data[row][col]) modules.push(`M${col * PIXEL},${row * PIXEL}h${PIXEL}v${PIXEL}h-${PIXEL}z`);
      }
    }
    // An explicit white background: a transparent QR is unreadable on a dark
    // viewer, and the quiet zone only works if it is actually light.
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">`,
      `<rect width="${side}" height="${side}" fill="#ffffff"/>`,
      `<path fill="#000000" d="${modules.join("")}"/>`,
      `</svg>`,
    ].join("");
  }
  return null;
}

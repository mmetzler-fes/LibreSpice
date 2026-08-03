import type { LibraryScope } from "@core/library/types.js";
import type { FullTheme } from "../theme.js";

/**
 * Where a library part came from, said plainly on its row — in the palette and
 * in the Insert dialog, which have to agree.
 *
 * All four scopes used to collapse into "LOCAL or TEMP" in the palette, so a
 * part served by the backend was labelled TEMP, as if it would be gone on the
 * next reload, and clicking that badge offered to copy it into this browser's
 * storage. The curated defaults had no badge at all because they were not
 * listed: they are compiled into the app, resolve by name, and were invisible
 * until a backend happened to serve the same files.
 */
export const SCOPE_BADGE: Record<LibraryScope, string> = {
  local: "LOCAL", temp: "TEMP", server: "SERVER", bundled: "STD",
};

export const SCOPE_HINT: Record<LibraryScope, string> = {
  local: "Im Browser gespeichert (Klick → nur diese Sitzung)",
  temp: "Nur diese Sitzung (Klick → im Browser speichern)",
  server: "Aus der Bibliothek dieses Servers (library/sub)",
  bundled: "Standardteil, fest eingebaut — immer vorhanden",
};

export function scopeStyle(pal: FullTheme, scope: LibraryScope): { background: string; color: string } {
  switch (scope) {
    case "local": return { background: pal.localBg, color: pal.localText };
    case "temp": return { background: pal.tempBg, color: pal.tempText };
    case "server": return { background: pal.serverBg, color: pal.serverText };
    // The quietest of the four: a default is the norm, not news.
    case "bundled": return { background: "transparent", color: pal.textMuted };
  }
}

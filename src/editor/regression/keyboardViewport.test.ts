import { appHeight } from "../../useKeyboardViewport.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * iPadOS trims the visual viewport for its own bars as well as for the keyboard:
 * the autofill/shortcut strip, and the "show keyboard" bar left behind once the
 * keyboard is dismissed (≈2 cm). Those are browser chrome — no CSS shortens them.
 * Mirroring their height into `--app-height` surrendered the same space twice and
 * left the schematic squeezed while nothing was being typed. Only a real keyboard
 * may shrink the app.
 */
type Case = { name: string; run: (fail: (r: string) => void) => void };

const CASES: Case[] = [
  { name: "a real keyboard shrinks the app to the visible height", run: (fail) => {
    // iPad Pro landscape, on-screen keyboard ≈ 350 px.
    if (appHeight(834, 484) !== 484) fail(`${appHeight(834, 484)} ≠ 484`);
    // iPhone portrait, keyboard ≈ 300 px.
    if (appHeight(844, 544) !== 544) fail(`${appHeight(844, 544)} ≠ 544`);
  } },

  { name: "a bar (autofill strip, dismiss bar) does not shrink the app", run: (fail) => {
    // The ≈2 cm "show keyboard" bar left behind after dismissing (≈75 px).
    if (appHeight(834, 759) !== 834) fail(`dismiss bar: ${appHeight(834, 759)} ≠ 834 (full)`);
    // The autofill/shortcut strip (≈45 px).
    if (appHeight(834, 789) !== 834) fail(`autofill strip: ${appHeight(834, 789)} ≠ 834 (full)`);
  } },

  { name: "nothing hidden → full height", run: (fail) => {
    if (appHeight(900, 900) !== 900) fail(`${appHeight(900, 900)} ≠ 900`);
    // A visual viewport larger than the layout one (pinch-zoom) must not grow it.
    if (appHeight(900, 950) !== 900) fail(`pinch-zoomed: ${appHeight(900, 950)} ≠ 900`);
  } },
];

export function runKeyboardViewportTests(): TestReport {
  const failures: { name: string; reason: string }[] = [];
  let failed = 0;
  for (const tc of CASES) {
    let f = false;
    tc.run((reason) => { failures.push({ name: tc.name, reason }); f = true; });
    if (f) failed++;
  }
  return { total: CASES.length, passed: CASES.length - failed, failures };
}

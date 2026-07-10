import { LONG_PRESS_MS, LONG_PRESS_TOLERANCE, isLongPressPointer, trackLongPress } from "../longPress.js";
import type { TestReport } from "./svgExport.test.js";

/**
 * Long-press stands in for the right-click an iPad cannot make. The gesture has
 * to lose against every other interpretation of the same pointer: a drag, a tap,
 * a cancelled pointer. And the `click` the browser synthesises when the finger
 * lifts must not reach the menu that just opened.
 */

type Case = { name: string; run: (fail: (r: string) => void, done: () => void) => void; async?: boolean };

function pointer(over: Partial<{ pointerId: number; pointerType: string; isPrimary: boolean }> = {}) {
  return { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 100, clientY: 100, ...over };
}

/** Replace `window` with an EventTarget we can dispatch on. */
function fakeWindow(): { win: EventTarget; restore: () => void } {
  const g = globalThis as unknown as { window?: unknown };
  const prev = g.window;
  const win = new EventTarget();
  g.window = win;
  return { win, restore: () => { g.window = prev; } };
}

function emit(win: EventTarget, type: string, props: Record<string, unknown> = {}): Event {
  const ev = new Event(type, { cancelable: true, bubbles: true });
  Object.assign(ev, { pointerId: 1, clientX: 100, clientY: 100, ...props });
  win.dispatchEvent(ev);
  return ev;
}

/** Wait past the long-press deadline. */
const afterDeadline = () => new Promise((r) => setTimeout(r, LONG_PRESS_MS + 60));

const CASES: Case[] = [
  {
    name: "isLongPressPointer covers pen and touch, never a mouse",
    run: (fail, done) => {
      if (!isLongPressPointer({ pointerType: "touch", isPrimary: true })) fail("touch rejected");
      if (!isLongPressPointer({ pointerType: "pen", isPrimary: true })) fail("pen rejected");
      if (isLongPressPointer({ pointerType: "mouse", isPrimary: true })) fail("mouse accepted — it has a right button");
      if (isLongPressPointer({ pointerType: "touch", isPrimary: false })) fail("a second finger accepted");
      done();
    },
  },
  {
    name: "holding still fires the long press once, at the press position",
    async: true,
    run: async (fail, done) => {
      const { win, restore } = fakeWindow();
      const fired: [number, number][] = [];
      trackLongPress(pointer(), (x, y) => fired.push([x, y]));
      emit(win, "pointermove", { clientX: 103, clientY: 104 }); // inside the tolerance
      await afterDeadline();
      if (fired.length !== 1) fail(`fired ${fired.length}×, want once`);
      else if (fired[0][0] !== 100 || fired[0][1] !== 100) fail(`fired at ${fired[0]}, want the press origin 100,100`);
      restore();
      done();
    },
  },
  {
    name: "moving past the tolerance cancels the press — it was a drag",
    async: true,
    run: async (fail, done) => {
      const { win, restore } = fakeWindow();
      let fired = 0;
      trackLongPress(pointer(), () => fired++);
      emit(win, "pointermove", { clientX: 100 + LONG_PRESS_TOLERANCE + 1, clientY: 100 });
      await afterDeadline();
      if (fired !== 0) fail("a drag opened the context menu");
      restore();
      done();
    },
  },
  {
    name: "lifting early cancels the press — it was a tap",
    async: true,
    run: async (fail, done) => {
      const { win, restore } = fakeWindow();
      let fired = 0;
      trackLongPress(pointer(), () => fired++);
      emit(win, "pointerup");
      await afterDeadline();
      if (fired !== 0) fail("a tap opened the context menu");
      restore();
      done();
    },
  },
  {
    name: "a cancelled pointer cancels the press",
    async: true,
    run: async (fail, done) => {
      const { win, restore } = fakeWindow();
      let fired = 0;
      trackLongPress(pointer(), () => fired++);
      emit(win, "pointercancel");
      await afterDeadline();
      if (fired !== 0) fail("a cancelled pointer opened the context menu");
      restore();
      done();
    },
  },
  {
    name: "a foreign pointer neither cancels nor drives the press",
    async: true,
    run: async (fail, done) => {
      const { win, restore } = fakeWindow();
      let fired = 0;
      trackLongPress(pointer({ pointerId: 1 }), () => fired++);
      emit(win, "pointerup", { pointerId: 2 });
      emit(win, "pointermove", { pointerId: 2, clientX: 900, clientY: 900 });
      await afterDeadline();
      if (fired !== 1) fail(`a second finger disturbed the press (fired ${fired}×)`);
      restore();
      done();
    },
  },
  {
    name: "the click that follows the long press is swallowed",
    async: true,
    run: async (fail, done) => {
      const { win, restore } = fakeWindow();
      trackLongPress(pointer(), () => {});
      await afterDeadline();
      // The finger lifts: the browser synthesises a click. It must not reach
      // the menu's backdrop, which would close the menu instantly.
      const click = emit(win, "click");
      if (!click.defaultPrevented) fail("the trailing click was not swallowed");
      // The very next click is a real one and must pass through.
      const next = emit(win, "click");
      if (next.defaultPrevented) fail("a later, genuine click was swallowed too");
      restore();
      done();
    },
  },
  {
    name: "abandoning the press stops it firing",
    async: true,
    run: async (fail, done) => {
      const { win, restore } = fakeWindow();
      let fired = 0;
      const abort = trackLongPress(pointer(), () => fired++);
      abort();
      await afterDeadline();
      if (fired !== 0) fail("an abandoned press still fired");
      void win;
      restore();
      done();
    },
  },
];

export async function runLongPressTests(): Promise<TestReport> {
  const failures: { name: string; reason: string }[] = [];
  let failedCases = 0;
  for (const tc of CASES) {
    let failed = false;
    await new Promise<void>((resolve) => {
      const r = tc.run((reason) => { failures.push({ name: tc.name, reason }); failed = true; }, resolve);
      void r;
    });
    if (failed) failedCases++;
  }
  return { total: CASES.length, passed: CASES.length - failedCases, failures };
}

/**
 * Long-press as the touch equivalent of a right-click.
 *
 * iPadOS does not fire `contextmenu` for arbitrary elements, so a stylus or
 * finger can never reach the schematic's context menus. Holding still on a part
 * or a wire for {@link LONG_PRESS_MS} opens the same menu a right-click does.
 */

/** How long the pointer must rest before the menu opens. */
export const LONG_PRESS_MS = 500;
/** Movement (px) that turns the gesture into a drag and cancels the press. */
export const LONG_PRESS_TOLERANCE = 10;

/** A mouse has a right button; only pen and touch need the long-press gesture. */
export function isLongPressPointer(e: { pointerType: string; isPrimary: boolean }): boolean {
  return e.isPrimary && e.pointerType !== "mouse";
}

/**
 * Fire `onLongPress` when this pointer rests in place long enough. The press is
 * abandoned as soon as the pointer moves past the tolerance (the user meant to
 * drag or pan), is released early, or is cancelled.
 *
 * Returns a function that aborts the pending press, for a caller that has to
 * give up on it (unmount).
 */
export function trackLongPress(
  e: { pointerId: number; clientX: number; clientY: number },
  onLongPress: (x: number, y: number) => void,
): () => void {
  const id = e.pointerId;
  const x0 = e.clientX, y0 = e.clientY;

  const timer = setTimeout(() => {
    cleanup();
    onLongPress(x0, y0);
    swallowNextClick();
  }, LONG_PRESS_MS);

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > LONG_PRESS_TOLERANCE) cleanup();
  };
  const end = (ev: PointerEvent) => {
    if (ev.pointerId === id) cleanup();
  };

  function cleanup() {
    clearTimeout(timer);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  }

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  return cleanup;
}

/**
 * Eat the `click` that the browser synthesises when the finger finally lifts —
 * otherwise it lands on the menu's backdrop (or the canvas) and closes the menu
 * the instant it opened. The listener is one-shot and self-expires, so a press
 * that produces no click cannot leave it armed.
 */
function swallowNextClick(): void {
  const swallow = (ev: Event) => {
    ev.stopPropagation();
    ev.preventDefault();
    done();
  };
  // `{ capture: true }` rather than the legacy boolean: Node's EventTarget only
  // matches the object form on removal, and browsers accept both.
  const capture = { capture: true } as const;
  const done = () => {
    clearTimeout(expiry);
    window.removeEventListener("click", swallow, capture);
  };
  const expiry = setTimeout(done, LONG_PRESS_MS);
  window.addEventListener("click", swallow, capture);
}

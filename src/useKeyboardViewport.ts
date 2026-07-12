import { useEffect } from "react";

/**
 * iOS/iPadOS keeps the layout viewport at full height when the on-screen
 * keyboard (and its autofill/shortcut accessory bar) slides up, so anything
 * anchored to the bottom of the screen ends up hidden behind it. Only the
 * *visual* viewport shrinks. We mirror that height into a `--app-height` CSS
 * variable so the app container collapses to the space that is actually
 * visible, then nudge the focused field into view once iOS has settled the
 * keyboard animation.
 *
 * Applied once at the app root, this covers every <input>/<textarea> without
 * having to wire per-field handlers.
 */
export function useKeyboardViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;

    const setAppHeight = () => {
      const height = vv ? vv.height : window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${height}px`);
    };

    setAppHeight();

    if (vv) {
      vv.addEventListener("resize", setAppHeight);
      vv.addEventListener("scroll", setAppHeight);
    }
    window.addEventListener("resize", setAppHeight);
    window.addEventListener("orientationchange", setAppHeight);

    const isTextEntry = (el: Element | null): el is HTMLElement => {
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        (el as HTMLElement).isContentEditable
      );
    };

    // When a field gets focus the keyboard is still animating in, so wait a
    // beat before scrolling — otherwise the browser measures the old viewport.
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as Element | null;
      if (!isTextEntry(target)) return;
      // iPadOS lays its autofill/shortcut bar (key · card · location) *over* the
      // page without shrinking the visual viewport, so `--app-height` cannot see
      // it and no measurement can compensate. While typing, pad the bottom of
      // scrollable panels (`.keyboard-safe`) so a field down there can still be
      // scrolled clear of that bar.
      document.body.classList.add("kb-open");
      window.setTimeout(() => {
        // Re-read after the keyboard has (mostly) settled.
        setAppHeight();
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 300);
    };

    const onFocusOut = (e: FocusEvent) => {
      if (!isTextEntry(e.target as Element | null)) return;
      document.body.classList.remove("kb-open");
    };

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);

    return () => {
      if (vv) {
        vv.removeEventListener("resize", setAppHeight);
        vv.removeEventListener("scroll", setAppHeight);
      }
      window.removeEventListener("resize", setAppHeight);
      window.removeEventListener("orientationchange", setAppHeight);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.body.classList.remove("kb-open");
    };
  }, []);
}

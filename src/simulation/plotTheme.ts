import { commonColors } from "../theme.js";
import { usePlotStore } from "./plotStore.js";

/**
 * Color theme for the oscilloscope/plot UI. It shares the accent/status base
 * ({@link commonColors}) with the main app theme, but is switched by the plot's
 * OWN `svgLight` flag (the ☀/🌙 button), independent of the app-wide dark mode —
 * so the diagram can be flipped to a white, print/beamer-friendly look while the
 * rest of the app stays dark, or vice-versa.
 *
 * The dark values keep the historical on-screen look; the light values keep the
 * historical print look. Use {@link usePlotTheme} in components and
 * {@link plotThemeFor} in non-component helpers (which can't call hooks).
 */
export interface PlotTheme {
  text: string;
  textMuted: string;
  heading: string;
  /** Dim uppercase labels / secondary captions. */
  labelDim: string;
  /** Placeholder ("drag a probe here…"). */
  placeholder: string;
  /** Axis / legend text drawn on the plot surface. */
  axisText: string;
  /** Surrounding panel background. */
  panelBg: string;
  /** Diagram / legend-box background (pure white in light for print). */
  plotBg: string;
  /** Input field background (deepest surface). */
  inputBg: string;
  /** Toolbar strip background. */
  toolbarBg: string;
  /** Active tab / selected row background. */
  activeBg: string;
  /** Popup menu / card background. */
  cardBg: string;
  /** Sidebar background (transparent on dark, white on light). */
  sidebarBg: string;
  /** Subtle border. */
  border: string;
  /** Divider border. */
  borderMuted: string;
  /** Strong border (inputs, controls). */
  borderStrong: string;
  /** Inactive probe color swatch. */
  chipInactive: string;
  /** Translucent cursor-readout background. */
  overlayBg: string;
  /** Translucent legend background. */
  overlayBg2: string;
}

type FullPlotTheme = PlotTheme & typeof commonColors;

export const plotDark: FullPlotTheme = {
  ...commonColors,
  text: "#e2e8f0",
  textMuted: "#94a3b8",
  heading: "#94a3b8",
  labelDim: "#64748b",
  placeholder: "#475569",
  axisText: "#cbd5e1",
  panelBg: "#0f172a",
  plotBg: "#0f172a",
  inputBg: "#0b1120",
  toolbarBg: "#0b1120",
  activeBg: "#1e293b",
  cardBg: "#1e293b",
  sidebarBg: "transparent",
  border: "#1e293b",
  borderMuted: "#334155",
  borderStrong: "#334155",
  chipInactive: "#334155",
  overlayBg: "#1e293be6",
  overlayBg2: "#0f172acc",
};

export const plotLight: FullPlotTheme = {
  ...commonColors,
  text: "#1e293b",
  textMuted: "#64748b",
  heading: "#475569",
  labelDim: "#94a3b8",
  placeholder: "#94a3b8",
  axisText: "#1e293b",
  panelBg: "#f8fafc",
  plotBg: "#ffffff",
  inputBg: "#ffffff",
  toolbarBg: "#f1f5f9",
  activeBg: "#f1f5f9",
  cardBg: "#ffffff",
  sidebarBg: "#ffffff",
  border: "#e2e8f0",
  borderMuted: "#e2e8f0",
  borderStrong: "#cbd5e1",
  chipInactive: "#94a3b8",
  overlayBg: "#ffffffee",
  overlayBg2: "#ffffffdd",
};

/** Plot theme for an explicit light flag — for non-component (hook-less) helpers. */
export function plotThemeFor(light: boolean): FullPlotTheme {
  return light ? plotLight : plotDark;
}

/** Active plot theme, driven by the plot store's own `svgLight` flag. */
export function usePlotTheme(): FullPlotTheme {
  return usePlotStore((s) => s.svgLight) ? plotLight : plotDark;
}

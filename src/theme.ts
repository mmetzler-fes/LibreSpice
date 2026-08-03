import { useUIStore } from "@store/uiStore.js";

/**
 * Central color theme. Instead of scattering `darkMode ? "#xxx" : "#yyy"`
 * ternaries across components, every UI color is a semantic token defined once
 * here for light and dark. Components read tokens via {@link useTheme}.
 *
 * `common` holds the theme-independent accent/status colors; the light and dark
 * themes spread it in (so they "inherit" those) and only override what differs.
 * The light values are the historical originals — light mode is unchanged.
 */
export const commonColors = {
  /** Primary accent (selection, focus, primary buttons). */
  accent: "#2563eb",
  /** Text/icon on an accent-filled surface. */
  accentText: "#ffffff",
  /** Stronger accent for emphasized values / hovered accent text. */
  accentStrong: "#1d4ed8",
  /** Destructive action text. */
  danger: "#fca5a5",
  /** Placement-ghost + connection-line stroke. */
  ghost: "#2563eb",
  /** Right-click popup menus are dark in both themes. */
  menuBg: "#1e293b",
  menuBorder: "#334155",
  menuText: "#e2e8f0",
  menuMuted: "#64748b",
  /** Code/netlist block is a dark terminal surface in both themes. */
  codeText: "#e2e8f0",
  codeBorder: "#334155",
} as const;

export interface Theme {
  // Text
  text: string;
  /** Near-black / near-white emphasized text (titles, tags). */
  textStrong: string;
  textMuted: string;
  heading: string;
  /** Medium stroke for symbol previews on panels. */
  symPreview: string;
  /** Toolbar button icon/label. */
  icon: string;
  /** App top menu-bar surface. */
  headerBg: string;
  /** Hovered menu/list row highlight. */
  itemHover: string;
  /** On-canvas SPICE directive box. */
  directiveBg: string;
  directiveBorder: string;
  /** Component / `.asy` symbol strokes (currentColor). */
  symStroke: string;
  /** Reference label under a component (R1, C1 …). */
  label: string;
  /** Value label under a component (1k, 100n …). */
  value: string;
  // Surfaces
  canvasBg: string;
  inputBg: string;
  panelBg: string;
  /** Slightly raised header/toolbar/tab-bar surface. */
  panelBgAlt: string;
  /** Modal-dialog body. */
  modalBg: string;
  /** Modal header strip. */
  modalHeaderBg: string;
  /** Collapsible section / list-group header. */
  sectionBg: string;
  /** Palette category header. */
  categoryBg: string;
  /** Selected / active list row + button. */
  itemActive: string;
  /** Subcircuit box fill (idle / selected). */
  boxFill: string;
  boxFillSel: string;
  // Borders
  /** Strong border (inputs, controls). */
  border: string;
  /** Subtle divider. */
  borderMuted: string;
  /** List-row separator. */
  rowBorder: string;
  // Canvas graphics
  wireStroke: string;
  gridDot: string;
  /** Net-label connector arrow/stem stroke. */
  netLabelStroke: string;
  // Component net-label tag
  netTagBg: string;
  netTagBgSel: string;
  /** Net-connector name tag: same shape as a net label's, tinted apart from it. */
  portTagBg: string;
  portTagBgSel: string;
  netTagText: string;
  netTagBorder: string;
  // Pin net-id badge
  badgeText: string;
  badgeBg: string;
  badgeBorder: string;
  /** Code/netlist block background (dark in both themes, darker in dark mode). */
  codeBg: string;
  // Canvas data-flag readout
  flagBg: string;
  flagBorder: string;
  flagValue: string;
  // Palette "Import LTSpice" button
  importBg: string;
  importText: string;
  // Scope/source chips
  localBg: string;
  localText: string;
  tempBg: string;
  tempText: string;
  serverBg: string;
  serverText: string;
}

export type FullTheme = Theme & typeof commonColors;

export const lightTheme: FullTheme = {
  ...commonColors,
  text: "#1e293b",
  textStrong: "#0f172a",
  textMuted: "#64748b",
  heading: "#475569",
  symPreview: "#334155",
  icon: "#334155",
  headerBg: "#e2e8f0",
  itemHover: "#f1f5f9",
  directiveBg: "rgba(255,255,255,0.9)",
  directiveBorder: "#94a3b8",
  symStroke: "#0f172a",
  label: "#374151",
  value: "#6b7280",
  canvasBg: "#ffffff",
  inputBg: "#ffffff",
  panelBg: "#fafafa",
  panelBgAlt: "#f8fafc",
  modalBg: "#ffffff",
  modalHeaderBg: "#f8fafc",
  sectionBg: "#f1f5f9",
  categoryBg: "#e2e8f0",
  itemActive: "#dbeafe",
  boxFill: "#f8fafc",
  boxFillSel: "#eff6ff",
  border: "#cbd5e1",
  borderMuted: "#e2e8f0",
  rowBorder: "#f1f5f9",
  codeBg: "#1e293b",
  wireStroke: "#1e293b",
  gridDot: "#cbd5e1",
  netLabelStroke: "#334155",
  netTagBg: "#e2e8f0",
  netTagBgSel: "#dbeafe",
  portTagBg: "#fde9c8",
  portTagBgSel: "#fcd9a4",
  netTagText: "#0f172a",
  netTagBorder: "#94a3b8",
  badgeText: "#1d4ed8",
  badgeBg: "rgba(255,255,255,0.85)",
  badgeBorder: "#bfdbfe",
  flagBg: "rgba(255,255,255,0.92)",
  flagBorder: "#93c5fd",
  flagValue: "#1d4ed8",
  importBg: "#eff6ff",
  importText: "#1d4ed8",
  localBg: "#dcfce7",
  localText: "#166534",
  tempBg: "#fef9c3",
  tempText: "#854d0e",
  serverBg: "#e0e7ff",
  serverText: "#3730a3",
};

export const darkTheme: FullTheme = {
  ...commonColors,
  text: "#e2e8f0",
  textStrong: "#e2e8f0",
  textMuted: "#94a3b8",
  heading: "#94a3b8",
  symPreview: "#cbd5e1",
  icon: "#e2e8f0",
  headerBg: "#1e293b",
  itemHover: "#334155",
  directiveBg: "rgba(15,23,42,0.85)",
  directiveBorder: "#334155",
  symStroke: "#e2e8f0",
  label: "#cbd5e1",
  value: "#94a3b8",
  canvasBg: "#0f172a",
  inputBg: "#0f172a",
  panelBg: "#1e293b",
  panelBgAlt: "#1e293b",
  modalBg: "#1e293b",
  modalHeaderBg: "#0f172a",
  sectionBg: "#0f172a",
  categoryBg: "#334155",
  itemActive: "#1e3a5f",
  boxFill: "#1e293b",
  boxFillSel: "#1e3a5f",
  border: "#475569",
  borderMuted: "#334155",
  rowBorder: "#334155",
  codeBg: "#0f172a",
  wireStroke: "#94a3b8",
  gridDot: "#334155",
  netLabelStroke: "#cbd5e1",
  netTagBg: "#334155",
  netTagBgSel: "#1e3a5f",
  portTagBg: "#4a3a24",
  portTagBgSel: "#5f4a2a",
  netTagText: "#e2e8f0",
  netTagBorder: "#475569",
  badgeText: "#93c5fd",
  badgeBg: "rgba(15,23,42,0.85)",
  badgeBorder: "#1e40af",
  flagBg: "rgba(15,23,42,0.92)",
  flagBorder: "#3b82f6",
  flagValue: "#60a5fa",
  importBg: "#1e3a5f",
  importText: "#93c5fd",
  localBg: "#14532d",
  localText: "#86efac",
  tempBg: "#713f12",
  tempText: "#fde68a",
  serverBg: "#312e81",
  serverText: "#c7d2fe",
};

/** Active theme, driven by the UI store's dark-mode flag. */
export function useTheme(): FullTheme {
  return useUIStore((s) => s.darkMode) ? darkTheme : lightTheme;
}

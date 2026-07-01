import { create } from "zustand";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";

export type ActiveTab = "schematic" | "netlist" | "oscilloscope";
export type EditorMode = "select" | "wire" | "pan" | "place";
export type DockTab = "netlist" | "simulation" | "waveform" | "log";
/** Which LTSpice symbol variant to draw: European default, ANSI, or EN. */
export type SymbolNorm = "default" | "ansi" | "en";

/** Payload describing the library entry queued for click-to-place. */
export interface PendingLibraryPlacement {
  componentType: ComponentType;
  /** Subcircuit/model name. */
  name: string;
  /** External pins for subcircuits. */
  pins?: string[];
  /** Raw `.subckt` text (subcircuits only). */
  raw?: string;
  /** Model name to assign to a typed device (models only). */
  model?: string;
}

interface UIState {
  activeTab: ActiveTab;
  editorMode: EditorMode;
  pendingPlaceType: ComponentType | null;
  pendingLibraryPlacement: PendingLibraryPlacement | null;
  /** Rotation (deg) applied to the placement ghost and the next placed part. */
  placementRotation: number;
  showPropertiesPanel: boolean;
  showComponentPalette: boolean;
  darkMode: boolean;
  showDirectiveModal: boolean;
  /** Simulation-parameter edit dialog (opened by right-clicking the directive). */
  showSimConfigDialog: boolean;
  showLibraryImport: boolean;
  dockOpen: boolean;
  dockHeight: number;
  dockTab: DockTab;
  symbolNorm: SymbolNorm;
  /** When on, clicking a component adds its branch current to the waveform probes. */
  autoProbeCurrent: boolean;
}

interface UIActions {
  setActiveTab: (tab: ActiveTab) => void;
  setEditorMode: (mode: EditorMode) => void;
  startPlacing: (type: ComponentType) => void;
  startPlacingLibrary: (placement: PendingLibraryPlacement) => void;
  cancelPlacing: () => void;
  rotatePlacement: () => void;
  togglePropertiesPanel: () => void;
  toggleComponentPalette: () => void;
  toggleDarkMode: () => void;
  toggleDirectiveModal: () => void;
  setSimConfigDialog: (open: boolean) => void;
  toggleLibraryImport: () => void;
  toggleDock: () => void;
  setDockHeight: (height: number) => void;
  setDockTab: (tab: DockTab) => void;
  setSymbolNorm: (norm: SymbolNorm) => void;
  toggleAutoProbeCurrent: () => void;
}

export const useUIStore = create<UIState & UIActions>((set) => ({
  activeTab: "schematic",
  editorMode: "select",
  pendingPlaceType: null,
  pendingLibraryPlacement: null,
  placementRotation: 0,
  showPropertiesPanel: true,
  showComponentPalette: true,
  darkMode: false,
  showDirectiveModal: false,
  showSimConfigDialog: false,
  showLibraryImport: false,
  dockOpen: true,
  dockHeight: 240,
  dockTab: "netlist",
  symbolNorm: "en",
  autoProbeCurrent: true,

  setActiveTab: (activeTab) => set({ activeTab }),
  setEditorMode: (editorMode) => set({ editorMode, pendingPlaceType: null, pendingLibraryPlacement: null }),
  startPlacing: (type) => set({ editorMode: "place", pendingPlaceType: type, pendingLibraryPlacement: null }),
  startPlacingLibrary: (placement) =>
    set({ editorMode: "place", pendingPlaceType: placement.componentType, pendingLibraryPlacement: placement }),
  cancelPlacing: () => set({ editorMode: "select", pendingPlaceType: null, pendingLibraryPlacement: null }),
  rotatePlacement: () => set((s) => ({ placementRotation: (s.placementRotation + 270) % 360 })),
  togglePropertiesPanel: () => set((s) => ({ showPropertiesPanel: !s.showPropertiesPanel })),
  toggleComponentPalette: () => set((s) => ({ showComponentPalette: !s.showComponentPalette })),
  toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),
  toggleDirectiveModal: () => set((s) => ({ showDirectiveModal: !s.showDirectiveModal })),
  setSimConfigDialog: (showSimConfigDialog) => set({ showSimConfigDialog }),
  toggleLibraryImport: () => set((s) => ({ showLibraryImport: !s.showLibraryImport })),
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),
  setDockHeight: (dockHeight) => set({ dockHeight: Math.max(120, Math.min(600, dockHeight)) }),
  setDockTab: (dockTab) => set({ dockTab, dockOpen: true }),
  setSymbolNorm: (symbolNorm) => set({ symbolNorm }),
  toggleAutoProbeCurrent: () => set((s) => ({ autoProbeCurrent: !s.autoProbeCurrent })),
}));

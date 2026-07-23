import { create } from "zustand";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";

export type ActiveTab = "schematic" | "netlist" | "oscilloscope";
/**
 * Editor modes. There is no "pan": dragging empty canvas already pans in select
 * mode, and the lock covers "navigate without touching anything" — the button was
 * a third way to do what those two already do, and it never got used.
 */
export type EditorMode = "select" | "wire" | "place";
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
  /** Custom `.asy` symbol to draw a subcircuit with (instead of the generic box). */
  symbolName?: string;
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
  showLibraryImport: boolean;
  showInsertComponent: boolean;
  dockOpen: boolean;
  dockHeight: number;
  dockTab: DockTab;
  symbolNorm: SymbolNorm;
  /** When on, clicking a component adds its branch current to the waveform probes. */
  autoProbeCurrent: boolean;
  /**
   * Canvas lock: components are pinned and the view does not pan. Lives here (not
   * in the canvas) because it has to reach every interaction — React Flow's node
   * drag, the caption drags and the connector tap-to-rotate all read it.
   */
  canvasLocked: boolean;
  /**
   * The name (net anchor) the user has hold of, or null.
   *
   * Kept here rather than on the anchor itself: a name is not a React Flow node,
   * so it is outside the selection React Flow manages — and it must not join it,
   * or "delete selection" would take a name along with the parts it happens to
   * sit near.
   */
  selectedAnchorId: string | null;
  /** The text box whose settings the properties panel shows, or null. */
  selectedTextBoxId: string | null;
  /**
   * Drag on empty canvas draws a selection rectangle instead of panning.
   *
   * Shift+drag already does this (React Flow's `selectionKeyCode` default), but
   * that needs a keyboard — and the app is used on an iPad, where it is
   * unreachable. This is the same gesture as a toggle.
   */
  areaSelect: boolean;
  /**
   * A cut/copied block riding on the cursor until it is put down, as `.asc` text.
   *
   * Separate from the clipboard on purpose: the clipboard is what makes a paste
   * into *another* schematic work, while this is the immediate "carry it and
   * click" gesture LTSpice has. A copy fills both.
   */
  pendingFragment: string | null;
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
  toggleLibraryImport: () => void;
  toggleInsertComponent: () => void;
  toggleDock: () => void;
  setDockHeight: (height: number) => void;
  setDockTab: (tab: DockTab) => void;
  setSymbolNorm: (norm: SymbolNorm) => void;
  toggleAutoProbeCurrent: () => void;
  toggleCanvasLocked: () => void;
  setSelectedAnchorId: (id: string | null) => void;
  setSelectedTextBoxId: (id: string | null) => void;
  toggleAreaSelect: () => void;
  setPendingFragment: (text: string | null) => void;
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
  showLibraryImport: false,
  showInsertComponent: false,
  dockOpen: true,
  dockHeight: 240,
  dockTab: "netlist",
  symbolNorm: "en",
  autoProbeCurrent: true,
  canvasLocked: false,
  selectedAnchorId: null,
  selectedTextBoxId: null,
  areaSelect: false,
  pendingFragment: null,

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
  toggleLibraryImport: () => set((s) => ({ showLibraryImport: !s.showLibraryImport })),
  toggleInsertComponent: () => set((s) => ({ showInsertComponent: !s.showInsertComponent })),
  toggleDock: () => set((s) => ({ dockOpen: !s.dockOpen })),
  setDockHeight: (dockHeight) => set({ dockHeight: Math.max(120, Math.min(600, dockHeight)) }),
  setDockTab: (dockTab) => set({ dockTab, dockOpen: true }),
  setSymbolNorm: (symbolNorm) => set({ symbolNorm }),
  toggleAutoProbeCurrent: () => set((s) => ({ autoProbeCurrent: !s.autoProbeCurrent })),
  toggleCanvasLocked: () => set((s) => ({ canvasLocked: !s.canvasLocked })),
  setSelectedAnchorId: (selectedAnchorId) => set({ selectedAnchorId, selectedTextBoxId: null }),
  setSelectedTextBoxId: (selectedTextBoxId) => set({ selectedTextBoxId, selectedAnchorId: null }),
  toggleAreaSelect: () => set((s) => ({ areaSelect: !s.areaSelect })),
  setPendingFragment: (pendingFragment) => set({ pendingFragment }),
}));

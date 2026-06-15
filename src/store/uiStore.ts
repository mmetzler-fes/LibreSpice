import { create } from "zustand";
import type { ComponentType } from "@editor/nodes/ComponentNode.js";

export type ActiveTab = "schematic" | "netlist" | "oscilloscope";
export type EditorMode = "select" | "wire" | "pan" | "place";

interface UIState {
  activeTab: ActiveTab;
  editorMode: EditorMode;
  pendingPlaceType: ComponentType | null;
  showPropertiesPanel: boolean;
  showComponentPalette: boolean;
  darkMode: boolean;
  showDirectiveModal: boolean;
}

interface UIActions {
  setActiveTab: (tab: ActiveTab) => void;
  setEditorMode: (mode: EditorMode) => void;
  startPlacing: (type: ComponentType) => void;
  cancelPlacing: () => void;
  togglePropertiesPanel: () => void;
  toggleComponentPalette: () => void;
  toggleDarkMode: () => void;
  toggleDirectiveModal: () => void;
}

export const useUIStore = create<UIState & UIActions>((set) => ({
  activeTab: "schematic",
  editorMode: "select",
  pendingPlaceType: null,
  showPropertiesPanel: true,
  showComponentPalette: true,
  darkMode: false,
  showDirectiveModal: false,

  setActiveTab: (activeTab) => set({ activeTab }),
  setEditorMode: (editorMode) => set({ editorMode, pendingPlaceType: null }),
  startPlacing: (type) => set({ editorMode: "place", pendingPlaceType: type }),
  cancelPlacing: () => set({ editorMode: "select", pendingPlaceType: null }),
  togglePropertiesPanel: () => set((s) => ({ showPropertiesPanel: !s.showPropertiesPanel })),
  toggleComponentPalette: () => set((s) => ({ showComponentPalette: !s.showComponentPalette })),
  toggleDarkMode: () => set((s) => ({ darkMode: !s.darkMode })),
  toggleDirectiveModal: () => set((s) => ({ showDirectiveModal: !s.showDirectiveModal })),
}));

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
  /**
   * Default instance parameters from that symbol's `SYMATTR SpiceLine`
   * (`Rtot=10k wiper=0.5`). Carried so a freshly placed part arrives with the
   * values its symbol advertises, rather than with an empty Parameter field the
   * user has to guess the parameter *names* for.
   */
  params?: string;
}

interface UIState {
  activeTab: ActiveTab;
  editorMode: EditorMode;
  pendingPlaceType: ComponentType | null;
  pendingLibraryPlacement: PendingLibraryPlacement | null;
  /**
   * A text box is waiting for the point it goes down at.
   *
   * An add-on to the select mode rather than an `editorMode` of its own: a note
   * is not a part, and switching modes for it took the rubber band away and
   * turned a drag into a pan. The mode stays what it was; only the next click on
   * the sheet means something else.
   */
  pendingTextBox: boolean;
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
   * The names (net anchors) the user has hold of.
   *
   * Kept here rather than on the anchor itself: a name is not a React Flow node,
   * so it is outside the selection React Flow manages and has to be tracked
   * beside it.
   *
   * It used to be a single id, and outside the selection on purpose — the worry
   * being that "delete selection" would take a name along with the parts it
   * happens to sit *near*. That worry is answered by making the selection
   * explicit rather than by keeping names out of it: a name joins only when the
   * rubber band actually caught its tag, or when it was clicked. Nothing is
   * selected by proximity, so nothing is deleted by proximity either.
   *
   * A list, because a rubber band across a block catches several at once, and
   * because that block then has to move as one.
   */
  selectedAnchorIds: string[];
  /** The text box whose settings the properties panel shows, or null. */
  selectedTextBoxId: string | null;
  /**
   * The text box whose text is open for typing, or null.
   *
   * Here rather than inside the layer that draws the boxes, because a box that
   * was just put down has to arrive with its editor open — and the placement
   * happens on the canvas, a component away.
   */
  editingTextBoxId: string | null;
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
  /** Arm the text tool: the next click on the sheet puts a note down there. */
  startPlacingTextBox: () => void;
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
  /** Select exactly this name, or clear the selection with `null`. */
  setSelectedAnchorId: (id: string | null) => void;
  /** Replace the whole name selection — what the rubber band hands over. */
  setSelectedAnchorIds: (ids: string[]) => void;
  /** Add or remove one name, for a shift-click on top of an existing selection. */
  toggleSelectedAnchorId: (id: string) => void;
  setSelectedTextBoxId: (id: string | null) => void;
  /** Open (or close, with `null`) a text box for typing. */
  setEditingTextBoxId: (id: string | null) => void;
  toggleAreaSelect: () => void;
  setPendingFragment: (text: string | null) => void;
}

export const useUIStore = create<UIState & UIActions>((set) => ({
  activeTab: "schematic",
  editorMode: "select",
  pendingPlaceType: null,
  pendingLibraryPlacement: null,
  pendingTextBox: false,
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
  selectedAnchorIds: [],
  selectedTextBoxId: null,
  editingTextBoxId: null,
  areaSelect: false,
  pendingFragment: null,

  setActiveTab: (activeTab) => set({ activeTab }),
  setEditorMode: (editorMode) => set({ editorMode, pendingPlaceType: null, pendingLibraryPlacement: null, pendingTextBox: false }),
  startPlacing: (type) => set({ editorMode: "place", pendingPlaceType: type, pendingLibraryPlacement: null, pendingTextBox: false }),
  startPlacingLibrary: (placement) =>
    set({ editorMode: "place", pendingPlaceType: placement.componentType, pendingLibraryPlacement: placement, pendingTextBox: false }),
  // Bleibt im Auswahlmodus: das Textwerkzeug ist ein Aufsatz, kein eigener
  // Modus. Als "place" nahm es dem Auswahlmodus das Gummiband weg und machte
  // aus dem Ziehen ein Schwenken — der Knopf sah aus, als hätte er den Modus
  // gewechselt, und die Fläche verhielt sich auch so.
  startPlacingTextBox: () =>
    set({ editorMode: "select", pendingPlaceType: null, pendingLibraryPlacement: null, pendingTextBox: true }),
  cancelPlacing: () => set({ editorMode: "select", pendingPlaceType: null, pendingLibraryPlacement: null, pendingTextBox: false }),
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
  setSelectedAnchorId: (id) => set({ selectedAnchorIds: id ? [id] : [], selectedTextBoxId: null, editingTextBoxId: null }),
  setSelectedAnchorIds: (selectedAnchorIds) =>
    set({ selectedAnchorIds, ...(selectedAnchorIds.length ? { selectedTextBoxId: null, editingTextBoxId: null } : {}) }),
  toggleSelectedAnchorId: (id) =>
    set((s) => ({
      selectedAnchorIds: s.selectedAnchorIds.includes(id)
        ? s.selectedAnchorIds.filter((x) => x !== id)
        : [...s.selectedAnchorIds, id],
      selectedTextBoxId: null,
      editingTextBoxId: null,
    })),
  // Selecting a different box (or nothing) closes whatever editor was open —
  // otherwise a note left in edit mode would keep swallowing the keyboard.
  setSelectedTextBoxId: (selectedTextBoxId) =>
    set((s) => ({
      selectedTextBoxId,
      selectedAnchorIds: [],
      editingTextBoxId: s.editingTextBoxId === selectedTextBoxId ? s.editingTextBoxId : null,
    })),
  setEditingTextBoxId: (editingTextBoxId) => set({ editingTextBoxId }),
  toggleAreaSelect: () => set((s) => ({ areaSelect: !s.areaSelect })),
  setPendingFragment: (pendingFragment) => set({ pendingFragment }),
}));

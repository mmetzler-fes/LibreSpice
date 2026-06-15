import type { ComponentType } from "./nodes/ComponentNode.js";

export interface ComponentDefinition {
  type: ComponentType;
  label: string;
  category: string;
  defaultLabel: string;
  description: string;
}

export const COMPONENT_DEFINITIONS: ComponentDefinition[] = [
  { type: "resistor", label: "Resistor", category: "Passives", defaultLabel: "R1", description: "Resistor (R)" },
  { type: "capacitor", label: "Capacitor", category: "Passives", defaultLabel: "C1", description: "Capacitor (C)" },
  { type: "inductor", label: "Inductor", category: "Passives", defaultLabel: "L1", description: "Inductor (L)" },
  { type: "diode", label: "Diode", category: "Semiconductors", defaultLabel: "D1", description: "Diode (D)" },
  { type: "led", label: "LED", category: "Semiconductors", defaultLabel: "D2", description: "Light Emitting Diode" },
  { type: "bjt_npn", label: "NPN BJT", category: "Semiconductors", defaultLabel: "Q1", description: "NPN Bipolar Junction Transistor" },
  { type: "bjt_pnp", label: "PNP BJT", category: "Semiconductors", defaultLabel: "Q2", description: "PNP Bipolar Junction Transistor" },
  { type: "mosfet_n", label: "NMOS", category: "Semiconductors", defaultLabel: "M1", description: "N-Channel MOSFET" },
  { type: "mosfet_p", label: "PMOS", category: "Semiconductors", defaultLabel: "M2", description: "P-Channel MOSFET" },
  { type: "vsource", label: "V Source", category: "Sources", defaultLabel: "V1", description: "Voltage Source" },
  { type: "isource", label: "I Source", category: "Sources", defaultLabel: "I1", description: "Current Source" },
  { type: "sinesource", label: "Sin Source", category: "Sources", defaultLabel: "V2", description: "Sinusoidal Voltage Source" },
  { type: "pulsesource", label: "Pulse", category: "Sources", defaultLabel: "V3", description: "Pulse Voltage Source" },
  { type: "ground", label: "Ground", category: "Special", defaultLabel: "GND", description: "Ground reference (node 0)" },
];

export const CATEGORIES = ["Passives", "Semiconductors", "Sources", "Special"];

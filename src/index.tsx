import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";
import { hydrateSourceFiles } from "./store/sourceFileStore.js";

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

// Source files (WAV/text) loaded in earlier sessions.
void hydrateSourceFiles();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

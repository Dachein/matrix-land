import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MatePreviewApp } from "./App";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode><MatePreviewApp /></StrictMode>
);

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MatePreviewApp } from "./App";
import "../../../src/portal/design-system/styles";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode><MatePreviewApp /></StrictMode>
);

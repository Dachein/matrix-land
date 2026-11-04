import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  publicDir: fileURLToPath(new URL("../../public", import.meta.url)),
  plugins: [react()],
  resolve: {
    alias: {
      "@frontier-workspace/mate": fileURLToPath(new URL("../../sdk/mate/dist/index.js", import.meta.url))
    }
  },
  build: {
    emptyOutDir: true,
    outDir: "dist",
    sourcemap: false,
    target: "es2022"
  },
  server: { host: "0.0.0.0", port: 5191, strictPort: true }
});

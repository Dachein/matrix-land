import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  publicDir: new URL("../../public", import.meta.url).pathname,
  plugins: [react()],
  resolve: {
    alias: {
      "@frontier-workspace/mate": new URL("../../sdk/mate/dist/index.js", import.meta.url).pathname
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

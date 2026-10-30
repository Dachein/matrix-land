import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "apps/portal",
  publicDir: "../../public",
  build: {
    assetsDir: "_build",
    emptyOutDir: true,
    outDir: "../../dist",
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }

          if (id.includes("/lucide-react/")) {
            return "vendor-icons";
          }

          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
            return "vendor-react";
          }

          return undefined;
        }
      }
    }
  },
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5174
  }
});

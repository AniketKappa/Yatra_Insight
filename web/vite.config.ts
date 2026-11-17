import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

// Open Graph needs absolute URLs. Set SITE_URL when deploying (e.g. SITE_URL=https://yatra.example.gov.in npm run build).
process.env.VITE_SITE_URL = (process.env.SITE_URL || process.env.VITE_SITE_URL || "http://localhost:8787").replace(/\/+$/, "");

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.API_PORT || 8787}`, changeOrigin: true } },
  },
  build: { outDir: path.join(root, "dist"), emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 600 },
});

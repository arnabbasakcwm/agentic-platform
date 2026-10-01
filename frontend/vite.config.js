import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    // Unit tests for pure logic; the browser-level checks live in e2e/ (Playwright).
    include: ["src/**/*.test.{js,jsx}"],
    environment: "node",
  },
  server: {
    port: 5173,
    // Proxying keeps the browser on one origin in dev, so the console works even if the
    // API's CORS allow-list changes. VITE_API_BASE overrides it for a non-local API.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});

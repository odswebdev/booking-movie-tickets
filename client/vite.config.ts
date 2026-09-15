import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const apiTarget = env.VITE_API_URL || "http://localhost:4000";
  /**
   * GitHub Pages serves the site from /movie-tickets/, but local dev and
   * preview builds stay at "/" so relative links behave naturally.
   */
  const base = mode === "production" ? env.VITE_BASE || "/movie-tickets/" : "/";

  return {
    base,
    plugins: [
      react(),
      tailwindcss(),
      {
        // Fills the SPA fallback with the real base path (see public/404.html).
        name: "spa-404-fallback",
        enforce: "post",
        transformIndexHtml: {
          order: "post",
          handler(html) {
            return html.replaceAll("%BASE%", base);
          },
        },
        closeBundle() {
          const dist = path.resolve(dirname, "dist");
          const file = path.join(dist, "404.html");
          if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, "utf8").replaceAll("%BASE%", base);
            fs.writeFileSync(file, content);
          }
        },
      },
    ],
    resolve: {
      alias: {
        "@": path.resolve(dirname, "src"),
        "@shared": path.resolve(dirname, "../shared"),
      },
    },
    // Pre-bundle every runtime dep at server start. Without this, Vite
    // discovers lazily-imported deps mid-session and forces a full page
    // reload ("new dependencies optimized") — which wipes form state during
    // E2E runs and slows the first dev load.
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-router-dom",
        "@tanstack/react-query",
        "react-hook-form",
        "@hookform/resolvers/zod",
        "i18next",
        "react-i18next",
        "i18next-browser-languagedetector",
        "leaflet",
        "framer-motion",
        "lucide-react",
        "qrcode",
        "zod",
      ],
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: false,
      // Sandboxed preview environments (and tunnels) use arbitrary hostnames.
      allowedHosts: true,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
      },
      fs: { allow: [".."] },
    },
    preview: {
      host: "0.0.0.0",
      port: 4173,
      allowedHosts: true,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: "dist",
      sourcemap: mode !== "production",
      chunkSizeWarningLimit: 800,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ["react", "react-dom", "react-router-dom"],
            motion: ["framer-motion"],
          },
        },
      },
    },
    test: {
      environment: "jsdom",
      globals: true,
      setupFiles: ["./src/test/setup.ts"],
      css: false,
      restoreMocks: true,
      // Playwright specs live in e2e/ and run via `npm run test:e2e`, not vitest.
      exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    },
  };
});

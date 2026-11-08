import { defineConfig, defaultClientConditions } from "vite";
import { resolve } from "node:path";

// Built into dashboard/app_dist and served by plugin_api.py at /api/plugins/fieldkit/app/.
// base "./" keeps every asset URL relative so the app works under any mount prefix.
export default defineConfig({
  root: resolve(import.meta.dirname),
  base: "./",
  publicDir: resolve(import.meta.dirname, "public"),
  resolve: {
    // onnxruntime-web's documented export condition for an external WASM binary: the bundle carries no
    // .wasm; Transformers.js points ONNX Runtime at the pinned jsDelivr copy, fetched + cached at setup.
    conditions: ["onnxruntime-web-use-extern-wasm", ...defaultClientConditions],
  },
  build: {
    outDir: resolve(import.meta.dirname, "../dashboard/app_dist"),
    emptyOutDir: true,
    target: "es2020",
    sourcemap: false,
    // esbuild keeps quoted strings; the default minifier rewrites them as template literals, which can create
    // "!`" sequences that Hermes' install scanner flags (inline_shell_exec). See scripts/postbuild-app.mjs.
    minify: "esbuild",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      input: resolve(import.meta.dirname, "index.html"),
    },
  },
  worker: { format: "es" },
  server: { port: 5173 },
});

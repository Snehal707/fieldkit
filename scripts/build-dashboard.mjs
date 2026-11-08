// Bundle the dashboard tab into a single IIFE (React comes from the Hermes plugin SDK at runtime).
import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
mkdirSync(join(root, "dashboard/dist"), { recursive: true });
await build({
  entryPoints: [join(root, "dashboard/src/index.ts")],
  outfile: join(root, "dashboard/dist/index.js"),
  bundle: true, format: "iife", target: "es2019", minify: false, legalComments: "inline",
  banner: { js: "/* FieldKit dashboard plugin — built from dashboard/src/index.ts. React is provided by window.__HERMES_PLUGIN_SDK__. */" },
});
copyFileSync(join(root, "dashboard/src/style.css"), join(root, "dashboard/dist/style.css"));
console.log("dashboard/dist/index.js written");

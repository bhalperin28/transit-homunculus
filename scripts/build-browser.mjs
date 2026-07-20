import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "docs", "assets", "vendor");

// The worker runs the whole pipeline off the main thread; it's a plain
// self-executing script (no module scope needed since it's loaded as a
// classic Worker script, which keeps browser Worker-loading simple).
await build({
  entryPoints: [path.join(root, "src", "browser", "worker.ts")],
  bundle: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  outfile: path.join(outDir, "generate-worker.js"),
  minify: false,
});

// The main-thread library (search + spinning up the worker) is exposed as
// a global `TH` for the plain <script> tags on the static pages to use.
await build({
  entryPoints: [path.join(root, "src", "browser", "lib.ts")],
  bundle: true,
  format: "iife",
  globalName: "TH",
  target: "es2020",
  platform: "browser",
  outfile: path.join(outDir, "generate-lib.js"),
  minify: false,
});

console.log(`Built browser bundles into ${path.relative(root, outDir)}/`);

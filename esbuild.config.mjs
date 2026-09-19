// Build script for the Antigravity CLI Obsidian plugin.
// Bundles src/main.ts -> main.js (CommonJS) with esbuild, mirroring the
// hermes-agent plugin. Node builtins stay external because Obsidian runs the
// plugin in an Electron renderer with Node integration, so require("child_process")
// resolves at runtime.
import esbuild from "esbuild";

const production = process.argv[2] === "production";

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2018",
  platform: "node",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: "main.js",
  external: [
    "obsidian",
    "electron",
    "child_process",
    "fs",
    "os",
    "path",
    "readline",
    "timers",
    "crypto",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common"
  ]
});

if (production) {
  await context.rebuild();
  await context.dispose();
  process.exit(0);
} else {
  await context.watch();
  console.log("[antigravity-cli] watching for changes...");
}

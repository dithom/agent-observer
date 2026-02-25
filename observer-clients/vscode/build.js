const esbuild = require("esbuild");
const { copyFileSync, mkdirSync, existsSync } = require("fs");
const { join } = require("path");

const serverDist = join(__dirname, "../../server/dist/server.js");
const outDir = join(__dirname, "dist");

async function build() {
  await esbuild.build({
    entryPoints: ["src/extension.ts"],
    bundle: true,
    platform: "node",
    target: "node18",
    outfile: "dist/extension.js",
    format: "cjs",
    sourcemap: true,
    external: ["vscode"],
  });

  // Copy server bundle as asset
  mkdirSync(outDir, { recursive: true });
  if (existsSync(serverDist)) {
    copyFileSync(serverDist, join(outDir, "server.js"));
    console.log("Copied server.js to dist/");
  } else {
    console.warn("Warning: server/dist/server.js not found. Build the server first.");
  }

  console.log("Extension built successfully");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});

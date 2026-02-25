const esbuild = require("esbuild");

esbuild
  .build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    target: "node18",
    outfile: "dist/server.js",
    format: "cjs",
    sourcemap: true,
  })
  .then(() => console.log("Server built successfully"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

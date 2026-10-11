// Bundle the server (workspace packages inlined; npm dependencies stay external).
import { build } from "esbuild";
import { readFileSync, cpSync, existsSync, mkdirSync } from "node:fs";

const deps = new Set();
for (const p of ["apps/server", "packages/core", "packages/db", "packages/wa", "packages/ai"]) {
  const pkg = JSON.parse(readFileSync(`${p}/package.json`, "utf8"));
  for (const d of Object.keys(pkg.dependencies ?? {})) deps.add(d);
}
await build({
  entryPoints: ["apps/server/src/main.ts"],
  bundle: true, platform: "node", format: "esm", target: "node24", outfile: "apps/server/dist/main.js",
  external: [...deps],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  sourcemap: true, logLevel: "info",
});
if (existsSync("apps/server/src/privacy.html")) { mkdirSync("apps/server/dist", { recursive: true }); cpSync("apps/server/src/privacy.html", "apps/server/dist/privacy.html"); }

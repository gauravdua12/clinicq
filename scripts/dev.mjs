// Dev: build the dashboard once (static export), then run the server with live reload.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("apps/web/out") || process.argv.includes("--web")) {
  spawnSync("npx", ["next", "build"], { cwd: "apps/web", stdio: "inherit", env: { ...process.env, NEXT_PUBLIC_DEV_TOOLS: "1" } });
}
const p = spawn("npx", ["tsx", "watch", "--clear-screen=false", "apps/server/src/main.ts"], { stdio: "inherit" });
p.on("exit", (c) => process.exit(c ?? 0));

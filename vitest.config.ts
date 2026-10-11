import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["packages/*/test/**/*.test.ts", "apps/server/test/unit/**/*.test.ts"] } },
      { test: { name: "integration", include: ["apps/server/test/integration/**/*.test.ts"], fileParallelism: false, setupFiles: ["apps/server/test/setup-env.ts"], testTimeout: 20000 } },
      { test: { name: "e2e", include: ["apps/server/test/e2e/**/*.test.ts"], fileParallelism: false, setupFiles: ["apps/server/test/setup-env.ts"], testTimeout: 30000 } },
      { test: { name: "boundary", include: ["apps/server/test/boundary/**/*.test.ts"], fileParallelism: false, setupFiles: ["apps/server/test/setup-env.ts"], testTimeout: 60000 } },
    ],
  },
});

import { defineConfig, devices } from "@playwright/test";

// UI tests drive the installed Google Chrome (no browser download) against a server on :8095
// using its own database (clinicq_ui), deterministic rules extraction and the mock WhatsApp.
const PORT = 8095;
export default defineConfig({
  testDir: "apps/web/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  outputDir: "test-results/ui/artifacts", // Playwright empties this folder each run; keep it away from the UAT/load reports
  reporter: [["list"], ["json", { outputFile: "test-results/ui/results.json" }]],
  use: { baseURL: `http://localhost:${PORT}`, channel: "chrome", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome", viewport: { width: 1366, height: 860 } }, testIgnore: /mobile\.spec\.ts/ },
    { name: "mobile", use: { ...devices["Pixel 7"], channel: "chrome" }, testMatch: /mobile\.spec\.ts/ },
  ],
  webServer: {
    command: "npx tsx apps/server/src/main.ts",
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT), NODE_ENV: "development", DATABASE_URL: "postgresql://clinicq@localhost:5432/clinicq_ui",
      DEV_TOOLS: "true", DEMO_STUDIO: "true", WA_MODE: "mock", EXTRACTOR_PRIMARY: "rules", EXTRACTOR_ESCALATION: "", STT_PROVIDER: "mock", STT_FALLBACK: "",
      WA_DISPLAY_NUMBER: "919920323832", DEMO_PRESENTER_PHONES: "", JOB_POLL_MS: "2000", BASE_PATH: "", WA_FLOW_ID_BOOKING: "", FLOW_PRIVATE_KEY_PATH: "",
    },
  },
  globalSetup: "./apps/web/e2e/global-setup.ts",
});

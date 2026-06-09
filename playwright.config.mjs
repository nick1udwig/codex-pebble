import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/config-page/e2e",
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node scripts/serve-config-page.mjs --port 4173",
    port: 4173,
    reuseExistingServer: true,
    timeout: 10_000,
  },
});

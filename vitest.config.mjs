import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      codex_rpc: resolve(rootDir, "src/embeddedjs/codex_rpc.js"),
      "commodetto/Poco": resolve(rootDir, "tests/js/mocks/commodetto/Poco.js"),
      dashboard: resolve(rootDir, "src/embeddedjs/views/dashboard.js"),
      detail: resolve(rootDir, "src/embeddedjs/views/detail.js"),
      dictation: resolve(rootDir, "src/embeddedjs/dictation.js"),
      jobs: resolve(rootDir, "src/embeddedjs/jobs.js"),
      "pebble/button": resolve(rootDir, "tests/js/mocks/pebble/button.js"),
      "pebble/dictation": resolve(rootDir, "tests/js/mocks/pebble/dictation.js"),
      "pebble/message": resolve(rootDir, "tests/js/mocks/pebble/message.js"),
      settings_needed: resolve(rootDir, "src/embeddedjs/views/settings_needed.js"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/js/**/*.test.js"],
    reporters: "default",
  },
});

import { defineConfig } from "vitest/config";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "commodetto/Poco": resolve(rootDir, "tests/js/mocks/commodetto/Poco.js"),
      "pebble/button": resolve(rootDir, "tests/js/mocks/pebble/button.js"),
      "pebble/dictation": resolve(rootDir, "tests/js/mocks/pebble/dictation.js"),
      "pebble/message": resolve(rootDir, "tests/js/mocks/pebble/message.js"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/js/**/*.test.js"],
    reporters: "default",
  },
});

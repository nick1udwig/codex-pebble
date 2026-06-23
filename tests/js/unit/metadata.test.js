import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
);
const appinfoJson = JSON.parse(
  readFileSync(new URL("../../../appinfo.json", import.meta.url), "utf8"),
);
const iconSvg = readFileSync(
  new URL("../../../assets/codex-jobs-icon.svg", import.meta.url),
  "utf8",
);
const terminalIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" viewBox="0 0 50 50">
  <g fill="none" stroke="#000" stroke-linecap="square" stroke-linejoin="miter">
    <path d="M9.5 8.5H40.5L43.5 11.5V39.5L40.5 42.5H9.5L6.5 39.5V11.5Z" fill="#fff" stroke-width="3"/>
    <path d="M8.5 17.5H41.5" stroke-width="3"/>
    <path d="M17.5 24.5L24.5 31.5L17.5 38.5" stroke-width="3"/>
    <path d="M29.5 37.5H37.5" stroke-width="3"/>
  </g>
</svg>`;

describe("publication metadata", () => {
  it("keeps appinfo.json aligned with the Pebble package metadata", () => {
    expect(appinfoJson.uuid).toBe(packageJson.pebble.uuid);
    expect(appinfoJson.shortName).toBe(packageJson.pebble.displayName);
    expect(appinfoJson.longName).toBe(packageJson.pebble.displayName);
    expect(appinfoJson.companyName).toBe(packageJson.author);
    expect(appinfoJson.versionLabel).toBe(packageJson.version);
    expect(appinfoJson.sdkVersion).toBe(packageJson.pebble.sdkVersion);
    expect(appinfoJson.projectType).toBe("native");
    expect(appinfoJson.watchapp).toEqual(packageJson.pebble.watchapp);
    expect(appinfoJson.capabilities).toEqual(packageJson.pebble.capabilities);
    expect(appinfoJson.targetPlatforms).toEqual(packageJson.pebble.targetPlatforms);
    expect(appinfoJson.appKeys).toEqual(packageJson.pebble.messageKeys);
    expect(appinfoJson.resources).toEqual(packageJson.pebble.resources);
  });

  it("uses the Rebble terminal SVG as the source app icon", () => {
    expect(iconSvg.trim()).toBe(terminalIconSvg.trim());
  });

  it("advertises the Go sidecar as the development relay path", () => {
    expect(packageJson.scripts["dev:sidecar"]).toBe("go run ./cmd/codex-pebble-sidecar");
    expect(packageJson.scripts).not.toHaveProperty("dev:relay");
  });
});

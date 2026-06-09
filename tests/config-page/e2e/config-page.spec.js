import { expect, test } from "@playwright/test";

async function installBridge(page) {
  await page.addInitScript(() => {
    window.__submitted = [];
    window.PebbleConfigBridge = {
      submit(payload) {
        window.__submitted.push(payload);
      },
    };
  });
}

test.beforeEach(async ({ page }) => {
  await installBridge(page);
});

test("loads embedded settings and submits sanitized settings", async ({ page }) => {
  const settings = encodeURIComponent(JSON.stringify({
    wsUrl: " ws://codex-host.tailnet-name.ts.net:4500 ",
    displayLimit: 5,
    recentCompletionLookbackMinutes: 1440,
  }));

  await page.goto(`/?settings=${settings}`);

  await expect(page.locator("#wsUrl")).toHaveValue("ws://codex-host.tailnet-name.ts.net:4500");
  await expect(page.locator("#displayLimit")).toHaveValue("5");
  await expect(page.locator("#recentCompletionLookbackMinutes")).toHaveValue("1440");

  await page.fill("#wsUrl", "wss://codex.example.ts.net:4500");
  await page.fill("#displayLimit", "99");
  await page.fill("#recentCompletionLookbackMinutes", "1");
  await page.click("#save-settings");

  await expect(page.locator("#status-banner")).toHaveText("Closing to save settings.");

  const submitted = await page.evaluate(() => window.__submitted);
  expect(submitted).toContainEqual({
    wsUrl: "wss://codex.example.ts.net:4500",
    displayLimit: 8,
    recentCompletionLookbackMinutes: 5,
  });
});

test("rejects non-websocket URLs without closing", async ({ page }) => {
  await page.goto("/");

  await page.fill("#wsUrl", "https://codex.example.ts.net:4500");
  await page.click("#save-settings");

  await expect(page.locator("#status-banner")).toHaveText("Enter a ws:// or wss:// URL.");
  await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "error");

  const submitted = await page.evaluate(() => window.__submitted);
  expect(submitted).toEqual([]);
});

test("persists settings locally without storing credentials", async ({ page }) => {
  await page.goto("/");
  await page.fill("#wsUrl", "ws://codex-host.tailnet-name.ts.net:4500");
  await page.fill("#displayLimit", "4");
  await page.fill("#recentCompletionLookbackMinutes", "720");
  await page.click("#save-settings");

  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("codex_jobs:config_state")));
  expect(stored).toEqual({
    wsUrl: "ws://codex-host.tailnet-name.ts.net:4500",
    displayLimit: 4,
    recentCompletionLookbackMinutes: 720,
  });
  expect(JSON.stringify(stored)).not.toContain("OpenAI");
});

test("uses emulator return_to callback when no bridge is injected", async ({ browser }) => {
  const page = await browser.newPage();
  const returnTo = "http://localhost:12345/close?";
  const settings = encodeURIComponent(JSON.stringify({
    wsUrl: "",
    displayLimit: 3,
    recentCompletionLookbackMinutes: 720,
  }));
  let callbackUrl = "";

  await page.route(/http:\/\/localhost:12345\/close\?.*/, async route => {
    callbackUrl = route.request().url();
    await route.fulfill({ status: 200, body: "OK" });
  });

  await page.goto(`/?v=20260609-return-to&settings=${settings}&return_to=${encodeURIComponent(returnTo)}`);
  await page.fill("#wsUrl", "ws://127.0.0.1:4500");
  await page.fill("#displayLimit", "3");
  await page.fill("#recentCompletionLookbackMinutes", "720");

  await Promise.all([
    page.waitForURL(url => url.href.startsWith(returnTo)),
    page.click("#save-settings"),
  ]);

  expect(decodeURIComponent(callbackUrl.slice(returnTo.length))).toBe(JSON.stringify({
    wsUrl: "ws://127.0.0.1:4500",
    displayLimit: 3,
    recentCompletionLookbackMinutes: 720,
  }));

  await page.close();
});

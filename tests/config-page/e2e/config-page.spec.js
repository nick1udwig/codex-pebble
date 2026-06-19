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
    wsUrl: " ws://codex-relay.tailnet-name.ts.net:4501 ",
    displayLimit: 5,
  }));

  await page.goto(`/?settings=${settings}`);

  await expect(page.locator("#wsUrl")).toHaveValue("ws://codex-relay.tailnet-name.ts.net:4501");
  await expect(page.locator("#displayLimit")).toHaveValue("5");

  await page.fill("#wsUrl", "wss://codex.example.ts.net:4500");
  await page.fill("#displayLimit", "99");
  await page.click("#save-settings");

  await expect(page.locator("#status-banner")).toHaveText("Closing to save settings.");

  const submitted = await page.evaluate(() => window.__submitted);
  expect(submitted).toContainEqual({
    wsUrl: "wss://codex.example.ts.net:4500",
    displayLimit: 8,
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
  await page.fill("#wsUrl", "ws://codex-relay.tailnet-name.ts.net:4501");
  await page.fill("#displayLimit", "4");
  await page.click("#save-settings");

  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("codex_jobs:config_state")));
  expect(stored).toEqual({
    wsUrl: "ws://codex-relay.tailnet-name.ts.net:4501",
    displayLimit: 4,
  });
  expect(JSON.stringify(stored)).not.toContain("OpenAI");
});

test("shows a warning when settings save locally but bridge submit fails", async ({ browser }) => {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.PebbleConfigBridge = {
      submit() {
        throw new Error("bridge unavailable");
      },
    };
  });

  await page.goto("/");
  await page.fill("#wsUrl", "ws://codex-relay.tailnet-name.ts.net:4501");
  await page.fill("#displayLimit", "4");
  await page.click("#save-settings");

  await expect(page.locator("#status-banner")).toHaveText("Settings saved locally, but watch was not notified.");
  await expect(page.locator("#status-banner")).toHaveAttribute("data-kind", "error");
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("codex_jobs:config_state")));
  expect(stored).toEqual({
    wsUrl: "ws://codex-relay.tailnet-name.ts.net:4501",
    displayLimit: 4,
  });

  await page.close();
});

test("uses emulator return_to callback when no bridge is injected", async ({ browser }) => {
  const page = await browser.newPage();
  const returnTo = "http://localhost:12345/close?";
  const settings = encodeURIComponent(JSON.stringify({
    wsUrl: "",
    displayLimit: 3,
  }));
  let callbackUrl = "";

  await page.route(/http:\/\/localhost:12345\/close\?.*/, async route => {
    callbackUrl = route.request().url();
    await route.fulfill({ status: 200, body: "OK" });
  });

  await page.goto(`/?v=20260609-return-to&settings=${settings}&return_to=${encodeURIComponent(returnTo)}`);
  await page.fill("#wsUrl", "ws://127.0.0.1:4501");
  await page.fill("#displayLimit", "3");

  await Promise.all([
    page.waitForURL(url => url.href.startsWith(returnTo)),
    page.click("#save-settings"),
  ]);

  expect(decodeURIComponent(callbackUrl.slice(returnTo.length))).toBe(JSON.stringify({
    wsUrl: "ws://127.0.0.1:4501",
    displayLimit: 3,
  }));

  await page.close();
});

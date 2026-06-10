import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(new URL("../../../src/pkjs/index.js", import.meta.url), "utf8");

describe("native C PKJS bridge", () => {
  it("opens the hosted config page with saved settings", () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 4,
        recentCompletionLookbackMinutes: 120,
      }),
    });

    harness.listeners.showConfiguration({});

    const url = harness.openedUrls[0];
    expect(url).toMatch(/^https:\/\/nick1udwig\.github\.io\/codex-pebble\/config\/\?/);
    expect(new URL(url).searchParams.get("v")).toBe("20260609-return-to");
    expect(JSON.parse(decodeURIComponent(new URL(url).searchParams.get("settings")))).toEqual({
      wsUrl: "ws://127.0.0.1:4501",
      displayLimit: 4,
      recentCompletionLookbackMinutes: 120,
    });
  });

  it("stores sanitized webview settings and tells the watch settings exist", () => {
    const harness = loadPkjs();
    harness.listeners.webviewclosed({
      response: encodeURIComponent(JSON.stringify({
        wsUrl: "",
        displayLimit: 99,
        recentCompletionLookbackMinutes: 1,
      })),
    });

    expect(JSON.parse(harness.localStorage.getItem("codexJobsSettings"))).toEqual({
      wsUrl: "",
      displayLimit: 8,
      recentCompletionLookbackMinutes: 5,
    });
    expect(harness.sentMessages.at(-2)).toMatchObject({
      0: "settings_state",
      1: "0|",
    });
    expect(harness.sentMessages.at(-1)).toMatchObject({
      0: "sync_status",
      1: "Set server URL",
      3: 0,
    });
  });

  it("opens config when the C app asks for it", () => {
    const harness = loadPkjs();

    harness.listeners.appmessage({ payload: { 0: "open_config" } });

    expect(harness.openedUrls).toHaveLength(1);
  });

  it("syncs Codex threads through PKJS and emits compact rows", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
        recentCompletionLookbackMinutes: 720,
      }),
    });

    harness.listeners.appmessage({ payload: { 0: "app_ready" } });
    expect(harness.webSockets).toHaveLength(1);
    harness.webSockets[0].open();

    await vi.waitFor(() => {
      expect(harness.sentMessages.some(message => message[0] === "job_complete")).toBe(true);
    });

    const methods = harness.webSockets[0].sentJson.map(message => message.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/list"]);
    expect(harness.webSockets[0].sentJson[2].params).toMatchObject({
      limit: 2,
      useStateDbOnly: true,
    });

    const row = harness.sentMessages.find(message => message[0] === "job_item");
    expect(row[1]).toContain("thr_1|active|Fix deploy|active - cli - codex-pebble");
    expect(harness.sentMessages.at(-1)).toMatchObject({
      0: "job_complete",
      1: "2",
      3: 2,
    });
  });
});

function loadPkjs(initialStorage = {}) {
  const listeners = {};
  const openedUrls = [];
  const sentMessages = [];
  const webSockets = [];
  const storage = new Map(Object.entries(initialStorage));

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sentJson = [];
      webSockets.push(this);
    }

    open() {
      this.readyState = 1;
      this.onopen();
    }

    send(raw) {
      const message = JSON.parse(raw);
      this.sentJson.push(message);
      if (message.method === "initialize") {
        this.onmessage({ data: JSON.stringify({ id: message.id, result: { userAgent: "test" } }) });
      } else if (message.method === "thread/list") {
        this.onmessage({ data: JSON.stringify({
          id: message.id,
          result: {
            data: [
              {
                id: "thr_1",
                name: "Fix deploy",
                preview: "Fix deploy preview",
                status: { type: "active" },
                source: "cli",
                cwd: "/home/nick/git/codex-pebble",
              },
              {
                id: "thr_2",
                name: null,
                preview: "Review tests in detail",
                status: { type: "notLoaded" },
                source: "vscode",
                cwd: "/tmp/repo",
              },
            ],
          },
        }) });
      }
    }

    close() {
      this.readyState = 3;
    }
  }

  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
  const module = { exports: {} };
  const context = vm.createContext({
    clearTimeout,
    console: { log: vi.fn() },
    localStorage,
    module,
    exports: module.exports,
    Number,
    Object,
    Pebble: {
      addEventListener(name, listener) {
        listeners[name] = listener;
      },
      openURL(url) {
        openedUrls.push(url);
      },
      sendAppMessage(payload, success) {
        sentMessages.push(payload);
        if (success)
          success();
      },
    },
    Promise,
    setTimeout,
    WebSocket: FakeWebSocket,
  });

  vm.runInContext(SOURCE, context, { filename: "src/pkjs/index.js" });

  return {
    listeners,
    localStorage,
    openedUrls,
    sentMessages,
    webSockets,
  };
}

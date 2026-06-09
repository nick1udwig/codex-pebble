import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(new URL("../../../src/pkjs/index.js", import.meta.url), "utf8");

describe("PKJS config relay", () => {
  it("opens the hosted config page with saved settings", () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://codex.tailnet:4500",
        displayLimit: 4,
        recentCompletionLookbackMinutes: 120,
      }),
    });

    harness.listeners.showConfiguration({});

    const url = harness.openedUrls[0];
    expect(url).toMatch(/^https:\/\/nick1udwig\.github\.io\/codex-pebble\/config\/\?settings=/);
    const payload = JSON.parse(decodeURIComponent(new URL(url).searchParams.get("settings")));
    expect(payload).toEqual({
      wsUrl: "ws://codex.tailnet:4500",
      displayLimit: 4,
      recentCompletionLookbackMinutes: 120,
    });
  });

  it("stores sanitized webview settings and sends them to the watch", () => {
    const harness = loadPkjs();
    const response = encodeURIComponent(JSON.stringify({
      wsUrl: " wss://codex.example.ts.net:4500 ",
      displayLimit: 99,
      recentCompletionLookbackMinutes: 1,
    }));

    harness.listeners.webviewclosed({ response });

    expect(JSON.parse(harness.localStorage.getItem("codexJobsSettings"))).toEqual({
      wsUrl: "wss://codex.example.ts.net:4500",
      displayLimit: 8,
      recentCompletionLookbackMinutes: 5,
    });
    expect(JSON.parse(harness.sentMessages.at(-1).Config)).toEqual({
      wsUrl: "wss://codex.example.ts.net:4500",
      displayLimit: 8,
      recentCompletionLookbackMinutes: 5,
    });
  });

  it("sends settings on ready and watch ConfigRequest messages", () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://codex.tailnet:4500",
        displayLimit: 2,
        recentCompletionLookbackMinutes: 30,
      }),
    });

    harness.listeners.ready({ ready: true });
    harness.listeners.appmessage({ payload: { ConfigRequest: 1 } });

    expect(harness.proxy.readyReceived).toHaveBeenCalledWith({ ready: true });
    expect(harness.sentMessages).toHaveLength(2);
    expect(JSON.parse(harness.sentMessages[1].Config)).toEqual({
      wsUrl: "ws://codex.tailnet:4500",
      displayLimit: 2,
      recentCompletionLookbackMinutes: 30,
    });
  });

  it("lets pebbleproxy consume proxy appmessages before config handling", () => {
    const harness = loadPkjs({}, { appMessageHandled: true });

    harness.listeners.appmessage({ payload: { ConfigRequest: 1 } });

    expect(harness.proxy.appMessageReceived).toHaveBeenCalled();
    expect(harness.sentMessages).toEqual([]);
  });
});

function loadPkjs(initialStorage = {}, options = {}) {
  const listeners = {};
  const openedUrls = [];
  const sentMessages = [];
  const storage = new Map(Object.entries(initialStorage));
  const proxy = {
    readyReceived: vi.fn(),
    appMessageReceived: vi.fn(() => !!options.appMessageHandled),
  };
  const localStorage = {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  };
  const context = vm.createContext({
    console: { log: vi.fn() },
    localStorage,
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
    require(id) {
      if (id === "@moddable/pebbleproxy")
        return proxy;
      throw new Error("Unexpected require: " + id);
    },
  });

  vm.runInContext(SOURCE, context, { filename: "src/pkjs/index.js" });

  return {
    listeners,
    localStorage,
    openedUrls,
    proxy,
    sentMessages,
  };
}

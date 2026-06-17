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
    const notLoadedRow = harness.sentMessages.find(message => String(message[1]).startsWith("thr_2|"));
    expect(notLoadedRow[1]).toContain("thr_2|notLoaded|Review tests in detail|vscode - repo");
    expect(harness.sentMessages.at(-1)).toMatchObject({
      0: "job_complete",
      1: "2|1",
      3: 2,
    });
  });

  it("loads more rows when the C app asks for the next page", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
        recentCompletionLookbackMinutes: 720,
      }),
    });

    harness.listeners.appmessage({ payload: { 0: "app_ready" } });
    harness.webSockets[0].open();
    await vi.waitFor(() => expect(lastMessageOfType(harness, "job_complete")?.[1]).toBe("2|1"));

    harness.listeners.appmessage({ payload: { 0: "load_more" } });
    harness.webSockets.at(-1).open();

    await vi.waitFor(() => expect(lastMessageOfType(harness, "job_complete")?.[1]).toBe("3|0"));
    expect(harness.webSockets.at(-1).sentJson.find(message => message.method === "thread/list").params.limit).toBe(4);
  });

  it("loads thread detail with thread/read and emits readable content", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
        recentCompletionLookbackMinutes: 720,
      }),
    });

    harness.listeners.appmessage({ payload: { 0: "detail_request", 1: "thr_2" } });
    harness.webSockets[0].open();

    await vi.waitFor(() => {
      expect(lastMessageOfType(harness, "detail_update")).toBeTruthy();
    });

    const methods = harness.webSockets[0].sentJson.map(message => message.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/read"]);
    expect(harness.webSockets[0].sentJson[2].params).toEqual({
      threadId: "thr_2",
      includeTurns: true,
    });

    const detail = lastMessageOfType(harness, "detail_update");
    expect(detail[1]).toContain("thr_2|You: Can you add more tests?");
    expect(detail[1]).toContain("Codex: Added the bridge tests.");
    expect(detail[1]).not.toContain("notLoaded");
  });

  it("starts a new turn for dictated replies on idle threads", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
        recentCompletionLookbackMinutes: 720,
      }),
    });

    harness.listeners.appmessage({ payload: { 0: "reply", 1: "thr_2|please continue" } });
    harness.webSockets[0].open();

    await vi.waitFor(() => {
      expect(harness.webSockets[0].sentJson.some(message => message.method === "turn/start")).toBe(true);
    });

    const turnStart = harness.webSockets[0].sentJson.find(message => message.method === "turn/start");
    expect(turnStart.params).toMatchObject({
      threadId: "thr_2",
      input: [{ type: "text", text: "please continue", text_elements: [] }],
    });
    expect(harness.sentMessages.some(message => message[0] === "sync_status" && message[1] === "Reply sent")).toBe(true);
  });

  it("steers an in-progress turn for dictated replies on active threads", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
        recentCompletionLookbackMinutes: 720,
      }),
    }, {
      threadReadFixture(threadId, readCount) {
        if (threadId === "thr_1" && readCount > 1)
          return completedThreadFixture(threadId, "Focus noted.");
        return threadReadFixture(threadId);
      },
    });

    harness.listeners.appmessage({ payload: { 0: "reply", 1: "thr_1|focus on tests" } });
    harness.webSockets[0].open();

    await vi.waitFor(() => {
      expect(harness.webSockets[0].sentJson.some(message => message.method === "turn/steer")).toBe(true);
    });

    const steer = harness.webSockets[0].sentJson.find(message => message.method === "turn/steer");
    expect(steer.params).toMatchObject({
      threadId: "thr_1",
      expectedTurnId: "turn_active",
      input: [{ type: "text", text: "focus on tests", text_elements: [] }],
    });
  });

  it("polls thread detail after a dictated reply until the Codex result is visible", async () => {
    vi.useFakeTimers();
    try {
      const harness = loadPkjs({
        codexJobsSettings: JSON.stringify({
          wsUrl: "ws://127.0.0.1:4501",
          displayLimit: 2,
          recentCompletionLookbackMinutes: 720,
        }),
      }, {
        threadReadFixture(threadId, readCount) {
          if (threadId !== "thr_2")
            return threadReadFixture(threadId);
          if (readCount === 1)
            return threadReadFixture(threadId);
          if (readCount === 2)
            return activeReplyThreadFixture(threadId);
          return completedThreadFixture(threadId, "Continued with the fix.");
        },
      });

      harness.listeners.appmessage({ payload: { 0: "reply", 1: "thr_2|please continue" } });
      harness.webSockets[0].open();

      await vi.waitFor(() => {
        expect(lastMessageOfType(harness, "detail_update")?.[1]).toContain("You: please continue");
      });

      await vi.advanceTimersByTimeAsync(3000);
      harness.webSockets.at(-1).open();

      await vi.waitFor(() => {
        expect(lastMessageOfType(harness, "detail_update")?.[1]).toContain("Codex: Continued with the fix.");
      });
      expect(harness.threadReadCounts.thr_2).toBe(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("logs websocket close details for failed connections", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
        recentCompletionLookbackMinutes: 720,
      }),
    });

    harness.listeners.appmessage({ payload: { 0: "app_ready" } });
    harness.webSockets[0].failClose({
      type: "close",
      code: 1006,
      reason: "abnormal",
      wasClean: false,
    });

    await vi.waitFor(() => {
      expect(lastMessageOfType(harness, "error")).toBeTruthy();
    });

    expect(harness.logs.some(line => line.includes("WebSocket close: type=close code=1006 reason=abnormal wasClean=false"))).toBe(true);
    expect(harness.logs.some(line => line.includes("Sync failed: WebSocket closed: type=close code=1006 reason=abnormal wasClean=false"))).toBe(true);
  });
});

function lastMessageOfType(harness, type) {
  return harness.sentMessages.filter(message => message[0] === type).at(-1);
}

function loadPkjs(initialStorage = {}, options = {}) {
  const listeners = {};
  const openedUrls = [];
  const sentMessages = [];
  const webSockets = [];
  const storage = new Map(Object.entries(initialStorage));
  const threadReadCounts = {};
  const threads = [
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
    {
      id: "thr_3",
      name: "Write docs",
      preview: "Write docs",
      status: { type: "idle" },
      source: "appServer",
      cwd: "/tmp/docs",
    },
  ];

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
        const limit = message.params.limit ?? threads.length;
        this.onmessage({ data: JSON.stringify({
          id: message.id,
          result: {
            data: threads.slice(0, limit),
            nextCursor: limit < threads.length ? "next-page" : null,
            backwardsCursor: "prev-page",
          },
        }) });
      } else if (message.method === "thread/read") {
        const threadId = message.params.threadId;
        threadReadCounts[threadId] = (threadReadCounts[threadId] || 0) + 1;
        this.onmessage({ data: JSON.stringify({
          id: message.id,
          result: {
            thread: options.threadReadFixture
              ? options.threadReadFixture(threadId, threadReadCounts[threadId])
              : threadReadFixture(threadId),
          },
        }) });
      } else if (message.method === "turn/start") {
        this.onmessage({ data: JSON.stringify({
          id: message.id,
          result: { turn: { id: "turn_new", status: "inProgress", items: [] } },
        }) });
      } else if (message.method === "turn/steer") {
        this.onmessage({ data: JSON.stringify({
          id: message.id,
          result: { turnId: message.params.expectedTurnId },
        }) });
      }
    }

    close() {
      this.readyState = 3;
    }

    failClose(event) {
      this.readyState = 3;
      this.onclose(event);
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
  const logs = [];
  const context = vm.createContext({
    clearTimeout,
    console: { log: vi.fn(message => logs.push(String(message))) },
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
    logs,
    openedUrls,
    sentMessages,
    threadReadCounts,
    webSockets,
  };
}

function threadReadFixture(threadId) {
  if (threadId === "thr_1") {
    return {
      id: "thr_1",
      preview: "Fix deploy preview",
      turns: [{
        id: "turn_active",
        status: "inProgress",
        items: [
          {
            type: "userMessage",
            id: "item_1",
            content: [{ type: "text", text: "Fix the deploy", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "item_2",
            text: "Working on the deploy.",
          },
        ],
      }],
    };
  }

  return {
    id: threadId,
    preview: "Review tests in detail",
    turns: [{
      id: "turn_done",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "item_3",
          content: [{ type: "text", text: "Can you add more tests?", text_elements: [] }],
        },
        {
          type: "agentMessage",
          id: "item_4",
          text: "Added the bridge tests.",
        },
      ],
    }],
  };
}

function activeReplyThreadFixture(threadId) {
  return {
    id: threadId,
    status: { type: "active" },
    preview: "Review tests in detail",
    turns: [{
      id: "turn_new",
      status: "inProgress",
      items: [
        {
          type: "userMessage",
          id: "item_reply_user",
          content: [{ type: "text", text: "please continue", text_elements: [] }],
        },
      ],
    }],
  };
}

function completedThreadFixture(threadId, text) {
  return {
    id: threadId,
    status: { type: "idle" },
    preview: "Review tests in detail",
    turns: [{
      id: "turn_done",
      status: "completed",
      items: [
        {
          type: "userMessage",
          id: "item_reply_user",
          content: [{ type: "text", text: "please continue", text_elements: [] }],
        },
        {
          type: "agentMessage",
          id: "item_reply_agent",
          text,
        },
      ],
    }],
  };
}

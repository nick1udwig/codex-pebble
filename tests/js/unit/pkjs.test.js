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
      }),
    });

    harness.listeners.showConfiguration({});

    const url = harness.openedUrls[0];
    expect(url).toMatch(/^https:\/\/nick1udwig\.github\.io\/codex-pebble\/config\/\?/);
    expect(new URL(url).searchParams.get("v")).toBe("20260609-return-to");
    expect(JSON.parse(decodeURIComponent(new URL(url).searchParams.get("settings")))).toEqual({
      wsUrl: "ws://127.0.0.1:4501",
      displayLimit: 4,
    });
  });

  it("stores sanitized webview settings and tells the watch settings exist", () => {
    const harness = loadPkjs();
    harness.listeners.webviewclosed({
      response: encodeURIComponent(JSON.stringify({
        wsUrl: "",
        displayLimit: 99,
      })),
    });

    expect(JSON.parse(harness.localStorage.getItem("codexJobsSettings"))).toEqual({
      wsUrl: "",
      displayLimit: 8,
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
    expect(row[1]).toContain("thr_1|working|codex-pebble  working|Fix deploy preview");
    const notLoadedRow = harness.sentMessages.find(message => String(message[1]).startsWith("thr_2|"));
    expect(notLoadedRow[1]).toContain("thr_2|saved|repo  saved|Review tests in detail");
    expect(harness.sentMessages.at(-1)).toMatchObject({
      0: "job_complete",
      1: "2|1",
      3: 2,
    });
  });

  it("syncs threads when PKJS becomes ready without waiting for a watch button press", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
      }),
    });

    harness.listeners.ready({});
    expect(harness.webSockets).toHaveLength(1);
    harness.webSockets[0].open();

    await vi.waitFor(() => expect(lastMessageOfType(harness, "job_complete")?.[1]).toBe("2|1"));
    expect(harness.webSockets[0].sentJson.find(message => message.method === "thread/list").params.limit).toBe(2);
  });

  it("loads more rows when the C app asks for the next page", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
      }),
    });

    harness.listeners.appmessage({ payload: { 0: "app_ready" } });
    harness.webSockets[0].open();
    await vi.waitFor(() => expect(lastMessageOfType(harness, "job_complete")?.[1]).toBe("2|1"));

    harness.listeners.appmessage({ payload: { 0: "load_more" } });
    harness.webSockets.at(-1).open();

    await vi.waitFor(() => expect(lastMessageOfType(harness, "job_complete")?.[1]).toBe("3|0"));
    const listRequest = harness.webSockets.at(-1).sentJson.find(message => message.method === "thread/list");
    expect(listRequest.params.limit).toBe(2);
    expect(listRequest.params.cursor).toBe("cursor-2");
    const rows = harness.sentMessages.filter(message => message[0] === "job_item").map(message => message[1]);
    expect(rows.at(-3)).toContain("thr_1|");
    expect(rows.at(-2)).toContain("thr_2|");
    expect(rows.at(-1)).toContain("thr_3|");
  });

  it("keeps same-title app-server rows focused on useful context", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 3,
      }),
    }, {
      threads: [
        {
          id: "019edd42-bccd-7941-8a8e-591a55851111",
          name: "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.",
          preview: "",
          status: { type: "idle" },
          source: { subAgent: "review" },
          cwd: "/tmp/pebble",
          updatedAt: 1700000000,
        },
        {
          id: "019edd24-1cbc-7fa3-aa88-9299040b2222",
          name: "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.",
          preview: "",
          status: { type: "idle" },
          source: { subAgent: "review" },
          cwd: "/tmp/pebble",
          updatedAt: 1700003600,
        },
        {
          id: "019edce0-590e-7612-8ba0-566971793333",
          name: "Review the current code changes (staged, unstaged, and untracked files) and provide prioritized findings.",
          preview: "",
          status: { type: "idle" },
          source: { subAgent: "review" },
          cwd: "/tmp/pebble",
          updatedAt: 1700007200,
        },
      ],
    });

    harness.listeners.appmessage({ payload: { 0: "app_ready" } });
    harness.webSockets[0].open();

    await vi.waitFor(() => expect(lastMessageOfType(harness, "job_complete")?.[1]).toBe("3|0"));
    const details = harness.sentMessages
      .filter(message => message[0] === "job_item")
      .map(message => String(message[1]).split("|")[3]);
    const titles = harness.sentMessages
      .filter(message => message[0] === "job_item")
      .map(message => String(message[1]).split("|")[2]);

    expect(details).toHaveLength(3);
    expect(new Set(details).size).toBe(3);
    expect(new Set(titles)).toEqual(new Set(["pebble  idle"]));
    expect(details.join("\n")).not.toContain("[object Object]");
    expect(details[0]).toContain("review");
    expect(details[0]).toContain("Review the current code changes");
  });

  it("loads thread detail with thread/read and emits readable content", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
      }),
    });

    harness.listeners.appmessage({ payload: { 0: "detail_request", 1: "thr_2" } });
    harness.webSockets[0].open();

    await vi.waitFor(() => {
      expect(lastMessageOfType(harness, "detail_update")).toBeTruthy();
    });

    const methods = harness.webSockets[0].sentJson.map(message => message.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/resume", "thread/read"]);
    expect(harness.webSockets[0].sentJson[2].params).toEqual({
      threadId: "thr_2",
    });
    expect(harness.webSockets[0].sentJson[3].params).toEqual({
      threadId: "thr_2",
      includeTurns: true,
    });

    const detail = lastMessageOfType(harness, "detail_update");
    const parsed = detailPayload(detail);
    expect(parsed.threadId).toBe("thr_2");
    expect(parsed.body).toContain("You: Can you add more tests?");
    expect(parsed.body).toContain("Codex: Added the bridge tests.");
    expect(parsed.body).not.toContain("notLoaded");
  });

  it("starts a new turn for dictated replies on idle threads", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
      }),
    });

    harness.listeners.appmessage({ payload: { 0: "reply", 1: "thr_2|please continue" } });
    const immediateDetail = lastMessageOfType(harness, "detail_update");
    const parsed = detailPayload(immediateDetail);
    expect(parsed.threadId).toBe("thr_2");
    expect(parsed.body).toContain("You: please continue");
    expect(parsed.body).toContain("Codex: working");

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

  it("keeps long thread ids intact when sending dictated replies", async () => {
    const longThreadId = "thread-" + "a".repeat(70);
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
      }),
    }, {
      threads: [{
        id: longThreadId,
        name: "Long id thread",
        preview: "Long id thread",
        status: { type: "idle" },
        source: "cli",
        cwd: "/tmp/long-id",
      }],
      threadReadFixture(threadId) {
        return completedThreadFixture(threadId, "Ready.");
      },
    });

    harness.listeners.appmessage({ payload: { 0: "app_ready" } });
    harness.webSockets[0].open();
    await vi.waitFor(() => expect(lastMessageOfType(harness, "job_item")?.[1]).toContain(longThreadId + "|"));

    harness.listeners.appmessage({ payload: { 0: "reply", 1: longThreadId + "|hello long id" } });
    const replySocket = harness.webSockets.at(-1);
    replySocket.open();

    await vi.waitFor(() => expect(replySocket.sentJson.some(message => message.method === "turn/start")).toBe(true));
    const turnStart = replySocket.sentJson.find(message => message.method === "turn/start");
    expect(turnStart.params.threadId).toBe(longThreadId);
    expect(turnStart.params.input).toEqual([{ type: "text", text: "hello long id", text_elements: [] }]);
  });

  it("steers an in-progress turn for dictated replies on active threads", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
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

  it("keeps dictated text before live agent deltas", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
      }),
    });

    harness.listeners.appmessage({ payload: { 0: "reply", 1: "thr_2|please continue" } });
    harness.webSockets[0].open();

    await vi.waitFor(() => {
      expect(harness.webSockets[0].sentJson.some(message => message.method === "turn/start")).toBe(true);
    });

    harness.webSockets[0].notify("item/agentMessage/delta", {
      threadId: "thr_2",
      turnId: "turn_live",
      itemId: "item_live",
      delta: "Streaming response",
    });

    await vi.waitFor(() => {
      const detail = lastMessageOfType(harness, "detail_update");
      expect(detail?.[1]).toContain("You: please continue");
      expect(detail?.[1]).toContain("Codex: Streaming response");
      expect(detail[1].indexOf("You: please continue")).toBeLessThan(detail[1].indexOf("Codex: Streaming response"));
    });
  });

  it("drops old detail text before truncating the newest response", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
      }),
    }, {
      threadReadFixture(threadId) {
        return longHistoryThreadFixture(threadId);
      },
    });

    harness.listeners.appmessage({ payload: { 0: "detail_request", 1: "thr_2" } });
    harness.webSockets[0].open();

    await vi.waitFor(() => {
      const detail = detailPayload(lastMessageOfType(harness, "detail_update"));
      expect(detail.body).toContain("Codex: Latest useful response");
      expect(detail.body).not.toContain("OLD stale context");
      expect(detail.hasPrev).toBe(true);
    });
  });

  it("streams adjacent cached thread detail pages on watch scroll", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
      }),
    }, {
      threadReadFixture(threadId) {
        return longHistoryThreadFixture(threadId);
      },
    });

    harness.listeners.appmessage({ payload: { 0: "detail_request", 1: "thr_2" } });
    harness.webSockets[0].open();

    await vi.waitFor(() => {
      const detail = detailPayload(lastMessageOfType(harness, "detail_update"));
      expect(detail.body).toContain("Codex: Latest useful response");
      expect(detail.hasPrev).toBe(true);
      expect(detail.hasNext).toBe(false);
      expect(detail.anchor).toBe("bottom");
    });

    harness.listeners.appmessage({ payload: { 0: "detail_scroll", 1: "thr_2|older" } });
    let older = detailPayload(lastMessageOfType(harness, "detail_update"));
    expect(older.threadId).toBe("thr_2");
    expect(older.body).toContain("OLD stale context");
    expect(older.hasNext).toBe(true);
    expect(older.anchor).toBe("bottom");

    harness.listeners.appmessage({ payload: { 0: "detail_scroll", 1: "thr_2|newer" } });
    const newer = detailPayload(lastMessageOfType(harness, "detail_update"));
    expect(newer.body).toContain("Codex: Latest useful response");
    expect(newer.body).not.toContain("OLD stale context");
    expect(newer.hasPrev).toBe(true);
    expect(newer.hasNext).toBe(false);
    expect(newer.anchor).toBe("top");
  });

  it("polls thread detail after a dictated reply until the Codex result is visible", async () => {
    vi.useFakeTimers();
    try {
      const harness = loadPkjs({
        codexJobsSettings: JSON.stringify({
          wsUrl: "ws://127.0.0.1:4501",
          displayLimit: 2,
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

  it("keeps polling after a reply when the immediate thread read is stale", async () => {
    vi.useFakeTimers();
    try {
      const harness = loadPkjs({
        codexJobsSettings: JSON.stringify({
          wsUrl: "ws://127.0.0.1:4501",
          displayLimit: 2,
        }),
      }, {
        threadReadFixture(threadId, readCount) {
          if (threadId !== "thr_2")
            return threadReadFixture(threadId);
          if (readCount <= 2)
            return threadReadFixture(threadId);
          return completedThreadFixture(threadId, "Finished the requested update.");
        },
      });

      harness.listeners.appmessage({ payload: { 0: "reply", 1: "thr_2|please continue" } });
      harness.webSockets[0].open();

      await vi.waitFor(() => {
        const detail = lastMessageOfType(harness, "detail_update");
        expect(detail?.[1]).toContain("You: please continue");
        expect(detail?.[1]).toContain("Codex: working");
      });

      await vi.advanceTimersByTimeAsync(3000);
      harness.webSockets.at(-1).open();

      await vi.waitFor(() => {
        expect(lastMessageOfType(harness, "detail_update")?.[1]).toContain("Codex: Finished the requested update.");
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

  it("surfaces common sidecar connection failures with specific watch messages", async () => {
    await expectFailedConnectionMessage("Handshake status 401 Unauthorized", "Bad relay token");
    await expectFailedConnectionMessage("Handshake status 409 Conflict", "Another watch is connected");
    await expectFailedConnectionMessage("Handshake status 502 Bad Gateway upstream connect failed", "Codex app-server unavailable");
  });

  it("renders live app-server notifications on the active thread", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
      }),
    });

    harness.listeners.appmessage({ payload: { 0: "detail_request", 1: "thr_2" } });
    harness.webSockets[0].open();
    await vi.waitFor(() => expect(lastMessageOfType(harness, "detail_update")).toBeTruthy());

    harness.webSockets[0].notify("turn/started", {
      threadId: "thr_2",
      turn: { id: "turn_live", status: "inProgress", items: [] },
    });
    await vi.waitFor(() => {
      expect(lastMessageOfType(harness, "detail_update")?.[1]).toContain("Codex: working");
    });

    harness.webSockets[0].notify("item/agentMessage/delta", {
      threadId: "thr_2",
      turnId: "turn_live",
      itemId: "item_live",
      delta: "Streaming",
    });
    harness.webSockets[0].notify("item/agentMessage/delta", {
      threadId: "thr_2",
      turnId: "turn_live",
      itemId: "item_live",
      delta: " response",
    });

    await vi.waitFor(() => {
      expect(lastMessageOfType(harness, "detail_update")?.[1]).toContain("Codex: Streaming response");
    });
  });

  it("coalesces rapid live agent deltas into one watch update", async () => {
    vi.useFakeTimers();
    try {
      const harness = loadPkjs({
        codexJobsSettings: JSON.stringify({
          wsUrl: "ws://127.0.0.1:4501",
          displayLimit: 2,
        }),
      });

      harness.listeners.appmessage({ payload: { 0: "detail_request", 1: "thr_2" } });
      harness.webSockets[0].open();
      await vi.waitFor(() => expect(lastMessageOfType(harness, "detail_update")).toBeTruthy());

      const detailCountBefore = messagesOfType(harness, "detail_update").length;
      harness.webSockets[0].notify("item/agentMessage/delta", {
        threadId: "thr_2",
        turnId: "turn_live",
        itemId: "item_live",
        delta: "One ",
      });
      harness.webSockets[0].notify("item/agentMessage/delta", {
        threadId: "thr_2",
        turnId: "turn_live",
        itemId: "item_live",
        delta: "two ",
      });
      harness.webSockets[0].notify("item/agentMessage/delta", {
        threadId: "thr_2",
        turnId: "turn_live",
        itemId: "item_live",
        delta: "three",
      });

      await vi.advanceTimersByTimeAsync(299);
      expect(messagesOfType(harness, "detail_update")).toHaveLength(detailCountBefore);

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(lastMessageOfType(harness, "detail_update")?.[1]).toContain("Codex: One two three");
      });
      expect(messagesOfType(harness, "detail_update")).toHaveLength(detailCountBefore + 1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("refreshes final thread content when a live turn completes", async () => {
    const harness = loadPkjs({
      codexJobsSettings: JSON.stringify({
        wsUrl: "ws://127.0.0.1:4501",
        displayLimit: 2,
      }),
    }, {
      threadReadFixture(threadId, readCount) {
        if (threadId !== "thr_2")
          return threadReadFixture(threadId);
        if (readCount < 2)
          return activeReplyThreadFixture(threadId);
        return completedThreadFixture(threadId, "Live completion arrived.");
      },
    });

    harness.listeners.appmessage({ payload: { 0: "detail_request", 1: "thr_2" } });
    harness.webSockets[0].open();
    await vi.waitFor(() => expect(harness.threadReadCounts.thr_2).toBe(1));

    harness.webSockets[0].notify("turn/completed", {
      threadId: "thr_2",
      turn: completedThreadFixture("thr_2", "Live completion arrived.").turns[0],
    });

    await vi.waitFor(() => {
      expect(harness.threadReadCounts.thr_2).toBe(2);
      expect(lastMessageOfType(harness, "detail_update")?.[1]).toContain("Codex: Live completion arrived.");
    });
  });
});

function lastMessageOfType(harness, type) {
  return messagesOfType(harness, type).at(-1);
}

function messagesOfType(harness, type) {
  return harness.sentMessages.filter(message => message[0] === type);
}

async function expectFailedConnectionMessage(message, expected) {
  const harness = loadPkjs({
    codexJobsSettings: JSON.stringify({
      wsUrl: "ws://127.0.0.1:4501",
      displayLimit: 2,
    }),
  });

  harness.listeners.appmessage({ payload: { 0: "app_ready" } });
  harness.webSockets[0].failClose({
    type: "close",
    code: 1006,
    message,
    wasClean: false,
  });

  await vi.waitFor(() => {
    expect(lastMessageOfType(harness, "error")?.[1]).toBe(expected);
  });
}

function detailPayload(message) {
  const parts = String(message?.[1] || "").split("|");
  return {
    threadId: parts[0],
    anchor: parts[1],
    hasPrev: parts[2] === "1",
    hasNext: parts[3] === "1",
    body: parts.slice(4).join("|"),
  };
}

function loadPkjs(initialStorage = {}, options = {}) {
  const listeners = {};
  const openedUrls = [];
  const sentMessages = [];
  const webSockets = [];
  const storage = new Map(Object.entries(initialStorage));
  const threadReadCounts = {};
  const threads = options.threads || [
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

    notify(method, params = {}) {
      this.onmessage({ data: JSON.stringify({ method, params }) });
    }

    send(raw) {
      const message = JSON.parse(raw);
      this.sentJson.push(message);
      if (message.method === "initialize") {
        this.onmessage({ data: JSON.stringify({ id: message.id, result: { userAgent: "test" } }) });
      } else if (message.method === "thread/list") {
        const limit = message.params.limit ?? threads.length;
        const start = message.params.cursor ? Number(String(message.params.cursor).replace("cursor-", "")) || 0 : 0;
        const end = start + limit;
        this.onmessage({ data: JSON.stringify({
          id: message.id,
          result: {
            data: threads.slice(start, end),
            nextCursor: end < threads.length ? "cursor-" + end : null,
            backwardsCursor: start > 0 ? "cursor-" + start : null,
          },
        }) });
      } else if (message.method === "thread/resume") {
        const threadId = message.params.threadId;
        this.onmessage({ data: JSON.stringify({
          id: message.id,
          result: {
            thread: options.threadResumeFixture
              ? options.threadResumeFixture(threadId)
              : options.threadReadFixture
                ? options.threadReadFixture(threadId, 0)
                : threadReadFixture(threadId),
          },
        }) });
      } else if (message.method === "thread/unsubscribe") {
        this.onmessage({ data: JSON.stringify({
          id: message.id,
          result: { status: "unsubscribed" },
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

function longHistoryThreadFixture(threadId) {
  return {
    id: threadId,
    status: { type: "idle" },
    preview: "Review tests in detail",
    turns: [
      {
        id: "turn_old",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "item_old_user",
            content: [{ type: "text", text: "OLD stale context " + "before ".repeat(60), text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "item_old_agent",
            text: "OLD stale context " + "after ".repeat(60),
          },
        ],
      },
      {
        id: "turn_new",
        status: "completed",
        items: [
          {
            type: "userMessage",
            id: "item_new_user",
            content: [{ type: "text", text: "What changed?", text_elements: [] }],
          },
          {
            type: "agentMessage",
            id: "item_new_agent",
            text: "Latest useful response " + "with more detail ".repeat(20),
          },
        ],
      },
    ],
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

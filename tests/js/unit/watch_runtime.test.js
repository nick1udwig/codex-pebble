import { afterEach, describe, expect, it, vi } from "vitest";
import { buttonInstances, resetButtons } from "../mocks/pebble/button.js";
import { dictationInstances, resetDictation } from "../mocks/pebble/dictation.js";
import { messageInstances, resetMessages } from "../mocks/pebble/message.js";
import { pocoInstances, resetPoco } from "../mocks/commodetto/Poco.js";

let activeHarness = null;

describe("watch runtime", () => {
  afterEach(() => {
    if (activeHarness && activeHarness.events.beforeunload)
      activeHarness.events.beforeunload();
    activeHarness = null;
    delete globalThis.addEventListener;
    delete globalThis.localStorage;
    delete globalThis.screen;
    delete globalThis.watch;
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("opens unconfigured, requests phone config, and reconnects with received settings", async () => {
    await boot();

    expect(renderText()).toContain("Set server URL");

    buttonInstances[0].push("select");
    expect(messageInstances[0].writes.at(-1).get("ConfigRequest")).toBe(1);

    messageInstances[0].emitReadable(new Map([["Config", JSON.stringify({
      wsUrl: "ws://codex.tailnet:4500",
      displayLimit: 3,
      recentCompletionLookbackMinutes: 720,
    })]]));

    await waitForRequest("thread/list");
    expect(FakeRpcClient.instances[0].url).toBe("ws://codex.tailnet:4500");
    expect(JSON.parse(globalThis.localStorage.getItem("codexJobsSettings")).wsUrl).toBe("ws://codex.tailnet:4500");
  });

  it("handles server unavailable without dropping cached dashboard data", async () => {
    vi.useFakeTimers();
    await boot({
      settings: settings(),
      connectError: new Error("Cannot reach Codex on Tailnet"),
      dashboard: {
        stale: false,
        syncedAt: now(),
        jobs: [job("thr_cached", "Cached job", "active")],
      },
    });

    await vi.waitFor(() => {
      expect(renderText()).toContain("stale");
    });
    expect(renderText()).toContain("Cached job");
    expect(JSON.parse(globalThis.localStorage.getItem("codexJobsDashboard")).stale).toBe(true);
  });

  it("maps raw websocket failures to the Tailnet reachability message", async () => {
    await boot({
      settings: settings(),
      connectError: new Error("WebSocket error"),
    });

    await vi.waitFor(() => {
      expect(renderText()).toContain("Cannot reach Codex");
    });
  });

  it("syncs visible jobs and subscribes active threads", async () => {
    const current = now();
    await boot({
      settings: settings({ recentCompletionLookbackMinutes: 60 }),
      rpcHandlers: threadHandlers({
        thr_active: thread("thr_active", "Fix deploy script", "active", current, [
          turn("turn_active", "inProgress", current, "editing CI"),
        ]),
        thr_recent: thread("thr_recent", "Review tests", "idle", current - 60, [
          turn("turn_recent", "completed", current - 60, "all green"),
        ]),
        thr_old: thread("thr_old", "Old history", "idle", current - 100000, [
          turn("turn_old", "completed", current - 100000, "done long ago"),
        ]),
      }, {
        loadedIds: ["thr_active"],
        listedIds: ["thr_recent", "thr_old"],
      }),
    });

    await waitForRequest("thread/resume");

    const dashboard = JSON.parse(globalThis.localStorage.getItem("codexJobsDashboard"));
    expect(dashboard.jobs.map(item => item.id)).toEqual(["thr_active", "thr_recent"]);
    expect(FakeRpcClient.instances[0].requests.map(item => item.method)).toEqual([
      "thread/loaded/list",
      "thread/read",
      "thread/list",
      "thread/read",
      "thread/read",
      "thread/read",
      "thread/resume",
    ]);
  });

  it("expands See more rows and acknowledges terminal jobs from detail", async () => {
    await boot({
      phoneReady: false,
      settings: settings({ displayLimit: 3 }),
      dashboard: {
        stale: true,
        syncedAt: now(),
        jobs: [
          job("thr_done", "Review tests", "completed", { latestTurnId: "turn_done" }),
          job("thr_two", "Second job", "active"),
          job("thr_three", "Third job", "active"),
          job("thr_four", "Fourth job", "active"),
        ],
      },
    });

    expect(renderText()).toContain("See more...");
    expect(renderText()).not.toContain("Fourth job");

    buttonInstances[0].push("down");
    buttonInstances[0].push("down");
    buttonInstances[0].push("down");
    buttonInstances[0].push("select");

    expect(renderText()).toContain("Fourth job");
    expect(renderText()).toContain("Show less");

    buttonInstances[0].push("select");
    expect(renderText()).toContain("Review tests");
    buttonInstances[0].push("up");

    const dashboard = JSON.parse(globalThis.localStorage.getItem("codexJobsDashboard"));
    expect(dashboard.jobs.map(item => item.id)).toEqual(["thr_two", "thr_three", "thr_four"]);
  });

  it("updates active rows from live notifications and unsubscribes on exit", async () => {
    const current = now();
    await boot({
      settings: settings(),
      rpcHandlers: threadHandlers({
        thr_active: thread("thr_active", "DB migration", "active", current, [
          turn("turn_active", "inProgress", current, "running"),
        ]),
      }, {
        loadedIds: ["thr_active"],
      }),
    });
    const rpc = await waitForRequest("thread/resume");

    rpc.hooks.onNotify("thread/status/changed", {
      threadId: "thr_active",
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    expect(JSON.parse(globalThis.localStorage.getItem("codexJobsDashboard")).jobs[0].waitingOnApproval).toBe(true);
    expect(renderText()).toContain("Needs approval");

    rpc.hooks.onNotify("turn/completed", {
      threadId: "thr_active",
      turnId: "turn_active",
      status: "completed",
    });
    expect(JSON.parse(globalThis.localStorage.getItem("codexJobsDashboard")).jobs[0].kind).toBe("completed");
    expect(renderText()).toContain("Done");

    rpc.hooks.onNotify("item/started", {
      threadId: "thr_active",
      turnId: "turn_active",
      startedAtMs: Date.now(),
      item: {
        type: "commandExecution",
        id: "cmd_1",
        command: "npm test",
        cwd: "/repo/thr_active",
        processId: null,
        source: "exec",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      },
    });
    expect(JSON.parse(globalThis.localStorage.getItem("codexJobsDashboard")).jobs[0].progress).toBe("Running: npm test");

    rpc.hooks.onNotify("item/completed", {
      threadId: "thr_active",
      turnId: "turn_active",
      completedAtMs: Date.now(),
      item: {
        type: "commandExecution",
        id: "cmd_1",
        command: "npm test",
        cwd: "/repo/thr_active",
        processId: null,
        source: "exec",
        status: "completed",
        commandActions: [],
        aggregatedOutput: "ok",
        exitCode: 0,
        durationMs: 100,
      },
    });
    expect(JSON.parse(globalThis.localStorage.getItem("codexJobsDashboard")).jobs[0].progress).toBe("Finished: npm test");

    activeHarness.events.beforeunload();
    expect(rpc.requests.some(item => item.method === "thread/unsubscribe" && item.params.threadId === "thr_active")).toBe(true);
    expect(rpc.closed).toBe(true);
  });

  it("previews accepted dictation and steers an active turn", async () => {
    const current = now();
    await boot({
      settings: settings(),
      rpcHandlers: threadHandlers({
        thr_active: thread("thr_active", "Fix deploy script", "active", current, [
          turn("turn_active", "inProgress", current, "editing CI"),
        ]),
      }, {
        loadedIds: ["thr_active"],
      }),
    });
    const rpc = await waitForRequest("thread/resume");

    buttonInstances[0].push("select");
    buttonInstances[0].push("select");
    expect(dictationInstances[0].started).toBe(1);

    dictationInstances[0].emitText("Please continue");
    expect(renderText()).toContain("Please continue");

    buttonInstances[0].push("select");
    await waitForRequest("turn/steer");

    const steer = rpc.requests.find(item => item.method === "turn/steer");
    expect(steer.params).toEqual({
      threadId: "thr_active",
      expectedTurnId: "turn_active",
      input: [{ type: "text", text: "Please continue", text_elements: [] }],
    });
  });

  it("offers to start a new turn when active-turn steering is stale", async () => {
    const current = now();
    const threads = {
      thr_active: thread("thr_active", "Fix deploy script", "active", current, [
        turn("turn_active", "inProgress", current, "editing CI"),
      ]),
    };
    await boot({
      settings: settings(),
      rpcHandlers: {
        ...threadHandlers(threads, {
          loadedIds: ["thr_active"],
        }),
        "turn/steer": () => {
          threads.thr_active = thread("thr_active", "Fix deploy script", "idle", current + 1, [
            turn("turn_active", "completed", current + 1, "done"),
          ]);
          throw new Error("No active turn");
        },
      },
    });
    const rpc = await waitForRequest("thread/resume");

    buttonInstances[0].push("select");
    buttonInstances[0].push("select");
    dictationInstances[0].emitText("Please continue");
    buttonInstances[0].push("select");

    await vi.waitFor(() => {
      expect(renderText()).toContain("No active turn.");
    });
    expect(rpc.requests.some(item => item.method === "turn/start")).toBe(false);

    buttonInstances[0].push("select");
    await waitForRequest("turn/start");

    const start = rpc.requests.find(item => item.method === "turn/start");
    expect(start.params).toEqual({
      threadId: "thr_active",
      input: [{ type: "text", text: "Please continue", text_elements: [] }],
    });
  });

  it("starts a new turn for idle threads", async () => {
    const current = now();
    await boot({
      settings: settings(),
      rpcHandlers: threadHandlers({
        thr_done: thread("thr_done", "Review tests", "idle", current, [
          turn("turn_done", "completed", current, "done"),
        ]),
      }, {
        listedIds: ["thr_done"],
      }),
    });
    const rpc = await waitForRequest("thread/list");
    await vi.waitFor(() => {
      expect(JSON.parse(globalThis.localStorage.getItem("codexJobsDashboard")).jobs).toHaveLength(1);
    });

    buttonInstances[0].push("select");
    buttonInstances[0].push("select");
    dictationInstances[0].emitText("Follow up");
    buttonInstances[0].push("select");
    await waitForRequest("turn/start");

    const resumeIndex = rpc.requests.findIndex(item => item.method === "thread/resume" && item.params.threadId === "thr_done");
    const startIndex = rpc.requests.findIndex(item => item.method === "turn/start");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(resumeIndex);
    expect(rpc.requests[startIndex].params).toEqual({
      threadId: "thr_done",
      input: [{ type: "text", text: "Follow up", text_elements: [] }],
    });
  });

  it("keeps dictated text available when sending fails", async () => {
    const current = now();
    await boot({
      settings: settings(),
      rpcHandlers: {
        ...threadHandlers({
          thr_active: thread("thr_active", "Fix deploy script", "active", current, [
            turn("turn_active", "inProgress", current, "editing CI"),
          ]),
        }, {
          loadedIds: ["thr_active"],
        }),
        "turn/steer": () => {
          throw new Error("steer failed");
        },
      },
    });
    await waitForRequest("thread/resume");

    buttonInstances[0].push("select");
    buttonInstances[0].push("select");
    dictationInstances[0].emitText("Keep this reply");
    buttonInstances[0].push("select");

    await vi.waitFor(() => {
      expect(renderText()).toContain("steer failed");
    });
    expect(renderText()).toContain("Keep this reply");
  });
});

async function boot(options = {}) {
  vi.resetModules();
  resetButtons();
  resetDictation();
  resetMessages();
  resetPoco();
  FakeRpcClient.reset();
  FakeRpcClient.connectError = options.connectError || null;
  FakeRpcClient.handlers = {
    ...threadHandlers({}),
    ...(options.rpcHandlers || {}),
  };

  globalThis.screen = {};
  const events = {};
  const watchListeners = {};
  globalThis.addEventListener = (name, listener) => {
    events[name] = listener;
  };
  globalThis.watch = {
    connected: { pebblekit: options.phoneReady !== false },
    addEventListener(name, listener) {
      watchListeners[name] = listener;
    },
  };
  globalThis.localStorage = createLocalStorage({
    codexJobsSettings: options.settings ? JSON.stringify(options.settings) : undefined,
    codexJobsState: options.appState ? JSON.stringify(options.appState) : undefined,
    codexJobsDashboard: options.dashboard ? JSON.stringify(options.dashboard) : undefined,
  });

  vi.doMock("../../../src/embeddedjs/codex_rpc.js", () => ({ default: FakeRpcClient }));
  await import("../../../src/embeddedjs/main.js");

  activeHarness = { events, watchListeners };
  return activeHarness;
}

async function waitForRequest(method) {
  await vi.waitFor(() => {
    const rpc = FakeRpcClient.instances.at(-1);
    expect(rpc && rpc.requests.some(item => item.method === method)).toBe(true);
  });
  return FakeRpcClient.instances.at(-1);
}

function renderText() {
  const render = pocoInstances[0];
  return render ? render.texts.map(item => item.text).join("\n") : "";
}

function createLocalStorage(initial) {
  const store = new Map(Object.entries(initial).filter(([, value]) => value !== undefined));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

class FakeRpcClient {
  static instances = [];
  static handlers = {};
  static connectError = null;

  static reset() {
    FakeRpcClient.instances = [];
    FakeRpcClient.handlers = {};
    FakeRpcClient.connectError = null;
  }

  constructor(url, hooks) {
    this.url = url;
    this.hooks = hooks;
    this.requests = [];
    this.closed = false;
    FakeRpcClient.instances.push(this);
  }

  async connect() {
    if (FakeRpcClient.connectError)
      throw FakeRpcClient.connectError;
    return {};
  }

  async request(method, params = {}, options = {}) {
    this.requests.push({ method, params, options });
    const handler = FakeRpcClient.handlers[method];
    if (!handler)
      return {};
    return handler(params, this);
  }

  close() {
    this.closed = true;
  }
}

function threadHandlers(threads, options = {}) {
  return {
    "thread/loaded/list": () => ({ data: options.loadedIds || [] }),
    "thread/list": () => ({ data: (options.listedIds || []).map(id => withoutTurns(threads[id])) }),
    "thread/read": params => ({ thread: params.includeTurns ? threads[params.threadId] : withoutTurns(threads[params.threadId]) }),
    "thread/resume": () => ({}),
    "thread/unsubscribe": () => ({}),
    "turn/steer": () => ({}),
    "turn/start": () => ({}),
  };
}

function settings(overrides = {}) {
  return {
    wsUrl: "ws://codex.tailnet:4500",
    displayLimit: 3,
    recentCompletionLookbackMinutes: 720,
    ...overrides,
  };
}

function job(id, title, kind, overrides = {}) {
  return {
    id,
    title,
    kind,
    statusType: kind === "active" ? "active" : "idle",
    latestTurnId: "turn_" + id,
    latestTurnStatus: kind === "active" ? "inProgress" : kind,
    updatedAt: now(),
    waitingOnApproval: false,
    progress: "",
    cwd: "",
    ...overrides,
  };
}

function thread(id, title, status, updatedAt, turns) {
  return {
    id,
    title,
    name: title,
    preview: title,
    status: { type: status },
    updatedAt,
    cwd: "/repo/" + id,
    turns,
  };
}

function turn(id, status, timestamp, summary) {
  return {
    id,
    status,
    startedAt: timestamp,
    completedAt: status === "inProgress" ? null : timestamp,
    items: [],
    summary,
  };
}

function withoutTurns(threadValue) {
  if (!threadValue)
    return undefined;
  return {
    ...threadValue,
    turns: [],
  };
}

function now() {
  return Math.floor(Date.now() / 1000);
}

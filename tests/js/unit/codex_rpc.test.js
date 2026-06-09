import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import CodexRpcClient from "../../../src/embeddedjs/codex_rpc.js";

describe("CodexRpcClient", () => {
  afterEach(() => {
    delete globalThis.WebSocket;
    FakeWebSocket.instances = [];
  });

  it("sends initialize then initialized during connect", async () => {
    globalThis.WebSocket = FakeWebSocket;
    const client = new CodexRpcClient("ws://codex.tailnet:4500");

    const connected = client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toMatchObject({
      id: 1,
      method: "initialize",
      params: {
        clientInfo: {
          name: "repebble_codex_jobs",
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    });

    socket.message({ id: 1, result: { protocolVersion: 1 } });
    await connected;

    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toEqual({
      method: "initialized",
      params: {},
    });
  });

  it("rejects methods outside the plan allowlist", () => {
    const client = new CodexRpcClient("ws://codex.tailnet:4500");

    expect(() => client.request("thread/archive", {})).toThrow(
      "Forbidden Codex app-server method: thread/archive",
    );
  });

  it("does not allow the removed thread/turns/list method", () => {
    const client = new CodexRpcClient("ws://codex.tailnet:4500");

    expect(() => client.request("thread/turns/list", {})).toThrow(
      "Forbidden Codex app-server method: thread/turns/list",
    );
  });

  it("tracks generated Codex app-server method names", () => {
    const clientRequests = readFileSync(new URL("../../../schemas/ClientRequest.ts", import.meta.url), "utf8");
    const clientNotifications = readFileSync(new URL("../../../schemas/ClientNotification.ts", import.meta.url), "utf8");
    const allowedRequests = [
      "initialize",
      "thread/loaded/list",
      "thread/list",
      "thread/read",
      "thread/resume",
      "thread/unsubscribe",
      "turn/steer",
      "turn/start",
      "account/read",
      "turn/interrupt",
    ];

    for (const method of allowedRequests)
      expect(clientRequests).toContain(`"method": "${method}"`);
    expect(clientNotifications).toContain(`"method": "initialized"`);
    expect(clientRequests).not.toContain(`"method": "thread/turns/list"`);
  });
});

class FakeWebSocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeWebSocket.instances.push(this);
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  send(payload) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
    this.emit("close", {});
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  emit(name, event) {
    for (const listener of this.listeners.get(name) || [])
      listener(event);
  }
}

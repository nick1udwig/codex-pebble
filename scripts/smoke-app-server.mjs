import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { resolve } from "node:path";
import net from "node:net";

const DEFAULT_SOCKET = "~/.codex/app-server-control/app-server-control.sock";
const SOURCE_KINDS = [
  "cli",
  "vscode",
  "appServer",
  "exec",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

function parseArgs(args) {
  const options = {
    socketPath: expandHome(process.env.CODEX_APP_SERVER_SOCKET || DEFAULT_SOCKET),
    timeoutMs: 5000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--unix-socket") {
      options.socketPath = expandHome(requireValue(args, ++i, arg));
    } else if (arg === "--ws-url") {
      const url = new URL(requireValue(args, ++i, arg));
      if (url.protocol !== "ws:")
        throw new Error("--ws-url must use ws://");
      options.socketPath = "";
      options.host = url.hostname;
      options.port = Number(url.port || "80");
      options.path = url.pathname || "/";
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(requireValue(args, ++i, arg));
      if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
        throw new Error("--timeout-ms must be a positive number");
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }

  return options;
}

function requireValue(args, index, flag) {
  if (index >= args.length)
    throw new Error(flag + " requires a value");
  return args[index];
}

function expandHome(path) {
  if (path === "~")
    return homedir();
  if (path.startsWith("~/"))
    return resolve(homedir(), path.slice(2));
  return path;
}

function pickThreadId(value) {
  if (!value)
    return "";
  if (typeof value === "string")
    return value;
  return value.id || value.threadId || value.sessionId || "";
}

function latestTurnStatus(thread) {
  const turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
  if (!turns.length)
    return null;
  const latest = turns.reduce((selected, turn) => {
    if (!selected)
      return turn;
    return turnTimestamp(turn) >= turnTimestamp(selected) ? turn : selected;
  }, null);
  return latest ? latest.status || null : null;
}

function turnTimestamp(turn) {
  return turn.updatedAt || turn.completedAt || turn.startedAt || turn.createdAt || 0;
}

class WebSocketJsonRpcClient {
  static async connect(options) {
    const client = new WebSocketJsonRpcClient(options);
    await client.connect();
    return client;
  }

  constructor(options) {
    this.options = options;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.handshakeBuffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.closed = false;
  }

  connect() {
    return new Promise((resolveConnect, rejectConnect) => {
      const socketOptions = this.options.socketPath
        ? { path: this.options.socketPath }
        : { host: this.options.host, port: this.options.port };
      const socket = net.createConnection(socketOptions);
      const key = randomBytes(16).toString("base64");
      const timeout = setTimeout(() => {
        socket.destroy(new Error("app-server smoke timed out during connect"));
      }, this.options.timeoutMs);

      this.socket = socket;
      socket.on("connect", () => {
        socket.write(makeHandshakeRequest(this.options, key));
      });
      socket.on("data", chunk => {
        try {
          if (!this.handshakeDone) {
            this.handleHandshake(chunk, key);
            if (this.handshakeDone) {
              clearTimeout(timeout);
              resolveConnect();
            }
            return;
          }
          this.handleFrames(chunk);
        } catch (error) {
          clearTimeout(timeout);
          rejectConnect(error);
          this.close();
        }
      });
      socket.on("error", error => {
        clearTimeout(timeout);
        this.rejectAll(error);
        rejectConnect(error);
      });
      socket.on("close", () => {
        this.closed = true;
        this.rejectAll(new Error("app-server socket closed"));
      });
    });
  }

  request(method, params = {}) {
    const id = this.nextId++;
    this.send({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + " timed out"));
      }, this.options.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  send(message) {
    if (!this.socket || this.closed)
      throw new Error("app-server socket is not open");
    this.socket.write(encodeFrame(JSON.stringify(message)));
  }

  close() {
    if (!this.socket || this.closed)
      return;
    this.closed = true;
    try {
      this.socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
      this.socket.end();
    } catch (_) {
    }
  }

  handleHandshake(chunk, key) {
    this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);
    const headerEnd = this.handshakeBuffer.indexOf("\r\n\r\n");
    if (headerEnd === -1)
      return;

    const header = this.handshakeBuffer.subarray(0, headerEnd).toString("utf8");
    const lines = header.split("\r\n");
    if (!/^HTTP\/1\.1 101\b/.test(lines[0] || ""))
      throw new Error("WebSocket upgrade failed: " + (lines[0] || "no status"));

    const headers = new Map();
    for (const line of lines.slice(1)) {
      const separator = line.indexOf(":");
      if (separator !== -1)
        headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
    }

    const expected = createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    if (headers.get("sec-websocket-accept") !== expected)
      throw new Error("WebSocket upgrade returned an invalid accept key");

    this.handshakeDone = true;
    const remainder = this.handshakeBuffer.subarray(headerEnd + 4);
    this.handshakeBuffer = Buffer.alloc(0);
    if (remainder.length)
      this.handleFrames(remainder);
  }

  handleFrames(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (true) {
      const frame = decodeFrame(this.buffer);
      if (!frame)
        return;
      this.buffer = this.buffer.subarray(frame.consumed);

      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        this.socket.write(encodeFrame(frame.payload, 0xA));
        continue;
      }
      if (frame.opcode !== 0x1)
        continue;

      const message = JSON.parse(frame.payload.toString("utf8"));
      if (message.id === undefined)
        continue;

      const pending = this.pending.get(message.id);
      if (!pending)
        continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message || pending.method + " failed");
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result || {});
      }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function makeHandshakeRequest(options, key) {
  const path = options.path || "/";
  const host = options.host ? options.host + ":" + options.port : "localhost";
  return [
    `GET ${path} HTTP/1.1`,
    `Host: ${host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "\r\n",
  ].join("\r\n");
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = randomBytes(4);
  const length = data.length;
  let header;

  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  header[0] = 0x80 | opcode;
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i++)
    masked[i] = data[i] ^ mask[i % 4];

  return Buffer.concat([header, mask, masked]);
}

function decodeFrame(buffer) {
  if (buffer.length < 2)
    return null;

  const opcode = buffer[0] & 0x0F;
  const masked = (buffer[1] & 0x80) !== 0;
  let offset = 2;
  let length = buffer[1] & 0x7F;

  if (length === 126) {
    if (buffer.length < offset + 2)
      return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8)
      return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error("WebSocket frame too large");
    length = Number(bigLength);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4)
      return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length)
    return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++)
      payload[i] ^= mask[i % 4];
  }

  return {
    opcode,
    payload,
    consumed: offset + length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = await WebSocketJsonRpcClient.connect(options);

  try {
    const initialized = await client.request("initialize", {
      clientInfo: {
        name: "repebble_codex_jobs_smoke",
        title: "Codex Jobs for Pebble Smoke",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    client.notify("initialized", {});

    const loaded = await client.request("thread/loaded/list", {});
    const loadedIds = loaded.data || loaded.threadIds || loaded.ids || [];
    const listed = await client.request("thread/list", {
      limit: 1,
      sortKey: "updated_at",
      archived: false,
      sourceKinds: SOURCE_KINDS,
    });
    const listedThreads = listed.data || listed.threads || [];
    const candidateThreadId = pickThreadId(loadedIds[0]) || pickThreadId(listedThreads[0]);

    let readSummary = null;
    if (candidateThreadId) {
      const read = await client.request("thread/read", {
        threadId: candidateThreadId,
        includeTurns: true,
      });
      const thread = read.thread || read;
      readSummary = {
        threadId: candidateThreadId,
        turns: Array.isArray(thread.turns) ? thread.turns.length : 0,
        latestTurnStatus: latestTurnStatus(thread),
      };
    }

    console.log(JSON.stringify({
      ok: true,
      transport: options.socketPath ? "unix" : "tcp",
      userAgent: initialized.userAgent || null,
      platformFamily: initialized.platformFamily || null,
      loadedThreadCount: loadedIds.length,
      listedThreadCount: listedThreads.length,
      readSummary,
    }, null, 2));
  } finally {
    client.close();
  }
}

await main();

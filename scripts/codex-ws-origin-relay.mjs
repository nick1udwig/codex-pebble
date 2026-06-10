#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const options = parseArgs(process.argv.slice(2));
const server = net.createServer(socket => {
  handleDownstream(socket).catch(error => {
    console.error("relay connection failed: " + error.message);
    socket.destroy();
  });
});

server.listen(options.listen.port, options.listen.host, () => {
  console.log(`Codex WebSocket origin relay listening on ws://${options.listen.host}:${options.listen.port}${options.listen.path}`);
  console.log(`Forwarding to ${options.upstream.href} without an Origin header`);
});

process.on("SIGINT", () => {
  server.close(() => process.exit(0));
});

async function handleDownstream(downstream) {
  downstream.setNoDelay(true);

  let downstreamHandshake;
  try {
    downstreamHandshake = await readHttpHead(downstream);
    validateDownstreamHandshake(downstreamHandshake.head);
  } catch (error) {
    writeHttpError(downstream, 400, error.message);
    return;
  }

  let upstream;
  try {
    upstream = await connectUpstream(options.upstream);
  } catch (error) {
    writeHttpError(downstream, 502, error.message);
    return;
  }

  const key = downstreamHandshake.head.headers.get("sec-websocket-key");
  downstream.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
    "\r\n",
  ].join("\r\n"));

  const closeBoth = () => {
    downstream.destroy();
    upstream.socket.destroy();
  };
  downstream.on("error", closeBoth);
  upstream.socket.on("error", closeBoth);
  downstream.on("close", () => upstream.socket.end());
  upstream.socket.on("close", () => downstream.end());

  relayFrames({
    source: downstream,
    target: upstream.socket,
    initial: downstreamHandshake.rest,
    expectMasked: true,
    maskOutput: true,
    label: "downstream",
  });
  relayFrames({
    source: upstream.socket,
    target: downstream,
    initial: upstream.rest,
    expectMasked: false,
    maskOutput: false,
    label: "upstream",
  });
}

function relayFrames({ source, target, initial, expectMasked, maskOutput, label }) {
  const parser = new FrameParser({ expectMasked, label });

  const writeFrames = chunk => {
    if (!chunk.length)
      return;
    const frames = parser.push(chunk);
    for (const frame of frames) {
      target.write(encodeFrame(frame, maskOutput));
      if (frame.opcode === 0x8) {
        target.end();
        source.end();
      }
    }
  };

  source.on("data", chunk => {
    try {
      writeFrames(chunk);
    } catch (error) {
      console.error(`${label} frame relay failed: ${error.message}`);
      source.destroy();
      target.destroy();
    }
  });

  writeFrames(initial);
}

class FrameParser {
  constructor({ expectMasked, label }) {
    this.expectMasked = expectMasked;
    this.label = label;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];

    while (true) {
      const frame = this.readFrame();
      if (!frame)
        return frames;
      frames.push(frame);
    }
  }

  readFrame() {
    if (this.buffer.length < 2)
      return null;

    const firstByte = this.buffer[0];
    const secondByte = this.buffer[1];
    const masked = (secondByte & 0x80) !== 0;
    let length = secondByte & 0x7f;
    let offset = 2;

    if (this.expectMasked && !masked)
      throw new Error(`${this.label} sent an unmasked frame`);
    if (!this.expectMasked && masked)
      throw new Error(`${this.label} sent a masked frame`);

    if (length === 126) {
      if (this.buffer.length < offset + 2)
        return null;
      length = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (this.buffer.length < offset + 8)
        return null;
      const bigLength = this.buffer.readBigUInt64BE(offset);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("frame too large");
      length = Number(bigLength);
      offset += 8;
    }

    let mask;
    if (masked) {
      if (this.buffer.length < offset + 4)
        return null;
      mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (this.buffer.length < offset + length)
      return null;

    const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
    this.buffer = this.buffer.subarray(offset + length);

    if (mask) {
      for (let i = 0; i < payload.length; i++)
        payload[i] ^= mask[i % 4];
    }

    return {
      firstByte,
      opcode: firstByte & 0x0f,
      payload,
    };
  }
}

function encodeFrame(frame, masked) {
  const payload = frame.payload;
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const maskLength = masked ? 4 : 0;
  const output = Buffer.alloc(headerLength + maskLength + length);
  let offset = 0;

  output[offset++] = frame.firstByte;
  if (length < 126) {
    output[offset++] = (masked ? 0x80 : 0) | length;
  } else if (length <= 0xffff) {
    output[offset++] = (masked ? 0x80 : 0) | 126;
    output.writeUInt16BE(length, offset);
    offset += 2;
  } else {
    output[offset++] = (masked ? 0x80 : 0) | 127;
    output.writeBigUInt64BE(BigInt(length), offset);
    offset += 8;
  }

  if (!masked) {
    payload.copy(output, offset);
    return output;
  }

  const mask = randomBytes(4);
  mask.copy(output, offset);
  offset += 4;
  for (let i = 0; i < payload.length; i++)
    output[offset + i] = payload[i] ^ mask[i % 4];
  return output;
}

function connectUpstream(url) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.host, port: url.port });
    const key = randomBytes(16).toString("base64");
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("upstream handshake timed out"));
    }, options.timeoutMs);

    socket.setNoDelay(true);
    socket.once("connect", () => {
      const host = `${url.host}:${url.port}`;
      socket.write([
        `GET ${url.pathname || "/"}${url.search || ""} HTTP/1.1`,
        `Host: ${host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "\r\n",
      ].join("\r\n"));
    });
    socket.once("error", error => {
      clearTimeout(timeout);
      reject(error);
    });

    readHttpHead(socket).then(response => {
      clearTimeout(timeout);
      if (!/^HTTP\/1\.1 101\b/i.test(response.head.startLine))
        throw new Error("upstream returned " + response.head.startLine);
      const expected = websocketAccept(key);
      if (response.head.headers.get("sec-websocket-accept") !== expected)
        throw new Error("upstream returned an invalid Sec-WebSocket-Accept");
      resolve({ socket, rest: response.rest });
    }).catch(error => {
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    });
  });
}

function readHttpHead(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("HTTP upgrade timed out"));
    }, options.timeoutMs);

    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1)
        return;
      cleanup();
      const raw = buffer.subarray(0, end).toString("latin1");
      resolve({
        head: parseHttpHead(raw),
        rest: buffer.subarray(end + 4),
      });
    };
    const onError = error => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("socket closed before HTTP upgrade completed"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function parseHttpHead(raw) {
  const lines = raw.split("\r\n");
  const startLine = lines.shift() || "";
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator === -1)
      continue;
    headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  return { startLine, headers };
}

function validateDownstreamHandshake(head) {
  if (!/^GET\s+\S+\s+HTTP\/1\.1$/i.test(head.startLine))
    throw new Error("expected WebSocket GET request");
  if ((head.headers.get("upgrade") || "").toLowerCase() !== "websocket")
    throw new Error("missing Upgrade: websocket");
  if (!/\bupgrade\b/i.test(head.headers.get("connection") || ""))
    throw new Error("missing Connection: Upgrade");
  if (!head.headers.get("sec-websocket-key"))
    throw new Error("missing Sec-WebSocket-Key");
}

function websocketAccept(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

function writeHttpError(socket, status, message) {
  socket.end([
    `HTTP/1.1 ${status} ${message}`,
    "Connection: close",
    "Content-Length: 0",
    "\r\n",
  ].join("\r\n"));
}

function parseArgs(args) {
  const parsed = {
    listen: parseWsUrl("ws://127.0.0.1:4501", "listen"),
    upstream: parseWsUrl("ws://127.0.0.1:4500", "upstream"),
    timeoutMs: 5000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--listen") {
      parsed.listen = parseWsUrl(requireValue(args, ++i, arg), "listen");
    } else if (arg === "--upstream") {
      parsed.upstream = parseWsUrl(requireValue(args, ++i, arg), "upstream");
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = Number(requireValue(args, ++i, arg));
      if (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0)
        throw new Error("--timeout-ms must be a positive number");
    } else {
      throw new Error("Unknown argument: " + arg);
    }
  }

  return parsed;
}

function parseWsUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== "ws:")
    throw new Error(`--${label} must use ws://`);
  if (!url.hostname)
    throw new Error(`--${label} must include a host`);
  return {
    href: url.href,
    host: url.hostname,
    port: Number(url.port || 80),
    path: url.pathname || "/",
    pathname: url.pathname || "/",
    search: url.search || "",
  };
}

function requireValue(args, index, flag) {
  if (index >= args.length)
    throw new Error(flag + " requires a value");
  return args[index];
}

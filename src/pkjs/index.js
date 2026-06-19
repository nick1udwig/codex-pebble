var SETTINGS_KEY = "codexJobsSettings";
var CONFIG_URL = "https://nick1udwig.github.io/codex-pebble/config/?v=20260609-return-to";

var Key = Object.freeze({
  messageType: 0,
  payload: 1,
  requestId: 2,
  syncState: 3
});

var MessageType = Object.freeze({
  appReady: "app_ready",
  refresh: "refresh",
  loadMore: "load_more",
  openConfig: "open_config",
  detailRequest: "detail_request",
  reply: "reply",
  settingsState: "settings_state",
  syncStatus: "sync_status",
  jobClear: "job_clear",
  jobItem: "job_item",
  jobComplete: "job_complete",
  detailUpdate: "detail_update",
  error: "error"
});

var SyncState = Object.freeze({
  desynced: 0,
  syncing: 1,
  synced: 2
});

var SOURCE_KINDS = [
  "cli",
  "vscode",
  "appServer",
  "exec",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown"
];

var ProtocolByteLimit = Object.freeze({
  threadId: 95,
  title: 47,
  detail: 95,
  body: 360,
  payload: 460
});

var MAX_WATCH_ROWS = 16;
var DETAIL_POLL_INTERVAL_MS = 3000;
var DETAIL_POLL_MAX_ATTEMPTS = 20;

var sendQueue = [];
var sending = false;
var syncInFlight = false;
var currentClient = null;
var activeListLimit = 0;
var activeDetailThreadId = "";
var detailPollTimer = null;
var detailPollAttempts = 0;
var detailPollInFlight = false;
var lastDetailBodyByThreadId = {};
var pendingReplyTextByThreadId = {};

Pebble.addEventListener("ready", function() {
  syncJobs({ reset: true });
});

Pebble.addEventListener("appmessage", function(event) {
  var type = readPayloadValue(event.payload, Key.messageType, "MessageType");

  if (type === MessageType.appReady) {
    sendSettingsState();
    syncJobs({ reset: true });
  } else if (type === MessageType.refresh) {
    syncJobs();
  } else if (type === MessageType.loadMore) {
    syncJobs({ loadMore: true });
  } else if (type === MessageType.openConfig) {
    openConfiguration();
  } else if (type === MessageType.detailRequest) {
    requestThreadDetail(readPayloadValue(event.payload, Key.payload, "Payload"));
  } else if (type === MessageType.reply) {
    submitReply(readPayloadValue(event.payload, Key.payload, "Payload"));
  }
});

Pebble.addEventListener("showConfiguration", openConfiguration);

Pebble.addEventListener("webviewclosed", function(event) {
  if (!event.response)
    return;

  var decoded = event.response;
  try {
    decoded = decodeURIComponent(decoded);
  } catch (_) {
  }

  try {
    saveSettings(JSON.parse(decoded));
    activeListLimit = 0;
    sendSettingsState();
    syncJobs({ reset: true });
  } catch (error) {
    log("Config parse failed", error);
    sendError("Bad config");
  }
});

function openConfiguration() {
  var separator = CONFIG_URL.indexOf("?") === -1 ? "?" : "&";
  Pebble.openURL(CONFIG_URL + separator + "settings=" + encodeURIComponent(JSON.stringify(loadSettings())));
}

function syncJobs(options) {
  options = options || {};
  var settings = loadSettings();
  if (!settings.wsUrl) {
    sendSettingsState();
    sendStatus("Set server URL", SyncState.desynced);
    return;
  }

  if (syncInFlight)
    return;

  if (!activeListLimit || options.reset)
    activeListLimit = settings.displayLimit;
  if (options.loadMore)
    activeListLimit = Math.min(MAX_WATCH_ROWS, activeListLimit + settings.displayLimit);

  syncInFlight = true;
  sendSettingsState();
  sendStatus(options.loadMore ? "Loading more" : "Syncing", SyncState.syncing);
  sendEnvelope(MessageType.jobClear, "", 0, SyncState.syncing);
  log("Sync starting", settings.wsUrl);

  if (currentClient)
    currentClient.close();

  currentClient = new JsonRpcClient(settings.wsUrl);
  currentClient.connect()
    .then(function() {
      return currentClient.request("thread/list", {
        limit: activeListLimit,
        sortKey: "updated_at",
        archived: false,
        sourceKinds: SOURCE_KINDS,
        useStateDbOnly: true
      });
    })
    .then(function(result) {
      var threads = result.data || result.threads || [];
      sendJobs(threads, settings, result);
      currentClient.close();
      currentClient = null;
      syncInFlight = false;
    })
    .catch(function(error) {
      log("Sync failed", error);
      if (currentClient)
        currentClient.close();
      currentClient = null;
      syncInFlight = false;
      sendError(humanError(error));
    });
}

function sendJobs(threads, settings, result) {
  var count = Math.min(threads.length, MAX_WATCH_ROWS);
  var hasMore = Boolean(result && result.nextCursor && count < MAX_WATCH_ROWS);
  var index;

  for (index = 0; index < count; index += 1)
    sendJobItem(threads[index]);

  sendEnvelope(MessageType.jobComplete, [String(count), hasMore ? "1" : "0"].join("|"), 0, SyncState.synced);
  log("Sync complete", count + " jobs");
}

function sendJobItem(thread) {
  var id = sanitizeField(thread.id || thread.sessionId || "", ProtocolByteLimit.threadId);
  var kind = sanitizeField(threadStatusText(thread), 15);
  var title = sanitizeField(thread.name || firstLine(thread.preview) || thread.cwd || "Codex thread", ProtocolByteLimit.title);
  var detail = sanitizeField(listDetail(thread), ProtocolByteLimit.detail);

  sendEnvelope(
    MessageType.jobItem,
    truncateUtf8([id, kind, title, detail].join("|"), ProtocolByteLimit.payload),
    0,
    SyncState.syncing
  );
}

function listDetail(thread) {
  var parts = [];
  var status = threadStatusText(thread);
  var source = thread.source || "";
  var cwd = basename(thread.cwd || "");

  if (status && status !== "notLoaded")
    parts.push(status);
  if (source)
    parts.push(source);
  if (cwd)
    parts.push(cwd);
  return parts.join(" - ") || "Open for latest content";
}

function threadStatusText(thread) {
  var status = thread && thread.status;
  if (!status)
    return "unknown";
  if (typeof status === "string")
    return status;
  return status.type || "unknown";
}

function basename(path) {
  var text = String(path || "");
  var parts = text.split("/");
  return parts[parts.length - 1] || text;
}

function firstLine(text) {
  return String(text || "").split(/\r?\n/)[0];
}

function requestThreadDetail(threadId) {
  threadId = sanitizeField(threadId, ProtocolByteLimit.threadId);
  if (!threadId)
    return;

  setActiveDetailThread(threadId);
  sendStatus("Loading thread", SyncState.syncing);
  runCodexRequest("Thread detail", function(client) {
    return client.request("thread/read", {
      threadId: threadId,
      includeTurns: true
    });
  }).then(function(result) {
    var thread = result.thread || result;
    sendDetailUpdate(threadId, thread);
    if (threadNeedsFollowup(thread))
      scheduleDetailPoll(threadId, true);
  }).catch(function(error) {
    log("Thread detail failed", error);
    sendError(humanError(error));
  });
}

function submitReply(payload) {
  var fields = splitPayload(payload || "");
  var threadId = sanitizeField(fields[0], ProtocolByteLimit.threadId);
  var text = String(fields[1] || "").trim();

  if (!threadId || !text) {
    sendError("Empty reply");
    return;
  }

  setActiveDetailThread(threadId);
  sendStatus("Sending reply", SyncState.syncing);
  runCodexRequest("Reply", function(client) {
    return client.request("thread/read", {
      threadId: threadId,
      includeTurns: true
    }).then(function(result) {
      var thread = result.thread || result;
      var activeTurn = latestInProgressTurn(thread);
      var input = [{
        type: "text",
        text: text,
        text_elements: []
      }];

      if (activeTurn) {
        return client.request("turn/steer", {
          threadId: threadId,
          input: input,
          expectedTurnId: activeTurn.id
        });
      }

      return client.request("turn/start", {
        threadId: threadId,
        input: input
      });
    }).then(function() {
      pendingReplyTextByThreadId[threadId] = text;
      sendStatus("Reply sent", SyncState.syncing);
      sendPendingReplyUpdate(threadId, text);
      return client.request("thread/read", {
        threadId: threadId,
        includeTurns: true
      });
    });
  }).then(function(result) {
    var thread = result.thread || result;
    sendDetailUpdate(threadId, thread);
    if (detailNeedsFollowup(threadId, thread))
      scheduleDetailPoll(threadId, true);
    else
      syncJobs();
  }).catch(function(error) {
    log("Reply failed", error);
    sendError(humanError(error));
  });
}

function runCodexRequest(label, callback) {
  var settings = loadSettings();
  var client;

  if (!settings.wsUrl)
    return Promise.reject(new Error("Set server URL"));

  client = new JsonRpcClient(settings.wsUrl);
  log(label + " starting", settings.wsUrl);
  return client.connect().then(function() {
    return callback(client);
  }).then(function(result) {
    client.close();
    return result;
  }, function(error) {
    client.close();
    throw error;
  });
}

function sendDetailUpdate(threadId, thread) {
  sendDetailBody(threadId, detailBody(threadId, thread), SyncState.synced);
  reconcilePendingReply(threadId, thread);
}

function sendPendingReplyUpdate(threadId, text) {
  sendDetailBody(threadId, appendPendingReply(lastDetailBodyByThreadId[threadId], text), SyncState.syncing);
}

function sendDetailBody(threadId, body, syncState) {
  lastDetailBodyByThreadId[threadId] = body;
  sendEnvelope(
    MessageType.detailUpdate,
    truncateUtf8([sanitizeField(threadId, ProtocolByteLimit.threadId), sanitizeBody(body, ProtocolByteLimit.body)].join("|"), ProtocolByteLimit.payload),
    0,
    syncState
  );
}

function sendDetailUpdateIfChanged(threadId, thread) {
  var body = detailBody(threadId, thread);
  reconcilePendingReply(threadId, thread);
  if (lastDetailBodyByThreadId[threadId] === body)
    return false;

  sendDetailBody(threadId, body, SyncState.synced);
  return true;
}

function setActiveDetailThread(threadId) {
  if (activeDetailThreadId === threadId)
    return;

  activeDetailThreadId = threadId;
  detailPollAttempts = 0;
  detailPollInFlight = false;
  if (detailPollTimer) {
    clearTimeout(detailPollTimer);
    detailPollTimer = null;
  }
}

function scheduleDetailPoll(threadId, resetAttempts) {
  if (threadId !== activeDetailThreadId)
    return;

  if (resetAttempts)
    detailPollAttempts = 0;

  if (detailPollTimer)
    clearTimeout(detailPollTimer);

  detailPollTimer = setTimeout(function() {
    detailPollTimer = null;
    pollThreadDetail(threadId);
  }, DETAIL_POLL_INTERVAL_MS);
}

function pollThreadDetail(threadId) {
  if (threadId !== activeDetailThreadId)
    return;

  if (detailPollInFlight) {
    scheduleDetailPoll(threadId, false);
    return;
  }

  if (detailPollAttempts >= DETAIL_POLL_MAX_ATTEMPTS) {
    log("Thread detail polling stopped", threadId);
    syncJobs();
    return;
  }

  detailPollAttempts += 1;
  detailPollInFlight = true;
  runCodexRequest("Thread detail poll", function(client) {
    return client.request("thread/read", {
      threadId: threadId,
      includeTurns: true
    });
  }).then(function(result) {
    var thread = result.thread || result;
    detailPollInFlight = false;

    if (threadId !== activeDetailThreadId)
      return;

    sendDetailUpdateIfChanged(threadId, thread);
    if (detailNeedsFollowup(threadId, thread))
      scheduleDetailPoll(threadId, false);
    else
      syncJobs();
  }).catch(function(error) {
    detailPollInFlight = false;
    log("Thread detail poll failed", error);
    if (detailPollAttempts < DETAIL_POLL_MAX_ATTEMPTS)
      scheduleDetailPoll(threadId, false);
    else
      sendError(humanError(error));
  });
}

function threadNeedsFollowup(thread) {
  var status = threadStatusText(thread);
  return status === "active" || status === "running" || Boolean(latestInProgressTurn(thread));
}

function detailNeedsFollowup(threadId, thread) {
  return threadNeedsFollowup(thread) || Boolean(pendingReplyTextByThreadId[threadId]);
}

function detailBody(threadId, thread) {
  var body = threadBody(thread);
  var pendingText = pendingReplyTextByThreadId[threadId];

  if (pendingText) {
    if (!threadContainsUserText(thread, pendingText))
      body = appendPendingReply(body, pendingText);
    else if (!threadHasReplyResult(thread, pendingText) && !bodyContainsWorkingIndicator(body))
      body = appendWithReservedSuffix(body, "Codex: working...");
  } else if (threadNeedsFollowup(thread) && !bodyContainsWorkingIndicator(body)) {
    body = appendWithReservedSuffix(body, "Codex: working...");
  }

  return body;
}

function appendPendingReply(body, text) {
  var suffix = [];

  if (!bodyContainsUserText(body, text))
    suffix.push("You: " + text);
  if (!bodyContainsWorkingIndicator(body))
    suffix.push("Codex: working...");

  if (!suffix.length)
    return String(body || "");
  return appendWithReservedSuffix(body, suffix.join("\n\n"));
}

function appendWithReservedSuffix(body, suffix) {
  var base = String(body || "").trim();
  var addition = String(suffix || "").trim();
  var maxBaseBytes;

  if (!addition)
    return base;
  if (!base || base === "No loaded messages yet")
    return addition;

  maxBaseBytes = ProtocolByteLimit.body - utf8ByteLength(addition) - 2;
  if (maxBaseBytes <= 0)
    return addition;

  return truncateUtf8(base, maxBaseBytes).trim() + "\n\n" + addition;
}

function reconcilePendingReply(threadId, thread) {
  var pendingText = pendingReplyTextByThreadId[threadId];
  if (pendingText && threadHasReplyResult(thread, pendingText))
    delete pendingReplyTextByThreadId[threadId];
}

function threadHasReplyResult(thread, text) {
  var target = normalizeTextForMatch(text);
  var turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
  var turnIndex;
  var itemIndex;
  var turn;
  var item;
  var itemText;
  var foundUser;
  var foundVisibleActivity;

  if (!target)
    return false;

  for (turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    turn = turns[turnIndex] || {};
    if (!Array.isArray(turn.items))
      continue;

    foundUser = false;
    foundVisibleActivity = false;
    for (itemIndex = 0; itemIndex < turn.items.length; itemIndex += 1) {
      item = turn.items[itemIndex];
      if (!item)
        continue;

      if (!foundUser && item.type === "userMessage") {
        itemText = normalizeTextForMatch(userInputText(item.content));
        foundUser = itemText === target || itemText.indexOf(target) !== -1;
      } else if (foundUser && item.type !== "userMessage" && threadItemSummary(item)) {
        foundVisibleActivity = true;
      }
    }

    if (foundUser && (foundVisibleActivity || turn.status === "completed" || turn.status === "failed" || turn.status === "canceled"))
      return true;
  }

  return false;
}

function threadContainsUserText(thread, text) {
  var target = normalizeTextForMatch(text);
  var turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
  var turnIndex;
  var itemIndex;
  var item;
  var itemText;

  if (!target)
    return false;

  for (turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    if (!Array.isArray(turns[turnIndex].items))
      continue;
    for (itemIndex = 0; itemIndex < turns[turnIndex].items.length; itemIndex += 1) {
      item = turns[turnIndex].items[itemIndex];
      if (!item || item.type !== "userMessage")
        continue;
      itemText = normalizeTextForMatch(userInputText(item.content));
      if (itemText === target || itemText.indexOf(target) !== -1)
        return true;
    }
  }

  return false;
}

function bodyContainsUserText(body, text) {
  return normalizeTextForMatch(body).indexOf("you: " + normalizeTextForMatch(text)) !== -1;
}

function bodyContainsWorkingIndicator(body) {
  return normalizeTextForMatch(body).indexOf("codex: working") !== -1;
}

function normalizeTextForMatch(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function threadBody(thread) {
  var turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
  var lines = [];
  var turnIndex;
  var itemIndex;
  var item;
  var summary;

  for (turnIndex = turns.length - 1; turnIndex >= 0 && lines.length < 5; turnIndex -= 1) {
    if (!Array.isArray(turns[turnIndex].items))
      continue;
    for (itemIndex = turns[turnIndex].items.length - 1; itemIndex >= 0 && lines.length < 5; itemIndex -= 1) {
      item = turns[turnIndex].items[itemIndex];
      summary = threadItemSummary(item);
      if (summary)
        lines.unshift(summary);
    }
  }

  if (!lines.length && thread && thread.preview)
    lines.push("Thread: " + thread.preview);
  if (!lines.length)
    lines.push("No loaded messages yet");

  return lines.join("\n\n");
}

function threadItemSummary(item) {
  if (!item || !item.type)
    return "";

  if (item.type === "agentMessage")
    return "Codex: " + item.text;
  if (item.type === "userMessage")
    return "You: " + userInputText(item.content);
  if (item.type === "plan")
    return "Plan: " + item.text;
  if (item.type === "commandExecution")
    return "$ " + item.command + (item.status ? " (" + item.status + ")" : "");
  if (item.type === "fileChange")
    return "Files changed: " + item.status;
  if (item.type === "mcpToolCall")
    return "Tool: " + item.server + "/" + item.tool + (item.status ? " (" + item.status + ")" : "");
  if (item.type === "dynamicToolCall")
    return "Tool: " + (item.namespace ? item.namespace + "/" : "") + item.tool;
  if (item.type === "reasoning" && item.summary && item.summary.length)
    return "Reasoning: " + item.summary.join(" ");
  if (item.type === "contextCompaction")
    return "Context compacted";
  return "";
}

function userInputText(content) {
  var parts = [];
  var index;

  if (!Array.isArray(content))
    return "";

  for (index = 0; index < content.length; index += 1) {
    if (content[index] && content[index].type === "text")
      parts.push(content[index].text || "");
  }

  return parts.join(" ");
}

function latestInProgressTurn(thread) {
  var turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
  var index;
  for (index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index] && turns[index].status === "inProgress")
      return turns[index];
  }
  return null;
}

function sendSettingsState() {
  var settings = loadSettings();
  sendEnvelope(
    MessageType.settingsState,
    [settings.wsUrl ? "1" : "0", sanitizeField(settings.wsUrl, 120)].join("|"),
    0,
    settings.wsUrl ? SyncState.syncing : SyncState.desynced
  );
}

function sendStatus(status, syncState) {
  sendEnvelope(MessageType.syncStatus, sanitizeField(status, ProtocolByteLimit.detail), 0, syncState);
}

function sendError(message) {
  sendEnvelope(MessageType.error, sanitizeField(message || "Sync failed", ProtocolByteLimit.detail), 0, SyncState.desynced);
}

function sendEnvelope(type, payload, requestId, syncState) {
  var message = {};
  message[Key.messageType] = type || "";
  message[Key.payload] = payload || "";
  message[Key.requestId] = requestId || 0;
  message[Key.syncState] = syncState == null ? SyncState.desynced : syncState;

  sendQueue.push(message);
  flushSendQueue();
}

function flushSendQueue() {
  if (sending || !sendQueue.length)
    return;

  sending = true;
  Pebble.sendAppMessage(sendQueue[0], function() {
    sending = false;
    sendQueue.shift();
    flushSendQueue();
  }, function(error) {
    sending = false;
    sendQueue.shift();
    log("sendAppMessage failed", error);
    flushSendQueue();
  });
}

function readPayloadValue(payload, numericKey, namedKey) {
  if (!payload)
    return null;
  if (payload[namedKey] !== undefined && payload[namedKey] !== null)
    return payload[namedKey];
  if (payload[numericKey] !== undefined && payload[numericKey] !== null)
    return payload[numericKey];
  if (payload[String(numericKey)] !== undefined && payload[String(numericKey)] !== null)
    return payload[String(numericKey)];
  return null;
}

function loadSettings() {
  var fallback = {
    wsUrl: "",
    displayLimit: 3,
    recentCompletionLookbackMinutes: 720
  };
  var stored = localStorage.getItem(SETTINGS_KEY);
  if (!stored)
    return fallback;

  try {
    return sanitizeSettings(Object.assign(fallback, JSON.parse(stored)));
  } catch (_) {
    return fallback;
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
}

function sanitizeSettings(settings) {
  return {
    wsUrl: typeof settings.wsUrl === "string" ? settings.wsUrl.trim() : "",
    displayLimit: clamp(settings.displayLimit, 1, 8, 3),
    recentCompletionLookbackMinutes: clamp(settings.recentCompletionLookbackMinutes, 5, 10080, 720)
  };
}

function clamp(value, min, max, fallback) {
  var number = Number(value);
  if (!Number.isFinite(number))
    return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function sanitizeField(value, maxBytes) {
  return truncateUtf8(
    String(value == null ? "" : value)
      .replace(/\|/g, "/")
      .replace(/\r?\n/g, " ")
      .trim(),
    maxBytes
  );
}

function sanitizeBody(value, maxBytes) {
  return truncateUtf8(
    String(value == null ? "" : value)
      .replace(/\|/g, "/")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    maxBytes
  );
}

function splitPayload(payload) {
  var text = String(payload || "");
  var separator = text.indexOf("|");
  if (separator === -1)
    return [text, ""];
  return [text.slice(0, separator), text.slice(separator + 1)];
}

function utf8ByteLength(value) {
  var text = String(value == null ? "" : value);
  var length = 0;
  var index;
  var code;
  var next;
  var codeUnitLength;

  for (index = 0; index < text.length; index += codeUnitLength) {
    code = text.charCodeAt(index);
    codeUnitLength = 1;

    if (code <= 0x7F) {
      length += 1;
    } else if (code <= 0x7FF) {
      length += 2;
    } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
      next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        codeUnitLength = 2;
        length += 4;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }

  return length;
}

function truncateUtf8(value, maxBytes) {
  var text = String(value == null ? "" : value);
  var length = 0;
  var end = 0;
  var index;
  var code;
  var next;
  var codeUnitLength;
  var codeByteLength;

  for (index = 0; index < text.length; index += codeUnitLength) {
    code = text.charCodeAt(index);
    codeUnitLength = 1;
    codeByteLength = 1;

    if (code <= 0x7F) {
      codeByteLength = 1;
    } else if (code <= 0x7FF) {
      codeByteLength = 2;
    } else if (code >= 0xD800 && code <= 0xDBFF && index + 1 < text.length) {
      next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        codeUnitLength = 2;
        codeByteLength = 4;
      } else {
        codeByteLength = 3;
      }
    } else {
      codeByteLength = 3;
    }

    if (length + codeByteLength > maxBytes)
      break;

    length += codeByteLength;
    end = index + codeUnitLength;
  }

  return text.slice(0, end);
}

function humanError(error) {
  var message = error && error.message ? error.message : String(error || "Sync failed");
  if (/WebSocket|Handshake status 403|Connection failed/i.test(message))
    return "Cannot reach Codex";
  return message;
}

function log(message, extra) {
  if (extra && extra.message)
    console.log("[PKJS] " + message + ": " + extra.message);
  else if (extra)
    console.log("[PKJS] " + message + ": " + String(extra));
  else
    console.log("[PKJS] " + message);
}

function describeWebSocketEvent(event) {
  var parts = [];
  var names = ["type", "code", "reason", "wasClean", "message"];
  var index;
  var name;
  var value;

  if (!event)
    return "";

  for (index = 0; index < names.length; index += 1) {
    name = names[index];
    try {
      value = event[name];
    } catch (_) {
      value = undefined;
    }
    if (value !== undefined && value !== null && value !== "")
      parts.push(name + "=" + String(value));
  }

  return parts.join(" ");
}

function JsonRpcClient(url) {
  this.url = url;
  this.ws = null;
  this.nextId = 1;
  this.pending = {};
  this.closed = false;
}

JsonRpcClient.prototype.connect = function() {
  var self = this;
  return new Promise(function(resolve, reject) {
    var settled = false;
    function failConnect(error) {
      if (!settled) {
        settled = true;
        reject(error);
      }
      self.rejectAll(error);
    }

    log("WebSocket connecting", self.url);
    try {
      self.ws = new WebSocket(self.url);
    } catch (error) {
      log("WebSocket constructor failed", error);
      failConnect(error);
      return;
    }

    self.ws.onopen = function() {
      log("WebSocket open", self.url);
      log("JSON-RPC initialize sending");
      self.request("initialize", {
        clientInfo: {
          name: "repebble_codex_jobs",
          title: "Codex Jobs for Pebble",
          version: "0.1.0"
        },
        capabilities: {
          experimentalApi: true
        }
      }).then(function(result) {
        log("JSON-RPC initialize complete");
        self.notify("initialized", {});
        settled = true;
        resolve(result);
      }).catch(function(error) {
        log("JSON-RPC initialize failed", error);
        failConnect(error);
      });
    };
    self.ws.onmessage = function(event) {
      log("WebSocket message", event && event.data ? String(event.data).length + " bytes" : "empty");
      self.handleMessage(event.data);
    };
    self.ws.onerror = function(event) {
      var detail = describeWebSocketEvent(event);
      var error = new Error(detail ? "WebSocket error: " + detail : "WebSocket error");
      log("WebSocket error", detail || "no event detail");
      failConnect(error);
    };
    self.ws.onclose = function(event) {
      var detail = describeWebSocketEvent(event);
      var error = new Error(detail ? "WebSocket closed: " + detail : "WebSocket closed");
      log("WebSocket close", detail || "no close detail");
      failConnect(error);
    };
  });
};

JsonRpcClient.prototype.request = function(method, params) {
  var self = this;
  var id = this.nextId++;
  var message = { method: method, id: id, params: params || {} };

  return new Promise(function(resolve, reject) {
    var timer = setTimeout(function() {
      delete self.pending[id];
      reject(new Error(method + " timed out"));
    }, 15000);
    self.pending[id] = { resolve: resolve, reject: reject, timer: timer };
    self.send(message);
  });
};

JsonRpcClient.prototype.notify = function(method, params) {
  this.send({ method: method, params: params || {} });
};

JsonRpcClient.prototype.send = function(message) {
  if (!this.ws || this.ws.readyState !== 1)
    throw new Error("WebSocket is not open");
  log("JSON-RPC send", message.method || ("id=" + message.id));
  this.ws.send(JSON.stringify(message));
};

JsonRpcClient.prototype.handleMessage = function(raw) {
  var message;
  var pending;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    log("Bad JSON-RPC message", error);
    return;
  }

  log("JSON-RPC receive", message.method || ("id=" + message.id) || "notification");

  if (message.id === undefined)
    return;

  pending = this.pending[message.id];
  if (!pending)
    return;

  delete this.pending[message.id];
  clearTimeout(pending.timer);
  if (message.error)
    pending.reject(new Error(message.error.message || "JSON-RPC request failed"));
  else
    pending.resolve(message.result || {});
};

JsonRpcClient.prototype.rejectAll = function(error) {
  var keys = Object.keys(this.pending);
  var index;
  var pending;
  for (index = 0; index < keys.length; index += 1) {
    pending = this.pending[keys[index]];
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  this.pending = {};
};

JsonRpcClient.prototype.close = function() {
  this.closed = true;
  if (this.ws) {
    try {
      this.ws.close();
    } catch (_) {
    }
    this.ws = null;
  }
  this.rejectAll(new Error("JSON-RPC client closed"));
};

module.exports = {
  Key: Key,
  MessageType: MessageType,
  SyncState: SyncState,
  sanitizeSettings: sanitizeSettings,
  truncateUtf8: truncateUtf8,
  JsonRpcClient: JsonRpcClient
};

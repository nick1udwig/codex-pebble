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
  detailScroll: "detail_scroll",
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
  body: 600,
  payload: 720
});

var MAX_WATCH_ROWS = 16;
var DETAIL_CACHE_LIMIT = 5;
var DETAIL_POLL_INTERVAL_MS = 3000;
var DETAIL_POLL_MAX_ATTEMPTS = 20;
var SEND_QUEUE_MAX = 32;
var LIVE_PROGRESS_FLUSH_MS = 300;
var LIVE_TEXT_MAX_BYTES = ProtocolByteLimit.body - 20;

var sendQueue = [];
var sending = false;
var syncInFlight = false;
var currentClient = null;
var detailClient = null;
var detailClientThreadId = "";
var detailClientReady = null;
var activeListLimit = 0;
var listThreads = [];
var listThreadIds = {};
var listNextCursor = null;
var activeDetailThreadId = "";
var detailPollTimer = null;
var detailPollAttempts = 0;
var detailPollInFlight = false;
var detailCacheOrder = [];
var lastDetailBodyByThreadId = {};
var detailPageCacheByThreadId = {};
var pendingReplyTextByThreadId = {};
var liveProgressLineByThreadId = {};
var livePendingLineByThreadId = {};
var liveFlushTimersByThreadId = {};
var liveAgentTextByKey = {};

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
  } else if (type === MessageType.detailScroll) {
    requestDetailScroll(readPayloadValue(event.payload, Key.payload, "Payload"));
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
    resetListCache();
    closeDetailClient();
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
  var requestLimit;
  var requestCursor = null;
  if (!settings.wsUrl) {
    sendSettingsState();
    sendStatus("Set server URL", SyncState.desynced);
    return;
  }

  if (syncInFlight)
    return;

  if (options.loadMore && (!listNextCursor || listThreads.length >= MAX_WATCH_ROWS)) {
    sendJobs([], settings, { nextCursor: null, totalCount: listThreads.length, clear: false });
    return;
  }

  if (options.loadMore) {
    requestLimit = Math.min(settings.displayLimit, MAX_WATCH_ROWS - listThreads.length);
  } else {
    requestLimit = options.reset ? settings.displayLimit : Math.min(MAX_WATCH_ROWS, Math.max(settings.displayLimit, activeListLimit || listThreads.length));
    resetListCache();
    activeListLimit = requestLimit;
  }

  syncInFlight = true;
  sendSettingsState();
  sendStatus(options.loadMore ? "Loading more" : "Syncing", SyncState.syncing);
  log("Sync starting", settings.wsUrl);

  if (currentClient)
    currentClient.close();

  currentClient = new JsonRpcClient(settings.wsUrl);
  currentClient.connect()
    .then(function() {
      var params = {
        limit: requestLimit,
        sortKey: "updated_at",
        archived: false,
        sourceKinds: SOURCE_KINDS,
        useStateDbOnly: true
      };
      if (options.loadMore) {
        requestCursor = listNextCursor;
        params.cursor = requestCursor;
      }
      log("List request", (options.loadMore ? "next" : "first") + " limit=" + requestLimit + " cursor=" + (requestCursor || "none") + " cached=" + listThreads.length);
      return currentClient.request("thread/list", params);
    })
    .then(function(result) {
      var threads = result.data || result.threads || [];
      var page = updateListCache(threads, result, options, requestCursor);
      sendJobs(options.loadMore ? page.addedThreads : listThreads, settings, {
        nextCursor: listNextCursor,
        totalCount: listThreads.length,
        clear: !options.loadMore
      });
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

function resetListCache() {
  listThreads = [];
  listThreadIds = {};
  listNextCursor = null;
}

function updateListCache(threads, result, options, requestCursor) {
  var addedThreads = [];
  var duplicateCount = 0;
  var index;
  var thread;
  var id;
  var nextCursor = result && result.nextCursor ? result.nextCursor : null;

  if (!options.loadMore)
    resetListCache();

  for (index = 0; index < threads.length && listThreads.length < MAX_WATCH_ROWS; index += 1) {
    thread = threads[index];
    id = String((thread && (thread.id || thread.sessionId)) || "");
    if (!id || listThreadIds[id]) {
      if (id)
        duplicateCount += 1;
      continue;
    }
    listThreadIds[id] = true;
    listThreads.push(thread);
    addedThreads.push(thread);
  }

  if (options.loadMore && addedThreads.length === 0 && nextCursor === requestCursor)
    nextCursor = null;

  listNextCursor = nextCursor;
  activeListLimit = listThreads.length || activeListLimit;
  log("List response", "returned=" + threads.length + " added=" + addedThreads.length + " dup=" + duplicateCount + " next=" + (listNextCursor || "none") + " ids=" + summarizeThreadIds(threads));
  return {
    addedThreads: addedThreads,
    duplicateCount: duplicateCount
  };
}

function sendJobs(threads, settings, result) {
  var count = result && result.totalCount != null ? Math.min(result.totalCount, MAX_WATCH_ROWS) : Math.min(threads.length, MAX_WATCH_ROWS);
  var hasMore = Boolean(result && result.nextCursor && count < MAX_WATCH_ROWS);
  var index;

  if (!result || result.clear !== false)
    sendEnvelope(MessageType.jobClear, "", 0, SyncState.syncing);
  for (index = 0; index < threads.length && index < MAX_WATCH_ROWS; index += 1)
    sendJobItem(threads[index]);

  sendEnvelope(MessageType.jobComplete, [String(count), hasMore ? "1" : "0"].join("|"), 0, SyncState.synced);
  log("Sync complete", count + " jobs");
}

function sendJobItem(thread) {
  var id = sanitizeField(thread.id || thread.sessionId || "", ProtocolByteLimit.threadId);
  var kind = sanitizeField(threadStatusText(thread), 15);
  var title = sanitizeField(listTitle(thread), ProtocolByteLimit.title);
  var detail = sanitizeField(listDetail(thread), ProtocolByteLimit.detail);

  sendEnvelope(
    MessageType.jobItem,
    truncateUtf8([id, kind, title, detail].join("|"), ProtocolByteLimit.payload),
    0,
    SyncState.syncing
  );
}

function listTitle(thread) {
  var project = threadProjectName(thread);
  var state = threadStateLabel(thread);

  if (project && state)
    return project + "  " + state;
  return project || state || "Codex thread";
}

function listDetail(thread) {
  var parts = [];
  var timestamp = listThreadTime(thread && (thread.updatedAt || thread.createdAt));
  var context = listContext(thread);
  var prompt = listPrompt(thread);

  if (timestamp)
    parts.push(timestamp);
  if (context)
    parts.push(context);
  if (prompt)
    parts.push(prompt);
  return parts.join(" - ") || "Open for latest content";
}

function threadProjectName(thread) {
  var cwd = basename(thread && thread.cwd || "");
  var repo = repoNameFromOrigin(thread && thread.gitInfo && thread.gitInfo.originUrl);
  return cwd || repo || "Codex";
}

function repoNameFromOrigin(originUrl) {
  var text = String(originUrl || "");
  var slash;

  if (!text)
    return "";
  text = text.replace(/\.git$/, "");
  slash = Math.max(text.lastIndexOf("/"), text.lastIndexOf(":"));
  if (slash !== -1)
    text = text.slice(slash + 1);
  return text;
}

function threadStateLabel(thread) {
  var flags = activeFlags(thread);
  var status = threadStatusText(thread);

  if (hasFlag(flags, "waitingOnApproval"))
    return "approval";
  if (hasFlag(flags, "waitingOnUserInput"))
    return "input";
  if (status === "active")
    return "working";
  if (status === "systemError")
    return "error";
  if (status === "notLoaded")
    return "saved";
  if (status === "idle")
    return "idle";
  return status || "unknown";
}

function activeFlags(thread) {
  var status = thread && thread.status;
  if (status && typeof status !== "string" && status.activeFlags && typeof status.activeFlags.length === "number")
    return status.activeFlags;
  return [];
}

function hasFlag(flags, value) {
  var index;
  for (index = 0; index < flags.length; index += 1) {
    if (flags[index] === value)
      return true;
  }
  return false;
}

function listContext(thread) {
  var parts = [];
  var branch = thread && thread.gitInfo && thread.gitInfo.branch;
  var source = sessionSourceContext(thread && thread.source);
  var role = thread && (thread.agentRole || thread.agentNickname);

  if (branch)
    parts.push(shortBranch(branch));
  if (role)
    parts.push(String(role));
  if (source)
    parts.push(source);
  return parts.join(" ");
}

function shortBranch(branch) {
  branch = String(branch || "");
  if (branch.indexOf("refs/heads/") === 0)
    branch = branch.slice(11);
  return branch;
}

function sessionSourceContext(source) {
  var text = sessionSourceText(source);
  if (text === "cli" || text === "vscode" || text === "appServer")
    return "";
  if (text.indexOf("subAgent:") === 0)
    return text.slice(9);
  return text;
}

function listPrompt(thread) {
  return firstLine(thread && thread.preview) || firstLine(thread && thread.name) || "";
}

function threadStatusText(thread) {
  var status = thread && thread.status;
  if (!status)
    return "unknown";
  if (typeof status === "string")
    return status;
  return status.type || "unknown";
}

function sessionSourceText(source) {
  if (!source)
    return "";
  if (typeof source === "string")
    return source;
  if (source.custom)
    return String(source.custom);
  if (source.subAgent)
    return subAgentSourceText(source.subAgent);
  return "";
}

function subAgentSourceText(source) {
  if (!source)
    return "subAgent";
  if (typeof source === "string")
    return "subAgent:" + source;
  if (source.thread_spawn)
    return "subAgent:spawn";
  if (source.other)
    return "subAgent:" + source.other;
  return "subAgent";
}

function listThreadTime(value) {
  var date = parseThreadDate(value);
  var now = Date.now();
  var diff;
  var minutes;

  if (!date)
    return "";
  diff = now - date.getTime();
  if (diff >= 0) {
    minutes = Math.floor(diff / 60000);
    if (minutes < 1)
      return "now";
    if (minutes < 60)
      return String(minutes) + "m ago";
    if (sameLocalDay(new Date(now), date))
      return clockTime(date);
    if (minutes < 10080)
      return weekdayName(date.getDay()) + " " + clockTime(date);
  }
  return String(date.getMonth() + 1) + "/" + String(date.getDate()) + " " + clockTime(date);
}

function sameLocalDay(left, right) {
  return left.getFullYear() === right.getFullYear() &&
         left.getMonth() === right.getMonth() &&
         left.getDate() === right.getDate();
}

function weekdayName(day) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day] || "";
}

function clockTime(date) {
  return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
}

function parseThreadDate(value) {
  var timestamp;
  if (typeof value === "number") {
    timestamp = value < 100000000000 ? value * 1000 : value;
  } else if (typeof value === "string" && value) {
    timestamp = Date.parse(value);
  } else {
    return null;
  }
  if (!isFinite(timestamp))
    return null;
  return new Date(timestamp);
}

function pad2(value) {
  value = String(value);
  return value.length < 2 ? "0" + value : value;
}

function summarizeThreadIds(threads) {
  var ids = [];
  var index;
  var id;
  for (index = 0; index < threads.length && index < 4; index += 1) {
    id = String((threads[index] && (threads[index].id || threads[index].sessionId)) || "");
    if (id)
      ids.push(id.slice(-6));
  }
  if (threads.length > ids.length)
    ids.push("+" + String(threads.length - ids.length));
  return ids.join(",");
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
  runDetailRequest("Thread detail", threadId, function(client) {
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

function requestDetailScroll(payload) {
  var fields = splitPayload(payload || "");
  var threadId = sanitizeField(fields[0], ProtocolByteLimit.threadId);
  var direction = fields[1] === "older" ? "older" : "newer";

  if (!threadId)
    return;

  if (!detailPageCacheByThreadId[threadId]) {
    requestThreadDetail(threadId);
    return;
  }

  setActiveDetailThread(threadId);
  sendDetailPage(threadId, {
    direction: direction,
    syncState: SyncState.synced
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
  pendingReplyTextByThreadId[threadId] = text;
  sendStatus("Sending reply", SyncState.syncing);
  sendPendingReplyUpdate(threadId, text);
  runDetailRequest("Reply", threadId, function(client) {
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
      sendStatus("Reply sent", SyncState.syncing);
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

function runDetailRequest(label, threadId, callback) {
  var settings = loadSettings();

  if (!settings.wsUrl)
    return Promise.reject(new Error("Set server URL"));

  log(label + " starting", settings.wsUrl);
  return ensureDetailClient(threadId).then(function(client) {
    return callback(client);
  });
}

function ensureDetailClient(threadId) {
  var settings = loadSettings();
  var client;

  if (!settings.wsUrl)
    return Promise.reject(new Error("Set server URL"));

  if (detailClient && detailClientThreadId === threadId && isClientOpen(detailClient))
    return Promise.resolve(detailClient);

  if (detailClientReady && detailClientThreadId === threadId)
    return detailClientReady;

  closeDetailClient();
  detailClientThreadId = threadId;
  detailClient = new JsonRpcClient(settings.wsUrl);
  detailClient.onNotification = handleCodexNotification;
  client = detailClient;

  log("Live detail connecting", settings.wsUrl);
  detailClientReady = client.connect()
    .then(function() {
      return client.request("thread/resume", {
        threadId: threadId
      });
    })
    .then(function(result) {
      var thread = result.thread || result;
      detailClientReady = null;
      if (thread && (thread.id || thread.turns))
        sendDetailUpdate(threadId, thread);
      return client;
    }, function(error) {
      if (detailClient === client) {
        detailClient = null;
        detailClientThreadId = "";
        detailClientReady = null;
      }
      client.close();
      throw error;
    });

  return detailClientReady;
}

function closeDetailClient() {
  var client = detailClient;
  var threadId = detailClientThreadId;

  detailClient = null;
  detailClientThreadId = "";
  detailClientReady = null;

  if (!client)
    return;

  client.onNotification = null;
  try {
    if (threadId && isClientOpen(client)) {
      client.request("thread/unsubscribe", {
        threadId: threadId
      }).then(function() {
        client.close();
      }, function() {
        client.close();
      });
    } else {
      client.close();
    }
  } catch (_) {
    client.close();
  }
}

function isClientOpen(client) {
  return Boolean(client && client.ws && client.ws.readyState === 1);
}

function sendDetailUpdate(threadId, thread) {
  cacheThreadDetail(threadId, thread);
  sendDetailPage(threadId, {
    mode: "latest",
    syncState: SyncState.synced
  });
  reconcilePendingReply(threadId, thread);
}

function sendPendingReplyUpdate(threadId, text) {
  sendDetailBody(threadId, pendingReplyBody(text, "Codex: working..."), SyncState.syncing);
}

function sendDetailBody(threadId, body, syncState, page) {
  var formattedBody = sanitizeDetailBody(body, ProtocolByteLimit.body);
  var anchor = page && page.anchor ? page.anchor : "bottom";
  var hasPrev = page && page.hasPrev ? "1" : "0";
  var hasNext = page && page.hasNext ? "1" : "0";
  rememberDetailThread(threadId);
  lastDetailBodyByThreadId[threadId] = formattedBody;
  sendEnvelope(
    MessageType.detailUpdate,
    truncateUtf8([sanitizeField(threadId, ProtocolByteLimit.threadId), anchor, hasPrev, hasNext, formattedBody].join("|"), ProtocolByteLimit.payload),
    0,
    syncState
  );
}

function sendDetailUpdateIfChanged(threadId, thread) {
  var sent;

  cacheThreadDetail(threadId, thread);
  reconcilePendingReply(threadId, thread);
  sent = sendDetailPage(threadId, {
    mode: "latest",
    syncState: SyncState.synced,
    suppressIfSame: true
  });
  return sent;
}

function setActiveDetailThread(threadId) {
  var previousThreadId = activeDetailThreadId;

  if (activeDetailThreadId === threadId)
    return;

  cancelQueuedLiveProgress(previousThreadId);
  pruneLiveAgentTextForThread(previousThreadId);
  closeDetailClient();
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
  runDetailRequest("Thread detail poll", threadId, function(client) {
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

function handleCodexNotification(method, params) {
  var threadId = notificationThreadId(params);
  var line;

  if (!threadId || threadId !== activeDetailThreadId)
    return;

  log("Live notification", method);
  if (method === "turn/started") {
    sendLiveProgressNow(threadId, "Codex: working...");
  } else if (method === "turn/plan/updated") {
    line = planNotificationSummary(params);
    if (line)
      queueLiveProgress(threadId, line);
  } else if (method === "item/started") {
    line = itemStartedSummary(params.item);
    if (line)
      queueLiveProgress(threadId, line);
  } else if (method === "item/agentMessage/delta") {
    handleAgentMessageDelta(params);
  } else if (method === "item/completed") {
    handleItemCompleted(params);
  } else if (method === "turn/completed") {
    handleTurnCompleted(params);
  } else if (method === "thread/status/changed") {
    if (params && params.status)
      queueLiveProgress(threadId, "Codex: " + threadStatusText({ status: params.status }));
  }
}

function notificationThreadId(params) {
  if (!params)
    return "";
  if (params.threadId)
    return sanitizeField(params.threadId, ProtocolByteLimit.threadId);
  if (params.thread && params.thread.id)
    return sanitizeField(params.thread.id, ProtocolByteLimit.threadId);
  return "";
}

function handleAgentMessageDelta(params) {
  var threadId = notificationThreadId(params);
  var key;
  var text;

  if (!threadId || !params || !params.itemId)
    return;

  key = [threadId, params.turnId || "", params.itemId].join("|");
  text = (liveAgentTextByKey[key] || "") + String(params.delta || "");
  liveAgentTextByKey[key] = truncateUtf8FromEnd(text, LIVE_TEXT_MAX_BYTES);
  if (text)
    queueLiveProgress(threadId, "Codex: " + liveAgentTextByKey[key]);
}

function handleItemCompleted(params) {
  var threadId = notificationThreadId(params);
  var item = params && params.item;
  var summary = threadItemSummary(item);
  var body;
  var cache;
  var key;

  if (!threadId || !summary)
    return;

  cancelQueuedLiveProgress(threadId);
  if (item && item.id) {
    key = [threadId, params.turnId || "", item.id].join("|");
    delete liveAgentTextByKey[key];
  }

  body = clearLiveProgress(threadId);
  if (bodyContainsLine(body, summary))
    return;

  if (pendingReplyTextByThreadId[threadId] && item && item.type !== "userMessage") {
    sendDetailBody(threadId, pendingReplyBody(pendingReplyTextByThreadId[threadId], summary), SyncState.syncing);
    return;
  }

  cache = detailPageCacheByThreadId[threadId];
  if (cache && Array.isArray(cache.sections)) {
    if (!sectionsContainLine(cache.sections, summary))
      cache.sections.push(summary);
    sendDetailPage(threadId, {
      mode: "latest",
      syncState: SyncState.syncing
    });
    return;
  }

  sendDetailBody(threadId, appendWithReservedSuffix(body, summary), SyncState.syncing);
}

function handleTurnCompleted(params) {
  var threadId = notificationThreadId(params);

  if (!threadId)
    return;

  clearLiveProgress(threadId);
  pruneLiveAgentTextForThread(threadId);
  if (params && params.turn)
    sendDetailUpdate(threadId, { id: threadId, turns: [params.turn] });

  refreshDetailFromLiveClient(threadId)
    .then(function(thread) {
      if (threadId !== activeDetailThreadId)
        return;
      sendDetailUpdate(threadId, thread);
      syncJobs();
    })
    .catch(function(error) {
      log("Live completion refresh failed", error);
      if (detailNeedsFollowup(threadId, {}))
        scheduleDetailPoll(threadId, false);
    });
}

function refreshDetailFromLiveClient(threadId) {
  return ensureDetailClient(threadId).then(function(client) {
    return client.request("thread/read", {
      threadId: threadId,
      includeTurns: true
    });
  }).then(function(result) {
    return result.thread || result;
  });
}

function sendLiveProgress(threadId, line) {
  var body;
  var cache;
  var previousLine;

  if (!threadId || !line)
    return;

  if (pendingReplyTextByThreadId[threadId]) {
    liveProgressLineByThreadId[threadId] = line;
    sendDetailBody(threadId, pendingReplyBody(pendingReplyTextByThreadId[threadId], line), SyncState.syncing);
    return;
  }

  cache = detailPageCacheByThreadId[threadId];
  if (cache && Array.isArray(cache.sections)) {
    previousLine = liveProgressLineByThreadId[threadId];
    if (previousLine)
      cache.sections = removeSectionLine(cache.sections, previousLine);
    liveProgressLineByThreadId[threadId] = line;
    cache.sections.push(line);
    sendDetailPage(threadId, {
      mode: "latest",
      syncState: SyncState.syncing
    });
    return;
  }

  body = clearLiveProgress(threadId);
  liveProgressLineByThreadId[threadId] = line;
  sendDetailBody(threadId, appendWithReservedSuffix(body, line), SyncState.syncing);
}

function sendLiveProgressNow(threadId, line) {
  cancelQueuedLiveProgress(threadId);
  sendLiveProgress(threadId, line);
}

function queueLiveProgress(threadId, line) {
  if (!threadId || !line)
    return;

  livePendingLineByThreadId[threadId] = line;
  if (liveFlushTimersByThreadId[threadId])
    return;

  liveFlushTimersByThreadId[threadId] = setTimeout(function() {
    var pending = livePendingLineByThreadId[threadId];
    delete livePendingLineByThreadId[threadId];
    liveFlushTimersByThreadId[threadId] = null;
    if (pending && threadId === activeDetailThreadId)
      sendLiveProgress(threadId, pending);
  }, LIVE_PROGRESS_FLUSH_MS);
}

function cancelQueuedLiveProgress(threadId) {
  if (!threadId)
    return;

  if (liveFlushTimersByThreadId[threadId]) {
    clearTimeout(liveFlushTimersByThreadId[threadId]);
    liveFlushTimersByThreadId[threadId] = null;
  }
  delete livePendingLineByThreadId[threadId];
}

function clearLiveProgress(threadId) {
  var body = removeLiveProgressLine(lastDetailBodyByThreadId[threadId], threadId);
  var cache = detailPageCacheByThreadId[threadId];
  var line = liveProgressLineByThreadId[threadId];

  if (cache && Array.isArray(cache.sections) && line)
    cache.sections = removeSectionLine(cache.sections, line);

  delete liveProgressLineByThreadId[threadId];
  lastDetailBodyByThreadId[threadId] = body;
  return body;
}

function removeLiveProgressLine(body, threadId) {
  var line = liveProgressLineByThreadId[threadId];
  var lines;
  var normalized;
  var index;
  var kept = [];

  body = String(body || "");
  if (!line)
    return body;

  lines = body.split(/\n\n+/);
  normalized = normalizeTextForMatch(line);
  for (index = 0; index < lines.length; index += 1) {
    if (normalizeTextForMatch(lines[index]) !== normalized)
      kept.push(lines[index]);
  }
  return kept.join("\n\n");
}

function bodyContainsLine(body, line) {
  return normalizeTextForMatch(body).indexOf(normalizeTextForMatch(line)) !== -1;
}

function sectionsContainLine(sections, line) {
  return normalizeTextForMatch((sections || []).join(" ")).indexOf(normalizeTextForMatch(line)) !== -1;
}

function removeSectionLine(sections, line) {
  var normalized = normalizeTextForMatch(line);
  var kept = [];
  var index;

  for (index = 0; index < sections.length; index += 1) {
    if (normalizeTextForMatch(sections[index]) !== normalized)
      kept.push(sections[index]);
  }
  return kept;
}

function itemStartedSummary(item) {
  if (!item || !item.type)
    return "Codex: working...";
  if (item.type === "agentMessage")
    return "Codex: writing...";
  if (item.type === "commandExecution")
    return "$ " + item.command + " (running)";
  if (item.type === "dynamicToolCall")
    return "Tool: " + (item.namespace ? item.namespace + "/" : "") + item.tool + " (running)";
  if (item.type === "mcpToolCall")
    return "Tool: " + item.server + "/" + item.tool + " (running)";
  if (item.type === "plan")
    return item.text ? "Plan: " + item.text : "Plan updated";
  return "Codex: working...";
}

function planNotificationSummary(params) {
  var plan = params && Array.isArray(params.plan) ? params.plan : [];
  var index;
  var step;

  for (index = plan.length - 1; index >= 0; index -= 1) {
    step = plan[index];
    if (step && step.step)
      return "Plan: " + step.step;
  }
  if (params && params.explanation)
    return "Plan: " + params.explanation;
  return "Plan updated";
}

function cacheThreadDetail(threadId, thread) {
  var cache = detailPageCacheByThreadId[threadId] || {};
  rememberDetailThread(threadId);
  cache.sections = detailSections(threadId, thread);
  cache.pageStart = typeof cache.pageStart === "number" ? Math.min(cache.pageStart, cache.sections.length) : null;
  cache.pageEnd = typeof cache.pageEnd === "number" ? Math.min(cache.pageEnd, cache.sections.length) : null;
  detailPageCacheByThreadId[threadId] = cache;
  return cache;
}

function rememberDetailThread(threadId) {
  var index;
  var evicted;

  if (!threadId)
    return;

  index = detailCacheOrder.indexOf(threadId);
  if (index !== -1)
    detailCacheOrder.splice(index, 1);
  detailCacheOrder.push(threadId);

  while (detailCacheOrder.length > DETAIL_CACHE_LIMIT) {
    evicted = detailCacheOrder.shift();
    if (evicted !== threadId)
      pruneDetailThread(evicted);
  }
}

function pruneDetailThread(threadId) {
  if (!threadId)
    return;

  cancelQueuedLiveProgress(threadId);
  delete lastDetailBodyByThreadId[threadId];
  delete detailPageCacheByThreadId[threadId];
  delete pendingReplyTextByThreadId[threadId];
  delete liveProgressLineByThreadId[threadId];
  pruneLiveAgentTextForThread(threadId);
}

function pruneLiveAgentTextForThread(threadId) {
  var prefix;
  var keys;
  var index;

  if (!threadId)
    return;

  prefix = threadId + "|";
  keys = Object.keys(liveAgentTextByKey);
  for (index = 0; index < keys.length; index += 1) {
    if (keys[index].indexOf(prefix) === 0)
      delete liveAgentTextByKey[keys[index]];
  }
}

function sendDetailPage(threadId, options) {
  var cache = detailPageCacheByThreadId[threadId];
  var page;

  options = options || {};
  if (!cache || !Array.isArray(cache.sections) || !cache.sections.length)
    cache = cacheThreadDetail(threadId, {});

  page = selectDetailPage(cache, options);
  if (options.suppressIfSame && lastDetailBodyByThreadId[threadId] === page.body)
    return false;

  cache.pageStart = page.start;
  cache.pageEnd = page.end;
  sendDetailBody(threadId, page.body, options.syncState == null ? SyncState.synced : options.syncState, {
    anchor: page.anchor,
    hasPrev: page.start > 0,
    hasNext: page.end < cache.sections.length
  });
  return true;
}

function selectDetailPage(cache, options) {
  var sections = cache.sections || ["No loaded messages yet"];

  if (typeof cache.pageStart !== "number" || typeof cache.pageEnd !== "number")
    return detailPageEndingAt(sections, sections.length, "bottom");

  if (options.direction === "older") {
    if (cache.pageStart > 0)
      return detailPageEndingAt(sections, cache.pageStart, "bottom");
    return detailPageStartingAt(sections, 0, "top");
  }

  if (options.direction === "newer") {
    if (cache.pageEnd < sections.length)
      return detailPageStartingAt(sections, cache.pageEnd, "top");
    return detailPageEndingAt(sections, sections.length, "bottom");
  }

  if (options.mode === "current" && typeof cache.pageStart === "number")
    return detailPageStartingAt(sections, cache.pageStart, "keep");

  return detailPageEndingAt(sections, sections.length, "bottom");
}

function detailPageEndingAt(sections, end, anchor) {
  var selected = [];
  var candidate;
  var index;

  end = clamp(end, 0, sections.length, sections.length);
  if (end <= 0)
    return detailPageStartingAt(sections, 0, "top");

  for (index = end - 1; index >= 0; index -= 1) {
    candidate = [sections[index]].concat(selected).join("\n\n");
    if (utf8ByteLength(candidate) <= ProtocolByteLimit.body) {
      selected.unshift(sections[index]);
    } else if (!selected.length) {
      return {
        start: index,
        end: index + 1,
        body: truncateUtf8(sections[index], ProtocolByteLimit.body),
        anchor: anchor || "bottom"
      };
    } else {
      break;
    }
  }

  return {
    start: index + 1,
    end: end,
    body: selected.join("\n\n"),
    anchor: anchor || "bottom"
  };
}

function detailPageStartingAt(sections, start, anchor) {
  var selected = [];
  var candidate;
  var index;

  start = clamp(start, 0, Math.max(sections.length - 1, 0), 0);
  for (index = start; index < sections.length; index += 1) {
    candidate = selected.concat([sections[index]]).join("\n\n");
    if (utf8ByteLength(candidate) <= ProtocolByteLimit.body) {
      selected.push(sections[index]);
    } else if (!selected.length) {
      return {
        start: index,
        end: index + 1,
        body: truncateUtf8(sections[index], ProtocolByteLimit.body),
        anchor: anchor || "top"
      };
    } else {
      break;
    }
  }

  return {
    start: start,
    end: index,
    body: selected.join("\n\n"),
    anchor: anchor || "top"
  };
}

function detailSections(threadId, thread) {
  var sections = threadSections(thread);
  var pendingText = pendingReplyTextByThreadId[threadId];

  if (pendingText) {
    if (!threadContainsUserText(thread, pendingText))
      return pendingReplySections(pendingText, "Codex: working...");
    if (!threadHasReplyResult(thread, pendingText) && !sectionsContainWorkingIndicator(sections))
      sections.push("Codex: working...");
  } else if (threadNeedsFollowup(thread) && !sectionsContainWorkingIndicator(sections)) {
    sections.push("Codex: working...");
  }

  return sections;
}

function detailBody(threadId, thread) {
  return detailSections(threadId, thread).join("\n\n");
}

function pendingReplyBody(text, progressLine) {
  return pendingReplySections(text, progressLine).join("\n\n");
}

function pendingReplySections(text, progressLine) {
  var sections = ["You: " + String(text || "").trim()];
  var progress = String(progressLine || "").trim();

  if (!progress)
    return sections;
  sections.push(progress);
  return sections;
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

function joinPreservingPrefix(prefix, suffix, maxBytes) {
  var head = String(prefix || "").trim();
  var tail = String(suffix || "").trim();
  var separator = "\n\n";
  var tailMaxBytes;

  if (!head)
    return truncateUtf8(tail, maxBytes);
  if (!tail)
    return truncateUtf8(head, maxBytes);

  tailMaxBytes = maxBytes - utf8ByteLength(head) - utf8ByteLength(separator);
  if (tailMaxBytes <= 0)
    return truncateUtf8(head, maxBytes);
  return head + separator + truncateUtf8(tail, tailMaxBytes);
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

function normalizeTextForMatch(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function sectionsContainWorkingIndicator(sections) {
  return normalizeTextForMatch((sections || []).join(" ")).indexOf("codex: working") !== -1;
}

function threadSections(thread) {
  var turns = thread && Array.isArray(thread.turns) ? thread.turns : [];
  var lines = [];
  var turnIndex;
  var itemIndex;
  var item;
  var summary;

  for (turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    if (!Array.isArray(turns[turnIndex].items))
      continue;
    for (itemIndex = 0; itemIndex < turns[turnIndex].items.length; itemIndex += 1) {
      item = turns[turnIndex].items[itemIndex];
      summary = threadItemSummary(item);
      if (summary)
        lines.push(summary);
    }
  }

  if (!lines.length && thread && thread.preview)
    lines.push("Thread: " + thread.preview);
  if (!lines.length)
    lines.push("No loaded messages yet");

  return lines;
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

  enqueueMessage(message);
  flushSendQueue();
}

function enqueueMessage(message) {
  var index = coalescableQueuedMessageIndex(message);

  if (index !== -1) {
    sendQueue[index] = message;
    return;
  }

  if (sendQueue.length >= SEND_QUEUE_MAX && !dropQueuedLowPriorityMessage()) {
    log("send queue full", "dropping " + message[Key.messageType]);
    return;
  }

  sendQueue.push(message);
}

function coalescableQueuedMessageIndex(message) {
  var type = message[Key.messageType];
  var threadId;
  var index;
  var start = sending ? 1 : 0;

  if (type === MessageType.syncStatus || type === MessageType.settingsState) {
    for (index = sendQueue.length - 1; index >= start; index -= 1) {
      if (sendQueue[index][Key.messageType] === type)
        return index;
    }
    return -1;
  }

  if (type !== MessageType.detailUpdate)
    return -1;

  threadId = envelopeThreadId(message);
  if (!threadId)
    return -1;

  for (index = sendQueue.length - 1; index >= start; index -= 1) {
    if (sendQueue[index][Key.messageType] === MessageType.detailUpdate && envelopeThreadId(sendQueue[index]) === threadId)
      return index;
  }
  return -1;
}

function dropQueuedLowPriorityMessage() {
  var start = sending ? 1 : 0;
  var index;
  var type;

  for (index = start; index < sendQueue.length; index += 1) {
    type = sendQueue[index][Key.messageType];
    if (type === MessageType.detailUpdate || type === MessageType.syncStatus || type === MessageType.settingsState) {
      log("send queue full", "dropping queued " + type);
      sendQueue.splice(index, 1);
      return true;
    }
  }
  return false;
}

function envelopeThreadId(message) {
  var payload = String(message && message[Key.payload] || "");
  var separator = payload.indexOf("|");
  if (separator === -1)
    return payload;
  return payload.slice(0, separator);
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
    displayLimit: 3
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
    displayLimit: clamp(settings.displayLimit, 1, 8, 3)
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

function sanitizeDetailBody(value, maxBytes) {
  var text = String(value == null ? "" : value)
    .replace(/\|/g, "/")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (utf8ByteLength(text) <= maxBytes)
    return text;
  return fitRecentDetailBody(text, maxBytes);
}

function fitRecentDetailBody(text, maxBytes) {
  var sections = String(text || "").split(/\n\n+/);
  var selected = [];
  var candidate;
  var index;

  if (!sections.length)
    return truncateUtf8(text, maxBytes);

  if (/^you:/i.test(sections[0]) && sections.length > 1 && !hasLaterUserSection(sections))
    return joinPreservingPrefix(sections[0], sections.slice(1).join("\n\n"), maxBytes);

  for (index = sections.length - 1; index >= 0; index -= 1) {
    candidate = [sections[index]].concat(selected).join("\n\n");
    if (utf8ByteLength(candidate) <= maxBytes) {
      selected.unshift(sections[index]);
    } else if (!selected.length) {
      return truncateUtf8(sections[index], maxBytes);
    } else {
      break;
    }
  }

  return selected.join("\n\n");
}

function hasLaterUserSection(sections) {
  var index;

  for (index = 1; index < sections.length; index += 1) {
    if (/^you:/i.test(sections[index]))
      return true;
  }
  return false;
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

function truncateUtf8FromEnd(value, maxBytes) {
  var text = String(value == null ? "" : value);
  var prefix = "...";
  var targetBytes = maxBytes - utf8ByteLength(prefix);
  var length = 0;
  var start = text.length;
  var index;
  var code;
  var previous;
  var codeUnitLength;
  var codeByteLength;

  if (utf8ByteLength(text) <= maxBytes)
    return text;
  if (targetBytes <= 0)
    return truncateUtf8(text, maxBytes);

  for (index = text.length; index > 0; index -= codeUnitLength) {
    code = text.charCodeAt(index - 1);
    codeUnitLength = 1;
    codeByteLength = 1;

    if (code >= 0xDC00 && code <= 0xDFFF && index - 2 >= 0) {
      previous = text.charCodeAt(index - 2);
      if (previous >= 0xD800 && previous <= 0xDBFF) {
        codeUnitLength = 2;
        codeByteLength = 4;
      } else {
        codeByteLength = 3;
      }
    } else if (code <= 0x7F) {
      codeByteLength = 1;
    } else if (code <= 0x7FF) {
      codeByteLength = 2;
    } else {
      codeByteLength = 3;
    }

    if (length + codeByteLength > targetBytes)
      break;

    length += codeByteLength;
    start = index - codeUnitLength;
  }

  return prefix + text.slice(start);
}

function humanError(error) {
  var message = error && error.message ? error.message : String(error || "Sync failed");
  if (/401|unauthorized|bad token|invalid token/i.test(message))
    return "Bad relay token";
  if (/409|already connected|already-connected/i.test(message))
    return "Another watch is connected";
  if (/502|bad gateway|upstream connect failed|app-server unavailable/i.test(message))
    return "Codex app-server unavailable";
  if (/timed out|timeout/i.test(message))
    return "Codex request timed out";
  if (/403|forbidden|rejected/i.test(message))
    return "Relay rejected connection";
  if (/WebSocket|Connection failed|NetworkError|ECONNREFUSED/i.test(message))
    return "Cannot reach Codex relay";
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
  this.onNotification = null;
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

  if (message.id === undefined) {
    if (message.method && this.onNotification) {
      try {
        this.onNotification(message.method, message.params || {});
      } catch (error) {
        log("Notification handler failed", error);
      }
    }
    return;
  }

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

import Poco from "commodetto/Poco";
import Button from "pebble/button";
import Message from "pebble/message";
import CodexRpcClient from "./codex_rpc";
import VoiceReply from "./dictation";
import { drawDashboard } from "./views/dashboard";
import { drawDetail, drawDictation } from "./views/detail";
import { drawConnecting, drawSettingsNeeded } from "./views/settings_needed";
import {
    SOURCE_KINDS,
    acknowledgeJob,
    buildVisibleJobs,
    getLatestTurnFromThread,
    getThreadId,
    getThreadStatusType,
    getTurnId,
    getTurnStatus,
    hasWaitingOnApproval,
    isTerminalJob,
    loadAppState,
    loadCachedDashboard,
    loadSettings,
    mergeSettings,
    nowUnix,
    saveAppState,
    saveCachedDashboard,
    saveSettings
} from "./jobs";

const render = new Poco(screen);
const fonts = {
    title: new render.Font("Gothic-Bold", 18),
    body: new render.Font("Gothic-Regular", 18),
    small: new render.Font("Gothic-Regular", 14)
};

let settings = loadSettings();
let appState = loadAppState();
let dashboard = loadCachedDashboard();
let mode = settings.wsUrl ? "dashboard" : "settings";
let selectedIndex = 0;
let expanded = false;
let detailJobId = "";
let syncing = false;
let stale = !!dashboard.stale;
let connectionState = "";
let errorMessage = "";
let replyText = "";
let replyError = "";
let reconnectDelay = 2000;
let reconnectTimer = null;
let syncTimer = null;
let phoneMessage = null;
let rpc = null;
let subscribedThreadIds = new Set();

const voiceReply = new VoiceReply({
    onText(text) {
        replyText = text || "";
        replyError = "";
        mode = "dictationPreview";
        redraw();
    },
    onError(error) {
        replyError = "Dictation canceled";
        errorMessage = error ? String(error) : "";
        mode = "detail";
        redraw();
    }
});

phoneMessage = new Message({
    keys: ["Config", "ConfigRequest"],
    onReadable() {
        const msg = this.read();
        const config = msg.get("Config");
        if (config !== undefined)
            applyConfig(config);
    },
    onWritable() {
        if (this.requestedConfig)
            return;
        this.requestedConfig = true;
        requestPhoneConfig();
    }
});

new Button({
    types: ["select", "up", "down", "back"],
    onPush(down, type) {
        if (down)
            return;
        handleButton(type);
    }
});

watch.addEventListener("connected", () => {
    if (watch.connected.pebblekit)
        start();
    else
        markPhoneMissing();
});

if (typeof addEventListener === "function") {
    addEventListener("beforeunload", closeForExit);
    addEventListener("unload", closeForExit);
}

redraw();
start();

function start() {
    if (!settings.wsUrl) {
        mode = "settings";
        redraw();
        return;
    }

    if (!watch.connected.pebblekit) {
        markPhoneMissing();
        return;
    }

    connectAndSync();
}

async function connectAndSync() {
    clearReconnect();
    if (syncing)
        return;

    syncing = true;
    errorMessage = "";
    connectionState = "connecting";
    if (!dashboard.jobs || !dashboard.jobs.length)
        mode = "connecting";
    redraw();

    try {
        await shutdownRpc(false);
        rpc = new CodexRpcClient(settings.wsUrl, {
            onNotify: handleNotification,
            onStateChange(state) {
                connectionState = state;
                redraw();
            },
            onError(error) {
                errorMessage = error.message || String(error);
                redraw();
            },
            onClose() {
                stale = true;
                saveCachedDashboard({ ...dashboard, stale: true });
                scheduleReconnect();
            }
        });

        await rpc.connect();
        reconnectDelay = 2000;
        mode = "dashboard";
        await syncDashboard();
        stale = false;
        errorMessage = "";
    } catch (error) {
        errorMessage = humanError(error);
        stale = !!(dashboard.jobs && dashboard.jobs.length);
        if (!stale)
            mode = "connecting";
        scheduleReconnect();
    } finally {
        syncing = false;
        redraw();
    }
}

async function shutdownRpc(unsubscribe) {
    if (!rpc)
        return;

    if (unsubscribe) {
        const ids = Array.from(subscribedThreadIds);
        for (const threadId of ids) {
            try {
                await rpc.request("thread/unsubscribe", { threadId }, { retries: 0, timeout: 3000 });
            } catch (_) {
            }
        }
    }

    subscribedThreadIds.clear();
    rpc.close();
    rpc = null;
}

async function syncDashboard() {
    if (!rpc)
        return;

    connectionState = "syncing";
    redraw();

    const loadedThreads = await fetchLoadedThreads();
    const listedThreads = await fetchListedThreads();
    const byId = new Map();

    for (const thread of loadedThreads) {
        const id = getThreadId(thread);
        if (id)
            byId.set(id, thread);
    }
    for (const thread of listedThreads) {
        const id = getThreadId(thread);
        if (id && !byId.has(id))
            byId.set(id, thread);
    }

    const entries = [];
    const threads = Array.from(byId.values()).slice(0, 25);
    for (const thread of threads) {
        entries.push(await fetchThreadSummary(thread));
    }

    const result = buildVisibleJobs(entries, appState, settings, nowUnix());
    appState = result.appState;
    dashboard = {
        jobs: result.jobs,
        syncedAt: nowUnix(),
        stale: false
    };

    saveAppState(appState);
    saveCachedDashboard(dashboard);
    clampSelection();
    await updateSubscriptions();
}

async function fetchLoadedThreads() {
    const result = await rpc.request("thread/loaded/list", {});
    const values = result.threadIds || result.ids || result.data || result.threads || [];
    const threads = [];

    for (const value of values) {
        if (typeof value === "string") {
            const read = await rpc.request("thread/read", { threadId: value, includeTurns: false });
            if (read.thread || read.id)
                threads.push(read.thread || read);
        } else if (value && getThreadId(value)) {
            threads.push(value);
        }
    }

    return threads;
}

async function fetchListedThreads() {
    const result = await rpc.request("thread/list", {
        limit: 25,
        sortKey: "updated_at",
        archived: false,
        sourceKinds: SOURCE_KINDS
    });
    return result.data || result.threads || [];
}

async function fetchThreadSummary(thread) {
    const threadId = getThreadId(thread);
    if (!threadId)
        return { thread, latestTurn: null };

    const result = await rpc.request("thread/read", {
        threadId,
        includeTurns: true
    });
    const hydratedThread = result.thread || result;
    return {
        thread: hydratedThread || thread,
        latestTurn: getLatestTurnFromThread(hydratedThread)
    };
}

async function updateSubscriptions() {
    const next = new Set();
    for (const job of dashboard.jobs || []) {
        if (job.kind === "active")
            next.add(job.id);
    }

    for (const threadId of Array.from(subscribedThreadIds)) {
        if (!next.has(threadId)) {
            try {
                await rpc.request("thread/unsubscribe", { threadId }, { retries: 0, timeout: 3000 });
            } catch (_) {
            }
            subscribedThreadIds.delete(threadId);
        }
    }

    for (const threadId of Array.from(next)) {
        if (!subscribedThreadIds.has(threadId)) {
            try {
                await rpc.request("thread/resume", { threadId });
                subscribedThreadIds.add(threadId);
            } catch (_) {
            }
        }
    }
}

function handleNotification(method, params) {
    const threadId = params.threadId || getThreadId(params.thread) || (params.turn && params.turn.threadId);
    if (!threadId)
        return;

    if (method === "thread/closed") {
        subscribedThreadIds.delete(threadId);
        return;
    }

    let changed = false;
    let job = findJob(threadId);

    if (!job) {
        scheduleSyncSoon();
        return;
    }

    if (method === "thread/status/changed") {
        const thread = params.thread || { status: params.status };
        job.statusType = getThreadStatusType(thread);
        job.waitingOnApproval = hasWaitingOnApproval(thread);
        if (job.statusType === "systemError")
            job.kind = "systemError";
        else if (job.statusType === "active")
            job.kind = "active";
        changed = true;
    } else if (method === "turn/started") {
        job.kind = "active";
        job.statusType = "active";
        job.latestTurnId = getTurnId(params.turn) || job.latestTurnId;
        job.latestTurnStatus = "inProgress";
        rememberActive(job);
        changed = true;
    } else if (method === "turn/plan/updated") {
        job.progress = extractPlanText(params) || job.progress;
        changed = true;
    } else if (method === "item/agentMessage/delta") {
        const delta = params.delta || params.text || "";
        if (delta)
            job.progress = trimPreview((job.progress || "") + delta);
        changed = true;
    } else if (method === "turn/completed") {
        const status = getTurnStatus(params.turn) || params.status || "completed";
        job.latestTurnId = getTurnId(params.turn) || params.turnId || job.latestTurnId;
        job.latestTurnStatus = status;
        job.kind = status;
        job.statusType = "idle";
        job.waitingOnApproval = false;
        changed = true;
    } else if (method === "serverRequest/resolved") {
        job.waitingOnApproval = false;
        changed = true;
    }

    if (changed) {
        dashboard.stale = false;
        saveCachedDashboard(dashboard);
        redraw();
    }
}

function handleButton(type) {
    if (mode === "settings") {
        if (type === "select")
            requestPhoneConfig();
        return;
    }

    if (mode === "connecting") {
        if (type === "select")
            connectAndSync();
        return;
    }

    if (mode === "dashboard") {
        handleDashboardButton(type);
        return;
    }

    if (mode === "detail") {
        handleDetailButton(type);
        return;
    }

    if (mode === "dictating") {
        if (type === "back")
            mode = "detail";
        redraw();
        return;
    }

    if (mode === "dictationPreview") {
        if (type === "select")
            sendReply();
        else if (type === "up")
            startVoiceReply();
        else if (type === "down" || type === "back")
            mode = "detail";
        redraw();
    }
}

function handleDashboardButton(type) {
    const display = dashboardDisplay();
    const count = display.jobs.length + (display.hasMore ? 1 : 0);

    if (type === "up") {
        selectedIndex = Math.max(0, selectedIndex - 1);
    } else if (type === "down") {
        selectedIndex = Math.min(Math.max(0, count - 1), selectedIndex + 1);
    } else if (type === "select") {
        if (display.hasMore && selectedIndex === display.jobs.length) {
            expanded = !expanded;
            selectedIndex = 0;
        } else if (display.jobs[selectedIndex]) {
            detailJobId = display.jobs[selectedIndex].id;
            mode = "detail";
        } else {
            connectAndSync();
        }
    }

    redraw();
}

function handleDetailButton(type) {
    const job = currentDetailJob();
    if (!job) {
        mode = "dashboard";
        redraw();
        return;
    }

    if (type === "back") {
        mode = "dashboard";
    } else if (type === "select") {
        startVoiceReply();
    } else if (type === "up" && isTerminalJob(job)) {
        acknowledgeCurrentJob();
    } else if (type === "up" || type === "down") {
        scheduleSyncSoon(0);
    }

    redraw();
}

function startVoiceReply() {
    replyText = "";
    replyError = "";
    mode = "dictating";
    redraw();
    voiceReply.start();
}

async function sendReply() {
    const job = currentDetailJob();
    if (!job || !replyText || !rpc)
        return;

    replyError = "";
    redraw();

    try {
        const read = await rpc.request("thread/read", { threadId: job.id, includeTurns: true });
        const thread = read.thread || read;
        const latestTurn = getLatestTurnFromThread(thread);
        const latestStatus = getTurnStatus(latestTurn);
        const activeThread = getThreadStatusType(thread) === "active";
        const input = [{ type: "text", text: replyText }];

        if (latestStatus === "inProgress" && activeThread) {
            await rpc.request("turn/steer", {
                threadId: job.id,
                expectedTurnId: getTurnId(latestTurn),
                input
            });
        } else {
            await rpc.request("thread/resume", { threadId: job.id });
            await rpc.request("turn/start", {
                threadId: job.id,
                input
            });
        }

        replyText = "";
        mode = "detail";
        await syncDashboard();
    } catch (error) {
        replyError = humanError(error);
        mode = "dictationPreview";
    }

    redraw();
}

function acknowledgeCurrentJob() {
    const job = currentDetailJob();
    appState = acknowledgeJob(appState, job);
    dashboard.jobs = (dashboard.jobs || []).filter(item => {
        return item.id !== job.id || item.latestTurnId !== job.latestTurnId;
    });
    saveAppState(appState);
    saveCachedDashboard(dashboard);
    mode = "dashboard";
    clampSelection();
}

function applyConfig(rawConfig) {
    let parsed = rawConfig;
    if (typeof rawConfig === "string") {
        try {
            parsed = JSON.parse(rawConfig);
        } catch (_) {
            errorMessage = "Bad config";
            redraw();
            return;
        }
    }

    settings = mergeSettings(parsed);
    saveSettings(settings);
    mode = settings.wsUrl ? "dashboard" : "settings";
    redraw();
    start();
}

function requestPhoneConfig() {
    if (!phoneMessage)
        return;

    const msg = new Map();
    msg.set("ConfigRequest", 1);
    try {
        phoneMessage.write(msg);
    } catch (error) {
        errorMessage = error.message || String(error);
        redraw();
    }
}

function redraw() {
    if (mode === "settings") {
        drawSettingsNeeded(render, fonts, { errorMessage });
        return;
    }

    if (mode === "connecting") {
        drawConnecting(render, fonts, {
            message: connectionState === "syncing" ? "Syncing..." : "Connecting...",
            errorMessage
        });
        return;
    }

    if (mode === "detail") {
        const job = currentDetailJob();
        drawDetail(render, fonts, {
            job,
            canAck: isTerminalJob(job),
            replyText,
            errorMessage: replyError || errorMessage
        });
        return;
    }

    if (mode === "dictating") {
        drawDictation(render, fonts, {
            title: "Voice reply",
            listening: true
        });
        return;
    }

    if (mode === "dictationPreview") {
        drawDictation(render, fonts, {
            title: "Send reply?",
            replyText,
            errorMessage: replyError
        });
        return;
    }

    const display = dashboardDisplay();
    drawDashboard(render, fonts, {
        jobs: display.jobs,
        hasMore: display.hasMore,
        expanded,
        selectedIndex,
        stale,
        syncing,
        connectionState,
        errorMessage
    });
}

function dashboardDisplay() {
    const jobs = dashboard.jobs || [];
    const limit = expanded ? jobs.length : settings.displayLimit;
    return {
        jobs: jobs.slice(0, limit),
        hasMore: jobs.length > limit
    };
}

function currentDetailJob() {
    return (dashboard.jobs || []).find(job => job.id === detailJobId) || null;
}

function findJob(threadId) {
    return (dashboard.jobs || []).find(job => job.id === threadId) || null;
}

function rememberActive(job) {
    if (!appState.threads[job.id])
        appState.threads[job.id] = { ackedTurnIds: [] };
    appState.threads[job.id].lastSeenStatus = "active";
    appState.threads[job.id].lastSeenTurnId = job.latestTurnId || "";
    appState.threads[job.id].lastSeenUpdatedAt = nowUnix();
    saveAppState(appState);
}

function extractPlanText(params) {
    const plan = params.plan || params.update || params;
    if (typeof plan === "string")
        return trimPreview(plan);
    if (plan && plan.summary)
        return trimPreview(String(plan.summary));
    if (plan && Array.isArray(plan.items) && plan.items.length) {
        const item = plan.items[0];
        return trimPreview(String(item.text || item.title || item.summary || ""));
    }
    return "";
}

function trimPreview(value) {
    const clean = String(value || "").replace(/\s+/g, " ").trim();
    return clean.length > 80 ? clean.slice(0, 77) + "..." : clean;
}

function clampSelection() {
    const display = dashboardDisplay();
    const count = display.jobs.length + (display.hasMore ? 1 : 0);
    selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, count - 1)));
}

function scheduleSyncSoon(delayMs = 750) {
    if (syncTimer)
        clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
        syncTimer = null;
        if (rpc)
            syncDashboard().then(redraw).catch(error => {
                errorMessage = humanError(error);
                stale = true;
                redraw();
            });
    }, delayMs);
}

function scheduleReconnect() {
    if (reconnectTimer || !settings.wsUrl)
        return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        reconnectDelay = Math.min(60000, reconnectDelay * 2);
        connectAndSync();
    }, reconnectDelay);
}

function clearReconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function markPhoneMissing() {
    errorMessage = "Phone link not ready";
    stale = !!(dashboard.jobs && dashboard.jobs.length);
    mode = stale ? "dashboard" : "connecting";
    redraw();
}

function closeForExit() {
    clearReconnect();
    if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
    }

    if (!rpc)
        return;

    for (const threadId of Array.from(subscribedThreadIds)) {
        try {
            rpc.request("thread/unsubscribe", { threadId }, { retries: 0, timeout: 1000 }).catch(() => {});
        } catch (_) {
        }
    }

    subscribedThreadIds.clear();
    rpc.close();
    rpc = null;
}

function humanError(error) {
    if (!error)
        return "Unknown error";
    if (error.message)
        return error.message;
    return String(error);
}

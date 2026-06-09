import { describe, expect, it } from "vitest";
import {
  acknowledgeJob,
  buildVisibleJobs,
  isTerminalJob,
} from "../../../src/embeddedjs/jobs.js";

const settings = {
  wsUrl: "ws://codex.tailnet:4500",
  displayLimit: 3,
  recentCompletionLookbackMinutes: 60,
};

describe("job visibility", () => {
  it("shows active threads", () => {
    const result = buildVisibleJobs([
      entry("thr_active", "active", "inProgress", 1000),
    ], emptyState(), settings, 1000);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].kind).toBe("active");
  });

  it("shows system error threads", () => {
    const result = buildVisibleJobs([
      entry("thr_error", "systemError", "failed", 1000),
    ], emptyState(), settings, 1000);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].kind).toBe("systemError");
  });

  it("hides old completed history on first sync", () => {
    const result = buildVisibleJobs([
      entry("thr_old", "idle", "completed", 100),
    ], emptyState(), settings, 10000);

    expect(result.jobs).toHaveLength(0);
  });

  it("shows recent completed threads until locally acked", () => {
    const result = buildVisibleJobs([
      entry("thr_recent", "idle", "completed", 980),
    ], emptyState(), settings, 1000);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].kind).toBe("completed");
    expect(isTerminalJob(result.jobs[0])).toBe(true);

    const acked = acknowledgeJob(result.appState, result.jobs[0]);
    const afterAck = buildVisibleJobs([
      entry("thr_recent", "idle", "completed", 980),
    ], acked, settings, 1010);

    expect(afterAck.jobs).toHaveLength(0);
  });

  it("keeps previously active completed threads visible past lookback", () => {
    const state = emptyState();
    state.threads.thr_seen = {
      lastSeenStatus: "active",
      lastSeenTurnId: "turn_seen",
      lastSeenUpdatedAt: 100,
      ackedTurnIds: [],
    };

    const result = buildVisibleJobs([
      entry("thr_seen", "idle", "completed", 100),
    ], state, settings, 1000);

    expect(result.jobs).toHaveLength(1);
  });

  it("shows completed work newer than the last successful watermark", () => {
    const state = emptyState();
    state.watermark.lastSuccessfulSyncUnix = 5000;

    const result = buildVisibleJobs([
      entry("thr_new", "idle", "completed", 5100),
    ], state, settings, 10000);

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].kind).toBe("completed");
  });

  it("marks active approval waits ahead of ordinary running jobs", () => {
    const result = buildVisibleJobs([
      entry("thr_running", "active", "inProgress", 1000),
      {
        ...entry("thr_approval", "active", "inProgress", 900),
        thread: {
          id: "thr_approval",
          title: "approval",
          status: { type: "active", activeFlags: ["waitingOnApproval"] },
          updatedAt: 900,
        },
      },
    ], emptyState(), settings, 1000);

    expect(result.jobs.map(job => job.id)).toEqual(["thr_approval", "thr_running"]);
    expect(result.jobs[0].waitingOnApproval).toBe(true);
  });
});

function emptyState() {
  return {
    watermark: { lastSuccessfulSyncUnix: 0 },
    threads: {},
  };
}

function entry(id, threadStatus, turnStatus, updatedAt) {
  return {
    thread: {
      id,
      title: id,
      status: { type: threadStatus },
      updatedAt,
    },
    latestTurn: {
      id: "turn_" + id,
      status: turnStatus,
      updatedAt,
      summary: "summary " + id,
    },
  };
}

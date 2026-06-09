Spec: RePebble Codex Jobs watch app

Scope: Alloy JavaScript watch app + PebbleKit JS network proxy + hosted config page. No native phone companion. No custom server bridge. No custom /watch/* endpoints. Codex data path must use only the unmodified Codex app-server WebSocket JSON-RPC protocol.

RePebble Alloy has separate watch JS and PKJS phone JS environments; network requests from Alloy are proxied through PKJS, and @moddable/pebbleproxy supports watch-side fetch() and WebSocket. Codex app-server, however, exposes real app APIs as JSON-RPC over WebSocket/stdio/unix socket; its HTTP surface is only /readyz and /healthz, so this app should use WebSocket for all job data.

1. Non-negotiables

Must use:
  ws://<tailscale-host>:<port>  Codex app-server WebSocket transport
  JSON-RPC messages documented by OpenAI Codex app-server
Must not use:
  /watch/v1/dashboard
  /watch/v1/thread/:id/reply
  any bridge summary API
  any modified Codex server
  any OpenAI/Codex credential login from the watch

Tailscale is the network/auth boundary. Bind or firewall the Codex app-server so it is reachable only over Tailnet, ideally only from the phone device. OpenAI docs warn that non-loopback WebSocket listeners allow unauthenticated connections by default unless WebSocket auth is configured; with this design, Tailnet ACLs are the gate.

2. Codex app-server startup

On the machine running Codex:

codex app-server --listen ws://<tailscale-ip-or-host>:4500

Optional health check only:

GET /readyz
GET /healthz

Do not use HTTP for thread/job data. Codex JSON-RPC over WebSocket is experimental/unsupported in the docs, but it is the only unmodified network transport matching this "watch talks directly to app-server" requirement.

3. RePebble app structure

codex-jobs/
  package.json
  src/
    embeddedjs/
      main.js              watch UI + app state
      codex_rpc.js         JSON-RPC client over WebSocket
      jobs.js              filtering / ack state
      dictation.js         voice input wrapper
      views/
        dashboard.js
        detail.js
        settings_needed.js
    pkjs/
      index.js             pebbleproxy + config page handlers
  config/
    index.html             GitHub Pages config page

Alloy target only. No old-watch fallback. Alloy supports modern JS, Piu/Poco UI, WebSocket/fetch networking, and local storage; current platform support is Emery/Gabbro, which is acceptable here.

4. Config / "login"

This is not Codex login. It is local app configuration.

Config page fields:

{
  "wsUrl": "ws://codex-host.tailnet-name.ts.net:4500",
  "displayLimit": 3,
  "recentCompletionLookbackMinutes": 720
}

Implementation:

package.json:
  capabilities includes "configurable"
PKJS:
  showConfiguration -> Pebble.openURL(config page)
  webviewclosed -> parse returned JSON
  store in PKJS localStorage
  send to watch via AppMessage
  watch stores same settings in watch localStorage

RePebble's config flow supports hosted HTML pages, Pebble.openURL, pebblejs://close#..., webviewclosed, GitHub Pages hosting, and relaying config data through PKJS/AppMessage.

5. Allowed Codex JSON-RPC methods

Use this allowlist only.

Connection:
  initialize
  initialized
Discovery / dashboard:
  thread/loaded/list
  thread/list
  thread/read
  thread/turns/list
Live updates:
  thread/resume
  thread/unsubscribe
Reply:
  turn/steer
  turn/start
Optional:
  account/read          connection/account sanity only
  turn/interrupt        later cancel button only

Notifications to handle:

thread/started
thread/status/changed
thread/closed
turn/started
turn/completed
turn/plan/updated
item/started
item/completed
item/agentMessage/delta
serverRequest/resolved

OpenAI documents the initialize handshake, thread APIs, turn APIs, loaded-thread listing, status notifications, turn/start, and turn/steer; thread/turns/list pages turn history with itemsView so the watch can fetch only a latest summary instead of full history.

6. WebSocket handshake

On app open:

{ "method": "initialize", "id": 1, "params": {
  "clientInfo": {
    "name": "repebble_codex_jobs",
    "title": "Codex Jobs for Pebble",
    "version": "0.1.0"
  },
  "capabilities": {
    "experimentalApi": true
  }
}}

Then:

{ "method": "initialized", "params": {} }

Keep one WebSocket open while app foregrounded. Close on app exit. Reconnect with exponential backoff. If server returns -32001 overload, retry later with jitter; Codex docs specify that behavior for WebSocket mode.

7. Dashboard data algorithm

Goal: show active jobs and newly completed unacknowledged jobs only. Never show full history by default.

Initial sync:

1. show cached dashboard immediately, marked stale
2. open WebSocket
3. initialize
4. call thread/loaded/list
5. call thread/read for each loaded thread id, includeTurns:false
6. call thread/list:
     limit: 25
     sortKey: "updated_at"
     archived: false
     sourceKinds: [
       "cli", "vscode", "appServer",
       "exec", "subAgent", "subAgentReview",
       "subAgentThreadSpawn", "unknown"
     ]
7. for candidate threads, call thread/turns/list:
     limit: 1
     sortDirection: "desc"
     itemsView: "summary"
8. filter to visible jobs
9. cache result

Current generated schema note: the local Codex app-server contracts generated
with `codex app-server generate-ts` and `generate-json-schema` do not expose
`thread/turns/list`. This implementation therefore hydrates each candidate with
`thread/read` and `includeTurns:true`, then derives the latest turn locally. If a
future generated schema reintroduces `thread/turns/list`, prefer the paged
latest-turn request again to avoid reading full turn history.

thread/list supports pagination, sortKey, sourceKinds, archived, cwd, and searchTerm; returned thread objects include runtime status. Source kinds include cli, vscode, exec, appServer, sub-agent variants, and unknown.

Visible job rules:

visible if thread.status.type === "active"
visible if thread.status.type === "systemError"
visible if latestTurn.status in ["completed", "failed", "interrupted"]
  and latestTurn not locally acknowledged
  and (
    thread was previously seen active by this app
    or thread.updatedAt > local lastSeenWatermark
    or thread.updatedAt within configured recentCompletionLookbackMinutes
  )

Default dashboard cap:

display first 3 visible jobs
show "See more..." if more visible jobs exist

First run behavior:

Show active jobs.
Do not flood with old completed history.
Set initial lastSeenWatermark after first successful sync.

8. Local app state

Store locally, not in Codex:

{
  "settings": {
    "wsUrl": "ws://...",
    "displayLimit": 3
  },
  "watermark": {
    "lastSuccessfulSyncUnix": 1780000000
  },
  "threads": {
    "thr_123": {
      "lastSeenStatus": "active",
      "lastSeenTurnId": "turn_456",
      "lastSeenUpdatedAt": 1780000000,
      "ackedTurnIds": ["turn_455"]
    }
  }
}

Ack is purely local:

Acknowledge completed job:
  add latestTurn.id to ackedTurnIds
  remove from dashboard
Do not call:
  thread/archive
  thread/metadata/update

Reason: Codex app-server has no documented "ack completed job" method. Local ack preserves the user's Codex history unchanged.

9. Live subscription strategy

After dashboard sync:

For each visible active thread:
  call thread/resume(threadId)
  remember subscribed threadId

While subscribed, process notifications:

thread/status/changed:
  update visible status
turn/started:
  set lastSeenTurnId
  mark active
turn/plan/updated:
  update one-line progress if available
item/agentMessage/delta:
  append small preview only; truncate aggressively
turn/completed:
  mark completed_unacked / failed_unacked / interrupted_unacked
  keep on dashboard until local ack

On app exit:

for each subscribed thread:
  thread/unsubscribe(threadId)

OpenAI docs say after starting or resuming a thread, clients should keep reading thread/*, turn/*, item/*, and serverRequest/resolved notifications; thread/unsubscribe removes the connection's subscription.

10. Reply / dictation flow

UI:

Thread detail
  Reply with voice
  Dictation system UI
  Preview transcription
  Send / Retry / Cancel

RePebble documents the Pebble dictation flow: user starts dictation, reviews transcription, accepts, then app receives text; the current Moddable Pebble examples include hellodictation for receiving spoken-word transcription in Embedded JS.

Send logic:

Before send:
  refresh thread via thread/read
  fetch latest turn via thread/turns/list limit:1
If latest turn status is "inProgress" and thread status is active:
  call turn/steer with expectedTurnId = latestTurn.id
Else:
  call thread/resume
  call turn/start with dictated text

Active turn steer:

{
  "method": "turn/steer",
  "id": 41,
  "params": {
    "threadId": "thr_123",
    "expectedTurnId": "turn_456",
    "input": [
      { "type": "text", "text": "Please continue and check the failing test first." }
    ]
  }
}

Idle/completed thread continuation:

{
  "method": "thread/resume",
  "id": 42,
  "params": { "threadId": "thr_123" }
}
{
  "method": "turn/start",
  "id": 43,
  "params": {
    "threadId": "thr_123",
    "input": [
      { "type": "text", "text": "Please continue and check the failing test first." }
    ]
  }
}

turn/steer requires expectedTurnId and fails when no active turn exists; turn/start starts a new turn on the target thread.

11. UI spec

State: not configured

Codex Jobs
Set server URL
Open settings in phone app

State: connecting

Codex Jobs
Connecting...
spinner

State: dashboard

Codex Jobs        ↻
● Fix deploy script
  Running · editing CI
! DB migration
  Needs approval
✓ Review tests
  Done · unacked
See more...

Row status mapping:

active + waitingOnApproval     → ! Needs approval
active                         → ● Running
systemError                    → ! Error
completed unacked              → ✓ Done
failed unacked                 → ! Failed
interrupted unacked            → – Interrupted

thread/status/changed examples include active status with activeFlags, such as waitingOnApproval. Turn completion status can be completed, interrupted, or failed.

State: detail

Fix deploy script
Running
Editing CI workflow...
Plan: run tests
[Voice reply]
[Acknowledge]   only visible for completed/failed/interrupted
[Refresh]

Spinner rules

Full-screen spinner:
  first load, no cache
Title-row spinner:
  refresh with cache already visible
Stale badge:
  network failure, cached data shown
No spinner:
  passive websocket event update

12. Error handling

No PKJS proxy:
  "Phone link not ready"
WebSocket fail:
  "Cannot reach Codex on Tailnet"
initialize error:
  show JSON-RPC error.message
thread/list fail:
  keep cache, mark stale
turn/steer fail:
  refresh status
  if no active turn, offer "Start new turn"
turn/start fail:
  show error; keep dictated text for retry
dictation canceled:
  return to detail, no network call

RePebble networking docs require waiting for the proxy/PKJS connection before using fetch() or WebSocket, and recommend error handling, minimal data, and caching.

13. Acceptance tests

Config
  app opens unconfigured state
  config page saves wsUrl
  watch receives config
  app reconnects using saved wsUrl
Connection
  connects to ws://Tailnet host
  sends initialize then initialized
  handles server unavailable
Dashboard
  active loaded thread appears
  idle old history does not appear
  recently completed unacked thread appears
  ack hides completed job locally
  See more expands beyond 3 rows
Live updates
  active thread status changes update UI
  turn/completed creates completed_unacked row
  app exit unsubscribes resumed threads
Dictation
  accepted transcript previews
  send to active turn uses turn/steer
  send to idle thread uses thread/resume + turn/start
  failed send preserves transcript for retry
No forbidden endpoints
  no HTTP job requests
  no /watch/*
  no custom bridge server

14. Implementation note

Generate Codex schemas from the installed Codex version and build the client against those generated contracts:

codex app-server generate-ts --out ./schemas
codex app-server generate-json-schema --out ./schemas

OpenAI documents these generators and notes the output matches the Codex version being run.
The generated files should be committed with this repo so tests can detect when
the watch client's method allowlist or request parameters drift from the Codex
version used to build the app.

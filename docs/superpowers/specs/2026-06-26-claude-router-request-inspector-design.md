# claude-router — Request Inspector + Optional Full Trace

**Status:** Approved 2026-06-26. Implement via Opus workflow.
**Target codebase:** `C:/Users/Thomas/Documents/Projects/claude-router` — single-file `server.js` + `webui.html`.
**Goal:** Show the live/persistent pool of requests: how many requests, which request routes to which backend/API/account, prompt preview, status, latency, errors, usage, and optional full request/response trace capture for debugging.

---

## 1. Goals

1. Persist a safe request audit log to `~/.claude-router/requests.jsonl`.
2. Keep a recent in-memory buffer for the WebUI.
3. Show request pool in WebUI: count, in-flight, status, backend/API, account/org, prompt preview, latency, errors.
4. Add optional full trace capture toggle for debugging.
5. Do not leak API keys/OAuth tokens in logs.
6. Do not regress existing router behavior: account pool, Step-1 Claude subscription inference fix, GLM plain-fetch path, Codex, Model Mapper, cc-switch import.

---

## 2. Non-goals

- No database. JSONL + in-memory ring buffer is enough.
- No full observability stack.
- No remote telemetry.
- No default full prompt/response capture. Full trace is opt-in only.

---

## 3. Storage

### 3.1 Files

```js
const REQUEST_LOG_FILE = path.join(CFG_DIR, "requests.jsonl");
const REQUEST_TRACE_DIR = path.join(CFG_DIR, "request-traces");
const REQUEST_SETTINGS_FILE = path.join(CFG_DIR, "request-settings.json");
```

### 3.2 Settings schema

`~/.claude-router/request-settings.json`:

```jsonc
{
  "fullTraceEnabled": false,
  "promptPreviewChars": 1000,
  "maxRecentRequests": 200,
  "maxTraceFiles": 200,
  "maxLogBytes": 26214400
}
```

Defaults apply if missing or invalid.

### 3.3 Request summary record

One JSONL line per request on finish/update:

```jsonc
{
  "id": "req_20260626_abcdef",
  "startedAt": 1782410000000,
  "finishedAt": 1782410001234,
  "latencyMs": 1234,
  "method": "POST",
  "path": "/v1/messages",
  "stream": true,
  "requestedModel": "glm-5.2",
  "upstreamModel": "glm-5.2",
  "backendId": "glm",
  "backendName": "GLM 5.2 (DashScope)",
  "backendFormat": "anthropic",
  "authScheme": "x-api-key",
  "upstream": "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages",
  "accountId": null,
  "organizationName": null,
  "organizationUuid": null,
  "status": "success",
  "httpStatus": 200,
  "stopReason": "end_turn",
  "usage": { "input_tokens": 12, "output_tokens": 4 },
  "promptPreview": "User: ping",
  "errorPreview": "",
  "retryCount": 0,
  "rotationCount": 0,
  "traceAvailable": false
}
```

Statuses:
- `pending`
- `streaming`
- `success`
- `error`
- `client_aborted`

### 3.4 Full trace file

If `fullTraceEnabled=true`, write `~/.claude-router/request-traces/<requestId>.json`:

```jsonc
{
  "id": "...",
  "requestBody": { "...": "redacted" },
  "transformedBody": { "...": "redacted" },
  "responseBodyPreview": "...",
  "sseEventsPreview": ["event:message_start..."],
  "upstreamHeaders": { "content-type": "..." }
}
```

Trace still redacts secrets. Trace files are capped to `maxTraceFiles`; delete oldest beyond the cap.

---

## 4. Redaction

Implement `redactSecrets(value)` recursively for strings/objects/arrays.

Redact:
- `authorization`
- `x-api-key`
- `apiKey`
- `ANTHROPIC_AUTH_TOKEN`
- `accessToken`
- `refreshToken`
- `sk-...` style tokens
- bearer-like long tokens (`[A-Za-z0-9_-]{40,}`) when key name is auth-ish

Prompt preview should be redacted and truncated to `promptPreviewChars`.

---

## 5. Server instrumentation

Add a small helper block in `server.js`:

```js
const requestLog = {
  recent: [],
  settings: loadRequestSettings(),
  start(req, body, backend),
  update(id, patch),
  finish(id, patch),
  trace(id, patch),
  list(filters),
  get(id),
  getTrace(id),
  clear(),
};
```

### 5.1 `proxy()` integration

In `proxy(req,res)`:
1. parse body as today.
2. resolve backend as today.
3. call `requestLog.start(req, body, backend)` before dispatch.
4. attach `req._requestLogId = id`.
5. pass into downstream via `req`.

If no backend: record `error` before returning 502.

### 5.2 Backend integration

Update records inside:
- `openaiTranslate`
- `openaiResponsesTranslate`
- `anthropicPassthrough`

Record:
- upstream URL
- transformed model/body type
- account/org for OAuth branch
- retry/rotation counts
- http status
- success/error
- latency
- usage if response has it

### 5.3 Streaming

For streaming responses:
- set status `streaming` when upstream 200 begins.
- finish `success` when stream ends normally.
- if upstream SSE emits `event:error`, finish `error` with error preview.
- if client disconnects (`res.on("close")` before finish), mark `client_aborted`.

Keep implementation lazy: do not store every SSE chunk unless full trace is on; for trace mode, store only first ~32KB of SSE text.

### 5.4 Non-streaming

On complete JSON response:
- parse usage and stop reason where possible.
- record success/error.

### 5.5 JSONL append and rotation

Append on `finish()`. Also keep in-memory record updated during `pending/streaming`.

If `requests.jsonl` exceeds `maxLogBytes`, rotate:
- delete existing `requests.1.jsonl`
- rename `requests.jsonl` → `requests.1.jsonl`
- start new file

This is local single-process; no file lock needed.

---

## 6. API

All endpoints under `/api/*`; mutating endpoints respect `CLAUDE_ROUTER_ADMIN_TOKEN`.

### 6.1 List requests

`GET /api/requests?limit=200&status=&backend=&model=&q=`

Return:

```json
{
  "requests": [RequestSummary],
  "stats": {
    "totalRecent": 42,
    "pending": 1,
    "success": 38,
    "error": 3,
    "avgLatencyMs": 1234,
    "lastError": "..."
  }
}
```

List from in-memory buffer, newest first. Filters apply to recent buffer only.

### 6.2 Get one request

`GET /api/requests/:id`

Return one summary from memory. If not in memory, scan the current JSONL + `.1` file from the end best-effort; if not found, 404.

### 6.3 Get trace

`GET /api/requests/:id/trace`

Return trace file if available; 404 otherwise.

### 6.4 Clear logs

`POST /api/requests/clear`

- Clear in-memory buffer.
- Truncate `requests.jsonl`.
- Delete trace files.

### 6.5 Settings

`GET /api/request-settings`

`POST /api/request-settings`

Allowed settings:
- `fullTraceEnabled` boolean
- `promptPreviewChars` number 100-5000
- `maxRecentRequests` number 50-1000
- `maxTraceFiles` number 0-1000
- `maxLogBytes` number 1MB-200MB

---

## 7. WebUI

Replace the current placeholder recent request list in **Live Admin Stats** with a real **Request Pool** section.

### 7.1 Summary metrics

Add metrics:
- Total recent
- In flight
- Success
- Errors
- Avg latency
- Last error

Keep existing throttle metrics.

### 7.2 Request table

Columns:
- Time
- Status
- Model
- Backend/API
- Account/org
- Latency
- Prompt preview
- Error

Row status colors:
- pending/streaming = warning
- success = success
- error/client_aborted = danger

### 7.3 Filters

- Status select: all/success/error/pending/streaming/client_aborted
- Backend select: all + backend ids
- Model input/search
- Prompt search

### 7.4 Row expand

Click row to expand details:
- request id
- path/method
- upstream URL
- route decision
- account/org
- usage
- full error preview
- trace button/link if `traceAvailable=true`

### 7.5 Controls

- Auto refresh existing checkbox continues to poll `/api/requests` too.
- Full trace capture toggle with warning:
  > Full trace stores complete prompts and responses locally. Enable only while debugging.
- Clear logs button with confirmation.

---

## 8. Privacy UI wording

Near the full-trace toggle:

> Request summaries store redacted prompt previews. Full trace stores complete prompts and responses locally in `~/.claude-router/request-traces`; use only while debugging.

---

## 9. Tests

Extend `selftest()`:

1. `redactSecrets()` redacts keys/tokens in objects and strings.
2. Prompt preview truncates.
3. Request log records success and error.
4. JSONL append works to temp dir.
5. Rotation happens when `maxLogBytes` exceeded.
6. Full trace off: no trace file.
7. Full trace on: trace file exists and redacted.
8. API filtering returns expected subset (can be pure helper test, no HTTP server needed).

Live verification:
1. Start router.
2. Send one request each:
   - Claude OAuth (`claude-haiku-4-5-20251001`)
   - GLM (`glm-5.2`)
   - Codex (`gpt-5.5-xhigh`)
3. `GET /api/requests` shows all three with correct backend ids and statuses.
4. WebUI table renders them.
5. Enable full trace, send one request, verify trace exists and `/api/requests/:id/trace` returns it.
6. Clear logs, verify empty list and deleted traces.

---

## 10. Implementation order

1. Add request settings helpers + redaction helpers.
2. Add request log helper (recent ring + JSONL append + rotation + trace files).
3. Instrument `proxy()` and no-backend error.
4. Instrument `openaiTranslate`, `openaiResponsesTranslate`, `anthropicPassthrough` minimally.
5. Add `/api/requests*` and `/api/request-settings` endpoints.
6. Replace WebUI request placeholder with real Request Pool table, filters, row expand, trace toggle, clear button.
7. Add selftests.
8. Live verify Claude/GLM/Codex requests + trace toggle + clear logs.
9. README update.

---

## 11. Non-regression checklist

- Existing `node server.js --selftest` still passes.
- Claude subscription Step-1 body injection remains intact.
- GLM uses plain fetch, not curl.
- Codex Responses path still returns Anthropic-shaped messages.
- Model Mapper endpoints still work.
- Account pool still refreshes/rotates.
- Request logging failures never fail a user request. If logging throws, swallow and continue.

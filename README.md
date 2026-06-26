# claude-router

Local proxy that lets **Claude Code** (which only speaks the Anthropic `/v1/messages` API) route requests to **different backends by model name**, with a built-in Anthropic↔OpenAI translation layer and a CC-Switch-style profile switcher. One file, zero dependencies, Node ≥ 18.

```
Claude Code ──POST /v1/messages──▶ claude-router (127.0.0.1:8123)
  body.model routes to a backend:
    "gpt-5.5" → Codex (ChatGPT sub) (format: openai-responses → translate to /v1/responses)
    "opus"    → Anthropic           (format: anthropic        → byte-identical passthrough)
    "glm-5.2" → DashScope           (format: openai           → translate to /v1/chat/completions)
```

- **`format:"anthropic"` backends** are byte-for-byte passthrough — they reuse the existing OAuth-subscription and API-key logic unchanged. No translation, no regression.
- **`format:"openai"` backends** get a full Anthropic↔OpenAI translation: request body (system prompt, tool-use, tool-results, images, stop sequences), non-streaming response, and streaming SSE — including tool-call streaming (`tool_calls[].index` → distinct `tool_use` blocks; `arguments` → `input_json_delta.partial_json`).
- **`format:"openai-responses"` backends** translate to the OpenAI **Responses API** — the same schema the Codex CLI uses. The built-in `codex` backend points at `https://chatgpt.com/backend-api/codex/responses` and reuses the **Codex CLI login** (`~/.codex/auth.json`, read-only) so Claude Code can drive your **ChatGPT subscription** with no API key. See [Codex (ChatGPT subscription) backend](#codex-chatgpt-subscription-backend) below.

## Run

```sh
node server.js              # start router + web UI at http://127.0.0.1:8123
node server.js --selftest   # offline self-checks: PKCE, account pool, headers, routing, translation, SSE, maskKey
node server.js --checkbackends   # live 1-token ping of every configured backend; OAuth is checked per account
```

Then open **http://127.0.0.1:8123/** to manage backends, routes, and profiles in the UI.

## Config

Backends live in `~/.claude-router/backends.json` (mode 0600), created by the UI. If the file is absent, a single-backend config is **synthesized from env vars** — byte-identical to the original single-file proxy:

```jsonc
{
  "backends": [
    { "id":"codex",  "name":"Codex (ChatGPT subscription)", "upstream":"https://chatgpt.com/backend-api/codex/responses",
      "format":"openai-responses", "codexOauth":true, "modelPatterns":["gpt-5.5","gpt-5*"], "testModel":"gpt-5.5", "enabled":true },
    { "id":"claude", "name":"Anthropic Opus (subscription OAuth)", "upstream":"https://api.anthropic.com",
      "format":"anthropic", "oauth":true, "modelPatterns":["opus","claude-*"], "modelMap":{"opus":"claude-opus-4-8"}, "testModel":"claude-opus-4-8", "enabled":true },
    { "id":"glm",    "name":"GLM 5.2 (DashScope)", "upstream":"https://dashscope.aliyuncs.com/compatible-mode/v1",
      "format":"openai", "apiKey":"sk-…", "modelPatterns":["glm-5.2","glm-*"], "testModel":"glm-5.2", "enabled":true }
  ],
  "routes": [
    { "pattern":"gpt-5.5", "backendId":"codex" },
    { "pattern":"opus",    "backendId":"claude" },
    { "pattern":"glm-5.2", "backendId":"glm" },
    { "pattern":"*",       "backendId":"claude" }
  ],
  "profiles": { "coding": { "primaryModel":"gpt-5.5" }, "research": { "primaryModel":"opus" }, "cheap": { "primaryModel":"glm-5.2" } },
  "activeProfile": null
}
```

**Routing precedence** (`resolveBackend`): specific routes first (first match wins) → per-backend `modelPatterns` fallback → catch-all `*` routes → a `*` modelPattern → first enabled. The `*` route is deferred so a per-backend glob (e.g. codex serving `gpt-5*`) beats a blanket `* → claude`.

**`modelMap`** rewrites `body.model` after routing, before forwarding (e.g. route on `opus`, forward `claude-opus-4-8`).

### Env vars

| Var | Default | Purpose |
|---|---|---|
| `CLAUDE_ROUTER_PORT` / `PORT` | `8123` | listen port. Explicit = fail loudly if busy; default = auto-hunt. Binds **127.0.0.1 only**. |
| `CLAUDE_ROUTER_API_KEY` | — | **Fallback single-backend mode.** If set and no `backends.json`, the router acts as the original proxy: `x-api-key` passthrough to `CLAUDE_ROUTER_UPSTREAM`. |
| `CLAUDE_ROUTER_UPSTREAM` | `https://api.anthropic.com` | Fallback upstream for the synthesized key-mode backend. |
| `CLAUDE_ROUTER_ADMIN_TOKEN` | — | Optional guard for mutating `/api/*` endpoints (header `X-Admin-Token` or `Authorization: Bearer`). Default (localhost) = no token. |

## Point Claude Code at it

**Option A — env (one-off shell):**
```cmd
:: cmd
set ANTHROPIC_BASE_URL=http://127.0.0.1:8123
set ANTHROPIC_API_KEY=claude-router
set ANTHROPIC_MODEL=gpt-5.5
claude
```
```powershell
# PowerShell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8123"
$env:ANTHROPIC_API_KEY="claude-router"
$env:ANTHROPIC_MODEL="gpt-5.5"
claude
```

**Option B — UI profile (persistent, CC-Switch-style):** open `http://127.0.0.1:8123/`, go to the **Claude Code profile** section, pick a profile (`coding` / `research` / `cheap`), click **Apply profile**. This deep-merges `~/.claude/settings.json` (preserving your existing `permissions`/`mcpServers`/`theme`) with:
```jsonc
{ "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8123", "ANTHROPIC_API_KEY": "claude-router", "ANTHROPIC_MODEL": "gpt-5.5" } }
```
…backs up the original to `~/.claude-router/settings-backup.json`, and sets the active profile. Start a **new Claude Code session** — it now routes through the router. **Restore** writes the backup back. (An already-running Claude Code picks up model changes on its next session, not mid-run — it re-reads env per session.)

**Option C - Model Mapper + cc-switch import:** open the **Model Mapper** section. Pick a backend and model for each Claude Code tier:

- `Fable` is also exported as `ANTHROPIC_MODEL`, so it is the default model Claude Code sends.
- `Opus`, `Sonnet`, and `Haiku` are exported as first-class cc-switch provider fields (`opusModel`, `sonnetModel`, `haikuModel`).
- `Fable` plus all `_MODEL_NAME` display values are carried in the deep link's base64 `config` JSON.

The model dropdowns are fetched automatically: Claude OAuth uses `/v1/models` through `anthropicFetch`/curl, Codex uses the curated `gpt-5.5` variants, and DashScope/GLM uses `https://dashscope.aliyuncs.com/compatible-mode/v1/models` through plain `fetch` (not curl).

The default mapping is:

```text
fable -> codex / gpt-5.5-xhigh
opus -> Claude OAuth / claude-opus-4-8
sonnet -> GLM / glm-5.2
haiku -> codex / gpt-5.5-instant
```

Click **Import to CC Switch** to save the router routes, then open a deep link like:

```text
ccswitch://v1/import?resource=provider&app=claude&name=claude-router&endpoint=http%3A%2F%2F127.0.0.1%3A8123&apiKey=claude-router&model=gpt-5.5-xhigh&opusModel=claude-opus-4-8&sonnetModel=glm-5.2&haikuModel=gpt-5.5-instant&config=...&configFormat=json&enabled=true
```

The browser still prompts to open `ccswitch://`, and cc-switch still shows its import dialog. Confirm that dialog to switch. Use **Copy link** if your browser blocks custom-scheme navigation from the button. Use **Apply** to write `~/.claude/settings.json` directly instead of going through cc-switch; it deep-merges `env`, preserves existing keys such as `permissions`, `mcpServers`, and `theme`, backs up once, and writes atomically.

If your OS or shell already sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN`, those environment variables override `settings.json`. The Model Mapper shows the same conflict banner as profiles; unset those variables before expecting Claude Code to use the router profile.

### The dummy `ANTHROPIC_API_KEY`

`ANTHROPIC_API_KEY=claude-router` is a **non-empty dummy**. Claude Code requires *something* there or it pops a login prompt. The router **ignores** the incoming `x-api-key` entirely and authenticates each backend with its own real key from `backends.json` (or the OAuth token from `creds.json`). It is not a secret.

### Anthropic OAuth account pool

OAuth subscription backends now use `~/.claude-router/accounts.json` as the authoritative pool. The file is written mode `0600`; each account stores one Claude OAuth grant plus token-response metadata (`organization.uuid`, `organization.name`, `account.uuid`, subscription type, and rate-limit tier). `/api/accounts*` read paths always return masked tokens.

- First login may use the generic Claude authorize URL and binds to the account's default org.
- Additional logins should use the Accounts UI. Choose an org from `GET /api/accounts/orgs` or paste the target org UUID; the router prepares `https://claude.ai/v1/oauth/{organization_uuid}/authorize` so the token is bound to that org.
- Duplicate `organization_uuid` values are rejected with HTTP 409.
- Manual Activate changes the preferred default only; Disable excludes an account; Remove deletes it; Refresh renews that account's token. No re-login happens on switch.
- On proxied `/v1/messages`, OAuth mode selects the active available account, then the next available account by array order. `429` cools the account until `anthropic-ratelimit-unified-reset` when present, otherwise 300s; `529` cools for 600s; repeated `401`/`403` after refresh cool for 1800s; selected blocking `400` bodies disable the account. The same inbound request is retried against the next available account up to the rotation budget.
- If `accounts.json` does not exist, startup migrates `~/.claude-router/creds.json` first, then `~/.claude/.credentials.json` as a read-only source. Once the pool has accounts, Claude Code piggyback credentials are no longer used for proxied OAuth traffic.
- All Anthropic-bound calls in this flow (`/v1/oauth/token`, `/v1/messages`, `/api/oauth/profile`, `/api/organizations`) go through `anthropicFetch`/curl because Node HTTP clients can trip Anthropic's TLS-fingerprint gate.

### Codex (ChatGPT subscription) backend

The built-in `codex` backend uses `format:"openai-responses"` to translate Anthropic Messages → the OpenAI **Responses API**, pointing at `https://chatgpt.com/backend-api/codex/responses` — the same endpoint the Codex CLI hits. It reuses your **Codex CLI login**: the router reads `~/.codex/auth.json` (the `tokens.access_token`) **read-only** and never refreshes it (the Codex CLI refreshes it itself; refreshing here could rotate the token and break your Codex CLI). So there is no separate login step — just run `codex login` once in the Codex CLI first.

Config:
```jsonc
{ "id":"codex", "name":"Codex (ChatGPT subscription)",
  "upstream":"https://chatgpt.com/backend-api/codex/responses",
  "format":"openai-responses", "codexOauth":true,
  "modelPatterns":["gpt-5.5","gpt-5*"], "testModel":"gpt-5.5", "enabled":true }
```

Requirements (verified against the live endpoint):
- **`gpt-5.5` is the only accepted model id** — `gpt-5` / `gpt-5-codex` / `o3` / etc. all return `400 "not supported"`. Route `gpt-5*` here and map other names to `gpt-5.5` via `modelMap` if needed.
- **`store:false` AND `stream:true` are required** in the request body (else `400`). The router always sets both; for a non-streaming Anthropic request it still streams upstream and buffers/assembles the final message.
- Headers sent: `Authorization: Bearer <codex token>`, `User-Agent: codex/0.142.0`, `Origin: https://chatgpt.com`, `Accept: text/event-stream`. (No `OpenAI-Beta` needed.)
- The call goes through **`anthropicFetch` (curl)** — `chatgpt.com` has the same TLS-fingerprint gate as Anthropic (Node `fetch` 403s; curl is accepted). Plain `fetch` is only used for `openai` (chat-completions) backends.
- At most one `codexOauth` backend is allowed (enforced on save).

`node server.js --checkbackends` reports **OK on `429`** (rate-limited = auth passed = path works) as well as on `200`; `401`/`403`/`400` are failures. (The account is currently 429 rate-limited; 429 is the expected "healthy" result until the limit clears.)

If you have an OpenAI **API key** instead of a subscription, add a separate `format:"openai"` backend hitting `https://api.openai.com/v1` via `/v1/chat/completions` (the older chat-completions translation). That path is **not** Responses-API parity — the UI's add-backend tooltip notes this.

## Translation layer (Anthropic ↔ OpenAI)

`format:"openai"` and `format:"openai-responses"` backends translate; `format:"anthropic"` is passthrough. Mapping highlights:
- **System prompt** → `openai`: one leading `role:"system"` message · `openai-responses`: top-level `instructions` (string).
- **Tool-use (request)** → `openai`: `tool_calls[].function.arguments` as a **string** (`JSON.stringify`) · `openai-responses`: a top-level `function_call` input item `{type:"function_call", call_id, name, arguments}`.
- **Tool results** → `openai`: one `role:"tool"` message per `tool_result` · `openai-responses`: a top-level `function_call_output` item `{type:"function_call_output", call_id, output}`.
- **`max_tokens` → `max_completion_tokens`** (openai) / **`max_output_tokens`** (openai-responses); `top_k` dropped; `stop_sequences` → `stop` (openai only, dropped on responses).
- **`thinking` / `output_config` / `cache_control`** dropped (Anthropic-specific; no OpenAI equivalent — so prompt-cache translation across formats is not supported in v1).
- **`finish_reason`/status → `stop_reason`**: `stop/completed→end_turn`, `length/max_output_tokens→max_tokens`, `tool_calls→tool_use`, `content_filter→refusal`.
- **Streaming (openai-responses)**: `response.output_text.delta` → `text_delta`; `response.function_call_arguments.delta` → `input_json_delta.partial_json`; `response.output_item.added` (function_call) opens a `tool_use` block carrying `call_id`+`name`; `response.completed` → `message_delta` + `message_stop`. `store:false` + `stream:true` always set.
- **`/v1/messages/count_tokens`** on an openai/openai-responses backend returns a heuristic (`chars/4`) — neither has a count endpoint.

## Virtual models (condition-based routing)

A **virtual model** is a client-facing model *name* (e.g. `fusion-smart`) that Claude Code can request as if it were real, and that the router resolves **per request** to one of several backend/model targets by evaluating ordered `condition → target` rules against the request body — first match wins, else a `default` target. Define them under the top-level `virtualModels[]` key in `backends.json`:

```jsonc
{
  "virtualModels": [{
    "id": "fusion-smart",
    "name": "Fusion (smart routing)",
    "enabled": true,
    "match": ["fusion-smart", "fusion-*"],          // aliases the client may request (glob); defaults to [id]
    "rules": [
      { "when": "hasImage",    "backendId": "claude", "model": "claude-opus-4-8" },                // any image content block
      { "when": "webSearch",   "backendId": "glm",    "model": "glm-5.2" },                        // request declares a web_search tool or metadata.web_search
      { "when": "longContext", "backendId": "gemini", "model": "gemini-2.5-pro", "thresholdTokens": 200000 }, // local ~chars/4 token estimate
      { "when": "keyword",    "backendId": "glm",    "model": "glm-5.2", "keywords": ["latest","today","news"] }
    ],
    "default": { "backendId": "codex", "model": "gpt-5.5" }                                        // required fallback
  }]
}
```

`when` is one of `hasImage | webSearch | longContext | keyword | always` (use `always` for a pure alias). Resolution happens in `proxy()` **between body parse and backend dispatch**: the matched target rewrites `body.model` to a real upstream model, then the existing passthrough/translate path runs unchanged (the chosen backend's `modelMap` still applies). Virtual models resolve **before** routes, so a non-matching model name falls through to normal routing byte-identically.

**This is a routing feature, not an agentic tool loop.** It deliberately does NOT replicate CCR's fusion mechanism: there is no hidden internal tool, no bundled MCP server, no multi-turn executor, and **exactly one upstream call per request** — the base model still owns the full answer; we only pick *which* backend serves that single turn based on request shape. (If you want true multi-model orchestration later, that is a separate spec with its own loop runtime.)

- **Purely additive / non-regressive:** with no `virtualModels` key, behavior is byte-identical to today.
- **A VM `id` must not collide with any `backendId`** (kept distinct so resolver namespaces stay clean).
- **Dangling `backendId`** in a matched rule (e.g. a backend was deleted after the rule was saved) degrades gracefully — the router falls back to glob-routing the resolved model instead of a hard 502.
- **REST API:** `GET/POST /api/virtual-models`, `PUT/DELETE /api/virtual-models/:id` (admin-guarded writes), and a read-only `POST /api/virtual-models/:id/preview` (send a sample body → `{matchedRule, backendId, model}`). The WebUI has a Virtual Models section with a reorderable rule editor and a live preview pane.

## Security

- **Localhost-only:** `HOST = 127.0.0.1` — never listens on a public interface.
- **Config files mode 0600:** `creds.json`, `backends.json`, `settings-backup.json`, and atomic `settings.json` writes all use `mode: 0o600`.
- **Keys never returned in full:** `maskKey()` (`sk-…wxyz`) on every read path (`/api/state`, `/api/backends`). Full keys only accepted on POST/PUT, never echoed back. **PUT with an empty `apiKey` preserves the stored key** (no wipe-on-edit).
- **Backend id validation:** `^[a-z0-9][a-z0-9-]{0,31}$`.
- **No CORS:** UI is same-origin (`/` and `/api/*` from the same port).
- **`settings.json` safety:** deep-merge `env` only, back up once before first takeover, atomic temp+rename.
- **Upstream error containment:** openai upstream non-2xx → Anthropic-shaped error, upstream body truncated to 500 chars.

## Self-test

```sh
node server.js --selftest
```
Checks PKCE, the `anthropic-beta` merge, header rewriting, the Model Mapper deep-link/routes/settings env shape, **plus** account-pool behavior, multi-backend routing, request/response/SSE translation, `maskKey`, and a codex/Responses-API section (request translation + scripted Responses SSE → Anthropic SSE + non-stream assembler). Prints `selftest OK (account-pool + multi-backend + codex/responses)` on success.

`node server.js --checkbackends` pings each enabled backend with a 1-token request and prints pass/fail + latency. Exits 0 if all pass, 1 if any fail. (For the OAuth subscription backend this currently returns 429 rate-limit via curl — which confirms the TLS-fingerprint gate is bypassed; see below. For the `codex` backend, `429` is also reported as OK — auth passed, just rate-limited.)

## ⚠️ Verified status (2026-06-25) — subscription OAuth is currently BLOCKED for inference

Anthropic's `/v1/messages` and `/v1/oauth/token` gate on the HTTP client's **TLS/transport fingerprint**: Node `fetch` (undici) and Node `https` both return `403 "Request not allowed"` with a valid subscription token + full official-client headers; **`curl` is accepted** (returns `429` = auth passed). The router therefore routes **all Anthropic-bound HTTP through `curl`** (`curlFetch` → `anthropicFetch`, with a zero-dep HTTPS-over-CONNECT fallback when an HTTP proxy like Clash is configured). Even so, Anthropic appears to block subscription-OAuth **inference** (the `/v1/messages` call) from non-official clients — the OAuth login path here is kept in case that block lifts.

For a working router today, add an **API-key** (`format:"anthropic"` with `apiKey`) or an **openai-format** backend (GLM/z.ai/codex) in the UI. The `anthropic` passthrough code is identical for OAuth and API-key backends; only the credential differs.

## Notes / caveats
- Uses Claude Code's reverse-engineered OAuth client to drive your **subscription**. Anthropic's consumer terms restrict programmatic use of subscription credentials — this is your own account, local, personal use, your call. The constants may change or be blocked at any time.
- The stored OAuth token grants **full access to your Claude account** — the server binds localhost only; do not expose the port.
- Per the project's "never hand-edit live config" rule, manage backends/routes/profiles through the UI (which round-trips through `saveConfig`); don't edit `backends.json` by hand while the router is running.

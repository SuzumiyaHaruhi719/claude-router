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
node server.js --selftest   # offline self-checks: PKCE, headers, routing, translation, SSE, maskKey
node server.js --checkbackends   # live 1-token ping of every configured backend (no listener)
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

### The dummy `ANTHROPIC_API_KEY`

`ANTHROPIC_API_KEY=claude-router` is a **non-empty dummy**. Claude Code requires *something* there or it pops a login prompt. The router **ignores** the incoming `x-api-key` entirely and authenticates each backend with its own real key from `backends.json` (or the OAuth token from `creds.json`). It is not a secret.

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
Checks PKCE, the `anthropic-beta` merge, header rewriting, **plus** multi-backend routing, request/response/SSE translation, `maskKey`, and a codex/Responses-API section (request translation + scripted Responses SSE → Anthropic SSE + non-stream assembler). Prints `selftest OK (multi-backend + codex/responses)` on success.

`node server.js --checkbackends` pings each enabled backend with a 1-token request and prints pass/fail + latency. Exits 0 if all pass, 1 if any fail. (For the OAuth subscription backend this currently returns 429 rate-limit via curl — which confirms the TLS-fingerprint gate is bypassed; see below. For the `codex` backend, `429` is also reported as OK — auth passed, just rate-limited.)

## ⚠️ Verified status (2026-06-25) — subscription OAuth is currently BLOCKED for inference

Anthropic's `/v1/messages` and `/v1/oauth/token` gate on the HTTP client's **TLS/transport fingerprint**: Node `fetch` (undici) and Node `https` both return `403 "Request not allowed"` with a valid subscription token + full official-client headers; **`curl` is accepted** (returns `429` = auth passed). The router therefore routes **all Anthropic-bound HTTP through `curl`** (`curlFetch` → `anthropicFetch`, with a zero-dep HTTPS-over-CONNECT fallback when an HTTP proxy like Clash is configured). Even so, Anthropic appears to block subscription-OAuth **inference** (the `/v1/messages` call) from non-official clients — the OAuth login path here is kept in case that block lifts.

For a working router today, add an **API-key** (`format:"anthropic"` with `apiKey`) or an **openai-format** backend (GLM/z.ai/codex) in the UI. The `anthropic` passthrough code is identical for OAuth and API-key backends; only the credential differs.

## Notes / caveats
- Uses Claude Code's reverse-engineered OAuth client to drive your **subscription**. Anthropic's consumer terms restrict programmatic use of subscription credentials — this is your own account, local, personal use, your call. The constants may change or be blocked at any time.
- The stored OAuth token grants **full access to your Claude account** — the server binds localhost only; do not expose the port.
- Per the project's "never hand-edit live config" rule, manage backends/routes/profiles through the UI (which round-trips through `saveConfig`); don't edit `backends.json` by hand while the router is running.

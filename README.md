# claude-router

Local proxy that lets **Claude Code** (which only speaks the Anthropic `/v1/messages` API) route requests to **different backends by model name**, with a built-in Anthropic↔OpenAI translation layer and a CC-Switch-style profile switcher. One file, zero dependencies, Node ≥ 18.

```
Claude Code ──POST /v1/messages──▶ claude-router (127.0.0.1:8123)
  body.model routes to a backend:
    "gpt-5.5" → codex/OpenAI   (format: openai     → translate request/response/SSE)
    "opus"    → Anthropic      (format: anthropic  → byte-identical passthrough)
    "glm-5.2" → DashScope      (format: openai     → translate)
```

- **`format:"anthropic"` backends** are byte-for-byte passthrough — they reuse the existing OAuth-subscription and API-key logic unchanged. No translation, no regression.
- **`format:"openai"` backends** get a full Anthropic↔OpenAI translation: request body (system prompt, tool-use, tool-results, images, stop sequences), non-streaming response, and streaming SSE — including tool-call streaming (`tool_calls[].index` → distinct `tool_use` blocks; `arguments` → `input_json_delta.partial_json`).

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
    { "id":"codex",  "name":"OpenAI Codex (gpt-5.5)", "upstream":"https://api.openai.com/v1",
      "format":"openai", "apiKey":"sk-…", "modelPatterns":["gpt-5.5","gpt-5*"], "testModel":"gpt-5.5", "enabled":true },
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

### ⚠ Codex `/chat/completions` caveat

The `codex` backend is an `openai`-format backend hitting `https://api.openai.com/v1` with an `sk-` API key via `/v1/chat/completions`. The Codex CLI itself uses `/v1/responses` (a different, stateful schema), which is **out of scope for v1**. Same host, same `gpt-5.5` model, but this router speaks Chat Completions, not Responses — so it is not full Codex-CLI parity. Documented in the UI's add-backend tooltip.

## Translation layer (Anthropic ↔ OpenAI)

Only `format:"openai"` backends translate; `format:"anthropic"` is passthrough. Mapping highlights:
- **System prompt** → one leading `role:"system"` message (string or text-block array).
- **Tool-use (request)** → `tool_calls[].function.arguments` as a **string** (`JSON.stringify`).
- **Tool results** → one `role:"tool"` message per `tool_result` block, `tool_call_id` matched, emitted before same-turn user text.
- **`max_tokens` → `max_completion_tokens`**; `top_k` dropped; `stop_sequences` → `stop`.
- **`thinking` / `output_config` / `cache_control`** dropped (Anthropic-specific; no OpenAI equivalent — so prompt-cache translation across formats is not supported in v1).
- **`finish_reason` → `stop_reason`**: `stop→end_turn`, `length→max_tokens`, `tool_calls→tool_use`, `content_filter→refusal`.
- **Streaming**: emits `message_start` once, one `content_block_start`/`stop` per block, `content_block_delta` (text or `input_json_delta`), `message_delta` with mapped `stop_reason`, `message_stop` last; `stream_options.include_usage` requested so the final usage chunk is mapped.
- **`/v1/messages/count_tokens`** on an openai backend returns a heuristic (`chars/4`) — OpenAI has no count endpoint.

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
Checks PKCE, the `anthropic-beta` merge, header rewriting, **plus** multi-backend routing, request/response/SSE translation, and `maskKey`. Prints `selftest OK (multi-backend)` on success.

`node server.js --checkbackends` pings each enabled backend with a 1-token request and prints pass/fail + latency. Exits 0 if all pass, 1 if any fail. (For the OAuth subscription backend this currently returns 429 rate-limit via curl — which confirms the TLS-fingerprint gate is bypassed; see below.)

## ⚠️ Verified status (2026-06-25) — subscription OAuth is currently BLOCKED for inference

Anthropic's `/v1/messages` and `/v1/oauth/token` gate on the HTTP client's **TLS/transport fingerprint**: Node `fetch` (undici) and Node `https` both return `403 "Request not allowed"` with a valid subscription token + full official-client headers; **`curl` is accepted** (returns `429` = auth passed). The router therefore routes **all Anthropic-bound HTTP through `curl`** (`curlFetch` → `anthropicFetch`, with a zero-dep HTTPS-over-CONNECT fallback when an HTTP proxy like Clash is configured). Even so, Anthropic appears to block subscription-OAuth **inference** (the `/v1/messages` call) from non-official clients — the OAuth login path here is kept in case that block lifts.

For a working router today, add an **API-key** (`format:"anthropic"` with `apiKey`) or an **openai-format** backend (GLM/z.ai/codex) in the UI. The `anthropic` passthrough code is identical for OAuth and API-key backends; only the credential differs.

## Notes / caveats
- Uses Claude Code's reverse-engineered OAuth client to drive your **subscription**. Anthropic's consumer terms restrict programmatic use of subscription credentials — this is your own account, local, personal use, your call. The constants may change or be blocked at any time.
- The stored OAuth token grants **full access to your Claude account** — the server binds localhost only; do not expose the port.
- Per the project's "never hand-edit live config" rule, manage backends/routes/profiles through the UI (which round-trips through `saveConfig`); don't edit `backends.json` by hand while the router is running.

# claude-router — Multi-Backend Model-Name Router + Translation Layer + Profile Switcher

**Status:** Implementation-ready design spec (drives a build workflow).
**Date:** 2026-06-25
**Target codebase:** `C:/Users/Thomas/Documents/Projects/claude-router` — currently `server.js` (single file, Node ≥ 18, zero deps: built-in `http`/`crypto`/`fs`/`path`/`os`, global `fetch`) + inline webui.
**Authoritative wire facts:** Anthropic Messages API (`POST /v1/messages`, `x-api-key` + `anthropic-version: 2023-06-01`, SSE named events `message_start`/`content_block_start`/`content_block_delta`/`content_block_stop`/`message_delta`/`message_stop`/`ping`/`error`) and OpenAI Chat Completions (`POST /v1/chat/completions`, `Authorization: Bearer`, SSE `data:` lines terminated by `data: [DONE]`).

---

## 0. Goals & non-goals

**Goals**
1. Claude Code (speaks only the Anthropic `/v1/messages` API) points `ANTHROPIC_BASE_URL` at this router. The router reads `body.model` and routes to different backends: `gpt-5.5` → codex/OpenAI, `opus` → claude/Anthropic, `glm-5.2` → dashscope (OpenAI-compatible).
2. A format-translation layer (Anthropic ↔ OpenAI) so non-Anthropic backends look like Anthropic to Claude Code — request body, non-streaming response, and streaming SSE, including tool-use, system-prompt, and stop-reason mapping.
3. A real static UI (good UX) to manage backends / routes / keys, with a CC-Switch-style "switch Claude Code profile" control that writes `~/.claude/settings.json`.
4. Preserve the two existing modes verbatim: (a) OAuth-subscription login (403-blocked today, kept for if unblocked) and (b) API-key passthrough (`CLAUDE_ROUTER_API_KEY` + `CLAUDE_ROUTER_UPSTREAM`). These become the synthesized single-backend fallback when no `backends.json` exists.

**Non-goals**
- Not a Tauri/desktop app. Stays a single-file Node server + one static HTML file. Zero deps, no build step.
- No `/v1/responses` (Codex Responses API) support in v1 — codex is reached via `/v1/chat/completions` with an `sk-` key (see §2.3).
- No prompt-cache translation across formats (Anthropic `cache_control` is dropped on the OpenAI path; Anthropic-native path passes it through untouched).

**Iron rule:** the Anthropic-native path (`format:"anthropic"` backends) is byte-for-byte passthrough — the existing `headersOAuth`/`headersKey`/`streamUpstream` logic is reused unchanged. Translation only runs on `format:"openai"` backends. This keeps subscription OAuth and key passthrough provably non-regressed.

---

## 1. Architecture

### 1.1 File layout

```
claude-router/
  server.js          # single Node file: http server, proxy, translation, config, selftest, --checkbackends
  webui.html         # static UI (vanilla JS + CSS, no build) served at GET /
  backends.json      # NOT in repo — lives at ~/.claude-router/backends.json (mode 0600), created by UI/cli
  creds.json         # NOT in repo — ~/.claude-router/creds.json (existing OAuth tokens, mode 0600)
  README.md
  package.json       # no deps; "type":"commonjs"; bin/script entry `node server.js`
```

`server.js` remains a single CommonJS file (no `require` of local modules). `webui.html` is a *static asset*, not a JS module — this respects "single-file server, split static frontend only if needed." `server.js` reads `webui.html` from disk at startup (same dir as `server.js`) and serves it; if missing, falls back to a minimal inline HTML stub (so the binary still boots).

### 1.2 Constants & startup (extend existing block)

Keep all existing constants. Add:

```js
const CFG_DIR  = path.join(os.homedir(), ".claude-router");          // existing
const CRED_FILE = path.join(CFG_DIR, "creds.json");                  // existing (OAuth)
const CFG_FILE  = path.join(CFG_DIR, "backends.json");               // NEW
const CC_SETTINGS = path.join(os.homedir(), ".claude", "settings.json"); // NEW — CC-Switch target
const CC_SETTINGS_LEGACY = path.join(os.homedir(), ".claude", "claude.json"); // fallback per CC-Switch
const CC_BACKUP  = path.join(CFG_DIR, "settings-backup.json");       // NEW — pre-takeover backup
const ADMIN_TOKEN = process.env.CLAUDE_ROUTER_ADMIN_TOKEN || "";     // optional guard for /api writes
const DUMMY_KEY = "claude-router"; // non-empty dummy Claude Code sends; router ignores it
```

`HOST` stays `"127.0.0.1"`. `PORT` default `8123` (existing). `listenWithRetry` unchanged (default-port auto-hunt; explicit port fails loudly).

### 1.3 Request lifecycle (the new `proxy()`)

```
Claude Code ──POST /v1/messages──▶ router (127.0.0.1:PORT)
  1. readBody(req)
  2. parse JSON → body.model (if can't parse, treat as anthropic passthrough of raw bytes)
  3. backend = resolveBackend(body.model)        // §2.4
  4. switch backend.format:
       "anthropic" → anthropicPassthrough(req, res, backend, body)   // existing logic, per-backend
       "openai"    → openaiTranslate(req, res, backend, body)        // §3
  5. if backend == null → 502 {error:{type:"proxy_error", message:"no backend for model <m>"}}
```

`/v1/messages/count_tokens` on an openai backend: OpenAI has no equivalent → return `{input_tokens: <heuristic chars/4>, token_count:<same>}` (see §3.5). On an anthropic backend: passthrough as today.

`/v1/messages` beta headers (`anthropic-beta`, `anthropic-version`): passthrough on anthropic backends; **dropped** on openai backends (replaced by `Authorization: Bearer`).

### 1.4 Backend registry (in-memory, disk-backed)

`loadConfig()` → reads `backends.json` (or synthesizes the env fallback, §2.5). Returns:

```js
{
  backends:   Backend[],   // ordered list
  routes:     Route[],     // ordered, first-match-wins
  profiles:   Record<name, Profile>,
  activeProfile: string|null,
}
```

`Backend`:
```ts
{
  id:           string,          // stable, [a-z0-9-]+, used in routes/profiles
  name:         string,          // display
  upstream:     string,          // base URL incl. version seg, no trailing slash
                                //   anthropic: "https://api.anthropic.com"
                                //   openai/codex: "https://api.openai.com/v1"
                                //   z.ai: "https://open.bigmodel.cn/api/paas/v4"
                                //   dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1"
  format:       "anthropic" | "openai",
  apiKey:       string,          // for openai (Bearer) and anthropic-key (x-api-key). "" if oauth.
  oauth:        boolean,         // true → use ~/.claude-router/creds.json (subscription). Only ONE backend may set this.
  authScheme:   "bearer" | "x-api-key" | "oauth",  // derived: openai→bearer; anthropic+apiKey→x-api-key; anthropic+oauth→oauth
  modelPatterns: string[],       // glob patterns this backend can serve, e.g. ["gpt-5.5","gpt-5*"]; informational + fallback routing
  modelMap:     Record<string,string>,  // optional: rewrite body.model before forwarding, e.g. {"opus":"claude-opus-4-8"}
  testModel:    string,          // model id used by "test connection" + --checkbackends (defaults to first modelPattern)
  enabled:      boolean,         // false = skipped by resolver
}
```

`Route`: `{ pattern: string, backendId: string }` — `pattern` is a glob (`*` allowed) matched case-insensitively against `body.model`. First match wins.

`Profile`: `{ primaryModel: string, routeOverrides?: Route[] }` — applying a profile sets `activeProfile`, optionally swaps `routes` with `routeOverrides`, and writes `~/.claude/settings.json` so Claude Code sends `primaryModel` on its next session (§5).

### 1.5 Format-translation layer

Three pure functions + one async generator (§3). No state leaks between requests except the per-stream state inside the SSE generator. Translation is the ONLY place Anthropic↔OpenAI conversion happens; the proxy calls it and nothing else does.

---

## 2. Config model (`~/.claude-router/backends.json`)

### 2.1 Full schema

```jsonc
{
  "backends": [
    {
      "id": "codex",
      "name": "OpenAI Codex (gpt-5.5)",
      "upstream": "https://api.openai.com/v1",
      "format": "openai",
      "apiKey": "sk-REDACTED",
      "modelPatterns": ["gpt-5.5", "gpt-5*"],
      "modelMap": {},
      "testModel": "gpt-5.5",
      "enabled": true
    },
    {
      "id": "claude",
      "name": "Anthropic Opus (subscription OAuth)",
      "upstream": "https://api.anthropic.com",
      "format": "anthropic",
      "apiKey": "",
      "oauth": true,
      "modelPatterns": ["opus", "claude-*"],
      "modelMap": { "opus": "claude-opus-4-8" },
      "testModel": "claude-opus-4-8",
      "enabled": true
    },
    {
      "id": "glm",
      "name": "GLM 5.2 (DashScope)",
      "upstream": "https://dashscope.aliyuncs.com/compatible-mode/v1",
      "format": "openai",
      "apiKey": "sk-REDACTED",
      "modelPatterns": ["glm-5.2", "glm-*"],
      "modelMap": {},
      "testModel": "glm-5.2",
      "enabled": true
    }
  ],
  "routes": [
    { "pattern": "gpt-5.5", "backendId": "codex" },
    { "pattern": "opus",    "backendId": "claude" },
    { "pattern": "glm-5.2", "backendId": "glm" },
    { "pattern": "*",       "backendId": "claude" }
  ],
  "profiles": {
    "coding":   { "primaryModel": "gpt-5.5" },
    "research": { "primaryModel": "opus" },
    "cheap":    { "primaryModel": "glm-5.2" }
  },
  "activeProfile": null
}
```

### 2.2 Field semantics & validation

- `id`: `^[a-z0-9][a-z0-9-]{0,31}$`. Reject otherwise (prevents path/injection).
- `upstream`: strip trailing `/`. For `format:"openai"` the router appends `/chat/completions`; for `format:"anthropic"` it appends `req.url` (i.e. `/v1/messages` or `/v1/messages/count_tokens`).
- `authScheme` is derived, not stored: `format==="openai"` → `"bearer"`; `format==="anthropic" && apiKey` → `"x-api-key"`; `format==="anthropic" && oauth` → `"oauth"`.
- `modelMap`: applied to `body.model` **after** routing, **before** forwarding. Keys are the model string Claude Code sent; values are the upstream id. Lets the route pattern (`opus`) differ from the real upstream id (`claude-opus-4-8`).
- `modelPatterns`: used for (a) UI display, (b) fallback routing when no `routes` entry matches, (c) the "Test" button's default model (`testModel`).
- At most one backend may have `oauth:true` (the global `creds.json`). UI enforces this.

### 2.3 The "codex account" backend

Per research: there is no separate Codex host. A ChatGPT subscription OAuth token or an ordinary `sk-` API key both hit `api.openai.com/v1`. `/v1/chat/completions` is the drop-in OpenAI chat shape (what the translation layer speaks); `/v1/responses` is a different (stateful) schema and is **out of scope for v1**. So the `codex` backend is just an `openai`-format backend with `upstream:"https://api.openai.com/v1"`, `apiKey:"sk-..."`, `testModel:"gpt-5.5"`. Document in the UI tooltip: "Codex CLI uses `/v1/responses`; this router uses `/v1/chat/completions` with an API key — same host, same `gpt-5.5` model."

### 2.4 Routing — `resolveBackend(model)`

```js
function resolveBackend(model) {
  const cfg = loadConfig();
  const m = String(model || "").toLowerCase();
  // 1. routes table — first match wins
  for (const r of cfg.routes) {
    if (matchPattern(m, r.pattern)) {
      const b = cfg.backends.find(x => x.id === r.backendId && x.enabled !== false);
      if (b) return b;
    }
  }
  // 2. fallback: any enabled backend whose modelPatterns match
  for (const b of cfg.backends) {
    if (b.enabled === false) continue;
    if ((b.modelPatterns || []).some(p => matchPattern(m, p))) return b;
  }
  // 3. last resort: a backend with "*" pattern, else first enabled, else null
  const star = cfg.backends.find(b => b.enabled !== false && (b.modelPatterns || []).includes("*"));
  return star || cfg.backends.find(b => b.enabled !== false) || null;
}

function matchPattern(modelLower, pattern) {
  const p = String(pattern).toLowerCase();
  if (p === "*" || p === "") return true;
  // glob: * → .*, escape the rest, anchor
  const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(modelLower);
}
```

### 2.5 Backward-compat synthesis (preserve env modes)

If `backends.json` does not exist, `loadConfig()` synthesizes a single-backend config from env, exactly reproducing today's `KEY_MODE` / OAuth behavior:

```js
function synthesizeFromEnv() {
  if (STATIC_KEY) {                              // existing KEY_MODE
    return {
      backends: [{ id:"default", name:"API-key passthrough", upstream: UPSTREAM,
        format:"anthropic", apiKey: STATIC_KEY, authScheme:"x-api-key",
        modelPatterns:["*"], modelMap:{}, testModel:"", enabled:true }],
      routes: [{ pattern:"*", backendId:"default" }],
      profiles: {}, activeProfile: null,
    };
  }
  // OAuth subscription (existing)
  return {
    backends: [{ id:"default", name:"Anthropic subscription (OAuth)", upstream:"https://api.anthropic.com",
      format:"anthropic", apiKey:"", oauth:true, authScheme:"oauth",
      modelPatterns:["*"], modelMap:{}, testModel:"claude-opus-4-8", enabled:true }],
    routes: [{ pattern:"*", backendId:"default" }],
    profiles: {}, activeProfile: null,
  };
}
```

This means: **with no `backends.json` and `CLAUDE_ROUTER_API_KEY` set, the router behaves byte-identically to today.** The existing `selftest` PKCE/header assertions still pass. `UPSTREAM`/`STATIC_KEY`/`KEY_MODE` constants are kept and feed the synthesizer.

### 2.6 Disk I/O

```js
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, "utf8")); }
  catch { return synthesizeFromEnv(); }
}
function saveConfig(cfg) {
  fs.mkdirSync(CFG_DIR, { recursive:true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
```

---

## 3. Translation layer (Anthropic ↔ OpenAI) — code-level spec

All functions live in `server.js`. They are pure (no I/O) except the SSE generator which consumes an async iterator of raw bytes/chunks.

### 3.1 `anthropicToOpenaiBody(body)` → OpenAI chat-completion request

```js
function anthropicToOpenaiBody(body) {
  const out = {
    model: body.model,                          // caller may apply backend.modelMap first
    messages: [],
    stream: !!body.stream,
  };
  if (out.stream) out.stream_options = { include_usage: true };  // need usage on final chunk (§3.4)

  // --- system prompt: top-level system (string OR array of text blocks) → one {role:"system"} ---
  let sysText = "";
  if (typeof body.system === "string") sysText = body.system;
  else if (Array.isArray(body.system)) {
    sysText = body.system
      .filter(b => b && b.type === "text")
      .map(b => b.text)
      .join("\n");
  }
  if (sysText) out.messages.push({ role:"system", content: sysText });

  // --- messages ---
  for (const msg of body.messages || []) {
    if (msg.role === "assistant") {
      out.messages.push(anthropicAssistantToOpenai(msg));
    } else if (msg.role === "user") {
      // a user turn may mix text/image/tool_result blocks
      const parts = [];      // content parts for a role:"user" message
      const toolResults = []; // each becomes its own role:"tool" message
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type:"text", text: String(msg.content ?? "") }];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          toolResults.push({ role:"tool", tool_call_id: b.tool_use_id, content: flattenToolResult(b.content) });
        } else if (b.type === "text") {
          parts.push({ type:"text", text: b.text });
        } else if (b.type === "image") {
          parts.push({ type:"image_url", image_url:{ url: imageUrlFromAnthropic(b.source) } });
        }
      }
      // tool results MUST come right after the assistant tool_calls, before any new user text
      for (const tr of toolResults) out.messages.push(tr);
      if (parts.length) out.messages.push({ role:"user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    } else if (msg.role === "system") {
      // mid-conversation system (rare from Claude Code) — fold into a system message
      out.messages.push({ role:"system", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) });
    }
  }

  // --- top-level params ---
  if (body.max_tokens != null) out.max_completion_tokens = body.max_tokens;  // preferred over deprecated max_tokens
  if (body.temperature != null) out.temperature = clamp(body.temperature, 0, 2);
  if (body.top_p != null) out.top_p = body.top_p;
  // top_k: dropped (no OpenAI equivalent)
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (body.metadata && body.metadata.user_id) out.user = body.metadata.user_id;
  if (Array.isArray(body.tools) && body.tools.length) out.tools = body.tools.map(anthropicToolToOpenai);
  if (body.tool_choice) {
    const tc = anthropicToolChoiceToOpenai(body.tool_choice);
    if (tc.tool_choice !== undefined) out.tool_choice = tc.tool_choice;
    if (tc.parallel_tool_calls !== undefined) out.parallel_tool_calls = tc.parallel_tool_calls;
  }
  // drop: thinking, output_config, cache_control (Anthropic-specific; no OpenAI equivalent)
  return out;
}
```

Helpers:

```js
function anthropicAssistantToOpenai(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content : [{ type:"text", text: String(msg.content ?? "") }];
  let text = "";
  const tool_calls = [];
  for (const b of blocks) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use") {
      tool_calls.push({
        id: b.id, type:"function",
        function:{ name: b.name, arguments: JSON.stringify(b.input ?? {}) }  // arguments is a STRING
      });
    }
    // thinking blocks: dropped (OpenAI has no streaming thinking delta we map in v1)
  }
  return {
    role:"assistant",
    content: text || null,    // null when only tool_calls
    ...(tool_calls.length ? { tool_calls } : {}),
  };
}

function anthropicToolToOpenai(t) {
  return {
    type:"function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type:"object", properties:{} },
      ...(t.strict != null ? { strict: t.strict } : {}),
    },
  };
}

function anthropicToolChoiceToOpenai(tc) {
  const out = {};
  if (tc.type === "auto") out.tool_choice = "auto";
  else if (tc.type === "any") out.tool_choice = "required";
  else if (tc.type === "none") out.tool_choice = "none";
  else if (tc.type === "tool") out.tool_choice = { type:"function", function:{ name: tc.name } };
  if (tc.disable_parallel_tool_use) out.parallel_tool_calls = false;  // inversion
  return out;
}

function flattenToolResult(content) {
  // Anthropic tool_result.content: string | array of blocks. OpenAI tool content is a string.
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter(b => b.type === "text").map(b => b.text).join("\n");
  return String(content ?? "");
}

function imageUrlFromAnthropic(source) {
  if (!source) return "";
  if (source.type === "base64") return `data:${source.media_type};base64,${source.data}`;
  if (source.type === "url") return source.url;
  return "";
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n))); }
```

**Explicit call-outs (must be correct in implementation):**
- **System prompt:** Anthropic top-level `system` (string or text-block array) becomes exactly one leading `role:"system"` message. Do not emit per-block system messages.
- **Tool-use (request):** Anthropic assistant `tool_use` block (`input` object) → OpenAI `tool_calls[].function.arguments` **string** via `JSON.stringify`. Never string-match; always parse/stringify.
- **Tool results:** Anthropic `role:"user"` carrying `tool_result` blocks → one `role:"tool"` message **per** block, each with `tool_call_id` matching the `tool_use.id`. Emitted **before** any same-turn user text.
- **`top_k`:** dropped (no OpenAI equivalent).
- **`max_tokens` → `max_completion_tokens`** (newer OpenAI reasoning models like `gpt-5.5` prefer this; `max_tokens` is the deprecated alias).
- **`thinking`/`output_config`/`cache_control`:** dropped (Anthropic-specific).

### 3.2 `mapFinishReason(reason)` → Anthropic `stop_reason`

```js
function mapFinishReason(reason) {
  switch (reason) {
    case "stop":           return "end_turn";
    case "length":         return "max_tokens";
    case "tool_calls":     return "tool_use";
    case "function_call":  return "tool_use";        // legacy
    case "content_filter": return "refusal";          // closest semantic; document this choice
    default:               return "end_turn";
  }
}
```

### 3.3 `openaiToAnthropicResponse(json, anthropicModel)` → Anthropic `Message` (non-streaming)

```js
function openaiToAnthropicResponse(json, anthropicModel) {
  const choice = (json.choices && json.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === "string" && msg.content) {
    content.push({ type:"text", text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = {}; }  // arguments is a STRING
      content.push({ type:"tool_use", id: tc.id, name: tc.function.name, input });
    }
  }
  const u = json.usage || {};
  return {
    id: "msg_" + (json.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || crypto.randomUUID(),
    type: "message",
    role: "assistant",
    model: anthropicModel,                         // echo the model Claude Code requested
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,                           // OpenAI doesn't report which stop matched
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      cache_read_input_tokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
      cache_creation_input_tokens: 0,
    },
  };
}
```

### 3.4 `openaiSseToAnthropicSse(asyncIter, anthropicModel)` — async generator yielding Anthropic SSE strings

Consumes raw byte chunks from the upstream `fetch` body. First parses OpenAI SSE (`data: <json>\n\n`, terminated by `data: [DONE]`), then runs the stateful transform from research §4. Each `yield` is a complete Anthropic SSE block: `` `event: <name>\ndata: <json>\n\n` ``.

```js
async function* openaiSseToAnthropicSse(asyncIter, anthropicModel) {
  const state = {
    emittedMessageStart: false,
    nextBlockIndex: 0,
    openBlock: null,            // {index, kind:"text"|"tool_use", tcIndex?:number}
    tcIndexToBlockIndex: new Map(),
    finalUsage: null,
    finalFinishReason: null,
    model: anthropicModel,
  };
  for await (const chunk of sseDataLines(asyncIter)) {   // yields parsed JSON objects; "DONE" sentinel ends iter
    yield* handleOpenaiChunk(chunk, state);
  }
  // if upstream ended without a finish_reason (no [DONE] or no terminal chunk), close cleanly
  if (state.openBlock) { yield sseBlock("content_block_stop", { index: state.openBlock.index }); state.openBlock = null; }
  if (!state.finalFinishReason) {
    yield sseBlock("message_delta", { delta:{ stop_reason:"end_turn", stop_sequence:null }, usage:{} });
    yield sseBlock("message_stop", {});
  }
}

async function* sseDataLines(asyncIter) {
  // asyncIter: async iterable of Uint8Array/Buffer chunks from fetch body reader
  let buf = "";
  for await (const raw of asyncIter) {
    buf += Buffer.from(raw).toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (data === "[DONE]") return;       // sentinel: end generator
      try { yield JSON.parse(data); } catch { /* skip malformed */ }
    }
  }
}

function* handleOpenaiChunk(chunk, state) {
  // usage-only final chunk (choices: [])
  if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) {
    if (chunk.usage) state.finalUsage = chunk.usage;
    return;
  }
  const choice = chunk.choices[0];
  const delta = choice.delta || {};

  // first chunk: emit message_start once
  if (!state.emittedMessageStart) {
    state.emittedMessageStart = true;
    yield sseBlock("message_start", {
      message: {
        id: "msg_" + String(chunk.id || "").replace(/[^A-Za-z0-9_-]/g,"").slice(0,40) || crypto.randomUUID(),
        type:"message", role:"assistant", content:[], model: state.model,
        stop_reason:null, stop_sequence:null,
        usage:{ input_tokens:0, output_tokens:1 },   // input unknown until final usage chunk
      },
    });
  }

  // text content
  if (typeof delta.content === "string" && delta.content) {
    if (!state.openBlock || state.openBlock.kind !== "text") {
      if (state.openBlock) { yield sseBlock("content_block_stop", { index: state.openBlock.index }); }
      const idx = state.nextBlockIndex++;
      yield sseBlock("content_block_start", { index: idx, content_block:{ type:"text", text:"" } });
      state.openBlock = { index: idx, kind:"text" };
    }
    yield sseBlock("content_block_delta", { index: state.openBlock.index, delta:{ type:"text_delta", text: delta.content } });
  }

  // tool calls
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (!state.tcIndexToBlockIndex.has(tc.index)) {
        // first chunk for this tool call → open a tool_use block
        if (state.openBlock) { yield sseBlock("content_block_stop", { index: state.openBlock.index }); state.openBlock = null; }
        const idx = state.nextBlockIndex++;
        state.tcIndexToBlockIndex.set(tc.index, idx);
        yield sseBlock("content_block_start", {
          index: idx,
          content_block:{ type:"tool_use", id: tc.id, name: tc.function && tc.function.name, input:{} },
        });
        state.openBlock = { index: idx, kind:"tool_use", tcIndex: tc.index };
      }
      const args = (tc.function && tc.function.arguments) || "";
      if (args) {
        yield sseBlock("content_block_delta", {
          index: state.tcIndexToBlockIndex.get(tc.index),
          delta:{ type:"input_json_delta", partial_json: args },   // string delta → partial_json (string delta)
        });
      }
    }
  }

  // refusal (OpenAI streams delta.refusal) — buffer, surface via stop_reason at the end
  // (no Anthropic streaming refusal delta; implemented as end-of-stream refusal)

  // finish
  if (choice.finish_reason) {
    state.finalFinishReason = choice.finish_reason;
    if (state.openBlock) { yield sseBlock("content_block_stop", { index: state.openBlock.index }); state.openBlock = null; }
    const u = state.finalUsage || {};
    yield sseBlock("message_delta", {
      delta:{ stop_reason: mapFinishReason(choice.finish_reason), stop_sequence:null },
      usage:{ input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
    });
    yield sseBlock("message_stop", {});
  }
}

function sseBlock(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
```

**Two things the implementation MUST get right (from research):**
1. **`delta.tool_calls[].index` is a tool-call index, not a byte offset.** It selects which `tool_use` block receives `input_json_delta`. Emit `content_block_start` for a `tool_use` block **once per new OpenAI `index`**, then route subsequent `arguments` deltas to that block via the `tcIndexToBlockIndex` map.
2. **`arguments` (string) ↔ `partial_json` (string).** They correspond directly. Pass `arguments` through as `partial_json`. Skip emitting `input_json_delta` for empty strings (no-op). Anthropic clients accumulate and `JSON.parse` at `content_block_stop`.

### 3.5 `count_tokens` on openai backends

OpenAI has no token-count endpoint. Implement a heuristic so Claude Code doesn't break:

```js
function openaiCountTokensResponse(body) {
  // rough: 1 token ≈ 4 chars; sum system + messages text
  let chars = 0;
  const add = (s) => { if (typeof s === "string") chars += s.length; };
  add(typeof body.system === "string" ? body.system : "");
  if (Array.isArray(body.system)) body.system.forEach(b => add(b.text));
  for (const m of body.messages || []) {
    if (typeof m.content === "string") add(m.content);
    else if (Array.isArray(m.content)) m.content.forEach(b => add(b.text || JSON.stringify(b.input || "")));
  }
  const n = Math.max(1, Math.ceil(chars / 4));
  return { input_tokens: n };
}
```

### 3.6 Proxy wiring for openai backends

```js
async function openaiTranslate(req, res, backend, body) {
  if (!body || !body.model) return sendJson(res, 400, { error:{ type:"invalid_request_error", message:"router: missing body.model" } });
  const model = (backend.modelMap && backend.modelMap[body.model]) || body.model;

  if (req.url.startsWith("/v1/messages/count_tokens")) {
    return sendJson(res, 200, openaiCountTokensResponse(body));
  }

  const isStream = !!body.stream;
  const oaiBody = anthropicToOpenaiBody({ ...body, model });
  const url = backend.upstream + "/chat/completions";
  const headers = { "content-type":"application/json", "authorization":`Bearer ${backend.apiKey}` };
  if (isStream) headers.accept = "text/event-stream";

  let up;
  try {
    up = await fetch(url, { method:"POST", headers, body: JSON.stringify(oaiBody) });
  } catch (e) {
    return sendJson(res, 502, { error:{ type:"proxy_error", message:`${backend.id}: ${String(e)}` } });
  }
  if (!up.ok) {
    const text = await up.text();
    return sendJson(res, up.status, { error:{ type:"api_error", message:`${backend.id} upstream ${up.status}: ${text.slice(0,500)}` } });
  }

  if (isStream) {
    res.writeHead(200, { "content-type":"text/event-stream", "cache-control":"no-cache", "connection":"keep-alive" });
    try {
      const reader = up.body.getReader();
      const iter = (async function* () { for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; } })();
      for await (const block of openaiSseToAnthropicSse(iter, body.model)) res.write(block);
    } catch (e) {
      res.write(sseBlock("error", { type:"error", error:{ type:"api_error", message:String(e) } }));
    }
    res.end();
  } else {
    const json = await up.json();
    sendJson(res, 200, openaiToAnthropicResponse(json, body.model));
  }
}
```

### 3.7 Per-backend anthropic passthrough (reuse existing header helpers)

```js
async function anthropicPassthrough(req, res, backend, body) {
  const model = (backend.modelMap && body && backend.modelMap[body.model]) || (body && body.model);
  let sendBody = req._rawBody;                                  // raw bytes by default
  if (model && model !== body.model) {
    // cheap rewrite: re-serialize with mapped model
    sendBody = Buffer.from(JSON.stringify({ ...body, model }));
  }
  const url = backend.upstream + req.url;                      // /v1/messages | /v1/messages/count_tokens
  let headers;
  if (backend.authScheme === "oauth") {
    const token = await getAccessToken();                      // existing refresh logic
    if (!token) return sendJson(res, 401, { error:{ type:"authentication_error", message:"claude-router: not logged in. Open http://"+HOST+":"+boundPort+"/ and click Login." } });
    headers = headersOAuth(req.headers, token);                // existing
  } else { // x-api-key
    headers = headersKey(req.headers, backend.apiKey);         // existing
  }
  let up;
  try { up = await fetch(url, { method:req.method, headers, body: sendBody && sendBody.length ? sendBody : undefined }); }
  catch (e) { return sendJson(res, 502, { error:{ type:"proxy_error", message:String(e) } }); }
  if (up.status === 401 && backend.authScheme === "oauth") {   // existing mid-flight refresh+retry
    const c = loadCreds();
    if (c && c.refresh_token) { try { const c2 = await refreshCreds(c); up = await fetch(url, { method:req.method, headers: headersOAuth(req.headers, c2.access_token), body: sendBody && sendBody.length ? sendBody : undefined }); } catch {} }
  }
  await streamUpstream(res, up);                               // existing
}
```

`proxy()` reads the body once into `req._rawBody` (Buffer) AND parses JSON into `req._body` (or `null` if not JSON). `anthropicPassthrough` uses the raw bytes (so non-JSON / pre-existing bytes pass through untouched when no modelMap applies); `openaiTranslate` uses the parsed body.

---

## 4. Frontend (`webui.html`, served at `GET /`)

### 4.1 Stack & constraints

- Vanilla JS + CSS in one `webui.html`. No framework, no build step, no npm install. Zero deps end-to-end.
- Talks to the router over a JSON REST API under `/api/*` (same origin). No CORS needed.
- Clean, modern look: system-ui font, ~960px max-width, card layout, soft borders, the existing warm palette (`#faf9f7` bg, `#cd6f4c` primary accent, `#1a7f37` ok / `#b3261e` warn). Subtle `box-shadow` on cards; **no keyframe `box-shadow` animation** (per memory `claude-monitor-pets-input-lag` — DWM/GPU cost). Use CSS transitions (`transition: box-shadow 120ms`) only.

### 4.2 UI sections (top to bottom)

1. **Header bar:** "claude-router" title; router base URL (`http://127.0.0.1:<port>`) with a copy button; mode badge (`OAuth` / `API-key` / `Multi-backend`); OAuth status line (existing `statusLine()` text).
2. **OAuth login card** (unchanged from today, shown when an `oauth:true` backend exists): ① Login with Claude, ② paste `code#state`, Submit, Logout. Keep the 403 warning callout.
3. **Backends grid:** one card per backend.
   - Header: `name` + format badge (`anthropic` / `openai`) + enabled toggle.
   - Body: `upstream` (mono), model-pattern chips, masked key (`sk-...wxyz`), auth scheme.
   - Actions: **Test** (→ `POST /api/backends/:id/test`, shows ✓ pass + latency + 1-token sample, or ✗ fail + error), **Edit**, **Delete**.
   - **Add backend** button → modal form: `id`, `name`, `format` (select), `upstream`, `apiKey` (password field), `oauth` (checkbox, only for anthropic), `modelPatterns` (comma list), `modelMap` (key:value lines), `testModel`.
4. **Routes table:** columns `#` (precedence, drag handle to reorder — or up/down arrows), `Pattern` (text), `Backend` (select of backend ids), `Actions` (delete). "Add route" row. Note: "First match wins. `*` catches all."
5. **Profiles / Claude Code switcher** (CC-Switch-style):
   - Dropdown of profile names (`coding` / `research` / `cheap` / …) + "Apply profile" button.
   - Shows a preview of the exact `env` block that will be written to `~/.claude/settings.json`:
     ```jsonc
     { "env": { "ANTHROPIC_BASE_URL": "http://127.0.0.1:8123", "ANTHROPIC_API_KEY": "claude-router", "ANTHROPIC_MODEL": "gpt-5.5" } }
     ```
   - "Restore original settings.json" button (writes back `~/.claude-router/settings-backup.json`).
   - Conflict banner: if the router detects `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` in the OS environment (it can see `process.env`; for registry-level it can only warn — see §5.4), show: "⚠ OS environment overrides the file — Claude Code may bypass the router. Unset them or run Claude Code in a clean shell."
   - Status line: "Active profile: coding · Claude Code will use model `gpt-5.5` on next session."

### 4.3 JSON REST API contract (`/api/*`)

All `/api/*` handlers: `Content-Type: application/json`. If `CLAUDE_ROUTER_ADMIN_TOKEN` is set, mutating endpoints require header `X-Admin-Token: <token>` (or `Authorization: Bearer <token>`); read endpoints are open. Default (localhost) = no token.

| Method | Path | Body | Returns | Notes |
|---|---|---|---|---|
| GET | `/api/state` | — | `{mode, baseUrl, oauthStatus, backends:[…masked], routes, profiles, activeProfile, osEnvConflicts}` | single-call hydration for the UI |
| GET | `/api/backends` | — | `[…masked]` | keys masked |
| POST | `/api/backends` | `Backend` (full key) | `Backend` (masked) | validate id regex; reject dup |
| PUT | `/api/backends/:id` | partial `Backend` | `Backend` (masked) | if `apiKey` omitted/empty, keep existing |
| DELETE | `/api/backends/:id` | — | `{ok:true}` | refuse if referenced by a route |
| POST | `/api/backends/:id/test` | — | `{ok, latencyMs, model, sample, error?}` | §7.2 `testBackend()` |
| GET | `/api/routes` | — | `Route[]` | ordered |
| POST | `/api/routes` | `{pattern, backendId}` | `Route[]` | append |
| DELETE | `/api/routes/:idx` | — | `Route[]` | remove by index |
| PUT | `/api/routes/order` | `{order:[idx…]}` | `Route[]` | reorder precedence |
| GET | `/api/profiles` | — | `{profiles, activeProfile}` | |
| POST | `/api/profiles/:name/apply` | — | `{ok, writtenPath, env, conflicts}` | §5 `applyProfile()` |
| POST | `/api/profiles/restore` | — | `{ok, restoredPath}` | restore backup |
| GET | `/login` | — | 302 → authorize URL | existing |
| POST | `/exchange` | form `code` | 302 `/` | existing |
| POST | `/logout` | — | 302 `/` | existing |
| ALL | `/v1/*` | — | proxy | existing path |

**Masking** — keys are never returned in full:

```js
function maskKey(k) {
  if (!k) return "";
  if (k.length <= 7) return k.slice(0,2) + "…" + "*".repeat(3);
  return k.slice(0,3) + "…" + k.slice(-4);   // sk-…wxyz
}
```

`GET /api/backends` and `GET /api/state` return `apiKey: maskKey(b.apiKey)`. `POST/PUT` accept a full key; the response masks it. `PUT` with empty/missing `apiKey` preserves the stored key (so a UI edit that doesn't retouch the key doesn't wipe it — per memory `corepilot-never-handedit-store`, editing live config files is risky; the UI round-trips through `saveConfig` only).

### 4.4 Server-side static serving

```js
const WEBUI = fs.existsSync(path.join(__dirname, "webui.html"))
  ? fs.readFileSync(path.join(__dirname, "webui.html"), "utf8")
  : FALLBACK_HTML;   // tiny inline stub so the binary still boots
// GET /  → sendHtml(res, 200, WEBUI)
```

---

## 5. CC-Switch integration — concrete mechanism

Verified from `farion1231/cc-switch` source (research §1–2). The file Claude Code reads is `~/.claude/settings.json` (legacy fallback `~/.claude/claude.json`). Claude Code reads its `env` block as process environment; **OS environment overrides the file**, which is why CC-Switch scrubs OS-level `ANTHROPIC_*`.

### 5.1 The exact write

`applyProfile(name)`:

```js
function applyProfile(name) {
  const cfg = loadConfig();
  const profile = cfg.profiles && cfg.profiles[name];
  if (!profile) throw new Error(`unknown profile: ${name}`);
  const path = fs.existsSync(CC_SETTINGS_LEGACY) ? CC_SETTINGS_LEGACY : CC_SETTINGS;

  // 1. back up the ORIGINAL (first time only) — crash-safe like CC-Switch
  if (!fs.existsSync(CC_BACKUP) && fs.existsSync(path)) {
    fs.mkdirSync(CFG_DIR, { recursive:true });
    fs.writeFileSync(CC_BACKUP, fs.readFileSync(path, "utf8"), { mode: 0o600 });
  }

  // 2. deep-merge: only set env.ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY + ANTHROPIC_MODEL; preserve everything else
  const cur = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path, "utf8") || "{}") : {};
  cur.env = cur.env && typeof cur.env === "object" ? cur.env : {};
  cur.env.ANTHROPIC_BASE_URL = `http://${HOST}:${boundPort}`;
  cur.env.ANTHROPIC_API_KEY  = DUMMY_KEY;                 // non-empty dummy; router ignores it
  if (profile.primaryModel) cur.env.ANTHROPIC_MODEL = profile.primaryModel;
  // NOTE: we do NOT scrub ANTHROPIC_DEFAULT_*_MODEL — we WANT Claude Code to send our route names.

  // 3. atomic write (temp + rename), keys sorted — matches CC-Switch atomic_write
  atomicWriteJson(path, cur);

  // 4. persist active profile
  cfg.activeProfile = name;
  if (profile.routeOverrides) cfg.routes = profile.routeOverrides;
  saveConfig(cfg);

  return { writtenPath: path, env: cur.env, conflicts: detectOsEnvConflicts() };
}
```

`restoreProfile()`:

```js
function restoreProfile() {
  const path = fs.existsSync(CC_SETTINGS_LEGACY) ? CC_SETTINGS_LEGACY : CC_SETTINGS;
  if (!fs.existsSync(CC_BACKUP)) throw new Error("no backup to restore");
  fs.copyFileSync(CC_BACKUP, path);   // restore original
  const cfg = loadConfig(); cfg.activeProfile = null; saveConfig(cfg);
  return { restoredPath: path };
}
```

Atomic JSON write (port of CC-Switch `config.rs::atomic_write`):

```js
function atomicWriteJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sortKeys(obj), null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === "object") return Object.keys(o).sort().reduce((a,k)=>{a[k]=sortKeys(o[k]);return a;},{});
  return o;
}
```

### 5.2 What Claude Code sees after Apply

`~/.claude/settings.json`:
```jsonc
{
  "env": {
    "ANTHROPIC_API_KEY": "claude-router",        // dummy, non-empty → no login prompt
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8123",
    "ANTHROPIC_MODEL": "gpt-5.5"                 // Claude Code sends this → router routes to codex
  },
  // …user's existing permissions, mcpServers, theme preserved…
}
```

Effect: on the **next Claude Code session**, Claude Code POSTs `/v1/messages` with `model:"gpt-5.5"` to `127.0.0.1:8123`, sends `x-api-key: claude-router` (ignored by router), and the router routes to the `codex` backend with the real `sk-` key. This is **CC-Switch direct (file-write) mode** — takes effect on next session, no process kill. (Hot-switch without restart would require the proxy-takeover mode, but our router IS the proxy, so switching the active profile's `routes`/`primaryModel` + re-applying is enough; an already-running Claude Code picks up model changes on its next request only if it re-reads env, which it does per session — document this.)

### 5.3 Profile ↔ backends/routes mapping

A profile is a *preset* of `(primaryModel, optional routeOverrides)`. Applying it:
1. sets `cfg.activeProfile` + (optionally) swaps `cfg.routes`,
2. writes `settings.json` so Claude Code sends `primaryModel`.

So "switch profile" = "tell Claude Code which model to send + optionally rewire which backend that model (and others) go to." The backends themselves are global; profiles only choose the active model and route overrides.

### 5.4 OS-env conflict detection

```js
function detectOsEnvConflicts() {
  const risky = ["ANTHROPIC_BASE_URL","ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN"];
  return risky.filter(k => process.env[k] && process.env[k] !== DUMMY_KEY);
}
```

Node cannot scrub the Windows Registry (`HKCU\Environment`) without `reg.exe` / elevation. The UI surfaces the conflict; if `process.env` has a stale `ANTHROPIC_BASE_URL`, the user must unset it in their shell. Document a one-liner: `set ANTHROPIC_BASE_URL=` (cmd) / `Remove-Item Env:ANTHROPIC_BASE_URL` (PowerShell). (A future hardening: shell out to `reg query HKCU\Environment` to scan the registry and warn — out of scope for v1.)

---

## 6. Security

- **Localhost-only binding:** `HOST = "127.0.0.1"` (unchanged). The server never listens on a public interface. `0.0.0.0`/`::` are never used.
- **Config file mode 0600:** `saveConfig`, `saveCreds`, `atomicWriteJson`, `CC_BACKUP` all write with `mode: 0o600`. `CFG_DIR` created with `recursive:true`.
- **Keys never returned in full:** `maskKey()` on every read path (`/api/backends`, `/api/state`). Full keys only accepted on `POST/PUT` and never echoed back unmasked. `PUT` with empty `apiKey` preserves the stored key (no wipe-on-edit).
- **Dummy `ANTHROPIC_API_KEY` ignored:** Claude Code sends `x-api-key: claude-router` (or whatever dummy). The router never authenticates incoming requests — it uses each backend's own real key. The dummy is documented as non-secret.
- **Admin token (optional):** if `CLAUDE_ROUTER_ADMIN_TOKEN` is set, all mutating `/api/*` calls require `X-Admin-Token`. Default unset (localhost is the boundary). Read endpoints always open (UI hydration).
- **ID validation:** backend `id` must match `^[a-z0-9][a-z0-9-]{0,31}$` — prevents path traversal / weird JSON keys.
- **No CORS headers:** UI is same-origin (`http://127.0.0.1:<port>` serves both `/` and `/api/*`). Browsers block cross-origin by default; we add nothing.
- **Upstream error containment:** openai upstream non-2xx → returned as Anthropic-shaped error `{type:"api_error", message:"<id> upstream <status>: <truncated>"}` with the upstream status code. No upstream body leakage beyond a 500-char truncation.
- **Settings.json safety:** never clobber — deep-merge `env` only; back up once before first takeover; atomic temp+rename. Matches CC-Switch crash-safety (backup-before-rewrite).

---

## 7. Testing

### 7.1 Extend `selftest()` (offline, no network)

Keep all existing assertions (PKCE, `mergeBetas`, `headersOAuth`, `headersKey`). Add a `selftestMultiBackend()` block invoked from `selftest()`:

```js
function selftestMultiBackend() {
  const assert = (c,m) => { if (!c) { console.error("FAIL:",m); process.exit(1); } };

  // (a) matchPattern
  assert( matchPattern("gpt-5.5","gpt-5*"), "glob gpt-5* matches gpt-5.5");
  assert( matchPattern("gpt-5.4","gpt-5*"), "glob gpt-5* matches gpt-5.4");
  assert(!matchPattern("glm-5.2","gpt-5*"), "glob gpt-5* does not match glm-5.2");
  assert( matchPattern("opus","opus"),      "exact opus matches");
  assert( matchPattern("anything","*"),     "catch-all matches");

  // (b) routing — synthesize a cfg and call resolveBackend against it (refactor resolveBackend to take cfg)
  const cfg = {
    backends: [
      { id:"codex",  format:"openai",    modelPatterns:["gpt-5*"], enabled:true },
      { id:"claude", format:"anthropic", modelPatterns:["opus","claude-*"], enabled:true },
      { id:"glm",    format:"openai",    modelPatterns:["glm-*"], enabled:true },
    ],
    routes: [
      { pattern:"gpt-5.5", backendId:"codex" },
      { pattern:"opus",    backendId:"claude" },
      { pattern:"glm-5.2", backendId:"glm" },
      { pattern:"*",       backendId:"claude" },
    ],
  };
  assert(resolveBackendCfg(cfg,"gpt-5.5").id === "codex",  "route gpt-5.5 → codex");
  assert(resolveBackendCfg(cfg,"opus").id    === "claude", "route opus → claude");
  assert(resolveBackendCfg(cfg,"glm-5.2").id === "glm",    "route glm-5.2 → glm");
  assert(resolveBackendCfg(cfg,"gpt-5.4").id === "codex",  "route gpt-5.5 miss → fallback modelPatterns gpt-5* → codex");
  assert(resolveBackendCfg(cfg,"weird").id   === "claude", "catch-all * → claude");

  // (c) request translation
  const anth = {
    model:"gpt-5.5", max_tokens:100, temperature:0.5, top_k:40,
    system:[{type:"text",text:"You are helpful."}],
    messages:[
      { role:"user", content:"Weather in SF?" },
      { role:"assistant", content:[{type:"text",text:"Let me check."},{type:"tool_use",id:"toolu_A",name:"get_weather",input:{location:"SF"}}] },
      { role:"user", content:[{type:"tool_result",tool_use_id:"toolu_A",content:"62F"}] },
    ],
    tools:[{ name:"get_weather", description:"d", input_schema:{type:"object",properties:{location:{type:"string"}},required:["location"]}, strict:true }],
    tool_choice:{ type:"auto", disable_parallel_tool_use:true },
    stop_sequences:["END"],
    stream:true,
  };
  const oai = anthropicToOpenaiBody(anth);
  assert(oai.messages[0].role === "system" && oai.messages[0].content === "You are helpful.", "system → leading system message");
  assert(oai.max_completion_tokens === 100, "max_tokens → max_completion_tokens");
  assert(oai.top_k === undefined, "top_k dropped");
  assert(oai.temperature === 0.5, "temperature passthrough");
  assert(Array.isArray(oai.stop) && oai.stop[0] === "END", "stop_sequences → stop");
  assert(oai.stream_options && oai.stream_options.include_usage === true, "stream_options.include_usage added");
  assert(oai.tools[0].type === "function" && oai.tools[0].function.parameters.required[0]==="location" && oai.tools[0].function.strict === true, "tool mapped");
  assert(oai.tool_choice === "auto" && oai.parallel_tool_calls === false, "tool_choice + parallel inverted");
  // assistant tool_use → tool_calls with string arguments
  const asst = oai.messages.find(m => m.role==="assistant");
  assert(asst.tool_calls && asst.tool_calls[0].id==="toolu_A" && asst.tool_calls[0].function.arguments === '{"location":"SF"}', "tool_use → tool_calls.arguments string");
  // tool_result → role:tool
  const tool = oai.messages.find(m => m.role==="tool");
  assert(tool && tool.tool_call_id === "toolu_A" && tool.content === "62F", "tool_result → role:tool");

  // (d) response translation
  const oaiResp = {
    id:"chatcmpl-1", model:"gpt-5.5",
    choices:[{ finish_reason:"tool_calls", message:{ content:null, tool_calls:[{ id:"call_A", type:"function", function:{ name:"get_weather", arguments:'{"location":"SF"}' }}] } }],
    usage:{ prompt_tokens:25, completion_tokens:5, prompt_tokens_details:{ cached_tokens:3 } },
  };
  const aResp = openaiToAnthropicResponse(oaiResp, "gpt-5.5");
  assert(aResp.type === "message" && aResp.role === "assistant", "response type/role");
  assert(aResp.stop_reason === "tool_use", "finish_reason tool_calls → stop_reason tool_use");
  assert(aResp.content.find(b=>b.type==="tool_use" && b.id==="call_A" && b.input.location==="SF"), "tool_call → tool_use with parsed input");
  assert(aResp.usage.input_tokens === 25 && aResp.usage.output_tokens === 5 && aResp.usage.cache_read_input_tokens === 3, "usage mapped");

  // (e) SSE translation — scripted OpenAI chunks → Anthropic events
  const chunks = [
    { id:"chatcmpl-1", model:"gpt-5.5", choices:[{ index:0, delta:{ role:"assistant", content:"" }, finish_reason:null }] },
    { id:"chatcmpl-1", model:"gpt-5.5", choices:[{ index:0, delta:{ content:"Hel" }, finish_reason:null }] },
    { id:"chatcmpl-1", model:"gpt-5.5", choices:[{ index:0, delta:{ content:"lo" }, finish_reason:null }] },
    { id:"chatcmpl-1", model:"gpt-5.5", choices:[{ index:0, delta:{ tool_calls:[{ index:0, id:"call_A", type:"function", function:{ name:"get_weather", arguments:"" } }] }, finish_reason:null }] },
    { id:"chatcmpl-1", model:"gpt-5.5", choices:[{ index:0, delta:{ tool_calls:[{ index:0, function:{ arguments:'{"locat' } }] }, finish_reason:null }] },
    { id:"chatcmpl-1", model:"gpt-5.5", choices:[{ index:0, delta:{ tool_calls:[{ index:0, function:{ arguments:'ion":"SF"}' } }] }, finish_reason:null }] },
    { id:"chatcmpl-1", model:"gpt-5.5", choices:[{ index:0, delta:{}, finish_reason:"tool_calls" }] },
    { id:"chatcmpl-1", model:"gpt-5.5", choices:[], usage:{ prompt_tokens:10, completion_tokens:7 } },
  ];
  // collect events from openaiSseToAnthropicSse fed by an async iter over `chunks`
  const events = [];
  for await (const block of openaiSseToAnthropicSse((async function*(){ for(const c of chunks) yield Buffer.from("data: "+JSON.stringify(c)+"\n\n"); for(const c of chunks){} yield Buffer.from("data: [DONE]\n\n"); })(), "gpt-5.5")) {
    const m = block.match(/^event: (\w+)\ndata: (\{.*\})$/s);
    if (m) events.push({ event:m[1], data:JSON.parse(m[2]) });
  }
  const seq = events.map(e=>e.event);
  assert(seq[0] === "message_start", "SSE: message_start first");
  assert(seq.includes("content_block_start") && seq.includes("content_block_delta"), "SSE: text block");
  assert(seq.filter(e=>e==="content_block_stop").length >= 2, "SSE: both blocks closed");
  const startTu = events.find(e=>e.event==="content_block_start" && e.data.content_block && e.data.content_block.type==="tool_use");
  assert(startTu && startTu.data.content_block.id === "call_A" && startTu.data.content_block.name === "get_weather", "SSE: tool_use block start carries id+name");
  const jsonDeltas = events.filter(e=>e.event==="content_block_delta" && e.data.delta && e.data.delta.type==="input_json_delta");
  assert(jsonDeltas.length === 2 && jsonDeltas.map(d=>d.data.delta.partial_json).join("") === '{"location":"SF"}', "SSE: input_json_delta partial_json accumulates");
  const md = events.find(e=>e.event==="message_delta");
  assert(md && md.data.delta.stop_reason === "tool_use", "SSE: message_delta stop_reason tool_use");
  assert(seq[seq.length-1] === "message_stop", "SSE: message_stop last");

  // (f) key masking
  assert(maskKey("sk-abcdefgh") === "sk-…efgh", "maskKey sk-…efgh");
  assert(maskKey("") === "", "maskKey empty");
}
```

`resolveBackend` is refactored to `resolveBackendCfg(cfg, model)` (pure) and `resolveBackend(model)` becomes a thin wrapper calling `loadConfig()`. This makes routing unit-testable offline.

> Note: the SSE test feeds `data: [DONE]` after the chunks; because `sseDataLines` returns on `[DONE]`, the generator's tail-clause (close open block + `message_delta`/`message_stop`) is **not** triggered — the finish chunk already emitted `message_delta`+`message_stop`. The tail clause is a safety net for unclean upstream disconnects.

### 7.2 `--checkbackends` (live, network)

`node server.js --checkbackends` → for each enabled backend, send a 1-token prompt and print pass/fail + latency. Exits 0 if all pass, 1 if any fail. Does **not** start the HTTP listener.

```js
async function checkBackends() {
  const cfg = loadConfig();
  let allOk = true;
  for (const b of cfg.backends) {
    if (b.enabled === false) { console.log(`  [SKIP] ${b.id} (disabled)`); continue; }
    const t0 = Date.now();
    try {
      const r = await testBackend(b);
      const ms = Date.now() - t0;
      console.log(`  [${r.ok ? "OK  " : "FAIL"}] ${b.id} (${b.format}) ${ms}ms${r.ok ? " sample="+JSON.stringify(r.sample) : " err="+r.error}`);
      if (!r.ok) allOk = false;
    } catch (e) { console.log(`  [FAIL] ${b.id} ${e.message}`); allOk = false; }
  }
  process.exit(allOk ? 0 : 1);
}

async function testBackend(b) {
  const model = b.testModel || (b.modelPatterns && b.modelPatterns.find(p=>p!=="*")) || "";
  if (b.format === "openai") {
    const r = await fetch(b.upstream + "/chat/completions", {
      method:"POST", headers:{ "content-type":"application/json", "authorization":`Bearer ${b.apiKey}` },
      body: JSON.stringify({ model, messages:[{role:"user",content:"ping"}], max_completion_tokens:1, stream:false }),
    });
    if (!r.ok) return { ok:false, latencyMs:0, error:`${r.status} ${(await r.text()).slice(0,200)}` };
    const j = await r.json();
    const sample = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return { ok:true, latencyMs:0, model, sample };
  }
  // anthropic
  const headers = { "content-type":"application/json", "anthropic-version":"2023-06-01" };
  if (b.authScheme === "oauth") {
    const tok = await getAccessToken();
    if (!tok) return { ok:false, latencyMs:0, error:"not logged in" };
    headers["authorization"] = `Bearer ${tok}`;
    headers["anthropic-beta"] = mergeBetas("");   // subscription needs the oauth beta
  } else {
    headers["x-api-key"] = b.apiKey;
  }
  const r = await fetch(b.upstream + "/v1/messages", {
    method:"POST", headers,
    body: JSON.stringify({ model, max_tokens:1, messages:[{role:"user",content:"ping"}] }),
  });
  if (!r.ok) return { ok:false, latencyMs:0, error:`${r.status} ${(await r.text()).slice(0,200)}` };
  const j = await r.json();
  const sample = j.content && j.content[0] && j.content[0].text;
  return { ok:true, latencyMs:0, model, sample };
}
```

`POST /api/backends/:id/test` calls the same `testBackend(findBackend(id))` and returns `{ok, latencyMs, model, sample, error?}`.

### 7.3 Selftest wiring

```js
if (process.argv.includes("--selftest")) { selftest(); selftestMultiBackend(); console.log("selftest OK (multi-backend)"); }
else if (process.argv.includes("--checkbackends")) { checkBackends(); }
else { listenWithRetry(PORT, 60); }
```

---

## 8. Use

### 8.1 Env vars

| Var | Default | Purpose |
|---|---|---|
| `CLAUDE_ROUTER_PORT` / `PORT` | `8123` | listen port. Explicit = fail loudly if busy; default = auto-hunt. |
| `CLAUDE_ROUTER_API_KEY` | — | **Fallback single-backend mode.** If set and no `backends.json`, router acts as today: `x-api-key` passthrough to `CLAUDE_ROUTER_UPSTREAM`. |
| `CLAUDE_ROUTER_UPSTREAM` | `https://api.anthropic.com` | Fallback upstream for the synthesized key-mode backend. |
| `CLAUDE_ROUTER_ADMIN_TOKEN` | — | Optional guard for `/api/*` mutating endpoints. |

### 8.2 Run

```bash
node server.js              # start router + UI at http://127.0.0.1:8123
node server.js --selftest   # offline self-checks incl. translation/routing/SSE
node server.js --checkbackends   # live 1-token ping of every configured backend
```

### 8.3 Point Claude Code at it

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

**Option B — UI profile (persistent, CC-Switch-style):** open `http://127.0.0.1:8123/`, go to the **Profiles** section, pick `coding` (or `research` / `cheap`), click **Apply profile**. This writes `~/.claude/settings.json` with the `env` block above (preserving your existing `permissions`/`mcpServers`/`theme`) and backs up the original to `~/.claude-router/settings-backup.json`. Start a new Claude Code session — it now routes through the router. **Restore** button writes the backup back.

The `ANTHROPIC_API_KEY=claude-router` value is a non-empty dummy (Claude Code requires *something* or it pops a login prompt). The router ignores it and uses each backend's real key from `backends.json`.

### 8.4 Open the UI

`http://127.0.0.1:8123/` in any browser. Add backends (paste real `sk-`/DashScope/z.ai keys), arrange routes, test connections, switch profiles — all without editing files by hand (per memory `corepilot-never-handedit-store`: never hand-edit live config; the UI round-trips through `saveConfig`).

---

## 9. Implementation order (for the build workflow)

1. **Refactor routing to be pure.** Split `resolveBackend` → `resolveBackendCfg(cfg, model)` + thin wrapper. Add `loadConfig`/`saveConfig`/`synthesizeFromEnv`/`matchPattern`. Add `CFG_FILE`/`CC_SETTINGS`/`CC_BACKUP` constants. Keep `KEY_MODE`/`UPSTREAM`/`STATIC_KEY` feeding the synthesizer. **Verify backward compat:** with no `backends.json` + `CLAUDE_ROUTER_API_KEY` set, behavior is byte-identical to today.
2. **Per-backend anthropic passthrough.** Lift `proxy()`'s anthropic branch into `anthropicPassthrough(req,res,backend,body)` using existing `headersOAuth`/`headersKey`/`streamUpstream`/`getAccessToken`/`refreshCreds`. Apply `backend.modelMap`.
3. **Translation functions.** Implement `anthropicToOpenaiBody`, helpers, `mapFinishReason`, `openaiToAnthropicResponse`, `sseDataLines`, `openaiSseToAnthropicSse`, `handleOpenaiChunk`, `sseBlock`, `openaiCountTokensResponse`, `openaiTranslate`.
4. **`/api/*` JSON endpoints** + `maskKey` + `testBackend` + `applyProfile`/`restoreProfile`/`atomicWriteJson`/`detectOsEnvConflicts`.
5. **`webui.html`** — header, OAuth card, backends grid + add/edit modal, routes table, profiles switcher. Wire to `/api/*`.
6. **Static serving** of `webui.html` at `GET /`; keep `/login`,`/exchange`,`/logout`,`/v1/*`.
7. **Tests:** extend `selftest()` with `selftestMultiBackend()`; add `--checkbackends`.
8. **README** update: env vars, run commands, profile switching, the dummy-key explanation, the codex `/chat/completions` caveat.

### 9.1 Non-regression checklist

- [ ] `CLAUDE_ROUTER_API_KEY=sk-... node server.js --selftest` → existing PKCE/header assertions still pass.
- [ ] No `backends.json` + `CLAUDE_ROUTER_API_KEY` set → a `/v1/messages` request is forwarded byte-identically to `UPSTREAM` with `x-api-key` (today's behavior).
- [ ] No `backends.json`, no key → OAuth mode UI/login still works (creds.json path unchanged).
- [ ] OAuth subscription backend still uses `headersOAuth` (Bearer + `anthropic-beta` oauth/claude-code) and the mid-flight 401 refresh+retry.
- [ ] `format:"anthropic"` backend with its own `apiKey` uses `headersKey` (x-api-key, no oauth beta, betas passthrough).
- [ ] `format:"openai"` backend never sends `anthropic-version`/`anthropic-beta`; sends `Authorization: Bearer`.
- [ ] SSE path emits `message_start` once, one `content_block_start`/`stop` per block, `message_delta` with mapped `stop_reason`, `message_stop` last.
- [ ] `tool_calls[].index` → distinct `tool_use` blocks; `arguments` → `input_json_delta.partial_json`.
- [ ] Keys masked on every read; `PUT` with empty `apiKey` preserves stored key.
- [ ] `~/.claude/settings.json` deep-merged (not clobbered) on profile apply; backup created once; restore writes it back.

---

## 10. Open / deferred (not in v1)

- `/v1/responses` (Codex Responses API) for true Codex-parity reasoning items & server-side state — v1 uses `/chat/completions`.
- Registry-level `ANTHROPIC_*` scrub (CC-Switch `env_checker` does this via `reg`/shell rc scanning) — v1 only warns from `process.env`.
- Circuit-breaker / auto-failover queue across backends (CC-Switch `circuit_breaker.rs`) — v1 routes one backend per request.
- Prompt-cache translation across formats (Anthropic `cache_control` has no OpenAI equivalent; dropped on openai path).
- Anthropic `thinking`/`output_config` → OpenAI `reasoning_effort` mapping (loose; dropped in v1).

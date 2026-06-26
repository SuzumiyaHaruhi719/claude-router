# claude-router — Fusion / Virtual Model (condition-based routing)

**Status:** Draft 2026-06-26. Implement via Opus spec → Sonnet impl → Opus+Fable audit.
**Target codebase:** `C:/Users/Thomas/Documents/Projects/claude-router` — single-file `server.js` + `webui.html`, zero deps, Node ≥ 18.
**Goal:** Let a user define a **virtual model** — a model name the client (Claude Code) can request as if it were a real model — that resolves, per-request, to one of several backend/model targets based on **conditions evaluated against the request body** (has image → vision backend; web-search flag/keywords → search backend; long context → long-context backend; default → primary).

---

## 0. What we are and are NOT building (read this first)

CCR's "fusion / 组合 / virtual model" runs an **agentic tool loop**: the base model owns the answer and calls a *hidden* internal tool (`vision_understand` / `web_search`) served by a bundled stdio MCP server; the tool fans the image/query out to a specialist backend, returns text, and the base model folds it into its answer. That is a **multi-turn runtime** with an MCP subprocess.

Our router is a **stateless translation proxy**: one client request → one upstream request → one response (passthrough or Anthropic↔OpenAI translation). It has no conversation loop, no MCP host, no place to run N internal turns. Re-creating CCR's tool loop here would mean inventing a whole agent runtime inside a translation proxy — wrong altitude, large regression surface, breaks the "one file, zero deps" contract.

**So we adapt the IDEA, not the mechanism.** A "virtual model" in OUR router is a configured model **name** whose **routing target is chosen per request** by evaluating ordered conditions against the request body. The base model still owns the full answer; we simply pick *which* backend/model serves that single turn based on request shape. This mirrors CCR's *Router-rule layer* (the `image` / `web-search` request-shape detection that rewrites the model **before** inference — research `claude-code-router-plugin.ts:185-191`), **not** CCR's *Fusion tool-loop layer*.

Concretely:
- **Build:** virtual model = name + ordered `[condition → target]` rules + a default target. Evaluated in `proxy()` after parsing the body, before backend dispatch. A matched rule rewrites `body.model` to the target model and routes to the target backend, then the existing passthrough/translate path runs unchanged.
- **Do NOT build:** internal hidden tools, an MCP server, a `tool_loop`/`maxTurns` executor, parallel image-to-A + text-to-B stitching, or any second upstream call per request. One request still makes exactly one upstream call.

This is deliberately a routing feature, not an orchestration feature. If true multi-model orchestration is wanted later, it is a separate spec with its own loop runtime; this spec explicitly defers it (see §2).

---

## 1. Goals

1. Define **virtual models** in `backends.json` under a new top-level `virtualModels[]` array. One entry = one virtual model name.
2. Each virtual model has **ordered rules**: `condition → { backendId, model }`, plus a required `default` target. First matching rule wins; else default.
3. Conditions cover the request shapes called out in the ask:
   - `hasImage` — any `image` content block in `messages`.
   - `webSearch` — request advertises a web-search tool, OR (optional) body text matches configured keywords.
   - `longContext` — estimated input tokens > a configured threshold.
   - `default` — implicit fallback (the `default` target).
   - `always` — unconditional (lets a virtual model be a pure alias / decorator).
4. Resolve virtual models in `proxy()` **before** backend dispatch, reusing `resolveBackendCfg` for the chosen target model and the existing translate/passthrough paths unchanged.
5. **Optional + non-regressive:** with no `virtualModels` defined (the default for every existing install), behavior is byte-identical to today. The feature is purely additive.
6. WebUI: a **Virtual Models** section to define a virtual model, add/reorder/delete rules, pick condition + target backend+model per rule, set the default target, and preview resolution.
7. REST API: `/api/virtual-models` CRUD mirroring the existing `/api/backends` + `/api/routes` style (admin-token guarded for writes).
8. Offline self-tests for condition evaluation + resolution precedence + non-regression, wired into `--selftest`.
9. Stay zero-dep, single-file `server.js` + single-file `webui.html`.

---

## 2. Non-goals

- **No agentic tool loop.** No `execution.mode=tool_loop`, no `maxTurns`/`maxToolCalls`, no internal hidden tools, no per-request second upstream call.
- **No bundled MCP server**, no `child_process` spawn for inference, no `fusion-vision-mcp.js` equivalent.
- **No response fusion / stitching.** We never merge two model responses. Exactly one backend produces the answer per request.
- **No dedicated vision/search HTTP clients.** A "vision backend" or "search backend" is just an existing configured backend (any `anthropic`/`openai`/`openai-responses` backend); the user wires it like any other backend.
- **No new external network dependency.** Web-search detection keys off the request's *own* declared tools / flag, not a search-provider API. (Calling Brave/Tavily/etc. would require the tool-loop runtime we are explicitly not building.)
- **No change to token-counting semantics for billing.** `longContext` uses a cheap local estimate, never an upstream `count_tokens` call.
- **No tokenizer dependency.** Token estimate is a char/word heuristic (see §5.3).

---

## 3. Config schema

### 3.1 Placement

New top-level key in `~/.claude-router/backends.json`, alongside `backends` / `routes` / `profiles` / `activeProfile`:

```jsonc
{
  "backends": [ /* unchanged */ ],
  "routes":   [ /* unchanged */ ],
  "profiles": { /* unchanged */ },
  "activeProfile": null,
  "virtualModels": [
    {
      "id": "fusion-smart",
      "name": "Fusion (smart routing)",
      "enabled": true,
      "match": ["fusion-smart"],
      "rules": [
        { "when": "hasImage",     "backendId": "claude",  "model": "claude-opus-4-8" },
        { "when": "webSearch",    "backendId": "glm",     "model": "glm-5.2" },
        { "when": "longContext",  "backendId": "gemini",  "model": "gemini-2.5-pro", "thresholdTokens": 200000 },
        { "when": "keyword",      "backendId": "glm",     "model": "glm-5.2", "keywords": ["latest", "today", "current", "news"] }
      ],
      "default": { "backendId": "codex", "model": "gpt-5.5" }
    }
  ]
}
```

### 3.2 `VirtualModel` shape (after normalization)

| field | type | required | notes |
|---|---|---|---|
| `id` | string | yes | matches `ID_RE` (`^[a-z0-9][a-z0-9-]{0,31}$`), unique among virtual models AND must NOT collide with any `backends[].id` (keeps `head` namespaces clean and avoids resolver ambiguity). |
| `name` | string | no | display label; defaults to `id`. |
| `enabled` | bool | no | default `true`. Disabled → treated as if it does not exist (request falls through to normal routing). |
| `match` | string[] | no | model-name aliases the client may request, matched case-insensitively against `body.model` using the **existing** `matchPattern` glob (so `fusion-*` works). Defaults to `[id]`. Empty after normalization → defaults to `[id]`. |
| `rules` | Rule[] | no | ordered; first match wins. May be empty (then only `default` applies). |
| `default` | Target | yes | the fallback target when no rule matches. Required — a virtual model with no resolvable target is invalid and dropped at normalize time. |

`Rule`:

| field | type | required | notes |
|---|---|---|---|
| `when` | enum | yes | one of `hasImage` \| `webSearch` \| `longContext` \| `keyword` \| `always`. Unknown → rule dropped. |
| `backendId` | string | yes | must reference an existing backend id (validated at API-write time; at resolve time a dangling id makes the rule a no-op and we continue to the next rule). |
| `model` | string | yes | the model name sent upstream (becomes `body.model`, then subject to that backend's `modelMap`). |
| `thresholdTokens` | int | only `longContext` | default `200000`; clamped `[1, 10_000_000]`. |
| `keywords` | string[] | only `keyword` | lowercased; matched as substrings against the concatenated user-text of the request. Empty → rule dropped. |

`Target` (`default` and the resolved output of a rule):

| field | type | required |
|---|---|---|
| `backendId` | string | yes |
| `model` | string | yes |

### 3.3 Normalization (`normalizeVirtualModel`, `normalizeVirtualModels`)

Mirror `normalizeBackend` / `normalizeRouteOverrides` discipline so downstream code can trust the shape:

- Coerce/validate `id` (`ID_RE`); drop the entry if `id` is empty or invalid.
- `enabled = b.enabled !== false`.
- `match`: array of non-empty strings; if empty after filtering → `[id]`.
- `rules`: map each; drop a rule if `when` is not in the enum, or `backendId`/`model` is empty, or (`when==="keyword"` and no keywords) or (a required field is missing). For `longContext`, `thresholdTokens = clampInt(r.thresholdTokens, 200000, 1, 10_000_000)`. Lowercase keyword list.
- `default`: `{ backendId: String(...), model: String(...) }`; **drop the whole virtual model** if either is empty (a VM must always be resolvable).
- Return a frozen plain object with exactly: `{ id, name, enabled, match, rules, default }`.

`loadConfig` adds:
```js
cfg.virtualModels = Array.isArray(cfg.virtualModels)
  ? cfg.virtualModels.map(normalizeVirtualModel).filter(Boolean)
  : [];
```
`synthesizeFromEnv()` returns `virtualModels: []` for both KEY_MODE and OAuth branches (keeps the no-config path identical to today).

### 3.4 Why these conditions (and not CCR's `match` block)

CCR's profile carries a rich `match`/`execution`/`materialization` block because it feeds a separate core engine that runs a loop. We collapse all of that to *request-shape predicates → routing target*, because a routing decision is all a stateless proxy can act on. The four conditions map 1:1 to the ask and to CCR's Router-rule layer (`image`, `web-search`, `long-context`, default).

---

## 4. Resolution: where it plugs into `proxy()`

### 4.1 Current flow (unchanged shape)

```js
async function proxy(req, res) {
  const raw = await readBody(req);
  let body = ...JSON.parse(raw)...;
  const model = body && body.model;
  const backend = resolveBackend(model);            // <-- resolveBackendCfg(loadConfig(), model)
  ... requestLog.start ...
  if (!backend) return 502;
  if (backend.format === "openai") return openaiTranslate(...);
  if (backend.format === "openai-responses") return openaiResponsesTranslate(...);
  return anthropicPassthrough(...);
}
```

### 4.2 New flow

Insert virtual-model resolution **between body parse and `resolveBackend`**. Load config **once** and thread it through (avoid the double `loadConfig()` that `resolveBackend` would do).

```js
async function proxy(req, res) {
  const raw = await readBody(req);
  req._rawBody = raw;
  let body = null;
  if (raw.length) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; } }
  req._body = body;

  const cfg = loadConfig();                          // single load for this request
  const requestedModel = body && body.model;

  // --- NEW: virtual-model resolution (no-op when none defined) ---
  const vm = resolveVirtualModel(cfg, requestedModel);   // null when not a VM or none defined
  let routeModel = requestedModel;
  if (vm) {
    const target = evaluateVirtualModel(vm, body, cfg);   // {backendId, model, matchedRule}
    routeModel = target.model;                            // route + send-as this model
    if (body) { body = { ...body, model: target.model }; req._body = body; req._rawBody = Buffer.from(JSON.stringify(body)); }
    req._virtualModel = { id: vm.id, requested: requestedModel, target, rule: target.matchedRule };
  }

  const backend = vm
    ? (cfg.backends.find((b) => b.id === vm._resolvedTarget.backendId && b.enabled !== false) || resolveBackendCfg(cfg, routeModel))
    : resolveBackendCfg(cfg, routeModel);
  // ... rest unchanged: requestLog.start, !backend → 502, dispatch by backend.format ...
}
```

Implementation detail: have `evaluateVirtualModel` stash the chosen `{backendId, model}` so backend lookup is direct. If the chosen `backendId` is dangling/disabled, **fall back to glob-routing the chosen model** via `resolveBackendCfg(cfg, routeModel)` (graceful degradation, never a hard 502 caused by a stale config). The existing `!backend → 502` still guards the truly-empty case.

### 4.3 Rewriting the body

When a virtual model resolves, the client requested `model:"fusion-smart"`, which is **not** a real upstream model. We MUST rewrite `body.model` to `target.model` and regenerate `req._rawBody`, because:
- `anthropicPassthrough` sends `req._rawBody` verbatim for non-OAuth and uses `body.model`/`modelMap` for OAuth and modelMap rewrites.
- the translate paths read `body.model`.

This is the same rewrite the existing OAuth/modelMap branch already does (`server.js:2185-2188`) — we set `body.model` and rebuild the buffer once, up front, so every downstream path sees a real model name. The target model is then *still* subject to the chosen backend's `modelMap` (e.g. an alias → upstream id), exactly like a normal request, so no special-casing downstream.

### 4.4 Precedence vs. existing routes

Virtual models are checked **first** (a VM name is a client-facing alias, like the Mapper's tier names). If `body.model` does not match any enabled VM's `match`, resolution returns `null` and the request goes through the **unchanged** `resolveBackendCfg` path. Therefore:
- Existing routes/backends/modelPatterns behavior is untouched for every non-VM model name.
- A VM name and a real route should not collide; §3.2 forbids VM `id` == backend `id`, and a VM `match` that shadows a real model is the user's explicit choice (documented in the WebUI hint).

### 4.5 Logging

Extend the request log (reuse `requestLog`, no schema break — additive fields): when `req._virtualModel` is set, record `virtualModelId`, `virtualRequestedModel`, `virtualMatchedRule` (the `when`), and the resolved `backendId`+`model` (already captured as `upstreamModel`). The WebUI request pool can show "via fusion-smart (hasImage)". All additive; absent on normal requests.

---

## 5. Condition evaluation (`evaluateVirtualModel`, pure)

Signature: `evaluateVirtualModel(vm, body, cfg) → { backendId, model, matchedRule }`. Pure and synchronous; depends only on its args. Iterate `vm.rules` in order; first predicate that returns true wins; else `vm.default` with `matchedRule = "default"`.

```js
function evaluateVirtualModel(vm, body, cfg) {
  for (const rule of vm.rules) {
    if (ruleMatches(rule, body)) {
      const t = { backendId: rule.backendId, model: rule.model, matchedRule: rule.when };
      vm._resolvedTarget = t; return t;
    }
  }
  const t = { backendId: vm.default.backendId, model: vm.default.model, matchedRule: "default" };
  vm._resolvedTarget = t; return t;
}
```

> Note: `vm._resolvedTarget` is set on the per-request normalized copy. Since `loadConfig()` re-parses from disk each request, there is no cross-request mutation risk; but to be safe, `resolveVirtualModel` returns a shallow clone of the matched VM so the `_resolvedTarget` scratch field never touches a shared object.

### 5.1 `hasImage`

True if any message contains an Anthropic `image` content block:
```js
function bodyHasImage(body) {
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    const c = m && m.content;
    if (Array.isArray(c) && c.some((b) => b && b.type === "image")) return true;
  }
  return false;
}
```
Anthropic image blocks are `{type:"image", source:{...}}` (confirmed by `imageUrlFromAnthropic` / translate `server.js:1408-1410`). We do not inspect OpenAI-style `image_url` parts because the client (Claude Code) speaks Anthropic Messages to us.

### 5.2 `webSearch`

True if the request **declares** a web-search capability. Two sub-signals (OR):
1. **Tool advertised** — any `body.tools[].name` matches a web-search tool name (case-insensitive substring of `web_search`, OR Anthropic's server-tool type `web_search_*`):
   ```js
   function bodyHasWebSearchTool(body) {
     const tools = body && Array.isArray(body.tools) ? body.tools : [];
     return tools.some((t) => {
       const n = String((t && (t.name || t.type)) || "").toLowerCase();
       return n.includes("web_search") || n.includes("websearch");
     });
   }
   ```
   (Mirrors CCR's `hasWebSearchTool(tools)` Router-rule signal, research `claude-code-router-plugin.ts:185-187`.)
2. **Explicit flag** — `body.metadata && body.metadata.web_search === true` (a caller-set hint; harmless if absent).

`keyword` (§5.4) is the text-content signal and is a **separate** `when` so users opt in deliberately (keyword routing on arbitrary prose is noisy; keep it off the `webSearch` predicate).

### 5.3 `longContext`

True if the estimated input token count exceeds `rule.thresholdTokens`. Estimate locally, no upstream call, no tokenizer dep:
```js
function estimateInputTokens(body) {
  // Cheap, deterministic heuristic: ~4 chars/token over all text we can see.
  let chars = 0;
  const add = (s) => { if (typeof s === "string") chars += s.length; };
  if (typeof body.system === "string") add(body.system);
  else if (Array.isArray(body.system)) for (const b of body.system) if (b && b.type === "text") add(b.text);
  for (const m of (Array.isArray(body.messages) ? body.messages : [])) {
    const c = m && m.content;
    if (typeof c === "string") add(c);
    else if (Array.isArray(c)) for (const b of c) {
      if (!b) continue;
      if (b.type === "text") add(b.text);
      else if (b.type === "tool_result") add(typeof b.content === "string" ? b.content : JSON.stringify(b.content || ""));
      else if (b.type === "tool_use") add(JSON.stringify(b.input || {}));
      else if (b.type === "image") chars += 1600; // ~ one image ≈ a few hundred tokens; coarse constant
    }
  }
  if (Array.isArray(body.tools)) chars += JSON.stringify(body.tools).length;
  return Math.ceil(chars / 4);
}
```
The estimate is intentionally rough — it only needs to be monotonic and stable for the threshold decision, not accurate for billing (see §2). Document the `/4` heuristic in a code comment.

### 5.4 `keyword`

True if the lowercased concatenation of user-visible text contains any of `rule.keywords` (substring match):
```js
function bodyText(body) { /* same text-walk as estimateInputTokens but returns the joined string, user+system text only */ }
function ruleKeywordMatch(rule, body) {
  const hay = bodyText(body).toLowerCase();
  return rule.keywords.some((k) => k && hay.includes(k));
}
```

### 5.5 `always`

Always true. Lets a virtual model be a deterministic alias (e.g. `fusion-fast` → always codex `gpt-5.5-instant`) or a single-condition decorator. A rule list of just `[{when:"always",...}]` is equivalent to a hard alias.

### 5.6 `ruleMatches` dispatcher

```js
function ruleMatches(rule, body) {
  switch (rule.when) {
    case "hasImage":    return bodyHasImage(body);
    case "webSearch":   return bodyHasWebSearchTool(body) || !!(body && body.metadata && body.metadata.web_search === true);
    case "longContext": return estimateInputTokens(body) > rule.thresholdTokens;
    case "keyword":     return ruleKeywordMatch(rule, body);
    case "always":      return true;
    default:            return false;
  }
}
```
All predicates tolerate `body === null` (non-JSON passthrough): every walk guards `Array.isArray`, so they return `false`/`0` and the request falls to `default`. A non-JSON body that hits a VM name is vanishingly unlikely, but it degrades to the default target rather than throwing.

### 5.7 `resolveVirtualModel`

```js
function resolveVirtualModel(cfg, model) {
  const vms = Array.isArray(cfg.virtualModels) ? cfg.virtualModels : [];
  if (!vms.length || !model) return null;
  const m = String(model).toLowerCase();
  for (const vm of vms) {
    if (vm.enabled === false) continue;
    if ((vm.match || []).some((p) => matchPattern(m, p))) return { ...vm, rules: vm.rules.map((r) => ({ ...r })), default: { ...vm.default } };
  }
  return null;
}
```
Reuses the existing `matchPattern` glob. First enabled VM whose `match` hits wins.

---

## 6. REST API

New `head === "virtual-models"` dispatch block, mirroring `routes`/`backends` (writes guarded by `isAdminOk`):

| Method | Path | Body | Returns | Guard |
|---|---|---|---|---|
| GET | `/api/virtual-models` | — | `loadConfig().virtualModels` (no secrets to mask — VMs hold no keys) | none |
| POST | `/api/virtual-models` | `VirtualModel` (without `id` or with) | created VM (normalized) | admin |
| PUT | `/api/virtual-models/:id` | partial `VirtualModel` | updated VM | admin |
| DELETE | `/api/virtual-models/:id` | — | remaining `virtualModels[]` | admin |

Handlers (`apiCreateVirtualModel` / `apiUpdateVirtualModel` / `apiDeleteVirtualModel`):
- `apiCreate`: assign `id` if absent (`vm-<n>` or slug of `name`), reject if `id` collides with an existing VM id or any `backendId`, reject if `id` fails `ID_RE`. Validate every rule's `backendId` and `default.backendId` reference an existing backend; reject (`400`) on dangling id at write time (resolve-time fallback in §4.2 is only for configs that go stale *after* a backend is later deleted).
- `apiUpdate`: load, find by id, deep-merge the allowed fields (`name`, `enabled`, `match`, `rules`, `default`), re-normalize, save. Reject if not found.
- `apiDelete`: splice by id, save.
- All write handlers `saveConfig(cfg)` and return the normalized result, exactly like `apiCreateRoute`.

Error envelope matches existing handlers: `{ error: { type: "api_error" | "not_found" | "conflict", message } }` with the matching status.

Optional read-only helper for the WebUI preview (no disk write):
- POST `/api/virtual-models/:id/preview` with `{ body }` (a sample Anthropic Messages body) → `{ matchedRule, backendId, model }` by running `evaluateVirtualModel`. Lets the UI show "this sample image request → claude / claude-opus-4-8". Pure; admin not required (read-only, local).

---

## 7. WebUI

### 7.1 New section

Add a `<section class="section" aria-labelledby="virtualModelsTitle">` after **Routes** (Virtual Models sit conceptually above raw routes — they are the high-level entry, routes the low-level table). Register `renderVirtualModels()` in `renderAll()` and load `state.virtualModels` in the existing fetch fan-out.

### 7.2 Layout

- Header: `Virtual Models` + a short hint: *"A virtual model is a name Claude Code can request that routes per-request by condition. No fusion tool-loop — one backend answers each turn."*
- List of defined virtual models (cards), each showing: name, `match` aliases, ordered rule chips (`hasImage → claude/claude-opus-4-8`, …), and the default target. Each card: **Edit**, **Delete**, **Enable/Disable** toggle.
- **Add Virtual Model** button → modal.

### 7.3 Editor modal

- **Name** (text), **enabled** (checkbox), **match aliases** (comma/newline list, defaults to a slug of name).
- **Rules** — an ordered, reorderable list (reuse the ↑/↓ + delete pattern from the Routes table, `reorderRoutes` in webui.html). Each rule row:
  - `when` `<select>`: `hasImage | webSearch | longContext | keyword | always`.
  - `backendId` `<select>` populated from `enabledBackends()`.
  - `model` `<input>` (with optional datalist from `/api/mapper/.../models` results already used by the Mapper).
  - conditional inputs: `thresholdTokens` (number) shown only for `longContext`; `keywords` (text) shown only for `keyword`.
- **Default target**: `backendId` `<select>` + `model` `<input>` (required; Save disabled until both set).
- **Live preview** panel: a small textarea where the user pastes/edits a sample request (prefilled with a tiny image example + a tiny text example toggle), calling `/api/virtual-models/:id/preview` (or a client-side mirror of `ruleMatches` for unsaved drafts) to show which rule fires → which backend/model. Mirrors the Mapper's "Routes preview" pane (`webui.html:971-972`).
- Save → POST/PUT; on success re-render and toast, matching existing patterns.

### 7.4 Stats

Add a stats tile: `Virtual Models: <n>` next to the existing Backends/Routes tiles (`renderStats`, `webui.html:1455-1460`).

### 7.5 No regression to existing sections

Virtual Models is a new sibling section; Mapper, Backends, Routes, Profiles, Request Pool, Accounts render exactly as before. The Mapper still writes raw `routes`; a user can use Mapper OR Virtual Models OR both (VMs resolve first, then fall through to Mapper-written routes).

---

## 8. Tests (`--selftest`, offline, zero network)

New `selftestVirtualModels()` added to the async IIFE in the `--selftest` branch (`server.js:4216-4223`) and to the final "selftest OK" line.

### 8.1 Normalization
- Valid VM round-trips with all fields; `match` defaults to `[id]` when omitted; bad `id` → dropped; missing `default` → whole VM dropped.
- Rule with unknown `when` dropped; `keyword` rule with empty keywords dropped; `longContext` `thresholdTokens` clamped.

### 8.2 Condition predicates
- `bodyHasImage`: true for a message with an `image` block; false for text-only; false for `body=null`.
- `bodyHasWebSearchTool`: true when `tools` has `{name:"web_search"}` or `{type:"web_search_20250305"}`; false otherwise; metadata flag path true.
- `estimateInputTokens`: monotonic — a long system prompt pushes over a 100-token threshold; image adds the constant; `body=null` → 0.
- `ruleKeywordMatch`: hits substring case-insensitively; misses cleanly.

### 8.3 Resolution precedence
- A VM with `[hasImage→A, webSearch→B, longContext→C]` + default D:
  - image body → A; web-search-tool body → B; 300k-token body → C; plain short text → D.
  - first-match wins: a body that is *both* image and long-context with `hasImage` rule first → A.
- `resolveVirtualModel`: returns null when `virtualModels` empty (non-regression anchor); returns the VM for a matching `match` glob (`fusion-*`); returns null for an unrelated model.
- Dangling `backendId` in a matched rule → `proxy` integration falls back to `resolveBackendCfg(routeModel)` (assert via a small harness calling the resolution helper, not a live request).

### 8.4 Non-regression
- `loadConfig` on a config WITHOUT `virtualModels` yields `cfg.virtualModels === []` and `resolveBackendCfg` results are identical to the existing `selftestMultiBackend` routing assertions (re-run a couple).
- `synthesizeFromEnv()` (both KEY_MODE and OAuth) includes `virtualModels: []`.
- The existing `selftest`, `selftestMapper`, `selftestMultiBackend`, `selftestCodexResponses`, `selftestRequestLog`, `selftestAccountPool` all still pass unchanged.

---

## 9. Implementation order

1. **Config layer** — add `normalizeVirtualModel` + `normalizeVirtualModels`; wire into `loadConfig` (`cfg.virtualModels = ...`); add `virtualModels: []` to both `synthesizeFromEnv()` branches. (No behavior change yet — pure additive parse.)
2. **Predicates** — `bodyHasImage`, `bodyHasWebSearchTool`, `estimateInputTokens`, `bodyText`, `ruleKeywordMatch`, `ruleMatches`. Pure functions, null-safe.
3. **Resolution** — `resolveVirtualModel(cfg, model)` + `evaluateVirtualModel(vm, body, cfg)`.
4. **proxy() integration** — single `loadConfig()` per request; insert VM resolution before backend dispatch; body+`_rawBody` rewrite; dangling-backend fallback; `req._virtualModel` for logging. Verify the non-VM path is byte-identical (same `resolveBackendCfg` call).
5. **Request log** — additive `virtualModelId`/`virtualRequestedModel`/`virtualMatchedRule` fields in `requestLog.start`/`update` when `req._virtualModel` present.
6. **REST API** — `head === "virtual-models"` block + `apiCreate/Update/Delete` + optional `/preview`. Admin-guard writes.
7. **WebUI** — section, render function, editor modal, rule reorder, preview pane, stats tile; fetch `state.virtualModels`.
8. **Self-tests** — `selftestVirtualModels()`; wire into `--selftest`; run `node server.js --selftest` until green.
9. **Docs** — short README subsection ("Virtual models: condition-based routing") + a JSON example, explicitly noting it is NOT a tool loop.

Each step compiles and passes `--selftest` before the next. Steps 1–3 are pure and independently testable; step 4 is the only one touching the hot path and gets the closest review.

---

## 10. Non-regression checklist

- [ ] With no `virtualModels` key in `backends.json`, `loadConfig().virtualModels === []` and every existing routing assertion is unchanged.
- [ ] `resolveVirtualModel` returns `null` when `virtualModels` is empty → `proxy()` calls `resolveBackendCfg` exactly as today (same arguments, same result).
- [ ] A request whose `body.model` matches no VM `match` is routed identically to today (no body rewrite, no `_rawBody` regeneration).
- [ ] OAuth subscription path: identity-injection, thinking-block sanitize, `?beta=true`, account rotation all run **after** VM resolution on the rewritten (real) model — VM never sends `fusion-smart` upstream.
- [ ] GLM plain-fetch path (`upFetch = fetch` for non-Anthropic hosts) unaffected — VM only changes which backend/model is chosen, not transport.
- [ ] Codex `openai-responses` path unaffected.
- [ ] Model Mapper still writes/reads raw `routes`; Mapper and Virtual Models coexist (VM first, routes fallback).
- [ ] `modelMap` on the chosen backend still applies to the VM-resolved model (no double-mapping, no skip).
- [ ] Request inspector log still works; new VM fields are additive and absent on normal requests.
- [ ] `--selftest` green for all existing suites + the new `selftestVirtualModels`.
- [ ] Zero new dependencies; `server.js` + `webui.html` remain the only runtime files; Node ≥ 18 builtins only.
- [ ] Exactly one upstream call per request (no second/internal call introduced).
- [ ] `body === null` (non-JSON) requests never throw in any predicate; degrade to default target or normal routing.
- [ ] Admin-token guard enforced on all VM write endpoints, matching `/api/routes` and `/api/backends`.

---

## 11. Self-review (placeholders / contradictions)

- **No TODO/placeholder targets.** All example backend ids (`claude`, `glm`, `gemini`, `codex`) are illustrative config values, not code stubs; the spec never depends on a specific backend existing.
- **Consistency: single `loadConfig()`** — §4.2 loads config once and passes `cfg` to both `resolveVirtualModel` and `resolveBackendCfg`, replacing the `resolveBackend(model)` wrapper *inside `proxy()` only*. `resolveBackend` (the disk-loading wrapper) stays for other callers (`testBackend` etc.); this is noted and is not a contradiction.
- **Consistency: body rewrite** — §4.3 reuses the exact rewrite the OAuth/modelMap branch already performs; downstream sees a real model in both `body.model` and `_rawBody`. No path reads the original `fusion-*` name after resolution except the additive log fields.
- **Scope honesty** — §0 and §2 state plainly we are NOT replicating CCR's tool loop; the rest of the spec never quietly reintroduces a loop, an MCP spawn, or a second upstream call. The single "exactly one upstream call" invariant is asserted in §10.
- **`default` always present** — normalization drops any VM lacking a resolvable `default`, so `evaluateVirtualModel` can never fall through to `undefined`.
- **No tokenizer / network for `longContext`** — §5.3 is a local heuristic; §2 forbids upstream `count_tokens`; no contradiction.
- **VM id vs backend id** — §3.2 forbids collision at write time; §4.4 explains why; resolver precedence (VM first) is stated once and used consistently.

# claude-router — Visual Model Mapper + One-Click cc-switch Import

**Status:** Design 2026-06-26; user asleep → decisions made autonomously per the unattended-run directive; hand to Codex for impl+audit.
**Target codebase:** `C:/Users/Thomas/Documents/Projects/claude-router` — single-file `server.js` + `webui.html`.
**Goal:** A beginner-friendly ("小白") visual configurator where the user picks, per Claude Code model tier (opus/sonnet/haiku/fable), which backend+model to substitute — via dropdowns only (no typing unless optional). One click exports the full mapping into cc-switch as a provider profile via the `ccswitch://` deep link.

---

## 0. Resolved facts (from exploration — do not re-litigate)

1. **CC's 4 model tiers** (confirmed from the user's `~/.claude/settings.json`): `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL` (+ `_NAME` display variants) + `ANTHROPIC_MODEL` (default) + `ANTHROPIC_REASONING_MODEL`. So the configurator maps exactly 4 tiers: **opus, sonnet, haiku, fable**. The user's example: opus→claude-opus-4-8 (Claude sub), fable→gpt-5.5-xhigh (codex), sonnet→glm-5.2 (GLM), haiku→gpt-5.5-instant (codex).
2. **Model lists are auto-fetchable for ALL three backends** (no typing needed for the common case):
   - Claude (oauth backend): `GET /v1/messages`-path `/v1/models` via the router returns the full Anthropic list with `display_name` (claude-fable-5, claude-opus-4-8, …). Verified 200.
   - Codex (codex backend): no `/v1/models` endpoint + `codex --help` has no `models` subcommand → **curated list** (verified all 200): `gpt-5.5`, `gpt-5.5-low`, `-medium`, `-high`, `-xhigh`, `-max`, `-instant`.
   - DashScope/GLM (glm backend): `GET https://dashscope.aliyuncs.com/compatible-mode/v1/models` with `Authorization: Bearer <key>` returns the full list (glm-5.2, qwen3.7-plus/max, kimi-k2.7-code, ZHIPU/GLM-5, …). Verified 200. (Original ask was "user types"; auto-fetch is strictly better for the 小白 UX, so we fetch + allow optional custom typing.)
3. **cc-switch deep link** (`ccswitch://v1/import?resource=provider&app=claude&…`, camelCase query params): carries `name`, `endpoint`, `apiKey`, `model`, `opusModel`, `sonnetModel`, `haikuModel` (first-class per-tier params!), plus `config=<base64({"env":{...}})>&configFormat=json` for arbitrary env (carries `ANTHROPIC_DEFAULT_FABLE_MODEL` since fable has no first-class param), plus `enabled=true` (auto-switch after import). It is **not zero-click**: browser "Open ccswitch?" prompt + cc-switch's `DeepLinkImportDialog` (user clicks Import) — that's the most cc-switch permits. No file import (SQL-only), no CLI/API.

---

## 1. Architecture overview

New **"Model Mapper"** section in `webui.html` (between the Accounts section and the Backends section) + three new server endpoints in `server.js`:

```
webui: Model Mapper section
  ├── 4 tier rows (opus/sonnet/haiku/fable): each = [backend dropdown] + [model dropdown (auto-fetched)]
  ├── default-model note (ANTHROPIC_MODEL = fable tier's model)
  ├── live preview: the generated ccswitch:// deep link + the router routes that will be saved
  └── [Import to CC Switch] button (opens deep link) + [Apply (write settings.json)] (existing path)

server.js:
  GET  /api/mapper/models/:backendId  → fetch the model list for a backend (Claude/codex/DashScope)
  POST /api/mapper/apply              → save the mapping as router routes (+ optional settings.json write)
  POST /api/mapper/deeplink           → generate the ccswitch:// URL from the mapping
```

The mapping flows two ways from one source of truth (the tier→backend+model table):
- **Router-side**: saved as routes (model→backend) in `backends.json` so the router routes the tier models correctly when CC sends them.
- **cc-switch-side**: exported as the `ccswitch://` deep link (opusModel/sonnetModel/haikuModel + config-env for fable) so cc-switch writes `~/.claude/settings.json` with the `ANTHROPIC_DEFAULT_*_MODEL` env that makes CC send those models.

---

## 2. Configurator UI (`webui.html` — new "Model Mapper" section)

### 2.1 Layout
A card titled **"Model Mapper"** with subtitle "Map each Claude Code model tier to a backend + model, then import into cc-switch." Contains:

1. **Tier table** (4 fixed rows, order: fable, opus, sonnet, haiku — fable first as the flagship default):
   | Tier | Backend | Model | (the model dropdown auto-populates when backend is picked) |
   Each row:
   - Tier label (fixed: "Fable (default)", "Opus", "Sonnet", "Haiku").
   - Backend `<select>`: options = the enabled backends with `authScheme` labels — `oauth`→"Claude (subscription pool)", `codex-oauth`→"Codex (ChatGPT sub)", `x-api-key`→"`<name>` (API key)". Default selection: fable→codex, opus→oauth, sonnet→glm, haiku→codex (the user's example).
   - Model `<select>`: populated by `GET /api/mapper/models/<backendId>` when the backend changes. Shows `display_name || id` (Claude/DashScope) or the curated id (codex). Includes a trailing "Custom…" option that reveals a free-text input (escape hatch for new/unlisted models — keeps the 小白 path default but doesn't block power users).
2. **Live preview** panel (updates on any change): two `<pre>` blocks — (a) the `ccswitch://` deep link URL, (b) the router routes that "Import"/"Apply" will save (e.g. `claude-opus-4-8 → default`, `glm-5.2 → glm`, `gpt-5.5-xhigh → codex`, `gpt-5.5-instant → codex`, `* → default`).
3. **Actions**:
   - **Import to CC Switch** (primary button): calls `POST /api/mapper/deeplink` to get the URL, saves the routes (`POST /api/mapper/apply`), then `window.location.href = url` (or an `<a href>` click) to fire the deep link. Toast: "Saved routes + opened cc-switch — confirm Import in the cc-switch dialog."
   - **Apply (write ~/.claude/settings.json)** (secondary): for users not using cc-switch — calls `POST /api/mapper/apply` with `writeSettings: true`. Writes the `env` block (ANTHROPIC_BASE_URL=router, ANTHROPIC_API_KEY=dummy, ANTHROPIC_MODEL=fable-model, ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL=…). Reuses the existing `applyProfile` machinery.

### 2.2 UX rules (beginner-friendly)
- **No required typing.** Every model dropdown is auto-populated. The "Custom…" option is opt-in only.
- **Backend change → auto-refetch + auto-pick a sensible default model** in the model dropdown (first match by tier preference: fable→`gpt-5.5-xhigh`, opus→`claude-opus-4-8`, sonnet→`glm-5.2`, haiku→`gpt-5.5-instant`; if not in the list, first item).
- **Validation**: a tier's model must be set (non-empty) before Import/Apply is enabled; show inline hints if a backend is disabled or has no key.
- The preview deep link updates live (debounced) so the user sees exactly what will be imported.

---

## 3. Model-list fetching (`server.js`)

New endpoint: `GET /api/mapper/models/:backendId` → `{ models: [{id, display, backend}] }`.

```js
async function apiMapperModels(backendId) {
  const cfg = loadConfig();
  const b = cfg.backends.find(x => x.id === backendId && x.enabled !== false);
  if (!b) throw notFound(`backend ${backendId}`);
  if (b.authScheme === "oauth") {
    // Claude: GET /v1/models via anthropicFetch (curl) + the oauth token (active account).
    const tok = await getAccessToken();
    if (!tok) return { models: [], error: "no Claude account token (login or add an account)" };
    const r = await anthropicFetch(b.upstream + "/v1/models", { method: "GET", headers: { ...headersOAuth({}, tok), "anthropic-version": "2023-06-01" } });
    if (!r.ok) return { models: [], error: `${r.status} ${(await r.text()).slice(0,200)}` };
    const j = JSON.parse(await r.text());
    return { models: (j.data || []).map(m => ({ id: m.id, display: m.display_name || m.id })) };
  }
  if (b.authScheme === "codex-oauth") {
    // Codex: curated (no endpoint). Verified all 200.
    return { models: [
      {id:"gpt-5.5",display:"GPT-5.5"},{id:"gpt-5.5-low",display:"GPT-5.5 (low)"},
      {id:"gpt-5.5-medium",display:"GPT-5.5 (medium)"},{id:"gpt-5.5-high",display:"GPT-5.5 (high)"},
      {id:"gpt-5.5-xhigh",display:"GPT-5.5 (xhigh)"},{id:"gpt-5.5-max",display:"GPT-5.5 (max)"},
      {id:"gpt-5.5-instant",display:"GPT-5.5 (instant)"},
    ]};
  }
  // x-api-key anthropic (GLM/DashScope etc.): fetch the upstream's /models (plain fetch, NOT curl).
  let host = ""; try { host = new URL(b.upstream).hostname; } catch {}
  const upFetch = (host === "api.anthropic.com" || host === "platform.claude.com") ? anthropicFetch : fetch;
  // DashScope's OpenAI-compatible list endpoint:
  const listUrl = b.upstream.includes("/compatible-mode/") ? b.upstream + "/models"
                : b.upstream.includes("/apps/anthropic") ? b.upstream.replace("/apps/anthropic","/compatible-mode/v1") + "/models"
                : b.upstream + "/models";
  const r = await upFetch(listUrl, { method: "GET", headers: { "authorization": `Bearer ${b.apiKey}` } });
  if (!r.ok) return { models: [], error: `${r.status} ${(await r.text()).slice(0,200)}` };
  const j = JSON.parse(await r.text());
  return { models: (j.data || []).map(m => ({ id: m.id, display: m.id })) };
}
```

Route: `if (seg.length === 4 && method === "GET" && seg[2] === "models") return sendJson(res, 200, await apiMapperModels(seg[3]));` under `head === "mapper"`.

**DashScope note**: the GLM backend's upstream is `https://dashscope.aliyuncs.com/apps/anthropic` (Anthropic-compatible). The model LIST lives at the OpenAI-compatible endpoint `https://dashscope.aliyuncs.com/compatible-mode/v1/models` (verified). The code above derives that URL by replacing `/apps/anthropic` with `/compatible-mode/v1` + `/models`. Plain `fetch` (not curl) — DashScope throttles curl.

---

## 4. Mapping → router routes (`POST /api/mapper/apply`)

```js
async function apiMapperApply(req) {
  const body = await readJson(req);           // { tiers: {opus:{backendId,model}, sonnet:{...}, haiku:{...}, fable:{...}}, writeSettings?: bool }
  const cfg = loadConfig();
  // 1. Build routes: each chosen model → its backend, BEFORE the catch-all.
  const tierModels = [];
  for (const [tier, pick] of Object.entries(body.tiers || {})) {
    if (!pick || !pick.model || !pick.backendId) continue;
    tierModels.push({ tier, model: pick.model, backendId: pick.backendId });
  }
  // Replace non-catch-all routes with the tier-model routes (keep one catch-all → default/oauth).
  const catchAll = (cfg.routes || []).find(r => r.pattern === "*") || { pattern: "*", backendId: "default" };
  cfg.routes = [...tierModels.map(t => ({ pattern: t.model, backendId: t.backendId })), catchAll];
  // If multiple tiers share a backend, the modelMap on that backend maps tier→model (already the model id, so no map needed).
  saveConfig(cfg);
  if (body.writeSettings) {
    // write ~/.claude/settings.json env (reuse applyProfile machinery with a synthetic profile)
    await writeMapperSettings(body.tiers);
  }
  return { ok: true, routes: cfg.routes };
}
```

`writeMapperSettings(tiers)` builds the env block:
```js
env = {
  ANTHROPIC_BASE_URL: `http://${HOST}:${boundPort}`,
  ANTHROPIC_API_KEY: DUMMY_KEY,
  ANTHROPIC_MODEL: tiers.fable?.model || tiers.opus?.model || "",
  ANTHROPIC_DEFAULT_OPUS_MODEL: tiers.opus?.model || "",
  ANTHROPIC_DEFAULT_SONNET_MODEL: tiers.sonnet?.model || "",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: tiers.haiku?.model || "",
  ANTHROPIC_DEFAULT_FABLE_MODEL: tiers.fable?.model || "",
  // _NAME display variants (optional, for CC's model picker UI)
  ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: tiers.opus?.model || "",
  ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: tiers.sonnet?.model || "",
  ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: tiers.haiku?.model || "",
  ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: tiers.fable?.model || "",
}
```
+ deep-merge into `~/.claude/settings.json` (preserve permissions/mcpServers/theme), backup once, atomic write (reuse `applyProfile`'s backup + `atomicWriteJson`).

---

## 5. Mapping → cc-switch deep link (`POST /api/mapper/deeplink`)

```js
async function apiMapperDeeplink(req) {
  const body = await readJson(req);   // { tiers: {...}, name?: "claude-router" }
  const t = body.tiers || {};
  const name = (body.name || "claude-router");
  const params = new URLSearchParams();
  params.set("resource", "provider");
  params.set("app", "claude");
  params.set("name", name);
  params.set("endpoint", `http://${HOST}:${boundPort}`);
  params.set("apiKey", DUMMY_KEY);
  params.set("model", t.fable?.model || t.opus?.model || "");     // ANTHROPIC_MODEL (default = fable)
  if (t.opus?.model)   params.set("opusModel", t.opus.model);     // first-class
  if (t.sonnet?.model) params.set("sonnetModel", t.sonnet.model);
  if (t.haiku?.model)  params.set("haikuModel", t.haiku.model);
  // fable has no first-class param → carry via base64 config env block
  const env = {};
  if (t.fable?.model) { env.ANTHROPIC_DEFAULT_FABLE_MODEL = t.fable.model; env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = t.fable.model; }
  // also carry the _NAME display variants for opus/sonnet/haiku (cc-switch's opusModel etc. only set the _MODEL, not _NAME)
  if (t.opus?.model)   env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = t.opus.model;
  if (t.sonnet?.model) env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = t.sonnet.model;
  if (t.haiku?.model)  env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = t.haiku.model;
  if (Object.keys(env).length) {
    params.set("config", Buffer.from(JSON.stringify({ env })).toString("base64"));
    params.set("configFormat", "json");
  }
  params.set("enabled", "true");   // auto-switch to it after import
  return { url: `ccswitch://v1/import?${params}`, env, routes: tierRoutes(t) };
}
```

`tierRoutes(t)` = the routes that `apply` would save (for the preview + so the router routes correctly after import). The webui's "Import to CC Switch" button calls `apply` (to save routes) THEN opens the deep link.

**Deep-link correctness** (per cc-switch `provider.rs:266-296`): `apiKey→ANTHROPIC_AUTH_TOKEN`, `endpoint→ANTHROPIC_BASE_URL`, `model→ANTHROPIC_MODEL`, `opusModel→ANTHROPIC_DEFAULT_OPUS_MODEL`, `sonnetModel→ANTHROPIC_DEFAULT_SONNET_MODEL`, `haikuModel→ANTHROPIC_DEFAULT_HAIKU_MODEL`. The base64 `config` env block is overlaid (only those 6 keys are overwritten by the URL params; the rest, incl. `ANTHROPIC_DEFAULT_FABLE_MODEL` + the `_NAME` variants, survive).

---

## 6. The "Import to CC Switch" button flow (webui)

```js
async function importToCcSwitch() {
  const tiers = readTierPicks();                       // from the 4 dropdowns
  // 1. save router routes (so the router routes the tier models correctly)
  await api("POST", "/api/mapper/apply", { tiers });
  // 2. get the deep link
  const { url } = await api("POST", "/api/mapper/deeplink", { tiers });
  // 3. open it (browser prompts "Open ccswitch?" → cc-switch dialog → user clicks Import)
  window.location.href = url;
  toast("Routes saved. Confirm Import in the cc-switch dialog.", "ok");
}
```

The `<a href>` approach also works (download/copy the link). Provide a "Copy deep link" affordance too (some browsers block `window.location` to a custom scheme from a fetch handler).

---

## 7. Error handling

- **Model-list fetch fails** (backend down / no token / 429): the model dropdown shows "—" + a hint ("backend unreachable / not logged in"); the user can still use "Custom…" to type. The Import button is disabled until all 4 tiers have a model.
- **cc-switch not installed**: the deep link does nothing (browser may show "nothing handled ccswitch"). Toast hint: "Install cc-switch (github.com/farion1231/cc-switch) to use one-click import; or use Apply to write settings.json directly."
- **OS env conflict** (`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` set in OS env, e.g. the user's GLM setup): the deep link's `enabled=true` makes cc-switch write settings.json, but OS env OVERRIDES the file → CC might bypass the router. Surface the existing `osEnvConflicts` banner prominently in the Model Mapper section: "⚠ OS env overrides settings.json — unset ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN in your shell, or CC won't use the router."
- **Deep link too long**: base64 config could make a long URL; cc-switch uses query params (no length limit in practice for local links). If it exceeds ~8k chars, fall back to writing settings.json directly (Apply) — unlikely (the env block is tiny).

---

## 8. Testing

### 8.1 Extend `selftest()` (offline)
- `buildMapperDeeplink({tiers:{opus:{model:"claude-opus-4-8"},sonnet:{model:"glm-5.2"},haiku:{model:"gpt-5.5-instant"},fable:{model:"gpt-5.5-xhigh"}}})` → assert URL contains `opusModel=claude-opus-4-8`, `sonnetModel=glm-5.2`, `haikuModel=gpt-5.5-instant`, `model=gpt-5.5-xhigh`, `enabled=true`, and the base64 `config` decodes to `{env:{ANTHROPIC_DEFAULT_FABLE_MODEL:"gpt-5.5-xhigh", ...}}`.
- `tierRoutes(tiers)` → assert it produces `[{pattern:"claude-opus-4-8",backendId:oauth},{pattern:"glm-5.2",backendId:glm},{pattern:"gpt-5.5-instant",backendId:codex},{pattern:"gpt-5.5-xhigh",backendId:codex},{pattern:"*",backendId:"default"}]`.
- `writeMapperSettings` env shape (without writing the file) → assert the 4 `ANTHROPIC_DEFAULT_*_MODEL` + `ANTHROPIC_MODEL` keys.

### 8.2 Live verification (Codex: do during impl, before declaring done)
1. `GET /api/mapper/models/default` (oauth) → returns the Claude model list (non-empty, includes claude-opus-4-8).
2. `GET /api/mapper/models/codex` → returns the 7 curated gpt-5.5 variants.
3. `GET /api/mapper/models/glm` → returns the DashScope list (non-empty, includes glm-5.2).
4. `POST /api/mapper/deeplink` with the user's example mapping → returns a valid `ccswitch://v1/import?…` URL; paste into a browser → cc-switch opens the import dialog pre-filled (manual confirmation step).
5. `POST /api/mapper/apply` → routes saved; then `POST /v1/messages` with each tier model routes correctly (opus→oauth 200, sonnet→glm 200, haiku→codex 200, fable→codex 200) — reuse the verified 200s from prior testing.

---

## 9. Implementation order (for Codex)

1. **Server: model-list endpoint** `GET /api/mapper/models/:backendId` (§3) + route under `head === "mapper"`.
2. **Server: deep-link generator** `POST /api/mapper/deeplink` (§5) + `tierRoutes` helper.
3. **Server: apply** `POST /api/mapper/apply` (§4) + `writeMapperSettings` (reuse `applyProfile`'s backup/atomic-write).
4. **webui: Model Mapper section** (§2) — tier table, backend/model dropdowns, live preview, Import + Apply buttons. Wire to the 3 endpoints.
5. **webui: auto-fetch on backend change** + sensible default model per tier + "Custom…" escape hatch.
6. **selftest** additions (§8.1).
7. **README** update: Model Mapper section, the cc-switch one-click flow, the OS-env-conflict caveat.

### 9.1 Non-regression
- [ ] Existing backends/routes/accounts/profiles unchanged; Model Mapper is additive.
- [ ] `curl` only for Anthropic-bound calls (Claude /v1/models); plain `fetch` for DashScope (curl gets 429 Throttling — verified).
- [ ] Deep link uses camelCase params + base64 config (per cc-switch `provider.rs`); `enabled=true`.
- [ ] `apply` saves routes WITHOUT clobbering the catch-all `* → default`.
- [ ] `writeMapperSettings` deep-merges settings.json (preserves permissions/mcpServers/theme), backs up once, atomic write.
- [ ] selftest passes (`selftest OK (account-pool + multi-backend + codex/responses)`) + new mapper assertions.

---

## 10. Open verifications (Codex: confirm during impl)

1. Does `GET /v1/models` (Claude) via `anthropicFetch` + `headersOAuth` need the identity system block? (It's a list endpoint, not inference — probably not, but verify it 200s without the block; if 403/429, add the identity block to the models GET too.)
2. Does the base64 `config` env block correctly carry `ANTHROPIC_DEFAULT_FABLE_MODEL` through cc-switch's `extract_claude_config_env` + overlay? (cc-switch `provider.rs:311-338` reads `config.env`; the 6 first-class keys are overwritten by URL params, fable is not among them so it survives — verify by importing + checking the written settings.json.)
3. Does `enabled=true` actually auto-switch cc-switch to the imported provider (writing settings.json) after the user clicks Import? (cc-switch `provider.rs:130-133` → `ProviderService::switch` — verify the live settings.json is written.)
4. Browser deep-link gating: does `window.location.href = "ccswitch://…"` work from the router webui, or does the browser block it (requiring an `<a href>` click)? Provide both (button + copy-link).

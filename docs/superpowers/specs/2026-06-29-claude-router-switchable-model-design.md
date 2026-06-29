# claude-router — Switchable "router" Model

**Status:** Design approved 2026-06-29.
**Target:** single-file `server.js` + `webui.html` (zero deps).
**Goal:** A single client-facing model name (`router`) you add to Claude Code. Requests for it go to the router (8123), which forwards to whichever real backend+model you've currently selected. You flip the active target between a candidate list (glm-5.2, minimax-m3, claude-opus-4-8, gpt-5.5-xhigh, …) with one click in the webui — no Claude Code restart, no config edits.

## 1. Approach

Extend the existing **Virtual Models** feature (do NOT build a parallel system). A virtual model gains two optional fields — a `candidates[]` list and an `activeCandidate` index — that turn it into a manual switch. Existing VMs (no `candidates`) behave byte-identically. The user picked: **one alias**, **pick-or-type candidates**, **manual switch by default with optional auto-rules layered on top**.

## 2. Data model (additive to the VM schema)

```jsonc
{
  "id": "router",
  "name": "Router (switchable)",
  "enabled": true,
  "match": ["router"],
  "candidates": [                                   // NEW (optional)
    { "backendId": "glm",     "model": "glm-5.2",        "label": "GLM 5.2" },
    { "backendId": "minimax", "model": "minimax-m3",     "label": "MiniMax M3" },
    { "backendId": "default", "model": "claude-opus-4-8","label": "Opus 4.8" },
    { "backendId": "codex",   "model": "gpt-5.5-xhigh",  "label": "GPT-5.5 xhigh" }
  ],
  "activeCandidate": 0,                             // NEW (index into candidates; the manual switch)
  "rules": [],                                      // existing, optional auto-rules
  "default": { "backendId": "glm", "model": "glm-5.2" }  // existing fallback
}
```

- `candidates[]`: each `{ backendId, model, label? }`. `label` is cosmetic (defaults to `model`). `backendId` need not currently exist/enabled at config time (free-type allowed — you may add the backend later); validity is checked at resolution time, not save time.
- `activeCandidate`: integer index. Clamped to `[0, candidates.length-1]` on load; if `candidates` is empty it's ignored.

### `normalizeVirtualModel()` changes (server.js ~1286)
- Parse `candidates` into a clean array of `{ backendId:String, model:String, label:String }`; drop entries missing `backendId` or `model`. If none valid → `candidates: []`.
- Parse `activeCandidate` as int via `clampInt(raw, 0, 0, candidates.length ? candidates.length-1 : 0)`.
- `default` stays **required** (final fallback). When the webui creates a `router` VM, it sets `default` to the first candidate automatically.

## 3. Resolution precedence (`evaluateVirtualModel`, server.js ~1490)

Per request, pick the target in this order:
1. **Rules** — if `rules[]` is non-empty and one matches the body (existing `ruleMatches`), use it (`matchedRule: rule.when`). *(Rules layer on top.)*
2. **Active candidate** — else if `candidates[]` is non-empty, use `candidates[activeCandidate]` **provided its backend exists and is enabled**; if that backend is missing/disabled, fall to the next valid candidate in order (`matchedRule: "active"`).
3. **Default** — else `default` (`matchedRule: "default"`).

This means: no rules + candidates ⇒ pure manual switch; rules + candidates ⇒ rules win when they fire, otherwise the manual pick. Existing VMs (no candidates) ⇒ rules → default, unchanged.

The backend-validity check reuses the same "find enabled backend by id" logic already used in `proxy()` for the VM target (so a stale candidate degrades gracefully rather than 502-ing).

## 4. API

Reuse existing CRUD (`POST/PUT/DELETE /api/virtual-models`) — `PUT` already deep-merges allowed fields, so `candidates`/`activeCandidate` flow through once `normalizeVirtualModel` knows them. Add **one** quick-switch endpoint:

```
POST /api/virtual-models/:id/switch     body: { "index": <int> }   (admin-guarded)
  -> sets activeCandidate (clamped), persists, returns the updated (normalized) VM
```

(A thin convenience over `PUT`; lets the dashboard flip with a single tiny call and clear intent. 400 if the VM has no candidates; 404 if VM not found.)

## 5. WebUI

In the existing **Virtual Models** section (webui.html ~1472):
- **Quick-switch widget** on each VM card that has `candidates`: render the candidates as segmented buttons (or a `<select>`) showing `label`, active one highlighted; clicking calls `POST …/switch {index}` then refreshes. Prominent, one-click — not buried in the editor.
- **Candidate editor** in the VM modal: a "Candidates" list (add/remove/reorder) where each row is a **backend dropdown + model picker**. The model picker is populated from `/api/mapper/models/:backendId` (existing) with a trailing **"Custom…"** free-type option (mirrors the Model Mapper UX). A radio/highlight marks the active candidate.
- An **"Add router model"** affordance (button) that pre-fills a new VM with `id: "router"`, `match: ["router"]`, an empty candidates list, and `default` set to the first candidate the user adds.
- Existing rules editor stays as-is (optional, shown below candidates).

## 6. Claude Code integration

Set `ANTHROPIC_MODEL=router` in `~/.claude/settings.json` (or map a tier to `router` in the Model Mapper). Claude Code then sends `model:"router"`; `resolveVirtualModel` matches it (existing glob match), `evaluateVirtualModel` returns the active candidate's `{backendId, model}`, `proxy()` rewrites `body.model` and dispatches — exactly the existing VM path. The existing `exactRouteOrPatternCollision()` check prevents `router` from clashing with a real backend id / route pattern.

## 7. Edge cases

- Active candidate's backend disabled/removed → skip to next valid candidate → `default` (§3).
- `activeCandidate` out of range → clamped on load and on `/switch`.
- `candidates` empty → VM behaves as a classic rules+default VM.
- Switching persists to `backends.json` and is live on the next request (config read fresh per request — no restart).
- Unsigned thinking blocks from GLM/MiniMax history are already stripped before the Claude backend by the existing `sanitizeThinkingForClaude` (so flipping `router` between GLM and Claude mid-conversation stays safe).

## 8. Tests

Extend `selftestVirtualModels()`:
- candidates + no rules → resolves to `candidates[activeCandidate]`.
- candidates + a matching rule → rule wins (override).
- activeCandidate clamp (out-of-range → clamped).
- active candidate whose backend is disabled → falls to next valid → default.
- normalize drops invalid candidate entries.
- no candidates → unchanged (rules → default).

Live verify (throwaway port): create a `router` VM with candidates [glm-5.2, minimax-m3]; request `model:"router"` → hits glm; `POST /switch {index:1}`; request again → hits minimax; both 200. Never touch 8123.

## 9. Implementation order

1. `normalizeVirtualModel`: parse/validate `candidates` + `activeCandidate`.
2. `evaluateVirtualModel`: rules → active candidate (skip invalid) → default.
3. `POST /api/virtual-models/:id/switch` endpoint + route.
4. WebUI: quick-switch widget on VM cards + candidate editor (pick-or-type) + "Add router model" button.
5. selftest additions; live-verify on a throwaway port.
6. README note.

## 10. Non-regression

- VM with no `candidates` → identical behavior (rules → default).
- All existing features intact: account pool, Step-1 Claude injection, GLM/Ark plain-fetch, codex, Model Mapper, request inspector, crash guards, streaming-error reshaping.
- `node server.js --selftest` passes (existing + new assertions). Never restart 8123; verify on a throwaway port.

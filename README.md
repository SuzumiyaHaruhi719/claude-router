# claude-router

Minimal local proxy — run **Claude Code** (or any Anthropic-API client) on your **Claude Pro/Max subscription** instead of a pay-per-token API key. One file, zero dependencies, a one-button login page.

```
Claude Code ──/v1/messages──▶ claude-router (127.0.0.1:8123) ──Bearer <subscription OAuth>──▶ api.anthropic.com
```

## Run

```sh
node server.js
```

Then open **http://127.0.0.1:8123/** and:

1. Click **① Login with Claude** (opens a new tab) → sign in → approve.
2. The page shows a string like `code#state` — copy the whole thing.
3. Paste it back into the box → **② Submit code**.

Point Claude Code at the router (any dummy API key — it's ignored and replaced with your subscription token):

```sh
# cmd
set ANTHROPIC_BASE_URL=http://127.0.0.1:8123
set ANTHROPIC_API_KEY=dummy

# PowerShell
$env:ANTHROPIC_BASE_URL="http://127.0.0.1:8123"; $env:ANTHROPIC_API_KEY="dummy"
```

…then start `claude`. Tokens are stored in `~/.claude-router/creds.json` (mode 600) and auto-refresh.

## Two modes
- **OAuth (subscription)** — default. Login via the webui; router sends a Bearer token. *Currently 403-blocked by Anthropic — see below.*
- **API-key** — set `CLAUDE_ROUTER_API_KEY` and the router forwards with `x-api-key` to `CLAUDE_ROUTER_UPSTREAM` (default `https://api.anthropic.com`), passing the client's `anthropic-beta` through untouched. No login needed. **This mode works today** and accepts any Anthropic-compatible backend:

```sh
# Anthropic API key, or an Anthropic-compatible endpoint (e.g. GLM/z.ai):
$env:CLAUDE_ROUTER_API_KEY="sk-..."; $env:CLAUDE_ROUTER_UPSTREAM="https://api.anthropic.com"; node server.js
# then point Claude Code at the router as usual (ANTHROPIC_BASE_URL=http://127.0.0.1:8123)
```

## Config
- `CLAUDE_ROUTER_PORT` (or `PORT`) — default `8123`. Binds **127.0.0.1 only**.
- `CLAUDE_ROUTER_API_KEY` — if set, runs in API-key mode (forwards `x-api-key`).
- `CLAUDE_ROUTER_UPSTREAM` — upstream base URL (default `https://api.anthropic.com`).

## Self-test
```sh
node server.js --selftest
```
Checks PKCE, the `anthropic-beta` merge, and header rewriting offline.

## ⚠️ Verified status (2026-06-25) — subscription OAuth is currently BLOCKED

Offline self-tests pass and the proxy/login code is correct, **but the live subscription-OAuth path does not work against Anthropic right now.** A valid (non-expired) Claude subscription OAuth token returns **`403 "Request not allowed"`** on `/v1/messages` — across all models and header variants, including a faithful replay of a genuine Claude Code request. Anthropic appears to block subscription-OAuth inference from non-official clients. **This router therefore cannot serve your subscription as an API as-is.**

To get a *working* local router, use **API-key mode** (implemented + verified end-to-end): set `CLAUDE_ROUTER_API_KEY` (and optionally `CLAUDE_ROUTER_UPSTREAM` for an Anthropic-compatible endpoint like GLM/z.ai). The router then forwards with `x-api-key` to that upstream — see **Two modes** above. The Anthropic-format passthrough is identical; only the credential differs.

## Notes / caveats
- Uses Claude Code's OAuth client to drive your **subscription**. Anthropic's consumer terms restrict programmatic use of subscription credentials — this is your own account, local, personal use, your call.
- The OAuth constants are reverse-engineered from Claude Code and **may change or be blocked** by Anthropic at any time. If login or requests start failing with 401/403, the constants in `server.js` likely need updating.
- The stored token grants **full access to your Claude account** — the server binds localhost only; do not expose the port.

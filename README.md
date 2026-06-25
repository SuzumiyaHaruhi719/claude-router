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

## Config
- `CLAUDE_ROUTER_PORT` (or `PORT`) — default `8123`. Binds **127.0.0.1 only**.

## Self-test
```sh
node server.js --selftest
```
Checks PKCE, the `anthropic-beta` merge, and header rewriting offline.

## Notes / caveats
- Uses Claude Code's OAuth client to drive your **subscription**. Anthropic's consumer terms restrict programmatic use of subscription credentials — this is your own account, local, personal use, your call.
- The OAuth constants are reverse-engineered from Claude Code and **may change or be blocked** by Anthropic at any time. If login or requests start failing with 401/403, the constants in `server.js` likely need updating.
- The stored token grants **full access to your Claude account** — the server binds localhost only; do not expose the port.

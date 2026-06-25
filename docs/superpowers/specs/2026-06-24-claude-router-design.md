# claude-router — design

**Date:** 2026-06-24
**Goal:** A minimal local proxy that lets Claude Code (or any Anthropic-API client) run against your **Claude Pro/Max subscription** instead of a pay-per-token API key. One file, one command, a one-button login page.

## Flow

```
Claude Code  ──HTTP /v1/messages──▶  claude-router (127.0.0.1:8123)  ──Bearer <subscription OAuth>──▶  api.anthropic.com
                                            │
                                     webui at /  → Claude Code OAuth (PKCE, paste-code) → ~/.claude-router/creds.json
```

## Decisions (from brainstorming)
- **Credential:** Claude subscription OAuth (Pro/Max), used as the backend. *ToS caveat acknowledged by the user* — Anthropic's consumer terms restrict programmatic use of subscription credentials; this is the user's own account, local, personal use, their call.
- **Wire format:** Anthropic-native passthrough only (`/v1/*`). No OpenAI translation.
- **Login:** self-contained webui (does its own OAuth), not reusing Claude Code's stored token.

## Components (single `server.js`, zero deps, Node ≥18 built-ins: `http`, global `fetch`, `crypto`, `fs`)

1. **Login webui** `GET /` — status (logged-in / expires-in / not-logged-in), **Login** link, paste-code box, **Logout**, and the `ANTHROPIC_BASE_URL` to copy.
   - `GET /login` → 302 to the Anthropic authorize URL (opens in a new tab; PKCE verifier+state held in memory).
   - Authorize uses the **paste-code** flow: redirect_uri is `https://console.anthropic.com/oauth/code/callback`, which displays `code#state`; the user pastes it back.
   - `POST /exchange` (form field `code`) → exchange `code#state` + verifier at the token endpoint → store tokens.
   - `POST /logout` → delete creds.
2. **Proxy** `ANY /v1/*` — strip incoming `x-api-key`/`authorization`, set `Authorization: Bearer <access_token>`, union `anthropic-beta` with `oauth-2025-04-20,claude-code-20250219`, default `anthropic-version: 2023-06-01`, forward to `api.anthropic.com` (path+query preserved), stream the response (SSE passes through). On upstream `401`: refresh once, retry once.
3. **Token store** `~/.claude-router/creds.json` (mode 600): `{access_token, refresh_token, expires_at}`. Auto-refresh 60 s before expiry and on a 401.

## OAuth constants (reverse-engineered from Claude Code; verified 2026-06-24 against community sources)
- client_id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- authorize `https://claude.ai/oauth/authorize` — params `code=true`, `response_type=code`, `client_id`, `redirect_uri=https://console.anthropic.com/oauth/code/callback`, `scope=org:create_api_key user:profile user:inference`, `code_challenge`, `code_challenge_method=S256`, `state`
- token `https://console.anthropic.com/v1/oauth/token` — POST JSON; auth-code body `{grant_type:"authorization_code", code, code_verifier, client_id, redirect_uri, state}`; refresh body `{grant_type:"refresh_token", refresh_token, client_id}`

## Errors
- Not logged in / refresh fails → `401` JSON pointing at the webui.
- Upstream/network error → `502` JSON.
- Upstream errors (rate limit, etc.) → passed through unchanged.

## Security
- Binds **127.0.0.1 only** (never exposed). The token grants full access to your Claude account; do not forward the port.
- creds file mode 600.

## Tests
`node server.js --selftest`: PKCE challenge == base64url(sha256(verifier)) and is url-safe; `anthropic-beta` merge dedupes + includes both required betas; header rewrite strips `x-api-key` and sets Bearer. Exit non-zero on failure.

## Use
1. `node server.js` → open `http://127.0.0.1:8123/` → **Login** → authorize → paste the code.
2. Point Claude Code at it: `ANTHROPIC_BASE_URL=http://127.0.0.1:8123` (+ any dummy `ANTHROPIC_API_KEY`).

## Known risk
The OAuth constants are reverse-engineered and Anthropic may change/limit them; first implementation step is to confirm a real login works before relying on it.

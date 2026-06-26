# claude-router — Multi-Org OAuth Account Pool + 429 Auto-Rotation

**Status:** Design approved 2026-06-26; implementation handed to Codex.
**Target codebase:** `C:/Users/Thomas/Documents/Projects/claude-router` — single-file `server.js` (Node ≥ 18, zero deps) + `webui.html`.
**Scope driver:** The user has ONE Claude account belonging to TWO organizations. Each org has independent quota (Anthropic rate limits apply at the org level). When one org is exhausted (429), the router must auto-rotate to the other org's token, with optional manual switch, and **no re-login at switch time**.

---

## 0. Resolved facts (from research — do not re-litigate)

1. The subscription-OAuth access token is bound to an **ORGANIZATION**, not a "workspace". The token response from `https://platform.claude.com/v1/oauth/token` returns `organization:{uuid,...}` and `account:{uuid,...}` objects. There is NO `workspace_id` field and NO per-request header to switch org at runtime (`anthropic-workspace-id` is AWS-Claude-Platform-only; CRS sets no org/workspace header on outgoing `/v1/messages`). Org is baked into the bearer at authorize time.
2. The router's CURRENT authorize URL `https://claude.ai/oauth/authorize` (generic) yields the account's **default-org** token and is NOT per-org selectable. CRS had to add a separate **org-scoped** authorize flow `https://claude.ai/v1/oauth/{organization_uuid}/authorize` to bind a token to a specific org. The 2nd+ login MUST use the org-scoped URL or the pool will silently contain two tokens for the SAME default org.
3. `exchangeCode` (`server.js` ~157-193) currently DISCARDS `organization`/`account`/`subscription` from the token response. It MUST capture them.
4. Anthropic `/v1/messages` + the token endpoint gate on TLS fingerprint (Node `fetch`/`https` → 403; `curl` accepted). ALL Anthropic-bound HTTP — token exchange, `/v1/messages`, AND the new `/api/oauth/profile` + `/api/organizations` calls — MUST go through the existing `anthropicFetch`/`curlFetch` wrapper. Do NOT regress this.
5. The router also has an API-key passthrough mode and a multi-backend model-name router (`backends.json`). The account pool is a SEPARATE axis that backs the `oauth:true` subscription backend.

---

## 1. Goals & non-goals

**Goals**
1. `~/.claude-router/accounts.json` — a pool of N org-scoped OAuth accounts, each obtained by one one-time PKCE paste-code login.
2. 2nd+ login uses the **org-scoped authorize URL** so each token binds to a distinct org; `exchangeCode` captures `organization_uuid`; duplicate-org tokens rejected.
3. On each proxied `/v1/messages`, select an available account and inject its `accessToken` as `Authorization: Bearer`. On 429 (quota) auto-rotate to the next org; on 529 (overload) short-cooldown; on 401/403 refresh-then-cooldown.
4. Manual switch (webui Activate / Disable / Remove / Refresh) with no re-login.
5. Migrate the existing single `creds.json` / CC `.credentials.json` token into `accounts[0]`; disable the read-only piggyback once the pool exists.
6. Preserve the existing single-file/zero-dep architecture, the `curlFetch`/`anthropicFetch` TLS bypass, the API-key mode, and the `backends.json` multi-backend router byte-for-byte.

**Non-goals (deferred — `// ponytail:` comments name the upgrade path)**
- Sticky sessions / conversation affinity (Claude Code sends full context per request; mid-conversation rotation does not lose context).
- Priority weights (array order suffices for 2 orgs).
- AES encryption at rest (file is mode 0600, localhost-only, consistent with existing `creds.json`).
- Circuit-breaker / auto-failover queue across backends.
- Console `wrkspc_` workspaces (API-key-scoped, no independent quota — out of scope; the user has two ORGS).

---

## 2. File layout

```
claude-router/
  server.js          # extended: pool, org-scoped login, rotation, /api/accounts*
  webui.html         # extended: accounts table + add-account (org picker) + per-row actions
  ~/.claude-router/
    accounts.json    # NEW — the pool (mode 0600)
    creds.json       # legacy — read once for migration, then superseded
    settings-backup.json
```

New constants:
```js
const ACCT_FILE = path.join(CFG_DIR, "accounts.json");
```
Keep `CRED_FILE` (`creds.json`) for migration only. `CC_SETTINGS`/`CC_BACKUP`/`CFG_DIR` unchanged.

---

## 3. `accounts.json` schema

```jsonc
{
  "version": 1,
  "accounts": [
    {
      "id": "acct_01",                       // internal, stable, "acct_" + zero-padded index
      "label": "Org A",                      // user-facing, editable
      "email": "user@example.com",           // optional, from profile if available
      "organization_uuid": "abc-...",        // CAPTURED from token response (key field)
      "organization_name": "Personal",       // from token response / profile
      "account_uuid": "...",                 // from token response
      "claudeAiOauth": {                     // mirror Claude Code's own shape
        "accessToken": "...",
        "refreshToken": "...",
        "expiresAt": 1750000000000           // epoch ms
      },
      "scopes": ["user:profile","user:inference", "..."],
      "subscriptionType": "enterprise",
      "rateLimitTier": "default_claude_max_5x",
      "status": "active",                    // active | cooldown | disabled
      "cooldown_until": null,                // epoch ms; null = available
      "cooldown_reason": null,               // "429_quota" | "529_overload" | "auth" | "blocked"
      "rate_limit_reset_at": null,           // from anthropic-ratelimit-unified-reset header
      "last_429_at": null,
      "created_at": 1750000000000
    }
  ],
  "active_id": "acct_01"
}
```

Disk I/O (mirror existing `saveCreds` style):
```js
function loadAccounts() {
  try { return JSON.parse(fs.readFileSync(ACCT_FILE, "utf8")); }
  catch { return { version:1, accounts:[], active_id:null }; }
}
function saveAccounts(a) {
  fs.mkdirSync(CFG_DIR, { recursive:true });
  fs.writeFileSync(ACCT_FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
}
```

---

## 4. Login flow (org-scoped, the critical fix)

### 4.1 First login (default org)
Keep `buildAuthorizeUrl()` using the generic `https://claude.ai/oauth/authorize`. In `exchangeCode(raw)` (server.js ~157-193), STOP discarding the token response — capture:
```js
// token response shape (per CRS, VERIFY during impl):
// { access_token, refresh_token, expires_in, token_type,
//   organization:{uuid,name,...}, account:{uuid,...},
//   subscription:{type,...}, plan:{...}, rateLimitTier }
```
Store `organization_uuid`, `organization_name`, `account_uuid`, `subscriptionType`, `rateLimitTier` into the new `accounts.json` entry. If `organization_uuid` is missing from the response (shouldn't happen — the token response carries it per CRS), mark it `"unknown"` rather than rejecting, so login still succeeds; the entry can't be deduped/org-labeled and the webui prompts a re-login via the org-scoped flow (§4.3) to recover it. The org-scoped path must always carry it.

### 4.2 Org enumeration (for the 2nd+ login)
After the first account exists, the webui "Add account" flow:
1. Call `https://claude.ai/api/organizations` with `Authorization: Bearer <first account accessToken>` via `anthropicFetch` (curl) to list the account's org UUIDs + names.
2. Present an org picker in the webui.
3. **Fallback** if that call 403s via curl: prompt the user to paste the target org UUID (visible in the claude.ai URL when they switch org), with a link to open claude.ai.

### 4.3 Org-scoped login (2nd+ account)
`buildAuthorizeUrl(organization_uuid)`:
- If `organization_uuid` provided → use `https://claude.ai/v1/oauth/{organization_uuid}/authorize` (CRS cookie/org-flow).
- Else → generic `https://claude.ai/oauth/authorize` (default org).
Same PKCE params (`code_verifier`/`state`/`redirect_uri`/`scope`/`client_id`), same `TOKEN_URL` exchange.

### 4.4 Dedup
On successful exchange, **reject** if an existing entry already has the same `organization_uuid` (HTTP 409 to the webui: "org already in pool"). The user must not accidentally hold two tokens for one org.

### 4.5 Login is one-time
`refreshToken` is per-grant and independent per account. Refresh each account independently (generalize `refreshCreds` to take an account). No re-login at switch time.

---

## 5. Account selection + rotation

### 5.1 Selection (per proxied `/v1/messages` on the `oauth` backend)
```js
function pickAccount() {
  const a = loadAccounts();
  if (!a.accounts.length) return null;
  const now = Date.now();
  // 1. active_id if available
  const active = a.accounts.find(x => x.id === a.active_id);
  if (active && active.status !== "disabled" && (active.cooldown_until || 0) <= now) return active;
  // 2. next available by array order
  return a.accounts.find(x => x.status !== "disabled" && (x.cooldown_until || 0) <= now) || null;
}
```
Inject `pickAccount().claudeAiOauth.accessToken` as `Authorization: Bearer` via the existing `headersOAuth()` path. The `curlFetch`/`anthropicFetch` wrapper is unchanged — only the bearer swaps.

If `pickAccount()` returns null (all cooling/disabled) → return Anthropic-shaped 503 `{error:{type:"proxy_error",message:"claude-router: all accounts cooling/disabled. Retry shortly or enable an account in the webui."}}`.

### 5.2 Rotation triggers (in `anthropicPassthrough`, after the upstream response)
Generalize the existing 401-mid-flight refresh+retry (server.js ~1651-1656) and `throttledBackendFetch` (server.js ~638-671) to per-account cooldown + rotate:

| Upstream | Action | Cooldown |
|---|---|---|
| 429 + `anthropic-ratelimit-unified-reset` header | quota exhausted → rotate-and-stay | `cooldown_until = reset`, `reason="429_quota"`, `rate_limit_reset_at = reset` |
| 429 (no reset header) | short backoff → rotate | `cooldown_until = now+300s`, `reason="429_quota"` |
| 529 | overload (transient) → rotate | `cooldown_until = now+600s`, `reason="529_overload"` |
| 401 | refresh token, retry SAME account once; refresh fail → cooldown | `cooldown_until = now+1800s`, `reason="auth"` |
| 403 | refresh + retry SAME account up to 2x (often transient fingerprint/refresh); still fail → cooldown | `cooldown_until = now+1800s`, `reason="auth"` |
| 400 body matches `/organization disabled\|account disabled\|not found\|invalid account\|Too many active sessions/i` | disable | `status="disabled"` for 600s, `reason="blocked"` |

On any rotation: `active_id` is preserved (the user's chosen default is reused once its cooldown expires); the cooling account is simply skipped by the next `pickAccount()`. Persist `accounts.json` on cooldown state change (debounced — don't write on every request; write only when a cooldown/status field changes).

**Retry budget:** when a request rotates, retry the SAME inbound request against the next available account (up to `MAX_ROTATE_RETRIES = 3` accounts) before surfacing the error to Claude Code. This makes 429-rotation transparent to the client for a single request.

**Streaming note:** rotation retry only happens BEFORE any SSE bytes are sent to the client — i.e. when the upstream 429/529 returns as a non-2xx with no body streamed (the normal quota-429 case). Once 2xx streaming has begun, a mid-stream error is surfaced to the client and Claude Code retries the whole request on its own.

---

## 6. Manual switch (webui)

Per account row:
- **Activate** → `active_id = x.id`, clear `cooldown_until`/`cooldown_reason` on x, `status="active"`. No re-login.
- **Disable** → `status="disabled"` (excluded from selection).
- **Remove** → delete entry (confirm). If removing `active_id`, set `active_id` to the first remaining.
- **Refresh now** → force a token refresh on that account.

---

## 7. Migration + piggyback conflict

### 7.1 One-time migration on startup
If `accounts.json` does not exist but `creds.json` OR `~/.claude/.credentials.json` exists:
1. Read the single token (prefer the router's own `creds.json`; fall back to CC's `.credentials.json` via `loadClaudeCodeCreds`).
2. Create `accounts[0]` from it with `organization_uuid = null` (the stored token's org was discarded at original exchange; CC's `.credentials.json` has no org field at all).
3. **Recover the org UUID** by calling `https://claude.ai/api/oauth/profile` (CRS uses this) with the access token via `anthropicFetch` (curl). If it 403s, mark `organization_uuid = "unknown"` (inference still works; the entry just can't be deduped/org-labeled) and surface a webui prompt to re-login that account via the org-scoped flow.
4. Write `accounts.json`; set `active_id = accounts[0].id`.
5. Do NOT block startup — an unknown-org entry still serves inference.

### 7.2 Piggyback disabled once pool exists
- Once `accounts.json` has ≥1 account, `loadCreds()` NO LONGER prefers `~/.claude/.credentials.json`. The pool (`accounts.json`) is authoritative for the `oauth` backend.
- `loadClaudeCodeCreds` is kept ONLY as a one-time migration source (7.1) when `accounts.json` is empty.
- NEVER write back to `~/.claude/.credentials.json` (cc-switch never does; CC's own login state is a separate concern). When Claude Code is pointed at the router (`ANTHROPIC_BASE_URL=127.0.0.1:PORT` + dummy `ANTHROPIC_API_KEY`), the router supplies `Authorization` on every proxied request, so CC's `.credentials.json` is irrelevant for proxied traffic.

---

## 8. webui changes (`webui.html`)

New **Accounts** section (above or beside the existing OAuth login card):
- Table: `label` | `email` | `organization_name` + last 4 of `organization_uuid` | status badge (`active` / `cooldown-until <countdown>` / `disabled`) | `subscriptionType` | `last_429_at` | row actions (Activate / Disable / Remove / Refresh).
- **Add account** button → PKCE login modal:
  - First account (pool empty): default-org flow, no picker.
  - 2nd+ account: org picker populated from `GET /api/accounts/orgs` (the server calls `claude.ai/api/organizations` with the active token); fallback manual-paste field for `organization_uuid`.
  - Shows the org-scoped authorize URL being used + a "Open claude.ai" link.
- Top banner: "Active: `<label>` (org `<name>`)" + a rotation indicator if any account is cooling.

New `/api/*` endpoints (all `Content-Type: application/json`; `CLAUDE_ROUTER_ADMIN_TOKEN` guard if set):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/accounts` | — | `{accounts:[…masked], active_id}` (accessToken/refreshToken masked) |
| POST | `/api/accounts/login-url` | `{organization_uuid?}` | `{url, state}` — buildAuthorizeUrl with org-scoped or generic URL |
| POST | `/api/accounts/exchange` | `{code, state, organization_uuid?}` | `{account}` (masked) — exchangeCode + capture org + dedup |
| POST | `/api/accounts/:id/activate` | — | `{ok, active_id}` |
| POST | `/api/accounts/:id/disable` | — | `{ok}` |
| DELETE | `/api/accounts/:id` | — | `{ok, active_id}` |
| POST | `/api/accounts/:id/refresh` | — | `{ok, expiresAt}` |
| GET | `/api/accounts/orgs` | — | `{orgs:[{uuid,name}]}` (calls claude.ai/api/organizations via curl) |

Keep `/login`, `/exchange`, `/logout` (legacy single-token flow) working for backward compat, but the webui preferentially uses the new `/api/accounts/*` flow.

`maskKey`-style masking for tokens on every read path.

---

## 9. Security

- `accounts.json` mode 0600, `CFG_DIR` recursive.
- Tokens masked (`sk-…`-style) on every `/api/accounts*` read; full tokens only accepted/stored server-side, never echoed.
- Localhost-only binding unchanged.
- No CORS (same-origin).
- The `org:create_api_key` scope is REQUESTED but NOT granted on the subscription path (CC grants `user:*` only). It is not needed for inference and not a workspace-selection lever. Leave the SCOPE string as-is for parity with Claude Code / CRS.
- Upstream error containment unchanged (Anthropic-shaped errors, body truncated).

---

## 10. Testing

### 10.1 Extend `selftest()` (offline, no network)
Keep all existing assertions. Add `selftestAccountPool()`:
- `pickAccount()` selection logic: active-available → active; active-cooling → next; all-cooling → null.
- Cooldown application: 429-with-reset sets `cooldown_until=reset`; 429-without sets `now+300s`; 529 sets `now+600s`.
- Dedup: `exchangeCode` mock with an existing `organization_uuid` → rejected.
- Org-scoped URL builder: `buildAuthorizeUrl("org-xyz")` → URL contains `/v1/oauth/org-xyz/authorize`; `buildAuthorizeUrl(null)` → generic authorize.
- Rotation retry budget: a mocked chain of 3 cooling accounts → returns 503 after `MAX_ROTATE_RETRIES`.
- Masking: accessToken masked on `/api/accounts` shape.

### 10.2 Live verification gate (the risky unknown — DO THIS BEFORE BUILDING ROTATION ON TOP)
After implementing §4 (org-scoped login + org capture) but BEFORE §5 rotation:
1. Log in account A (default org). Confirm `accounts[0].organization_uuid` is captured (not null).
2. Log in account B via the org-scoped URL for the 2nd org. **Confirm `accounts[1].organization_uuid` DIFFERS from `accounts[0].organization_uuid`.**
3. If both carry the same org UUID, the org-scoped authorize URL did not bind a distinct org — STOP and report (the fallback is the manual-paste org UUID + org-scoped URL, which must be verified to produce a distinct org).

### 10.3 `--checkbackends`
Extend to report per-account status (active/cooling/disabled) for the oauth backend.

---

## 11. Implementation order (front-load the risky login verification)

1. **accounts.json** schema + `loadAccounts`/`saveAccounts` + migration-from-creds (§7.1). No behavior change yet (single migrated account, `pickAccount` returns it).
2. **Capture org in `exchangeCode`** (§4.1). Stop discarding `organization`/`account`/`subscription`.
3. **Org-scoped authorize URL** + `/api/accounts/orgs` (§4.2, §4.3) + webui org picker.
4. **VERIFICATION GATE (§10.2):** log in two orgs, confirm distinct `organization_uuid`. Do not proceed to rotation until this passes.
5. **Pool-backed selection** in `anthropicPassthrough` (§5.1): replace single `getAccessToken()` with `pickAccount()`.
6. **Rotation** (§5.2): 429/529/401/403/400 handling + retry budget.
7. **Manual switch** webui + `/api/accounts/:id/*` endpoints (§6, §8).
8. **Disable piggyback** when pool non-empty (§7.2).
9. **selftest** additions (§10.1) + `--checkbackends` per-account (§10.3).
10. README update: multi-org pool, org-scoped 2nd login, 429 auto-rotation, manual switch, migration.

---

## 12. Non-regression checklist

- [ ] `curlFetch`/`anthropicFetch` used for ALL Anthropic-bound calls incl. the new `/api/oauth/profile` + `/api/organizations` + org-scoped authorize/token exchange. No raw `fetch` anywhere Anthropic-bound.
- [ ] No `backends.json` + `CLAUDE_ROUTER_API_KEY` set → API-key passthrough byte-identical to today.
- [ ] `accounts.json` empty + `creds.json` present → migrated to `accounts[0]`, inference still works.
- [ ] `accounts.json` non-empty → piggyback on `~/.claude/.credentials.json` disabled.
- [ ] Single-account pool behaves like today's single-creds path (no spurious rotation).
- [ ] 429-quota rotation is transparent to Claude Code for a single request (retry budget).
- [ ] Tokens masked on every `/api/accounts*` read; never written back to `~/.claude/.credentials.json`.
- [ ] Existing `selftest` (PKCE, `mergeBetas`, `headersOAuth`, `headersKey`, translation, SSE) still passes.

---

## 13. Open verifications (Codex: confirm during impl, report if any fails)

1. Does the token response from `platform.claude.com/v1/oauth/token` actually return `organization.uuid` + `account.uuid`? (CRS reads them; VERIFY the field names + that curl reaches it without 403.)
2. Does `https://claude.ai/v1/oauth/{org_uuid}/authorize` mint a token bound to THAT org (distinct `organization.uuid`)? This is the core gate (§10.2).
3. Does `https://claude.ai/api/organizations` (bearer = first account token) return the org list via curl, or 403? (Fallback = manual paste.)
4. Does `https://claude.ai/api/oauth/profile` return org info for the migrated token via curl? (Fallback = mark `unknown`.)
5. Does Anthropic emit `anthropic-ratelimit-unified-reset` on subscription 429, and is its value a daily-quota reset (hours away)? If absent, the 429-no-reset 300s path covers it.
6. Is `x-claude-code-session-id` stable per conversation? (Only relevant if sticky sessions are added later — not needed for v1.)

If verification #2 fails (org-scoped URL does NOT bind a distinct org), STOP and report — the entire pool premise depends on it.

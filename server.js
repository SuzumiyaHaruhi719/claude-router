#!/usr/bin/env node
// claude-router — multi-backend model-name router + Anthropic↔OpenAI translation
// layer + CC-Switch-style profile switcher for Claude Code.
//
//   Claude Code ──POST /v1/messages──▶ claude-router (127.0.0.1) ──▶ backend
//     body.model routes to a backend:
//       format:"anthropic" → byte-identical passthrough (OAuth subscription OR x-api-key)
//       format:"openai"    → translate request/response/SSE to look like Anthropic
//
// One file, zero deps, Node >= 18 (built-in http, crypto, fs, path, os, net, tls, global fetch).
//   node server.js                  # run router + webui
//   node server.js --selftest       # offline self-checks (routing/translation/SSE/mask)
//   node server.js --checkbackends  # live 1-token ping of every configured backend
//
// Backends live at ~/.claude-router/backends.json (mode 0600). If absent, a single-
// backend config is synthesized from CLAUDE_ROUTER_API_KEY / OAuth creds — byte-
// identical to the original single-backend behaviour.
//
// NOTE: OAuth mode drives your Claude Pro/Max subscription via Claude Code's reverse-
// engineered OAuth client. Anthropic's consumer terms restrict programmatic use of
// subscription credentials; these constants may change or be blocked.

"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const tls = require("tls");
const { spawn } = require("child_process");

// --- crash guard ----------------------------------------------------------------
// A localhost proxy serving multiple concurrent Claude Code sessions must NEVER hard-
// crash from a single bad request: a crash aborts EVERY in-flight stream at once, so
// every session sees a truncated response ("API Error: Failed to parse JSON"). The
// usual culprits are async stream 'error' events (EPIPE/ECONNRESET on curl stdin or a
// client socket) that have no listener. Log and keep running instead of exiting.
process.on("uncaughtException", (err) => {
  try { process.stderr.write(`[claude-router] uncaughtException (survived): ${err && err.stack || err}\n`); } catch {}
});
process.on("unhandledRejection", (reason) => {
  try { process.stderr.write(`[claude-router] unhandledRejection (survived): ${reason && reason.stack || reason}\n`); } catch {}
});

// --- constants (reverse-engineered from Claude Code; verified 2026-06-24) --------
const EXPLICIT_PORT = process.env.CLAUDE_ROUTER_PORT || process.env.PORT || "";
const PORT = Number(EXPLICIT_PORT || 8123); // 8787 falls in a Windows excluded range; 8123 is clear
let boundPort = PORT; // actual port after listen (may differ if auto-retried)
const HOST = "127.0.0.1"; // localhost only — this token = full access to your account
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const SCOPE = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const REQUIRED_BETAS = ["oauth-2025-04-20", "claude-code-20250219", "interleaved-thinking-2025-05-14", "context-management-2025-06-27", "prompt-caching-scope-2026-01-05", "fast-mode-2026-02-01", "redact-thinking-2026-02-12", "token-efficient-tools-2026-03-28"];

// Env fallback (existing single-backend modes — feed the synthesizer when no
// backends.json exists, so the no-config + CLAUDE_ROUTER_API_KEY case is byte-
// identical to the original single-file proxy).
const UPSTREAM = (process.env.CLAUDE_ROUTER_UPSTREAM || "https://api.anthropic.com").replace(/\/+$/, "");
const STATIC_KEY = process.env.CLAUDE_ROUTER_API_KEY || "";
const KEY_MODE = !!STATIC_KEY;

// --- config / profile paths ------------------------------------------------------
const CFG_DIR   = path.join(os.homedir(), ".claude-router");          // creds + backends config
const CRED_FILE = path.join(CFG_DIR, "creds.json");                   // existing OAuth tokens
const ACCT_FILE = path.join(CFG_DIR, "accounts.json");                // org-scoped OAuth account pool
const CFG_FILE  = path.join(CFG_DIR, "backends.json");                // NEW — multi-backend config
const CODEX_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json"); // Codex CLI OAuth token (read-only)
const CC_CRED_FILE = path.join(os.homedir(), ".claude", ".credentials.json"); // Claude Code CLI OAuth token (read-only reuse — idiot-proof default)
const CC_SETTINGS        = path.join(os.homedir(), ".claude", "settings.json"); // CC-Switch target
const CC_SETTINGS_LEGACY = path.join(os.homedir(), ".claude", "claude.json");   // CC-Switch fallback
const CC_BACKUP  = path.join(CFG_DIR, "settings-backup.json");        // pre-takeover backup
const REQUEST_LOG_FILE      = path.join(CFG_DIR, "requests.jsonl");          // request audit log (append-only)
const REQUEST_LOG_FILE_1    = path.join(CFG_DIR, "requests.1.jsonl");        // rotated previous log
const REQUEST_TRACE_DIR     = path.join(CFG_DIR, "request-traces");          // optional full traces, one file per request
const REQUEST_SETTINGS_FILE = path.join(CFG_DIR, "request-settings.json");   // inspector settings
const ADMIN_TOKEN = process.env.CLAUDE_ROUTER_ADMIN_TOKEN || "";      // optional guard for /api writes
const DUMMY_KEY = "claude-router"; // non-empty dummy Claude Code sends; router ignores it
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;                            // backend id validation
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/;
const CODEX_RESPONSES_UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_RESPONSES_MODEL = "gpt-5.5";
const GLM_ANTHROPIC_UPSTREAM = "https://dashscope.aliyuncs.com/apps/anthropic";
const GLM_OPENAI_COMPAT_UPSTREAM = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const ORG_AUTHORIZE_PREFIX = "https://claude.ai/v1/oauth";
const OAUTH_PROFILE_URL = "https://claude.ai/api/oauth/profile";
const ORGANIZATIONS_URL = "https://claude.ai/api/organizations";
const MAPPER_TIERS = ["fable", "opus", "sonnet", "haiku"];
const MAPPER_ROUTE_TIERS = ["opus", "sonnet", "haiku", "fable"];
const MAPPER_DEFAULT_MODELS = {
  fable: "gpt-5.5-xhigh",
  opus: "claude-opus-4-8",
  sonnet: "glm-5.2",
  haiku: "gpt-5.5-instant",
};
const CODEX_MAPPER_MODELS = [
  { id: "gpt-5.5", display: "GPT-5.5" },
  { id: "gpt-5.5-low", display: "GPT-5.5 (low)" },
  { id: "gpt-5.5-medium", display: "GPT-5.5 (medium)" },
  { id: "gpt-5.5-high", display: "GPT-5.5 (high)" },
  { id: "gpt-5.5-xhigh", display: "GPT-5.5 (xhigh)" },
  { id: "gpt-5.5-max", display: "GPT-5.5 (max)" },
  { id: "gpt-5.5-instant", display: "GPT-5.5 (instant)" },
];
const MAX_ROTATE_RETRIES = 3;
const THROTTLE_DEFAULTS = {
  maxConcurrency: 5,
  maxRetries: 3,
  baseBackoffMs: 800,
  maxBackoffMs: 10000,
  minIntervalMs: 350,
};

// --- credential store ------------------------------------------------------------
// Idiot-proof default: the router reuses the Claude Code CLI's own login
// (~/.claude/.credentials.json -> claudeAiOauth.accessToken) when present, so the
// user never has to paste a code#state via the webui — "logged into Claude Code"
// IS the router's login. Read-only: the Claude Code CLI refreshes the token itself
// (we never POST to the token endpoint, so we never rotate/compete with the CLI).
// Falls back to the router's own creds.json (webui login, refreshable) only if the
// Claude Code file is absent (e.g. Claude Code not installed / not logged in).
function loadClaudeCodeCreds() {
  try {
    const o = JSON.parse(fs.readFileSync(CC_CRED_FILE, "utf8")).claudeAiOauth;
    if (!o || !o.accessToken) return null;
    return { access_token: o.accessToken, refresh_token: o.refreshToken || "", expires_at: Number(o.expiresAt || 0), read_only: true };
  } catch { return null; }
}
function loadRouterCreds() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, "utf8")); } catch { return null; }
}
function loadCreds() {
  const store = loadAccounts();
  const picked = pickAccount(store);
  if (picked && picked.claudeAiOauth && picked.claudeAiOauth.accessToken) return accountToLegacyCreds(picked);
  const cc = loadClaudeCodeCreds();
  if (cc && cc.access_token) return cc;           // default: reuse Claude Code's login until accounts.json exists
  return loadRouterCreds();
}
function saveCreds(c) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}
function clearCreds() { try { fs.unlinkSync(CRED_FILE); } catch {} }
function clearAccounts() { try { fs.unlinkSync(ACCT_FILE); } catch {} }

// --- OAuth account pool ----------------------------------------------------------
function stringOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function firstString(...values) {
  for (const v of values) {
    const s = stringOrNull(v);
    if (s) return s;
  }
  return "";
}
function firstUuid(...values) {
  return firstString(...values) || null;
}
function normalizeScopes(v) {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  if (typeof v === "string") return v.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  return [];
}
function nextAccountId(accounts) {
  let max = 0;
  for (const a of accounts || []) {
    const m = String(a && a.id || "").match(/^acct_(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return "acct_" + String(max + 1).padStart(2, "0");
}
function normalizeAccount(a) {
  if (!a || typeof a !== "object") a = {};
  const oauth = a.claudeAiOauth && typeof a.claudeAiOauth === "object" ? a.claudeAiOauth : {};
  const status = ["active", "cooldown", "disabled"].includes(a.status) ? a.status : "active";
  return {
    id: String(a.id || ""),
    label: String(a.label || a.organization_name || a.email || a.id || "Claude account"),
    email: stringOrNull(a.email),
    organization_uuid: a.organization_uuid == null ? null : String(a.organization_uuid),
    organization_name: stringOrNull(a.organization_name),
    account_uuid: stringOrNull(a.account_uuid),
    claudeAiOauth: {
      accessToken: String(oauth.accessToken || a.access_token || ""),
      refreshToken: String(oauth.refreshToken || a.refresh_token || ""),
      expiresAt: Number(oauth.expiresAt || a.expires_at || 0),
    },
    scopes: normalizeScopes(a.scopes || a.scope),
    subscriptionType: stringOrNull(a.subscriptionType || a.subscription_type),
    rateLimitTier: stringOrNull(a.rateLimitTier || a.rate_limit_tier),
    status,
    cooldown_until: a.cooldown_until == null ? null : Number(a.cooldown_until || 0),
    cooldown_reason: a.cooldown_reason == null ? null : String(a.cooldown_reason),
    rate_limit_reset_at: a.rate_limit_reset_at == null ? null : Number(a.rate_limit_reset_at || 0),
    last_429_at: a.last_429_at == null ? null : Number(a.last_429_at || 0),
    created_at: Number(a.created_at || Date.now()),
  };
}
function normalizeAccountsStore(raw) {
  const store = raw && typeof raw === "object" ? raw : {};
  const accounts = Array.isArray(store.accounts) ? store.accounts.map(normalizeAccount).filter((a) => a.id) : [];
  let active_id = store.active_id && accounts.some((a) => a.id === store.active_id) ? String(store.active_id) : null;
  if (!active_id && accounts.length) active_id = accounts[0].id;
  return { version: 1, accounts, active_id };
}
function loadAccounts(file = ACCT_FILE) {
  try { return normalizeAccountsStore(JSON.parse(fs.readFileSync(file, "utf8"))); }
  catch { return { version: 1, accounts: [], active_id: null }; }
}
function saveAccounts(store, file = ACCT_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalizeAccountsStore(store), null, 2), { mode: 0o600 });
}
function accountToLegacyCreds(account) {
  const oauth = account && account.claudeAiOauth || {};
  return {
    access_token: oauth.accessToken || "",
    refresh_token: oauth.refreshToken || "",
    expires_at: Number(oauth.expiresAt || 0),
  };
}
function accountAvailable(account, now = Date.now()) {
  return !!account && account.status !== "disabled" && Number(account.cooldown_until || 0) <= now;
}
function pickAccount(store = loadAccounts(), now = Date.now(), excludeIds = new Set()) {
  const accounts = (store && store.accounts) || [];
  if (!accounts.length) return null;
  const excluded = excludeIds instanceof Set ? excludeIds : new Set(excludeIds || []);
  const active = accounts.find((x) => x.id === store.active_id);
  if (active && !excluded.has(active.id) && accountAvailable(active, now)) return active;
  return accounts.find((x) => !excluded.has(x.id) && accountAvailable(x, now)) || null;
}
function maskedAccount(account) {
  const a = normalizeAccount(account);
  return {
    ...a,
    claudeAiOauth: {
      accessToken: maskKey(a.claudeAiOauth.accessToken),
      refreshToken: maskKey(a.claudeAiOauth.refreshToken),
      expiresAt: a.claudeAiOauth.expiresAt,
    },
  };
}
function maskAccountsStore(store) {
  const s = normalizeAccountsStore(store);
  return { version: s.version, active_id: s.active_id, accounts: s.accounts.map(maskedAccount) };
}
function duplicateOrgError(orgUuid) {
  const e = new Error(`org already in pool: ${orgUuid}`);
  e.status = 409;
  return e;
}
function buildAccountFromTokenResponse(t, opts = {}) {
  const now = opts.now || Date.now();
  const organization = t && typeof t.organization === "object" ? t.organization : {};
  const account = t && typeof t.account === "object" ? t.account : {};
  const subscription = t && typeof t.subscription === "object" ? t.subscription : {};
  const plan = t && typeof t.plan === "object" ? t.plan : {};
  const organization_uuid = firstUuid(
    organization.uuid, organization.id, t && t.organization_uuid, t && t.org_uuid
  ) || "unknown";
  const organization_name = firstString(organization.name, organization.display_name, t && t.organization_name);
  const account_uuid = firstUuid(account.uuid, account.id, t && t.account_uuid);
  const email = firstString(account.email, t && t.email);
  const expiresAt = now + (Number(t && t.expires_in) || 0) * 1000;
  const label = firstString(opts.label, organization_name, email, organization_uuid === "unknown" ? "" : `Org ${organization_uuid.slice(-4)}`) || "Claude account";
  return normalizeAccount({
    id: opts.id || "",
    label,
    email,
    organization_uuid,
    organization_name,
    account_uuid,
    claudeAiOauth: {
      accessToken: String(t && t.access_token || ""),
      refreshToken: String(t && t.refresh_token || ""),
      expiresAt,
    },
    scopes: normalizeScopes((t && (t.scopes || t.scope)) || opts.scopes),
    subscriptionType: firstString(subscription.type, subscription.subscription_type, plan.type, t && t.subscriptionType, t && t.subscription_type),
    rateLimitTier: firstString(t && t.rateLimitTier, t && t.rate_limit_tier, subscription.rateLimitTier, subscription.rate_limit_tier, plan.rateLimitTier, plan.rate_limit_tier),
    status: "active",
    cooldown_until: null,
    cooldown_reason: null,
    rate_limit_reset_at: null,
    last_429_at: null,
    created_at: now,
  });
}
function addAccountToStore(store, account) {
  const s = normalizeAccountsStore(store);
  const org = account && account.organization_uuid;
  const existing = (org && org !== "unknown") ? s.accounts.find((a) => a.organization_uuid === org) : null;
  if (existing) {
    // ponytail: re-login of an existing org REPLACES that account (refresh the token,
    // keep id + label, clear cooldown) — so a stale-token re-login doesn't require
    // Remove-first. ceiling: two concurrent re-logins of the same org race (last wins);
    // per-account locks if throughput ever matters.
    Object.assign(existing, normalizeAccount({ ...account, id: existing.id, label: existing.label }));
    store.version = s.version;
    store.accounts = s.accounts;
    store.active_id = s.active_id;
    return existing;
  }
  const a = normalizeAccount({ ...account, id: account.id || nextAccountId(s.accounts) });
  s.accounts.push(a);
  if (!s.active_id) s.active_id = a.id;
  store.version = s.version;
  store.accounts = s.accounts;
  store.active_id = s.active_id;
  return a;
}
function addTokenResponseToAccounts(t, opts = {}) {
  const store = loadAccounts();
  const account = buildAccountFromTokenResponse(t, opts);
  const added = addAccountToStore(store, account);
  saveAccounts(store);
  return added;
}
function legacyCredsToAccount(creds, source) {
  const o = creds && creds.claudeAiOauth ? creds.claudeAiOauth : null;
  return normalizeAccount({
    id: "acct_01",
    label: source === "claude-code" ? "Claude Code login" : "Router OAuth login",
    organization_uuid: null,
    organization_name: null,
    account_uuid: null,
    claudeAiOauth: {
      accessToken: String((o && o.accessToken) || (creds && creds.access_token) || ""),
      refreshToken: String((o && o.refreshToken) || (creds && creds.refresh_token) || ""),
      expiresAt: Number((o && o.expiresAt) || (creds && creds.expires_at) || 0),
    },
    status: "active",
    created_at: Date.now(),
  });
}
function oauthHeaders(token) {
  return {
    "authorization": `Bearer ${token}`,
    "accept": "application/json, text/plain, */*",
    "user-agent": "claude-cli/1.0.57 (external, cli)",
    "accept-language": "en-US,en;q=0.9",
    "referer": "https://claude.ai/",
    "origin": "https://claude.ai",
  };
}
async function anthropicJson(url, token) {
  const res = await anthropicFetch(url, { method: "GET", headers: oauthHeaders(token) });
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`${res.status} ${text.slice(0, 300)}`);
    e.status = res.status;
    e.body = text;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}
function applyProfileToAccount(account, profile) {
  if (!profile || typeof profile !== "object") return account;
  const org = profile.organization || profile.active_organization || profile.current_organization || {};
  const acct = profile.account || profile.user || {};
  const orgUuid = firstUuid(org.uuid, org.id, profile.organization_uuid, profile.organizationId);
  const orgName = firstString(org.name, org.display_name, profile.organization_name);
  const accountUuid = firstUuid(acct.uuid, acct.id, profile.account_uuid, profile.accountId);
  const email = firstString(acct.email, profile.email);
  if (orgUuid) account.organization_uuid = orgUuid;
  if (orgName) account.organization_name = orgName;
  if (accountUuid) account.account_uuid = accountUuid;
  if (email) account.email = email;
  if ((!account.label || /^(Claude (Code login|account)|Router OAuth login)$/.test(account.label)) && (orgName || email)) account.label = orgName || email;
  return account;
}
function parseOrganizations(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload && payload.organizations) ? payload.organizations : Array.isArray(payload && payload.data) ? payload.data : [];
  return list.map((o) => ({
    uuid: firstUuid(o && o.uuid, o && o.id, o && o.organization_uuid),
    name: firstString(o && o.name, o && o.display_name, o && o.organization_name),
  })).filter((o) => o.uuid);
}
async function recoverAccountProfile(account) {
  const token = account && account.claudeAiOauth && account.claudeAiOauth.accessToken;
  if (!token) return account;
  try {
    applyProfileToAccount(account, await anthropicJson(OAUTH_PROFILE_URL, token));
    if (!account.organization_uuid) account.organization_uuid = "unknown";
  } catch {
    if (!account.organization_uuid) account.organization_uuid = "unknown";
  }
  return account;
}
async function migrateAccountsFromCreds() {
  if (fs.existsSync(ACCT_FILE)) return loadAccounts();
  const routerCreds = loadRouterCreds();
  const source = routerCreds && routerCreds.access_token ? "router" : "claude-code";
  const legacy = routerCreds && routerCreds.access_token ? routerCreds : loadClaudeCodeCreds();
  if (!legacy || !legacy.access_token) return loadAccounts();
  const store = { version: 1, accounts: [legacyCredsToAccount(legacy, source)], active_id: "acct_01" };
  await recoverAccountProfile(store.accounts[0]);
  saveAccounts(store);
  return normalizeAccountsStore(store);
}
async function accountsForUse() {
  if (fs.existsSync(ACCT_FILE)) return loadAccounts();
  return migrateAccountsFromCreds();
}
async function refreshAccountInStore(store, account) {
  const refreshToken = account && account.claudeAiOauth && account.claudeAiOauth.refreshToken;
  if (!refreshToken) throw new Error("account has no refresh token");
  const res = await anthropicFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "claude-cli/1.0.56 (external, cli)",
      "accept": "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      "referer": "https://claude.ai/",
      "origin": "https://claude.ai",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Refresh failed (${res.status}): ${text.slice(0, 300)}`);
  const t = JSON.parse(text);
  const updated = buildAccountFromTokenResponse({ ...t, refresh_token: t.refresh_token || refreshToken }, {
    id: account.id,
    label: account.label,
    now: Date.now(),
  });
  Object.assign(account, {
    email: updated.email || account.email,
    organization_uuid: updated.organization_uuid !== "unknown" ? updated.organization_uuid : account.organization_uuid,
    organization_name: updated.organization_name || account.organization_name,
    account_uuid: updated.account_uuid || account.account_uuid,
    claudeAiOauth: updated.claudeAiOauth,
    scopes: updated.scopes.length ? updated.scopes : account.scopes,
    subscriptionType: updated.subscriptionType || account.subscriptionType,
    rateLimitTier: updated.rateLimitTier || account.rateLimitTier,
  });
  return account;
}
async function ensureAccountAccessToken(store, account, force = false) {
  if (!account || !account.claudeAiOauth) return "";
  if ((force || Date.now() > Number(account.claudeAiOauth.expiresAt || 0) - 60_000) && account.claudeAiOauth.refreshToken) {
    await refreshAccountInStore(store, account);
    saveAccounts(store);
  }
  return account.claudeAiOauth.accessToken;
}
async function listAccountOrganizations() {
  const store = await accountsForUse();
  const account = pickAccount(store);
  if (!account) return { orgs: [], manual: true, error: "no available account token for organization lookup" };
  const token = await ensureAccountAccessToken(store, account);
  try {
    return { orgs: parseOrganizations(await anthropicJson(ORGANIZATIONS_URL, token)) };
  } catch (e) {
    if (e.status === 403) return { orgs: [], manual: true, error: String(e.message || e) };
    throw e;
  }
}

// --- Codex CLI creds (READ-ONLY) ------------------------------------------------
// The Codex CLI logs into the ChatGPT subscription and stores its OAuth token at
// ~/.codex/auth.json: {auth_mode:"chatgpt", tokens:{access_token, refresh_token,
// id_token, account_id}, last_refresh}. We read tokens.access_token ONLY — never
// refresh it (the Codex CLI refreshes it itself; rotating it here would break the
// user's Codex CLI). expires_at is decoded best-effort from the JWT `exp` claim so
// callers can surface staleness; absence just means "unknown".
function loadCodexCreds() {
  try {
    const j = JSON.parse(fs.readFileSync(CODEX_AUTH_FILE, "utf8"));
    const tok = j && j.tokens && j.tokens.access_token;
    if (!tok) return null;
    let expires_at;
    try {
      const parts = String(tok).split(".");
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
        if (payload && typeof payload.exp === "number") expires_at = payload.exp * 1000;
      }
    } catch { /* not a JWT or unparseable — leave expires_at undefined */ }
    return { access_token: tok, expires_at };
  } catch { return null; }
}

// --- PKCE ------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function makePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

// in-memory pending login (verifier + state), set by /login, consumed by /exchange
let pending = null;

function parseOAuthCode(raw) {
  const s = String(raw || "").trim();
  const hash = s.indexOf("#");
  const code = (hash >= 0 ? s.slice(0, hash) : s).split("&")[0].trim();
  const state = hash >= 0 ? s.slice(hash + 1).split("&")[0].trim() : "";
  return { code, state };
}

function buildAuthorizeUrl(organization_uuid = null) {
  const { verifier, challenge } = makePkce();
  const state = b64url(crypto.randomBytes(32));
  const org = stringOrNull(organization_uuid);
  pending = { verifier, state, organization_uuid: org };
  const q = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  const base = org ? `${ORG_AUTHORIZE_PREFIX}/${encodeURIComponent(org)}/authorize` : AUTHORIZE_URL;
  return `${base}?${q}`;
}

async function exchangeCode(raw, opts = {}) {
  if (!pending) throw new Error('No pending login — click "Login" first.');
  // CRS-aligned: clean the code (strip #fragment and &params), then exchange at
  // platform.claude.com (console.anthropic.com is dead — returns 403/404 post-migration).
  // The token endpoint fingerprint-checks the official client: it requires the
  // claude-cli User-Agent + an Origin/Referer of https://claude.ai, else 403.
  // Uses anthropicFetch (curl) — the token endpoint has the same TLS gate as /v1/messages.
  const parsed = parseOAuthCode(raw);
  const code = parsed.code;
  if (!code) throw new Error("Empty authorization code.");
  if (opts.state && pending.state !== opts.state) throw new Error("OAuth state mismatch.");
  if (parsed.state && pending.state !== parsed.state) throw new Error("OAuth state mismatch.");
  const res = await anthropicFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "claude-cli/1.0.56 (external, cli)",
      "accept": "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      "referer": "https://claude.ai/",
      "origin": "https://claude.ai",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      code_verifier: pending.verifier,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: pending.state,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Token exchange failed (${res.status}): ${text}`);
  const t = JSON.parse(text);
  const account = addTokenResponseToAccounts(t, { label: opts.label });
  pending = null;
  return account;
}

async function refreshCreds(creds) {
  const res = await anthropicFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "claude-cli/1.0.56 (external, cli)",
      "accept": "application/json, text/plain, */*",
      "accept-language": "en-US,en;q=0.9",
      "referer": "https://claude.ai/",
      "origin": "https://claude.ai",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: CLIENT_ID,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Refresh failed (${res.status})`);
  const t = JSON.parse(text);
  const c = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || creds.refresh_token,
    expires_at: Date.now() + (Number(t.expires_in) || 0) * 1000,
  };
  saveCreds(c);
  return c;
}

// Returns a usable access token. For the router's own creds.json (webui login),
// refresh if within 60s of expiry. For read-only Claude-Code-reused creds, never
// refresh (the CLI does it) — just re-read the file if it looks expired.
async function getAccessToken() {
  const store = await accountsForUse();
  if (store.accounts.length) {
    const account = pickAccount(store);
    if (!account) return null;
    try { return await ensureAccountAccessToken(store, account); }
    catch { return null; }
  }
  let c = loadCreds();
  if (!c || !c.access_token) return null;
  if (c.read_only) {
    if (Date.now() > (c.expires_at || 0) - 60_000) {
      // possibly stale — re-read (Claude Code may have refreshed it since)
      const fresh = loadCreds();
      if (fresh && fresh.access_token) return fresh.access_token;
    }
    return c.access_token;
  }
  if (Date.now() > (c.expires_at || 0) - 60_000 && c.refresh_token) {
    try { c = await refreshCreds(c); } catch { return null; }
  }
  return c.access_token;
}

// --- header helpers (existing, unchanged — the iron-clad anthropic passthrough) ---
// Official Claude Code client identity (mirrors CRS claudeCodeHeadersService defaults).
// Anthropic's /v1/messages gate fingerprint-checks these on subscription-OAuth tokens;
// when Claude Code is the caller they arrive in `incoming` and pass through, but we
// inject defaults for any that are missing so the OAuth backend is robust standalone.
const CC_DEFAULT_HEADERS = {
  "x-stainless-retry-count": "0",
  "x-stainless-timeout": "60",
  "x-stainless-lang": "js",
  "x-stainless-package-version": "0.55.1",
  "x-stainless-os": "Windows",
  "x-stainless-arch": "x64",
  "x-stainless-runtime": "node",
  "x-stainless-runtime-version": "v20.19.2",
  // anthropic-dangerous-direct-browser-access DROPPED: real CC CLI does NOT send it on
  // OAuth (CLIProxyAPI comment) — it's API-key-mode only; sending it on OAuth trips the
  // 429 soft-block body-content classifier.
  "x-app": "cli",
  "user-agent": "claude-cli/2.1.191 (external, cli)",
  "accept-language": "*",
  "sec-fetch-mode": "cors",
};
// Copy client headers minus the ones we replace / hop-by-hop ones.
function baseHeaders(incoming, alsoStrip) {
  const strip = new Set(["host", "content-length", "connection", "accept-encoding", ...alsoStrip]);
  const out = {};
  for (const [k, v] of Object.entries(incoming)) {
    if (!strip.has(k.toLowerCase())) out[k] = v;
  }
  if (!out["anthropic-version"]) out["anthropic-version"] = "2023-06-01";
  return out;
}
// OAuth mode: drop the client's auth, inject the OAuth bearer, union anthropic-beta,
// and ensure the official-client identity headers are present (inject defaults if the
// caller didn't send them) so the subscription token is accepted on /v1/messages.
function headersOAuth(incoming, token) {
  const out = baseHeaders(incoming, ["x-api-key", "authorization", "anthropic-beta"]);
  out["authorization"] = `Bearer ${token}`;
  out["anthropic-beta"] = mergeBetas(incoming["anthropic-beta"]);
  for (const [k, v] of Object.entries(CC_DEFAULT_HEADERS)) {
    if (out[k] == null) out[k] = v;
  }
  return out;
}
// Key mode: forward to the configured upstream with x-api-key; pass the client's
// betas through untouched (no oauth beta — this is a plain API-key request).
function headersKey(incoming, key) {
  const out = baseHeaders(incoming, ["x-api-key", "authorization"]);
  out["x-api-key"] = key;
  return out;
}

// --- curl-based upstream (TLS-fingerprint gate bypass) ---------------------------
// Anthropic's /v1/messages + /v1/oauth/token gate on the HTTP client's TLS/transport
// fingerprint: Node fetch (undici, HTTP/2) AND Node https (HTTP/1.1) both get 403
// "Request not allowed"; curl is accepted (verified: same token+headers+body → curl
// 429 rate-limit-accepted, Node 403). So Anthropic-bound calls (OAuth login + the
// subscription backend's inference + any anthropic-format backend's passthrough) go
// through curlFetch. Returns a fetch-like Response so streamUpstream/exchange code is
// unchanged. Streams SSE via curl -N. DO NOT REPLACE WITH fetch ANYWHERE ANTHROPIC-BOUND.
const HAVE_CURL = (() => { try { require("child_process").execFileSync("curl", ["--version"], { stdio: "ignore", windowsHide: true }); return true; } catch { return false; } })();

function curlFetch(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-sS", "-i", "-N", "--no-buffer", "--max-time", "180", url, "-X", String(method)];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    args.push("-H", "Expect:"); // disable Expect:100-continue (its 100 preamble breaks -i parsing)
    // Send the body via STDIN (--data-binary @-) as raw bytes — NOT as a CLI argument.
    // Passing it on argv mangles non-ASCII (CJK/emoji → "surrogates not allowed" 400 from
    // Anthropic) and overflows the Windows ~32KB command-line limit for large opus bodies.
    // Buffer keeps the exact UTF-8 bytes; @- reads stdin verbatim. (memory: windows-http-utf8-testing)
    const bodyBuf = (body != null && body !== "")
      ? (Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8"))
      : null;
    if (bodyBuf) args.push("--data-binary", "@-");
    let child;
    try { child = spawn("curl", args, { windowsHide: true }); }
    catch (e) { return reject(new Error("curl spawn failed: " + e.message)); }
    // CRITICAL: curl can close stdin before reading the whole body (connection failure,
    // early error response). That makes child.stdin emit an ASYNC 'error' event (EPIPE) —
    // with no listener, Node throws it as an uncaught exception and the ENTIRE router
    // process crashes, aborting every in-flight stream (→ "Failed to parse JSON" for all
    // concurrent Claude Code sessions). Swallow it; the request fails cleanly on its own.
    if (child.stdin) child.stdin.on("error", () => {});
    if (bodyBuf) { try { child.stdin.write(bodyBuf); child.stdin.end(); } catch (e) { /* EPIPE if curl exits early */ } }
    else { try { child.stdin.end(); } catch {} }
    let prelude = Buffer.alloc(0);
    let preludeDone = false;
    const queued = [];
    let waiter = null;
    let childDone = false;
    let stderr = "";
    let resolved = false;
    let exitCode = null;
    child.stderr.on("data", (c) => { stderr += c.toString("utf8"); });
    child.stdout.on("data", (chunk) => {
      if (!preludeDone) {
        prelude = Buffer.concat([prelude, chunk]);
        // Skip any HTTP/1.1 100 Continue preambles, then parse the real status+headers.
        while (true) {
          const idx = prelude.indexOf("\r\n\r\n");
          if (idx === -1) return; // need more bytes
          const headPart = prelude.slice(0, idx).toString("utf8");
          const firstLine = headPart.split("\r\n")[0];
          const st = parseInt((firstLine.match(/HTTP\/[\d.]+\s+(\d+)/) || [])[1] || "0", 10);
          const reason = firstLine.replace(/^HTTP\/[\d.]+\s+\d+\s*/, "").trim();
          // Skip 100-continue AND HTTP-proxy CONNECT preambles ("200 Connection established"),
          // which curl -i emits when HTTPS_PROXY (e.g. Clash) tunnels the request. The real
          // Anthropic response follows; without skipping, the proxy's 200 is mistaken for the
          // upstream status and the real status+headers leak into the body.
          if (st === 100 || (st === 200 && /connection established/i.test(reason))) { prelude = prelude.slice(idx + 4); continue; }
          const rest = prelude.slice(idx + 4);
          preludeDone = true;
          const lines = headPart.split("\r\n");
          const status = st;
          const hdrs = new Map();
          for (const l of lines.slice(1)) { const i = l.indexOf(":"); if (i > 0) hdrs.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim()); }
          const bodyObj = { getReader: () => ({ read: () => new Promise((res) => {
            if (queued.length) res({ done: false, value: queued.shift() });
            else if (childDone) res({ done: true });
            else waiter = res;
          }) }) };
          const resp = {
            status, ok: status >= 200 && status < 300, headers: hdrs, body: bodyObj,
            async text() { const parts = []; for (;;) { const r = await bodyObj.getReader().read(); if (r.done) break; parts.push(r.value); } return Buffer.concat(parts).toString("utf8"); },
            async json() { return JSON.parse(await this.text()); },
          };
          if (rest.length) queued.push(rest);
          resolved = true;
          resolve(resp);
          return;
        }
      }
      if (waiter) { const w = waiter; waiter = null; w({ done: false, value: chunk }); }
      else queued.push(chunk);
    });
    const finish = () => {
      childDone = true;
      if (waiter) { const w = waiter; waiter = null; w({ done: true }); }
      if (!resolved) reject(new Error("curl produced no upstream response" + (exitCode != null ? ` (exit ${exitCode})` : "") + (stderr ? " | " + stderr.slice(0, 300) : "")));
    };
    child.stdout.on("end", finish);
    child.on("error", (e) => { if (!resolved) reject(new Error("curl error: " + e.message)); });
    child.on("exit", (code) => { exitCode = code; finish(); });
  });
}

function envValue(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return "";
}
function noProxyMatches(host) {
  const noProxy = envValue("NO_PROXY", "no_proxy");
  if (!noProxy) return false;
  const h = String(host || "").toLowerCase();
  return noProxy.split(",").map((s) => s.trim().toLowerCase()).some((rule) => {
    if (!rule) return false;
    if (rule === "*") return true;
    if (rule.startsWith(".")) return h.endsWith(rule);
    return h === rule || h.endsWith("." + rule);
  });
}
function httpProxyFor(targetUrl) {
  const u = new URL(targetUrl);
  if (u.protocol !== "https:" || noProxyMatches(u.hostname)) return null;
  const raw = envValue("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy");
  if (!raw) return null;
  const p = new URL(raw);
  if (p.protocol !== "http:") return null;
  return p;
}
function connectViaHttpProxy(target, proxy) {
  return new Promise((resolve, reject) => {
    const proxyPort = Number(proxy.port || 80);
    const sock = net.connect(proxyPort, proxy.hostname);
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      sock.removeAllListeners("data");
      sock.removeAllListeners("error");
      sock.removeAllListeners("timeout");
      if (err) { try { sock.destroy(); } catch {} reject(err); }
      else resolve(value);
    };
    sock.setTimeout(30_000, () => done(new Error("proxy CONNECT timeout")));
    sock.on("error", done);
    sock.on("connect", () => {
      const auth = proxy.username ? `Proxy-Authorization: Basic ${Buffer.from(decodeURIComponent(proxy.username) + ":" + decodeURIComponent(proxy.password || "")).toString("base64")}\r\n` : "";
      sock.write(`CONNECT ${target.hostname}:443 HTTP/1.1\r\nHost: ${target.hostname}:443\r\n${auth}Proxy-Connection: Keep-Alive\r\n\r\n`);
    });
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString("latin1");
      const rest = buf.slice(idx + 4);
      if (!/^HTTP\/\S+\s+200\b/i.test(head)) return done(new Error("proxy CONNECT failed: " + head.split("\r\n")[0]));
      if (rest.length) sock.unshift(rest);
      sock.setTimeout(0);
      const secure = tls.connect({ socket: sock, servername: target.hostname, ALPNProtocols: ["http/1.1"] });
      secure.setTimeout(30_000, () => { secure.destroy(new Error("TLS timeout")); });
      secure.once("secureConnect", () => done(null, secure));
      secure.once("error", done);
    });
  });
}
function nodeProxyFetch(url, { method = "GET", headers = {}, body } = {}) {
  const proxy = httpProxyFor(url);
  if (!proxy) return fetch(url, { method, headers, body });
  return new Promise(async (resolve, reject) => {
    let secure;
    try {
      const target = new URL(url);
      secure = await connectViaHttpProxy(target, proxy);
      const bodyBuf = body == null || body === "" ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
      const outHeaders = { ...headers };
      outHeaders.host = target.hostname;
      outHeaders.connection = "close";
      if (bodyBuf && outHeaders["content-length"] == null && outHeaders["Content-Length"] == null) outHeaders["content-length"] = String(bodyBuf.length);
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => secure;
      const req = http.request({
        host: target.hostname,
        path: target.pathname + target.search,
        method: String(method),
        headers: outHeaders,
        agent,
        timeout: 180_000,
      }, (r) => {
        const queued = [];
        let waiter = null;
        let ended = false;
        r.on("data", (chunk) => {
          if (waiter) { const w = waiter; waiter = null; w({ done: false, value: chunk }); }
          else queued.push(chunk);
        });
        r.on("end", () => {
          ended = true;
          if (waiter) { const w = waiter; waiter = null; w({ done: true }); }
        });
        r.on("error", (e) => {
          ended = true;
          if (waiter) { const w = waiter; waiter = null; w({ done: true }); }
          reject(e);
        });
        const bodyObj = { getReader: () => ({ read: () => new Promise((res) => {
          if (queued.length) res({ done: false, value: queued.shift() });
          else if (ended) res({ done: true });
          else waiter = res;
        }) }) };
        resolve({
          status: r.statusCode || 0,
          ok: (r.statusCode || 0) >= 200 && (r.statusCode || 0) < 300,
          headers: { get: (k) => r.headers[String(k).toLowerCase()] },
          body: bodyObj,
          async text() {
            const parts = [];
            for (;;) {
              const x = await bodyObj.getReader().read();
              if (x.done) break;
              parts.push(x.value);
            }
            return Buffer.concat(parts).toString("utf8");
          },
        });
      });
      req.on("timeout", () => req.destroy(new Error("proxy request timeout")));
      req.on("error", reject);
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    } catch (e) {
      if (secure && !secure.destroyed) secure.destroy();
      reject(e);
    }
  });
}

// Anthropic-bound fetch: prefer curl (TLS bypass). If curl itself cannot complete
// TLS in this sandbox, fall back to a zero-dep HTTPS-over-CONNECT path when a local
// HTTP proxy is configured; otherwise use Node fetch only when curl is absent.
// IRON RULE: all Anthropic-bound calls (exchangeCode/refreshCreds, the oauth backend's
// /v1/messages, any anthropic-format backend passthrough, anthropic testBackend) go
// through here — never plain fetch — or the subscription 403 returns.
async function anthropicFetch(url, opts) {
  if (HAVE_CURL) {
    try { return await curlFetch(url, opts); }
    catch (e) {
      if (httpProxyFor(url)) return nodeProxyFetch(url, opts);
      throw e;
    }
  }
  return nodeProxyFetch(url, opts);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  const v = Number.isFinite(n) ? Math.trunc(n) : fallback;
  return Math.max(min, max == null ? v : Math.min(max, v));
}

function throttleConfigFromBackend(b) {
  const maxConcurrency = clampInt(b.maxConcurrency, THROTTLE_DEFAULTS.maxConcurrency, 1, 50);
  const maxRetries = clampInt(b.maxRetries, THROTTLE_DEFAULTS.maxRetries, 0, 6);
  const baseBackoffMs = clampInt(b.baseBackoffMs, THROTTLE_DEFAULTS.baseBackoffMs, 0, 60_000);
  const maxBackoffMs = Math.max(baseBackoffMs, clampInt(b.maxBackoffMs, THROTTLE_DEFAULTS.maxBackoffMs, 0, 120_000));
  const minIntervalMs = clampInt(b.minIntervalMs, THROTTLE_DEFAULTS.minIntervalMs, 0, 60_000);
  return { maxConcurrency, maxRetries, baseBackoffMs, maxBackoffMs, minIntervalMs };
}

const throttleStates = new Map();
function throttleState(id) {
  const key = String(id || "default");
  let st = throttleStates.get(key);
  if (!st) {
    st = { inFlight: 0, queue: [], nextDispatchAt: 0, rateChain: Promise.resolve(), totalRetries: 0 };
    throttleStates.set(key, st);
  }
  return st;
}
function throttleSnapshot(id) {
  const st = throttleState(id);
  return { inFlight: st.inFlight, queued: st.queue.length, totalRetries: st.totalRetries };
}
function throttleStatsForConfig(cfg) {
  const out = {};
  for (const b of cfg.backends || []) if (b.throttle) out[b.id] = throttleSnapshot(b.id);
  return out;
}
function acquireThrottleSlot(st, cfg) {
  return new Promise((resolve) => {
    if (st.inFlight < cfg.maxConcurrency) { st.inFlight++; resolve(); return; }
    st.queue.push(() => { st.inFlight++; resolve(); });
  });
}
function releaseThrottleSlot(st) {
  st.inFlight = Math.max(0, st.inFlight - 1);
  const next = st.queue.shift();
  if (next) next();
}
function throttleRateGate(st, cfg) {
  const p = st.rateChain.then(async () => {
    const wait = Math.max(0, st.nextDispatchAt - Date.now());
    if (wait > 0) await sleep(wait);
    st.nextDispatchAt = Date.now() + cfg.minIntervalMs;
  });
  st.rateChain = p.catch(() => {});
  return p;
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }
function headerGet(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || headers.get(String(name).toLowerCase()) || "";
  const key = Object.keys(headers).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return key ? headers[key] : "";
}
function throttleBackoffMs(attempt, cfg, retryAfterHeader) {
  let ms = cfg.baseBackoffMs * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
  if (retryAfterHeader) {
    const ra = parseFloat(retryAfterHeader);
    if (!Number.isNaN(ra)) ms = Math.max(ms, ra * 1000);
  }
  return Math.min(ms, cfg.maxBackoffMs);
}
function isThrottleRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504 || status === 529;
}
function wrapThrottleResponse(resp, release) {
  let released = false;
  const done = () => { if (!released) { released = true; release(); } };
  const body = resp.body && typeof resp.body.getReader === "function" ? {
    getReader() {
      const reader = resp.body.getReader();
      return {
        async read() {
          try {
            const r = await reader.read();
            if (r.done) done();
            return r;
          } catch (e) { done(); throw e; }
        },
        releaseLock() { if (typeof reader.releaseLock === "function") return reader.releaseLock(); },
        cancel(reason) { done(); return typeof reader.cancel === "function" ? reader.cancel(reason) : undefined; },
      };
    },
  } : null;
  return {
    status: resp.status,
    ok: resp.ok,
    headers: resp.headers,
    body,
    async text() {
      try { return typeof resp.text === "function" ? await resp.text() : ""; }
      finally { done(); }
    },
    async json() {
      try {
        if (typeof resp.json === "function") return await resp.json();
        return JSON.parse(typeof resp.text === "function" ? await resp.text() : "");
      } finally { done(); }
    },
  };
}
async function throttledBackendFetch(backend, fetcher) {
  if (!backend.throttle) return fetcher();
  const cfg = throttleConfigFromBackend(backend);
  const st = throttleState(backend.id);
  let attempt = 0;
  for (;;) {
    await acquireThrottleSlot(st, cfg);
    let released = false;
    const release = () => { if (!released) { released = true; releaseThrottleSlot(st); } };
    let resp;
    try {
      await throttleRateGate(st, cfg);
      resp = await fetcher();
    } catch (e) {
      release();
      if (attempt >= cfg.maxRetries) throw e;
      st.totalRetries++;
      await sleep(throttleBackoffMs(attempt, cfg, ""));
      attempt++;
      continue;
    }

    if (!isThrottleRetryableStatus(resp.status) || attempt >= cfg.maxRetries) {
      return wrapThrottleResponse(resp, release);
    }

    const retryAfter = headerGet(resp.headers, "retry-after");
    try { if (typeof resp.text === "function") await resp.text(); } catch {}
    release();
    st.totalRetries++;
    await sleep(throttleBackoffMs(attempt, cfg, retryAfter));
    attempt++;
  }
}

function parseResetAt(value, now = Date.now()) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) {
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return now + n * 1000;
  }
  const d = Date.parse(raw);
  return Number.isFinite(d) ? d : null;
}
function unavailableAccountsPayload() {
  return { error: { type: "proxy_error", message: "claude-router: all accounts cooling/disabled. Retry shortly or enable an account in the webui." } };
}
async function safeReadText(resp) {
  try { return resp && typeof resp.text === "function" ? await resp.text() : ""; }
  catch { return ""; }
}
function sendUpstreamText(res, up, text) {
  if (headersDone(res)) { try { if (res && !res.writableEnded) res.end(); } catch {} return; }
  const ct = headerGet(up.headers, "content-type") || "application/json";
  res.writeHead(up.status, { "content-type": ct });
  res.end(text || "");
}
function setAccountCooldown(account, patch) {
  Object.assign(account, patch);
  return true;
}
function applyAccountFailure(store, account, status, headers, bodyText = "", now = Date.now()) {
  if (!account) return false;
  if (status === 429) {
    const reset = parseResetAt(headerGet(headers, "anthropic-ratelimit-unified-reset"), now);
    setAccountCooldown(account, {
      status: "cooldown",
      cooldown_until: reset || now + 300_000,
      cooldown_reason: "429_quota",
      rate_limit_reset_at: reset || null,
      last_429_at: now,
    });
    return true;
  }
  if (status === 529) {
    setAccountCooldown(account, {
      status: "cooldown",
      cooldown_until: now + 600_000,
      cooldown_reason: "529_overload",
    });
    return true;
  }
  if (status === 401 || status === 403) {
    setAccountCooldown(account, {
      status: "cooldown",
      cooldown_until: now + 1_800_000,
      cooldown_reason: "auth",
    });
    return true;
  }
  if (status === 400 && /organization disabled|account disabled|not found|invalid account|Too many active sessions/i.test(bodyText || "")) {
    setAccountCooldown(account, {
      status: "disabled",
      cooldown_until: now + 600_000,
      cooldown_reason: "blocked",
    });
    return true;
  }
  return false;
}

function mergeBetas(clientBeta) {
  const set = new Set();  if (clientBeta) String(clientBeta).split(",").forEach((b) => { const t = b.trim(); if (t) set.add(t); });
  REQUIRED_BETAS.forEach((b) => set.add(b));
  return [...set].join(",");
}

// --- config model: ~/.claude-router/backends.json --------------------------------
// Backend: { id, name, upstream, format, apiKey, oauth, codexOauth, authScheme(derived),
//  modelPatterns, modelMap, testModel, enabled }. authScheme is derived, not stored.
//  format:"anthropic"        → byte-identical /v1/messages passthrough (OAuth or x-api-key)
//  format:"openai"           → translate to /v1/chat/completions (plain fetch)
//  format:"openai-responses" → translate to OpenAI Responses API (chatgpt.com/codex/responses
//                              via anthropicFetch; codexOauth reads ~/.codex/auth.json)
function normalizeBackend(b) {
  if (!b || typeof b !== "object") b = {};
  const id = String(b.id || "");
  const idLower = id.toLowerCase();
  let upstream = String(b.upstream || "").replace(/\/+$/, "");
  let rawFormat = b.format;
  const modelPatterns = Array.isArray(b.modelPatterns) ? b.modelPatterns.slice() : [];
  const modelMap = (b.modelMap && typeof b.modelMap === "object" && !Array.isArray(b.modelMap)) ? { ...b.modelMap } : {};

  const looksCodexResponses = upstream === CODEX_RESPONSES_UPSTREAM || b.codexOauth || b.authScheme === "codex-oauth";
  if (looksCodexResponses) {
    rawFormat = "openai-responses";
    upstream = CODEX_RESPONSES_UPSTREAM;
  }

  const looksGlm = idLower.includes("glm") || modelPatterns.some((p) => String(p).toLowerCase().includes("glm"));
  const oldGlmDefault = looksGlm && (!upstream || upstream === GLM_OPENAI_COMPAT_UPSTREAM) && (rawFormat == null || rawFormat === "openai");
  if (oldGlmDefault) {
    rawFormat = "anthropic";
    upstream = GLM_ANTHROPIC_UPSTREAM;
  }

  const format = rawFormat === "openai" ? "openai" : rawFormat === "openai-responses" ? "openai-responses" : "anthropic";
  const codexOauth = !!(format === "openai-responses" && looksCodexResponses);
  let authScheme = b.authScheme;
  if (!authScheme) {
    if (format === "openai") authScheme = "bearer";
    else if (format === "openai-responses") authScheme = codexOauth ? "codex-oauth" : "bearer";
    else if (b.oauth) authScheme = "oauth";
    else authScheme = "x-api-key";
  }
  if (codexOauth) authScheme = "codex-oauth";
  const throttleCfg = throttleConfigFromBackend(b);
  const isClaudeNative = format === "anthropic" && (b.oauth || upstream === "https://api.anthropic.com");
  const defaultGlmThrottle = looksGlm && format === "anthropic" && upstream === GLM_ANTHROPIC_UPSTREAM;
  const throttleAllowed = !codexOauth && format !== "openai-responses" && !isClaudeNative;
  const throttle = throttleAllowed && (b.throttle === true || (b.throttle == null && (oldGlmDefault || defaultGlmThrottle)));
  return {
    id,
    name: b.name || id,
    upstream,
    format,
    apiKey: b.apiKey || "",
    oauth: !!b.oauth,
    codexOauth,
    authScheme,
    modelPatterns,
    modelMap,
    testModel: codexOauth ? CODEX_RESPONSES_MODEL : (b.testModel || ""),
    enabled: b.enabled !== false,
    throttle,
    ...throttleCfg,
  };
}

function assertProfileName(name) {
  const n = String(name || "").trim();
  if (!PROFILE_NAME_RE.test(n) || n.includes("/") || n.includes("\\")) throw new Error(`invalid profile name (must match ${PROFILE_NAME_RE})`);
  return n;
}
function normalizeEnvMap(env) {
  const out = {};
  if (!env || typeof env !== "object" || Array.isArray(env)) return out;
  for (const [k, v] of Object.entries(env)) {
    if (!k || typeof k !== "string") continue;
    if (v == null) continue;
    out[k] = String(v);
  }
  return out;
}
function normalizeRouteOverrides(routes) {
  if (!Array.isArray(routes)) return undefined;
  return routes.map((r) => ({
    pattern: String(r && r.pattern != null ? r.pattern : "*"),
    backendId: String(r && r.backendId != null ? r.backendId : ""),
  })).filter((r) => r.backendId);
}
function normalizeProfile(p) {
  if (!p || typeof p !== "object") p = {};
  const out = {
    primaryModel: String(p.primaryModel || "").trim(),
    env: normalizeEnvMap(p.env),
  };
  const routes = normalizeRouteOverrides(p.routeOverrides);
  if (routes) out.routeOverrides = routes;
  return out;
}
function normalizeProfiles(profiles) {
  const out = {};
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return out;
  for (const [name, profile] of Object.entries(profiles)) {
    try {
      const n = assertProfileName(name);
      out[n] = normalizeProfile(profile);
    } catch {}
  }
  return out;
}

// --- virtual models (condition-based routing) -----------------------------------
// A virtual model is a client-facing model NAME whose routing target is chosen per
// request by evaluating ordered `rules` against the request body (first match wins),
// else `default`. Purely additive: when `virtualModels` is empty/absent, proxy()
// behaves byte-identically to today. This is a ROUTING feature, not an agentic tool
// loop — exactly one upstream call is made per request (see spec §0/§2).
const VM_WHEN_SET = new Set(["hasImage", "webSearch", "longContext", "keyword", "always"]);
function normalizeVirtualRule(r) {
  if (!r || typeof r !== "object") return null;
  const when = String(r.when || "");
  if (!VM_WHEN_SET.has(when)) return null;                 // unknown predicate → drop rule
  const backendId = String(r.backendId || "");
  const model = String(r.model || "");
  if (!backendId || !model) return null;                   // target must be resolvable
  const out = { when, backendId, model };
  if (when === "longContext") {
    out.thresholdTokens = clampInt(r.thresholdTokens, 200000, 1, 10_000_000);
  }
  if (when === "keyword") {
    const kws = Array.isArray(r.keywords)
      ? r.keywords.map((k) => String(k || "").toLowerCase().trim()).filter(Boolean)
      : [];
    if (!kws.length) return null;                          // keyword rule with no keywords → drop
    out.keywords = kws;
  }
  return out;
}
// Returns a clean plain object with exactly { id, name, enabled, match, rules, default },
// or null if the entry is invalid (dropped at load time). Mirrors normalizeBackend
// discipline: downstream code can trust the shape. Not frozen (consistency with the
// rest of the config layer; resolveVirtualModel returns a fresh clone before any
// per-request scratch field is written, so the cfg-level object is never mutated).
function normalizeVirtualModel(v) {
  if (!v || typeof v !== "object") return null;
  const id = String(v.id || "");
  if (!ID_RE.test(id)) return null;
  const name = v.name ? String(v.name) : id;
  const enabled = v.enabled !== false;
  let match = Array.isArray(v.match) ? v.match.map((m) => String(m || "").trim()).filter(Boolean) : [];
  if (!match.length) match = [id];
  const rules = Array.isArray(v.rules) ? v.rules.map(normalizeVirtualRule).filter(Boolean) : [];
  const dflt = v.default && typeof v.default === "object" ? v.default : null;
  const defBackendId = dflt ? String(dflt.backendId || "") : "";
  const defModel = dflt ? String(dflt.model || "") : "";
  if (!defBackendId || !defModel) return null;             // a VM must always be resolvable
  return { id, name, enabled, match, rules, default: { backendId: defBackendId, model: defModel } };
}
function normalizeVirtualModels(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeVirtualModel).filter(Boolean);
}

function synthesizeFromEnv() {
  if (STATIC_KEY) {                              // existing KEY_MODE
    return {
      backends: [normalizeBackend({ id:"default", name:"API-key passthrough", upstream: UPSTREAM,
        format:"anthropic", apiKey: STATIC_KEY, authScheme:"x-api-key",
        modelPatterns:["*"], modelMap:{}, testModel:"", enabled:true })],
      routes: [{ pattern:"*", backendId:"default" }],
      profiles: {}, activeProfile: null,
      virtualModels: [],
    };
  }
  // OAuth subscription (existing)
  return {
    backends: [normalizeBackend({ id:"default", name:"Anthropic subscription (OAuth)", upstream:"https://api.anthropic.com",
      format:"anthropic", apiKey:"", oauth:true, authScheme:"oauth",
      modelPatterns:["*"], modelMap:{}, testModel:"claude-opus-4-8", enabled:true })],
    routes: [{ pattern:"*", backendId:"default" }],
    profiles: {}, activeProfile: null,
    virtualModels: [],
  };
}

function loadConfig(file = CFG_FILE) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    // normalize + validate shape so downstream code can trust the fields
    cfg.backends = Array.isArray(cfg.backends) ? cfg.backends.map(normalizeBackend) : [];
    if (!cfg.backends.length) return synthesizeFromEnv(); // empty file → synth
    cfg.routes = Array.isArray(cfg.routes) ? cfg.routes : [];
    cfg.profiles = normalizeProfiles(cfg.profiles);
    cfg.activeProfile = cfg.activeProfile || null;
    cfg.virtualModels = normalizeVirtualModels(cfg.virtualModels);
    return cfg;
  } catch { return synthesizeFromEnv(); }
}
function saveConfig(cfg, file = CFG_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteJson(file, cfg);
}

// glob match, case-insensitive. "*" or "" → match all.
function matchPattern(modelLower, pattern) {
  const p = String(pattern == null ? "*" : pattern).toLowerCase();
  if (p === "*" || p === "") return true;
  const re = new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
  return re.test(String(modelLower));
}

// Pure routing: cfg + model → backend object (or null). Precedence:
//  1. specific (non-"*") routes — first match wins
//  2. any enabled backend whose modelPatterns match (fallback)
//  3. catch-all ("*") routes — first match wins
//  4. a backend with a "*" modelPattern, else first enabled, else null
// The "*" route is deferred to step 3 so a per-backend modelPattern (e.g. codex
// serving "gpt-5*") wins over a blanket "*" → claude catch-all — matches the spec
// §7.1 routing assertions ("route gpt-5.5 miss → fallback modelPatterns gpt-5* → codex").
function resolveBackendCfg(cfg, model) {
  const m = String(model || "").toLowerCase();
  const backends = Array.isArray(cfg.backends) ? cfg.backends : [];
  const routes = Array.isArray(cfg.routes) ? cfg.routes : [];
  const isCatchAll = (p) => { const s = String(p == null ? "*" : p).toLowerCase(); return s === "*" || s === ""; };
  for (const r of routes) {
    if (isCatchAll(r.pattern)) continue;
    if (matchPattern(m, r.pattern)) {
      const b = backends.find((x) => x.id === r.backendId && x.enabled !== false);
      if (b) return b;
    }
  }
  for (const b of backends) {
    if (b.enabled === false) continue;
    if ((b.modelPatterns || []).some((p) => matchPattern(m, p))) return b;
  }
  for (const r of routes) {
    if (!isCatchAll(r.pattern)) continue;
    const b = backends.find((x) => x.id === r.backendId && x.enabled !== false);
    if (b) return b;
  }
  const star = backends.find((b) => b.enabled !== false && (b.modelPatterns || []).includes("*"));
  return star || backends.find((b) => b.enabled !== false) || null;
}
// Thin wrapper: load config from disk, then route.
function resolveBackend(model) {
  return resolveBackendCfg(loadConfig(), model);
}

// --- virtual-model predicates (pure, null-safe) ---------------------------------
// All walkers guard Array.isArray and tolerate body === null (non-JSON passthrough):
// they return false/0 so a VM-named request with an unparseable body degrades to the
// default target rather than throwing.
function bodyHasImage(body) {
  const msgs = body && Array.isArray(body.messages) ? body.messages : [];
  for (const m of msgs) {
    const c = m && m.content;
    if (Array.isArray(c) && c.some((b) => b && b.type === "image")) return true;
  }
  return false;
}
// A request "advertises" web search if it declares a tool whose name/type looks like a
// web-search tool, OR the caller set metadata.web_search === true. (Mirrors CCR's
// hasWebSearchTool Router-rule signal — request-shape detection only, no search API.)
function bodyHasWebSearchTool(body) {
  const tools = body && Array.isArray(body.tools) ? body.tools : [];
  return tools.some((t) => {
    const n = String((t && (t.name || t.type)) || "").toLowerCase();
    return n.includes("web_search") || n.includes("websearch");
  });
}
// Cheap local token estimate: ~4 chars/token over every text we can see + a coarse
// constant per image block. Monotonic + stable is all the threshold decision needs;
// it is NOT used for billing and never makes an upstream count_tokens call (spec §2/§5.3).
function estimateInputTokens(body) {
  let chars = 0;
  if (!body || typeof body !== "object") return 0;
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
// Joined user+system+assistant text for keyword matching (substring, case-insensitive).
function bodyText(body) {
  if (!body || typeof body !== "object") return "";
  const parts = [];
  const add = (s) => { if (typeof s === "string" && s) parts.push(s); };
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
    }
  }
  return parts.join("\n");
}
function ruleKeywordMatch(rule, body) {
  const kws = Array.isArray(rule.keywords) ? rule.keywords : [];
  if (!kws.length) return false;
  const hay = bodyText(body).toLowerCase();
  return kws.some((k) => k && hay.includes(k));
}
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
// Resolve a requested model name to a (cloned) virtual model, or null. First enabled
// VM whose `match` glob hits wins. Returns a fresh shallow clone with cloned
// rules/default so per-request scratch (`_resolvedTarget`) never touches the shared
// cfg-level object.
function resolveVirtualModel(cfg, model) {
  const vms = Array.isArray(cfg && cfg.virtualModels) ? cfg.virtualModels : [];
  if (!vms.length || !model) return null;
  const m = String(model).toLowerCase();
  for (const vm of vms) {
    if (vm.enabled === false) continue;
    if ((vm.match || []).some((p) => matchPattern(m, p))) {
      return { ...vm, rules: vm.rules.map((r) => ({ ...r })), default: { ...vm.default } };
    }
  }
  return null;
}
// Evaluate ordered rules against the body; first match wins, else default. Pure and
// synchronous; stashes the chosen target on the (per-request clone) vm._resolvedTarget
// so proxy() can look the backend up directly without re-evaluating.
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

function maskKey(k) {
  if (!k) return "";
  const s = String(k);
  if (s.length <= 7) return s.slice(0, 2) + "…" + "*".repeat(3);
  return s.slice(0, 3) + "…" + s.slice(-4);
}
// Return a backend with apiKey masked (for every read path / API response).
function maskBackend(b) {
  const n = normalizeBackend(b);
  return { ...n, apiKey: maskKey(n.apiKey) };
}

// --- translation: Anthropic → OpenAI (pure) --------------------------------------
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, Number(n))); }

function imageUrlFromAnthropic(source) {
  if (!source) return "";
  if (source.type === "base64") return `data:${source.media_type};base64,${source.data}`;
  if (source.type === "url") return source.url;
  return "";
}
function flattenToolResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  return String(content ?? "");
}
function anthropicToolToOpenai(t) {
  return {
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
      ...(t.strict != null ? { strict: t.strict } : {}),
    },
  };
}
function anthropicToolChoiceToOpenai(tc) {
  const out = {};
  if (tc.type === "auto") out.tool_choice = "auto";
  else if (tc.type === "any") out.tool_choice = "required";
  else if (tc.type === "none") out.tool_choice = "none";
  else if (tc.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
  if (tc.disable_parallel_tool_use) out.parallel_tool_calls = false; // inversion
  return out;
}
function anthropicAssistantToOpenai(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
  let text = "";
  const tool_calls = [];
  for (const b of blocks) {
    if (b.type === "text") text += b.text;
    else if (b.type === "tool_use") {
      tool_calls.push({
        id: b.id, type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }, // arguments is a STRING
      });
    }
    // thinking blocks: dropped (no OpenAI streaming-thinking delta mapped in v1)
  }
  return {
    role: "assistant",
    content: text || null,    // null when only tool_calls
    ...(tool_calls.length ? { tool_calls } : {}),
  };
}

function anthropicToOpenaiBody(body) {
  const out = {
    model: body.model,                          // caller may apply backend.modelMap first
    messages: [],
    stream: !!body.stream,
  };
  if (out.stream) out.stream_options = { include_usage: true }; // need usage on final chunk

  // --- system prompt: top-level system (string OR array of text blocks) → one {role:"system"} ---
  let sysText = "";
  if (typeof body.system === "string") sysText = body.system;
  else if (Array.isArray(body.system)) {
    sysText = body.system
      .filter((b) => b && b.type === "text")
      .map((b) => b.text)
      .join("\n");
  }
  if (sysText) out.messages.push({ role: "system", content: sysText });

  for (const msg of body.messages || []) {
    if (msg.role === "assistant") {
      out.messages.push(anthropicAssistantToOpenai(msg));
    } else if (msg.role === "user") {
      const parts = [];          // content parts for a role:"user" message
      const toolResults = [];    // each becomes its own role:"tool" message
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          toolResults.push({ role: "tool", tool_call_id: b.tool_use_id, content: flattenToolResult(b.content) });
        } else if (b.type === "text") {
          parts.push({ type: "text", text: b.text });
        } else if (b.type === "image") {
          parts.push({ type: "image_url", image_url: { url: imageUrlFromAnthropic(b.source) } });
        }
      }
      // tool results MUST come right after the assistant tool_calls, before any new user text
      for (const tr of toolResults) out.messages.push(tr);
      if (parts.length) out.messages.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    } else if (msg.role === "system") {
      out.messages.push({ role: "system", content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) });
    }
  }

  if (body.max_tokens != null) out.max_completion_tokens = body.max_tokens; // preferred over deprecated max_tokens
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

function mapFinishReason(reason) {
  switch (reason) {
    case "stop":           return "end_turn";
    case "length":         return "max_tokens";
    case "tool_calls":     return "tool_use";
    case "function_call":  return "tool_use";        // legacy
    case "content_filter": return "refusal";          // closest semantic; documented choice
    default:               return "end_turn";
  }
}

// --- translation: OpenAI → Anthropic (non-streaming) ----------------------------
function openaiToAnthropicResponse(json, anthropicModel) {
  const choice = (json.choices && json.choices[0]) || {};
  const msg = choice.message || {};
  const content = [];
  if (typeof msg.content === "string" && msg.content) {
    content.push({ type: "text", text: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse((tc.function && tc.function.arguments) || "{}"); } catch { input = {}; } // arguments is a STRING
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
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

// --- translation: OpenAI SSE → Anthropic SSE (async generator) ------------------
function sseBlock(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

// Consume raw byte chunks → parsed OpenAI SSE JSON objects. "[DONE]" ends the iter.
async function* sseDataLines(asyncIter) {
  let buf = "";
  for await (const raw of asyncIter) {
    buf += Buffer.from(raw).toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (data === "[DONE]") return;       // sentinel: end generator
      try { yield JSON.parse(data); } catch { /* skip malformed */ }
    }
  }
}

// Stateful transform: OpenAI chat-completion chunks → Anthropic SSE event blocks.
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
        id: "msg_" + String(chunk.id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || crypto.randomUUID(),
        type: "message", role: "assistant", content: [], model: state.model,
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1 }, // input unknown until final usage chunk
      },
    });
  }

  // text content
  if (typeof delta.content === "string" && delta.content) {
    if (!state.openBlock || state.openBlock.kind !== "text") {
      if (state.openBlock) { yield sseBlock("content_block_stop", { index: state.openBlock.index }); }
      const idx = state.nextBlockIndex++;
      yield sseBlock("content_block_start", { index: idx, content_block: { type: "text", text: "" } });
      state.openBlock = { index: idx, kind: "text" };
    }
    yield sseBlock("content_block_delta", { index: state.openBlock.index, delta: { type: "text_delta", text: delta.content } });
  }

  // tool calls — delta.tool_calls[].index is a tool-call index, NOT a byte offset
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      if (!state.tcIndexToBlockIndex.has(tc.index)) {
        // first chunk for this tool call → open a tool_use block
        if (state.openBlock) { yield sseBlock("content_block_stop", { index: state.openBlock.index }); state.openBlock = null; }
        const idx = state.nextBlockIndex++;
        state.tcIndexToBlockIndex.set(tc.index, idx);
        yield sseBlock("content_block_start", {
          index: idx,
          content_block: { type: "tool_use", id: tc.id, name: tc.function && tc.function.name, input: {} },
        });
        state.openBlock = { index: idx, kind: "tool_use", tcIndex: tc.index };
      }
      const args = (tc.function && tc.function.arguments) || "";
      if (args) {
        yield sseBlock("content_block_delta", {
          index: state.tcIndexToBlockIndex.get(tc.index),
          delta: { type: "input_json_delta", partial_json: args }, // arguments(string) ↔ partial_json(string)
        });
      }
    }
  }

  // refusal (OpenAI streams delta.refusal) — buffered, surfaced via stop_reason at end
  // (no Anthropic streaming refusal delta; implemented as end-of-stream refusal mapping)

  // finish
  if (choice.finish_reason) {
    state.finalFinishReason = choice.finish_reason;
    if (state.openBlock) { yield sseBlock("content_block_stop", { index: state.openBlock.index }); state.openBlock = null; }
    const u = state.finalUsage || {};
    yield sseBlock("message_delta", {
      delta: { stop_reason: mapFinishReason(choice.finish_reason), stop_sequence: null },
      usage: { input_tokens: u.prompt_tokens || 0, output_tokens: u.completion_tokens || 0 },
    });
    yield sseBlock("message_stop", {});
  }
}

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
  for await (const chunk of sseDataLines(asyncIter)) {   // parsed JSON objects; "[DONE]" ends iter
    yield* handleOpenaiChunk(chunk, state);
  }
  // safety net: if upstream ended without a finish_reason (no [DONE] / no terminal chunk),
  // close cleanly so the Anthropic client doesn't hang on an open block.
  if (state.openBlock) { yield sseBlock("content_block_stop", { index: state.openBlock.index }); state.openBlock = null; }
  if (!state.finalFinishReason) {
    yield sseBlock("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: {} });
    yield sseBlock("message_stop", {});
  }
}

function openaiCountTokensResponse(body) {
  // rough heuristic: 1 token ≈ 4 chars; sum system + messages text. OpenAI has no count endpoint.
  let chars = 0;
  const add = (s) => { if (typeof s === "string") chars += s.length; };
  add(typeof body.system === "string" ? body.system : "");
  if (Array.isArray(body.system)) body.system.forEach((b) => add(b.text));
  for (const m of body.messages || []) {
    if (typeof m.content === "string") add(m.content);
    else if (Array.isArray(m.content)) m.content.forEach((b) => add(b.text || JSON.stringify(b.input || "")));
  }
  const n = Math.max(1, Math.ceil(chars / 4));
  return { input_tokens: n };
}

// --- translation: Anthropic → OpenAI Responses API (pure) -----------------------
// Targets the ChatGPT/Codex subscription responses endpoint (chatgpt.com/.../codex/
// responses). The Responses API is stateful & item-based: `input` is a flat array of
// message items + function_call / function_call_output items; `instructions` holds the
// system prompt; `store:false` + `stream:true` are REQUIRED by the codex endpoint.
function anthropicToOpenaiResponsesBody(body) {
  const input = [];

  // system (string OR text-block array) → instructions (string). Per-message system
  // roles are also folded into instructions (Responses has no in-input system role).
  let instructions = "";
  if (typeof body.system === "string") instructions = body.system;
  else if (Array.isArray(body.system)) {
    instructions = body.system.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  }

  for (const msg of body.messages || []) {
    if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
      const textParts = [];
      const fcCalls = [];
      for (const b of blocks) {
        if (b.type === "text") textParts.push({ type: "output_text", text: b.text });
        else if (b.type === "tool_use") {
          // top-level input item (NOT nested in content); arguments is a STRING
          fcCalls.push({ type: "function_call", call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
        }
        // thinking blocks: dropped (no Responses equivalent)
      }
      if (textParts.length) input.push({ role: "assistant", content: textParts });
      for (const fc of fcCalls) input.push(fc);
    } else if (msg.role === "user") {
      const parts = [];          // content parts for a role:"user" message item
      const fcoOutputs = [];     // each becomes a top-level function_call_output item
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content ?? "") }];
      for (const b of blocks) {
        if (b.type === "tool_result") {
          fcoOutputs.push({ type: "function_call_output", call_id: b.tool_use_id, output: flattenToolResult(b.content) });
        } else if (b.type === "text") {
          parts.push({ type: "input_text", text: b.text });
        } else if (b.type === "image") {
          const url = imageUrlFromAnthropic(b.source);
          if (url) parts.push({ type: "input_image", image_url: url });
        }
      }
      // function_call_output items come right after the assistant function_call, before new user text
      for (const fco of fcoOutputs) input.push(fco);
      if (parts.length) input.push({ role: "user", content: parts });
    } else if (msg.role === "system") {
      const s = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      instructions = instructions ? (instructions + "\n" + s) : s;
    }
  }

  const out = {
    model: body.model,                          // caller may apply backend.modelMap first
    input,
    store: false,                               // REQUIRED by codex/responses (else 400)
    stream: true,                               // REQUIRED (endpoint rejects non-stream)
  };
  if (instructions) out.instructions = instructions;

  if (body.max_tokens != null) out.max_output_tokens = body.max_tokens;
  if (body.temperature != null) out.temperature = clamp(body.temperature, 0, 2);
  if (body.top_p != null) out.top_p = body.top_p;
  // dropped: top_k, thinking, cache_control, stop_sequences (no Responses equivalent)
  if (Array.isArray(body.tools) && body.tools.length) {
    // Responses function tools are FLAT: {type:"function", name, description, parameters}
    out.tools = body.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
      ...(t.strict != null ? { strict: t.strict } : {}),
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "none") out.tool_choice = "none";
    else if (tc.type === "tool") out.tool_choice = { type: "function", name: tc.name };
  }
  return out;
}

// Consume raw byte chunks → parsed Responses SSE JSON objects. Responses events are
// `event: <name>\ndata: <json>\n\n`; each data object carries a `type` field equal to
// the event name, so we only need the data line. "[DONE]" (never sent by Responses,
// but harmless) is skipped. Reuses the sseDataLines frame-splitting pattern, adapted
// to yield every parsed data object (no early [DONE] termination semantics).
async function* responsesSseEvents(asyncIter) {
  let buf = "";
  for await (const raw of asyncIter) {
    buf += Buffer.from(raw).toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const data = dataLine.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try { yield JSON.parse(data); } catch { /* skip malformed */ }
    }
  }
}

// Map Responses response status → Anthropic stop_reason. completed→end_turn,
// max_output_tokens (incomplete)→max_tokens, tool_calls present→tool_use.
function responsesStopReason(state) {
  if (state.incompleteReason === "max_output_tokens") return "max_tokens";
  if (state.hadToolCalls) return "tool_use";
  return "end_turn";
}
function responsesUsage(u) {
  const x = u || {};
  return {
    input_tokens: x.input_tokens || 0,
    output_tokens: x.output_tokens || 0,
    cache_read_input_tokens: (x.input_tokens_details && x.input_tokens_details.cached_tokens) || 0,
    cache_creation_input_tokens: 0,
  };
}

// Stateful transform: Responses SSE events → Anthropic SSE event blocks.
// Emits message_start once; output_text.delta → text content_block + text_delta;
// function_call (output_item.added) → tool_use content_block; function_call_arguments.delta
// → input_json_delta partial_json; function_call_arguments.done / output_item.done →
// content_block_stop; response.completed → message_delta (stop_reason) + message_stop.
async function* openaiResponsesSseToAnthropicSse(asyncIter, anthropicModel) {
  const state = {
    model: anthropicModel,
    emittedMessageStart: false,
    nextBlockIndex: 0,
    openBlock: null,            // {index, kind:"text"|"tool_use", itemId?, callId?, seenDelta?}
    itemIdToBlock: new Map(),   // function_call item.id → block index (for arg deltas)
    responseId: "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    hadToolCalls: false,
    finalUsage: null,
    incompleteReason: null,
    terminal: false,
  };
  function* emitMessageStart() {
    if (state.emittedMessageStart) return;
    state.emittedMessageStart = true;
    yield sseBlock("message_start", {
      message: {
        id: state.responseId, type: "message", role: "assistant", content: [],
        model: state.model, stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1 }, // real usage arrives in message_delta
      },
    });
  }
  function* closeOpen() {
    if (state.openBlock) { yield sseBlock("content_block_stop", { index: state.openBlock.index }); state.openBlock = null; }
  }

  for await (const ev of responsesSseEvents(asyncIter)) {
    const t = ev.type;
    if (t === "response.created" || t === "response.in_progress") {
      if (ev.response && ev.response.id) state.responseId = "msg_" + String(ev.response.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      yield* emitMessageStart();
    } else if (t === "response.output_item.added") {
      yield* emitMessageStart();
      const item = ev.item || {};
      if (item.type === "function_call") {
        yield* closeOpen();
        const idx = state.nextBlockIndex++;
        const callId = item.call_id || item.id;
        if (item.id) state.itemIdToBlock.set(item.id, idx);
        state.hadToolCalls = true;
        yield sseBlock("content_block_start", {
          index: idx,
          content_block: { type: "tool_use", id: callId, name: item.name, input: {} },
        });
        state.openBlock = { index: idx, kind: "tool_use", itemId: item.id, callId, seenDelta: false };
      }
      // message / reasoning items: text opens lazily on the first output_text.delta
    } else if (t === "response.output_text.delta") {
      yield* emitMessageStart();
      if (!state.openBlock || state.openBlock.kind !== "text") {
        yield* closeOpen();
        const idx = state.nextBlockIndex++;
        yield sseBlock("content_block_start", { index: idx, content_block: { type: "text", text: "" } });
        state.openBlock = { index: idx, kind: "text" };
      }
      yield sseBlock("content_block_delta", { index: state.openBlock.index, delta: { type: "text_delta", text: ev.delta || "" } });
    } else if (t === "response.content_part.done") {
      if (state.openBlock && state.openBlock.kind === "text") yield* closeOpen();
    } else if (t === "response.function_call_arguments.delta") {
      yield* emitMessageStart();
      const itemId = ev.item_id;
      let idx;
      if (state.openBlock && state.openBlock.kind === "tool_use" && state.openBlock.itemId === itemId) {
        idx = state.openBlock.index;
      } else {
        idx = state.itemIdToBlock.get(itemId);   // fallback (Responses streams one fc at a time, so openBlock matches)
        if (idx == null) continue;
      }
      yield sseBlock("content_block_delta", { index: idx, delta: { type: "input_json_delta", partial_json: ev.delta || "" } });
      if (state.openBlock && state.openBlock.kind === "tool_use" && state.openBlock.index === idx) state.openBlock.seenDelta = true;
    } else if (t === "response.function_call_arguments.done") {
      const itemId = ev.item_id;
      if (state.openBlock && state.openBlock.kind === "tool_use" && state.openBlock.itemId === itemId) {
        // if no deltas streamed the args (e.g. {}), emit the final arguments as one partial so the
        // block delivers a complete JSON value; otherwise the deltas already accumulated to it.
        if (!state.openBlock.seenDelta && ev.arguments) {
          yield sseBlock("content_block_delta", { index: state.openBlock.index, delta: { type: "input_json_delta", partial_json: ev.arguments } });
        }
        yield* closeOpen();
      }
    } else if (t === "response.output_item.done") {
      const item = ev.item || {};
      if (item.type === "message") {
        if (state.openBlock && state.openBlock.kind === "text") yield* closeOpen();
      } else if (item.type === "function_call") {
        if (state.openBlock && state.openBlock.kind === "tool_use" && state.openBlock.itemId === item.id) yield* closeOpen();
      }
    } else if (t === "response.completed" || t === "response.incomplete") {
      if (ev.response) {
        if (ev.response.id) state.responseId = "msg_" + String(ev.response.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
        state.finalUsage = ev.response.usage || null;
        if (ev.response.incomplete_details && ev.response.incomplete_details.reason) state.incompleteReason = ev.response.incomplete_details.reason;
      }
      yield* closeOpen();
      yield sseBlock("message_delta", { delta: { stop_reason: responsesStopReason(state), stop_sequence: null }, usage: responsesUsage(state.finalUsage) });
      yield sseBlock("message_stop", {});
      state.terminal = true;
      return;
    } else if (t === "response.failed" || t === "error") {
      const msg = (ev.error && (ev.error.message || ev.error.code))
        || (ev.response && ev.response.error && (ev.response.error.message || ev.response.error.code))
        || "upstream response failed";
      yield* closeOpen();
      yield sseBlock("error", { type: "error", error: { type: "api_error", message: String(msg) } });
      state.terminal = true;
      return;
    }
  }
  // safety net: upstream ended without response.completed (no terminal event) — close cleanly.
  if (!state.terminal) {
    yield* closeOpen();
    if (!state.emittedMessageStart) yield* emitMessageStart();
    yield sseBlock("message_delta", { delta: { stop_reason: responsesStopReason(state), stop_sequence: null }, usage: responsesUsage(state.finalUsage) });
    yield sseBlock("message_stop", {});
  }
}

// Non-stream assembler: the codex/responses endpoint REQUIRES stream:true, so for a
// non-stream Anthropic request we stream upstream, collect all Responses events, and
// assemble one Anthropic message response. Mirrors openaiToAnthropicResponse output.
async function openaiResponsesToAnthropicResponse(asyncIter, anthropicModel) {
  let responseId = "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  let textBuf = "", inText = false;
  const content = [];
  let pendingTool = null;      // {id, name, args} for the function_call currently streaming
  let status = "completed", usage = null, hadToolCalls = false, incompleteReason = null, failedMsg = null;
  const flushText = () => { if (inText) { content.push({ type: "text", text: textBuf }); textBuf = ""; inText = false; } };

  for await (const ev of responsesSseEvents(asyncIter)) {
    const t = ev.type;
    if (t === "response.created" || t === "response.in_progress") {
      if (ev.response && ev.response.id) responseId = "msg_" + String(ev.response.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
    } else if (t === "response.output_item.added") {
      const item = ev.item || {};
      if (item.type === "function_call") {
        flushText();
        pendingTool = { id: item.call_id || item.id, name: item.name, args: "" };
        hadToolCalls = true;
      } else if (item.type === "message") {
        flushText();
      }
    } else if (t === "response.output_text.delta") {
      inText = true; textBuf += ev.delta || "";
    } else if (t === "response.content_part.done") {
      flushText();
    } else if (t === "response.function_call_arguments.delta") {
      if (pendingTool) pendingTool.args += ev.delta || "";
    } else if (t === "response.function_call_arguments.done") {
      if (pendingTool) {
        const finalArgs = ev.arguments != null ? ev.arguments : pendingTool.args;
        let input = {};
        try { input = JSON.parse(finalArgs || "{}"); } catch { input = {}; }
        content.push({ type: "tool_use", id: pendingTool.id, name: pendingTool.name, input });
        pendingTool = null;
      }
    } else if (t === "response.output_item.done") {
      const item = ev.item || {};
      if (item.type === "function_call") {
        if (pendingTool) {
          let input = {};
          try { input = JSON.parse(item.arguments || pendingTool.args || "{}"); } catch { input = {}; }
          content.push({ type: "tool_use", id: pendingTool.id || item.call_id || item.id, name: pendingTool.name || item.name, input });
          pendingTool = null;
        }
      } else if (item.type === "message") {
        flushText();
      }
    } else if (t === "response.completed" || t === "response.incomplete") {
      if (ev.response) {
        if (ev.response.id) responseId = "msg_" + String(ev.response.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
        status = ev.response.status || (t === "response.incomplete" ? "incomplete" : "completed");
        usage = ev.response.usage || usage;
        if (ev.response.incomplete_details && ev.response.incomplete_details.reason) incompleteReason = ev.response.incomplete_details.reason;
      }
    } else if (t === "response.failed" || t === "error") {
      failedMsg = (ev.error && (ev.error.message || ev.error.code))
        || (ev.response && ev.response.error && (ev.response.error.message || ev.response.error.code))
        || "upstream response failed";
    }
  }
  if (failedMsg) throw new Error(String(failedMsg));
  flushText();
  const stopReason = incompleteReason === "max_output_tokens" ? "max_tokens" : (hadToolCalls ? "tool_use" : "end_turn");
  return {
    id: responseId,
    type: "message",
    role: "assistant",
    model: anthropicModel,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: responsesUsage(usage),
  };
}

// --- proxy wiring: openai-responses backend (codex/responses via anthropicFetch) -
// Like openaiTranslate but targets the Responses API. The upstream IS the full
// responses URL (https://chatgpt.com/backend-api/codex/responses) — NOT +/chat/
// completions. Uses anthropicFetch (curl) because chatgpt.com has the same TLS-
// fingerprint gate as Anthropic (Node fetch 403s; curl accepted). stream:true is
// forced upstream; a non-stream Anthropic request buffers + assembles via the
// collector. count_tokens returns the same chars/4 heuristic as the openai path.
function openaiResponsesUpstreamForBackend(backend) {
  if (!backend.codexOauth) return backend.upstream;
  const configured = String(backend.upstream || "").replace(/\/+$/, "");
  if (configured && configured !== CODEX_RESPONSES_UPSTREAM) throw new Error("codexOauth upstream must be " + CODEX_RESPONSES_UPSTREAM);
  return CODEX_RESPONSES_UPSTREAM;
}
function openaiResponsesModelForBackend(backend, requestedModel) {
  if (backend.codexOauth) return CODEX_RESPONSES_MODEL;
  return (backend.modelMap && backend.modelMap[requestedModel]) || requestedModel;
}
async function openaiResponsesTranslate(req, res, backend, body) {
  const logId = req._requestLogId;
  if (!body || !body.model) {
    markLogFinished(res, logId, { status: "error", httpStatus: 400, errorPreview: "router: missing body.model" });
    return sendJson(res, 400, { error: { type: "invalid_request_error", message: "router: missing body.model" } });
  }
  let upstream;
  try { upstream = openaiResponsesUpstreamForBackend(backend); }
  catch (e) { markLogFinished(res, logId, { status: "error", httpStatus: 500, errorPreview: String(e.message || e) }); return sendJson(res, 500, { error: { type: "configuration_error", message: String(e.message || e) } }); }
  const model = openaiResponsesModelForBackend(backend, body.model);

  if (req.url.startsWith("/v1/messages/count_tokens")) {
    markLogFinished(res, logId, { status: "success", httpStatus: 200, upstreamModel: model });
    return sendJson(res, 200, openaiCountTokensResponse(body));
  }

  const isStream = !!body.stream;
  const rBody = anthropicToOpenaiResponsesBody({ ...body, model });
  // The chatgpt.com codex endpoint is a constrained Responses subset: it rejects
  // max_output_tokens ("Unsupported parameter: max_output_tokens" → 400). Strip it
  // for codexOauth. A bearer openai-responses backend against the standard
  // api.openai.com/v1/responses keeps max_output_tokens (the Responses API accepts it).
  if (backend.codexOauth) delete rBody.max_output_tokens;
  requestLog.update(logId, { upstreamModel: model, upstream, authScheme: backend.codexOauth ? "codex-oauth" : "bearer" });
  requestLog.trace(logId, { requestBody: body, transformedBody: rBody });
  watchClientAbort(res, logId);

  let bearer;
  if (backend.codexOauth) {
    const creds = loadCodexCreds();
    if (!creds || !creds.access_token) {
      markLogFinished(res, logId, { status: "error", httpStatus: 401, errorPreview: "codex not logged in (no ~/.codex/auth.json)" });
      return sendJson(res, 401, { error: { type: "authentication_error", message: `claude-router: codex not logged in — run \`codex login\` first (no ~/.codex/auth.json).` } });
    }
    bearer = creds.access_token;
  } else {
    if (!backend.apiKey) {
      markLogFinished(res, logId, { status: "error", httpStatus: 401, errorPreview: `${backend.id}: missing API key` });
      return sendJson(res, 401, { error: { type: "authentication_error", message: `${backend.id}: missing API key` } });
    }
    bearer = backend.apiKey;
  }

  const headers = {
    "content-type": "application/json",
    "authorization": `Bearer ${bearer}`,
    "accept": "text/event-stream",
  };
  if (backend.codexOauth) {
    headers["user-agent"] = "codex/0.142.0";
    headers["origin"] = "https://chatgpt.com";
  }

  let up;
  try {
    up = await anthropicFetch(upstream, { method: "POST", headers, body: JSON.stringify(rBody) });
  } catch (e) {
    markLogFinished(res, logId, { status: "error", errorPreview: `${backend.id}: ${String(e)}` });
    return sendProxyError(res, 502, `${backend.id}: ${String(e)}`, "proxy_error", isStream);
  }
  if (!up.ok) {
    const text = await up.text();
    markLogFinished(res, logId, { status: "error", httpStatus: up.status, errorPreview: `upstream ${up.status}: ${text.slice(0, 300)}` });
    return sendProxyError(res, up.status, `${backend.id} upstream ${up.status}: ${text.slice(0, 500)}`, (up.status === 429 ? "rate_limit_error" : "api_error"), isStream);
  }

  const reader = up.body.getReader();
  const iter = (async function* () { for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; } })();

  if (isStream) {
    requestLog.update(logId, { status: "streaming", httpStatus: 200 });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
    let streamErr = null;
    let acc = "";
    const CAP = 65536;
    try {
      for await (const block of openaiResponsesSseToAnthropicSse(iter, body.model)) {
        res.write(block);
        if (acc.length < CAP) { acc += block; if (acc.length > CAP) acc = acc.slice(0, CAP); }
      }
    } catch (e) {
      streamErr = String(e);
      const errBlock = sseBlock("error", { type: "error", error: { type: "api_error", message: String(e) } });
      res.write(errBlock);
      if (acc.length < CAP) acc += errBlock;
    }
    const patch = streamErr
      ? { status: "error", httpStatus: 200, errorPreview: streamErr, ...requestLogPatchFromAnthropicSseText(acc) }
      : { status: "success", httpStatus: 200, ...requestLogPatchFromAnthropicSseText(acc) };
    requestLog.trace(logId, { sseEventsPreview: acc.split("\n\n").filter(Boolean).slice(0, 40).map((b) => b.slice(0, 800)) });
    markLogFinished(res, logId, patch);
    res.end();
  } else {
    try {
      const anth = await openaiResponsesToAnthropicResponse(iter, body.model);
      requestLog.trace(logId, { responseBody: anth });
      markLogFinished(res, logId, { status: "success", httpStatus: 200, ...anthropicUsageFromResponse(anth) });
      sendJson(res, 200, anth);
    } catch (e) {
      markLogFinished(res, logId, { status: "error", httpStatus: 502, errorPreview: `${backend.id}: ${String(e)}` });
      sendJson(res, 502, { error: { type: "api_error", message: `${backend.id}: ${String(e)}` } });
    }
  }
}

// --- proxy wiring: openai-format backend (plain fetch — no TLS gate on GLM/codex) -
async function openaiTranslate(req, res, backend, body) {
  const logId = req._requestLogId;
  if (!body || !body.model) {
    markLogFinished(res, logId, { status: "error", httpStatus: 400, errorPreview: "router: missing body.model" });
    return sendJson(res, 400, { error: { type: "invalid_request_error", message: "router: missing body.model" } });
  }
  const model = (backend.modelMap && backend.modelMap[body.model]) || body.model;

  if (req.url.startsWith("/v1/messages/count_tokens")) {
    markLogFinished(res, logId, { status: "success", httpStatus: 200, upstreamModel: model });
    return sendJson(res, 200, openaiCountTokensResponse(body));
  }

  const isStream = !!body.stream;
  const oaiBody = anthropicToOpenaiBody({ ...body, model });
  const url = backend.upstream + "/chat/completions";
  requestLog.update(logId, { upstreamModel: model, upstream: url });
  requestLog.trace(logId, { requestBody: body, transformedBody: oaiBody });
  watchClientAbort(res, logId);
  const headers = { "content-type": "application/json", "authorization": `Bearer ${backend.apiKey}` };
  if (isStream) headers.accept = "text/event-stream";

  let up;
  try {
    up = await throttledBackendFetch(backend, () => fetch(url, { method: "POST", headers, body: JSON.stringify(oaiBody) }));
  } catch (e) {
    markLogFinished(res, logId, { status: "error", errorPreview: `${backend.id}: ${String(e)}` });
    return sendProxyError(res, 502, `${backend.id}: ${String(e)}`, "proxy_error", isStream);
  }
  if (!up.ok) {
    const text = await up.text();
    markLogFinished(res, logId, { status: "error", httpStatus: up.status, errorPreview: `upstream ${up.status}: ${text.slice(0, 300)}` });
    return sendProxyError(res, up.status, `${backend.id} upstream ${up.status}: ${text.slice(0, 500)}`, (up.status === 429 ? "rate_limit_error" : "api_error"), isStream);
  }

  if (isStream) {
    requestLog.update(logId, { status: "streaming", httpStatus: 200 });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
    let streamErr = null;
    let acc = "";
    const CAP = 65536;
    try {
      const reader = up.body.getReader();
      const iter = (async function* () { for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; } })();
      for await (const block of openaiSseToAnthropicSse(iter, body.model)) {
        res.write(block);
        if (acc.length < CAP) { acc += block; if (acc.length > CAP) acc = acc.slice(0, CAP); }
      }
    } catch (e) {
      streamErr = String(e);
      const errBlock = sseBlock("error", { type: "error", error: { type: "api_error", message: String(e) } });
      res.write(errBlock);
      if (acc.length < CAP) acc += errBlock;
    }
    const patch = streamErr
      ? { status: "error", httpStatus: 200, errorPreview: streamErr, ...requestLogPatchFromAnthropicSseText(acc) }
      : { status: "success", httpStatus: 200, ...requestLogPatchFromAnthropicSseText(acc) };
    requestLog.trace(logId, { sseEventsPreview: acc.split("\n\n").filter(Boolean).slice(0, 40).map((b) => b.slice(0, 800)) });
    markLogFinished(res, logId, patch);
    res.end();
  } else {
    const json = await up.json();
    const anth = openaiToAnthropicResponse(json, body.model);
    requestLog.trace(logId, { responseBody: anth });
    markLogFinished(res, logId, { status: "success", httpStatus: 200, ...anthropicUsageFromResponse(anth) });
    sendJson(res, 200, anth);
  }
}

// Remove unsigned thinking blocks from assistant history before sending to Claude.
// Cross-backend contamination: GLM/Codex emit thinking blocks with signature:"" (no
// valid Anthropic signature). When a conversation later routes to real Claude, Claude
// rejects them with 400 "Invalid signature in thinking block". We drop thinking/
// redacted_thinking blocks lacking a non-empty signature; if that empties an assistant
// turn, fall back to a minimal text block so the turn stays structurally valid.
function sanitizeThinkingForClaude(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return m;
    let dropped = false;
    const content = m.content.filter((c) => {
      if (c && (c.type === "thinking" || c.type === "redacted_thinking")) {
        const sig = typeof c.signature === "string" ? c.signature : "";
        if (!sig) { dropped = true; return false; } // unsigned → drop
      }
      return true;
    });
    if (!dropped) return m;
    changed = true;
    const safe = content.length ? content : [{ type: "text", text: "" }];
    return { ...m, content: safe };
  });
  return changed ? out : messages;
}

// --- per-backend anthropic passthrough (reuses header helpers; anthropicFetch) ---
// IRON RULE: byte-for-byte passthrough. Uses anthropicFetch (curl → nodeProxyFetch
// fallback) for the upstream call — NOT plain fetch — or the subscription-OAuth 403
// (TLS-fingerprint gate) returns.
async function anthropicPassthrough(req, res, backend, body) {
  const logId = req._requestLogId;
  const isStream = !!(body && body.stream);
  const model = (body && backend.modelMap && backend.modelMap[body.model]) || (body && body.model);
  let sendBody = req._rawBody;                                  // raw bytes by default
  let urlQuery = "";
  // OAuth subscription path: Anthropic's 429 soft-block is a BODY-CONTENT gate — the
  // literal Claude-Code identity sentence MUST be the first system block (vellum-oauth-proxy /
  // CLIProxyAPI / openclaw / horselock all inject this on stock HTTP). x-api-key anthropic
  // backends passthrough unchanged.
  if (body && backend.authScheme === "oauth") {
    const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
    let sys;
    if (Array.isArray(body.system)) sys = body.system.slice();
    else if (typeof body.system === "string") sys = body.system ? [{ type: "text", text: body.system }] : [];
    else sys = [];
    const hasIdentity = sys.some((b) => b && b.type === "text" && typeof b.text === "string" && b.text.includes(IDENTITY));
    if (!hasIdentity) sys = [{ type: "text", text: IDENTITY }, ...sys];
    // Strip UNSIGNED thinking blocks from assistant history before sending to Claude.
    // GLM/Codex emit thinking blocks with signature:"" — when the conversation later
    // routes to real Claude (opus), Claude validates the signature and 400s with
    // "Invalid signature in thinking block" (messages.N.content.0). Drop thinking/
    // redacted_thinking blocks that lack a non-empty signature; keep signed ones.
    const cleanMessages = sanitizeThinkingForClaude(body.messages);
    sendBody = Buffer.from(JSON.stringify({ ...body, model: model || body.model, system: sys, messages: cleanMessages }));
    if (req.url === "/v1/messages") urlQuery = "?beta=true"; // gateway-protocol: inference posts to /v1/messages?beta=true
  } else if (body && model && model !== body.model) {
    sendBody = Buffer.from(JSON.stringify({ ...body, model })); // cheap rewrite for modelMap
  }
  const url = backend.upstream + req.url + urlQuery;             // /v1/messages[?beta=true] | /v1/messages/count_tokens
  requestLog.update(logId, { upstream: url, upstreamModel: model || (body && body.model) || null });
  if (body) requestLog.trace(logId, { requestBody: body, transformedBody: (() => { try { return sendBody && sendBody.length ? JSON.parse(sendBody.toString("utf8")) : null; } catch { return null; } })() });
  watchClientAbort(res, logId);
  // curl (anthropicFetch) only for TLS-gated hosts (api.anthropic.com / platform.claude.com);
  // non-Anthropic anthropic-format backends (DashScope GLM etc.) must use plain fetch —
  // dashscope throttles curl with 429 "Throttling" (curl→429 ~5s, Node fetch→200 ~5s, same key).
  let upHost = ""; try { upHost = new URL(backend.upstream).hostname; } catch {}
  const upFetch = (backend.authScheme === "oauth" || upHost === "api.anthropic.com" || upHost === "platform.claude.com") ? anthropicFetch : fetch;
  const doFetch = (hdrs) => upFetch(url, { method: req.method, headers: hdrs, body: sendBody && sendBody.length ? sendBody : undefined });
  if (backend.authScheme !== "oauth") {
    const headers = headersKey(req.headers, backend.apiKey);
    let up;
    try { up = await throttledBackendFetch(backend, () => doFetch(headers)); }
    catch (e) { markLogFinished(res, logId, { status: "error", errorPreview: String(e) }); return sendJson(res, 502, { error: { type: "proxy_error", message: String(e) } }); }
    return streamUpstream(res, up, { id: logId, isStream });
  }

  let store = await accountsForUse();
  if (!store.accounts.length) { markLogFinished(res, logId, { status: "error", httpStatus: 503, errorPreview: "no accounts available" }); return sendJson(res, 503, unavailableAccountsPayload()); }

  const tried = new Set();
  for (let rotateAttempt = 0; rotateAttempt < MAX_ROTATE_RETRIES; rotateAttempt++) {
    store = await accountsForUse();
    const account = pickAccount(store, Date.now(), tried);
    if (!account) { markLogFinished(res, logId, { status: "error", httpStatus: 503, errorPreview: "no account available", rotationCount: rotateAttempt }); return sendJson(res, 503, unavailableAccountsPayload()); }
    requestLog.update(logId, { accountId: account.id, organizationName: account.organization_name || null, organizationUuid: account.organization_uuid || null, rotationCount: rotateAttempt });

    let up;
    try {
      const token = await ensureAccountAccessToken(store, account);
      if (!token) {
        applyAccountFailure(store, account, 401, {}, "", Date.now());
        saveAccounts(store);
        tried.add(account.id);
        continue;
      }
      up = await throttledBackendFetch(backend, () => doFetch(headersOAuth(req.headers, token)));
    } catch (e) {
      markLogFinished(res, logId, { status: "error", errorPreview: String(e) });
      return sendJson(res, 502, { error: { type: "proxy_error", message: String(e) } });
    }

    if (up.status === 401 || up.status === 403) {
      const refreshTries = up.status === 403 ? 2 : 1;
      for (let i = 0; i < refreshTries && (up.status === 401 || up.status === 403); i++) {
        await safeReadText(up);
        try {
          const refreshedToken = await ensureAccountAccessToken(store, account, true);
          up = await throttledBackendFetch(backend, () => doFetch(headersOAuth(req.headers, refreshedToken)));
        } catch {
          break;
        }
      }
    }

    if (up.status === 400) {
      const text = await safeReadText(up);
      if (applyAccountFailure(store, account, up.status, up.headers, text, Date.now())) {
        saveAccounts(store);
        tried.add(account.id);
        continue;
      }
      markLogFinished(res, logId, { status: "error", httpStatus: 400, errorPreview: String(text).slice(0, 300) });
      return sendUpstreamText(res, up, text);
    }

    if (up.status === 429 || up.status === 529 || up.status === 401 || up.status === 403) {
      const text = await safeReadText(up);
      applyAccountFailure(store, account, up.status, up.headers, text, Date.now());
      saveAccounts(store);
      tried.add(account.id);
      requestLog.update(logId, { errorPreview: `acct ${account.id} → ${up.status}, rotating` });
      continue;
    }

    // AUTO-SWITCH: this account served the request OK. If it isn't the current active
    // account (i.e. we rotated here because the previous active one hit 429/cooldown),
    // promote it to active — the pool stays on the working org instead of bouncing back
    // to the rate-limited one when its cooldown expires, and the dashboard reflects it.
    if (up.status >= 200 && up.status < 300 && store.active_id !== account.id) {
      store.active_id = account.id;
      saveAccounts(store);
      try { process.stderr.write(`[claude-router] auto-switched active account -> ${account.id} (${account.organization_name || account.organization_uuid || ""}) after 429/rotate\n`); } catch {}
    }
    return streamUpstream(res, up, { id: logId, isStream });
  }

  markLogFinished(res, logId, { status: "error", httpStatus: 503, errorPreview: "all accounts exhausted" });
  return sendJson(res, 503, unavailableAccountsPayload());
}

// --- request inspector: settings + redaction ------------------------------------
// All inspector state lives under CFG_DIR. The hard rule everywhere below: logging is
// best-effort. Every public entry point of `requestLog` is wrapped so a thrown error
// (disk full, bad JSON, EPERM) is swallowed — a user's /v1/messages request must never
// fail because the audit log could not be written.
const REQUEST_SETTINGS_DEFAULTS = {
  fullTraceEnabled: false,
  promptPreviewChars: 1000,
  maxRecentRequests: 1000,
  maxTraceFiles: 200,
  maxLogBytes: 26214400, // 25 MiB
};
function sanitizeRequestSettings(raw) {
  const s = { ...REQUEST_SETTINGS_DEFAULTS };
  if (raw && typeof raw === "object") {
    if (typeof raw.fullTraceEnabled === "boolean") s.fullTraceEnabled = raw.fullTraceEnabled;
    s.promptPreviewChars = clampInt(raw.promptPreviewChars, s.promptPreviewChars, 100, 5000);
    s.maxRecentRequests = clampInt(raw.maxRecentRequests, s.maxRecentRequests, 50, 5000);
    s.maxTraceFiles = clampInt(raw.maxTraceFiles, s.maxTraceFiles, 0, 1000);
    s.maxLogBytes = clampInt(raw.maxLogBytes, s.maxLogBytes, 1048576, 209715200); // 1MB–200MB
  }
  return s;
}
function loadRequestSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(REQUEST_SETTINGS_FILE, "utf8"));
    return sanitizeRequestSettings(raw);
  } catch { return { ...REQUEST_SETTINGS_DEFAULTS }; }
}
function saveRequestSettings(settings) {
  const clean = sanitizeRequestSettings(settings);
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(REQUEST_SETTINGS_FILE, JSON.stringify(clean, null, 2), { mode: 0o600 });
  return clean;
}

// Keys whose values are secrets regardless of content.
const SECRET_KEY_RE = /^(authorization|x-api-key|apikey|api_key|anthropic[-_]auth[-_]token|access[-_]?token|refresh[-_]?token|client[-_]?secret|cookie|set-cookie|password|secret)$/i;
// Auth-ish key names where a long opaque token-looking value should also be masked.
const AUTHISH_KEY_RE = /(authorization|token|secret|key|bearer|credential)/i;
const REDACTED = "[REDACTED]";
function redactSecretString(s) {
  if (typeof s !== "string" || !s) return s;
  let out = s;
  // sk-..., sk-ant-..., and other provider-prefixed secret tokens
  out = out.replace(/\b(sk|sk-ant|sk-proj|gsk|ya29|ghp|github_pat)[-_][A-Za-z0-9_-]{8,}/g, REDACTED);
  // Bearer <token>
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, "Bearer " + REDACTED);
  return out;
}
// Recursively redact secrets in strings / arrays / objects. Never throws.
function redactSecrets(value, keyName = "") {
  try {
    if (value == null) return value;
    if (typeof value === "string") {
      if (keyName && SECRET_KEY_RE.test(keyName)) return REDACTED;
      if (keyName && AUTHISH_KEY_RE.test(keyName) && /^[A-Za-z0-9_.\-+/=~]{40,}$/.test(value)) return REDACTED;
      return redactSecretString(value);
    }
    if (Array.isArray(value)) return value.map((v) => redactSecrets(v, keyName));
    if (typeof value === "object") {
      const out = {};
      for (const k of Object.keys(value)) {
        if (SECRET_KEY_RE.test(k)) { out[k] = REDACTED; continue; }
        out[k] = redactSecrets(value[k], k);
      }
      return out;
    }
    return value;
  } catch { return REDACTED; }
}

// Build a short, redacted, human-readable preview of the request prompt.
function buildPromptPreview(body, maxChars) {
  try {
    if (!body || typeof body !== "object") return "";
    const parts = [];
    const pushText = (label, content) => {
      if (typeof content === "string") { if (content.trim()) parts.push(`${label}: ${content.trim()}`); return; }
      if (Array.isArray(content)) {
        const text = content.map((b) => {
          if (typeof b === "string") return b;
          if (b && typeof b === "object") {
            if (typeof b.text === "string") return b.text;
            if (b.type === "image") return "[image]";
            if (b.type === "tool_use") return `[tool_use ${b.name || ""}]`;
            if (b.type === "tool_result") return "[tool_result]";
          }
          return "";
        }).filter(Boolean).join(" ");
        if (text.trim()) parts.push(`${label}: ${text.trim()}`);
      }
    };
    if (body.system) pushText("System", body.system);
    if (Array.isArray(body.messages)) {
      for (const m of body.messages) {
        if (!m || typeof m !== "object") continue;
        const role = m.role === "assistant" ? "Assistant" : m.role === "system" ? "System" : "User";
        pushText(role, m.content);
      }
    } else if (Array.isArray(body.input)) {
      // Responses-style payloads land here as a fallback.
      for (const m of body.input) { if (m && typeof m === "object") pushText(m.role === "assistant" ? "Assistant" : "User", m.content); }
    } else if (typeof body.prompt === "string") {
      pushText("Prompt", body.prompt);
    }
    let preview = parts.join("\n");
    preview = redactSecretString(preview);
    const cap = clampInt(maxChars, REQUEST_SETTINGS_DEFAULTS.promptPreviewChars, 100, 5000);
    if (preview.length > cap) preview = preview.slice(0, cap) + "…";
    return preview;
  } catch { return ""; }
}

// --- request inspector: log store ------------------------------------------------
const requestLog = {
  recent: [],
  settings: loadRequestSettings(),
  _seq: 0,

  reloadSettings() { try { this.settings = loadRequestSettings(); } catch {} return this.settings; },

  // Path resolvers — default to module constants but honor `this._dir` (used by selftest
  // to isolate file I/O into a temp directory without touching ~/.claude-router).
  _dir: null,
  _baseDir() { return this._dir || CFG_DIR; },
  _logFile() { return this._dir ? path.join(this._dir, "requests.jsonl") : REQUEST_LOG_FILE; },
  _logFile1() { return this._dir ? path.join(this._dir, "requests.1.jsonl") : REQUEST_LOG_FILE_1; },
  _traceDir() { return this._dir ? path.join(this._dir, "request-traces") : REQUEST_TRACE_DIR; },

  _newId() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const rand = crypto.randomBytes(4).toString("hex");
    return `req_${stamp}_${rand}`;
  },

  // Begin tracking a request. Returns an id (or null if everything failed).
  start(req, body, backend) {
    try {
      const now = Date.now();
      const id = this._newId();
      const rec = {
        id,
        startedAt: now,
        finishedAt: null,
        latencyMs: null,
        method: (req && req.method) || "POST",
        path: (req && req.url ? String(req.url).split("?")[0] : ""),
        stream: !!(body && body.stream),
        requestedModel: (body && body.model) || null,
        upstreamModel: null,
        backendId: backend ? backend.id : null,
        backendName: backend ? (backend.name || backend.id) : null,
        backendFormat: backend ? backend.format : null,
        authScheme: backend ? (backend.authScheme || (backend.codexOauth ? "codex-oauth" : "bearer")) : null,
        // Additive virtual-model fields (absent on normal requests — non-regressive).
        // `requestedModel` above already reflects the rewritten target model; these
        // carry the original alias + which rule fired for the inspector.
        virtualModelId: (req && req._virtualModel) ? req._virtualModel.id : null,
        virtualRequestedModel: (req && req._virtualModel) ? (req._virtualModel.requested || null) : null,
        virtualMatchedRule: (req && req._virtualModel) ? (req._virtualModel.rule || null) : null,
        upstream: null,
        accountId: null,
        organizationName: null,
        organizationUuid: null,
        status: "pending",
        httpStatus: null,
        stopReason: null,
        usage: null,
        promptPreview: buildPromptPreview(body, this.settings.promptPreviewChars),
        errorPreview: "",
        retryCount: 0,
        rotationCount: 0,
        traceAvailable: false,
      };
      this.recent.push(rec);
      const cap = clampInt(this.settings.maxRecentRequests, REQUEST_SETTINGS_DEFAULTS.maxRecentRequests, 50, 5000);
      while (this.recent.length > cap) this.recent.shift();
      return id;
    } catch { return null; }
  },

  _find(id) { if (!id) return null; for (let i = this.recent.length - 1; i >= 0; i--) if (this.recent[i].id === id) return this.recent[i]; return null; },

  // Patch an in-memory record without persisting (used during pending/streaming).
  update(id, patch) {
    try { const rec = this._find(id); if (rec && patch) Object.assign(rec, patch); } catch {}
  },

  get(id) {
    const rec = this._find(id);
    if (rec) return rec;
    // best-effort tail scan of jsonl (+ rotated) for an evicted record
    try {
      for (const file of [this._logFile(), this._logFile1()]) {
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, "utf8").split("\n");
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim();
          if (!line) continue;
          try { const obj = JSON.parse(line); if (obj && obj.id === id) return obj; } catch {}
        }
      }
    } catch {}
    return null;
  },

  // Finalize a record: set terminal status + latency, persist one JSONL line.
  finish(id, patch) {
    try {
      const rec = this._find(id);
      if (!rec) return;
      if (patch) Object.assign(rec, patch);
      if (rec.finishedAt == null) rec.finishedAt = Date.now();
      if (rec.latencyMs == null) rec.latencyMs = Math.max(0, rec.finishedAt - rec.startedAt);
      if (typeof rec.errorPreview === "string" && rec.errorPreview.length > 600) rec.errorPreview = rec.errorPreview.slice(0, 600);
      this._append(rec);
      this._totalsCache = null; // invalidate: a finished request adds usage to the totals
    } catch {}
  },

  _append(rec) {
    try {
      fs.mkdirSync(this._baseDir(), { recursive: true });
      this._rotateIfNeeded();
      fs.appendFileSync(this._logFile(), JSON.stringify(rec) + "\n", { mode: 0o600 });
    } catch {}
  },

  _rotateIfNeeded() {
    try {
      const max = clampInt(this.settings.maxLogBytes, REQUEST_SETTINGS_DEFAULTS.maxLogBytes, 1048576, 209715200);
      let size = 0;
      try { size = fs.statSync(this._logFile()).size; } catch { return; }
      if (size < max) return;
      try { fs.unlinkSync(this._logFile1()); } catch {}
      fs.renameSync(this._logFile(), this._logFile1());
    } catch {}
  },

  // Write/merge an optional full trace file (only when full trace is enabled).
  trace(id, patch) {
    try {
      if (!this.settings.fullTraceEnabled || !id || !patch) return;
      const dir = this._traceDir();
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${id}.json`);
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
      const merged = { id, ...existing };
      for (const k of Object.keys(patch)) merged[k] = redactSecrets(patch[k], k);
      fs.writeFileSync(file, JSON.stringify(merged, null, 2), { mode: 0o600 });
      this.update(id, { traceAvailable: true });
      this._pruneTraces();
    } catch {}
  },

  getTrace(id) {
    try {
      if (!id || !/^req_[A-Za-z0-9_]+$/.test(id)) return null; // guard path traversal
      const file = path.join(this._traceDir(), `${id}.json`);
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { return null; }
  },

  _pruneTraces() {
    try {
      const cap = clampInt(this.settings.maxTraceFiles, REQUEST_SETTINGS_DEFAULTS.maxTraceFiles, 0, 1000);
      const dir = this._traceDir();
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return; }
      if (files.length <= cap) return;
      const withTime = files.map((f) => {
        let mtime = 0; try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
        return { f, mtime };
      }).sort((a, b) => a.mtime - b.mtime); // oldest first
      for (let i = 0; i < withTime.length - cap; i++) {
        try { fs.unlinkSync(path.join(dir, withTime[i].f)); } catch {}
      }
    } catch {}
  },

  // Filtered, newest-first view of the in-memory buffer + summary stats.
  list(filters = {}) {
    const { status, backend, model, q, limit } = filters || {};
    // absent/empty limit → use the full buffer cap (NOT 1). clampInt(null,…) would
    // coerce null→0→1, collapsing the list to a single row — the "only one request"
    // bug. Only honor an explicit positive limit.
    const hasLimit = limit != null && String(limit).trim() !== "" && Number.isFinite(Number(limit)) && Number(limit) > 0;
    const cap = hasLimit ? clampInt(limit, this.settings.maxRecentRequests, 1, 5000) : 5000;
    const qLower = q ? String(q).toLowerCase() : "";
    const modelLower = model ? String(model).toLowerCase() : "";
    let rows = this.recent.slice();
    rows.reverse(); // newest first
    const filtered = rows.filter((r) => {
      if (status && r.status !== status) return false;
      if (backend && r.backendId !== backend) return false;
      if (modelLower) {
        const m = `${r.requestedModel || ""} ${r.upstreamModel || ""}`.toLowerCase();
        if (!m.includes(modelLower)) return false;
      }
      if (qLower && !String(r.promptPreview || "").toLowerCase().includes(qLower)) return false;
      return true;
    }).slice(0, cap);
    // stats computed over the full recent buffer (not the filtered subset)
    let pending = 0, success = 0, error = 0, latSum = 0, latN = 0, lastError = "";
    const recentErrors = [];
    for (const r of this.recent) {
      if (r.status === "pending" || r.status === "streaming") pending++;
      else if (r.status === "success") success++;
      else if (r.status === "error" || r.status === "client_aborted") {
        error++;
        if (r.errorPreview) lastError = r.errorPreview;
        recentErrors.push({ id: r.id, startedAt: r.startedAt, requestedModel: r.requestedModel, backendId: r.backendId, status: r.status, httpStatus: r.httpStatus, errorPreview: r.errorPreview || "" });
      }
      if (typeof r.latencyMs === "number") { latSum += r.latencyMs; latN++; }
    }
    recentErrors.reverse(); // newest first
    return {
      requests: filtered,
      stats: {
        totalRecent: this.recent.length,
        pending, success, error,
        avgLatencyMs: latN ? Math.round(latSum / latN) : 0,
        lastError,
        recentErrors: recentErrors.slice(0, 200),
      },
    };
  },

  clear() {
    try { this.recent.length = 0; } catch {}
    try { fs.writeFileSync(this._logFile(), "", { mode: 0o600 }); } catch {}
    try { fs.unlinkSync(this._logFile1()); } catch {}
    try {
      for (const f of fs.readdirSync(this._traceDir())) {
        if (f.endsWith(".json")) { try { fs.unlinkSync(path.join(this._traceDir(), f)); } catch {} }
      }
    } catch {}
    this._totalsCache = null; // invalidate totals cache
  },

  // Aggregate tokens from the FULL JSONL log + in-memory buffer (not just the
  // recent buffer). The big Dashboard counter should reflect ALL logged history,
  // not just the last N requests in memory. Dedupes by request id (buffer + JSONL
  // overlap for finished requests). Cached; invalidated on finish()/clear().
  _totalsCache: null,
  totals() {
    if (this._totalsCache) return this._totalsCache;
    const byModel = {};
    let totalInput = 0, totalOutput = 0;
    const seen = new Set();
    const aggregate = (rec) => {
      if (!rec || seen.has(rec.id)) return;
      seen.add(rec.id);
      const model = rec.requestedModel || rec.upstreamModel || "unknown";
      const u = rec.usage || {};
      const inp = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const out = u.output_tokens || 0;
      totalInput += inp; totalOutput += out;
      if (!byModel[model]) byModel[model] = { input: 0, output: 0, count: 0 };
      byModel[model].input += inp; byModel[model].output += out; byModel[model].count++;
    };
    // scan JSONL file(s) — full history (rotated + current)
    for (const file of [this._logFile1(), this._logFile()]) {
      try {
        if (!fs.existsSync(file)) continue;
        const data = fs.readFileSync(file, "utf8");
        for (const line of data.split("\n")) {
          const t = line.trim();
          if (!t) continue;
          try { aggregate(JSON.parse(t)); } catch {}
        }
      } catch {}
    }
    // scan in-memory buffer (adds pending/streaming not yet flushed to JSONL)
    for (const r of this.recent) aggregate(r);
    this._totalsCache = { totalInputTokens: totalInput, totalOutputTokens: totalOutput, byModel };
    return this._totalsCache;
  },
};

// Pull usage + stop_reason out of a parsed Anthropic-shaped response object.
function anthropicUsageFromResponse(json) {
  try {
    if (!json || typeof json !== "object") return {};
    const out = {};
    if (json.usage && typeof json.usage === "object") {
      const u = json.usage;
      out.usage = {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        ...(u.cache_creation_input_tokens != null ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}),
        ...(u.cache_read_input_tokens != null ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
      };
    }
    if (typeof json.stop_reason === "string") out.stopReason = json.stop_reason;
    return out;
  } catch { return {}; }
}
// Attach a one-time client-abort watcher: if the socket closes before the record is
// finalized, mark it client_aborted. `res._logFinished` is the guard set by finish.
function watchClientAbort(res, id) {
  try {
    if (!id || !res) return;
    res.on("close", () => {
      try {
        if (res._logFinished) return;
        const rec = requestLog._find(id);
        if (rec && (rec.status === "pending" || rec.status === "streaming")) {
          requestLog.finish(id, { status: "client_aborted", errorPreview: rec.errorPreview || "client disconnected before completion" });
        }
      } catch {}
    });
  } catch {}
}
function markLogFinished(res, id, patch) {
  try { if (res) res._logFinished = true; } catch {}
  requestLog.finish(id, patch);
}
function requestLogPatchFromAnthropicSseText(text) {
  const patch = {};
  let sawError = false;
  try {
    for (const block of String(text || "").split("\n\n")) {
      if (!block.trim()) continue;
      if (/^event:\s*error/m.test(block)) sawError = true;
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      let obj;
      try { obj = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
      if (obj && obj.delta && obj.delta.stop_reason) patch.stopReason = obj.delta.stop_reason;
      if (obj && obj.usage) {
        const u = obj.usage;
        patch.usage = {
          input_tokens: u.input_tokens,
          output_tokens: u.output_tokens,
          ...(u.cache_creation_input_tokens != null ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}),
          ...(u.cache_read_input_tokens != null ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
        };
      }
      if (obj && obj.message && obj.message.usage && !patch.usage) {
        const u = obj.message.usage;
        patch.usage = {
          input_tokens: u.input_tokens,
          output_tokens: u.output_tokens,
          ...(u.cache_creation_input_tokens != null ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}),
          ...(u.cache_read_input_tokens != null ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
        };
      }
      if (obj && obj.type === "error") {
        sawError = true;
        patch.errorPreview = JSON.stringify(obj.error || obj).slice(0, 300);
      }
    }
  } catch {}
  if (sawError) patch.status = "error";
  return patch;
}

// --- request lifecycle -----------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
// Byte-for-byte passthrough. `log` (optional) = { id, isStream } enables audit-log
// finalization: we additionally accumulate a capped copy of the body to extract
// usage/stop_reason/errors — the raw bytes streamed to the client are untouched.
// Pull a human message out of an upstream error body (JSON {error:{message}} /
// {message} / {code}, or an SSE "data:" line, or raw text).
function extractUpstreamErrorMessage(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  let jsonStr = t;
  if (/^event:|\bdata:/m.test(t)) {
    const dl = t.split(/\r?\n/).find((l) => l.trim().startsWith("data:"));
    if (dl) jsonStr = dl.replace(/^\s*data:\s*/, "").trim();
  }
  try {
    const o = JSON.parse(jsonStr);
    if (o && o.error && (o.error.message || o.error.type)) return o.error.message || o.error.type;
    if (o && o.message) return String(o.message);
    if (o && o.code) return o.code + (o.message ? ": " + o.message : "");
    return jsonStr.slice(0, 400);
  } catch { return t.slice(0, 400); }
}

// Send an error to the client in the shape its client expects. A STREAMING client
// (Anthropic SDK) on a non-2xx reads the body as text and JSON.parse()s it — so it must
// get either a clean JSON error (non-stream) or a 200 + SSE `event: error` frame
// (stream). Never hand a streaming client a non-2xx with a non-JSON/SSE-shaped body.
function sendProxyError(res, status, message, errType, isStream) {
  if (res.headersSent) { try { res.end(); } catch {} return; }
  const errObj = { type: "error", error: { type: errType || "api_error", message: String(message).slice(0, 600) } };
  if (isStream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
    res.write(`event: error\ndata: ${JSON.stringify(errObj)}\n\n`);
    res.end();
  } else {
    sendJson(res, status, errObj);
  }
}

async function streamUpstream(res, up, log) {
  const ct = up.headers.get("content-type") || "application/json";
  const headers = { "content-type": ct };
  const logId = log && log.id;
  const isSse = ct.includes("text/event-stream") || (log && log.isStream);
  const CAP = 65536; // accumulate at most 64KB for parsing/preview
  // NON-2xx upstream: NEVER forward the raw status+body to the client. Anthropic's SDK,
  // on a non-2xx streaming request, reads the body as TEXT and JSON.parse()s it — if the
  // upstream returned an SSE-framed or non-Anthropic-shaped error body (e.g. DashScope's
  // 400 "event:error\ndata:{code,message}"), that parse fails → "Failed to parse JSON".
  // Re-shape it: streaming client → 200 + text/event-stream + a proper Anthropic
  // `event: error` frame (the SDK's stream parser handles it); non-streaming → status +
  // a clean Anthropic-shaped JSON error.
  if (up.status >= 400) {
    let text = "";
    try {
      if (up.body) {
        const reader = up.body.getReader();
        const dec = new TextDecoder();
        for (;;) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); if (text.length > CAP) break; }
      }
    } catch {}
    const msg = extractUpstreamErrorMessage(text) || `upstream error ${up.status}`;
    const errType = up.status === 429 ? "rate_limit_error" : (up.status >= 500 ? "api_error" : "invalid_request_error");
    const errObj = { type: "error", error: { type: errType, message: msg } };
    if (log && log.isStream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
      res.write(`event: error\ndata: ${JSON.stringify(errObj)}\n\n`);
    } else {
      res.writeHead(up.status, { "content-type": "application/json" });
      res.write(JSON.stringify(errObj));
    }
    if (logId) markLogFinished(res, logId, { status: "error", httpStatus: up.status, errorPreview: msg.slice(0, 300) });
    res.end();
    return;
  }
  if (logId) {
    requestLog.update(logId, { httpStatus: up.status, status: isSse ? "streaming" : "pending" });
    requestLog.trace(logId, { upstreamHeaders: { "content-type": ct } });
  }
  res.writeHead(up.status, headers);
  let acc = "";
  let streamErr = null;
  if (up.body) {
    const reader = up.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
        if (logId && acc.length < CAP) { try { acc += decoder.decode(value, { stream: true }); if (acc.length > CAP) acc = acc.slice(0, CAP); } catch {} }
      }
    } catch (e) {
      // Upstream dropped mid-stream. Terminate CLEANLY so the client doesn't choke on a
      // truncated partial SSE event ("API Error: Failed to parse JSON"). For an SSE stream,
      // emit a proper Anthropic `event: error` frame as the terminal event; the client's
      // stream parser handles it instead of failing on a dangling `data: {incomplete`.
      streamErr = String(e && e.message || e);
      if (isSse) { try { res.write(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: "upstream stream interrupted: " + streamErr } })}\n\n`); } catch {} }
    }
  }
  if (!logId) { res.end(); return; }
  try {
    if (up.status >= 400) {
      markLogFinished(res, logId, { status: "error", httpStatus: up.status, errorPreview: acc.slice(0, 300) });
      requestLog.trace(logId, { responseBodyPreview: acc.slice(0, 32768) });
    } else if (isSse) {
      const events = [];
      for (const block of acc.split("\n\n")) {
        if (!block.trim()) continue;
        if (events.length < 40) events.push(block.slice(0, 800));
      }
      const patch = { status: streamErr ? "error" : "success", httpStatus: up.status, ...requestLogPatchFromAnthropicSseText(acc) };
      if (streamErr) patch.errorPreview = "stream interrupted: " + streamErr;
      requestLog.trace(logId, { sseEventsPreview: events });
      markLogFinished(res, logId, patch);
    } else {
      let patch = { status: "success", httpStatus: up.status };
      try { const json = JSON.parse(acc); Object.assign(patch, anthropicUsageFromResponse(json)); requestLog.trace(logId, { responseBody: json }); } catch { requestLog.trace(logId, { responseBodyPreview: acc.slice(0, 32768) }); }
      markLogFinished(res, logId, patch);
    }
  } catch {}
  res.end();
}

// proxy(): read body once (raw + parsed), route by body.model, dispatch by format.
// Virtual-model resolution (if any VM matches body.model) happens BETWEEN body parse
// and backend dispatch: it rewrites body.model to the chosen target model so every
// downstream path (passthrough/translate/modelMap) sees a real upstream model. When no
// VM is defined or body.model is not a VM alias, the path is byte-identical to today.
async function proxy(req, res) {
  const raw = await readBody(req);
  req._rawBody = raw;
  let body = null;
  if (raw.length) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; } } // non-JSON → passthrough raw
  req._body = body;
  const cfg = loadConfig();                          // single load for this request
  const requestedModel = body && body.model;
  // --- virtual-model resolution (no-op when none defined / model not a VM) ---
  const vm = resolveVirtualModel(cfg, requestedModel);   // null when not a VM or none defined
  let target = null;
  let routeModel = requestedModel;
  if (vm) {
    target = evaluateVirtualModel(vm, body, cfg);        // {backendId, model, matchedRule}
    routeModel = target.model;                           // route + send-as this model
    if (body) { body = { ...body, model: target.model }; req._body = body; req._rawBody = Buffer.from(JSON.stringify(body)); }
    req._virtualModel = { id: vm.id, requested: requestedModel, target, rule: target.matchedRule };
  }
  // Backend dispatch. For a VM, look the chosen target up directly; if that backend is
  // dangling/disabled (config went stale after a backend was deleted), gracefully fall
  // back to glob-routing the now-real routeModel — never a hard 502 from a stale VM
  // rule. The non-VM branch is byte-identical to the previous resolveBackend(model) call
  // (resolveBackend was just resolveBackendCfg(loadConfig(), model)).
  const backend = vm
    ? (cfg.backends.find((b) => b.id === target.backendId && b.enabled !== false) || resolveBackendCfg(cfg, routeModel))
    : resolveBackendCfg(cfg, routeModel);
  // Audit log: NEVER let logging failures fail a user request (requestLog.start swallows).
  const logId = requestLog.start(req, body, backend);
  req._requestLogId = logId;
  if (!backend) {
    requestLog.finish(logId, { status: "error", httpStatus: 502, errorPreview: `no backend for model ${requestedModel || "<none>"}` });
    return sendJson(res, 502, { error: { type: "proxy_error", message: `no backend for model ${requestedModel || "<none>"}` } });
  }
  if (backend.format === "openai") return openaiTranslate(req, res, backend, body);
  if (backend.format === "openai-responses") return openaiResponsesTranslate(req, res, backend, body);
  return anthropicPassthrough(req, res, backend, body);
}

// --- CC-Switch profile switching ------------------------------------------------
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === "object") return Object.keys(o).sort().reduce((a, k) => { a[k] = sortKeys(o[k]); return a; }, {});
  return o;
}
function atomicWriteFile(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}
function atomicWriteJson(file, obj) {
  atomicWriteFile(file, JSON.stringify(sortKeys(obj), null, 2) + "\n", 0o600);
}
function detectOsEnvConflicts() {
  const risky = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  return risky.filter((k) => process.env[k] && process.env[k] !== DUMMY_KEY);
}
function deepMerge(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return target;
  if (!target || typeof target !== "object" || Array.isArray(target)) target = {};
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === "object" && !Array.isArray(v)) target[k] = deepMerge(target[k], v);
    else target[k] = v;
  }
  return target;
}

function ccSettingsPath() {
  return fs.existsSync(CC_SETTINGS_LEGACY) ? CC_SETTINGS_LEGACY : CC_SETTINGS;
}
function applyProfile(name, opts = {}) {
  const cfg = opts.cfg || loadConfig(opts.cfgFile || CFG_FILE);
  const profile = cfg.profiles && cfg.profiles[name];
  if (!profile) throw new Error(`unknown profile: ${name}`);
  if (!profile.primaryModel) throw new Error(`profile ${name} missing primaryModel`);
  const file = opts.settingsFile || ccSettingsPath();
  const backupFile = opts.backupFile || CC_BACKUP;
  const port = opts.port || boundPort;

  // 1. back up the ORIGINAL (first time only) — crash-safe like CC-Switch
  if (!fs.existsSync(backupFile) && fs.existsSync(file)) {
    atomicWriteFile(backupFile, fs.readFileSync(file, "utf8"), 0o600);
  }

  // 2. deep-merge: only set env.ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY + ANTHROPIC_MODEL; preserve everything else
  const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8") || "{}") : {};
  const env = {
    ANTHROPIC_BASE_URL: `http://${HOST}:${port}`,
    ANTHROPIC_API_KEY: DUMMY_KEY,
    ANTHROPIC_MODEL: profile.primaryModel,
    ...normalizeEnvMap(profile.env),
  };
  deepMerge(cur, { env });
  // NOTE: we do NOT scrub ANTHROPIC_DEFAULT_*_MODEL — we WANT Claude Code to send our route names.

  // 3. atomic write (temp + rename), keys sorted — matches CC-Switch atomic_write
  atomicWriteJson(file, cur);

  // 4. persist active profile (+ optional route overrides)
  cfg.activeProfile = name;
  if (Array.isArray(profile.routeOverrides)) cfg.routes = profile.routeOverrides;
  saveConfig(cfg, opts.cfgFile || CFG_FILE);

  return { writtenPath: file, env: cur.env, conflicts: detectOsEnvConflicts() };
}
function restoreProfile(opts = {}) {
  const file = opts.settingsFile || ccSettingsPath();
  const backupFile = opts.backupFile || CC_BACKUP;
  if (!fs.existsSync(backupFile)) throw new Error("no backup to restore");
  atomicWriteFile(file, fs.readFileSync(backupFile, "utf8"), 0o600);
  const cfg = loadConfig(opts.cfgFile || CFG_FILE); cfg.activeProfile = null; saveConfig(cfg, opts.cfgFile || CFG_FILE);
  return { restoredPath: file };
}

// --- Visual Model Mapper ---------------------------------------------------------
function normalizeMapperTiers(tiers, opts = {}) {
  const out = {};
  const source = tiers && typeof tiers === "object" && !Array.isArray(tiers) ? tiers : {};
  const backendIds = opts.cfg ? new Set((opts.cfg.backends || []).filter((b) => b.enabled !== false).map((b) => b.id)) : null;
  for (const tier of MAPPER_TIERS) {
    const pick = source[tier] && typeof source[tier] === "object" ? source[tier] : {};
    const model = String(pick.model || "").trim();
    const backendId = String(pick.backendId || "").trim();
    if (opts.requireAll && !model) throw new Error(`mapper tier ${tier} missing model`);
    if (opts.requireBackend && !backendId) throw new Error(`mapper tier ${tier} missing backendId`);
    if (backendIds && backendId && !backendIds.has(backendId)) throw new Error(`mapper tier ${tier} unknown or disabled backendId: ${backendId}`);
    if (model || backendId) out[tier] = { ...(backendId ? { backendId } : {}), ...(model ? { model } : {}) };
  }
  return out;
}

function mapperSettingsEnv(tiers, opts = {}) {
  const t = normalizeMapperTiers(tiers, { requireAll: true });
  const port = opts.port || boundPort;
  const fableModel = t.fable && t.fable.model || t.opus && t.opus.model || "";
  const env = {
    ANTHROPIC_BASE_URL: `http://${HOST}:${port}`,
    ANTHROPIC_API_KEY: DUMMY_KEY,
    ANTHROPIC_MODEL: fableModel,
  };
  for (const tier of MAPPER_TIERS) {
    const model = t[tier] && t[tier].model || "";
    const key = tier.toUpperCase();
    env[`ANTHROPIC_DEFAULT_${key}_MODEL`] = model;
    env[`ANTHROPIC_DEFAULT_${key}_MODEL_NAME`] = model;
  }
  return env;
}

function mapperDeeplinkConfigEnv(tiers) {
  const t = normalizeMapperTiers(tiers, { requireAll: true });
  const env = {};
  if (t.fable && t.fable.model) {
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = t.fable.model;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME = t.fable.model;
  }
  for (const tier of ["opus", "sonnet", "haiku"]) {
    if (t[tier] && t[tier].model) env[`ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL_NAME`] = t[tier].model;
  }
  return env;
}

function tierRoutes(tiers, opts = {}) {
  const t = normalizeMapperTiers(tiers);
  const routes = [];
  for (const tier of MAPPER_ROUTE_TIERS) {
    const pick = t[tier];
    if (pick && pick.model && pick.backendId) routes.push({ pattern: pick.model, backendId: pick.backendId });
  }
  const catchAll = opts.catchAll || { pattern: "*", backendId: "default" };
  routes.push({ ...catchAll, pattern: catchAll.pattern == null ? "*" : catchAll.pattern });
  return routes;
}

function buildMapperDeeplink(input = {}) {
  const t = normalizeMapperTiers(input.tiers || input, { requireAll: true });
  const endpoint = String(input.endpoint || `http://${HOST}:${input.port || boundPort}`).replace(/\/+$/, "");
  const params = new URLSearchParams();
  params.set("resource", "provider");
  params.set("app", "claude");
  params.set("name", String(input.name || "claude-router"));
  params.set("endpoint", endpoint);
  params.set("apiKey", DUMMY_KEY);
  params.set("model", t.fable && t.fable.model || t.opus && t.opus.model || "");
  if (t.opus && t.opus.model) params.set("opusModel", t.opus.model);
  if (t.sonnet && t.sonnet.model) params.set("sonnetModel", t.sonnet.model);
  if (t.haiku && t.haiku.model) params.set("haikuModel", t.haiku.model);
  const env = mapperDeeplinkConfigEnv(t);
  if (Object.keys(env).length) {
    params.set("config", Buffer.from(JSON.stringify({ env }), "utf8").toString("base64"));
    params.set("configFormat", "json");
  }
  params.set("enabled", "true");
  return { url: `ccswitch://v1/import?${params.toString()}`, env, routes: tierRoutes(input.tiers || input) };
}

function mapperModelsUrl(backend) {
  const upstream = String(backend && backend.upstream || "").replace(/\/+$/, "");
  let host = "";
  try { host = new URL(upstream).hostname; } catch {}
  if (host === "dashscope.aliyuncs.com") return `${GLM_OPENAI_COMPAT_UPSTREAM}/models`;
  if (host === "api.anthropic.com" || host === "platform.claude.com") return upstream.endsWith("/v1") ? `${upstream}/models` : `${upstream}/v1/models`;
  return `${upstream}/models`;
}

function normalizeModelList(payload, backendId) {
  const data = Array.isArray(payload && payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return data.map((m) => {
    const id = String(m && (m.id || m.name || m.model) || "").trim();
    if (!id) return null;
    return { id, display: String(m && (m.display_name || m.display || m.name) || id), backend: backendId };
  }).filter(Boolean);
}

async function apiMapperModels(backendId) {
  const cfg = loadConfig();
  const backend = cfg.backends.find((b) => b.id === backendId && b.enabled !== false);
  if (!backend) {
    const e = new Error(`backend not found or disabled: ${backendId}`);
    e.status = 404;
    throw e;
  }
  const b = normalizeBackend(backend);
  if (b.authScheme === "codex-oauth") return { models: CODEX_MAPPER_MODELS.map((m) => ({ ...m, backend: b.id })) };

  if (b.authScheme === "oauth") {
    // Model LISTING is not inference — use ANY account's token, even one in cooldown.
    // getAccessToken() uses pickAccount() which skips cooling accounts, making the
    // model list unavailable when all accounts happen to be cooling (the user IS
    // logged in; cooldown is an inference-only concept).
    const store = await accountsForUse();
    const account = (store.accounts.find(a => a.status !== "disabled") || store.accounts[0]) || null;
    let token = "";
    if (account) { try { token = await ensureAccountAccessToken(store, account); } catch {} }
    if (!token) return { models: [], error: "no Claude OAuth account token (login or add an account)" };
    const url = mapperModelsUrl(b);
    let r;
    try { r = await anthropicFetch(url, { method: "GET", headers: headersOAuth({}, token) }); }
    catch (e) { return { models: [], error: String(e && e.message || e).slice(0, 300) }; }
    const text = await r.text();
    if (!r.ok) return { models: [], error: `${r.status} ${text.slice(0, 300)}` };
    try { return { models: normalizeModelList(JSON.parse(text), b.id) }; }
    catch { return { models: [], error: "invalid JSON from Claude models endpoint" }; }
  }

  if (!b.apiKey) return { models: [], error: `${b.id}: missing API key` };
  const url = mapperModelsUrl(b);
  let host = "";
  try { host = new URL(url).hostname; } catch {}
  const anthropicBound = host === "api.anthropic.com" || host === "platform.claude.com";
  const headers = anthropicBound
    ? headersKey({}, b.apiKey)
    : { authorization: `Bearer ${b.apiKey}`, accept: "application/json" };
  let r;
  try {
    r = await (anthropicBound ? anthropicFetch : fetch)(url, { method: "GET", headers });
  } catch (e) {
    if (anthropicBound || !httpProxyFor(url)) return { models: [], error: String(e && e.message || e).slice(0, 300) };
    try { r = await nodeProxyFetch(url, { method: "GET", headers }); }
    catch (e2) { return { models: [], error: String(e2 && e2.message || e2).slice(0, 300) }; }
  }
  const text = await r.text();
  if (!r.ok) return { models: [], error: `${r.status} ${text.slice(0, 300)}` };
  try { return { models: normalizeModelList(JSON.parse(text), b.id) }; }
  catch { return { models: [], error: `invalid JSON from ${b.id} models endpoint` }; }
}

async function apiMapperDeeplink(req) {
  const body = await readJson(req);
  const tiers = normalizeMapperTiers(body && body.tiers, { requireAll: true });
  const link = buildMapperDeeplink({ tiers, name: body && body.name });
  return { ...link, defaults: MAPPER_DEFAULT_MODELS };
}

function writeMapperSettings(tiers, opts = {}) {
  const env = mapperSettingsEnv(tiers, opts);
  if (opts.dryRun) return { env };
  const file = opts.settingsFile || ccSettingsPath();
  const backupFile = opts.backupFile || CC_BACKUP;
  if (!fs.existsSync(backupFile) && fs.existsSync(file)) {
    atomicWriteFile(backupFile, fs.readFileSync(file, "utf8"), 0o600);
  }
  const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8") || "{}") : {};
  deepMerge(cur, { env });
  atomicWriteJson(file, cur);
  return { writtenPath: file, env: cur.env, conflicts: detectOsEnvConflicts() };
}

async function apiMapperApply(req) {
  const body = await readJson(req);
  const cfg = loadConfig();
  const tiers = normalizeMapperTiers(body && body.tiers, { cfg, requireAll: true, requireBackend: true });
  const catchAll = (cfg.routes || []).find((r) => {
    const p = String(r && r.pattern == null ? "*" : r.pattern).trim();
    return p === "" || p === "*";
  }) || { pattern: "*", backendId: "default" };
  cfg.routes = tierRoutes(tiers, { catchAll });
  saveConfig(cfg);
  const settings = body && body.writeSettings ? writeMapperSettings(tiers) : null;
  return { ok: true, routes: cfg.routes, settings, conflicts: detectOsEnvConflicts() };
}

// --- backend test (live 1-token ping) -------------------------------------------
// openai path → plain fetch (no TLS gate on GLM/codex).
// openai-responses path → anthropicFetch (curl) to chatgpt.com (same TLS gate as
//   Anthropic). 200 OR 429 = ok (429 = auth passed, just rate-limited); 401/403/400
//   = not ok (auth/path broken). stream:true is required, so we read the SSE and
//   surface the first output_text.delta as the sample.
// anthropic path → anthropicFetch (curl → nodeProxyFetch) so the oauth subscription
//   TLS gate is bypassed (matches the iron rule: anthropicFetch for ALL Anthropic-bound calls).
async function testBackend(b) {
  const model = b.codexOauth ? CODEX_RESPONSES_MODEL : (b.testModel || (b.modelPatterns && b.modelPatterns.find((p) => p && p !== "*")) || "");
  if (b.format === "openai-responses") {
    let upstream;
    try { upstream = openaiResponsesUpstreamForBackend(b); }
    catch (e) { return { ok: false, latencyMs: 0, model, error: String(e.message || e) }; }
    let bearer, extraHeaders = {};
    if (b.codexOauth) {
      const creds = loadCodexCreds();
      if (!creds || !creds.access_token) return { ok: false, latencyMs: 0, model, error: "codex not logged in (run `codex login`)" };
      bearer = creds.access_token;
      extraHeaders = { "user-agent": "codex/0.142.0", "origin": "https://chatgpt.com" };
    } else {
      if (!b.apiKey) return { ok: false, latencyMs: 0, model, error: "missing API key" };
      bearer = b.apiKey;
    }
    const r = await anthropicFetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${bearer}`, "accept": "text/event-stream", ...extraHeaders },
      body: JSON.stringify({ model, store: false, stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "ping" }] }] }),
    });
    // 429 = auth passed, just rate-limited → path works
    if (r.status === 429) return { ok: true, latencyMs: 0, model, sample: "(429 rate-limited — auth passed)" };
    if (r.status === 401 || r.status === 403 || r.status === 400) {
      return { ok: false, latencyMs: 0, model, error: `${r.status} ${(await r.text()).slice(0, 200)}` };
    }
    if (!r.ok) return { ok: false, latencyMs: 0, model, error: `${r.status} ${(await r.text()).slice(0, 200)}` };
    // 200: drain the (tiny) 1-token stream, extract the first text delta as sample
    let raw = "";
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        raw += Buffer.from(value).toString("utf8");
        if (raw.length > 8192) break; // cap (1-token response is tiny)
      }
    } catch (e) { return { ok: true, latencyMs: 0, model, sample: "(stream ok, read error: " + String(e).slice(0, 80) + ")" }; }
    let sample = "";
    let buf = raw, idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const dl = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dl) continue;
      const d = dl.slice(5).trim();
      if (!d || d === "[DONE]") continue;
      let ev; try { ev = JSON.parse(d); } catch { continue; }
      if (ev.type === "response.output_text.delta") sample += ev.delta || "";
      if (ev.type === "response.completed" || ev.type === "response.failed") break;
    }
    return { ok: true, latencyMs: 0, model, sample: sample || "(stream ok, no text delta)" };
  }
  if (b.format === "openai") {
    const r = await throttledBackendFetch(b, () => fetch(b.upstream + "/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${b.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_completion_tokens: 1, stream: false }),
    }));
    if (!r.ok) return { ok: false, latencyMs: 0, model, error: `${r.status} ${(await r.text()).slice(0, 200)}` };
    const j = await r.json();
    const sample = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return { ok: true, latencyMs: 0, model, sample };
  }
  // anthropic
  if (b.authScheme === "oauth") {
    // Mirror apiTestAccount / anthropicPassthrough Step-1 path: identity system block +
    // headersOAuth (fixed UA/betas, NO browser-access) + ?beta=true + haiku probe.
    // The old branch sent a bare body + opus testModel → 429 soft-block (body-content gate)
    // + opus's separate permission 429, masked as "auth passed".
    const tok = await getAccessToken();
    if (!tok) return { ok: false, latencyMs: 0, model, error: "not logged in (no account token)" };
    const probeModel = "claude-haiku-4-5-20251001"; // opus/sonnet/1M have separate permission 429s (CRS #1000/#1142)
    const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
    const t0 = Date.now();
    let r;
    try {
      r = await anthropicFetch(b.upstream + "/v1/messages?beta=true", {
        method: "POST",
        headers: { ...headersOAuth({}, tok), "content-type": "application/json" },
        body: JSON.stringify({ model: probeModel, max_tokens: 1, system: [{ type: "text", text: IDENTITY }], messages: [{ role: "user", content: "ping" }] }),
      });
    } catch (e) { return { ok: false, latencyMs: Date.now() - t0, model: probeModel, error: String(e && e.message || e).slice(0, 200) }; }
    const latencyMs = Date.now() - t0;
    const text = await r.text();
    if (r.status === 429) return { ok: false, latencyMs, model: probeModel, status: 429, error: `429 ${text.slice(0, 300)}`, retryAfter: r.headers.get("retry-after") || "", rateLimitReset: r.headers.get("anthropic-ratelimit-unified-reset") || "" };
    if (!r.ok) return { ok: false, latencyMs, model: probeModel, error: `${r.status} ${text.slice(0, 200)}` };
    let sample = "(ok)";
    try { const j = JSON.parse(text); const t2 = (j.content || []).find((c) => c.type === "text"); if (t2 && t2.text) sample = t2.text; } catch {}
    return { ok: true, latencyMs, model: probeModel, sample };
  }
  // anthropic x-api-key (GLM etc.) — single direct probe, plain fetch (NOT curl):
  // dashscope throttles curl with 429 "Throttling" (curl→429 ~5s, Node fetch→200 ~5s),
  // which made the old throttledBackendFetch+curl path retry for 34s. curl is only for
  // TLS-gated Anthropic hosts.
  let upHost = ""; try { upHost = new URL(b.upstream).hostname; } catch {}
  const upFetch = (upHost === "api.anthropic.com" || upHost === "platform.claude.com") ? anthropicFetch : fetch;
  const t0 = Date.now();
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01", "x-api-key": b.apiKey };
  let r;
  try {
    r = await upFetch(b.upstream + "/v1/messages", {
      method: "POST", headers,
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
  } catch (e) { return { ok: false, latencyMs: Date.now() - t0, model, error: String(e && e.message || e).slice(0, 200) }; }
  const latencyMs = Date.now() - t0;
  const text = await r.text();
  if (!r.ok) return { ok: false, latencyMs, model, error: `${r.status} ${text.slice(0, 200)}` };
  let sample = "(ok)";
  try { const j = JSON.parse(text); const t2 = (j.content || []).find((c) => c.type === "text"); if (t2 && t2.text) sample = t2.text; } catch {}
  return { ok: true, latencyMs, model, sample };
}

// --- status (existing) ----------------------------------------------------------
function statusLine() {
  const store = loadAccounts();
  if (store.accounts.length) {
    const active = store.accounts.find((a) => a.id === store.active_id) || store.accounts[0];
    const available = pickAccount(store);
    const cooling = store.accounts.filter((a) => a.status !== "disabled" && Number(a.cooldown_until || 0) > Date.now()).length;
    const label = active ? `${active.label || active.id}${active.organization_name ? " (" + active.organization_name + ")" : ""}` : "none";
    const suffix = cooling ? `; ${cooling} cooling` : "";
    if (!available) return { ok: false, text: `Account pool: ${store.accounts.length} account(s); no account currently available${suffix}.` };
    return { ok: true, text: `Account pool: ${store.accounts.length} account(s). Active: ${label}${suffix}.` };
  }
  const c = loadCreds();
  if (!c || !c.access_token) return { ok: false, text: "Not logged in." };
  const secs = Math.round(((c.expires_at || 0) - Date.now()) / 1000);
  if (secs <= 0) return { ok: true, text: "Logged in (token expired — will auto-refresh on next request)." };
  const mins = Math.round(secs / 60);
  return { ok: true, text: `Logged in. Token valid ~${mins} min.` };
}

// --- static webui serving --------------------------------------------------------
const FALLBACK_HTML = `<!doctype html><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1"><title>claude-router</title>
<body style="font:15px/1.6 system-ui,Segoe UI,sans-serif;max-width:640px;margin:6vh auto;padding:0 20px;color:#1c1c1c;background:#faf9f7">
<h1>claude-router</h1><p>webui.html was not found next to server.js — serving a minimal stub. The JSON API is live under <code>/api/*</code>.</p>
<p><a href="/login">Login with Claude</a> · <form method=post action=/logout style=display:inline><button>Logout</button></form></p>`;
const WEBUI_PATH = path.join(__dirname, "webui.html");
// Serve webui.html FRESH from disk (mtime-cached) so frontend edits go live on a
// browser refresh WITHOUT restarting the backend — the 8123 process must never be
// killed (this session's own API routes through it), but the UI must stay editable.
let _webuiCache = { mtimeMs: 0, html: null };
function readWebui() {
  try {
    const st = fs.statSync(WEBUI_PATH);
    if (_webuiCache.html == null || st.mtimeMs !== _webuiCache.mtimeMs) {
      _webuiCache = { mtimeMs: st.mtimeMs, html: fs.readFileSync(WEBUI_PATH, "utf8") };
    }
    return _webuiCache.html;
  } catch { return FALLBACK_HTML; }
}

// --- http helpers ----------------------------------------------------------------
// If a response is already committed (mid-stream when an error is thrown, then the
// top-level catch calls sendJson) writeHead() throws ERR_HTTP_HEADERS_SENT and crashes
// the request — guard every header-writer so that can never happen.
function headersDone(res) { return !res || res.headersSent || res.writableEnded || res.finished; }
function sendJson(res, code, obj) {
  if (headersDone(res)) { try { if (res && !res.writableEnded) res.end(); } catch {} return; }
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function sendHtml(res, code, html) {
  if (headersDone(res)) { try { if (res && !res.writableEnded) res.end(); } catch {} return; }
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}
function redirect(res, location) {
  if (headersDone(res)) { try { if (res && !res.writableEnded) res.end(); } catch {} return; }
  res.writeHead(302, { location });
  res.end();
}
async function parseForm(req) {
  const body = (await readBody(req)).toString("utf8");
  return new URLSearchParams(body);
}
async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString("utf8")); } catch { throw new Error("invalid JSON body"); }
}
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// optional admin-token guard for mutating /api endpoints (localhost is the boundary by default)
function isAdminOk(req) {
  if (!ADMIN_TOKEN) return true;
  const h = req.headers["x-admin-token"];
  const b = req.headers["authorization"];
  return h === ADMIN_TOKEN || (!!b && b.startsWith("Bearer ") && b.slice(7) === ADMIN_TOKEN);
}
function adminDenied(res) { return sendJson(res, 401, { error: { type: "authentication_error", message: "admin token required (set X-Admin-Token)" } }); }

// --- /api/* handlers -------------------------------------------------------------
function apiState() {
  const cfg = loadConfig();
  const mode = fs.existsSync(CFG_FILE) ? "multi-backend" : (KEY_MODE ? "api-key" : "oauth");
  return {
    mode,
    baseUrl: `http://${HOST}:${boundPort}`,
    oauthStatus: statusLine().text,
    backends: cfg.backends.map(maskBackend),
    routes: cfg.routes,
    virtualModels: cfg.virtualModels || [],
    profiles: cfg.profiles || {},
    activeProfile: cfg.activeProfile || null,
    throttleStats: throttleStatsForConfig(cfg),
    osEnvConflicts: detectOsEnvConflicts(),
  };
}
async function apiCreateBackend(req) {
  const b = await readJson(req);
  if (!b || !b.id || !ID_RE.test(b.id)) throw new Error(`invalid id (must match ${ID_RE})`);
  const cfg = loadConfig();
  if (cfg.backends.some((x) => x.id === b.id)) throw new Error(`backend id already exists: ${b.id}`);
  const n = normalizeBackend(b);
  if (n.oauth && cfg.backends.some((x) => x.oauth)) throw new Error("only one oauth backend is allowed");
  if (n.codexOauth && cfg.backends.some((x) => x.codexOauth)) throw new Error("only one codex-oauth backend is allowed");
  cfg.backends.push(n);
  saveConfig(cfg);
  return n;
}
async function apiUpdateBackend(req, id) {
  const patch = await readJson(req);
  const cfg = loadConfig();
  const idx = cfg.backends.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error(`backend not found: ${id}`);
  const cur = normalizeBackend(cfg.backends[idx]);
  const merged = normalizeBackend({ ...cur, ...patch, id: cur.id });
  // PUT with empty/missing apiKey preserves the stored key (no wipe-on-edit)
  if (patch.apiKey == null || patch.apiKey === "") merged.apiKey = cur.apiKey;
  if (merged.oauth) for (const x of cfg.backends) if (x.id !== id && x.oauth) throw new Error("only one oauth backend is allowed");
  if (merged.codexOauth) for (const x of cfg.backends) if (x.id !== id && x.codexOauth) throw new Error("only one codex-oauth backend is allowed");
  cfg.backends[idx] = merged;
  saveConfig(cfg);
  return merged;
}
async function apiDeleteBackend(id) {
  const cfg = loadConfig();
  if (!cfg.backends.some((x) => x.id === id)) throw new Error(`backend not found: ${id}`);
  if (cfg.routes.some((r) => r.backendId === id)) throw new Error("backend referenced by a route; remove the route first");
  cfg.backends = cfg.backends.filter((x) => x.id !== id);
  saveConfig(cfg);
  return { ok: true };
}
async function apiTestBackend(id) {
  const cfg = loadConfig();
  const b = cfg.backends.find((x) => x.id === id);
  if (!b) throw new Error(`backend not found: ${id}`);
  const t0 = Date.now();
  const r = await testBackend(normalizeBackend(b));
  r.latencyMs = Date.now() - t0;
  return r;
}
async function apiCreateRoute(req) {
  const { pattern, backendId } = await readJson(req);
  const cfg = loadConfig();
  if (!cfg.backends.some((x) => x.id === backendId)) throw new Error(`unknown backendId: ${backendId}`);
  cfg.routes.push({ pattern: String(pattern == null ? "*" : pattern), backendId });
  saveConfig(cfg);
  return cfg.routes;
}
async function apiDeleteRoute(idx) {
  const cfg = loadConfig();
  if (!Number.isInteger(idx) || idx < 0 || idx >= cfg.routes.length) throw new Error("route index out of range");
  cfg.routes.splice(idx, 1);
  saveConfig(cfg);
  return cfg.routes;
}
async function apiReorderRoutes(req) {
  const { order } = await readJson(req);
  const cfg = loadConfig();
  if (!Array.isArray(order) || order.length !== cfg.routes.length) throw new Error("order must be a permutation of current route indices");
  const seen = new Set();
  for (const i of order) {
    if (!Number.isInteger(i) || i < 0 || i >= cfg.routes.length || seen.has(i)) throw new Error("order must be a permutation of current route indices");
    seen.add(i);
  }
  cfg.routes = order.map((i) => cfg.routes[i]);
  saveConfig(cfg);
  return cfg.routes;
}

// --- virtual-models REST API (mirrors routes/backends; writes admin-guarded) -----
// VMs hold no secrets, so GET returns them unmasked. Write handlers validate that
// every rule's backendId + default.backendId reference an existing backend (reject 400
// at write time); resolve-time fallback in proxy() only covers configs that go stale
// *after* a backend is later deleted.
function vmHttpError(status, message) { const e = new Error(message); e.status = status; return e; }
function suggestVirtualModelId(name, cfg) {
  const slug = String(name || "").toLowerCase().trim()
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  const base = slug && /^[a-z0-9]/.test(slug) ? slug : "vm";
  const taken = new Set([
    ...(cfg.backends || []).map((b) => b.id),
    ...(cfg.virtualModels || []).map((v) => v.id),
  ]);
  if (!taken.has(base) && ID_RE.test(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
    if (!taken.has(id) && ID_RE.test(id)) return id;
  }
}
function exactRouteOrPatternCollision(alias, cfg, selfId = "") {
  const a = String(alias || "").trim().toLowerCase();
  if (!a || a.includes("*")) return null; // globs are explicit advanced matches; exact aliases get collision protection.
  const vm = (cfg.virtualModels || []).find((v) => v.id !== selfId && (v.match || []).some((p) => String(p || "").trim().toLowerCase() === a));
  if (vm) return `another virtual model (${vm.id})`;
  const backendId = (cfg.backends || []).find((b) => String(b.id || "").toLowerCase() === a);
  if (backendId) return `backend id (${backendId.id})`;
  const route = (cfg.routes || []).find((r) => !String(r.pattern == null ? "*" : r.pattern).includes("*") && String(r.pattern == null ? "*" : r.pattern).toLowerCase() === a);
  if (route) return `route pattern (${route.pattern})`;
  const patBackend = (cfg.backends || []).find((b) => (b.modelPatterns || []).some((p) => !String(p == null ? "*" : p).includes("*") && String(p == null ? "*" : p).toLowerCase() === a));
  if (patBackend) return `backend model pattern (${patBackend.id}:${a})`;
  return null;
}
function validateVirtualModelBackends(vm, cfg) {
  const ids = new Set((cfg.backends || []).map((b) => b.id));
  for (const alias of (vm.match || [])) {
    const collision = exactRouteOrPatternCollision(alias, cfg, vm.id);
    if (collision) throw vmHttpError(409, `virtual model match alias ${JSON.stringify(alias)} collides with ${collision}`);
  }
  for (const r of vm.rules) {
    if (!ids.has(r.backendId)) throw vmHttpError(400, `rule references unknown backendId: ${r.backendId}`);
  }
  if (!ids.has(vm.default.backendId)) throw vmHttpError(400, `default references unknown backendId: ${vm.default.backendId}`);
}
async function apiCreateVirtualModel(req) {
  const input = await readJson(req);
  const cfg = loadConfig();
  let id = input && input.id ? String(input.id) : "";
  if (!id) id = suggestVirtualModelId(input && input.name, cfg);
  if (!ID_RE.test(id)) throw vmHttpError(400, `invalid id (must match ${ID_RE})`);
  if (cfg.backends.some((b) => b.id === id)) throw vmHttpError(409, `id collides with a backend id: ${id}`);
  if ((cfg.virtualModels || []).some((v) => v.id === id)) throw vmHttpError(409, `virtual model already exists: ${id}`);
  const n = normalizeVirtualModel({ ...(input || {}), id });
  if (!n) throw vmHttpError(400, "virtual model is invalid: a resolvable default target (backendId + model) is required");
  validateVirtualModelBackends(n, cfg);
  cfg.virtualModels.push(n);
  saveConfig(cfg);
  return n;
}
async function apiUpdateVirtualModel(req, id) {
  const patch = await readJson(req);
  const cfg = loadConfig();
  const list = cfg.virtualModels || [];
  const idx = list.findIndex((v) => v.id === id);
  if (idx < 0) throw vmHttpError(404, `virtual model not found: ${id}`);
  const cur = list[idx];
  // Deep-merge allowed fields; id is immutable. Arrays (match/rules) replace when
  // provided; default target is shallow-merged (it is just {backendId, model}).
  const merged = normalizeVirtualModel({
    id: cur.id,
    name: patch.name != null ? patch.name : cur.name,
    enabled: patch.enabled != null ? patch.enabled : cur.enabled,
    match: Array.isArray(patch.match) ? patch.match : cur.match,
    rules: Array.isArray(patch.rules) ? patch.rules : cur.rules,
    default: (patch.default && typeof patch.default === "object") ? { ...cur.default, ...patch.default } : cur.default,
  });
  if (!merged) throw vmHttpError(400, "virtual model is invalid: a resolvable default target (backendId + model) is required");
  validateVirtualModelBackends(merged, cfg);
  list[idx] = merged;
  cfg.virtualModels = list;
  saveConfig(cfg);
  return merged;
}
async function apiDeleteVirtualModel(id) {
  const cfg = loadConfig();
  const list = cfg.virtualModels || [];
  const before = list.length;
  cfg.virtualModels = list.filter((v) => v.id !== id);
  if (cfg.virtualModels.length === before) throw vmHttpError(404, `virtual model not found: ${id}`);
  saveConfig(cfg);
  return cfg.virtualModels;
}
// Read-only preview: run evaluateVirtualModel against a sample body the WebUI pastes.
// Pure (no disk write); admin not required. Returns which rule fired + the target.
async function apiPreviewVirtualModel(id, req) {
  const cfg = loadConfig();
  const vm = (cfg.virtualModels || []).find((v) => v.id === id);
  if (!vm) throw vmHttpError(404, `virtual model not found: ${id}`);
  const posted = await readJson(req);
  // Accept the sample request body either directly (the natural shape a client/CC sends:
  // {model, messages, tools, ...}) OR wrapped as {body:{...}}. Earlier this only read
  // `.body`, so a directly-posted sample evaluated as undefined → every rule missed →
  // always "default". Prefer .body when it's an object, else treat the payload as the body.
  const body = posted && typeof posted.body === "object" && posted.body !== null ? posted.body : posted;
  const clone = { ...vm, rules: vm.rules.map((r) => ({ ...r })), default: { ...vm.default } };
  const target = evaluateVirtualModel(clone, body, cfg);
  return { matchedRule: target.matchedRule, backendId: target.backendId, model: target.model };
}
function validateProfileForConfig(profile, cfg) {
  if (!profile.primaryModel) throw new Error("profile primaryModel is required");
  const backendIds = new Set((cfg.backends || []).map((b) => b.id));
  for (const r of profile.routeOverrides || []) {
    if (!backendIds.has(r.backendId)) throw new Error(`unknown route override backendId: ${r.backendId}`);
  }
}
function createProfileInConfig(cfg, body) {
  const name = assertProfileName(body.name);
  if (cfg.profiles[name]) throw new Error(`profile already exists: ${name}`);
  const profile = normalizeProfile(body);
  validateProfileForConfig(profile, cfg);
  cfg.profiles[name] = profile;
  return name;
}
function updateProfileInConfig(cfg, name, patch) {
  name = assertProfileName(name);
  if (!cfg.profiles[name]) throw new Error(`profile not found: ${name}`);
  const profile = normalizeProfile({ ...cfg.profiles[name], ...patch });
  validateProfileForConfig(profile, cfg);
  cfg.profiles[name] = profile;
  return name;
}
function deleteProfileInConfig(cfg, name) {
  name = assertProfileName(name);
  if (!cfg.profiles[name]) throw new Error(`profile not found: ${name}`);
  delete cfg.profiles[name];
  if (cfg.activeProfile === name) cfg.activeProfile = null;
  return name;
}
async function apiCreateProfile(req) {
  const body = await readJson(req);
  const cfg = loadConfig();
  createProfileInConfig(cfg, body);
  saveConfig(cfg);
  return { profiles: cfg.profiles, activeProfile: cfg.activeProfile || null };
}
async function apiUpdateProfile(req, name) {
  const patch = await readJson(req);
  const cfg = loadConfig();
  updateProfileInConfig(cfg, name, patch);
  saveConfig(cfg);
  return { profiles: cfg.profiles, activeProfile: cfg.activeProfile || null };
}
async function apiDeleteProfile(name) {
  const cfg = loadConfig();
  deleteProfileInConfig(cfg, name);
  saveConfig(cfg);
  return { profiles: cfg.profiles, activeProfile: cfg.activeProfile || null };
}

function findAccountOrThrow(store, id) {
  const account = store.accounts.find((a) => a.id === id);
  if (!account) {
    const e = new Error(`account not found: ${id}`);
    e.status = 404;
    throw e;
  }
  return account;
}
async function apiListAccounts() {
  return maskAccountsStore(await accountsForUse());
}
async function apiAccountLoginUrl(req) {
  const body = await readJson(req);
  const org = stringOrNull(body && body.organization_uuid);
  // Empty org = standard authorize URL; the active claude.ai org is honored at
  // consent time, and addAccountToStore rejects duplicate-org tokens (409) — so
  // no need to force an org UUID up front (the /api/organizations auto-list 403s
  // for most accounts, which made this hard requirement a login trap).
  const url = buildAuthorizeUrl(org);
  return { url, state: pending && pending.state, organization_uuid: pending && pending.organization_uuid };
}
async function apiAccountExchange(req) {
  const body = await readJson(req);
  if (!body || !body.code) throw new Error("code is required");
  const account = await exchangeCode(body.code, { state: body.state, label: body.label });
  return { account: maskedAccount(account) };
}
async function apiActivateAccount(id) {
  const store = loadAccounts();
  const account = findAccountOrThrow(store, id);
  store.active_id = account.id;
  account.status = "active";
  account.cooldown_until = null;
  account.cooldown_reason = null;
  saveAccounts(store);
  return { ok: true, active_id: store.active_id };
}
async function apiDisableAccount(id) {
  const store = loadAccounts();
  const account = findAccountOrThrow(store, id);
  account.status = "disabled";
  saveAccounts(store);
  return { ok: true };
}
async function apiDeleteAccount(id) {
  const store = loadAccounts();
  findAccountOrThrow(store, id);
  store.accounts = store.accounts.filter((a) => a.id !== id);
  if (store.active_id === id) store.active_id = store.accounts[0] ? store.accounts[0].id : null;
  saveAccounts(store);
  return { ok: true, active_id: store.active_id };
}
async function apiRefreshAccount(id) {
  const store = loadAccounts();
  const account = findAccountOrThrow(store, id);
  await ensureAccountAccessToken(store, account, true);
  saveAccounts(store);
  return { ok: true, expiresAt: account.claudeAiOauth.expiresAt };
}

// Diagnostic 1-token probe of one account's token against /v1/messages via curl.
// Does NOT apply cooldown (it's a test, not a real request). ok=true on 200 OR 429
// (auth passed, just rate-limited); ok=false on 401/403/400/!ok with the upstream body.
async function apiTestAccount(id) {
  const store = loadAccounts();
  const account = findAccountOrThrow(store, id);
  if (!account.claudeAiOauth || !account.claudeAiOauth.accessToken) return { ok: false, latencyMs: 0, error: "account has no access token" };
  let token;
  try { token = await ensureAccountAccessToken(store, account); }
  catch (e) { return { ok: false, latencyMs: 0, error: "refresh failed: " + String(e && e.message || e).slice(0, 200) }; }
  if (!token) return { ok: false, latencyMs: 0, error: "no access token after refresh" };
  const oauthBackend = (loadConfig().backends || []).find((b) => b.enabled !== false && (b.authScheme === "oauth" || b.oauth));
  const upstream = (oauthBackend && oauthBackend.upstream) || "https://api.anthropic.com";
  const model = "claude-haiku-4-5-20251001"; // haiku probe — opus/sonnet/1M have separate permission 429s (CRS #1000/#1142) that mask the identity signal
  const t0 = Date.now();
  let r;
  try {
    const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
    r = await anthropicFetch(upstream + "/v1/messages?beta=true", {
      method: "POST",
      headers: { ...headersOAuth({}, token), "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, system: [{ type: "text", text: IDENTITY }], messages: [{ role: "user", content: "ping" }] }),
    });
  } catch (e) { return { ok: false, latencyMs: Date.now() - t0, model, error: String(e && e.message || e).slice(0, 200) }; }
  const text = await r.text();
  const latencyMs = Date.now() - t0;
  if (r.status === 429) return { ok: false, latencyMs, model, status: 429, error: `429 ${text.slice(0, 300)}`, retryAfter: r.headers.get("retry-after") || "", rateLimitReset: r.headers.get("anthropic-ratelimit-unified-reset") || "" };
  if (r.status === 401 || r.status === 403 || r.status === 400 || !r.ok) return { ok: false, latencyMs, model, error: `${r.status} ${text.slice(0, 200)}` };
  let sample = "(ok)";
  try { const j = JSON.parse(text); const t2 = (j.content || []).find((c) => c.type === "text"); if (t2 && t2.text) sample = t2.text; } catch {}
  return { ok: true, latencyMs, model, sample };
}

async function apiRouter(req, res, url) {
  const method = req.method;
  const seg = url.split("/").filter(Boolean); // ["api", ...]
  const head = seg[1];
  if (head === "state" && method === "GET" && seg.length === 2) return sendJson(res, 200, apiState());

  // --- request inspector -------------------------------------------------------
  if (head === "requests") {
    try {
      if (seg.length === 2) {
        if (method === "GET") {
          let qp = new URLSearchParams();
          try { qp = new URL(req.url, "http://x").searchParams; } catch {}
          const filters = {
            limit: qp.get("limit"),
            status: qp.get("status") || "",
            backend: qp.get("backend") || "",
            model: qp.get("model") || "",
            q: qp.get("q") || "",
          };
          return sendJson(res, 200, requestLog.list(filters));
        }
        return sendJson(res, 405, { error: { type: "method_not_allowed" } });
      }
      if (seg.length === 3 && seg[2] === "clear" && method === "POST") {
        if (!isAdminOk(req)) return adminDenied(res);
        requestLog.clear();
        return sendJson(res, 200, { ok: true });
      }
      if (seg.length === 3 && seg[2] === "totals" && method === "GET") {
        // full-history token/cost totals from the JSONL log (NOT just the recent buffer)
        return sendJson(res, 200, requestLog.totals());
      }
      if (seg.length === 3 && method === "GET") {
        const rec = requestLog.get(decodeURIComponent(seg[2]));
        if (!rec) return sendJson(res, 404, { error: { type: "not_found", message: "request not found" } });
        return sendJson(res, 200, rec);
      }
      if (seg.length === 4 && seg[3] === "trace" && method === "GET") {
        const trace = requestLog.getTrace(decodeURIComponent(seg[2]));
        if (!trace) return sendJson(res, 404, { error: { type: "not_found", message: "trace not available" } });
        return sendJson(res, 200, trace);
      }
      return sendJson(res, 404, { error: { type: "not_found", message: "claude-router: unknown requests api path " + url } });
    } catch (e) {
      return sendJson(res, 500, { error: { type: "api_error", message: String(e && e.message || e) } });
    }
  }

  if (head === "request-settings") {
    try {
      if (method === "GET") return sendJson(res, 200, requestLog.reloadSettings());
      if (method === "POST") {
        if (!isAdminOk(req)) return adminDenied(res);
        const patch = await readJson(req);
        const merged = sanitizeRequestSettings({ ...requestLog.settings, ...patch });
        requestLog.settings = saveRequestSettings(merged);
        return sendJson(res, 200, requestLog.settings);
      }
      return sendJson(res, 405, { error: { type: "method_not_allowed" } });
    } catch (e) {
      return sendJson(res, 500, { error: { type: "api_error", message: String(e && e.message || e) } });
    }
  }

  if (head === "mapper") {
    try {
      if (seg.length === 4 && seg[2] === "models" && method === "GET") return sendJson(res, 200, await apiMapperModels(decodeURIComponent(seg[3])));
      if (seg.length === 3 && seg[2] === "deeplink" && method === "POST") return sendJson(res, 200, await apiMapperDeeplink(req));
      if (seg.length === 3 && seg[2] === "apply" && method === "POST") {
        if (!isAdminOk(req)) return adminDenied(res);
        return sendJson(res, 200, await apiMapperApply(req));
      }
      return sendJson(res, 404, { error: { type: "not_found", message: "claude-router: unknown mapper api path " + url } });
    } catch (e) {
      return sendJson(res, e.status || 500, { error: { type: e.status === 404 ? "not_found" : "api_error", message: String(e && e.message || e) } });
    }
  }

  if (head === "accounts") {
    if (!isAdminOk(req)) return adminDenied(res);
    try {
      if (seg.length === 2) {
        if (method === "GET") return sendJson(res, 200, await apiListAccounts());
        return sendJson(res, 405, { error: { type: "method_not_allowed" } });
      }
      if (seg.length === 3 && seg[2] === "login-url" && method === "POST") return sendJson(res, 200, await apiAccountLoginUrl(req));
      if (seg.length === 3 && seg[2] === "exchange" && method === "POST") return sendJson(res, 200, await apiAccountExchange(req));
      if (seg.length === 3 && seg[2] === "orgs" && method === "GET") return sendJson(res, 200, await listAccountOrganizations());
      if (seg.length === 3 && method === "DELETE") return sendJson(res, 200, await apiDeleteAccount(seg[2]));
      if (seg.length === 4 && method === "POST" && seg[3] === "activate") return sendJson(res, 200, await apiActivateAccount(seg[2]));
      if (seg.length === 4 && method === "POST" && seg[3] === "disable") return sendJson(res, 200, await apiDisableAccount(seg[2]));
      if (seg.length === 4 && method === "POST" && seg[3] === "refresh") return sendJson(res, 200, await apiRefreshAccount(seg[2]));
      if (seg.length === 4 && method === "POST" && seg[3] === "test") return sendJson(res, 200, await apiTestAccount(seg[2]));
      return sendJson(res, 404, { error: { type: "not_found", message: "claude-router: unknown account api path " + url } });
    } catch (e) {
      return sendJson(res, e.status || 500, { error: { type: e.status === 409 ? "conflict" : "api_error", message: String(e && e.message || e) } });
    }
  }

  if (head === "backends") {
    if (seg.length === 2) {
      if (method === "GET") return sendJson(res, 200, loadConfig().backends.map(maskBackend));
      if (method === "POST") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, maskBackend(await apiCreateBackend(req))); }
      return sendJson(res, 405, { error: { type: "method_not_allowed" } });
    }
    if (seg.length === 3) {
      const id = seg[2];
      if (method === "PUT") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, maskBackend(await apiUpdateBackend(req, id))); }
      if (method === "DELETE") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await apiDeleteBackend(id)); }
      return sendJson(res, 405, { error: { type: "method_not_allowed" } });
    }
    if (seg.length === 4 && seg[3] === "test" && method === "POST") {
      return sendJson(res, 200, await apiTestBackend(seg[2]));
    }
  }

  if (head === "routes") {
    if (seg.length === 2) {
      if (method === "GET") return sendJson(res, 200, loadConfig().routes);
      if (method === "POST") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await apiCreateRoute(req)); }
      return sendJson(res, 405, { error: { type: "method_not_allowed" } });
    }
    if (seg.length === 3) {
      if (seg[2] === "order" && method === "PUT") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await apiReorderRoutes(req)); }
      if (method === "DELETE") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await apiDeleteRoute(parseInt(seg[2], 10))); }
      return sendJson(res, 405, { error: { type: "method_not_allowed" } });
    }
  }

  if (head === "virtual-models") {
    try {
      if (seg.length === 2) {
        if (method === "GET") return sendJson(res, 200, loadConfig().virtualModels || []);
        if (method === "POST") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await apiCreateVirtualModel(req)); }
        return sendJson(res, 405, { error: { type: "method_not_allowed" } });
      }
      if (seg.length === 3) {
        const id = seg[2];
        if (method === "PUT") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await apiUpdateVirtualModel(req, id)); }
        if (method === "DELETE") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await apiDeleteVirtualModel(id)); }
        return sendJson(res, 405, { error: { type: "method_not_allowed" } });
      }
      if (seg.length === 4 && seg[3] === "preview" && method === "POST") {
        return sendJson(res, 200, await apiPreviewVirtualModel(seg[2], req)); // read-only, no admin guard
      }
      return sendJson(res, 404, { error: { type: "not_found", message: "claude-router: unknown virtual-models api path " + url } });
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      const type = status === 404 ? "not_found" : status === 409 ? "conflict" : "api_error";
      return sendJson(res, status, { error: { type, message: String(e && e.message || e) } });
    }
  }

  if (head === "profiles") {
    if (seg.length === 2) {
      if (method === "GET") {
        const c = loadConfig();
        return sendJson(res, 200, { profiles: c.profiles || {}, activeProfile: c.activeProfile || null });
      }
      if (method === "POST") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await apiCreateProfile(req)); }
      return sendJson(res, 405, { error: { type: "method_not_allowed" } });
    }
    if (seg.length === 3 && method === "POST" && seg[2] === "restore") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await restoreProfile()); }
    if (seg.length === 3) {
      if (method === "PUT") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await apiUpdateProfile(req, seg[2])); }
      if (method === "DELETE") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await apiDeleteProfile(seg[2])); }
      return sendJson(res, 405, { error: { type: "method_not_allowed" } });
    }
    if (seg.length === 4 && method === "POST" && seg[3] === "apply") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await applyProfile(seg[2])); }
  }

  return sendJson(res, 404, { error: { type: "not_found", message: "claude-router: unknown api path " + url } });
}

// --- http server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];
    const method = req.method;
    if (method === "GET" && url === "/") return sendHtml(res, 200, readWebui());
    if (method === "GET" && url === "/login") return redirect(res, buildAuthorizeUrl());
    if (method === "POST" && url === "/exchange") {
      const form = await parseForm(req);
      try { await exchangeCode(form.get("code") || ""); return redirect(res, "/"); }
      catch (e) { return sendHtml(res, 400, `<p style="font:15px system-ui;color:#b3261e">${escapeHtml(String(e && e.message || e))}</p><p><a href="/">← back</a></p>`); }
    }
    if (method === "POST" && url === "/logout") { clearCreds(); clearAccounts(); return redirect(res, "/"); }
    if (url.startsWith("/api/")) return await apiRouter(req, res, url);
    if (url.startsWith("/v1/")) return await proxy(req, res);
    sendJson(res, 404, { error: { type: "not_found", message: "claude-router: unknown path " + url } });
  } catch (e) {
    sendJson(res, 500, { error: { type: "router_error", message: String(e && e.message || e) } });
  }
});

// --- self-test (offline) ---------------------------------------------------------
function selftest() {
  const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };
  // PKCE: challenge == base64url(sha256(verifier)), both url-safe (no + / =)
  const { verifier, challenge } = makePkce();
  const urlsafe = (s) => /^[A-Za-z0-9_-]+$/.test(s);
  assert(urlsafe(verifier) && urlsafe(challenge), "pkce values must be base64url");
  const recomputed = b64url(crypto.createHash("sha256").update(verifier).digest());
  assert(recomputed === challenge, "challenge must be base64url(sha256(verifier))");
  // beta merge: dedupes + always includes both required betas
  const merged = mergeBetas("claude-code-20250219,fine-grained-tool-streaming-2025-05-14");
  const parts = merged.split(",");
  assert(parts.includes("oauth-2025-04-20"), "merged betas must include oauth beta");
  assert(parts.includes("claude-code-20250219"), "merged betas must include claude-code beta");
  assert(parts.filter((b) => b === "claude-code-20250219").length === 1, "betas must dedupe");
  assert(mergeBetas("").split(",").sort().join(",") === [...REQUIRED_BETAS].sort().join(","), "empty client beta -> just required");
  // OAuth header rewrite: strips x-api-key, sets Bearer, injects oauth beta, keeps others
  const h = headersOAuth({ "x-api-key": "sk-leak", "host": "x", "content-type": "application/json", "anthropic-beta": "claude-code-20250219" }, "TOK");
  assert(!("x-api-key" in h) && !("host" in h), "oauth: must strip x-api-key and host");
  assert(h["authorization"] === "Bearer TOK", "oauth: must set Bearer token");
  assert(h["anthropic-beta"].split(",").includes("oauth-2025-04-20"), "oauth: must inject oauth beta");
  assert(h["content-type"] === "application/json", "oauth: must keep content-type");
  assert(h["anthropic-version"] === "2023-06-01", "oauth: must default anthropic-version");
  // Key-mode header rewrite: sets x-api-key, NO bearer, NO injected oauth beta, betas passthrough
  const k = headersKey({ "x-api-key": "client-key", "authorization": "Bearer old", "host": "x", "anthropic-beta": "claude-code-20250219" }, "MYKEY");
  assert(k["x-api-key"] === "MYKEY", "key: must set our x-api-key");
  assert(!("authorization" in k), "key: must drop client authorization");
  assert(k["anthropic-beta"] === "claude-code-20250219", "key: must pass client betas through untouched");
  assert(!k["anthropic-beta"].includes("oauth-2025-04-20"), "key: must NOT inject oauth beta");
  console.log("selftest OK");
}

function selftestMapper() {
  const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };
  const tiers = {
    opus: { backendId: "default", model: "claude-opus-4-8" },
    sonnet: { backendId: "glm", model: "glm-5.2" },
    haiku: { backendId: "codex", model: "gpt-5.5-instant" },
    fable: { backendId: "codex", model: "gpt-5.5-xhigh" },
  };
  const link = buildMapperDeeplink({ tiers, name: "router-test", port: 8123 });
  assert(link.url.startsWith("ccswitch://v1/import?"), "mapper: ccswitch URL scheme");
  const parsed = new URL(link.url);
  assert(parsed.searchParams.get("resource") === "provider", "mapper: resource provider");
  assert(parsed.searchParams.get("app") === "claude", "mapper: app claude");
  assert(parsed.searchParams.get("model") === "gpt-5.5-xhigh", "mapper: model uses fable");
  assert(parsed.searchParams.get("opusModel") === "claude-opus-4-8", "mapper: opusModel param");
  assert(parsed.searchParams.get("sonnetModel") === "glm-5.2", "mapper: sonnetModel param");
  assert(parsed.searchParams.get("haikuModel") === "gpt-5.5-instant", "mapper: haikuModel param");
  assert(parsed.searchParams.get("enabled") === "true", "mapper: enabled=true");
  const cfg = JSON.parse(Buffer.from(parsed.searchParams.get("config") || "", "base64").toString("utf8"));
  assert(cfg.env.ANTHROPIC_DEFAULT_FABLE_MODEL === "gpt-5.5-xhigh", "mapper: config carries fable model");
  assert(cfg.env.ANTHROPIC_DEFAULT_FABLE_MODEL_NAME === "gpt-5.5-xhigh", "mapper: config carries fable display name");
  assert(cfg.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME === "claude-opus-4-8", "mapper: config carries opus display name");
  assert(!("ANTHROPIC_DEFAULT_OPUS_MODEL" in cfg.env), "mapper: opus first-class model stays out of config");

  const expectedRoutes = [
    { pattern: "claude-opus-4-8", backendId: "default" },
    { pattern: "glm-5.2", backendId: "glm" },
    { pattern: "gpt-5.5-instant", backendId: "codex" },
    { pattern: "gpt-5.5-xhigh", backendId: "codex" },
    { pattern: "*", backendId: "default" },
  ];
  assert(JSON.stringify(tierRoutes(tiers)) === JSON.stringify(expectedRoutes), "mapper: tierRoutes order + catch-all");

  const dry = writeMapperSettings(tiers, { dryRun: true, port: 9000 });
  assert(dry.env.ANTHROPIC_BASE_URL === "http://127.0.0.1:9000", "mapper: settings base url");
  assert(dry.env.ANTHROPIC_API_KEY === DUMMY_KEY, "mapper: settings dummy key");
  assert(dry.env.ANTHROPIC_MODEL === "gpt-5.5-xhigh", "mapper: settings model uses fable");
  for (const tier of MAPPER_TIERS) {
    const key = tier.toUpperCase();
    assert(dry.env[`ANTHROPIC_DEFAULT_${key}_MODEL`] === tiers[tier].model, `mapper: ${tier} model env`);
    assert(dry.env[`ANTHROPIC_DEFAULT_${key}_MODEL_NAME`] === tiers[tier].model, `mapper: ${tier} model name env`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-router-mapper-"));
  try {
    const settingsFile = path.join(tmpDir, "settings.json");
    const backupFile = path.join(tmpDir, "settings-backup.json");
    fs.writeFileSync(settingsFile, JSON.stringify({ env: { KEEP_ME: "1" }, permissions: { allow: ["Bash(node --version)"] }, theme: "dark" }, null, 2));
    const written = writeMapperSettings(tiers, { settingsFile, backupFile, port: 9010 });
    const after = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    assert(fs.existsSync(backupFile), "mapper: settings backup created once");
    assert(after.env.KEEP_ME === "1", "mapper: settings env deep-merge preserves existing env");
    assert(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL === "glm-5.2", "mapper: settings write includes sonnet");
    assert(after.permissions.allow[0] === "Bash(node --version)" && after.theme === "dark", "mapper: settings write preserves non-env keys");
    assert(written.env.ANTHROPIC_DEFAULT_FABLE_MODEL === "gpt-5.5-xhigh", "mapper: write returns merged env");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function selftestAccountPool() {
  const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };
  const now = 1_750_000_000_000;
  const acct = (id, patch = {}) => normalizeAccount({
    id,
    label: id,
    organization_uuid: `org-${id}`,
    claudeAiOauth: { accessToken: `access-${id}`, refreshToken: `refresh-${id}`, expiresAt: now + 60_000 },
    status: "active",
    created_at: now,
    ...patch,
  });

  const store = { version: 1, active_id: "acct_02", accounts: [acct("acct_01"), acct("acct_02")] };
  assert(pickAccount(store, now).id === "acct_02", "pool: active available is selected");
  store.accounts[1].cooldown_until = now + 10_000;
  store.accounts[1].status = "cooldown";
  assert(pickAccount(store, now).id === "acct_01", "pool: active cooling falls back to next available");
  store.accounts[0].cooldown_until = now + 10_000;
  store.accounts[0].status = "cooldown";
  assert(pickAccount(store, now) === null, "pool: all cooling returns null");

  const resetAt = now + 86_400_000;
  const a429 = acct("acct_03");
  applyAccountFailure({ accounts: [a429] }, a429, 429, new Map([["anthropic-ratelimit-unified-reset", new Date(resetAt).toISOString()]]), "", now);
  assert(a429.cooldown_until === resetAt && a429.rate_limit_reset_at === resetAt && a429.cooldown_reason === "429_quota", "pool: 429 reset cooldown");
  const a429NoReset = acct("acct_04");
  applyAccountFailure({ accounts: [a429NoReset] }, a429NoReset, 429, {}, "", now);
  assert(a429NoReset.cooldown_until === now + 300_000, "pool: 429 no-reset cooldown");
  const a529 = acct("acct_05");
  applyAccountFailure({ accounts: [a529] }, a529, 529, {}, "", now);
  assert(a529.cooldown_until === now + 600_000 && a529.cooldown_reason === "529_overload", "pool: 529 cooldown");

  const dedupStore = { version: 1, active_id: null, accounts: [acct("acct_06", { organization_uuid: "org-dupe" })] };
  // re-login of an existing org REPLACES the account (keeps id), not 409 — refresh w/o Remove
  const beforeId = dedupStore.accounts[0].id;
  const replaced = addAccountToStore(dedupStore, acct("acct_07", { organization_uuid: "org-dupe" }));
  assert(dedupStore.accounts.length === 1, "pool: re-login same org replaces (no duplicate row)");
  assert(replaced.id === beforeId, "pool: re-login keeps existing account id");
  const addStore = { version: 1, active_id: null, accounts: [] };
  const added = addAccountToStore(addStore, acct("acct_12"));
  assert(addStore.accounts.length === 1 && addStore.active_id === added.id, "pool: add mutates caller store for save");

  const oldPending = pending;
  const scoped = buildAuthorizeUrl("org-xyz");
  assert(scoped.includes("https://claude.ai/v1/oauth/org-xyz/authorize"), "pool: org-scoped authorize URL");
  const generic = buildAuthorizeUrl(null);
  assert(generic.startsWith(AUTHORIZE_URL + "?"), "pool: generic authorize URL");
  pending = oldPending;

  const rotateStore = { version: 1, active_id: "acct_08", accounts: [acct("acct_08"), acct("acct_09"), acct("acct_10")] };
  const tried = new Set();
  for (let i = 0; i < MAX_ROTATE_RETRIES; i++) {
    const picked = pickAccount(rotateStore, now, tried);
    assert(picked, "pool: rotation pick before budget exhausted");
    applyAccountFailure(rotateStore, picked, 429, {}, "", now);
    tried.add(picked.id);
  }
  assert(pickAccount(rotateStore, now, tried) === null, "pool: rotation budget exhausted");
  assert(unavailableAccountsPayload().error.type === "proxy_error", "pool: exhausted budget returns proxy_error payload");

  const masked = maskedAccount(acct("acct_11"));
  assert(masked.claudeAiOauth.accessToken !== "access-acct_11" && masked.claudeAiOauth.refreshToken !== "refresh-acct_11", "pool: account tokens masked");
}

// Multi-backend assertions: routing, request/response translation, SSE, maskKey.
// (async because the SSE assertion iterates an async generator with for-await)
async function selftestMultiBackend() {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

  // (a) matchPattern
  assert(matchPattern("gpt-5.5", "gpt-5*"), "glob gpt-5* matches gpt-5.5");
  assert(matchPattern("gpt-5.4", "gpt-5*"), "glob gpt-5* matches gpt-5.4");
  assert(!matchPattern("glm-5.2", "gpt-5*"), "glob gpt-5* does not match glm-5.2");
  assert(matchPattern("opus", "opus"), "exact opus matches");
  assert(matchPattern("anything", "*"), "catch-all matches");

  // (b) routing — synthesize a cfg and call resolveBackendCfg against it
  const cfg = {
    backends: [
      { id: "codex",  format: "openai",    modelPatterns: ["gpt-5*"],           enabled: true },
      { id: "claude", format: "anthropic", modelPatterns: ["opus", "claude-*"], enabled: true },
      { id: "glm",    format: "openai",    modelPatterns: ["glm-*"],            enabled: true },
    ],
    routes: [
      { pattern: "gpt-5.5", backendId: "codex" },
      { pattern: "opus",    backendId: "claude" },
      { pattern: "glm-5.2", backendId: "glm" },
      { pattern: "*",       backendId: "claude" },
    ],
  };
  assert(resolveBackendCfg(cfg, "gpt-5.5").id === "codex", "route gpt-5.5 → codex");
  assert(resolveBackendCfg(cfg, "opus").id === "claude", "route opus → claude");
  assert(resolveBackendCfg(cfg, "glm-5.2").id === "glm", "route glm-5.2 → glm");
  assert(resolveBackendCfg(cfg, "gpt-5.4").id === "codex", "route gpt-5.5 miss → fallback modelPatterns gpt-5* → codex");
  assert(resolveBackendCfg(cfg, "weird").id === "claude", "catch-all * → claude");

  // (c) request translation
  const anth = {
    model: "gpt-5.5", max_tokens: 100, temperature: 0.5, top_k: 40,
    system: [{ type: "text", text: "You are helpful." }],
    messages: [
      { role: "user", content: "Weather in SF?" },
      { role: "assistant", content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "toolu_A", name: "get_weather", input: { location: "SF" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "62F" }] },
    ],
    tools: [{ name: "get_weather", description: "d", input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] }, strict: true }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    stop_sequences: ["END"],
    stream: true,
  };
  const oai = anthropicToOpenaiBody(anth);
  assert(oai.messages[0].role === "system" && oai.messages[0].content === "You are helpful.", "system → leading system message");
  assert(oai.max_completion_tokens === 100, "max_tokens → max_completion_tokens");
  assert(oai.top_k === undefined, "top_k dropped");
  assert(oai.temperature === 0.5, "temperature passthrough");
  assert(Array.isArray(oai.stop) && oai.stop[0] === "END", "stop_sequences → stop");
  assert(oai.stream_options && oai.stream_options.include_usage === true, "stream_options.include_usage added");
  assert(oai.tools[0].type === "function" && oai.tools[0].function.parameters.required[0] === "location" && oai.tools[0].function.strict === true, "tool mapped");
  assert(oai.tool_choice === "auto" && oai.parallel_tool_calls === false, "tool_choice + parallel inverted");
  const asst = oai.messages.find((m) => m.role === "assistant");
  assert(asst.tool_calls && asst.tool_calls[0].id === "toolu_A" && asst.tool_calls[0].function.arguments === '{"location":"SF"}', "tool_use → tool_calls.arguments string");
  const tool = oai.messages.find((m) => m.role === "tool");
  assert(tool && tool.tool_call_id === "toolu_A" && tool.content === "62F", "tool_result → role:tool");

  // (d) response translation
  const oaiResp = {
    id: "chatcmpl-1", model: "gpt-5.5",
    choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call_A", type: "function", function: { name: "get_weather", arguments: '{"location":"SF"}' } }] } }],
    usage: { prompt_tokens: 25, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } },
  };
  const aResp = openaiToAnthropicResponse(oaiResp, "gpt-5.5");
  assert(aResp.type === "message" && aResp.role === "assistant", "response type/role");
  assert(aResp.stop_reason === "tool_use", "finish_reason tool_calls → stop_reason tool_use");
  assert(aResp.content.find((b) => b.type === "tool_use" && b.id === "call_A" && b.input.location === "SF"), "tool_call → tool_use with parsed input");
  assert(aResp.usage.input_tokens === 25 && aResp.usage.output_tokens === 5 && aResp.usage.cache_read_input_tokens === 3, "usage mapped");

  // (e) SSE translation — scripted OpenAI chunks → Anthropic events
  const chunks = [
    { id: "chatcmpl-1", model: "gpt-5.5", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] },
    { id: "chatcmpl-1", model: "gpt-5.5", choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
    { id: "chatcmpl-1", model: "gpt-5.5", choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
    { id: "chatcmpl-1", model: "gpt-5.5", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_A", type: "function", function: { name: "get_weather", arguments: "" } }] }, finish_reason: null }] },
    { id: "chatcmpl-1", model: "gpt-5.5", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"locat' } }] }, finish_reason: null }] },
    { id: "chatcmpl-1", model: "gpt-5.5", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ion":"SF"}' } }] }, finish_reason: null }] },
    { id: "chatcmpl-1", model: "gpt-5.5", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "chatcmpl-1", model: "gpt-5.5", choices: [], usage: { prompt_tokens: 10, completion_tokens: 7 } },
  ];
  const events = [];
  for await (const block of openaiSseToAnthropicSse((async function* () { for (const c of chunks) yield Buffer.from("data: " + JSON.stringify(c) + "\n\n"); yield Buffer.from("data: [DONE]\n\n"); })(), "gpt-5.5")) {
    // sseBlock emits `event: <name>\ndata: <json>\n\n`; trim trailing \n\n before matching
    const m = block.trim().match(/^event: (\w+)\ndata: (\{.*\})$/s);
    if (m) events.push({ event: m[1], data: JSON.parse(m[2]) });
  }
  const seq = events.map((e) => e.event);
  assert(seq[0] === "message_start", "SSE: message_start first");
  assert(seq.includes("content_block_start") && seq.includes("content_block_delta"), "SSE: text block");
  assert(seq.filter((e) => e === "content_block_stop").length >= 2, "SSE: both blocks closed");
  const startTu = events.find((e) => e.event === "content_block_start" && e.data.content_block && e.data.content_block.type === "tool_use");
  assert(startTu && startTu.data.content_block.id === "call_A" && startTu.data.content_block.name === "get_weather", "SSE: tool_use block start carries id+name");
  const jsonDeltas = events.filter((e) => e.event === "content_block_delta" && e.data.delta && e.data.delta.type === "input_json_delta");
  assert(jsonDeltas.length === 2 && jsonDeltas.map((d) => d.data.delta.partial_json).join("") === '{"location":"SF"}', "SSE: input_json_delta partial_json accumulates");
  const md = events.find((e) => e.event === "message_delta");
  assert(md && md.data.delta.stop_reason === "tool_use", "SSE: message_delta stop_reason tool_use");
  assert(seq[seq.length - 1] === "message_stop", "SSE: message_stop last");

  // (f) key masking
  assert(maskKey("sk-abcdefgh") === "sk-…efgh", "maskKey sk-…efgh");
  assert(maskKey("") === "", "maskKey empty");
}

// Codex / Responses-API assertions: request translation, scripted Responses SSE →
// Anthropic SSE, and the non-stream assembler. (async — for-await over generators)
async function selftestCodexResponses() {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

  // (a) request translation: Anthropic Messages → Responses body
  const anth = {
    model: "gpt-5.5", max_tokens: 100, temperature: 0.5, top_k: 40,
    system: [{ type: "text", text: "You are helpful." }],
    messages: [
      { role: "user", content: "Weather in SF?" },
      { role: "assistant", content: [{ type: "text", text: "Let me check." }, { type: "tool_use", id: "toolu_A", name: "get_weather", input: { location: "SF" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_A", content: "62F" }] },
    ],
    tools: [{ name: "get_weather", description: "d", input_schema: { type: "object", properties: { location: { type: "string" } }, required: ["location"] }, strict: true }],
    tool_choice: { type: "auto" },
    stop_sequences: ["END"],
    stream: true,
  };
  const r = anthropicToOpenaiResponsesBody(anth);
  assert(r.store === false, "resp: store:false always");
  assert(r.stream === true, "resp: stream:true always");
  assert(r.instructions === "You are helpful.", "resp: system → instructions");
  assert(r.max_output_tokens === 100, "resp: max_tokens → max_output_tokens");
  assert(r.temperature === 0.5, "resp: temperature passthrough");
  assert(r.top_k === undefined, "resp: top_k dropped");
  assert(r.stop === undefined && r.stop_sequences === undefined, "resp: stop_sequences dropped");
  // user text → input_text
  const userMsg = r.input.find((it) => it.role === "user" && Array.isArray(it.content));
  assert(userMsg && userMsg.content[0].type === "input_text" && userMsg.content[0].text === "Weather in SF?", "resp: user text → input_text");
  // assistant text → output_text
  const asstMsg = r.input.find((it) => it.role === "assistant");
  assert(asstMsg && asstMsg.content[0].type === "output_text" && asstMsg.content[0].text === "Let me check.", "resp: assistant text → output_text");
  // assistant tool_use → top-level function_call with JSON.stringify arguments
  const fc = r.input.find((it) => it.type === "function_call");
  assert(fc && fc.call_id === "toolu_A" && fc.name === "get_weather" && fc.arguments === '{"location":"SF"}', "resp: tool_use → function_call (top-level, arguments string)");
  // user tool_result → function_call_output
  const fco = r.input.find((it) => it.type === "function_call_output");
  assert(fco && fco.call_id === "toolu_A" && fco.output === "62F", "resp: tool_result → function_call_output");
  // tools → flat function shape (NOT nested under .function)
  assert(r.tools[0].type === "function" && r.tools[0].name === "get_weather" && r.tools[0].parameters.required[0] === "location" && r.tools[0].strict === true, "resp: tools → flat function");
  assert(r.tool_choice === "auto", "resp: tool_choice auto");
  // ordering: user msg, assistant msg, function_call, function_call_output
  assert(r.input[0].role === "user", "resp: input[0] is user msg");
  assert(r.input[1].role === "assistant", "resp: input[1] is assistant msg");
  assert(r.input[2].type === "function_call", "resp: input[2] is function_call");
  assert(r.input[3].type === "function_call_output", "resp: input[3] is function_call_output");

  // (b) scripted Responses SSE → Anthropic SSE
  const respEvents = [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [] } },
    { type: "response.content_part.added", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hel" },
    { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "lo" },
    { type: "response.output_text.done", item_id: "msg_1", output_index: 0, content_index: 0, text: "Hello" },
    { type: "response.content_part.done", item_id: "msg_1", output_index: 0, content_index: 0, part: { type: "output_text", text: "Hello" } },
    { type: "response.output_item.done", output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "Hello" }] } },
    { type: "response.output_item.added", output_index: 1, item: { id: "fc_1", type: "function_call", name: "get_weather", arguments: "", call_id: "call_1" } },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: '{"locat' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 1, delta: 'ion":"SF"}' },
    { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1, arguments: '{"location":"SF"}' },
    { type: "response.output_item.done", output_index: 1, item: { id: "fc_1", type: "function_call", name: "get_weather", arguments: '{"location":"SF"}', call_id: "call_1" } },
    { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 25, output_tokens: 7, input_tokens_details: { cached_tokens: 3 } } } },
  ];
  const sse = respEvents.map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join("");
  const events = [];
  for await (const block of openaiResponsesSseToAnthropicSse((async function* () { yield Buffer.from(sse); })(), "gpt-5.5")) {
    const m = block.trim().match(/^event: (\w+)\ndata: (\{.*\})$/s);
    if (m) events.push({ event: m[1], data: JSON.parse(m[2]) });
  }
  const seq = events.map((e) => e.event);
  assert(seq[0] === "message_start", "resp SSE: message_start first");
  assert(seq[seq.length - 1] === "message_stop", "resp SSE: message_stop last");
  // text deltas
  const textDeltas = events.filter((e) => e.event === "content_block_delta" && e.data.delta && e.data.delta.type === "text_delta");
  assert(textDeltas.map((d) => d.data.delta.text).join("") === "Hello", "resp SSE: output_text.delta → text_delta accumulates to Hello");
  // tool_use block start carries call_id + name
  const tuStart = events.find((e) => e.event === "content_block_start" && e.data.content_block && e.data.content_block.type === "tool_use");
  assert(tuStart && tuStart.data.content_block.id === "call_1" && tuStart.data.content_block.name === "get_weather", "resp SSE: function_call → tool_use block start (id+name)");
  // input_json_delta partials
  const jsonDeltas = events.filter((e) => e.event === "content_block_delta" && e.data.delta && e.data.delta.type === "input_json_delta");
  assert(jsonDeltas.length === 2 && jsonDeltas.map((d) => d.data.delta.partial_json).join("") === '{"location":"SF"}', "resp SSE: function_call_arguments.delta → input_json_delta accumulates");
  // message_delta stop_reason + usage
  const md = events.find((e) => e.event === "message_delta");
  assert(md && md.data.delta.stop_reason === "tool_use", "resp SSE: response.completed → stop_reason tool_use (hadToolCalls)");
  assert(md.data.usage && md.data.usage.input_tokens === 25 && md.data.usage.output_tokens === 7 && md.data.usage.cache_read_input_tokens === 3, "resp SSE: usage mapped");
  // both blocks closed
  assert(seq.filter((e) => e === "content_block_stop").length >= 2, "resp SSE: both content blocks closed");

  // (c) non-stream assembler (same SSE → one Anthropic message)
  const ns = await openaiResponsesToAnthropicResponse((async function* () { yield Buffer.from(sse); })(), "gpt-5.5");
  assert(ns.type === "message" && ns.role === "assistant", "resp non-stream: type/role");
  assert(ns.content.find((b) => b.type === "text" && b.text === "Hello"), "resp non-stream: text block");
  assert(ns.content.find((b) => b.type === "tool_use" && b.id === "call_1" && b.input && b.input.location === "SF"), "resp non-stream: tool_use block with parsed input");
  assert(ns.stop_reason === "tool_use", "resp non-stream: stop_reason tool_use");
  assert(ns.usage.input_tokens === 25 && ns.usage.output_tokens === 7 && ns.usage.cache_read_input_tokens === 3, "resp non-stream: usage mapped");

  // (d) end_turn stop_reason when there are no tool calls
  const noToolSse = [
    { type: "response.created", response: { id: "resp_2", status: "in_progress" } },
    { type: "response.output_text.delta", item_id: "m", output_index: 0, content_index: 0, delta: "hi" },
    { type: "response.completed", response: { id: "resp_2", status: "completed", usage: { input_tokens: 5, output_tokens: 1 } } },
  ].map((ev) => `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`).join("");
  const ns2 = await openaiResponsesToAnthropicResponse((async function* () { yield Buffer.from(noToolSse); })(), "gpt-5.5");
  assert(ns2.stop_reason === "end_turn" && ns2.content[0].text === "hi", "resp non-stream: completed (no tools) → end_turn");
}

// --- self-test: request inspector (offline, isolated temp dir) ------------------
function selftestRequestLog() {
  const assert = (cond, msg) => { if (!cond) { console.error("FAIL:", msg); process.exit(1); } };

  // 1. redactSecrets() on objects + strings.
  const red = redactSecrets({
    authorization: "Bearer sk-ant-abcdefghijklmnopqrstuvwxyz0123456789",
    "x-api-key": "sk-secretkey12345",
    nested: { accessToken: "xyz", refreshToken: "abc", note: "use sk-ant-deadbeef0123456789abcd in prod" },
    list: ["Bearer eyJhbGciOiJ9.payloadpayloadpayloadpayloadpayload.sig", "harmless"],
    apiKey: "should-be-masked",
    keep: "hello world",
  });
  assert(red.authorization === "[REDACTED]", "redact: authorization key masked");
  assert(red["x-api-key"] === "[REDACTED]", "redact: x-api-key masked");
  assert(red.nested.accessToken === "[REDACTED]" && red.nested.refreshToken === "[REDACTED]", "redact: access/refresh token keys masked");
  assert(red.nested.note.includes("[REDACTED]") && !red.nested.note.includes("deadbeef"), "redact: sk- token inside string masked");
  assert(red.list[0].includes("[REDACTED]") && red.list[1] === "harmless", "redact: bearer in array masked, plain kept");
  assert(red.apiKey === "[REDACTED]", "redact: apiKey masked");
  assert(red.keep === "hello world", "redact: harmless value preserved");
  assert(redactSecrets("plain text sk-ant-cafebabe0123456789abcd end").includes("[REDACTED]"), "redact: top-level string sk- masked");

  // 2. prompt preview truncates + redacts.
  const longBody = { model: "m", messages: [{ role: "user", content: "x".repeat(5000) }] };
  const prev = buildPromptPreview(longBody, 200);
  assert(prev.length <= 201 + "User: ".length && prev.endsWith("…"), "preview: truncated to cap with ellipsis");
  const redactedPrev = buildPromptPreview({ model: "m", messages: [{ role: "user", content: "token sk-ant-feedface0123456789abcd here" }] }, 1000);
  assert(redactedPrev.includes("[REDACTED]") && !redactedPrev.includes("feedface"), "preview: secrets redacted");
  assert(buildPromptPreview({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image" }] }] }, 1000).includes("hi"), "preview: handles block content");

  // Isolate file I/O into a temp dir.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-router-reqlog-"));
  const savedDir = requestLog._dir;
  const savedSettings = requestLog.settings;
  const savedRecent = requestLog.recent;
  try {
    requestLog._dir = tmpDir;
    requestLog.recent = [];
    requestLog.settings = { ...REQUEST_SETTINGS_DEFAULTS };

    // 3. records success and error; 4. JSONL append works.
    const okId = requestLog.start({ method: "POST", url: "/v1/messages" }, { model: "glm-5.2", messages: [{ role: "user", content: "ping" }] }, { id: "glm", name: "GLM", format: "anthropic", authScheme: "x-api-key" });
    requestLog.finish(okId, { status: "success", httpStatus: 200, usage: { input_tokens: 3, output_tokens: 1 }, stopReason: "end_turn" });
    const errId = requestLog.start({ method: "POST", url: "/v1/messages" }, { model: "gpt-5.5-xhigh", messages: [{ role: "user", content: "boom" }] }, { id: "codex", name: "Codex", format: "openai-responses", codexOauth: true });
    requestLog.finish(errId, { status: "error", httpStatus: 500, errorPreview: "kaboom" });
    const jsonlPath = path.join(tmpDir, "requests.jsonl");
    assert(fs.existsSync(jsonlPath), "jsonl: file created");
    const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
    assert(lines.length === 2, "jsonl: two records appended");
    const recOk = JSON.parse(lines[0]); const recErr = JSON.parse(lines[1]);
    assert(recOk.status === "success" && recOk.usage.input_tokens === 3 && typeof recOk.latencyMs === "number", "jsonl: success record shape");
    assert(recErr.status === "error" && recErr.httpStatus === 500 && recErr.errorPreview === "kaboom", "jsonl: error record shape");

    // 8. API filtering returns expected subset.
    const listAll = requestLog.list({});
    assert(listAll.requests.length === 2 && listAll.stats.success === 1 && listAll.stats.error === 1, "list: stats success/error");
    assert(listAll.requests[0].id === errId, "list: newest first");
    assert(requestLog.list({ status: "error" }).requests.length === 1, "list: status filter");
    assert(requestLog.list({ backend: "glm" }).requests.length === 1, "list: backend filter");
    assert(requestLog.list({ model: "gpt-5.5" }).requests.length === 1, "list: model filter");
    assert(requestLog.list({ q: "ping" }).requests.length === 1, "list: prompt search filter");

    // get() falls back to JSONL tail scan after eviction.
    requestLog.recent = [];
    assert(requestLog.get(okId) && requestLog.get(okId).id === okId, "get: jsonl tail-scan fallback");

    // 5. rotation happens when maxLogBytes exceeded.
    requestLog.settings = { ...REQUEST_SETTINGS_DEFAULTS, maxLogBytes: 1048576 };
    fs.writeFileSync(jsonlPath, "x".repeat(1048600)); // exceed cap
    const rid = requestLog.start({ method: "POST", url: "/v1/messages" }, { model: "m" }, { id: "glm", format: "anthropic" });
    requestLog.finish(rid, { status: "success", httpStatus: 200 });
    assert(fs.existsSync(path.join(tmpDir, "requests.1.jsonl")), "rotate: old log moved to .1");
    assert(fs.statSync(jsonlPath).size < 1048576, "rotate: new log started small");

    // 6. full trace OFF: no trace file written.
    requestLog.settings = { ...REQUEST_SETTINGS_DEFAULTS, fullTraceEnabled: false };
    const offId = requestLog.start({ method: "POST", url: "/v1/messages" }, { model: "m" }, { id: "glm", format: "anthropic" });
    requestLog.trace(offId, { requestBody: { model: "m", "x-api-key": "sk-leak" } });
    requestLog.finish(offId, { status: "success", httpStatus: 200 });
    assert(!fs.existsSync(path.join(tmpDir, "request-traces", `${offId}.json`)), "trace off: no trace file");
    assert(requestLog.getTrace(offId) === null, "trace off: getTrace null");

    // 7. full trace ON: trace file exists and is redacted.
    requestLog.settings = { ...REQUEST_SETTINGS_DEFAULTS, fullTraceEnabled: true };
    const onId = requestLog.start({ method: "POST", url: "/v1/messages" }, { model: "m" }, { id: "glm", format: "anthropic" });
    requestLog.trace(onId, { requestBody: { model: "m", authorization: "Bearer sk-ant-secret0123456789abcdef" }, transformedBody: { token: "sk-proj-aaaaaaaaaaaaaaaaaaaa" } });
    requestLog.finish(onId, { status: "success", httpStatus: 200 });
    const tracePath = path.join(tmpDir, "request-traces", `${onId}.json`);
    assert(fs.existsSync(tracePath), "trace on: trace file exists");
    const traceRaw = fs.readFileSync(tracePath, "utf8");
    assert(!traceRaw.includes("secret0123456789") && !traceRaw.includes("sk-proj-aaaa"), "trace on: secrets redacted");
    const got = requestLog.getTrace(onId);
    assert(got && got.requestBody.authorization === "[REDACTED]", "trace on: getTrace returns redacted body");
    assert(requestLog.getTrace("../../etc/passwd") === null, "trace: path traversal guarded");

    // trace cap deletes oldest files beyond maxTraceFiles.
    requestLog.settings = { ...REQUEST_SETTINGS_DEFAULTS, fullTraceEnabled: true, maxTraceFiles: 1 };
    const capOld = requestLog.start({ method: "POST", url: "/v1/messages" }, { model: "m" }, { id: "glm", format: "anthropic" });
    requestLog.trace(capOld, { responseBodyPreview: "old" });
    try { fs.utimesSync(path.join(tmpDir, "request-traces", `${capOld}.json`), new Date(Date.now() - 10000), new Date(Date.now() - 10000)); } catch {}
    const capNew = requestLog.start({ method: "POST", url: "/v1/messages" }, { model: "m" }, { id: "glm", format: "anthropic" });
    requestLog.trace(capNew, { responseBodyPreview: "new" });
    assert(!fs.existsSync(path.join(tmpDir, "request-traces", `${capOld}.json`)) && fs.existsSync(path.join(tmpDir, "request-traces", `${capNew}.json`)), "trace cap: oldest deleted beyond cap");

    const ssePatch = requestLogPatchFromAnthropicSseText([
      sseBlock("message_start", { message: { usage: { input_tokens: 3, output_tokens: 1 } } }),
      sseBlock("message_delta", { delta: { stop_reason: "end_turn" }, usage: { input_tokens: 9, output_tokens: 4, cache_read_input_tokens: 2 } }),
      sseBlock("message_stop", {})
    ].join(""));
    assert(ssePatch.stopReason === "end_turn" && ssePatch.usage.input_tokens === 9 && ssePatch.usage.cache_read_input_tokens === 2, "sse parser: captures stop_reason + usage");

    // clear() empties memory + files.
    requestLog.clear();
    assert(requestLog.recent.length === 0, "clear: memory emptied");
    assert(fs.readFileSync(jsonlPath, "utf8") === "", "clear: jsonl truncated");
    assert(!fs.existsSync(path.join(tmpDir, "requests.1.jsonl")), "clear: rotated log deleted");
    assert(!fs.existsSync(tracePath), "clear: trace files deleted");

    // settings sanitization clamps out-of-range values.
    const s = sanitizeRequestSettings({ promptPreviewChars: 999999, maxRecentRequests: 1, maxLogBytes: 1, maxTraceFiles: 99999, fullTraceEnabled: "yes" });
    assert(s.promptPreviewChars === 5000 && s.maxRecentRequests === 50 && s.maxLogBytes === 1048576 && s.maxTraceFiles === 1000 && s.fullTraceEnabled === false, "settings: clamp + type guard");

    // sanitizeThinkingForClaude: drop unsigned thinking blocks, keep signed ones.
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", signature: "", thinking: "unsigned (from GLM)" }, { type: "text", text: "answer" }] },
      { role: "assistant", content: [{ type: "thinking", signature: "abc123", thinking: "signed (from Claude)" }, { type: "text", text: "ok" }] },
      { role: "assistant", content: [{ type: "thinking", signature: "", thinking: "only unsigned" }] },
    ];
    const cleaned = sanitizeThinkingForClaude(msgs);
    assert(cleaned[1].content.length === 1 && cleaned[1].content[0].type === "text", "thinking: unsigned dropped, text kept");
    assert(cleaned[2].content.length === 2 && cleaned[2].content[0].type === "thinking", "thinking: signed block preserved");
    assert(cleaned[3].content.length === 1 && cleaned[3].content[0].type === "text" && cleaned[3].content[0].text === "", "thinking: emptied turn gets placeholder text");
    assert(sanitizeThinkingForClaude(msgs) !== msgs, "thinking: returns new array when changed");
    const noThink = [{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "text", text: "y" }] }];
    assert(sanitizeThinkingForClaude(noThink) === noThink, "thinking: untouched array returned as-is");
  } finally {
    requestLog._dir = savedDir;
    requestLog.settings = savedSettings;
    requestLog.recent = savedRecent;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  console.log("selftest OK (request-inspector)");
}

// --- virtual models: normalization + predicates + resolution + non-regression ----
function selftestVirtualModels() {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };

  // (8.1) Normalization ---------------------------------------------------------
  // Valid VM round-trips with all fields.
  const full = normalizeVirtualModel({
    id: "fusion-smart", name: "Fusion (smart routing)", enabled: true, match: ["fusion-smart", "fusion-*"],
    rules: [
      { when: "hasImage",    backendId: "claude", model: "claude-opus-4-8" },
      { when: "longContext", backendId: "gemini", model: "gemini-2.5-pro", thresholdTokens: 200000 },
      { when: "keyword",     backendId: "glm",    model: "glm-5.2", keywords: ["LATEST", "Today "] },
    ],
    default: { backendId: "codex", model: "gpt-5.5" },
  });
  assert(full && full.id === "fusion-smart", "vm: valid round-trips with id");
  assert(Array.isArray(full.rules) && full.rules.length === 3, "vm: all 3 rules survive");
  assert(full.default.backendId === "codex" && full.default.model === "gpt-5.5", "vm: default preserved");
  // match defaults to [id] when omitted
  const noMatch = normalizeVirtualModel({ id: "vm1", default: { backendId: "b", model: "m" } });
  assert(JSON.stringify(noMatch.match) === JSON.stringify(["vm1"]), "vm: match defaults to [id]");
  assert(noMatch.enabled === true, "vm: enabled defaults to true");
  assert(noMatch.name === "vm1", "vm: name defaults to id");
  // bad id → dropped
  assert(normalizeVirtualModel({ id: "Bad ID", default: { backendId: "b", model: "m" } }) === null, "vm: bad id dropped");
  assert(normalizeVirtualModel({ id: "", default: { backendId: "b", model: "m" } }) === null, "vm: empty id dropped");
  // missing default → whole VM dropped
  assert(normalizeVirtualModel({ id: "vm2" }) === null, "vm: missing default drops whole VM");
  assert(normalizeVirtualModel({ id: "vm2", default: { backendId: "b" } }) === null, "vm: default missing model drops VM");
  // rule with unknown `when` dropped; keyword with empty keywords dropped; longContext clamped
  const messy = normalizeVirtualModel({
    id: "messy", default: { backendId: "b", model: "m" },
    rules: [
      { when: "bogus", backendId: "b", model: "m" },                       // dropped: unknown when
      { when: "keyword", backendId: "b", model: "m", keywords: [] },      // dropped: no keywords
      { when: "keyword", backendId: "b", model: "m", keywords: ["Hi"] },  // kept + lowercased
      { when: "longContext", backendId: "b", model: "m", thresholdTokens: -5 },   // clamped to 1
      { when: "longContext", backendId: "b", model: "m", thresholdTokens: 99_999_999 }, // clamped to 10_000_000
      { when: "hasImage", backendId: "", model: "m" },                    // dropped: empty backendId
    ],
  });
  assert(messy.rules.length === 3, "vm: 3 of 6 rules survive normalization");
  assert(messy.rules[0].keywords[0] === "hi", "vm: keywords lowercased");
  assert(messy.rules[1].thresholdTokens === 1, "vm: longContext threshold clamped to min 1");
  assert(messy.rules[2].thresholdTokens === 10_000_000, "vm: longContext threshold clamped to max");
  // normalizeVirtualModels filters nulls
  assert(normalizeVirtualModels([{ id: "ok", default: { backendId: "b", model: "m" } }, { id: "Bad" }]).length === 1, "vm: list filters dropped entries");
  // generated ids remain valid even when a 32-char slug needs a numeric suffix
  const generatedId = suggestVirtualModelId("a".repeat(40), { backends: [{ id: "a".repeat(32) }], virtualModels: [] });
  assert(ID_RE.test(generatedId) && generatedId.length <= 32 && generatedId.endsWith("-2"), "vm: generated collision id stays within ID_RE length");

  // (8.2) Condition predicates --------------------------------------------------
  const imgBody = { messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", source: { type: "base64" } }] }] };
  const txtBody = { messages: [{ role: "user", content: "hello" }] };
  assert(bodyHasImage(imgBody) === true, "pred: hasImage true for image block");
  assert(bodyHasImage(txtBody) === false, "pred: hasImage false for text-only");
  assert(bodyHasImage(null) === false, "pred: hasImage false for body=null");
  assert(bodyHasWebSearchTool({ tools: [{ name: "web_search" }] }) === true, "pred: webSearch true for name web_search");
  assert(bodyHasWebSearchTool({ tools: [{ type: "web_search_20250305" }] }) === true, "pred: webSearch true for server-tool type");
  assert(bodyHasWebSearchTool({ tools: [{ name: "get_weather" }] }) === false, "pred: webSearch false for unrelated tool");
  assert(bodyHasWebSearchTool({ tools: [{ name: "WebSearcher" }] }) === true, "pred: webSearch true for case-insensitive substring");
  const metaBody = { metadata: { web_search: true }, messages: [] };
  assert(ruleMatches({ when: "webSearch" }, metaBody) === true, "pred: webSearch true via metadata flag");
  assert(ruleMatches({ when: "webSearch" }, { messages: [] }) === false, "pred: webSearch false without flag/tool");
  // estimateInputTokens: monotonic; body=null → 0; image adds the constant
  assert(estimateInputTokens(null) === 0, "pred: tokens 0 for body=null");
  const small = { system: "abc", messages: [{ role: "user", content: "def" }] }; // 6 chars → 2 tokens
  const big = { system: "x".repeat(500), messages: [{ role: "user", content: "y".repeat(500) }] };
  assert(estimateInputTokens(small) < 100, "pred: small body under 100 tokens");
  assert(estimateInputTokens(big) > 100, "pred: big body over 100 tokens (monotonic)");
  assert(estimateInputTokens(big) > estimateInputTokens(small), "pred: tokens monotonic in text length");
  const withImg = { messages: [{ role: "user", content: [{ type: "image", source: {} }] }] };
  assert(estimateInputTokens(withImg) === 400, "pred: image block adds 1600 chars / 4 = 400 tokens");
  // ruleKeywordMatch: substring, case-insensitive
  const kwBody = { messages: [{ role: "user", content: "Tell me the LATEST news" }] };
  assert(ruleKeywordMatch({ keywords: ["latest"] }, kwBody) === true, "pred: keyword hits case-insensitive substring");
  assert(ruleKeywordMatch({ keywords: ["today"] }, kwBody) === false, "pred: keyword misses cleanly");
  assert(ruleKeywordMatch({ keywords: [] }, kwBody) === false, "pred: empty keyword list never matches");
  assert(ruleMatches({ when: "always" }, null) === true, "pred: always true even for body=null");

  // (8.3) Resolution precedence -------------------------------------------------
  const cfg = {
    backends: [
      { id: "claude", format: "anthropic", modelPatterns: ["opus"], enabled: true },
      { id: "glm",    format: "openai",    modelPatterns: ["glm-*"], enabled: true },
      { id: "gemini", format: "openai",    modelPatterns: ["gemini-*"], enabled: true },
      { id: "codex",  format: "openai",    modelPatterns: ["gpt-*"], enabled: true },
    ],
    routes: [{ pattern: "*", backendId: "codex" }],
    virtualModels: [{
      id: "fusion-smart", enabled: true, match: ["fusion-smart", "fusion-*"], default: { backendId: "codex", model: "gpt-5.5" },
      rules: [
        { when: "hasImage",    backendId: "claude", model: "claude-opus-4-8" },
        { when: "webSearch",   backendId: "glm",    model: "glm-5.2" },
        { when: "longContext", backendId: "gemini", model: "gemini-2.5-pro", thresholdTokens: 200000 },
      ],
    }],
  };
  // image → A (claude)
  let t = evaluateVirtualModel(resolveVirtualModel(cfg, "fusion-smart"), imgBody, cfg);
  assert(t.matchedRule === "hasImage" && t.backendId === "claude" && t.model === "claude-opus-4-8", "res: image → claude/opus");
  // web-search-tool → B (glm)
  t = evaluateVirtualModel(resolveVirtualModel(cfg, "fusion-smart"), { tools: [{ name: "web_search" }], messages: [] }, cfg);
  assert(t.matchedRule === "webSearch" && t.backendId === "glm", "res: webSearch → glm");
  // 300k-token body → C (gemini)
  const huge = { messages: [{ role: "user", content: "z".repeat(1_200_000) }] }; // 300k tokens
  t = evaluateVirtualModel(resolveVirtualModel(cfg, "fusion-smart"), huge, cfg);
  assert(t.matchedRule === "longContext" && t.backendId === "gemini", "res: longContext → gemini");
  // plain short text → D (codex default)
  t = evaluateVirtualModel(resolveVirtualModel(cfg, "fusion-smart"), txtBody, cfg);
  assert(t.matchedRule === "default" && t.backendId === "codex" && t.model === "gpt-5.5", "res: plain → default codex");
  // first-match wins: a body that is BOTH image and long-context, with hasImage first → A
  const imgAndHuge = { messages: [{ role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "z".repeat(1_200_000) }] }] };
  t = evaluateVirtualModel(resolveVirtualModel(cfg, "fusion-smart"), imgAndHuge, cfg);
  assert(t.matchedRule === "hasImage", "res: first-match wins (hasImage before longContext)");
  // resolveVirtualModel: null when empty; glob match; null for unrelated
  assert(resolveVirtualModel({ backends: [], routes: [], virtualModels: [] }, "fusion-smart") === null, "res: null when virtualModels empty");
  assert(resolveVirtualModel(cfg, "fusion-fast") && resolveVirtualModel(cfg, "fusion-fast").id === "fusion-smart", "res: glob fusion-* matches");
  assert(resolveVirtualModel(cfg, "gpt-5.5") === null, "res: non-VM model returns null");
  assert(resolveVirtualModel(cfg, null) === null, "res: null model returns null");
  // disabled VM is invisible
  const cfgDisabled = JSON.parse(JSON.stringify(cfg));
  cfgDisabled.virtualModels[0].enabled = false;
  assert(resolveVirtualModel(cfgDisabled, "fusion-smart") === null, "res: disabled VM treated as absent");
  // exact VM aliases that shadow real route/model names are rejected at write-validation time
  const cfgExactCollision = JSON.parse(JSON.stringify(cfg));
  cfgExactCollision.routes.unshift({ pattern: "claude-opus-4-8", backendId: "claude" });
  assert(exactRouteOrPatternCollision("claude-opus-4-8", cfgExactCollision, "fusion-smart").includes("route pattern"), "res: exact alias collision detects real route/model names");
  let collisionRejected = false;
  try { validateVirtualModelBackends({ id: "newvm", match: ["claude-opus-4-8"], rules: [], default: { backendId: "codex", model: "gpt-5.5" } }, cfgExactCollision); } catch (e) { collisionRejected = e.status === 409; }
  assert(collisionRejected, "res: validate rejects VM match alias that collides with a real model route");

  // Dangling backendId in a matched rule → proxy-style lookup falls back to
  // resolveBackendCfg(routeModel). Reproduce the exact proxy() backend-selection logic.
  const cfgDangling = {
    backends: [{ id: "codex", format: "openai", modelPatterns: ["gpt-*"], enabled: true }],
    routes: [{ pattern: "*", backendId: "codex" }],
    virtualModels: [{
      id: "fusion-smart", enabled: true, match: ["fusion-*"], default: { backendId: "codex", model: "gpt-5.5" },
      rules: [{ when: "hasImage", backendId: "ghost", model: "claude-opus-4-8" }], // ghost does not exist
    }],
  };
  const vmD = resolveVirtualModel(cfgDangling, "fusion-smart");
  const targetD = evaluateVirtualModel(vmD, imgBody, cfgDangling);
  assert(targetD.backendId === "ghost", "res: dangling rule still resolves to its target");
  // mirror: cfg.backends.find(enabled by id) || resolveBackendCfg(cfg, routeModel)
  const fallbackBackend = (cfgDangling.backends.find((b) => b.id === targetD.backendId && b.enabled !== false) || resolveBackendCfg(cfgDangling, targetD.model));
  assert(fallbackBackend && fallbackBackend.id === "codex", "res: dangling backend falls back to resolveBackendCfg(routeModel)");
  // req._virtualModel is set with the original alias + matched rule (mirror proxy)
  const req = { _virtualModel: { id: vmD.id, requested: "fusion-smart", target: targetD, rule: targetD.matchedRule } };
  assert(req._virtualModel.id === "fusion-smart" && req._virtualModel.rule === "hasImage", "res: _virtualModel carries alias + matched rule");

  // (8.4) Non-regression --------------------------------------------------------
  // loadConfig on a config WITHOUT virtualModels yields cfg.virtualModels === []
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-router-vm-"));
  try {
    const cfgFile = path.join(tmpDir, "backends.json");
    fs.writeFileSync(cfgFile, JSON.stringify({
      backends: [{ id: "codex", format: "openai", modelPatterns: ["gpt-*"], apiKey: "k" }],
      routes: [{ pattern: "*", backendId: "codex" }],
      // NOTE: no virtualModels key
    }), { mode: 0o600 });
    const loaded = loadConfig(cfgFile);
    assert(Array.isArray(loaded.virtualModels) && loaded.virtualModels.length === 0, "non-reg: missing virtualModels key → []");
    // resolveBackendCfg results identical to pre-feature behaviour
    assert(resolveBackendCfg(loaded, "gpt-5.5").id === "codex", "non-reg: routing still resolves gpt-5.5 → codex");
    assert(resolveVirtualModel(loaded, "gpt-5.5") === null, "non-reg: no VM match for real model");
    // empty file → synth, which also carries virtualModels: []
    const emptyFile = path.join(tmpDir, "empty.json");
    fs.writeFileSync(emptyFile, "", { mode: 0o600 });
    const synth = loadConfig(emptyFile);
    assert(Array.isArray(synth.virtualModels) && synth.virtualModels.length === 0, "non-reg: synth config has virtualModels: []");
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
  // synthesizeFromEnv() includes virtualModels: [] (current-process branch)
  assert(Array.isArray(synthesizeFromEnv().virtualModels) && synthesizeFromEnv().virtualModels.length === 0, "non-reg: synthesizeFromEnv has virtualModels: []");
  // With virtualModels present, a non-matching model still routes through the normal path byte-identically
  assert(resolveBackendCfg(cfg, "gpt-5.5").id === "codex", "non-reg: VMs present don't disturb real-model routing");

  console.log("selftest OK (virtual-models)");
}

// --- --checkbackends (live network pings, no listener) --------------------------
async function checkBackends() {
  const cfg = loadConfig();
  let allOk = true;
  for (const b of cfg.backends) {
    if (b.enabled === false) { console.log(`  [SKIP] ${b.id} (disabled)`); continue; }
    const nb = normalizeBackend(b);
    if (nb.authScheme === "oauth") {
      const store = await accountsForUse();
      if (store.accounts.length) {
        const model = nb.testModel || (nb.modelPatterns && nb.modelPatterns.find((p) => p && p !== "*")) || "";
        for (const account of store.accounts) {
          const tag = `${nb.id}/${account.id}`;
          if (account.status === "disabled") { console.log(`  [SKIP] ${tag} (${account.label}, disabled)`); continue; }
          if (Number(account.cooldown_until || 0) > Date.now()) { console.log(`  [SKIP] ${tag} (${account.label}, cooling until ${new Date(account.cooldown_until).toISOString()})`); continue; }
          const t0 = Date.now();
          try {
            const token = await ensureAccountAccessToken(store, account);
            const r = await throttledBackendFetch(nb, () => anthropicFetch(nb.upstream + "/v1/messages", {
              method: "POST",
              headers: headersOAuth({ "content-type": "application/json" }, token),
              body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
            }));
            const ms = Date.now() - t0;
            if (r.status === 429) {
              console.log(`  [OK  ] ${tag} (${account.organization_name || account.organization_uuid || account.label}) ${ms}ms sample="(429 rate-limited - auth passed)"`);
              continue;
            }
            if (!r.ok) {
              const err = `${r.status} ${(await r.text()).slice(0, 200)}`;
              console.log(`  [FAIL] ${tag} (${account.organization_name || account.organization_uuid || account.label}) ${ms}ms err=${err}`);
              allOk = false;
              continue;
            }
            const j = await r.json();
            const sample = j.content && j.content[0] && j.content[0].text;
            console.log(`  [OK  ] ${tag} (${account.organization_name || account.organization_uuid || account.label}) ${ms}ms sample=${JSON.stringify(sample)}`);
          } catch (e) { console.log(`  [FAIL] ${tag} ${e.message}`); allOk = false; }
        }
        continue;
      }
    }
    const t0 = Date.now();
    try {
      const r = await testBackend(nb);
      const ms = Date.now() - t0;
      console.log(`  [${r.ok ? "OK  " : "FAIL"}] ${b.id} (${b.format}) ${ms}ms${r.ok ? " sample=" + JSON.stringify(r.sample) : " err=" + r.error}`);
      if (!r.ok) allOk = false;
    } catch (e) { console.log(`  [FAIL] ${b.id} ${e.message}`); allOk = false; }
  }
  process.exit(allOk ? 0 : 1);
}

// --- main ------------------------------------------------------------------------
function modeLabel() {
  if (fs.existsSync(CFG_FILE)) {
    try { return `multi-backend (${loadConfig().backends.length} backends)`; } catch { return "multi-backend"; }
  }
  return KEY_MODE ? `API-key → ${UPSTREAM}` : "OAuth subscription (login at that URL)";
}
function listenWithRetry(port, attemptsLeft) {
  const onError = (e) => {
    if ((e.code === "EACCES" || e.code === "EADDRINUSE")) {
      // An explicitly-requested port must be respected — fail loudly so the user's
      // ANTHROPIC_BASE_URL stays correct. Only the default auto-hunts for a free port
      // (Windows excluded ranges shift on reboot, so a fixed default isn't reliable).
      if (EXPLICIT_PORT) { console.error(`claude-router: port ${port} unavailable (${e.code}). Pick a free one via CLAUDE_ROUTER_PORT.`); process.exit(1); }
      if (attemptsLeft > 0) return listenWithRetry(port + 1, attemptsLeft - 1);
    }
    console.error("claude-router: listen failed:", e.message); process.exit(1);
  };
  server.once("error", onError);
  server.listen(port, HOST, () => {
    server.removeListener("error", onError);
    boundPort = port;
    console.log(`claude-router on http://${HOST}:${port}  [${modeLabel()}]  — point Claude Code's ANTHROPIC_BASE_URL here`);
  });
}

if (process.argv.includes("--selftest")) {
  // selftest() is sync; selftestMultiBackend()/selftestCodexResponses() are async
  // (for-await over the SSE generators) — drive all three from an async IIFE so the
  // result ordering is deterministic.
  (async () => {
    selftest();
    selftestMapper();
    selftestAccountPool();
    await selftestMultiBackend();
    await selftestCodexResponses();
    selftestRequestLog();
    selftestVirtualModels();
    console.log("selftest OK (account-pool + multi-backend + codex/responses + request-inspector + virtual-models)");
  })();
} else if (process.argv.includes("--checkbackends")) {
  checkBackends();
} else {
  migrateAccountsFromCreds().catch(() => {});
  listenWithRetry(PORT, 60);
}

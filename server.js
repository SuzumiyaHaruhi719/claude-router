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
const REQUIRED_BETAS = ["oauth-2025-04-20", "claude-code-20250219"];

// Env fallback (existing single-backend modes — feed the synthesizer when no
// backends.json exists, so the no-config + CLAUDE_ROUTER_API_KEY case is byte-
// identical to the original single-file proxy).
const UPSTREAM = (process.env.CLAUDE_ROUTER_UPSTREAM || "https://api.anthropic.com").replace(/\/+$/, "");
const STATIC_KEY = process.env.CLAUDE_ROUTER_API_KEY || "";
const KEY_MODE = !!STATIC_KEY;

// --- config / profile paths ------------------------------------------------------
const CFG_DIR   = path.join(os.homedir(), ".claude-router");          // creds + backends config
const CRED_FILE = path.join(CFG_DIR, "creds.json");                   // existing OAuth tokens
const CFG_FILE  = path.join(CFG_DIR, "backends.json");                // NEW — multi-backend config
const CODEX_AUTH_FILE = path.join(os.homedir(), ".codex", "auth.json"); // Codex CLI OAuth token (read-only)
const CC_SETTINGS        = path.join(os.homedir(), ".claude", "settings.json"); // CC-Switch target
const CC_SETTINGS_LEGACY = path.join(os.homedir(), ".claude", "claude.json");   // CC-Switch fallback
const CC_BACKUP  = path.join(CFG_DIR, "settings-backup.json");        // pre-takeover backup
const ADMIN_TOKEN = process.env.CLAUDE_ROUTER_ADMIN_TOKEN || "";      // optional guard for /api writes
const DUMMY_KEY = "claude-router"; // non-empty dummy Claude Code sends; router ignores it
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;                            // backend id validation

// --- credential store (existing, unchanged) -------------------------------------
function loadCreds() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, "utf8")); } catch { return null; }
}
function saveCreds(c) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}
function clearCreds() { try { fs.unlinkSync(CRED_FILE); } catch {} }

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

function buildAuthorizeUrl() {
  const { verifier, challenge } = makePkce();
  const state = b64url(crypto.randomBytes(32));
  pending = { verifier, state };
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
  return `${AUTHORIZE_URL}?${q}`;
}

async function exchangeCode(raw) {
  if (!pending) throw new Error('No pending login — click "Login" first.');
  // CRS-aligned: clean the code (strip #fragment and &params), then exchange at
  // platform.claude.com (console.anthropic.com is dead — returns 403/404 post-migration).
  // The token endpoint fingerprint-checks the official client: it requires the
  // claude-cli User-Agent + an Origin/Referer of https://claude.ai, else 403.
  // Uses anthropicFetch (curl) — the token endpoint has the same TLS gate as /v1/messages.
  const code = String(raw).trim().split("#")[0].split("&")[0];
  if (!code) throw new Error("Empty authorization code.");
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
  saveCreds({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (Number(t.expires_in) || 0) * 1000,
  });
  pending = null;
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

// Returns a usable access token, refreshing if it's within 60s of expiry. null = login needed.
async function getAccessToken() {
  let c = loadCreds();
  if (!c || !c.access_token) return null;
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
  "anthropic-dangerous-direct-browser-access": "true",
  "x-app": "cli",
  "user-agent": "claude-cli/1.0.57 (external, cli)",
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
    if (body != null && body !== "") {
      const bodyStr = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
      args.push("--data-raw", bodyStr);
    }
    let child;
    try { child = spawn("curl", args, { windowsHide: true }); }
    catch (e) { return reject(new Error("curl spawn failed: " + e.message)); }
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
  const format = b.format === "openai" ? "openai" : b.format === "openai-responses" ? "openai-responses" : "anthropic";
  const codexOauth = !!(format === "openai-responses" && b.codexOauth);
  let authScheme = b.authScheme;
  if (!authScheme) {
    if (format === "openai") authScheme = "bearer";
    else if (format === "openai-responses") authScheme = codexOauth ? "codex-oauth" : "bearer";
    else if (b.oauth) authScheme = "oauth";
    else authScheme = "x-api-key";
  }
  return {
    id: String(b.id || ""),
    name: b.name || String(b.id || ""),
    upstream: String(b.upstream || "").replace(/\/+$/, ""),
    format,
    apiKey: b.apiKey || "",
    oauth: !!b.oauth,
    codexOauth,
    authScheme,
    modelPatterns: Array.isArray(b.modelPatterns) ? b.modelPatterns.slice() : [],
    modelMap: (b.modelMap && typeof b.modelMap === "object" && !Array.isArray(b.modelMap)) ? { ...b.modelMap } : {},
    testModel: b.testModel || "",
    enabled: b.enabled !== false,
  };
}

function synthesizeFromEnv() {
  if (STATIC_KEY) {                              // existing KEY_MODE
    return {
      backends: [normalizeBackend({ id:"default", name:"API-key passthrough", upstream: UPSTREAM,
        format:"anthropic", apiKey: STATIC_KEY, authScheme:"x-api-key",
        modelPatterns:["*"], modelMap:{}, testModel:"", enabled:true })],
      routes: [{ pattern:"*", backendId:"default" }],
      profiles: {}, activeProfile: null,
    };
  }
  // OAuth subscription (existing)
  return {
    backends: [normalizeBackend({ id:"default", name:"Anthropic subscription (OAuth)", upstream:"https://api.anthropic.com",
      format:"anthropic", apiKey:"", oauth:true, authScheme:"oauth",
      modelPatterns:["*"], modelMap:{}, testModel:"claude-opus-4-8", enabled:true })],
    routes: [{ pattern:"*", backendId:"default" }],
    profiles: {}, activeProfile: null,
  };
}

function loadConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
    // normalize + validate shape so downstream code can trust the fields
    cfg.backends = Array.isArray(cfg.backends) ? cfg.backends.map(normalizeBackend) : [];
    if (!cfg.backends.length) return synthesizeFromEnv(); // empty file → synth
    cfg.routes = Array.isArray(cfg.routes) ? cfg.routes : [];
    cfg.profiles = (cfg.profiles && typeof cfg.profiles === "object") ? cfg.profiles : {};
    cfg.activeProfile = cfg.activeProfile || null;
    return cfg;
  } catch { return synthesizeFromEnv(); }
}
function saveConfig(cfg) {
  fs.mkdirSync(CFG_DIR, { recursive: true });
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
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
  if (state.hadToolCalls) return "tool_use";
  if (state.incompleteReason === "max_output_tokens") return "max_tokens";
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
    } else if (t === "response.completed") {
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
    } else if (t === "response.completed") {
      if (ev.response) {
        if (ev.response.id) responseId = "msg_" + String(ev.response.id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
        status = ev.response.status || "completed";
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
  const stopReason = hadToolCalls ? "tool_use" : (incompleteReason === "max_output_tokens" ? "max_tokens" : "end_turn");
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
async function openaiResponsesTranslate(req, res, backend, body) {
  if (!body || !body.model) return sendJson(res, 400, { error: { type: "invalid_request_error", message: "router: missing body.model" } });
  const model = (backend.modelMap && backend.modelMap[body.model]) || body.model;

  if (req.url.startsWith("/v1/messages/count_tokens")) {
    return sendJson(res, 200, openaiCountTokensResponse(body));
  }

  const isStream = !!body.stream;
  const rBody = anthropicToOpenaiResponsesBody({ ...body, model });
  // The chatgpt.com codex endpoint is a constrained Responses subset: it rejects
  // max_output_tokens ("Unsupported parameter: max_output_tokens" → 400). Strip it
  // for codexOauth. A bearer openai-responses backend against the standard
  // api.openai.com/v1/responses keeps max_output_tokens (the Responses API accepts it).
  if (backend.codexOauth) delete rBody.max_output_tokens;

  let bearer;
  if (backend.codexOauth) {
    const creds = loadCodexCreds();
    if (!creds || !creds.access_token) {
      return sendJson(res, 401, { error: { type: "authentication_error", message: `claude-router: codex not logged in — run \`codex login\` first (no ~/.codex/auth.json).` } });
    }
    bearer = creds.access_token;
  } else {
    if (!backend.apiKey) return sendJson(res, 401, { error: { type: "authentication_error", message: `${backend.id}: missing API key` } });
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
    up = await anthropicFetch(backend.upstream, { method: "POST", headers, body: JSON.stringify(rBody) });
  } catch (e) {
    return sendJson(res, 502, { error: { type: "proxy_error", message: `${backend.id}: ${String(e)}` } });
  }
  if (!up.ok) {
    const text = await up.text();
    return sendJson(res, up.status, { error: { type: "api_error", message: `${backend.id} upstream ${up.status}: ${text.slice(0, 500)}` } });
  }

  const reader = up.body.getReader();
  const iter = (async function* () { for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; } })();

  if (isStream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
    try {
      for await (const block of openaiResponsesSseToAnthropicSse(iter, body.model)) res.write(block);
    } catch (e) {
      res.write(sseBlock("error", { type: "error", error: { type: "api_error", message: String(e) } }));
    }
    res.end();
  } else {
    try {
      const anth = await openaiResponsesToAnthropicResponse(iter, body.model);
      sendJson(res, 200, anth);
    } catch (e) {
      sendJson(res, 502, { error: { type: "api_error", message: `${backend.id}: ${String(e)}` } });
    }
  }
}

// --- proxy wiring: openai-format backend (plain fetch — no TLS gate on GLM/codex) -
async function openaiTranslate(req, res, backend, body) {
  if (!body || !body.model) return sendJson(res, 400, { error: { type: "invalid_request_error", message: "router: missing body.model" } });
  const model = (backend.modelMap && backend.modelMap[body.model]) || body.model;

  if (req.url.startsWith("/v1/messages/count_tokens")) {
    return sendJson(res, 200, openaiCountTokensResponse(body));
  }

  const isStream = !!body.stream;
  const oaiBody = anthropicToOpenaiBody({ ...body, model });
  const url = backend.upstream + "/chat/completions";
  const headers = { "content-type": "application/json", "authorization": `Bearer ${backend.apiKey}` };
  if (isStream) headers.accept = "text/event-stream";

  let up;
  try {
    up = await fetch(url, { method: "POST", headers, body: JSON.stringify(oaiBody) });
  } catch (e) {
    return sendJson(res, 502, { error: { type: "proxy_error", message: `${backend.id}: ${String(e)}` } });
  }
  if (!up.ok) {
    const text = await up.text();
    return sendJson(res, up.status, { error: { type: "api_error", message: `${backend.id} upstream ${up.status}: ${text.slice(0, 500)}` } });
  }

  if (isStream) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
    try {
      const reader = up.body.getReader();
      const iter = (async function* () { for (;;) { const { done, value } = await reader.read(); if (done) break; yield value; } })();
      for await (const block of openaiSseToAnthropicSse(iter, body.model)) res.write(block);
    } catch (e) {
      res.write(sseBlock("error", { type: "error", error: { type: "api_error", message: String(e) } }));
    }
    res.end();
  } else {
    const json = await up.json();
    sendJson(res, 200, openaiToAnthropicResponse(json, body.model));
  }
}

// --- per-backend anthropic passthrough (reuses header helpers; anthropicFetch) ---
// IRON RULE: byte-for-byte passthrough. Uses anthropicFetch (curl → nodeProxyFetch
// fallback) for the upstream call — NOT plain fetch — or the subscription-OAuth 403
// (TLS-fingerprint gate) returns.
async function anthropicPassthrough(req, res, backend, body) {
  const model = (body && backend.modelMap && backend.modelMap[body.model]) || (body && body.model);
  let sendBody = req._rawBody;                                  // raw bytes by default
  if (body && model && model !== body.model) {
    sendBody = Buffer.from(JSON.stringify({ ...body, model })); // cheap rewrite for modelMap
  }
  const url = backend.upstream + req.url;                       // /v1/messages | /v1/messages/count_tokens
  let headers;
  if (backend.authScheme === "oauth") {
    const token = await getAccessToken();                       // existing refresh logic
    if (!token) return sendJson(res, 401, { error: { type: "authentication_error", message: `claude-router: not logged in. Open http://${HOST}:${boundPort}/ and click Login.` } });
    headers = headersOAuth(req.headers, token);                 // existing
  } else { // x-api-key
    headers = headersKey(req.headers, backend.apiKey);          // existing
  }
  const doFetch = (hdrs) => anthropicFetch(url, { method: req.method, headers: hdrs, body: sendBody && sendBody.length ? sendBody : undefined });
  let up;
  try { up = await doFetch(headers); }
  catch (e) { return sendJson(res, 502, { error: { type: "proxy_error", message: String(e) } }); }
  // token rejected mid-flight → force one refresh + retry (oauth only)
  if (up.status === 401 && backend.authScheme === "oauth") {
    const c = loadCreds();
    if (c && c.refresh_token) {
      try { const c2 = await refreshCreds(c); up = await doFetch(headersOAuth(req.headers, c2.access_token)); } catch {}
    }
  }
  await streamUpstream(res, up);                                // existing
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
async function streamUpstream(res, up) {
  const headers = { "content-type": up.headers.get("content-type") || "application/json" };
  res.writeHead(up.status, headers);
  if (up.body) {
    const reader = up.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
  }
  res.end();
}

// proxy(): read body once (raw + parsed), route by body.model, dispatch by format.
async function proxy(req, res) {
  const raw = await readBody(req);
  req._rawBody = raw;
  let body = null;
  if (raw.length) { try { body = JSON.parse(raw.toString("utf8")); } catch { body = null; } } // non-JSON → passthrough raw
  req._body = body;
  const model = body && body.model;
  const backend = resolveBackend(model);
  if (!backend) return sendJson(res, 502, { error: { type: "proxy_error", message: `no backend for model ${model || "<none>"}` } });
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
function atomicWriteJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sortKeys(obj), null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}
function detectOsEnvConflicts() {
  const risky = ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"];
  return risky.filter((k) => process.env[k] && process.env[k] !== DUMMY_KEY);
}

function ccSettingsPath() {
  return fs.existsSync(CC_SETTINGS_LEGACY) ? CC_SETTINGS_LEGACY : CC_SETTINGS;
}
function applyProfile(name) {
  const cfg = loadConfig();
  const profile = cfg.profiles && cfg.profiles[name];
  if (!profile) throw new Error(`unknown profile: ${name}`);
  const file = ccSettingsPath();

  // 1. back up the ORIGINAL (first time only) — crash-safe like CC-Switch
  if (!fs.existsSync(CC_BACKUP) && fs.existsSync(file)) {
    fs.mkdirSync(CFG_DIR, { recursive: true });
    fs.writeFileSync(CC_BACKUP, fs.readFileSync(file, "utf8"), { mode: 0o600 });
  }

  // 2. deep-merge: only set env.ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY + ANTHROPIC_MODEL; preserve everything else
  const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8") || "{}") : {};
  cur.env = cur.env && typeof cur.env === "object" ? cur.env : {};
  cur.env.ANTHROPIC_BASE_URL = `http://${HOST}:${boundPort}`;
  cur.env.ANTHROPIC_API_KEY = DUMMY_KEY;                        // non-empty dummy; router ignores it
  if (profile.primaryModel) cur.env.ANTHROPIC_MODEL = profile.primaryModel;
  // NOTE: we do NOT scrub ANTHROPIC_DEFAULT_*_MODEL — we WANT Claude Code to send our route names.

  // 3. atomic write (temp + rename), keys sorted — matches CC-Switch atomic_write
  atomicWriteJson(file, cur);

  // 4. persist active profile (+ optional route overrides)
  cfg.activeProfile = name;
  if (Array.isArray(profile.routeOverrides)) cfg.routes = profile.routeOverrides;
  saveConfig(cfg);

  return { writtenPath: file, env: cur.env, conflicts: detectOsEnvConflicts() };
}
function restoreProfile() {
  const file = ccSettingsPath();
  if (!fs.existsSync(CC_BACKUP)) throw new Error("no backup to restore");
  fs.copyFileSync(CC_BACKUP, file);                              // restore original
  const cfg = loadConfig(); cfg.activeProfile = null; saveConfig(cfg);
  return { restoredPath: file };
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
  const model = b.testModel || (b.modelPatterns && b.modelPatterns.find((p) => p && p !== "*")) || "";
  if (b.format === "openai-responses") {
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
    const r = await anthropicFetch(b.upstream, {
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
    const r = await fetch(b.upstream + "/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", "authorization": `Bearer ${b.apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_completion_tokens: 1, stream: false }),
    });
    if (!r.ok) return { ok: false, latencyMs: 0, model, error: `${r.status} ${(await r.text()).slice(0, 200)}` };
    const j = await r.json();
    const sample = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return { ok: true, latencyMs: 0, model, sample };
  }
  // anthropic
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (b.authScheme === "oauth") {
    const tok = await getAccessToken();
    if (!tok) return { ok: false, latencyMs: 0, model, error: "not logged in" };
    headers["authorization"] = `Bearer ${tok}`;
    headers["anthropic-beta"] = mergeBetas("");   // subscription needs the oauth beta
  } else {
    headers["x-api-key"] = b.apiKey;
  }
  const r = await anthropicFetch(b.upstream + "/v1/messages", {
    method: "POST", headers,
    body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
  });
  if (!r.ok) return { ok: false, latencyMs: 0, model, error: `${r.status} ${(await r.text()).slice(0, 200)}` };
  const j = await r.json();
  const sample = j.content && j.content[0] && j.content[0].text;
  return { ok: true, latencyMs: 0, model, sample };
}

// --- status (existing) ----------------------------------------------------------
function statusLine() {
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
const WEBUI = fs.existsSync(WEBUI_PATH) ? fs.readFileSync(WEBUI_PATH, "utf8") : FALLBACK_HTML;

// --- http helpers ----------------------------------------------------------------
function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
function sendHtml(res, code, html) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}
function redirect(res, location) {
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
    profiles: cfg.profiles || {},
    activeProfile: cfg.activeProfile || null,
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

async function apiRouter(req, res, url) {
  const method = req.method;
  const seg = url.split("/").filter(Boolean); // ["api", ...]
  const head = seg[1];
  if (head === "state" && method === "GET" && seg.length === 2) return sendJson(res, 200, apiState());

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

  if (head === "profiles") {
    if (seg.length === 2 && method === "GET") {
      const c = loadConfig();
      return sendJson(res, 200, { profiles: c.profiles || {}, activeProfile: c.activeProfile || null });
    }
    if (seg.length === 3 && method === "POST" && seg[2] === "restore") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await restoreProfile()); }
    if (seg.length === 4 && method === "POST" && seg[3] === "apply") { if (!isAdminOk(req)) return adminDenied(res); return sendJson(res, 200, await applyProfile(seg[2])); }
  }

  return sendJson(res, 404, { error: { type: "not_found", message: "claude-router: unknown api path " + url } });
}

// --- http server -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];
    const method = req.method;
    if (method === "GET" && url === "/") return sendHtml(res, 200, WEBUI);
    if (method === "GET" && url === "/login") return redirect(res, buildAuthorizeUrl());
    if (method === "POST" && url === "/exchange") {
      const form = await parseForm(req);
      try { await exchangeCode(form.get("code") || ""); return redirect(res, "/"); }
      catch (e) { return sendHtml(res, 400, `<p style="font:15px system-ui;color:#b3261e">${escapeHtml(String(e && e.message || e))}</p><p><a href="/">← back</a></p>`); }
    }
    if (method === "POST" && url === "/logout") { clearCreds(); return redirect(res, "/"); }
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

// --- --checkbackends (live network pings, no listener) --------------------------
async function checkBackends() {
  const cfg = loadConfig();
  let allOk = true;
  for (const b of cfg.backends) {
    if (b.enabled === false) { console.log(`  [SKIP] ${b.id} (disabled)`); continue; }
    const t0 = Date.now();
    try {
      const r = await testBackend(normalizeBackend(b));
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
    await selftestMultiBackend();
    await selftestCodexResponses();
    console.log("selftest OK (multi-backend + codex/responses)");
  })();
} else if (process.argv.includes("--checkbackends")) {
  checkBackends();
} else {
  listenWithRetry(PORT, 60);
}

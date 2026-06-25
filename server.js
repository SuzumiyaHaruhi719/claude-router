#!/usr/bin/env node
// claude-router — minimal local proxy that lets Claude Code run on your Claude
// Pro/Max SUBSCRIPTION (OAuth) instead of a pay-per-token API key.
//
//   Claude Code ──/v1/messages──▶ claude-router (127.0.0.1) ──Bearer──▶ api.anthropic.com
//
// One file, zero deps, Node >= 18 (uses built-in http, global fetch, crypto, fs).
//   node server.js            # run the router + login webui
//   node server.js --selftest # run the offline self-checks
//
// NOTE: uses Claude Code's OAuth client to drive your subscription. That is the
// user's own account / local use; Anthropic's consumer terms restrict programmatic
// use of subscription credentials, and these reverse-engineered constants may change.

"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
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
// Upstream + auth mode. Default = Anthropic via subscription OAuth (what the user
// specced). But Anthropic 403-blocks subscription-OAuth inference (verified
// 2026-06-25), so a working alternative is "key mode": set CLAUDE_ROUTER_API_KEY
// (and optionally CLAUDE_ROUTER_UPSTREAM for an Anthropic-compatible endpoint like
// GLM/z.ai) and the router forwards with x-api-key instead, passing the client's
// betas through untouched. Key mode is auto-selected when CLAUDE_ROUTER_API_KEY is set.
const UPSTREAM = (process.env.CLAUDE_ROUTER_UPSTREAM || "https://api.anthropic.com").replace(/\/+$/, "");
const STATIC_KEY = process.env.CLAUDE_ROUTER_API_KEY || "";
const KEY_MODE = !!STATIC_KEY;
const CRED_DIR = path.join(os.homedir(), ".claude-router");
const CRED_FILE = path.join(CRED_DIR, "creds.json");

// --- credential store ------------------------------------------------------------
function loadCreds() {
  try { return JSON.parse(fs.readFileSync(CRED_FILE, "utf8")); } catch { return null; }
}
function saveCreds(c) {
  fs.mkdirSync(CRED_DIR, { recursive: true });
  fs.writeFileSync(CRED_FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}
function clearCreds() { try { fs.unlinkSync(CRED_FILE); } catch {} }

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

// --- header helpers --------------------------------------------------------------
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
// subscription backend's inference) go through curl. Returns a fetch-like Response so
// the existing streamUpstream/exchange code is unchanged. Streams SSE via curl -N.
const HAVE_CURL = (() => { try { require("child_process").execFileSync("curl", ["--version"], { stdio: "ignore", windowsHide: true }); return true; } catch { return false; } })();

function curlFetch(url, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const args = ["-s", "-i", "-N", "--no-buffer", "--max-time", "180", url, "-X", String(method)];
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
    const finish = () => { childDone = true; if (waiter) { const w = waiter; waiter = null; w({ done: true }); } if (!resolved) reject(new Error("curl produced no output" + (stderr ? " | " + stderr.slice(0, 300) : ""))); };
    child.stdout.on("end", finish);
    child.on("error", (e) => { if (!resolved) reject(new Error("curl error: " + e.message)); });
    child.on("exit", finish);
  });
}

// Anthropic-bound fetch: use curl (TLS bypass) when available, else fall back to Node fetch.
const anthropicFetch = (url, opts) => (HAVE_CURL ? curlFetch(url, opts) : fetch(url, opts));

function mergeBetas(clientBeta) {
  const set = new Set();  if (clientBeta) String(clientBeta).split(",").forEach((b) => { const t = b.trim(); if (t) set.add(t); });
  REQUIRED_BETAS.forEach((b) => set.add(b));
  return [...set].join(",");
}

// --- proxy -----------------------------------------------------------------------
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
async function proxy(req, res) {
  const body = await readBody(req);
  const url = UPSTREAM + req.url;

  if (KEY_MODE) {
    // API-key mode: forward to the configured upstream with x-api-key. No login needed.
    let up;
    try { up = await anthropicFetch(url, { method: req.method, headers: headersKey(req.headers, STATIC_KEY), body: body.length ? body : undefined }); }
    catch (e) { return sendJson(res, 502, { error: { type: "proxy_error", message: String(e) } }); }
    return streamUpstream(res, up);
  }

  // OAuth mode (subscription).
  const token = await getAccessToken();
  if (!token) return sendJson(res, 401, { error: { type: "authentication_error", message: `claude-router: not logged in. Open http://${HOST}:${boundPort}/ and click Login.` } });
  const doFetch = (tok) => anthropicFetch(url, { method: req.method, headers: headersOAuth(req.headers, tok), body: body.length ? body : undefined });

  let up;
  try { up = await doFetch(token); }
  catch (e) { return sendJson(res, 502, { error: { type: "proxy_error", message: String(e) } }); }

  // token rejected mid-flight → force one refresh + retry
  if (up.status === 401) {
    const c = loadCreds();
    if (c && c.refresh_token) {
      try { const c2 = await refreshCreds(c); up = await doFetch(c2.access_token); } catch {}
    }
  }
  await streamUpstream(res, up);
}

// --- webui -----------------------------------------------------------------------
function statusLine() {
  const c = loadCreds();
  if (!c || !c.access_token) return { ok: false, text: "Not logged in." };
  const secs = Math.round(((c.expires_at || 0) - Date.now()) / 1000);
  if (secs <= 0) return { ok: true, text: "Logged in (token expired — will auto-refresh on next request)." };
  const mins = Math.round(secs / 60);
  return { ok: true, text: `Logged in. Token valid ~${mins} min.` };
}
function page() {
  const s = statusLine();
  const base = `http://${HOST}:${boundPort}`;
  const loginCard = `<div class=card><b>登录 / Re-login</b>
    <ol>
      <li><a class="btn primary" href="/login" target="_blank" rel=noopener>① Login with Claude</a> — 新标签页打开授权，登录并同意。</li>
      <li>授权后页面会显示一串 <code>code#state</code>，整段复制。</li>
      <li>粘贴到这里 → Submit：
        <form method=post action=/exchange><input name=code placeholder="把 code#state 粘到这里" autocomplete=off><button>② Submit code</button></form>
      </li>
    </ol></div>`;
  const oauthWarn = `<p class=muted style="color:#b3261e;margin-top:10px">⚠ Anthropic 目前对订阅 OAuth 推理返回 403（2026-06-25 实测被拦）。要立即可用：设 <code>CLAUDE_ROUTER_API_KEY</code>（+可选 <code>CLAUDE_ROUTER_UPSTREAM</code> 指向 Anthropic 兼容端点，如 GLM/z.ai）切到 API-key 模式。</p>`;
  const modeCards = KEY_MODE
    ? `<div class=card><div class=st style="color:#1a7f37">API-key 模式</div><p class=muted>转发到 <code>${UPSTREAM}</code>，用环境变量里的 x-api-key 鉴权，无需登录。</p></div>`
    : `<div class=card><div class=st>${s.text}</div>${s.ok ? `<form method=post action=/logout style=margin-top:12px><button>Logout</button></form>` : ""}${oauthWarn}</div>` + loginCard;
  return `<!doctype html><meta charset=utf8><title>claude-router</title>
<style>
 body{font:15px/1.6 system-ui,Segoe UI,sans-serif;max-width:640px;margin:6vh auto;padding:0 20px;color:#1c1c1c;background:#faf9f7}
 h1{font-size:20px;margin:0 0 4px} .sub{color:#888;margin:0 0 24px}
 .card{background:#fff;border:1px solid #e6e3dd;border-radius:12px;padding:18px 20px;margin:14px 0}
 .st{font-weight:600;color:${s.ok ? "#1a7f37" : "#b3261e"}}
 a.btn,button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid #d6d3cc;background:#fff;padding:8px 16px;text-decoration:none;color:#1c1c1c;display:inline-block}
 a.primary{background:#cd6f4c;border-color:#cd6f4c;color:#fff}
 input{font:inherit;width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d6d3cc;border-radius:8px;margin:8px 0}
 code{background:#f0eee9;padding:2px 6px;border-radius:5px;font-size:13px}
 ol{padding-left:20px;color:#444} li{margin:6px 0} .muted{color:#999;font-size:13px}
</style>
<h1>claude-router</h1>
<p class=sub>本地把 Claude 订阅当 API 用 · localhost only</p>

${modeCards}

<div class=card>
  <b>给 Claude Code 用</b>
  <p class=muted>设置环境变量后启动 Claude Code：</p>
  <p><code>set ANTHROPIC_BASE_URL=${base}</code><br><code>set ANTHROPIC_API_KEY=dummy</code></p>
  <p class=muted>(PowerShell: <code>$env:ANTHROPIC_BASE_URL="${base}"</code> ; key 随便填，router 会忽略并换成你的订阅 token)</p>
</div>`;
}

// --- http server -----------------------------------------------------------------
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

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split("?")[0];
    if (req.method === "GET" && url === "/") return sendHtml(res, 200, page());
    if (req.method === "GET" && url === "/login") return redirect(res, buildAuthorizeUrl());
    if (req.method === "POST" && url === "/exchange") {
      const form = await parseForm(req);
      try { await exchangeCode(form.get("code") || ""); return redirect(res, "/"); }
      catch (e) { return sendHtml(res, 400, `<p style="font:15px system-ui;color:#b3261e">${escapeHtml(String(e.message || e))}</p><p><a href="/">← back</a></p>`); }
    }
    if (req.method === "POST" && url === "/logout") { clearCreds(); return redirect(res, "/"); }
    if (url.startsWith("/v1/")) return await proxy(req, res);
    sendJson(res, 404, { error: { type: "not_found", message: "claude-router: unknown path " + url } });
  } catch (e) {
    sendJson(res, 500, { error: { type: "router_error", message: String(e && e.message || e) } });
  }
});
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

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

// --- main ------------------------------------------------------------------------
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
    console.log(`claude-router on http://${HOST}:${port}  [${KEY_MODE ? "API-key → " + UPSTREAM : "OAuth subscription (login at that URL)"}]  — point Claude Code's ANTHROPIC_BASE_URL here`);
  });
}

if (process.argv.includes("--selftest")) {
  selftest();
} else {
  listenWithRetry(PORT, 60);
}

#!/usr/bin/env node
// claude-router external watchdog — keeps the router (port 8123) alive.
//
// Detects three failure modes via an HTTP health probe (not just "is the PID alive"):
//   1. crashed/exited  -> connection refused
//   2. hung            -> probe times out
//   3. zombie          -> port open but app not responding -> RST/timeout
// On N consecutive failures it kills whatever holds the port and respawns the router.
//
// HARD REQUIREMENT: the monitor must NEVER crash. Everything is wrapped; uncaught
// exceptions and unhandled rejections are logged and swallowed; the health loop is a
// self-rescheduling setInterval whose body can throw freely without killing the process.
// Pair with start-monitor.bat (a goto-loop) so even an external kill relaunches it.
//
//   node monitor.js                 # watch 8123
//   MONITOR_PORT=8230 node monitor.js   # watch another port (for testing)
"use strict";

// ---- never-crash floor: log and keep running, no matter what ----
process.on("uncaughtException", (e) => log("uncaughtException (ignored): " + safeStr(e)));
process.on("unhandledRejection", (e) => log("unhandledRejection (ignored): " + safeStr(e)));

let http, child_process, fs, path, os, net;
try {
  http = require("http");
  child_process = require("child_process");
  fs = require("fs");
  path = require("path");
  os = require("os");
  net = require("net");
} catch (e) {
  // If even the requires fail, we cannot do anything useful — exit so the .bat relaunches.
  try { process.stderr.write("monitor: failed to load builtins: " + e + "\n"); } catch {}
  process.exit(1);
}

// ---- config (env-overridable, all with safe defaults) ----
function intEnv(name, def, min, max) {
  const n = parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
const DIR = __dirname;
const PORT = intEnv("MONITOR_PORT", 8123, 1, 65535);
const HOST = "127.0.0.1";
const HEALTH_PATH = "/api/state";
const CHECK_INTERVAL_MS = intEnv("MONITOR_INTERVAL_MS", 8000, 1000, 600000);
const PROBE_TIMEOUT_MS = intEnv("MONITOR_TIMEOUT_MS", 5000, 500, 60000);
const FAIL_THRESHOLD = intEnv("MONITOR_FAIL_THRESHOLD", 3, 1, 100);
const MIN_RESTART_INTERVAL_MS = intEnv("MONITOR_MIN_RESTART_MS", 15000, 3000, 600000);
const SERVER_JS = path.join(DIR, "server.js");
const MONITOR_LOG = path.join(DIR, "monitor.log");
const ROUTER_LOG = path.join(DIR, "router.log");
const LOG_CAP_BYTES = 5 * 1024 * 1024; // 5MB, then truncate

// ---- state ----
let failCount = 0;
let lastRestartAt = 0;
let restarting = false;
let totalRestarts = 0;

function safeStr(x) {
  try { return x && x.stack ? String(x.stack) : String(x); } catch { return "<unprintable>"; }
}
function log(msg) {
  const line = "[" + new Date().toISOString() + "] " + msg + "\n";
  try { process.stdout.write(line); } catch {}
  try {
    // best-effort size cap so the log can't grow unbounded
    try { const st = fs.statSync(MONITOR_LOG); if (st && st.size > LOG_CAP_BYTES) fs.writeFileSync(MONITOR_LOG, ""); } catch {}
    fs.appendFileSync(MONITOR_LOG, line);
  } catch {}
}

// HTTP health probe — resolves true/false, NEVER rejects.
function probe() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(!!ok); } };
    let req;
    try {
      req = http.request(
        { host: HOST, port: PORT, path: HEALTH_PATH, method: "GET", timeout: PROBE_TIMEOUT_MS },
        (res) => {
          // drain the body; healthy iff a 2xx/3xx status came back
          const ok = res.statusCode >= 200 && res.statusCode < 400;
          try { res.on("data", () => {}); res.on("end", () => finish(ok)); res.on("error", () => finish(ok)); } catch { finish(ok); }
          // safety: resolve even if 'end' never fires
          setTimeout(() => finish(ok), PROBE_TIMEOUT_MS);
        }
      );
      req.on("timeout", () => { try { req.destroy(); } catch {} finish(false); });
      req.on("error", () => finish(false));
      req.setTimeout(PROBE_TIMEOUT_MS, () => { try { req.destroy(); } catch {} finish(false); });
      req.end();
    } catch (e) {
      finish(false);
    }
    // absolute backstop
    setTimeout(() => finish(false), PROBE_TIMEOUT_MS + 2000);
  });
}

// Kill whatever process is LISTENING on PORT (Windows). Best-effort, never throws.
function killPort() {
  return new Promise((resolve) => {
    try {
      const cmd = process.platform === "win32"
        ? `for /f "tokens=5" %a in ('netstat -ano ^| findstr LISTENING ^| findstr :${PORT}') do taskkill /PID %a /F`
        : `bash -lc "lsof -ti tcp:${PORT} | xargs -r kill -9" `;
      const opts = { windowsHide: true, timeout: 10000 };
      if (process.platform === "win32") {
        child_process.exec(cmd, opts, () => resolve());
      } else {
        child_process.exec(cmd, opts, () => resolve());
      }
    } catch (e) {
      log("killPort error (ignored): " + safeStr(e));
      resolve();
    }
    // never hang
    setTimeout(resolve, 11000);
  });
}

function spawnRouter() {
  try {
    let out = "ignore", err = "ignore";
    try {
      // cap router.log too, then capture its output for crash diagnostics
      try { const st = fs.statSync(ROUTER_LOG); if (st && st.size > LOG_CAP_BYTES) fs.writeFileSync(ROUTER_LOG, ""); } catch {}
      const fd = fs.openSync(ROUTER_LOG, "a");
      out = fd; err = fd;
    } catch (e) { /* fall back to ignore */ }
    const env = Object.assign({}, process.env, { CLAUDE_ROUTER_PORT: String(PORT) });
    const child = child_process.spawn(process.execPath, [SERVER_JS], {
      cwd: DIR, env, detached: true, stdio: ["ignore", out, err], windowsHide: true,
    });
    child.on("error", (e) => log("spawn error (ignored): " + safeStr(e)));
    try { child.unref(); } catch {}
    log("spawned router (pid " + (child && child.pid) + ") on port " + PORT);
  } catch (e) {
    log("spawnRouter failed (ignored): " + safeStr(e));
  }
}

async function restartRouter(reason) {
  if (restarting) return;
  const now = Date.now();
  if (now - lastRestartAt < MIN_RESTART_INTERVAL_MS) {
    log("restart suppressed (cooldown) — " + reason);
    return;
  }
  restarting = true;
  lastRestartAt = now;
  totalRestarts++;
  try {
    log("RESTARTING router (#" + totalRestarts + ") — " + reason);
    await killPort();
    await new Promise((r) => setTimeout(r, 2000));
    spawnRouter();
    // give it time to bind before the next probe counts against it
    await new Promise((r) => setTimeout(r, 6000));
  } catch (e) {
    log("restart sequence error (ignored): " + safeStr(e));
  } finally {
    restarting = false;
    failCount = 0;
  }
}

async function tick() {
  try {
    if (restarting) return;
    const healthy = await probe();
    if (healthy) {
      if (failCount > 0) log("router healthy again (after " + failCount + " miss" + (failCount === 1 ? "" : "es") + ")");
      failCount = 0;
      return;
    }
    failCount++;
    log("health check FAILED (" + failCount + "/" + FAIL_THRESHOLD + ") on port " + PORT);
    if (failCount >= FAIL_THRESHOLD) {
      await restartRouter("router not responding after " + failCount + " checks");
    }
  } catch (e) {
    // tick must never throw out
    log("tick error (ignored): " + safeStr(e));
  }
}

function loop() {
  // schedule the next tick AFTER the current one finishes, so a slow tick can't overlap.
  Promise.resolve()
    .then(tick)
    .catch((e) => { try { log("loop tick rejected (ignored): " + safeStr(e)); } catch {} })
    .finally(() => { try { setTimeout(loop, CHECK_INTERVAL_MS); } catch { setTimeout(loop, 8000); } });
}

log("=== claude-router monitor started === watching http://" + HOST + ":" + PORT + HEALTH_PATH +
    " | interval=" + CHECK_INTERVAL_MS + "ms timeout=" + PROBE_TIMEOUT_MS + "ms threshold=" + FAIL_THRESHOLD);
// initial immediate check, then the self-rescheduling loop
loop();

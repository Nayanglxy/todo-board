#!/usr/bin/env node
// Our own review surface — replaces lavish-axi. Zero deps, node 18+.
// Localhost-only HTTP server: serves the board app shell, streams state,
// and accepts human edits straight onto the coordinator-owned 'human' segment.
//
//   node server.mjs                 bind 127.0.0.1:8787 (override: TODO_BOARD_PORT)
//   ssh -L 8787:localhost:8787 box  then open http://localhost:8787 on your laptop
//
// Security model: binds loopback ONLY. Reachability is the SSH tunnel; the
// server itself is never exposed on the box's public interface.
import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, mkdirSync, statSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { readAllEvents, fold, appendEvent, genId, STATUSES, root, artifactsDir } from "./lib.mjs";
import { attach } from "./attach.mjs";
import { parseSession, compactPrompt } from "./session-parse.mjs";
import { commentBlock, freshPrompt, VARIANTS, VARIANT_IDS, frame, variantLabel, variantMeta } from "./prompts.mjs";

const PORT = Number(process.env.TODO_BOARD_PORT) || 8787;
const HOST = "127.0.0.1";
const OMP = process.env.OMP_BIN || "/home/nbandaru/.local/bin/omp";
const MAX_SPAWN = Number(process.env.TODO_BOARD_MAX_SPAWN) || 3;
// idle cap: a running session is killed if it produces no activity (assistant
// output / tool traffic) for this long. A review send spawns a fresh run, so
// "your comment / response" resets the clock the same way. Override in minutes.
const IDLE_MS = (Number(process.env.TODO_BOARD_IDLE_MIN) || 30) * 60_000;
const running = new Map(); // taskId -> { pid, started }

// parse cache: avoid re-parsing a multi-MB .jsonl on every poll (keyed by mtime)
const _pcache = new Map(); // path -> { mtimeMs, parsed }
function parseSessionCached(path) {
  const mt = statSync(path).mtimeMs;
  const hit = _pcache.get(path);
  if (hit && hit.mtimeMs === mt) return hit.parsed;
  const parsed = parseSession(readFileSync(path, "utf8"));
  _pcache.set(path, { mtimeMs: mt, parsed });
  return parsed;
}

// ---- state read: fold live history; rev = event count (cheap change signal) ----
function snapshot() {
  const events = readAllEvents();
  return { rev: events.length, board: fold(events), spawning: [...running.keys()], cap: MAX_SPAWN };
}

// ---- human edits -> events on the 'human' segment (single writer = this proc) ----
const ALLOWED_OPS = new Set(["add", "update", "note", "drop"]);
const FIELD_KEYS = new Set(["title", "status", "priority", "owner", "notes", "order", "text"]);

function sanitize(e) {
  if (!e || !ALLOWED_OPS.has(e.op)) return null;
  const out = { op: e.op };
  if (e.id) out.id = String(e.id);
  for (const k of FIELD_KEYS) if (e[k] !== undefined) out[k] = e[k];
  if (out.status !== undefined && !STATUSES.includes(out.status)) return null;
  if (out.op !== "add" && out.op !== "drop" && !out.id) return null;
  return out;
}

function applyEdits(edits) {
  let n = 0;
  for (const raw of Array.isArray(edits) ? edits : []) {
    const e = sanitize(raw);
    if (!e) continue;
    const id = e.id || (e.op === "add" ? genId() : undefined);
    if (!id && e.op !== "drop") continue;
    appendEvent("human", { ...e, id: id || e.id });
    n++;
  }
  return n;
}

// ---- helpers ----
const send = (res, code, type, body) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
};
const json = (res, code, obj) => send(res, code, "application/json", JSON.stringify(obj));

// ---- anti-rebinding / anti-CSRF: enforce the loopback-only model at L7 ----
// A DNS-rebind or a cross-site fetch from the owner's browser (while the SSH
// tunnel is open) could otherwise reach mutating routes. Legit local/tunnel
// traffic always presents Host: localhost|127.0.0.1 and a same-origin (or
// absent) Origin. Reject anything else before it touches state.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
function hostOk(req) {
  const host = String(req.headers.host || "").split(":")[0].toLowerCase();
  return LOOPBACK.has(host);
}
function originOk(req) {
  const o = req.headers.origin || req.headers.referer;
  if (!o) return true; // curl, same-origin navigations, and tests send none
  try { return LOOPBACK.has(new URL(o).hostname.toLowerCase()); } catch { return false; }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1 << 20) { reject(new Error("body too large")); req.destroy(); return; }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---- per-task artifacts ----
function findTask(id) {
  return fold(readAllEvents()).tasks.find((t) => t.id === id) || null;
}

const ART_CT = { html: "text/html; charset=utf-8", json: "application/json; charset=utf-8", png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml" };
const IMG_FMT = new Set(["png", "webp", "jpg", "jpeg", "gif", "svg"]);
function serveArtifact(req, res, taskId, art) {
  const t = findTask(taskId);
  const a = t && (t.artifacts || []).find((x) => x.art === art);
  if (!a) return json(res, 404, { ok: false, error: "no such artifact" });
  const base = artifactsDir();
  const p = join(base, a.file);
  if ((p !== base && !p.startsWith(base + sep)) || !existsSync(p)) return json(res, 404, { ok: false, error: "missing body" });
  const ct = ART_CT[a.format] || "text/plain; charset=utf-8";
  if (IMG_FMT.has(a.format)) {
    // figures are large but stable once written — revalidate cheaply via ETag
    let st; try { st = statSync(p); } catch { return json(res, 404, { ok: false, error: "missing body" }); }
    const etag = '"' + Math.round(st.mtimeMs) + "-" + st.size + '"';
    if (req && req.headers["if-none-match"] === etag) { res.writeHead(304, { etag, "cache-control": "no-cache" }); return res.end(); }
    const h = { "content-type": ct, "cache-control": "no-cache", "x-content-type-options": "nosniff", etag };
    if (a.format === "svg") h["content-security-policy"] = "default-src 'none'; style-src 'unsafe-inline'";
    res.writeHead(200, h);
    return res.end(readFileSync(p));
  }
  // html bodies render in a scripts-OFF sandboxed iframe; CSP is defence-in-depth
  // for anyone hitting the raw URL directly (no scripts, no exfil, no framing games).
  const headers = { "content-type": ct, "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (a.format === "html") headers["content-security-policy"] = "default-src 'none'; img-src data: https:; style-src 'unsafe-inline'; font-src data:";
  res.writeHead(200, headers);
  res.end(readFileSync(p));
}

// omp sessions live here; used to validate import paths and adopt forked files.
const SESSIONS_ROOT = join(homedir(), ".omp", "agent", "sessions");
function underSessions(p) {
  try { return realpathSync(p).startsWith(realpathSync(SESSIONS_ROOT)); } catch { return false; }
}
// newest .jsonl under SESSIONS_ROOT modified at/after `since` (to adopt a fork)
function newestSessionSince(since) {
  let best = null, bestM = since;
  const walk = (d) => {
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".jsonl")) { try { const mt = statSync(f).mtimeMs; if (mt >= bestM) { bestM = mt; best = f; } } catch {} }
    }
  };
  walk(SESSIONS_ROOT);
  return best;
}

// ---- unified session runner (confirm-gated in UI, capped here) ----
// mode: "task" (own session, --continue), "resume" (resume a .jsonl by path),
//       "compact" (fresh session seeded with omp's own rollup + comments).
function runSession(taskId, { mode = "task", promptOverride = null, resumePath = null, label = "", variant = null, abRun = null, onDone = null } = {}) {
  const t = findTask(taskId);
  if (!t) return { ok: false, code: 404, error: "no such task" };
  if (running.has(taskId)) return { ok: false, code: 409, error: "a session is already running for this task" };
  if (running.size >= MAX_SPAWN) return { ok: false, code: 429, error: `cap reached: ${running.size}/${MAX_SPAWN} sessions running` };

  const env = { ...process.env, TODO_BOARD_TASK: taskId, TODO_BOARD_AUTOTASK: "0" };
  let args, verb, prevPath = null, prevMtime = 0;
  if (mode === "resume") {
    if (!resumePath || !underSessions(resumePath)) return { ok: false, code: 400, error: "resume path missing or outside sessions root" };
    prevPath = resumePath;
    try { prevMtime = statSync(resumePath).mtimeMs; } catch {}
    args = ["-p", "--print-thoughts", "--resume", resumePath, promptOverride || "Continue."];
    verb = "resumed";
  } else if (mode === "compact") {
    args = ["-p", "--print-thoughts", promptOverride || "Continue."]; // fresh, no resume
    verb = "started (compact)";
  } else {
    const sessDir = join(root(), "sessions", taskId);
    let resuming = false;
    try { mkdirSync(sessDir, { recursive: true }); resuming = readdirSync(sessDir).some((f) => f.endsWith(".jsonl")); } catch {}
    const prompt = promptOverride || freshPrompt(t, resuming);
    args = ["-p", "--print-thoughts", "--session-dir", sessDir];
    if (resuming) args.push("--continue");
    args.push(prompt);
    verb = resuming ? "resumed" : "started";
  }

  const startMs = Date.now();
  let child;
  try {
    child = spawn(OMP, args, { cwd: root(), env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    return { ok: false, code: 500, error: "spawn failed: " + (e && e.message) };
  }
  running.set(taskId, { pid: child.pid, started: startMs });
  appendEvent("spawner", { op: "update", id: taskId, status: "doing", interrupted: false });
  appendEvent("spawner", { op: "log", id: taskId, text: `▶ ${verb} omp session${label ? " — " + label : ""} (pid ${child.pid})` });

  let out = "", lastActivity = Date.now(), interrupted = false;
  const cap = (d) => { lastActivity = Date.now(); out += d; if (out.length > 4_000_000) out = out.slice(-4_000_000); };
  child.stdout.on("data", cap);
  child.stderr.on("data", cap);
  child.on("error", (e) => cap(`\n[spawn error] ${e && e.message}\n`));
  // kill on idle: no assistant activity for IDLE_MS since the last chunk
  const idle = setInterval(() => {
    if (Date.now() - lastActivity >= IDLE_MS) {
      interrupted = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref();
    }
  }, Math.max(1000, Math.min(30_000, IDLE_MS)));
  idle.unref();
  child.on("exit", (exitCode) => {
    clearInterval(idle);
    running.delete(taskId);
    try {
      attach("spawner", taskId, "output", `${label || "session"} response${interrupted ? " (interrupted)" : ` (exit ${exitCode})`}`, { body: out || "(no output captured)", format: "text", ab: abRun, variant });
      // adopt the updated/forked session file so the review view reflects new turns
      if (mode === "resume") {
        let adopt = null;
        try { if (statSync(prevPath).mtimeMs > prevMtime) adopt = prevPath; } catch {}
        if (!adopt) adopt = newestSessionSince(startMs);
        if (adopt && adopt !== t.session) appendEvent("spawner", { op: "update", id: taskId, session: adopt });
      }
      if (interrupted) {
        // don't close it out and keep it in Current Sessions — just flag it as
        // stopped-but-resumable (status is left untouched).
        appendEvent("spawner", { op: "update", id: taskId, interrupted: true });
        appendEvent("spawner", { op: "log", id: taskId, text: `⏸ interrupted — ${Math.round(IDLE_MS / 60000)}m idle cap hit (no assistant activity); stopped but still open to resume` });
      } else {
        appendEvent("spawner", { op: "log", id: taskId, text: `session finished (exit ${exitCode})` });
      }
    } catch {}
    try { if (onDone) onDone(exitCode); } catch {}
  });
  return { ok: true, code: 200, pid: child.pid, running: running.size };
}
function spawnSession(taskId) {
  const t = findTask(taskId);
  if (t && t.session && underSessions(t.session)) return runSession(taskId, { mode: "resume", resumePath: t.session, label: "resume" });
  return runSession(taskId, { mode: "task" });
}

// ---- A/B harness: run one core prompt through N framings, side by side ----
// Each framing is an INDEPENDENT resume fork off the same session, so every
// arm starts from identical context and only the framing differs. Runs are
// serialized (runSession is single-flight per task); each response is captured
// as an artifact tagged {ab, variant} so the task page can group them.
async function runAB(taskId, { variants, core, compact }) {
  const t = findTask(taskId);
  if (!t || !t.session) return;
  const abRun = "ab_" + genId().slice(2);
  appendEvent("reviewer", { op: "note", id: taskId, text: `A/B ${abRun}: ${variants.length} framings — ${variants.map(variantLabel).join(", ")}` });
  appendEvent("reviewer", { op: "log", id: taskId, text: `⚑ A/B run ${abRun} started — ${variants.map(variantLabel).join(" · ")}` });
  for (const vid of variants) {
    const framed = frame(vid, core);
    const label = `A/B ${variantLabel(vid)}`;
    await new Promise((resolve) => {
      const opts = compact
        ? { mode: "compact", promptOverride: compactPrompt(parseSessionCached(t.session), framed) }
        : { mode: "resume", resumePath: t.session, promptOverride: framed };
      const r = runSession(taskId, { ...opts, variant: vid, abRun, label, onDone: () => resolve() });
      if (!r || !r.ok) {
        appendEvent("reviewer", { op: "log", id: taskId, text: `A/B ${variantLabel(vid)} skipped: ${(r && r.error) || "run rejected"}` });
        resolve();
      }
    });
  }
  appendEvent("reviewer", { op: "log", id: taskId, text: `✔ A/B run ${abRun} complete` });
}

// ---- routes ----
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);
    let m;
    if (!hostOk(req)) return json(res, 403, { ok: false, error: "forbidden host (loopback only)" });
    if (req.method !== "GET" && !originOk(req)) return json(res, 403, { ok: false, error: "cross-origin blocked" });
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, "text/html; charset=utf-8", PAGE);
    if (req.method === "GET" && url.pathname === "/api/board") return json(res, 200, snapshot());
    if (req.method === "POST" && url.pathname === "/api/edit") {
      const body = await readBody(req);
      let payload; try { payload = JSON.parse(body || "{}"); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
      const n = applyEdits(payload.edits);
      return json(res, 200, { ok: true, applied: n, ...snapshot() });
    }
    if (req.method === "POST" && url.pathname === "/api/spawn") {
      const body = await readBody(req);
      let payload; try { payload = JSON.parse(body || "{}"); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
      const r = spawnSession(String(payload.taskId || ""));
      return json(res, r.code || (r.ok ? 200 : 400), { ...r, ...snapshot() });
    }
    // associate an omp session .jsonl with a task (validated under sessions root)
    if (req.method === "POST" && url.pathname === "/api/import-session") {
      const body = await readBody(req);
      let payload; try { payload = JSON.parse(body || "{}"); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
      const taskId = String(payload.taskId || ""); const path = String(payload.path || "");
      if (!findTask(taskId)) return json(res, 404, { ok: false, error: "no such task" });
      if (!path || !underSessions(path) || !existsSync(path)) return json(res, 400, { ok: false, error: "path missing or outside ~/.omp/agent/sessions" });
      appendEvent("importer", { op: "update", id: taskId, session: realpathSync(path) });
      return json(res, 200, { ok: true, ...snapshot() });
    }
    // parsed transcript + cost/compaction signals for the review UI
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/session\/(t_[a-z0-9]+)$/))) {
      const t = findTask(m[1]);
      if (!t) return json(res, 404, { ok: false, error: "no such task" });
      if (!t.session || !existsSync(t.session)) return json(res, 200, { ok: true, hasSession: false, taskId: t.id });
      // conditional cache: a large transcript is only re-sent when the .jsonl
      // (or run state) actually changes — an unchanged reload gets a tiny 304.
      let st; try { st = statSync(t.session); } catch (e) { return json(res, 500, { ok: false, error: "stat failed: " + e.message }); }
      const etag = '"' + Math.round(st.mtimeMs) + "-" + st.size + "-" + (running.has(t.id) ? 1 : 0) + '"';
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag, "cache-control": "no-cache" }); return res.end(); }
      let p; try { p = parseSessionCached(t.session); } catch (e) { return json(res, 500, { ok: false, error: "parse failed: " + e.message }); }
      const body = JSON.stringify({ ok: true, hasSession: true, taskId: t.id, path: t.session, title: p.title, tokens: p.tokens, promptTokens: p.promptTokens, cost: p.cost, hasCompaction: !!p.compaction, turns: p.turns, running: running.has(t.id) });
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache", etag });
      return res.end(body);
    }
    // review: assembled comments -> prompt -> resume the reviewed session
    if (req.method === "POST" && url.pathname === "/api/review") {
      const body = await readBody(req);
      let payload; try { payload = JSON.parse(body || "{}"); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
      const t = findTask(String(payload.taskId || ""));
      if (!t) return json(res, 404, { ok: false, error: "no such task" });
      if (!t.session || !existsSync(t.session)) return json(res, 400, { ok: false, error: "task has no associated session" });
      const comments = Array.isArray(payload.comments) ? payload.comments : [];
      if (!comments.length) return json(res, 400, { ok: false, error: "no comments to send" });
      const block = commentBlock(comments);
      appendEvent("reviewer", { op: "note", id: t.id, text: `review sent (${comments.length} comment${comments.length > 1 ? "s" : ""})` });
      let r;
      if (payload.compact) {
        const p = parseSessionCached(t.session);
        r = runSession(t.id, { mode: "compact", promptOverride: compactPrompt(p, block), label: "review (compact)" });
      } else {
        r = runSession(t.id, { mode: "resume", resumePath: t.session, promptOverride: block, label: "review" });
      }
      return json(res, r.code || (r.ok ? 200 : 400), { ...r, ...snapshot() });
    }
    // A/B framings for the review picker (static metadata; safe to cache)
    if (req.method === "GET" && url.pathname === "/api/variants") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "max-age=300" });
      return res.end(JSON.stringify({ ok: true, variants: variantMeta() }));
    }
    // A/B: run one core (review comments, or a raw prompt) through N framings
    if (req.method === "POST" && url.pathname === "/api/ab") {
      const body = await readBody(req);
      let payload; try { payload = JSON.parse(body || "{}"); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
      const t = findTask(String(payload.taskId || ""));
      if (!t) return json(res, 404, { ok: false, error: "no such task" });
      if (!t.session || !existsSync(t.session)) return json(res, 400, { ok: false, error: "task has no associated session" });
      if (running.has(t.id)) return json(res, 409, { ok: false, error: "a session is already running for this task" });
      let variants = (Array.isArray(payload.variants) ? payload.variants : []).map(String).filter((v) => VARIANT_IDS.has(v));
      variants = [...new Set(variants)].slice(0, 4);
      if (!variants.length) variants = VARIANTS.map((v) => v.id);
      const comments = Array.isArray(payload.comments) ? payload.comments : [];
      let core;
      if (comments.length) core = commentBlock(comments);
      else if (typeof payload.prompt === "string" && payload.prompt.trim()) core = payload.prompt.trim();
      else core = freshPrompt(t, true);
      // fire-and-forget: arms run serialized in the background; the page polls
      // artifacts and renders each response as it lands.
      runAB(t.id, { variants, core, compact: !!payload.compact }).catch(() => {});
      return json(res, 200, { ok: true, variants, ...snapshot() });
    }
    if (req.method === "GET" && /^\/task\/t_[a-z0-9]+$/.test(url.pathname)) return send(res, 200, "text/html; charset=utf-8", DETAIL);
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/task\/(t_[a-z0-9]+)$/))) {
      const t = findTask(m[1]);
      return t ? json(res, 200, { rev: readAllEvents().length, running: running.has(t.id), task: t }) : json(res, 404, { ok: false, error: "no such task" });
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/artifact\/(t_[a-z0-9]+)\/(a_[a-z0-9]+)$/))) return serveArtifact(req, res, m[1], m[2]);
    if (url.pathname === "/favicon.ico") return send(res, 204, "text/plain", "");
    return json(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`todo board on http://${HOST}:${PORT}  (dir: ${root()})`);
  console.log(`tunnel:  ssh -L ${PORT}:localhost:${PORT} <this-box>  ->  http://localhost:${PORT}`);
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    console.error(`[board] port ${PORT} is already in use — another process holds ${HOST}:${PORT}.`);
    console.error(`[board] free it, or set TODO_BOARD_PORT to a different port and restart.`);
    process.exit(3);
  }
  console.error("[board] server error:", err && err.message || err);
  process.exit(1);
});

// ---- the page: client-side render from /api/board, edits POST to /api/edit ----
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>todo board</title>
<style>
  :root{
    color-scheme:dark;
    --bg:#100F0F; --bg2:#1C1B1A; --ui:#282726; --ui2:#343331; --ui3:#403E3C;
    --tx:#CECDC3; --tx2:#878580; --tx3:#575653; --hi:#E6E4D9;
    --re:#D14D41; --or:#DA702C; --ye:#D0A215; --gr:#879A39; --cy:#3AA99F; --bl:#4385BE; --pu:#8B7EC8; --ma:#CE5D97;
  }
  *{box-sizing:border-box}
  html,body{background:var(--bg);color:var(--tx);margin:0;font:14.5px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-feature-settings:"tnum" 1;-webkit-font-smoothing:antialiased}
  a{color:var(--bl);text-decoration:none}a:hover{text-decoration:underline}
  header{position:sticky;top:0;z-index:6;background:#100F0Fe6;backdrop-filter:blur(8px);border-bottom:1px solid var(--ui2);padding:12px 22px;display:flex;align-items:center;gap:11px}
  header .mark{width:22px;height:22px;border-radius:7px;background:linear-gradient(135deg,var(--bl),var(--pu));box-shadow:0 0 14px #4385be55}
  header h1{font-size:15px;margin:0;font-weight:650;letter-spacing:.01em;color:var(--hi)}
  header .dot{margin-left:auto;color:var(--gr);font-size:10px;transition:opacity .3s}
  main{max-width:1080px;margin:0 auto;padding:20px 22px 130px}
  /* hero metric strip */
  .hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:2px 0 8px}
  .stat{position:relative;overflow:hidden;background:var(--bg2);border:1px solid var(--ui2);border-radius:14px;padding:15px 17px}
  .stat .accent{position:absolute;left:0;top:0;bottom:0;width:3px}
  .stat .num{font-size:30px;font-weight:700;line-height:1;color:var(--hi);font-variant-numeric:tabular-nums}
  .stat .lbl{margin-top:8px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--tx2)}
  .stat.run .accent{background:var(--ye)}.stat.run .num{color:var(--ye)}
  .stat.sess .accent{background:var(--bl)}
  .stat.road .accent{background:var(--pu)}
  .stat.done .accent{background:var(--gr)}
  /* section header */
  .sec{display:flex;align-items:baseline;gap:10px;margin:32px 0 15px}
  .sec h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;margin:0;color:var(--hi);font-weight:650}
  .sec .c{font-size:12px;color:var(--tx3);font-variant-numeric:tabular-nums}
  .sec .desc{margin-left:auto;font-size:12px;color:var(--tx3)}
  .muted{color:var(--tx3);font-size:13px;padding:14px 2px}
  /* session card grid */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(312px,1fr));gap:14px}
  .card{display:flex;flex-direction:column;gap:9px;background:var(--bg2);border:1px solid var(--ui2);border-radius:14px;padding:14px 15px;transition:border-color .15s}
  .card:hover{border-color:var(--ui3)}
  .card.running{border-color:var(--ye);box-shadow:0 0 0 1px #d0a21533}
  .card.intr{border-color:var(--or);box-shadow:0 0 0 1px #da702c33}
  .ibadge{font-size:10px;font-weight:700;letter-spacing:.03em;color:var(--or);border:1px solid var(--or);border-radius:9px;padding:2px 8px;background:#da702c1a;white-space:nowrap}
  .ctop{display:flex;align-items:center;gap:8px}
  .ctop .sp,.cfoot .sp,.ractions .sp{margin-left:auto}
  .pill,select.st{font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:2px 9px;border-radius:9px;border:1px solid var(--ui3);font-weight:600;background:var(--bg2);color:var(--tx);cursor:pointer}
  select.st{-webkit-appearance:none;appearance:none;padding-right:9px}
  .pill.st-todo,select.st.st-todo{color:var(--tx)}
  .pill.st-doing,select.st.st-doing{color:var(--bl);border-color:var(--bl)}
  .pill.st-blocked,select.st.st-blocked{color:var(--re);border-color:var(--re)}
  .pill.st-done,select.st.st-done{color:var(--gr);border-color:var(--gr)}
  .pill.st-dropped,select.st.st-dropped{color:var(--tx3)}
  .spin{color:var(--ye);display:inline-block;animation:sp 1s linear infinite}
  @keyframes sp{to{transform:rotate(360deg)}}
  .pchip{font-size:10px;color:var(--tx2);border:1px solid var(--ui3);border-radius:7px;padding:1px 6px;font-variant-numeric:tabular-nums}
  .pchip.p0{color:var(--re);border-color:var(--re)}.pchip.p1{color:var(--or);border-color:var(--or)}
  .card .title,.ritem .title{font-size:15px;font-weight:600;color:var(--hi);outline:none;line-height:1.35;cursor:text;word-break:break-word}
  .card .title:focus,.ritem .title:focus{background:var(--ui);border-radius:6px;box-shadow:0 0 0 1px var(--bl)}
  .card.dn .title{opacity:.55;text-decoration:line-through}
  .sub{font:11.5px/1.4 ui-monospace,Menlo,monospace;color:var(--tx3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cfoot,.ractions{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
  button.b{background:var(--ui);color:var(--tx);border:1px solid var(--ui3);border-radius:8px;padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer}
  button.b:hover{border-color:var(--tx3)}
  button.b.go{background:var(--gr);color:#100F0F;border-color:transparent}
  button.b.res{background:var(--bl);color:#100F0F;border-color:transparent}
  button.b.go:hover,button.b.res:hover{filter:brightness(1.08)}
  button.b:disabled{opacity:.5;cursor:default}
  button.icon{background:transparent;border:0;color:var(--tx3);cursor:pointer;font-size:14px;padding:2px 6px;border-radius:6px}
  button.icon:hover{color:var(--re)}
  .card .exp,.ritem .exp{display:none;flex-direction:column;gap:8px;border-top:1px solid var(--ui2);padding-top:10px;margin-top:2px}
  .card.open-exp .exp,.ritem.open-exp .exp{display:flex}
  .exp .fl{font-size:11px;color:var(--tx2);display:flex;gap:7px;align-items:center}
  .card select,.card input,.card textarea,.ritem select,.ritem input,.ritem textarea{background:var(--bg);color:var(--tx);border:1px solid var(--ui2);border-radius:7px;padding:5px 8px;font:inherit;font-size:12.5px}
  .card textarea,.ritem textarea{resize:vertical;min-height:46px;width:100%}
  .prio{width:64px}.own{width:100%}
  /* roadmap timeline */
  .add{display:flex;gap:8px;margin:0 0 18px}
  .add input{flex:1;background:var(--bg2);color:var(--tx);border:1px solid var(--ui2);border-radius:9px;padding:9px 12px;font:inherit}
  .add input:focus{outline:none;border-color:var(--pu)}
  .add select{width:66px;background:var(--bg2);color:var(--tx);border:1px solid var(--ui2);border-radius:9px;padding:0 8px}
  .add button{background:var(--pu);color:#100F0F;border:0;border-radius:9px;padding:0 16px;font-weight:700;cursor:pointer}
  .road{position:relative;padding-left:26px}
  .road:before{content:"";position:absolute;left:7px;top:8px;bottom:8px;width:2px;background:var(--ui2)}
  .ritem{position:relative;display:flex;gap:11px;align-items:flex-start;background:var(--bg2);border:1px solid var(--ui2);border-radius:12px;padding:11px 14px;margin:0 0 11px}
  .ritem:hover{border-color:var(--ui3)}
  .ritem:before{content:"";position:absolute;left:-23px;top:16px;width:10px;height:10px;border-radius:50%;background:var(--pu);box-shadow:0 0 0 3px var(--bg)}
  .ritem.p0:before{background:var(--re)}.ritem.p1:before{background:var(--or)}
  .rbody{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px}
  /* done / dropped */
  details#donebox{margin-top:30px}
  details#donebox>summary{cursor:pointer;color:var(--tx2);font-size:12px;list-style:none;padding:6px 0}
  details#donebox>summary:hover{color:var(--tx)}
  .drow{display:flex;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid var(--ui2)}
  .drow .title{font-size:13.5px;font-weight:500;flex:1}
  .drow a.open{font-size:12px;color:var(--bl);cursor:pointer}
  /* overlay */
  #ov{position:fixed;inset:0;background:#000a;display:none;z-index:10}
  #ov.on{display:block}
  #ovbox{position:absolute;inset:4vh 4vw;background:var(--bg);border:1px solid var(--ui2);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;box-shadow:0 20px 60px #000a}
  #ovbar{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--ui2);background:var(--bg2);font-size:13px;color:var(--hi)}
  #ovbar a{color:var(--bl)}
  #ovx{margin-left:auto;cursor:pointer;color:var(--tx);border:1px solid var(--ui3);border-radius:8px;padding:4px 12px;background:var(--ui)}
  #ovx:hover{color:var(--re)}
  #ovframe{flex:1;border:0;width:100%;background:var(--bg)}
  .card.kfoc,.ritem.kfoc{outline:2px solid var(--bl);outline-offset:2px}
  .khint{margin-left:8px;color:var(--tx3);font-size:12px;cursor:pointer}
  #kh{position:fixed;inset:0;background:#000a;z-index:30;display:none;align-items:center;justify-content:center}
  #kh.on{display:flex}
  #kh .box{background:var(--bg2);border:1px solid var(--ui2);border-radius:12px;padding:18px 22px;box-shadow:0 12px 40px #000c}
  #kh h3{margin:0 0 12px;color:var(--hi);font-size:14px}
  #kh table{border-collapse:collapse;font-size:13px}
  #kh td{padding:4px 12px 4px 0;color:var(--tx);vertical-align:top}
  #kh kbd{background:var(--ui);border:1px solid var(--ui3);border-bottom-width:2px;border-radius:6px;padding:1px 7px;font:12px ui-monospace,Menlo,monospace;color:var(--hi)}
</style></head><body>
<header>
  <span class="mark"></span>
  <h1>todo board</h1>
  <span class="dot" id="dot" title="live">&#9679;</span>
  <span class="khint" id="khbtn" title="keyboard shortcuts">? keys</span>
</header>
<main>
  <section class="hero">
    <div class="stat run"><span class="accent"></span><div class="num" id="h-run">0</div><div class="lbl">Running now</div></div>
    <div class="stat sess"><span class="accent"></span><div class="num" id="h-sess">0</div><div class="lbl">Sessions</div></div>
    <div class="stat road"><span class="accent"></span><div class="num" id="h-road">0</div><div class="lbl">Roadmap</div></div>
    <div class="stat done"><span class="accent"></span><div class="num" id="h-done">0</div><div class="lbl">Done</div></div>
  </section>

  <div class="sec"><h2>Current sessions</h2><span class="c" id="sesscount">0</span><span class="desc">live &amp; imported omp agent work &mdash; click a card to review</span></div>
  <div class="grid" id="sesswrap"></div>

  <div class="sec"><h2>Roadmap</h2><span class="c" id="roadcount">0</span><span class="desc">future work &mdash; hit &#9654; to spin up a session</span></div>
  <div class="add">
    <input id="addt" placeholder="add to roadmap and press Enter" autocomplete="off">
    <select id="addp" title="priority"><option value="0">p0</option><option value="1">p1</option><option value="2" selected>p2</option><option value="3">p3</option></select>
    <button id="addb">Add</button>
  </div>
  <div class="road" id="roadwrap"></div>
  <div class="muted" id="roadempty" hidden>Roadmap is clear. Add future work above.</div>

  <details id="donebox"><summary></summary><div id="donewrap"></div></details>
  <div class="muted" id="empty" hidden>Nothing yet. Add a roadmap item above, or a session appends via append.mjs.</div>
</main>
<div id="ov"><div id="ovbox"><div id="ovbar"><span id="ovtitle">task</span><a id="ovnew" href="#" target="_blank">open in tab &#8599;</a><button id="ovx">close &#10005;</button></div><iframe id="ovframe"></iframe></div></div>
<div id="kh"><div class="box">
  <h3>keyboard</h3>
  <table>
    <tr><td><kbd>j</kbd> <kbd>k</kbd></td><td>next / previous item</td></tr>
    <tr><td><kbd>o</kbd> / <kbd>&#8617;</kbd></td><td>open focused item</td></tr>
    <tr><td><kbd>r</kbd></td><td>run / resume focused</td></tr>
    <tr><td><kbd>esc</kbd></td><td>close overlay / help</td></tr>
    <tr><td><kbd>?</kbd></td><td>toggle this help</td></tr>
  </table>
</div></div>
<script>
const STATUSES = ${JSON.stringify(STATUSES)};
const RANK = Object.fromEntries(STATUSES.map((s,i)=>[s,i]));
let rev = -1, focusHold = false, SPAWNING = new Set(), lastSpawnKey = "";

async function post(edits){
  const r = await fetch('/api/edit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({edits})});
  const d = await r.json(); if(d && d.board){ rev = d.rev; SPAWNING = new Set(d.spawning||[]); paint(d.board); } return d;
}
function edit(e){ return post([e]); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function isSess(t){ return !!t.session || t.status==='doing' || SPAWNING.has(t.id) || (t.artifacts&&t.artifacts.length>0); }
function sidOf(t){ var s=String(t.session||t.origin_session||''); s=s.split('/').pop(); return s.length>36? s.slice(0,16)+'\\u2026'+s.slice(-15): s; }
function stSel(t){ return '<select class="st st-'+t.status+'" title="status">'+STATUSES.map(function(s){return '<option '+(s===t.status?'selected':'')+' value="'+s+'">'+s+'</option>';}).join('')+'</select>'; }
function prioSel(t){ return '<select class="prio" title="priority">'+[0,1,2,3].map(function(p){return '<option '+(p===t.priority?'selected':'')+' value="'+p+'">p'+p+'</option>';}).join('')+'</select>'; }

function sessCard(t){
  var run=SPAWNING.has(t.id), dn=(t.status==='done'||t.status==='dropped');
  var nart=(t.artifacts&&t.artifacts.length)||0;
  var intr=(t.interrupted&&!run);
  return '<article class="card'+(run?' running':'')+(intr?' intr':'')+(dn?' dn':'')+'" data-id="'+t.id+'">'
    + '<div class="ctop">'+stSel(t)
      + (run?'<span class="spin" title="running">&#10227;</span>':'')
      + (intr?'<span class="ibadge" title="idle-cap interrupted; still resumable">&#9208; interrupted</span>':'')
      + '<span class="pchip p'+t.priority+'">p'+t.priority+'</span>'
      + '<span class="sp"></span>'
      + '<button class="icon drop" title="drop">&#215;</button></div>'
    + '<div class="title" contenteditable="plaintext-only">'+esc(t.title)+'</div>'
    + '<div class="sub" title="'+esc(t.session||t.origin_session||'')+'">'+ (sidOf(t)||'&mdash;') + (nart?'  &#183; '+nart+' &#9633;':'') + '</div>'
    + '<div class="cfoot">'
      + (run?'<button class="b res" disabled>running&#8230;</button>':'<button class="b res run">&#9654; resume</button>')
      + '<button class="b open" data-open="'+t.id+'">open &#8599;</button>'
      + '<span class="sp"></span>'
      + '<button class="icon more" title="details">&#9776;</button></div>'
    + '<div class="exp">'
      + '<label class="fl">priority '+prioSel(t)+'</label>'
      + '<input class="own" value="'+esc(t.owner)+'" placeholder="owner">'
      + '<textarea class="notes" placeholder="notes">'+esc(t.notes)+'</textarea></div>'
    + '</article>';
}
function roadItem(t){
  return '<div class="ritem p'+t.priority+'" data-id="'+t.id+'">'
    + '<span class="pchip p'+t.priority+'">p'+t.priority+'</span>'
    + '<div class="rbody">'
      + '<div class="title" contenteditable="plaintext-only">'+esc(t.title)+'</div>'
      + '<div class="ractions">'
        + '<button class="b go run">&#9654; start session</button>'
        + '<button class="b open" data-open="'+t.id+'">open</button>'
        + '<button class="b more">notes</button>'
        + '<span class="sp"></span>'+stSel(t)
        + '<button class="icon drop" title="drop">&#215;</button></div>'
      + '<div class="exp"><label class="fl">priority '+prioSel(t)+'</label><textarea class="notes" placeholder="notes">'+esc(t.notes)+'</textarea></div>'
    + '</div></div>';
}
function doneRow(t){
  return '<div class="drow" data-id="'+t.id+'"><span class="pill st-'+t.status+'">'+t.status+'</span>'
    + '<span class="title" contenteditable="plaintext-only">'+esc(t.title)+'</span>'
    + '<a class="open" data-open="'+t.id+'">open</a>'
    + '<button class="icon drop" title="delete">&#215;</button></div>';
}
function setNum(id,n){ var e=document.getElementById(id); if(e) e.textContent=n; }

function paint(board){
  var tasks=board.tasks.slice();
  var live=tasks.filter(function(t){return t.status!=='done'&&t.status!=='dropped';});
  var done=tasks.filter(function(t){return t.status==='done'||t.status==='dropped';});
  var sessions=live.filter(isSess);
  var road=live.filter(function(t){return !isSess(t);});
  sessions.sort(function(a,b){ return (SPAWNING.has(b.id)-SPAWNING.has(a.id)) || (RANK[a.status]-RANK[b.status]) || (b.priority-a.priority) || (a.order-b.order); });
  road.sort(function(a,b){ return (a.priority-b.priority) || (a.order-b.order); });
  done.sort(function(a,b){ return (b.updated<a.updated?-1:b.updated>a.updated?1:0); });

  var running=sessions.filter(function(t){return SPAWNING.has(t.id);}).length;
  setNum('h-run',running); setNum('h-sess',sessions.length); setNum('h-road',road.length); setNum('h-done',done.length);
  setNum('sesscount',sessions.length); setNum('roadcount',road.length);

  document.getElementById('sesswrap').innerHTML = sessions.length? sessions.map(sessCard).join('')
    : '<div class="muted">No active sessions. Start one from the roadmap, or append via a session hook.</div>';
  document.getElementById('roadwrap').innerHTML = road.map(roadItem).join('');
  document.getElementById('roadempty').hidden = road.length!==0;
  document.getElementById('donewrap').innerHTML = done.map(doneRow).join('');
  document.getElementById('donebox').hidden = done.length===0;
  document.querySelector('#donebox>summary').textContent='Done / dropped ('+done.length+')';
  document.getElementById('empty').hidden = tasks.length!==0;
  applyKfoc();
}

function idOf(el){ var n=el.closest('[data-id]'); return n&&n.getAttribute('data-id'); }
document.addEventListener('change', function(ev){
  var el=ev.target, id=idOf(el); if(!id) return;
  if(el.classList.contains('st')) edit({op:'update',id,status:el.value});
  else if(el.classList.contains('prio')) edit({op:'update',id,priority:Number(el.value)});
});
document.addEventListener('blur', function(ev){
  var el=ev.target, id=idOf(el); if(!id) return;
  if(el.classList.contains('own')) edit({op:'update',id,owner:el.value.trim()});
  else if(el.classList.contains('notes')) edit({op:'note',id,text:el.value});
  else if(el.classList.contains('title')) edit({op:'update',id,title:el.textContent.trim()});
}, true);
document.addEventListener('click', function(ev){
  var t=ev.target;
  if(t.classList.contains('more')){ var c=t.closest('.card,.ritem'); if(c) c.classList.toggle('open-exp'); return; }
  if(t.classList.contains('drop')){ var id=idOf(t); if(id) edit({op:'drop',id}); return; }
  if(t.classList.contains('run')){ var id2=idOf(t); var node=t.closest('[data-id]'); var ttl=node&&node.querySelector('.title')?node.querySelector('.title').textContent:id2; if(id2) runTask(id2,ttl); return; }
  if(t.classList.contains('open')){ ev.preventDefault(); var id3=t.getAttribute('data-open'); if(id3) openOverlay(id3); return; }
});

function openOverlay(id){
  document.getElementById('ovframe').src='/task/'+id;
  document.getElementById('ovnew').href='/task/'+id;
  document.getElementById('ovtitle').textContent='task '+id;
  document.getElementById('ov').classList.add('on');
}
function closeOverlay(){
  document.getElementById('ov').classList.remove('on');
  document.getElementById('ovframe').src='about:blank';
}
document.getElementById('ovx').onclick=closeOverlay;
document.getElementById('ov').addEventListener('click', function(e){ if(e.target.id==='ov') closeOverlay(); });
var kid = null;
function navEls(){ return Array.prototype.slice.call(document.querySelectorAll('#sesswrap [data-id], #roadwrap [data-id]')); }
function applyKfoc(){ var f=document.querySelectorAll('.kfoc'); for(var n=0;n<f.length;n++) f[n].classList.remove('kfoc'); if(kid){ var el=document.querySelector('[data-id="'+kid+'"]'); if(el) el.classList.add('kfoc'); else kid=null; } }
function moveFoc(d){ var els=navEls(); if(!els.length) return; var idx=-1; for(var n=0;n<els.length;n++){ if(els[n].getAttribute('data-id')===kid){ idx=n; break; } } idx = idx<0 ? (d>0?0:els.length-1) : Math.max(0,Math.min(els.length-1, idx+d)); kid=els[idx].getAttribute('data-id'); applyKfoc(); els[idx].scrollIntoView({block:'nearest'}); }
document.getElementById('khbtn').onclick=function(){ document.getElementById('kh').classList.toggle('on'); };
document.getElementById('kh').addEventListener('click', function(){ this.classList.remove('on'); });
document.addEventListener('keydown', function(e){
  if(e.key==='Escape'){ document.getElementById('kh').classList.remove('on'); closeOverlay(); return; }
  var ae=document.activeElement;
  if(ae && (ae.matches('input,textarea,select') || ae.isContentEditable)) return;
  if(document.getElementById('ov').classList.contains('on')) return;
  if(e.metaKey||e.ctrlKey||e.altKey) return;
  if(e.key==='j'||e.key==='ArrowDown'){ e.preventDefault(); moveFoc(1); }
  else if(e.key==='k'||e.key==='ArrowUp'){ e.preventDefault(); moveFoc(-1); }
  else if(e.key==='o'||e.key==='Enter'){ if(kid){ e.preventDefault(); openOverlay(kid); } }
  else if(e.key==='r'){ if(kid){ var el=document.querySelector('[data-id="'+kid+'"]'); var ttl=el&&el.querySelector('.title')?el.querySelector('.title').textContent:kid; e.preventDefault(); runTask(kid,ttl); } }
  else if(e.key==='?'){ e.preventDefault(); document.getElementById('kh').classList.toggle('on'); }
});

async function runTask(id, title){
  if(!confirm('Run an omp session for:\\n\\n'+title+'\\n\\nThis spends tokens and runs autonomously. Continue?')) return;
  try{
    var r=await fetch('/api/spawn',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:id})});
    var d=await r.json();
    if(!d.ok) alert('Cannot run: '+(d.error||('HTTP '+r.status)));
    if(d.board){ rev=d.rev; SPAWNING=new Set(d.spawning||[]); paint(d.board); }
  }catch(e){ alert('spawn request failed: '+e.message); }
}

document.addEventListener('focusin', function(e){ if(e.target.matches('input,textarea,select,[contenteditable]')) focusHold=true; });
document.addEventListener('focusout', function(){ setTimeout(function(){ focusHold=!!document.querySelector('input:focus,textarea:focus,select:focus,[contenteditable]:focus'); },0); });

function addTask(){
  var i=document.getElementById('addt'); var title=i.value.trim(); if(!title) return;
  var priority=Number(document.getElementById('addp').value);
  i.value=''; edit({op:'add',title,priority});
}
document.getElementById('addb').onclick=addTask;
document.getElementById('addt').addEventListener('keydown', function(e){ if(e.key==='Enter') addTask(); });

async function poll(){
  try{
    var d=await (await fetch('/api/board')).json();
    document.getElementById('dot').style.opacity=1;
    var sk=(d.spawning||[]).join(',');
    if((d.rev!==rev || sk!==lastSpawnKey) && !focusHold){ rev=d.rev; lastSpawnKey=sk; SPAWNING=new Set(d.spawning||[]); paint(d.board); }
    setTimeout(function(){document.getElementById('dot').style.opacity=.5;},150);
  }catch(e){ document.getElementById('dot').style.opacity=.2; }
  setTimeout(poll,1500);
}
poll();
</script></body></html>`;

// ---- per-task detail page: header + append-only artifact timeline ----
const DETAIL = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>task</title>
<style>
  :root{
    color-scheme:dark;
    /* Flexoki dark — kepano / stephango.com/flexoki */
    --bg:#100F0F; --bg2:#1C1B1A; --ui:#282726; --ui2:#343331; --ui3:#403E3C;
    --tx:#CECDC3; --tx2:#878580; --tx3:#575653; --hi:#E6E4D9;
    --re:#D14D41; --or:#DA702C; --ye:#D0A215; --gr:#879A39; --cy:#3AA99F; --bl:#4385BE; --pu:#8B7EC8; --ma:#CE5D97;
  }
  html,body{background:var(--bg);color:var(--tx);margin:0;font:15.5px/1.7 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  a{color:var(--bl);text-decoration:none}a:hover{text-decoration:underline}
  header{position:sticky;top:0;background:#100F0Fee;backdrop-filter:blur(6px);border-bottom:1px solid var(--ui2);padding:11px 16px;z-index:5}
  .crumb{color:var(--tx2);font-size:12px}
  h1{font-size:19px;margin:5px 0 4px;color:var(--hi)}
  .meta{color:var(--tx2);font-size:12px;display:flex;gap:14px;flex-wrap:wrap;align-items:center}
  .badge{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;border:1px solid var(--ui3)}
  .st-todo{color:var(--tx)}.st-doing{color:var(--bl);border-color:var(--bl)}.st-blocked{color:var(--re);border-color:var(--re)}.st-done{color:var(--gr);border-color:var(--gr)}.st-dropped{color:var(--tx3)}
  .run{color:var(--ye);border-color:var(--ye)}
  .badge.intr{color:var(--or);border-color:var(--or)}
  main{padding:16px 20px 140px;max-width:920px;margin:0 auto}
  .notes{white-space:pre-wrap;background:var(--bg2);border:1px solid var(--ui2);border-left:3px solid var(--ye);border-radius:8px;padding:9px 12px;margin:10px 0;color:var(--tx)}
  .logbox{margin:10px 0;border-left:2px solid var(--ui2);padding-left:11px}
  .logline{color:var(--tx2);font:12px/1.55 ui-monospace,Menlo,monospace}.logline .lt{color:var(--tx3);margin-right:8px}
  h2.sec{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--tx2);margin:26px 0 12px;border-bottom:1px solid var(--ui2);padding-bottom:6px}
  h2.sec .hint{text-transform:none;letter-spacing:0;font-weight:400;color:var(--tx3);margin-left:8px}
  /* transcript: reads like a document, not a log */
  .turn{margin:22px 0;position:relative}
  .turn>.rh{display:flex;gap:9px;align-items:center;margin:0 0 6px 2px}
  .role{font-size:10px;text-transform:uppercase;letter-spacing:.07em;padding:2px 9px;border-radius:9px;border:1px solid var(--ui3);font-weight:600}
  .role.user{color:var(--bl);border-color:var(--bl)}.role.assistant{color:var(--pu);border-color:var(--pu)}.role.toolResult{color:var(--gr);border-color:var(--gr)}.role.err{color:var(--re);border-color:var(--re)}
  .ts{color:var(--tx3);font-size:11px}.rh .sp{margin-left:auto}
  .cbtn{cursor:pointer;font-size:11px;color:var(--tx2);border:1px solid var(--ui3);border-radius:8px;padding:2px 10px;background:var(--ui)}
  .cbtn:hover{color:var(--tx)}.cbtn.on{color:var(--or);border-color:var(--or)}
  .turn .bd{padding:15px 20px;border:1px solid var(--ui2);border-radius:12px;background:var(--bg2)}
  .turn.user .bd{border-left:3px solid var(--bl)}
  .turn.assistant .bd{border-left:3px solid var(--pu)}
  .turn.toolResult .bd{border-left:3px solid var(--gr)}
  .turn.hascmt .bd{box-shadow:inset 3px 0 0 var(--or)}
  /* tool output collapses to a thin expandable line: the thread stays prompts
     + responses + notes + figures. Expand any result, or toggle all with 't'. */
  .turn.tr{margin:9px 0}
  .turn.tr .bd{padding:0;border:0;background:none}
  details.tres{border:1px solid var(--ui2);border-radius:9px;background:var(--bg2);overflow:hidden}
  details.tres>summary{cursor:pointer;list-style:none;padding:6px 12px;color:var(--tx3);font:11.5px/1.4 ui-monospace,Menlo,monospace;display:flex;gap:8px;align-items:center}
  details.tres>summary::-webkit-details-marker{display:none}
  details.tres>summary:hover{color:var(--tx2)}
  details.tres[open]>summary{color:var(--tx2);border-bottom:1px solid var(--ui2)}
  details.tres .tsz{color:var(--tx3);margin-left:auto}
  details.tres>pre.tx,details.tres>.args,details.tres>.prose{margin:0;padding:12px}
  /* inline figures (image artifacts) rendered in the thread */
  .figs{display:flex;flex-wrap:wrap;gap:12px;margin:12px 0 4px}
  .fig{margin:0;border:1px solid var(--ui2);border-radius:10px;overflow:hidden;background:var(--bg);max-width:100%}
  .fig.broken{display:none}
  .fig img{display:block;max-width:440px;max-height:340px;width:auto;height:auto;cursor:zoom-in;background:#fff}
  .fig figcaption{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;color:var(--tx2);border-top:1px solid var(--ui2)}
  .fig .fcap{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,Menlo,monospace}
  .fig .figc{margin-left:auto;background:var(--ui);border:1px solid var(--ui3);color:var(--tx2);border-radius:7px;padding:2px 8px;font-size:11px;cursor:pointer;white-space:nowrap}
  .fig .figc:hover{color:var(--or);border-color:var(--or)}
  #lb{position:fixed;inset:0;background:#000d;z-index:40;display:none;align-items:center;justify-content:center;cursor:zoom-out}
  #lb.on{display:flex}
  #lb img{max-width:94vw;max-height:94vh;box-shadow:0 8px 40px #000}
  /* prose (markdown) */
  .prose{color:var(--tx)}
  .prose>*:first-child{margin-top:0}.prose>*:last-child{margin-bottom:0}
  .prose p{margin:13px 0}
  .prose h1,.prose h2,.prose h3,.prose h4,.prose h5,.prose h6{margin:20px 0 10px;line-height:1.3;font-weight:600;color:var(--hi)}
  .prose h1.mdh{font-size:21px;border-bottom:1px solid var(--ui2);padding-bottom:6px}
  .prose h2.mdh{font-size:18px;border-bottom:1px solid var(--ui2);padding-bottom:5px;text-transform:none;letter-spacing:0}
  .prose h3.mdh{font-size:16px;color:var(--or)}.prose h4.mdh,.prose h5.mdh,.prose h6.mdh{font-size:14.5px;color:var(--tx)}
  .prose ul,.prose ol{margin:10px 0;padding-left:24px}.prose li{margin:4px 0}
  .prose li::marker{color:var(--tx3)}
  .prose li>ul,.prose li>ol{margin:3px 0 3px}
  .prose li>p{margin:4px 0}
  .prose code{background:var(--ui);border:1px solid var(--ui2);border-radius:5px;padding:.5px 5px;font:13px/1.4 ui-monospace,Menlo,monospace;color:var(--hi)}
  .prose pre.code{background:var(--ui);border:1px solid var(--ui2);border-radius:10px;padding:13px 15px;overflow:auto;margin:12px 0}
  .prose pre.code code{background:none;border:0;padding:0;font-size:13px;color:var(--tx);white-space:pre}
  .prose blockquote{margin:12px 0;padding:3px 14px;border-left:3px solid var(--ui3);color:var(--tx2)}
  .prose a{color:var(--bl)}
  .prose table{border-collapse:collapse;margin:14px 0;font-size:13.5px;display:block;overflow:auto;max-width:100%}
  .prose th,.prose td{border:1px solid var(--ui2);padding:7px 12px;text-align:left;vertical-align:top}
  .prose th{background:var(--ui);font-weight:600;color:var(--hi);white-space:nowrap}
  .prose tbody tr:nth-child(even) td{background:var(--bg)}
  .prose strong{color:var(--hi)}
  .prose em{color:var(--tx)}
  /* collapsibles for reasoning / tool traffic — kept out of the way */
  details.think,details.tool{margin:9px 0;border-radius:8px;background:var(--bg);border:1px solid var(--ui2)}
  details.think>summary,details.tool>summary{cursor:pointer;padding:6px 11px;font-size:11px;list-style:none}
  details.think>summary{color:var(--pu);text-transform:uppercase;letter-spacing:.05em}
  details.tool>summary{color:var(--cy);font:12px ui-monospace,Menlo,monospace}
  details.tool .intent{color:var(--tx3)}
  details[open]>summary{border-bottom:1px solid var(--ui2);margin-bottom:2px}
  details.think .prose{padding:5px 13px 11px;color:var(--tx2);font-size:14px}
  pre.tx{margin:0;white-space:pre-wrap;word-break:break-word;font:13px/1.6 ui-monospace,Menlo,monospace;color:var(--tx2)}
  pre.args{margin:0;padding:7px 13px 11px;color:var(--tx2);font:12px/1.5 ui-monospace,Menlo,monospace;max-height:240px;overflow:auto;white-space:pre-wrap}
  /* comment boxes */
  textarea.cmt{display:none;width:100%;box-sizing:border-box;margin:9px 0 2px;background:var(--bg);border:1px solid var(--or);border-radius:8px;color:var(--ye);font:13.5px/1.55 ui-sans-serif,system-ui,sans-serif;padding:8px 10px;resize:vertical;min-height:54px}
  textarea.cmt.show{display:block}
  textarea.cmt::placeholder{color:var(--tx3)}
  .qc{margin:9px 0 4px;border-left:3px solid var(--or);background:#1a1512;border-radius:0 8px 8px 0;padding:8px 11px}
  .qc .qtxt{color:var(--ye);font-style:italic;border-left:2px solid var(--or);padding-left:10px;margin:0 0 4px;font-size:13px;white-space:pre-wrap}
  .qc textarea.cmt{margin-top:4px}
  .qcx{cursor:pointer;font-size:11px;color:var(--tx2)}.qcx:hover{color:var(--re)}
  /* floating selection button */
  #selbtn{position:fixed;display:none;z-index:20;background:var(--or);color:#100F0F;border:0;border-radius:9px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 3px 12px #000c}
  /* review bar */
  #bar{position:fixed;left:0;right:0;bottom:0;background:#1C1B1Afa;border-top:1px solid var(--ui2);padding:10px 16px;display:none;gap:14px;align-items:center;z-index:8}
  #bar.show{display:flex}
  #bar .n{font-weight:600;color:var(--hi)}#bar .est{color:var(--tx2);font-size:12px}
  #bar label{color:var(--tx);font-size:12px;display:flex;gap:5px;align-items:center;cursor:pointer}
  #bar .sp{margin-left:auto}
  button.send{background:var(--gr);color:#100F0F;border:0;border-radius:8px;padding:8px 15px;font-size:13px;font-weight:700;cursor:pointer}
  button.send:disabled{opacity:.5;cursor:default}
  #barmsg{color:var(--ye);font-size:12px}
  /* import */
  #imp{border:1px dashed var(--ui3);border-radius:10px;padding:15px;color:var(--tx2)}
  #imp input{width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--ui2);border-radius:8px;color:var(--tx);padding:8px 10px;font:12px ui-monospace,Menlo,monospace;margin:9px 0}
  #imp button{background:var(--bl);color:#100F0F;border:0;border-radius:8px;padding:7px 13px;font-weight:600;cursor:pointer}
  /* captured-responses modal */
  #capbtn{position:fixed;left:16px;bottom:14px;z-index:7;background:var(--ui);border:1px solid var(--ui3);color:var(--tx2);border-radius:20px;padding:7px 14px;font-size:12px;cursor:pointer}
  #capbtn:hover{color:var(--tx);border-color:var(--tx3)}
  dialog#artdlg{background:var(--bg2);color:var(--tx);border:1px solid var(--ui2);border-radius:12px;max-width:900px;width:92vw;max-height:86vh;padding:0;overflow:hidden}
  dialog#artdlg::backdrop{background:#000c}
  #artdlg .dlgh{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--ui2);position:sticky;top:0;background:var(--bg2);color:var(--hi)}
  #artdlg .dlgh .sp{margin-left:auto}
  #artdlg #artclose{background:var(--ui);border:1px solid var(--ui3);color:var(--tx);border-radius:8px;padding:5px 13px;cursor:pointer}
  #artdlg #arts{padding:15px;overflow:auto;max-height:calc(86vh - 54px)}
  .art{border:1px solid var(--ui2);border-radius:10px;margin:0 0 12px;overflow:hidden;background:var(--bg)}
  .art>.h{display:flex;gap:10px;align-items:center;padding:9px 13px;background:var(--ui);border-bottom:1px solid var(--ui2);font-size:12px}
  .art .k{text-transform:uppercase;font-size:10px;padding:1px 7px;border-radius:8px;border:1px solid var(--ui3);color:var(--tx2)}
  .art .k.output{color:var(--gr);border-color:var(--gr)}.art .k.html{color:var(--bl);border-color:var(--bl)}
  .art .t{font-weight:600;color:var(--hi)}.art .s{color:var(--tx3);margin-left:auto}
  .art pre.body{margin:0;padding:13px;white-space:pre-wrap;word-break:break-word;font:12.5px/1.6 ui-monospace,Menlo,monospace;color:var(--tx);max-height:60vh;overflow:auto}
  .art iframe.body{width:100%;height:55vh;border:0;background:#fff}
  /* A/B controls in the review bar */
  #abbtn{background:var(--pu);color:#100F0F;border:0;border-radius:8px;padding:5px 11px;font-weight:600;font-size:12px;cursor:pointer}
  #abbtn:hover{filter:brightness(1.08)}
  #abbtn:disabled{opacity:.5;cursor:default}
  #abvars{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  .abv{display:inline-flex;align-items:center;gap:3px;font-size:11.5px;color:var(--tx2);background:var(--ui);border:1px solid var(--ui3);border-radius:7px;padding:2px 7px;cursor:pointer}
  .abv input{margin:0}
  /* A/B grouped responses in the captured-responses modal */
  .abgroup{border:1px solid var(--pu);border-radius:11px;margin:0 0 14px;overflow:hidden}
  .abh{padding:8px 13px;background:var(--ui);border-bottom:1px solid var(--ui2);color:var(--pu);font-size:12px;font-weight:600}
  .abrow{display:flex;gap:12px;padding:12px;overflow-x:auto}
  .abcol{flex:1 1 320px;min-width:300px;margin:0}
  .abcol pre.body{max-height:52vh}
  .vbadge{text-transform:uppercase;font-size:10px;letter-spacing:.04em;padding:1px 7px;border-radius:8px;border:1px solid var(--pu);color:var(--pu)}
  /* artifact actions, reply box, and full-screen document popup */
  .art .amini{font-size:11px;color:var(--tx2);background:var(--bg);border:1px solid var(--ui3);border-radius:7px;padding:2px 8px;cursor:pointer;text-decoration:none;line-height:1.6}
  .art .amini:hover{color:var(--tx);border-color:var(--tx3)}
  .art .body.prose{padding:14px 16px;max-height:62vh;overflow:auto}
  .artreply{padding:11px 13px;border-top:1px solid var(--ui2);background:var(--bg)}
  .artreply textarea{width:100%;box-sizing:border-box;min-height:62px;background:var(--bg2);border:1px solid var(--ui2);border-radius:8px;color:var(--tx);padding:9px 11px;font:13px/1.5 inherit;resize:vertical}
  .artreply .arrow{display:flex;align-items:center;gap:10px;margin-top:8px}
  .artreply .arsend{background:var(--bl);color:#100F0F;border:0;border-radius:8px;padding:6px 13px;font-weight:600;cursor:pointer}
  .artreply .arsend:disabled{opacity:.5;cursor:default}
  .artreply .armsg{font-size:12px;color:var(--tx3)}
  #docov{position:fixed;inset:0;z-index:12;background:#000c;display:none;align-items:center;justify-content:center}
  #docov.on{display:flex}
  #docov .dbox{background:var(--bg2);border:1px solid var(--ui2);border-radius:12px;width:90vw;max-width:1000px;height:88vh;display:flex;flex-direction:column;overflow:hidden}
  #docov .dh{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--ui2);color:var(--hi)}
  #docov .dh .sp{margin-left:auto}
  #docov #docx{background:var(--ui);border:1px solid var(--ui3);color:var(--tx);border-radius:8px;padding:5px 13px;cursor:pointer}
  #docov #docbody{flex:1;overflow:auto;padding:18px 22px}
  #docov #docbody.prose{padding:18px 26px}
  #docov #docbody pre.tx{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.6 ui-monospace,Menlo,monospace;color:var(--tx)}
  #docov #docbody iframe{width:100%;height:100%;border:0;background:#fff}
  .turn.kfoc .bd{outline:1.5px solid var(--bl);outline-offset:2px}
  /* turn-index rail */
  #rail{position:fixed;left:0;top:52px;bottom:0;width:222px;background:var(--bg2);border-right:1px solid var(--ui2);display:flex;flex-direction:column;z-index:4}
  main{margin-left:238px}
  #bar{left:238px}
  #capbtn{left:238px}
  #railhd{display:flex;align-items:center;gap:6px;padding:8px 11px;border-bottom:1px solid var(--ui2);font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--tx3)}
  #railhd .sp{margin-left:auto}
  #railtog{background:var(--ui);border:1px solid var(--ui3);color:var(--tx2);border-radius:6px;padding:2px 8px;font-size:12px;cursor:pointer;line-height:1}
  #railtog:hover{color:var(--tx)}
  #raillist{overflow-y:auto;flex:1;padding:4px 0}
  .rrow{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:0;border-left:2px solid transparent;color:var(--tx2);padding:3px 10px;font:11.5px/1.35 ui-sans-serif,system-ui;cursor:pointer}
  .rrow:hover{background:var(--ui)}
  .rrow.cur{background:var(--ui);border-left-color:var(--bl);color:var(--hi)}
  .rdot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;background:var(--tx3)}
  .rrow.user .rdot{background:var(--bl)}.rrow.assistant .rdot{background:var(--pu)}.rrow.toolResult .rdot{background:var(--gr)}.rrow.err .rdot{background:var(--re)}
  .rnum{color:var(--tx3);font-variant-numeric:tabular-nums;flex:0 0 auto;width:28px;text-align:right}
  .rref{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  body.rail-min #rail{width:27px}
  body.rail-min main{margin-left:43px}
  body.rail-min #bar{left:43px}
  body.rail-min #capbtn{left:43px}
  body.rail-min .rnum,body.rail-min .rref,body.rail-min #railhd>span{display:none}
  body.rail-min .rrow{justify-content:center;padding:3px 0;gap:0}
  body.rail-min #railhd{justify-content:center;padding:8px 0}
  @media(max-width:760px){ #rail{display:none} main{margin-left:0} #bar{left:0} #capbtn{left:16px} }
  #bar .n{font-size:13px;background:var(--ui);border:1px solid var(--ui3);border-radius:9px;padding:3px 10px;font-weight:700}
  #bar .kbd{color:var(--tx3);font-size:11px}
  .khint{color:var(--tx3);font-size:12px;cursor:pointer;margin-left:10px}
  #kh{position:fixed;inset:0;background:#000a;z-index:30;display:none;align-items:center;justify-content:center}
  #kh.on{display:flex}
  #kh .box{background:var(--bg2);border:1px solid var(--ui2);border-radius:12px;padding:18px 22px;box-shadow:0 12px 40px #000c}
  #kh h3{margin:0 0 12px;color:var(--hi);font-size:14px}
  #kh table{border-collapse:collapse;font-size:13px}
  #kh td{padding:4px 12px 4px 0;color:var(--tx);vertical-align:top}
  #kh kbd{background:var(--ui);border:1px solid var(--ui3);border-bottom-width:2px;border-radius:6px;padding:1px 7px;font:12px ui-monospace,Menlo,monospace;color:var(--hi)}
</style></head><body>
<header>
  <div class="crumb"><a href="/">&#8592; board</a> <span class="khint" id="toolstog" title="show/hide tool output (t)">tools: hidden</span> <span class="khint" id="khbtn" title="keyboard shortcuts">? keys</span></div>
  <h1 id="title">&hellip;</h1>
  <div class="meta" id="meta"></div>
</header>
<nav id="rail">
  <div id="railhd"><span>turns</span><span class="sp"></span><button id="railtog" title="collapse (m)">&#171;</button></div>
  <div id="raillist"></div>
</nav>
<main>
  <div id="notes"></div>
  <div id="logbox"></div>
  <div id="review"></div>
</main>
<button id="capbtn" hidden>&#128230; artifacts (<span id="capn">0</span>)</button>
<dialog id="artdlg">
  <div class="dlgh"><b>artifacts</b><span class="sp"></span><button id="artclose">close</button></div>
  <div id="arts"></div>
</dialog>
<button id="selbtn">&#128172; comment</button>
<div id="bar">
  <span class="n" id="barn">0 comments</span>
  <span class="est" id="barest"></span>
  <label title="Cheaper: resumes from omp's own summary + your comments instead of the full transcript (some context lost)"><input type="checkbox" id="compact"> compact resume</label>
  <span class="sp"></span>
  <button id="abbtn" title="A/B: run this feedback through several prompt framings as independent forks, then compare responses">A/B &#9662;</button>
  <span id="abvars"></span>
  <span id="barmsg"></span>
  <span class="kbd" title="send batch">&#8984;&#8617;</span>
  <button class="send" id="send">Done &mdash; send as prompt &rarr;</button>
</div>
<div id="kh"><div class="box">
  <h3>keyboard</h3>
  <table>
    <tr><td><kbd>j</kbd> <kbd>k</kbd></td><td>next / previous turn</td></tr>
    <tr><td><kbd>g</kbd> <kbd>G</kbd></td><td>first / last turn</td></tr>
    <tr><td><kbd>c</kbd></td><td>comment on the turn in view</td></tr>
    <tr><td><kbd>m</kbd></td><td>collapse / expand turn rail</td></tr>
    <tr><td><kbd>t</kbd></td><td>show / hide all tool output</td></tr>
    <tr><td><kbd>&#8984;</kbd><kbd>&#8617;</kbd></td><td>send batch as prompt</td></tr>
    <tr><td><kbd>esc</kbd></td><td>blur field / close help</td></tr>
    <tr><td><kbd>?</kbd></td><td>toggle this help</td></tr>
  </table>
</div></div>
<div id="lb"><img id="lbimg" alt=""></div>
<div id="docov"><div class="dbox"><div class="dh"><b id="doct">artifact</b><span class="sp"></span><button id="docx">close</button></div><div id="docbody"></div></div></div>
<script>
var ID = location.pathname.split('/').pop();
var BT = String.fromCharCode(96);
var comments = new Map();        // cid -> {turn, quote|null, ref, text}
var seenArt = new Set();
var turnsLen = -1, running = false, sess = null, pendingSel = null, qid = 0;
var figs=[], figMap={}, figSig=''; var IMGX=/^(png|webp|jpg|jpeg|gif|svg)$/;
function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
function when(ts){ try{ return new Date(ts).toLocaleString(); }catch(e){ return ts||''; } }
function kfmt(n){ return n>=1000 ? (n/1000).toFixed(n>=10000?0:1)+'k' : String(n); }

/* ---- tiny markdown -> html (headings, lists, bold/italic, code, links, blockquote, GFM tables) ---- */
function md(src){
  var lines = String(src==null?'':src).replace(/\\r\\n?/g,'\\n').split('\\n');
  var out=[], i=0, FENCE=BT+BT+BT;
  function splitRow(r){ var x=r.trim(); if(x.charAt(0)==='|')x=x.slice(1); if(x.charAt(x.length-1)==='|')x=x.slice(0,-1); return x.split('|').map(function(c){return c.trim();}); }
  function isSep(r){ return /^\\s*\\|?[\\s:|-]*-[\\s:|-]*\\|?\\s*$/.test(r) && r.indexOf('-')>=0; }
  function inl(x){
    x = esc(x);
    x = x.replace(new RegExp(BT+'([^'+BT+']+)'+BT,'g'), function(_,c){ return '<code>'+c+'</code>'; });
    x = x.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
    x = x.replace(/(^|[^\\w])_([^_\\n]+)_(?=[^\\w]|$)/g,'$1<em>$2</em>');
    x = x.replace(/(^|[^*])\\*([^*\\n]+)\\*/g,'$1<em>$2</em>');
    x = x.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
    x = x.replace(/(^|[\\s(])(https?:\\/\\/[^\\s)]+)/g, function(m,p,u){ return p+'<a href="'+u+'" target="_blank" rel="noopener">'+u+'</a>'; });
    return x;
  }
  var reItem=/^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$/;
  function indentOf(s){ return s.length - s.replace(/^\\s+/,'').length; }
  function buildList(region){
    var frames=[], roots=[];
    function cur(){ return frames[frames.length-1]; }
    region.forEach(function(raw){
      if(raw.trim()==='') return;
      var mi=reItem.exec(raw);
      if(mi){
        var indent=mi[1].length, ord=/\\d/.test(mi[2]), text=mi[3];
        while(frames.length && indent<cur().indent) frames.pop();
        if(!frames.length){ var f={indent:indent,ord:ord,items:[]}; frames.push(f); roots.push(f); }
        else if(indent>cur().indent){ var parent=cur().items[cur().items.length-1]; var nf={indent:indent,ord:ord,items:[]}; parent.children.push(nf); frames.push(nf); }
        cur().items.push({text:text, children:[]});
      } else { var it=cur()&&cur().items[cur().items.length-1]; if(it) it.text += ' '+raw.trim(); }
    });
    function render(frame){ var tag=frame.ord?'ol':'ul';
      return '<'+tag+'>'+frame.items.map(function(it){ return '<li>'+inl(it.text)+it.children.map(render).join('')+'</li>'; }).join('')+'</'+tag+'>'; }
    return roots.map(render).join('');
  }
  function parseList(start){
    var m0=reItem.exec(lines[start]), base=m0[1].length, j=start, region=[];
    while(j<lines.length){
      var ln2=lines[j];
      if(ln2.trim()===''){ var k=j; while(k<lines.length && lines[k].trim()==='') k++;
        if(k<lines.length){ var mm=reItem.exec(lines[k]);
          if((mm && mm[1].length>=base) || (indentOf(lines[k])>base && !/^#{1,6}\\s/.test(lines[k].trim()))){ region.push(''); j++; continue; } }
        break; }
      var mi=reItem.exec(ln2);
      if(mi){ if(mi[1].length<base) break; region.push(ln2); j++; continue; }
      if(indentOf(ln2)>base){ region.push(ln2); j++; continue; }
      break;
    }
    return { html: buildList(region), next:j };
  }
  while(i<lines.length){
    var ln=lines[i];
    if(ln.trim().slice(0,3)===FENCE){ var buf=[]; i++; while(i<lines.length && lines[i].trim().slice(0,3)!==FENCE){ buf.push(lines[i]); i++; } i++; out.push('<pre class="code"><code>'+esc(buf.join('\\n'))+'</code></pre>'); continue; }
    if(ln.indexOf('|')>=0 && i+1<lines.length && isSep(lines[i+1])){
      var head=splitRow(ln);
      var al=splitRow(lines[i+1]).map(function(c){ var L=c.charAt(0)===':', R=c.charAt(c.length-1)===':'; return (L&&R)?'center':R?'right':L?'left':''; });
      i+=2; var rows=[];
      while(i<lines.length && lines[i].indexOf('|')>=0 && lines[i].trim()!==''){ rows.push(splitRow(lines[i])); i++; }
      var th='<tr>'+head.map(function(c,k){ return '<th'+(al[k]?' style="text-align:'+al[k]+'"':'')+'>'+inl(c)+'</th>'; }).join('')+'</tr>';
      var tb=rows.map(function(r){ return '<tr>'+head.map(function(_,k){ return '<td'+(al[k]?' style="text-align:'+al[k]+'"':'')+'>'+inl(r[k]||'')+'</td>'; }).join('')+'</tr>'; }).join('');
      out.push('<table><thead>'+th+'</thead><tbody>'+tb+'</tbody></table>'); continue;
    }
    var hm=/^(#{1,6})\\s+(.*)$/.exec(ln); if(hm){ var lv=hm[1].length; out.push('<h'+lv+' class="mdh">'+inl(hm[2])+'</h'+lv+'>'); i++; continue; }
    if(/^\\s*>\\s?/.test(ln)){ var qb=[]; while(i<lines.length && /^\\s*>\\s?/.test(lines[i])){ qb.push(lines[i].replace(/^\\s*>\\s?/,'')); i++; } out.push('<blockquote>'+md(qb.join('\\n'))+'</blockquote>'); continue; }
    if(reItem.test(ln)){ var lb=parseList(i); out.push(lb.html); i=lb.next; continue; }
    if(ln.trim()===''){ i++; continue; }
    var para=[ln]; i++;
    while(i<lines.length){ var nx=lines[i];
      if(nx.trim()==='') break;
      if(nx.trim().slice(0,3)===FENCE) break;
      if(/^#{1,6}\\s/.test(nx)) break;
      if(/^\\s*>\\s?/.test(nx)) break;
      if(/^\\s*([-*+]|\\d+[.)])\\s+/.test(nx)) break;
      if(nx.indexOf('|')>=0 && i+1<lines.length && isSep(lines[i+1])) break;
      para.push(nx); i++; }
    out.push('<p>'+inl(para.join('\\n')).replace(/\\n/g,'<br>')+'</p>');
  }
  return out.join('');
}
function hasTable(s){ var L=String(s).split('\\n'); for(var i=0;i+1<L.length;i++){ if(L[i].indexOf('|')>=0 && /^\\s*\\|?[\\s:|-]*-[\\s:|-]*\\|?\\s*$/.test(L[i+1]) && L[i+1].indexOf('-')>=0) return true; } return false; }

function header(task){
  document.title = task.title || 'task';
  document.getElementById('title').textContent = task.title || '(untitled)';
  var extra = '';
  if(sess && sess.hasSession){ extra = '<span>ctx ~'+kfmt(sess.promptTokens||sess.tokens||0)+' tok</span>'
    + (sess.cost?'<span>$'+sess.cost.toFixed(2)+' so far</span>':'')
    + '<span>'+ (sess.turns?sess.turns.length:0) +' turns</span>'; }
  document.getElementById('meta').innerHTML =
      '<span class="badge st-'+task.status+'">'+task.status+'</span>'
    + (running?'<span class="badge run">&#9211; running</span>':'')
    + (task.interrupted&&!running?'<span class="badge intr">&#9208; interrupted</span>':'')
    + '<span>p'+task.priority+'</span><span>owner: '+esc(task.owner||'-')+'</span>'+extra
    + '<span>updated '+when(task.updated)+'</span>';
  document.getElementById('notes').innerHTML = task.notes ? '<div class="notes">'+esc(task.notes)+'</div>' : '';
  var log = task.log||[];
  document.getElementById('logbox').innerHTML = log.length ? log.map(function(e){ return '<div class="logline"><span class="lt">'+when(e.ts)+'</span>'+esc(e.text)+(e.sess?' <span class="lt">('+esc(e.sess)+')</span>':'')+'</div>'; }).join('') : '';
}

function blockHtml(b){
  if(b.t==='text') return '<div class="prose">'+md(b.text)+'</div>';
  if(b.t==='thinking') return '<details class="think"><summary>thinking</summary><div class="prose">'+md(b.text)+'</div></details>';
  if(b.t==='tool') return '<details class="tool"><summary>&rarr; '+esc(b.name)+(b.intent?' <span class="intent">'+esc(b.intent)+'</span>':'')+'</summary><pre class="args">'+esc(b.args||'')+'</pre></details>';
  if(b.t==='result'){ var tx=b.text||'';
    if(hasTable(tx)) return '<div class="prose">'+md(tx)+'</div>';
    var long=tx.length>1400;
    return long ? '<pre class="tx">'+esc(tx.slice(0,1400))+'</pre><details class="tool"><summary>show '+(tx.length-1400)+' more chars</summary><pre class="args">'+esc(tx.slice(1400))+'</pre></details>' : '<pre class="tx">'+esc(tx)+'</pre>';
  }
  return '';
}
function refOf(t){
  if(t.role==='toolResult') return 'tool result: '+(t.blocks[0]&&t.blocks[0].toolName||'');
  if(t.role==='assistant'){ var tc=t.blocks.find(function(x){return x.t==='tool';}); if(tc) return 'called '+tc.name; var tx=t.blocks.find(function(x){return x.t==='text';}); return tx?('says: '+tx.text.slice(0,40)):'assistant'; }
  return 'your message';
}
function selCards(i){
  var cards='';
  comments.forEach(function(c,cid){ if(c.quote!=null && c.turn===i){
    cards += '<div class="qc" data-cid="'+cid+'"><div class="qtxt">'+esc(c.quote)+'</div>'
      + '<textarea class="cmt show" data-q="'+cid+'" placeholder="comment on this passage — sent to the agent">'+esc(c.text)+'</textarea>'
      + '<span class="qcx" data-x="'+cid+'">&times; remove</span></div>';
  } });
  return cards;
}
function turnHtml(t){
  var i=t.i, roleCls=t.role, isTR=(t.role==='toolResult');
  var err = (isTR && t.blocks[0] && t.blocks[0].isError) ? ' err':'';
  var label = isTR ? (t.blocks[0]&&t.blocks[0].isError?'tool error':'tool result') : t.role;
  var meta = isTR ? (t.blocks[0]&&t.blocks[0].toolName||'') : (t.model||'');
  var wc = comments.get('w'+i); var hasSel=false; comments.forEach(function(c){ if(c.quote!=null && c.turn===i) hasSel=true; });
  var has = !!wc || hasSel;
  var body = t.blocks.map(blockHtml).join('');
  if(isTR){ var sz=(t.blocks[0]&&t.blocks[0].text)?t.blocks[0].text.length:0; var szl=sz>999?((Math.round(sz/100)/10)+'k chars'):(sz+' chars'); body='<details class="tres"'+(err?' open':'')+'><summary>&#9656; output <span class="tsz">'+szl+'</span></summary>'+body+'</details>'; }
  return '<div class="turn '+roleCls+(has?' hascmt':'')+(isTR?' tr':'')+'" data-i="'+i+'">'
    + '<div class="rh"><span class="role '+roleCls+err+'">'+esc(label)+'</span><span class="ts">'+esc(meta)+'</span>'
    + '<span class="sp"></span><span class="cbtn'+(wc?' on':'')+'" data-c="'+i+'">'+(wc?'&#9998; note':'+ note')+'</span></div>'
    + '<div class="bd">'+body+selCards(i)+figHtml(i)
    + '<textarea class="cmt'+(wc?' show':'')+'" data-ta="'+i+'" placeholder="note on this whole turn — sent to the agent as feedback">'+(wc?esc(wc.text):'')+'</textarea></div></div>';
}

function renderTranscript(){
  var r = document.getElementById('review');
  if(!sess || !sess.hasSession){
    r.innerHTML = '<h2 class="sec">session</h2><div id="imp">No omp session attached to this task.'
      + '<input id="imppath" placeholder="/home/nbandaru/.omp/agent/sessions/.../session.jsonl" spellcheck="false">'
      + '<button id="impgo">Attach &amp; review</button> <span id="impmsg"></span></div>';
    document.getElementById('impgo').onclick = doImport;
    return;
  }
  figMap = assignFigs();
  r.innerHTML = '<h2 class="sec">transcript <span class="hint">select any text to comment on a passage, or + note a whole turn &middot; then Done</span></h2>'
    + sess.turns.map(turnHtml).join('');
  applyKfoc(); renderRail(); applyTools();
  var fim=document.querySelectorAll('.fig img'); for(var n=0;n<fim.length;n++) fim[n].onerror=function(){ var f=this.closest('.fig'); if(f) f.classList.add('broken'); };
}

async function doImport(){
  var p = document.getElementById('imppath').value.trim();
  var msg = document.getElementById('impmsg'); msg.textContent='attaching…';
  try{ var res = await (await fetch('/api/import-session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:ID,path:p})})).json();
    if(res.ok){ await loadSession(); renderTranscript(); toBottom(); } else msg.textContent = res.error||'failed';
  }catch(e){ msg.textContent='error: '+e.message; }
}

/* ---- comment interactions ---- */
function liveComments(){ var a=[]; comments.forEach(function(c){ if(String(c.text||'').trim()) a.push(c); }); return a; }

document.addEventListener('click', function(e){
  var x = e.target.closest && e.target.closest('.qcx');
  if(x){ var cid=x.getAttribute('data-x'); comments.delete(cid); var card=x.closest('.qc'); if(card) card.remove(); updateBar(); return; }
  var c = e.target.closest && e.target.closest('.cbtn'); if(!c) return;
  var i = c.getAttribute('data-c');
  var ta = document.querySelector('textarea[data-ta="'+i+'"]');
  ta.classList.toggle('show'); if(ta.classList.contains('show')) ta.focus();
});
document.addEventListener('input', function(e){
  if(!e.target.matches || !e.target.matches('textarea.cmt')) return;
  var val = e.target.value, v = val.trim();
  if(e.target.hasAttribute('data-q')){
    var cid = e.target.getAttribute('data-q'); var c = comments.get(cid); if(c) c.text = val;
  } else {
    var i = +e.target.getAttribute('data-ta'), key='w'+i;
    if(v) comments.set(key, {turn:i, quote:null, ref:refOf(sess.turns[i]), text:val}); else comments.delete(key);
    var card = e.target.closest('.turn'), btn = card.querySelector('.cbtn');
    if(v){ card.classList.add('hascmt'); btn.classList.add('on'); btn.innerHTML='&#9998; note'; }
    else { card.classList.remove('hascmt'); btn.classList.remove('on'); btn.innerHTML='+ note'; }
  }
  updateBar();
});

/* ---- selection -> inline quoted comment ---- */
document.addEventListener('mouseup', function(e){
  var selbtn = document.getElementById('selbtn');
  if(selbtn.contains(e.target)) return;
  setTimeout(function(){
    var s = window.getSelection(); var txt = String(s).replace(/\\s+/g,' ').trim();
    if(!txt || txt.length<2){ selbtn.style.display='none'; return; }
    var a = s.anchorNode; var el = a ? (a.nodeType===1?a:a.parentElement) : null;
    var turn = el && el.closest ? el.closest('.turn') : null;
    var bd = turn ? turn.querySelector('.bd') : null;
    if(!turn || !bd || !bd.contains(el) || el.closest('textarea') || el.closest('.qc')){ selbtn.style.display='none'; return; }
    pendingSel = { turn:+turn.getAttribute('data-i'), quote: txt.slice(0,300) };
    selbtn.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth-130))+'px';
    selbtn.style.top = (e.clientY+14)+'px';
    selbtn.style.display='block';
  },1);
});
document.getElementById('selbtn').onclick = function(){
  if(!pendingSel) return;
  var cid = 'q'+(++qid);
  comments.set(cid, { turn:pendingSel.turn, quote:pendingSel.quote, ref:refOf(sess.turns[pendingSel.turn]), text:'' });
  this.style.display='none'; try{ window.getSelection().removeAllRanges(); }catch(e){}
  renderTranscript(); updateBar();
  var ta = document.querySelector('textarea[data-q="'+cid+'"]'); if(ta){ ta.scrollIntoView({block:'center'}); ta.focus(); }
};

function updateBar(){
  var n = liveComments().length;
  var bar = document.getElementById('bar');
  bar.classList.toggle('show', n>0);
  document.getElementById('barn').textContent = n+' comment'+(n===1?'':'s');
  var compact = document.getElementById('compact').checked;
  var tok = (sess && (sess.promptTokens||sess.tokens)) || 0;
  document.getElementById('barest').textContent = compact
    ? 'compact resume — small prefill (summary + comments)'
    : 'full resume — re-prefills ~'+kfmt(tok)+' tokens (cold)';
}
document.getElementById('compact').addEventListener('change', updateBar);

document.getElementById('send').onclick = async function(){
  var live = liveComments(); if(!live.length) return;
  var btn=this; btn.disabled=true; var msg=document.getElementById('barmsg'); msg.textContent='sending…';
  var list = live.map(function(c){ return {turn:c.turn, ref:c.ref, text:c.text, quote:c.quote||undefined}; });
  var compact = document.getElementById('compact').checked;
  try{
    var res = await (await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:ID,comments:list,compact:compact})})).json();
    if(res.ok){ comments.clear(); renderTranscript(); updateBar(); msg.textContent='sent — agent is resuming…'; }
    else { msg.textContent = res.error || 'failed'; }
  }catch(e){ msg.textContent='error: '+e.message; }
  btn.disabled=false;
};

/* ---- A/B: run the assembled feedback through several prompt framings ---- */
(async function loadVariants(){
  try{
    var d = await (await fetch('/api/variants')).json();
    if(!d || !d.ok || !d.variants) return;
    var host=document.getElementById('abvars');
    host.innerHTML = d.variants.map(function(v){
      return '<label class="abv" title="'+esc(v.desc)+'"><input type="checkbox" data-v="'+esc(v.id)+'" checked> '+esc(v.label)+'</label>';
    }).join('');
  }catch(e){}
})();
async function sendAB(){
  var msg=document.getElementById('barmsg');
  var vs=[]; var boxes=document.querySelectorAll('#abvars input[type=checkbox]');
  for(var i=0;i<boxes.length;i++) if(boxes[i].checked) vs.push(boxes[i].getAttribute('data-v'));
  if(!vs.length){ msg.textContent='pick at least one framing'; return; }
  var live = liveComments();
  var compact = document.getElementById('compact').checked;
  var body = { taskId: ID, variants: vs, compact: compact };
  if(live.length) body.comments = live.map(function(c){ return {turn:c.turn, ref:c.ref, text:c.text, quote:c.quote||undefined}; });
  var btn=document.getElementById('abbtn'); btn.disabled=true; msg.textContent='starting A/B…';
  try{
    var res = await (await fetch('/api/ab',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
    if(res.ok){ if(live.length){ comments.clear(); renderTranscript(); updateBar(); } msg.textContent='A/B started — '+res.variants.length+' framings running'; document.getElementById('artdlg').showModal(); }
    else { msg.textContent = res.error || 'failed'; }
  }catch(e){ msg.textContent='error: '+e.message; }
  btn.disabled=false;
}
document.getElementById('abbtn').onclick = sendAB;

/* ---- review focus, keyboard nav, turn-index rail ---- */
var kidx = -1, railRaf = 0;
function turnEls(){ return document.querySelectorAll('.turn'); }
function applyKfoc(){ var els=turnEls(); for(var n=0;n<els.length;n++) els[n].classList.remove('kfoc'); if(kidx>=0){ var el=document.querySelector('.turn[data-i="'+kidx+'"]'); if(el) el.classList.add('kfoc'); } }
function activeTurn(){ var els=turnEls(); if(!els.length) return -1; var ref=window.innerHeight*0.35, best=-1, bd=1e9; for(var n=0;n<els.length;n++){ var r=els[n].getBoundingClientRect(); var d=Math.abs(r.top-ref); if(d<bd){ bd=d; best=+els[n].getAttribute('data-i'); } } return best; }
function railSync(){ var list=document.getElementById('raillist'); if(!list) return; var c=list.querySelector('.rrow.cur'); if(c) c.classList.remove('cur'); var row=list.querySelector('.rrow[data-j="'+kidx+'"]'); if(row){ row.classList.add('cur'); list.scrollTop=Math.max(0, row.offsetTop - list.clientHeight/2 + row.offsetHeight/2); } }
function setFocus(n, scroll){ var els=turnEls(); if(!els.length){ kidx=-1; return; } kidx=Math.max(0,Math.min(n, els.length-1)); applyKfoc(); railSync(); if(scroll){ var el=document.querySelector('.turn[data-i="'+kidx+'"]'); if(el) el.scrollIntoView({block:'center'}); } }
function focusTurn(n){ setFocus(n, true); }
function renderRail(){ var list=document.getElementById('raillist'); if(!list) return; if(!sess||!sess.turns){ list.innerHTML=''; return; } list.innerHTML = sess.turns.map(function(t){ var er=(t.role==='toolResult'&&t.blocks[0]&&t.blocks[0].isError)?' err':''; var ref=refOf(t); return '<button class="rrow '+t.role+er+'" data-j="'+t.i+'" title="'+esc(ref)+'"><span class="rdot"></span><span class="rnum">'+t.i+'</span><span class="rref">'+esc(ref)+'</span></button>'; }).join(''); railSync(); }
function assignFigs(){ var map={}; if(!sess||!sess.turns||!figs.length) return map; var ts=sess.turns.map(function(t){return t.ts||'';}); for(var k=0;k<figs.length;k++){ var f=figs[k]; var idx=sess.turns.length-1; if(f.ts){ idx=0; for(var n=0;n<ts.length;n++){ if(ts[n] && ts[n]<=f.ts) idx=n; } } (map[idx]=map[idx]||[]).push(f); } return map; }
function figHtml(i){ var fs=figMap[i]; if(!fs||!fs.length) return ''; return '<div class="figs">'+fs.map(function(f){ var u='/artifact/'+ID+'/'+f.art; var cap=esc(f.title||'figure'); return '<figure class="fig" data-fa="'+f.art+'"><img loading="lazy" src="'+u+'" alt="'+cap+'"><figcaption><span class="fcap">'+cap+'</span><button class="figc" data-ff="'+i+'" data-fart="'+f.art+'" data-fn="'+cap+'">&#128172; comment</button></figcaption></figure>'; }).join('')+'</div>'; }
function commentFigure(turn, art, name){ var cid='fig_'+art; if(!comments.get(cid)) comments.set(cid, { turn:turn, quote:'figure: '+name, ref:(sess.turns[turn]?refOf(sess.turns[turn]):'figure'), text:'' }); renderTranscript(); updateBar(); var ta=document.querySelector('textarea[data-q="'+cid+'"]'); if(ta){ ta.scrollIntoView({block:'center'}); ta.focus(); } }
document.addEventListener('click', function(e){
  if(e.target && e.target.matches && e.target.matches('.fig img')){ document.getElementById('lbimg').src=e.target.src; document.getElementById('lb').classList.add('on'); return; }
  var fc=e.target.closest?e.target.closest('.figc'):null; if(fc){ e.preventDefault(); commentFigure(+fc.getAttribute('data-ff'), fc.getAttribute('data-fart'), fc.getAttribute('data-fn')); }
});
document.getElementById('lb').addEventListener('click', function(){ this.classList.remove('on'); });
/* keep focus on the turn you are actually looking at, so c never jumps elsewhere */
window.addEventListener('scroll', function(){ if(railRaf) return; railRaf=requestAnimationFrame(function(){ railRaf=0; var a=activeTurn(); if(a>=0 && a!==kidx){ kidx=a; applyKfoc(); railSync(); } }); }, {passive:true});
/* clicking anywhere in a turn focuses it */
document.addEventListener('click', function(e){ var tn=e.target.closest?e.target.closest('.turn'):null; if(tn){ var i=+tn.getAttribute('data-i'); if(i>=0){ kidx=i; applyKfoc(); railSync(); } } });
document.getElementById('raillist').addEventListener('click', function(e){ var b=e.target.closest?e.target.closest('.rrow'):null; if(b) focusTurn(+b.getAttribute('data-j')); });
function railMin(v){ document.body.classList.toggle('rail-min', v); document.getElementById('railtog').innerHTML = v?'&#187;':'&#171;'; try{ localStorage.setItem('tb_railmin', v?'1':'0'); }catch(_){} }
document.getElementById('railtog').onclick=function(){ railMin(!document.body.classList.contains('rail-min')); };
function positionRail(){ var h=document.querySelector('header'); if(h) document.getElementById('rail').style.top=h.offsetHeight+'px'; }
window.addEventListener('resize', positionRail);
try{ if(localStorage.getItem('tb_railmin')==='1') railMin(true); }catch(_){}
positionRail();
var toolsOpen=false;
function applyTools(){ var ds=document.querySelectorAll('details.tres'); for(var n=0;n<ds.length;n++) ds[n].open=toolsOpen; var b=document.getElementById('toolstog'); if(b) b.textContent='tools: '+(toolsOpen?'shown':'hidden'); }
function setTools(v){ toolsOpen=v; applyTools(); try{ localStorage.setItem('tb_tools', v?'1':'0'); }catch(_){} }
document.getElementById('toolstog').onclick=function(){ setTools(!toolsOpen); };
try{ if(localStorage.getItem('tb_tools')==='1') toolsOpen=true; }catch(_){}
document.getElementById('khbtn').onclick=function(){ document.getElementById('kh').classList.toggle('on'); };
document.getElementById('kh').addEventListener('click', function(){ this.classList.remove('on'); });
document.addEventListener('keydown', function(e){
  if((e.metaKey||e.ctrlKey) && e.key==='Enter'){ if(document.getElementById('bar').classList.contains('show')){ e.preventDefault(); document.getElementById('send').click(); } return; }
  var ae=document.activeElement;
  if(ae && (ae.matches('textarea,input') || ae.isContentEditable)){ if(e.key==='Escape') ae.blur(); return; }
  if(e.metaKey||e.ctrlKey||e.altKey) return;
  var base = kidx<0 ? activeTurn() : kidx;
  if(e.key==='j'||e.key==='ArrowDown'){ e.preventDefault(); focusTurn(base+1); }
  else if(e.key==='k'||e.key==='ArrowUp'){ e.preventDefault(); focusTurn(base-1); }
  else if(e.key==='g'){ e.preventDefault(); focusTurn(0); }
  else if(e.key==='G'){ e.preventDefault(); focusTurn(1e9); }
  else if(e.key==='c'){ e.preventDefault(); if(kidx<0) kidx=activeTurn(); if(kidx>=0){ applyKfoc(); railSync(); var ta=document.querySelector('textarea[data-ta="'+kidx+'"]'); if(ta){ ta.classList.add('show'); ta.scrollIntoView({block:'center'}); ta.focus({preventScroll:true}); } } }
  else if(e.key==='m'){ e.preventDefault(); railMin(!document.body.classList.contains('rail-min')); }
  else if(e.key==='t'){ e.preventDefault(); setTools(!toolsOpen); }
  else if(e.key==='Escape'){ document.getElementById('kh').classList.remove('on'); document.getElementById('lb').classList.remove('on'); }
  else if(e.key==='?'){ e.preventDefault(); document.getElementById('kh').classList.toggle('on'); }
});

async function loadSession(){
  try{ sess = await (await fetch('/api/session/'+ID)).json(); running = !!sess.running; }
  catch(e){ sess = {hasSession:false}; }
}

/* ---- captured responses (modal) ---- */
document.getElementById('capbtn').onclick = function(){ document.getElementById('artdlg').showModal(); };
document.getElementById('artclose').onclick = function(){ document.getElementById('artdlg').close(); };
var abGroups = {};
function abContainer(ab){
  if(abGroups[ab]) return abGroups[ab];
  var box=document.createElement('div'); box.className='abgroup';
  var h=document.createElement('div'); h.className='abh'; h.innerHTML='&#9878; A/B framings &middot; compare responses side by side';
  var row=document.createElement('div'); row.className='abrow';
  box.appendChild(h); box.appendChild(row);
  document.getElementById('arts').appendChild(box);
  abGroups[ab]={box:box,row:row};
  return abGroups[ab];
}
var artMeta = {};
async function addArtifact(a){
  if(seenArt.has(a.art)) return; seenArt.add(a.art);
  artMeta[a.art]={title:a.title||a.format,format:a.format};
  var btn=document.getElementById('capbtn'); btn.hidden=false; document.getElementById('capn').textContent=seenArt.size;
  var actions='<button class="amini aopen" data-art="'+esc(a.art)+'">open &#8599;</button>'
    + '<button class="amini areply" data-art="'+esc(a.art)+'">&#128172; reply</button>'
    + '<a class="amini" href="/artifact/'+ID+'/'+a.art+'" target="_blank">raw</a>';
  var head='<div class="h"><span class="k '+esc(a.kind)+'">'+esc(a.kind)+'</span>'
    + (a.variant?'<span class="vbadge">'+esc(a.variant)+'</span>':'')
    + '<span class="t">'+esc(a.title||a.format)+'</span>'
    + '<span class="s">'+when(a.ts)+' &middot; '+a.bytes+'b</span>'+actions+'</div>';
  var isMd=(a.format==='md'||a.format==='markdown');
  var wrap=document.createElement('div'); wrap.className='art'+(a.ab?' abcol':''); wrap.setAttribute('data-art',a.art);
  wrap.innerHTML=head;
  if(a.format==='html'){ var f=document.createElement('iframe'); f.className='body'; f.setAttribute('sandbox',''); f.src='/artifact/'+ID+'/'+a.art; wrap.appendChild(f); }
  else if(isMd){ var host=document.createElement('div'); host.className='body prose'; host.innerHTML='loading&#8230;'; wrap.appendChild(host); try{ host.innerHTML=md(await (await fetch('/artifact/'+ID+'/'+a.art)).text()); }catch(e){ host.textContent='[unreadable]'; } }
  else { var pre=document.createElement('pre'); pre.className='body'; pre.textContent='loading…'; wrap.appendChild(pre); try{ pre.textContent=await (await fetch('/artifact/'+ID+'/'+a.art)).text(); }catch(e){ pre.textContent='[unreadable]'; } }
  var rep=document.createElement('div'); rep.className='artreply'; rep.hidden=true; rep.setAttribute('data-art',a.art);
  rep.innerHTML='<textarea placeholder="respond to this artifact &mdash; sent to the agent as a prompt to resume"></textarea><div class="arrow"><button class="arsend">reply to agent &rarr;</button><span class="armsg"></span></div>';
  wrap.appendChild(rep);
  if(a.ab){ abContainer(a.ab).row.appendChild(wrap); } else { document.getElementById('arts').appendChild(wrap); }
}
document.getElementById('arts').addEventListener('click', function(e){
  var t=e.target; if(!t.classList) return;
  if(t.classList.contains('aopen')){ openArt(t.getAttribute('data-art')); }
  else if(t.classList.contains('areply')){ var w=t.closest('.art'); var r=w&&w.querySelector('.artreply'); if(r){ r.hidden=!r.hidden; if(!r.hidden){ var ta=r.querySelector('textarea'); if(ta) ta.focus(); } } }
  else if(t.classList.contains('arsend')){ sendArtReply(t); }
});
async function openArt(art){
  var m=artMeta[art]||{}; var ov=document.getElementById('docov'); var body=document.getElementById('docbody');
  document.getElementById('doct').textContent=m.title||'artifact';
  body.className=''; body.innerHTML='loading&#8230;'; ov.classList.add('on');
  try{
    if(m.format==='html'){ body.innerHTML=''; var f=document.createElement('iframe'); f.setAttribute('sandbox',''); f.src='/artifact/'+ID+'/'+art; body.appendChild(f); }
    else { var txt=await (await fetch('/artifact/'+ID+'/'+art)).text();
      if(m.format==='md'||m.format==='markdown'){ body.className='prose'; body.innerHTML=md(txt); }
      else { body.innerHTML=''; var pre=document.createElement('pre'); pre.className='tx'; pre.textContent=txt; body.appendChild(pre); } }
  }catch(e){ body.textContent='[unreadable]'; }
}
async function sendArtReply(btn){
  var box=btn.closest('.artreply'); if(!box) return; var art=box.getAttribute('data-art');
  var ta=box.querySelector('textarea'); var msg=box.querySelector('.armsg');
  var text=String(ta.value||'').trim(); if(!text){ msg.textContent='write a reply first'; return; }
  var m=artMeta[art]||{}; var lastTurn=(sess&&sess.turns&&sess.turns.length)?sess.turns.length-1:0;
  var comment={turn:lastTurn, ref:'re: '+(m.title||'artifact'), quote:'artifact: '+(m.title||art), text:text};
  var compact=document.getElementById('compact').checked;
  btn.disabled=true; msg.textContent='sending&#8230;';
  try{
    var res=await (await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({taskId:ID,comments:[comment],compact:compact})})).json();
    if(res.ok){ ta.value=''; box.hidden=true; msg.textContent='sent — agent resuming…'; }
    else { msg.textContent=res.error||'failed'; }
  }catch(e){ msg.textContent='error: '+e.message; }
  btn.disabled=false;
}
document.getElementById('docx').onclick=function(){ document.getElementById('docov').classList.remove('on'); };
document.getElementById('docov').addEventListener('click', function(e){ if(e.target.id==='docov') e.currentTarget.classList.remove('on'); });
document.addEventListener('keydown', function(e){ if(e.key==='Escape'){ var ov=document.getElementById('docov'); if(ov&&ov.classList.contains('on')){ e.stopPropagation(); ov.classList.remove('on'); } } }, true);

/* ---- auto-scroll: land at newest; follow while running if pinned ---- */
function atBottom(){ return (window.innerHeight+window.scrollY) >= document.body.scrollHeight-160; }
function toBottom(){ window.scrollTo(0, document.body.scrollHeight); }
var firstScroll=false;

var lastRunning=false, loadedOnce=false;
async function tick(){
  try{
    var r = await fetch('/api/task/'+ID);
    if(r.status===404){ document.getElementById('title').textContent='(no such task)'; return; }
    var d = await r.json();
    running = !!d.running;
    if(!loadedOnce || running || lastRunning){ await loadSession(); loadedOnce = true; }
    header(d.task);
    var len = sess && sess.hasSession ? sess.turns.length : -1;
    if(len !== turnsLen){
      var pinned = atBottom();
      turnsLen = len; renderTranscript(); updateBar();
      if(!firstScroll || (running && pinned)){ toBottom(); firstScroll = true; }
    }
    lastRunning = running;
    var arts = d.task.artifacts||[];
    var imgs = arts.filter(function(a){ return IMGX.test(a.format||''); });
    var fsig = imgs.map(function(a){ return a.art; }).join(',');
    if(fsig!==figSig){ figs=imgs; figSig=fsig; if(sess&&sess.hasSession) renderTranscript(); }
    for(var i=0;i<arts.length;i++){ if(!IMGX.test(arts[i].format||'')) await addArtifact(arts[i]); }
  }catch(e){}
  setTimeout(tick, running ? 1500 : 2500);
}
tick();
</script></body></html>`;

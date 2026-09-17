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
import { join, sep, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { readAllEvents, fold, appendEvent, genId, STATUSES, root, artifactsDir } from "./lib.mjs";
import { attach } from "./attach.mjs";
import { parseSession, compactPrompt } from "./session-parse.mjs";
import { commentBlock, freshPrompt, VARIANTS, VARIANT_IDS, frame, variantLabel, variantMeta } from "./prompts.mjs";

const PORT = Number(process.env.TODO_BOARD_PORT) || 8787;
const HOST = "127.0.0.1";
const ASSETS = join(dirname(fileURLToPath(import.meta.url)), "public");
const OMP = process.env.OMP_BIN || "/home/nbandaru/.local/bin/omp";
const MAX_SPAWN = Number(process.env.TODO_BOARD_MAX_SPAWN) || 3;
// idle cap: a running session is killed if it produces no activity (assistant
// output / tool traffic) for this long. A review send spawns a fresh run, so
// "your comment / response" resets the clock the same way. Override in minutes.
const IDLE_MS = (Number(process.env.TODO_BOARD_IDLE_MIN) || 30) * 60_000;
const running = new Map(); // taskId -> { pid, started }
const queue = new Map(); // taskId -> fn[]: reviews that arrived while a run was busy, drained on exit

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

// omp writes sessions here; the board's spawned workers write per-task sessions
// under root()/sessions/<taskId>. Both are trusted roots for import + resume.
const SESSIONS_ROOT = join(homedir(), ".omp", "agent", "sessions");
function underSessions(p) {
  let rp; try { rp = realpathSync(p); } catch { return false; }
  for (const dir of [SESSIONS_ROOT, join(root(), "sessions")]) {
    try { if (rp.startsWith(realpathSync(dir))) return true; } catch {}
  }
  return false;
}
// newest .jsonl DIRECTLY under `dir` (a per-task session dir). Deterministic
// capture: adoption + live-tail read only the task's OWN dir, never the whole
// sessions root, so two concurrent sessions can never cross-bind transcripts.
function newestInDir(dir) {
  let best = null, bestM = -1;
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    try { const mt = statSync(join(dir, e.name)).mtimeMs; if (mt > bestM) { bestM = mt; best = join(dir, e.name); } } catch {}
  }
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
  // Every task keeps its transcript in ONE stable dir. Capture is deterministic:
  // the review view adopts from HERE (never "newest .jsonl anywhere"), so two
  // concurrent sessions can never cross-bind, and the file is live-tailable.
  const sessDir = join(root(), "sessions", taskId);
  try { mkdirSync(sessDir, { recursive: true }); } catch {}
  const hasLocal = () => { try { return readdirSync(sessDir).some((f) => f.endsWith(".jsonl")); } catch { return false; } };

  let args, verb, prevMtime = 0;
  if (mode === "compact") {
    args = ["-p", "--print-thoughts", "--session-dir", sessDir, promptOverride || "Continue."]; // fresh, seeded prompt
    verb = "started (compact)";
  } else if (mode === "resume") {
    if (!resumePath || !underSessions(resumePath)) return { ok: false, code: 400, error: "resume path missing or outside sessions root" };
    try { prevMtime = statSync(resumePath).mtimeMs; } catch {}
    args = (dirname(resumePath) === sessDir)
      ? ["-p", "--print-thoughts", "--session-dir", sessDir, "--continue", promptOverride || "Continue."]        // own session: continue in place
      : ["-p", "--print-thoughts", "--session-dir", sessDir, "--resume", resumePath, promptOverride || "Continue."]; // external: resume, store here
    verb = "resumed";
  } else {
    const resuming = hasLocal();
    args = ["-p", "--print-thoughts", "--session-dir", sessDir];
    if (resuming) args.push("--continue");
    args.push(promptOverride || freshPrompt(t, resuming));
    verb = resuming ? "resumed" : "started";
  }

  const startMs = Date.now();
  let child;
  try {
    // detached: own process group/session so a server restart (KillMode=process)
    // never reaches in-flight workers; parent still signals by pid for idle-kill.
    child = spawn(OMP, args, { cwd: root(), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch (e) {
    return { ok: false, code: 500, error: "spawn failed: " + (e && e.message) };
  }
  running.set(taskId, { pid: child.pid, started: startMs });
  appendEvent("spawner", { op: "update", id: taskId, status: "doing", interrupted: false });
  appendEvent("spawner", { op: "log", id: taskId, text: `▶ ${verb} omp session${label ? " — " + label : ""} (pid ${child.pid})` });

  // live-bind: point the task at the worker's .jsonl as soon as it appears in
  // the per-task dir, so the review page tails new turns in real time — not only
  // once the run exits. Only emits an event when the bound file actually changes.
  let bound = (t.session && dirname(t.session) === sessDir) ? t.session : null;
  const bind = (f) => { if (f && f !== bound) { bound = f; try { appendEvent("spawner", { op: "update", id: taskId, session: f }); } catch {} } };
  const binder = setInterval(() => { try { bind(newestInDir(sessDir)); } catch {} }, 1500);
  binder.unref();

  let out = "", lastActivity = Date.now(), interrupted = false, lastFileM = 0;
  const cap = (d) => { lastActivity = Date.now(); out += d; if (out.length > 4_000_000) out = out.slice(-4_000_000); };
  child.stdout.on("data", cap);
  child.stderr.on("data", cap);
  child.on("error", (e) => cap(`\n[spawn error] ${e && e.message}\n`));
  // if the parent exits mid-run, the orphaned child's pipe breaks; swallow the
  // resulting stream error so it never throws in (a since-restarted) parent.
  child.stdout.on("error", () => {});
  child.stderr.on("error", () => {});
  // kill on idle: no activity for IDLE_MS. Activity = stdout OR transcript growth,
  // so an agent mid-tool-call (quiet on stdout but still writing turns) is never
  // mistaken for idle and killed.
  const idle = setInterval(() => {
    try { const f = bound || newestInDir(sessDir); if (f) { const mt = statSync(f).mtimeMs; if (mt > lastFileM) { lastFileM = mt; lastActivity = Date.now(); } } } catch {}
    if (Date.now() - lastActivity >= IDLE_MS) {
      interrupted = true;
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000).unref();
    }
  }, Math.max(1000, Math.min(30_000, IDLE_MS)));
  idle.unref();
  child.on("exit", (exitCode) => {
    clearInterval(idle); clearInterval(binder);
    running.delete(taskId);
    try {
      attach("spawner", taskId, "output", `${label || "session"} response${interrupted ? " (interrupted)" : ` (exit ${exitCode})`}`, { body: out || "(no output captured)", format: "text", ab: abRun, variant });
      // deterministic adoption: newest transcript in THIS task's own dir; fall
      // back to an in-place external resume whose file actually advanced.
      let adopt = newestInDir(sessDir);
      if (!adopt && mode === "resume") { try { if (statSync(resumePath).mtimeMs > prevMtime) adopt = resumePath; } catch {} }
      const cur = findTask(taskId);
      if (adopt && (!cur || adopt !== cur.session)) appendEvent("spawner", { op: "update", id: taskId, session: adopt });
      if (interrupted) {
        // don't close it out and keep it in Current Sessions — just flag it as
        // stopped-but-resumable (status is left untouched).
        appendEvent("spawner", { op: "update", id: taskId, interrupted: true });
        appendEvent("spawner", { op: "log", id: taskId, text: `⏸ interrupted — ${Math.round(IDLE_MS / 60000)}m idle cap hit (no assistant activity); stopped but still open to resume` });
      } else {
        appendEvent("spawner", { op: "log", id: taskId, text: `session finished (exit ${exitCode})` });
      }
    } catch {}
    // drain a review that queued while this run was busy (chains via its own exit)
    try { const arr = queue.get(taskId); if (arr && arr.length) { const fn = arr.shift(); if (!arr.length) queue.delete(taskId); setImmediate(fn); } } catch {}
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
  appendEvent("reviewer", { op: "log", id: taskId, text: `⚑ A/B ${abRun}: ${variants.length} framings — ${variants.map(variantLabel).join(", ")}` });
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
      appendEvent("reviewer", { op: "log", id: t.id, text: `✒ review sent (${comments.length} comment${comments.length > 1 ? "s" : ""})` });
      const runReview = () => {
        const cur = findTask(t.id);
        return payload.compact
          ? runSession(t.id, { mode: "compact", promptOverride: compactPrompt(parseSessionCached(cur.session), block), label: "review (compact)" })
          : runSession(t.id, { mode: "resume", resumePath: cur.session, promptOverride: block, label: "review" });
      };
      // busy? queue it instead of a flat 409 — drains when the current run exits.
      if (running.has(t.id)) {
        const arr = queue.get(t.id) || []; arr.push(() => { runReview(); }); queue.set(t.id, arr);
        appendEvent("reviewer", { op: "log", id: t.id, text: `⧗ review queued — runs when the current session finishes` });
        return json(res, 202, { ok: true, queued: true, ...snapshot() });
      }
      const r = runReview();
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
    // static client assets (css/js split out of the page templates)
    if (req.method === "GET" && (m = url.pathname.match(/^\/assets\/([a-z0-9_]+\.(?:css|js))$/))) {
      const fp = join(ASSETS, m[1]);
      if (!existsSync(fp)) return json(res, 404, { ok: false, error: "no such asset" });
      let st; try { st = statSync(fp); } catch (e) { return json(res, 500, { ok: false, error: "stat failed: " + e.message }); }
      const etag = '"' + Math.round(st.mtimeMs) + "-" + st.size + '"';
      if (req.headers["if-none-match"] === etag) { res.writeHead(304, { etag, "cache-control": "no-cache" }); return res.end(); }
      const ct = m[1].endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
      res.writeHead(200, { "content-type": ct, "cache-control": "no-cache", etag });
      return res.end(readFileSync(fp));
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
<link rel="stylesheet" href="/assets/board.css">
</head><body>
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
<script>window.__BOOT__={statuses:${JSON.stringify(STATUSES)}};</script>
<script src="/assets/board.js"></script>
</body></html>`;

// ---- per-task detail page: header + append-only artifact timeline ----
const DETAIL = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>task</title>
<link rel="stylesheet" href="/assets/detail.css">
</head><body>
<header>
  <div class="crumb"><a href="/">&#8592; board</a> <span class="khint" id="toolstog" title="expand/collapse reasoning (t)">reasoning: hidden</span> <span class="khint" id="khbtn" title="keyboard shortcuts">? keys</span></div>
  <h1 id="title">&hellip;</h1>
  <div class="meta" id="meta"></div>
</header>
<nav id="rail">
  <div id="railhd"><span>turns</span><span class="sp"></span><button id="railtog" title="collapse (m)">&#171;</button></div>
  <div id="raillist"></div>
  <div id="railresize" title="drag to resize sidebar"></div>
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
    <tr><td><kbd>t</kbd></td><td>expand / collapse reasoning</td></tr>
    <tr><td><kbd>&#8984;</kbd><kbd>&#8617;</kbd></td><td>send batch as prompt</td></tr>
    <tr><td><kbd>esc</kbd></td><td>blur field / close help</td></tr>
    <tr><td><kbd>?</kbd></td><td>toggle this help</td></tr>
  </table>
</div></div>
<div id="lb"><img id="lbimg" alt=""></div>
<dialog id="docov"><div class="dh"><b id="doct">artifact</b><span class="sp"></span><button id="docx">close</button></div><div id="docbody"></div></dialog>
<script src="/assets/detail.js"></script>
</body></html>`;

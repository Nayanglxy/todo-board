// todo-board session binding hook (the orchestration layer).
//
// Loaded by every omp session (discovered at ~/.omp/agent/hooks/pre/board.js).
// It makes each session board-aware without turning the board into a session log:
//   - the board is a curated BACKLOG of outstanding roadmap items (research /
//     exploration threads worth continuing), NOT one row per session,
//   - injects the live backlog into the model's context every turn, so the agent
//     sees outstanding work + your notes,
//   - a session owns a task ONLY when spawned to one (TODO_BOARD_TASK) or when it
//     explicitly `/board add`s a new item or `/board claim`s an existing one,
//   - exposes /board commands to add items, report status/notes/log, and attach
//     reasoning traces / outputs as artifacts.
// Nothing is auto-created or auto-closed: the backlog only changes deliberately.
//
// EVERY handler is wrapped so a board failure can never break a session.
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const BOARD_DIR = process.env.TODO_BOARD_CODE || "/home/nbandaru/todo-board"; // where lib.mjs/attach.mjs live (data dir is lib's own TODO_BOARD_DIR)
const AUTOTASK = process.env.TODO_BOARD_AUTOTASK === "1";       // opt-in: register each session as its own task (off = board is a curated backlog)
const AUTOCAP = process.env.TODO_BOARD_AUTOCAP === "1";         // auto-attach notable tool outputs
const CAP_MIN = Number(process.env.TODO_BOARD_AUTOCAP_MIN || 400); // min chars to auto-capture
const AUTOSESS = process.env.TODO_BOARD_NO_AUTOSESSION !== "1" && process.env.TODO_BOARD_AUTOTASK !== "0"; // default: every session registers itself + binds its transcript

let _lib = null;
async function lib() {
  if (!_lib) _lib = await import(pathToFileURL(join(BOARD_DIR, "lib.mjs")).href);
  return _lib;
}
async function attachFn() {
  return (await import(pathToFileURL(join(BOARD_DIR, "attach.mjs")).href)).attach;
}

// per-session state, keyed by session file (survives for the process lifetime)
const S = new Map();
function keyOf(ctx) {
  try { return ctx.sessionManager.getSessionFile() || "default"; } catch { return "default"; }
}
function sessId(file) {
  const h = createHash("sha1").update(String(file)).digest("hex");
  return { sess: "s_" + h.slice(0, 6), taskId: "t_" + h.slice(0, 8) };
}
async function state(ctx) {
  const file = keyOf(ctx);
  let st = S.get(file);
  if (st) return st;
  const { sess } = sessId(file);
  // The board is a backlog of outstanding roadmap items, NOT a session registry.
  // A session owns a task ONLY if it was spawned to one (TODO_BOARD_TASK) or
  // explicitly claims/creates one via /board. It never auto-registers itself.
  const pinned = /^t_[a-z0-9]+$/.test(process.env.TODO_BOARD_TASK || "") ? process.env.TODO_BOARD_TASK : null;
  st = { file, sess, taskId: pinned, autoId: sessId(file).taskId };
  S.set(file, st);
  if (pinned) {
    try { const { appendEvent } = await lib(); appendEvent(sess, { op: "update", id: pinned, owner: sess, status: "doing" }); } catch {}
  } else if (AUTOSESS) {
    // default: register this session as a task and bind its own transcript so
    // it shows on the board and is reviewable with zero manual steps.
    try {
      const { appendEvent } = await lib();
      appendEvent(sess, { op: "add", id: st.autoId, title: "session " + sess, status: "doing", priority: 1, session: file });
      st.taskId = st.autoId; st.boundPath = file; st.titled = false;
    } catch {}
  }
  return st;
}

// pull the first human prompt out of the .jsonl to use as a readable card title
async function firstUserTitle(file) {
  try {
    const { readFileSync } = await import("node:fs");
    for (const l of readFileSync(file, "utf8").split("\n")) {
      if (!l.trim()) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.type !== "message" || !o.message || o.message.role !== "user") continue;
      const c = o.message.content;
      let tx = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text").map((b) => b.text).join(" ") : "";
      tx = tx.replace(/\s+/g, " ").trim();
      if (tx) return tx.slice(0, 80);
    }
  } catch {}
  return null;
}
// keep the auto-registered task's transcript path fresh and give it a real title once
async function autoRefresh(ctx, st) {
  if (!AUTOSESS || st.taskId !== st.autoId) return;
  try {
    const { appendEvent } = await lib();
    const cur = keyOf(ctx);
    if (cur && cur !== "default" && cur !== st.boundPath) { appendEvent(st.sess, { op: "update", id: st.taskId, session: cur }); st.boundPath = cur; }
    if (!st.titled) { const ttl = await firstUserTitle(st.boundPath); if (ttl) { appendEvent(st.sess, { op: "update", id: st.taskId, title: ttl }); st.titled = true; } }
  } catch {}
}

async function boardSnapshot() {
  const { fold, readAllEvents } = await lib();
  return fold(readAllEvents());
}
function taskLine(t) {
  return `${t.status === "done" ? "[x]" : t.status === "doing" ? "[~]" : t.status === "blocked" ? "[!]" : "[ ]"} ${t.title} (p${t.priority}${t.owner ? " @" + t.owner : ""}) ${t.id}`;
}

export default function board(pi) {
  const log = (m) => { try { pi.logger.info(`[todo-board] ${m}`); } catch {} };

  // eagerly bind on session start
  pi.on("session_start", async (_e, ctx) => {
    try { const st = await state(ctx); log(st.taskId ? `session owns task ${st.taskId}` : "session board-aware (no task owned)"); } catch (e) { log("start: " + e.message); }
  });

  // inject the live backlog into context every turn
  pi.on("before_agent_start", async (_e, ctx) => {
    try {
      const st = await state(ctx);
      await autoRefresh(ctx, st);
      const b = await boardSnapshot();
      const open = b.tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
      const mine = st.taskId ? b.tasks.find((t) => t.id === st.taskId) : null;
      const lines = [];
      lines.push("📋 todo board — shared backlog of outstanding roadmap items.");
      if (mine) {
        lines.push(`YOUR TASK: ${taskLine(mine)}`);
        if (mine.notes) lines.push(`  human notes: ${mine.notes}`);
        if (mine.artifacts && mine.artifacts.length) lines.push(`  artifacts attached: ${mine.artifacts.length}`);
      }
      const rest = open.filter((t) => t.id !== st.taskId);
      if (rest.length) {
        lines.push(`OPEN ITEMS (${rest.length}):`);
        for (const t of rest.slice(0, 8)) lines.push("  " + taskLine(t));
      } else if (!mine) {
        lines.push("(backlog empty)");
      }
      lines.push(mine
        ? "Report with /board note|log|attach|done|block. Attach reasoning/outputs so they show on the task page."
        : "This is a backlog, not a session log — only record OUTSTANDING work. Surface a new roadmap item with /board add <title>, or pick one up with /board claim <id>.");
      return { message: { customType: "board", attribution: "todo-board", display: "📋 board synced", content: [{ type: "text", text: lines.join("\n") }] } };
    } catch (e) { log("inject: " + e.message); }
  });

  // opt-in: auto-attach notable tool outputs — only when this session owns a task
  pi.on("tool_result", async (event, ctx) => {
    if (!AUTOCAP || event.isError) return;
    try {
      const st = await state(ctx);
      if (!st.taskId) return;
      const text = (event.content || []).filter((c) => c && c.type === "text").map((c) => c.text).join("\n");
      if (!text || text.length < CAP_MIN) return;
      const attach = await attachFn();
      attach(st.sess, st.taskId, "output", `${event.toolName} output`, { body: text, format: "text" });
    } catch (e) { log("autocap: " + e.message); }
  });
  // No shutdown mutation: the backlog is a curated list of outstanding items;
  // sessions never auto-close or auto-drop tasks. Resolve items deliberately
  // (/board done|block, or from the browser).

  // /board <sub> [args] — report + attach from inside a session
  pi.registerCommand("board", {
    description: "todo board: list|add|claim|note|log|attach|figure|status|task|done|block",
    handler: async (args, ctx) => {
      const say = async (t) => { try { await pi.sendMessage({ role: "user", content: [{ type: "text", text: t }] }); } catch {} };
      try {
        const st = await state(ctx);
        const { appendEvent, fold, readAllEvents, genId } = await lib();
        const parts = String(args || "").trim().split(/\s+/);
        const sub = parts.shift();
        const rest = parts.join(" ");
        const board = () => fold(readAllEvents());
        const needTask = () => { if (!st.taskId) { say("board: you don't own a task yet — /board add <title> to record a new item, or /board claim <id> to pick one up"); return true; } return false; };

        // list — always available (default action too)
        if (!sub || sub === "list") {
          const open = board().tasks.filter((t) => t.status !== "done" && t.status !== "dropped");
          return say("board (" + open.length + " open):\n" + (open.map(taskLine).join("\n") || "  (backlog empty)") + (st.taskId ? `\n(you = ${st.taskId})` : ""));
        }
        // add — record a new outstanding roadmap item and own it
        if (sub === "add") {
          const title = rest.trim();
          if (!title) return say("board: usage /board add <title>");
          const id = genId();
          appendEvent(st.sess, { op: "add", id, title, status: "todo", priority: 1, owner: st.sess });
          st.taskId = id;
          return say(`board: added ${id} — ${title}`);
        }
        // claim — take ownership of an existing item
        if (sub === "claim") {
          const id = rest.trim();
          if (!/^t_[a-z0-9]+$/.test(id)) return say("board: usage /board claim t_xxxxxxxx");
          if (!board().tasks.some((t) => t.id === id)) return say(`board: no such task ${id}`);
          st.taskId = id; appendEvent(st.sess, { op: "update", id, owner: st.sess, status: "doing" });
          return say(`board: claimed ${id}`);
        }
        // everything below mutates the session's own task
        if (needTask()) return;
        if (sub === "status" || ["todo", "doing", "blocked", "done"].includes(sub)) {
          const s = sub === "status" ? rest : sub;
          appendEvent(st.sess, { op: "update", id: st.taskId, status: s });
          return say(`board: status -> ${s}`);
        }
        if (sub === "done" || sub === "block") {
          appendEvent(st.sess, { op: "update", id: st.taskId, status: sub === "done" ? "done" : "blocked" });
          return say(`board: ${st.taskId} -> ${sub}`);
        }
        if (sub === "note") { appendEvent(st.sess, { op: "note", id: st.taskId, text: rest }); return say("board: note saved"); }
        if (sub === "log") { appendEvent(st.sess, { op: "log", id: st.taskId, text: rest }); return say("board: logged"); }
        if (sub === "task") { appendEvent(st.sess, { op: "update", id: st.taskId, title: rest }); return say(`board: title -> ${rest}`); }
        if (sub === "figure" || sub === "fig") {
          const sp = rest.indexOf(" ");
          const path = (sp < 0 ? rest : rest.slice(0, sp)).trim();
          const caption = sp < 0 ? "" : rest.slice(sp + 1).trim();
          if (!path) return say("board: usage /board figure <path.png> [caption]");
          const ex = (path.split(".").pop() || "").toLowerCase();
          if (!/^(png|webp|jpg|jpeg|gif|svg)$/.test(ex)) return say("board: /board figure needs an image (png/webp/jpg/gif/svg)");
          const attach = await attachFn();
          const { readFileSync } = await import("node:fs");
          const { art } = attach(st.sess, st.taskId, "figure", caption || basename(path), { bodyBuf: readFileSync(path), format: ex });
          return say(`board: figure ${art} attached — ${caption || basename(path)}`);
        }
        if (sub === "attach") {
          const [path, kind] = rest.split(/\s+/);
          if (!path) return say("board: usage /board attach <path> [kind]");
          const attach = await attachFn();
          const { readFileSync } = await import("node:fs");
          const ex = (path.split(".").pop() || "").toLowerCase();
          if (/^(png|webp|jpg|jpeg|gif|svg)$/.test(ex)) {
            const { art } = attach(st.sess, st.taskId, "figure", basename(path), { bodyBuf: readFileSync(path), format: ex });
            return say(`board: figure ${art} attached to ${st.taskId}`);
          }
          const body = readFileSync(path, "utf8");
          const fmt = /\.html?$/.test(path) ? "html" : /\.md$/.test(path) ? "md" : /\.json$/.test(path) ? "json" : "text";
          const { art } = attach(st.sess, st.taskId, kind || "output", basename(path), { body, format: fmt });
          return say(`board: attached ${art} to ${st.taskId}`);
        }
        return say(`board: unknown subcommand '${sub}' — try list|add|claim|note|log|attach|figure|status|task|done|block`);
      } catch (e) { return say("board error: " + e.message); }
    },
  });
}

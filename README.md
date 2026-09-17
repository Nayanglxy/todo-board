# todo-board

A single always-on **task board** that every [omp](https://github.com/) agent
session writes to, that you review/edit in a browser, and that each session reads
back. Event-sourced truth, one localhost server as the surface, one omp hook that
binds each session to a task.

Zero runtime dependencies — plain Node (`>=18`), no npm install.

See [`PLAN.md`](./PLAN.md) for the design rationale and [`DESIGN.md`](./DESIGN.md)
for the UI token/structure rules.

## Layout

```
lib.mjs             core: paths, appendEvent, readAllEvents, fold, genId
append.mjs          session write helper: add|update|note|drop
attach.mjs          attach an artifact (reasoning/output/log/html) to a task
server.mjs          the surface: localhost HTTP server + board app + task pages
show.mjs            headless terminal view (node show.mjs [--watch])
smoke.mjs           concurrency + fold + artifact regression test
session-parse.mjs   parse an omp .jsonl session into turns/tokens/compaction
session-render.mjs  render a parsed session to HTML (task detail view)
prompts.mjs         resume-prompt builders

hooks/pre/board.js  the omp session-binding hook (orchestration)
todo-board.service  systemd --user unit for the review server

events/             (gitignored) append-only event log, one file per session — truth
artifacts/          (gitignored) artifact bodies; pointers live in the event log
```

`events/` and `artifacts/` are **local runtime state** and are intentionally not
committed. They are created on first write.

## Run the server

```sh
node server.mjs                 # binds 127.0.0.1:8787 (TODO_BOARD_PORT overrides)
```

From your laptop, reach it over an SSH tunnel:

```sh
ssh -L 8787:localhost:8787 <box>   # then open http://localhost:8787
```

Security: binds loopback only; reachability is the SSH tunnel. HTML artifacts
render in a scripts-off sandboxed iframe (+ CSP, nosniff); artifact routes are
id-validated (no path traversal).

### Persist it (optional, systemd --user)

```sh
mkdir -p ~/.config/systemd/user
cp todo-board.service ~/.config/systemd/user/
# edit WorkingDirectory / ExecStart paths to match your checkout, then:
systemctl --user daemon-reload
systemctl --user enable --now todo-board
loginctl enable-linger "$USER"        # survive logout/reboot
journalctl --user -u todo-board -f
```

## Session write helpers

```sh
node append.mjs <sess> add    '{"title":"…","priority":2}'
node append.mjs <sess> update '{"id":"t_xxx","status":"doing"}'
node append.mjs <sess> note   '{"id":"t_xxx","text":"…"}'
node append.mjs <sess> drop   '{"id":"t_xxx"}'
some-output | node attach.mjs <sess> t_xxx reasoning "trace" --stdin
node attach.mjs <sess> t_xxx output "result" --file run.html
```

## The omp hook (orchestration)

`hooks/pre/board.js` binds each omp session to the board. Install it by copying
(or symlinking) into omp's pre-hook dir:

```sh
mkdir -p ~/.omp/agent/hooks/pre
ln -s "$PWD/hooks/pre/board.js" ~/.omp/agent/hooks/pre/board.js
```

Relevant env vars:

| var | meaning |
| --- | --- |
| `TODO_BOARD_PORT` | server port (default `8787`) |
| `TODO_BOARD_DIR` | relocate the data dir (`events/`, `artifacts/`) |
| `TODO_BOARD_CODE` | point the hook at the code dir if relocated |
| `TODO_BOARD_AUTOTASK` | `1` = register each session as its own task |
| `TODO_BOARD_AUTOCAP` | `1` = auto-attach notable tool outputs |
| `TODO_BOARD_AUTOCAP_MIN` | min chars to auto-capture (default `400`) |
| `OMP_BIN` | path to the `omp` binary (spawner) |

Every hook handler is wrapped so a board failure can never break a session.

## Test

```sh
node smoke.mjs      # concurrency + fold + artifact regression test
```

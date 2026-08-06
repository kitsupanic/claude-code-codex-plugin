---
name: codex-dispatch-runtime
description: Contract for dispatching long-running background Codex jobs with verbatim transport via the codex-dispatch runtime
user-invocable: false
---

# codex-dispatch runtime contract

Use this runtime when a session needs a **second opinion from a pinned frontier
model on a large standalone brief** — review, architecture, design, diagnosis —
and the answer is allowed to take minutes to half an hour. Do not use it for
quick interactive questions; that is what the official codex plugin is for.

Runtime: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" <verb>`

## The five invariants — never work around them

1. **Verbatim brief in.** The brief is a markdown FILE fed to `codex exec -` on
   stdin, byte-for-byte. Never inline a brief on a command line (Windows quoting
   mangles it) and never rewrite the brief on the way in.
2. **Pinned defaults, per-call overrides.** Defaults are explicit and recorded
   in `job.json`, and they ship budget on purpose: model `gpt-5.6-luna`,
   reasoning effort `medium`, so a fresh install cannot bill frontier prices by
   accident. Frontier is two flags away — `--model gpt-5.6-sol --effort xhigh`.
   If a dispatch is part of a contract that names a model (a second-opinion arm,
   say), pass `--model`/`--effort` explicitly rather than relying on whatever
   the runtime currently ships.
3. **Sandbox controlled.** Default `--sandbox read-only`. Only `--write` (maps to
   `workspace-write`) allows writes, and only when the task genuinely needs them.
   Review/architecture/design dispatches stay read-only, always.
4. **Verbatim answer out.** `result` prints the model's answer byte-for-byte.
   Never summarize, truncate, filter, re-rank, or reformat it — deliver it whole.
5. **No blind answers.** A codex whose sandbox cannot run commands sees no files
   and answers anyway, exiting 0. Preflight proves the sandbox works before
   dispatching and the runtime flags such a run `failed / sandbox-blind`
   afterwards. Never work around that flag by reading the out file yourself: a
   sourceless second opinion is worse than none.

## Verbs

- `dispatch --brief <file> [--role <stem>] [--cd <dir>] [--model <m>] [--effort <e>] [--write] [--force]`
  — returns immediately with `job: <id>`, `bin: <codex binary>` and `out: <path>`.
  Refuses if a job with the same role is still running; `--force` kills that
  job's tree first. `--role` must be lowercase letters only (`^[a-z]+$`).
- `status [<job-id>]` — state (running / done / failed / killed / stale /
  corrupt), a `reason:` line when there is one, runtime, log size, `out:` path.
- `result <job-id>` — the answer, verbatim, stdout only. Exits nonzero with the
  `out:` path if not done, and refuses a job flagged `sandbox-blind`.
- `cancel <job-id>` — taskkills the whole job tree, marks it killed.
- `list` — all jobs, newest first, one line each.
- `preflight` — checks codex is installed, authenticated, and that its sandbox
  can actually read a file; names which binary it chose.

## The out: fallback rule

Every dispatch/status output prints the literal absolute output-file path on its
own line as `out: <path>`. If a wake-up or notification is missed, that path is
the delivery channel: the file exists if and only if the run finished. Poll its
existence; read it directly if the runtime is somehow unavailable. Always
propagate the `out:` line when reporting job state to the user or to another
agent.

## Rules of engagement

- One dispatch per role at a time; pick distinct `--role` stems for parallel work.
- Never retry a dispatch without going through the runtime (`--force` or
  `cancel`) — it kills the previous process tree first. Launching codex directly
  alongside a running job double-bills.
- Preflight failures name the fix: `npm install -g @openai/codex` (not
  installed, or installed only as the desktop app, whose build cannot sandbox)
  or `codex login` (not authenticated — interactive browser OAuth, the human's
  to run; never script around it).
- A job that comes back `failed / sandbox-blind` was not a bad answer, it was no
  answer. Re-dispatch it once the preflight passes; do not relay it.

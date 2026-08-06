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
5. **No unproven answer without an explicit, recorded opt-in.** A codex whose
   sandbox cannot run commands sees no files and answers anyway, exiting 0. So
   before each job's codex is launched, the supervisor reads a file inside that
   job's own `--cd` through codex's sandbox and requires the bytes back. That proof
   is the deliverability gate:
   - **Proven** — `sight: cwd-file:<name>`. The job runs and delivers normally.
   - **Disproven** — the sandbox failed: `failed / sandbox-blind-precheck`, before
     anything is spent. `result` refuses it.
   - **Unprovable** — a codex with no `sandbox` subcommand, or a `--cd` with no
     readable file to prove a read against: `failed / sight-unproven`, also before
     anything is spent, also refused. This is NOT a defect to route around; it
     names its cure (usually `npm install -g @openai/codex`, or a `--cd` pointed at
     the directory the model actually has to read). Fix it and re-dispatch.
   - **Unprovable, accepted** — `--allow-unproven-sight` on the dispatch. Only then
     does an unprovable job run; the record carries
     `sight: unproven (accepted by caller)`, and `result` delivers the bytes with
     an `UNPROVEN SIGHT` caveat on stderr.

   Pass `--allow-unproven-sight` only when a human asked for it or the situation is
   understood and stated; never as a reflex to get past a refusal. If a dispatch is
   refused for unproven sight, **say so and name the cure** rather than retrying
   with the flag. And never work around any of this by reading the out file
   yourself: a sourceless second opinion is worse than none. When an answer does
   arrive carrying `UNPROVEN SIGHT` or a `warning:`, relay the answer AND the
   caveat — both, every time.

## Verbs

- `dispatch --brief <file> [--role <stem>] [--cd <dir>] [--model <m>] [--effort <e>] [--write] [--force] [--watch] [--allow-unproven-sight]`
  — returns immediately with `job: <id>`, `bin: <codex binary>` and `out: <path>`.
  Refuses if a job with the same role may still have live processes (running,
  stale, or kill-failed); `--force` kills that job's tree first **and verifies it
  died** — if anything survived, the new job is refused rather than launched
  beside it. `--role` must be lowercase letters only (`^[a-z]+$`), and the role is
  claimed atomically, so of two dispatches racing for one role exactly one wins.
  `--allow-unproven-sight` is invariant 5's opt-in; it is never a default and never
  a way around a refusal you have not read.
- `status [<job-id>]` — state (running / done / failed / killed / kill-failed /
  stale / corrupt), a `reason:` line when there is one, `sight:`, `warning:` and
  `survivors:` lines when they apply, runtime, log size, `out:` path.
- `result <job-id>` — the answer, verbatim, stdout only. **The record decides**:
  it prints only when the record says `done`. Every other state exits nonzero
  naming the state and the `out:` path — including a job whose answer file exists
  but whose run was never vouched for. An existing `out.txt` is bytes, not a
  verdict.
- `cancel <job-id>` — kills the whole job tree and checks it died. Survivors mean
  `kill-failed` (not `killed`), a nonzero exit, and the role stays blocked; a pid
  the OS refuses to answer about counts as a survivor, not as a death. On a job
  whose `job.json` is corrupt it reaps the pid files instead, preserves the record
  as evidence, and marks the spent pids so a second cancel replays nothing — that
  second cancel reports `already reaped` and changes nothing.
- `list` — all jobs, newest first, one line each.
- `watch <job-id>` — opens a console window that follows the job and shouts when
  it finishes. **For humans only** (see below).
- `preflight` — checks codex is installed, authenticated, and that its sandbox
  can actually read a file; names which binary it chose.

## The out: fallback rule

Every dispatch/status output prints the literal absolute output-file path on its
own line as `out: <path>`. If a wake-up or notification is missed, that path is
the last-resort delivery channel: read it directly if the runtime is somehow
unavailable. Always propagate the `out:` line when reporting job state to the user
or to another agent.

**Poll `result` (or `status`), not the file.** The out file appears the moment
codex writes it — before the exit code is recorded and before the sight verdict —
so its existence is not completion and never was a verdict. `result` exits nonzero
until the record says done, which is exactly the signal to wait on.

## Rules of engagement

- One dispatch per role at a time; pick distinct `--role` stems for parallel work.
- Never retry a dispatch without going through the runtime (`--force` or
  `cancel`) — it kills the previous process tree first. Launching codex directly
  alongside a running job double-bills.
- Preflight failures name the fix: `npm install -g @openai/codex` (not
  installed, or installed only as the desktop app, whose build cannot sandbox)
  or `codex login` (not authenticated — interactive browser OAuth, the human's
  to run; never script around it).
- **Watching is for humans; agents never watch.** `watch` exists for the operator
  who has been burned by dropped notifications. An agent gains nothing from a
  console window it cannot see and must never block on one — poll `result`, which
  exits nonzero until the record says done.
- A job that comes back `failed / sandbox-blind-precheck` or `failed /
  sight-unproven` was not a bad answer, it was no answer — codex never ran, and
  nothing was billed. Fix what the refusal names (`preflight` names the install
  half; a `--cd` with nothing readable in it is the other half) and re-dispatch.
  Do not relay it, do not read the out file in its place (there is none), and do
  not reach for `--allow-unproven-sight` to make the refusal go away.

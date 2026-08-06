# codex-dispatch

A Claude Code plugin + standalone job runtime that wraps the OpenAI Codex CLI
for **long-running, background, verbatim-transport dispatches**: a session sends
a large standalone brief to a pinned frontier model and gets the answer back
untouched, minutes to half an hour later, reliably, on Windows.

The runtime (`scripts/codex-dispatch.mjs`) is the product; the plugin is a thin
shell over it. Zero npm dependencies, Node 18+.

## Why it exists — the six invariants

The official `codex` plugin serves casual interactive reviews. This one serves
orchestrated second-opinion dispatches, which need six guarantees the official
plugin does not make:

1. **Verbatim brief in.** The brief is a markdown file fed to `codex exec -` on
   stdin, byte-for-byte. Never inlined on a command line — Windows quoting
   mangles large briefs (learned in production, not a preference).
2. **Model and effort are pinned, recorded, and cheap by default.** Every job
   records the exact model and effort it ran on in `job.json` — never "whatever
   the CLI felt like". What *ships* is the budget pair, `gpt-5.6-luna` at
   `medium` (via `-c model_reasoning_effort=...`), so a fresh install cannot
   bill frontier prices by accident. Frontier is two flags away:
   `--model gpt-5.6-sol --effort xhigh`.
3. **Sandbox controlled.** Default `--sandbox read-only`; write access only via
   an explicit `--write` flag. A review dispatch can never scribble on the
   target repo by accident.
4. **Verbatim answer out.** The result is the `--output-last-message` file,
   returned untouched. Nothing in this repo summarizes, truncates, or reformats
   a Codex answer.
5. **No unproven answer without an explicit, recorded opt-in.** A dispatch whose
   sandbox cannot read files produces a confident, sourceless answer and exits 0.
   So before each job's codex is launched, the supervisor runs a sandboxed read
   **in that job's own `--cd`** and requires bytes from *inside* the file to come
   back on stdout. That proof is the deliverability gate, not a label: no proof, no
   job. A sandbox that fails fails as `sandbox-blind-precheck`; a sandbox that
   *cannot be proven either way* — a CLI too old to have the subcommand, a cwd with
   nothing readable in it — is refused as `sight-unproven`, both before a single
   token is spent. The one way past it is `--allow-unproven-sight`, which runs the
   job, stamps `sight: unproven (accepted by caller)` **and `allowUnprovenSight:
   true`** on the record, and makes every `status` and every `result` say so. The
   after-the-fact log scan still runs, but it is a warning now, not a verdict —
   see "Proving sight" below.
6. **Deliverability is a versioned property of the record, and it is positive.**
   `result` does not ask "is there a reason to withhold this?" — it asks "does this
   record vouch for its run?", and refuses unless the answer is yes: this release's
   schema stamp (`recordVersion`), a zero exit, and either sight proven in the job's
   own cwd or the `--allow-unproven-sight` boolean written down by the dispatch that
   ran it. Records that predate the stamp are `unvouched`, named as such by `status`
   and `list`, and refused — because a record written under an older gate is not
   evidence that this gate was met. Consent is never inferred from a string.

## How this differs from `openai/codex-plugin-cc`

The [official OpenAI plugin](https://github.com/openai/codex-plugin-cc) and this
one drive the same CLI underneath and share no code — this is not a fork; it was
built clean-room against a written brief. What differs is the centre of gravity.
Theirs is interactive convenience: you are in a session, you want Codex's opinion
or want to hand it a task, and it is one command away. This one is orchestration
infrastructure: a long-running background dispatch that carries a large brief
verbatim to a pinned model, on Windows, and can be shown to have actually read
something.

|  | official `codex` plugin | this (`codex-dispatch`) |
| --- | --- | --- |
| **Brief transport** | codex's own reviewer (no brief), prompt templates with interpolated variables, optional focus text | a markdown file on `codex exec -` stdin, byte-for-byte; never inlined on a command line |
| **Model & effort** | deliberately unset — Codex's defaults, or your `config.toml` | explicit defaults, recorded in `job.json`; ships budget (`gpt-5.6-luna`, `medium`), frontier per call (`--model gpt-5.6-sol --effort xhigh`) |
| **Sandbox** | `read-only` for reviews; the rescue agent defaults to write-capable | `read-only` unless `--write`, plus a per-job positive sight proof in the job's own cwd before codex is launched |
| **Job model** | background jobs polled from the session via a companion app-server broker | detached supervisor, on-disk records, unique job dirs, atomic role claims, verified kill-before-retry, stale reaping, atomic type-checked records, whitelisted ids and roles proved inside the jobs root |
| **Hooks** | `SessionStart`/`SessionEnd` lifecycle, plus an opt-in stop-time review gate | none, ever — enforced by a test |
| **Footprint** | companion app-server, agents, skills, prompt templates, output schemas, 8 commands | one zero-dependency script, 6 commands, 1 skill |
| **Tests** | 8 test files, CI on every pull request | 70 tests — fake-codex lifecycle drills, the deliverability matrix, sight-gate and kill-verification drills, path-escape canaries, a concurrency race and a fenced-claim takeover, plus an opt-in live smoke |

Things the official plugin has that this one deliberately does not: the
`codex-rescue` subagent, `/codex:review`'s zero-brief native reviewer, the
adversarial-review framing, session-lifecycle integration and transfer of a
session into Codex, and OpenAI's own maintenance. This tool does one thing. For
interactive, user-fired reviews and for delegating a task from inside a session,
that plugin is the better instrument; use this one for orchestrated background
dispatches. Installing both is fine — separate marketplaces, separate plugin
names, `/codex:*` against `/codex-dispatch:*`.

The sharpest single difference is epistemic. Neither pipeline originally had a
concept of a *blind* success: a dispatch whose sandboxed tool calls all fail
still exits 0 and returns a fluent, plausible answer. The failure catalog below
records exactly that incident — a completed, billed, frontier-model review that
had never read a single file, and that was indistinguishable from a good one
until someone read the log. For a convenience tool that is an annoyance; for a
second opinion it is the entire product failing silently. So this runtime proves,
per job and in that job's own working directory, that the sandbox can read a file
— and refuses to print an answer whose record does not say it earned one.

## The failure catalog behind the design (2026-08-05/06, all seen in production)

- A foreground run under a 10-minute tool cap timed out and **orphaned the codex
  process** — it kept running, kept billing, and overwrote the retry's output.
  → There is no foreground mode. Dispatch always returns immediately with a job
  handle; a detached supervisor owns the run.
- A date-only filename was reused by a retry, so orphan and live run shared
  paths. → Every dispatch gets `<role>-<epoch-seconds>-<pid>/` — path reuse is
  impossible by construction.
- A retry launched while the first attempt was alive → two Codex instances,
  double billing. → Kill-before-retry is built in: `--force` and `cancel` run
  `taskkill /PID <pid> /T /F` on the recorded supervisor pid.
- Wake-up notifications dropped four times in one day, and status output that
  didn't name the output file forced filesystem hunts. → **Every dispatch/status
  output prints the literal absolute out-file path as `out: <path>`.** The
  deterministic path is the fallback delivery channel for *locating* an answer —
  never a done signal. The out file appears the instant codex writes it, which is
  before the exit code is recorded and before any sight verdict, so **the record is
  the done signal** and the file's existence says nothing. (That line used to say
  the opposite, which contradicted the record-authority rule two sections down;
  caught by the 0.3.0 dual review.)
- `codex` missing from PATH in shells started before install. → Preflight resolves
  `%APPDATA%\npm\codex.cmd` itself (see the resolution order below).
- Auth lapses silently. → Preflight runs `codex --version` and
  `codex login status` and names the exact fix for each failure.
- **A review dispatch came back as a real-looking answer that had read nothing.**
  Bare `codex` on PATH resolved to the *desktop-app* build
  (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`), which ships without the
  Windows sandbox helper executables. Every file read inside the job failed —
  `orchestrator_helper_launch_failed`, `helper=codex-windows-sandbox-setup.exe`,
  `CreateProcessWithLogonW failed: 2`, eleven times in one run.log — while codex
  **exited 0**, the job read `done`, and the out file politely asked for the source
  to be pasted in. A silent blind success: the worst possible failure for a
  second-opinion tool, because it looks exactly like a first opinion.
  → Binary resolution puts the npm build first and the desktop app last; and the
  supervisor now **proves** the sandbox can read a file in the job's own cwd
  before launching codex, rather than inferring blindness from the wreckage.
- **That scan then failed the first job that actually worked.** The end-to-end
  proof — "review `scripts/codex-dispatch.mjs`" — read the file successfully and
  echoed it into the log, and the file contains all four signature strings as
  literals. A substring scan makes a self-referential repo unreviewable, and does
  it by declaring a success a failure. Splitting stdout from stderr does not help
  either: `codex exec` puts its *whole transcript* — echoed file content included —
  on stderr, and only the final answer on stdout. → A hit only counts on a line
  codex itself emitted, matched by shape:
  `<rfc3339>Z ERROR codex_core::…:`. Verified offline against seven real job logs
  — four genuinely blind runs caught, three sighted ones (including the one that
  caused this) clean. That scan survives as a **warning**; it no longer decides
  anything, because a rule that can be fooled by a quotation should never have
  been the thing standing between a sourceless answer and the user.
- **The blind-success route was left open by good manners.** Once sight was proven
  per job, two cases still could not be proven *either way*: a codex too old to
  have the `sandbox` subcommand, and a cwd with no readable file to prove a read
  against. Refusing them looked like inventing a defect, so they ran, recorded
  `sight: unproven`, and were **delivered with a warning**. That is the same
  artifact the whole precheck exists to refuse — a fluent answer that never read
  anything — handed over with a caveat on stderr that a pipe swallows and a reader
  skims. → Deliverability requires proven sight. Unprovable is refused as
  `sight-unproven`, and `--allow-unproven-sight` is the only way past it: recorded
  on the job, printed by `dispatch`, `status` and `result`, and never a default.
- **Four pushes shipped as `0.1.0`.** The version in the manifests never moved, so
  `/plugin marketplace update kitsupanic` had nothing to install: every installed
  copy stayed on the first push while the repo moved four commits ahead, and
  nothing anywhere said so. → A push that changes behavior bumps the version. See
  "Releases and versioning" below; this release is `0.4.0`.

### The 0.3.0 dual review (2026-08-06) — two frontier arms, both "not ready"

`0.3.0` was reviewed by two frontier models working from the same standalone
brief, independently, neither seeing the other's answer: Claude Fable 5 at xhigh
and GPT-5.6-sol at xhigh. Both returned the same verdict — *not ready for public
use* — and both reproduced or traced what they found. What they disagreed about is
what makes the exercise worth recording: **they arrived at the same defect class
through different doors, and each found a critical one the other missed.**

- **Converged: untrusted strings became paths.** The Claude arm reproduced it from
  the claim side — a role lock's `owner` file containing `../not-a-job-dir` was
  joined to the jobs root, so a dispatch read pid files there, killed an unrelated
  process, wrote `reaped.pids` and renamed files outside the jobs root, and exited
  0 announcing *"reaped unvouched-for job"*. The Codex arm traced it from the
  record side — `validateRecord` type-checked `role` as a string but never applied
  `ROLE_RE`, so a corrupt record carrying `role: "..\\..\\victim"` flowed through
  `killJob` into `releaseRole`, which joins it, **renames that directory into the
  jobs root and then removes it recursively.** Same class, two entry points,
  neither visible from the other. → Both are now closed structurally: every value
  that becomes a path segment is whitelisted **by the function that reads it**, and
  every absolute path derived from one is proved to be inside the jobs root before
  anything is read, renamed, removed or killed. A violation is a refusal and a
  corrupt classification, never a best-effort guess.
- **Codex arm only: legacy records delivered silently.** `result` gated on
  `state === 'done'` and nothing else, so records written by 0.1/0.2 — which carry
  no `sight` at all, or the old `unproven`/`job-nonce` labels — were delivered the
  moment this runtime was installed over them. Worse, a 0.2 `unproven` record
  collected the *"the caller opted in with `--allow-unproven-sight`"* caveat, a
  claim of consent nobody had given, inferred from a word in a string. → Invariant
  6: deliverability is versioned and positive, and consent is a boolean the
  dispatch wrote, not a phrase in a label.
- **Codex arm only: cancel during supervisor registration.** Dispatch spawned the
  supervisor; the supervisor recorded its own pid a moment later. A `cancel` in
  that window found nothing to kill, "verified" the empty kill, marked the job
  `killed` and released the role — while the supervisor it never touched went on to
  launch codex, leaving a second same-role dispatch free to start beside it. Two
  billing codexes, from the one code path built to prevent exactly that. → The pid
  is knowable in the parent at spawn time, so dispatch records it before it
  returns; `launch` records the phase, so "nothing to kill" can be told apart from
  "nothing has been launched"; a kill inside the window becomes `kill-pending`
  rather than `killed`; and the supervisor re-checks its record and its claim
  immediately before exec.
- **Claude arm only: ANSI banner forgery (reproduced).** Codex's own error text
  lands in `job.json`'s `sight`/`warning`, and every verb printed those fields raw
  — `stripControlBytes` was applied only to tailed log bytes. A sandbox failure
  whose message carried an OSC title change, a screen clear and a cursor-home could
  therefore redraw the watcher's finished banner, which is the one line in this
  runtime meant to be believed from across the room. → Control bytes are stripped
  at the **write** boundary (they never enter a record) *and* at every print
  boundary (records written by older releases never went through the first one).
- **Claude arm only: the sight token was accepted from anywhere (reproduced).** The
  proof required the probe file's **first line** to appear anywhere in stdout *or*
  stderr — and the first line is exactly what a tool that never opened the file can
  produce: a header, or the file's own name echoed back off the command line. A
  stand-in that read nothing and echoed its argv earned `sight: cwd-file:…` and a
  `done` job. → The token now comes from **below** the first line, must be 12+
  printable ASCII characters, must be unrelated to the file's name, is asserted not
  to appear in the command being sent, and must come back **on stdout** — verified
  live against codex-cli 0.146.0, where `codex sandbox cmd /c type <file>` puts the
  sandboxed command's output on stdout and leaves stderr empty.
- Also from the Claude arm: POSIX kills never reached codex's descendants (no tree
  walk off Windows), a failed supervisor spawn left a job reading `running` forever
  with a refusal message claiming codex "may be billing" for a process that never
  existed, `SKILL.md`'s `out:` fallback licensed the workaround invariant 5 forbids,
  and `commands/list.md` documented a `failed(sandbox-blind)` reason 0.3.0 could not
  emit. All fixed in 0.4.0.

The lesson banked: **a single frontier reviewer is not a review of this class of
code.** Each arm's blind spot was invisible from inside that arm, and three of the
five findings above were found by exactly one of them.

## Install

This repo is its own marketplace: `.claude-plugin/marketplace.json` sits at the
root and lists one plugin with `"source": "./"`, so the repo root *is* the
plugin. Both install routes are therefore the same two commands, differing only
in what you hand to `marketplace add`.

**From GitHub:**

```
/plugin marketplace add kitsupanic/claude-code-codex-plugin
/plugin install codex-dispatch@kitsupanic
```

**From a local clone:**

```
/plugin marketplace add C:\path\to\claude-code-codex-plugin
/plugin install codex-dispatch@kitsupanic
```

Three names, three jobs, and they are deliberately different:

- **`claude-code-codex-plugin`** is the repo — a GitHub `owner/repo` slug or a
  local path. That is what `marketplace add` takes, and the only place it is used.
- **`kitsupanic`** is the marketplace — the `name` in `marketplace.json`. It is
  the catalog, not a plugin: it happens to hold one today and can hold more later.
- **`codex-dispatch`** is the plugin. So the install string is
  `codex-dispatch@kitsupanic` — `<plugin>@<marketplace>`.

Commands appear as `/codex-dispatch:dispatch`, `:status`, `:result`, `:cancel`,
`:list`, `:watch`. There are **no hooks** — this plugin never inserts itself into
a session's lifecycle.

Update after a push with `/plugin marketplace update kitsupanic`.

## Releases and versioning

**A push that changes behavior MUST bump the version**, in all three places that
carry it (`plugin.json`, and both `version` fields in `marketplace.json` — the
packaging test asserts they are identical, so they move together or the suite
goes red).

This is not bookkeeping. `marketplace update` compares versions: an installed
copy stays exactly where it is until the number moves, no matter how many commits
the repo is ahead. Four pushes shipped as `0.1.0` before anyone noticed that
every install was pinned to the first of them — the fix landed in the repo and
nowhere else, silently, which is the same shape of failure as a blind answer:
confident, and wrong in a way nothing surfaces.

Current release: **0.4.0** — the 0.3.0 dual review, fixed. Untrusted strings can no
longer become paths (claim owners and record roles are whitelisted where they are
read, and every derived path is proved inside the jobs root); deliverability is
versioned, so records from before the gate are `unvouched` and refused rather than
delivered; a cancel inside the supervisor's registration window is `kill-pending`,
not `killed`; control bytes never enter a record or a banner; the sight token comes
from inside the file and must return on stdout; POSIX kills reach the process
group. Behavioral, and deliberately so: **jobs dispatched by 0.1–0.3 will not be
delivered by `result` on this release** — their records cannot vouch for how they
ran. `result` names the reason and prints the `out:` path; read them by hand if you
trust them, or re-dispatch.

Previous: **0.3.0** — sight becomes a deliverability gate (unprovable is refused;
`--allow-unproven-sight` is the recorded opt-in), access-denied counts as alive,
role claims are fenced against a descheduled claimer, a reclaim from an
unvouched-for owner kills first, failed pid-file renames are surfaced, and the
watcher's banner tells the truth.

Before that: **0.2.0** — positive per-job sight proof, verified kills, atomic role
claims, record-authoritative delivery, consumed pid files, and the `watch` verb.

**As a bare runtime (no plugin system needed):**

```
node scripts/codex-dispatch.mjs <verb> [...]
```

Prerequisites: Node 18+, `npm install -g @openai/codex`, `codex login`.

## Verb reference

```
node scripts/codex-dispatch.mjs dispatch --brief review-brief.md --role review
  # → job: review-1785972364-11696
  #   bin: C:\Users\me\AppData\Roaming\npm\codex.cmd
  #   out: C:\Users\me\AppData\Local\codex-dispatch\jobs\review-1785972364-11696\out.txt

node scripts/codex-dispatch.mjs dispatch --brief b.md --role fix --cd D:\repo --write
node scripts/codex-dispatch.mjs dispatch --brief b.md --role review --model gpt-5.6-sol --effort xhigh
  # ↑ the frontier escalation. Without those two flags a dispatch runs on the
  #   shipped budget defaults: gpt-5.6-luna at medium effort.

node scripts/codex-dispatch.mjs dispatch --brief b.md --role review --watch
  # ↑ dispatch, then open a console window that follows it and shouts when done

node scripts/codex-dispatch.mjs dispatch --brief b.md --role review --allow-unproven-sight
  # ↑ the ONLY way to get an answer out of a job whose sight could not be proven.
  #   Without it such a job is refused; with it the record says so forever.

node scripts/codex-dispatch.mjs status            # all jobs
node scripts/codex-dispatch.mjs status <job-id>   # one job: state, sight, deliverability, warnings, runtime, log size, out path
  # sight: cwd-file:<name>            proven — a real file in the job's cwd was read back
  # sight: unproven (accepted by ...) ran only because --allow-unproven-sight was passed
  # (a job whose sight could be neither proven nor disproven, without that flag,
  #  never ran: state failed, reason sight-unproven)
  # deliverable: yes (...)            printed for finished jobs — what earned the delivery
  # deliverable: NO - unvouched: ...  the record cannot vouch for the run; result will refuse
node scripts/codex-dispatch.mjs result <job-id>   # the answer, verbatim, stdout only; nonzero + out: path unless the record says done AND vouches for it
node scripts/codex-dispatch.mjs cancel <job-id>   # kill the whole tree, verify it died, mark killed
node scripts/codex-dispatch.mjs list              # one line per job, newest first
node scripts/codex-dispatch.mjs watch <job-id>    # detached console window: tails run.log, then a JOB FINISHED banner
node scripts/codex-dispatch.mjs preflight         # install / auth / functional-sandbox check
  # → preflight: ok
  #   bin: C:\Users\me\AppData\Roaming\npm\codex.cmd
  #   version: codex-cli 0.146.0
  #   auth: Logged in using ChatGPT
  #   sandbox: functional (file reads work inside --sandbox read-only)
```

- `--role` must match `^[a-z]+$` and job ids are therefore `^[a-z]+-\d+-\d+$`;
  anything else is refused before it can become a path (see below).
- `dispatch` refuses if a job with the same `--role` is still `running`,
  `kill-pending`, `stale`, or `kill-failed` — the four states in which processes
  may still be alive. Stale means the supervisor died before an out file appeared,
  so codex was probably reparented and is still running and still billing;
  `kill-failed` means an earlier kill was attempted and *verified not to have
  worked*; `kill-pending` means a cancel arrived before there was anything to kill,
  so nothing died and nothing may assume it did. The refusal names which of the
  four it is. `--force` kills that job's tree first —
  including the recorded codex pid and any pids in the job dir's `child.pid` — and
  then **checks**: if anything survived, the new job is refused rather than
  launched alongside it.
- Jobs root: `%LOCALAPPDATA%\codex-dispatch\jobs\`, overridable via
  `CODEX_DISPATCH_JOBS`. Job records survive reboots; `list`/`status` mark jobs
  whose recorded pids no longer exist as `stale`.
- `CODEX_DISPATCH_BIN` overrides the codex binary (a `.mjs`/`.js` path is run
  via node — this is how the tests substitute a fake codex).

## Which codex binary — and proving it can see

Two codex builds can be installed at once, and they are not interchangeable for
this runtime. The npm build vendors the Windows sandbox helper executables; the
desktop-app build does not, and it is the one bare `codex` finds on PATH.

**Resolution order** (first that answers `--version` wins):

1. `CODEX_DISPATCH_BIN` — trusted, unchecked. That is its point.
2. `%APPDATA%\npm\codex.cmd` — the npm global install.
3. any other `codex.cmd` on PATH (`where codex.cmd`) — a different npm prefix.
4. bare `codex` on PATH.
5. `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` — the desktop app, **last**.

The desktop app is last rather than excluded: it is a working CLI for everything
except the sandbox, and if it is all a machine has, the preflight failure below
says so precisely instead of the runtime pretending nothing is installed.

**Install-level check (`preflight`).** Preflight writes a secret into a temp file
and runs `codex sandbox <cat that file>` — codex's own sandbox, no model, no
tokens, no billing, ~300 ms. It is `functional` only if the command exits 0 *and*
the secret comes back **on stdout**. The secret is deliberately not the file's name:
when it was (the nonce named the file and *was* its content), the name travelled on
the command line, so a binary that echoed its argv and opened nothing could return
it. A `broken` sandbox is a preflight **failure** (on Windows —
elsewhere a warning, since Windows is the platform this probe is verified on)
whose message names the resolved binary, the probe error, and the npm-vs-desktop
fix. If the CLI is too old to have a `sandbox` subcommand the probe reports
`unavailable` and preflight warns rather than fails.

Preflight says the *install* is capable. It does not say that this job, in this
directory, can see — which is the claim that actually matters.

## Proving sight, per job

Blindness used to be **inferred, after the fact, from four error strings**. That
is the wrong shape of evidence twice over:

- it can only recognise failures it has already met, so a new error shape passes
  as a success — silently, which is the exact failure mode being guarded against;
- it fires on failures codex *recovered from*, turning a good answer into a
  refusal.

So the verdict is now a **positive proof, run per job, in that job's own `--cd`**,
by the supervisor, immediately before codex is launched:

1. Pick a file that **already exists** in the job's cwd — first regular file by
   name, non-empty, under 1 MiB, yielding a verification token. Names carrying
   `%`, `^`, `&`, `!` or `"` are skipped rather than trusted to Windows quoting.
2. Run `codex sandbox cmd /c type <that file>` with the probe's own working
   directory set to the job's cwd.
3. The proof holds only if the command exits 0 **and the token comes back on
   stdout**.

**What the token is, is the whole proof.** It used to be the file's *first* line,
matched against stdout and stderr merged — and the first line is precisely what a
tool that never opened the file can produce: a header, a shebang, or the file's own
name echoed back off the command line it was handed. A stand-in that read nothing
and printed its argv earned `sight: cwd-file:…` and a `done` job (reproduced in
review, 2026-08-06). So the token now has to be content nobody can produce without
having read the file:

- it comes from **below the first line** — line 0 is never eligible;
- it is **12+ printable-ASCII characters** after trimming, capped at 60, so it is
  content rather than boilerplate;
- it must be **unrelated to the file's name** in either direction, since the name is
  the one part of this that travels on the command line;
- the runtime **asserts the token does not appear in the command it is about to
  send** — a property the picker already guarantees, checked again where the argv
  actually exists, because a property enforced only somewhere else is one refactor
  away from being enforced nowhere;
- and the match is on **stdout only**. Verified live against codex-cli 0.146.0:
  `codex sandbox cmd /c type <file>` puts the sandboxed command's output on stdout
  and leaves stderr empty. If the bytes turn up on stderr instead, that is reported
  as a broken probe naming exactly that, not quietly accepted.

A file that yields no such token is skipped and the next one is tried (up to 20);
a cwd where none does falls through to the job-nonce path below, which is not proof.

Nothing is ever written into the job's cwd — it is somebody's repository, possibly
read-only, possibly precious. If the cwd has no readable file at all (empty, or
all binary), the probe falls back to writing its nonce into the **job dir** and
reading that by absolute path, still from the job's cwd. That fallback still runs,
because it separates "the sandbox is broken" from "the cwd had nothing to read" —
but it **does not count as proof of sight**, and a job that gets no further than
it is refused like any other unproven job.

**A failed proof fails the job before codex spends anything**: state `failed`,
`reason: sandbox-blind-precheck`, the probe's own error text in `sight:`, and the
npm-vs-desktop fix printed into `run.log` and the supervisor's stderr. No tokens,
no billing, no invented answer to be tempted by. `result` refuses it and says why.

**A proof that cannot be run is refused too, and that is the deliberate part.**
Two situations end there: a codex too old to have the `sandbox` subcommand, and a
cwd with no readable file to prove a read against. Neither is a *broken* sandbox,
and for one release each ran anyway and delivered its answer with a `warning:`
attached — refusing them, the reasoning went, would be inventing a defect. That
reasoning was the hole. The artifact a blind job produces is a fluent answer that
never read anything, and handing one over with a caveat stapled to stderr is
delivering it: politeness reopened exactly the route the positive proof was built
to close. So an unprovable job is **refused** — state `failed`,
`reason: sight-unproven`, the cures named — and `result` refuses it too.

**`--allow-unproven-sight` is the way past, and it is a decision, not a default.**
Given that flag the job runs, the record carries
`sight: unproven (accepted by caller)` plus `allowUnprovenSight: true`, `dispatch`
says so on its own output, `status` prints both the sight line and the warning, and
`result` **delivers** — stdout stays the byte-verbatim answer, with the
`UNPROVEN SIGHT` caveat on stderr where a pipe will not swallow it. The caller
opted in knowingly; what they get is the transport they asked for plus a record
that will still say, months later, that nothing ever vouched for this one.

**The signature scan is now a warning.** When a job finishes, `run.log` is still
scanned for the four sandbox-failure signatures — but only on lines codex itself
emitted, identified by its tracing shape (`2026-…Z ERROR codex_core::exec: …`),
since the same strings appear as echoed file content and in this very README. A
hit no longer flips the state. It adds
`warning: sandbox-failure signatures in log (<signature>)` to the record, to
`status`, and to the `list` line, and `result` shouts it on stderr while stdout
stays byte-verbatim. Sight was proven up front; a post-hoc string match does not
get to overrule a proof.

## Corrupt records and job ids

- **`job.json` writes are atomic** (temp file + rename, with a short retry for the
  Windows replace-rename race). A half-written record is the corruption most
  likely to be self-inflicted.
- **A corrupt `job.json` cannot brick the runtime.** Reads return a corrupt marker
  instead of throwing: `list` and `status` render the job as `corrupt` and name the
  parse error, every other verb skips it, and `dispatch` is never blocked by one.
- **Corrupt means wrong-typed too, not just unparseable.** Parsing to an object is
  not enough — the verbs assume types (`allJobs` sorts on `started.localeCompare`,
  the supervisor hands `model`/`effort`/`sandbox`/`cwd`/`bin` to spawn), so a
  record with `"started": 12345` used to crash every listing verb, for every job.
  `readRecord` now type-checks the fields the verbs consume and returns the same
  marker, naming the field: `corrupt job.json (field "started" is not a string
  (number))`.
- **`cancel` on a corrupt job still reaps processes**, from the `supervisor.pid`,
  `codex.pid` and `child.pid` files the job dir carries alongside the record — and
  leaves the corrupt `job.json` byte-for-byte intact, because it is the evidence.
  Such a job therefore keeps reading as `corrupt` after cancellation.
- **A spent pid file is renamed, not left loaded.** After that reap, each consumed
  file becomes `<name>.pid.reaped-<timestamp>`. Pid numbers get reused, and a
  corrupt job cannot be marked `killed` (its record is evidence and stays
  untouched), so without this a second `cancel` would fire the same numbers again
  — at whatever process now owns them. A second cancel instead reports
  `already reaped: child.pid.reaped-…`, kills nothing, and changes nothing.
- **Job ids are whitelisted, not sanitized**: `^[a-z]+-\d+-\d+$`, checked before
  the id is ever joined into a path. Roles are `^[a-z]+$` for the same reason, and
  the collision suffix extends the pid digits (`…-4844` → `…-48441`) rather than
  adding a segment, so a generated id always satisfies the whitelist it will later
  be checked against.
- **And the whitelist is applied where the value is READ, not where it is used.**
  That sentence above was true of the id a *user types* and false of every other
  string that becomes a path — which is how both review arms found the same defect
  class from opposite ends (see the catalog above). Three strings become path
  segments, and each is now whitelisted by the function that reads it:
  - a role claim's `owner` file → `parseClaimOwner`, against `JOB_ID_RE`. An owner
    that is not a job id comes back classified `invalid`, never as a usable string,
    so `inspectClaim` reports a **corrupt claim** and the dispatch refuses, naming
    the owner file and leaving everything untouched.
  - a record's `role` and `id` → `validateRecord`, against `ROLE_RE`/`JOB_ID_RE`.
    A record carrying `role: "..\\..\\victim"` is **corrupt**, which is the
    containment every verb already implements, so it never reaches `releaseRole`.
  - a user-typed job id → `assertJobId`, as before.
- **Every derived absolute path is then proved to be inside the jobs root.**
  `isInsideRoot` resolves both sides and requires the relative path to be non-empty
  and not to start with `..`; `jobDirFor` combines it with the id whitelist, and
  `roleLockDir` with the role whitelist. Reads, renames, removals and kills all go
  through one of them. The two checks are deliberately separate rather than one
  clever one: the whitelist is what the paragraph above promises, and the
  containment assert is what still holds if a whitelist is ever loosened.

## The supervisor / job model

```
dispatch (returns immediately)
  ├─ claims the role: build .role-locks/.staging-…/ (owner file inside), then
  │    rename it onto .role-locks/<role>/   ← a failed rename = someone else has it
  │    └─ owner            the job id holding the claim
  ├─ creates <jobs-root>/<role>-<epoch>-<pid>/
  │    ├─ prompt.md        byte-copy of the brief
  │    ├─ job.json         recordVersion, role, model, effort, sandbox, cwd, pids,
  │    │                    state, launch phase, sight, allowUnprovenSight,
  │    │                    reapedPids, timestamps
  │    ├─ run.log          codex stdout+stderr — grows during the run (liveness signal);
  │    │                    the transcript, and what the signature scan warns from
  │    ├─ supervisor.log   supervisor diagnostics
  │    ├─ supervisor.pid   ┐ plain-text kill targets mirroring job.json, so a corrupt
  │    ├─ codex.pid        ┘ record still cannot orphan the process tree
  │    ├─ reaped.pids      pids already fired at, mirroring job.json's reapedPids, so a
  │    │                    corrupt record cannot cost us the anti-target either
  │    ├─ sight-probe.txt  only in job-nonce mode: the nonce the sandbox had to read back
  │    └─ out.txt          the verbatim answer — bytes, not a verdict (see below)
  ├─ re-reads the claim's owner  ← taken over while we were starting up? abort, remove the dir
  ├─ records launch: spawning   ← from here on a supervisor may exist
  └─ spawns (detached), THEN records its pid before returning
       supervisor  ← the kill target; taskkill /T /F here takes codex with it
         ├─ proves sight: codex sandbox cmd /c type <a file in the job's cwd>
         │    └─ not proven, and no --allow-unproven-sight? failed / sight-unproven, nothing spent
         ├─ re-checks: record still running? claim still ours?  ← else abort, nothing spent
         └─ codex exec - --cd <cwd> --sandbox <mode> --skip-git-repo-check
              --model <m> -c model_reasoning_effort=<e>
              --output-last-message out.txt --color never  < prompt.md > run.log 2>&1
```

The supervisor exists because a detached spawn cannot report an exit code: it
proves sight, runs codex to completion, then writes exit code, final state, and
finished timestamp into `job.json`. After dispatch returns, the supervisor is the
only writer of `job.json` (cancel excepted), so there are no write races.

**Dispatch records the supervisor's pid itself, at spawn time, before it returns.**
The supervisor used to write its own, which left a window — record says `running`,
nothing recorded to kill — in which a `cancel` killed nothing, called it verified,
marked the job `killed` and released the role while that supervisor went on to
launch codex. `child.pid` is knowable in the parent, so the window does not have to
exist. The `launch` field records the phase alongside it (`pending` → `spawning` →
`spawned`), which is what lets a kill tell "nothing has been launched yet" apart
from "something was launched and has not registered": the first is safe to take the
role from (that dispatch re-verifies its claim before spawning anything), the second
is not.

**States**: `running` → `done` | `failed` | `killed` | `kill-pending` |
`kill-failed`, plus two derived readings — `stale` (record says running, supervisor
pid is gone) and `corrupt` (the record cannot be trusted). `running`,
`kill-pending`, `stale` and `kill-failed` are the states in which processes may
still be alive, so those four block their role, are cancellable, and are what
`--force` must kill. `kill-pending` is what a cancel inside the registration window
produces: nothing was killed, so nothing may record a death — the job keeps its
role, `cancel` exits nonzero saying so, and a retry (once the supervisor has
registered, or once the window has passed and it provably never will) resolves it.

**The record is authoritative, and it has to vouch.** `result` prints only when the
record says `done` **and** `deliverability()` holds: this release's `recordVersion`
stamp, `exitCode: 0`, and either `sight: cwd-file:<name>` or the
`allowUnprovenSight: true` the dispatch wrote down. Every other case — a `stale` job
whose `out.txt` is sitting right there, a 0.2 record with no sight at all, a record
whose sight *says* it was accepted but that carries no recorded opt-in — exits
nonzero, names the reason, and names the `out:` path so the bytes remain reachable
by hand. `status` prints a `deliverable:` line for finished jobs and `list` tags
them `done(unvouched)`, so the refusal is never the first anyone hears of it. See
the decisions section for what this revoked and why.

**The role claim is atomic, and it is fenced.** The claim is a directory,
`<jobs-root>/.role-locks/<role>/`, but it is never built in place: a dispatch
assembles the whole claim — the directory with the `owner` file already inside it,
itself written temp-then-rename — somewhere else, and **renames it into position**.
Rename onto an existing non-empty directory fails on every platform this runs on,
so exactly one racer wins and the loser's failure is the answer, the way `EEXIST`
was before. The reason it is not a bare `mkdir` any more is the fence: mkdir then
write-owner left a window, and a claimer descheduled inside it could be reclaimed
and then wake up and write *its own* name back over the new owner's, leaving two
dispatches each able to read itself out of the lock.

The other half of the fence is on the way out. **Reclaiming renames the whole lock
directory to a tombstone** — atomic, so two reclaimers cannot both think they won
— and a dispatch **re-reads the owner immediately before it launches anything**.
A claim taken away underneath it is therefore detected, and the dispatch aborts as
`CLAIM LOST`, removing the job directory it had started to build rather than
launching a second codex beside the job that legitimately took over.

The claim is taken *before* the job directory exists, so a loser leaves nothing
behind, and it is released on a terminal state by the process that owns it — a
release checks the `owner` file first, so it can never hand away a claim it does
not hold. A claim whose owner is terminal, corrupt or gone is reclaimable; one
whose owner is still live needs `--force`; one under 15 seconds old with no
readable owner record is a dispatch mid-claim and is refused outright. The older
scan of every job's record survives as a backstop for jobs that predate claims or
whose claim was removed by hand.

**A reclaim kills before it takes.** An owner that cannot vouch for itself — a
corrupt record, or a job directory with no record at all — says *nothing* about
whether its processes are alive, which is not the same as saying they are dead.
Taking the role on that silence is how a second codex ends up running beside the
first. So that path now runs the same verified-kill discipline as a stale claim:
reap the owner's `.pid` files, verify the deaths, consume the spent files, and
only then take the role. Survivors refuse the takeover with the same
`REFUSING to launch` message `--force` uses, and the corrupt `job.json` is left
byte-for-byte, because it is evidence.

**Kills are verified.** `taskkill`'s exit code is not evidence — it reports
success for pids that never existed and failure for children the tree kill
already took. So after signalling, every targeted pid is re-checked with the same
liveness test the rest of the runtime uses, for up to 3 seconds. If anything
survives, the job becomes `kill-failed` (**not** `killed`), keeps its role claim,
lists the survivors in `status`, and makes `--force` refuse to launch a new job
beside it. A kill that cannot be shown to have worked is not a kill: the survivor
may be codex, and codex that is alive is codex that is billing.

**Off Windows, the tree is the process group.** `taskkill /T` walks the tree
itself and is the tested, first-class path; elsewhere there was no tree at all —
`killTree` signalled the two recorded pids and nothing else, so codex's own
sandbox children outlived a cancel. The supervisor and codex are now both spawned
detached on POSIX, which makes each of them a process-group leader, and the kill
signals the **group** (`kill(-pgid)`) before the bare pid. The group is what a
`/T` buys on Windows; signalling two numbers was never it.

**And "still alive" includes "the OS would not say".** The liveness test is
`process.kill(pid, 0)`, which raises `EPERM` — and the same code for Windows'
`ERROR_ACCESS_DENIED` — precisely when the process *exists* but this account may
not signal it: elevated, another user's, protected. Every exception used to read
as "dead", so that case reported a survived kill as a verified one. Only `ESRCH`
(no such process) now counts as death; everything else counts as alive, which errs
toward `kill-failed` and a refused dispatch rather than toward two codexes.

**A pid that has been fired at is never fired at again.** After a verified kill the
spent `.pid` files are renamed to `<name>.pid.reaped-<timestamp>`, and the numbers
are written down in two places — `reapedPids` in `job.json`, and a `reaped.pids`
sidecar for the jobs whose record must not be rewritten. The rename can fail (an
open handle, a read-only attribute, a permission that moved) and it used to fail
*silently*, which left the numbers loaded and the operator believing they were not.
Now a failed rename is reported on stderr and as a `warning:` on the record, and
the written-down list — not the file name — is what the next reap consults. Pid
numbers get reused; a replayed kill lands on whatever inherited them.

## Watching a job

```
node scripts/codex-dispatch.mjs watch <job-id>
node scripts/codex-dispatch.mjs dispatch --brief b.md --role review --watch
```

`watch` opens a **separate console window**, titled with the job id, which prints
the tail of `run.log`, follows it as it grows, and then — instead of tailing
silently forever — rings the bell and prints:

```
==================================================================
  JOB FINISHED - result is ready
==================================================================
  job:     review-1786031944-36232
  state:   done
  sight:   cwd-file:LICENSE
  out:     C:\...\jobs\review-1786031944-36232\out.txt
  collect: node "...\codex-dispatch.mjs" result review-1786031944-36232
==================================================================
```

The rationale is one line: wake-up notifications dropped four times in one day,
and a window that shouts is the one delivery channel that does not depend on
anything remembering to tell you. The window is detached — closing it does
nothing to the job, and the job finishing does not close it.

**The banner says what actually happened.** `JOB FINISHED - result is ready` is
printed for `done` and for nothing else; every other terminal state gets
`JOB ENDED - state: <state>` and a `next:` line that fits it — `result` will
refuse this one, these survivors are still alive and here is how to kill them,
nothing vouched for how this ended. A window that shouts is only worth having if
what it shouts is true, and the old banner cheerfully announced a ready result for
jobs whose answer `result` was about to refuse.

Two more things it now gets right. A record read as corrupt is **re-read** before
the watcher believes it: `job.json` is replaced by rename, a reader can land in the
gap, and treating the first unreadable read as the end killed the watcher on a
perfectly healthy job. And the tailed bytes are **stripped of terminal control
characters** before they reach the console — `run.log` is whatever codex printed,
including file contents and tool output it echoed, and an escape sequence in there
can retitle the window, clear the screen, or drive the cursor back over the banner
and rewrite it. Tab, newline and carriage return survive; C0 and C1 controls do not.

Finally, `watch` **checks that the window opened**. A detached spawn that fails is
silent, and the verb used to announce a window either way; now the launcher gets a
moment to fall over, and a spawn error or a nonzero exit is reported as a failure
naming `status` as the fallback. From `dispatch --watch` it is reported on stderr
without failing the dispatch — the job is already running and its handle already
printed; a window that would not open is not a reason to call that a failure.

**Agents never watch.** Watching is a human affordance; an agent that opens a
console window has bought nothing, and an agent that waits on one has blocked
itself on a window it cannot see. Agents poll `result`.

Spawning a detached console window is Windows-only in this release. Elsewhere the
verb says so and names the `tail -f` and `status` commands to use instead, rather
than opening nothing and claiming otherwise.

## Tests

```
node --test                            # everything: 70 tests (bare form — see below)
node --test tests/dispatch.test.mjs    # lifecycle, against a fake codex
node --test tests/packaging.test.mjs   # manifests, command frontmatter, no-hooks invariant
node --test tests/resolution.test.mjs  # binary resolution, sight-probe targeting, blind scan, whitelists, deliverability (imported, not spawned)
node tests/live-smoke.mjs              # one real cheap dispatch; skips loudly if codex absent/logged out
```

One of the 70 is skipped on Windows and runs on POSIX: the process-group kill has
no Windows analogue to assert (`taskkill /T` is the path there), so the *choice* of
targets is unit-tested on both platforms via `killPlan` and the kill itself is
integration-tested only where it applies.

**Invocation quirk:** `node --test tests/` fails on Node 24 — the directory
path is resolved as a module (`Cannot find module ...\tests`). Use the bare
`node --test` (from the repo root) or name the file. Bare discovery matches
`*.test.mjs`, so `tests/live-smoke.mjs` is never picked up by accident: the
naming, not a config file, is what keeps the real-billing smoke opt-in.

The fake codex (`tests/fake-codex.mjs`) serves both subcommands the runtime uses.
Its `exec` reads stdin, spawns a child process (so tree-kill is assertable),
sleeps, then writes the out file; its `sandbox` really runs the command it is
handed, so the sight proof is exercised end to end rather than stubbed. Knobs:
`FAKE_CODEX_BLIND=1` prints a real blind run's tracing lines and still exits 0;
`FAKE_CODEX_ECHO=1` prints the same signature strings the way a *sighted* job
that read this repo's source does — same stream, different line shape — so the
false positive that cost the first end-to-end run has a regression test;
`FAKE_CODEX_SANDBOX_BROKEN=1` fails the sandbox probe with an error string that
**matches no known signature**; `FAKE_CODEX_SANDBOX_UNAVAILABLE=1` is a codex too
old to have the subcommand; `FAKE_CODEX_SANDBOX_ARGV_ECHO=1` is the stand-in that
**reads nothing and echoes its own argv**, exiting 0 — the shape that beat the
first-line token; `FAKE_CODEX_SANDBOX_ANSI=1` fails with an error carrying terminal
control sequences and a forged `JOB FINISHED` banner, aimed at the record and at
the watcher's console.

The suite covers: job-dir uniqueness, refuse-then-force on same-role double
dispatch, two concurrent same-role dispatches where exactly one wins the claim and
the loser leaves no job dir, a claimer descheduled *after* winning the role
detecting the takeover and aborting as `CLAIM LOST`, a stale job blocking a
same-role dispatch, `--force` reaping a codex orphaned by a killed supervisor, a
kill that does not take becoming `kill-failed` and blocking `--force`, an
access-denied liveness probe counting as a survivor rather than a death, a
corrupt-owner claim being reaped-or-refused instead of launched beside, a spent
pid file whose rename fails being reported and still never replayed, not-ready
`result` behavior, `result` refusing a failed job whose `out.txt` exists and a
stale one that never got finalized, whole-tree cancel, stale-pid classification,
an *unrecognized* sandbox failure being caught by the precheck before codex runs
(with no out file, no exit code, and the brief never sent), a sighted job's
signature hits being a warning that still delivers verbatim bytes, a job that
merely echoes the signatures not even being warned about, a `sandbox`-less codex
being **refused** as `sight-unproven` and delivering only under
`--allow-unproven-sight` with the acceptance on the record, a cwd with nothing
readable being refused the same way, a corrupt `job.json` leaving every other verb
working, a *wrong-typed* `job.json` field being contained the same way rather than
crashing `list`/`status`/`dispatch`, `cancel` reaping a corrupt job's pids without
touching its record and renaming the spent pid files, a second cancel on that job
killing nothing and changing nothing, the watcher's banner telling the truth for
each terminal state, the watcher surviving a transiently corrupt record and ending
on a persistent one, terminal control bytes never reaching the console, `watch`
reporting a window that failed to open, traversal-shaped ids and roles being
refused, and the shipped defaults landing in `job.json` as the budget pair while
`--model`/`--effort` still override them — the last of those is a cost guard, not
a preference, so it is asserted rather than assumed.

The 0.4.0 additions are the review's findings turned into assertions, and seven of
the eight lifecycle ones were confirmed to **fail against 0.3.0** before the fixes
landed (the eighth pins an ordering that was already right):

- **the deliverability matrix** — one record per shape (unstamped with no sight,
  unstamped `unproven`, unstamped `job-nonce`, stamped with no sight, stamped
  `job-nonce`, stamped and proven, stamped with a recorded opt-in, the *forged*
  opt-in whose label says accepted but whose record carries no boolean, and a
  stamped record with a nonzero exit). Each asserts which deliver, that every
  refusal produces **zero stdout**, that the refusal names its reason, and that no
  refusal ever claims a caller consented;
- **`--allow-unproven-sight` does not rescue a DISPROVEN sandbox** — the opt-in is
  for sight that could not be established either way, never for one shown broken,
  so the check ordering is pinned: hoisting it fails the suite;
- **the two path-escape canaries** — a claim owner of `../<canary>` and a corrupt
  record whose `role` is `..\..\<canary>`, each with a live bystander process and a
  file outside the jobs root, asserting the refusal *and* that the process, the
  directory and its contents are untouched;
- **cancel inside the registration window** — `kill-pending` rather than `killed`,
  the role still blocked, `--force` still refused, and both resolutions (past the
  window, and a job that never spawned) landing on `killed`. Plus the structural
  half: a real dispatch's record names its supervisor pid the instant dispatch
  returns, with no polling, because there is no instant at which it does not;
- **control bytes reach neither a record nor a banner** — a sandbox failure carrying
  OSC/CSI sequences and a forged `JOB FINISHED`, asserting no ESC in `job.json`
  itself, none in `status`/`list`/`result`, and that the forged line never becomes
  the watcher's headline while its text still survives, defanged;
- **the sight proof rejects an argv-echo stand-in** — in a cwd built as the trap
  (the only file's first line is its own name, and the name is on the command
  line), asserting the job fails `sandbox-blind-precheck` *and* that the echo did
  return the old token, which bought it nothing.

**Five test-only knobs live in the runtime**, each standing in for a condition
that cannot be produced on demand in CI, on both platforms, from both shells. What
is under test in every case is the runtime's *decision*, never the mechanism that
would have caused the condition:

- `CODEX_DISPATCH_TEST_NOKILL=1` — `killTree` becomes a no-op: a kill that reports
  success and changes nothing (access denied, an elevated child, a process wedged
  in a driver).
- `CODEX_DISPATCH_TEST_EPERM=<pid[,pid]>` — the liveness probe answers as though
  the OS refused the query for those pids. Real elevation is not available to a
  test; the decision (access denied means alive) is.
- `CODEX_DISPATCH_TEST_RENAME_FAIL=<pid-file-name>` — consuming that spent pid file
  fails. Locking a file hard enough to block a rename is not portable; reporting
  the failure and surviving it is what matters.
- `CODEX_DISPATCH_TEST_CLAIM_PAUSE_MS=<ms>` — a dispatch is descheduled between
  winning the role claim and launching, which is the window the fence exists for.
- `CODEX_DISPATCH_TEST_WATCH_BIN=<exe>` — the watcher's console launcher is
  replaced, so a spawn that fails and a launcher that exits immediately can both be
  driven.

The suite also pins each dispatch's cwd to the repo root rather than inheriting the
runner's: a job's cwd is what sight is proven against, and a suite whose
deliverability depended on where `node --test` was typed would be testing the
tester.

`tests/resolution.test.mjs` imports the runtime instead of spawning it, which is
why the runtime only calls `main()` when it is the process entry point.

Live smoke verified 2026-08-06 against codex-cli 0.146.0: preflight, dispatch
with `--model gpt-5.3-codex-spark --effort low`, poll to done, byte-verbatim
`DISPATCH-OK` result. No drift from the pinned CLI contract observed. It pins
its model explicitly rather than riding the defaults, so it keeps exercising the
override path — and keeps costing the same — whatever the defaults later become.

End-to-end verified the same day, and it is the check that matters most: a
`--role reviewer` dispatch whose brief was one line — *"Review
scripts/codex-dispatch.mjs in this repo (top 3 defects, terse, line refs, do not
fix)"* — with the file itself never inlined. It came back `done` in 26s citing
`allJobs`, `effectiveState`/`pidAlive` and `cmdQuote` with line numbers: content
the brief did not contain, so the sandbox genuinely read the repo. The same
dispatch against the desktop-app binary (via `CODEX_DISPATCH_BIN`) came back
`failed / sandbox-blind`, which is the true positive that proves the detector is
not just always saying yes. (Under 0.2.0 that same run is caught earlier and
cheaper, by the precheck, and reads `failed / sandbox-blind-precheck`.)

## Known issues (found by review, accepted for now)

- **PID reuse can make a dead job read as `running`.** `pidAlive` asks the OS
  whether a pid number exists, not whether it is still *our* process — across a
  reboot or a long gap that number can belong to something unrelated, and the job
  then reads `running` (and blocks its role) instead of `stale`. A real fix needs
  the pid's start time compared against `started`. The same limitation is what
  kill verification rests on, so a survivor could in principle be a pid that was
  reused between the kill and the check; the timing makes that vanishingly
  unlikely, and the failure direction is safe (a spurious `kill-failed` refuses to
  launch, rather than launching a duplicate). Recorded rather than fixed. The
  reaped-pid list narrows the blast radius — a number already fired at is never
  fired at again — but it does not make the number identify a process.
- **Windows `shell: true` quoting is best-effort.** `codex.cmd` needs a shell, so
  `spawnCodex`/`runCodexSync` join argv into one command line with `cmdQuote`,
  which quotes and doubles `"` but does not escape what `cmd.exe` expands *after*
  quote stripping — `%VAR%` in particular, and `^` in some positions. Nothing
  reachable today goes near it (job paths are generated, and the brief is never
  inlined — invariant 1), but a `--cd`, `--model` or `--effort` value containing
  `%` or `^` could still be mangled or expanded.
- **The POSIX process-group kill is unit-tested everywhere and integration-tested
  only on POSIX.** `killPlan` pins the targets (`[-pid, pid]` off Windows,
  `taskkill /T /F` on it) as data, so the decision is asserted on both platforms;
  the drill that actually kills a grandchild through the group is skipped on
  Windows, which is where this repo's suite is run. Nothing here is verified on a
  real POSIX box yet — say so rather than imply otherwise.
- **A job whose supervisor is killed between `launch: 'spawning'` and its pid being
  recorded stays `kill-pending` until the 15-second window passes.** That is the
  safe direction — the role stays blocked, a retry resolves it — but it does mean a
  crashed dispatch can hold a role for 15 seconds longer than it used to.

## Decisions made during the build

Things the brief left open, decided here:

- **The shipped defaults are budget, not frontier** — `gpt-5.6-luna` at
  `medium`, where they were once `gpt-5.6-sol` at `xhigh`. Having *explicit,
  recorded* defaults is the structural difference from the official plugin,
  which leaves them deliberately unset; that is unchanged. What changed is the
  values, because a public repo whose defaults are the frontier pair bills
  frontier prices to anyone who clones it and dispatches once, for a decision
  they never made. Frontier is two flags away —
  `--model gpt-5.6-sol --effort xhigh` — and power users override per call.
  `medium` rather than `low` as the balanced public default: `low` is a
  smoke-test setting, and an answer too shallow to use is its own kind of waste.
  Orchestration consumers (anything dispatching on a contract — a second-opinion
  arm pinned to a particular model, say) should pass `--model`/`--effort`
  explicitly rather than inherit whatever this repo happens to ship.
  Verified live against codex-cli 0.146.0 on 2026-08-06: `gpt-5.6-luna`
  dispatched and answered verbatim in 4s, while the near-miss id `gpt-5.6-lua`
  failed the job with `Model metadata for 'gpt-5.6-lua' not found` plus a 400
  `The 'gpt-5.6-lua' model is not supported when using Codex with a ChatGPT
  account` — which is also the evidence that the CLI validates model ids rather
  than quietly accepting anything, so the accepted one is a real model.
- **`--write` maps to `--sandbox workspace-write`**, not `danger-full-access`.
  Escalating past workspace writes is out of scope for a dispatch runtime.
- **Default `--role` is `dispatch`** when none is given.
- **A `preflight` verb is exposed** (the brief only required preflight inside
  dispatch); the live smoke and humans both want it standalone.
- **`CODEX_DISPATCH_BIN` skips the version/auth/sandbox preflight.** The override
  is trusted by design — that is what makes it useful for tests and stand-ins.
  It is also the only way to deliberately dispatch on a blind binary, which is
  how the true-positive half of the detector gets tested.
- **The desktop-app build is last in the resolution order, not banned.** It is a
  perfectly good CLI for everything except the sandbox, and a machine that only
  has it deserves the preflight message rather than "codex not found".
- **The sandbox is proven with `codex sandbox <read a file>`, not a test
  dispatch.** No model, no tokens, no billing, ~300 ms, and it fails in the same
  plumbing the real jobs use. A model-call probe would have cost money to learn
  less. If the CLI has no `sandbox` subcommand the claim is `unproven` rather than
  broken — the two are genuinely different diagnoses, which is why the record and
  the messages still distinguish them. What is *not* different is what they buy:
  neither one is deliverable.
- **Sight is proven per job, in the job's cwd, by the supervisor — REPLACING the
  post-hoc signature scan as the verdict.** Preflight's probe runs wherever the
  launcher happens to be, which is not where the job runs; and inference from log
  signatures is negative evidence twice over — blind to error shapes it has not
  met (false negative, silently) and fooled by failures codex recovered from
  (false positive). A positive proof has neither failure mode: the bytes come back
  or the job does not run. The scan is kept as a `warning:`, because "something in
  the sandbox complained" is worth saying and is not worth overruling a proof
  with.
- **The precheck never writes into the job's cwd.** It reads a file that is
  already there. A `--cd` can be read-only, or precious, or under review; a
  runtime that drops scratch files into it is one nobody points at anything that
  matters. The nonce fallback writes into the *job* dir instead — and it is kept,
  even though it no longer proves sight, because it is what separates "the sandbox
  is broken" from "the cwd had nothing to read". Those are different problems with
  different cures, and the refusal message names the right one.
- **REVOKED: an unprovable sandbox used to deliver with a warning.** "Refusing
  every job on a CLI too old to have the subcommand would be inventing a defect"
  was the reasoning, and it is a good instinct pointed at the wrong risk. The
  defect being invented is a refusal the operator can see and fix in one command;
  the defect being tolerated is a sourceless answer that looks exactly like a
  sourced one. Politeness was the hole: a caveat on stderr is not a refusal, and
  the entire value of a second opinion is that something vouched for it. So sight
  is now a **deliverability gate**, not a label — `unproven` is refused — and
  `--allow-unproven-sight` moves the decision to the caller, where it can be made
  knowingly and is written into the record for whoever reads the answer later.
  The escape hatch is deliberately not a config setting or an environment
  variable: it is per-dispatch, so it cannot be turned on once and forgotten.
- **`EPERM` means alive, not dead.** The liveness probe treated every exception
  from `process.kill(pid, 0)` as "the process is gone", which inverts the single
  case where the answer matters most: `EPERM` (and Windows' access-denied, which
  surfaces the same way) is raised precisely when the process EXISTS and this
  account may not signal it — elevated, another user's, protected. That is exactly
  the shape a kill that did not take leaves behind, and reading it as death
  reported such a kill as verified, which is how a still-billing codex gets
  declared dead. Only `ESRCH` counts as death now; everything else counts as
  alive. The asymmetry is the point: guessing "alive" costs a refused dispatch,
  guessing "dead" costs two codex processes.
- **A claim is renamed into place, and re-verified before it is used.** `mkdir`
  alone won the race but left a fence to fall off between winning and recording
  the owner. The claim is now assembled complete elsewhere and moved in with one
  rename, reclaiming renames the whole lock directory away (atomically, so two
  reclaimers cannot both win), and a dispatch re-reads the owner immediately
  before spawning its supervisor. Everything before that read is reversible; a
  spawned supervisor is not, so that is where the check belongs.
- **A reclaim from an unvouched-for owner kills first.** A corrupt record was
  treated as permission to take the role, on the reasoning that a record which
  cannot be read cannot claim to be running. True — and it cannot claim not to be,
  either. Silence is not death, so the corrupt-owner path now reaps that job's pid
  files, verifies the deaths, and refuses the takeover if anything survives:
  the same discipline stale claims already got, for the same reason.
- **A failed pid-file rename is reported, and the numbers are written down.**
  Consuming a spent pid file has two halves, and only the visible one could fail.
  It failed silently, which is worse than failing loudly: the numbers stayed
  loaded *and* the operator had been told they were unloaded. Now the rename
  failure is a `warning:` on the record and a line on stderr, and the pids are
  recorded as reaped in `job.json` (`reapedPids`) plus a `reaped.pids` sidecar for
  the jobs whose record is evidence and must not be rewritten. The list is what
  the next reap consults, so a surviving pid file cannot resurrect a spent number.
  Consumption happens only after a *verified* kill: pids that survived are
  demonstrably still theirs, and still need firing at.
- **The finished banner states the terminal state, and only `done` is good news.**
  It announced `JOB FINISHED - result is ready` for every state, including jobs
  whose answer `result` was about to refuse — the same class of defect as every
  other one here, a claim made rather than a fact checked, and in the one place
  built to be believed from across the room. Alongside it: a corrupt read is
  re-read before it is believed (records are replaced by rename, and a reader can
  land in the gap), log bytes are stripped of terminal control characters before
  they reach a console (`run.log` is untrusted — it carries whatever codex echoed,
  and an escape sequence can rewrite the banner it sits above), and the window
  spawn is verified rather than assumed.
- **A failed precheck is fatal on every platform**, unlike preflight's broken-sandbox
  verdict, which stays fatal only on Windows. The two are different claims: the
  preflight probe is a general capability check on a platform where it has been
  verified, while the precheck is a direct, positive, per-job measurement — if the
  bytes of a file in this cwd do not come back, this job cannot see, and that is
  not a platform-specific conclusion.
- **Blind detection matches line shape, not substrings.** The signatures alone
  appear in this repo's own source, in the model's prose when it is blind, and in
  this README — the first end-to-end run was failed by its own success. Requiring
  codex's tracing prefix (`<rfc3339>Z ERROR codex_core::…:`) is what separates a
  diagnostic from a quotation. A job that reviews a file containing real codex
  error logs can still fool it; now that this is a warning rather than a verdict,
  the residual costs a spurious line of stderr instead of a refused answer.
- **A blind job keeps its out file.** `result` refuses to print it and says why,
  but nothing deletes or rewrites it — verbatim transport means the bytes stay
  available even when the runtime's judgement is that they are worthless. (A job
  failed by the *precheck* has no out file to keep: it never ran.)
- **Kills are verified, and an unverified kill is `kill-failed`, not `killed`.**
  `taskkill`'s result was previously discarded, which meant "killed" was a claim
  the runtime made about an action rather than a fact it had checked — and the
  whole point of the kill is that a surviving codex keeps billing. So every
  targeted pid is re-checked afterwards, survivors are recorded and printed, the
  role stays claimed, and `--force` refuses to launch beside them. Erring toward
  refusing is deliberate: the failure this runtime exists to prevent is two codex
  processes at once, not one dispatch too few.
- **The same-role guard is an atomic claim, not a scan.** Scan-then-create is a
  read followed by a write with a gap in between; two dispatches launched together
  both read an empty world and both proceed. `mkdir` is the one filesystem
  operation where exactly one racer can win, so the role is claimed by creating
  `<jobs-root>/.role-locks/<role>/` and EEXIST is the answer. The claim is taken
  before the job dir so a loser leaves nothing behind; it is released on terminal
  states by its owner only; a claim under 15 seconds old with no readable owner
  record is treated as a dispatch mid-claim and refused rather than stolen.
- **Consumed pid files are renamed, not deleted or left in place.** A corrupt job
  cannot be marked `killed` — its record is evidence and stays byte-for-byte — so
  nothing else would stop a second `cancel` from firing the same pid numbers at
  whatever has since inherited them. Renaming to `<name>.pid.reaped-<timestamp>`
  makes the reap non-repeatable while keeping it visible: the second cancel reports
  `already reaped` and touches nothing. Renaming rather than deleting because the
  numbers are part of the incident record.
- **Corrupt records are contained, not repaired.** `readRecord` returns a marker
  instead of throwing, so one bad `job.json` cannot brick `list`/`status`/
  `dispatch`; `cancel` still reaps pids from the pid files but leaves the corrupt
  file byte-for-byte, because a record that got corrupted once is evidence. The
  consequence is deliberate: such a job reads `corrupt` forever.
- **A wrong-typed field is corrupt, not coerced.** Validation could have coerced
  (`String(started)`) or defaulted, but a record whose `started` is a number was
  not written by this runtime, so nothing about it can be trusted enough to
  repair — which is precisely what the corrupt marker already means, and every
  verb already handles. So: a field present with the wrong type ⇒ corrupt, named.
  Absence is the other half of the choice, and it splits: `state` and `started`
  are required (there is no state machine without them), while the rest are
  tolerated when missing, because the verbs already treat them as unset and
  hand-written fixtures legitimately carry only part of the record.
- **Job ids are whitelisted rather than sanitized**, and roles are restricted to
  `^[a-z]+$` so that a generated id always satisfies the whitelist it will be
  checked against later. That is why the live smoke's role is `smoke` and no
  longer `live-smoke`, and why the collision suffix grows the pid digits instead
  of adding a fourth segment.
- **The runtime calls `main()` only when it is the entry point**, so tests can
  import its pure helpers. The check is case-insensitive on Windows: a
  differently-cased path must never silently turn the CLI into a no-op.
- **`dispatch` prints a `bin:` line.** Which codex a job runs on is exactly the
  thing that went wrong in production; it belongs in the handle, not in a log.
- **REVOKED: the supervisor used to record its own pid.** The reasoning was single
  writership — dispatch writes, then the supervisor owns the record — and it was
  right about writers and wrong about time. Between the spawn and that write the
  record said `running` with nothing recorded to kill, and a `cancel` landing there
  killed nothing, called the empty kill verified, marked the job `killed` and
  released the role, while the supervisor went on to launch codex and a second
  same-role dispatch became legal beside it. Two billing codexes, out of the code
  path built to prevent exactly that. The child's pid is knowable in the parent the
  moment `spawn` returns, so **dispatch records it before it returns**, and the
  supervisor writes it only if it finds a record that does not already name it —
  single writership preserved, window gone. The 15-second grace survives for
  records this release did not write.
- **The launch phase is written down rather than inferred.** "No supervisor pid"
  meant two opposite things: a dispatch that has not spawned anything (safe — its
  claim fence stops it launching if the role moves) and a supervisor that was
  spawned and has not registered (dangerous). `launch: 'pending' | 'spawning' |
  'spawned'` makes it a recorded fact. A kill with no target inside the dangerous
  phase yields `kill-pending`, not `killed`; in the safe phase, killing nothing IS
  the whole kill and the runtime says so honestly.
- **The supervisor re-checks its record and its claim immediately before exec.**
  Sight-proving takes a moment, and a cancel or a takeover can land in it. So the
  last thing before the spend is a re-read: the record must still say `running`
  (a `kill-pending` one is honoured — the supervisor marks it `killed` and releases
  the role, which is the cancel finally landing) and the role claim must still name
  this job (`claim-lost` otherwise, without releasing a claim that is somebody
  else's). Same principle as the dispatch-side fence, at the other end of the same
  gap: check where the irreversible thing happens.
- **Deliverability is versioned, and unstamped means unvouched.** Gating `result`
  on `state === 'done'` alone meant that installing this runtime over 0.1/0.2 job
  dirs delivered their answers immediately, under a gate those records were never
  written against — and a 0.2 record whose sight said `unproven` even collected the
  "the caller opted in" caveat, a consent claim inferred from a word in a string.
  So the record now carries `recordVersion`, written by the dispatch that ran the
  job, and delivery requires positive evidence: the stamp, a zero exit, and either
  proven sight or the `allowUnprovenSight` boolean that same dispatch wrote. The
  cost is real and accepted — **old jobs stop being deliverable when you upgrade** —
  and it is the right cost: the alternative is handing over answers whose provenance
  this release cannot speak to. The bytes are never hidden; the refusal names the
  reason and the `out:` path.
- **Untrusted strings are whitelisted at the READ boundary, and derived paths are
  proved inside the jobs root.** Both halves, because they fail differently. The
  whitelist is what makes the promise in "Corrupt records and job ids" true — the
  value never reaches a caller in a form that could be joined. The containment
  assert is what survives the whitelist being loosened one day by someone who does
  not know why it is narrow. A violation is a loud refusal plus a corrupt
  classification (`inspectClaim` → corrupt claim; `validateRecord` → corrupt
  record), never a best-effort attempt to do something sensible with it: a claim
  owner that is not a job id says nothing about what is running, and acting on that
  silence is what killed an unrelated process in review.
- **Control bytes are stripped at the write boundary AND at every print boundary.**
  Either alone leaves a route. Stripping only on the way out means a control byte
  lives in the record and every future reader must remember; stripping only on the
  way in leaves records written by older releases, or by hand, untouched. The write
  boundary is `writeRecord` (every string field), the print boundaries are `status`,
  `list`, `result`'s stderr, the watcher's banner and the refusal messages. The
  banner is the reason: it is the one line here meant to be believed from across
  the room, and an escape sequence in a `sight:` field could redraw it.
- **The sight token is content from inside the file, matched on stdout.** See
  "Proving sight" for the rules. The principle behind them: a proof must require
  something the prover could not have been *handed*. The first line of a file, and
  its name, are both things a tool that never opened it can produce — so neither can
  be the evidence.
- **REVOKED: `out.txt` existence used to override `job.json` state.** The original
  rule said that if the supervisor died after codex finished but before finalizing
  the record, the job should still read `done`, because the out file was the
  authoritative done signal. That is wrong in a way the acceptance run could not
  see: the answer file appears the moment codex writes it, which is *before* the
  exit code is recorded and *before* any sight verdict is reached — so there is a
  real window in which a job reads `done`, and `result` hands over bytes, while
  nothing has yet vouched for how the run ended. The delivery decision now belongs
  to the record alone: `done` requires the record to say `done` (exit code
  recorded, sight resolved), `status` never promotes on file existence, and
  `result` refuses `failed`/`killed`/`kill-failed`/`stale`/`corrupt` even when the
  file is sitting right there. What is lost is a convenience — an unfinalized run
  now reads `stale` instead of `done` — and what is bought is that every answer
  this runtime prints has a record behind it. The bytes are never hidden: the
  refusal names the state and prints the `out:` path, so a human who wants to read
  an unvouched-for answer can, deliberately, by hand.
- **The `watch` verb spawns a window; it does not tail in-process.** A tail that
  blocks the caller is useless to the two things that actually need it — a slash
  command, and a human who wants to keep working — and a tail that ends silently
  is how a finished job goes unnoticed. So `watch` returns immediately and the
  following happens in a detached console titled with the job id, which ends on a
  banner rather than on nothing. Windows-only in this release, and it says so
  elsewhere rather than pretending: a fake window is worse than no window.
- **Effort is passed as `-c model_reasoning_effort=<effort>`** (no embedded
  quotes): that is the argv the verified production contract actually delivered
  after shell quote-stripping.
- **`result` prints the answer to stdout only; all diagnostics go to stderr**,
  so stdout is pipe-safe verbatim bytes.
- **REVISED: the non-Windows fallback kills the process GROUP, not two pids.** It
  used to signal the supervisor and codex pids directly and call that a tree kill,
  which it never was — codex's own sandbox children are its descendants, not ours,
  and they outlived every cancel off Windows. The supervisor and codex are now
  spawned detached there, making each a group leader, and the kill signals
  `-pgid` before the bare pid. Windows (`taskkill /T /F`) remains the tested,
  first-class path; `killPlan` states both choices as data so the decision is
  asserted on either platform.
- **Jobs root on non-Windows** falls back to `~/.local/share/codex-dispatch/jobs`.
- **Live smoke tolerates a trailing newline** when comparing `DISPATCH-OK` —
  the transported bytes are still untouched; only the assertion trims.
- **No `package.json`**: zero dependencies and no build step; tests run by path.
- **A `marketplace.json` is included** so a local clone is directly installable
  with `/plugin marketplace add <path>`.
- **The plugin lives at the repo root, not under `plugins/<name>/`.** The
  official OpenAI plugin nests its plugin one level down because its marketplace
  is built to carry several; the loader does not require it. Community
  single-plugin marketplaces such as `i-have-adhd` and `ponytail` use exactly
  this repo's shape — `.claude-plugin/{marketplace,plugin}.json` at the root,
  `"source": "./"` — and install from GitHub. Root layout also keeps
  `node scripts/codex-dispatch.mjs` working from the repo root, which the bare
  runtime documents.
- **`marketplace.json` carries both a top-level `description` and
  `metadata.description`.** Anthropic's own marketplace and the community ones
  surveyed use the top-level field; the OpenAI plugin uses `metadata`.
  Populating both costs a duplicated line and removes the guess.
- **`tests/packaging.test.mjs` asserts the manifests rather than trusting
  them** — version identical in the three places that carry it, `source: "./"`
  resolving to a real `plugin.json`, required frontmatter on all six commands
  and the skill, and no `hooks/` directory. A broken manifest makes the plugin
  silently uninstallable, and no other test in this repo would notice.
- **`supervisor.log` and (in tests) `child.pid` live in the job dir** alongside
  the three brief-mandated files; extra diagnostics, same lifecycle.
- **A behavior-changing push bumps the version.** Not a convention — a delivery
  mechanism. `marketplace update` installs nothing until the number moves, so an
  unbumped push is a fix that exists only in the repo. See "Releases and
  versioning"; the packaging test keeps the three copies of the number honest,
  which is what makes the rule cheap to follow.

## Contributing

Zero runtime dependencies and no build step: clone it and run `node --test`.
Every constraint in the runtime traces to an entry in the failure catalog above
— if a change relaxes one, say which failure it is no longer guarding against.

## License

MIT — see [LICENSE](LICENSE).

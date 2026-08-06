# codex-dispatch

A Claude Code plugin + standalone job runtime that wraps the OpenAI Codex CLI
for **long-running, background, verbatim-transport dispatches**: a session sends
a large standalone brief to a pinned frontier model and gets the answer back
untouched, minutes to half an hour later, reliably, on Windows.

The runtime (`scripts/codex-dispatch.mjs`) is the product; the plugin is a thin
shell over it. Zero npm dependencies, Node 18+.

## Why it exists — the seven invariants

The official `codex` plugin serves casual interactive reviews. This one serves
orchestrated second-opinion dispatches, which need seven guarantees the official
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
7. **One validator stands in front of every ownership, kill and delivery decision,
   and it fails closed.** The record is a plain file: anything can write it, and
   what it says decides who owns a role, what gets signalled, and whose bytes go
   out. So its fields are checked for MEANING, not just for type, in one place —
   and every value outside its domain resolves to the reading that costs a refused
   dispatch rather than the one that costs a second billing codex. See "The
   validator" below.

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
| **Tests** | 8 test files, CI on every pull request | 99 tests — fake-codex lifecycle drills, the deliverability matrix, sight-gate and kill-verification drills, path-escape canaries, a concurrency race and a fenced-claim takeover, plus an opt-in live smoke |

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


The production failures and the review rounds that shaped this design are
recorded in [docs/REVIEWS.md](docs/REVIEWS.md); the decisions made during the
build — including the revoked ones — in [docs/DECISIONS.md](docs/DECISIONS.md).

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

Current release: **0.6.0** — the post-0.5.0 review, fixed. The POSIX sight
probe quotes its filename for `sh` and skips names carrying shell-expansion
characters, so a hostile name in a probed cwd cannot run anything; a recorded
pid the OS has reissued is identified by its start time (`pidStarts`) and is
neither read as alive nor fired at, which is what stops a stale job's kill from
landing on an innocent process; the supervisor's exit-time record write carries
the same only-if-still-running precondition as every other racy write; and
`reaped.pids` is written atomically, like the record it exists to outlive.
`RECORD_VERSION` does not move: 0.5.0 records remain deliverable.

Previous: **0.5.0** — the 0.4.0 dual review, fixed, around the one change
both arms prescribed: **a version-aware, fail-closed semantic validator in front of
every ownership, kill and delivery decision** (see "The validator"). Out of it fall
the specifics: an unrecognised state is `unknown` — live, role-blocking,
undeliverable — instead of quietly terminal; a pid outside the pid domain is
corruption rather than a signal target; a `sight` that merely starts with the proof
prefix is corruption rather than proof; and `_supervise` asserts the schema version
of the record it picked up rather than trusting the stamp the dispatch wrote.
Alongside it: kills record and verify the **actual** codex process rather than the
cmd.exe wrapper Windows hands back, and walk the process tree; a cancel inside the
codex-exec window is `kill-pending`, never `killed`; a corrupt record blocks its
role until its pids are proven dead, and the corrupt-claim message no longer opens
by telling you to delete the guard; containment is proved against the real path, so
a junction cannot redirect a read, a rename or a kill; claim reclaim and release are
conditional on the owner that was inspected; record writes are serialized and a lost
write is reported; the dispatch catch-all finalizes its record instead of leaving a
ghost; the watcher keeps watching live states; and a sight probe that could not be
*run* is `sight-probe-error`, not a finding of blindness.

`RECORD_VERSION` moves to **2**, and that is behavioral and deliberate: **jobs
dispatched by 0.1–0.4 will not be delivered by `result` on this release** — their
records were written by a gate that read fields instead of validating them, so they
are not evidence that this gate was met. `result` names the reason and prints the
`out:` path; read them by hand if you trust them, or re-dispatch.

Previous: **0.4.0** — the 0.3.0 dual review, fixed. Untrusted strings can no
longer become paths (claim owners and record roles are whitelisted where they are
read, and every derived path is proved inside the jobs root); deliverability is
versioned; a cancel inside the supervisor's registration window is `kill-pending`,
not `killed`; control bytes never enter a record or a banner; the sight token comes
from inside the file and must return on stdout; POSIX kills reach the process group.

Before that: **0.3.0** — sight becomes a deliverability gate (unprovable is refused;
`--allow-unproven-sight` is the recorded opt-in), access-denied counts as alive,
role claims are fenced against a descheduled claimer, a reclaim from an
unvouched-for owner kills first, failed pid-file renames are surfaced, and the
watcher's banner tells the truth.

And **0.2.0** — positive per-job sight proof, verified kills, atomic role
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
  #  never ran: state failed, reason sight-unproven — or sight-probe-error when the
  #  probe could not be RUN at all, which is a transport failure, not blindness)
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
  `kill-pending`, `stale`, `kill-failed` or `unknown` — the five states in which
  processes may still be alive. Stale means the supervisor died before an out file
  appeared, so codex was probably reparented and is still running and still billing;
  `kill-failed` means an earlier kill was attempted and *verified not to have
  worked*; `kill-pending` means a cancel arrived inside one of the two registration
  windows, so nothing died and nothing may assume it did; `unknown` means the
  record's state is not one this release writes, so nothing about the job can be
  concluded at all. A **corrupt** record blocks too, until its recorded pids are
  proven dead. The refusal names which it is. `--force` kills that job's tree first
  — the recorded supervisor and codex pids, every pid resolved behind a shell
  wrapper, anything in the job dir's `.pid` files, and every live descendant of
  those — and then **checks**: if anything survived, the new job is refused rather
  than launched alongside it.
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

## The validator — one gate, version-aware, fail-closed

`job.json` is a plain file. Anything can write it, and what it says decides three
things that cost money to get wrong: **who owns a role**, **what gets signalled**,
and **whose bytes go out**. Until 0.5.0 those decisions read the record's fields
directly and checked their *types*; both review arms, independently, said the same
thing about that, and prescribed the same cure. So every one of those decisions now
goes through one validator, and the validator checks **meaning**.

The rule it applies everywhere: **a value outside its domain resolves to the
reading that costs a refused dispatch, never to the one that costs a second billing
codex or an unvouched-for answer.** That is what "fail closed" means here, and it
is worth spelling out per field, because the safe direction is different for each:

| field | domain | what an out-of-domain value becomes |
| --- | --- | --- |
| `state` | `running`, `done`, `failed`, `killed`, `kill-pending`, `kill-failed` | **`unknown`** — live and unvouched. It blocks its role, it is cancellable, it never delivers. NOT "some other terminal state": a state this release cannot reason about says nothing about what the job owns. `stale` and `corrupt` are *derived* readings and are not writable — a record claiming one is claiming a conclusion only the runtime may reach. |
| `launch` | `pending`, `spawning`, `spawned`, `exec-spawning`, `exec` | **`exec-spawning`**, the most dangerous phase: codex may be alive and unrecorded, so a kill there may not record a death. Absent means the record predates the field (0.3 and earlier) and gets the older, time-boxed reading. |
| `supervisorPid`, `codexPid`, `codexPgid`, and every entry of `codexPids`/`reapedPids` | integers `1 … 4294967295` | **corrupt**. Zero and negatives are the point: `killPlan(-1)` off Windows expanded to `kill(-1)` — every process this account may signal — after `kill(1)`. A machine-wide kill out of one bad field. `killPlan` refuses out-of-domain pids as well, so the domain holds even where a number did not come from a record. |
| `sight` | exactly `cwd-file:<file name>`, or exactly `unproven (accepted by caller)` | **corrupt** when it claims the `cwd-file:` prefix and is not a proof. `sight: "cwd-file:"` used to satisfy the delivery gate, because the gate was `startsWith`. So did `cwd-file:a.txt FAILED: …` — which is what the supervisor itself wrote for a read it had just *disproven*. A file name is non-empty, has no path separator and no `:`, is not `.` or `..`, and does not lead or trail whitespace; a disproven read now writes `FAILED cwd-file:<name>: …`, which cannot be mistaken for one. |
| `recordVersion` | exactly the running `RECORD_VERSION` | **unvouched** for delivery — and, in `_supervise`, a refusal to run at all (`record-version-mismatch`). Dispatch and the supervisor are separate processes and can be different installed copies: an older supervisor picking up a newer record applies its own, weaker proof, and the job then delivers on the stamp the *dispatch* wrote. The stamp has to mean "this whole run met this gate", so the half that spends money checks it too. |
| `role`, `id` | `^[a-z]+$` / `^[a-z]+-\d+-\d+$` | **corrupt** (unchanged from 0.4.0 — these are the strings that become paths). |
| `exitCode` | any integer, `0` to deliver | not deliverable. The one number that is legitimately negative: `-1` means it never ran. |
| `generation` | non-negative integer | corrupt. Bumped by every write; see the write lock below. |

Two things sit alongside the field table because they are the same idea applied to
the filesystem rather than to the record:

- **A job directory is proved to be a real directory, inside the real jobs root.**
  Lexical containment is not containment: `path.resolve` collapses `..` and knows
  nothing about reparse points, so a junction named `review-1-2` inside the jobs
  root passed every check and then redirected everything through it. Containment is
  now proved against `fs.realpathSync.native`, links are refused rather than
  followed, and the listing walk renders one as `corrupt` instead of reading
  through it.
- **A corrupt record blocks its role until its processes are proven dead.** It
  cannot claim to be running; it cannot claim not to be either. Its role comes from
  the *directory name* — the one statement about a job that survives its record
  being unreadable — and the role changes hands only after the same verified reap
  the claim side has always run.

## Corrupt records and job ids

- **`job.json` writes are atomic** (temp file + rename, with a short retry for the
  Windows replace-rename race). A half-written record is the corruption most
  likely to be self-inflicted.
- **A corrupt `job.json` cannot brick the runtime.** Reads return a corrupt marker
  instead of throwing: `list` and `status` render the job as `corrupt` and name the
  parse error, and no verb ever crashes on one.
- **REVISED: a corrupt record now BLOCKS its role, until its pids are proven dead.**
  This used to say `dispatch` is never blocked by one, on the reasoning that a
  record which cannot be read cannot claim to be running. It cannot claim not to be
  either, and the reproduction is unambiguous: with the role lock removed, two
  codexes ran under one role. The job's role comes from its **directory name** —
  the one statement about it that survives an unreadable record — and the role
  changes hands only after the same verified reap the claim side runs: kill the pid
  files, confirm the deaths, then take it. Survivors refuse the dispatch. Nothing
  about this rewrites the corrupt record; it is still evidence, still byte-for-byte.
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
  class from opposite ends (see [docs/REVIEWS.md](docs/REVIEWS.md)). Three strings become path
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
  │    ├─ job.json         recordVersion, generation, role, model, effort, sandbox,
  │    │                    cwd, supervisorPid, codexPid, codexPids, codexPgid,
  │    │                    state, launch phase, sight, allowUnprovenSight,
  │    │                    reapedPids, timestamps
  │    ├─ job.json.lock     held for the read-and-write of a record update; one writer
  │    ├─ run.log          codex stdout+stderr — grows during the run (liveness signal);
  │    │                    the transcript, and what the signature scan warns from
  │    ├─ supervisor.log   supervisor diagnostics
  │    ├─ supervisor.pid   ┐ plain-text kill targets mirroring job.json, so a corrupt
  │    ├─ codex.pid        ┘ record still cannot orphan the process tree (this one
  │    │                    carries the wrapper AND the real worker behind it)
  │    ├─ reaped.pids      pids already fired at, mirroring job.json's reapedPids, so a
  │    │                    corrupt record cannot cost us the anti-target either
  │    ├─ sight-probe.txt  only in job-nonce mode: the nonce the sandbox had to read back
  │    └─ out.txt          the verbatim answer — bytes, not a verdict (see below)
  ├─ re-reads the claim's owner  ← taken over while we were starting up? abort, remove the dir
  ├─ records launch: spawning   ← from here on a supervisor may exist
  ├─ spawns (detached), THEN records its pid before returning
  └─ re-reads the record  ← cancelled while we were spawning? kill it, verify, refuse
       supervisor  ← the kill target; taskkill /T /F here takes codex with it
         ├─ asserts recordVersion == this release's ← else failed / record-version-mismatch
         ├─ proves sight: codex sandbox cmd /c type <a file in the job's cwd>
         │    ├─ not proven, no --allow-unproven-sight? failed / sight-unproven, nothing spent
         │    └─ probe would not RUN (after retries)?  failed / sight-probe-error — NOT blindness
         ├─ re-checks: record still running? claim still ours?  ← else abort, nothing spent
         ├─ records launch: exec-spawning  ← the SECOND window opens; a cancel landing
         │                                   here kills NOTHING and records kill-pending
         ├─ codex exec - --cd <cwd> --sandbox <mode> --skip-git-repo-check
         │    --model <m> -c model_reasoning_effort=<e>
         │    --output-last-message out.txt --color never  < prompt.md > run.log 2>&1
         ├─ resolves what it ACTUALLY spawned (the worker behind a .cmd wrapper) and
         │    records codexPids / codexPgid, launch: exec   ← the window closes
         └─ re-reads the record ← kill-pending? kill codex, verify, killed/cancelled-during-exec
```

The supervisor exists because a detached spawn cannot report an exit code: it
proves sight, runs codex to completion, then writes exit code, final state, and
finished timestamp into `job.json`.

**There ARE write races, and they are serialized rather than wished away.** This
paragraph used to say that after dispatch returns the supervisor is the only writer
(cancel excepted), so there were none. That was already false when 0.4.0 shipped:
closing the supervisor registration window moved dispatch's `{supervisorPid,
launch}` write to *after* the spawn, which put it in the same window a `cancel`
writes in. `updateRecord` is a read-modify-write, so two interleavings were
reachable — cancel's `kill-pending` lost to dispatch's later write, and, worse,
cancel taking the honest nothing-to-kill path and recording `killed` only for
dispatch to put `running` back. The operator was told the job was killed, the role
was released, and codex ran.

So every record update takes a lock first — `job.json.lock`, a directory, the same
atomic primitive the role claim uses — and does its read and its write inside it.
A holder that died is broken out of after five seconds, so a crash cannot wedge a
job. Each write bumps a `generation` counter, and callers may pass a precondition
that is evaluated *inside* the lock ("only if this still says running"). And a
write that could not take the lock is **reported, not swallowed**: a `cancel` whose
kill worked but whose record would not update exits nonzero saying exactly that,
because a kill nothing else can see is not a kill anything else may act on.

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
`kill-failed` are the states this runtime writes, plus three readings it *derives*
and never writes — `stale` (record says running, supervisor pid is gone), `corrupt`
(the record cannot be trusted) and `unknown` (the record's state is not one of the
six). `running`, `kill-pending`, `stale`, `kill-failed` and `unknown` are the states
in which processes may still be alive, so those five block their role, are
cancellable, and are what `--force` must kill; `corrupt` blocks too, until its pids
are proven dead.

`kill-pending` is what a cancel inside **either** registration window produces:
nothing was killed, so nothing may record a death — the job keeps its role, `cancel`
exits nonzero saying so, and it resolves when the supervisor reaches its next
re-check (it honours a pending cancel by killing codex itself and verifying), or,
for the supervisor window, once that window has passed and the supervisor provably
never arrived.

**There are two such windows, and the second one kills nothing at all.** The
supervisor window is between spawning the supervisor and recording its pid; the
codex window (`launch: 'exec-spawning'`) is between spawning codex and recording
*its* pids. In the second one the supervisor is the only process that knows what it
just started, so killing it is precisely how that knowledge is lost — which is what
0.4.0 did before recording `killed` and releasing the role. So a cancel there stops
at `kill-pending` and lets the supervisor land it. The one exception: if the
recorded supervisor is itself provably dead, nobody can ever land it, and the
window closes so the job is not stuck for ever.

**The record is authoritative, and it has to vouch.** `result` prints only when the
record says `done` **and** `deliverability()` holds: this release's `recordVersion`
stamp, a state this release knows, `exitCode: 0`, and either a WELL-FORMED
`sight: cwd-file:<name>` or the `allowUnprovenSight: true` the dispatch wrote down.
Every other case — a `stale` job whose `out.txt` is sitting right there, a 0.2
record with no sight at all, a record whose sight *says* it was accepted but that
carries no recorded opt-in, a `sight` that is the proof prefix and nothing more,
a state this release cannot name — exits
nonzero, names the reason, and names the `out:` path so the bytes remain reachable
by hand. `status` prints a `deliverable:` line for finished jobs and `list` tags
them `done(unvouched)`, so the refusal is never the first anyone hears of it. See
[docs/DECISIONS.md](docs/DECISIONS.md) for what this revoked and why.

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

**And what is verified is codex, not a stand-in for it.** On Windows the supported
codex install is `%APPDATA%\npm\codex.cmd` — a batch file, which cannot be run
under node, so it is spawned through `cmd.exe` and **the pid that comes back is the
shell wrapper**. Measured during review: wrapper 43124, real worker 40732 with
ppid 43124. Every kill verification was therefore checking a proxy, and a surviving
worker left the job reading `killed` with its role released. `kill-failed` was
unreachable on the platform this runtime is built for, and the suite could not see
it because `CODEX_DISPATCH_BIN` is a `.mjs` in every test (now also a `.cmd`).

Two things fix it, and both are recorded rather than assumed. The supervisor
resolves what it actually spawned — polling the process table for the wrapper's
descendants — and writes them to `codexPids` and to `codex.pid`, so they are kill
targets and verification targets like any other. And the kill walks the **tree**:
live descendants of every target are killed alongside it, and anything still
descended from one afterwards is a survivor, even if it was never a recorded pid.
The table comes from `Get-CimInstance Win32_Process` on Windows and `ps -eo
pid=,ppid=` elsewhere; if it cannot be read, that is **reported** — as a warning on
`cancel`, and as a refusal to conclude anything inside the codex-exec window — never
quietly treated as an empty tree. Off Windows the process group is the other half
of the same proof: `codexPgid` is recorded, and a group that still has members
after the kill counts as a survivor.

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
printed for `done` and for nothing else; every other **terminal** state gets
`JOB ENDED - state: <state>` and a `next:` line that fits it — `result` will
refuse this one, nothing vouched for how this ended. A window that shouts is only
worth having if what it shouts is true, and the old banner cheerfully announced a
ready result for jobs whose answer `result` was about to refuse.

**And it does not declare an end while a process may live.** `kill-pending`,
`kill-failed`, `stale` and `unknown` are states this runtime *defines* as
process-owning — they block their role and are cancellable — and the watcher used
to print `JOB ENDED` for all of them and exit. It keeps watching them now: one
`JOB NOT FINISHED - state: <state>` notice saying what is happening and what to do
about it (these pids survived and may still be billing; re-run the cancel; reap
the orphan), then it goes on following the log. Those states can and do change —
a retried cancel resolves a `kill-failed` — and the window is there to see it.
Only `done`, `failed`, `killed` and a confirmed `corrupt` end it.

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
node --test                            # everything: 99 tests (bare form — see below)
node --test tests/dispatch.test.mjs    # lifecycle, against a fake codex
node --test tests/packaging.test.mjs   # manifests, command frontmatter, no-hooks invariant
node --test tests/resolution.test.mjs  # binary resolution, sight-probe targeting, blind scan, whitelists, deliverability (imported, not spawned)
node tests/live-smoke.mjs              # one real cheap dispatch; skips loudly if codex absent/logged out
```

One of the 99 is skipped on Windows and runs on POSIX: the process-group kill has
no Windows analogue to assert (`taskkill /T` is the path there), so the *choice* of
targets is unit-tested on both platforms via `killPlan` and the kill itself is
integration-tested only where it applies.

**Invocation quirk:** `node --test tests/` fails on Node 24 — the directory
path is resolved as a module (`Cannot find module ...\tests`). Use the bare
`node --test` (from the repo root) or name the file. Bare discovery matches
`*.test.mjs`, so `tests/live-smoke.mjs` is never picked up by accident: the
naming, not a config file, is what keeps the real-billing smoke opt-in.

What the fake codex fakes, the full coverage inventory, the review findings
turned into assertions (each confirmed to fail against the release it was
written about), and the test-only knobs the runtime carries are documented in
[docs/TESTS.md](docs/TESTS.md).

## Known issues (found by review, accepted for now)

- **PID reuse is narrowed by start-time identity, not eliminated.** Each
  registered pid's OS start time is recorded (`pidStarts`), and a pid whose
  current start time no longer matches is neither read as alive nor fired at.
  What remains: records written before the field existed keep the old behavior,
  macOS `ps` has no `etimes` so the query answers nothing there, and start
  times are memoized per invocation — a reuse occurring mid-run degrades to the
  old behavior. Every remaining case fails in the safe direction: a spurious
  `kill-failed` refuses a launch rather than launching a duplicate, and the
  reaped-pid list still stops a number already fired at from ever being fired
  at again.
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
- **The process table costs about a second to read on Windows**, because
  `Get-CimInstance Win32_Process` does. It is read on a kill and once per job when
  codex was launched through a shell wrapper — not in any hot path — but a `cancel`
  is perceptibly slower than it was, and that is the price of verifying the tree
  rather than a list of numbers. `ps -eo pid=,ppid=` off Windows is free by
  comparison.
- **A probe file name that cannot survive the delivery gate's round trip is
  refused.** `sight` is written as `cwd-file:<name>` and read back by a validator
  that requires a name with no `:` and no path separator, so a POSIX file called
  `notes:2026.txt` would prove a real read and then be classified malformed, failing
  the job as unproven. Fail-closed by construction, vanishingly rare on the platform
  this targets (those characters are illegal in Windows filenames), and the cure is
  a `--cd` with one ordinary file in it. Recorded rather than papered over with an
  escaping scheme nobody would maintain.
- **A supervisor that dies inside the codex-exec window can orphan a codex that
  nothing recorded.** The window closes when the supervisor is provably dead — it
  has to, or the job is `kill-pending` for ever — and the ordinary verified kill
  then runs against the recorded pids and their tree. On Windows the orphan is still
  a descendant and is caught; off Windows codex was detached into its own group and
  reparented, so it may not be. That is the same limitation `stale` has always
  carried, narrowed rather than removed.
- **The junction/symlink drill is skipped, loudly, on a platform that will not
  create one.** Windows needs no elevation for a directory junction, so it runs
  where this suite runs; a POSIX box with symlink creation denied would print the
  skip rather than pass a test that proved nothing.


## Contributing

Zero runtime dependencies and no build step: clone it and run `node --test`.
Every constraint in the runtime traces to an entry in [docs/REVIEWS.md](docs/REVIEWS.md)
— if a change relaxes one, say which failure it is no longer guarding against.

## License

MIT — see [LICENSE](LICENSE).

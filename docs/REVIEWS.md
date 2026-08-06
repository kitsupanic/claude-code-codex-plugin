# The failure catalog and the dual reviews

Every constraint in the runtime traces to an entry here. The catalog records the
production failures this design answers; the review sections record the dual
frontier reviews of 0.3.0 and 0.4.0, whose findings became 0.4.0 and 0.5.0.

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
  `%APPDATA%\npm\codex.cmd` itself (see README → "Which codex binary").
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
  "Releases and versioning" in the README; this release is `0.5.0`.

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

### The 0.4.0 dual review (2026-08-06) — round three, and the same prescription twice

`0.4.0` went back to both frontier arms, again independently, again from one
standalone brief. Both returned *not ready*, and — this is the part worth
recording — **both prescribed the same cure**: one version-aware, fail-closed
semantic validator standing in front of every ownership, kill and delivery
decision. Not a list of patches; a missing organizing piece that each of the
specific findings then falls out of. That is what 0.5.0 is built around, and it is
why the seventh invariant exists.

Converged findings, each reproduced or traced by both arms:

- **Kill verification never reached codex, on either platform.** The Claude arm
  measured it on Windows: `codex.cmd` is a batch file, so `spawnCodex` goes through
  `cmd.exe` with `shell: true`, and the pid that comes back is the **wrapper**
  (43124), not the worker (40732, whose ppid was 43124). `killPids`/`waitGone`
  verified the wrapper. A surviving worker therefore left the job marked `killed`,
  its role released, and the next dispatch running beside a codex that was still
  billing — `kill-failed` could not fire at all. The Codex arm found the POSIX
  half: codex is spawned detached into its own group, and the kill targeted
  recorded fields only. **The suite was blind to all of it** because
  `CODEX_DISPATCH_BIN` is always a `.mjs` in CI, so the shell branch never
  executed. → The runtime now resolves and records what it ACTUALLY spawned
  (`codexPids`, plus `codexPgid` off Windows), kills and verifies the process tree
  rather than a list of numbers, and reports when the tree could not be enumerated
  instead of reading that as "nothing there". `tests/fake-codex.cmd` makes CI take
  the wrapper path.
- **A second registration window, around codex.** 0.4.0 closed the window between
  spawning the supervisor and recording its pid, and left the identical window one
  level down: the supervisor spawns codex, then records its pid. A cancel landing
  there killed the supervisor, verified the targets it knew about, marked the job
  `killed` and released the role — while codex ran on. → `launch: 'exec-spawning'`
  is recorded **before** the spawn; a cancel inside it kills **nothing** (the
  supervisor is the only process that knows what it just started, and killing it is
  how that knowledge is lost), records `kill-pending`, and the supervisor honours
  that cancel the moment it has the pids — killing codex itself and verifying it.
- **A corrupt or unknown record let a live role be taken.** The Claude arm
  reproduced it through `findRoleConflict`, which skipped corrupt records *by
  design*: with the claim directory gone, two codexes ran under one role. Worse,
  the runtime's own corrupt-claim message **told the operator to delete that lock
  directory** — instructing them to remove the last remaining guard. The Codex arm
  found the same class through unknown states: `effectiveState` passed an
  unrecognised state through verbatim, so a corrupt `"runnng"` or a future
  `"cancelling"` was neither running nor live, and lost its claim while codex ran.
  → The scan blocks on corrupt records unless their pids are proven dead, using the
  same verified-reap discipline the claim side already had; the message now puts
  the deletion **last**, after checking what is alive; and unknown states resolve
  to `unknown`, which is live.

Codex arm only, this round:

- **Lexical containment followed junctions.** `isInsideRoot` resolved `..` and
  nothing else, so a validly-named directory junction under the jobs root directed
  pid reads, kills, renames and writes wherever it pointed — and Windows junctions
  need no elevation. → Containment is proved against the **real** path
  (`fs.realpathSync.native`), links are refused rather than followed, and the
  listing walk classifies them as corrupt instead of reading through them. Tested
  with an actual junction.
- **An ABA race in claim reclaim and release.** Inspect owner A, pause, another
  dispatch installs claim B and passes its own fence, resume, and rename B's claim
  away. → The reclaim re-reads the owner before the rename **and re-checks what it
  actually moved afterwards**, putting a stranger's claim straight back and
  refusing. Reading before the rename narrows the window; only the check after it
  closes it.
- **The watcher terminated on live states.** `kill-pending` and `kill-failed` are
  declared live and process-owning, and the watcher printed `JOB ENDED` for them
  and exited. → It keeps watching every live state, says what is happening, and
  declares an end only when there is one.

Claude arm only, this round:

- **`updateRecord` is a read-modify-write, and 0.4.0 opened a window where dispatch
  and cancel both write it.** Two bad interleavings, the second dangerous: cancel
  takes the honest nothing-to-kill path and records `killed`, then dispatch's
  `{supervisorPid, launch:'spawned'}` — built on a read from before that — puts
  `running` back. The operator was told "killed", the role was released, and codex
  ran. The README's claim that there are no write races was, by then, false. → A
  single-writer lock around read-and-write, a `generation` counter, an optional
  precondition, and — found while fixing it — a write that loses that race is now
  **reported** rather than swallowed, because a kill that could not be written down
  is not a kill anything else can see.
- **A ghost record from the catch-all.** Any throw after `writeRecord` and before
  the `!child.pid` check released the role and left the record `running` with no
  supervisor: exactly the ghost closure 11 removed, reachable by another path. →
  The catch-all finalizes the record (`failed` / `dispatch-failed`) — and, if a
  supervisor was already spawned, does the opposite of what it used to: it keeps
  the role and refuses to finalize anything, because something is running.
- **`cmdList` could print undocumented reasons.** → The emittable set is exported
  as `JOB_REASONS`, documented in `commands/list.md`, and a test scans the runtime
  source for reasons it writes and fails on any that is undeclared or undocumented.

And one found during this round rather than in it, from a console error the
operator saw while the suite ran:

- **A transport failure in the sight probe was recorded as proven blindness.**
  `spawnSync` sets `error` and leaves `status` null when a launch fails, and
  `sandboxRead` inspected neither: every such failure fell out of the bottom as
  `broken`, i.e. `failed / sandbox-blind-precheck` — a verdict that codex cannot
  see, on the strength of an infrastructure hiccup. The hiccup was real and had a
  cause: `spawnSync`'s default stdio hands the child a pipe for stdin and closes
  it, and `cmd /c type` inheriting that handle can fail the launch with
  ERROR_NO_DATA (`0x800700E8`, "the pipe is being closed") — which surfaced as a
  console error box against a perfectly healthy binary. Under a fail-closed gate
  this is the expensive direction: it refuses good jobs and names the wrong cure.
  → stdin is NUL and `windowsHide` is set on every synchronous spawn; the probe
  distinguishes "the sandbox said no" from "the probe never ran", retries a bounded
  number of times, and a persistent transport failure is `sight-probe-error` with
  its own message — refusable, opt-in-able, and never called blindness.


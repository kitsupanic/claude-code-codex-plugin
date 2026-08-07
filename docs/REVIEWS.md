# The failure catalog and the dual reviews

Every constraint in the runtime traces to an entry here. The catalog records the
production failures this design answers; the review sections record the dual
frontier reviews of 0.3.0, 0.4.0, 0.8.0 and 0.8.1 and the 0.7.3 full-repo
review, whose findings became 0.4.0, 0.5.0, 0.8.0, 0.8.1 and 0.8.2.

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
  `%APPDATA%\npm\codex.cmd` itself (see [DESIGN.md → "Which codex binary"](DESIGN.md#which-codex-binary--and-proving-it-can-see)).
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


### The 0.7.3 full-repo review (2026-08-07) — the kill seam, and everything nothing had ever removed

One arm, one standalone brief, the whole repo. Eight findings, and the lead one
was **reproduced against the shipped runtime before it was reported** — the shape
this catalog trusts most. The theme is a familiar one wearing a new costume: a
rule the runtime states everywhere and applies in all but one place.

- **`killJob`'s terminal writes carried no precondition (reproduced).** Every
  other writer in this seam is a compare-and-swap — the supervisor's exit handler,
  the `exec-spawning` mark and dispatch's post-spawn check all pass
  `expect: canonicalState === 'running'` — and the four writes a cancel makes
  (`kill-pending` twice, `kill-failed`, `killed`) passed nothing at all. Worse,
  `killJob`'s own stale-snapshot re-read compared the launch *phase* and the pid
  list and never the *state*, so a record that reached a verdict inside the gap
  looked unchanged and the decision was made on the pre-gap snapshot. A cancel
  that lost the race to the supervisor therefore killed a supervisor that was
  already exiting and wrote `killed` over its verdict: `killed(sight-unproven)`
  on disk — the pair `tests/resolution.test.mjs` asserts impossible — or a
  deliverable `done` answer destroyed. Reachable identically through `--force`,
  by two routes (`claimRole` and `cmdDispatch`'s own conflict path). → All four
  writes are CAS on "the state is still one of `LIVE_STATES`", the re-read watches
  the state as well, and a precondition that loses is not a lost write but a
  *found verdict*: nothing is overwritten, nothing is killed, the role is not
  released, and the caller is told the state that is really there. `--force`
  treats a terminal job as what it is — not a conflict — and takes the role
  without claiming a kill it never made.
- **The test that should have caught it moved the wrong field.** The kill-race
  test held a cancel in the injected pause and moved the launch *phase* to
  `exec-spawning`; it never moved the state. → Two new test blocks cover three
  scenarios: one moves the state to `failed(sight-unproven)` and then to `done`
  inside that window and asserts the verdict survives both times, the other puts
  a `--force` in the same race. Both blocks fail against the unfixed runtime,
  which is how they were written.
- **Nothing had ever removed a job directory.** Unbounded on-disk growth: brief,
  record, `run.log` and answer kept for ever, with the only remedy being to delete
  the tree by hand — the operation this runtime spends the most care making unsafe
  to do by hand. → A `clean` verb: manual, never automatic, refusing without
  `--all` or `--older-than <days>`, eligible only on `ROLE_RELEASE_STATES`, no
  `--force` past live or corrupt jobs, removal under the record lock with the
  state re-decided inside it. See [DESIGN.md → Retention](DESIGN.md#retention--clean-and-why-it-is-manual).
- **The role scan read through junctions.** `allJobs` classifies a directory
  junction named like a job id as corrupt so that "nothing was read through it",
  and `findRoleConflict` then read that entry's pid files and record — following
  the link — and probed the numbers it found there for liveness. The kill was
  refused later by `assertInsideRoot`; the read never was. → The containment
  classification is honoured at the read boundary: such an entry is refused
  outright, blocks its role (it cannot be proved dead without reading it), and the
  refusal names the entry.
- **`watch` spawned a literal `node`.** The only spawn in the runtime not using
  `process.execPath`. Where node is not on the interactive PATH the window opened,
  printed `'node' is not recognized`, and `watch` reported success. → The launcher
  line is built from `process.execPath`, quoted once by `cmdQuote` with
  `windowsVerbatimArguments`, exported as `watchLaunchArgs` so the argv is
  asserted directly, and refused rather than mangled when a path carries `% ! "`.
- **The cmd.exe gate never checked the jobs root.** It travels on the same command
  line as `--output-last-message <jobs-root>\<id>\out.txt`, and `%` and `!` are
  legal in a Windows user name — so the DEFAULT root can carry one. Preflight
  passed, the sight probe passed, a role was claimed and a supervisor spawned, and
  then every job failed as `codex-argv-refused`, for ever, with the fault named
  nowhere near where it could be fixed. → Checked in `preflight` (before the
  `CODEX_DISPATCH_BIN` short-circuit) and in `dispatch` before anything is
  claimed, naming `CODEX_DISPATCH_JOBS` as the cure.
- **Two documentation drifts.** `commands/result.md`'s "Not delivered"
  enumeration omitted `unknown`, which `result` routes there like any other
  non-`done` state; and the README still counted 111 tests. Both corrected.

What the round did *not* find is worth recording too: the validator, the record
lock, the claim fence, the containment asserts and the delivery gate were all
probed and all held.

**And the follow-up review of that diff found a regression it had introduced**,
which is the entry in this catalog most worth keeping. The `watch` fix quoted the
node path and the runtime path with `cmdQuote` and put them straight after
`cmd /k` — and `cmd /k` does not parse an argv. With no `/S` it preserves quotes
only when the tail holds *exactly two*, and otherwise strips the first character
and the last quote: four quotes meant it ran `C:\Program`. So every install with
a space in **both** paths — `C:\Program Files\nodejs` plus a plugin under
`C:\Users\John Smith\...` — got a dead window and a `watching:` success, which is
worse for that population than the literal `node` it replaced. Reproduced on the
reviewer's machine and again here before the second fix.

Two lessons, both structural:

- **The argv-shape assertion was the gap.** `watchLaunchArgs` was exported and
  tested as data precisely so this could not happen, and the broken line
  satisfied every assertion in that test. A command line is not proved by its
  shape; it is proved by running it. The suite now executes the real line for all
  four combinations of (node path quoted / not) × (runtime path quoted / not),
  headless — `/k` becomes `/c` and `start` gets `/B /WAIT` — and the data test is
  kept beside it rather than instead of it.
- **A fix that narrows a failure population can still widen it for somebody.**
  The old line worked for a spaced plugin path whenever node was on PATH; the new
  one broke exactly that case. "Strictly better" is a claim to check per
  population, not to infer from the defect being real.

The same review also closed three narrower things in this round's own work: the
CAS's "which verdict beat me" answer now comes from the record read *inside* the
lock (`updateRecordOutcome` already hands it back) rather than from a re-read
that could report a third state; `clean` dismantles a job directory with its
`job.json` **last**, because `allJobs` cannot see an entry without one and a
removal that died partway with the record already gone left a tree nothing could
ever list or clean again; and a removal that fails is caught and reported as a
`kept:` line plus a stderr warning instead of throwing out of the lock and ending
the run at the first stuck file.

### The 0.8.0 dual review (2026-08-07) — the arms disagree, and adjudication decides

`0.8.0` went back to two arms, full repo, one standalone brief each,
independently: Claude Fable 5 with fresh context and the whole suite green
beside it, and GPT-5.6-sol at xhigh — dispatched **through this runtime
itself**, in the read-only sandbox the second-opinion contract mandates, which
meant the Codex arm could execute only the 46 non-writing tests and traced the
rest from source. For the first time the verdicts split: the Claude arm said
*safe to build on, with one asterisk*; the Codex arm said *not yet safe*. The
split was resolved the only way it can be — every disputed finding adjudicated
against the source — and **all six of the Codex arm's extra findings survived,
two of them in areas the Claude arm had explicitly probed and recorded as
sound.** The 0.3.0 lesson gains its corollary: an arm's "checked and found
sound" is a claim like any other finding, and the disagreement between arms is
where the review actually happens.

Converged — both arms, independently, the same trace:

- **Dispatch's post-spawn cancel branch was the one writer left in the kill
  seam without its precondition** — the exact class 0.8.0 declared closed, one
  process to the left. It read the record once, spent seconds inside
  `killPids`, then wrote `killed`/`kill-failed` unguarded, so a cancel landing
  in the spawning window while the sight probe failed could put
  `killed(sight-unproven)` — the pair `commands/list.md` documents as
  impossible — back on disk. And DESIGN claimed the branch carried
  `expect: canonicalState === 'running'`, which it never had, at any revision:
  the next auditor would have concluded from the docs that the bug could not
  exist. → CAS on `stillCancellable` like the rest of the seam; a lost
  precondition is a found verdict — nothing overwritten, nothing released; the
  kill target goes through the reaped-pid list first and pid files are consumed
  only after a verified kill; both doc passages corrected.
- **An unenumerated process tree counted as verified dead.** `killPids` said
  `enumerated: false` when the process table could not be read, and exactly one
  call site listened — the corrupt-record cancel. `killJob`, the post-spawn
  branch, the unvouched reap and the supervisor's cancel landing all verified
  only the pids they had fired at, concluded `killed`, and released the role —
  while DESIGN promised an unreadable table is "never quietly treated as an
  empty tree". → `enumerated: false` is a failed verification: `kill-failed`,
  role kept, pid files left loaded, re-run advised — on every path, and the
  DESIGN passage is now true.

Codex arm only — all six confirmed by adjudication, none demoted:

- **`clean` did not actually delete the record last.** `removeJobDir` unlinked
  `job.json` and *then* removed the directory — an operation that can fail
  alone (a process whose cwd is the job directory, on Windows: every file
  unlinks, the rmdir refuses), leaving the invisible tree the comment above the
  function promised away — while the failure warning told the operator "each of
  them still has its job.json". The Claude arm had recorded `clean` as sound;
  its test blocked a child directory and never the root. → The record's raw
  bytes are captured before the unlink and written back when the final removal
  throws, so a failure anywhere leaves a job that still lists; the new test
  blocks the directory itself.
- **`markPending` reported a state it failed to write.** A `locked`/`corrupt`
  write failure was indistinguishable from success, so `cancel` printed "the
  state is kill-pending" over a record still saying `running` — and the
  exec-window launch block, which is the entire point of the mark, was silently
  not armed. → Three outcomes: marked, lost-to-verdict, and unrecorded — the
  last reported as "not recorded, nothing killed, re-run" through every caller.
- **An ownerless claim was reclaimed with no fence at all.** `expected:
  undefined` skipped both owner checks, so a reclaimer that resumed after the
  grace window renamed away whatever held the lock at that moment — including a
  fresh claim whose owner had already passed the verify fence and launched: two
  same-role codexes, the one failure this runtime exists to prevent. The Claude
  arm had recorded the ABA fence sound; the fence existed only for named
  owners, and the code's own comment called the unfenced damage "bounded" on a
  bound that fails exactly when the victim is past its fence. → `null` is a
  fenced expectation of its own — "still ownerless", checked before the rename
  and re-checked on what was actually moved — and the unfenced case is retired;
  no caller remained that had never read an owner.
- **The record-lock stale-break trusted age alone.** The lock's mtime was never
  refreshed and no liveness was checked, so a live writer stalled five seconds
  inside its critical section lost mutual exclusion, and its resumed write
  clobbered the breaker's — a cancel's `kill-pending`, say. The CAS tests pause
  2.5 s, specifically under the break, and so could never see it. → The lock
  names its holder, and the break requires stale age *and* a holder not
  provably alive.
- **The jobs root was used verbatim.** A relative `CODEX_DISPATCH_JOBS` — the
  README's own documented cure for a `%` in a user name — made job identity and
  every printed `out:` path depend on the caller's cwd. → `path.resolve`, one
  line, plus the test.
- **Kill patches preserved a live record's `reason`, and `result` read the
  reason before the state.** A version-skewed record — a state this release
  cannot name, carrying `sight-unproven` — is `unknown`, which is live, which
  is cancellable; the kill patch merged `killed` over it without touching the
  reason, and `result` then printed "UNPROVEN: job never ran" for a job that
  ran and was killed. → Terminal kill patches clear `reason`, and the never-ran
  checks are gated on the state actually being `failed`, so a reason can never
  outrank a state again.

**And the follow-up review of the fix diff found the theme again, one writer
further left**: the supervisor's cancelled-during-exec landing wrote its
`killed`/`kill-failed` unguarded — while the freshly corrected DESIGN passage
claimed all three late writers were compare-and-swap. Dispatch's now-fenced
branch could write `killed` and release the role during the seconds the
supervisor spent inside its own `killPids`; the supervisor then stamped
`kill-failed` over that verdict with the role already free — a record that
blocks nothing while claiming to. → The landing carries the same precondition,
under an ownership rule stated both directions: whoever's write lands owns the
verdict *and* the release together; a loser reports into `run.log`, overwrites
nothing, releases nothing — and still kills codex, because the verdict is about
the record, not about what is alive. Pinned by an interleaving test confirmed
failing against 0.8.0 **and** against the fixed tree with only its `expect:`
removed. The same follow-up caught the stale-break fix planting a synchronous
PowerShell start-time query inside the very critical section it protected — on
a cold shell, longer than the stale age itself. Cured at the root rather than
relocated: the holder file carries the pid and nothing else, because start-time
identity everywhere else in this runtime only ever *subtracts* kill targets,
and here it would have been the evidence *justifying* the break of a
live-looking lock. The residual — a dead holder whose pid is instantly reissued
keeps the lock, and writers refuse loudly rather than lose an update — is in
DESIGN's known issues, failing in the safe direction. Plus three honesty
repairs of the round's own making: an advice line claiming pids were recorded
spent when an unverified kill consumes nothing, a verified `killed` carrying
the stale `killSurvivors` list of the `kill-failed` it overwrote, and two
messages asserting claim-states they had not checked.

Ten tests went in with the fixes (127 → 137), every one confirmed to fail
against the unfixed runtime before it landed. What held, probed by both arms:
`killJob`'s 0.8.0 CAS repair, the validator and its domains, the delivery gate
and its version stamp, junction containment at both boundaries, the cmd.exe
quoting gate, and all of the 0.7.3 fixes.

One operational note, for symmetry with the entry that opens this catalog: the
Codex arm's answer was retrieved through the printed `out:` path after the
relay's wake-up chain dropped — the same dropped-notification failure that
motivated the `out:` line in the first place, caught this time by the fallback
it exists to provide. The contract held; the relay's polling loop is the thing
to fix, and it lives outside this repo.

### The 0.8.1 dual review (2026-08-07) — both arms wrong somewhere, and adjudication decides both ways

The range `5f9f292..HEAD` — 0.7.2 through 0.8.1, the work layered on the last
round's fixes — went to two arms again: Claude Fable 5 with fresh context and
the suite green beside it, GPT-5.6-sol as the second opinion. Both said the
range was substantive; each was wrong somewhere the other was right, and this
time the errors were **symmetric**. The Claude arm pronounced the record-lock
holder liveness "fail directions all correct" and the killJob verdict race
"closed, not narrowed"; the Codex arm's two High findings contested exactly
those clean bills. Adjudication — one fresh arm per contested finding, tracing
interleavings against the source — decided both ways at once: the lock finding
**CONFIRMED and slightly worse than claimed** (the resumed acquirer's holder
write does not fail, it lands *inside the breaker's fresh lock*), the exec-race
finding **PARTIAL** — real at the seam named, but tens of milliseconds wide
rather than the whole refresh-to-kill span, because the pre-kill descendant
sweep and the re-read loop close everything before the table snapshot. A High
demoted to Medium with the maximal consequence intact is not a refutation; it
is the width of the fix.

- **The mkdir-then-write acquisition was the unproved-liveness break the 0.8.1
  entry above praised the code for eliminating** — one window to the left. A
  holderless lock past the stale age was broken on age alone, live creator or
  not, and the creator resumed into the breaker's directory. → Staged
  acquisition (holder inside, rename publishes), release by identity; the
  mixed-version POSIX empty-directory replace narrowed and recorded as a
  residual, not claimed closed.
- **The `'none'` kill window carried no fence** — `kill-pending` was written
  for the exec window and the empty window, and not for the one that actually
  kills, so the record said `running` for exactly the seconds the supervisor's
  `exec-spawning` CAS needed it to. → The mark is unconditional before
  `killPids`; the re-read behind it defers to the one process that knows what
  it just spawned.
- **Converged, both arms independently: the two headline cancel/verdict tests
  never reached the writes they pinned.** The fixed 1.5-second timer landed
  the verdict before the first record read, so the pre-existing early-out —
  which the unfixed runtime also passed — was the only path exercised;
  deleting the CAS preconditions failed nothing. → Reworked around a pause at
  the verdict write itself, plus the missing hook, and every new test in the
  round was verified to fail against a scratch-broken guard before it counted.
- The arms' non-contested findings all held under implementation: the
  corrupt-record cancel spending unenumerated targets (Claude), the
  unpreconditioned pre-launch refusals (Claude), the `kill-failed` loss
  reported as a win (Codex), `clean`'s restore written over its own deleted
  lock (Claude).

**The round's own test pass then found the fix under the fix**: the refusal
CAS the implementation landed used `stillCancellable`, and `kill-failed` is a
live state — it must be, a second cancel has to be able to retry it — so the
probe showed a refusal still overwriting a cancel's verdict and freeing its
role, with the DESIGN sentence claiming otherwise already written. The line is
`CANCEL_STATES`, not liveness: a cancel-authored state is the cancel's to
resolve. And the final gate on the whole diff caught the same shape one seam
smaller — the honour path's precondition also accepted `kill-failed`, when
the state it honours is exactly `kill-pending` — plus the POSIX rename
residual stated above and seven test hooks that would wait forever on
`Atomics.wait(…, NaN)` from a typo'd env value.

Twelve tests went in with the fixes (137 → 149). What held, probed by both
arms and the adjudicators: the three verdict CASes under the record lock, the
0.7.3 `CANCEL_STATES` gate on dispatch's post-spawn branch, the supervisor's
exec-landing CAS and release-by-ownership, the `reclaimClaim` ownerless fence,
the cmd.exe quoting gates, and the reaped-pid anti-target list with its
control fixture.

The operational note repeats verbatim from the round above, which is the
point: the relay's wake-up chain dropped again, the answer sat finished in the
`out:` file, and a nudge — any message; the relay's first act on waking is
`result` — delivered it. The contract held twice. The second drop bought the
root cause: the relay's background wait was never alive at all — a subagent's
background tasks are reaped the moment its turn ends, so the wake-up it
promised ran on a mechanism that does not exist. Fixed the same day, outside
this repo where the relay lives: the caller owns the watch now, and the
example agent file in this repo carries the warning so nobody rebuilds the
broken shape from the template.

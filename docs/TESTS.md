# Tests — the fake codex, the coverage, and the knobs

How to run the suite is in [README → Tests](../README.md#tests). This file
records what the suite covers and how conditions that cannot be produced on
demand are injected.

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
  return the old token, which bought it nothing. (The label it asserts changed in
  0.5.0: a disproven read writes `FAILED cwd-file:<name>: …`, because the old
  `cwd-file:<name> FAILED: …` began with the one prefix that means "proved".)

The 0.5.0 additions are round three's findings turned into assertions, and **every
one of them was confirmed to fail against `80b1d29` (0.4.0) before the fixes
landed** — sixteen tests, run against the previous runtime with nothing changed but
the four new test knobs, which had to be back-ported to it so the injected
conditions could exist at all:

- **an unknown state is live and unvouched** — a record saying `cancelling` reads
  as `unknown`, blocks its role, is cancellable, and never delivers; `list` shows
  `unknown(cancelling)` so the raw value is not lost;
- **a pid outside the pid domain is refused before anything is signalled** —
  `supervisorPid: -1` and `codexPid: 0` are corruption, `cancel` takes the corrupt
  path, and `-1` never appears as a target;
- **a sight that is only the proof prefix is refused** — `cwd-file:`,
  `cwd-file:../escape`, and the `cwd-file:<name> FAILED: …` label the supervisor
  itself used to write for a disproven read;
- **the supervisor asserts the record version it picked up** — a record stamped by
  a different release stops it before anything is billed;
- **a corrupt record blocks its role** — the Claude arm's B1 reproduction, with the
  lock directory deleted: a corrupt record with live pids refuses the role while
  kills do not take, and yields it only after a verified reap;
- **the corrupt-claim message checks before it deletes** — asserted by ordering,
  not by wording alone: the "find out whether anything is alive" step must appear
  before the "remove the lock directory" step;
- **containment follows junctions** — a real junction (Windows needs no elevation
  for one) named like a job dir: `status`, `result` and `cancel` all refuse it,
  `list` renders it corrupt, and nothing outside the jobs root is touched. If the
  platform will not create one the test says so rather than passing silently;
- **a cancel that lands mid-write is not undone by the write it interrupted** —
  with a pause injected between the read and the write;
- **the catch-all finalizes the record** — an injected throw after `writeRecord`
  leaves `failed(dispatch-failed)`, not a `running` ghost, and frees the role;
- **a transport failure in the probe is not a finding of blindness** — one injected
  spawn failure is absorbed by the retry and the job runs; a persistent one is
  `sight-probe-error` with its own message, never `sandbox-blind-precheck`, and the
  recorded opt-in is the way past it;
- **a codex behind a `.cmd` wrapper is recorded and verified, not its proxy** — the
  worker is resolved, recorded alongside the wrapper, mirrored into `codex.pid`,
  and named as a survivor when a kill does not take. This is the one the suite was
  structurally blind to, and `tests/fake-codex.cmd` is what opened its eyes;
- **the codex-exec window**, both halves — a fixture in that phase yields
  `kill-pending` and stays blocked (and is not time-boxed: an hour later it is
  still pending), and a real supervisor *held inside* the window has its cancel
  refused as pending and then landed by the supervisor itself as
  `killed(cancelled-during-exec)`;
- **the watcher keeps watching a live state** — two seconds into a `kill-failed`
  job it must not have exited, must have said `JOB NOT FINISHED` and what the
  survivors mean, and must end only once the record really does;
- plus the **deliverability matrix**, extended with the previous release's stamp,
  the four malformed-sight shapes, two unknown states and two bad pids.

The 0.7.3 additions pin the five fixes of the full-repo review, and two of them
close gaps the review named rather than defects it found:

- **a verdict the supervisor reached is not a cancel** — the window between
  recording `launch: 'spawned'` and re-reading the record, held open with
  `CODEX_DISPATCH_TEST_SPAWN_PAUSE_MS` while a codex with no `sandbox` subcommand
  makes the precheck fail inside it. The job keeps `failed(sight-unproven)`, the
  dispatch still exits 0 with the same handle, nothing is killed, and the note on
  stderr says whose verdict it deferred to. Only a *cancel-shaped* state is a
  cancel, which is asserted directly on `CANCEL_STATES` as well;
- **the state/reason PAIR is a contract, in both directions** — a source scan
  pairs each written reason with the state written beside it and checks the pair
  against `commands/list.md`, and a sweep at the end of the lifecycle file reads
  the pairs the suite actually put on disk. The source half cannot see a pair made
  by one write setting `state` over another's `reason` — which is exactly how
  `killed(sandbox-blind-precheck)` was produced — so the record half exists for
  those, and neither replaces the other;
- **a `--cd` that is not there is refused before anything is spent** — a missing
  path and a file, each named in the refusal, with no job directory and no role
  claim left behind;
- **`,` `;` and `=` end a cmd.exe token** — asserted on `cmdQuote` directly, and
  end to end by dispatching against a `.cmd` copied into a directory called
  `to,ols;x=y`: the shell branch is the only one that builds a command line, and
  an unquoted path there never runs at all;
- **a `kill-failed` job keeps its role claim when its supervisor exits** — the
  claim itself is asserted, not the refusal it produces, because
  `findRoleConflict`'s backstop scan produces that refusal either way;
- **a reaped pid is never fired at again through the record** — the anti-target
  list applied to the pid files while `supervisorPid`/`codexPid`/`codexPids` walked
  past it. Both homes of the spent list are covered (the record's `reapedPids` and
  `reaped.pids`), with `CODEX_DISPATCH_TEST_NOKILL` making the question decidable:
  a pid that IS targeted survives the no-op kill and is reported by name, so the
  control job fails exactly where the filtered one passes.

**Thirteen test-only knobs live in the runtime**, each standing in for a condition
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
- `CODEX_DISPATCH_TEST_RECORD_PAUSE_MS=<ms>` — a writer is descheduled between
  reading the record and writing it: the window in which another writer's verdict
  used to be lost. A scheduler gap of a chosen length is not producible on demand.
- `CODEX_DISPATCH_TEST_EXEC_PAUSE_MS=<ms>` — the supervisor is held inside the
  codex-exec window, with codex spawned and its pid written down nowhere. A real
  one lasts milliseconds and cannot be aimed at.
- `CODEX_DISPATCH_TEST_THROW_AFTER_RECORD=1` — the dispatch throws after writing
  the record and before handing the job off. A full disk, or a log that will not
  open, between exactly those two lines is not producible either.
- `CODEX_DISPATCH_TEST_PROBE_ERROR=<n>` — the first `n` sight-probe spawns fail at
  the transport level (`error` set, no exit status), the way a Windows pipe
  teardown does. This is the one that separates "the sandbox said no" from "the
  probe never ran", and both halves — the retry absorbing a flake, and a persistent
  failure being refused as `sight-probe-error` rather than as blindness — need it.
- `CODEX_DISPATCH_TEST_SPAWN_PAUSE_MS=<ms>` — the dispatch is held between
  registering its supervisor's pid and re-reading the record, which is the window
  a fast supervisor finishes inside. Real ones are milliseconds wide and cannot be
  aimed at; the decision under test is that a verdict the supervisor reached is
  neither killed nor overwritten by the parent.
- `CODEX_DISPATCH_TEST_KILL_PAUSE_MS=<ms>` — a cancel is descheduled between
  gathering its targets and deciding on them, standing in for the seconds the pid
  identity check really spends in a shell: the decision has to be made on the
  record as it is now, not as the caller read it.
- `CODEX_DISPATCH_TEST_START_TIME=<pid>:<start>[,<pid>:<start>]` — the OS start time
  answered for those pids, so pid reuse (a number reissued to something else) can
  be posed without waiting for an OS to reissue one.
- `CODEX_DISPATCH_TEST_PREFLIGHT_FULL=1` — `CODEX_DISPATCH_BIN` stops
  short-circuiting `preflight`, so the version, auth and sandbox checks it exists
  to make actually run — against a stand-in that answers the way codex-cli does.
  Only the short-circuit is injected; every check below it is the real one.

They are all injections of a *condition*, never of an *answer*: every one of them
makes the world behave a certain way and then asserts what the runtime decides
about it.

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


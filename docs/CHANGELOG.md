# Changelog

Versioning rule: **a push that changes behavior MUST bump the version** — see
[README → Releases and versioning](../README.md#releases-and-versioning) for why.

## 0.7.2

A full-repo review — runtime, tests and docs each read by its own reviewer —
fixed. The theme every finding shared: the code was strongest where the record
meets its own state machine and weakest where the record meets the real OS
process boundary.

**The cancel race.** `killJob` decided its kill window from the record snapshot
its caller had read, then spent seconds in process-table queries — time enough
for the supervisor to reach `exec-spawning` and spawn codex detached. On POSIX
that codex leads its own group and reparents to init when the supervisor dies,
so the kill missed it, the leftover check could not see it, and the job was
recorded `killed` with its role released: an orphan codex billing beside the
next dispatch, the exact artifact this runtime exists to prevent. The window
and the target set are now re-read immediately before firing, and re-checked
once after the slow identity pass, so a fresh `exec-spawning` takes the
kill-pending path.

**`child.pid` is out of the kill surface.** Only the test fake ever wrote that
file, and its presence in `PID_FILES` made the grandchild a direct kill target
— so the Windows tree-kill tests passed even with `taskkill /T` traversal
broken. The runtime no longer reads it, and the tests now genuinely fail if
the tree walk does.

**Domains on the fields the supervisor hands to spawn.** `sandbox` is
whitelisted (`read-only`, `workspace-write`), `model` and `effort` are
shape-checked, and `started` must parse as a date — checked at dispatch, where
a bad value is a refusal, and in the validator, where one is corruption. This
is **behavioral** in the fail-closed direction: a job.json rewritten to
`danger-full-access` now reads corrupt instead of launching codex unsandboxed.
`RECORD_VERSION` does not move — records this runtime wrote remain
deliverable; only a value it would never have written reads corrupt.

**Smaller closures, same review.** A stale record lock is broken by
rename-to-tombstone, so two breakers can no longer free two concurrent
writers; reaped-pid merges happen under that lock, so a spent pid cannot be
re-armed by a lost entry; a stale Windows ppid pointing at a reissued number
no longer adopts an unrelated process as a kill target (a child cannot predate
its parent — one batched start-time query, and the check still only ever
subtracts); an unreadable claim owner inside the grace window is a live claim,
not an ownerless one, in `claimRole` and in `releaseRole`, whose comment had
promised the behaviour it did not implement.

**Tests: 103 → 111, and the process boundary is covered.** The codex argv is
asserted flag by flag out of the fake's echo, the brief is byte-compared
against what actually reached codex's stdin (CRLF, unicode, no trailing
newline), a nonzero exec and a done-with-no-answer-file both run end to end,
and preflight's six verdict branches run against the fake through the new
`CODEX_DISPATCH_TEST_PREFLIGHT_FULL` hook. The suite also cleans up after
itself now: the temp jobs tree is reaped and removed, long-lived fakes die in
`finally`, and the one order-dependent test builds its own fixtures.

## 0.7.1

0.7.0's own fix, reviewed by another dispatch, and it had left three holes.

**A regression 0.7.0 introduced.** The `%` check ran on `opts.cd`, so a dispatch
with no `--cd` at all skipped it and put `process.cwd()` into the record
unexamined. Run from a directory with a `%` in its name, the supervisor then
threw on a command line nothing had inspected — inside a detached process with
no catch around it, so the record kept saying `running`, the job read `stale`,
and it held its role until someone cancelled it. Reproduced by hand before
being fixed. The check now runs on the **resolved** cwd, the record is written
from the values that were checked rather than from a second computation of them,
and the supervisor's spawn is wrapped so a refusal finalizes as
`failed / codex-argv-refused` rather than stranding the job. `main()` catches the
same refusal (tagged, so it cannot widen to every other throw) and reports it
through the normal failure path, which covers preflight and the sight probe.

**`"` is refused, not escaped.** 0.7.0 escaped it as `""`, which keeps `cmd.exe`'s
quote parity even and breaks `CommandLineToArgvW`, where `\"` is the escape — so
`a\"` did not round-trip. There is no spelling that satisfies both parsers.
Windows paths cannot contain a quote and no model or effort name does, so
refusing removes the mismatch at no real cost.

**`!` is refused too.** Same expansion hazard as `%` under delayed expansion.
Node launches `cmd.exe /d /s /c`, where it is off, so this is a guarantee about
somebody else's future setting rather than a live defect — the cheapest kind to
keep.

No record-schema change: 0.7.0 and 0.6.0 records remain deliverable.

## 0.7.0

Windows command-line construction, fixed — both defects found by a Codex
dispatch reviewing this runtime's own quoting, and both reachable from
user-supplied flag values.

`cmdQuote` doubles a **trailing backslash run** before the closing quote it adds:
`foo bar\` used to become `"foo bar\"`, which `CommandLineToArgvW` reads as an
escaped quote, so the argument lost its delimiter and merged with the next one.
Interior backslashes are untouched.

And **`%` is refused rather than mangled**. `cmd.exe` expands `%VAR%` after quote
stripping, so no quoting reaches it and there is no in-band escape; a
`--model %COMSPEC%` would silently launch codex with something other than what
was typed. `dispatch` now rejects `--model`, `--effort` and `--cd` values
carrying `%` (naming the cure), and `cmdQuote` throws as the backstop. This is
**behavioral**: a value that previously ran, mangled, is now a clean refusal —
on Windows only, since elsewhere argv is passed as an array and nothing
re-parses it. `%` is a legal NTFS filename character, so a `--cd` with one in it
is a real directory this release will not point at.

`RECORD_VERSION` does not move: 0.6.0 records remain deliverable.

## 0.6.0

The post-0.5.0 review, fixed. The POSIX sight probe quotes its filename for `sh`
and skips names carrying shell-expansion characters, so a hostile name in a
probed cwd cannot run anything; a recorded pid the OS has reissued is identified
by its start time (`pidStarts`) and is neither read as alive nor fired at, which
is what stops a stale job's kill from landing on an innocent process; the
supervisor's exit-time record write carries the same only-if-still-running
precondition as every other racy write; and `reaped.pids` is written atomically,
like the record it exists to outlive. `RECORD_VERSION` does not move: 0.5.0
records remain deliverable.

## 0.5.0

The 0.4.0 dual review, fixed, around the one change both arms prescribed: **a
version-aware, fail-closed semantic validator in front of every ownership, kill
and delivery decision** (see [DESIGN.md → The validator](DESIGN.md#the-validator--one-gate-version-aware-fail-closed)).
Out of it fall the specifics: an unrecognised state is `unknown` — live,
role-blocking, undeliverable — instead of quietly terminal; a pid outside the pid
domain is corruption rather than a signal target; a `sight` that merely starts
with the proof prefix is corruption rather than proof; and `_supervise` asserts
the schema version of the record it picked up rather than trusting the stamp the
dispatch wrote. Alongside it: kills record and verify the **actual** codex
process rather than the cmd.exe wrapper Windows hands back, and walk the process
tree; a cancel inside the codex-exec window is `kill-pending`, never `killed`; a
corrupt record blocks its role until its pids are proven dead, and the
corrupt-claim message no longer opens by telling you to delete the guard;
containment is proved against the real path, so a junction cannot redirect a
read, a rename or a kill; claim reclaim and release are conditional on the owner
that was inspected; record writes are serialized and a lost write is reported;
the dispatch catch-all finalizes its record instead of leaving a ghost; the
watcher keeps watching live states; and a sight probe that could not be *run* is
`sight-probe-error`, not a finding of blindness.

`RECORD_VERSION` moves to **2**, and that is behavioral and deliberate: **jobs
dispatched by 0.1–0.4 will not be delivered by `result` on this release** — their
records were written by a gate that read fields instead of validating them, so
they are not evidence that this gate was met. `result` names the reason and
prints the `out:` path; read them by hand if you trust them, or re-dispatch.

## 0.4.0

The 0.3.0 dual review, fixed. Untrusted strings can no longer become paths (claim
owners and record roles are whitelisted where they are read, and every derived
path is proved inside the jobs root); deliverability is versioned; a cancel
inside the supervisor's registration window is `kill-pending`, not `killed`;
control bytes never enter a record or a banner; the sight token comes from inside
the file and must return on stdout; POSIX kills reach the process group.

## 0.3.0

Sight becomes a deliverability gate (unprovable is refused;
`--allow-unproven-sight` is the recorded opt-in), access-denied counts as alive,
role claims are fenced against a descheduled claimer, a reclaim from an
unvouched-for owner kills first, failed pid-file renames are surfaced, and the
watcher's banner tells the truth.

## 0.2.0

Positive per-job sight proof, verified kills, atomic role claims,
record-authoritative delivery, consumed pid files, and the `watch` verb.

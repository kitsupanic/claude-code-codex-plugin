# Changelog

Versioning rule: **a push that changes behavior MUST bump the version** — see
[README → Releases and versioning](../README.md#releases-and-versioning) for why.

## 0.8.0

A full-repo review of 0.7.3, whose lead finding was reproduced on the shipped
runtime before it was written down. The theme repeats: a rule this runtime
states everywhere and applied in all but one place. Minor bump because there is
a new verb.

**A cancel may not write its verdict over one already reached.** Every writer in
the kill seam carries a compare-and-swap precondition — the supervisor's exit
handler, the `exec-spawning` mark, dispatch's post-spawn check all write
`expect: canonicalState === 'running'` — and `killJob`'s four writes carried
none. Its stale-snapshot re-read compared the launch *phase* and the pid list
and never the *state*, so a verdict landing in the gap was invisible and the
decision was made on the pre-gap read. Reproduced: the supervisor writes
`failed(sight-unproven)` or `done`, the cancel kills a supervisor that was
already exiting and writes `killed` over it — `killed(sight-unproven)`, the pair
`commands/list.md` documents as impossible, or a deliverable answer destroyed.
The same hole was reachable through `--force` by two routes. All four writes are
CAS on "the state is still live" now, the re-read watches the state too, and a
precondition that loses is not a lost write — it is a *found verdict*: nothing
overwritten, nothing killed, no role released, and `cancel` reports
`already <state>, nothing to kill` and exits 0, the convention it has always
applied to a job that finished first. A terminal job is not a conflict, so
`--force` takes the role rather than refusing, and stops claiming a kill it never
made.

**A `clean` verb, because nothing had ever removed a job directory.** Briefs,
records, `run.log`s and answers accumulated for ever, and the only remedy was
deleting the tree by hand. `clean --all` or `clean --older-than <days>`; with
neither it removes nothing and says which to type. Eligible is
`ROLE_RELEASE_STATES` — `done`, `failed`, `killed` — and nothing else: every live
state may still own processes whose only kill targets are the `.pid` files inside
that directory, and a corrupt `job.json` is evidence. There is deliberately no
`--force` past either. Manual on purpose, never a background prune: a record is
the only account of what a job did. A job directory is dismantled with its
`job.json` **last** — an entry without one is invisible to `list`, `status` and
`clean` itself, so a removal that dies partway (a process sitting in the
directory, an antivirus hold) has to leave the record behind or it leaves a tree
nothing can ever see again — and a failed removal is reported as a `kept:` line
and a stderr warning rather than ending the run at the first stuck file.

**The junction classification now holds at the READ boundary.** `allJobs` renders
a directory junction named like a job id as corrupt so that nothing is read
through it — and `findRoleConflict` then read its pid files and its record and
probed the numbers it found on the other side. The kill was refused later by
`assertInsideRoot`; the read was not. Such an entry is refused where it is read,
blocks its role, and the refusal names the entry.

**`watch` launches THIS node — and the line it builds is now proved by running
it.** The one spawn that used the literal string `node` rather than
`process.execPath`: where node is not on the interactive PATH the window opened,
said `'node' is not recognized`, and `watch` reported success. The line is built
from `process.execPath`, quoted once by `cmdQuote`, and refused rather than
mangled when a path carries `% ! "`. The first version of that fix put the two
quoted paths straight after `cmd /k`, which does not parse an argv: with four
quotes on the tail cmd strips the first character and the last quote and runs
`C:\Program` — so an install with a space in *both* the node path and the plugin
path got a dead window and a `watching:` success, caught by review before
release. The tail is one `cmd /s /k "<command>"` string now, verified end to end
for all four quoting combinations by a test that executes it, because the broken
version satisfied an argv-shape assertion perfectly.

**The cmd.exe gate checks the jobs root.** It rides the same command line as
`--output-last-message <jobs-root>\<id>\out.txt`, and `%` and `!` are legal in a
Windows user name — so the default root under `%LOCALAPPDATA%` can carry one, and
every job failed late as `codex-argv-refused` after claiming a role and spawning
a supervisor. Refused now in `preflight` and in `dispatch` before anything is
claimed, naming `CODEX_DISPATCH_JOBS`.

**Docs:** `commands/result.md`'s "Not delivered" list omitted `unknown`, which
`result` routes there like every other non-`done` state; the README's test count
was stale again.

**Tests: 121 → 127.** Two of the new blocks fail against 0.7.3 by construction,
three scenarios between them: one moves the record to a terminal verdict inside
the injected kill pause twice over (`failed(sight-unproven)`, then `done`) and
asserts it survives, the other races a `--force` the same way. Plus the `clean`
drill (eligible jobs removed, all five live states and a corrupt record kept, a
junction named like a job id refused with nothing outside the root touched, and a
removal blocked partway leaving a job that still lists and still cleans), a jobs
root with a `%` in it refused by both `dispatch` and `preflight`, the junction
read boundary asserted through a real dispatch, and the watcher's command line
both asserted as data **and executed** for all four quoting combinations — the
data assertion alone is what let the `cmd /k` regression through.

## 0.7.3

A fresh single-arm review of 0.7.2, its two lead findings reproduced before
they were reported. The core held — containment, claims, the record lock, the
kill machinery and the delivery gate all came back sound. What gave was the
seam where the parent and the supervisor both hold a pen over one verdict, and
the seam where a probe that never ran was still spelled as one that found
something.

**Only a cancel-shaped state is a cancel.** Dispatch's post-spawn check fired
on any non-`running` record — and the supervisor reaches a terminal verdict
faster than the parent gets there, because the parent spends half a second in
PowerShell on pid start times. Lose that race and dispatch killed a pid that
was already gone and wrote `killed` over the supervisor's real verdict:
reproduced as `killed(sandbox-blind-precheck)`, a state/reason pair the docs
call impossible, under a message about a cancel nobody ran — and a
`claim-lost` lost its takeover evidence the same way. The check now fires only
on `kill-pending` / `killed` / `kill-failed` (`CANCEL_STATES`); any other
verdict is the supervisor's own, reported on stderr and left exactly as
written, and the dispatch still exits 0 — an exit code that depends on who won
a millisecond race is not a fact about the job.

**A probe that could not be POSED is not a probe that found blindness.**
0.5.0 drew that line inside `sandboxRead` and left both outer entry points on
the old classification: a job cwd that does not exist, and any throw inside
the probe wrapper (an unquotable `CODEX_DISPATCH_BIN` lands there), were
recorded as `sandbox-blind-precheck` — a typo'd `--cd` told the user to
reinstall codex. Both now record `sight-probe-error` naming the actual fault,
and dispatch refuses a missing or non-directory `--cd` up front, before
preflight, the claim or any spawn.

**`,` `;` and `=` end a cmd.exe token exactly as a space does.** `cmdQuote`'s
trigger set did not include them, so a codex binary under `D:\tools\codex,v2\`
failed every invocation — measured, status 1, "not recognized" — and via the
old probe classification that spelled itself as proven blindness. The three
delimiters now trigger quoting; argument position was never affected.

**Releasing the role is a claim about what is alive.** The supervisor's exit
handler refused to rewrite a record that had stopped saying `running` — and
then released the role anyway, including for `kill-failed`, whose whole
contract is that the job keeps blocking dispatch. Only `findRoleConflict`'s
backstop was keeping that promise. Release now happens only from `done` /
`failed` / `killed` (`ROLE_RELEASE_STATES`); a survived kill, a pending one
and an unreadable record all keep the claim — silence is not death. And the
finalization write in that handler is caught rather than trusted: a record
that could not be written is reported into `run.log` and stderr instead of
taking the whole handler down with it.

**A reaped pid is never a target again — wherever the number comes from.**
`killJob` filtered the pid-file targets through the reaped list and pushed the
record's own `supervisorPid` / `codexPid` / `codexPids` straight in, so the
documented "re-run this cancel, it will not fire at anything again" was false
whenever the reap succeeded and the record write did not. The whole gathered
set is filtered now.

**Docs caught up where they had drifted.** The README's release-discipline
paragraph — the one whose subject is keeping the version honest — still said
0.7.1; DESIGN.md still described the `child.pid` kill surface 0.7.2 removed;
TESTS.md counted nine test knobs when there were twelve; and `cancel.md`
listed four live states on the one page where a user decides whether a
`kill-pending` job is cancellable. It is, and now the page says so.

**Tests: 111 → 121, and the seams are covered.** A new
`CODEX_DISPATCH_TEST_SPAWN_PAUSE_MS` knob holds the parent in exactly the
window the race lived in, and a test proves the supervisor's verdict survives
it. State/reason *pairs* are enforced two ways — a source-level scan of what
the runtime writes, and a sweep of every record the suite put on disk, because
the reproduced corruption was made by two writes and no single literal. A
nonexistent `--cd` is refused without a job directory or a claim; the three
cmd.exe delimiters round-trip end to end through a real `.cmd` under
`to,ols;x=y`; a `kill-failed` job is shown keeping its claim after its
supervisor exits; and a pid on the reaped list is never fired at again even
when the record still names it.

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

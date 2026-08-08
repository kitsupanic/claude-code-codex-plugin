# Changelog

Versioning rule: **a push that changes behavior MUST bump the version** — see
[README → Releases and versioning](../README.md#releases-and-versioning) for why.

## 0.8.6

A fourth opinion from GPT-5.6, adversarial and aimed at the **kill seam** — and
the first review of this arc to be refused by Codex's own content filter. The
framing was "construct an interleaving that kills a wrong target", which reads as
offensive-security work; re-dispatched with the framing the task actually had — a
correctness review of this project's own process-termination code — it ran. Seven
findings, five High and two Medium as filed. All seven adjudicated by six
independent arms, and adjudication did two things worth recording: it brought the
severities down substantially (one High held, the rest Medium or Low), and it
collapsed the seven into **one** root concern. Patch bump: no new verb, no schema
change, and **no new reason** — every fix reused the reasons already there — with
a shared thesis: **identity fails open to kill, and closed to write a target
down.**

**The kill decision stays fail-open, and that is the organizing choice.** A pid
whose identity cannot be proved but which is genuinely alive must still be
killable: a slow process table or a timed-out query is not evidence of innocence,
and withholding the signal leaves a real codex billing with nothing left that can
stop it. So the primary kill keeps its rule that the check only ever *subtracts*.
Two adjudicators looked like they disagreed about the fail direction; the
reconciliation is that they were about different kill sites, and the discipline
that changed is the discipline of the **writes**. What gets **recorded** as a
target fails closed, because a pid written into the record beside its own start
time matches itself for ever — a stranger vouched for once is vouched for
permanently, and every later check confirms the forgery. What is **verified dead**
is always marked spent, because an unrecorded verified kill re-arms the number.
And the **cache** is never poisoned by a query that failed. Above all of them, the
launch phase may never rewind.

**Dispatch's post-spawn write was the seam's one non-CAS writer.** A shallow
merge, landing after the supervisor had already reached `exec-spawning`, could
rewind `launch` back to `spawned` and wipe the codex pids' start identities in the
same stroke — so a POSIX cancel read the earlier phase, killed the supervisor,
never touched the detached codex, and recorded the job killed while it went on
billing. The single most consequential finding of the review and the one High that
survived adjudication intact. It is a function-patch now: `pidStarts` merges
rather than replaces, and the phase only ever advances.

**A "no opinion" is not an identity, and the Windows descendant walk used to
treat it as one.** With start times absent or tied, the walk could promote an
unrelated process into `codex.pid` — and record it with **its own** start time, so
every identity check afterwards was perfectly self-consistent about the wrong
process. The result is a `taskkill /T` at a stranger's entire tree, and it is not a
transient: it is the job's recorded truth for the rest of its life. Closed at the
recording site with a **wrapper-start floor** — a descendant older than the wrapper
that spawned it is never written down — which is the fail-closed direction applied
where it belongs, on *adding*. Ties are accepted deliberately: `cmd.exe` spawns
node within milliseconds of itself, and a floor that rejected equal starts would
reject the real worker.

**A cached miss from a query that never ran disarms the check for ever.** The
start-time lookup cached its negatives on a comment that justified it — "it won't
answer better later" — which is true of a process that does not exist and false of
a fifteen-second timeout under load. The false half latched "no opinion" into a
per-process cache: through every retry, and through the entire life of the
long-lived watch loop. The cache is now written only on a query that **succeeded**
with a genuinely absent row. A query that could not run answers nothing and
remembers nothing.

**Round 2 of `killPids` re-fired at pids round 1 had watched die.** A number
reissued inside the verify window got its inheritor's tree signalled by the second
round of a kill that had already worked — the reuse hazard produced by the
mechanism that exists to be thorough about reuse. Round 2 skips a seen-dead set
collected from round 1, which has the incidental virtue of making the code's own
comment ("nothing is signalled twice") true as written rather than aspirational.

**A survivor that nothing can retry is not a survivor, it is a sentence.** A
kill-failed late worker was reported to the operator as surviving and then
discarded: survivors were display text, never persisted as targets, so the retry
that the whole `kill-failed` state exists to arm was a permanent no-op — and on
POSIX a reparented survivor could go on billing under a record that said `killed`.
Survivors are persisted as **identity-anchored** targets now, with an anchor the
record already holds always winning, so a number that fail-open waved through
cannot self-stamp over a real identity.

**0.8.5's own registration-failure cleanup left a verified kill unrecorded.** The
kill it fires is verified, and its pid was left un-spent under a live
`kill-pending` — so a retry re-fired that number at whoever had inherited it by
then, which is the precise hazard the reaped ledger was built for, reintroduced by
a release that was tightening the same seam. It records the pid reaped, and the
ledger's unlocked fallback means the mark lands even when the lock is refused.

**And that fallback was losing writes.** The unlocked last resort did a
read-modify-write on the shared ledger, so under contention one writer's spent
marks silently dropped another's — re-arming exactly the numbers the file exists to
retire, on the path taken when things are already going badly. Each writer stages
its **own** sidecar now and readers take the union: no lost update by construction,
and the write is tmp+rename, so no reader ever sees a torn line.

**A POSIX child can leave the process group and the parent chain both, and then
nothing was looking for it.** The group kill misses it and the descendant walk
cannot reach it. The process table carries a **session** column now, and any live
pid in codex's session is a target. The residual is stated in the same breath
rather than implied away: a child that calls `setsid()` outright leaves the session
too, and this finds nothing it cannot see.

Alongside them: `reapUnvouchedJob` routes through the identity filter — a **TOCTOU
backstop** today rather than a live guard, since every current caller reaches it
only with unreadable records, and it is documented as exactly that; session
parsing is decimal-only; and the comments and DESIGN passages where the prose
promised more than the code delivered are corrected in the same pass, which is
0.8.5's finding applied to itself.

**Residuals, stated rather than closed.** The POSIX session sweep and the decimal
parser have never run against a live `ps` — the host is Windows-only and there is
no CI standing behind them. macOS worker resolution records **no** discovered
descendants at all: there is no `etimes` to floor them with, so it falls back to
the wrapper-only path and warns. The survivor persist can still anchor a
never-recorded stranger inside a seconds-wide reuse window, and DESIGN carries the
argument for why a floor there would cost more than it buys rather than a claim
that the case is handled. And the full-`setsid()` session-leaver is undiscoverable.

**Test hooks: two new knobs, and adjudication named both as the reason these
survived the last sweep.** `CODEX_DISPATCH_TEST_REGISTER_PAUSE_MS` holds the
dispatch between spawning the supervisor and the write that registers its pid —
the only point from which the phase-rewind interleaving can be posed, since the
existing spawn pause sits *after* that write. `CODEX_DISPATCH_TEST_NO_START_TIMES`
makes the start-time query unable to run at all, which is the cache-poison case.
Both are inert unless set.

**Tests: 110 → 117 in the dispatch suite, 171 total.** One POSIX-only test is
present and **skipped with its reason visible**: the session sweep cannot be posed
from node, because `detached` there *is* `setsid` and the child leaves the very
session the test needs it to stay in. Several properties are review-pinned rather
than tested and say so in comments, in the file's existing idiom — pid reuse inside
a ~3s window is not producible on demand, and a test that pretended otherwise
would be testing its own scaffolding.

## 0.8.5

A third opinion from GPT-5.6, and this one was not aimed at the code at all: a
**docs-truth audit**, every claim DESIGN.md makes about the record lock
classified against the source that is supposed to implement it — 72 TRUE, 30
OVERCLAIM, 2 STALE. It found four code defect clusters, which makes it the most
productive review of this four-release arc. That is the finding, and it is worth
saying plainly: prose that overstates what the code does is usually not a writing
error, it is the first visible symptom of the code not doing it. Patch bump: one
new reason, no new verb, no schema change, and a shared thesis: **a claim is not
a fact — in the prose or in the writes.**

**The acquisition guard failed OPEN, in the release whose thesis was
fail-closed.** 0.8.4's guard reads the job directory before staging and refuses
past a live lock stranded in a tombstone. Its `readdir` was wrapped in a bare
`catch` returning "no blocker" — the one observation in this seam pointed the
wrong way, and it readmitted the exact silent double-hold the guard was built to
close: a directory that cannot be enumerated is not a directory without
tombstones, it is no evidence either way, and unproven absence does not stage.
Three-valued now. `ENOENT` alone means gone — a job directory that is not there
holds no tombstone, and staging's own `mkdir` stays the fast honest failure for
that case rather than being pre-empted by a fifteen-second wait for a lock in a
directory nobody will ever create. Every other errno is `unenumerable` and
blocks, and it gets **its own refusal**: routing it through the stranded-lock
message would have named a tombstone nobody read and sent an operator to inspect
a path this process never saw, which is a refusal inventing its own evidence.

**Releasing is a break of one's own lock, and it now follows the same discipline
as every other one.** The release was the last bare `rmSync` on the canonical
lock path — the same non-atomic hazard the sweep and the break each shed in
0.8.3, and the same measurement behind it: Node's recursive removal unlinks the
holder file before the directory, leaving the lock standing and **empty** for as
long as the rmdir takes, which is precisely the holderless lock staged
acquisition exists to make impossible. The identity test in front of it was a
two-step bound to a pathname, so a stale break landing between the check and the
removal made "ours" true about a lock that was somebody else's by the time it was
deleted. So: rename to a tombstone, re-read the holder, compare **pid and
nonce** — the `tombIsCondemned` test applied to release — and only then remove.
A mismatch is somebody else's lock: it goes back if the path is free, is left
standing if it is not, and is never removed. **And the unreadable case gets its
own words**, because it is not that finding: a holder file that will not read
microseconds after our own rename of our own lock is a transient far more often
than it is a break, and the break sentence asserted as fact a thing this release
cannot prove. What it can say is that ownership is unverified, so nothing was
removed.

**A blocker holding our own live pid is our own release litter, and clearing it
is finishing our own release.** The rename-first release has a failure mode the
old one did not: a swallowed final `rmSync` leaves a `.stale-*` tombstone naming
a pid that is alive — this one. The guard cannot tell that from a stranded
holder, so it would block every later acquisition of that job *including this
process's own*, for as long as this process lives, with the sweep that would
collect the thing sitting behind the guard: a wedge produced by tidying up. Both
guard consumers clear it instead. The predicate is deliberately the **pid alone,
not the nonce** — the nonce is the right test everywhere else, and the wrong one
here, where it would refuse to clear litter left by an earlier acquisition of
this same process, which is most of it. What makes the wider match safe is a
property of the runtime and not of the filesystem: single-threaded, one record
lock at a time, so at the moment the guard asks there is no acquisition of ours
in flight and a self-pid tombstone can only be litter. `withRecordLock`'s
`stranded` tombstone is explicitly excluded — it holds somebody else's **live**
lock this process moved and owes a restore to. It is written down as one of the
predicates that must be rewritten before anything here becomes concurrent.

**The checked-writer discipline stopped one layer short of the two writes that
matter most.** Terminal finalization — the loudest verdict this runtime produces,
the one the whole job exists to reach — could fail without throwing: a `locked`
or `corrupt` answer came back as `null`, the exit handler went straight on to
release the role, and the record still said `running` beside a finished
`out.txt`, with nobody alive to re-run the write. It reads `stale` for ever,
holds its role, and `result` refuses the answer codex was paid for. It is checked
now, and the three answers are three different findings: `precondition` is a
**found verdict** and this stays silent about it, `locked` is contention this
writer can afford to insist against (`TERMINAL_WRITE_RETRY` — five attempts
inside a minute, ~75s worst case, because the detached supervisor has nothing
else to do and every second not spent here is a job that reads stale), and
anything still unwritten after that is reported in the run log and on stderr,
naming the out file and the one cure: `cancel`.

**A codex whose pids never reached the record is a run nobody can cancel, so it
is not allowed to continue.** The registration write was fire-and-forget, and it
is the write that turns a spawned codex into a *killable* one. Lost, the record
keeps `launch: 'exec-spawning'` with no `codexPids`, so `killWindow` answers
"exec" for the supervisor's whole life: every cancel writes `kill-pending`, kills
nothing, and the finalizer's own compare-and-swap then loses to that
`kill-pending` — a run stoppable only by promise, billing to completion. It is
insisted on tightly (`LAUNCH_WRITE_RETRY`, one full lock wait and one more, ~30s)
and a failure **kills what was just spawned**: milliseconds of codex is a cheaper
thing to lose than the only handle on it, and the pid is in hand right there,
which is the whole reason that line exists. The kill is held to the same bar as
every other one in this runtime — nothing survived, and something actually
looked — and an unverified one **keeps the role**, because handing a claim away
while something that bills may still be alive is the `kill-failed` mistake under
another name.

**Two more writes ahead of the spend, and both refuse before it.** The sight
label is the only evidence the delivery gate ever reads, so a label that does not
land is a run that can never be delivered however well it goes — refused as
unvouched with codex already paid for. It was fire-and-forget, which put the
proof this release spends a shell probe to establish on the hope that a lock was
free; it is retried and, failing, refuses **before** anything is launched. The
pre-spawn launch marker is the same argument one step further: unchecked, a
refused write left `launch: 'pending'` under a supervisor that was launched
anyway, and "nothing was ever started" is the one reading that lets a cancel call
a running job dead. It aborts before the spawn. Alongside them, `claim-lost` is
checked and says so when it could not be recorded, the supervisor's own
pid-registration failure stops reporting a merely-unlockable record as a corrupt
one, and **dispatch's two nothing-was-spawned finalizations gained the
`notCancelAuthored` precondition** their supervisor-side siblings have carried
since 0.8.1 — the state is `launch: 'spawning'`, deliberately one a cancel may
act on, so both writes could land on a cancel's verdict and hand the role away
underneath it. All three of the spawn-failed, dispatch-failed and claim-lost
reports now branch honestly on what the write actually did.

**`clean` may not delete a record it could not read.** `removeJobDir` read the
record it puts back on a failed removal through a catch-all that treated *any*
error as "already gone" — and read it *after* the children loop, where a failure
meant the safeguard silently did not exist at all: the last step could then fail
with nothing in hand and leave exactly the unlistable directory the ordering
exists to prevent, while `clean`'s summary said nothing was left half-removed.
The read is hoisted above everything that unlinks, and **any** failure refuses
the job untouched. An absence there is incoherent — this runs under the record
lock, milliseconds after `cmdClean` read the same file — and an unreadable record
is evidence the file is there and cannot be safeguarded.

**And the prose the audit graded.** Sixteen corrections, each one a claim the
code does not make: what the `generation` counter is and is not, that
`recordVersion` is a *schema* stamp and cannot gate two runtimes' lock protocols
against each other, that the sweep is opportunistic rather than scheduled, that a
tombstone mismatch means *unproven* rather than *stolen*, the difference between a
transient unreadable holder that clears itself and a persistent one that is a
manual-repair wedge, the corner where a restore leaves things neutral-to-slightly-
worse, what actually causes a rename to fail on each platform, and how wide the
pid-reuse window really is. `refuseBeforeLaunch` gained a `spawned` option in the
same pass, because its "Nothing was launched" sentence became false the moment a
caller reached it with a codex spawned and killed — a message that is false in one
caller is the same defect class as everything else in this catalog. TESTS.md's
knob count went 14 → 20 and README's current release 0.8.1 → 0.8.5.

**Test hooks: one new knob, and it is a budget, not an answer.**
`CODEX_DISPATCH_TEST_WRITE_BUDGET_MS` shortens the *time budget* half of both
checked-write retries and nothing else — reaching either retry means a wedged
lock, and every attempt inside one costs a full fifteen-second lock wait, so the
unshortened test is one nobody would run. The attempt caps, the decision to retry
only `locked`, and every message ship exactly as tested.

**Tests: 105 → 110 in the dispatch suite, 164 total.** Each new one was pinned
non-vacuously against a deliberately broken copy of the guard it covers: the
finalization-under-a-wedged-lock control has the supervisor exit in **total
silence**, leaving a finished answer beside a record that says `running`, and the
registration-refusal test asserts the whole grandchild tree is dead.

## 0.8.4

A second opinion from GPT-5.6, this time on 0.8.3's own break protocol — the
entry below — read against the source before a line was changed. Six findings:
five confirmed by adjudication, two of those reproduced or measured live, and
one partial whose probability story the adjudication refuted. Patch bump: no new
verb, no schema change, and a shared thesis: **a live lock in a tombstone still
holds the record.**

**A live lock stranded in a `.stale-*` tombstone while the canonical path stands
free is one terminal state behind three doors, and acquisition now refuses past
it.** A breaker that crashes between its rename and its restore; an existence
probe that answers "gone" for a directory that is merely unreadable; a restore
that failed because a third writer took the path — all three end in the same
place, somebody's live lock in a tombstone and `job.json.lock` empty. Acquisition
consulted only the canonical path, so the next writer took it and the stranded
holder was in a **silent double-hold**: two writers under one record, arrived at
by way of the mechanism that exists to prevent exactly that. Reproduced on this
machine — a real cancel acquired past a hand-built strand in ~80ms, stderr empty,
and because the two writers' generation numbers collide the lost update is
forensically invisible afterwards. So the job directory is read before staging,
and a tombstone whose holder is alive — or **unreadable**, fail-closed like every
other reading in this seam — blocks. 0.8.3 closed the break's front door; this
closes the room behind it.

**The block is the mechanism, and its cost is stated rather than implied away.**
A tombstone whose holder is dead or absent blocks nothing: it is litter awaiting
the sweep, and waiting on a corpse would wedge every acquisition in the job
behind something nothing will ever come back for. What does block, blocks for
exactly as long as the stranded holder's **process** — while it runs, every
acquirer of that job waits its fifteen seconds and refuses loudly, which is
correct, because that process still believes it has the record; when it exits the
tombstone reads dead, stops blocking, and a later sweep collects it. The refusal
names the tombstone and says what will and will not lift it, because "could not
be locked; re-run" is useless advice against a live lock sitting in a directory
nobody looks in. An unreadable holder file can never read as dead and so is a
manual-repair wedge, deliberately; the message says so. All of it is in DESIGN's
residuals as what the guard itself costs, beside the state it replaced.

**The heal is the breaker's own, and the rest is redundancy that says so.** A
breaker whose restore failed keeps the tombstone in hand and retries the rename
at **every turn of its own wait**, taking no lock itself until it lands — so a
strand whose breaker survived is repaired in milliseconds, and the deadline
refusal, if it comes, names the tombstone still held. Behind the guard, the sweep
now **restores** an aged live-holder tombstone rather than merely skipping it, and
**re-reads the holder of the tombstone it won** before removing anything, putting
anything live back rather than deleting it. Both are defense-in-depth: with the
guard in place the only route to a strand this process did not cut itself is the
guard-to-stage microsecond TOCTOU or a source-path ABA between two sweepers,
which nothing in this runtime can produce on demand. They are recorded as
unexercised rather than counted as covered.

**Only `ENOENT` is "gone" — the discipline the holder read already followed, now
applied to the probes.** Two `existsSync` calls decided whether a condemned
tombstone had been collected, and `existsSync` answers **false for a directory
that is there** and could not be statted: an ACL, `EPERM`, `EBUSY`, a cloud
filter. Demonstrated against a real directory ACL. Reading that as "collected"
skipped the verification entirely and left whatever stood in the tombstone
unexamined, which is one of the three doors above. Both became three-valued
`statSync`: `ENOENT` alone is absence, and anything else is present-but-
unmeasurable and falls through to the fail-closed verification. **The failed
restore's diagnosis rests on the rename's own errno**, not on a second probe
taken at a later moment against a racing directory — on Windows it could not have
told the two causes apart anyway, since both a pinned source and an occupied
target come back `EPERM`, and the measurement behind that is Defender's
on-access scan being summoned by the break rename itself. The calm branch also
stopped over-claiming: a tombstone that vanished may have been *restored* by a
sweeper that found its holder alive, not only collected by one that proved it
dead, and the message now covers both.

**The holder file carries a pid and a nonce.** The break's identity check
compared an mtime and a pid, which is a fingerprint rather than an identity: two
locks can share both. Sixty-four bits from the OS CSPRNG are written fresh on
every **acquisition** — never per process, because one process locks the same
record many times in a run and two of its own acquisitions must not match each
other — so `tombIsCondemned` compares what it condemned rather than what merely
resembles it. Liveness readers parse the leading digits and ignore the rest. The
mtime-and-pid collision this closes was the one partial finding: adjudication
showed its precondition is a backward clock step of five seconds or more, not the
ordinary race it was reported as, and the fix closes it outright regardless.

**The wait bounds are monotonic.** The lock's fifteen seconds, the worker-resolve
poll and the kill verification now measure with `performance.now()`. Each is
compared only against readings taken in the same process, and a wall-clock step —
NTP, a manual set, a VM resume — must not be able to shorten or extend a wait a
caller is blocked in: a wait bound is a promise. Ages, grace windows and
timestamps stay on the wall clock, because an mtime is a wall-clock fact and
nothing else can be compared with one.

**`clean` refuses a job whose directory holds a live-cargo tombstone.**
`removeJobDir` deletes everything but the record and the lock, tombstones
included — which would have been the one deletion of a live lock this runtime
performs, by way of the verb whose whole job is tidying up. The job is refused
instead, loudly and per job, the way `clean` already refuses any directory it
cannot finish: one stuck job does not end a clean run, it lists, and a later
clean takes it once the holder is gone.

**Test hooks: one new pause point.** `RESTORE_PAUSE` stands a breaker between
moving a successor into its tombstone and putting it back — the window in which a
third writer can take the freed path and make the restore fail — because a window
of a chosen length there is not producible on demand.

**Tests: 100 → 105 in the dispatch suite, 159 total.** Each new one was pinned
non-vacuously against a deliberately broken copy of the guard it covers; the
room-closure test's control reproduces the pre-fix silent double-hold in 60ms.

## 0.8.3

A second opinion from GPT-5.6 on 0.8.2's own lock rework — the entry below —
read against the source before a line was changed, and the pre-commit review's
three closing notes with it. All three findings confirmed by adjudication; one
reproduced live. Patch bump: no new verb, no schema change, three fixes, and a
shared thesis: **the destroyer must prove it is destroying the thing it
condemned.**

**The stale break is bound to the condemned lock's identity, not to its
pathname.** The entry below called the rename to a tombstone "exactly one
winner". It is one winner per *rename*, which is not the same as per *lock*,
and the gap between the two is a whole ABA: two breakers stat the same dead
lock and both condemn it, the first breaks it, re-acquires and publishes a
**live successor** at the same path — and the second, descheduled in between,
renames that successor into its own tombstone and deletes it. Two writers in
the critical section, arrived at by way of the mechanism that exists to stop
them, and a pathname was the whole of what bound the decision to the act. So
the decision now records what it condemned: the lock's **mtime** — never
refreshed while a lock lives, and untouched by a rename — and its **holder** as
read at that moment, a pid or a genuine absence. The removal runs only against
a tombstone that still matches both. A mismatch means a live successor was
moved, so it is renamed straight back, never removed, and said loudly: a
mismatched tombstone is somebody's lock, not a tombstone. What is left is
stated rather than claimed closed — the lock path stands empty for the
microseconds the restore needs, and a third writer publishing into that gap
makes the restore fail. The victim's lock is then **stranded in the tombstone
rather than deleted**, where it can be inspected, and DESIGN's known issues
carry it as the three-writers-in-one-microsecond residual it is.

**Only `ENOENT` is "no holder".** The proof of a dead holder reads the holder
file, and a read can fail for reasons that have nothing to do with the holder:
an antivirus sharing violation, an ACL, `EIO`, a cloud filter waking the file
back up. Every one of them collapsed to "nothing there", which made a transient
error on a **live** holder's file the permission to break its lock — the one
read in this runtime that failed open, in the one place that cannot afford to.
An unreadable holder file is evidence a holder **exists**: it answers alive now,
the breaker's obligation is unmet, and no break follows. The age-only break is
reserved for a holder that is genuinely absent or is not a pid at all, which
since acquisition became atomic can only be a pre-upgrade artifact or a corrupt
directory. **A lock that will not stat no longer fabricates staleness** for the
matching reason: both failures used to land on an infinite age and condemn, so
an absent lock renamed nothing and an unreadable one went round the
condemn-rename-restore path every 20ms — a warning storm over a lock path
repeatedly emptied on no evidence at all. `ENOENT` is the lock **gone** and
re-stages immediately; anything else is a lock that is **there** and
unmeasurable, and an age that was never measured is not an age.

**The staging sweep is a rename first, then a removal**, for the same reason
the break is. A recursive `rmSync` is not atomic and has no winner: it unlinks
the holder file before the directory, and a stage's owner never checks its own
stage before publishing — it checks the lock. So an aged-but-still-owned stage
hollowed out by a sweep gets renamed onto the lock path by its owner as an
**empty lock**, which is precisely the holderless lock the staged acquisition
exists to make impossible; reproduced on this machine as `acquired: true` over
a lock directory with zero entries. An aged orphan is moved to a unique
tombstone first, so a failed rename means the owner or another sweeper has it
and its contents are never touched, only what this process moved is removed,
and a removal interrupted halfway strands an empty tombstone rather than
anything on a stage or a lock path. The sweep now collects **abandoned break
tombstones** too, so a breaker that dies between its rename and its removal
leaks a directory that ages out instead of one that never goes — but it refuses
any tombstone whose holder is **alive**, and skips an unreadable one
fail-closed in the same direction as the break. A tombstone can hold a live
lock: a slow holder past the stale mark is condemned for its age, and what
stands in the tombstone until the restore runs is that holder's own lock. A
tombstone with a live holder is a mid-flight restore's cargo, not litter, and
collecting it by age would be the single path in this whole mechanism where a
live lock is deleted rather than stranded.

**Two new WARNING shapes, and the split between them is honest.** A break that
moved a live successor and put it back says so and names nothing to inspect. A
break whose condemned tombstone was collected by a concurrent sweeper before
the put-back could run says *that*, and says it calmly: the sweep will not
collect a tombstone whose holder is alive, so one it did collect held a dead or
absent holder — exactly what the break condemned it for — and nothing live was
removed. Only the third case, a restore that lost the lock path to another
writer, carries the loud sentence: the tombstone is named, it is left standing,
and its holder has lost mutual exclusion.

**Test hooks: two new pause points.** One stands a process between condemning
a lock and moving it — the window in which a live successor can take the path —
and one inside the sweep between the rename that wins an orphan and the removal
of what it won, which poses the interrupted sweep from outside. Both go through
`testPauseMs` like the rest.

**Tests: 95 → 100 in the dispatch suite, 154 total.** Each new one was pinned
non-vacuously against a deliberately broken copy of the guard it covers.

## 0.8.2

A two-model review of `5f9f292..HEAD` — the Claude arm reading beside the suite,
GPT-5.6 asked for a second opinion — and where the two arms disagreed the finding
was adjudicated against the source before a line was changed. Patch bump: no new
verb, no schema change, seven fixes.

**A lock is never visible half-built.** The holder pid the stale break relies on
was written *after* the `mkdir` that created the lock, and the gap between those
two steps is a lock that exists with nothing inside it: a second writer stats it
past the stale age, finds no holder it can prove alive, breaks in — and the
first, merely descheduled, resumes and writes its pid into the breaker's fresh
directory at the same path. Two writers in the critical section, which is the
exact lost update the lock exists to close, reintroduced by the acquisition
itself. The lock is assembled out of sight now and published in one step, the way
role claims are: the holder file is written inside a staging directory, and the
**rename of that directory onto the lock path is the acquisition**. A failed
rename is "somebody else has it", the answer `EEXIST` used to give; orphans left
by an acquirer that died mid-stage age out and are never mistaken for the lock,
which is one exact path. **Release is by identity, not by path** for the matching
reason: `rmSync` removes whatever is at the path, and after a legitimate stale
break that is somebody *else's* lock — the writer that finishes first deleting a
directory another is still working under. A releaser now removes the lock only
while the holder file still names its own pid. What is left is stated rather than
claimed closed: POSIX `rename(2)` replaces an existing **empty** directory, so an
acquisition could land on one at age zero — but every lock this release publishes
already has its holder inside it, and the only empty lock in reach is an *old*
release's, caught mid-gap. Existence of the lock path is treated as contention,
which leaves the check-to-rename gap and nothing wider, and it is in DESIGN's
known issues as the mixed-version residual it is.

**The kill window that actually kills is fenced with `kill-pending` before it
kills.** Reading the process table costs seconds, and for all of them the record
went on saying `running` — which is precisely the precondition the supervisor's
`launch: 'exec-spawning'` compare-and-swap asks for. A supervisor reaching that
mark between the kill's snapshot and its signals spends money the kill can no
longer reach: off Windows codex is detached, leads its own group, and reparents
to init the moment the supervisor dies, so the leftover sweep finds nothing
descended from anything and the pre-kill record carries no `codexPgid` to check
it by. A verified kill, a released role, and a billed orphan with no recorded
target. The mark is written first now, the record lock totally orders the two
writers, and the re-read taken behind the fence answers with the codex-exec
window — the supervisor, the one process that knows what it just spawned, lands
the pending cancel itself. A corrupt record is excluded on purpose: refusing to
kill because a fence could not be written would spare the very orphan the fence
exists to catch. **The post-kill survivor check re-reads the record** for the same
reason — a pgid or a codex pid registered *during* the kill is a target it must
look at — and a fresh read that comes back corrupt leaves the stale one standing,
so this can only add targets, never subtract them. And **a pid file is consumed
only when every number in it was fired at**: renaming them all regardless
destroyed targets nothing had shot at, because a `codex.pid` written moments
before a supervisor died is the only recorded target its orphan has.

**A corrupt-record cancel that could not enumerate refuses instead of spending
its targets.** Every other writer in the kill seam already treats
`enumerated: false` as a failed verification — `killJob` lands `kill-failed`, the
reap of an unvouched-for job refuses the takeover — and this branch warned, reaped
the pid files anyway, and exited 0. Those files are the only kill targets a
corrupt job has, and the retry the warning asked for then read "already reaped"
and fired at nothing. It exits 1 now, keeps the files loaded, and says to re-run
when the process table answers.

**The supervisor's seven pre-launch refusals are compare-and-swap.** A record
version mismatch, a blind sandbox, a probe that could not be run, sight left
unproven, an argv `cmdQuote` refuses, a spawn that fails, and the honouring of a
`kill-pending` all write a verdict before codex exists — unconditionally, with a
sight probe's seconds of shell sitting between the record they read and the write.
A cancel that reached a verdict inside that gap was overwritten by a `failed`
about a launch that never happened, and had its role handed away underneath it:
`killed(sight-unproven)` from one direction, a `kill-failed` whose role went free
from the other. Six of the seven now require a live state that is **not
cancel-authored** — `stillCancellable` alone was not the line, because
`kill-pending` and `kill-failed` are live states (they must be: a second cancel
has to be able to retry them), so a refusal satisfied it and wrote straight over a
cancel's verdict, releasing the role `kill-failed` exists to keep blocked, after
`cancel` had already told the operator that survivors exist. A cancel-authored
state is the cancel's to resolve: the refusal that finds one **stands down**,
overwrites nothing, releases nothing, and says what it found in `run.log` and on
stderr. The seventh is the exception in the other direction — the honour path
expects **exactly `kill-pending`**, the state it read, because it is not
overwriting that cancel but carrying it out, and the `stillCancellable` it used to
carry also accepts `kill-failed`, so a cancel reaching that verdict in the gap
would have been replaced by `killed(cancelled-during-registration)` with its
survivors cleared and its role released. All seven clear `killSurvivors`, so a
`failed` never inherits an earlier cancel's survivor list. A write that could not
be made *at all* is the one different answer: it found no verdict, codex was never
launched, and the claim is still the supervisor's own to give back.

**A kill that lost its swap to a real verdict is reported as one.** The
`kill-failed` write — the one landing *after* the signals went out — was the only
loss in the seam that came back without the verdict attached, so `cancel`
announced `state: kill-failed (NOT killed)` for a record saying `done` and exited
nonzero, and `--force` treated a job that had genuinely finished as an unresolved
conflict and refused to launch. Both read it as terminal now, and neither borrows
the finished-job sentence: it says *finished as `<state>` while the kill was
verifying*, because "nothing was killed" would be a claim about processes this
cancel really did fire at. The survivors, or the unreadable process table, stay on
stderr where the kill wrote them.

**`clean` never writes `job.json` outside the lock.** `removeJobDir` holds the
record's bytes across the final `rmSync` and puts them back if it throws — but a
recursive removal takes the children first, the held `job.json.lock` among them,
and only *then* fails on the directory, so that restore was an unlocked write over
a lock-governed file. The order is fixed instead: the record is removed while the
lock is still held, the lock is handed back next by the same identity test
`withRecordLock` releases by, and a restore re-acquires it through the ordinary
path. A restore that cannot take the lock writes **nothing** and says so — a job
nobody can list is recoverable by hand; a record two writers wrote at once is not.

**Test hooks: two new pause points, and all seven made incapable of hanging.**
`Atomics.wait` treats `NaN` as *no timeout* and waits for ever, so `Number(env)`
on a typo or a shell that exported the name empty turned a test hook into a wedged
process with no output. Every hook goes through `testPauseMs`, which reads
anything non-finite or non-positive as unset and clamps the rest to the record
lock's own patience. The two new points hold a process immediately before the
verdict compare-and-swap in `killJob` and before the supervisor's pre-launch mark
— the only places from which the interleavings above can be posed, since the
existing pauses all sit before a bail that already answers.

**Tests: 83 → 95 in the dispatch suite.** Every new one was pinned
non-vacuously: each was verified to fail first against a deliberately broken copy
of the guard it covers, so none of them passes by construction.

## 0.8.1

A dual review of 0.8.0, and its lead finding is a correction to what 0.8.0
itself claimed. Patch bump: no new verb, no schema change, six fixes.

**The one writer in the kill seam that never had its compare-and-swap was
dispatch's own.** The entry below, and `docs/DESIGN.md` with it, said the
post-spawn cancel branch wrote `expect: canonicalState === 'running'`. It did
not: it read the record once, spent the seconds a verified kill costs on the
supervisor it had just spawned, and wrote `killed` or `kill-failed` over whatever
landed in the gap — including the supervisor's own `failed(sight-unproven)`, the
pair `commands/list.md` documents as impossible. Both writes are CAS on
`stillCancellable` now, and a lost precondition is a *found verdict*: reported,
not overwritten, and **no role released**. Its kill target goes through the
reaped-pid list first, and the spent pid files are consumed only after a kill
that verified. Both passages are corrected rather than left standing.

**So was the supervisor's cancelled-during-exec landing, one writer to the
left.** It races the same cancel-shaped record from the other side: the dispatch
kills *it*, records `killed` and releases the role, while it is inside its own
kill — and its unconditioned write then landed on top, leaving a `kill-failed`
record whose role was already free. Same compare-and-swap, and a write that loses
it reports into the job's `run.log` and releases nothing: whoever's write landed
owns the verdict and the release together.

**An unreadable process table is a failed verification, not an empty tree.**
`killPids` has always reported `enumerated: false` when neither shell would
answer, and only `cancel`'s corrupt-record branch ever looked at it — so
everywhere else "nothing was seen" was read as "nothing survived": a verified
`killed`, a released role, and the codex behind a `.cmd` wrapper never checked.
`killJob`, dispatch's post-spawn branch and the supervisor's
cancelled-during-exec landing now record `kill-failed` with the unreadable table
named on the record, keep the role, consume no pid file, and say to re-run; the
reap of an unvouched-for claim refuses the takeover instead of taking it.

**A `clean` that fails at the last step no longer hides the job it could not
remove.** `removeJobDir` deletes the contents, then `job.json`, then the
directory — and on Windows that final `rmdir` fails alone whenever the directory
is some process's current one: every file unlinked, the directory left, the
record gone, and a job `list`, `status` and `clean` can never see again. Exactly
what removing the record last exists to prevent. The record's bytes are held
across that removal and put back if it throws, so a removal that fails anywhere
still leaves a job that lists.

**`kill-pending` is only reported when it was written.** `markPending` treated a
write that could not take the lock, or that found a corrupt record, as a success:
`cancel` announced "the state is kill-pending" for a state nothing had written,
and the launch-block that state exists to arm was not armed. Three outcomes now —
marked, lost to a verdict, or unrecorded — and the unrecorded one says so and
tells the caller to re-run, without claiming a kill or a state.

**Three smaller ones, same discipline.** A relative `CODEX_DISPATCH_JOBS` — the
override the README names as a cure — is `path.resolve`d, so the jobs root and
every `out:` path stop depending on the directory a verb was run from.
Reclaiming an OWNERLESS role claim is fenced as "still ownerless" instead of
"whatever is there", which is what used to let a reclaim rename away a fresh
claim whose owner had already passed its verify fence and launched. And the
record lock's stale break now needs a holder it can prove is *gone* — the lock
carries the holder's pid — rather than treating any five-second-old lock as a
dead one, which is how a live writer stalled inside its critical section lost
mutual exclusion and clobbered the breaker's write. Deliberately a pid and no
start time: reading one costs a PowerShell spawn on the lock path, and identity
here would be evidence FOR breaking a live-looking lock, which inverts the
direction that machinery is allowed to push in everywhere else. The terminal
kill patches also clear `reason`, and `result` reads the never-ran reasons only
when the state is `failed`, so a reason can no longer outrank a state.

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

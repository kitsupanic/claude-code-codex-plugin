# Design — how the runtime earns its invariants

The [README](../README.md) states the seven invariants; this file is the full
account of the machinery behind them. The production failures and review rounds
that forced each mechanism are in [REVIEWS.md](REVIEWS.md); the decisions —
including revoked ones — in [DECISIONS.md](DECISIONS.md).

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
since the same strings appear as echoed file content and in this repo's own
documentation. A hit no longer flips the state. It adds
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
| `generation` | non-negative integer | corrupt. Bumped by every locked *update*, and absent on the record dispatch first creates; a byte-for-byte restore puts back the number it read. Not a write count — see the write lock below. |

Two things sit alongside the field table because they are the same idea applied to
the filesystem rather than to the record:

- **A job directory is proved to be a real directory, inside the real jobs root.**
  Lexical containment is not containment: `path.resolve` collapses `..` and knows
  nothing about reparse points, so a junction named `review-1-2` inside the jobs
  root passed every check and then redirected everything through it. Containment is
  now proved against `fs.realpathSync.native`, links are refused rather than
  followed, and the listing walk renders one as `corrupt` instead of reading
  through it. **That classification is honoured at the READ boundary, not only at
  the kill.** The role-conflict scan treated a corrupt entry as "read its pid
  files and its record, then probe those numbers for liveness" — every one of
  those reads went through the junction before any containment check, so the
  promise the walk makes ("nothing was read through it") held only for the write
  side, where `assertInsideRoot` stopped the reap. Such an entry is refused where
  it is read now: it cannot be proved dead without reading it, so it blocks its
  role, and the refusal names the entry rather than a job.
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
- **`cancel` on a corrupt job still reaps processes**, from the `supervisor.pid`
  and `codex.pid` files the job dir carries alongside the record — and
  leaves the corrupt `job.json` byte-for-byte intact, because it is the evidence.
  Such a job therefore keeps reading as `corrupt` after cancellation.
- **A spent pid file is renamed, not left loaded.** After that reap, each consumed
  file becomes `<name>.pid.reaped-<timestamp>`. Pid numbers get reused, and a
  corrupt job cannot be marked `killed` (its record is evidence and stays
  untouched), so without this a second `cancel` would fire the same numbers again
  — at whatever process now owns them. A second cancel instead reports
  `already reaped: codex.pid.reaped-…`, kills nothing, and changes nothing.
  The numbers are the anti-target, not the file names: every kill target, however
  it was gathered — the pid files, `supervisorPid`, `codexPid`, `codexPids` — is
  filtered through the reaped list, so a record that outlived a failed write
  cannot re-arm a spent number either. **A file is consumed only when every number
  in it was fired at** (or was already recorded as spent). Renaming all of them
  regardless destroyed targets nothing had shot at: a `codex.pid` written by a
  supervisor moments before it died is the only recorded target its orphan has,
  and a cancel that killed the supervisor alone used to rename it away — leaving
  the next cancel with nothing to fire.
- **Job ids are whitelisted, not sanitized**: `^[a-z]+-\d+-\d+$`, checked before
  the id is ever joined into a path. Roles are `^[a-z]+$` for the same reason, and
  the collision suffix extends the pid digits (`…-4844` → `…-48441`) rather than
  adding a segment, so a generated id always satisfies the whitelist it will later
  be checked against.
- **And the whitelist is applied where the value is READ, not where it is used.**
  That sentence above was true of the id a *user types* and false of every other
  string that becomes a path — which is how both review arms found the same defect
  class from opposite ends (see [REVIEWS.md](REVIEWS.md)). Three strings become path
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
  └─ re-reads the record  ← a CANCEL-shaped state? kill it, verify, refuse.
       │                     any other verdict is the supervisor's: report, touch nothing
       supervisor  ← the kill target; taskkill /T /F here takes codex with it
         ├─ asserts recordVersion == this release's ← else failed / record-version-mismatch
         ├─ proves sight: codex sandbox cmd /c type <a file in the job's cwd>
         │    ├─ not proven, no --allow-unproven-sight? failed / sight-unproven, nothing spent
         │    └─ probe would not RUN or could not be POSED (transport, after retries;
         │         a cwd that is gone; a bin path that will not quote)?
         │         failed / sight-probe-error — NOT blindness
         ├─ records the sight label the delivery gate reads ← a write that will not land
         │    is refused HERE: failed / record-write-refused, nothing spent
         ├─ re-checks: record still running? claim still ours?  ← else abort, nothing spent
         ├─ records launch: exec-spawning  ← the SECOND window opens; a cancel landing
         │                                   here kills NOTHING and records kill-pending
         ├─ codex exec - --cd <cwd> --sandbox <mode> --skip-git-repo-check
         │    --model <m> -c model_reasoning_effort=<e>
         │    --output-last-message out.txt --color never  < prompt.md > run.log 2>&1
         ├─ resolves what it ACTUALLY spawned (the worker behind a .cmd wrapper) and
         │    records codexPids / codexPgid, launch: exec   ← the window closes; a write
         │    that will not land KILLS codex: failed / record-write-refused
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
A holder that died is broken out of, so a crash cannot wedge a job — and
**"died" is proved, not assumed from the clock**. The break used to be an age
test alone: five seconds old meant dead. The lock's mtime is never refreshed, so
a writer that was merely slow — a `pidStartTimes` query in a cold PowerShell, a
paged-out process, a machine under load — lost mutual exclusion at exactly that
mark, and then wrote from its pre-break read over whatever the breaker had
written in between: a cancel's `kill-pending` vanishing by way of the mechanism
that stops a crash from wedging a job. So the holder writes its **pid** inside
the lock, and a breaker needs both the age AND a holder it can show is gone.

**Only `ENOENT` is "no holder".** The proof reads the holder file, and a read can
fail for reasons that have nothing to do with the holder: `EBUSY`, `EPERM`,
`EIO`, an ACL, a cloud filter waking the file back up. Collapsing every one of
those to "nothing there" made a transient error on a *live* holder's file the
permission to break its lock — the one place in this runtime where an unreadable
answer failed open. An unreadable holder file is evidence a holder **exists**, so
it now reads as alive and no break follows; the age-only break is reserved for a
holder that is genuinely absent (`ENOENT`) — **or for holder content no release
of this runtime ever writes**, a file whose leading token is not a pid at all,
which is corruption evidence rather than a live acquirer. Since acquisition
became atomic, both of those can only be a pre-upgrade artifact, a hand-made
directory or a corrupt one.

**No lock this release publishes is ever visible without a holder in it**, which
is what makes that proof worth
anything. `mkdir` followed by a write is two steps, and between them sits a lock
with nothing inside it: a second writer stats it past the stale age, finds no
holder to prove alive, breaks in — and the first, merely descheduled, resumes and
writes its pid into the breaker's fresh directory at the same path. Both then run
the critical section, which is the lost-update window reintroduced by the
acquisition itself. So the lock is assembled out of sight and published in one
step, the way role claims are: the holder file is written into a staging
directory beside the lock, and the **rename of that directory onto the lock path
is the acquisition**. A failed rename is not one cause but three — somebody else
holds the path (the answer `EEXIST` used to give), this process's own stage was
swept out from under it while it aged, or the filesystem refused the move for a
reason of its own — and all three mean the same thing to the caller: go round
again. The staging directory is then removed best-effort; a cleanup that fails
leaves an orphan the sweep is already responsible for. Those orphans become
**sweep-eligible** once they age past the stale mark and are collected when a
later acquisition in that job directory reaches the stale-break path — the sweep
is opportunistic, not scheduled, so an orphan in a job nothing writes to again
simply sits there, costing a directory. They are never mistaken for the lock,
which is one exact path.

**And nothing in this release empties a lock in place.** Every destructive step
in the seam — the stale break, the sweep, and (since this release) the *release*
itself — renames the directory to a unique tombstone before removing anything, so
the last bare `rmSync` on the lock path is gone. Between the two halves of a
recursive removal the holder file is already unlinked while the directory still
stands, and that is exactly the holderless lock the staged acquisition exists to
make impossible. What that buys is bounded and worth stating as such: the empty
window is closed for locks *this* runtime writes and removes, which is what makes
"a holderless lock is not a live acquirer" true again. A holderless lock is
therefore a pre-upgrade artifact, a hand-made directory or a corrupt one — and
past the stale age it is still broken, because none of those may wedge a job for
ever.

**The break is a rename to a tombstone, and the tombstone is checked before it is
removed.** The rename alone was described as giving "exactly one winner"; it does
not. It is single-winner per *rename*, not per lock, and the difference is a
whole ABA: two breakers condemn the same dead lock, the first breaks it,
re-acquires and publishes a live successor at the same path, and the second —
descheduled in between — renames that **successor** into its own tombstone and
deletes it. Two writers again, by way of the mechanism that exists to prevent
them. So the decision records what it condemned — the lock's mtime, which is
never refreshed while a lock lives, and its holder as read at that moment — and
the destructive step happens only against a tombstone that still matches both.
A mismatch does not mean "a live successor was moved" — it means the breaker
**cannot prove** this tombstone is what it condemned, and the causes are wider
than the ABA: a successor really did take the path, or the tombstone will not
stat, or its holder file will not read, or the decision was taken without a
readable mtime in the first place. All of them answer the same conservative way.
Nothing is removed; the directory is renamed straight back to the lock path if
that path is free, and if the put-back fails it is left standing to be inspected
(see the strand guard below). The guarantee is therefore **per condemned lock**:
the directory a breaker destroys is the directory it proved dead, and a directory
it cannot prove anything about is one it does not touch.

**Sweeping is a rename first too**, for the same reason. A recursive `rmSync` of
an aged staging directory unlinks the holder file first, and the stage's owner
never checks its own stage before publishing — it checks the lock — so a hollowed
stage gets renamed onto the lock path as an **empty** lock, which is precisely
what the staged acquisition exists to make impossible. The sweep therefore
renames an aged orphan to a unique tombstone (a failed rename means the owner has
republished it, another sweeper won it, it has already gone, or the filesystem
refused the move — the sweep does not distinguish, and its contents are never
touched either way) and only then removes
what it moved. The owner's own rename then fails and it goes round again. The
sweep collects abandoned **break** tombstones as well, under the same age gate
plus one more test — the tombstone's holder must not be alive: a breaker that
dies between its rename and its removal would otherwise leak one for ever, while
a tombstone holding a *live* lock (a slow holder condemned for its age, waiting
on a restore) must not be collected at all. Both suffixes are strictly longer
than the lock's name, so nothing the sweep matches can ever be the lock itself.
And what the sweep does with that live-holder tombstone is **put it back**: one
rename onto the lock path, which is single-winner like every other move here and
leaves the tombstone untouched when it fails. Leaving it standing was only half a
fix, for the reason the next paragraph is about. The age gate keeps this off the
ordinary mid-flight restore — a tombstone cut from a live successor carries that
successor's own fresh mtime, and a lock's mtime is its acquisition time and is
never refreshed — and where a successor really has held for more than five
seconds, restoring it is what its breaker was about to do anyway. The sweep also
**re-reads the holder of the tombstone it won** before removing anything: winning
a rename proves what is in it now, not what was in it when the decision was taken,
and anything found alive is put back rather than deleted: **two renames are
tried** — onto the lock path first, because a live lock belongs there, and back
under its old name if that path is occupied — and if both fail the tombstone is
left standing exactly where the sweep's own move put it, where the acquisition
guard still reads it. It is never deleted on any of the three outcomes.

**A live lock stranded in a tombstone while the lock path stands free is one
terminal state behind three doors, and acquisition refuses past it.** A breaker
that crashes between its rename and its restore, a restore that failed because a
third writer took the path, an existence probe that read the tombstone wrongly —
all three end in the same place: somebody's live lock in a `.stale-*` directory,
and `job.json.lock` free. Acquisition consulted only the canonical path, so the
next writer took it and the stranded holder was in a **silent double-hold**: two
writers under one record, arrived at by the mechanism that exists to prevent
exactly that. So the job directory is read before staging, and a tombstone whose
holder is alive — or unreadable, fail-closed like every other reading in this
seam — blocks acquisition, which turns into the ordinary loud refusal at the
deadline, naming the tombstone. A tombstone whose holder is *dead or absent* never
blocks: it is litter awaiting the sweep, and waiting on a corpse would wedge the
job. **The block is the mechanism, and a strand nothing repairs lasts as long as
the stranded holder's process** — while that process runs, every acquirer of the
job is refused
loudly at its own deadline, which is correct, because that process still believes
it holds the record; when it exits, the tombstone reads dead, stops blocking and is
collected by a later sweep. The one repair that heals rather than backstops is the
breaker's own: a breaker whose restore failed keeps the tombstone in hand and
**retries the rename at every turn of its wait**, taking no lock itself until it
lands. That retry is bounded by the breaker's own fifteen-second deadline and by
nothing else: while the path stays occupied the restore keeps failing, and at the
deadline the breaker refuses and leaves, naming the tombstone it is still holding.
Where the path does come free the restore is usually the next turn — twenty
milliseconds — and a strand repaired that way shortens the guard to however long
the path was taken. A strand whose breaker **died** has no retry behind it at all,
and that is the one that lasts the stranded holder's process lifetime. The sweep's
restore (above) and `removeJobDir`'s inner refusals sit *behind* the guard —
defense-in-depth for states nothing in-process can reach except the guard-to-stage
TOCTOU. `clean` refuses a
job directory holding such a tombstone for the same reason, per job, the way it
refuses any directory it cannot finish removing.

**And a guard that could not look has not cleared anything**, so the guard's
answer is three-valued rather than yes/no. A `readdir` of the job directory that
fails is not an absence of tombstones, it is an absence of evidence, and the
fail-open reading of it readmits the silent double-hold the guard exists to
close. `ENOENT` is the only failure that means "no blocker": a directory that is
not there holds no tombstone, and staging's own `mkdir` should stay the fast,
honest failure for that case rather than being pre-empted by a fifteen-second
wait for a lock in a directory nobody will ever create. Every other errno —
`EPERM`, `EBUSY`, `EIO`, an ACL, a cloud filter — is *unenumerable*, and both
callers treat it as blocked: the acquirer waits out its deadline like any other
contention and refuses **in words of its own** (naming the directory it could not
read, never a tombstone nobody ever saw), and `removeJobDir` refuses the job
rather than delete what it cannot prove is dead.

**The wait bounds are monotonic.** The lock's fifteen seconds, the worker-resolve
poll and the kill verification all measure with `performance.now()`: they are
compared only against readings taken in the same process, and a wall-clock step —
NTP, a manual set, a VM resume — must not be able to shorten or extend a wait a
caller is blocked in. Ages, grace windows and timestamps stay on the wall clock,
because an mtime is a wall-clock fact and nothing else can be compared with one.

Release is **by identity, not by path, and by rename, not by removal** — a break
of one's own lock, held to the same discipline as every other break. `rmSync` on
the lock path removes whatever is there, and after a legitimate stale break that
is somebody else's lock: the writer that finishes first deletes the directory the
other still believes it holds. So a releaser reads the holder file back and
removes the lock only while it still names its own pid, which is right and was
not enough on its own: the read and the removal are two steps bound by a
pathname, so a stale break landing between them made "ours" true about a lock
that was somebody else's by the time it was deleted. And the removal itself is
not atomic either: it
unlinks the holder file before the directory goes, which is the empty-lock window
again, in the one place still opening it. So the release renames the lock to a
tombstone first and **verifies what it won** before removing it, four
dispositions, three of them refusals to delete:

- the holder is not ours: leave it, for its own holder to release or to age out;
- the rename fails: the lock was already broken or stolen. Nothing is removed —
  the same answer the identity test gave, one step later;
- the won tombstone does not carry our own holder line, pid **and** nonce: a
  break replaced the lock between the read and the rename, so this tombstone is
  somebody else's lock. It goes back to the lock path if that path is free, is
  left standing if it is not, is never removed, and says so loudly either way.
  A holder that could not be **re-read** takes the same action and a different
  sentence: microseconds after this release renamed its own lock, an unreadable
  holder file is a transient far more often than it is a break, so the message
  says the holder could not be re-read (with the errno) and that the lock is
  going back **unverified**, rather than asserting a break nothing here proved —
  the same correction the break's own ENOENT branch took;
- it does carry our line: remove it. A failure there is swallowed, and what is
  left is a tombstone whose holder is this process — dead the moment this process
  exits, blocking nothing, collected by a later sweep. It does not wait that long
  in the ordinary case: it names *this* pid, so it reads live to the acquisition
  guard, and the guard's self-heal below clears it on this process's very next
  acquisition of the job. Only a process that never acquires again leaves it
  standing until it exits.

**And a blocker holding our own live pid is our own release litter, which the
guard clears rather than waits out.** The swallowed removal above leaves a
`.stale-*` directory naming a live pid — this one — and the guard cannot tell
that from a stranded holder, so it blocked: every later acquisition of that job,
by any process *and by this one*, waited its fifteen seconds and refused, with
the sweep that would collect the thing sitting behind the guard. A wedge until
the releaser exits, produced by tidying up. So both consumers of the guard (the
acquisition loop and `removeJobDir`, which also runs in-process) remove a blocker
whose holder is this pid and carry on unblocked; a removal that fails changes
nothing and they keep blocking. The predicate is the pid alone, not the nonce:
this runtime is single-threaded and holds one record lock at a time, so at the
moment the guard asks, no acquisition of ours is in flight and a tombstone of
ours can only be litter — whichever acquisition left it. The one tombstone this
never touches is the breaker's own stranded one, which holds somebody else's
**live** lock and is passed to the guard as a blocker in its own right.

For the microseconds between that rename and the removal the tombstone holds a
**live** pid — ours — so another acquirer's guard reads it as a blocker, waits
one 20ms turn, and takes the freed lock path on the next.

**A pid and a nonce, and no start time** — which is a decision rather than an
omission. The nonce is identity: sixty-four random bits written fresh on every
acquisition (never per process — one process locks the same record many times in
a run, and two of its own acquisitions must not match each other), so the holder
text a breaker condemned identifies *that* lock rather than merely that pid's
locks. Liveness readers parse the leading digits and ignore the rest.
The start time could go beside it, as it does for every kill target — but reading it
is a synchronous PowerShell spawn, so paid lazily it lands *inside* the critical
section this exists to protect and paid eagerly it lands on the first record
write of every process; and the direction is wrong twice over. Start-time
identity everywhere else in this runtime only ever **subtracts** — it withdraws
a kill target or a liveness claim, and can never manufacture one — while here it
would be the evidence justifying the break of a lock that still looks held,
which is the exact action being prevented. What that leaves is in the known
issues: a holder that dies and whose number is instantly reissued to something
long-lived keeps the lock, and writers then refuse loudly instead of losing an
update quietly.
Every *update* bumps a `generation` counter, and callers may pass a precondition
that is evaluated *inside* the lock ("only if this still says running"). Two
writes are outside that rule and are worth naming, because a counter that is
described as universal invites being read as one: the record dispatch **creates**
carries no `generation` field at all (the first update writes 1), and the byte-for-byte
restore of a record a failed `clean` had already removed puts back exactly the
bytes it read, generation included. Neither is a lost update — the first has
nothing to lose, the second is a put-back of the last thing written — but neither
increments, and a reader must not treat the counter as a write count.

**A write whose loss would strand a record is checked and reported, not
swallowed.** `updateRecordOutcome` answers `ok`, or one of `corrupt`,
`precondition`, `locked`, and the rule this release finished applying is: every
writer whose loss leaves a job reading something untrue — `running` with nothing
behind it, a launch marker that never landed, a codex nobody can aim a kill at, a
terminal verdict nobody can see — checks that answer and says that the write did
not happen, where the person who ran the job will see it: on stderr for the
verbs a human is watching, and in the job's own `run.log` as well for the
detached supervisor, whose stderr nobody is reading. The message carries what
resolves it, which is `cancel <id>` almost every time, because that is what
resolves a record stuck on `running`. A `precondition` answer is never reported as a failure: it means a
verdict was **found**, and the writer stands down. A `locked` answer is the one
worth insisting on, since it clears by itself, and the two writers that cannot
afford to lose retry it against a named budget — `TERMINAL_WRITE_RETRY` (five
attempts inside a minute) for the supervisor's own exit verdict, which is the
last act of a detached process that has already been paid for, and
`LAUNCH_WRITE_RETRY` (two attempts inside twenty seconds) for the two
spawn-adjacent writes, where holding a live codex hostage to a lock is worse than
refusing. Those budgets cap the time before another attempt is *started*, not the
time an attempt takes: a `locked` answer can have spent a full fifteen-second
lock wait getting there, so the wall-clock worst cases are one lock wait longer —
about 75s for `TERMINAL` (four attempts landing just inside the minute, then a
fifth) and about 30s for `LAUNCH`, which is the "one full lock wait and one more"
that budget was chosen to be. A `cancel` whose kill worked but whose record would not update exits
nonzero saying exactly that, because a kill nothing else can see is not a kill
anything else may act on.

**What is still fire-and-forget is what a checked writer heals.** Dispatch's
post-spawn `{supervisorPid, launch: 'spawned'}` write is unchecked, and the
supervisor's own first act is the checked fallback for it: it writes its pid
itself unless the record already names it, and refuses to run when *that* write
cannot be made — telling the operator whether the record was corrupt or merely
locked, which are different repairs. The other unchecked write is the
worker-resolve `warning` field, whose text is already in `run.log` and whose loss
costs nothing but a duplicate. Everything else in the kill seam, the launch path
and the finalizer is checked.

**Two of those checks refuse a launch outright: one before the spend, one after
it.** The
sight label — the only evidence the delivery gate ever reads — is written before
codex exists, so a label that will not land is refused there rather than
discovered after a paid run is undeliverable: `failed(record-write-refused)`,
nothing launched, nothing billed. The codex-pid registration is the write that
turns a spawned codex into a *killable* one, and it is the one place where a
refusal arrives too late to be free: lost, the record keeps `launch:
'exec-spawning'` with no pids, so every cancel writes `kill-pending` and kills
nothing while codex bills to completion. So it is retried, and a failure **kills
what was just spawned** and records the same `record-write-refused` — milliseconds
of codex is a cheaper thing to lose than the only handle on it. That refusal is
held to the runtime's usual kill bar: the role claim is released only if the kill
verified (nothing survived *and* the process table could be read), and the
report says what was spawned and what became of it rather than the "nothing was
launched" the pre-launch refusals say.

**Every writer in the kill seam carries a precondition, including the cancel.**
The supervisor's exit handler and the `exec-spawning` mark wrote
`expect: canonicalState === 'running'`; `killJob`'s four writes —
`kill-pending` twice, `kill-failed`, `killed` — carried none, and its own
stale-snapshot re-read watched the launch *phase* and the pid list move without
ever watching the *state*. So a cancel that lost the race to the supervisor's own
verdict wrote straight over it: `killed(sight-unproven)`, a state/reason pair this
document calls impossible, or a deliverable `done` destroyed by a cancel that
killed nothing that was still alive (reproduced, 2026-08-07). Those writes are now
compare-and-swap on **"the state is still one of `LIVE_STATES`"**, and a write that
loses that precondition did not lose data — it *found a verdict*. Nothing is
overwritten, nothing is killed (the re-read bails before the trigger too), the
role is not released, and the answer is the state that is really there: `cancel`
reports `job <id> is already <state>, nothing to kill` and exits 0, exactly as it
always has for a job that finished before the cancel arrived. A verdict found by
the `kill-failed` write — the one that lands *after* the signals went out — is the
same answer and is now reported as one: it says `finished as <state> while the
kill was verifying`, because "nothing to kill" would be a claim about processes
this cancel really did fire at, and the survivors (or the unreadable process
table) stay on stderr where the kill wrote them. It used to come back with no
verdict at all, so `cancel` announced `state: kill-failed (NOT killed)` for a
record saying `done` and exited nonzero. `--force` gets the
same answer and treats it correctly — a terminal job is not a conflict, so the
force takes the role rather than refusing, and it does not print a kill it never
made.

**And "every writer" now includes dispatch's own post-spawn cancel branch**,
which this section claimed carried `expect: canonicalState === 'running'` for a
release in which it carried nothing at all. It read the record once, spent the
one to three seconds a verified kill costs on the supervisor it had just
spawned, and then wrote `killed` or `kill-failed` over whatever landed in that
gap — a supervisor's `failed(sight-unproven)` among them, which is the pair this
document calls impossible, reached by the one route the CAS work of 0.8.0 did
not close. Both of its writes are compare-and-swap on `stillCancellable` now,
and a lost precondition is read here exactly as it is in `killJob`: a verdict was
found, it is reported and not overwritten, and **no role is released** — the
process that wrote the verdict owns that decision too. Its kill target goes
through the reaped-pid list first, like every other kill target in this runtime,
and the spent pid files are consumed only after a kill that verified.

**And dispatch's two "nothing was spawned" finalizations are the last two**, held
to the tighter bar rather than to `stillCancellable`. A supervisor that will not
spawn and the catch-all that closes a ghost both write
`failed(supervisor-spawn-failed | dispatch-failed)` and release the role, and
both were *checked* — they never claim a write they did not make — but
unconditional. The record has said `launch: 'spawning'` since before the spawn
was attempted, which is deliberately a state a cancel may act on, so a
`kill-pending` written into that window was overwritten by a `failed` about a
launch that never happened and its role handed away underneath it: the same
defect the supervisor's seven pre-launch refusals had, on the parent's side of
the same window. Both now carry `notCancelAuthored` — the identical predicate,
shared rather than restated — and a lost precondition is read the same way: the
verdict found is reported and not overwritten, and the role is released only when
the found state is *not* cancel-authored. A cancel-authored one owns its own
release decision, and this dispatch releases nothing. A write that could not be
made at all is unchanged: no verdict was found, nothing was spawned, and the
claim goes back as before.

**And the supervisor's own cancelled-during-exec landing is the other one**, for
the same reason and against the same opponent. That landing reads the record,
kills codex — seconds, in a shell — and writes `killed` or `kill-failed`; the
dispatch that spawned it is looking at the same cancel-shaped record and its
post-spawn branch kills *this supervisor*, records `killed` and releases the
role. Without a precondition the landing wrote straight over that verdict, and
what it left was a `kill-failed` record whose role was already free: the state
says something may still be alive, and nothing is blocking a second dispatch.
It is a compare-and-swap on `stillCancellable` too, and a write that loses it
reports into the job's own `run.log` and releases nothing — a second release
could hand away a claim a new dispatch has taken since. Same rule, both
directions: whoever's write landed owns the verdict *and* the release.

**And the supervisor's seven pre-launch refusals are the last of them.** A record
version mismatch, a blind sandbox, a probe that could not be run, sight left
unproven, an argv `cmdQuote` refuses, a spawn that fails, and the honouring of a
`kill-pending` all write a verdict before codex exists — and all seven wrote it
unconditionally, with a sight probe's seconds of shell sitting between the record
they read and the write. A cancel that reached a verdict inside that gap was
overwritten by a `failed` about a launch that never happened, and its role handed
away underneath it: `killed(sight-unproven)` from one direction, a `kill-failed`
whose role went free from the other. They are compare-and-swap too, on a
precondition one notch tighter than `stillCancellable`: six of the seven require a
live state that is **not cancel-authored** — `stillCancellable(rec) &&
!CANCEL_STATES.includes(canonicalState(rec))` — because `kill-pending` and
`kill-failed` are live states (they must be: a second cancel has to be able to
retry them), so `stillCancellable` alone still let a refusal write
`failed(<reason>)` over a cancel's verdict and hand its role away. A
cancel-authored state is the *cancel's* to resolve: the refusal that finds one
stands down, overwrites nothing and releases nothing, and the cancel's own
compare-and-swap finishes the story — for `kill-pending` the live cancel writes
its verdict, and a `kill-failed` **keeps both its record and its claim** against
every one of these writes, which is the whole contract of that state ("Kills are
verified"). The seventh, the honour path, is the exception in the other
direction: it expects **exactly `kill-pending`**, the state it read, because it
is not overwriting that cancel but carrying it out — and `stillCancellable`,
which it used to carry, also accepts `kill-failed`, so a cancel reaching that
verdict inside the gap would have been replaced by
`killed(cancelled-during-registration)` with its survivors cleared and its role
released, the very overwrite the other six forbid. It stands down on a lost
precondition exactly as they do. All of them clear `killSurvivors` so a `failed` never inherits an
earlier cancel's survivor list, and a lost precondition releases nothing.
A write that could not be made *at all* is the one place these differ
from the landings above: it found no verdict, and on every one of these paths
codex was never launched and the supervisor is exiting, so the claim it holds is
still its own to give back.

**Two more refusals go through the same helper now, and the second breaks its
"pre-launch" name.** The sight label that will not land is a pre-launch refusal
like the seven above and behaves exactly like them. The codex-pid registration
that will not land does not: codex exists by then, so that caller kills it first
and passes two things the others never need — *do not release the claim unless
that kill verified*, and *say what was spawned*, since "nothing was launched" is
the one sentence that would be false there. Both write
`failed(record-write-refused)`; both are the same compare-and-swap.

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

**And the re-read that follows the spawn only recognises a CANCEL.** The parent's
last act is to read the record back, because a `cancel` may have landed while it
was spawning; it used to treat *any* state other than `running` as that cancel,
kill the supervisor, and write `killed` over what it found. But the supervisor can
reach a terminal state before the parent gets there — a failed sight precheck lands
about 250 ms in, and recording the supervisor's start time costs longer than that
in a PowerShell — so the parent was overwriting a verdict it had never made: a
`--cd` pointing at a directory that does not exist finished as
`killed(sandbox-blind-precheck)`, a state/reason pair this document calls
impossible, under a message about a cancel nobody ran, and a `claim-lost` takeover
lost its evidence the same way. Only `kill-pending`, `killed` and `kill-failed` —
the states a cancel writes — are read as a cancel now. Any other state is the
supervisor's own account of a run the parent no longer owns: nothing is killed,
nothing is rewritten, the outcome goes to stderr, and the dispatch still succeeds
with the same handle, because an exit code that depends on which of two processes
won a millisecond is not a fact about the job.

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

**And the window that DOES kill is fenced with the same state.** Outside both
windows a cancel has targets, and the kill spends seconds reading the process
table — during which the record used to go on saying `running`, which is exactly
the precondition the supervisor's `exec-spawning` mark asks for. A supervisor
reaching it in that gap spawns a codex the kill can no longer reach: off Windows
it is detached, leads its own group and reparents to init the moment the
supervisor dies, so nothing descended from the targets is left for the leftover
sweep and the pre-kill record carries no `codexPgid` to check it by — a verified
kill, a released role, and a billed orphan with no recorded target. So
`kill-pending` is written **before** the kill there too. The record lock then
totally orders the two writers: either the supervisor's mark loses its
precondition against `kill-pending` and it aborts before spending anything, or it
won first — and the re-read taken behind the fence sees `exec-spawning` and
answers with the codex window instead. The kill's own `killed`/`kill-failed`
write is unaffected, because `kill-pending` is a live state and every write in
this seam asks only for that. The post-kill survivor check re-reads the record
for the same reason: a pgid or a codex pid registered *during* the kill is a
target it must look at, and a fresh read that comes back corrupt leaves the stale
one standing rather than subtracting anything.

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
[DECISIONS.md](DECISIONS.md) for what this revoked and why.

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
behind, and it is released by the process that owns it, on a terminal state that
says everything the job owned is gone — `done`, `failed` or `killed`, and nothing
else. A release checks the `owner` file first, so it can never hand away a claim it
does not hold. **`kill-failed` is not a release, and neither is a record that
cannot be read**: the supervisor's exit handler used to call `releaseRole`
unconditionally, one line after correctly refusing to *rewrite* a record that had
stopped saying `running` — so a job whose cancel killed codex and left the
supervisor alive dropped the claim that is its whole point, and only the
`findRoleConflict` backstop scan was still keeping the promise. Silence is not
death here either: a corrupt or unreadable record at that moment keeps the claim
too. That handler also **catches its own finalization**: `job.json` is written by
temp-file-and-rename, that write can fail (a rename that exhausts its retries,
ENOSPC), and an uncaught throw out of an exit handler ends the supervisor with the
record still saying `running` — a job that reads `stale` for ever, holding its
role, with a finished `out.txt` next to it that `result` refuses. The failure is
reported into `run.log` and onto stderr instead. A claim whose owner is terminal, corrupt or gone is reclaimable; one
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
pid=,ppid=` elsewhere. **If it cannot be read, the kill is not verified** — and
that is a state, not a warning. `killPids` answers `enumerated: false` when
neither shell would say (both `powershell` and `pwsh` failing on Windows), which
means the descendants were never enumerated and the leftover sweep read nothing:
the recorded pids can be gone while the codex behind a `.cmd` wrapper is not, and
that worker is precisely what these two mechanisms exist to catch. For a release
only the corrupt-record branch of `cancel` looked at the field at all, so
everywhere else an unreadable table WAS quietly an empty tree — a verified
`killed`, a released role. Every caller now treats it as a failed verification:
`killJob`, dispatch's post-spawn branch and the supervisor's cancelled-during-exec
landing all record **`kill-failed`** (compare-and-swap, like every write in this
seam) with the unreadable table named in the record's `warning`, the role stays
claimed, no pid file is consumed, and the caller is told to re-run once the table
can be read; the reap of an unvouched-for job refuses the takeover instead of
taking the role, and leaves the corrupt record and the loaded pid files exactly
as it found them. `cancel`'s corrupt-record branch, which may never rewrite that
record at all, does the one thing left to it: it **does not consume the pid
files** and exits non-zero, so the retry it asks for still has numbers to fire at.
It used to warn and reap them anyway, which spent the only kill targets a corrupt
job has on a sweep nothing had witnessed — and the retry then read "already
reaped". Off Windows the process group is the other half
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

## Retention — `clean`, and why it is manual

Nothing removed a job directory until 0.8.0. Every dispatch left one behind for
ever: the brief, the record, `run.log` (megabytes on a long run) and the answer.
The jobs root therefore grew without bound, and the only way to reclaim it was to
delete the tree by hand — which is precisely the operation the rest of this
document works to make unsafe to do by hand.

`clean` is that operation, done through the same invariants, and it is **manual on
purpose**: no automatic pruning, no age default that deletes something the first
time it runs. A record is the only account of what a job did, and deciding on the
operator's behalf that an account has expired is not a decision a background sweep
gets to make. With neither `--all` nor `--older-than <days>` it removes nothing
and says which to type.

**Eligible is `ROLE_RELEASE_STATES` — `done`, `failed`, `killed`** — the same set
the supervisor is allowed to release a role on, and for the same reason: those are
the states that say everything the job owned is gone. Everything else is kept and
named in the output:

- the five live states (`running`, `kill-pending`, `stale`, `kill-failed`,
  `unknown`) may still own processes, and the `.pid` files inside that directory
  are the only remaining way to kill them. There is deliberately **no `--force`**
  for these: a flag whose meaning is "ignore the state taxonomy" is a flag that
  makes a still-billing codex unkillable.
- a `corrupt` `job.json` is evidence, and this runtime neither repairs nor deletes
  one anywhere else.
- an entry that is a link or resolves outside the jobs root is refused, exactly as
  the listing walk classifies it — nothing is read through it and nothing is
  removed through it.

The removal itself takes the job's own record lock and **re-decides inside it**,
so a job that turns live between the listing and the removal is kept; the id goes
through the whitelist and the containment assert first, like every other path this
runtime operates on. A removed job that still held a role claim leaves a claim
naming a job directory that is not there, which `inspectClaim` already reads as
reclaimable.

**A removal that fails ANYWHERE leaves a job that still lists**, and that took
two mechanisms rather than one. The directory is dismantled with its `job.json`
last, because an entry without one is invisible to `list`, `status` and `clean`
itself — but the *last* step can fail on its own: on Windows a directory that is
some process's current one lets every file inside it unlink and then refuses the
`rmdir`. Which produced exactly the outcome the ordering exists to prevent — the
record gone, the directory left, nothing able to see it again. So the record's
bytes are held across that final removal and written straight back if it throws;
the failure is then reported as a `kept:` line and a stderr warning, and a retry
takes the job once whatever was sitting in it has moved. A restore that itself
fails is reported on its own, because that is the one case where a job really has
become unlistable.

**And the put-back is a write to `job.json`, so it happens under the lock like
every other one.** A recursive `rmSync` removes the children first — the held
`job.json.lock` among them — and only *then* fails on the directory, so the
restore was an unlocked write over a lock-governed file. The order is fixed
instead: the record is removed while the lock is still held, the lock is handed
back next (the removal is called holding it and returns it itself), and a restore
re-acquires it through the ordinary `withRecordLock` path. A restore that cannot
take the lock writes **nothing** and says so — a job nobody can list is
recoverable by hand; a record two writers wrote at once is not.

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

**The window runs the node that is running this, not a `node` on somebody's PATH.**
The launcher line was `cmd /c start <title> cmd /k node <self> _watch <id>` with
`node` as a literal — the only spawn in the runtime that did not go through
`process.execPath`. On a machine where node is not on the *interactive* path (an
nvm shim, a portable install, a PATH a parent process trimmed) the window opened,
printed `'node' is not recognized`, and `watch` reported success: a claim made
instead of a fact checked, in the one affordance that exists because
notifications get dropped. The line is now built from `process.execPath`, quoted
by `cmdQuote` and spawned with `windowsVerbatimArguments` so there is exactly one
quoting pass, and it fails closed on `% ! "` like every other value bound for a
cmd.exe command line.

**And the tail after `/k` needs one more pair of quotes than looks right**, which
the first version of that fix got wrong and a follow-up review reproduced.
`cmd /k <tail>` does not parse an argv: without `/S` it preserves quotes only
when the tail contains *exactly two* of them, and otherwise strips the first
character if it is a quote and the last quote on the line. Quote both the node
path and the runtime path — every install under `C:\Program Files\nodejs` whose
plugin also lives under a path with a space — and the tail has four, so cmd ran
`C:\Program`. A window saying `'C:\Program' is not recognized` while `watch`
prints `watching:` is the same false success the literal `node` produced, in a
narrower population. So the whole command is one `cmdQuote`-quoted string handed
to `cmd /s /k` inside an outer pair: `/s` makes the strip-outer-pair rule
unconditional, and what is left runs verbatim. Verified end to end for all four
combinations of (node path quoted / not) × (runtime path quoted / not) — and the
test that keeps it verified **executes** the line, because the broken version
satisfied an argv-shape assertion perfectly.

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

## Known issues (found by review, accepted for now)

- **PID reuse is narrowed by start-time identity, not eliminated.** Each
  registered pid's OS start time is recorded (`pidStarts`), and a pid whose
  current start time no longer matches is neither read as alive nor fired at.
  What remains: records written before the field existed keep the old behavior,
  macOS `ps` has no `etimes` so the query answers nothing there, and start
  times are memoized per invocation — a reuse occurring mid-run degrades to the
  old behavior. Most remaining cases fail in the safe direction: a spurious
  `kill-failed` refuses a launch rather than launching a duplicate, and the
  reaped-pid list still stops a number already fired at from ever being fired
  at again.

  **One case does not, and it is the kill targets read out of the `.pid` files
  when there is no usable record to check them against.** `pidStarts` lives in
  `job.json`, so a job whose record is corrupt or absent — the reap that clears
  an unvouched-for claim, and `cancel` on a corrupt job — has nothing to compare
  a number to, and those numbers are fired at on the strength of the number
  alone. That is the first shot, which is the one that can land on a stranger;
  the reaped list only ever stopped the second. The `.pid` files are deliberately
  not given a start-time sidecar of their own: a second file to keep in step with
  the first is a second thing to be wrong, and the record is where identity is
  written down. Stated here rather than implied away.
- **A record lock whose holder died and whose pid was instantly reissued is not
  broken until that impostor exits.** The holder file carries a pid and a
  per-acquisition nonce, and no start time (the reasoning is under the write lock
  above) — the nonce is identity, not liveness — so a number that is alive
  reads as a holder that is alive. The window is the hold time, and that is not
  uniformly short: an ordinary record update is a read, a JSON write and a rename
  — milliseconds — but `clean` holds the lock across an entire job-directory
  removal, every file in it, and a lock held that long is a lock with a
  correspondingly wider window to die inside. The consequence is the
  safe one wherever the window is: every writer waits its fifteen seconds and then REFUSES, saying the
  record could not be locked and to re-run, rather than writing over somebody.
  Every writer that would strand a record by losing this says so (see the write
  lock above); `cancel`, `--force` and `clean` report it by name. Removing the `job.json.lock`
  directory by hand is the manual cure, and it is safe once nothing is running.
- **The staged-lock rename narrows a POSIX replace, it does not close it.**
  `rename(2)` replaces an existing *empty* directory where Windows refuses, so
  an acquisition could land on a lock at age zero and skip the stale-age
  discipline — but only on a lock that is empty, and every lock this release
  publishes already contains its holder, from the rename that publishes it to the
  rename that releases it. The empty lock in reach is another release's: an old
  acquirer caught between its bare `mkdir` and its holder write, or an old
  releaser caught inside the recursive `rmSync` this release stopped doing. The
  acquirer now treats the lock path merely existing as contention, which leaves
  the check-to-rename gap and nothing wider; the precondition is POSIX plus two
  different releases writing the same job directory at the same time.

  **Nothing detects that mixed-version case, and no version gate can.**
  `recordVersion` is a *schema* stamp — 2 since 0.5.0, unmoved since — and it
  gates delivery and the supervisor's willingness to run, not locking: two
  releases whose lock protocols differ (0.8.1's bare `mkdir`-and-remove against
  0.8.4's staged, tombstoned one) both write and both accept 2, so the mismatch
  refusal cannot see the skew, and bumping the stamp would not help — it would
  refuse *records*, and the concurrency here is between processes, one of which
  is an old binary that never heard of the new number. So this is not a covered
  case with a residual: **"one runtime per jobs root" is a rule the operator
  keeps, not an invariant anything enforces.** It is stated here for the same
  reason the pid-reuse window is: it is the honest description of what is and is
  not checked.
- **A break that moved a live successor puts it back, and the put-back can
  lose — but a lost put-back is no longer a hole anybody can fall into.** The
  stale break is bound to the condemned lock's identity, so a breaker that finds
  a successor in its tombstone renames it back to the lock path rather than
  removing it; the path stands empty for the microseconds in between, and a third
  writer publishing into that gap makes the restore fail. The victim's lock is
  then stranded in the tombstone: **left there rather than removed**, so it can be
  inspected, and the breaker says so loudly on stderr, naming the tombstone. What
  changed is what happens next. Nobody acquires past it — a `.stale-*` tombstone
  whose holder is live or unreadable blocks staging and turns into the loud
  refusal at the deadline — and `clean` refuses to remove a job directory holding
  one. The breaker retries its restore at every turn of its own wait — until that
  wait's own fifteen-second deadline and no longer, at which point it refuses and
  leaves, naming the tombstone it still holds — so a strand whose breaker survived
  is usually repaired within a turn of the lock path coming free, and is repaired
  at all only if that happens inside the breaker's remaining wait. A strand whose breaker did
  not survive is **held safe by the guard until its stranded holder's process
  exits**, at which point the tombstone is dead litter and a later sweep collects
  it. The sweep's restore is a backstop behind that guard, not the cure.
  Narrowed, not closed, and what remains is:
  - the stranding itself, whose precondition is unchanged: three writers on one
    job directory inside one microsecond window, against a lock that was already
    dead enough to condemn;
  - the two ways of reading a holder wrongly, both of which still fall toward
    leaving the tombstone standing — a sweep landing on the exact instant of the
    holder's death, an unreadable holder file (fail-closed), and pid reuse making
    a dead holder look alive for as long as the impostor runs. With the guard in
    place, a *falsely live* tombstone now also blocks acquisition until it is read
    truthfully, so the failure is a refusal rather than a silent double-hold;
  - and a theoretical composition of the guard with the monotonic wait: both the
    guard and the deadline are process-local judgements about a shared directory,
    so two processes can disagree for one 20ms turn about whether a tombstone is
    live. The disagreement resolves by the next readdir, and the destructive
    variant of it — a breaker removing a tombstone it did not condemn — additionally
    requires the holder text to collide, which the per-acquisition nonce puts out
    of reach of anything but sixty-four-bit chance.

  And what the guard itself costs, stated rather than implied away:
  - **A wedge nothing repairs lasts the stranded holder's process lifetime.**
    Every acquirer of
    that one job waits its fifteen seconds and refuses, loudly, for as long as the
    process named in the tombstone runs — unless the breaker that cut the strand is
    still alive to retry its restore, in which case it usually ends in one 20ms
    turn after the lock path frees, and at the latest when that breaker's own
    fifteen seconds run out. That is bounded, visible and per job, and
    it is the price of the state it replaced: 0.8.3 reached the same state as a
    **silent double-hold**, two writers under one record with nothing printed.
  - **A tombstone whose holder file stays UNREADABLE is a manual-repair wedge.**
    The guard re-reads it on every turn of every acquirer's wait, so a *transient*
    unreadability — a scanner with the file open, a cloud filter waking it — clears
    on a later turn and the block lifts by itself. What does not lift is a
    persistent one: while the file cannot be read it cannot read as dead, so an
    ACL, a broken permission or a damaged directory wedges the job until somebody
    repairs it. The refusal names the tombstone path and says to inspect it and, if
    it persists, remove it by hand once nothing is running. Deliberate: every other
    reading in this seam is fail-closed, and a lock this runtime cannot read the
    owner of is the last place to start guessing.
  - **A restore that lands after its victim finished re-wedges, and can outlast
    the strand it replaced.** A lock put back on the canonical path after its
    holder has left its critical section is unreleasable — release is by identity
    and that holder will never ask again — so it stands until three things are
    true at once: the holder reads dead, the lock is past the stale age, and some
    acquirer comes along to break it. The holder reading dead means that process
    exiting, which is the same bound the tombstone had; the stale age is where
    they differ. A rename does not normally touch a directory's own mtime, so the
    restored lock usually arrives already aged — but where the filesystem gives it
    a **fresh** one, the job stays blocked for the remainder of that five-second
    interval *after* the process exits, whereas a dead tombstone stops blocking
    the instant it does. So the restore is neutral-to-slightly-worse in that
    corner rather than a fix, and that is precisely why the guard's blocking, not
    the restore, is the accepted contract; the restore is kept because a live lock
    belongs on the lock path.
  - **The two backstop branches have no in-process trigger path, and so no test
    covers them.** The sweep's live-holder restore and the verify-after-win
    rename-back are reachable through the guard-to-stage TOCTOU, a source-path ABA
    between two sweepers, or — for the verify-after-win branch specifically — a
    holder that changes its answer between the sweep's two reads: the first said
    dead-or-absent (or it would have restored instead), the second says alive,
    which needs the pid reissued or the holder file becoming *unreadable* in
    between, since unreadable reads as alive. All of them are microsecond windows
    against another process's lifecycle, and nothing in this
    runtime can produce them on demand. They are unit-reachable only by fabricating the
    directory state, which asserts the branch rather than the race. Said plainly:
    defense-in-depth, unexercised.
  - **`removeJobDir`'s own read-refusal is shadowed, and is kept anyway.** Before
    it unlinks anything it reads `job.json` into memory, so a failed `rmdir` can
    put the record back; any failure of *that* read refuses the job untouched. It
    cannot fire through the one caller there is: `clean` reads the same record
    under the same held lock microseconds earlier and treats an unreadable one as
    corrupt, which refuses the removal a step higher. Reaching it needs the file
    to become unreadable between two reads inside one lock hold — an external hand
    or a scanner, not anything this runtime does. Unreachable via `clean`, listed
    with the other unexercised branches, and kept because the ordering it protects
    (bytes in hand before the first unlink) is what makes the put-back possible at
    all.
- **Windows `shell: true` quoting refuses what it cannot escape.** `codex.cmd`
  needs a shell, so `spawnCodex`/`runCodexSync` join argv into one command line
  with `cmdQuote`. Three characters cannot survive that command line and are
  **refused** rather than escaped (`CMD_UNSAFE`), because a value that silently
  becomes something else is the blind-answer failure in another costume:
  - `%` and `!` are expanded by `cmd.exe` *after* quote stripping, so `"%PATH%"`
    expands exactly like `%PATH%` and no quoting reaches either. `!` is inert
    under the `cmd.exe /d /s /c` Node launches, so refusing it is a guarantee
    about somebody else's future setting rather than a live defect.
  - `"` is the one character whose two escaping conventions disagree: `cmd.exe`
    tracks quote *parity* to find metacharacters, while `CommandLineToArgvW` reads
    `\"` as an escape — so `""` satisfies one parser and breaks the other, and
    there is no spelling that satisfies both. Windows paths cannot contain one, so
    refusing costs nothing real. (0.7.0 escaped it as `""`, and `a\"` did not
    round-trip.)

  **What gets quoted is every command-token delimiter, not just the obvious
  metacharacters.** cmd.exe ends a token on `,`, `;` and `=` exactly as it does on
  whitespace, and those three were missing from the trigger while `& | < > ( ) ^`
  were not — measured: a `.cmd` under `to,ols\`, `se;mi\` or `eq=al\` exits 1 with
  "is not recognized" unquoted and runs when quoted. A resolved bin path silently
  becoming a different one is the same failure class the refusals above exist for.

  Separately, a **trailing backslash** run turned `foo bar\` into `"foo bar\"`,
  which `CommandLineToArgvW` reads as an escaped quote: the argument lost its
  delimiter and swallowed the next one. The run against the closing delimiter is
  doubled now, which that parser reads back as N literal backslashes and a
  delimiter that survives. Interior runs are untouched — only the run against the
  delimiter is ambiguous, and a Windows path is mostly interior runs.

  **And it is applied to every value that reaches the line, including the jobs
  root.** The gate checked `--model`, `--effort` and `--cd`, and the jobs root
  travels on the same command line as `--output-last-message
  <jobs-root>\<id>\out.txt`. `%` and `!` are legal in a Windows user name, so the
  DEFAULT root under `%LOCALAPPDATA%` can carry one: preflight passed, the sight
  probe passed, a role was claimed, a supervisor was spawned, and only then did
  the job fail as `codex-argv-refused` — every job, for ever, with the fault named
  nowhere near where it could be fixed. It is checked where it is read now: in
  `preflight` (before the `CODEX_DISPATCH_BIN` short-circuit, because an install
  whose every job would fail is not "ok") and in `dispatch` before anything is
  claimed, naming the `CODEX_DISPATCH_JOBS` override that cures it.

  **The refusal is applied to the RESOLVED value, and it lands somewhere.** 0.7.0
  got both halves of that wrong. It validated `opts.cd`, so a dispatch with no
  `--cd` skipped the check entirely and put `process.cwd()` into the record
  unexamined; run from a directory with a `%` in its name, the supervisor then
  threw inside a detached process with nobody to catch it, and the job sat
  `stale` holding its role. So the check now runs on the resolved cwd (the same
  rule the jobs root states: check the value where it is *read*), the record is
  written from the values that were checked rather than from a second computation
  of them, and the supervisor's spawn is wrapped so a refusal finalizes the record
  as `failed / codex-argv-refused` instead of stranding it. `main()` catches the
  same refusal — tagged `CMD_UNQUOTABLE`, so the catch cannot widen to every other
  throw — and reports it through `fail()`, which covers preflight and the sight
  probe, where a `CODEX_DISPATCH_BIN` path is documented as trusted and unchecked.
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

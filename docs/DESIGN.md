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
| `generation` | non-negative integer | corrupt. Bumped by every write; see the write lock below. |

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
  cannot re-arm a spent number either.
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

**Every writer in the kill seam carries a precondition, including the cancel.**
The supervisor's exit handler, the `exec-spawning` mark and dispatch's post-spawn
write all wrote `expect: canonicalState === 'running'`; `killJob`'s four writes —
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
always has for a job that finished before the cancel arrived. `--force` gets the
same answer and treats it correctly — a terminal job is not a conflict, so the
force takes the role rather than refusing, and it does not print a kill it never
made.

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
  old behavior. Every remaining case fails in the safe direction: a spurious
  `kill-failed` refuses a launch rather than launching a duplicate, and the
  reaped-pid list still stops a number already fired at from ever being fired
  at again.
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

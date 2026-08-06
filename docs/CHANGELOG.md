# Changelog

Versioning rule: **a push that changes behavior MUST bump the version** — see
[README → Releases and versioning](../README.md#releases-and-versioning) for why.

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

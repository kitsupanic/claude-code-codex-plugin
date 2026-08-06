---
description: List all codex-dispatch jobs, newest first, with state and out path
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" list`

Present the command output to the user unchanged — one line per job, `<id>  <state>  out: <path>`, newest first.

## States

`running`, `done`, `failed`, `killed`, `kill-pending`, `kill-failed` are written onto the record. Two more are *derived* and never written: `stale` (the record says running, the supervisor pid is gone) and `corrupt` (the record cannot be trusted). One is a refusal to guess: `unknown`, printed as `unknown(<the raw state>)`, for a record whose state is not one this release knows — treated as live and unvouched, because a state that cannot be reasoned about is not evidence that nothing is running.

`running`, `kill-pending`, `stale`, `kill-failed` and `unknown` are the states in which processes may still be alive: they block their role, are cancellable, and are what `--force` has to kill and verify first. A `corrupt` job blocks its role too, until its recorded pids are shown to be dead.

## The reasons a state can carry

A job that records a reason is printed as `state(reason)`. This is the complete set the runtime can emit — it is declared in the runtime as `JOB_REASONS` and a test fails if the source writes one that is not listed here:

- `failed(sandbox-blind-precheck)` — codex's sandbox was **shown** unable to read a file in the job's cwd. Nothing was billed; codex never ran.
- `failed(sight-unproven)` — sight could be shown neither way (a CLI with no `sandbox` subcommand, or a cwd with nothing readable), and the dispatch did not pass `--allow-unproven-sight`.
- `failed(sight-probe-error)` — the probe could not be **run**: the spawn failed or produced nothing to judge, after a bounded retry. This is a transport failure, **not** a finding that codex is blind, and the cure is different — re-dispatch, or run the probe by hand.
- `failed(supervisor-spawn-failed)` — the detached supervisor would not spawn. Nothing was billed.
- `failed(codex-spawn-failed)` — the supervisor could not launch codex.
- `failed(codex-argv-refused)` — a value bound for codex's command line carried a character cmd.exe expands or re-parses after quote stripping (`%`, `!`, `"`), so the launch was refused rather than mangled. Nothing was billed. Windows only.
- `failed(claim-lost)` — the role was taken over while this job was starting, so it refused to launch beside the job that legitimately holds it.
- `failed(record-version-mismatch)` — the dispatch that wrote the record and the supervisor that picked it up are different releases of this runtime. A record stamped by one delivery gate is not evidence that another was met.
- `failed(dispatch-failed)` — the dispatch fell over after writing the record and before handing the job off. Recorded as failed rather than left reading `running` forever.
- `killed(cancelled-during-registration)` — a cancel arrived before the supervisor had registered anything to kill, and the supervisor honoured it before spending anything.
- `killed(cancelled-during-exec)` / `kill-failed(cancelled-during-exec)` — the same, one level down: the cancel landed while codex was being launched, so the supervisor killed codex itself. `kill-failed` means that kill could not be verified.

A finished job whose record cannot vouch for its run — one dispatched by an older release, before the delivery gate was versioned — is tagged `done(unvouched)`, and `/codex-dispatch:result` will refuse it and say why.

With no jobs on disk it prints a single `no jobs in <jobs-root>` line instead.

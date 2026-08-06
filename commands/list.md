---
description: List all codex-dispatch jobs, newest first, with state and out path
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" list`

Present the command output to the user unchanged — one line per job, `<id>  <state>  out: <path>`, newest first.

A failed job's state carries the reason the runtime actually recorded: `failed(sandbox-blind-precheck)` (codex's sandbox was shown unable to read a file in the job's cwd), `failed(sight-unproven)` (it could be shown neither way, and the dispatch did not pass `--allow-unproven-sight`), `failed(supervisor-spawn-failed)`, `failed(codex-spawn-failed)`, or `failed(claim-lost)`. A finished job whose record cannot vouch for its run — one dispatched by an older release, before the delivery gate was versioned — is tagged `done(unvouched)`, and `/codex-dispatch:result` will refuse it and say why.

With no jobs on disk it prints a single `no jobs in <jobs-root>` line instead.

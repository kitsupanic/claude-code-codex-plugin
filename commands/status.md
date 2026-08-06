---
description: Show state, runtime, log size, and out path for one or all codex-dispatch jobs
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" status $ARGUMENTS`

Present the command output to the user unchanged. Every job block ends with an `out:` line naming the literal output file path — always keep it; it is the fallback delivery channel if notifications drop. With no jobs on disk there is no block at all: the command prints a single `no jobs in <jobs-root>` line.

Two lines are worth never dropping when they appear. `sight:` says how this job earned the right to be delivered — `cwd-file:<name>` means a real file in its working directory was read back through the sandbox; `unproven (accepted by caller)` means it ran only because the dispatch passed `--allow-unproven-sight`, so nothing vouched for it. `survivors:` means processes outlived a kill and may still be billing.

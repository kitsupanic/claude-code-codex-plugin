---
description: Show state, runtime, log size, and out path for one or all codex-dispatch jobs
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" status $ARGUMENTS`

Present the command output to the user unchanged. Every job block ends with an `out:` line naming the literal output file path — always keep it; it is the fallback delivery channel if notifications drop.

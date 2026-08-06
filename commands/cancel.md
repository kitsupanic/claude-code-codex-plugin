---
description: Kill a running codex-dispatch job's whole process tree and mark it killed
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" cancel $ARGUMENTS`

Present the command output to the user unchanged, including the `out:` line.

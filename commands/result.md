---
description: Print the finished Codex answer verbatim (byte-for-byte, never summarized)
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" result $ARGUMENTS`

Present the full command output to the user EXACTLY as produced. Do not summarize, condense, re-rank, reformat, or annotate it — verbatim transport is the entire point of this plugin. If the job is not done, the command exits nonzero and prints the current state plus the `out:` path; show that unchanged too.

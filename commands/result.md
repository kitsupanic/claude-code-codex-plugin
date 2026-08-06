---
description: Collect a codex-dispatch job — the finished answer verbatim, or why it cannot be delivered
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" result $ARGUMENTS`

Present the command output to the user EXACTLY as produced — never summarize, condense, re-rank, reformat, or annotate it. Verbatim transport is the entire point of this plugin, and it applies to the refusals as much as to the answer. One of four outcomes:

- **Done** — the answer file's bytes on stdout, nothing else.
- **Sandbox-blind** — exits nonzero with the blindness explanation and the `out:` path, deliberately keeping the invented answer off stdout. Do not fetch that file for the user unless they ask for it by name.
- **Corrupt record** — exits nonzero with a corrupt-specific error naming the fault in `job.json`, plus the `out:` path.
- **Not ready** — exits nonzero with the job's current state and runtime, plus the `out:` path.

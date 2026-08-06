---
description: List all codex-dispatch jobs, newest first, with state and out path
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" list`

Present the command output to the user unchanged — one line per job, `<id>  <state>  out: <path>`, newest first, where a failed job's state carries its reason (`failed(sandbox-blind)`). With no jobs on disk it prints a single `no jobs in <jobs-root>` line instead.

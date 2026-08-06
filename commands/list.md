---
description: List all codex-dispatch jobs, newest first, with state and out path
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" list`

Present the command output to the user unchanged — one line per job with its state and `out:` path.

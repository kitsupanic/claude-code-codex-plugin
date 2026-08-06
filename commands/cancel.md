---
description: Cancel a codex-dispatch job — tree-kill a live one, or reap a corrupt one's pids
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" cancel $ARGUMENTS`

Present the command output to the user unchanged, including the `out:` line. A running or stale job is tree-killed and marked `killed`. A job whose `job.json` is corrupt has its pids reaped from the job dir's `.pid` files instead, and the record is left byte-for-byte as evidence — so it still reads `corrupt` afterwards, which is correct, not a failed cancel. A job that already finished is reported and left alone.

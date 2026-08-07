---
description: Cancel a codex-dispatch job — tree-kill a live one, or reap a corrupt one's pids
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" cancel $ARGUMENTS`

Present the command output to the user unchanged, including the `out:` line. A job in any of the live states — `running`, `kill-pending`, `stale`, `kill-failed` or `unknown` — is tree-killed, **the kill is then verified**, and only then is it marked `killed`. If anything survived, the command exits nonzero, lists the surviving pids, and the job becomes `kill-failed` rather than `killed` — the role stays blocked, deliberately, because a surviving codex is a billing codex. Report that loudly; the fix is `taskkill /PID <pid> /T /F` by hand.

A cancel that arrives before the job has registered anything to kill exits nonzero as `KILL PENDING` and the job becomes `kill-pending`, not `killed`: killing nothing is not killing it, and its supervisor may be starting Codex at that very moment. The cure is to re-run the same cancel in a moment — relay that rather than treating it as a failure.

A job whose `job.json` is corrupt has its pids reaped from the job dir's `.pid` files instead, and the record is left byte-for-byte as evidence — so it still reads `corrupt` afterwards, which is correct, not a failed cancel. Those spent pid files are renamed to `<name>.pid.reaped-<timestamp>`, so a second cancel on the same job reports `already reaped`, kills nothing, and changes nothing: pid numbers get reused, and a replayed cancel would fire them at whatever now owns them.

A job that already finished is reported and left alone.

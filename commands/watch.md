---
description: Open a console window that follows a codex-dispatch job and shouts when it finishes
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" watch $ARGUMENTS`

Present the command output to the user unchanged. It returns immediately: the watching happens in a **separate console window**, titled with the job id, which tails `run.log` and then prints a loud banner. For a job that ended `done` the banner reads `JOB FINISHED - result is ready` and gives the `out:` path and the exact `result` command; for any other terminal state it reads `JOB ENDED - state: <state>` and a `next:` line that fits that state, because `result` will refuse those. The window stays open afterwards; closing it is the user's business and does not affect the job.

This verb is for the human. Never watch on the user's behalf and never wait on that window — collect the job with `/codex-dispatch:result` when it is done, and check `/codex-dispatch:status` in the meantime.

If the window could not be opened, the command exits nonzero and says so rather than reporting a window that is not there; relay that and use `/codex-dispatch:status` instead.

Spawning a detached console window is Windows-only in this release; elsewhere the command says so and names the `tail -f` and `status` commands to use instead, rather than pretending to have opened something.

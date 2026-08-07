---
description: Remove finished codex-dispatch job directories — terminal jobs only, never a live one
argument-hint: '--all | --older-than <days>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" clean $ARGUMENTS`

Present the command output to the user unchanged — a `removed: <id>` line per job removed, then the jobs that were kept and why, then the count and the jobs root they were counted in.

Nothing else in this runtime removes a job directory: a dispatch's prompt, `run.log` (which can be megabytes), record and answer file are kept for ever, so the jobs root grows until somebody clears it. This is the verb that clears it, and it is **manual on purpose** — there is no automatic pruning, because a record is the only account of what a job did and no background sweep gets to decide that an account has expired.

**It asks for the ask.** With neither `--all` nor `--older-than <days>` it removes nothing and exits nonzero saying which to type. `--all` takes every eligible job; `--older-than <days>` takes the eligible ones that finished more than that many days ago (measured from `finished`, or from `started` when a job never recorded one).

**Eligible means terminal: `done`, `failed`, `killed`.** That is the same set the supervisor is allowed to release a role on — the states that say everything the job owned is gone. Everything else is kept, and the output names it:

- `running`, `kill-pending`, `stale`, `kill-failed` and `unknown` are the states in which processes may still be alive. Removing one of those directories removes the `.pid` files that are the only remaining way to kill what it owns. Cancel it first (`/codex-dispatch:cancel`), and clean it once it is terminal.
- A `corrupt` job.json is **evidence**. This runtime never rewrites one and never deletes one; a human decides what to do with it.
- An entry that is a link, or resolves outside the jobs root, is refused rather than removed — nothing is read through it and nothing is deleted through it. If one turns up, relay it: something created a junction named like a job id.

There is deliberately no `--force`. A flag that removed live or corrupt jobs would mean "ignore the state taxonomy", and the taxonomy is what stops a still-billing Codex from becoming unkillable.

Removal happens under the job's own record lock, and the state is re-checked inside it, so a job that turns live between the listing and the removal is kept. If a removed job still held a role claim, the next dispatch for that role reclaims it normally.

A removal that cannot finish — something is sitting in the directory, an antivirus scan has a file — is reported (`could not be removed: <code>`, plus a `WARNING:` on stderr) and the run carries on with the other jobs; one stuck file never ends the run. Such a job keeps its `job.json`, which is what keeps it visible to `list` and cleanable later: relay the warning and suggest running it again once whatever holds the file has let go.


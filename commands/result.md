---
description: Collect a codex-dispatch job — the finished answer verbatim, or why it cannot be delivered
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" result $ARGUMENTS`

Present the command output to the user EXACTLY as produced — never summarize, condense, re-rank, reformat, or annotate it. Verbatim transport is the entire point of this plugin, and it applies to the refusals as much as to the answer. The job's RECORD decides whether there is an answer to hand over; the presence of an answer file does not. One of five outcomes:

- **Done** — the answer file's bytes on stdout, nothing else. If the record carries a `warning:` (sandbox-failure signatures in the run log), or an `UNPROVEN SIGHT` caveat (the job ran only because its dispatch passed `--allow-unproven-sight`), that is printed on stderr alongside the answer: relay both. The caveat is part of the delivery, not decoration — an unproven answer is one nothing vouched for, and whoever reads it needs to know that as much as they need the answer itself.
- **Blind** — the job never ran, because codex's sandbox could not read a file in the job's own working directory. Exits nonzero with the explanation and the `out:` path; there is no invented answer to fetch, which is the improvement.
- **Unproven** — the job never ran, because sight could be neither proven nor disproven: a codex too old to have the `sandbox` subcommand, or a `--cd` with nothing readable in it. Exits nonzero naming the cures, and nothing was billed. Relay it as-is; re-dispatching with `--allow-unproven-sight` is the user's call, never a workaround to apply on their behalf.
- **Corrupt record** — exits nonzero with a corrupt-specific error naming the fault in `job.json`, plus the `out:` path.
- **Not delivered** — anything else: running, stale, failed, killed, kill-failed. Exits nonzero naming the state, the runtime, and the `out:` path. If an answer file exists anyway the refusal says so and still refuses, because nothing has vouched for how that run ended. Do not fetch that file for the user unless they ask for it by name.

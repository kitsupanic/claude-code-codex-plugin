---
description: Collect a codex-dispatch job — the finished answer verbatim, or why it cannot be delivered
argument-hint: '<job-id>'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-dispatch.mjs" result $ARGUMENTS`

Present the command output to the user EXACTLY as produced — never summarize, condense, re-rank, reformat, or annotate it. Verbatim transport is the entire point of this plugin, and it applies to the refusals as much as to the answer. The job's RECORD decides whether there is an answer to hand over; the presence of an answer file does not. One of eight outcomes:

- **Done** — the answer file's bytes on stdout, nothing else. If the record carries a `warning:` (sandbox-failure signatures in the run log), or an `UNPROVEN SIGHT` caveat (the job ran only because its dispatch passed `--allow-unproven-sight`), that is printed on stderr alongside the answer: relay both. The caveat is part of the delivery, not decoration — an unproven answer is one nothing vouched for, and whoever reads it needs to know that as much as they need the answer itself.
- **Blind** — the job never ran, because codex's sandbox could not read a file in the job's own working directory. Exits nonzero with the explanation and the `out:` path; there is no invented answer to fetch, which is the improvement.
- **Probe error** — the job never ran, because the sight probe could not be **run** at all, so nothing is known about that sandbox either way. Exits nonzero saying exactly that: it is a transport failure, **not** a finding that codex is blind, and conflating the two sends the user chasing the wrong cure. A transport failure that does not repeat costs one retry, so re-dispatching once is the advised move; if it repeats, the refusal names the by-hand probe and the `--allow-unproven-sight` opt-in.
- **Unproven** — the job never ran, because sight could be neither proven nor disproven: a codex too old to have the `sandbox` subcommand, or a `--cd` with nothing readable in it. Exits nonzero naming the cures, and nothing was billed. Relay it as-is; re-dispatching with `--allow-unproven-sight` is the user's call, never a workaround to apply on their behalf.
- **Unvouched** — the record says `done`, but it cannot vouch for how the run went: no schema stamp (a job dispatched by an older release, before the delivery gate was versioned), a nonzero exit, a `sight:` that is not proof, or a claim of an accepted unproven sight with no recorded opt-in behind it. Exits nonzero naming which, plus the `out:` path. Nothing is broken and nothing is being hidden — relay it as-is. Reading the file out on the user's behalf is precisely the workaround this gate exists to prevent; if they want the bytes, that is theirs to ask for.
- **Missing** — the record says `done` and vouches for the run, but the answer file is not on disk. Exits nonzero naming the `out:` path it looked at. There is nothing to relay but that: the bytes the record promised are gone, and no other file substitutes for them.
- **Corrupt record** — exits nonzero with a corrupt-specific error naming the fault in `job.json`, plus the `out:` path.
- **Not delivered** — anything else: running, stale, failed, killed, kill-pending, kill-failed. Exits nonzero naming the state, the runtime, and the `out:` path. If an answer file exists anyway the refusal says so and still refuses, because nothing has vouched for how that run ended. Do not fetch that file for the user unless they ask for it by name.

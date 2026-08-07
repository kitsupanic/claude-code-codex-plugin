# codex-dispatch

A Claude Code plugin + standalone job runtime that wraps the OpenAI Codex CLI
for **long-running, background, verbatim-transport dispatches**: a session sends
a large standalone brief to a pinned frontier model and gets the answer back
untouched, minutes to half an hour later, reliably, on Windows.

The runtime (`scripts/codex-dispatch.mjs`) is the product; the plugin is a thin
shell over it. Zero npm dependencies, Node 18+.

## Why it exists — the seven invariants

The official `codex` plugin serves casual interactive reviews. This one serves
orchestrated second-opinion dispatches, which need seven guarantees the official
plugin does not make:

1. **Verbatim brief in.** A markdown file on `codex exec -` stdin, byte-for-byte
   — never inlined on a command line, where Windows quoting mangles large briefs.
2. **Model and effort pinned, recorded, cheap by default.** Every job records
   what it ran on; shipped defaults are budget (`gpt-5.6-luna` at `medium`),
   frontier is two flags away (`--model gpt-5.6-sol --effort xhigh`).
3. **Sandbox controlled.** `read-only` unless an explicit `--write`.
4. **Verbatim answer out.** The `--output-last-message` file, untouched — nothing
   here summarizes, truncates, or reformats a Codex answer.
5. **No unproven answer without a recorded opt-in.** Before codex is launched,
   the supervisor proves the sandbox can read a real file in the job's own cwd.
   No proof, no job — unless `--allow-unproven-sight`, which is stamped on the
   record forever.
6. **Deliverability is a versioned, positive property of the record.** `result`
   delivers only when the record vouches for its run; records written under an
   older gate are `unvouched` and refused.
7. **One fail-closed validator** in front of every ownership, kill and delivery
   decision — fields are checked for meaning, and every out-of-domain value
   resolves to the reading that costs a refused dispatch, never a second billing
   codex.

The full account of how each is enforced — the sight proof, the validator's
field table, the supervisor/job model, verified kills, the watcher — is in
[docs/DESIGN.md](docs/DESIGN.md). The production failures and review rounds that
shaped it are in [docs/REVIEWS.md](docs/REVIEWS.md); the decisions made during
the build — including the revoked ones — in [docs/DECISIONS.md](docs/DECISIONS.md).

## How this differs from `openai/codex-plugin-cc`

The [official OpenAI plugin](https://github.com/openai/codex-plugin-cc) and this
one drive the same CLI underneath and share no code — this is not a fork; it was
built clean-room against a written brief. Theirs is interactive convenience;
this is orchestration infrastructure.

|  | official `codex` plugin | this (`codex-dispatch`) |
| --- | --- | --- |
| **Brief transport** | codex's own reviewer (no brief), prompt templates with interpolated variables, optional focus text | a markdown file on `codex exec -` stdin, byte-for-byte; never inlined on a command line |
| **Model & effort** | deliberately unset — Codex's defaults, or your `config.toml` | explicit defaults, recorded in `job.json`; ships budget (`gpt-5.6-luna`, `medium`), frontier per call (`--model gpt-5.6-sol --effort xhigh`) |
| **Sandbox** | `read-only` for reviews; the rescue agent defaults to write-capable | `read-only` unless `--write`, plus a per-job positive sight proof in the job's own cwd before codex is launched |
| **Job model** | background jobs polled from the session via a companion app-server broker | detached supervisor, on-disk records, unique job dirs, atomic role claims, verified kill-before-retry, stale reaping, atomic type-checked records, whitelisted ids and roles proved inside the jobs root |
| **Hooks** | `SessionStart`/`SessionEnd` lifecycle, plus an opt-in stop-time review gate | none, ever — enforced by a test |
| **Footprint** | companion app-server, agents, skills, prompt templates, output schemas, 8 commands | one zero-dependency script, 6 commands, 1 skill |
| **Tests** | 8 test files, CI on every pull request | 103 tests — fake-codex lifecycle drills, the deliverability matrix, sight-gate and kill-verification drills, path-escape canaries, a concurrency race and a fenced-claim takeover, plus an opt-in live smoke |

Things the official plugin has that this one deliberately does not: the
`codex-rescue` subagent, `/codex:review`'s zero-brief native reviewer, the
adversarial-review framing, session-lifecycle integration, and OpenAI's own
maintenance. For interactive, user-fired reviews that plugin is the better
instrument; use this one for orchestrated background dispatches. Installing both
is fine — separate marketplaces, separate names, `/codex:*` against
`/codex-dispatch:*`.

The sharpest single difference is epistemic. Neither pipeline originally had a
concept of a *blind* success: a dispatch whose sandboxed tool calls all fail
still exits 0 and returns a fluent, plausible answer — [docs/REVIEWS.md](docs/REVIEWS.md)
records exactly that incident, a completed, billed, frontier-model review that
had never read a single file. For a convenience tool that is an annoyance; for a
second opinion it is the entire product failing silently. So this runtime
proves, per job and in that job's own working directory, that the sandbox can
read a file — and refuses to print an answer whose record does not say it earned
one.

## Install

This repo is its own marketplace: `.claude-plugin/marketplace.json` sits at the
root and lists one plugin with `"source": "./"`, so the repo root *is* the
plugin. Both install routes are the same two commands, differing only in what
you hand to `marketplace add`.

**From GitHub:**

```
/plugin marketplace add kitsupanic/claude-code-codex-plugin
/plugin install codex-dispatch@kitsupanic
```

**From a local clone:**

```
/plugin marketplace add C:\path\to\claude-code-codex-plugin
/plugin install codex-dispatch@kitsupanic
```

Three names, three jobs, and they are deliberately different:

- **`claude-code-codex-plugin`** is the repo — a GitHub `owner/repo` slug or a
  local path. That is what `marketplace add` takes, and the only place it is used.
- **`kitsupanic`** is the marketplace — the `name` in `marketplace.json`. It is
  the catalog, not a plugin: it happens to hold one today and can hold more later.
- **`codex-dispatch`** is the plugin. So the install string is
  `codex-dispatch@kitsupanic` — `<plugin>@<marketplace>`.

Commands appear as `/codex-dispatch:dispatch`, `:status`, `:result`, `:cancel`,
`:list`, `:watch`. There are **no hooks** — this plugin never inserts itself into
a session's lifecycle.

Update after a push with `/plugin marketplace update kitsupanic`.

**As a bare runtime (no plugin system needed):**

```
node scripts/codex-dispatch.mjs <verb> [...]
```

Prerequisites: Node 18+, `npm install -g @openai/codex`, `codex login`.

## Usage

A typical session, start to finish:

```
/codex-dispatch:dispatch review-brief.md --role review
  → job: review-1786031944-36232        (returns immediately; the job runs in
    out: C:\...\out.txt                  the background, minutes to half an hour)

/codex-dispatch:status review-1786031944-36232     # check on it whenever
/codex-dispatch:result review-1786031944-36232     # collect the verbatim answer
```

`dispatch` takes either a **path to an existing file** (used as the brief,
byte-for-byte) or **inline text** (written verbatim to a temp file first — a
brief never travels on a command line). The other commands — `:status`,
`:result`, `:cancel`, `:list`, `:watch` — are one-argument wrappers over the
runtime verbs below.

All six commands are **user-typed only** (`disable-model-invocation: true`):
Claude never fires a dispatch on its own, because a dispatch bills.

**Writing a brief.** The brief is transported verbatim and Codex sees nothing
else — not your conversation, not your session context. So it must stand alone:

- name the working directory to read (`--cd D:\repo` points the sandbox there,
  and the brief should say what to look at inside it);
- state the question and the shape of answer you want (a review with findings?
  a design with trade-offs? a diagnosis with a root cause?);
- include any context the model needs, pasted in — it cannot ask follow-ups.

**Wiring your own agents.** The plugin ships a model-facing skill
(`codex-dispatch-runtime`, not user-invocable) that carries the full contract —
verbatim transport, poll `result` instead of watching, never read `out.txt`
around a refusal, never add `--allow-unproven-sight` to get past a gate. Any
session with the plugin installed has it; you do not need to restate the rules.
What the skill cannot know is **when your project wants a dispatch**, so if you
want agents to reach for it as part of a workflow, say so in your `CLAUDE.md`,
e.g.:

```markdown
## Second opinions
For architecture decisions and pre-merge reviews, prepare a standalone brief
and ask me to run /codex-dispatch:dispatch <brief> --role review --cd <repo>.
Poll with /codex-dispatch:result; deliver the answer verbatim, including any
warnings on stderr. Frontier tier (--model gpt-5.6-sol --effort xhigh) only
when I ask for it.
```

(Keep the dispatch itself user-fired — that is what the
`disable-model-invocation` flag enforces, and "ask me to run" is the phrasing
that respects it.)

If you want a dedicated subagent instead — one that composes the brief,
dispatches, polls, and relays verbatim when you ask for a second opinion —
copy [examples/second-opinion-agent.md](examples/second-opinion-agent.md) into
your project's `.claude/agents/` and adjust the description to your workflow.
It encodes the same contract: budget defaults unless you ask for frontier,
poll `result` (never `watch`), refusals relayed as-is, no
`--allow-unproven-sight` on its own initiative.

## Releases and versioning

**A push that changes behavior MUST bump the version**, in all three places that
carry it (`plugin.json`, and both `version` fields in `marketplace.json` — the
packaging test asserts they are identical, so they move together or the suite
goes red).

This is not bookkeeping. `marketplace update` compares versions: an installed
copy stays exactly where it is until the number moves, no matter how many commits
the repo is ahead. Four pushes shipped as `0.1.0` before anyone noticed that
every install was pinned to the first of them — the fix landed in the repo and
nowhere else, silently, which is the same shape of failure as a blind answer:
confident, and wrong in a way nothing surfaces.

Current release: **0.7.1** — 0.7.0's Windows quoting fix, reviewed by a second
dispatch and repaired. 0.7.0 checked the `--cd` you typed rather than the cwd it
resolved, so dispatching from a directory with a `%` in its name skipped the gate
and stranded the job; the check now runs on the resolved value and a refusal
finalizes the record instead of leaving it to go stale. `"` and `!` join `%` as
refused rather than escaped. 0.6.0 and 0.7.0 records remain deliverable. Full
history, including the
`RECORD_VERSION` 2 cutoff that makes 0.1–0.4 records undeliverable, in
[docs/CHANGELOG.md](docs/CHANGELOG.md).

## Verb reference

```
node scripts/codex-dispatch.mjs dispatch --brief review-brief.md --role review
  # → job: review-1785972364-11696
  #   bin: C:\Users\me\AppData\Roaming\npm\codex.cmd
  #   out: C:\Users\me\AppData\Local\codex-dispatch\jobs\review-1785972364-11696\out.txt

node scripts/codex-dispatch.mjs dispatch --brief b.md --role fix --cd D:\repo --write
node scripts/codex-dispatch.mjs dispatch --brief b.md --role review --model gpt-5.6-sol --effort xhigh
  # ↑ the frontier escalation. Without those two flags a dispatch runs on the
  #   shipped budget defaults: gpt-5.6-luna at medium effort.

node scripts/codex-dispatch.mjs dispatch --brief b.md --role review --watch
  # ↑ dispatch, then open a console window that follows it and shouts when done

node scripts/codex-dispatch.mjs dispatch --brief b.md --role review --allow-unproven-sight
  # ↑ the ONLY way to get an answer out of a job whose sight could not be proven.
  #   Without it such a job is refused; with it the record says so forever.

node scripts/codex-dispatch.mjs status            # all jobs
node scripts/codex-dispatch.mjs status <job-id>   # one job: state, sight, deliverability, warnings, runtime, log size, out path
  # sight: cwd-file:<name>            proven — a real file in the job's cwd was read back
  # sight: unproven (accepted by ...) ran only because --allow-unproven-sight was passed
  # (a job whose sight could be neither proven nor disproven, without that flag,
  #  never ran: state failed, reason sight-unproven — or sight-probe-error when the
  #  probe could not be RUN at all, which is a transport failure, not blindness)
  # deliverable: yes (...)            printed for finished jobs — what earned the delivery
  # deliverable: NO - unvouched: ...  the record cannot vouch for the run; result will refuse
node scripts/codex-dispatch.mjs result <job-id>   # the answer, verbatim, stdout only; nonzero + out: path unless the record says done AND vouches for it
node scripts/codex-dispatch.mjs cancel <job-id>   # kill the whole tree, verify it died, mark killed
node scripts/codex-dispatch.mjs list              # one line per job, newest first
node scripts/codex-dispatch.mjs watch <job-id>    # detached console window: tails run.log, then a JOB FINISHED banner
node scripts/codex-dispatch.mjs preflight         # install / auth / functional-sandbox check
  # → preflight: ok
  #   bin: C:\Users\me\AppData\Roaming\npm\codex.cmd
  #   version: codex-cli 0.146.0
  #   auth: Logged in using ChatGPT
  #   sandbox: functional (file reads work inside --sandbox read-only)
```

- `--role` must match `^[a-z]+$` and job ids are therefore `^[a-z]+-\d+-\d+$`;
  anything else is refused before it can become a path.
- `dispatch` refuses if a job with the same `--role` is still `running`,
  `kill-pending`, `stale`, `kill-failed` or `unknown` — the five states in which
  processes may still be alive — and a **corrupt** record blocks too, until its
  pids are proven dead. The refusal names which it is. `--force` kills that job's
  tree first and then **checks**: if anything survived, the new job is refused
  rather than launched alongside it. State semantics are in
  [docs/DESIGN.md](docs/DESIGN.md).
- Jobs root: `%LOCALAPPDATA%\codex-dispatch\jobs\`, overridable via
  `CODEX_DISPATCH_JOBS`. Job records survive reboots; `list`/`status` mark jobs
  whose recorded pids no longer exist as `stale`.
- `CODEX_DISPATCH_BIN` overrides the codex binary (a `.mjs`/`.cjs`/`.js` path is run
  via node — this is how the tests substitute a fake codex).
- `watch` is a human affordance and Windows-only in this release; agents poll
  `result`. Details in [docs/DESIGN.md → Watching a job](docs/DESIGN.md#watching-a-job).

## Tests

```
node --test                            # everything: 103 tests (bare form — see below)
node --test tests/dispatch.test.mjs    # lifecycle, against a fake codex
node --test tests/packaging.test.mjs   # manifests, command frontmatter, no-hooks invariant
node --test tests/resolution.test.mjs  # binary resolution, sight-probe targeting, blind scan, whitelists, deliverability (imported, not spawned)
node tests/live-smoke.mjs              # one real cheap dispatch; skips loudly if codex absent/logged out
```

One of the 103 is skipped on Windows and runs on POSIX: the process-group kill has
no Windows analogue to assert (`taskkill /T` is the path there), so the *choice* of
targets is unit-tested on both platforms via `killPlan` and the kill itself is
integration-tested only where it applies.

**Invocation quirk:** `node --test tests/` fails on Node 24 — the directory
path is resolved as a module (`Cannot find module ...\tests`). Use the bare
`node --test` (from the repo root) or name the file. Bare discovery matches
`*.test.mjs`, so `tests/live-smoke.mjs` is never picked up by accident: the
naming, not a config file, is what keeps the real-billing smoke opt-in.

What the fake codex fakes, the full coverage inventory, the review findings
turned into assertions (each confirmed to fail against the release it was
written about), and the test-only knobs the runtime carries are documented in
[docs/TESTS.md](docs/TESTS.md).

## Contributing

Zero runtime dependencies and no build step: clone it and run `node --test`.
Every constraint in the runtime traces to an entry in [docs/REVIEWS.md](docs/REVIEWS.md)
— if a change relaxes one, say which failure it is no longer guarding against.

## License

MIT — see [LICENSE](LICENSE).

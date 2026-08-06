# codex-dispatch

A Claude Code plugin + standalone job runtime that wraps the OpenAI Codex CLI
for **long-running, background, verbatim-transport dispatches**: a session sends
a large standalone brief to a pinned frontier model and gets the answer back
untouched, minutes to half an hour later, reliably, on Windows.

The runtime (`scripts/codex-dispatch.mjs`) is the product; the plugin is a thin
shell over it. Zero npm dependencies, Node 18+.

## Why it exists — the five invariants

The official `codex` plugin serves casual interactive reviews. This one serves
orchestrated second-opinion dispatches, which need five guarantees the official
plugin does not make:

1. **Verbatim brief in.** The brief is a markdown file fed to `codex exec -` on
   stdin, byte-for-byte. Never inlined on a command line — Windows quoting
   mangles large briefs (learned in production, not a preference).
2. **Model and effort are pinned, recorded, and cheap by default.** Every job
   records the exact model and effort it ran on in `job.json` — never "whatever
   the CLI felt like". What *ships* is the budget pair, `gpt-5.6-luna` at
   `medium` (via `-c model_reasoning_effort=...`), so a fresh install cannot
   bill frontier prices by accident. Frontier is two flags away:
   `--model gpt-5.6-sol --effort xhigh`.
3. **Sandbox controlled.** Default `--sandbox read-only`; write access only via
   an explicit `--write` flag. A review dispatch can never scribble on the
   target repo by accident.
4. **Verbatim answer out.** The result is the `--output-last-message` file,
   returned untouched. Nothing in this repo summarizes, truncates, or reformats
   a Codex answer.
5. **No blind answers.** A dispatch whose sandbox cannot read files produces a
   confident, sourceless answer and exits 0. The runtime proves the sandbox works
   before dispatching, and scans the finished run for the failure signatures
   afterwards. An answer is delivered only if the model could see.

## How this differs from `openai/codex-plugin-cc`

The [official OpenAI plugin](https://github.com/openai/codex-plugin-cc) and this
one drive the same CLI underneath and share no code — this is not a fork; it was
built clean-room against a written brief. What differs is the centre of gravity.
Theirs is interactive convenience: you are in a session, you want Codex's opinion
or want to hand it a task, and it is one command away. This one is orchestration
infrastructure: a long-running background dispatch that carries a large brief
verbatim to a pinned model, on Windows, and can be shown to have actually read
something.

|  | official `codex` plugin | this (`codex-dispatch`) |
| --- | --- | --- |
| **Brief transport** | codex's own reviewer (no brief), prompt templates with interpolated variables, optional focus text | a markdown file on `codex exec -` stdin, byte-for-byte; never inlined on a command line |
| **Model & effort** | deliberately unset — Codex's defaults, or your `config.toml` | explicit defaults, recorded in `job.json`; ships budget (`gpt-5.6-luna`, `medium`), frontier per call (`--model gpt-5.6-sol --effort xhigh`) |
| **Sandbox** | `read-only` for reviews; the rescue agent defaults to write-capable | `read-only` unless `--write`, plus a functional sandbox preflight and post-run blind-job detection |
| **Job model** | background jobs polled from the session via a companion app-server broker | detached supervisor, on-disk records, unique job dirs, same-role guard, kill-before-retry, stale reaping, atomic type-checked records, whitelisted ids |
| **Hooks** | `SessionStart`/`SessionEnd` lifecycle, plus an opt-in stop-time review gate | none, ever — enforced by a test |
| **Footprint** | companion app-server, agents, skills, prompt templates, output schemas, 8 commands | one zero-dependency script, 5 commands, 1 skill |
| **Tests** | 8 test files, CI on every pull request | 30 tests — fake-codex lifecycle drills, blind/sighted regressions, plus an opt-in live smoke |

Things the official plugin has that this one deliberately does not: the
`codex-rescue` subagent, `/codex:review`'s zero-brief native reviewer, the
adversarial-review framing, session-lifecycle integration and transfer of a
session into Codex, and OpenAI's own maintenance. This tool does one thing. For
interactive, user-fired reviews and for delegating a task from inside a session,
that plugin is the better instrument; use this one for orchestrated background
dispatches. Installing both is fine — separate marketplaces, separate plugin
names, `/codex:*` against `/codex-dispatch:*`.

The sharpest single difference is epistemic. Neither pipeline originally had a
concept of a *blind* success: a dispatch whose sandboxed tool calls all fail
still exits 0 and returns a fluent, plausible answer. The failure catalog below
records exactly that incident — a completed, billed, frontier-model review that
had never read a single file, and that was indistinguishable from a good one
until someone read the log. For a convenience tool that is an annoyance; for a
second opinion it is the entire product failing silently. So this runtime proves
the sandbox can read before it dispatches, audits the run log for blindness
afterwards, and refuses to print an answer it cannot vouch for.

## The failure catalog behind the design (2026-08-05/06, all seen in production)

- A foreground run under a 10-minute tool cap timed out and **orphaned the codex
  process** — it kept running, kept billing, and overwrote the retry's output.
  → There is no foreground mode. Dispatch always returns immediately with a job
  handle; a detached supervisor owns the run.
- A date-only filename was reused by a retry, so orphan and live run shared
  paths. → Every dispatch gets `<role>-<epoch-seconds>-<pid>/` — path reuse is
  impossible by construction.
- A retry launched while the first attempt was alive → two Codex instances,
  double billing. → Kill-before-retry is built in: `--force` and `cancel` run
  `taskkill /PID <pid> /T /F` on the recorded supervisor pid.
- Wake-up notifications dropped four times in one day, and status output that
  didn't name the output file forced filesystem hunts. → **Every dispatch/status
  output prints the literal absolute out-file path as `out: <path>`.** The
  deterministic path is the fallback delivery channel; the out file appears only
  when the run finishes, so its existence is the done signal.
- `codex` missing from PATH in shells started before install. → Preflight resolves
  `%APPDATA%\npm\codex.cmd` itself (see the resolution order below).
- Auth lapses silently. → Preflight runs `codex --version` and
  `codex login status` and names the exact fix for each failure.
- **A review dispatch came back as a real-looking answer that had read nothing.**
  Bare `codex` on PATH resolved to the *desktop-app* build
  (`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`), which ships without the
  Windows sandbox helper executables. Every file read inside the job failed —
  `orchestrator_helper_launch_failed`, `helper=codex-windows-sandbox-setup.exe`,
  `CreateProcessWithLogonW failed: 2`, eleven times in one run.log — while codex
  **exited 0**, the job read `done`, and the out file politely asked for the source
  to be pasted in. A silent blind success: the worst possible failure for a
  second-opinion tool, because it looks exactly like a first opinion.
  → Binary resolution puts the npm build first and the desktop app last; preflight
  proves the sandbox can read a file; the supervisor scans run.log and fails the
  job even on exit 0.
- **That scan then failed the first job that actually worked.** The end-to-end
  proof — "review `scripts/codex-dispatch.mjs`" — read the file successfully and
  echoed it into the log, and the file contains all four signature strings as
  literals. A substring scan makes a self-referential repo unreviewable, and does
  it by declaring a success a failure. Splitting stdout from stderr does not help
  either: `codex exec` puts its *whole transcript* — echoed file content included —
  on stderr, and only the final answer on stdout. → A hit only counts on a line
  codex itself emitted, matched by shape:
  `<rfc3339>Z ERROR codex_core::…:`. Verified offline against seven real job logs
  — four genuinely blind runs caught, three sighted ones (including the one that
  caused this) clean.

## Install

This repo is its own marketplace: `.claude-plugin/marketplace.json` sits at the
root and lists one plugin with `"source": "./"`, so the repo root *is* the
plugin. Both install routes are therefore the same two commands, differing only
in what you hand to `marketplace add`.

**From GitHub:**

```
/plugin marketplace add kitsupanic/claude-code-codex-plugin
/plugin install codex-dispatch@codex-dispatch
```

**From a local clone:**

```
/plugin marketplace add C:\path\to\claude-code-codex-plugin
/plugin install codex-dispatch@codex-dispatch
```

`marketplace add` takes the repo (a GitHub `owner/repo` slug or a local path);
the marketplace then registers under the `name` in its manifest, which is
`codex-dispatch` regardless of what the repo is called. So the install string is
`codex-dispatch@codex-dispatch` — `<plugin>@<marketplace>`, both named
`codex-dispatch` here, which is normal for a single-plugin repo.

Commands appear as `/codex-dispatch:dispatch`, `:status`, `:result`, `:cancel`,
`:list`. There are **no hooks** — this plugin never inserts itself into a
session's lifecycle.

Update after a push with `/plugin marketplace update codex-dispatch`.

**As a bare runtime (no plugin system needed):**

```
node scripts/codex-dispatch.mjs <verb> [...]
```

Prerequisites: Node 18+, `npm install -g @openai/codex`, `codex login`.

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

node scripts/codex-dispatch.mjs status            # all jobs
node scripts/codex-dispatch.mjs status <job-id>   # one job: state, runtime, log size, out path
node scripts/codex-dispatch.mjs result <job-id>   # the answer, verbatim, stdout only; nonzero + out: path if not done
node scripts/codex-dispatch.mjs cancel <job-id>   # taskkill the whole tree, mark killed
node scripts/codex-dispatch.mjs list              # one line per job, newest first
node scripts/codex-dispatch.mjs preflight         # install / auth / functional-sandbox check
  # → preflight: ok
  #   bin: C:\Users\me\AppData\Roaming\npm\codex.cmd
  #   version: codex-cli 0.146.0
  #   auth: Logged in using ChatGPT
  #   sandbox: functional (file reads work inside --sandbox read-only)
```

- `--role` must match `^[a-z]+$` and job ids are therefore `^[a-z]+-\d+-\d+$`;
  anything else is refused before it can become a path (see below).
- `dispatch` refuses if a job with the same `--role` is still `running` **or
  `stale`** — stale means the supervisor died before an out file appeared, so
  codex was probably reparented and is still running and still billing. The
  refusal names which of the two it is. `--force` kills that job's tree first,
  including the recorded codex pid and any pids in the job dir's `child.pid`,
  which is what actually reaches an orphan whose supervisor is already gone.
- Jobs root: `%LOCALAPPDATA%\codex-dispatch\jobs\`, overridable via
  `CODEX_DISPATCH_JOBS`. Job records survive reboots; `list`/`status` mark jobs
  whose recorded pids no longer exist as `stale`.
- `CODEX_DISPATCH_BIN` overrides the codex binary (a `.mjs`/`.js` path is run
  via node — this is how the tests substitute a fake codex).

## Which codex binary — and proving it can see

Two codex builds can be installed at once, and they are not interchangeable for
this runtime. The npm build vendors the Windows sandbox helper executables; the
desktop-app build does not, and it is the one bare `codex` finds on PATH.

**Resolution order** (first that answers `--version` wins):

1. `CODEX_DISPATCH_BIN` — trusted, unchecked. That is its point.
2. `%APPDATA%\npm\codex.cmd` — the npm global install.
3. any other `codex.cmd` on PATH (`where codex.cmd`) — a different npm prefix.
4. bare `codex` on PATH.
5. `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` — the desktop app, **last**.

The desktop app is last rather than excluded: it is a working CLI for everything
except the sandbox, and if it is all a machine has, the preflight failure below
says so precisely instead of the runtime pretending nothing is installed.

**Functional sandbox check.** Preflight writes a nonce into a temp file and runs
`codex sandbox <cat that file>` — codex's own sandbox, no model, no tokens, no
billing, ~300 ms. It is `functional` only if the command exits 0 *and* the nonce
comes back. A `broken` sandbox is a preflight **failure** (on Windows — elsewhere
a warning, since Windows is the platform this probe is verified on) whose message
names the resolved binary, the probe error, and the npm-vs-desktop fix. If the CLI
is too old to have a `sandbox` subcommand the probe reports `unavailable` and
preflight warns rather than fails, leaving the run.log scan as the backstop.

**Blind-job detection.** Exit code 0 is not proof of sight, so when a job finishes
the supervisor scans `run.log` for the four signatures the sandbox failure prints
(`orchestrator_helper_launch_failed`, `helper=codex-windows-sandbox-setup.exe`,
`CreateProcessWithLogonW failed`, `helper copy failed`) — but only on lines codex
itself emitted, identified by its tracing shape
(`2026-…Z ERROR codex_core::exec: …`). The same strings appearing as echoed file
content or in the model's own prose are content, not diagnosis. A hit flips the job to `failed` with
`reason: sandbox-blind`, shown by `status` and as `failed(sandbox-blind)` in
`list`. `result` on such a job exits nonzero, explains what happened, and keeps
the invented answer off stdout — the out file stays on disk, named as always, for
anyone who wants to see what a blind run produces.

## Corrupt records and job ids

- **`job.json` writes are atomic** (temp file + rename, with a short retry for the
  Windows replace-rename race). A half-written record is the corruption most
  likely to be self-inflicted.
- **A corrupt `job.json` cannot brick the runtime.** Reads return a corrupt marker
  instead of throwing: `list` and `status` render the job as `corrupt` and name the
  parse error, every other verb skips it, and `dispatch` is never blocked by one.
- **Corrupt means wrong-typed too, not just unparseable.** Parsing to an object is
  not enough — the verbs assume types (`allJobs` sorts on `started.localeCompare`,
  the supervisor hands `model`/`effort`/`sandbox`/`cwd`/`bin` to spawn), so a
  record with `"started": 12345` used to crash every listing verb, for every job.
  `readRecord` now type-checks the fields the verbs consume and returns the same
  marker, naming the field: `corrupt job.json (field "started" is not a string
  (number))`.
- **`cancel` on a corrupt job still reaps processes**, from the `supervisor.pid`,
  `codex.pid` and `child.pid` files the job dir carries alongside the record — and
  leaves the corrupt `job.json` byte-for-byte intact, because it is the evidence.
  Such a job therefore keeps reading as `corrupt` after cancellation.
- **Job ids are whitelisted, not sanitized**: `^[a-z]+-\d+-\d+$`, checked before
  the id is ever joined into a path. Roles are `^[a-z]+$` for the same reason, and
  the collision suffix extends the pid digits (`…-4844` → `…-48441`) rather than
  adding a segment, so a generated id always satisfies the whitelist it will later
  be checked against.

## The supervisor / job model

```
dispatch (returns immediately)
  ├─ creates <jobs-root>/<role>-<epoch>-<pid>/
  │    ├─ prompt.md        byte-copy of the brief
  │    ├─ job.json         role, model, effort, sandbox, cwd, pids, state, timestamps
  │    ├─ run.log          codex stdout+stderr — grows during the run (liveness signal);
  │    │                    the transcript, and what the blind scan reads at the end
  │    ├─ supervisor.log   supervisor diagnostics
  │    ├─ supervisor.pid   ┐ plain-text kill targets mirroring job.json, so a corrupt
  │    ├─ codex.pid        ┘ record still cannot orphan the process tree
  │    └─ out.txt          appears ONLY at completion (done signal) — the verbatim answer
  └─ spawns (detached, unref'd)
       supervisor  ← the kill target; taskkill /T /F here takes codex with it
         └─ codex exec - --cd <cwd> --sandbox <mode> --skip-git-repo-check
              --model <m> -c model_reasoning_effort=<e>
              --output-last-message out.txt --color never  < prompt.md > run.log 2>&1
```

The supervisor exists because a detached spawn cannot report an exit code: it
runs codex to completion, then writes exit code, final state, and finished
timestamp into `job.json`. After dispatch returns, the supervisor is the only
writer of `job.json` (cancel excepted), so there are no write races.

## Tests

```
node --test                            # everything: 30 tests (bare form — see below)
node --test tests/dispatch.test.mjs    # lifecycle, against a fake codex
node --test tests/packaging.test.mjs   # manifests, command frontmatter, no-hooks invariant
node --test tests/resolution.test.mjs  # binary resolution, blind scan, id whitelist (imported, not spawned)
node tests/live-smoke.mjs              # one real cheap dispatch; skips loudly if codex absent/logged out
```

**Invocation quirk:** `node --test tests/` fails on Node 24 — the directory
path is resolved as a module (`Cannot find module ...\tests`). Use the bare
`node --test` (from the repo root) or name the file. Bare discovery matches
`*.test.mjs`, so `tests/live-smoke.mjs` is never picked up by accident: the
naming, not a config file, is what keeps the real-billing smoke opt-in.

The fake codex (`tests/fake-codex.mjs`) reads stdin, spawns a child process (so
tree-kill is assertable), sleeps, then writes the out file. `FAKE_CODEX_BLIND=1`
makes it print a real blind run's tracing lines and still exit 0;
`FAKE_CODEX_ECHO=1` prints the same signature strings the way a *sighted* job
that read this repo's source does — same stream, different line shape — so the
false positive that cost the first end-to-end run has a regression test. The
suite covers: job-dir uniqueness, refuse-then-force on same-role double dispatch,
a stale job blocking a same-role dispatch, `--force` reaping a codex orphaned by
a killed supervisor, not-ready `result` behavior, whole-tree cancel, stale-pid
classification, a blind job being failed despite exit 0 and refused by `result`,
a sighted job that echoes the signatures **not** being failed, a corrupt
`job.json` leaving every other verb working, a *wrong-typed* `job.json` field
being contained the same way rather than crashing `list`/`status`/`dispatch`,
`cancel` reaping a corrupt job's pids without touching its record,
traversal-shaped ids and roles being refused, and the shipped defaults landing
in `job.json` as the budget pair while `--model`/`--effort` still override them
— the last of those is a cost guard, not a preference, so it is asserted rather
than assumed.

`tests/resolution.test.mjs` imports the runtime instead of spawning it, which is
why the runtime only calls `main()` when it is the process entry point.

Live smoke verified 2026-08-06 against codex-cli 0.146.0: preflight, dispatch
with `--model gpt-5.3-codex-spark --effort low`, poll to done, byte-verbatim
`DISPATCH-OK` result. No drift from the pinned CLI contract observed. It pins
its model explicitly rather than riding the defaults, so it keeps exercising the
override path — and keeps costing the same — whatever the defaults later become.

End-to-end verified the same day, and it is the check that matters most: a
`--role reviewer` dispatch whose brief was one line — *"Review
scripts/codex-dispatch.mjs in this repo (top 3 defects, terse, line refs, do not
fix)"* — with the file itself never inlined. It came back `done` in 26s citing
`allJobs`, `effectiveState`/`pidAlive` and `cmdQuote` with line numbers: content
the brief did not contain, so the sandbox genuinely read the repo. The same
dispatch against the desktop-app binary (via `CODEX_DISPATCH_BIN`) came back
`failed / sandbox-blind`, which is the true positive that proves the detector is
not just always saying yes.

## Known issues (found by review, accepted for now)

- **PID reuse can make a dead job read as `running`.** `pidAlive` asks the OS
  whether a pid number exists, not whether it is still *our* process — across a
  reboot or a long gap that number can belong to something unrelated, and the job
  then reads `running` (and blocks its role) instead of `stale`. A real fix needs
  the pid's start time compared against `started`; the out-file done signal covers
  the common case, so this is recorded rather than fixed.
- **Windows `shell: true` quoting is best-effort.** `codex.cmd` needs a shell, so
  `spawnCodex`/`runCodexSync` join argv into one command line with `cmdQuote`,
  which quotes and doubles `"` but does not escape what `cmd.exe` expands *after*
  quote stripping — `%VAR%` in particular, and `^` in some positions. Nothing
  reachable today goes near it (job paths are generated, and the brief is never
  inlined — invariant 1), but a `--cd`, `--model` or `--effort` value containing
  `%` or `^` could still be mangled or expanded.

## Decisions made during the build

Things the brief left open, decided here:

- **The shipped defaults are budget, not frontier** — `gpt-5.6-luna` at
  `medium`, where they were once `gpt-5.6-sol` at `xhigh`. Having *explicit,
  recorded* defaults is the structural difference from the official plugin,
  which leaves them deliberately unset; that is unchanged. What changed is the
  values, because a public repo whose defaults are the frontier pair bills
  frontier prices to anyone who clones it and dispatches once, for a decision
  they never made. Frontier is two flags away —
  `--model gpt-5.6-sol --effort xhigh` — and power users override per call.
  `medium` rather than `low` as the balanced public default: `low` is a
  smoke-test setting, and an answer too shallow to use is its own kind of waste.
  Orchestration consumers (anything dispatching on a contract — a second-opinion
  arm pinned to a particular model, say) should pass `--model`/`--effort`
  explicitly rather than inherit whatever this repo happens to ship.
  Verified live against codex-cli 0.146.0 on 2026-08-06: `gpt-5.6-luna`
  dispatched and answered verbatim in 4s, while the near-miss id `gpt-5.6-lua`
  failed the job with `Model metadata for 'gpt-5.6-lua' not found` plus a 400
  `The 'gpt-5.6-lua' model is not supported when using Codex with a ChatGPT
  account` — which is also the evidence that the CLI validates model ids rather
  than quietly accepting anything, so the accepted one is a real model.
- **`--write` maps to `--sandbox workspace-write`**, not `danger-full-access`.
  Escalating past workspace writes is out of scope for a dispatch runtime.
- **Default `--role` is `dispatch`** when none is given.
- **A `preflight` verb is exposed** (the brief only required preflight inside
  dispatch); the live smoke and humans both want it standalone.
- **`CODEX_DISPATCH_BIN` skips the version/auth/sandbox preflight.** The override
  is trusted by design — that is what makes it useful for tests and stand-ins.
  It is also the only way to deliberately dispatch on a blind binary, which is
  how the true-positive half of the detector gets tested.
- **The desktop-app build is last in the resolution order, not banned.** It is a
  perfectly good CLI for everything except the sandbox, and a machine that only
  has it deserves the preflight message rather than "codex not found".
- **The sandbox is proven with `codex sandbox <read a file>`, not a test
  dispatch.** No model, no tokens, no billing, ~300 ms, and it fails in the same
  plumbing the real jobs use. A model-call probe would have cost money to learn
  less. If the CLI has no `sandbox` subcommand, preflight warns instead of
  failing — an unprovable sandbox is not the same claim as a broken one, and the
  run.log scan still backstops it.
- **A broken sandbox is fatal on Windows, a warning elsewhere.** Windows is where
  the failure was observed and where the probe is verified; failing a Linux user's
  dispatch on an unverified probe would be inventing a defect.
- **Blind detection matches line shape, not substrings.** The signatures alone
  appear in this repo's own source, in the model's prose when it is blind, and in
  this README — the first end-to-end run was failed by its own success. Requiring
  codex's tracing prefix (`<rfc3339>Z ERROR codex_core::…:`) is what separates a
  diagnostic from a quotation. A job that reviews a file containing real codex
  error logs can still fool it; that is the accepted residual.
- **A blind job keeps its out file.** `result` refuses to print it and says why,
  but nothing deletes or rewrites it — verbatim transport means the bytes stay
  available even when the runtime's judgement is that they are worthless.
- **Corrupt records are contained, not repaired.** `readRecord` returns a marker
  instead of throwing, so one bad `job.json` cannot brick `list`/`status`/
  `dispatch`; `cancel` still reaps pids from the pid files but leaves the corrupt
  file byte-for-byte, because a record that got corrupted once is evidence. The
  consequence is deliberate: such a job reads `corrupt` forever.
- **A wrong-typed field is corrupt, not coerced.** Validation could have coerced
  (`String(started)`) or defaulted, but a record whose `started` is a number was
  not written by this runtime, so nothing about it can be trusted enough to
  repair — which is precisely what the corrupt marker already means, and every
  verb already handles. So: a field present with the wrong type ⇒ corrupt, named.
  Absence is the other half of the choice, and it splits: `state` and `started`
  are required (there is no state machine without them), while the rest are
  tolerated when missing, because the verbs already treat them as unset and
  hand-written fixtures legitimately carry only part of the record.
- **Job ids are whitelisted rather than sanitized**, and roles are restricted to
  `^[a-z]+$` so that a generated id always satisfies the whitelist it will be
  checked against later. That is why the live smoke's role is `smoke` and no
  longer `live-smoke`, and why the collision suffix grows the pid digits instead
  of adding a fourth segment.
- **The runtime calls `main()` only when it is the entry point**, so tests can
  import its pure helpers. The check is case-insensitive on Windows: a
  differently-cased path must never silently turn the CLI into a no-op.
- **`dispatch` prints a `bin:` line.** Which codex a job runs on is exactly the
  thing that went wrong in production; it belongs in the handle, not in a log.
- **The supervisor records its own pid** (plus codex's) into `job.json` after
  spawn, rather than dispatch writing the child pid — this keeps a single
  writer after dispatch returns. Stale detection has a 15-second grace period
  for the moment before the supervisor has registered itself.
- **`out.txt` existence overrides `job.json` state**: if the supervisor died
  after codex finished but before finalizing the record, the job still reads as
  done — the out file is the authoritative done signal.
- **Effort is passed as `-c model_reasoning_effort=<effort>`** (no embedded
  quotes): that is the argv the verified production contract actually delivered
  after shell quote-stripping.
- **`result` prints the answer to stdout only; all diagnostics go to stderr**,
  so stdout is pipe-safe verbatim bytes.
- **Non-Windows fallback** kills the supervisor and codex pids directly (no
  process-tree walk). Windows (`taskkill /T /F`) is the tested, first-class path.
- **Jobs root on non-Windows** falls back to `~/.local/share/codex-dispatch/jobs`.
- **Live smoke tolerates a trailing newline** when comparing `DISPATCH-OK` —
  the transported bytes are still untouched; only the assertion trims.
- **No `package.json`**: zero dependencies and no build step; tests run by path.
- **A `marketplace.json` is included** so a local clone is directly installable
  with `/plugin marketplace add <path>`.
- **The plugin lives at the repo root, not under `plugins/<name>/`.** The
  official OpenAI plugin nests its plugin one level down because its marketplace
  is built to carry several; the loader does not require it. Community
  single-plugin marketplaces such as `i-have-adhd` and `ponytail` use exactly
  this repo's shape — `.claude-plugin/{marketplace,plugin}.json` at the root,
  `"source": "./"` — and install from GitHub. Root layout also keeps
  `node scripts/codex-dispatch.mjs` working from the repo root, which the bare
  runtime documents.
- **`marketplace.json` carries both a top-level `description` and
  `metadata.description`.** Anthropic's own marketplace and the community ones
  surveyed use the top-level field; the OpenAI plugin uses `metadata`.
  Populating both costs a duplicated line and removes the guess.
- **`tests/packaging.test.mjs` asserts the manifests rather than trusting
  them** — version identical in the three places that carry it, `source: "./"`
  resolving to a real `plugin.json`, required frontmatter on all five commands
  and the skill, and no `hooks/` directory. A broken manifest makes the plugin
  silently uninstallable, and no other test in this repo would notice.
- **`supervisor.log` and (in tests) `child.pid` live in the job dir** alongside
  the three brief-mandated files; extra diagnostics, same lifecycle.

## Contributing

Zero runtime dependencies and no build step: clone it and run `node --test`.
Every constraint in the runtime traces to an entry in the failure catalog above
— if a change relaxes one, say which failure it is no longer guarding against.

## License

MIT — see [LICENSE](LICENSE).

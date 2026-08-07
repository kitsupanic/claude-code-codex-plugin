# Decisions made during the build

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
  less. If the CLI has no `sandbox` subcommand the claim is `unproven` rather than
  broken — the two are genuinely different diagnoses, which is why the record and
  the messages still distinguish them. What is *not* different is what they buy:
  neither one is deliverable.
- **Sight is proven per job, in the job's cwd, by the supervisor — REPLACING the
  post-hoc signature scan as the verdict.** Preflight's probe runs wherever the
  launcher happens to be, which is not where the job runs; and inference from log
  signatures is negative evidence twice over — blind to error shapes it has not
  met (false negative, silently) and fooled by failures codex recovered from
  (false positive). A positive proof has neither failure mode: the bytes come back
  or the job does not run. The scan is kept as a `warning:`, because "something in
  the sandbox complained" is worth saying and is not worth overruling a proof
  with.
- **The precheck never writes into the job's cwd.** It reads a file that is
  already there. A `--cd` can be read-only, or precious, or under review; a
  runtime that drops scratch files into it is one nobody points at anything that
  matters. The nonce fallback writes into the *job* dir instead — and it is kept,
  even though it no longer proves sight, because it is what separates "the sandbox
  is broken" from "the cwd had nothing to read". Those are different problems with
  different cures, and the refusal message names the right one.
- **REVOKED: an unprovable sandbox used to deliver with a warning.** "Refusing
  every job on a CLI too old to have the subcommand would be inventing a defect"
  was the reasoning, and it is a good instinct pointed at the wrong risk. The
  defect being invented is a refusal the operator can see and fix in one command;
  the defect being tolerated is a sourceless answer that looks exactly like a
  sourced one. Politeness was the hole: a caveat on stderr is not a refusal, and
  the entire value of a second opinion is that something vouched for it. So sight
  is now a **deliverability gate**, not a label — `unproven` is refused — and
  `--allow-unproven-sight` moves the decision to the caller, where it can be made
  knowingly and is written into the record for whoever reads the answer later.
  The escape hatch is deliberately not a config setting or an environment
  variable: it is per-dispatch, so it cannot be turned on once and forgotten.
- **`EPERM` means alive, not dead.** The liveness probe treated every exception
  from `process.kill(pid, 0)` as "the process is gone", which inverts the single
  case where the answer matters most: `EPERM` (and Windows' access-denied, which
  surfaces the same way) is raised precisely when the process EXISTS and this
  account may not signal it — elevated, another user's, protected. That is exactly
  the shape a kill that did not take leaves behind, and reading it as death
  reported such a kill as verified, which is how a still-billing codex gets
  declared dead. Only `ESRCH` counts as death now; everything else counts as
  alive. The asymmetry is the point: guessing "alive" costs a refused dispatch,
  guessing "dead" costs two codex processes.
- **A claim is renamed into place, and re-verified before it is used.** `mkdir`
  alone won the race but left a fence to fall off between winning and recording
  the owner. The claim is now assembled complete elsewhere and moved in with one
  rename, reclaiming renames the whole lock directory away (atomically, so two
  reclaimers cannot both win), and a dispatch re-reads the owner immediately
  before spawning its supervisor. Everything before that read is reversible; a
  spawned supervisor is not, so that is where the check belongs.
- **A reclaim from an unvouched-for owner kills first.** A corrupt record was
  treated as permission to take the role, on the reasoning that a record which
  cannot be read cannot claim to be running. True — and it cannot claim not to be,
  either. Silence is not death, so the corrupt-owner path now reaps that job's pid
  files, verifies the deaths, and refuses the takeover if anything survives:
  the same discipline stale claims already got, for the same reason.
- **A failed pid-file rename is reported, and the numbers are written down.**
  Consuming a spent pid file has two halves, and only the visible one could fail.
  It failed silently, which is worse than failing loudly: the numbers stayed
  loaded *and* the operator had been told they were unloaded. Now the rename
  failure is a `warning:` on the record and a line on stderr, and the pids are
  recorded as reaped in `job.json` (`reapedPids`) plus a `reaped.pids` sidecar for
  the jobs whose record is evidence and must not be rewritten. The list is what
  the next reap consults, so a surviving pid file cannot resurrect a spent number.
  Consumption happens only after a *verified* kill: pids that survived are
  demonstrably still theirs, and still need firing at.
- **The finished banner states the terminal state, and only `done` is good news.**
  It announced `JOB FINISHED - result is ready` for every state, including jobs
  whose answer `result` was about to refuse — the same class of defect as every
  other one here, a claim made rather than a fact checked, and in the one place
  built to be believed from across the room. Alongside it: a corrupt read is
  re-read before it is believed (records are replaced by rename, and a reader can
  land in the gap), log bytes are stripped of terminal control characters before
  they reach a console (`run.log` is untrusted — it carries whatever codex echoed,
  and an escape sequence can rewrite the banner it sits above), and the window
  spawn is verified rather than assumed.
- **A failed precheck is fatal on every platform**, unlike preflight's broken-sandbox
  verdict, which stays fatal only on Windows. The two are different claims: the
  preflight probe is a general capability check on a platform where it has been
  verified, while the precheck is a direct, positive, per-job measurement — if the
  bytes of a file in this cwd do not come back, this job cannot see, and that is
  not a platform-specific conclusion.
- **Blind detection matches line shape, not substrings.** The signatures alone
  appear in this repo's own source, in the model's prose when it is blind, and in
  this repo's docs — the first end-to-end run was failed by its own success. Requiring
  codex's tracing prefix (`<rfc3339>Z ERROR codex_core::…:`) is what separates a
  diagnostic from a quotation. A job that reviews a file containing real codex
  error logs can still fool it; now that this is a warning rather than a verdict,
  the residual costs a spurious line of stderr instead of a refused answer.
- **A blind job keeps its out file.** `result` refuses to print it and says why,
  but nothing deletes or rewrites it — verbatim transport means the bytes stay
  available even when the runtime's judgement is that they are worthless. (A job
  failed by the *precheck* has no out file to keep: it never ran.)
- **Kills are verified, and an unverified kill is `kill-failed`, not `killed`.**
  `taskkill`'s result was previously discarded, which meant "killed" was a claim
  the runtime made about an action rather than a fact it had checked — and the
  whole point of the kill is that a surviving codex keeps billing. So every
  targeted pid is re-checked afterwards, survivors are recorded and printed, the
  role stays claimed, and `--force` refuses to launch beside them. Erring toward
  refusing is deliberate: the failure this runtime exists to prevent is two codex
  processes at once, not one dispatch too few.
- **The same-role guard is an atomic claim, not a scan.** Scan-then-create is a
  read followed by a write with a gap in between; two dispatches launched together
  both read an empty world and both proceed. `mkdir` is the one filesystem
  operation where exactly one racer can win, so the role is claimed by creating
  `<jobs-root>/.role-locks/<role>/` and EEXIST is the answer. The claim is taken
  before the job dir so a loser leaves nothing behind; it is released on terminal
  states by its owner only; a claim under 15 seconds old with no readable owner
  record is treated as a dispatch mid-claim and refused rather than stolen.
- **Consumed pid files are renamed, not deleted or left in place.** A corrupt job
  cannot be marked `killed` — its record is evidence and stays byte-for-byte — so
  nothing else would stop a second `cancel` from firing the same pid numbers at
  whatever has since inherited them. Renaming to `<name>.pid.reaped-<timestamp>`
  makes the reap non-repeatable while keeping it visible: the second cancel reports
  `already reaped` and touches nothing. Renaming rather than deleting because the
  numbers are part of the incident record.
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
- **REVOKED: the supervisor used to record its own pid.** The reasoning was single
  writership — dispatch writes, then the supervisor owns the record — and it was
  right about writers and wrong about time. Between the spawn and that write the
  record said `running` with nothing recorded to kill, and a `cancel` landing there
  killed nothing, called the empty kill verified, marked the job `killed` and
  released the role, while the supervisor went on to launch codex and a second
  same-role dispatch became legal beside it. Two billing codexes, out of the code
  path built to prevent exactly that. The child's pid is knowable in the parent the
  moment `spawn` returns, so **dispatch records it before it returns**, and the
  supervisor writes it only if it finds a record that does not already name it —
  single writership preserved, window gone. The 15-second grace survives for
  records this release did not write.
- **The launch phase is written down rather than inferred.** "No supervisor pid"
  meant two opposite things: a dispatch that has not spawned anything (safe — its
  claim fence stops it launching if the role moves) and a supervisor that was
  spawned and has not registered (dangerous). `launch: 'pending' | 'spawning' |
  'spawned'` makes it a recorded fact. A kill with no target inside the dangerous
  phase yields `kill-pending`, not `killed`; in the safe phase, killing nothing IS
  the whole kill and the runtime says so honestly.
- **The supervisor re-checks its record and its claim immediately before exec.**
  Sight-proving takes a moment, and a cancel or a takeover can land in it. So the
  last thing before the spend is a re-read: the record must still say `running`
  (a `kill-pending` one is honoured — the supervisor marks it `killed` and releases
  the role, which is the cancel finally landing) and the role claim must still name
  this job (`claim-lost` otherwise, without releasing a claim that is somebody
  else's). Same principle as the dispatch-side fence, at the other end of the same
  gap: check where the irreversible thing happens.
- **Deliverability is versioned, and unstamped means unvouched.** Gating `result`
  on `state === 'done'` alone meant that installing this runtime over 0.1/0.2 job
  dirs delivered their answers immediately, under a gate those records were never
  written against — and a 0.2 record whose sight said `unproven` even collected the
  "the caller opted in" caveat, a consent claim inferred from a word in a string.
  So the record now carries `recordVersion`, written by the dispatch that ran the
  job, and delivery requires positive evidence: the stamp, a zero exit, and either
  proven sight or the `allowUnprovenSight` boolean that same dispatch wrote. The
  cost is real and accepted — **old jobs stop being deliverable when you upgrade** —
  and it is the right cost: the alternative is handing over answers whose provenance
  this release cannot speak to. The bytes are never hidden; the refusal names the
  reason and the `out:` path.
- **Untrusted strings are whitelisted at the READ boundary, and derived paths are
  proved inside the jobs root.** Both halves, because they fail differently. The
  whitelist is what makes the promise in "Corrupt records and job ids" true — the
  value never reaches a caller in a form that could be joined. The containment
  assert is what survives the whitelist being loosened one day by someone who does
  not know why it is narrow. A violation is a loud refusal plus a corrupt
  classification (`inspectClaim` → corrupt claim; `validateRecord` → corrupt
  record), never a best-effort attempt to do something sensible with it: a claim
  owner that is not a job id says nothing about what is running, and acting on that
  silence is what killed an unrelated process in review.
- **Control bytes are stripped at the write boundary AND at every print boundary.**
  Either alone leaves a route. Stripping only on the way out means a control byte
  lives in the record and every future reader must remember; stripping only on the
  way in leaves records written by older releases, or by hand, untouched. The write
  boundary is `writeRecord` (every string field), the print boundaries are `status`,
  `list`, `result`'s stderr, the watcher's banner and the refusal messages. The
  banner is the reason: it is the one line here meant to be believed from across
  the room, and an escape sequence in a `sight:` field could redraw it.
- **The sight token is content from inside the file, matched on stdout.** See
  [DESIGN.md → "Proving sight, per job"](DESIGN.md#proving-sight-per-job) for the rules. The principle behind them: a proof must require
  something the prover could not have been *handed*. The first line of a file, and
  its name, are both things a tool that never opened it can produce — so neither can
  be the evidence.
- **REVOKED: `out.txt` existence used to override `job.json` state.** The original
  rule said that if the supervisor died after codex finished but before finalizing
  the record, the job should still read `done`, because the out file was the
  authoritative done signal. That is wrong in a way the acceptance run could not
  see: the answer file appears the moment codex writes it, which is *before* the
  exit code is recorded and *before* any sight verdict is reached — so there is a
  real window in which a job reads `done`, and `result` hands over bytes, while
  nothing has yet vouched for how the run ended. The delivery decision now belongs
  to the record alone: `done` requires the record to say `done` (exit code
  recorded, sight resolved), `status` never promotes on file existence, and
  `result` refuses `failed`/`killed`/`kill-failed`/`stale`/`corrupt` even when the
  file is sitting right there. What is lost is a convenience — an unfinalized run
  now reads `stale` instead of `done` — and what is bought is that every answer
  this runtime prints has a record behind it. The bytes are never hidden: the
  refusal names the state and prints the `out:` path, so a human who wants to read
  an unvouched-for answer can, deliberately, by hand.
- **The `watch` verb spawns a window; it does not tail in-process.** A tail that
  blocks the caller is useless to the two things that actually need it — a slash
  command, and a human who wants to keep working — and a tail that ends silently
  is how a finished job goes unnoticed. So `watch` returns immediately and the
  following happens in a detached console titled with the job id, which ends on a
  banner rather than on nothing. Windows-only in this release, and it says so
  elsewhere rather than pretending: a fake window is worse than no window.
- **Effort is passed as `-c model_reasoning_effort=<effort>`** (no embedded
  quotes): that is the argv the verified production contract actually delivered
  after shell quote-stripping.
- **`result` prints the answer to stdout only; all diagnostics go to stderr**,
  so stdout is pipe-safe verbatim bytes.
- **REVISED: the non-Windows fallback kills the process GROUP, not two pids.** It
  used to signal the supervisor and codex pids directly and call that a tree kill,
  which it never was — codex's own sandbox children are its descendants, not ours,
  and they outlived every cancel off Windows. The supervisor and codex are now
  spawned detached there, making each a group leader, and the kill signals
  `-pgid` before the bare pid. Windows (`taskkill /T /F`) remains the tested,
  first-class path; `killPlan` states both choices as data so the decision is
  asserted on either platform.
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
  resolving to a real `plugin.json`, required frontmatter on all six commands
  and the skill, and no `hooks/` directory. A broken manifest makes the plugin
  silently uninstallable, and no other test in this repo would notice.
- **`supervisor.log` and (in tests) `child.pid` live in the job dir** alongside
  the three brief-mandated files; extra diagnostics, same lifecycle.
- **A behavior-changing push bumps the version.** Not a convention — a delivery
  mechanism. `marketplace update` installs nothing until the number moves, so an
  unbumped push is a fix that exists only in the repo. See "Releases and
  versioning" in the README; the packaging test keeps the three copies of the number honest,
  which is what makes the rule cheap to follow.

- **ONE validator, and it validates meaning.** Both frontier arms of round three
  arrived at the same prescription independently, which is the strongest signal
  this repo has produced: not a list of patches, but a missing organizing piece.
  The specific findings then stop being separate — an unknown state, an
  out-of-domain pid, a `sight` that is a prefix rather than a proof, and a stamp
  from another release are all the same defect, which is *a field being read
  instead of judged*. Putting the judgement in one place is also what makes "fail
  closed" checkable: there is a table of what each field's out-of-domain value
  becomes, and a test per row.
- **Unknown is a live state, not a terminal one.** The instinct is to treat an
  unrecognised state as "not running, therefore finished", and that instinct is
  backwards: what the runtime actually knows is *nothing*, and the only safe thing
  to assume about a job you know nothing about is that it is still going. Guessing
  live costs a refused dispatch; guessing finished costs two codexes.
- **`stale`, `corrupt` and `unknown` are derived, never written.** They are
  conclusions this runtime reaches about a record, so a record claiming one is
  claiming a conclusion it is not entitled to. Keeping them out of `KNOWN_STATES`
  makes that structural rather than conventional.
- **A cancel in the codex-exec window kills nothing.** The tempting fix is to kill
  the supervisor and verify the tree, and it very nearly works: on Windows
  `taskkill /T` really does take a just-spawned codex with it. It is still wrong,
  for two reasons. A process table is a snapshot, so "no descendants right now" does
  not cover a `CreateProcess` already in flight; and off Windows codex is detached
  into its own group, so once the supervisor dies the orphan is not a descendant of
  anything we recorded. The supervisor is the only party that will ever hold that
  pid — so the cancel waits for it rather than destroying the one thing that can
  land it.
- **A lock, not a compare-and-swap retry loop.** Detecting a lost update after the
  fact and retrying still has a window where two writers each believe they won;
  `mkdir` does not. It is the same primitive the role claim already uses, which
  means one concurrency idea in the runtime rather than two. The generation counter
  rides along so a precondition can be expressed and so a lost write would be
  *visible* if the lock ever failed to hold.
- **A write that lost its lock is reported, not swallowed.** Found while building
  the lock: `killJob` ignored the return of the record update, so a `cancel` could
  kill everything, fail to write it down, and print `killed:` anyway. That is the
  same defect as every other one in this catalog — an action reported instead of a
  fact — introduced by the fix for a different one. The processes really are dead;
  the record still says otherwise, so the job keeps blocking its role (the safe
  direction) and the caller is told to re-run.
- **A probe that could not be RUN is not a probe that found blindness.** The
  distinction sounds pedantic until you notice what each verdict tells the operator
  to do: `sandbox-blind-precheck` says reinstall codex, and for a Windows pipe
  teardown that is advice about the wrong thing entirely. Under a fail-closed gate
  the cost is real — a good job refused, with the wrong cure printed — so
  `sight-probe-error` is its own outcome, with a bounded retry in front of it,
  because a genuine spawn failure repeats and a flake does not. It sits in the
  UNPROVEN class rather than the BROKEN one, which is what makes
  `--allow-unproven-sight` the right escape hatch for it: nothing was disproven,
  nothing was asked. **The distinction applies at every entrance to the probe, not
  just inside it.** It was made where the spawn happens and skipped at the two
  outer edges, which both still answered `broken`: a job cwd that does not exist,
  and any exception thrown by the probe wrapper (`cmdQuote` refusing an unquotable
  `CODEX_DISPATCH_BIN`, a directory that will not list). Both are probes that could
  not be POSED — codex was never asked anything — and both printed "reinstall
  codex" at an operator whose real fault was a typo. A missing `--cd` is now also
  refused by `dispatch` itself, before a role is claimed or a supervisor spawned:
  the cheapest place to say it is where it was typed.
- **`stdin` is NUL on every synchronous spawn.** `spawnSync`'s default hands the
  child a pipe and closes the write end immediately, and a grandchild that inherits
  the handle — `cmd /c type` does — can fail its launch with ERROR_NO_DATA. Nothing
  this runtime spawns synchronously reads stdin, so there was never a reason to give
  it one. `windowsHide` alongside it: a probe running under a detached supervisor
  must not put a console window on somebody's screen.
- **The suite grew a `.cmd` fake because CI was structurally blind.** Every test
  pointed `CODEX_DISPATCH_BIN` at a `.mjs`, so the `shell: true` branch — the one
  the supported Windows install takes — never executed in a single test, and the
  wrapper-pid defect lived under full coverage. A test suite that cannot reach a
  code path is not evidence about that code path, and the cheapest fix was eight
  lines of batch file.


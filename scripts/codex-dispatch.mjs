#!/usr/bin/env node
// codex-dispatch — background job runtime for verbatim Codex CLI dispatches.
// Node 18+, zero npm dependencies, Windows-first.
//
// Verbs: dispatch, status, result, cancel, list, clean, watch, preflight,
//        _supervise / _watch (internal)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const WIN = process.platform === 'win32';
// Defaults are pinned and recorded, but deliberately NOT the frontier pair. A
// fresh install must not be able to bill frontier prices by accident, so what
// ships is the budget model at medium effort; frontier is two explicit flags
// away (`--model gpt-5.6-sol --effort xhigh`). Orchestration consumers should
// pass their own model/effort per call rather than inherit whatever ships here.
// `gpt-5.6-luna` verified live against codex-cli 0.146.0 on 2026-08-06.
const DEFAULT_MODEL = 'gpt-5.6-luna';
const DEFAULT_EFFORT = 'medium';

// How long a just-created thing is allowed to be incomplete before it is judged:
// a supervisor that has not yet registered its pid, a role claim whose owner job
// has not yet written its record.
const CLAIM_GRACE_MS = 15000;
// How long a verified kill waits for the OS to actually reap what it signalled.
const KILL_VERIFY_MS = 3000;
// How long `watch` waits for its launcher to prove it did not fall over, before
// it is allowed to announce that a window was opened.
const WATCH_SPAWN_GRACE_MS = 500;
// job.json is replaced by rename, so a reader can catch the instant in between
// and see nothing at all. The watcher re-reads before believing a record is
// corrupt: a transient read is not a reason to stop watching a live job.
const CORRUPT_CONFIRM_TRIES = 5;
const CORRUPT_CONFIRM_MS = 200;

// Job ids are the only strings that ever become a path segment from user input.
// Whitelist, never sanitize: anything outside this shape is refused, loudly.
export const JOB_ID_RE = /^[a-z]+-\d+-\d+$/;
export const ROLE_RE = /^[a-z]+$/;

// The record schema stamp. Deliverability is a VERSIONED invariant: a record
// written before this stamp existed (0.1–0.3) was written under a different
// delivery gate, so nothing in it may be read as proof or as consent. Bump this
// when the meaning of a field the gate reads changes.
//
// 2 (0.5.0): the gate stopped reading fields and started VALIDATING them — a
// `sight` that merely begins with the proof prefix is no longer proof, a state
// outside the known set is live-and-unvouched rather than terminal, and a pid
// field outside the pid domain is corruption. A record written under version 1
// was written by a runtime that did none of that, so it cannot be evidence that
// this gate was met.
export const RECORD_VERSION = 2;

// The only `sight` value that is proof, and the only one that is a recorded
// opt-in. Both are compared exactly; neither is ever inferred from prose.
export const PROVEN_SIGHT_PREFIX = 'cwd-file:';
export const ACCEPTED_SIGHT = 'unproven (accepted by caller)';

// ------------------------------------------------- the semantic domains
//
// THE VALIDATOR IS THE SPINE (dual review round three, 2026-08-06). Every
// ownership, kill and delivery decision reads the record through the functions
// below, and every one of them FAILS CLOSED: a value outside its domain is
// resolved to the reading that costs a refused dispatch, never to the one that
// costs a second billing codex or an unvouched-for answer.
//
// The states this runtime writes. A record carrying anything else was not
// written by this runtime, and the safe reading of "I do not recognise this
// state" is NOT "therefore it is not running" — it is "therefore I know nothing
// about what it owns", which is `unknown`: live, role-blocking, undeliverable.
export const KNOWN_STATES = ['running', 'done', 'failed', 'killed', 'kill-pending', 'kill-failed'];

// The launch phases, in the order a job passes through them. `spawning` and
// `exec-spawning` are the two windows in which something was launched and has
// not been registered — the phases in which "nothing to kill" must never be read
// as "nothing is alive".
export const KNOWN_LAUNCH_PHASES = ['pending', 'spawning', 'spawned', 'exec-spawning', 'exec'];
// An unrecognised phase resolves to the most dangerous one: codex may be running
// and unregistered.
export const MOST_DANGEROUS_PHASE = 'exec-spawning';

// A pid is a positive integer in a domain an OS could actually have issued.
// `supervisorPid: -1` used to reach killPlan(-1), which off Windows signals the
// process GROUP -1 — every process the user may signal — and then pid 1. A
// machine-wide kill out of one corrupt record. (Codex arm, round three.)
export const PID_MIN = 1;
export const PID_MAX = 0xffffffff;
export const isPid = (n) => Number.isSafeInteger(n) && n >= PID_MIN && n <= PID_MAX;

// The reasons this runtime writes onto a record. `list` prints `state(reason)`,
// so this is the source of truth commands/list.md documents and the packaging
// test checks the source against.
export const JOB_REASONS = [
  'sandbox-blind-precheck',
  'sight-unproven',
  'sight-probe-error',
  'supervisor-spawn-failed',
  'codex-spawn-failed',
  'codex-argv-refused',
  'claim-lost',
  'cancelled-during-registration',
  'cancelled-during-exec',
  'record-version-mismatch',
  'dispatch-failed',
];

// States in which a job may still own live processes. These block their role,
// are cancellable, and are what `--force` has to kill (and verify) first.
// `kill-pending` is one of them: a cancel that arrived before the job had a kill
// target killed nothing, so nothing may treat it as dead. `unknown` is one of
// them for the same reason at one remove: a state this release cannot name is a
// state it cannot reason about, and the only safe thing to assume about a job
// you cannot reason about is that it is still going.
export const LIVE_STATES = ['running', 'kill-pending', 'stale', 'kill-failed', 'unknown'];

// The states a `cancel` writes — the only ones a dispatch may read, in the
// instant after it spawned its supervisor, as "this job was cancelled while it
// was starting". Every other non-running state visible there was written by the
// SUPERVISOR, about a run it has already judged, and a verdict this process did
// not reach is not this process's to overwrite. See the post-spawn check in
// `cmdDispatch` for what overwriting one cost.
export const CANCEL_STATES = ['kill-pending', 'killed', 'kill-failed'];

// The terminal states in which the supervisor may release its role claim: the
// job is genuinely over and nothing it owned is alive, so unblocking the role is
// safe. `kill-failed` is deliberately absent — a cancel killed codex and this
// supervisor SURVIVED it, and such a job keeps its claim and keeps blocking
// dispatch (see DESIGN.md, "Kills are verified"). So is `kill-pending`, which is
// a cancel nothing has landed yet, and so is every unreadable record: silence is
// not death here either.
export const ROLE_RELEASE_STATES = ['done', 'failed', 'killed'];

// run.log, job.json and a codex probe's error text are all UNTRUSTED text: they
// carry whatever codex printed, including file contents and tool output it
// echoed. A terminal control sequence in there can retitle a window, erase the
// screen, or drive the cursor back over the finished banner and rewrite it — and
// the banner is the one thing in this runtime that has to be true from across the
// room. So the C0 controls go, along with the C1 range some terminals still act
// on. Kept: tab, newline and carriage return — the log's own formatting.
// Written as a scan rather than a regex literal so this source file never has to
// carry a control byte of its own.
export function stripControlBytes(text) {
  const s = String(text);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) { out += s[i]; continue; }
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) continue;
    out += s[i];
  }
  return out;
}

// Every record- or filesystem-derived string that reaches a console goes through
// this. Stripping happens at BOTH boundaries — write (below) and print — because
// either alone leaves a route: a record written by an older release, or by hand,
// has never been through the write boundary.
const clean = (v) => stripControlBytes(v ?? '');

// ---------------------------------------------------- paths from untrusted text
//
// Two strings here come from files anything can write — a role claim's `owner`,
// and a record's `role`/`id` — and both used to be joined into a path that was
// then read, renamed, deleted or killed through. (Dual review 2026-08-06: both
// arms found this class, through different doors.) Two rules, applied together:
//
//   1. VALIDATE AT THE READ BOUNDARY. A value that will become a path segment is
//      matched against its whitelist by the function that reads it, so an invalid
//      one never reaches a caller as a usable string — it arrives classified as
//      corrupt, and the caller refuses.
//   2. ASSERT CONTAINMENT AT THE USE BOUNDARY. Every absolute path derived from
//      such a value is resolved and proved to live INSIDE the jobs root before
//      anything reads, renames, removes or kills through it.
//
// Neither replaces the other: (1) is what the README promises, (2) is what still
// holds if a whitelist is ever loosened.

export function isInsideRoot(root, target) {
  const from = path.resolve(root);
  const to = path.resolve(target);
  const rel = path.relative(from, to);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// LEXICAL CONTAINMENT IS NOT CONTAINMENT. `path.resolve` collapses `..`; it knows
// nothing about reparse points, so a directory junction (or a symlink) named
// `review-1-2` inside the jobs root passes every check above and then directs
// every read, rename, removal and kill at wherever it points. Windows junctions
// need no elevation to create. (Codex arm, round three.)
//
// So containment is proved against the REAL path: resolve the deepest ancestor
// that exists — the target itself may be about to be created — and require the
// resolved target to still be inside the resolved root.
function realpathDeep(p) {
  let cur = path.resolve(p);
  const tail = [];
  for (;;) {
    try {
      const real = (fs.realpathSync.native || fs.realpathSync)(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch { /* does not exist (yet): try the parent */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(p);
    tail.push(path.basename(cur));
    cur = parent;
  }
}

export function isInsideRootReal(root, target) {
  if (!isInsideRoot(root, target)) return false;
  return isInsideRoot(realpathDeep(root), realpathDeep(target));
}

// A directory entry that is a link of any kind is not a job directory, whatever
// it is named. Checked separately from the containment above because a junction
// whose target happens to be inside the jobs root is still not something this
// runtime created, and treating it as a job is how a rename lands somewhere else.
function isRealDirectory(p) {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

// The job directory for an id — or null when the id is not one this runtime could
// have generated, or when joining it would leave the jobs root.
export function jobDirFor(root, id) {
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) return null;
  const dir = path.join(root, id);
  return isInsideRootReal(root, dir) ? dir : null;
}

// Loud refusal, never best-effort: a path that cannot be PROVED to be inside the
// jobs root is not operated on at all.
function assertInsideRoot(root, target, action) {
  if (isInsideRootReal(root, target)) return target;
  fail(
    `REFUSING to ${action}: ${JSON.stringify(String(clean(target)))}\n` +
    `That path is outside the jobs root (${path.resolve(root)}) — lexically, or once its\n` +
    `reparse points are resolved (a junction or symlink is not containment).\n` +
    `Something wrote a job id, role or claim owner this runtime would never generate. Nothing has\n` +
    `been read, renamed, removed or killed.`
  );
  return null; // unreachable: fail() exits
}

// RESOLVED, never taken verbatim. The override is user-facing — the README names
// it as the cure for a `%` in the default root — so a RELATIVE value is a
// realistic thing to be handed, and an unresolved one makes the jobs root, every
// job directory, every `out:` path printed and every containment check depend on
// the directory each verb happened to be run from. A dispatch and the `result`
// that collects it would then be reading two different roots, and each would
// truthfully report that the other's job does not exist.
//
// Exported for the unit tests: an absolute root is not observable from outside
// except by reading it back.
export function jobsRoot() {
  if (process.env.CODEX_DISPATCH_JOBS) return path.resolve(process.env.CODEX_DISPATCH_JOBS);
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'codex-dispatch', 'jobs');
}

// THE JOBS ROOT LANDS ON THE CMD.EXE COMMAND LINE TOO. Every job is launched
// with `--output-last-message <jobs-root>\<id>\out.txt`, so the root is subject
// to exactly the same refusal `--model`, `--effort` and `--cd` are — and it was
// the one value nothing checked. `%` and `!` are legal in a Windows user name,
// so a default root under `C:\Users\o!livia\AppData\Local\...` passed preflight,
// passed the sight probe, claimed a role, spawned a supervisor, and only then
// failed the job as `codex-argv-refused` — every job, for ever, with the fault
// named nowhere near where it could be fixed. Checked where it is READ instead:
// once in preflight, and once at dispatch before anything is claimed.
function assertJobsRootQuotable(root) {
  if (!WIN || !CMD_UNSAFE.test(root)) return root;
  fail(
    `jobs root ${JSON.stringify(clean(root))} contains one of % ! " — cmd.exe expands or re-parses\n` +
    `these after quote stripping, and the jobs root goes onto codex's command line as\n` +
    `--output-last-message <jobs-root>\\<job-id>\\out.txt. No escaping on a command line reaches\n` +
    `them, so it is refused here rather than mangled later: every job under this root would fail\n` +
    `as codex-argv-refused after claiming a role and spawning a supervisor.\n` +
    `Cure: point CODEX_DISPATCH_JOBS at a directory whose path has none of them, e.g.\n` +
    `  set CODEX_DISPATCH_JOBS=C:\\codex-dispatch\\jobs\n` +
    `(The default is %LOCALAPPDATA%\\codex-dispatch\\jobs, which carries your user name.)`
  );
  return null; // unreachable: fail() exits
}

const outPath = (dir) => path.join(dir, 'out.txt');
const recordPath = (dir) => path.join(dir, 'job.json');
const runLogPath = (dir) => path.join(dir, 'run.log');

// Parsing to an object is not enough: every verb reads these fields and assumes
// a type. `allJobs` sorts on `started.localeCompare`, `effectiveState` compares
// `state`, the supervisor hands `model`/`effort`/`sandbox`/`cwd`/`bin` straight
// to spawn. job.json is a plain file that anything can write, so a field of the
// wrong type is exactly as untrustworthy as an unparseable one — and the corrupt
// marker is the shape this runtime already has for that. Hence: a field present
// with the wrong type is corrupt. Absence is tolerated (the verbs already treat
// the optional ones as unset) except for `state` and `started`, without which
// there is no state machine to run.
const STRING_FIELDS = [
  'id', 'role', 'state', 'model', 'effort', 'sandbox', 'cwd', 'bin',
  'started', 'finished', 'reason', 'blindSignature', 'warning', 'sight',
  'killSurvivors', 'launch',
];
const NUMBER_FIELDS = [
  'supervisorPid', 'codexPid', 'codexPgid', 'exitCode', 'recordVersion', 'generation',
];
const BOOLEAN_FIELDS = ['allowUnprovenSight'];
const NUMBER_ARRAY_FIELDS = ['reapedPids', 'codexPids'];
const REQUIRED_FIELDS = ['state', 'started'];

// Fields whose numbers become KILL TARGETS. Being a number was never enough:
// `supervisorPid: -1` is a finite number, and `killPlan(-1)` off Windows signals
// process group -1 — which is every process this account may signal — and then
// pid 1. Whole-machine kill, from one corrupt record.
const PID_NUMBER_FIELDS = ['supervisorPid', 'codexPid', 'codexPgid'];
const PID_ARRAY_FIELDS = ['reapedPids', 'codexPids'];
// Counters, which may be zero but never negative or fractional.
const COUNTER_FIELDS = ['recordVersion', 'generation'];

// pid -> the OS's start time for the process that number MEANT when it was
// written down (see the pid-identity note below `pidAlive`). One map for the
// whole job rather than a field per pid: the supervisor's number and codex's
// live in the same place, and a reader needs one lookup for any of them.
// Absent is normal — a record written before this field existed, or one whose OS
// would not answer — and every reader treats absence as "no opinion".
const PID_START_FIELD = 'pidStarts';

// Two of the record's fields become PATH SEGMENTS — `role` reaches
// `<root>/.role-locks/<role>/`, which a release renames away and then removes
// recursively, and `id` names the job directory. Type-checking them as strings
// was never enough: `role: "..\\..\\victim"` is a string, and a corrupt record
// carrying one used to walk out of the jobs root through killJob → releaseRole
// (found by the Codex arm, 2026-08-06). They are whitelisted HERE, at the read
// boundary, so an invalid one is corruption — the shape every verb already
// handles — rather than a path.
const PATTERN_FIELDS = [
  ['role', ROLE_RE, 'a role (lowercase letters only)'],
  ['id', JOB_ID_RE, 'a job id (<role>-<epoch>-<pid>)'],
];

// Three more fields the supervisor hands STRAIGHT TO CODEX — `--sandbox`,
// `--model`, `-c model_reasoning_effort=` — and they were only ever type-checked.
//
// `sandbox` has a domain and it is two words wide: dispatch writes `read-only` or
// `workspace-write` and nothing else, ever. A rewritten job.json saying
// `danger-full-access` was a string, so it validated, so the supervisor launched
// codex with no sandbox at all — on a record this runtime never wrote. Out of
// domain is corruption, like every other semantic domain here.
const SANDBOX_MODES = ['read-only', 'workspace-write'];
// `model` and `effort` cannot have a domain: codex adds models, and a whitelist
// written today refuses tomorrow's. So the SHAPE is constrained instead — the
// charset every model and effort name has ever used — which is what keeps a
// record from smuggling a second argument, a redirection or an expansion onto the
// command line the supervisor builds. CMD_UNSAFE covers Windows only; this runs
// on both, and this is the check that does.
const ARGV_WORD_RE = /^[A-Za-z0-9._-]{1,80}$/;

const typeName = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

// A proven sight is `cwd-file:<name>` where <name> is a FILE NAME — not a
// prefix, not a prefix with a diagnosis stapled to it. `sight: "cwd-file:"`
// passed the delivery gate before this existed (Codex arm, round three), and so
// would `cwd-file:a.txt FAILED: the bytes never came back`, which is what the
// supervisor used to write for a DISPROVEN read.
//
// The name is what the probe passed to codex as a relative path in the job's own
// cwd, so: non-empty, no path separators, no `:` (which is both a Windows-invalid
// filename character and the separator this runtime's own labels use), nothing
// that could be a traversal, and short enough to be a name. A legitimate name
// that fails this — a POSIX file with a colon in it — is classified malformed and
// its job is refused, which is the fail-closed direction and is documented.
export const PROBE_FILE_NAME_RE = /^[^\\/:*?"<>|\x00-\x1f]{1,255}$/;

export function isProbeFileName(name) {
  if (typeof name !== 'string' || !PROBE_FILE_NAME_RE.test(name)) return false;
  if (name !== name.trim()) return false;
  return name !== '.' && name !== '..';
}

// What a record's `sight` field MEANS, decided in one place:
//   proven    — a well-formed cwd-file proof
//   accepted  — the exact recorded-opt-in label (still needs the boolean)
//   malformed — it claims the proof prefix and is not a proof: never deliverable
//   unproven  — anything else, including absent
export function sightVerdict(record) {
  const sight = record && typeof record.sight === 'string' ? record.sight : '';
  if (sight === ACCEPTED_SIGHT) return { kind: 'accepted', sight };
  if (sight.startsWith(PROVEN_SIGHT_PREFIX)) {
    const file = sight.slice(PROVEN_SIGHT_PREFIX.length);
    if (isProbeFileName(file)) return { kind: 'proven', sight, file };
    return { kind: 'malformed', sight, file };
  }
  return { kind: 'unproven', sight };
}

// The state this runtime will REASON with. A state outside the known set is not
// "some other terminal state" — it is a state this release cannot reason about,
// and `unknown` is how that is said out loud: live, role-blocking, never
// reclaimable without a verified kill, never deliverable.
export function canonicalState(record) {
  if (!record || isCorrupt(record)) return 'corrupt';
  return KNOWN_STATES.includes(record.state) ? record.state : 'unknown';
}

// The launch phase this runtime will reason with. Absent means the record
// predates the field (0.3 and earlier) and gets the time-boxed conservative
// reading; anything unrecognised gets the most dangerous one outright.
export function launchPhase(record) {
  if (!record || isCorrupt(record)) return MOST_DANGEROUS_PHASE;
  const p = record.launch;
  if (p === undefined || p === null) return 'legacy';
  return KNOWN_LAUNCH_PHASES.includes(p) ? p : MOST_DANGEROUS_PHASE;
}

// Returns a corruptReason string, or null when the record is usable.
export function validateRecord(parsed) {
  for (const key of STRING_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') return `field "${key}" is not a string (${typeName(v)})`;
  }
  for (const key of NUMBER_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return `field "${key}" is not a number (${typeName(v)})`;
    }
  }
  for (const key of BOOLEAN_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'boolean') return `field "${key}" is not a boolean (${typeName(v)})`;
  }
  for (const key of NUMBER_ARRAY_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v)) return `field "${key}" is not an array (${typeName(v)})`;
    for (const n of v) {
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        return `field "${key}" holds a non-number (${typeName(n)})`;
      }
    }
  }
  for (const [key, re, what] of PATTERN_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && re.test(v)) continue;
    return `field "${key}" is not ${what}: ${JSON.stringify(clean(String(v)).slice(0, 80))}`;
  }
  // ---- semantic domains, not just types --------------------------------------
  if (parsed.sandbox !== undefined && parsed.sandbox !== null && !SANDBOX_MODES.includes(parsed.sandbox)) {
    return (
      `field "sandbox" is not a sandbox mode ` +
      `(${JSON.stringify(clean(String(parsed.sandbox)).slice(0, 80))}; this runtime dispatches ` +
      `${SANDBOX_MODES.join(' or ')} and nothing else)`
    );
  }
  for (const key of ['model', 'effort']) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    if (!ARGV_WORD_RE.test(v)) {
      return (
        `field "${key}" is not a name this runtime would put on a codex command line ` +
        `(${JSON.stringify(clean(String(v)).slice(0, 80))}; ${ARGV_WORD_RE})`
      );
    }
  }
  for (const key of PID_NUMBER_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    if (!isPid(v)) {
      return `field "${key}" is not a pid (${JSON.stringify(v)}; pids are integers ${PID_MIN}..${PID_MAX})`;
    }
  }
  for (const key of PID_ARRAY_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    for (const n of v) {
      if (!isPid(n)) {
        return `field "${key}" holds something that is not a pid (${JSON.stringify(n)})`;
      }
    }
  }
  for (const key of COUNTER_FIELDS) {
    const v = parsed[key];
    if (v === undefined || v === null) continue;
    if (!Number.isSafeInteger(v) || v < 0) {
      return `field "${key}" is not a non-negative integer (${JSON.stringify(v)})`;
    }
  }
  // The start-time map is read to decide whether a recorded pid still names the
  // job's own process, so its keys have to be pids and its values have to be
  // text. Anything else is a record this runtime did not write.
  const starts = parsed[PID_START_FIELD];
  if (starts !== undefined && starts !== null) {
    if (typeof starts !== 'object' || Array.isArray(starts)) {
      return `field "${PID_START_FIELD}" is not an object (${typeName(starts)})`;
    }
    for (const [key, when] of Object.entries(starts)) {
      if (!/^\d+$/.test(key) || !isPid(Number(key))) {
        return `field "${PID_START_FIELD}" is keyed by something that is not a pid (${JSON.stringify(clean(key).slice(0, 40))})`;
      }
      if (typeof when !== 'string') {
        return `field "${PID_START_FIELD}" holds a start time that is not a string (${typeName(when)})`;
      }
    }
  }
  if (parsed.exitCode !== undefined && parsed.exitCode !== null && !Number.isSafeInteger(parsed.exitCode)) {
    return `field "exitCode" is not an integer (${JSON.stringify(parsed.exitCode)})`;
  }
  // A sight that CLAIMS the proof prefix and is not a proof is corruption, not a
  // weaker sight: something wrote the one string this runtime treats as evidence.
  if (parsed.sight !== undefined && parsed.sight !== null) {
    const verdict = sightVerdict(parsed);
    if (verdict.kind === 'malformed') {
      return (
        `field "sight" claims the proof prefix "${PROVEN_SIGHT_PREFIX}" but does not name a file ` +
        `(${JSON.stringify(clean(String(verdict.file)).slice(0, 80))})`
      );
    }
  }
  for (const key of REQUIRED_FIELDS) {
    if (!parsed[key]) return `field "${key}" is missing`;
  }
  // `started` is not decoration. `killWindow` measures the supervisor-registration
  // window from it, and an unparseable one made `Number.isFinite(Date.parse(...))`
  // false — which fell out of that expression as window `none`, so a cancel
  // landing inside the window killed nothing, recorded `killed` and released the
  // role while the supervisor it never touched went on to launch codex. That is
  // the one failure this runtime exists to prevent, reached by a field nobody had
  // given a domain. The validator is the spine: a time that is not a time is a
  // record this runtime did not write, so it is corruption here rather than a
  // fail-open guess in every reader.
  if (!Number.isFinite(Date.parse(parsed.started))) {
    return `field "started" is not a date (${JSON.stringify(clean(String(parsed.started)).slice(0, 80))})`;
  }
  return null;
}

// A corrupt job.json must never brick the other jobs: readRecord returns a
// marker instead of throwing, and every verb decides what to do with it.
export function readRecord(dir) {
  let raw;
  try {
    raw = fs.readFileSync(recordPath(dir), 'utf8');
  } catch (err) {
    return { __corrupt: true, corruptReason: clean(`unreadable: ${err.message}`) };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // The parse error quotes the file's own bytes, and those are untrusted:
    // an escape sequence in a corrupt job.json would otherwise be printed raw by
    // status, list and the watcher's banner.
    return { __corrupt: true, corruptReason: clean(`unparseable: ${err.message}`) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { __corrupt: true, corruptReason: 'job.json is not an object' };
  }
  const bad = validateRecord(parsed);
  if (bad) return { __corrupt: true, corruptReason: bad };
  return parsed;
}

export const isCorrupt = (record) => Boolean(record && record.__corrupt);

// ------------------------------------------------------- the delivery gate
//
// Deliverability is a VERSIONED SEMANTIC INVARIANT, computed from the record
// alone, and it requires POSITIVE proof rather than the absence of a red flag.
// The hole it closes: records written by 0.1/0.2 carry no `sight` at all (or the
// old `unproven` / `job-nonce` labels), and `result` gated only on
// `state === 'done'` — so upgrading this runtime silently delivered pre-gate
// answers, and a 0.2 `unproven` record even collected the "the caller opted in"
// caveat, which is a FALSE claim of consent. (Codex arm, 2026-08-06.)
//
// So: deliverable means the record carries this release's schema stamp AND a
// clean exit AND either a proven sight or the exact opt-in that the dispatch
// which ran the job wrote down. Consent is never inferred from a string.
// Everything else is UNVOUCHED: refused by `result`, named by `status`/`list`.
export function deliverability(record) {
  if (!record || isCorrupt(record)) {
    return { ok: false, reason: 'the record is corrupt, so it vouches for nothing' };
  }
  // The state gate lives HERE, not only in `result`, so there is exactly one
  // place that decides deliverability. An unknown state is the case this closes:
  // it is not `done`, and it is not safely anything else either.
  const state = canonicalState(record);
  if (state === 'unknown') {
    return {
      ok: false,
      reason:
        `the record's state ${JSON.stringify(clean(String(record.state)).slice(0, 40))} is not one this ` +
        `release knows (${KNOWN_STATES.join(', ')}), so nothing can be concluded from it`,
    };
  }
  if (state !== 'done') {
    return { ok: false, reason: `the record says "${clean(state)}", not "done"` };
  }
  if (record.recordVersion !== RECORD_VERSION) {
    return {
      ok: false,
      reason:
        `the record carries no current schema stamp (recordVersion ` +
        `${JSON.stringify(record.recordVersion ?? null)}, this release writes ${RECORD_VERSION}), so it ` +
        `was written by an older release under a delivery gate that is not this one`,
    };
  }
  if (record.exitCode !== 0) {
    return { ok: false, reason: `exitCode is ${JSON.stringify(record.exitCode ?? null)}, not 0` };
  }
  const verdict = sightVerdict(record);
  if (verdict.kind === 'proven') {
    return { ok: true, how: `sight proven (${clean(verdict.sight)})` };
  }
  if (verdict.kind === 'malformed') {
    // Unreachable through readRecord — validateRecord already calls this
    // corruption — and kept because deliverability is also called on records
    // this process assembled, and the one string that means "proved" must never
    // be satisfied by a prefix.
    return {
      ok: false,
      reason:
        `sight claims the proof prefix but names no file ` +
        `(${JSON.stringify(clean(verdict.sight).slice(0, 80))}) — a prefix is not a proof`,
    };
  }
  if (verdict.kind === 'accepted') {
    if (record.allowUnprovenSight === true) {
      return { ok: true, accepted: true, how: 'unproven sight, opted into by the dispatch that ran it' };
    }
    return {
      ok: false,
      reason:
        'the record claims an accepted unproven sight but carries no recorded opt-in ' +
        '(allowUnprovenSight: true) — consent is never read out of a label',
    };
  }
  return {
    ok: false,
    reason:
      `sight is ${verdict.sight ? JSON.stringify(clean(verdict.sight)) : 'not recorded'}, which is not ` +
      `proof — only "${PROVEN_SIGHT_PREFIX}<name>" is, and only a recorded --allow-unproven-sight ` +
      `substitutes for it`,
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The suite's pause hooks, read as a number that can only ever be a pause.
// `Atomics.wait` treats NaN as no timeout at all — it waits FOR EVER — so
// `Number(env)` on an unset-adjacent value (a typo, a shell that exported the
// name empty) turned a test hook into a wedged process with no output. Anything
// that is not a finite non-negative number is the same answer as unset: zero,
// inert. The ceiling is read at call time (RECORD_LOCK_WAIT_MS is declared
// below) and is a test hook's, not a policy: no window under test is wider than
// the record lock's own patience.
function testPauseMs(name) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, RECORD_LOCK_WAIT_MS);
}

// Atomic: a half-written job.json is exactly the corruption this guards against,
// and the supervisor writes it while status/list may be reading. On Windows a
// replace-rename can transiently lose to a concurrent reader, so retry briefly
// rather than let the supervisor die with the record unfinalized.
// Control bytes never ENTER the record. job.json carries text codex produced —
// a probe's error, a sight detail, a warning — and every verb prints those
// fields, one of them into a console right above a banner that has to be
// trustworthy. Codex's error text reaching `sight:` and then being printed raw
// was reproduced in review (2026-08-06): an ANSI sequence there could redraw the
// watcher's banner. Stripping at the write boundary means no reader has to
// remember to; the print boundaries strip as well, for records this runtime did
// not write.
function sanitizeRecord(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    out[k] = typeof v === 'string' ? stripControlBytes(v) : v;
  }
  return out;
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(from, to); } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleepSync(20);
    }
  }
}

function writeRecord(dir, record) {
  const tmp = path.join(dir, `job.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(sanitizeRecord(record), null, 2) + '\n');
  return renameWithRetry(tmp, recordPath(dir));
}

// ------------------------------------------------- one writer at a time
//
// `updateRecord` is a READ-MODIFY-WRITE, and 0.4.0 opened a window in which
// dispatch and cancel both write: dispatch records `{supervisorPid, launch}`
// after the spawn, while a cancel may be writing `kill-pending` or `killed`.
// Two interleavings were reachable, and the second is the dangerous one
// (Claude arm, round three):
//   - cancel's `kill-pending` lost to dispatch's later write;
//   - cancel took the honest nothing-to-kill path, wrote `state: 'killed'`, and
//     dispatch's write — built on a read from BEFORE that — put `running` back.
//     The operator was told "killed", the role was released, and codex ran.
//
// The cure is a single-writer discipline over the read and the write together.
// `mkdir` is the same atomic primitive the role claim uses: exactly one writer
// can create the lock directory, and a writer that died holding it is broken out
// of after RECORD_LOCK_STALE_MS rather than wedging the job forever.
const RECORD_LOCK = 'job.json.lock';
// The wait is long because the stale-break below bounds it: a holder that died is
// broken out of after RECORD_LOCK_STALE_MS, so the only thing this wait covers is
// live contention, and losing that race must never look like a successful write.
const RECORD_LOCK_WAIT_MS = 15000;
const RECORD_LOCK_STALE_MS = 5000;

// THE LOCK KNOWS WHO HOLDS IT. The stale break used to be an age test and
// nothing else — five seconds old meant "the holder died" — and the mtime is
// never refreshed, so a holder that is merely SLOW (a `pidStartTimes` query in a
// cold PowerShell, a paged-out process, a machine under load) lost mutual
// exclusion at exactly the five-second mark and then wrote from its pre-break
// read, over whatever the breaker had written in between. A cancel's
// `kill-pending` disappearing that way is the interleaving this lock exists to
// stop, reintroduced by the mechanism that stops a crash from wedging a job.
//
// So the holder writes its pid inside the lock, and a breaker must be able to
// PROVE that holder is gone — `pidAlive` says no — before the age matters at
// all.
//
// A VISIBLE LOCK ALWAYS HAS A HOLDER, and that is what makes the proof
// meaningful. `mkdir` then write is two steps, and the gap between them is a
// lock that exists with nothing inside it: a second writer stats it past the
// stale age, finds no holder to prove alive, and breaks in — while the creator,
// merely descheduled, resumes and writes its pid into the BREAKER's fresh
// directory at the same path. Two writers in the critical section, which is the
// interleaving above, reintroduced by the acquisition itself. So the lock is
// assembled out of sight and made visible in one atomic step: the holder file is
// written inside a staging directory, and a rename of that directory onto the
// lock path is the acquisition (see tryClaim, which claims roles the same way).
// A holderless lock is therefore not a live acquirer any more — it is a
// pre-upgrade artifact or a corrupt directory — and past the stale age it is
// still broken, because neither may wedge a job for ever. Below that age it is
// left alone, which is only sound while every holderless lock in reach is an
// artifact: an OLD release still acquires by bare `mkdir`, so one of its
// mid-gap locks is a live acquirer that this test cannot see. That is the
// mixed-version residual the staging rename narrows and DESIGN.md states; it is
// the same domain as a record-version mismatch, which refuses on sight.
//
// A PID AND NOTHING ELSE, DELIBERATELY. The obvious strengthening is to record
// the OS start time beside it, the way `pidStarts` does for kill targets, so a
// reissued number cannot pose as the holder. It is not done, for two reasons
// that point the same way. The query is a synchronous PowerShell spawn — half a
// second warm, seconds cold — and this is a lock: paid lazily it lands INSIDE
// the critical section (the exact slow holder this mechanism exists to protect,
// and past five seconds there is not even a holder file yet), paid eagerly it
// lands on the first record write of every process, cancel included. And the
// direction is wrong. Everywhere else in this runtime, start-time identity only
// ever SUBTRACTS — it withdraws a kill target or a liveness claim, never
// manufactures one — whereas here it would be the evidence that JUSTIFIES
// breaking a live-looking lock, which is the one action this fix exists to
// prevent. The residual is stated in DESIGN.md's known issues: a holder that
// dies and whose number is immediately reissued to something long-lived keeps
// the lock, and every writer then REFUSES loudly ("could not be locked; re-run")
// rather than silently losing an update. That is the direction this runtime
// always takes.
const RECORD_LOCK_HOLDER = 'holder';
// A suffix on the lock's own name, so the staging directories sort beside it and
// can never be confused with it: the lock is one exact path, and this is not it.
const RECORD_LOCK_STAGING = '.staging-';
// The tombstone a break moves a lock to, and the tombstone the staging sweep
// moves an orphan to. One suffix for both, so an abandoned tombstone is itself
// sweepable: a breaker that dies between the rename and the removal then leaks a
// directory that ages out rather than one that never goes. Like the staging
// suffix it is a suffix on the lock's own name, strictly longer than it, so no
// swept prefix can ever match the lock — which is one exact path.
const RECORD_LOCK_TOMB = '.stale-';

// A PID AND A NONCE. The pid is the liveness question every reader asks (see
// `lockHolderLives`, which parses the leading digits and nothing else); the nonce
// is IDENTITY, and it is what `tombIsCondemned` compares. Per ACQUISITION, never
// per process: one process acquires this lock many times in a run — cancel writes
// twice, a supervisor a dozen times — and two of its own acquisitions must not
// match each other, or a breaker that condemned holder text "1234" can find
// "1234" in its tombstone and call a LATER lock of the same process the one it
// proved dead. Sixty-four bits from the OS CSPRNG, for the same reason the mtime
// is checked beside it: the comparison is only worth what its collision odds are.
const lockHolderLine = () => `${process.pid} ${randomBytes(8).toString('hex')}\n`;
// Unique per rename, and it has to be: two tombstones cut in the same
// millisecond by the same process for two different locks that then collided
// would put one lock's verification against another's cargo. Three independent
// components — a per-process monotonic counter (never repeats in this process),
// the clock (separates processes that share a pid across time), and randomness
// (separates processes alive at once) — over the `.stale-` prefix and the pid the
// sweep and the tests match on.
let lockTombSeq = 0;
const lockTombPath = (lock) =>
  `${lock}${RECORD_LOCK_TOMB}${process.pid}-${Date.now().toString(36)}-${(++lockTombSeq).toString(36)}`
  + `-${Math.random().toString(36).slice(2, 8)}`;

// The holder file as EVIDENCE, not as a verdict: read once, so the breaker below
// can judge and then condemn the same bytes rather than two different readings of
// the same path. ENOENT ALONE IS "NO HOLDER". Every other error — EBUSY, EPERM,
// EIO, an ACL, a cloud filter waking a file back up — is a holder file that
// EXISTS and could not be read, which is evidence for a holder and not against
// one.
function lockHolderEvidence(lock) {
  try { return { text: fs.readFileSync(path.join(lock, RECORD_LOCK_HOLDER), 'utf8') }; }
  catch (err) { return err && err.code === 'ENOENT' ? { absent: true } : { unreadable: true }; }
}

// Alive — or null, no evidence either way, which leaves the age test to decide.
// An UNREADABLE holder answers ALIVE, not null: the breaker's obligation is to
// PROVE the holder gone, a read that failed proves nothing, and this is the only
// consumer of that read that could fail open — one transient EBUSY on a live
// holder's file would otherwise authorize breaking a live lock. Null is therefore
// reserved for a holder that is genuinely not there (ENOENT) or not a pid: the
// pre-upgrade artifact, which is the one age-only break there is.
function lockHolderLives(ev) {
  if (ev.unreadable) return true;
  if (ev.absent) return null;
  const m = String(ev.text).trim().match(/^(\d+)/);
  if (!m || !isPid(Number(m[1]))) return null;
  const pid = Number(m[1]);
  if (pid === process.pid) return true; // our own re-entry: never break it
  return pidAlive(pid);
}

// Ours — the one question release may ask. `lockHolderLives` answers a different
// one (is SOMEBODY there) and says true for any live pid, which is no evidence of
// ownership at all.
function lockHolderIsSelf(lock) {
  let text;
  try { text = fs.readFileSync(path.join(lock, RECORD_LOCK_HOLDER), 'utf8'); } catch { return false; }
  const m = String(text).trim().match(/^(\d+)/);
  return !!m && Number(m[1]) === process.pid;
}

// A LIVE LOCK STRANDED IN A TOMBSTONE WHILE THE CANONICAL PATH STANDS FREE IS
// ONE TERMINAL STATE BEHIND THREE DOORS, and this is the guard that closes the
// room. A breaker crashing between its rename and its restore; a restore that
// failed because a third writer took the path; a probe that read the tombstone
// wrongly — all three end in the same place: somebody's live lock sitting in a
// `.stale-*` directory, and `job.json.lock` free. Acquisition consults only the
// canonical path, so the next writer takes it and the stranded holder is in a
// silent double-hold: two writers under one record, which is the exact thing this
// mechanism exists to prevent, arrived at by the mechanism itself.
//
// So the room is closed at the point of harm. Before staging, and before a job
// directory is removed, the job dir is read and any tombstone whose holder is
// ALIVE — or unreadable, fail-closed like every other reading in this seam —
// blocks. Blocking is a refusal, never a break: the caller waits out its deadline
// and says loudly that the lock could not be taken, which is the direction this
// runtime always takes over writing on top of somebody.
//
// ONLY LIVE-OR-UNREADABLE BLOCKS, AND THE BLOCK IS THE MECHANISM — not a holding
// pattern until some repair arrives. A tombstone whose holder is dead or absent is
// litter awaiting the sweep, and blocking on it would wedge every acquisition in
// the job behind a corpse nothing will ever come back for. So the wedge lasts
// exactly as long as the stranded HOLDER'S PROCESS: while it runs, every acquirer
// of this job is refused loudly at its own deadline (which is correct — that
// process still believes it holds the record); when it exits, the tombstone reads
// dead, stops blocking, and is collected by a later sweep. The one exception is a
// tombstone whose holder file cannot be READ: it never reads as dead, so it blocks
// until somebody repairs it by hand. That is deliberate — fail-closed, loud at
// every deadline, and the refusal names the path to act on.
//
// The two repairs behind this guard are redundancy, not the cure. A stranded
// BREAKER that survived heals itself in milliseconds by retrying its own restore
// (see `withRecordLock`), and `sweepStaleStaging`'s restore of an aged live-holder
// tombstone is defense-in-depth: with the guard in place the only way to reach a
// strand this process did not cut itself is the guard-to-stage TOCTOU, the
// three-writer microsecond race stated with the residuals.
function liveLockTomb(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  for (const name of names) {
    if (!name.startsWith(`${RECORD_LOCK}${RECORD_LOCK_TOMB}`)) continue;
    const p = path.join(dir, name);
    if (lockHolderLives(lockHolderEvidence(p)) === true) return p;
  }
  return null;
}

// Assemble out of sight, publish in one step. The rename IS the acquisition: it
// lands a directory that already contains the holder file, so no reader can ever
// see a lock without an owner. Failing it means somebody else holds the path —
// the answer EEXIST on `mkdir` used to give — and the staging directory goes,
// because a crashed acquirer's leftovers must never outlive the attempt.
function stageRecordLock(dir, lock) {
  const stage = path.join(dir, `${RECORD_LOCK}${RECORD_LOCK_STAGING}${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  try { fs.mkdirSync(stage, { recursive: false }); } catch (err) { return { acquired: false, error: err }; }
  try {
    // temp + rename inside the staging directory, so the holder file is whole
    // before the directory it lives in is anything anyone can see.
    const tmp = path.join(stage, `${RECORD_LOCK_HOLDER}.tmp`);
    fs.writeFileSync(tmp, lockHolderLine());
    fs.renameSync(tmp, path.join(stage, RECORD_LOCK_HOLDER));
  } catch (err) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ }
    return { acquired: false, error: err };
  }
  // A NARROWING, NOT A PROOF. `rename(2)` on POSIX atomically REPLACES a target
  // that is an existing EMPTY directory, where Windows fails; every lock this
  // release publishes is non-empty, but an OLD release's bare `mkdir` acquirer,
  // caught between its mkdir and its holder write, leaves an empty one — and
  // replacing that at age zero would step straight past the stale-age discipline
  // for the one case it is needed. Existence is therefore contention, the same
  // answer the rename failure gives on Windows. The check-to-rename gap cannot be
  // closed with rename semantics; only mixed-version POSIX concurrency on one job
  // directory can thread it, and that is stated with the other residuals.
  if (fs.existsSync(lock)) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ }
    return { acquired: false };
  }
  // A failure here is somebody else holding the path — or this stage having been
  // swept out from under us while it aged (see sweepStaleStaging), in which case
  // there is nothing to publish and nothing to remove. Both say the same thing to
  // the caller: go round again.
  try { fs.renameSync(stage, lock); return { acquired: true }; } catch { /* held by someone else, or swept */ }
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ }
  return { acquired: false };
}

// Orphans of acquirers that died mid-stage, and tombstones of breakers that died
// mid-break. They are never mistaken for the lock — the lock is one exact path,
// and both suffixes are strictly longer than it — so they cost nothing but a
// directory, and they are only swept once they are older than any acquisition in
// flight could be.
//
// SWEEPING IS A RENAME FIRST, THEN A REMOVAL, for the same reason breaking is.
// `rmSync` on a live path is not a single-winner move and it is not atomic: it
// unlinks the holder file first, and a stage's owner does not check its own stage
// before publishing it — it checks the lock. So an aged-but-still-owned stage
// hollowed out by a sweep gets renamed onto the lock path by its owner as an
// EMPTY lock, which is the holderless lock the staged acquisition exists to make
// impossible. Renaming the whole directory to a unique tombstone first decides
// the race the way every other race here is decided: the rename fails, and the
// owner (or another sweeper) has it, and its contents are never touched. Only
// what this process moved is removed, and a removal interrupted halfway strands
// an empty tombstone — never anything on a stage or a lock path.
//
// AND AN AGED TOMBSTONE WHOSE HOLDER LIVES IS PUT BACK, NOT COLLECTED. Age alone
// is evidence enough for a STAGING orphan — its holder never published, so nothing
// depends on it — but a tombstone can hold a LIVE lock: a slow holder past five
// seconds has an aged lock, a mismatch-bound breaker condemns it, and what is
// standing in the tombstone until the restore runs is that holder's own lock,
// carrying its own mtime. Collecting that by age would delete a live holder's
// lock, the one path in this whole mechanism where a live lock is removed rather
// than stranded. Leaving it alone is therefore the floor, and the sweep goes one
// step further and RESTORES it — one `renameSync` back onto the lock path,
// single-winner like every other move here, and a failure (the path occupied,
// another hand faster) leaves the tombstone exactly where it was. Never a removal
// either way.
//
// THIS RESTORE IS DEFENSE-IN-DEPTH, NOT THE HEAL. What makes a strand safe is the
// acquisition guard (see `liveLockTomb`): nobody stages past a live-holder
// tombstone, so there is no silent double-hold to race the sweep for, and the
// strand ends when its holder's process does. The strand this restore could find
// is one the guard let through by the guard-to-stage TOCTOU, or one cut by a
// process that has since died — both microsecond-window states with no in-process
// trigger path. It is kept because putting a live lock back where it belongs is
// strictly better than leaving it in a directory nobody acquires from, not because
// anything depends on it running.
//
// THE AGE GATE IS WHAT KEEPS THIS OFF A MID-FLIGHT RESTORE, mostly, and where it
// does not the restore is the right move anyway. The gate stats the TOMBSTONE,
// and a tombstone cut from a live successor carries that successor's own mtime —
// fresh, because a lock's mtime is its acquisition time and is never refreshed —
// so the ordinary ABA window (condemn, move, put back, microseconds) is excluded
// before the holder is ever read. The exception is a successor that has itself
// held for more than five seconds while its breaker stayed descheduled: then this
// sweep gets there first and restores the victim's lock to the path it was taken
// from, which is precisely what the breaker was about to do. The breaker's own
// restore then fails with ENOENT and reads it as another hand having acted, which
// it was.
//
// AND THE WINNER OF A TOMB RENAME PROVES ITS CARGO IS DEAD BEFORE REMOVING IT.
// The holder read above and the directory removed below are two different moments
// on two different paths, and the source-path ABA — this tombstone collected by
// another sweeper and a new one appearing under the same name — is astronomically
// unlikely and not zero. So the holder is re-read on the tombstone THIS process
// won, and anything live is put back rather than removed: onto the lock path if
// it is free, because a live lock belongs there; onto its old name if it is not,
// because a tombstone standing where the acquisition guard reads it still holds
// the record against every acquirer, where a deleted one holds nothing. Never
// deleted. Like the restore above, this is a last line rather than a heal — the
// state it catches is the source-path ABA, which nothing in-process can produce.
function sweepStaleStaging(dir) {
  const lock = path.join(dir, RECORD_LOCK);
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    const isTomb = name.startsWith(`${RECORD_LOCK}${RECORD_LOCK_TOMB}`);
    if (!isTomb && !name.startsWith(`${RECORD_LOCK}${RECORD_LOCK_STAGING}`)) continue;
    const p = path.join(dir, name);
    try {
      if (Date.now() - fs.statSync(p).mtimeMs <= RECORD_LOCK_STALE_MS) continue;
      if (isTomb && lockHolderLives(lockHolderEvidence(p)) === true) {
        try {
          fs.renameSync(p, lock);
          process.stderr.write(
            `NOTE: a live record lock was stranded in ${p} and has been put back at\n`
            + `${lock}. Its holder never lost the lock; a breaker or a sweeper died holding it.\n`);
        } catch { /* the path is taken, or another hand was faster: leave it standing */ }
        continue;
      }
      const tomb = lockTombPath(lock);
      fs.renameSync(p, tomb);
      // TEST HOOK: stands in for this process dying (or being descheduled) between
      // the rename that wins the orphan and the removal of what it won. What is
      // under test is the state visible from outside in that window: the orphan
      // gone from its own path, and nothing but a tombstone to show for it.
      sleepSync(testPauseMs('CODEX_DISPATCH_TEST_SWEEP_PAUSE_MS'));
      if (isTomb && lockHolderLives(lockHolderEvidence(tomb)) === true) {
        let back = null;
        try { fs.renameSync(tomb, lock); back = lock; }
        catch { try { fs.renameSync(tomb, p); back = p; } catch { /* left where it is */ } }
        process.stderr.write(
          `WARNING: the tombstone this sweep won at ${p} holds a LIVE holder's lock, which the\n`
          + `read before the move said it did not. It was ${back ? `put back at ${back}` : `left in ${tomb}`}`
          + ` and NOT removed.\n`);
        continue;
      }
      fs.rmSync(tomb, { recursive: true, force: true });
    } catch { /* held, already swept, or gone: not ours to touch */ }
  }
}

// THE DESTROYER MUST PROVE IT IS DESTROYING WHAT IT CONDEMNED. Winning the
// tombstone rename is single-winner per RENAME, which is not the same as per
// LOCK: two breakers can both condemn the same dead lock, the first break it,
// re-acquire and publish a LIVE successor at the same path, and the second —
// descheduled in between — then move that successor into its own tombstone and
// delete it, which is two writers again by way of the mechanism meant to stop
// them. A pathname is all that bound the decision to the act, and the pathname is
// exactly what changed hands. So the evidence taken at decision time is checked
// against the tombstone before anything is removed: the same mtime (never
// refreshed while a lock lives, and a rename does not touch it) AND the same
// holder — the same pid, or the same genuine absence of one. An unreadable holder
// proves nothing and therefore matches nothing, as does a decision taken without
// a readable mtime at all.
function tombIsCondemned(tomb, mtimeMs, condemned) {
  if (mtimeMs === null || condemned.unreadable) return false;
  let st;
  try { st = fs.statSync(tomb); } catch { return false; }
  if (st.mtimeMs !== mtimeMs) return false;
  const now = lockHolderEvidence(tomb);
  if (now.unreadable) return false;
  if (condemned.absent) return now.absent === true;
  return now.absent !== true && String(now.text).trim() === String(condemned.text).trim();
}

function withRecordLock(dir, fn) {
  const lock = path.join(dir, RECORD_LOCK);
  // MONOTONIC, BECAUSE THE WAIT BOUND IS A PROMISE THE WALL CLOCK MUST NOT BE
  // ABLE TO BREAK. `Date.now()` is steppable — NTP, a manual set, a VM resume, a
  // DST-adjacent correction — and a step backwards turns fifteen seconds into
  // however long the step was, inside a loop a caller is blocked in. This
  // deadline is compared only against readings taken in this same process, so
  // `performance.now()` is the right clock for it; the AGES below stay on the
  // wall clock, because a file's mtime is a wall-clock fact and nothing else can
  // be compared with it.
  const deadline = performance.now() + RECORD_LOCK_WAIT_MS;
  // A tombstone this process cut, failed to put back, and has not given up on.
  // See the restore branch below: while it stands, this process must not stage —
  // it would be the second writer under a lock it stranded itself.
  let stranded = null;
  // The refusal names the tombstone, because "could not be locked; re-run" is
  // useless advice against a live lock sitting in a directory nobody will look in.
  const refuse = (tomb) => {
    if (tomb) {
      process.stderr.write(
        `WARNING: the record lock at ${lock} could not be taken: a lock whose holder is still ALIVE\n`
        + `— or whose holder file cannot be READ, which is treated the same — is stranded in\n`
        + `${tomb}\n`
        + `That holder still believes it has this record, so taking the lock path would put two writers\n`
        + `under it; this refuses instead. The block lasts as long as that holder's PROCESS does: once\n`
        + `it exits the tombstone reads as dead, stops blocking, and a later sweep collects it. If the\n`
        + `holder file is UNREADABLE it can never read as dead and nothing lifts this on its own —\n`
        + `inspect that directory and, once nothing is running under this job, remove it by hand.\n`);
    }
    return { locked: false };
  };
  for (;;) {
    // THE HEAL, AND IT IS THIS ONE: a breaker that survives its own failed restore
    // fixes the strand in milliseconds, here, and never leaves the wait. A restore
    // that failed because a third writer took the path can succeed a moment later,
    // once that writer releases — so it is retried at every turn of the wait rather
    // than abandoned to the next process that happens along. (The sweep's restore
    // is behind the guard, for the strands whose breaker did not survive.) ENOENT
    // means the
    // tombstone has gone: another hand collected it or put it back, and there is
    // nothing left to repair.
    if (stranded) {
      let err = null;
      try { fs.renameSync(stranded, lock); } catch (e) { err = e; }
      if (!err) {
        process.stderr.write(
          `NOTE: the lock stranded in ${stranded} was restored on retry to ${lock}.\n`);
        stranded = null;
      } else if (err.code === 'ENOENT') {
        stranded = null;
      }
    }
    // THE ACQUISITION GUARD (see `liveLockTomb` for the room it closes): a live
    // holder's lock stranded in a tombstone holds the record just as much as one
    // standing at the canonical path, and staging past it is a silent double-hold.
    // A dead-or-absent holder's tombstone is litter and blocks nothing. This is
    // one `readdirSync` of a small directory every 20ms of contention, which is
    // cheaper than the state it prevents by any measure that matters.
    const blocker = stranded || liveLockTomb(dir);
    if (blocker) {
      if (performance.now() >= deadline) return refuse(blocker);
      sleepSync(20);
      continue;
    }
    const staged = stageRecordLock(dir, lock);
    if (staged.acquired) break;
    // Staging itself failing is this process's own problem, not contention:
    // there is nothing to wait for, so it is reported like the old non-EEXIST
    // `mkdir` failure was.
    if (staged.error) return { locked: false, error: staged.error };
    // A LOCK THAT WILL NOT STAT HAS NO AGE, and the two ways to fail want opposite
    // moves. ENOENT is the lock GONE — the path is free, and the productive move is
    // straight back to staging rather than a wait. Every other error (EPERM, EBUSY,
    // EIO, an ACL) is a lock that is THERE and unmeasurable: no age proof, so no
    // break, and nothing to do but wait like any contended iteration. Both used to
    // land on `age = Infinity` and condemn: the absent lock renamed nothing and the
    // unreadable one went round the condemn-rename-restore path every 20ms — a
    // warning storm, and a lock path repeatedly emptied on no evidence at all.
    let age = Infinity;
    let mtimeMs = null;
    let vanished = false;
    try { const st = fs.statSync(lock); mtimeMs = st.mtimeMs; age = Date.now() - st.mtimeMs; }
    catch (err) { vanished = !!err && err.code === 'ENOENT'; }
    if (vanished) {
      if (performance.now() >= deadline) return refuse(null);
      continue;
    }
    // The holder is read ONCE, and what is read is kept: the verdict below and the
    // identity check after the break must be about the same bytes, or the break is
    // bound to nothing but a pathname (see tombIsCondemned). No mtime, no
    // condemnation: an age that was never measured is not an age.
    const condemned = mtimeMs !== null && age > RECORD_LOCK_STALE_MS ? lockHolderEvidence(lock) : null;
    if (condemned && lockHolderLives(condemned) !== true) {
      // The holder died — PROVED (see lockHolderLives), not assumed from the
      // clock; or there is no holder at all, which since acquisition became
      // atomic can only be an artifact or a corrupt directory. Breaking the
      // lock is safe in a way stealing a role claim is not: the loser of this
      // race rewrites from a fresh read.
      //
      // But BREAKING IT MUST NOT BE A DELETE, and `rmSync` has no winner at all.
      // Two processes can both stat the same stale lock and both decide to
      // break it; the second, descheduled after its stat, deleted the FRESH
      // lock the first had already created and was writing under — which
      // reopens the lost-update window this lock exists to close. So the break
      // is a RENAME to a unique tombstone, the same atomic single-winner
      // primitive the role claims use (see reclaimClaim), and only the process
      // that won the rename removes what it moved. A rename that fails means
      // somebody else broke it first — nothing to do but go round again.
      //
      // THAT RENAME IS SINGLE-WINNER PER RENAME, NOT PER LOCK, which is the
      // narrower guarantee this used to claim: the loser of the break can win a
      // LATER rename of the live successor standing at the same path. So the
      // destructive step is bound to the condemned lock's identity and not to its
      // pathname — the tombstone is checked against the evidence before it is
      // removed (see tombIsCondemned), and a successor found in it is put back.
      //
      // Swept BEFORE the break, never after: the sweep collects aged tombstones
      // too, and this process's own tombstone is aged from birth (it holds a lock
      // condemned for its age). Sweeping after would let it remove, unverified,
      // the very directory the check below exists to verify.
      sweepStaleStaging(dir);
      // TEST HOOK: stands in for this process being descheduled between condemning
      // the lock and moving it — the window in which the lock it judged can be
      // broken by somebody else and replaced by a LIVE successor at the same path.
      // A gap of a chosen length there is not producible on demand; what is under
      // test is that the removal below is bound to the evidence, not to the path.
      sleepSync(testPauseMs('CODEX_DISPATCH_TEST_BREAK_PAUSE_MS'));
      const tomb = lockTombPath(lock);
      let broke = false;
      try { fs.renameSync(lock, tomb); broke = true; } catch { /* another breaker won it */ }
      if (broke) {
        // Gone already: a sweeper collected what we condemned, which is the same
        // outcome by another hand. Nothing to prove and nothing to remove — and
        // silence is right by construction, because a sweep that collects rather
        // than restores has itself proved the holder dead or absent, which is
        // exactly what this break condemned it for.
        //
        // ENOENT ALONE IS "GONE", the same discipline the holder read follows.
        // `existsSync` answers false for a directory that is THERE and could not
        // be statted (EPERM, EBUSY, an ACL, a cloud filter), and reading that as
        // collected would skip the verification below and leave whatever is in
        // the tombstone unexamined. Unproven is present: anything but ENOENT
        // falls through to `tombIsCondemned`, whose own fail-closed answer (no
        // proof, no removal) then takes over.
        let tombGone = false;
        try { fs.statSync(tomb); } catch (err) { tombGone = !!err && err.code === 'ENOENT'; }
        if (tombGone) continue;
        if (tombIsCondemned(tomb, mtimeMs, condemned)) {
          try { fs.rmSync(tomb, { recursive: true, force: true }); } catch { /* a tombstone; harmless */ }
          continue;
        }
        // Not what we condemned: this rename moved a LIVE successor off the lock
        // path, so it goes straight back and is never removed — a mismatched
        // tombstone is somebody's lock, not a tombstone. The residual is stated in
        // DESIGN.md: the path stands empty for the microseconds in between, and a
        // third writer publishing into it makes the restore fail and strands the
        // victim's lock in the tombstone, where it is left to be inspected rather
        // than deleted. It is not treated as a won break either way.
        // THE RESTORE'S OWN ERRNO IS THE EVIDENCE, not a second probe. Asking
        // `existsSync(tomb)` afterwards asks a different question at a later
        // moment, and on Windows it cannot tell the two failures apart anyway:
        // both a target that is occupied and a source that is pinned come back
        // EPERM, and either can look present. So the rename's own error decides.
        // ENOENT is the source having gone — another hand had the tombstone —
        // and everything else is a move that failed with the tombstone still
        // there, which is the loud case.
        // TEST HOOK: stands in for this process being descheduled between moving a
        // successor into its tombstone and putting it back — the window in which a
        // third writer can take the freed lock path and make the restore fail. What
        // is under test is the retry: the tombstone stays in hand, nothing stages
        // past it, and the restore lands once the path comes free again. A window of
        // a chosen length there is not producible on demand.
        sleepSync(testPauseMs('CODEX_DISPATCH_TEST_RESTORE_PAUSE_MS'));
        let restoreErr = null;
        try { fs.renameSync(tomb, lock); } catch (err) { restoreErr = err; }
        if (!restoreErr) {
          process.stderr.write(
            `WARNING: the record lock at ${lock} changed hands between the decision to break it as\n`
            + `stale and the break itself. The successor was moved back and NOT removed.\n`);
        } else if (restoreErr.code === 'ENOENT') {
          // THE CALM ONE, AND IT NO LONGER CLAIMS THE HOLDER WAS DEAD. A sweeper
          // that COLLECTS a tombstone has proved that (it restores a live one
          // instead), but a sweeper that RESTORED this one to the lock path is
          // now the other way the tombstone can vanish from under this
          // verification — and that one's holder was alive. Both end the same
          // way for this process: it moved nothing, removed nothing, and what
          // stands at the lock path is the other hand's business.
          process.stderr.write(
            `WARNING: the record lock at ${lock} changed hands between the decision to break it as\n`
            + `stale and the break itself, and the condemned tombstone was gone before it could be put\n`
            + `back — collected by a sweeper that proved its holder dead, or put back on the lock path\n`
            + `by one that found it alive. Nothing was removed here.\n`);
        } else {
          // A live lock stranded in a tombstone while the lock path stands free
          // (or is somebody else's) — the state `liveLockTomb` refuses to stage
          // past. It is kept in hand: the loop retries the restore at every turn,
          // and until it lands this process will not take the lock either.
          let taken = true;
          try { fs.statSync(lock); } catch (err) { taken = !(err && err.code === 'ENOENT'); }
          stranded = tomb;
          process.stderr.write(
            `WARNING: the record lock at ${lock} changed hands between the decision to break it as\n`
            + `stale and the break itself, and it could not be moved back (${clean(restoreErr.code || restoreErr.message)}`
            + ` — ${taken ? 'another writer took the path first' : 'the path is free, so this is not contention'}).\n`
            + `It is left in ${tomb} rather than removed, so it can be inspected, and the restore is\n`
            + `retried until this writer gives up. Its holder has lost mutual exclusion: stop what is\n`
            + `writing this job before touching it.\n`);
        }
      }
    }
    if (performance.now() >= deadline) return refuse(stranded);
    sleepSync(20);
  }
  try { return { locked: true, value: fn() }; }
  // RELEASE BY IDENTITY, NOT BY PATH. `rmSync` on the path removes whatever is
  // there, and after a stale break that is somebody else's lock — the finisher
  // deletes the directory another writer is still working under. A lock this
  // process no longer owns is left exactly where it is: it is not ours to remove,
  // and its own holder will release it or age out.
  finally {
    try { if (lockHolderIsSelf(lock)) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// Compare-and-swap on the record. `expect` is the precondition, evaluated on the
// record as it is INSIDE the lock — so a caller can say "only if this is still
// running" and have that mean it. Returns the new record, or null when the
// record is corrupt, the precondition failed, or the lock could not be taken;
// `updateRecordOutcome` gives callers the reason when they need to act on it.
// `patch` may be a FUNCTION of the current record, for the callers whose patch is
// itself a read-modify-write (see recordReapedPids): computing a merge from a read
// taken outside the lock is the very race this lock exists to stop.
function updateRecordOutcome(dir, patch, { expect } = {}) {
  const held = withRecordLock(dir, () => {
    const current = readRecord(dir);
    // TEST HOOK: stands in for this process being descheduled between the read and
    // the write — the window in which another writer's verdict used to be lost. A
    // scheduler gap of a chosen length is not producible on demand; the runtime's
    // decision (the other writer's value survives) is what is under test.
    sleepSync(testPauseMs('CODEX_DISPATCH_TEST_RECORD_PAUSE_MS'));
    if (isCorrupt(current)) return { ok: false, why: 'corrupt', current };
    if (expect && !expect(current)) return { ok: false, why: 'precondition', current };
    const generation = Number.isSafeInteger(current.generation) ? current.generation + 1 : 1;
    const record = { ...current, ...(typeof patch === 'function' ? patch(current) : patch), generation };
    writeRecord(dir, record);
    return { ok: true, record };
  });
  if (!held.locked) {
    return { ok: false, why: 'locked' };
  }
  return held.value;
}

function updateRecord(dir, patch, opts) {
  const outcome = updateRecordOutcome(dir, patch, opts);
  return outcome.ok ? outcome.record : null;
}

// The liveness probe decides whether a kill worked, whether a job is stale, and
// whether a role may change hands — so what it does with an error matters as much
// as what it does with a success.
//
// It used to treat EVERY exception as "dead", which inverts the one case that is
// dangerous: `process.kill(pid, 0)` raises EPERM (and, on Windows, the same code
// for ERROR_ACCESS_DENIED out of OpenProcess) precisely when the process EXISTS
// but this account may not signal it — an elevated child, another user's process,
// a protected one. That is the shape a survived kill takes, and reading it as
// "dead" reported the kill as verified. Only ESRCH — no such process — is
// evidence of death; everything else is treated as alive, which errs toward
// refusing to launch rather than toward launching a second codex.
export function livenessFromError(err) {
  return !(err && (err.code === 'ESRCH' || err.errno === -3 /* UV_ESRCH */));
}

// Test-only: makes the liveness probe for these pids answer as though the OS had
// refused the query. Real elevation is not producible on demand in CI, and what
// is under test is the DECISION (access denied means alive), not how the denial
// arose. Format: `<pid>` or `<pid>:<CODE>`, comma- or space-separated.
function injectedLivenessError(pid) {
  const raw = process.env.CODEX_DISPATCH_TEST_EPERM;
  if (!raw) return null;
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const [p, code] = part.split(':');
    if (Number(p) === pid) return Object.assign(new Error('simulated'), { code: code || 'EPERM' });
  }
  return null;
}

export function pidAlive(pid) {
  if (!pid) return false;
  const injected = injectedLivenessError(pid);
  if (injected) return livenessFromError(injected);
  try { process.kill(pid, 0); return true; } catch (err) { return livenessFromError(err); }
}

// --------------------------------------------------------------- pid identity
//
// A PID IS A NUMBER THE OS HANDS BACK OUT. Every kill target here is written down
// once — supervisor.pid at spawn, codex.pid a moment later — and fired at
// whenever a cancel, a `--force` or a reap gets round to it, which can be hours
// after the process it named died. By then the number may belong to someone
// else's editor. `reaped.pids` does not cover this: it stops a SECOND shot at a
// number, and the first is the one that lands on a stranger. The same number read
// as "still alive" is also how a job whose supervisor died in the night reads
// `running` for ever, blocking its role and refusing every dispatch.
//
// So the start time is recorded beside the pid, and a number whose process
// started at a different moment is not the process this job spawned.
//
// THE CHECK ONLY EVER SUBTRACTS. No recorded start time (a record from before
// this field existed), or no readable current one (the query failed, this
// platform's `ps` cannot say, the process is already gone), leaves the pid with
// exactly the standing it had before: it is killed, and it is read as alive.
// Identity can withdraw a kill target or a liveness claim; it can never
// manufacture one — because the direction that costs money is declining to kill
// a codex that really is there, and that direction stays closed.
//
// Two readings of the same instant differ by the rounding of whatever printed
// them, so a couple of seconds apart is the same process.
const START_TIME_SLOP_MS = 2000;

// Test-only: the start time the OS would report for a pid right now. Real pid
// reuse cannot be aimed at in CI — it needs the OS to reissue a specific number —
// and what is under test is the DECISION (a moved start time is a different
// process), never the reuse itself. Format: `<pid>:<start>`, comma- or
// space-separated; everything after the first colon is the value.
function injectedStartTime(pid) {
  const raw = process.env.CODEX_DISPATCH_TEST_START_TIME;
  if (!raw) return null;
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const at = part.indexOf(':');
    if (at > 0 && Number(part.slice(0, at)) === pid) return part.slice(at + 1);
  }
  return null;
}

// Answered once per pid per process: a live pid's start time cannot change, and
// the watcher asks about the same supervisor every 500ms for as long as the job
// runs — a shell spawn a tick is not a diagnostic, it is a load. A number
// reissued DURING one of these processes' lifetimes reads as the old process,
// which is the fail-open direction and exactly today's behaviour. Misses are
// cached too: a query that could not answer once will not answer better 500ms
// later, and its answer is "no opinion" either way.
const startTimeCache = new Map();

// The OS's start time for each of these pids, as ISO text, in ONE query — a
// cancel checks several, and a shell spawn each is a cost paid on the path that
// stops a codex from billing. A pid the OS will not report is simply absent from
// the map, which every caller reads as "no opinion". Same powershell/pwsh
// fallback and windowsHide as processTable, for the same reasons.
//
// POSIX uses elapsed seconds rather than `lstart`: `etimes` is an integer this
// runtime turns into an absolute instant itself, so the recorded value and the
// checked one are the same shape and cannot disagree because two processes had
// different locales. A `ps` without `etimes` (macOS) reports nothing, which is
// the fail-open case above rather than a wrong answer.
function pidStartTimes(pids) {
  const out = new Map();
  const ask = [];
  for (const pid of [...new Set(pids.filter(isPid))]) {
    const injected = injectedStartTime(pid);
    if (injected !== null) { out.set(pid, injected); continue; }
    if (startTimeCache.has(pid)) {
      const cached = startTimeCache.get(pid);
      if (cached) out.set(pid, cached);
      continue;
    }
    ask.push(pid);
  }
  if (!ask.length) return out;
  const found = new Map();
  // Every pid that was asked about gets an entry, so a pid the OS would not name
  // is not asked about again by this process.
  const answer = () => {
    for (const pid of ask) startTimeCache.set(pid, found.get(pid) || null);
    for (const [pid, when] of found) out.set(pid, when);
    return out;
  };
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000 };
  if (!WIN) {
    const r = spawnSync('ps', ['-o', 'pid=,etimes=', '-p', ask.join(',')], opts);
    if (r.status !== 0) return answer();
    const now = Date.now();
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) found.set(Number(m[1]), new Date(now - Number(m[2]) * 1000).toISOString());
    }
    return answer();
  }
  // The filter is built from numbers that already passed `isPid`, so nothing
  // untrusted reaches the WQL. `.ToString('o')` is the round-trip format:
  // culture-invariant, so it means the same thing to whoever reads it back.
  const filter = ask.map((p) => `ProcessId=${p}`).join(' or ');
  const script =
    `Get-CimInstance Win32_Process -Filter '${filter}' | ` +
    `ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToString('o'))" }`;
  for (const shell of ['powershell', 'pwsh']) {
    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], opts);
    if (r.status !== 0) continue;
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(\S+)$/);
      if (m) found.set(Number(m[1]), m[2]);
    }
    if (found.size) return answer();
  }
  return answer();
}

// Same process, or not enough evidence to say otherwise. Absence on either side
// is the fail-open case. Two unparseable strings that differ are treated as a
// mismatch: both readings come from the same command on the same machine, so for
// the same process they are the same bytes.
export function sameStartTime(recorded, current) {
  if (typeof recorded !== 'string' || !recorded) return true;
  if (typeof current !== 'string' || !current) return true;
  if (recorded === current) return true;
  const a = Date.parse(recorded);
  const b = Date.parse(current);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= START_TIME_SLOP_MS;
}

// Which of these pids are still the processes the record wrote down. Pids with
// no recorded start time pass through untouched — see the note above: this
// filter only ever removes.
function recordedProcesses(record, pids) {
  const starts = (record && !isCorrupt(record) && record[PID_START_FIELD] && typeof record[PID_START_FIELD] === 'object')
    ? record[PID_START_FIELD]
    : {};
  const checkable = pids.filter((p) => isPid(p) && typeof starts[String(p)] === 'string');
  const current = checkable.length ? pidStartTimes(checkable) : new Map();
  return pids.filter((p) => sameStartTime(starts[String(p)], current.get(p)));
}

// The start times to write down beside a set of pids, in the record's shape.
// Empty when the OS would not say, which is the same thing as not recording them.
//
// Never off the cache: this is the one moment the number is KNOWN to be the
// process just spawned, and this process may have asked about that same number
// earlier, when it belonged to the dead job a `--force` was clearing. Recording
// the dead one's start time as ours would make every later kill decline to
// signal our own supervisor — the single direction that ends with a codex
// nobody will stop.
function startTimesFor(pids) {
  for (const pid of pids) startTimeCache.delete(pid);
  const out = {};
  for (const [pid, when] of pidStartTimes(pids)) out[String(pid)] = clean(when);
  return out;
}

// Every listing verb walks this, and every one of them then reads pid files,
// kills, renames or removes through what it finds. So the walk is where the
// containment is proved: a directory entry inside the jobs root is only a job if
// its name is an id this runtime could have generated, it is a REAL directory
// (not a junction or symlink pointing somewhere else), and it still resolves
// inside the root once its reparse points are followed.
//
// An entry that carries a job.json and fails any of those is reported as corrupt
// rather than skipped: skipping is how a live thing becomes invisible, and this
// walk is the backstop that has to see everything.
function allJobs() {
  const root = jobsRoot();
  if (!fs.existsSync(root)) return [];
  const jobs = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    const name = entry.name;
    const dir = path.join(root, name);
    if (!fs.existsSync(recordPath(dir))) continue; // not a job dir
    if (!JOB_ID_RE.test(name)) {
      jobs.push({
        id: name, dir, contained: false,
        record: { __corrupt: true, corruptReason: clean(`the directory name is not a job id (${name})`) },
      });
      continue;
    }
    if (!isRealDirectory(dir) || !isInsideRootReal(root, dir)) {
      jobs.push({
        id: name, dir, contained: false,
        record: {
          __corrupt: true,
          corruptReason:
            'the job directory is a link, or resolves outside the jobs root — nothing was read ' +
            'through it',
        },
      });
      continue;
    }
    jobs.push({ id: name, dir, contained: true, record: readRecord(dir) });
  }
  jobs.sort((a, b) => (b.record.started || '').localeCompare(a.record.started || ''));
  return jobs;
}

function getJob(id) {
  if (!id) fail('missing job id');
  assertJobId(id);
  const root = jobsRoot();
  // Whitelisted above and PROVED inside the root here: the two halves are
  // deliberately separate, so loosening one can never silently disarm the other.
  const dir = jobDirFor(root, id) || assertInsideRoot(root, path.join(root, id), 'open a job directory');
  if (!fs.existsSync(recordPath(dir))) fail(`no such job: ${id}`);
  return { id, dir, record: readRecord(dir) };
}

function assertJobId(id) {
  if (JOB_ID_RE.test(id)) return;
  fail(
    `invalid job id: ${JSON.stringify(id)}\n` +
    `job ids are <role>-<epoch>-<pid> and must match ${JOB_ID_RE} — refusing to use it as a path.`
  );
}

// The RECORD is authoritative. An earlier revision promoted a job to `done` the
// moment out.txt existed; that is revoked (see docs/DECISIONS.md). The answer
// file appears the instant codex writes it — BEFORE the exit code is recorded and
// BEFORE any sight verdict — so file-existence promotion opened a window in which
// a job read `done` while nothing had yet vouched for it. A supervisor that dies
// before finalizing now leaves the job `stale`, which is the truth: nobody ever
// confirmed how it ended.
function effectiveState(job) {
  const r = job.record;
  if (isCorrupt(r)) return 'corrupt';
  // Through the validator, always: a state outside the known set reads as
  // `unknown`, which is live. It used to pass through verbatim, so a record
  // carrying a typo'd `"runnng"` or a future `"cancelling"` was neither running
  // nor in LIVE_STATES — it lost its role claim while codex ran. (Codex arm.)
  const state = canonicalState(r);
  if (state !== 'running') return state;
  // A live pid is not the same as OUR live pid. The number is reissued, and a
  // record naming one that now belongs to something else used to read `running`
  // for ever: the job blocked its role and every refusal claimed codex might
  // still be billing. Identity is checked second, so a dead pid never pays for
  // the query, and an unknown answer leaves the liveness reading as it was.
  if (!pidAlive(r.supervisorPid) || !recordedProcesses(r, [r.supervisorPid]).length) {
    // grace: supervisor registers its own pid shortly after spawn
    if (!r.supervisorPid && Date.now() - Date.parse(r.started) < CLAIM_GRACE_MS) return 'running';
    return 'stale';
  }
  return 'running';
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function humanDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

// ------------------------------------------------- blind-signature backstop
//
// The desktop-app codex build lacks the Windows sandbox helper executables, so
// every file read inside a job fails — while codex still exits 0 and the model
// still writes a confident out file. Seen in production: a review that said it
// could not read the file it was asked to review, delivered as a success.
// These are the signatures that failure prints.
//
// DEMOTED (see docs/DECISIONS.md): this scan no longer decides anything. It is
// negative, post-hoc inference — it cannot see a failure shape it has never met,
// and it cannot tell a fatal failure from one codex recovered from. Sight is now
// established positively, per job, before the run (`sightProbe`), and a hit here
// only adds `warning:` to the record.
export const BLIND_SIGNATURES = [
  'orchestrator_helper_launch_failed',
  'helper=codex-windows-sandbox-setup.exe',
  'CreateProcessWithLogonW failed',
  'helper copy failed',
];

// A signature alone is not evidence: a job that reads source code echoes that
// source into run.log, and this repo's own source contains all four strings as
// literals. (That false positive failed the first end-to-end run that actually
// worked.) So a hit must sit on a line codex itself emitted — its tracing lines
// are timestamped and targeted, e.g.
//   2026-08-06T13:49:29.446054Z ERROR codex_core::exec: exec error: windows sandbox: ...
// which neither echoed source nor the model's own prose about the failure can
// imitate. Reviewing a file that contains real codex error logs would still fool
// it; that is now merely a spurious warning rather than a wrong verdict.
const CODEX_TRACE_LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(?:ERROR|WARN)\s+codex[\w:]*:/;

export function scanBlindText(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!CODEX_TRACE_LINE.test(line)) continue;
    for (const sig of BLIND_SIGNATURES) if (line.includes(sig)) return sig;
  }
  return null;
}

// Chunked so a half-hour run's log never has to fit in memory; the trailing
// partial line is carried into the next chunk so no line is ever split.
export function scanBlindLog(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const size = fs.fstatSync(fd).size;
    const CHUNK = 65536;
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    let carry = '';
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (n <= 0) break;
      const text = carry + buf.toString('utf8', 0, n);
      const lastBreak = text.lastIndexOf('\n');
      const complete = lastBreak === -1 ? '' : text.slice(0, lastBreak);
      // A "line" longer than a chunk is not a codex tracing line — cap the carry
      // so a newline-free log cannot grow it without bound. The regex anchors at
      // the line start, which the kept prefix preserves.
      carry = (lastBreak === -1 ? text : text.slice(lastBreak + 1)).slice(0, CHUNK);
      const hit = scanBlindText(complete);
      if (hit) return hit;
      pos += n;
    }
    return scanBlindText(carry);
  } finally {
    fs.closeSync(fd);
  }
}

const BLIND_EXPLANATION =
  'sandbox-blind: codex could not run commands inside its sandbox, so the model would see NO files.\n' +
  'It answers anyway and exits 0, which is why sight is proven up front rather than read off the exit code.\n' +
  'Cause: the desktop-app codex build ships without the Windows sandbox helpers\n' +
  '(codex-windows-sandbox-setup.exe). Fix: npm install -g @openai/codex, and make sure\n' +
  '%APPDATA%\\npm\\codex.cmd is what this runtime resolves (or point CODEX_DISPATCH_BIN at it).';

// The other half of the same rule, and the one that was missing: sight that
// cannot be DISPROVEN is not sight. A job whose sandbox was never shown to read
// anything produces exactly the artifact this runtime exists to refuse — a
// confident, sourceless answer that exits 0 — so it is not delivered on the
// strength of a polite warning. It is refused, unless the caller says otherwise
// in writing.
const UNPROVEN_EXPLANATION =
  'sight-unproven: nothing proved this job could read files, so any answer it produced would be\n' +
  'unvouched-for — the same artifact as a blind success, minus the error messages.\n' +
  'Deliverability requires PROVEN sight: a file that already exists in the job\'s own --cd, read\n' +
  'back through codex\'s sandbox with its bytes returned.\n' +
  'Cures, best first:\n' +
  '  - CLI too old to have `codex sandbox`: npm install -g @openai/codex, then re-run preflight.\n' +
  '  - Nothing readable in the job\'s --cd (empty, all binary, or every candidate name carries a\n' +
  '    shell expansion character): point --cd at the directory the model actually has to read.\n' +
  '  - Accept it knowingly: re-dispatch with --allow-unproven-sight. The job then runs, the\n' +
  '    record carries `sight: unproven (accepted by caller)`, status and result both say so,\n' +
  '    and the answer is delivered with that caveat attached.';

// ---------------------------------------------------------------- codex binary

const isScript = (bin) => /\.(mjs|cjs|js)$/i.test(bin);

// Three characters no quoting on a cmd.exe command line can hold, so all three
// are refused rather than escaped. A value that silently becomes something else
// is the blind-answer failure in another costume: confident, wrong, unsurfaced.
//   %  cmd.exe expands `%VAR%` AFTER quote stripping — `"%PATH%"` expands exactly
//      like `%PATH%`, so quoting is not a defence and no in-band escape exists.
//   !  the same, under delayed expansion. Node launches `cmd.exe /d /s /c`, where
//      it is off, so this is a guarantee about somebody else's future setting
//      rather than a live defect — which is the cheapest kind to keep.
//   "  the one character whose two escaping conventions disagree. cmd.exe tracks
//      quote PARITY to decide what is "inside quotes" for metacharacter purposes,
//      while CommandLineToArgvW reads `\"` as an escaped quote — so `""` keeps
//      cmd happy and breaks the CRT, `\"` does the reverse, and there is no
//      spelling that satisfies both. Windows paths cannot contain one and no
//      model or effort name does, so refusing costs nothing real and removes the
//      whole mismatch. (Codex arm, round two: the old `""` escaping made `a\"`
//      fail to round-trip.)
export const CMD_UNSAFE = /[%!"]/;

const cmdUnsafeError = (s) => {
  const err = new Error(
    `cannot quote for cmd.exe: ${JSON.stringify(s)} contains one of % ! " — cmd.exe ` +
    'expands or re-parses these after quote stripping, and no escaping on a command ' +
    'line reaches them. Remove it (or point --cd at a path without one).'
  );
  // Tagged so main() can report it as a refusal instead of a stack trace, without
  // swallowing every other throw in the process. See the catch there.
  err.code = 'CMD_UNQUOTABLE';
  return err;
};

// Windows cmd-line quoting for shell:true spawns (codex.cmd needs a shell).
// Exported for the unit tests: this is argv construction, and every defect here
// has been invisible until the output was asserted directly.
export function cmdQuote(s) {
  if (CMD_UNSAFE.test(s)) throw cmdUnsafeError(s);
  // EVERY command-token delimiter, not just the metacharacters. cmd.exe ends a
  // token on `,`, `;` and `=` exactly as it does on whitespace, and those three
  // were missing here while `& | < > ( ) ^` were not. Measured: a `.cmd` under
  // `to,ols\`, `se;mi\` or `eq=al\` exits 1 with "is not recognized" unquoted and
  // runs when quoted — a resolved bin path silently becoming a different one,
  // which is the class of failure this whole function exists to refuse.
  if (!/[\s&|<>()^,;=]/.test(s)) return s;
  // The trailing backslash run is doubled because the closing quote we are about
  // to add is read by CommandLineToArgvW, not by cmd.exe: there `\"` is an ESCAPED
  // quote, so `"foo bar\"` loses its delimiter and swallows whatever argument
  // comes next. N backslashes become 2N, which the same parser reads back as N
  // literal backslashes followed by a delimiter that survives. Interior runs are
  // left alone — only the run against the delimiter is ambiguous, and a Windows
  // path is mostly interior runs. With `"` refused above, this is the only rule
  // left to get right.
  return `"${s.replace(/(\\+)$/, '$1$1')}"`;
}

// Returns { child, viaShell }. `viaShell` matters because of what it does to the
// pid: on Windows `codex.cmd` is not a script this runtime can run under node, so
// it is spawned through cmd.exe — and the pid that comes back is the CMD.EXE
// WRAPPER, not codex. Recording that as `codexPid` meant every kill verification
// checked a proxy (measured live: wrapper 43124, real worker 40732 with ppid
// 43124). See resolveWorkerPids.
function spawnCodex(bin, args, opts) {
  if (isScript(bin)) return { child: spawn(process.execPath, [bin, ...args], opts), viaShell: false };
  if (WIN) {
    return { child: spawn([bin, ...args].map(cmdQuote).join(' '), { ...opts, shell: true }), viaShell: true };
  }
  return { child: spawn(bin, args, opts), viaShell: false };
}

// stdin is NUL, never a pipe. spawnSync's default stdio gives the child a pipe
// for stdin and closes the write end immediately; a child (or a grandchild that
// inherits the handle — `cmd /c type` does) that touches it can fail the launch
// with ERROR_NO_DATA / 0x800700E8, "the pipe is being closed". That surfaced as a
// console error box during a probe against a perfectly good binary. Nothing this
// runtime spawns synchronously ever reads stdin, so there is no reason to give it
// one. windowsHide for the same reason a probe must be invisible: it runs under a
// detached supervisor, and a console window popping up is not a diagnostic.
function runCodexSync(bin, args, opts = {}) {
  const base = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, ...opts };
  if (isScript(bin)) return spawnSync(process.execPath, [bin, ...args], base);
  if (WIN) return spawnSync([bin, ...args].map(cmdQuote).join(' '), { ...base, shell: true });
  return spawnSync(bin, args, base);
}

function whereHits(name) {
  if (!WIN) return [];
  const r = spawnSync('where', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  if (r.status !== 0) return [];
  return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

export const DESKTOP_APP_REL = ['Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'];

// Resolution order, most-sandbox-capable first:
//   1. the npm global install — it vendors the Windows sandbox helper binaries
//   2. any other codex.cmd on PATH (a different npm prefix)
//   3. bare `codex` on PATH
//   4. the desktop-app build LAST — it resolves as `codex` on PATH but has no
//      sandbox helpers, so preferring it is how jobs go blind.
export function binCandidates(env = process.env, where = whereHits('codex.cmd')) {
  const list = [];
  if (env.APPDATA) list.push(path.join(env.APPDATA, 'npm', 'codex.cmd'));
  for (const p of where) if (!list.includes(p)) list.push(p);
  list.push('codex');
  if (env.LOCALAPPDATA) list.push(path.join(env.LOCALAPPDATA, ...DESKTOP_APP_REL));
  return list;
}

export const isDesktopApp = (bin) =>
  /[\\/]Programs[\\/]OpenAI[\\/]Codex[\\/]bin[\\/]codex\.exe$/i.test(bin || '');

function resolveBin() {
  if (process.env.CODEX_DISPATCH_BIN) return process.env.CODEX_DISPATCH_BIN;
  for (const candidate of binCandidates()) {
    if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
    if (runCodexSync(candidate, ['--version']).status === 0) return candidate;
  }
  return null;
}

// ------------------------------------------------------------ proving sight
//
// A proof is only as good as the thing it demands back. The token used to be the
// probe file's FIRST line, matched against stdout and stderr merged — and a
// stand-in that read nothing and merely echoed its own argv earned a
// `sight: cwd-file:...` verdict from that (Claude arm, 2026-08-06, reproduced).
// Two structural changes: the token now comes from INSIDE the file, never from
// its first line or its name (see pickProbeTarget), and the match is on STDOUT
// only — verified live against codex-cli 0.146.0, where `codex sandbox cmd /c
// type <file>` puts the sandboxed command's output on stdout and leaves stderr
// empty. Plus the assertion below: whatever we require back must not be visible
// in what we send, or an echo is indistinguishable from a read.
const MIN_SIGHT_TOKEN = 12;

// The probe's POSIX half runs `sh -c "cat <file>"`, and the file name comes off
// the job's own cwd — a directory somebody else fills. `JSON.stringify` was
// doing this quoting, and it produces a DOUBLE-quoted string: sh expands
// `$(...)`, backticks and backslashes inside those, so a file named
// `$(curl evil).md` sitting in the probed directory RAN during the read meant to
// prove sight. Single quotes are the one sh quoting that expands nothing at all;
// the `'\''` dance is how a single quote is carried through them. Names carrying
// these characters are also skipped outright (see pickProbeTarget) — this is the
// second lock on the same door, and the one that holds for the job-nonce path,
// where the name is ours but the directory is not.
export function shQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

// How many times a probe whose TRANSPORT failed is retried before the runtime
// gives up and says so. Deliberately small: a real spawn failure repeats, a flake
// does not.
const SIGHT_PROBE_ATTEMPTS = 3;
const SIGHT_PROBE_RETRY_MS = 250;

// Test-only: makes the Nth probe spawn fail the way a Windows pipe/launch failure
// does — `spawnSync` returning an `error` with no status at all. A transport
// failure is not producible on demand in CI, and what is under test is the
// runtime's DECISION: a probe that could not be RUN is not a probe that found
// blindness. Format: a count of attempts to fail (`2` = the first two).
function injectedProbeError() {
  const raw = process.env.CODEX_DISPATCH_TEST_PROBE_ERROR;
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
let injectedProbeErrorsUsed = 0;

// One sandboxed read, verified by its content. `codex sandbox <cmd>` runs a real
// command inside codex's own sandbox: no model call, no tokens, no billing,
// ~300 ms. The check is POSITIVE — the bytes we expect have to come back — which
// is what makes it robust against failure shapes nobody has seen yet.
//
// Returns { state, detail } where state is one of:
//   functional  — the bytes came back on stdout: sight is PROVEN
//   broken      — the sandbox ran and could not read: sight is DISPROVEN
//   unavailable — this codex has no `sandbox` subcommand
//   unprovable  — the read could not be posed as a proof
//   probe-error — THE PROBE NEVER RAN. The spawn itself failed (Windows pipe
//                 teardown, a binary that vanished, a transport error), so
//                 nothing was learned about the sandbox at all.
//
// That last one is a distinction this runtime used to lack, and it matters
// exactly as much as the rest of the gate: `spawnSync` sets `error` and leaves
// `status` null when the launch fails, and every one of those used to fall out of
// the bottom of this function as `broken` — i.e. as a job FAILED for
// `sandbox-blind-precheck`, a verdict of proven blindness, on the strength of an
// infrastructure hiccup. Under a fail-closed gate that is the expensive
// direction: it refuses good jobs and blames the wrong thing.
function sandboxRead(bin, file, { cwd, token } = {}) {
  const args = WIN
    ? ['sandbox', 'cmd', '/c', 'type', file]
    : ['sandbox', 'sh', '-c', `cat ${shQuote(file)}`];
  const sent = [bin, ...args].join(' ');
  if (typeof token !== 'string' || token.length < MIN_SIGHT_TOKEN) {
    return {
      state: 'unprovable',
      detail: `no usable verification token (need ${MIN_SIGHT_TOKEN}+ printable ASCII characters from inside the file)`,
    };
  }
  if (sent.includes(token)) {
    // Never reachable through pickProbeTarget, which rejects such tokens — kept
    // because this is the property the proof rests on, and a property that is
    // only enforced somewhere else is one refactoring away from being enforced
    // nowhere.
    return {
      state: 'unprovable',
      detail: 'the verification token appears in the command being sent, so an echo would pass as a read',
    };
  }

  let transport = null;
  for (let attempt = 1; attempt <= SIGHT_PROBE_ATTEMPTS; attempt++) {
    let r;
    if (injectedProbeErrorsUsed < injectedProbeError()) {
      injectedProbeErrorsUsed++;
      r = { error: Object.assign(new Error('simulated spawn failure'), { code: 'UNKNOWN', errno: -4094 }), status: null };
    } else {
      r = runCodexSync(bin, args, cwd ? { cwd } : {});
    }
    // The probe did not RUN. Not evidence about the sandbox — evidence about the
    // spawn. Retry a bounded number of times; a real failure survives that.
    if (r.error || (r.status === null && !r.stdout && !r.stderr)) {
      const err = r.error || new Error('the process produced neither output nor an exit status');
      transport = `${clean(err.code || err.errno || 'spawn failed')}: ${clean(err.message)}`;
      if (attempt < SIGHT_PROBE_ATTEMPTS) { sleepSync(SIGHT_PROBE_RETRY_MS); continue; }
      return {
        state: 'probe-error',
        detail:
          `the sight probe could not be RUN (${transport}), ${SIGHT_PROBE_ATTEMPTS} attempts — ` +
          'so nothing is known about this sandbox either way',
      };
    }
    const stdout = r.stdout || '';
    const text = `${stdout}${r.stderr || ''}`;
    if (r.status === 0 && stdout.includes(token)) return { state: 'functional', detail: '' };
    const firstLine = clean(text).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || `exit ${r.status}`;
    if (/unrecognized subcommand|unknown subcommand|invalid subcommand/i.test(text)) {
      return { state: 'unavailable', detail: firstLine };
    }
    if (r.status === 0) {
      return {
        state: 'broken',
        detail: text.includes(token)
          ? `the command exited 0 and the bytes appeared only on stderr, not on stdout where a real read puts them (${firstLine})`
          : `the command exited 0 but the file's bytes never came back (${firstLine})`,
      };
    }
    // A nonzero exit WITH no output at all is the other shape a broken launch
    // takes on Windows (the shell reports the failure and says nothing), so it is
    // treated as transport rather than as a sandbox verdict.
    if (r.signal || (!stdout && !(r.stderr || ''))) {
      transport = r.signal ? `killed by ${clean(r.signal)}` : `exit ${r.status} with no output`;
      if (attempt < SIGHT_PROBE_ATTEMPTS) { sleepSync(SIGHT_PROBE_RETRY_MS); continue; }
      return {
        state: 'probe-error',
        detail:
          `the sight probe produced no output to judge (${transport}), ${SIGHT_PROBE_ATTEMPTS} attempts — ` +
          'so nothing is known about this sandbox either way',
      };
    }
    return { state: 'broken', detail: firstLine };
  }
  /* c8 ignore next */
  return { state: 'probe-error', detail: transport || 'the sight probe could not be run' };
}

// Install-level probe, from wherever the launcher happens to be: writes a nonce
// into the OS temp dir and reads it back. Used by `preflight`; it says the
// install is capable, not that any particular job can see (that is sightProbe).
export function sandboxProbe(bin) {
  // The secret is NOT the file name. It used to be: the nonce was both the name
  // and the content, so the name travelled on the command line and an argv echo
  // could return it without ever opening the file — the same weakness as the
  // per-job probe's first-line token.
  const name = `codex-dispatch-sandbox-probe-${Date.now()}-${process.pid}`;
  const secret = `sandbox-proof-${randomToken()}`;
  const file = path.join(os.tmpdir(), `${name}.txt`);
  fs.writeFileSync(file, `probe file for ${name}\n${secret}\n`);
  try {
    return sandboxRead(bin, file, { token: secret });
  } finally {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  }
}

// 128 bits from the OS CSPRNG: the secret has to be unguessable by a stand-in
// that never read the file, and `crypto` costs nothing here that `Math.random`
// was buying.
function randomToken() {
  return randomBytes(16).toString('hex');
}

// Pick a file that ALREADY EXISTS in the job's cwd, plus a token from it to
// verify the read by. Never writes there: a job's `--cd` is somebody's repo, and
// a runtime that litters it is one nobody points at anything precious.
// The token is ASCII-only so a console codepage cannot mangle the comparison, and
// names carrying an expansion character of EITHER shell are skipped rather than
// trusted to quoting: `% ^ & ! "` are cmd.exe's, and `$ ` \ '` are sh's — a file
// called `$(cmd).md` in the probed directory used to execute during the probe.
// Skipping is the cheap half (a name this runtime never has to handle is a name
// that cannot bite); shQuote above is the half that still holds if this list is
// ever loosened.
//
// WHERE the token comes from is the security property. It used to be the file's
// first line, which is exactly the part a tool that never opened the file is most
// likely to be able to produce — a header, a shebang, a name repeated from the
// path. A stand-in that read nothing and echoed its argv passed the proof that
// way. Now it comes from BELOW the first line, must be long enough to be
// content rather than boilerplate, and must not contain (or be contained in) the
// file's own name: bytes nobody can produce without having read the file.
const PRINTABLE_ASCII_LINE = /^[\x20-\x7E]+$/;

// cmd.exe's expansion characters and sh's, in one list: a candidate name
// carrying any of them is passed over for the next file rather than quoted.
export const PROBE_UNSAFE_NAME = /[%^&!"$`\\']/;

export function pickProbeTarget(dir, { limit = 20, maxBytes = 1024 * 1024 } = {}) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const names = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  let examined = 0;
  for (const name of names) {
    if (examined >= limit) break;
    if (PROBE_UNSAFE_NAME.test(name)) continue;
    const full = path.join(dir, name);
    let size;
    try { size = fs.statSync(full).size; } catch { continue; }
    if (size === 0 || size > maxBytes) continue;
    examined++;
    let head = '';
    try {
      const fd = fs.openSync(full, 'r');
      try {
        const buf = Buffer.alloc(Math.min(8192, size));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        head = buf.toString('utf8', 0, n);
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    const token = pickProbeToken(head, name);
    if (token) return { name, token };
  }
  return null;
}

// The token rules, in one place so the test can state them:
//   - never the first line (index 0), which is the guessable one;
//   - MIN_SIGHT_TOKEN+ characters after trimming, so it is content;
//   - printable ASCII only;
//   - unrelated to the file name in either direction, since the name is the one
//     part of this that travels on the command line.
export function pickProbeToken(text, name = '', { max = 60 } = {}) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim().slice(0, max).trim();
    if (t.length < MIN_SIGHT_TOKEN) continue;
    if (!PRINTABLE_ASCII_LINE.test(t)) continue;
    if (name && (t.includes(name) || name.includes(t))) continue;
    return t;
  }
  return null;
}

// Positive, per-job, per-cwd proof that codex's sandbox can read files where
// this job is about to run. Two modes, in order:
//   cwd-file  — read a file that already exists in the job's --cd, by relative
//               name, with the probe's own cwd set to it. Proves sandboxed reads
//               work in the directory the model will be reading.
//   job-nonce — nothing readable in the cwd (empty, or all binary): write the
//               nonce into the JOB dir and read it by absolute path, still from
//               the job cwd. Weaker, and recorded as such: it proves sandbox exec
//               works from that cwd, not that the cwd itself is readable.
function sightProbe(bin, cwd, jobDir) {
  // NOT `broken`. A directory that is not there is a probe that cannot be POSED,
  // not a sandbox that has been shown unable to read — and `broken` means
  // `sandbox-blind-precheck`, whose cure is "reinstall codex", which fixes
  // nothing about a typo in `--cd`. Same distinction the transport failures in
  // `sandboxRead` already make (DECISIONS.md: a probe that could not be RUN is
  // not a probe that found blindness). `cmdDispatch` refuses a missing cwd up
  // front, so reaching this line means it went away in between.
  if (!fs.existsSync(cwd)) {
    return { state: 'probe-error', mode: 'none', detail: `the job cwd does not exist: ${cwd}` };
  }
  const target = pickProbeTarget(cwd);
  if (target) {
    return { ...sandboxRead(bin, target.name, { cwd, token: target.token }), mode: `cwd-file:${target.name}` };
  }
  const nonce = `codex-dispatch-sight-${Date.now()}-${process.pid}`;
  const file = path.join(jobDir, 'sight-probe.txt');
  fs.writeFileSync(file, nonce + '\n');
  return { ...sandboxRead(bin, file, { cwd, token: nonce }), mode: 'job-nonce' };
}

// Returns { bin } or exits loudly. With CODEX_DISPATCH_BIN set the checks are
// skipped: the override is trusted (that is its point, for tests and stand-ins).
function preflight({ quiet } = {}) {
  // Before anything else, including the override below: a jobs root that cannot
  // survive a cmd.exe command line breaks every job this install will ever run,
  // and preflight is where an install-level fault belongs. It is checked at
  // dispatch too, because that is where the value is read for a launch.
  assertJobsRootQuotable(jobsRoot());
  // TEST HOOK: the pin below is the whole of preflight when it is set, so every
  // check this function exists to make — version, auth, the sandbox probe and the
  // three warnings hanging off it — has never once executed under test. This
  // forces them to run against the pinned bin. Only the SHORT-CIRCUIT is
  // injected; each check below is the real one, posed at a stand-in that answers
  // `--version` and `login status` the way codex-cli does, because a preflight
  // that has never been run is a preflight nobody knows the shape of.
  if (process.env.CODEX_DISPATCH_BIN && !process.env.CODEX_DISPATCH_TEST_PREFLIGHT_FULL) {
    if (!quiet) console.log(`preflight: using CODEX_DISPATCH_BIN override (${process.env.CODEX_DISPATCH_BIN})`);
    return { bin: process.env.CODEX_DISPATCH_BIN };
  }
  const bin = resolveBin();
  if (!bin) fail('preflight: codex CLI not found. Install it: npm install -g @openai/codex');
  const version = runCodexSync(bin, ['--version']);
  if (version.status !== 0) fail(`preflight: "${bin} --version" failed. Install it: npm install -g @openai/codex`);
  const login = runCodexSync(bin, ['login', 'status']);
  if (login.status !== 0) {
    fail(`preflight: codex (${bin}) is not authenticated. Run: codex login (interactive browser OAuth — yours to run, never scripted).`);
  }

  // `codex` on PATH is the desktop app on a machine with both installed, and
  // naming the file it actually resolves to is the whole diagnosis.
  const binPath = path.isAbsolute(bin) ? bin : (whereHits(bin)[0] || bin);
  const binLabel = binPath === bin ? bin : `${bin} (-> ${binPath})`;

  const sandbox = sandboxProbe(bin);
  // `unprovable` means the probe could not be POSED as a proof (no usable token,
  // or one an echo could return). That is not a working sandbox either, and
  // saying "ok" about it would be the same politeness the sight gate exists to
  // refuse — so it fails in the same place, with its own detail.
  if (sandbox.state === 'broken' || sandbox.state === 'unprovable') {
    const msg =
      `preflight: codex sandbox is NOT functional — every job would run blind.\n` +
      `bin: ${binLabel}\n` +
      `probe: ${sandbox.detail}\n` +
      (isDesktopApp(binPath)
        ? 'That binary IS the desktop-app build, which ships without the Windows sandbox\n' +
          'helpers (codex-windows-sandbox-setup.exe).\n'
        : 'This is what the desktop-app build does — it ships without the Windows sandbox\n' +
          'helpers (codex-windows-sandbox-setup.exe). Check which binary is being resolved.\n') +
      'Inside a blind job, every file read fails while codex still exits 0, so the answer\n' +
      'is confident and sourceless. Fix: npm install -g @openai/codex (the npm build vendors\n' +
      `the helpers), then set CODEX_DISPATCH_BIN to %APPDATA%\\npm\\codex.cmd or put it first on PATH.`;
    if (WIN) fail(msg);
    process.stderr.write(msg + '\nNot fatal here: Windows is the platform this probe is verified on.\n');
  }
  if (sandbox.state === 'probe-error') {
    // NOT a blindness verdict: the probe never ran, so it found nothing. Saying
    // "your sandbox is broken" here would blame the binary for a spawn failure.
    process.stderr.write(
      `preflight: WARNING — the sandbox probe could not be RUN, so nothing is known about it.\n` +
      `bin: ${binLabel}\n` +
      `probe: ${sandbox.detail}\n` +
      `This is a transport failure (the process would not launch or produced nothing), not evidence\n` +
      `that codex cannot see. Dispatches will be refused as "sight-probe-error" rather than as blind.\n` +
      `Re-run preflight; if it persists, check that ${binLabel} runs by hand.\n`
    );
  }
  if (sandbox.state === 'unavailable') {
    process.stderr.write(
      `preflight: WARNING — this codex has no "sandbox" subcommand, so sight cannot be proven\n` +
      `(${sandbox.detail}). Dispatches will be REFUSED as "sight-unproven" — deliverability requires\n` +
      `a proven read. Fix: npm install -g @openai/codex. To accept unproven answers knowingly,\n` +
      `dispatch with --allow-unproven-sight; the record and every result will say so.\n`
    );
  }
  if (!quiet) {
    console.log('preflight: ok');
    console.log(`bin: ${binLabel}`);
    console.log(`version: ${(version.stdout || '').trim()}`);
    console.log(`auth: ${(login.stdout || login.stderr || '').trim()}`);
    console.log(`sandbox: ${sandbox.state}${sandbox.state === 'functional' ? ' (file reads work inside --sandbox read-only)' : ''}`);
  }
  return { bin };
}

// -------------------------------------------------------------- role claims
//
// The same-role guard used to be a scan-then-create: read every job, find none
// live, create the dir. Two dispatches running that concurrently both read an
// empty world and both proceed — precisely the double-billing this runtime
// exists to prevent. `mkdir` is the one filesystem operation where exactly one
// racer can win, so the role is claimed by creating a directory: EEXIST is the
// answer, not an error. The scan survives as a backstop for jobs that predate
// claims or whose claim was removed by hand.

const ROLE_LOCKS = '.role-locks';

// A role becomes a path segment, so it is whitelisted before it is joined and the
// result is proved to be inside the jobs root. Both checks are here rather than
// at the call sites: this is the only function that turns a role into a path.
function roleLockDir(root, role) {
  if (typeof role !== 'string' || !ROLE_RE.test(role)) {
    fail(
      `REFUSING to use ${JSON.stringify(clean(String(role)).slice(0, 80))} as a role.\n` +
      `Roles must match ${ROLE_RE} — a role names a lock directory that a release renames away and\n` +
      `then removes recursively, so anything else is refused before it can become a path.`
    );
  }
  return assertInsideRoot(root, path.join(root, ROLE_LOCKS, role), 'use a role-lock directory');
}

const claimOwnerPath = (lockDir) => path.join(lockDir, 'owner');

// READ BOUNDARY for the claim owner. The `owner` file is a plain file in a
// directory anything can write, and its contents are joined to the jobs root to
// find the job whose pid files a reclaim will kill, whose files it will rename,
// and whose directory it may remove. An owner of `../not-a-job-dir` did exactly
// that in review — killed an unrelated process, wrote reaped.pids outside the
// jobs root, renamed files there, and exited 0 saying "reaped unvouched-for job"
// (Claude arm, 2026-08-06, reproduced).
//
// So the value is whitelisted HERE, and a caller can never receive an unusable
// owner as though it were a usable one: it arrives as `invalid`, which is a
// corrupt claim, which is a loud refusal.
export function parseClaimOwner(raw) {
  if (typeof raw !== 'string') return { owner: null };
  const text = raw.trim();
  if (!text) return { owner: null };
  if (!JOB_ID_RE.test(text)) return { owner: null, invalid: clean(text).slice(0, 120) };
  return { owner: text };
}

// A READ THAT FAILED AND A CLAIM THAT NAMED NOBODY are two different answers, and
// they used to arrive as the same `{ owner: null }`. `unreadable` is what tells
// them apart — see inspectClaim and releaseRole, both of which decide whether to
// rename a live claim away on the strength of it.
function readClaimOwner(lockDir) {
  try { return parseClaimOwner(fs.readFileSync(claimOwnerPath(lockDir), 'utf8')); }
  catch (err) { return { owner: null, unreadable: clean(err.code || err.message).slice(0, 40) }; }
}

function claimAge(lockDir) {
  try { return Date.now() - fs.statSync(lockDir).mtimeMs; } catch { return Infinity; }
}

// The claim is BUILT ELSEWHERE AND MOVED INTO PLACE, so the lock directory and
// the owner file inside it come into existence in one atomic step.
//
// mkdir-then-write-owner left a fence to fall off: a claimer descheduled between
// the two could be judged ownerless, reclaimed, and then wake up and write its own
// name over the new owner's — two dispatches, each able to read its own id back
// out of the lock. Staging the whole claim and renaming it in removes the window
// by construction. Rename onto an existing non-empty directory fails on every
// platform this runs on (EEXIST/ENOTEMPTY on POSIX, ERROR_ALREADY_EXISTS or
// ERROR_ACCESS_DENIED on Windows), and the lock directory is never empty — the
// owner file is inside it before it lands — so a failed rename is the "someone
// else has it" answer, the same role EEXIST played before.
function tryClaim(root, role, jobId) {
  const locks = path.join(root, ROLE_LOCKS);
  fs.mkdirSync(locks, { recursive: true });
  const lockDir = roleLockDir(root, role);
  // Staging and tombstone names begin with a dot; roles are [a-z]+, so neither
  // can ever collide with a real role lock.
  const stage = path.join(locks, `.staging-${role}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(stage, { recursive: false });
  try {
    // temp + rename INSIDE the staging directory: the owner file is never
    // observable half-written, not even by a reader that catches the claim the
    // instant it lands.
    const tmp = path.join(stage, 'owner.tmp');
    fs.writeFileSync(tmp, jobId + '\n');
    fs.renameSync(tmp, claimOwnerPath(stage));
    try {
      fs.renameSync(stage, lockDir);
    } catch {
      return false;
    }
  } finally {
    // A no-op once the rename succeeded — the staging directory is the lock now.
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  return verifyClaim(lockDir, jobId);
}

// Verify-own-claim. Winning the race is not the same as still holding it: the
// reclaim path renames the whole lock directory away, atomically, so a dispatch
// descheduled between claiming and launching can wake up holding nothing at all.
// Reading the owner back is how it finds out — and it has to, because the
// alternative is launching a second codex beside the job that legitimately took
// the role over.
export function verifyClaim(lockDir, jobId) {
  return readClaimOwner(lockDir).owner === jobId;
}

// Reclaiming is a RENAME, not an rm. It is atomic, so exactly one reclaimer can
// win it and a second gets ENOENT rather than quietly deleting the winner's fresh
// claim; and the moment it returns, the old lock is unreachable by name, which is
// what makes a resumed claimer's verify fail. The tombstone is deleted afterwards
// at leisure — that part never had to be atomic.
//
// IT IS ALSO CONDITIONAL ON THE OWNER, which is the ABA race this closes (Codex
// arm, round three): inspect owner A, be descheduled, another dispatch installs
// its own claim B and passes its own fence, resume, and rename B's claim away —
// leaving B running with no claim and the role free for a third dispatch. Reading
// the owner before the rename narrows the window but cannot close it, because the
// read and the rename are two operations. So the check that decides is AFTER the
// rename, on the thing actually moved: if it is not the claim that was inspected,
// it is put straight back and the reclaim fails.
//
// `expected` is the owner the caller inspected, and OWNERLESS IS AN EXPECTATION
// TOO. It used to be `undefined` — "whatever is there" — which skipped both
// fences, and both call sites reached it by mapping a null owner onto it. So a
// reclaim judged against a claim that named nobody renamed away whatever held
// the role at the moment of the rename, including a claim installed since: a
// fresh dispatch that had already passed its own verify fence (see cmdDispatch)
// and launched. Two same-role codexes, out of a claim that was ownerless one
// read ago. `null` therefore means "the claim must STILL name nobody", checked
// before the rename and proved on the thing actually moved afterwards, exactly
// as a named owner is.
// Exported for the unit tests: the fence is two filesystem operations with a
// window between them, and the window is not reachable from a spawned verb.
export function reclaimClaim(root, role, expected) {
  const lockDir = roleLockDir(root, role);
  const tomb = assertInsideRoot(
    root,
    path.join(root, ROLE_LOCKS, `.reclaimed-${role}-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`),
    'stage a reclaimed role lock'
  );
  if (readClaimOwner(lockDir).owner !== expected) {
    return { ok: false, reason: 'the claim changed hands before it could be reclaimed' };
  }
  try {
    fs.renameSync(lockDir, tomb);
  } catch (err) {
    // Already gone: somebody else got there first, which is the same outcome.
    return err.code === 'ENOENT' ? { ok: true, gone: true } : { ok: false, reason: clean(err.message) };
  }
  const moved = readClaimOwner(tomb).owner;
  if (moved !== expected) {
    // We just took a claim that was not the one we judged. Put it back — one
    // rename, the same atomic primitive — and refuse. A restore that itself
    // fails is reported, because a claim left in a tombstone is a role nobody
    // holds and everybody may take.
    let restored = false;
    try { fs.renameSync(tomb, lockDir); restored = true; } catch { /* reported below */ }
    const name = (o) => (o === null ? '(none)' : JSON.stringify(clean(String(o))));
    return {
      ok: false,
      aba: true,
      restored,
      reason:
        `the claim changed hands during the reclaim (expected owner ${name(expected)}, ` +
        `moved ${name(moved)})${restored ? ' — it has been put back' : ''}`,
    };
  }
  try { fs.rmSync(tomb, { recursive: true, force: true }); } catch { /* best effort */ }
  return { ok: true };
}

// Only ever releases OUR claim: a release that cannot name itself as the owner
// would hand the role to whoever raced in behind it.
//
// The role arrives from a record, which is a file anything can write, and this is
// the function that renames a directory away and then removes it recursively —
// so a role that is not a role is refused here rather than joined. A record
// carrying `role: "..\\..\\victim"` reached exactly this rename in review; the
// record is now corrupt long before it gets here, and this check is the second
// lock on the same door.
function releaseRole(root, role, jobId) {
  if (!role) return;
  if (typeof role !== 'string' || !ROLE_RE.test(role)) {
    process.stderr.write(
      `WARNING: refusing to release a role claim named ${JSON.stringify(clean(String(role)).slice(0, 80))} — ` +
      `that is not a role (${ROLE_RE}), so it names no lock this runtime created. Nothing was touched.\n`
    );
    return;
  }
  const lockDir = roleLockDir(root, role);
  if (!fs.existsSync(lockDir)) return;
  const { owner, invalid, unreadable } = readClaimOwner(lockDir);
  // An unreadable owner is not proof the claim is ours, and releasing it would
  // hand the role away on a guess. That was only half true until `readClaimOwner`
  // could say which kind of "no owner" it meant: a read that THREW arrived here as
  // `{ owner: null }`, sailed past this line and past the ownership check below,
  // and released the claim with no fence at all. Not releasing costs nothing —
  // this job is terminal, so the next dispatch reclaims the role through
  // `inspectClaim`, fence and all.
  if (invalid !== undefined || unreadable !== undefined) return;
  if (owner && jobId && owner !== jobId) return;
  // Conditional on the owner still being the one just read — the release side of
  // the same ABA race as the reclaim side. `owner` may legitimately be null (a
  // claim with no owner file), and that is passed through AS null rather than as
  // "no expectation": ownerless is a state of the claim, and the claim that
  // replaced it a millisecond ago is not.
  const done = reclaimClaim(root, role, owner ?? null);
  if (!done.ok) {
    process.stderr.write(
      `WARNING: did not release the "${role}" role claim held by ${clean(String(jobId))}: ${done.reason}.\n` +
      `Another dispatch owns it now; releasing it would have handed the role to a third.\n`
    );
  }
}

// live        — a dispatch is mid-claim right now; nobody may take it
// conflict    — the owner job may still have processes; --force territory
// reclaimable — the owner is terminal, corrupt, or gone
//
// `reapFirst` marks the reclaimable cases whose owner cannot vouch for itself: a
// corrupt record, or no record at all. Those say NOTHING about whether processes
// are alive, which is not the same as saying they are dead — so the role does not
// change hands until they have been killed and the kill verified.
function inspectClaim(root, lockDir) {
  const { owner, invalid, unreadable } = readClaimOwner(lockDir);
  const age = claimAge(lockDir);
  // An owner that is not a job id is CORRUPT, not "an owner we will do our best
  // with". Nothing is derived from it, nothing is reaped, nothing is reclaimed:
  // this claim needs a human to look at it.
  if (invalid !== undefined) {
    return { status: 'corrupt', owner: null, invalid, lockDir, detail: 'the claim owner is not a job id' };
  }
  if (!owner) {
    // An owner that could not be READ is not a claim standing there ownerless.
    // The claim is built elsewhere and renamed into place with its owner file
    // already inside (see tryClaim), so a failed read means the claim was caught
    // mid-install, or vanished under this inspection and something else is in its
    // place now. Answering `reclaimable` sent `reclaimClaim` in with
    // `expected: undefined`, which skipped the owner fence and renamed away
    // whatever held the role at that moment — a live claim installed a
    // millisecond ago, destroyed on a read error. That fence is closed on the
    // other side now (an ownerless claim is expected AS ownerless, before and
    // after the rename), and this reading stays because the two halves guard
    // different things: the fence stops the wrong claim being taken, and this
    // stops a young claim being judged at all.
    //
    // Time-boxed like every other "cannot tell yet" here: `claimAge` reads the
    // lock directory, so this is only ever taken while something young is really
    // there, and an owner file still unreadable past the grace window goes down
    // the reclaimable path as before rather than blocking the role for ever.
    if (unreadable !== undefined && age < CLAIM_GRACE_MS) {
      return { status: 'live', owner: null, age, detail: `the claim owner could not be read (${unreadable})` };
    }
    return age < CLAIM_GRACE_MS
      ? { status: 'live', owner: null, age }
      : { status: 'reclaimable', owner: null, detail: 'the claim never named an owner' };
  }
  // Whitelisted at the read boundary above; proved inside the root here.
  const dir = jobDirFor(root, owner);
  if (!dir) {
    return { status: 'corrupt', owner: null, invalid: owner, lockDir, detail: 'the claim owner does not name a job directory inside the jobs root' };
  }
  if (!fs.existsSync(recordPath(dir))) {
    if (age < CLAIM_GRACE_MS) return { status: 'live', owner, age };
    // No record, but a job dir may still be there carrying pid files: a supervisor
    // that registered its process and never got a record written is exactly the
    // shape that must be reaped before anyone else runs under this role.
    return {
      status: 'reclaimable', owner, dir, reapFirst: fs.existsSync(dir),
      detail: `owner job ${owner} left no record`,
    };
  }
  const job = { id: owner, dir, record: readRecord(dir) };
  if (isCorrupt(job.record)) {
    return {
      status: 'reclaimable', owner, dir, reapFirst: true,
      detail: `owner job ${owner} has a corrupt record`,
    };
  }
  const state = effectiveState(job);
  if (LIVE_STATES.includes(state)) return { status: 'conflict', owner, job, state };
  return { status: 'reclaimable', owner, dir, detail: `owner job ${owner} is ${state}` };
}

function claimRole(root, role, jobId, { force } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryClaim(root, role, jobId)) return { ok: true };
    const lockDir = roleLockDir(root, role);
    const claim = inspectClaim(root, lockDir);
    if (claim.status === 'corrupt') return { ok: false, message: corruptClaimMessage(role, lockDir, claim) };
    if (claim.status === 'live') {
      return {
        ok: false,
        message:
          `dispatch: another dispatch is claiming role "${role}" right now ` +
          `(claim is ${Math.max(0, Math.round(claim.age))}ms old${claim.owner ? `, owner ${claim.owner}` : ''}).\n` +
          `Exactly one dispatch per role may win that race — this one lost. Retry in a moment, or pick another --role.`,
      };
    }
    if (claim.status === 'conflict') {
      if (!force) return { ok: false, message: conflictMessage(claim.job, claim.state, role) };
      const killed = killJob(claim.job);
      // A JOB THAT FINISHED IS NOT A CONFLICT. It reached its own verdict while
      // the force was deciding, so there is nothing to kill and nothing to
      // refuse: the role is releasable by ROLE_RELEASE_STATES' own definition,
      // and the reclaim below takes it. The one thing that must not happen is
      // this force reporting a kill it never made.
      if (killed.terminal) {
        console.log(terminalKillNote(claim.job.id, killed));
      } else if (!killed.ok) {
        return {
          ok: false,
          message: killed.unrecorded
            ? unrecordedKillMessage(role, claim.job.id, killed)
            : killed.pending
              ? killPendingMessage(claim.job, role)
              : killFailedMessage(claim.job, killed),
        };
      } else {
        console.log(`killed previous job: ${claim.job.id} (was ${claim.state})`);
      }
    }
    // A reclaimable-but-unvouched-for owner gets the same verified-kill discipline
    // as a stale one. "The record is unreadable" is not "the processes are gone",
    // and taking the role on that assumption is how a second codex ends up running
    // beside the first — which is the one failure this whole runtime is built to
    // prevent, so a survivor refuses the takeover rather than proceeding past it.
    if (claim.status === 'reclaimable' && claim.reapFirst) {
      const reaped = reapUnvouchedJob(root, claim.dir);
      if (!reaped.ok) return { ok: false, message: reapFailedMessage(role, claim, reaped) };
      if (reaped.killed.length) {
        console.log(
          `reaped unvouched-for job before taking role "${role}": ` +
          `${claim.owner} (pids ${reaped.killed.join(', ')})`
        );
      }
    }
    // Take the claim away CONDITIONALLY: reclaimClaim re-reads the owner before
    // the rename and re-checks what it actually moved afterwards, putting a
    // stranger's claim straight back. A reclaim that loses that race is not an
    // error — it means somebody else owns the role now — so the loop retries and
    // re-inspects rather than launching. An OWNERLESS claim is expected as null,
    // not as "whatever is there": the fresh claim standing where the ownerless
    // one was is the one this used to rename away, out from under a dispatch
    // that had already verified it and launched.
    const reclaimed = reclaimClaim(root, role, claim.owner ?? null);
    if (!reclaimed.ok) continue;
  }
  return {
    ok: false,
    message:
      `dispatch: could not claim role "${role}" — the claim was retaken while this dispatch was ` +
      `clearing it. Retry, or pick another --role.`,
  };
}

// ---------------------------------------------------------------------- kills

// What a tree kill actually targets, per platform, as data — so the choice can be
// asserted on either platform rather than only on the one running the suite.
//
// Windows: `taskkill /T` walks the tree itself, and that path is the tested,
// first-class one. Elsewhere there was no tree at all: killTree signalled the two
// recorded pids and nothing else, so codex's own sandbox children survived a
// cancel (Claude arm, 2026-08-06). The supervisor and codex are both spawned
// detached on POSIX, which makes each of them a process-group leader, so the
// group is the tree — `kill(-pgid)` reaches every descendant that did not
// deliberately leave it. The bare pid follows as a fallback for the case where
// the group no longer exists (leader gone, group empty) but the process does.
export function killPlan(pid, win = WIN) {
  // THE PID DOMAIN IS PART OF THE PLAN. `killPlan(-1)` used to answer
  // `{ signals: [1, -1] }` off Windows: signal pid 1, then signal EVERY process
  // this account may signal. One corrupt record with `supervisorPid: -1` is a
  // machine-wide kill. Nothing outside the domain gets a plan at all.
  if (!isPid(pid)) {
    return { refuse: `${JSON.stringify(pid)} is not a pid (integers ${PID_MIN}..${PID_MAX})` };
  }
  if (win) return { tool: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  return { signals: [-pid, pid] };
}

function killTree(pid) {
  const plan = killPlan(pid);
  if (plan.refuse) {
    if (pid !== null && pid !== undefined && pid !== 0) {
      process.stderr.write(`WARNING: refusing to signal ${plan.refuse}. Nothing was killed.\n`);
    }
    return;
  }
  // Test-only: simulate a kill that does not take effect, so the verified-kill
  // path has a regression test that does not depend on finding a genuinely
  // unkillable process. Never set outside the suite.
  if (process.env.CODEX_DISPATCH_TEST_NOKILL) return;
  if (plan.tool) { spawnSync(plan.tool, plan.args, { stdio: 'ignore', windowsHide: true }); return; }
  for (const target of plan.signals) {
    try { process.kill(target, 'SIGKILL'); } catch { /* already gone, or never a group */ }
  }
}

// ------------------------------------------------------ the tree, for real
//
// A kill is only verified if the thing verified is the thing that bills. On
// Windows the recorded `codexPid` is the CMD.EXE WRAPPER whenever codex is a
// `.cmd` (which is the npm build, i.e. the supported one): `spawn` with
// `shell: true` returns the shell's pid, and the real worker is its child.
// Measured live during review: wrapper 43124, worker 40732, ppid 43124. Every
// `killPids`/`waitGone` therefore verified a proxy — a surviving worker left the
// job marked `killed`, the role released, and the next dispatch running beside a
// codex that was still going. `kill-failed` could not fire.
//
// So the process table is read and the tree is walked: descendants are killed
// alongside their recorded ancestors, and any that remain afterwards are
// survivors. Returns a Map<pid, ppid>, or null when the table cannot be read —
// which is reported, never silently treated as "the tree is empty".
function processTable() {
  const parse = (text) => {
    const table = new Map();
    for (const line of String(text).split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)[\s,]+(\d+)$/);
      if (m) table.set(Number(m[1]), Number(m[2]));
    }
    return table.size ? table : null;
  };
  // Test-only: the table cannot be read at all — a host where PowerShell will
  // not run, a WMI service that is down, a `ps` that is not on PATH. Producing
  // that on demand in CI is not possible; what is under test is the DECISION
  // every caller then makes, that a kill nothing could enumerate is not a
  // verified kill. Never set outside the suite.
  if (process.env.CODEX_DISPATCH_TEST_NO_PROCESS_TABLE) return null;
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 15000 };
  if (!WIN) {
    const r = spawnSync('ps', ['-eo', 'pid=,ppid='], opts);
    return r.status === 0 ? parse(r.stdout) : null;
  }
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }';
  for (const shell of ['powershell', 'pwsh']) {
    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], opts);
    if (r.status === 0) {
      const table = parse(r.stdout);
      if (table) return table;
    }
  }
  return null;
}

// Every live process descended from any of `roots`, excluding the roots.
export function descendantsOf(roots, table) {
  if (!table) return null;
  const wanted = new Set(roots.filter(isPid));
  const out = new Set();
  // Bounded by the table size: a cycle in reported parentage (pid reuse can
  // manufacture one) must not spin.
  for (const [pid, ppid] of table) {
    if (!isPid(pid)) continue;
    let cursor = ppid;
    for (let hops = 0; hops < table.size && isPid(cursor); hops++) {
      if (wanted.has(cursor)) { if (!wanted.has(pid)) out.add(pid); break; }
      const next = table.get(cursor);
      if (next === undefined || next === cursor) break;
      cursor = next;
    }
  }
  return [...out];
}

// A CHILD CANNOT PREDATE ITS PARENT, and that is the only thing standing between
// the walk above and an adopted stranger.
//
// Windows leaves a dead parent's pid sitting in the ppid field of every surviving
// child, and pid numbers are reissued. So the moment one of those numbers is
// handed to the cmd.exe wrapper this runtime just spawned, some unrelated process
// that outlived the ORIGINAL owner of that number appears in the table as our
// descendant. It is then recorded in `codexPids` together with ITS OWN CURRENT
// start time (see the supervisor's `startTimesFor`) — which is what makes the
// forgery complete: the identity check at kill time compares that recorded start
// time against itself and waves the stranger through. The runtime signs the
// papers itself, and then fires `taskkill /PID <n> /T /F` at somebody else's tree.
//
// So an edge whose child started BEFORE its supposed parent is a lie, and it is
// removed from the table before the walk is re-run — which drops the stranger and
// everything reachable only through it, rather than just the one pid.
//
// NOTE THE DIRECTION. Everywhere else the start-time machinery only ever
// SUBTRACTS from a kill list, and the file's rule is that it may only subtract
// what it can DISPROVE. That rule holds here — the edge is subtracted only on
// evidence that contradicts parentage outright, and absence of a start time on
// either side is no opinion and leaves the edge standing. But the thing being
// dropped is a KILL TARGET, so if this were ever wrong it would spare a real
// descendant rather than spare a stranger. That trade is worth taking precisely
// because the pids this can drop were never recorded by the job: a pid the job
// wrote down is a target in its own right and never reaches this walk, so the
// only thing at risk is a descendant found by inference — and inference from a
// ppid field that the OS itself does not keep honest.
export function livingDescendantsOf(roots, table) {
  const kin = descendantsOf(roots, table);
  if (!kin || !kin.length) return kin;
  // One batched query: the candidates, and the parents the table claims for them.
  const claimed = new Map(kin.map((pid) => [pid, table.get(pid)]));
  const starts = pidStartTimes([...kin, ...claimed.values()].filter(isPid));
  const lying = kin.filter((pid) => startedBefore(starts.get(pid), starts.get(claimed.get(pid))));
  if (!lying.length) return kin;
  const pruned = new Map(table);
  for (const pid of lying) pruned.delete(pid);
  return descendantsOf(roots, pruned);
}

// Strictly before, by more than the slop `sameStartTime` already allows: a parent
// and the child it spawns a millisecond later cannot be ordered by this clock, and
// "no opinion" is the only honest reading of two times that close. Unparseable or
// absent on either side is no opinion too.
function startedBefore(child, parent) {
  const a = Date.parse(child ?? '');
  const b = Date.parse(parent ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return a < b - START_TIME_SLOP_MS;
}

// The real process(es) behind a shell wrapper. Polled rather than read once,
// because cmd.exe takes a moment to start what it was asked to start, and an
// empty answer here is the difference between verifying codex and verifying a
// proxy. Bounded: a wrapper that never produces a child is reported, not waited
// on forever.
const WORKER_RESOLVE_MS = 5000;
const WORKER_POLL_MS = 200;

function resolveWorkerPids(wrapperPid, { timeoutMs = WORKER_RESOLVE_MS } = {}) {
  if (!isPid(wrapperPid)) return [];
  // Monotonic, like every other in-process wait bound here: a wall-clock step
  // must not be able to shorten or extend a poll a caller is blocked in.
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const table = processTable();
    const kin = livingDescendantsOf([wrapperPid], table);
    if (kin && kin.length) return kin;
    if (!pidAlive(wrapperPid)) return kin || [];
    if (performance.now() >= deadline) return kin || [];
    sleepSync(WORKER_POLL_MS);
  }
}

// POSIX: the process group codex leads is the tree there, so an empty group is
// part of the proof. `kill(-pgid, 0)` raises ESRCH exactly when no process is
// left in it; anything else (EPERM included) means something is.
function groupAlive(pgid) {
  if (WIN || !isPid(pgid)) return false;
  try { process.kill(-pgid, 0); return true; } catch (err) { return livenessFromError(err); }
}

// taskkill's exit code lies often enough to be useless (it reports success for
// "process not found" and failure for children it already reaped with the tree),
// so the kill is verified by asking the OS afterwards, not by trusting the tool.
function waitGone(pids, ms = KILL_VERIFY_MS) {
  const deadline = performance.now() + ms;
  let alive = pids.filter(pidAlive);
  while (alive.length && performance.now() < deadline) {
    sleepSync(50);
    alive = alive.filter(pidAlive);
  }
  return alive;
}

// Kills every pid AND everything descended from it, and reports what is still
// alive afterwards.
//
// Returns { survivors, targets, enumerated }. `enumerated: false` means the
// process table could not be read, so the descendants were never known — the
// callers treat that as "this kill could not be fully verified" rather than as
// "there was nothing there", which is the whole point of the field.
//
// Two rounds, because a tree can grow between the enumeration and the kill: a
// wrapper that has not yet started its worker, a codex still spawning its sandbox
// helpers. Two is enough for that and bounded enough not to become a loop.
function killPids(pids, { rounds = 2 } = {}) {
  const targets = [...new Set(pids.filter(isPid))];
  if (!targets.length) return { survivors: [], targets: [], enumerated: true };
  const fired = new Set(targets);
  let enumerated = true;

  for (let round = 0; round < rounds; round++) {
    const table = processTable();
    if (!table) enumerated = false;
    // Descendants are only meaningful for a parent that is alive: a dead pid's
    // recorded parentage is stale on Windows and can name a REUSED number.
    const live = targets.filter(pidAlive);
    const kin = table ? (livingDescendantsOf(live, table) || []) : [];
    for (const pid of kin) fired.add(pid);
    for (const pid of [...fired]) killTree(pid);
    if (!waitGone([...fired]).length) break;
  }

  const alive = waitGone([...fired]);
  // Anything still descended from what was targeted is a survivor too, even if
  // it was never a recorded pid: that is precisely the codex worker behind a
  // cmd.exe wrapper.
  const after = processTable();
  if (!after) enumerated = false;
  const leftovers = after ? (livingDescendantsOf([...fired], after) || []) : [];
  return {
    survivors: [...new Set([...alive, ...leftovers.filter(pidAlive)])],
    targets: [...fired],
    enumerated,
  };
}

// ENUMERATION IS HALF THE VERIFICATION, and `enumerated: false` is how killPids
// says it never happened: neither shell would answer, so the descendants were
// never known and the leftover sweep looked at nothing. The recorded pids can be
// gone while the codex behind a cmd.exe wrapper is not — which is precisely the
// process this runtime spent a release learning to verify — so "nothing was
// seen" may not be read as "nothing survived". Every caller treats it as a kill
// that could not be verified: `kill-failed`, the role kept, and a re-run once
// the table can be read again.
const UNENUMERATED_KILL = WIN
  ? 'the kill could not be verified: the process table could not be read (both powershell and pwsh ' +
    'failed), so nothing enumerated the tree behind these pids'
  : 'the kill could not be verified: the process table could not be read (ps -eo pid=,ppid= failed), ' +
    'so nothing enumerated the tree behind these pids';

const UNENUMERATED_ADVICE =
  'A kill nothing could enumerate is not a verified kill: the recorded pids may be gone while a\n' +
  'descendant of theirs — the codex behind a shell wrapper — is not. Re-run this once the process\n' +
  'table can be read again (Get-CimInstance Win32_Process on Windows, ps elsewhere).\n' +
  'The pid files stay LOADED, because nothing here proved those numbers are spent: the retry fires\n' +
  'at the same numbers again, filtered only by the start-time identity a readable record carries.';

// Pids recorded as plain files in the job dir, one or more per file, both
// written by this runtime. These are the only kill targets that survive a
// corrupt job.json.
//
// `child.pid` used to be listed here and nothing this runtime ships has ever
// written one — only the tests' fake codex does. That made the fake's grandchild
// a DIRECT kill target, so the two Windows tree-kill tests passed without
// `taskkill /T` having to traverse anything: the one thing they existed to prove
// was the one thing they could not fail on. The POSIX group-kill test already
// deleted the file before cancelling for exactly that reason. It is a test
// artifact, and it is read by the tests, not by this.
const PID_FILES = ['supervisor.pid', 'codex.pid'];
// Mirrors job.json's `reapedPids` for the jobs whose record must NOT be rewritten
// — a corrupt job.json is evidence and stays byte-for-byte — so the fact that a
// number has already been fired at still has somewhere to live. Same relationship
// the .pid files have to the record: a second copy, so a bad record cannot cost
// us the truth.
const REAPED_PIDS_FILE = 'reaped.pids';

function readPidList(file) {
  const pids = [];
  try {
    for (const n of fs.readFileSync(file, 'utf8').split(/\s+/).map(Number)) {
      if (Number.isInteger(n) && n > 0) pids.push(n);
    }
  } catch { /* unreadable pid file: nothing to do */ }
  return pids;
}

// Pids already fired at, from both homes. A reaped pid is never a target again:
// numbers get reused, so a replayed kill lands on whatever inherited it.
export function reapedPids(dir) {
  const spent = new Set(readPidList(path.join(dir, REAPED_PIDS_FILE)));
  const record = readRecord(dir);
  if (!isCorrupt(record) && Array.isArray(record.reapedPids)) {
    for (const n of record.reapedPids) if (Number.isInteger(n) && n > 0) spent.add(n);
  }
  return spent;
}

function recordedPids(dir) {
  const spent = reapedPids(dir);
  const pids = [];
  for (const name of PID_FILES) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    for (const n of readPidList(f)) if (!spent.has(n)) pids.push(n);
  }
  return pids;
}

// Writing the numbers down is what actually makes a reap non-repeatable. The
// rename below is the visible half and it can fail; this half cannot be defeated
// by a locked file, an attribute, or a permission that changed underneath us.
// BOTH copies are merged UNDER THE RECORD LOCK, and both merges are computed from
// reads taken inside it. They used to be computed from reads taken before it, in
// two separate read-modify-writes: two cancels reaping in parallel each wrote its
// own list over the other's, and a lost entry is a spent pid number RE-ARMED —
// fired at again, hours later, at whatever inherited it. The file is the record's
// second copy, so the record's lock is the right one for both.
function recordReapedPids(dir, pids) {
  const list = [...new Set(pids.filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return;
  const mergeFile = () => {
    try {
      const prior = readPidList(path.join(dir, REAPED_PIDS_FILE));
      // Temp file and rename, exactly as job.json gets it. This file exists FOR the
      // case where the record copy is unusable, so a reader catching it half-written
      // — a process killed mid-write, a machine that lost power — would lose the one
      // list that keeps a spent number from being fired at again. A rename is either
      // done or not done.
      const tmp = path.join(dir, `${REAPED_PIDS_FILE}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, [...new Set([...prior, ...list])].join('\n') + '\n');
      renameWithRetry(tmp, path.join(dir, REAPED_PIDS_FILE));
    } catch { /* best effort: the record copy is the other half */ }
  };
  let merged = false;
  updateRecordOutcome(dir, (current) => {
    mergeFile();
    merged = true;
    const prior = Array.isArray(current.reapedPids) ? current.reapedPids : [];
    return { reapedPids: [...new Set([...prior, ...list])] };
  });
  if (merged) return;
  // The callback never ran: the record is corrupt (evidence, never rewritten) or
  // the lock could not be taken. The FILE is the copy that exists precisely for
  // those cases, so it is merged anyway — under the lock when one can be had, and
  // unlocked rather than not at all when it cannot. A lost entry re-arms a spent
  // number, which is the failure this file is here to prevent.
  if (!withRecordLock(dir, mergeFile).locked) mergeFile();
}

// A pid file that has been acted on is spent. Renaming it is what stops a second
// cancel from replaying those numbers against whatever now owns them — pid reuse
// turns a repeated cancel into a kill of an innocent process.
//
// That rename can fail: a handle open on the file, a read-only attribute, a
// permission that moved. Swallowing the failure left the numbers loaded AND left
// the operator believing they had been unloaded, which is the worse half. So the
// failure is returned to be reported, and the pids are written down as reaped
// first — the list, not the filename, is what the next reap consults.
//
// ONLY A FILE WHOSE NUMBERS WERE ACTUALLY FIRED AT IS SPENT. This renamed every
// pid file regardless of which pids the kill had targeted, and the file it can
// destroy that way is the only recorded target an orphan has: a `codex.pid` the
// supervisor wrote moments before it died is renamed out of the way by a cancel
// that never signalled anything in it, and the next cancel finds nothing to fire
// at. So a file is consumed only when every number in it is either in the fired
// set or already recorded as spent; anything else stays loaded and stays a target.
function consumePidFiles(dir, pids = []) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const consumed = [];
  const failed = [];
  recordReapedPids(dir, pids);
  // Read back after the write above, so the durable half of "already fired at"
  // counts here too — a number this caller never aimed at because an earlier
  // cancel had already spent it must not keep its file loaded for ever.
  const fired = new Set([...pids.filter(isPid), ...reapedPids(dir)]);
  for (const name of PID_FILES) {
    const from = path.join(dir, name);
    if (!fs.existsSync(from)) continue;
    if (!readPidList(from).every((n) => fired.has(n))) continue;
    const to = path.join(dir, `${name}.reaped-${stamp}`);
    try {
      // Test-only: a rename that fails on demand. Locking a file hard enough to
      // block a rename is not portable across the two shells and two platforms
      // this suite runs in, and what is under test is the REPORTING, not the lock.
      const failNames = (process.env.CODEX_DISPATCH_TEST_RENAME_FAIL || '').split(/[\s,]+/);
      if (failNames.includes(name)) {
        throw Object.assign(new Error('simulated rename failure'), { code: 'EPERM' });
      }
      fs.renameSync(from, to);
      consumed.push(path.basename(to));
    } catch (err) {
      failed.push(`${name} (${err.code || err.message})`);
    }
  }
  return { consumed, failed };
}

function reapedPidFiles(dir) {
  try { return fs.readdirSync(dir).filter((n) => /\.pid\.reaped-/.test(n)); } catch { return []; }
}

// The verified-kill discipline applied to a job that cannot vouch for itself.
// Its record is evidence and is never rewritten, so the pid files are the only
// kill targets it has — and once fired at, they are consumed.
function reapUnvouchedJob(root, dir) {
  if (!dir || !fs.existsSync(dir)) return { ok: true, killed: [] };
  // Last gate before the killing, renaming and writing starts: this directory
  // came from a claim owner, and a claim owner is untrusted text.
  assertInsideRoot(root, dir, 'reap a job directory');
  const pids = recordedPids(dir);
  if (!pids.length) return { ok: true, killed: [] };
  const killed = killPids(pids);
  // Survivors refuse the takeover — and so does a kill nothing could enumerate
  // (see UNENUMERATED_KILL). This job's record is evidence and is never
  // rewritten, so the refusal IS the safe direction here: the role does not
  // change hands, and the pid files are left loaded rather than consumed,
  // because consuming them would spend targets that were never proved dead.
  if (killed.survivors.length || !killed.enumerated) {
    return {
      ok: false,
      survivors: killed.survivors,
      targets: killed.targets,
      unverified: !killed.enumerated,
    };
  }
  const spent = consumePidFiles(dir, pids);
  if (spent.failed.length) {
    process.stderr.write(
      `WARNING: could not rename spent pid file(s) in ${dir}: ${spent.failed.join('; ')}\n` +
      `Those pids are recorded as reaped in ${REAPED_PIDS_FILE}, so nothing will fire at them again.\n`
    );
  }
  return { ok: true, killed: pids, consumed: spent.consumed, failed: spent.failed };
}

// A job that has no kill target yet, and may already have a supervisor on its
// way to one, is INSIDE ITS REGISTRATION WINDOW. Killing nothing there is not a
// kill, and must not be recorded as one.
//
// The window: dispatch spawned the supervisor, and the supervisor wrote its own
// pid into the record a moment later. A cancel landing in between found no pids,
// "verified" the empty kill, marked the job killed and released the role — while
// the supervisor it never touched went on to launch codex, leaving a second
// same-role dispatch free to start beside it (Codex arm, 2026-08-06).
//
// Two halves close it. Dispatch now records the child pid itself, at spawn time,
// before it returns. And `launch` makes the phase a RECORDED FACT rather than an
// inference from a missing field, which is what lets this tell apart the two
// jobs that look identical from outside:
//   launch: 'pending'  — no supervisor has been spawned at all. Killing nothing
//                        IS the whole kill, and a dispatch still in that phase
//                        re-verifies its claim before it spawns anything, so the
//                        role can be taken from it safely.
//   launch: 'spawning' — a supervisor was spawned and has not been registered.
//                        This is the dangerous one; nothing may call it dead.
// A record with no `launch` at all predates 0.4.0, so it gets the conservative
// reading: time-boxed refusal.
// THERE ARE TWO SUCH WINDOWS, NOT ONE. 0.4.0 closed the first and left the
// second open, in the same shape (Claude and Codex arms both, round three): the
// supervisor spawns codex and records its pid a moment later, so a cancel landing
// in between kills the supervisor, verifies the targets it knows about, marks the
// job `killed` and releases the role — while the codex it never recorded runs on.
//
//   'supervisor' — dispatch spawned a supervisor that has not registered.
//                  Time-boxed, because a supervisor that never arrives must not
//                  block its role forever.
//   'exec'       — the supervisor is about to spawn, or has just spawned, codex.
//                  NOT time-boxed: sight-proving takes as long as it takes, and
//                  the phase is left behind by the supervisor itself the moment
//                  the pids are recorded.
//   'none'       — everything that has a kill target, or provably never will.
export function killWindow(record, now = Date.now(), { supervisorDead = false } = {}) {
  if (!record || isCorrupt(record)) return 'none';
  const phase = launchPhase(record);
  if (phase === 'exec-spawning') {
    // The supervisor is the ONLY process that knows what it just spawned, so it is
    // the only one that can land a cancel here. If it is recorded and provably
    // gone, nobody can, and holding the window would leave the job kill-pending
    // for ever — so it closes and the ordinary verified kill takes over, with the
    // orphan limitation that `stale` already carries.
    if (record.supervisorPid && supervisorDead) return 'none';
    return 'exec';
  }
  if (record.supervisorPid) return 'none';
  if (phase === 'pending') return 'none';
  // 'spawning', or a record with no phase at all (0.3 and earlier), or a phase
  // this release does not recognise — the conservative reading, time-boxed.
  const started = Date.parse(record.started);
  return Number.isFinite(started) && now - started < CLAIM_GRACE_MS ? 'supervisor' : 'none';
}

export function inRegistrationWindow(record, now = Date.now()) {
  return killWindow(record, now) !== 'none';
}

// THE PRECONDITION EVERY RECORD WRITE IN THE KILL SEAM CARRIES: the state must
// still be one this runtime treats as LIVE. `stale` is in LIVE_STATES and is a
// derived reading of a record that says `running`, so it never comes back from
// `canonicalState` — which is exactly why the check is stated against the
// canonical state rather than against `effectiveState`: this is about what the
// record SAYS, evaluated inside the lock, not about what a pid probe concluded a
// moment ago.
export function stillCancellable(record) {
  return !isCorrupt(record) && LIVE_STATES.includes(canonicalState(record));
}

// Returns { ok, survivors, targets }. A kill that cannot be shown to have worked
// is NOT a kill: the job goes to `kill-failed`, keeps its role claim, and keeps
// blocking dispatch — because whatever survived may still be codex, still billing.
//
// `terminal: <state>` is the other non-ok answer: the record reached a verdict of
// its own — `done`, `failed`, a `killed` somebody else landed — before this kill
// could be written down. Nothing is overwritten, because a job that finished is
// not a job this cancel killed; the caller reports the state that is really there.
function killJob(job) {
  // THE CALLER'S SNAPSHOT IS NOT THE RECORD. `job.record` was read at `getJob`
  // time, and everything between there and here is slow: `effectiveState` and the
  // identity check below each spend seconds in a shell. In that gap the
  // supervisor can CAS `launch: 'exec-spawning'` and spawn codex — which off
  // Windows leads its own process group and reparents to init the moment the
  // supervisor dies. Deciding on the snapshot therefore read the window as
  // `none` and the target list as "supervisor only": the kill verified, the
  // leftover sweep found nothing descended from anything, and the job was
  // recorded `killed` with its role released while codex went on billing.
  //
  // So the record is read HERE, and read again after the identity check — the
  // one step long enough for the phase to move underneath it. Both the phase and
  // the pids are re-gathered, because the two sides of that window differ in
  // both: `exec-spawning` has no codex pid to kill, `exec` has one the snapshot
  // never carried. One re-gather is the bound: the supervisor writes the phase
  // and the pids on either side of the window, and a record still moving after
  // that is one being rewritten in a loop, whose phase is the dangerous reading
  // either way.
  const gather = (record) => {
    // THE ANTI-TARGET LIST APPLIES TO EVERY SOURCE, not just to the pid files.
    // `recordedPids` filtered these out and the record fields walked straight
    // past them, so a cancel whose kill worked and whose record write did not —
    // the case the operator is explicitly told to retry, "the pids are already
    // spent, so a retry fires at nothing" — re-armed the very numbers
    // `consumePidFiles` had just written down as spent. Pid numbers get reused;
    // a replayed kill lands on whatever inherited them.
    const spent = reapedPids(job.dir);
    const targets = [];
    if (!isCorrupt(record)) {
      if (record.supervisorPid) targets.push(record.supervisorPid);
      if (record.codexPid) targets.push(record.codexPid);
      // The pids resolved AFTER the spawn — on Windows the real codex worker behind
      // the cmd.exe wrapper that `codexPid` names. This is the field a kill
      // verification has to reach; `codexPid` alone was a proxy.
      if (Array.isArray(record.codexPids)) targets.push(...record.codexPids);
    }
    // When the supervisor is already dead — the stale case — codex has been
    // reparented out of its tree, so /T on the supervisor reaches nothing. Hit the
    // recorded pids directly: harmless when they are already gone, and the only
    // thing that stops an orphan billing. (Non-Windows has no tree kill at all,
    // so it always needed this.)
    targets.push(...recordedPids(job.dir));
    return [...new Set(targets.filter((n) => isPid(n) && !spent.has(n)))];
  };
  let r, written, unique;
  for (let pass = 0; ; pass++) {
    r = readRecord(job.dir);
    written = gather(r);
    // IDENTITY BEFORE THE TRIGGER. These numbers were written down when the job
    // started and may be firing hours later, by which time the OS can have reissued
    // one of them — and `taskkill /PID <n> /T /F` at a reused number kills a
    // stranger's process tree. A pid whose process no longer carries the start time
    // this job recorded is treated as already dead: not fired at, not counted as a
    // survivor. Pids with nothing recorded are unchanged (see `recordedProcesses`).
    unique = recordedProcesses(r, written);
    if (pass >= 1) break;
    // TEST HOOK: stands in for the seconds the identity check above really spends
    // in a shell. A scheduler gap of a chosen length is not producible on demand;
    // what is under test is that the decision below is made on the record as it is
    // NOW rather than as the caller read it. Never set outside the suite.
    sleepSync(testPauseMs('CODEX_DISPATCH_TEST_KILL_PAUSE_MS'));
    const after = readRecord(job.dir);
    // THE STATE IS PART OF "IT MOVED". This compared the phase and the pid list
    // only, so a record whose STATE went from `running` to a terminal verdict in
    // the gap looked unchanged, and the decision below was then made on the
    // pre-pause snapshot: a supervisor that had just written `done` was killed
    // and the answer it produced was overwritten with `killed`.
    if (canonicalState(after) === canonicalState(r) &&
        launchPhase(after) === launchPhase(r) &&
        String(gather(after)) === String(written)) break;
  }
  // THE VERDICT MAY ALREADY HAVE BEEN REACHED, and it is not this cancel's to
  // overwrite. The re-read loop above watched the launch PHASE and the pid list
  // move; the STATE can move in the same gap and used to be invisible here — the
  // supervisor lands `done` or `failed(sight-unproven)` while this process is in
  // a shell asking about pid start times, and killJob then killed a supervisor
  // that was already exiting and wrote `killed` over the answer it had just
  // finished producing. `killed(sight-unproven)` is a state/reason pair this
  // repo documents as impossible; a destroyed `done` is a deliverable answer
  // thrown away by a cancel that killed nothing that was alive.
  //
  // Bailing here is the cheap half — it stops the kill as well as the write.
  // The preconditions below are the half that actually holds, because the
  // verdict can equally land after this line. A corrupt record is deliberately
  // NOT terminal: it says nothing about what is alive, so it keeps the old path
  // (its pid files are still reaped, and `updateRecordOutcome` refuses to
  // rewrite it anyway).
  if (!isCorrupt(r) && !stillCancellable(r)) {
    return { ok: false, terminal: canonicalState(r), survivors: [], targets: [] };
  }
  const reissued = written.filter((pid) => !unique.includes(pid));
  if (reissued.length) {
    process.stderr.write(
      `note: job ${clean(job.id)} recorded pid(s) ${reissued.join(', ')}, and the process(es) holding ` +
      `those numbers now\nstarted at a different time — the OS reissued them. They belong to something ` +
      `else and have NOT been\nsignalled; whatever this job ran is already gone.\n`
    );
  }
  // Every write below is a COMPARE-AND-SWAP on "the state is still live", the
  // same `expect` mechanism the supervisor's exit handler, the exec-spawning
  // mark and dispatch's post-spawn write already use. A write that loses it did
  // not lose data: it found a verdict, and the verdict is the answer.
  //
  // THE STATE REPORTED IS THE ONE THAT BEAT THE SWAP, read INSIDE the lock and
  // handed back by `updateRecordOutcome`. Re-reading the record here instead
  // would report a third state — whatever the file says by the time this line
  // runs — which is a different claim from "this is what my write lost to", and
  // in the corner where that re-read came back corrupt it would have told
  // `claimRole` a job had finished on its own when nothing had vouched for it,
  // skipping the reap discipline a corrupt owner is owed. `current` is never
  // corrupt: `updateRecordOutcome` answers `why: 'corrupt'` before it ever
  // evaluates a precondition, so the states reachable here are exactly the
  // known, non-live ones — done, failed, killed.
  const lostToVerdict = (outcome) => {
    if (outcome.ok || outcome.why !== 'precondition') return null;
    return canonicalState(outcome.current);
  };
  // THREE OUTCOMES, NOT TWO. `lostToVerdict` answers null for `why: 'locked'` and
  // `why: 'corrupt'` as well as for a successful write, so a mark that never
  // reached the disk read here as a mark that did: `killJob` returned
  // `{ pending: true }` and `cancel` announced "the state is kill-pending" — a
  // state nothing had written, and with it the launch-block the supervisor's
  // exec-spawning CAS reads was silently not armed. Returns null only when the
  // state really says kill-pending now; otherwise it returns the caller's answer.
  const markPending = () => {
    const marked = updateRecordOutcome(job.dir, { state: 'kill-pending' }, { expect: stillCancellable });
    const verdict = lostToVerdict(marked);
    if (verdict) return { ok: false, terminal: verdict, survivors: [], targets: [] };
    if (!marked.ok) {
      // Nothing was killed here and nothing was recorded either, so the caller
      // must not say "kill-pending" and must not say "killed": the same
      // unrecorded shape the verified-kill path uses, flagged as the case where
      // no process was signalled at all.
      return { ok: false, unrecorded: true, nothingKilled: true, why: marked.why, survivors: [], targets: [] };
    }
    return null;
  };
  // A supervisor is gone when its number is dead OR when the identity check above
  // refused it: a reissued number is not the supervisor this job spawned. Stated
  // once because the window is read twice — before the kill, and again behind the
  // fence below, on a record that may have moved.
  const supervisorGone = (rec) =>
    !isCorrupt(rec) && Boolean(rec.supervisorPid) &&
    (!pidAlive(rec.supervisorPid) || !unique.includes(rec.supervisorPid));
  const window = killWindow(r, Date.now(), { supervisorDead: supervisorGone(r) });
  // INSIDE THE CODEX-EXEC WINDOW, KILL NOTHING. codex exists and its pid is
  // written down nowhere; the supervisor is the one process that has it, and
  // killing the supervisor is exactly how that knowledge is lost — which is what
  // 0.4.0 did before recording `killed` and releasing the role. So this reports
  // instead of declaring: `kill-pending` keeps the role, keeps the job
  // cancellable, and the supervisor lands the cancel the moment it has registered
  // the pids (it re-reads the record there, kills codex itself, and verifies).
  if (window === 'exec') {
    const blocked = markPending();
    if (blocked) return blocked;
    return { ok: false, pending: true, survivors: [], targets: [], window };
  }
  // Nothing to kill AND nothing has registered yet: report, do not declare. The
  // state stays live (`kill-pending` blocks the role and is cancellable), the
  // claim is NOT released, and the caller is told to retry — because the thing
  // this would otherwise have called dead is a supervisor that is still starting.
  if (!unique.length && window !== 'none') {
    const blocked = markPending();
    if (blocked) return blocked;
    return { ok: false, pending: true, survivors: [], targets: [], window };
  }
  // THE RECORD HAS TO SPEAK FOR THIS CANCEL WHILE THE PROCESS TABLE IS BEING
  // READ. The `none` window is the one that kills, and it used to leave the state
  // saying `running` for the whole kill — so nothing fenced the supervisor's
  // `launch: 'exec-spawning'` CAS, whose precondition is exactly that state. A
  // supervisor reaching it between killPids' process-table snapshot and the
  // signal spends money this kill can no longer reach: off Windows codex is
  // detached, leads its own group and reparents to init the moment the supervisor
  // dies, so the leftover sweep finds nothing descended from anything and the
  // pre-kill `r` carries no `codexPgid` to check it by. The kill then verified,
  // the role was released, and a billed orphan was left with no recorded target.
  // `kill-pending` is in LIVE_STATES, so it costs the CAS writes below nothing —
  // every one of them expects `stillCancellable`, which this state satisfies.
  //
  // A corrupt record is excluded on purpose: it is evidence and is never
  // rewritten, its pid files are the only targets it has, and refusing to kill
  // because a fence could not be written would spare exactly the orphan the fence
  // exists to catch.
  if (window === 'none' && !isCorrupt(r)) {
    const blocked = markPending();
    if (blocked) return blocked;
    // THE LOCK TOTALLY ORDERS THE TWO WRITERS, and one of the two orders is the
    // supervisor getting past its CAS before this mark landed. That order is only
    // visible here, in a read taken after the fence: a phase that has become
    // `exec-spawning` under a live supervisor IS the codex-exec window, so it is
    // reported rather than declared dead, and the supervisor — the one process
    // that knows what it just spawned — lands the pending cancel itself.
    const fenced = readRecord(job.dir);
    if (killWindow(fenced, Date.now(), { supervisorDead: supervisorGone(fenced) }) === 'exec') {
      return { ok: false, pending: true, survivors: [], targets: [], window: 'exec' };
    }
  }
  const killed = killPids(unique);
  const survivors = killed.survivors;
  const finished = new Date().toISOString();
  const priorWarning = isCorrupt(r) ? undefined : r.warning;
  // AND THE SURVIVOR CHECK READS THE RECORD AGAIN. `r` is the record as it was
  // BEFORE the kill, so a supervisor that registered codex DURING it — the pgid
  // and the pids it writes a moment after the exec — was invisible to every check
  // below, and its codex was declared dead by a check that never held its number.
  // A fresh read that comes back corrupt says nothing about what is alive, so the
  // stale one still stands: this may add targets to look at, never subtract them.
  const post = readRecord(job.dir);
  const witnesses = [r, post].filter((rec) => rec && !isCorrupt(rec));
  if (!survivors.length) {
    // POSIX: codex leads its own process group, and an empty group is part of the
    // proof that the group kill reached everything in it.
    for (const pgid of new Set(witnesses.map((rec) => rec.codexPgid).filter(isPid))) {
      if (groupAlive(pgid)) survivors.push(pgid);
    }
    // Pids the kill never fired at because nothing had written them down when it
    // gathered its targets — which means the ones the FRESH read added, and only
    // those: everything `gather` already saw was either fired at or refused by the
    // identity check, and a number refused as reissued belongs to somebody else
    // and is nobody's survivor. The spent list applies here as it does to every
    // other source, and the start-time identity is asked about the new numbers.
    const spent = reapedPids(job.dir);
    const late = [];
    for (const rec of witnesses) {
      for (const pid of [rec.codexPid, ...(Array.isArray(rec.codexPids) ? rec.codexPids : [])]) {
        if (isPid(pid) && !written.includes(pid) && !spent.has(pid) && !late.includes(pid)) late.push(pid);
      }
    }
    if (late.length) survivors.push(...recordedProcesses(post, late).filter(pidAlive));
  }
  // TEST HOOK: stands in for this process being descheduled between the kill and
  // the write that records it — the gap in which another writer's verdict lands,
  // and the one the compare-and-swaps below exist for. The pauses above sit
  // BEFORE the trigger, where the pre-trigger bail already answers, so neither of
  // them can pose this interleaving. Never set outside the suite.
  sleepSync(testPauseMs('CODEX_DISPATCH_TEST_VERDICT_PAUSE_MS'));
  // A kill with nothing left standing is only a kill if something LOOKED. An
  // unreadable process table is a failed verification, not a clean sweep (see
  // UNENUMERATED_KILL), so it lands in the same state a survivor does.
  const unverified = !killed.enumerated;
  if (survivors.length || unverified) {
    // The pid files stay loaded on purpose: those processes are demonstrably still
    // alive — or nothing could show they are not — so the numbers are still theirs
    // and still need firing at.
    const marked = updateRecordOutcome(job.dir, {
      state: 'kill-failed',
      // The state and the reason are written as a PAIR. A live record can carry
      // a reason from a phase this cancel is now ending (a version skew puts
      // `sight-unproven` on a state this release calls `unknown`, which is
      // cancellable), and leaving it in place produces exactly the sort of pair
      // this repo documents as impossible.
      reason: undefined,
      finished,
      killSurvivors: survivors.length ? survivors.join(', ') : undefined,
      ...(unverified ? { warning: [priorWarning, UNENUMERATED_KILL].filter(Boolean).join('; ') } : {}),
    }, { expect: stillCancellable });
    const verdict = lostToVerdict(marked);
    if (verdict) {
      // A survivor outranks the bookkeeping: the verdict is left exactly as its
      // writer left it, and the pids that outlived the kill are still reported,
      // because one of them may be codex and codex that is alive is billing.
      process.stderr.write(
        `WARNING: job ${clean(job.id)} — ` +
        (survivors.length
          ? `pids ${survivors.join(', ')} survived the kill, but the record\n`
          : `the kill could not be verified (the process table would not be read), but the record\n`) +
        `had already reached "${clean(verdict)}". That verdict has NOT been overwritten, so this job\n` +
        `does not read kill-failed even though something may still be alive. Kill them yourself:\n` +
        `taskkill /PID <pid> /T /F\n`
      );
    }
    // AND THE ANSWER IS THE VERDICT, NOT THE FAILED WRITE. `terminal` was left off
    // here alone, so a kill that lost this swap came back looking like a plain
    // kill-failed: `cancel` announced "state: kill-failed (NOT killed)" for a
    // record saying `done`, and `--force` treated a job that had finished as an
    // unresolved conflict and refused to launch. The survivor list rides along
    // either way — the state is somebody else's, the pids are still real.
    return { ok: false, ...(verdict ? { terminal: verdict } : {}), survivors, targets: unique, unverified };
  }
  const spent = consumePidFiles(job.dir, unique);
  const renameWarning = spent.failed.length
    ? `pid file(s) could not be consumed: ${spent.failed.join('; ')}`
    : null;
  const recorded = updateRecordOutcome(job.dir, {
    state: 'killed',
    reason: undefined,
    finished,
    killSurvivors: undefined,
    warning: [priorWarning, renameWarning].filter(Boolean).join('; ') || undefined,
  }, { expect: stillCancellable });
  const verdict = lostToVerdict(recorded);
  if (verdict) {
    // The job finished under us. Nothing is rewritten and the role is NOT
    // released — whoever wrote that verdict owns both decisions.
    return { ok: false, terminal: verdict, survivors: [], targets: unique };
  }
  // A KILL THAT COULD NOT BE WRITTEN DOWN IS NOT A KILL THAT HAPPENED, as far as
  // anything reading this job afterwards is concerned. Swallowing the failed write
  // and returning ok is the same shape of defect as every other one here: the
  // runtime reporting an action instead of a fact. The processes really are dead;
  // the record still says otherwise, so it keeps blocking its role — the safe
  // direction — and the caller is told to re-run.
  if (!recorded.ok) {
    return { ok: false, unrecorded: true, why: recorded.why, survivors: [], targets: unique };
  }
  if (renameWarning) {
    process.stderr.write(
      `WARNING: job ${job.id} — ${renameWarning}\n` +
      `The pids are recorded as reaped (job.json reapedPids + ${REAPED_PIDS_FILE}), so nothing\n` +
      `will fire at those numbers again even though the file is still there.\n`
    );
  }
  releaseRole(path.dirname(job.dir), r.role, job.id);
  return { ok: true, survivors: [], targets: unique };
}

function conflictMessage(job, state, role) {
  return (
    `dispatch: a "${role}" job is already ${state}: ${job.id}\n` +
    (state === 'stale'
      ? 'stale: its supervisor is gone but no out file was written — codex may have been reparented and is still running (and billing).\n'
      : '') +
    // Two shapes of kill-failed, and the second one is now the ORDINARY one: a
    // kill with no survivor list is a kill nothing could enumerate, and saying
    // "pids ? were still alive" there names a list that was never read.
    (state === 'kill-failed'
      ? (clean(job.record.killSurvivors)
        ? `kill-failed: an earlier kill did not take — pids ${clean(job.record.killSurvivors)} were still alive afterwards.\n`
        : 'kill-failed: an earlier kill could not be VERIFIED — nothing was seen alive, and nothing enumerated the tree either (the process table could not be read). Re-run the cancel.\n')
      : '') +
    (state === 'kill-pending'
      ? 'kill-pending: a cancel landed before this job had registered anything to kill, so nothing was killed and nothing may assume it died. Re-run the cancel.\n'
      : '') +
    `out: ${outPath(job.dir)}\n` +
    `Re-run with --force to kill it first, or pick another --role.`
  );
}

function corruptClaimMessage(role, lockDir, claim) {
  return (
    `dispatch: REFUSING to launch — the "${role}" role lock does not name a job this runtime could\n` +
    `have created.\n` +
    `owner file: ${claimOwnerPath(lockDir)}\n` +
    `contents: ${JSON.stringify(claim.invalid)}\n` +
    `A claim owner becomes a PATH: the job directory whose pid files a reclaim kills, whose spent\n` +
    `files it renames, and whose record it reads. So anything outside ${JOB_ID_RE} is refused before\n` +
    `it is joined — nothing has been read, killed, renamed or removed.\n` +
    `\n` +
    `RECOVERY, in this order. Removing the lock is the LAST step, not the first: it is the guard\n` +
    `standing between this role and a second codex, and this message used to open by telling you to\n` +
    `delete it.\n` +
    `  1. Read that owner file. Something wrote it, and what wrote it is the actual problem.\n` +
    `  2. Find out whether a "${role}" job is still alive:  list  — and  status <job-id>  for any\n` +
    `     that reads running, stale, kill-pending, kill-failed or unknown.\n` +
    `  3. Kill anything that is (cancel <job-id>, or taskkill /PID <pid> /T /F) and confirm it died.\n` +
    `  4. ONLY THEN remove the lock directory (${lockDir}) and re-dispatch.\n` +
    `  Or skip all of it: dispatch under another --role, which is free and takes nothing away.`
  );
}

function killPendingMessage(job, role) {
  return (
    `dispatch: REFUSING to launch — the previous "${role}" job could not be shown to have died.\n` +
    `job: ${job.id} (state: kill-pending)\n` +
    `It was cancelled inside one of the two registration windows — either before its supervisor had\n` +
    `recorded anything to kill, or while that supervisor was launching codex and had not yet written\n` +
    `down what it launched. Either way "killed nothing" is not "is dead".\n` +
    `Wait a moment and re-run; the supervisor honours a pending cancel as soon as it has the pids,\n` +
    `and then the kill has a target and can be verified. Or dispatch under another --role.`
  );
}

function reapFailedMessage(role, claim, reaped) {
  return (
    `dispatch: REFUSING to launch — the "${role}" role is held by a job that cannot vouch for\n` +
    `itself, and its processes could not be ` +
    `${reaped.survivors.length ? 'killed' : 'shown to have died'}.\n` +
    `job: ${clean(claim.owner)} (${clean(claim.detail)})\n` +
    (reaped.survivors.length
      ? `survivors: ${reaped.survivors.join(', ')}\n`
      : `${UNENUMERATED_KILL}\n`) +
    `A record that cannot be read says nothing about what is still running; taking the role while\n` +
    `those are alive is the double-dispatch this runtime exists to prevent, and if one of them is\n` +
    `codex it is still billing.\n` +
    `Kill them yourself (taskkill /PID <pid> /T /F) and re-run, or dispatch under another --role.`
  );
}

function uncontainedJobMessage(role, conflict) {
  return (
    `dispatch: REFUSING to launch — an entry in the jobs root carries the "${role}" role's name and is\n` +
    `not a job directory this runtime created.\n` +
    `entry: ${clean(conflict.dir)}\n` +
    `why: ${clean(conflict.record.corruptReason)}\n` +
    `A directory junction or symlink named like a job id redirects every read, kill, rename and\n` +
    `removal at whatever it points at, and Windows needs no elevation to create one. So nothing has\n` +
    `been read through it — not its record, not its pid files — which also means nothing here can\n` +
    `prove the role is free. It stays blocked.\n` +
    `Look at that entry yourself and remove or rename it, or dispatch under another --role.`
  );
}

// A kill that LOST to a verdict, said honestly. Two shapes, and the second one
// must not borrow the first's sentence: an ordinary loss killed nothing because
// the job had already finished, while a loss behind survivors or an unreadable
// process table happened AFTER the signals went out — "nothing was killed" there
// is a claim about processes this cancel really did fire at.
function terminalKillNote(jobId, killed) {
  if (killed.survivors.length || killed.unverified) {
    return (
      `previous job finished as ${clean(killed.terminal)} while the kill was verifying: ${jobId}\n` +
      (killed.survivors.length
        ? `pids ${killed.survivors.join(', ')} survived it — that verdict stands and was not overwritten`
        : `the kill could not be verified — that verdict stands and was not overwritten`)
    );
  }
  return `previous job finished on its own: ${jobId} (${clean(killed.terminal)}) — nothing was killed`;
}

function killFailedMessage(job, killed) {
  // Two ways a kill fails, and they are not the same claim: pids that outlived
  // it, or a kill nothing could enumerate. The second must not be reported as
  // the first — naming survivors there would be naming a list nobody read.
  if (!killed.survivors.length && killed.unverified) {
    return (
      `dispatch: REFUSING to launch — the previous "${clean(job.record.role)}" job's kill could not be\n` +
      `verified.\n` +
      `job: ${job.id} (state: kill-failed)\n` +
      UNENUMERATED_ADVICE + '\n' +
      `Or dispatch under another --role, which takes nothing away.`
    );
  }
  return (
    `dispatch: REFUSING to launch — the previous "${clean(job.record.role)}" job could not be killed.\n` +
    `job: ${job.id}\n` +
    `survivors: ${killed.survivors.join(', ')}\n` +
    `Those processes are still alive; if one of them is codex it is still billing, and a new job\n` +
    `alongside it is the double-dispatch this runtime exists to prevent.\n` +
    `Kill them yourself (taskkill /PID <pid> /T /F) and re-run, or dispatch under another --role.`
  );
}

// A kill whose outcome could not be WRITTEN DOWN, from the two dispatch paths
// that meet one. Shared because the two used to spell the same refusal
// differently, and one of them now has to be able to say that nothing was
// killed at all — a mark that never reached the disk is not a death.
function unrecordedKillMessage(role, jobId, killed) {
  return killed.nothingKilled
    ? `dispatch: REFUSING to launch — the "${role}" role's previous job has not registered anything to\n` +
      `kill, and the kill-pending state that says so could not be written (${clean(killed.why)}).\n` +
      `job: ${jobId}\n` +
      `Nothing was killed and nothing was recorded, so nothing here may treat that job as finished.\n` +
      `Re-run in a moment; once its supervisor has registered, the kill has a target and can be verified.`
    : `dispatch: REFUSING to launch — the "${role}" role's previous job was killed, but that\n` +
      `could not be written to its record (${clean(killed.why)}), so nothing may treat it as\n` +
      `finished. job: ${jobId}\nRe-run; the pids are spent, so a retry only records the death.`;
}

// ---------------------------------------------------------------------- verbs

// Which role a job belongs to, WITHOUT trusting the record. The directory name is
// the id, ids are `<role>-<epoch>-<pid>`, and the name has already been proved to
// match that shape and to be inside the jobs root — so it is the one statement of
// a job's role that survives its record being unreadable.
export function roleOfJob(job) {
  if (JOB_ID_RE.test(job.id)) return job.id.slice(0, job.id.indexOf('-'));
  return isCorrupt(job.record) ? null : (job.record.role ?? null);
}

// The backstop scan, for jobs that predate role claims or whose claim was removed
// by hand — which is exactly the situation this had to be fixed for.
//
// IT USED TO SKIP CORRUPT RECORDS BY DESIGN, on the reasoning that a record which
// cannot be read cannot claim to be running. True, and it cannot claim not to be
// either: with the claim directory deleted, two codexes ran under one role, and
// the message the runtime printed at the operator told them to delete that
// directory (Claude arm, round three, reproduced). Silence is not death anywhere
// else in this runtime and it is not death here: a corrupt record blocks its role
// unless its processes are PROVEN gone, and the proof is the same verified reap
// the claim side already runs.
function findRoleConflict(role) {
  for (const j of allJobs()) {
    if (roleOfJob(j) !== role) continue;
    // CONTAINMENT BEFORE THE FIRST READ, not only before the first kill. A
    // junction named like a job id is classified corrupt by `allJobs` precisely
    // so that "nothing was read through it" — and then this scan read its pid
    // files and its record to decide whether it was dead, following the link and
    // probing whatever numbers it found on the other side. `assertInsideRoot`
    // stopped the reap later, which is a gate on the write boundary; the read
    // boundary needs its own. Such an entry cannot be proved dead, so it blocks
    // its role and says so, which is the same fail-closed answer a genuinely
    // corrupt-but-contained job gets.
    if (!j.contained) return { ...j, state: 'corrupt', unvouched: true, uncontained: true };
    const s = effectiveState(j);
    if (s === 'corrupt') {
      // Proven dead = it has no un-reaped pid file still naming a live process.
      // Anything else and the role does not change hands on a guess.
      if (!recordedPids(j.dir).some(pidAlive)) continue;
      return { ...j, state: 'corrupt', unvouched: true };
    }
    if (LIVE_STATES.includes(s)) return { ...j, state: s };
  }
  return null;
}

function cmdDispatch(opts) {
  if (!opts.brief) fail('dispatch: --brief <file> is required');
  const briefPath = path.resolve(opts.brief);
  if (!fs.existsSync(briefPath)) fail(`dispatch: brief file not found: ${briefPath}`);

  const role = opts.role || 'dispatch';
  if (!ROLE_RE.test(role)) {
    fail(
      `dispatch: invalid --role ${JSON.stringify(role)}\n` +
      `roles must match ${ROLE_RE} (lowercase letters only), so job ids stay ${JOB_ID_RE}.`
    );
  }

  // RESOLVED, not typed — and that distinction is the whole fix. 0.7.0 validated
  // `opts.cd`, so a dispatch with no --cd at all skipped the check and put
  // `process.cwd()` into the record unexamined: run it from a directory with a `%`
  // in the name and the supervisor threw on a command line nothing had inspected.
  // This is the rule the jobs root already states — check the value where it is
  // READ, not where it is typed — applied to the one place it was not.
  const cwd = path.resolve(opts.cd || process.cwd());
  // The characters of this path were checked below long before anything checked
  // that it EXISTS, so a typo'd `--cd` claimed a role, built a job dir, spawned a
  // supervisor and only then failed the sight probe — for a fault the caller could
  // have been told about in one line, before anything was spent or blocked. It is
  // a directory, not a file: codex is given it with `--cd`.
  let cwdStat = null;
  try { cwdStat = fs.statSync(cwd); } catch { /* reported below */ }
  if (!cwdStat || !cwdStat.isDirectory()) {
    fail(
      `dispatch: --cd ${JSON.stringify(cwd)} ${cwdStat ? 'is not a directory' : 'does not exist'}\n` +
      `That is the directory codex would be run in and the one sight is proven against, so there is\n` +
      `nothing to dispatch into. Nothing was claimed, created or launched.` +
      `${opts.cd ? '' : '\n(No --cd was given, so this is the current directory.)'}`
    );
  }
  const model = opts.model || DEFAULT_MODEL;
  const effort = opts.effort || DEFAULT_EFFORT;

  // The same shape the READ boundary enforces (see ARGV_WORD_RE in
  // validateRecord), applied where the value is typed — because a dispatch that
  // writes a record it could not read back has produced a corrupt job that blocks
  // its role, which is a worse answer than a refusal. Every platform, unlike the
  // cmd.exe check below: argv arrays are not re-parsed, but a model name is still
  // a word.
  for (const [flag, value] of [['--model', model], ['--effort', effort]]) {
    if (!ARGV_WORD_RE.test(value)) {
      fail(
        `dispatch: ${flag} ${JSON.stringify(value)} is not a name this runtime will put on a codex\n` +
        `command line (${ARGV_WORD_RE}). Model and effort names are words; anything else is a\n` +
        `second argument in a costume, so it is refused rather than passed on.`
      );
    }
  }

  // Windows only, because only Windows builds a command line: elsewhere argv is
  // handed to spawn as an array and nothing re-parses it. See CMD_UNSAFE for why
  // this is a refusal rather than an escaping scheme. Those characters are legal
  // in NTFS filenames, so a cwd carrying one is a real directory this runtime will
  // not point at — the cure is named, and it is one directory away.
  if (WIN) {
    // The jobs root is on that same command line (`--output-last-message`), and
    // it is checked HERE — before preflight, before the claim, before the job
    // dir — because the alternative is a refusal that arrives once per job,
    // after a role has been taken and a supervisor spawned.
    assertJobsRootQuotable(jobsRoot());
    for (const [flag, value] of [['--model', model], ['--effort', effort], ['--cd', cwd]]) {
      if (value && CMD_UNSAFE.test(value)) {
        fail(
          `dispatch: ${flag} ${JSON.stringify(value)} contains one of % ! " — cmd.exe expands or\n` +
          're-parses these after quote stripping, so codex would be launched with something\n' +
          'other than this. No escaping on a command line reaches them, so it is refused\n' +
          `rather than mangled. Cure: a ${flag} value without them` +
          `${flag === '--cd' ? ' (this one defaults to the current directory, so --cd may be what you need)' : ''}.`
        );
      }
    }
  }
  const { bin } = preflight({ quiet: true });

  const root = jobsRoot();
  fs.mkdirSync(root, { recursive: true });

  // A stale job blocks exactly like a running one. Stale means the supervisor is
  // gone while the out file never appeared: codex was very likely reparented and
  // is still running — and still billing. Letting that through is the orphan
  // failure this runtime exists to kill. A corrupt job blocks too, now: it cannot
  // claim to be running, and it cannot claim not to be either.
  const conflict = findRoleConflict(role);
  if (conflict) {
    if (conflict.uncontained) {
      // Nothing has been read through it and nothing will be: this entry is a
      // link, or resolves outside the jobs root, and it carries the role's name.
      // It cannot be proved dead without reading it, so the role stays blocked.
      fail(uncontainedJobMessage(role, conflict));
    }
    if (conflict.unvouched) {
      // A corrupt record cannot be marked killed — it is evidence and stays
      // byte-for-byte — so the discipline is the claim side's: reap its pid files,
      // verify the deaths, and refuse the role if anything survives. No --force
      // needed to try, and no --force sufficient to skip it.
      const reaped = reapUnvouchedJob(root, conflict.dir);
      if (!reaped.ok) {
        fail(reapFailedMessage(role, { owner: conflict.id, detail: 'its job.json is corrupt' }, reaped));
      }
      if (reaped.killed.length) {
        console.log(
          `reaped unvouched-for job before taking role "${role}": ` +
          `${conflict.id} (pids ${reaped.killed.join(', ')})`
        );
      }
    } else {
      if (!opts.force) fail(conflictMessage(conflict, conflict.state, role));
      const killed = killJob(conflict);
      // Terminal under the force: that job finished on its own, so there is
      // nothing to kill, nothing to refuse, and — above all — nothing of its
      // verdict to overwrite. The claim below is taken the ordinary way.
      if (killed.terminal) {
        console.log(terminalKillNote(conflict.id, killed));
      } else if (!killed.ok) {
        if (killed.unrecorded) fail(unrecordedKillMessage(role, conflict.id, killed));
        fail(killed.pending ? killPendingMessage(conflict, role) : killFailedMessage(conflict, killed));
      } else {
        console.log(`killed previous job: ${conflict.id} (was ${conflict.state})`);
      }
    }
  }

  // <role>-<epoch-seconds>-<pid>: unique by construction. The collision suffix
  // extends the pid digits rather than adding a segment, so the id keeps the
  // shape the whitelist enforces.
  const stem = `${role}-${Math.floor(Date.now() / 1000)}-${process.pid}`;
  let dir = path.join(root, stem);
  for (let n = 1; fs.existsSync(dir); n++) dir = path.join(root, `${stem}${n}`);
  const id = path.basename(dir);

  // The claim comes BEFORE the job dir: a dispatch that loses the race must
  // leave nothing behind.
  const claim = claimRole(root, role, id, { force: opts.force });
  if (!claim.ok) fail(claim.message);

  // Set the moment a supervisor exists. Past that point the catch-all below must
  // NOT finalize the record or release the role: something is running.
  let spawned = false;
  try {
    fs.mkdirSync(dir);
    fs.copyFileSync(briefPath, path.join(dir, 'prompt.md'));

    writeRecord(dir, {
      // The schema stamp, written by the dispatch that ran the job — which is
      // also the only thing that may write the opt-in below. Delivery reads both
      // (see `deliverability`), and a record without this stamp is unvouched-for
      // by construction rather than by inspection.
      recordVersion: RECORD_VERSION,
      id,
      role,
      // The validated values from above, not a second computation of them: a
      // check that runs on one expression and a record written from another is
      // exactly how the process.cwd() default slipped past 0.7.0's gate.
      model,
      effort,
      sandbox: opts.write ? 'workspace-write' : 'read-only',
      cwd,
      bin,
      started: new Date().toISOString(),
      state: 'running',
      // Nothing has been spawned yet, and that is worth writing down rather than
      // inferring from `supervisorPid: null` later — see `inRegistrationWindow`.
      launch: 'pending',
      allowUnprovenSight: Boolean(opts.allowUnprovenSight),
      supervisorPid: null,
      codexPid: null,
      exitCode: null,
      finished: null,
    });

    // TEST HOOK: a throw from between writeRecord and the pid check below — a full
    // disk, a log that will not open, a pid file that will not write. Any of them
    // used to land in the catch-all, which released the role and left the record
    // saying `running` with no supervisor. Never set outside the suite.
    if (process.env.CODEX_DISPATCH_TEST_THROW_AFTER_RECORD) {
      throw new Error('simulated failure after the record was written');
    }
    // TEST HOOK: stands in for this dispatch being descheduled between winning the
    // claim and launching — the window a reclaimer can use. Never set outside the
    // suite; finding a real scheduler pause on demand is not portable.
    sleepSync(testPauseMs('CODEX_DISPATCH_TEST_CLAIM_PAUSE_MS'));
    // Verify-own-claim, immediately before the launch it authorizes. Everything
    // above this line is reversible; a spawned supervisor is not.
    if (!verifyClaim(roleLockDir(root, role), id)) {
      fs.rmSync(dir, { recursive: true, force: true });
      fail(
        `dispatch: CLAIM LOST — role "${role}" was taken over while this dispatch was starting up.\n` +
        `job: ${id} (never launched; its job dir has been removed)\n` +
        `owner now: ${readClaimOwner(roleLockDir(root, role)).owner || '(none)'}\n` +
        `Another dispatch reclaimed the role and may already be running under it. Launching anyway\n` +
        `is the double-dispatch this runtime exists to prevent. Retry, or pick another --role.`
      );
    }

    // From here on a supervisor may exist, so nothing may read "no recorded pid"
    // as "nothing is running". The marker goes down BEFORE the spawn, because
    // after it there is no instant at which it could be written soon enough.
    updateRecord(dir, { launch: 'spawning' });

    const supLog = fs.openSync(path.join(dir, 'supervisor.log'), 'a');
    const child = spawn(process.execPath, [SELF, '_supervise', dir], {
      detached: true,
      stdio: ['ignore', supLog, supLog],
      windowsHide: true,
    });
    fs.closeSync(supLog);

    // A spawn that failed is silent: `spawn` does not throw for it, and this
    // process is about to exit, so the 'error' event may never be delivered. An
    // unchecked failure left the record saying `running` with no supervisor pid
    // — which later reads `stale`, blocks the role, and makes the refusal claim
    // codex "may still be billing" for a process that never existed.
    if (!child.pid) {
      updateRecord(dir, {
        state: 'failed',
        reason: 'supervisor-spawn-failed',
        exitCode: -1,
        finished: new Date().toISOString(),
      });
      releaseRole(root, role, id);
      fail(
        `dispatch: could not start job ${id} — the supervisor process would not spawn.\n` +
        `The job is recorded as failed (supervisor-spawn-failed) and the "${role}" role has been\n` +
        `released; nothing was billed, because codex was never reached.\n` +
        `out: ${outPath(dir)}`
      );
    }
    spawned = true;
    // REGISTER THE KILL TARGET IN THE PARENT, before this dispatch returns and
    // before the job id is printed. The supervisor writing its own pid left a
    // window in which the record said `running` with nothing to kill: a cancel
    // landing there killed nothing, "verified" it, marked the job killed and
    // released the role while the supervisor went on to launch codex. The pid is
    // knowable here, at spawn time, so the window does not have to exist.
    //
    // The write is serialized behind the record lock (see updateRecord) and sets
    // only its own two fields: a cancel may be writing `kill-pending` or
    // `killed` at this very moment, and the unlocked read-modify-write this used
    // to be could put `running` back over it — telling the operator the job was
    // killed, releasing the role, and leaving codex to run.
    fs.writeFileSync(path.join(dir, 'supervisor.pid'), String(child.pid));
    // The start time goes down WITH the number, here, while the process is
    // certainly still the one just spawned. It is what tells a cancel hours from
    // now whether this pid is still ours or a number the OS has reissued.
    updateRecord(dir, {
      supervisorPid: child.pid,
      [PID_START_FIELD]: startTimesFor([child.pid]),
      launch: 'spawned',
    });
    // Attached only so a late 'error' cannot throw out of an already-detached
    // child; the synchronous pid check above is what actually decides.
    child.on('error', (err) => {
      process.stderr.write(`dispatch: supervisor spawn reported an error: ${clean(err.message)}\n`);
    });
    child.unref();

    // TEST HOOK: holds this dispatch between registering the supervisor and the
    // read below — the window in which a fast supervisor reaches its own verdict.
    // A real one of those is milliseconds wide and cannot be aimed at; what is
    // under test is the decision made about what is found there. Never set
    // outside the suite.
    sleepSync(testPauseMs('CODEX_DISPATCH_TEST_SPAWN_PAUSE_MS'));

    // A cancel that landed while this dispatch was spawning has now been serialized
    // behind that write, and it wrote a state this job must honour rather than
    // overwrite. The supervisor re-checks the same thing before it spends anything;
    // this is the parent's half, and it exists so the cancel's verdict wins the
    // race it just lost.
    //
    // ONLY A CANCEL-SHAPED STATE IS A CANCEL. This used to fire on any non-running
    // record, and the supervisor gets to a terminal state faster than this line
    // does: a failed sight precheck lands ~250 ms in, while the `startTimesFor`
    // above spends half a second in PowerShell on a warm machine. The parent then
    // killed a pid that was already gone and wrote `killed` over a verdict it had
    // never made — reproduced: a `--cd` at a path that does not exist finished as
    // `killed(sandbox-blind-precheck)`, a state/reason pair this runtime documents
    // as impossible, under a message about a cancel nobody ran. A `claim-lost`
    // lost its takeover evidence the same way.
    const after = readRecord(dir);
    const state = isCorrupt(after) ? 'corrupt' : canonicalState(after);
    if (CANCEL_STATES.includes(state)) {
      // THE ANTI-TARGET LIST APPLIES HERE TOO. The cancel that wrote the state
      // above may have fired at this very pid and written it down as spent (a
      // `kill-pending` it could not land, retried), and a number already fired
      // at belongs to whatever the OS has since given it to. Same filter
      // `killJob` applies to every source it gathers from.
      const spent = reapedPids(dir);
      const targets = spent.has(child.pid) ? [] : [child.pid];
      const killed = killPids(targets);
      // Verified means BOTH: nothing survived, and something actually looked.
      // An unreadable process table never enumerated the supervisor's tree, so
      // it is a failed verification rather than a clean sweep (UNENUMERATED_KILL).
      const verified = !killed.survivors.length && killed.enumerated;
      const finished = new Date().toISOString();
      // The spent pids are written down before the state is, exactly as killJob
      // orders it: the list is what stops a retry firing these numbers again,
      // and it must survive a state write that loses its precondition.
      if (verified) consumePidFiles(dir, targets);
      // COMPARE-AND-SWAP, like every other writer in the kill seam. This was the
      // one that carried no precondition, so a supervisor that reached its own
      // verdict in the gap between the read above and this write had it
      // overwritten — `killed(sight-unproven)`, the pair this repo documents as
      // impossible — by a parent that had killed a pid already gone.
      const written = updateRecordOutcome(dir, verified
        // `killSurvivors` is CLEARED, exactly as killJob clears it: the state
        // this branch reads may be a `kill-failed` an earlier cancel wrote, and
        // a `killed` record carrying that cancel's survivor list would have
        // `result` print survivors for a job whose kill verified.
        ? { state: 'killed', reason: undefined, finished, killSurvivors: undefined }
        : {
          state: 'kill-failed',
          reason: undefined,
          finished,
          killSurvivors: killed.survivors.length ? killed.survivors.join(', ') : undefined,
          // Merged, never replaced — a warning already on the record is about
          // something else that is still true.
          ...(killed.enumerated
            ? {}
            : { warning: [after.warning, UNENUMERATED_KILL].filter(Boolean).join('; ') }),
        }, { expect: stillCancellable });
      if (!written.ok && written.why === 'precondition') {
        // A LOST PRECONDITION IS A FOUND VERDICT. Something reached a terminal
        // state while this branch was killing; that state is the answer, it is
        // not rewritten, and the role is NOT released — whoever wrote it owns
        // both decisions.
        fail(
          `dispatch: job ${id} was cancelled while it was starting, and reached ` +
          `"${clean(canonicalState(written.current))}" before this dispatch could record the kill.\n` +
          `That verdict has been left exactly as its writer left it, and this dispatch released\n` +
          `nothing — whoever wrote that state owns the "${role}" role's release decision too, and\n` +
          `may already have made it. See it: status ${id}\n` +
          `out: ${outPath(dir)}`
        );
      }
      if (!written.ok) {
        // The kill happened; the record cannot say so. Safe direction: the job
        // keeps its role and the caller is told to look.
        fail(
          `dispatch: job ${id} was cancelled while it was starting, but the outcome could not be\n` +
          `written to its record (${clean(written.why)}), so nothing may treat it as finished.\n` +
          `The "${role}" role stays claimed. Re-run the cancel: cancel ${id}\n` +
          `out: ${outPath(dir)}`
        );
      }
      if (verified) releaseRole(root, role, id);
      fail(
        `dispatch: job ${id} was cancelled while it was starting.\n` +
        `state: ${clean(state)}\n` +
        (killed.survivors.length
          ? `Its supervisor SURVIVED the kill (${killed.survivors.join(', ')}); the role stays blocked.\n` +
            `Kill it yourself: taskkill /PID <pid> /T /F\n`
          : verified
            ? `Its supervisor has been killed and verified dead; nothing was billed.\n`
            : `${UNENUMERATED_KILL}; the role stays blocked.\n${UNENUMERATED_ADVICE}\n`) +
        `out: ${outPath(dir)}`
      );
    } else if (state !== 'running' && state !== 'corrupt') {
      // The supervisor got there first. Nothing is killed and nothing is rewritten
      // — the record is its account of a run this dispatch no longer owns — and the
      // dispatch still succeeds with the same handle: an exit code that depends on
      // whether the parent or the child won a millisecond race is not a fact about
      // the job. `status` and `result` read the verdict out of the record, which is
      // where it has been left.
      process.stderr.write(
        `dispatch: job ${id} is no longer "running" — its supervisor reached "${clean(state)}"` +
        `${after.reason ? ` (${clean(after.reason)})` : ''} while this dispatch was still starting it.\n` +
        `That is the supervisor's own verdict, not a cancel, so the record has been left exactly as\n` +
        `written and nothing was killed. See it: status ${id}\n`
      );
    }
  } catch (err) {
    // GHOST CLOSURE. Anything that threw between writeRecord and the pid check —
    // opening the supervisor log, writing the pid file, a full disk — used to
    // release the role and leave the record saying `running` with no supervisor:
    // a job that reads `stale` forever, blocks its own role, and whose refusal
    // claims codex "may still be billing" for a process that never existed. That
    // was closed once, on the spawn-failure path, and remained reachable here.
    if (spawned) {
      // A supervisor EXISTS. Finalizing the record or releasing the role would be
      // the double-dispatch this runtime is built to prevent, so neither happens.
      fail(
        `dispatch: job ${id} was launched, but handing it over failed: ${clean(err.message)}\n` +
        `The supervisor is running and the "${role}" role stays claimed — nothing here may assume\n` +
        `otherwise. Check it: status ${id}   Stop it: cancel ${id}\n` +
        `out: ${outPath(dir)}`
      );
    }
    updateRecord(dir, {
      state: 'failed',
      reason: 'dispatch-failed',
      exitCode: -1,
      finished: new Date().toISOString(),
    });
    releaseRole(root, role, id);
    fail(
      `dispatch: could not start job ${id}: ${clean(err.message)}\n` +
      `The job is recorded as failed (dispatch-failed) and the "${role}" role has been released;\n` +
      `nothing was billed, because codex was never reached.`
    );
  }

  console.log(`job: ${id}`);
  console.log(`bin: ${bin}`);
  if (opts.allowUnprovenSight) {
    console.log(
      'sight: UNPROVEN ACCEPTED (--allow-unproven-sight) — this job may answer without ever ' +
      'having been shown able to read a file; the record and result will both say so'
    );
  }
  console.log(`out: ${outPath(dir)}`);
  if (opts.watch) cmdWatch(id, { fromDispatch: true });
}

// Detached supervisor: proves the sandbox can see, runs codex to completion,
// then finalizes job.json. It is the only writer of job.json after dispatch
// returns, and its pid is the kill target — taskkill /T on it takes the whole
// codex tree down.
function cmdSupervise(dir) {
  // Dispatch now records this pid before it returns, so the usual case is a
  // record that already names us: re-writing it would be a second writer for no
  // gain. Writing it here remains the fallback for a record that does not.
  const existing = readRecord(dir);
  const record = (!isCorrupt(existing) && existing.supervisorPid === process.pid)
    ? existing
    : updateRecord(dir, {
      supervisorPid: process.pid,
      [PID_START_FIELD]: {
        ...(!isCorrupt(existing) && existing[PID_START_FIELD] ? existing[PID_START_FIELD] : {}),
        ...startTimesFor([process.pid]),
      },
    });
  if (!record) {
    process.stderr.write(`supervisor: job.json is corrupt, refusing to run: ${dir}\n`);
    process.exit(1);
  }
  // Pid files mirror job.json: a corrupt record must not cost us the kill target.
  fs.writeFileSync(path.join(dir, 'supervisor.pid'), String(process.pid));
  const root = path.dirname(dir);
  const id = path.basename(dir);

  // EVERY PRE-LAUNCH VERDICT IS A COMPARE-AND-SWAP, like every other writer in
  // the kill seam. These seven wrote unconditionally, and everything between the
  // record read above and them is slow — a sight probe is seconds of shell — so a
  // cancel that reached a verdict inside that gap had it overwritten by a
  // `failed` about a launch that never happened, and its role handed away
  // underneath it. `killed(sight-unproven)` and a `kill-failed` whose role went
  // free are both reachable that way; both are pairs this repo documents as
  // impossible.
  //
  // A LOST PRECONDITION IS A FOUND VERDICT: it is left exactly as its writer left
  // it and nothing is released here, because whoever wrote it owns the release
  // decision too — `kill-failed` above all, whose whole contract is that it goes
  // on blocking the role (DESIGN.md, "Kills are verified"). This is the exec
  // landing's rule, one step earlier.
  //
  // A write that could not be made AT ALL is a different answer: it found no
  // verdict, and on every one of these paths codex was never launched and this
  // supervisor is about to exit, so the claim it holds is still its own to give
  // back, and it gives it back exactly as it did before.
  //
  // A CANCEL-AUTHORED STATE IS THE CANCEL'S TO RESOLVE. `stillCancellable` alone
  // was not that line: `kill-pending` and `kill-failed` are LIVE states — they
  // have to be, so a second cancel can retry them — so a refusal satisfied the
  // precondition and wrote `failed(<reason>)` straight over a cancel's verdict,
  // releasing the role that `kill-failed` exists to keep blocked, after `cancel`
  // had already told the operator survivors exist and the role stays blocked. So
  // a refusal that finds one stands down: it overwrites nothing, releases
  // nothing, says what it found, and lets the cancel's own compare-and-swap
  // finish the story — the live cancel will write its verdict over
  // `kill-pending`, and a `kill-failed` already says what the operator needs.
  // `CANCEL_STATES` is the list this repo already draws (0.7.3); its third
  // member, `killed`, is terminal and `stillCancellable` refuses it a step
  // earlier, so naming all three keeps one list and adds nothing.
  //
  // The kill-pending HONOUR path below is the exception and passes its own
  // precondition: it is not overwriting that cancel, it is carrying it out.
  const notCancelAuthored = (rec) =>
    stillCancellable(rec) && !CANCEL_STATES.includes(canonicalState(rec));
  const refuseBeforeLaunch = (patch, { expect = notCancelAuthored } = {}) => {
    const written = updateRecordOutcome(dir, {
      ...patch,
      // The state, the reason and the survivor list travel as ONE. The record this
      // lands on may be a `kill-failed` carrying an earlier cancel's
      // `killSurvivors`, and a `failed` that kept it would report survivors of a
      // kill its own state never mentions.
      killSurvivors: undefined,
      finished: new Date().toISOString(),
    }, { expect });
    if (written.ok) {
      releaseRole(root, record.role, id);
      return;
    }
    const msg = written.why === 'precondition'
      ? `supervisor: the record had already reached "${clean(canonicalState(written.current))}" before this\n` +
        `refusal could be written, so that verdict has NOT been overwritten and no role claim was\n` +
        `released — whoever wrote it owns that decision. See it: status ${id}`
      : `supervisor: this refusal could not be written to the record (${clean(written.why)}), so the record\n` +
        `still says what it said. Nothing was launched; the "${clean(record.role)}" role claim has been\n` +
        `released. Look at the job: status ${id}`;
    try { fs.appendFileSync(runLogPath(dir), msg + '\n'); } catch { /* best effort */ }
    process.stderr.write(msg + '\n');
    if (written.why !== 'precondition') releaseRole(root, record.role, id);
  };

  // ASSERT THE SCHEMA VERSION OF THE RECORD THIS SUPERVISOR PICKED UP. Two copies
  // of this runtime can be installed at once — a plugin install and a clone, an
  // old shell and a new one — and dispatch and `_supervise` are separate
  // processes: the record can therefore have been written by a different release
  // than the one now running it. An older supervisor picking up a newer record
  // applies its own, weaker proof and then the run delivers as vouched, because
  // the stamp the gate reads says the version the DISPATCH wrote. (Codex arm,
  // round three.) The stamp has to mean "this whole run met this gate", so the
  // half of the run that spends money checks it too.
  if (record.recordVersion !== RECORD_VERSION) {
    const msg =
      `supervisor: RECORD VERSION MISMATCH — refusing to run.\n` +
      `record: recordVersion ${JSON.stringify(record.recordVersion ?? null)}\n` +
      `this supervisor writes and enforces recordVersion ${RECORD_VERSION}\n` +
      `The dispatch that created this job and the supervisor running it are different releases of\n` +
      `codex-dispatch. A record stamped by one gate is not evidence that another gate was met, and\n` +
      `the stamp is what "result" reads, so this job would deliver on a proof it never ran.\n` +
      `Fix: use one runtime. Re-dispatch with the same copy that will supervise it.`;
    try { fs.appendFileSync(runLogPath(dir), msg + '\n'); } catch { /* best effort */ }
    process.stderr.write(msg + '\n');
    refuseBeforeLaunch({ state: 'failed', reason: 'record-version-mismatch' });
    process.exit(1);
  }

  // ---- positive sight proof, in THIS job's cwd, before codex spends anything --
  // A probe that throws is a probe that did not prove anything, and a supervisor
  // that dies here would leave the job reading `running` forever. But it is not
  // the same verdict as a failed read: a throw out of this call — `cmdQuote`
  // refusing an unquotable `CODEX_DISPATCH_BIN`, a directory that cannot be
  // listed, a nonce file that will not write — means the probe never asked codex
  // anything, so nothing about the sandbox was disproven. Calling that `broken`
  // printed "reinstall codex" at an operator whose bin path had a `%` in it.
  let sight;
  try {
    sight = sightProbe(record.bin, record.cwd, dir);
  } catch (err) {
    sight = { state: 'probe-error', mode: 'none', detail: `the probe itself could not be run: ${clean(err.message)}` };
  }
  if (sight.state === 'broken') {
    const msg =
      `supervisor: SIGHT PRECHECK FAILED (${sight.mode}) — refusing to dispatch.\n` +
      `probe: ${sight.detail}\n` +
      `cwd: ${record.cwd}\n` +
      `bin: ${record.bin}\n` +
      BLIND_EXPLANATION;
    try { fs.appendFileSync(runLogPath(dir), msg + '\n'); } catch { /* best effort */ }
    process.stderr.write(msg + '\n');
    refuseBeforeLaunch({
      state: 'failed',
      reason: 'sandbox-blind-precheck',
      // NOT `${sight.mode} FAILED: ...`. That began with `cwd-file:`, which is the
      // one prefix this runtime treats as proof — a DISPROVEN read wrote a string
      // that looked like evidence of a proven one. The label leads with the
      // verdict now, and `sightVerdict` will not accept a prefix either way.
      sight: `FAILED ${sight.mode}: ${sight.detail}`,
    });
    process.exit(1);
  }
  // THE PROBE NEVER RAN. Not blindness — an absence of evidence, which is the
  // `unproven` class, not the `broken` one. Calling this `sandbox-blind-precheck`
  // (which is what every transport failure used to become) blames the binary for a
  // spawn failure and tells the operator to reinstall codex, which fixes nothing.
  if (sight.state === 'probe-error') {
    const msg =
      `supervisor: SIGHT PROBE COULD NOT BE RUN (${sight.mode}) — refusing to dispatch.\n` +
      `probe: ${sight.detail}\n` +
      `cwd: ${record.cwd}\n` +
      `bin: ${record.bin}\n` +
      'This is NOT a verdict about the sandbox: the probe could not be posed or run at all — the\n' +
      'process would not launch, or produced nothing to judge, or the cwd it had to run in was not\n' +
      'there — so codex was never asked and nothing was learned about what it can see.\n' +
      'Cures, best first:\n' +
      '  - Read the probe line above: it names the fault, and a missing cwd or an unquotable bin\n' +
      '    path is fixed where it was typed, not by reinstalling anything.\n' +
      '  - Run it by hand: the bin above, with `sandbox` and a read, from that cwd.\n' +
      '  - Re-dispatch; a transport failure that does not repeat costs one retry.\n' +
      '  - Accept it knowingly: --allow-unproven-sight runs the job and records that nothing\n' +
      '    ever vouched for it.';
    try { fs.appendFileSync(runLogPath(dir), msg + '\n'); } catch { /* best effort */ }
    if (!record.allowUnprovenSight) {
      process.stderr.write(msg + '\n');
      refuseBeforeLaunch({
        state: 'failed',
        reason: 'sight-probe-error',
        sight: `unproven: the probe could not be run (${sight.detail})`,
      });
      process.exit(1);
    }
  }
  // DELIVERABILITY REQUIRES PROVEN SIGHT, and exactly one thing proves it: a file
  // that already existed in this job's own --cd, read back through codex's sandbox
  // with its bytes returned. Two situations fall short of that and used to be
  // waved through with a polite warning — a CLI too old to have the `sandbox`
  // subcommand, and a cwd with nothing readable in it (the job-nonce fallback,
  // which only ever proved that sandboxed execution works *from* that directory).
  // Delivering either one reopened the blind-success route through good manners:
  // an answer nothing had vouched for, printed anyway, with a caveat nobody reads.
  // So an unproven job is REFUSED — unless the caller opted in, in writing, and
  // the record carries that acceptance from here to the delivery.
  //
  // Routed through the validator, not through `startsWith`: the label about to be
  // written has to be one `sightVerdict` will still call a proof when `result`
  // reads it back, so a cwd file whose name cannot survive that round trip is
  // refused here rather than delivered later on a label nothing can parse.
  const proven = sight.state === 'functional' && sightVerdict({ sight: sight.mode }).kind === 'proven';
  let warning;
  if (!proven) {
    const detail = sight.state === 'unavailable'
      ? `this codex has no "sandbox" subcommand (${sight.detail})`
      : sight.state === 'unprovable'
        ? `the read could not be posed as a proof: ${sight.detail}`
        : sight.state === 'probe-error'
          ? `the probe could not be run at all: ${sight.detail}`
          : sight.state === 'functional' && sight.mode.startsWith(PROVEN_SIGHT_PREFIX)
            ? `the read succeeded but "${sight.mode}" is not a label the delivery gate can read back ` +
              'as a proof, so it will not be recorded as one'
            : `nothing in the job cwd could prove a sandboxed read, and the ${sight.mode} fallback ` +
              'proves only that sandboxed execution works from there';
    if (!record.allowUnprovenSight) {
      const msg =
        `supervisor: SIGHT NOT PROVEN (${sight.mode}) — refusing to dispatch.\n` +
        `probe: ${detail}\n` +
        `cwd: ${record.cwd}\n` +
        `bin: ${record.bin}\n` +
        UNPROVEN_EXPLANATION;
      try { fs.appendFileSync(runLogPath(dir), msg + '\n'); } catch { /* best effort */ }
      process.stderr.write(msg + '\n');
      refuseBeforeLaunch({
        state: 'failed',
        reason: 'sight-unproven',
        sight: `unproven: ${detail}`,
      });
      process.exit(1);
    }
    warning = `sight not proven, accepted by caller (--allow-unproven-sight): ${detail}`;
    try { fs.appendFileSync(runLogPath(dir), `supervisor: ${warning}\n`); } catch { /* best effort */ }
    updateRecord(dir, { sight: ACCEPTED_SIGHT, warning });
  } else {
    updateRecord(dir, { sight: sight.mode });
  }

  // LAST CHECK BEFORE THE SPEND. Everything above is reversible; a launched codex
  // is not. Two things can have changed while this supervisor was starting up and
  // proving sight: the job can have been cancelled (a cancel that arrived before
  // registration marks it `kill-pending` precisely because it could not kill us),
  // and the role can have been taken over. Launching in either case is the
  // double-dispatch — or the ghost job — this runtime exists to prevent.
  const now = readRecord(dir);
  if (isCorrupt(now)) {
    abortSupervisor(dir, `job.json became unreadable before launch (${now.corruptReason})`);
  }
  if (canonicalState(now) !== 'running') {
    if (now.state === 'kill-pending') {
      // The cancel could not reach us then; it can be honoured now, by us. This
      // is the one refusal that MAY land on a cancel-authored state, because it
      // is not overwriting that cancel — it is completing it. Its precondition is
      // therefore exactly the state it read and nothing wider: `stillCancellable`
      // also accepts `kill-failed`, so a live cancel that reached that verdict
      // between this read and this write would have it replaced by
      // `killed(cancelled-during-registration)` — survivors cleared, role
      // released — which is the overwrite the six siblings forbid. Losing it is a
      // found verdict and stands down through the same path they do. Exactly as
      // the exec landing's honour path does one step later.
      refuseBeforeLaunch(
        { state: 'killed', reason: 'cancelled-during-registration' },
        { expect: (rec) => canonicalState(rec) === 'kill-pending' },
      );
    }
    abortSupervisor(dir, `the record says "${clean(now.state)}", not "running" — this job was cancelled before codex was launched`);
  }
  if (!verifyClaim(roleLockDir(root, record.role), id)) {
    updateRecord(dir, {
      state: 'failed',
      reason: 'claim-lost',
      finished: new Date().toISOString(),
    });
    // Deliberately no releaseRole: the claim is somebody else's now.
    abortSupervisor(dir, `the "${record.role}" role claim is no longer this job's — another dispatch owns it`);
  }

  const promptFd = fs.openSync(path.join(dir, 'prompt.md'), 'r');
  // Merged, as before: codex exec puts its whole transcript on stderr and only
  // the final answer on stdout, so splitting them buys nothing the line-shaped
  // blind scan does not already give.
  const logFd = fs.openSync(runLogPath(dir), 'a');
  const args = [
    'exec', '-',
    '--cd', record.cwd,
    '--sandbox', record.sandbox,
    '--skip-git-repo-check',
    '--model', record.model,
    '-c', `model_reasoning_effort=${record.effort}`,
    '--output-last-message', outPath(dir),
    '--color', 'never',
  ];
  // THE SECOND REGISTRATION WINDOW, recorded before it opens. Between this line
  // and the pid write below, codex exists and nothing has written down how to kill
  // it — the same shape as the supervisor's own window, one level down, and left
  // open when that one was closed. A cancel landing here used to kill the
  // supervisor, verify the targets it knew about, mark the job `killed` and
  // release the role, while codex ran on and billed. `launch: 'exec-spawning'` is
  // what lets `killJob` refuse to call that a death.
  // TEST HOOK: holds this supervisor immediately BEFORE the mark below, which is
  // the last thing standing between a cancel's fence and a codex nobody wrote
  // down. The real gap between the pre-launch read above and this compare-and-swap
  // is shell time measured in milliseconds and cannot be aimed at; what is under
  // test is that a `kill-pending` written while the kill runs costs this
  // supervisor its precondition. Never set outside the suite.
  sleepSync(testPauseMs('CODEX_DISPATCH_TEST_PRELAUNCH_PAUSE_MS'));
  const marked = updateRecord(dir, { launch: 'exec-spawning' }, {
    expect: (r) => canonicalState(r) === 'running',
  });
  if (!marked) {
    abortSupervisor(dir, 'the record stopped saying "running" (or could not be locked) as codex was about to be launched');
  }

  // Detached on POSIX so codex leads its own process group: that group IS the
  // tree a kill has to reach, since there is no `taskkill /T` off Windows and the
  // sandbox helpers codex spawns are its children, not ours.
  //
  // Wrapped because cmdQuote can REFUSE, and a refusal here used to be an
  // unhandled throw in a detached process with nobody to catch it: the record kept
  // saying `running` with no supervisor behind it, so the job read `stale` and held
  // its role until someone noticed and cancelled it. Reproduced by dispatching from
  // a directory with a `%` in its name (0.7.0 validated --cd but not the
  // process.cwd() default). The gate is closed at the boundary now, but a record
  // written by an older dispatch reaches this same line, so the throw has to land
  // somewhere that finalizes rather than nowhere at all.
  let child, viaShell;
  try {
    ({ child, viaShell } = spawnCodex(record.bin, args, {
      stdio: [promptFd, logFd, logFd],
      windowsHide: true,
      detached: !WIN,
    }));
  } catch (err) {
    const msg = `supervisor: refusing to launch codex: ${clean(err.message)}`;
    try { fs.appendFileSync(runLogPath(dir), msg + '\n'); } catch { /* best effort */ }
    console.error(msg);
    refuseBeforeLaunch({ state: 'failed', reason: 'codex-argv-refused', exitCode: -1 });
    process.exit(1);
  }
  child.on('error', (err) => {
    fs.appendFileSync(runLogPath(dir), `supervisor: spawn failed: ${clean(err.message)}\n`);
    refuseBeforeLaunch({ state: 'failed', reason: 'codex-spawn-failed', exitCode: -1 });
    process.exit(1);
  });

  // TEST HOOK: holds this supervisor inside the codex-exec window — the gap
  // between codex existing and its pids being written down. A real one of those
  // lasts milliseconds and cannot be aimed at on demand; what is under test is the
  // runtime's DECISION, that nothing landing in it may record a death.
  sleepSync(testPauseMs('CODEX_DISPATCH_TEST_EXEC_PAUSE_MS'));

  // WHAT WAS ACTUALLY SPAWNED. `child.pid` is codex only when codex was spawned
  // directly. Through the Windows shell — which is the path the supported npm
  // build takes, because `codex.cmd` is a batch file — it is cmd.exe, and codex is
  // its child. Recording only that proxy is why a surviving codex could leave a
  // job marked `killed` with its role released.
  const workers = viaShell ? resolveWorkerPids(child.pid) : [];
  const codexPids = [...new Set([child.pid, ...workers].filter(isPid))];
  if (codexPids.length) fs.writeFileSync(path.join(dir, 'codex.pid'), codexPids.join('\n'));
  updateRecord(dir, {
    codexPid: isPid(child.pid) ? child.pid : null,
    codexPids,
    // Merged, never replaced: the supervisor's own entry was written by the
    // dispatch that spawned it and is still the thing a cancel checks us by.
    [PID_START_FIELD]: {
      ...(record[PID_START_FIELD] || {}),
      ...startTimesFor(codexPids),
    },
    // POSIX: codex is detached, so it leads a group whose emptiness is part of a
    // verified kill. On Windows the tree is taskkill's business.
    codexPgid: !WIN && isPid(child.pid) ? child.pid : null,
    launch: 'exec',
  });
  if (viaShell && !workers.length) {
    fs.appendFileSync(runLogPath(dir),
      'supervisor: WARNING - codex was launched through a shell wrapper and no worker process could ' +
      'be resolved, so a kill can only verify the wrapper.\n');
    updateRecord(dir, { warning: 'codex worker pid could not be resolved behind the shell wrapper' });
  }

  // THE OTHER HALF OF THE WINDOW. A cancel that arrived while codex was being
  // spawned could not kill it and therefore recorded `kill-pending` rather than a
  // death. It has a target now — us — so the honest thing is to land it here
  // rather than let a "pending" cancel and a running codex coexist.
  const afterExec = readRecord(dir);
  if (!isCorrupt(afterExec) && canonicalState(afterExec) !== 'running') {
    const killed = killPids(codexPids);
    // A KILL NOTHING COULD ENUMERATE IS NOT A VERIFIED KILL, and this is the one
    // place that knows what it just spawned: codex behind a shell wrapper is a
    // DESCENDANT of the recorded pid, so an unreadable process table means the
    // thing that bills was never checked. It lands as `kill-failed` — same state
    // a survivor produces, role kept — rather than as a death nobody witnessed.
    const verified = !killed.survivors.length && killed.enumerated;
    // AND THIS WRITE IS A COMPARE-AND-SWAP LIKE EVERY OTHER ONE IN THE SEAM. The
    // state it read above was read BEFORE a kill that spends one to three
    // seconds in a shell, and it is not the only writer that can act on it: the
    // dispatch that spawned this supervisor is looking at the same cancel-shaped
    // record, and its own post-spawn branch kills THIS process, writes `killed`
    // and releases the role. Landing on top of that produced a `kill-failed`
    // record whose role was already free — a verdict overwritten by a writer
    // that lost, which is the defect this release exists to close, one writer to
    // the left of where it was closed.
    const landed = updateRecordOutcome(dir, verified
      ? {
        state: 'killed',
        reason: 'cancelled-during-exec',
        killSurvivors: undefined,
        finished: new Date().toISOString(),
      }
      : {
        state: 'kill-failed',
        reason: 'cancelled-during-exec',
        killSurvivors: killed.survivors.length ? killed.survivors.join(', ') : undefined,
        // Merged rather than set: this supervisor may already have warned that
        // it could not resolve the worker behind the shell wrapper, which is
        // the other half of the same doubt.
        ...(killed.enumerated
          ? {}
          : { warning: [afterExec.warning, UNENUMERATED_KILL].filter(Boolean).join('; ') }),
        finished: new Date().toISOString(),
      }, { expect: stillCancellable });
    // WHOEVER WROTE THE VERDICT OWNS THE RELEASE TOO. A write that lost its
    // precondition found one: it is reported into the job's own log and left
    // exactly as its writer left it, and this supervisor releases nothing —
    // the process that recorded the death has already made that decision, and a
    // second release could hand away a claim a NEW dispatch has taken since.
    // A write that could not be made at all (locked, or a record gone corrupt)
    // is the same answer for the same reason: nothing here may act on a death
    // the record does not carry.
    if (landed.ok) {
      if (verified) releaseRole(root, record.role, id);
    } else {
      const found = landed.why === 'precondition'
        ? `the record had already reached "${clean(canonicalState(landed.current))}"`
        : `the record could not be written (${clean(landed.why)})`;
      const msg =
        `supervisor: codex was killed for a cancel, but ${found}, so this supervisor wrote nothing\n` +
        `and released no role claim. ` +
        (verified ? 'codex is verified dead.' : 'codex could not be verified dead.');
      try { fs.appendFileSync(runLogPath(dir), msg + '\n'); } catch { /* best effort */ }
      process.stderr.write(msg + '\n');
    }
    abortSupervisor(dir,
      `the record says "${clean(canonicalState(afterExec))}" — this job was cancelled while codex was ` +
      `being launched, so codex has been killed ` +
      (killed.survivors.length
        ? `and pids ${killed.survivors.join(', ')} SURVIVED`
        : killed.enumerated
          ? 'and verified dead'
          : `and ${UNENUMERATED_KILL}`),
      { launched: true });
  }

  child.on('exit', (code) => {
    // FINALIZATION MAY FAIL, AND IT MAY NOT TAKE THE HANDLER DOWN WITH IT. The
    // write inside `updateRecord` can throw — a rename that exhausts its retries,
    // ENOSPC on the temp file — and an uncaught throw out of an exit handler ends
    // this supervisor right here: the record still says `running`, so the job
    // reads `stale` for ever, holds its role, and `result` refuses a finished
    // out.txt sitting next to it. A write that could not happen is reported, in
    // the job's own log and on stderr, exactly like every other one in this
    // runtime that cannot be made to stick.
    try {
      const current = readRecord(dir);
      if (!isCorrupt(current) && canonicalState(current) === 'running') {
        // The signature scan is a WARNING now, not a verdict: sight was established
        // positively before the run, so a signature here means "something in the
        // sandbox complained", which is worth saying and not worth overruling a
        // proof with.
        const blind = scanBlindLog(runLogPath(dir));
        const warnings = [];
        if (blind) warnings.push(`sandbox-failure signatures in log (${blind})`);
        if (warning) warnings.push(warning);
        // The read above is not the decision — the scan takes long enough for a
        // cancel to land inside it, and a `killed` verdict written in that gap used
        // to be overwritten by this `done`. The precondition is re-evaluated inside
        // the lock, so the other writer's verdict wins the race it just won.
        updateRecord(dir, {
          state: code === 0 ? 'done' : 'failed',
          warning: warnings.length ? warnings.join('; ') : undefined,
          blindSignature: blind || undefined,
          exitCode: code,
          finished: new Date().toISOString(),
        }, { expect: (rec) => canonicalState(rec) === 'running' });
      }
    } catch (err) {
      const msg =
        `supervisor: codex exited ${code}, but job.json could not be finalized: ${clean(err.message)}\n` +
        `The record still says what it said, so this job will read "stale" and keep its role until\n` +
        `someone cancels it. The answer file, if codex wrote one, is at ${outPath(dir)}`;
      try { fs.appendFileSync(runLogPath(dir), msg + '\n'); } catch { /* best effort */ }
      process.stderr.write(msg + '\n');
    }
    // RELEASING THE ROLE IS A CLAIM ABOUT WHAT IS ALIVE, so it is made from the
    // record as it now stands rather than unconditionally. The check above already
    // refuses to REWRITE a record that stopped saying `running` — and then this
    // handed the role away anyway, including for `kill-failed`, whose whole
    // contract is that a cancel killed codex, this supervisor survived it, and the
    // job goes on blocking dispatch (DESIGN.md, "Kills are verified"). Only
    // `findRoleConflict`'s backstop scan was keeping that promise. An unreadable
    // record does not release either: silence is not death.
    const final = readRecord(dir);
    const finalState = isCorrupt(final) ? 'corrupt' : canonicalState(final);
    if (ROLE_RELEASE_STATES.includes(finalState)) {
      releaseRole(root, record.role, id);
    } else {
      process.stderr.write(
        `supervisor: not releasing the "${clean(record.role)}" role — this job reads "${clean(finalState)}", ` +
        `which is not a state\nthat says everything it owned is gone. The claim stays with ${clean(id)}.\n`
      );
    }
    process.exit(0);
  });
}

// A supervisor that must not launch says so in the two places a human will look —
// the job's own run.log and the supervisor's stderr — and exits nonzero. The
// record has already been set by the caller; this only reports and stops.
function abortSupervisor(dir, why, { launched = false } = {}) {
  const msg = launched
    ? `supervisor: ABORTING — ${why}.`
    : `supervisor: ABORTING before codex was launched — ${why}.\nNothing was billed.`;
  try { fs.appendFileSync(runLogPath(dir), msg + '\n'); } catch { /* best effort */ }
  process.stderr.write(msg + '\n');
  process.exit(1);
}

function printStatus(job) {
  const state = effectiveState(job);
  const r = job.record;
  // Everything below that comes out of the record or off the filesystem is
  // stripped of control bytes on the way to the console: a record written by an
  // older release, or by hand, never went through the write boundary.
  console.log(`job: ${clean(job.id)}`);
  console.log(`state: ${state}`);
  if (isCorrupt(r)) {
    console.log(`reason: corrupt job.json (${clean(r.corruptReason)})`);
    console.log(`out: ${outPath(job.dir)}`);
    return;
  }
  if (state === 'unknown') {
    console.log(
      `reason: the record's state ${JSON.stringify(clean(String(r.state)).slice(0, 40))} is not one this ` +
      `release knows (${KNOWN_STATES.join(', ')}), so this job is treated as live and unvouched`
    );
  }
  if (r.reason) console.log(`reason: ${clean(r.reason)}${r.blindSignature ? ` (${clean(r.blindSignature)})` : ''}`);
  if (r.killSurvivors && state === 'kill-failed') console.log(`survivors: ${clean(r.killSurvivors)}`);
  if (r.sight) console.log(`sight: ${clean(r.sight)}`);
  if (r.warning) console.log(`warning: ${clean(r.warning)}`);
  // A job that reads `done` is not necessarily a job whose answer this runtime
  // will hand over: the record has to vouch for the run. Saying so here means the
  // refusal at `result` is never a surprise.
  if (state === 'done') {
    const d = deliverability(r);
    console.log(d.ok ? `deliverable: yes (${d.how})` : `deliverable: NO - unvouched: ${d.reason}`);
  }
  const end = r.finished ? Date.parse(r.finished) : Date.now();
  const logFile = runLogPath(job.dir);
  const logSize = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  console.log(`runtime: ${humanDuration(end - Date.parse(r.started))}`);
  console.log(`log: ${logSize} bytes`);
  console.log(`out: ${outPath(job.dir)}`);
}

function cmdStatus(id) {
  if (id) return printStatus(getJob(id));
  const jobs = allJobs();
  if (!jobs.length) return console.log(`no jobs in ${jobsRoot()}`);
  jobs.forEach((j, i) => { if (i) console.log(''); printStatus(j); });
}

function cmdResult(id) {
  const job = getJob(id);
  const out = outPath(job.dir);
  if (isCorrupt(job.record)) {
    fail(
      `CORRUPT: job ${id} has an unusable job.json (${clean(job.record.corruptReason)})\n` +
      `The answer file may still be there; read it yourself if you trust it.\n` +
      `out: ${out}`
    );
  }
  // A REASON MAY NEVER OUTRANK A STATE. These three checks read `reason` before
  // anything read `state`, so a record carrying one of them beside a state that
  // is not `failed` was reported as a job that never ran — a `killed` job would
  // have printed "UNPROVEN: job never ran". The pair is what means something:
  // these are refusals reached before or instead of a run, and `failed` is the
  // only state that can carry one (asserted in tests/resolution.test.mjs). Any
  // other state falls through to the state-shaped refusals below, which is where
  // a job that was cancelled or is still live belongs.
  const state = effectiveState(job);
  const neverRan = state === 'failed';
  if (neverRan && job.record.reason === 'sandbox-blind-precheck') {
    fail(
      `BLIND: job ${id} never ran — codex's sandbox could not read a file in the job's cwd,\n` +
      `so anything it produced would have been sourceless.\n` +
      `probe: ${clean(job.record.sight) || 'sight precheck failed'}\n` +
      BLIND_EXPLANATION + '\n' +
      `out: ${out}`
    );
  }
  if (neverRan && job.record.reason === 'sight-probe-error') {
    fail(
      `PROBE ERROR: job ${id} never ran — the sight probe could not be RUN, so nothing is known\n` +
      `about this sandbox either way. The probe never asked codex anything — a transport failure, a\n` +
      `cwd that was not there, a bin path that could not be quoted — NOT a finding that codex is blind.\n` +
      `probe: ${clean(job.record.sight) || 'the probe could not be run'}\n` +
      `Re-dispatch: a transport failure that does not repeat costs one retry. If it repeats, run the\n` +
      `probe by hand (the recorded bin, "sandbox", a read, from the job's --cd), or accept it\n` +
      `knowingly with --allow-unproven-sight.\n` +
      `out: ${out}`
    );
  }
  if (neverRan && job.record.reason === 'sight-unproven') {
    fail(
      `UNPROVEN: job ${id} never ran — codex could not be PROVEN able to read a file in the\n` +
      `job's own working directory, and an unproven answer is not deliverable by default.\n` +
      `probe: ${clean(job.record.sight) || 'sight could not be proven'}\n` +
      UNPROVEN_EXPLANATION + '\n' +
      `out: ${out}`
    );
  }
  // Record-authoritative: an answer file is bytes, not a verdict. Only a record
  // that says done — exit code recorded, sight resolved — releases output.
  if (state !== 'done') {
    fail(
      `NOT DELIVERED: job ${id} is ${state}; the record does not say done, so this runtime will not print its output.\n` +
      (fs.existsSync(out)
        ? `An answer file DOES exist, and that is not enough: nothing has vouched for how this run ended.\n` +
          `Read it yourself if you want to see what it says.\n`
        : '') +
      (job.record.killSurvivors ? `survivors: ${clean(job.record.killSurvivors)}\n` : '') +
      `started ${clean(job.record.started)}, runtime ${humanDuration(Date.now() - Date.parse(job.record.started))}\n` +
      `out: ${out}`
    );
  }
  // The record says done — now: does it VOUCH for the run? A `done` state was
  // never the whole gate, it was only the part that had been written down. A
  // record from 0.1/0.2 carries no sight at all and one from 0.2 can carry the
  // word `unproven` with nothing that consented to it, and both used to be
  // delivered by this line — the second of them with a caveat claiming a caller
  // had opted in, which nobody had.
  const deliver = deliverability(job.record);
  if (!deliver.ok) {
    fail(
      `UNVOUCHED: job ${id} reads done, but its record does not vouch for the run, so this runtime\n` +
      `will not print its output.\n` +
      `reason: ${deliver.reason}\n` +
      `Deliverability is a property of the RECORD: this release requires its own schema stamp\n` +
      `(recordVersion ${RECORD_VERSION}), a zero exit, and either sight proven in the job's own cwd\n` +
      `("${PROVEN_SIGHT_PREFIX}<name>") or the --allow-unproven-sight opt-in written down by the dispatch that\n` +
      `ran it. A record predating that gate is not evidence that it was met.\n` +
      `The bytes are not hidden — read them by hand if you decide to trust them, or re-dispatch\n` +
      `under this release to get an answer something vouched for.\n` +
      `out: ${out}`
    );
  }
  if (!fs.existsSync(out)) {
    fail(
      `MISSING: job ${id} is done but its answer file is not on disk.\n` +
      `out: ${out}`
    );
  }
  if (deliver.accepted) {
    // Delivered ONLY because the dispatch said so — in the record, as a boolean
    // this runtime wrote, not as a word in a label — and the caveat rides with
    // the bytes every time they are collected. stdout stays the verbatim answer:
    // the caller opted in knowingly, and a warning welded into the answer would
    // break the transport this runtime exists to guarantee.
    process.stderr.write(
      `UNPROVEN SIGHT: job ${id} ran WITHOUT proof that codex could read files in its cwd.\n` +
      `sight: ${clean(job.record.sight)}\n` +
      `It is being delivered only because the dispatch recorded --allow-unproven-sight.\n` +
      `A codex that cannot see answers confidently and exits 0, so treat what follows as\n` +
      `unvouched-for until something in it proves otherwise.\n`
    );
  }
  if (job.record.warning) {
    process.stderr.write(
      `WARNING: job ${id} — ${clean(job.record.warning)}\n` +
      (deliver.accepted
        ? `Sight was never proven for this job (${clean(job.record.sight)}); see above.\n`
        : `Sight was established before the run (${clean(job.record.sight) || 'unrecorded'}), so this is a warning, not a verdict.\n`) +
      `The answer follows on stdout; treat it with that caveat.\n`
    );
  }
  // verbatim: raw bytes, nothing else on stdout
  process.stdout.write(fs.readFileSync(out));
}

function cmdCancel(id) {
  const job = getJob(id);
  // A corrupt record still has processes to reap: the pid files are the fallback,
  // and job.json is left exactly as found so the corruption stays inspectable.
  if (isCorrupt(job.record)) {
    const pids = recordedPids(job.dir);
    console.log(`job ${id} has a corrupt job.json (${clean(job.record.corruptReason)})`);
    if (!pids.length) {
      const reaped = reapedPidFiles(job.dir);
      const spent = [...reapedPids(job.dir)];
      if (reaped.length) {
        console.log(`already reaped: ${reaped.join(', ')} — nothing left to kill, nothing touched`);
      } else if (spent.length) {
        console.log(
          `already reaped: pids ${spent.join(', ')} (recorded in ${REAPED_PIDS_FILE}) — ` +
          'nothing left to kill, nothing touched'
        );
      } else {
        console.log('no pid files to kill; job.json left untouched for inspection');
      }
      console.log(`out: ${outPath(job.dir)}`);
      return;
    }
    const reaped = killPids(pids);
    const survivors = reaped.survivors;
    console.log(`killed recorded pids: ${pids.join(', ')} (job.json left untouched for inspection)`);
    if (survivors.length) {
      // Survivors keep their pid files: those numbers are demonstrably still
      // theirs, so a later cancel must be able to fire at them again.
      console.log(`out: ${outPath(job.dir)}`);
      process.stderr.write(
        `KILL FAILED: job ${id} — these pids survived: ${survivors.join(', ')}\n` +
        `Kill them yourself: taskkill /PID <pid> /T /F\n`
      );
      process.exit(1);
    }
    // AN UNENUMERATED KILL IS A FAILED VERIFICATION HERE TOO. This branch used to
    // warn and then consume the pid files anyway — spending the only kill targets a
    // corrupt record has on a sweep nothing witnessed, and exiting 0 — so the retry
    // the warning asked for found "already reaped" and fired at nothing. Every other
    // writer in the kill seam already treats `enumerated: false` as failure
    // (`killJob` lands kill-failed, `reapUnvouchedJob` refuses the takeover and
    // leaves the pid files loaded); a corrupt record, which has no state to move,
    // keeps its targets instead.
    if (!reaped.enumerated) {
      console.log(`out: ${outPath(job.dir)}`);
      process.stderr.write(
        `KILL NOT VERIFIED: job ${id} — the signals were sent to the recorded pids, and the process\n` +
        `table could not be read afterwards, so nothing enumerated the tree behind them. A descendant\n` +
        `of theirs — a codex, if this job had one — could have survived unseen.\n` +
        `pid files stay loaded; re-run cancel when the process table answers.\n` +
        UNENUMERATED_ADVICE + '\n'
      );
      process.exit(1);
    }
    const spent = consumePidFiles(job.dir, pids);
    if (spent.consumed.length) {
      console.log(`consumed pid files: ${spent.consumed.join(', ')} — a second cancel cannot replay those pids`);
    }
    if (spent.failed.length) {
      // The rename is the visible half of consuming a pid file and it can fail.
      // Saying so is the point: the operator would otherwise read the silence as
      // success and find a loaded pid file next time they look.
      console.log(
        `reaped pids recorded in ${REAPED_PIDS_FILE}: ${pids.join(', ')} — ` +
        'a second cancel consults that list, not the file names'
      );
      process.stderr.write(
        `WARNING: job ${id} — could not rename spent pid file(s): ${spent.failed.join('; ')}\n` +
        `They are still on disk and still hold those numbers. Nothing will fire at them again\n` +
        `(they are recorded as reaped in ${REAPED_PIDS_FILE}), but the files are worth a look.\n`
      );
    }
    console.log(`out: ${outPath(job.dir)}`);
    return;
  }
  const state = effectiveState(job);
  if (!LIVE_STATES.includes(state)) {
    console.log(`job ${id} is already ${state}, nothing to kill`);
    console.log(`out: ${outPath(job.dir)}`);
    return;
  }
  const killed = killJob(job);
  if (killed.terminal) {
    // It finished between the state read above and the write below — its own
    // verdict, left exactly as written. Reported the way cancelling any other
    // finished job is reported, because that is what this is: a verdict that was
    // reached is not this cancel's failure, so the exit code is the finished-job
    // one even when the signals had already gone out. What DID happen behind them
    // is on stderr, written by the kill itself.
    console.log(killed.survivors.length || killed.unverified
      ? `job ${id} finished as ${killed.terminal} while the kill was verifying, and that verdict stands`
      : `job ${id} is already ${killed.terminal}, nothing to kill`);
    console.log(`out: ${outPath(job.dir)}`);
    return;
  }
  if (killed.unrecorded) {
    console.log(`out: ${outPath(job.dir)}`);
    // Two shapes of "not recorded", and the second one must not borrow the
    // first's sentence: `nothingKilled` is a cancel that reached no target at
    // all and could not even write down that it is pending, so saying its
    // processes were killed and verified dead would be inventing both halves.
    process.stderr.write(killed.nothingKilled
      ? `KILL NOT RECORDED: job ${id} has not registered anything to kill yet, and the kill-pending\n` +
        `state that says so could not be written (${clean(killed.why)}). NOTHING was killed and\n` +
        `nothing was recorded, so this job is exactly as it was: still live, still holding its role,\n` +
        `still cancellable. Re-run this cancel in a moment.\n`
      : `KILL NOT RECORDED: job ${id} — its processes were killed and verified dead, but the record\n` +
        `could not be updated (${clean(killed.why)}), so it still does not say so.\n` +
        `The job therefore keeps blocking its role, which is the safe direction: nothing here will\n` +
        `claim a death the record cannot confirm. Re-run this cancel — the pids are already spent, so\n` +
        `it will not fire at anything again.\n`
    );
    process.exit(1);
  }
  if (killed.pending) {
    // Nothing was killed, and that is exactly why this is not a success. The job
    // keeps its role and stays cancellable; the retry is the whole cure.
    console.log(`out: ${outPath(job.dir)}`);
    process.stderr.write(
      `KILL PENDING: job ${id} has not registered anything to kill yet — its supervisor is still\n` +
      `starting up. Killing nothing is not killing it, so this cancel has NOT been recorded as a\n` +
      `death: the state is kill-pending, the role stays claimed, and the job stays cancellable.\n` +
      `Re-run this cancel in a moment; once the supervisor has registered, the kill has a target\n` +
      `and can be verified.\n`
    );
    process.exit(1);
  }
  if (!killed.ok) {
    // A kill that could not be ENUMERATED reports what it actually knows: no
    // survivor list, because nothing read one. Same state, same blocked role —
    // and no invented names.
    process.stderr.write(!killed.survivors.length && killed.unverified
      ? `KILL NOT VERIFIED: job ${id} — the signals were sent, and the process table could not be\n` +
        `read afterwards, so nothing enumerated the tree behind them.\n` +
        `state: kill-failed (NOT killed). The role stays blocked, because what could not be seen may\n` +
        `be codex, and codex that is alive is codex that is billing.\n` +
        UNENUMERATED_ADVICE + '\n' +
        `out: ${outPath(job.dir)}\n`
      : `KILL FAILED: job ${id} — these pids survived the kill: ${killed.survivors.join(', ')}\n` +
        `state: kill-failed (NOT killed). The role stays blocked, because a survivor may be codex,\n` +
        `and codex that is alive is codex that is billing.\n` +
        `Kill them yourself: taskkill /PID <pid> /T /F\n` +
        `out: ${outPath(job.dir)}\n`
    );
    process.exit(1);
  }
  console.log(`killed: ${id}`);
  console.log(`out: ${outPath(job.dir)}`);
}

function cmdList() {
  const jobs = allJobs();
  if (!jobs.length) return console.log(`no jobs in ${jobsRoot()}`);
  for (const job of jobs) {
    const state = effectiveState(job);
    const r = job.record;
    let tag = state;
    if (!isCorrupt(r)) {
      // The raw state rides along, because "unknown" without it tells nobody what
      // to go and look at.
      if (state === 'unknown') tag = `unknown(${clean(String(r.state)).slice(0, 40)})`;
      else if (r.reason) tag = `${state}(${clean(r.reason)})`;
      // A done job whose record does not vouch for the run is listed as such:
      // `result` is going to refuse it, and a listing that says plain `done`
      // would be the last place anyone learns that.
      else if (state === 'done' && !deliverability(r).ok) tag = 'done(unvouched)';
    }
    const warn = !isCorrupt(r) && r.warning ? `  warning: ${clean(r.warning)}` : '';
    console.log(`${clean(job.id)}  ${tag}  out: ${outPath(job.dir)}${warn}`);
  }
}

// ---------------------------------------------------------------------- clean
//
// NOTHING HAS EVER REMOVED A JOB DIRECTORY. Every dispatch leaves one behind for
// ever — a prompt, a run.log that can be megabytes, an answer file — and the
// jobs root grows without bound until somebody deletes it by hand, which is the
// one operation this runtime spends the most care making unsafe to do by hand.
//
// So: a MANUAL verb, never an automatic prune. A record is the only account of
// what a job did, and deciding on the operator's behalf that an account has
// expired is not a decision a background sweep gets to make. `clean` removes
// only what the caller asks it to remove, and it asks for the ask explicitly:
// with neither `--all` nor `--older-than <days>` it refuses rather than picking
// a default that deletes something.
//
// WHAT IS ELIGIBLE is the runtime's existing notion of "everything this job
// owned is gone" — ROLE_RELEASE_STATES, the same set the supervisor is allowed
// to release a role on. `done`, `failed`, `killed`, and nothing else:
//   - every LIVE state (running, kill-pending, stale, kill-failed, unknown) may
//     still own processes. Removing the directory of a job that owns a codex
//     removes the pid files that are the only way left to kill it.
//   - `corrupt` is EVIDENCE. This runtime refuses to rewrite a corrupt record
//     anywhere else (DECISIONS.md, "Corrupt records are contained, not
//     repaired"); deleting one in bulk is the same claim with a bigger hammer.
//   - `kill-failed` and `unknown` are deliberately NOT reachable by a flag.
//     They are live by definition, and a `--force` that deleted them would be a
//     flag whose meaning is "ignore the taxonomy". Cancel them until they are
//     terminal, and then clean them.
const DAY_MS = 86400000;

function cmdClean(opts) {
  const root = jobsRoot();
  const all = Boolean(opts.all);
  const days = opts.olderThan === undefined ? null : Number(opts.olderThan);
  if (!all && days === null) {
    fail(
      'clean: say what to remove — nothing is removed by default.\n' +
      '  clean --all                 every job in a terminal state (done, failed, killed)\n' +
      '  clean --older-than <days>   the terminal ones that finished more than <days> days ago\n' +
      'Jobs that may still own processes (running, kill-pending, stale, kill-failed, unknown) and\n' +
      'jobs whose job.json is corrupt are never removed by either: the first may still be billing,\n' +
      'and the second is the only evidence of how it broke.'
    );
  }
  if (days !== null && (!Number.isFinite(days) || days < 0)) {
    fail(`clean: --older-than ${JSON.stringify(String(opts.olderThan))} is not a number of days.`);
  }
  const cutoff = days === null ? null : Date.now() - days * DAY_MS;

  const removed = [];
  const kept = [];
  const failures = [];
  for (const job of allJobs()) {
    // A link named like a job id is not a job directory, and this verb is the
    // one that REMOVES things — so the classification `allJobs` already made is
    // honoured before anything else is read or resolved.
    if (!job.contained) {
      kept.push(`${job.id}  refused: not a job directory this runtime created (${clean(job.record.corruptReason)})`);
      continue;
    }
    const state = effectiveState(job);
    if (!ROLE_RELEASE_STATES.includes(state)) {
      kept.push(`${job.id}  ${state}`);
      continue;
    }
    const when = Date.parse(job.record.finished || job.record.started);
    if (cutoff !== null && !(Number.isFinite(when) && when < cutoff)) {
      kept.push(`${job.id}  ${state}, ${Number.isFinite(when) ? `${humanDuration(Date.now() - when)} old` : 'no usable timestamp'}`);
      continue;
    }
    // The whitelist and the containment assert, separately, exactly as every
    // other path-taking operation in this runtime does them: the id must be one
    // this runtime could have generated, AND the directory it resolves to must
    // be provably inside the real jobs root before anything is removed.
    const dir = jobDirFor(root, job.id);
    if (!dir || dir !== job.dir) {
      kept.push(`${job.id}  refused: the directory name is not a job id this runtime could have generated`);
      continue;
    }
    assertInsideRoot(root, dir, 'remove a job directory');
    // Under the record lock, and re-decided inside it: the state read above is a
    // read from outside, and this is a removal. The same compare-and-swap
    // discipline every other terminal decision here uses, with the removal in
    // place of the write.
    const held = withRecordLock(dir, () => {
      const current = readRecord(dir);
      if (isCorrupt(current) || !ROLE_RELEASE_STATES.includes(canonicalState(current))) {
        return { removed: false, why: 'changed under the lock — not removed' };
      }
      try {
        removeJobDir(dir);
        return { removed: true };
      } catch (err) {
        // ONE STUCK FILE MUST NOT END THE RUN. A handle held on `run.log` (a
        // watcher, an editor, an antivirus scan) makes a removal fail on
        // Windows, and an uncaught throw out of here would abort the whole
        // clean at whichever job happened to be first.
        return { removed: false, failed: true, why: `could not be removed: ${clean(err.code || err.message)}` };
      }
    });
    const outcome = held.locked
      ? held.value
      : { removed: false, why: 'its record could not be locked — not removed' };
    if (outcome.removed) {
      removed.push(job.id);
    } else {
      kept.push(`${job.id}  ${outcome.why}`);
      if (outcome.failed) failures.push(`${job.id}: ${outcome.why}`);
    }
  }

  if (!removed.length && !kept.length) return console.log(`no jobs in ${root}`);
  for (const id of removed) console.log(`removed: ${id}`);
  if (kept.length) {
    console.log(kept.length === 1 ? 'kept 1 job:' : `kept ${kept.length} jobs:`);
    for (const line of kept) console.log(`  ${line}`);
  }
  console.log(`removed ${removed.length} of ${removed.length + kept.length} in ${root}`);
  if (failures.length) {
    process.stderr.write(
      `WARNING: ${failures.length} job director${failures.length === 1 ? 'y' : 'ies'} could not be removed:\n` +
      failures.map((f) => `  ${f}\n`).join('') +
      `Something is holding a file open, or is sitting in the directory (a watcher window, an editor,\n` +
      `a virus scanner, a shell). Each of them still has its job.json — put back if it had already\n` +
      `been removed when the failure hit — so it still lists, still reads as finished, and a later\n` +
      `clean will take it. Nothing was left half-removed and invisible, and the one case that could\n` +
      `not be put back would have said so above.\n`
    );
  }
}

// A job directory is dismantled with its RECORD LAST, because `job.json` is what
// makes the directory visible at all: `allJobs` skips an entry without one, so a
// removal that died partway with the record already gone would leave a directory
// that `list`, `status` and `clean` itself can never see again — undeletable by
// this runtime and invisible to the operator. Removing the contents first and the
// record last means a failure anywhere leaves a job that still lists, still reads
// as finished, and can simply be cleaned again.
//
// `job.json.lock` is skipped in the loop for the same reason from the other end:
// this process is holding it, and removing it while the record is still there
// would let another writer take the lock mid-removal.
//
// `recursive` unlinks a link rather than following it, and the caller has already
// proved this path is inside the real jobs root, so neither half can walk out.
//
// AND THE LAST STEP CAN FAIL ON ITS OWN, which is the half that promise was
// missing. On Windows a directory that is some process's current directory
// unlinks every file inside it happily and then refuses the rmdir (EPERM) — so
// the ordering above delivered exactly the outcome it was written to prevent:
// job.json gone, the directory still there, invisible to `allJobs` for ever.
// The record's bytes are therefore held in hand across that last removal and put
// straight back if it throws. A restore that itself fails is reported loudly,
// because it is the one case where a job really has become unlistable.
//
// AND THE PUT-BACK IS A WRITE TO job.json, so it happens UNDER THE LOCK like
// every other one. `fs.rmSync(dir, { recursive: true })` removes the children
// first — the lock this removal is holding among them — and only then fails on
// the directory itself, so the restore below used to write a lock-governed file
// with no lock in existence at all. The order is therefore fixed: the record goes
// while the lock is still held, the lock is handed back next (this function is
// called holding it and returns it itself), and a restore RE-ACQUIRES it through
// the ordinary path. A restore that cannot take the lock writes NOTHING and says
// so — an unlistable job is recoverable by hand, an unlocked write over a record
// another writer is holding is not.
// AND A STRANDED LIVE LOCK IS NOT LITTER TO SWEEP UP WITH THE JOB. The loop
// below removes everything but the record and the lock, tombstones included —
// and a `.stale-*` tombstone can hold a LIVE holder's lock (see `liveLockTomb`),
// so removing it blind is the one deletion of a live lock this runtime would
// perform, by way of the verb that is supposed to be tidying up. The whole job
// is refused instead, loudly and by job, which the caller already handles: one
// stuck job does not end a clean run, it lists, and a later clean takes it once
// whatever is holding that lock is gone. A dead-or-absent holder's tombstone
// goes with the job as before.
function removeJobDir(dir) {
  const live = liveLockTomb(dir);
  if (live) {
    throw new Error(
      `a record lock whose holder is still alive is stranded in ${path.basename(live)}`
      + ' — removing this job would delete a live lock');
  }
  for (const name of fs.readdirSync(dir)) {
    if (name === 'job.json' || name === RECORD_LOCK) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
  let raw = null;
  try { raw = fs.readFileSync(recordPath(dir)); } catch { /* already gone: nothing to put back */ }
  fs.rmSync(recordPath(dir), { force: true });
  // Ours to give back, and only ours: released by the same identity test
  // `withRecordLock` releases by, because a lock this process no longer holds is
  // somebody else's and is not this removal's to delete.
  const lock = path.join(dir, RECORD_LOCK);
  try { if (lockHolderIsSelf(lock)) fs.rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if (raw !== null) {
      let restoreErr = null;
      const held = withRecordLock(dir, () => {
        try { fs.writeFileSync(recordPath(dir), raw); return true; } catch (e) { restoreErr = e; return false; }
      });
      if (!held.locked || !held.value) {
        process.stderr.write(
          `WARNING: job directory ${dir} could not be removed (${clean(err.code || err.message)}), and its\n` +
          `job.json could not be put back (${restoreErr
            ? clean(restoreErr.code || restoreErr.message)
            : 'its record lock could not be re-acquired, and nothing writes that file without it'}). ` +
          `Without a record\nthat directory is invisible to list, status and clean — remove it by hand.\n`
        );
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------- watch
//
// Watching is a HUMAN affordance: a detached console window that follows the run
// and then shouts, for the operator who has been burned by dropped wake-up
// notifications four times in one day and does not trust a silent terminal.
// Agents must never watch — they poll `result`.

// The watcher window's command line, as data, because every defect in argv
// construction here is invisible until the output is asserted directly.
//
// `start` gives the watcher its own console window; `cmd /k` keeps that window
// open after the banner so the news survives the process that delivered it. The
// node in the middle used to be the literal string `node` — the only spawn in
// this runtime that did not go through `process.execPath`. On a machine where
// node is not on the INTERACTIVE path (a nvm shim, a portable install, a PATH
// that a parent process trimmed) the window opened, printed "'node' is not
// recognized", and `watch` reported success: a claim made instead of a fact
// checked, in the affordance that exists because notifications get dropped.
//
// Everything on this line is quoted with `cmdQuote`, which REFUSES `% ! "`
// rather than escaping them — so an execPath or a runtime path carrying one is a
// loud refusal naming the fault, not a window that silently runs something else.
//
// AND THE TAIL AFTER /K NEEDS ONE MORE PAIR OF QUOTES THAN LOOKS RIGHT, which is
// the defect the first version of this shipped with (review, 2026-08-07,
// reproduced). `cmd /k <tail>` does not parse the tail as an argv: with no /S it
// preserves the quotes only when the tail contains EXACTLY TWO of them, and
// otherwise falls back to "strip the first character if it is a quote, and strip
// the last quote on the line". Quote both the node path and the runtime path —
// which is every install under `C:\Program Files\nodejs` whose plugin also lives
// under a path with a space — and the tail has four, so cmd stripped the opening
// quote of the node path and the closing quote of the script path and ran
// `C:\Program`. A window that opens saying "'C:\Program' is not recognized"
// while `watch` prints `watching:` is the same false success the literal `node`
// produced, in a narrower population.
//
// So the whole command is built as ONE string, quoted by `cmdQuote` token by
// token, and handed to `cmd /s /k` wrapped in an outer pair. `/s` makes that
// second rule unconditional: cmd strips exactly the outer pair and runs what is
// left verbatim, whatever the inner quoting looks like. Verified end to end on
// Windows for all four combinations of (node path quoted / not) × (runtime path
// quoted / not), and the executing test below is what keeps it verified — the
// broken version passed an argv-shape assertion perfectly.
export function watchLaunchArgs(id, { title = `codex-dispatch ${id}`, node = process.execPath, self = SELF } = {}) {
  const inner = [node, self, '_watch', id].map(cmdQuote).join(' ');
  return ['/c', 'start', cmdQuote(title), 'cmd', '/s', '/k', `"${inner}"`];
}

function watchFailMessage(id, dir, detail) {
  return (
    `watch: FAILED to open a watcher console window for ${id}.\n` +
    `${detail}\n` +
    `The job itself is unaffected — nothing about it depends on being watched.\n` +
    `Follow it here instead:\n` +
    `  node "${SELF}" status ${id}\n` +
    `out: ${outPath(dir)}`
  );
}

function cmdWatch(id, { fromDispatch } = {}) {
  const job = getJob(id);
  if (!WIN) {
    const msg =
      `watch: spawning a detached console window is Windows-only in this release.\n` +
      `Follow it here instead:\n` +
      `  tail -f ${runLogPath(job.dir)}\n` +
      `  node "${SELF}" status ${id}\n` +
      `out: ${outPath(job.dir)}`;
    if (fromDispatch) { process.stderr.write(msg + '\n'); return; }
    fail(msg);
  }
  const title = `codex-dispatch ${id}`;
  const launcher = process.env.CODEX_DISPATCH_TEST_WATCH_BIN || 'cmd';
  let args;
  try {
    args = watchLaunchArgs(id, { title });
  } catch (err) {
    // Fail closed exactly as the WIN gate does: a value that cannot survive a
    // cmd.exe command line is refused, never mangled. Reported through the same
    // channel a launcher failure is, so `dispatch --watch` does not turn a
    // running job into a failed dispatch over a window.
    const msg = watchFailMessage(id, job.dir, `the watcher command line cannot be built: ${clean(err.message)}`);
    if (fromDispatch) { process.stderr.write(msg + '\n'); return; }
    fail(msg);
  }
  // Verbatim: the arguments below are already quoted for cmd.exe by `cmdQuote`,
  // and letting libuv quote them again would put backslash-escaped quotes on a
  // line cmd.exe parses by quote parity — two conventions that disagree (see
  // CMD_UNSAFE). One quoting pass, by the function this runtime already uses.
  const child = spawn(launcher, args, {
    detached: true,
    stdio: 'ignore',
    windowsVerbatimArguments: true,
  });

  // A detached spawn that fails is silent: no window opens and the caller is told
  // one did. That is the same defect as every other one in this runtime — a claim
  // made instead of a fact checked — so the launcher gets a moment to fall over
  // before this prints anything. `cmd /c start` hands off and exits 0 almost
  // immediately, so exit 0 IS the success signal here; a nonzero exit or a spawn
  // error is not.
  let settled = false;
  let timer;
  const succeed = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.unref();
    console.log(`watching: ${id} in a new console window titled "${title}"`);
    if (!fromDispatch) console.log(`out: ${outPath(job.dir)}`);
  };
  const failed = (detail) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const msg = watchFailMessage(id, job.dir, detail);
    // From `dispatch --watch` the job is already launched and its handle already
    // printed; a window that would not open must not turn that into a failure.
    if (fromDispatch) { process.stderr.write(msg + '\n'); return; }
    fail(msg);
  };
  child.on('error', (err) => failed(`spawn error from "${launcher}": ${err.message}`));
  child.on('exit', (code) => {
    if (code === 0) succeed();
    else failed(`the launcher "${launcher}" exited ${code} without opening a window.`);
  });
  timer = setTimeout(succeed, WATCH_SPAWN_GRACE_MS);
}

function tailInitial(file, lines = 30) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return 0; }
  if (!size) return 0;
  const CHUNK = Math.min(size, 65536);
  const fd = fs.openSync(file, 'r');
  let text = '';
  try {
    const buf = Buffer.alloc(CHUNK);
    const n = fs.readSync(fd, buf, 0, CHUNK, size - CHUNK);
    text = buf.toString('utf8', 0, n);
  } finally { fs.closeSync(fd); }
  const all = text.split(/\r?\n/);
  process.stdout.write(stripControlBytes(all.slice(-lines).join('\n')) + '\n');
  return size;
}

function tailMore(file, pos) {
  let size = 0;
  try { size = fs.statSync(file).size; } catch { return pos; }
  if (size < pos) pos = 0; // truncated or replaced
  if (size <= pos) return pos;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - pos);
    const n = fs.readSync(fd, buf, 0, buf.length, pos);
    process.stdout.write(stripControlBytes(buf.toString('utf8', 0, n)));
  } finally { fs.closeSync(fd); }
  return size;
}

function cmdWatchInline(id) {
  const job = getJob(id);
  try { process.title = `codex-dispatch ${id}`; } catch { /* not a console */ }
  const bar = '='.repeat(66);
  const log = runLogPath(job.dir);
  const out = outPath(job.dir);
  console.log(bar);
  // ASCII only in this window: it may be a legacy conhost on a codepage that
  // renders anything else as mojibake, and the banner is the one thing here that
  // has to be readable from across the room.
  console.log(`  codex-dispatch - watching ${id}`);
  console.log(`  log: ${log}`);
  console.log(`  out: ${out}`);
  console.log(bar);

  const finish = (state, record) => {
    const r = record;
    // Every field below comes out of job.json, which carries text codex produced.
    // The write boundary strips control bytes going in; this strips them coming
    // out, because a record written by an older release never went through it —
    // and this banner is the one thing here that has to be unforgeable.
    const deliver = state === 'done' ? deliverability(r) : { ok: false };
    process.stdout.write('\x07');
    console.log('');
    console.log(bar);
    // The banner says what actually happened. It used to announce "JOB FINISHED -
    // result is ready" for every terminal state, so a job that failed its sight
    // precheck, was killed, or could not be killed all ended on the same cheerful
    // line — and `result` then refused the answer the window had just promised.
    // A window that shouts is only worth having if what it shouts is true.
    if (deliver.ok) console.log('  JOB FINISHED - result is ready');
    else if (state === 'done') console.log('  JOB ENDED - state: done (unvouched)');
    else console.log(`  JOB ENDED - state: ${state}`);
    console.log(bar);
    console.log(`  job:     ${clean(id)}`);
    console.log(`  state:   ${state}`);
    if (isCorrupt(r)) {
      console.log(`  reason:  corrupt job.json (${clean(r.corruptReason)})`);
    } else {
      if (r.reason) console.log(`  reason:  ${clean(r.reason)}`);
      if (r.sight) console.log(`  sight:   ${clean(r.sight)}`);
      if (r.warning) console.log(`  warning: ${clean(r.warning)}`);
      if (r.killSurvivors && state === 'kill-failed') console.log(`  survivors: ${clean(r.killSurvivors)}`);
    }
    console.log(`  out:     ${out}${fs.existsSync(out) ? '' : '   (no answer file)'}`);
    if (deliver.ok) console.log(`  collect: node "${SELF}" result ${id}`);
    else if (state === 'done') console.log(`  next:    result will REFUSE this job (${deliver.reason}). The bytes are at the out: path above.`);
    else console.log(`  next:    ${watchNextStep(state, r, id)}`);
    console.log(bar);
    console.log('This window is yours to close.');
  };

  // A live state is not an end. `kill-pending`, `kill-failed`, `stale` and
  // `unknown` are all states in which this runtime says processes may still be
  // alive — and the watcher used to print `JOB ENDED` for every one of them and
  // exit, which is the same defect as the old cheerful banner in the other
  // direction: a claim made rather than a fact checked, in the one line meant to
  // be believed from across the room. It keeps watching now, says what is
  // happening, and ends only when the job really has. (Codex arm, round three.)
  const live = (state) => LIVE_STATES.includes(state);
  const notice = (state, r) => {
    console.log('');
    console.log(bar);
    console.log(`  JOB NOT FINISHED - state: ${state}`);
    console.log(bar);
    console.log(`  ${watchLiveNote(state, r, id)}`);
    console.log('  still watching - this state can still change, and nothing here will call it an end.');
    console.log(bar);
  };

  let pos = tailInitial(log);
  let corruptReads = 0;
  let announced = null;
  const tick = () => {
    pos = tailMore(log, pos);
    const record = readRecord(job.dir);
    const state = effectiveState({ id, dir: job.dir, record });
    // job.json is replaced by rename, and a reader can land in the gap. Treating
    // the first unreadable read as the end killed the watcher on a perfectly
    // healthy job — the record is corrupt only if it is STILL corrupt after
    // re-reading, which is a claim worth a second of patience.
    if (state === 'corrupt' && ++corruptReads < CORRUPT_CONFIRM_TRIES) {
      setTimeout(tick, CORRUPT_CONFIRM_MS);
      return;
    }
    if (state !== 'corrupt') corruptReads = 0;
    if (live(state)) {
      if (state !== 'running' && state !== announced) { announced = state; notice(state, record); }
      setTimeout(tick, 500);
      return;
    }
    pos = tailMore(log, pos);
    finish(state, record);
  };
  tick();
}

// What a live-but-not-running state means, for the window that keeps watching it.
function watchLiveNote(state, r, id) {
  switch (state) {
    case 'kill-pending':
      return (
        'a cancel landed before this job had registered anything to kill, so nothing died and nothing ' +
        `may assume it did - re-run: node "${SELF}" cancel ${id}`
      );
    case 'kill-failed':
      return (
        `pids ${clean((!isCorrupt(r) && r.killSurvivors) || '?')} SURVIVED the kill and may still be ` +
        'billing - kill them yourself: taskkill /PID <pid> /T /F'
      );
    case 'stale':
      return (
        'the supervisor is gone and this job was never finalized; codex may have been reparented and ' +
        `may still be running - reap it: node "${SELF}" cancel ${id}`
      );
    case 'unknown':
      return (
        `the record's state is not one this release knows (${clean((!isCorrupt(r) && r.state) || '?')}), ` +
        'so nothing may be concluded about what it owns'
      );
    default:
      return `node "${SELF}" status ${id}`;
  }
}

// What to do next, per terminal state — because for every state but `done` the
// next step is NOT "collect the result": `result` will refuse it.
function watchNextStep(state, r, id) {
  const statusCmd = `node "${SELF}" status ${id}`;
  switch (state) {
    case 'failed': {
      const reason = clean((!isCorrupt(r) && r.reason) || 'see the log above');
      const cure = (reason === 'sandbox-blind-precheck' || reason === 'sight-unproven')
        ? ' Nothing was billed - codex never ran. Fix the install or the --cd and re-dispatch;'
        : '';
      return `result will REFUSE this job (${reason}).${cure} ${statusCmd}`;
    }
    case 'killed':
      return `this job was cancelled; result will REFUSE it. ${statusCmd}`;
    // kill-pending, kill-failed, stale and unknown never reach here: they are live
    // states, and the watcher keeps watching them rather than declaring an end.
    // See watchLiveNote for what it says about each instead.
    case 'corrupt':
      return (
        'job.json stayed unreadable across re-reads; result will REFUSE it. The bytes, if any, ' +
        'are at the out: path above - read them by hand if you trust them.'
      );
    default:
      return statusCmd;
  }
}

// ----------------------------------------------------------------------- main

const BOOL_FLAGS = new Set(['write', 'force', 'watch', 'allow-unproven-sight', 'all']);
const camelCase = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) opts[camelCase(name)] = true;
    else opts[camelCase(name)] = argv[++i];
  }
  return opts;
}

function main() {
  try {
    return run();
  } catch (err) {
    // Only the quoting refusal, and only so it reads as the refusal it is rather
    // than as a crash. Everything else keeps its stack: a broad catch here would
    // turn real defects into tidy one-liners, which is the opposite of what this
    // runtime is for. Reachable from preflight and the sight probe, where a binary
    // path — `CODEX_DISPATCH_BIN` is documented as trusted and unchecked — carries
    // one of the refused characters.
    if (err && err.code === 'CMD_UNQUOTABLE') fail(err.message);
    throw err;
  }
}

function run() {
  const [verb, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  switch (verb) {
    case 'dispatch': cmdDispatch(opts); break;
    case 'status': cmdStatus(opts._[0]); break;
    case 'result': cmdResult(opts._[0]); break;
    case 'cancel': cmdCancel(opts._[0]); break;
    case 'list': cmdList(); break;
    case 'clean': cmdClean(opts); break;
    case 'watch': cmdWatch(opts._[0]); break;
    case 'preflight': preflight(); break;
    case '_supervise': cmdSupervise(opts._[0]); break;
    case '_watch': cmdWatchInline(opts._[0]); break;
    default:
      fail(
        'usage: node codex-dispatch.mjs <verb>\n' +
        '  dispatch --brief <file> [--role <stem>] [--cd <dir>] [--model <m>] [--effort <e>]\n' +
        '           [--write] [--force] [--watch] [--allow-unproven-sight]\n' +
        '  status [<job-id>]\n' +
        '  result <job-id>\n' +
        '  cancel <job-id>\n' +
        '  list\n' +
        '  clean --all | --older-than <days>\n' +
        '  watch <job-id>\n' +
        '  preflight'
      );
  }
}

// Run only when invoked as a program; importing it (the unit tests do) must be
// inert. Compared case-insensitively on Windows so a differently-cased path can
// never turn the CLI into a silent no-op.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const entry = path.resolve(process.argv[1]);
  return WIN ? entry.toLowerCase() === SELF.toLowerCase() : entry === SELF;
}

if (invokedDirectly()) main();

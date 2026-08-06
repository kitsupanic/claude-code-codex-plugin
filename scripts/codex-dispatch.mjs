#!/usr/bin/env node
// codex-dispatch — background job runtime for verbatim Codex CLI dispatches.
// Node 18+, zero npm dependencies, Windows-first.
//
// Verbs: dispatch, status, result, cancel, list, watch, preflight,
//        _supervise / _watch (internal)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
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
export const RECORD_VERSION = 1;

// The only `sight` value that is proof, and the only one that is a recorded
// opt-in. Both are compared exactly; neither is ever inferred from prose.
export const PROVEN_SIGHT_PREFIX = 'cwd-file:';
export const ACCEPTED_SIGHT = 'unproven (accepted by caller)';

// States in which a job may still own live processes. These block their role,
// are cancellable, and are what `--force` has to kill (and verify) first.
// `kill-pending` is one of them: a cancel that arrived before the job had a kill
// target killed nothing, so nothing may treat it as dead.
export const LIVE_STATES = ['running', 'kill-pending', 'stale', 'kill-failed'];

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

// The job directory for an id — or null when the id is not one this runtime could
// have generated, or when joining it would leave the jobs root.
export function jobDirFor(root, id) {
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) return null;
  const dir = path.join(root, id);
  return isInsideRoot(root, dir) ? dir : null;
}

// Loud refusal, never best-effort: a path that cannot be PROVED to be inside the
// jobs root is not operated on at all.
function assertInsideRoot(root, target, action) {
  if (isInsideRoot(root, target)) return target;
  fail(
    `REFUSING to ${action}: ${JSON.stringify(String(clean(target)))}\n` +
    `That path is outside the jobs root (${path.resolve(root)}).\n` +
    `Something wrote a job id, role or claim owner this runtime would never generate. Nothing has\n` +
    `been read, renamed, removed or killed.`
  );
  return null; // unreachable: fail() exits
}

function jobsRoot() {
  if (process.env.CODEX_DISPATCH_JOBS) return process.env.CODEX_DISPATCH_JOBS;
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'codex-dispatch', 'jobs');
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
const NUMBER_FIELDS = ['supervisorPid', 'codexPid', 'exitCode', 'recordVersion'];
const BOOLEAN_FIELDS = ['allowUnprovenSight'];
const NUMBER_ARRAY_FIELDS = ['reapedPids'];
const REQUIRED_FIELDS = ['state', 'started'];

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

const typeName = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

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
  for (const key of REQUIRED_FIELDS) {
    if (!parsed[key]) return `field "${key}" is missing`;
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
  const sight = typeof record.sight === 'string' ? record.sight : '';
  if (sight.startsWith(PROVEN_SIGHT_PREFIX)) return { ok: true, how: `sight proven (${clean(sight)})` };
  if (sight === ACCEPTED_SIGHT) {
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
      `sight is ${sight ? JSON.stringify(clean(sight)) : 'not recorded'}, which is not proof — only ` +
      `"${PROVEN_SIGHT_PREFIX}<name>" is, and only a recorded --allow-unproven-sight substitutes for it`,
  };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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

function writeRecord(dir, record) {
  const tmp = path.join(dir, `job.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(sanitizeRecord(record), null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(tmp, recordPath(dir)); } catch (err) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleepSync(20);
    }
  }
}

function updateRecord(dir, patch) {
  const current = readRecord(dir);
  if (isCorrupt(current)) return null;
  const record = { ...current, ...patch };
  writeRecord(dir, record);
  return record;
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

function allJobs() {
  const root = jobsRoot();
  if (!fs.existsSync(root)) return [];
  const jobs = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.existsSync(recordPath(dir))) continue; // not a job dir
    jobs.push({ id: name, dir, record: readRecord(dir) });
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
// moment out.txt existed; that is revoked (see README → Decisions). The answer
// file appears the instant codex writes it — BEFORE the exit code is recorded and
// BEFORE any sight verdict — so file-existence promotion opened a window in which
// a job read `done` while nothing had yet vouched for it. A supervisor that dies
// before finalizing now leaves the job `stale`, which is the truth: nobody ever
// confirmed how it ended.
function effectiveState(job) {
  const r = job.record;
  if (isCorrupt(r)) return 'corrupt';
  if (r.state !== 'running') return r.state;
  if (!pidAlive(r.supervisorPid)) {
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
// DEMOTED (see README → Decisions): this scan no longer decides anything. It is
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
  '  - Nothing readable in the job\'s --cd (empty, all binary, or every candidate name carries\n' +
  '    %, ^, & or !): point --cd at the directory the model actually has to read.\n' +
  '  - Accept it knowingly: re-dispatch with --allow-unproven-sight. The job then runs, the\n' +
  '    record carries `sight: unproven (accepted by caller)`, status and result both say so,\n' +
  '    and the answer is delivered with that caveat attached.';

// ---------------------------------------------------------------- codex binary

const isScript = (bin) => /\.(mjs|cjs|js)$/i.test(bin);

// Windows cmd-line quoting for shell:true spawns (codex.cmd needs a shell).
function cmdQuote(s) {
  return /[\s&|<>()^"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function spawnCodex(bin, args, opts) {
  if (isScript(bin)) return spawn(process.execPath, [bin, ...args], opts);
  if (WIN) return spawn([bin, ...args].map(cmdQuote).join(' '), { ...opts, shell: true });
  return spawn(bin, args, opts);
}

function runCodexSync(bin, args, opts = {}) {
  const base = { encoding: 'utf8', ...opts };
  if (isScript(bin)) return spawnSync(process.execPath, [bin, ...args], base);
  if (WIN) return spawnSync([bin, ...args].map(cmdQuote).join(' '), { ...base, shell: true });
  return spawnSync(bin, args, base);
}

function whereHits(name) {
  if (!WIN) return [];
  const r = spawnSync('where', [name], { encoding: 'utf8' });
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

// One sandboxed read, verified by its content. `codex sandbox <cmd>` runs a real
// command inside codex's own sandbox: no model call, no tokens, no billing,
// ~300 ms. The check is POSITIVE — the bytes we expect have to come back — which
// is what makes it robust against failure shapes nobody has seen yet.
// Returns { state: 'functional' | 'broken' | 'unavailable' | 'unprovable', detail }.
function sandboxRead(bin, file, { cwd, token } = {}) {
  const args = WIN
    ? ['sandbox', 'cmd', '/c', 'type', file]
    : ['sandbox', 'sh', '-c', `cat ${JSON.stringify(file)}`];
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
  const r = runCodexSync(bin, args, cwd ? { cwd } : {});
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
  return { state: 'broken', detail: firstLine };
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

// 128 bits of Math.random-grade entropy, which is the right strength for this:
// the secret has to be unguessable by a stand-in that never read the file, not
// unforgeable by an attacker who can read our memory.
function randomToken() {
  return `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`.slice(0, 20);
}

// Pick a file that ALREADY EXISTS in the job's cwd, plus a token from it to
// verify the read by. Never writes there: a job's `--cd` is somebody's repo, and
// a runtime that litters it is one nobody points at anything precious.
// The token is ASCII-only so a console codepage cannot mangle the comparison, and
// names carrying cmd.exe's expansion characters are skipped rather than trusted
// to the documented best-effort quoting.
//
// WHERE the token comes from is the security property. It used to be the file's
// first line, which is exactly the part a tool that never opened the file is most
// likely to be able to produce — a header, a shebang, a name repeated from the
// path. A stand-in that read nothing and echoed its argv passed the proof that
// way. Now it comes from BELOW the first line, must be long enough to be
// content rather than boilerplate, and must not contain (or be contained in) the
// file's own name: bytes nobody can produce without having read the file.
const PRINTABLE_ASCII_LINE = /^[\x20-\x7E]+$/;

export function pickProbeTarget(dir, { limit = 20, maxBytes = 1024 * 1024 } = {}) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const names = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  let examined = 0;
  for (const name of names) {
    if (examined >= limit) break;
    if (/[%^&!"]/.test(name)) continue;
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
  if (!fs.existsSync(cwd)) {
    return { state: 'broken', mode: 'none', detail: `the job cwd does not exist: ${cwd}` };
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
  if (process.env.CODEX_DISPATCH_BIN) {
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

function readClaimOwner(lockDir) {
  try { return parseClaimOwner(fs.readFileSync(claimOwnerPath(lockDir), 'utf8')); } catch { return { owner: null }; }
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
function reclaimClaim(root, role) {
  const lockDir = roleLockDir(root, role);
  const tomb = assertInsideRoot(
    root,
    path.join(root, ROLE_LOCKS, `.reclaimed-${role}-${Date.now()}-${process.pid}`),
    'stage a reclaimed role lock'
  );
  try {
    fs.renameSync(lockDir, tomb);
  } catch (err) {
    return err.code === 'ENOENT'; // already gone: somebody else got there first
  }
  try { fs.rmSync(tomb, { recursive: true, force: true }); } catch { /* best effort */ }
  return true;
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
  const { owner, invalid } = readClaimOwner(lockDir);
  // An unreadable owner is not proof the claim is ours, and releasing it would
  // hand the role away on a guess.
  if (invalid !== undefined) return;
  if (owner && jobId && owner !== jobId) return;
  reclaimClaim(root, role);
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
  const { owner, invalid } = readClaimOwner(lockDir);
  const age = claimAge(lockDir);
  // An owner that is not a job id is CORRUPT, not "an owner we will do our best
  // with". Nothing is derived from it, nothing is reaped, nothing is reclaimed:
  // this claim needs a human to look at it.
  if (invalid !== undefined) {
    return { status: 'corrupt', owner: null, invalid, lockDir, detail: 'the claim owner is not a job id' };
  }
  if (!owner) {
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
      if (!killed.ok) {
        return {
          ok: false,
          message: killed.pending
            ? killPendingMessage(claim.job, role)
            : killFailedMessage(claim.job, killed),
        };
      }
      console.log(`killed previous job: ${claim.job.id} (was ${claim.state})`);
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
    // Re-read the owner immediately before taking the claim away: it may have
    // changed hands while this dispatch was inspecting it, and a reclaim is a
    // rename that does not care whose directory it moves.
    if (readClaimOwner(lockDir).owner !== claim.owner) continue;
    reclaimClaim(root, role);
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
  if (win) return { tool: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  return { signals: [-pid, pid] };
}

function killTree(pid) {
  if (!pid) return;
  // Test-only: simulate a kill that does not take effect, so the verified-kill
  // path has a regression test that does not depend on finding a genuinely
  // unkillable process. Never set outside the suite.
  if (process.env.CODEX_DISPATCH_TEST_NOKILL) return;
  const plan = killPlan(pid);
  if (plan.tool) { spawnSync(plan.tool, plan.args, { stdio: 'ignore' }); return; }
  for (const target of plan.signals) {
    try { process.kill(target, 'SIGKILL'); } catch { /* already gone, or never a group */ }
  }
}

// taskkill's exit code lies often enough to be useless (it reports success for
// "process not found" and failure for children it already reaped with the tree),
// so the kill is verified by asking the OS afterwards, not by trusting the tool.
function waitGone(pids, ms = KILL_VERIFY_MS) {
  const deadline = Date.now() + ms;
  let alive = pids.filter(pidAlive);
  while (alive.length && Date.now() < deadline) {
    sleepSync(50);
    alive = alive.filter(pidAlive);
  }
  return alive;
}

// Kills every pid and returns the ones that were STILL ALIVE afterwards.
function killPids(pids) {
  const unique = [...new Set(pids.filter(Boolean))];
  for (const pid of unique) killTree(pid);
  return waitGone(unique);
}

// Pids recorded as plain files in the job dir, one or more per file. The
// supervisor writes supervisor.pid/codex.pid; the tests' fake codex writes
// child.pid. These are the only kill targets that survive a corrupt job.json.
const PID_FILES = ['supervisor.pid', 'codex.pid', 'child.pid'];
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
function recordReapedPids(dir, pids) {
  const list = [...new Set(pids.filter((n) => Number.isInteger(n) && n > 0))];
  if (!list.length) return;
  try {
    const prior = readPidList(path.join(dir, REAPED_PIDS_FILE));
    fs.writeFileSync(
      path.join(dir, REAPED_PIDS_FILE),
      [...new Set([...prior, ...list])].join('\n') + '\n'
    );
  } catch { /* best effort: the record copy below is the other half */ }
  const current = readRecord(dir);
  if (isCorrupt(current)) return; // evidence — never rewritten
  const prior = Array.isArray(current.reapedPids) ? current.reapedPids : [];
  updateRecord(dir, { reapedPids: [...new Set([...prior, ...list])] });
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
function consumePidFiles(dir, pids = []) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const consumed = [];
  const failed = [];
  recordReapedPids(dir, pids);
  for (const name of PID_FILES) {
    const from = path.join(dir, name);
    if (!fs.existsSync(from)) continue;
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
  const survivors = killPids(pids);
  if (survivors.length) return { ok: false, survivors, targets: pids };
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
export function inRegistrationWindow(record, now = Date.now()) {
  if (!record || isCorrupt(record)) return false;
  if (record.supervisorPid) return false;
  if (record.launch === 'pending') return false;
  const started = Date.parse(record.started);
  return Number.isFinite(started) && now - started < CLAIM_GRACE_MS;
}

// Returns { ok, survivors, targets }. A kill that cannot be shown to have worked
// is NOT a kill: the job goes to `kill-failed`, keeps its role claim, and keeps
// blocking dispatch — because whatever survived may still be codex, still billing.
function killJob(job) {
  const r = job.record;
  const targets = [];
  if (!isCorrupt(r)) {
    if (r.supervisorPid) targets.push(r.supervisorPid);
    if (r.codexPid) targets.push(r.codexPid);
  }
  // When the supervisor is already dead — the stale case — codex has been
  // reparented out of its tree, so /T on the supervisor reaches nothing. Hit the
  // recorded pids directly: harmless when they are already gone, and the only
  // thing that stops an orphan billing. (Non-Windows has no tree kill at all,
  // so it always needed this.)
  targets.push(...recordedPids(job.dir));
  const unique = [...new Set(targets.filter(Boolean))];
  // Nothing to kill AND nothing has registered yet: report, do not declare. The
  // state stays live (`kill-pending` blocks the role and is cancellable), the
  // claim is NOT released, and the caller is told to retry — because the thing
  // this would otherwise have called dead is a supervisor that is still starting.
  if (!unique.length && inRegistrationWindow(r)) {
    updateRecord(job.dir, { state: 'kill-pending' });
    return { ok: false, pending: true, survivors: [], targets: [] };
  }
  const survivors = killPids(unique);
  const finished = new Date().toISOString();
  if (survivors.length) {
    // The pid files stay loaded on purpose: those processes are demonstrably still
    // alive, so the numbers are still theirs and still need firing at.
    updateRecord(job.dir, {
      state: 'kill-failed',
      finished,
      killSurvivors: survivors.join(', '),
    });
    return { ok: false, survivors, targets: unique };
  }
  const spent = consumePidFiles(job.dir, unique);
  const priorWarning = isCorrupt(r) ? undefined : r.warning;
  const renameWarning = spent.failed.length
    ? `pid file(s) could not be consumed: ${spent.failed.join('; ')}`
    : null;
  updateRecord(job.dir, {
    state: 'killed',
    finished,
    killSurvivors: undefined,
    warning: [priorWarning, renameWarning].filter(Boolean).join('; ') || undefined,
  });
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
    (state === 'kill-failed'
      ? `kill-failed: an earlier kill did not take — pids ${clean(job.record.killSurvivors) || '?'} were still alive afterwards.\n`
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
    `Inspect that file. If it is junk, delete the lock directory (${lockDir}) and re-dispatch.`
  );
}

function killPendingMessage(job, role) {
  return (
    `dispatch: REFUSING to launch — the previous "${role}" job could not be shown to have died.\n` +
    `job: ${job.id} (state: kill-pending)\n` +
    `It was cancelled inside its supervisor's registration window: there was nothing recorded to\n` +
    `kill, and "killed nothing" is not "is dead" — its supervisor may be starting codex right now.\n` +
    `Wait a moment and re-run; once the supervisor has registered, the kill has a target and can be\n` +
    `verified. Or dispatch under another --role.`
  );
}

function reapFailedMessage(role, claim, reaped) {
  return (
    `dispatch: REFUSING to launch — the "${role}" role is held by a job that cannot vouch for\n` +
    `itself, and its processes could not be killed.\n` +
    `job: ${clean(claim.owner)} (${clean(claim.detail)})\n` +
    `survivors: ${reaped.survivors.join(', ')}\n` +
    `A record that cannot be read says nothing about what is still running; taking the role while\n` +
    `those are alive is the double-dispatch this runtime exists to prevent, and if one of them is\n` +
    `codex it is still billing.\n` +
    `Kill them yourself (taskkill /PID <pid> /T /F) and re-run, or dispatch under another --role.`
  );
}

function killFailedMessage(job, killed) {
  return (
    `dispatch: REFUSING to launch — the previous "${clean(job.record.role)}" job could not be killed.\n` +
    `job: ${job.id}\n` +
    `survivors: ${killed.survivors.join(', ')}\n` +
    `Those processes are still alive; if one of them is codex it is still billing, and a new job\n` +
    `alongside it is the double-dispatch this runtime exists to prevent.\n` +
    `Kill them yourself (taskkill /PID <pid> /T /F) and re-run, or dispatch under another --role.`
  );
}

// ---------------------------------------------------------------------- verbs

function findRoleConflict(role) {
  for (const j of allJobs()) {
    if (isCorrupt(j.record) || j.record.role !== role) continue;
    const s = effectiveState(j);
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
  const { bin } = preflight({ quiet: true });

  const root = jobsRoot();
  fs.mkdirSync(root, { recursive: true });

  // A stale job blocks exactly like a running one. Stale means the supervisor is
  // gone while the out file never appeared: codex was very likely reparented and
  // is still running — and still billing. Letting that through is the orphan
  // failure this runtime exists to kill. Corrupt jobs cannot make that claim
  // about themselves, so they never block.
  const conflict = findRoleConflict(role);
  if (conflict) {
    if (!opts.force) fail(conflictMessage(conflict, conflict.state, role));
    const killed = killJob(conflict);
    if (!killed.ok) {
      fail(killed.pending ? killPendingMessage(conflict, role) : killFailedMessage(conflict, killed));
    }
    console.log(`killed previous job: ${conflict.id} (was ${conflict.state})`);
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
      model: opts.model || DEFAULT_MODEL,
      effort: opts.effort || DEFAULT_EFFORT,
      sandbox: opts.write ? 'workspace-write' : 'read-only',
      cwd: path.resolve(opts.cd || process.cwd()),
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

    // TEST HOOK: stands in for this dispatch being descheduled between winning the
    // claim and launching — the window a reclaimer can use. Never set outside the
    // suite; finding a real scheduler pause on demand is not portable.
    if (process.env.CODEX_DISPATCH_TEST_CLAIM_PAUSE_MS) {
      sleepSync(Number(process.env.CODEX_DISPATCH_TEST_CLAIM_PAUSE_MS));
    }
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
    // REGISTER THE KILL TARGET IN THE PARENT, before this dispatch returns and
    // before the job id is printed. The supervisor writing its own pid left a
    // window in which the record said `running` with nothing to kill: a cancel
    // landing there killed nothing, "verified" it, marked the job killed and
    // released the role while the supervisor went on to launch codex. The pid is
    // knowable here, at spawn time, so the window does not have to exist.
    updateRecord(dir, { supervisorPid: child.pid, launch: 'spawned' });
    fs.writeFileSync(path.join(dir, 'supervisor.pid'), String(child.pid));
    // Attached only so a late 'error' cannot throw out of an already-detached
    // child; the synchronous pid check above is what actually decides.
    child.on('error', (err) => {
      process.stderr.write(`dispatch: supervisor spawn reported an error: ${clean(err.message)}\n`);
    });
    child.unref();
  } catch (err) {
    releaseRole(root, role, id);
    fail(`dispatch: could not start job ${id}: ${err.message}`);
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
    : updateRecord(dir, { supervisorPid: process.pid });
  if (!record) {
    process.stderr.write(`supervisor: job.json is corrupt, refusing to run: ${dir}\n`);
    process.exit(1);
  }
  // Pid files mirror job.json: a corrupt record must not cost us the kill target.
  fs.writeFileSync(path.join(dir, 'supervisor.pid'), String(process.pid));
  const root = path.dirname(dir);
  const id = path.basename(dir);

  // ---- positive sight proof, in THIS job's cwd, before codex spends anything --
  // A probe that throws is a probe that did not prove anything, and a supervisor
  // that dies here would leave the job reading `running` forever. Same verdict as
  // a failed read: no proof, no job.
  let sight;
  try {
    sight = sightProbe(record.bin, record.cwd, dir);
  } catch (err) {
    sight = { state: 'broken', mode: 'none', detail: `the probe itself failed: ${err.message}` };
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
    updateRecord(dir, {
      state: 'failed',
      reason: 'sandbox-blind-precheck',
      sight: `${sight.mode} FAILED: ${sight.detail}`,
      finished: new Date().toISOString(),
    });
    releaseRole(root, record.role, id);
    process.exit(1);
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
  const proven = sight.state === 'functional' && sight.mode.startsWith(PROVEN_SIGHT_PREFIX);
  let warning;
  if (!proven) {
    const detail = sight.state === 'unavailable'
      ? `this codex has no "sandbox" subcommand (${sight.detail})`
      : sight.state === 'unprovable'
        ? `the read could not be posed as a proof: ${sight.detail}`
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
      updateRecord(dir, {
        state: 'failed',
        reason: 'sight-unproven',
        sight: `unproven: ${detail}`,
        finished: new Date().toISOString(),
      });
      releaseRole(root, record.role, id);
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
  if (now.state !== 'running') {
    if (now.state === 'kill-pending') {
      // The cancel could not reach us then; it can be honoured now, by us.
      updateRecord(dir, {
        state: 'killed',
        reason: 'cancelled-during-registration',
        finished: new Date().toISOString(),
      });
      releaseRole(root, record.role, id);
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
  // Detached on POSIX so codex leads its own process group: that group IS the
  // tree a kill has to reach, since there is no `taskkill /T` off Windows and the
  // sandbox helpers codex spawns are its children, not ours.
  const child = spawnCodex(record.bin, args, {
    stdio: [promptFd, logFd, logFd],
    windowsHide: true,
    detached: !WIN,
  });
  child.on('error', (err) => {
    fs.appendFileSync(runLogPath(dir), `supervisor: spawn failed: ${clean(err.message)}\n`);
    updateRecord(dir, {
      state: 'failed', reason: 'codex-spawn-failed', exitCode: -1, finished: new Date().toISOString(),
    });
    releaseRole(root, record.role, id);
    process.exit(1);
  });
  updateRecord(dir, { codexPid: child.pid });
  if (child.pid) fs.writeFileSync(path.join(dir, 'codex.pid'), String(child.pid));
  child.on('exit', (code) => {
    const current = readRecord(dir);
    if (!isCorrupt(current) && current.state === 'running') {
      // The signature scan is a WARNING now, not a verdict: sight was established
      // positively before the run, so a signature here means "something in the
      // sandbox complained", which is worth saying and not worth overruling a
      // proof with.
      const blind = scanBlindLog(runLogPath(dir));
      const warnings = [];
      if (blind) warnings.push(`sandbox-failure signatures in log (${blind})`);
      if (warning) warnings.push(warning);
      updateRecord(dir, {
        state: code === 0 ? 'done' : 'failed',
        warning: warnings.length ? warnings.join('; ') : undefined,
        blindSignature: blind || undefined,
        exitCode: code,
        finished: new Date().toISOString(),
      });
    }
    releaseRole(root, record.role, id);
    process.exit(0);
  });
}

// A supervisor that must not launch says so in the two places a human will look —
// the job's own run.log and the supervisor's stderr — and exits nonzero. The
// record has already been set by the caller; this only reports and stops.
function abortSupervisor(dir, why) {
  const msg = `supervisor: ABORTING before codex was launched — ${why}.\nNothing was billed.`;
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
  if (job.record.reason === 'sandbox-blind-precheck') {
    fail(
      `BLIND: job ${id} never ran — codex's sandbox could not read a file in the job's cwd,\n` +
      `so anything it produced would have been sourceless.\n` +
      `probe: ${clean(job.record.sight) || 'sight precheck failed'}\n` +
      BLIND_EXPLANATION + '\n' +
      `out: ${out}`
    );
  }
  if (job.record.reason === 'sight-unproven') {
    fail(
      `UNPROVEN: job ${id} never ran — codex could not be PROVEN able to read a file in the\n` +
      `job's own working directory, and an unproven answer is not deliverable by default.\n` +
      `probe: ${clean(job.record.sight) || 'sight could not be proven'}\n` +
      UNPROVEN_EXPLANATION + '\n' +
      `out: ${out}`
    );
  }
  const state = effectiveState(job);
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
    const survivors = killPids(pids);
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
    process.stderr.write(
      `KILL FAILED: job ${id} — these pids survived the kill: ${killed.survivors.join(', ')}\n` +
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
      if (r.reason) tag = `${state}(${clean(r.reason)})`;
      // A done job whose record does not vouch for the run is listed as such:
      // `result` is going to refuse it, and a listing that says plain `done`
      // would be the last place anyone learns that.
      else if (state === 'done' && !deliverability(r).ok) tag = 'done(unvouched)';
    }
    const warn = !isCorrupt(r) && r.warning ? `  warning: ${clean(r.warning)}` : '';
    console.log(`${clean(job.id)}  ${tag}  out: ${outPath(job.dir)}${warn}`);
  }
}

// ---------------------------------------------------------------------- watch
//
// Watching is a HUMAN affordance: a detached console window that follows the run
// and then shouts, for the operator who has been burned by dropped wake-up
// notifications four times in one day and does not trust a silent terminal.
// Agents must never watch — they poll `result`.

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
  // `start` gives the watcher its own console window; `cmd /k` keeps that window
  // open after the banner so the news survives the process that delivered it.
  const launcher = process.env.CODEX_DISPATCH_TEST_WATCH_BIN || 'cmd';
  const child = spawn(launcher, ['/c', 'start', title, 'cmd', '/k', 'node', SELF, '_watch', id], {
    detached: true,
    stdio: 'ignore',
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
    const msg =
      `watch: FAILED to open a watcher console window for ${id}.\n` +
      `${detail}\n` +
      `The job itself is unaffected — nothing about it depends on being watched.\n` +
      `Follow it here instead:\n` +
      `  node "${SELF}" status ${id}\n` +
      `out: ${outPath(job.dir)}`;
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

  let pos = tailInitial(log);
  let corruptReads = 0;
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
    if (state === 'running') { setTimeout(tick, 500); return; }
    pos = tailMore(log, pos);
    finish(state, record);
  };
  tick();
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
    case 'kill-pending':
      return (
        'a cancel landed before this job had registered anything to kill, so nothing died and ' +
        `nothing may assume it did - re-run: node "${SELF}" cancel ${id}`
      );
    case 'kill-failed':
      return (
        `pids ${clean((!isCorrupt(r) && r.killSurvivors) || '?')} SURVIVED the kill and may still be ` +
        `billing - kill them yourself: taskkill /PID <pid> /T /F`
      );
    case 'stale':
      return (
        'the supervisor died without finalizing, so nothing vouched for how this ended; ' +
        `result will REFUSE it. Reap any survivors: node "${SELF}" cancel ${id}`
      );
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

const BOOL_FLAGS = new Set(['write', 'force', 'watch', 'allow-unproven-sight']);
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
  const [verb, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  switch (verb) {
    case 'dispatch': cmdDispatch(opts); break;
    case 'status': cmdStatus(opts._[0]); break;
    case 'result': cmdResult(opts._[0]); break;
    case 'cancel': cmdCancel(opts._[0]); break;
    case 'list': cmdList(); break;
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

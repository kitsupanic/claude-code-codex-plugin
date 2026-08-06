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

// Job ids are the only strings that ever become a path segment from user input.
// Whitelist, never sanitize: anything outside this shape is refused, loudly.
export const JOB_ID_RE = /^[a-z]+-\d+-\d+$/;
export const ROLE_RE = /^[a-z]+$/;

// States in which a job may still own live processes. These block their role,
// are cancellable, and are what `--force` has to kill (and verify) first.
export const LIVE_STATES = ['running', 'stale', 'kill-failed'];

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
  'killSurvivors',
];
const NUMBER_FIELDS = ['supervisorPid', 'codexPid', 'exitCode'];
const REQUIRED_FIELDS = ['state', 'started'];

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
    return { __corrupt: true, corruptReason: `unreadable: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { __corrupt: true, corruptReason: `unparseable: ${err.message}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { __corrupt: true, corruptReason: 'job.json is not an object' };
  }
  const bad = validateRecord(parsed);
  if (bad) return { __corrupt: true, corruptReason: bad };
  return parsed;
}

export const isCorrupt = (record) => Boolean(record && record.__corrupt);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Atomic: a half-written job.json is exactly the corruption this guards against,
// and the supervisor writes it while status/list may be reading. On Windows a
// replace-rename can transiently lose to a concurrent reader, so retry briefly
// rather than let the supervisor die with the record unfinalized.
function writeRecord(dir, record) {
  const tmp = path.join(dir, `job.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
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

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
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
  const dir = path.join(jobsRoot(), id);
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
// One sandboxed read, verified by its content. `codex sandbox <cmd>` runs a real
// command inside codex's own sandbox: no model call, no tokens, no billing,
// ~300 ms. The check is POSITIVE — the bytes we expect have to come back — which
// is what makes it robust against failure shapes nobody has seen yet.
// Returns { state: 'functional' | 'broken' | 'unavailable', detail }.
function sandboxRead(bin, file, { cwd, token } = {}) {
  const args = WIN
    ? ['sandbox', 'cmd', '/c', 'type', file]
    : ['sandbox', 'sh', '-c', `cat ${JSON.stringify(file)}`];
  const r = runCodexSync(bin, args, cwd ? { cwd } : {});
  const text = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0 && text.includes(token)) return { state: 'functional', detail: '' };
  const firstLine = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || `exit ${r.status}`;
  if (/unrecognized subcommand|unknown subcommand|invalid subcommand/i.test(text)) {
    return { state: 'unavailable', detail: firstLine };
  }
  if (r.status === 0) {
    return {
      state: 'broken',
      detail: `the command exited 0 but the file's bytes never came back (${firstLine})`,
    };
  }
  return { state: 'broken', detail: firstLine };
}

// Install-level probe, from wherever the launcher happens to be: writes a nonce
// into the OS temp dir and reads it back. Used by `preflight`; it says the
// install is capable, not that any particular job can see (that is sightProbe).
export function sandboxProbe(bin) {
  const nonce = `codex-dispatch-sandbox-probe-${Date.now()}-${process.pid}`;
  const file = path.join(os.tmpdir(), `${nonce}.txt`);
  fs.writeFileSync(file, nonce + '\n');
  try {
    return sandboxRead(bin, file, { token: nonce });
  } finally {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  }
}

// Pick a file that ALREADY EXISTS in the job's cwd, plus a token from it to
// verify the read by. Never writes there: a job's `--cd` is somebody's repo, and
// a runtime that litters it is one nobody points at anything precious.
// The token is short and ASCII-only so a console codepage cannot mangle the
// comparison, and names carrying cmd.exe's expansion characters are skipped
// rather than trusted to the documented best-effort quoting.
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
        const buf = Buffer.alloc(Math.min(4096, size));
        const n = fs.readSync(fd, buf, 0, buf.length, 0);
        head = buf.toString('utf8', 0, n);
      } finally { fs.closeSync(fd); }
    } catch { continue; }
    for (const line of head.split(/\r?\n/)) {
      const t = line.trim();
      if (t.length < 4) continue;
      if (!/^[\x20-\x7E]+$/.test(t)) continue;
      return { name, token: t.slice(0, 40).trim() };
    }
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
  if (sandbox.state === 'broken') {
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
      `(${sandbox.detail}). Jobs will run with a "sight not proven" warning on the record.\n`
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
const roleLockDir = (root, role) => path.join(root, ROLE_LOCKS, role);
const claimOwnerPath = (lockDir) => path.join(lockDir, 'owner');

function readClaimOwner(lockDir) {
  try { return fs.readFileSync(claimOwnerPath(lockDir), 'utf8').trim() || null; } catch { return null; }
}

function claimAge(lockDir) {
  try { return Date.now() - fs.statSync(lockDir).mtimeMs; } catch { return Infinity; }
}

function tryClaim(root, role, jobId) {
  fs.mkdirSync(path.join(root, ROLE_LOCKS), { recursive: true });
  const lockDir = roleLockDir(root, role);
  try {
    fs.mkdirSync(lockDir, { recursive: false });
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  fs.writeFileSync(claimOwnerPath(lockDir), jobId + '\n');
  return true;
}

// Only ever releases OUR claim: a release that cannot name itself as the owner
// would hand the role to whoever raced in behind it.
function releaseRole(root, role, jobId) {
  if (!role) return;
  const lockDir = roleLockDir(root, role);
  if (!fs.existsSync(lockDir)) return;
  const owner = readClaimOwner(lockDir);
  if (owner && jobId && owner !== jobId) return;
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// live        — a dispatch is mid-claim right now; nobody may take it
// conflict    — the owner job may still have processes; --force territory
// reclaimable — the owner is terminal, corrupt, or gone
function inspectClaim(root, lockDir) {
  const owner = readClaimOwner(lockDir);
  const age = claimAge(lockDir);
  if (!owner) {
    return age < CLAIM_GRACE_MS
      ? { status: 'live', owner: null, age }
      : { status: 'reclaimable', owner: null, detail: 'the claim never named an owner' };
  }
  const dir = path.join(root, owner);
  if (!fs.existsSync(recordPath(dir))) {
    return age < CLAIM_GRACE_MS
      ? { status: 'live', owner, age }
      : { status: 'reclaimable', owner, detail: `owner job ${owner} left no record` };
  }
  const job = { id: owner, dir, record: readRecord(dir) };
  if (isCorrupt(job.record)) {
    return { status: 'reclaimable', owner, detail: `owner job ${owner} has a corrupt record` };
  }
  const state = effectiveState(job);
  if (LIVE_STATES.includes(state)) return { status: 'conflict', owner, job, state };
  return { status: 'reclaimable', owner, detail: `owner job ${owner} is ${state}` };
}

function claimRole(root, role, jobId, { force } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (tryClaim(root, role, jobId)) return { ok: true };
    const lockDir = roleLockDir(root, role);
    const claim = inspectClaim(root, lockDir);
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
      if (!killed.ok) return { ok: false, message: killFailedMessage(claim.job, killed) };
      console.log(`killed previous job: ${claim.job.id} (was ${claim.state})`);
    }
    releaseRole(root, role, claim.owner);
  }
  return {
    ok: false,
    message:
      `dispatch: could not claim role "${role}" — the claim was retaken while this dispatch was ` +
      `clearing it. Retry, or pick another --role.`,
  };
}

// ---------------------------------------------------------------------- kills

function killTree(pid) {
  if (!pid) return;
  // Test-only: simulate a kill that does not take effect, so the verified-kill
  // path has a regression test that does not depend on finding a genuinely
  // unkillable process. Never set outside the suite.
  if (process.env.CODEX_DISPATCH_TEST_NOKILL) return;
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
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

function recordedPids(dir) {
  const pids = [];
  for (const name of PID_FILES) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    try {
      for (const n of fs.readFileSync(f, 'utf8').split(/\s+/).map(Number)) {
        if (Number.isInteger(n) && n > 0) pids.push(n);
      }
    } catch { /* unreadable pid file: nothing to do */ }
  }
  return pids;
}

// A pid file that has been acted on is spent. Renaming it is what stops a second
// cancel from replaying those numbers against whatever now owns them — pid reuse
// turns a repeated cancel into a kill of an innocent process.
function consumePidFiles(dir) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const consumed = [];
  for (const name of PID_FILES) {
    const from = path.join(dir, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(dir, `${name}.reaped-${stamp}`);
    try { fs.renameSync(from, to); consumed.push(path.basename(to)); } catch { /* best effort */ }
  }
  return consumed;
}

function reapedPidFiles(dir) {
  try { return fs.readdirSync(dir).filter((n) => /\.pid\.reaped-/.test(n)); } catch { return []; }
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
  const survivors = killPids(unique);
  const finished = new Date().toISOString();
  if (survivors.length) {
    updateRecord(job.dir, {
      state: 'kill-failed',
      finished,
      killSurvivors: survivors.join(', '),
    });
    return { ok: false, survivors, targets: unique };
  }
  updateRecord(job.dir, { state: 'killed', finished, killSurvivors: undefined });
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
      ? `kill-failed: an earlier kill did not take — pids ${job.record.killSurvivors || '?'} were still alive afterwards.\n`
      : '') +
    `out: ${outPath(job.dir)}\n` +
    `Re-run with --force to kill it first, or pick another --role.`
  );
}

function killFailedMessage(job, killed) {
  return (
    `dispatch: REFUSING to launch — the previous "${job.record.role}" job could not be killed.\n` +
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
    if (!killed.ok) fail(killFailedMessage(conflict, killed));
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
      id,
      role,
      model: opts.model || DEFAULT_MODEL,
      effort: opts.effort || DEFAULT_EFFORT,
      sandbox: opts.write ? 'workspace-write' : 'read-only',
      cwd: path.resolve(opts.cd || process.cwd()),
      bin,
      started: new Date().toISOString(),
      state: 'running',
      supervisorPid: null,
      codexPid: null,
      exitCode: null,
      finished: null,
    });

    const supLog = fs.openSync(path.join(dir, 'supervisor.log'), 'a');
    const child = spawn(process.execPath, [SELF, '_supervise', dir], {
      detached: true,
      stdio: ['ignore', supLog, supLog],
      windowsHide: true,
    });
    child.unref();
    fs.closeSync(supLog);
  } catch (err) {
    releaseRole(root, role, id);
    fail(`dispatch: could not start job ${id}: ${err.message}`);
  }

  console.log(`job: ${id}`);
  console.log(`bin: ${bin}`);
  console.log(`out: ${outPath(dir)}`);
  if (opts.watch) cmdWatch(id, { fromDispatch: true });
}

// Detached supervisor: proves the sandbox can see, runs codex to completion,
// then finalizes job.json. It is the only writer of job.json after dispatch
// returns, and its pid is the kill target — taskkill /T on it takes the whole
// codex tree down.
function cmdSupervise(dir) {
  const record = updateRecord(dir, { supervisorPid: process.pid });
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
  let warning;
  if (sight.state === 'unavailable') {
    // An unprovable sandbox is not the same claim as a broken one: refusing every
    // job on a CLI too old to have the subcommand would be inventing a defect.
    warning = `sight not proven: this codex has no "sandbox" subcommand (${sight.detail})`;
    try { fs.appendFileSync(runLogPath(dir), `supervisor: ${warning}\n`); } catch { /* best effort */ }
    updateRecord(dir, { sight: 'unproven', warning });
  } else {
    updateRecord(dir, { sight: sight.mode });
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
  const child = spawnCodex(record.bin, args, { stdio: [promptFd, logFd, logFd], windowsHide: true });
  child.on('error', (err) => {
    fs.appendFileSync(runLogPath(dir), `supervisor: spawn failed: ${err.message}\n`);
    updateRecord(dir, { state: 'failed', exitCode: -1, finished: new Date().toISOString() });
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

function printStatus(job) {
  const state = effectiveState(job);
  const r = job.record;
  console.log(`job: ${job.id}`);
  console.log(`state: ${state}`);
  if (isCorrupt(r)) {
    console.log(`reason: corrupt job.json (${r.corruptReason})`);
    console.log(`out: ${outPath(job.dir)}`);
    return;
  }
  if (r.reason) console.log(`reason: ${r.reason}${r.blindSignature ? ` (${r.blindSignature})` : ''}`);
  if (r.killSurvivors && state === 'kill-failed') console.log(`survivors: ${r.killSurvivors}`);
  if (r.sight) console.log(`sight: ${r.sight}`);
  if (r.warning) console.log(`warning: ${r.warning}`);
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
      `CORRUPT: job ${id} has an unusable job.json (${job.record.corruptReason})\n` +
      `The answer file may still be there; read it yourself if you trust it.\n` +
      `out: ${out}`
    );
  }
  if (job.record.reason === 'sandbox-blind-precheck') {
    fail(
      `BLIND: job ${id} never ran — codex's sandbox could not read a file in the job's cwd,\n` +
      `so anything it produced would have been sourceless.\n` +
      `probe: ${job.record.sight || 'sight precheck failed'}\n` +
      BLIND_EXPLANATION + '\n' +
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
      (job.record.killSurvivors ? `survivors: ${job.record.killSurvivors}\n` : '') +
      `started ${job.record.started}, runtime ${humanDuration(Date.now() - Date.parse(job.record.started))}\n` +
      `out: ${out}`
    );
  }
  if (!fs.existsSync(out)) {
    fail(
      `MISSING: job ${id} is done but its answer file is not on disk.\n` +
      `out: ${out}`
    );
  }
  if (job.record.warning) {
    process.stderr.write(
      `WARNING: job ${id} — ${job.record.warning}\n` +
      `Sight was established before the run (${job.record.sight || 'unrecorded'}), so this is a warning, not a verdict.\n` +
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
    console.log(`job ${id} has a corrupt job.json (${job.record.corruptReason})`);
    if (!pids.length) {
      const reaped = reapedPidFiles(job.dir);
      console.log(reaped.length
        ? `already reaped: ${reaped.join(', ')} — nothing left to kill, nothing touched`
        : 'no pid files to kill; job.json left untouched for inspection');
      console.log(`out: ${outPath(job.dir)}`);
      return;
    }
    const survivors = killPids(pids);
    const consumed = consumePidFiles(job.dir);
    console.log(`killed recorded pids: ${pids.join(', ')} (job.json left untouched for inspection)`);
    console.log(`consumed pid files: ${consumed.join(', ')} — a second cancel cannot replay those pids`);
    console.log(`out: ${outPath(job.dir)}`);
    if (survivors.length) {
      process.stderr.write(
        `KILL FAILED: job ${id} — these pids survived: ${survivors.join(', ')}\n` +
        `Kill them yourself: taskkill /PID <pid> /T /F\n`
      );
      process.exit(1);
    }
    return;
  }
  const state = effectiveState(job);
  if (!LIVE_STATES.includes(state)) {
    console.log(`job ${id} is already ${state}, nothing to kill`);
    console.log(`out: ${outPath(job.dir)}`);
    return;
  }
  const killed = killJob(job);
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
    const tag = !isCorrupt(job.record) && job.record.reason ? `${state}(${job.record.reason})` : state;
    const warn = !isCorrupt(job.record) && job.record.warning ? `  warning: ${job.record.warning}` : '';
    console.log(`${job.id}  ${tag}  out: ${outPath(job.dir)}${warn}`);
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
  const child = spawn('cmd', ['/c', 'start', title, 'cmd', '/k', 'node', SELF, '_watch', id], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.log(`watching: ${id} in a new console window titled "${title}"`);
  if (!fromDispatch) console.log(`out: ${outPath(job.dir)}`);
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
  process.stdout.write(all.slice(-lines).join('\n') + '\n');
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
    process.stdout.write(buf.toString('utf8', 0, n));
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

  const finish = () => {
    const fresh = { id, dir: job.dir, record: readRecord(job.dir) };
    const state = effectiveState(fresh);
    const r = fresh.record;
    process.stdout.write('\x07');
    console.log('');
    console.log(bar);
    console.log('  JOB FINISHED - result is ready');
    console.log(bar);
    console.log(`  job:     ${id}`);
    console.log(`  state:   ${state}`);
    if (!isCorrupt(r) && r.reason) console.log(`  reason:  ${r.reason}`);
    if (!isCorrupt(r) && r.warning) console.log(`  warning: ${r.warning}`);
    console.log(`  out:     ${out}${fs.existsSync(out) ? '' : '   (no answer file)'}`);
    console.log(`  collect: node "${SELF}" result ${id}`);
    console.log(bar);
    console.log('This window is yours to close.');
  };

  let pos = tailInitial(log);
  const tick = () => {
    pos = tailMore(log, pos);
    const state = effectiveState({ id, dir: job.dir, record: readRecord(job.dir) });
    if (state === 'running') { setTimeout(tick, 500); return; }
    pos = tailMore(log, pos);
    finish();
  };
  tick();
}

// ----------------------------------------------------------------------- main

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write' || a === '--force' || a === '--watch') opts[a.slice(2)] = true;
    else if (a.startsWith('--')) opts[a.slice(2)] = argv[++i];
    else opts._.push(a);
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
        '  dispatch --brief <file> [--role <stem>] [--cd <dir>] [--model <m>] [--effort <e>] [--write] [--force] [--watch]\n' +
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

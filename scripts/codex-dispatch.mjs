#!/usr/bin/env node
// codex-dispatch — background job runtime for verbatim Codex CLI dispatches.
// Node 18+, zero npm dependencies, Windows-first.
//
// Verbs: dispatch, status, result, cancel, list, preflight, _supervise (internal)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const WIN = process.platform === 'win32';
const DEFAULT_MODEL = 'gpt-5.6-sol';
const DEFAULT_EFFORT = 'xhigh';

// Job ids are the only strings that ever become a path segment from user input.
// Whitelist, never sanitize: anything outside this shape is refused, loudly.
export const JOB_ID_RE = /^[a-z]+-\d+-\d+$/;
export const ROLE_RE = /^[a-z]+$/;

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
  'started', 'finished', 'reason', 'blindSignature',
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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
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

// The out file appears only when the run finishes: its existence is the done
// signal and overrides a job.json the supervisor never got to finalize.
function effectiveState(job) {
  const r = job.record;
  if (isCorrupt(r)) return 'corrupt';
  if (r.state !== 'running') return r.state;
  if (fs.existsSync(outPath(job.dir))) return 'done';
  if (!pidAlive(r.supervisorPid)) {
    // grace: supervisor registers its own pid shortly after spawn
    if (!r.supervisorPid && Date.now() - Date.parse(r.started) < 15000) return 'running';
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

// ------------------------------------------------------- blind-job detection
//
// The desktop-app codex build lacks the Windows sandbox helper executables, so
// every file read inside a job fails — while codex still exits 0 and the model
// still writes a confident out file. Seen in production: a review that said it
// could not read the file it was asked to review, delivered as a success.
// These are the signatures that failure prints.
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
// it; nothing short of a structured event stream would not.
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
  'sandbox-blind: codex could not run commands inside its sandbox, so the model saw NO files.\n' +
  'It answers anyway and exits 0, which is why this is detected from run.log rather than the exit code.\n' +
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

function runCodexSync(bin, args) {
  if (isScript(bin)) return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  if (WIN) return spawnSync([bin, ...args].map(cmdQuote).join(' '), { shell: true, encoding: 'utf8' });
  return spawnSync(bin, args, { encoding: 'utf8' });
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

// Functional sandbox check: run a real command inside codex's own sandbox and
// require it to read a file we just wrote. `codex sandbox <cmd>` costs no model
// call and no tokens — the failure is in the sandbox plumbing, not the model,
// so probing it directly is both cheaper and more precise than a test dispatch.
// Returns { state: 'functional' | 'broken' | 'unavailable', detail }.
export function sandboxProbe(bin) {
  const nonce = `codex-dispatch-sandbox-probe-${Date.now()}-${process.pid}`;
  const file = path.join(os.tmpdir(), `${nonce}.txt`);
  fs.writeFileSync(file, nonce + '\n');
  try {
    const args = WIN
      ? ['sandbox', 'cmd', '/c', 'type', file]
      : ['sandbox', 'sh', '-c', `cat ${JSON.stringify(file)}`];
    const r = runCodexSync(bin, args);
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    if (r.status === 0 && text.includes(nonce)) return { state: 'functional', detail: '' };
    const firstLine = text.split(/\r?\n/).find(Boolean) || `exit ${r.status}`;
    if (/unrecognized subcommand|unknown subcommand|invalid subcommand/i.test(text)) {
      return { state: 'unavailable', detail: firstLine };
    }
    return { state: 'broken', detail: firstLine };
  } finally {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  }
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
      `preflight: WARNING — this codex has no "sandbox" subcommand, so the sandbox could not be\n` +
      `proven functional (${sandbox.detail}). Jobs still get the run.log blind-signature scan as a backstop.\n`
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

// ---------------------------------------------------------------------- verbs

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
  let conflict = null;
  for (const j of allJobs()) {
    if (isCorrupt(j.record) || j.record.role !== role) continue;
    const s = effectiveState(j);
    if (s === 'running' || s === 'stale') { conflict = { ...j, state: s }; break; }
  }
  if (conflict) {
    if (!opts.force) {
      fail(
        `dispatch: a "${role}" job is already ${conflict.state}: ${conflict.id}\n` +
        (conflict.state === 'stale'
          ? 'stale: its supervisor is gone but no out file was written — codex may have been reparented and is still running (and billing).\n'
          : '') +
        `out: ${outPath(conflict.dir)}\n` +
        `Re-run with --force to kill it first, or pick another --role.`
      );
    }
    killJob(conflict);
    console.log(`killed previous job: ${conflict.id} (was ${conflict.state})`);
  }

  // <role>-<epoch-seconds>-<pid>: unique by construction. The collision suffix
  // extends the pid digits rather than adding a segment, so the id keeps the
  // shape the whitelist enforces.
  const stem = `${role}-${Math.floor(Date.now() / 1000)}-${process.pid}`;
  let dir = path.join(root, stem);
  for (let n = 1; fs.existsSync(dir); n++) dir = path.join(root, `${stem}${n}`);
  fs.mkdirSync(dir);
  fs.copyFileSync(briefPath, path.join(dir, 'prompt.md'));

  writeRecord(dir, {
    id: path.basename(dir),
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

  console.log(`job: ${path.basename(dir)}`);
  console.log(`bin: ${bin}`);
  console.log(`out: ${outPath(dir)}`);
}

// Detached supervisor: runs codex to completion, then finalizes job.json.
// It is the only writer of job.json after dispatch returns, and its pid is the
// kill target — taskkill /T on it takes the whole codex tree down.
function cmdSupervise(dir) {
  const record = updateRecord(dir, { supervisorPid: process.pid });
  if (!record) {
    process.stderr.write(`supervisor: job.json is corrupt, refusing to run: ${dir}\n`);
    process.exit(1);
  }
  // Pid files mirror job.json: a corrupt record must not cost us the kill target.
  fs.writeFileSync(path.join(dir, 'supervisor.pid'), String(process.pid));
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
    fs.appendFileSync(path.join(dir, 'run.log'), `supervisor: spawn failed: ${err.message}\n`);
    updateRecord(dir, { state: 'failed', exitCode: -1, finished: new Date().toISOString() });
    process.exit(1);
  });
  updateRecord(dir, { codexPid: child.pid });
  if (child.pid) fs.writeFileSync(path.join(dir, 'codex.pid'), String(child.pid));
  child.on('exit', (code) => {
    const current = readRecord(dir);
    if (!isCorrupt(current) && current.state === 'running') {
      // Exit code 0 is not proof of sight: scan for the sandbox failure that
      // makes codex answer from nothing.
      const blind = scanBlindLog(runLogPath(dir));
      updateRecord(dir, {
        state: blind ? 'failed' : code === 0 ? 'done' : 'failed',
        reason: blind ? 'sandbox-blind' : undefined,
        blindSignature: blind || undefined,
        exitCode: code,
        finished: new Date().toISOString(),
      });
    }
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
  if (job.record.reason === 'sandbox-blind') {
    fail(
      `BLIND: job ${id} completed without a working sandbox — its answer is not evidence.\n` +
      `signature: ${job.record.blindSignature}\n` +
      BLIND_EXPLANATION + '\n' +
      `The (untrustworthy) answer file is still on disk if you want to see what it invented.\n` +
      `out: ${out}`
    );
  }
  if (fs.existsSync(out)) {
    // verbatim: raw bytes, nothing else on stdout
    process.stdout.write(fs.readFileSync(out));
    return;
  }
  process.stderr.write(
    `NOT READY: job ${id} is ${effectiveState(job)} ` +
    `(started ${job.record.started}, runtime ${humanDuration(Date.now() - Date.parse(job.record.started))})\n` +
    `out: ${out}\n`
  );
  process.exit(1);
}

function killTree(pid) {
  if (!pid) return;
  if (WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
}

// Pids recorded as plain files in the job dir, one or more per file. The
// supervisor writes supervisor.pid/codex.pid; the tests' fake codex writes
// child.pid. These are the only kill targets that survive a corrupt job.json.
function recordedPids(dir) {
  const pids = [];
  for (const name of ['supervisor.pid', 'codex.pid', 'child.pid']) {
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

function killJob(job) {
  killTree(job.record.supervisorPid);
  // When the supervisor is already dead — the stale case — codex has been
  // reparented out of its tree, so /T on the supervisor reaches nothing. Hit the
  // recorded pids directly: harmless when they are already gone, and the only
  // thing that stops an orphan billing. (Non-Windows has no tree kill at all,
  // so it always needed this.)
  killTree(job.record.codexPid);
  for (const pid of recordedPids(job.dir)) killTree(pid);
  updateRecord(job.dir, { state: 'killed', finished: new Date().toISOString() });
}

function cmdCancel(id) {
  const job = getJob(id);
  // A corrupt record still has processes to reap: the pid files are the fallback,
  // and job.json is left exactly as found so the corruption stays inspectable.
  if (isCorrupt(job.record)) {
    const pids = recordedPids(job.dir);
    for (const pid of pids) killTree(pid);
    console.log(`job ${id} has a corrupt job.json (${job.record.corruptReason})`);
    console.log(pids.length
      ? `killed recorded pids: ${pids.join(', ')} (job.json left untouched for inspection)`
      : 'no pid files to kill; job.json left untouched for inspection');
    console.log(`out: ${outPath(job.dir)}`);
    return;
  }
  const state = effectiveState(job);
  if (state !== 'running' && state !== 'stale') {
    console.log(`job ${id} is already ${state}, nothing to kill`);
    console.log(`out: ${outPath(job.dir)}`);
    return;
  }
  killJob(job);
  console.log(`killed: ${id}`);
  console.log(`out: ${outPath(job.dir)}`);
}

function cmdList() {
  const jobs = allJobs();
  if (!jobs.length) return console.log(`no jobs in ${jobsRoot()}`);
  for (const job of jobs) {
    const state = effectiveState(job);
    const tag = !isCorrupt(job.record) && job.record.reason ? `${state}(${job.record.reason})` : state;
    console.log(`${job.id}  ${tag}  out: ${outPath(job.dir)}`);
  }
}

// ----------------------------------------------------------------------- main

export function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write' || a === '--force') opts[a.slice(2)] = true;
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
    case 'preflight': preflight(); break;
    case '_supervise': cmdSupervise(opts._[0]); break;
    default:
      fail(
        'usage: node codex-dispatch.mjs <verb>\n' +
        '  dispatch --brief <file> [--role <stem>] [--cd <dir>] [--model <m>] [--effort <e>] [--write] [--force]\n' +
        '  status [<job-id>]\n' +
        '  result <job-id>\n' +
        '  cancel <job-id>\n' +
        '  list\n' +
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

// Lifecycle tests for codex-dispatch, run against the fake codex.
// Usage: node --test tests/dispatch.test.mjs

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Imported, not hard-coded: the schema stamp is the thing the delivery gate reads,
// so a fixture that wants to be deliverable has to carry whatever this release
// writes. Hard-coded 1s silently stopped meaning "current" the moment it moved.
import { RECORD_VERSION, cmdQuote, watchLaunchArgs } from '../scripts/codex-dispatch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const RUNTIME = path.join(HERE, '..', 'scripts', 'codex-dispatch.mjs');
const FAKE = path.join(HERE, 'fake-codex.mjs');
// The same fake, reached through a Windows .cmd shim — which is what the SUPPORTED
// codex install is (`%APPDATA%\npm\codex.cmd`), and therefore the spawn path CI
// never exercised: `CODEX_DISPATCH_BIN` was always a `.mjs`, so the `shell: true`
// branch, and the wrapper pid it hands back, were invisible to every test.
const FAKE_CMD = path.join(HERE, 'fake-codex.cmd');
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-test-'));

const baseEnv = { ...process.env, CODEX_DISPATCH_JOBS: JOBS, CODEX_DISPATCH_BIN: FAKE };

// Pinned to the repo root, not inherited: a dispatch's cwd IS the job's cwd, and
// sight is now proven by reading a file that is already in it. Inheriting
// whatever directory `node --test` happened to be run from would make the whole
// suite's deliverability depend on where it was invoked.
function run(args, env = {}) {
  return spawnSync(process.execPath, [RUNTIME, ...args], {
    env: { ...baseEnv, ...env },
    cwd: REPO,
    encoding: 'utf8',
  });
}

function jobIdFrom(stdout) {
  return stdout.match(/^job: (.+)$/m)[1];
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function poll(fn, ms = 15000, every = 100) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, every));
  }
  return fn();
}

function writeBrief(name, content) {
  const p = path.join(JOBS, name);
  fs.writeFileSync(p, content);
  return p;
}

// job.json is rewritten by rename while these polls read it; on Windows a reader
// can transiently lose that race, which is a flaky test, not a defect.
function record(id) {
  const p = path.join(JOBS, id, 'job.json');
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (err) {
      if (attempt >= 20) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

const done = (id) => record(id).state === 'done';

// A reap list and the one-liner that adds to it, for the tests that dispatch
// long-lived fakes. Those ids are only known partway through a body, and every
// one of them has to be cancelled even when an assertion throws first — a fake
// asleep for a minute holds its role AND its open log file, so a single failure
// used to cascade into the rest of the file. The fixture tests already reap in a
// finally; this is the same shape where the id is not known up front.
function reaper() {
  const ids = [];
  return {
    keep: (id) => { ids.push(id); return id; },
    cancelAll: () => { for (const id of ids) run(['cancel', id]); },
  };
}

// The mkdtemp tree leaked every run: dozens of job directories, plus whatever
// 60-second fakes were still asleep in them, left in the OS temp dir for ever.
//
// The removal has to come SECOND. A fake still running holds run.log open, and on
// Windows an open handle makes the directory undeletable — so anything still
// live is cancelled first, through the runtime's own `cancel`. Deliberately not a
// raw taskkill over every number these records mention: several of those numbers
// belong to fixtures and to processes long dead, and firing at a pid the OS has
// since reissued is precisely the harm this runtime's identity check exists to
// prevent. `cancel` applies that check; a loop here would not.
after(async () => {
  const LIVE = ['running', 'stale', 'kill-pending', 'kill-failed', 'unknown'];
  for (const line of (run(['list']).stdout || '').split(/\r?\n/)) {
    const m = line.match(/^([a-z]+-\d+-\d+)\s+([a-z-]+)/);
    if (m && LIVE.includes(m[2])) run(['cancel', m[1]]);
  }
  // Handles close a moment after the process holding them does, so the removal is
  // retried rather than asserted — a leftover tree is untidy, not a test failure.
  for (let attempt = 0; attempt < 20; attempt++) {
    try { fs.rmSync(JOBS, { recursive: true, force: true }); return; } catch { /* still locked */ }
    await new Promise((r) => setTimeout(r, 250));
  }
});

test('dispatch returns immediately, job dir is complete, result is verbatim', async () => {
  const briefContent = 'brief with CRLF\r\nand unicode é中\nno trailing newline';
  const brief = writeBrief('brief1.md', briefContent);
  const t0 = Date.now();
  const r = run(['dispatch', '--brief', brief, '--role', 'basic']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 5000, 'dispatch must return immediately');
  assert.match(r.stdout, /^out: .+out\.txt$/m, 'dispatch output must contain the out: line');

  const id = jobIdFrom(r.stdout);
  const dir = path.join(JOBS, id);
  assert.deepEqual(
    fs.readFileSync(path.join(dir, 'prompt.md')),
    Buffer.from(briefContent),
    'prompt.md must be byte-identical to the brief'
  );
  assert.ok(fs.existsSync(path.join(dir, 'job.json')));

  assert.ok(await poll(() => done(id)), 'job should finish and the RECORD should say so');
  assert.ok(fs.existsSync(path.join(dir, 'out.txt')), 'and the answer file should be there');
  assert.ok(fs.existsSync(path.join(dir, 'run.log')), 'run.log should exist');
  // A RELEASE THAT IS NOW A RENAME STILL HAS TO LEAVE NOTHING BEHIND. Releasing
  // the record lock moves it to a tombstone and removes THAT, rather than
  // removing the live path — so a release that lost track of what it moved would
  // leave a `job.json.lock.stale-*` directory in every finished job, and the next
  // acquirer would sit behind it for as long as its holder lived. This job took
  // the lock half a dozen times on its way through; nothing lock-shaped may
  // survive it.
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('job.json.lock')), false,
    `every lock this job took was given back whole: ${fs.readdirSync(dir).join(', ')}`);

  const st = run(['status', id]);
  assert.match(st.stdout, /^state: done$/m);
  // `cwd-file:` and nothing else. The `job-nonce` alternative that used to be
  // accepted here dates from when the weak fallback still delivered; a job whose
  // sight reads `job-nonce` now FAILS (see the nonce test below), so allowing it
  // in this assert would let a regression that lost the strong proof pass.
  assert.match(st.stdout, /^sight: cwd-file:/m, 'sight must be PROVEN in the job cwd, and recorded');
  assert.match(st.stdout, /^out: /m, 'status must contain the out: line');

  const res = run(['result', id]);
  assert.equal(res.status, 0);
  assert.deepEqual(
    Buffer.from(res.stdout),
    fs.readFileSync(path.join(dir, 'out.txt')),
    'result must be byte-identical to the out file'
  );
});

test('the codex exec argv carries every flag the run depends on', async () => {
  // The supervisor's command line is the one thing about a run that is invisible
  // afterwards, and every flag on it fails SILENTLY when it is dropped or renamed:
  // without --cd codex reads whatever directory it inherited, without --sandbox it
  // takes its own default, without --skip-git-repo-check a non-repo cwd refuses to
  // run at all, and without --model/-c the bill is codex's default rather than the
  // pair this record was dispatched with. The fake echoes its own argv into
  // run.log, which is the only place it can be read back.
  const brief = writeBrief('briefargvflags.md', 'quick');
  const argvOf = (id) => {
    const log = fs.readFileSync(path.join(JOBS, id, 'run.log'), 'utf8');
    const m = log.match(/^fake-codex: got \d+ brief bytes, args: (.*)$/m);
    assert.ok(m, `run.log must carry the argv codex was handed:\n${log}`);
    return m[1];
  };

  const r = run(['dispatch', '--brief', brief, '--role', 'argvflags',
    '--model', 'gpt-5.6-sol', '--effort', 'xhigh']);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => done(id)), 'the job must finish');

  const rec = record(id);
  assert.equal(rec.cwd, path.resolve(REPO), 'the job cwd is the dispatch cwd, resolved');
  const argv = argvOf(id);
  for (const flag of [
    'exec -',
    `--cd ${rec.cwd}`,
    '--sandbox read-only',
    '--skip-git-repo-check',
    '--model gpt-5.6-sol',
    '-c model_reasoning_effort=xhigh',
    `--output-last-message ${path.join(JOBS, id, 'out.txt')}`,
  ]) {
    assert.ok(argv.includes(flag), `codex's argv must carry "${flag}"\ngot: ${argv}`);
  }

  // --write is the only thing that may move the sandbox off read-only, and it has
  // to reach the FLAG, not merely the record: a record that says workspace-write
  // while codex was handed read-only is a job that silently cannot write.
  const w = run(['dispatch', '--brief', brief, '--role', 'argvwrite', '--write']);
  assert.equal(w.status, 0, w.stderr);
  const wid = jobIdFrom(w.stdout);
  assert.ok(await poll(() => done(wid)), 'the --write job must finish');
  assert.equal(record(wid).sandbox, 'workspace-write');
  assert.ok(argvOf(wid).includes('--sandbox workspace-write'),
    `--write must reach codex's argv\ngot: ${argvOf(wid)}`);
  assert.equal(argvOf(wid).includes('--sandbox read-only'), false,
    'and must not leave the read-only flag alongside it');
});

test('the brief reaches codex\'s stdin byte-for-byte, not merely on disk', async () => {
  // prompt.md is asserted elsewhere; this is the OTHER half of the same claim.
  // Between the file and the model there is an fd handed to a spawned process,
  // and every mangling worth worrying about — CRLF translation, a re-encode, a
  // BOM, a trailing newline politely added — survives a byte COUNT and changes
  // what the model was asked. So the fake writes back what it actually read on
  // fd 0 and it is diffed against the dispatched file.
  const briefContent =
    'CRLF line\r\nlone LF line\nunicode é中🙂 and a NUL-free tab\there\r\nno trailing newline';
  const brief = writeBrief('briefstdin.md', briefContent);
  const r = run(['dispatch', '--brief', brief, '--role', 'stdinbytes']);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => done(id)), 'the job must finish');

  const received = fs.readFileSync(path.join(JOBS, id, 'received-brief.bin'));
  assert.deepEqual(received, Buffer.from(briefContent),
    'the bytes codex read on stdin must be the bytes that were dispatched');
  assert.deepEqual(received, fs.readFileSync(brief), 'and the bytes still on disk');
  assert.deepEqual(received, fs.readFileSync(path.join(JOBS, id, 'prompt.md')),
    'so file, copy and stdin are one transport with no re-encode in it');
});

test('a codex that exits nonzero is failed, and a done job with no answer file is refused', async () => {
  // Two shapes CI had never produced, both of which end with the operator being
  // told something the run cannot support.
  //
  // First: codex writes an out file and THEN fails. The file exists, so anything
  // that treats an answer file as a verdict delivers it; only the recorded exit
  // code can tell this apart from a success.
  const brief = writeBrief('briefexecfail.md', 'quick');
  const f = run(['dispatch', '--brief', brief, '--role', 'execfail'], { FAKE_CODEX_EXEC_EXIT: '3' });
  assert.equal(f.status, 0, f.stderr);
  const failId = jobIdFrom(f.stdout);
  assert.ok(await poll(() => record(failId).state !== 'running'), 'the supervisor must finalize');

  const failed = record(failId);
  assert.equal(failed.state, 'failed', 'a nonzero exit is a failure, whatever is on disk');
  assert.equal(failed.exitCode, 3, 'and the code is recorded, not flattened to 1');
  assert.ok(fs.existsSync(path.join(JOBS, failId, 'out.txt')),
    'the answer file really is there, which is what makes this the interesting case');
  assert.match(run(['status', failId]).stdout, /^state: failed$/m);

  const failRes = run(['result', failId]);
  assert.notEqual(failRes.status, 0, 'result must refuse a failed job');
  assert.equal(failRes.stdout, '', 'and produce ZERO stdout, answer file or not');
  assert.match(failRes.stderr, /NOT DELIVERED/);
  assert.match(failRes.stderr, /is failed/);
  assert.match(failRes.stderr, /An answer file DOES exist/, 'admitting the file rather than hiding it');
  assert.match(failRes.stderr, /^out: .+out\.txt$/m);

  // Second: codex exits 0 and writes nothing. The record honestly says `done` and
  // passes the whole deliverability gate — stamp, clean exit, proven sight — so
  // the only thing between the operator and an empty, confident delivery is the
  // MISSING check at the end of it.
  const m = run(['dispatch', '--brief', brief, '--role', 'noout'], { FAKE_CODEX_NO_OUT: '1' });
  assert.equal(m.status, 0, m.stderr);
  const missId = jobIdFrom(m.stdout);
  assert.ok(await poll(() => done(missId)), 'an exit 0 is still a done job');

  const missing = record(missId);
  assert.equal(missing.exitCode, 0);
  assert.match(missing.sight, /^cwd-file:/, 'sight was proven, so nothing earlier refuses it');
  assert.equal(fs.existsSync(path.join(JOBS, missId, 'out.txt')), false, 'and there is no answer file');
  assert.match(run(['status', missId]).stdout, /^deliverable: yes/m,
    'the record vouches for the run — the bytes are what is absent');

  const missRes = run(['result', missId]);
  assert.notEqual(missRes.status, 0, 'result must refuse rather than deliver nothing successfully');
  assert.equal(missRes.stdout, '', 'zero stdout');
  assert.match(missRes.stderr, /MISSING/, 'and name the class: done, but no answer on disk');
  assert.match(missRes.stderr, /^out: .+out\.txt$/m);
});

test('the shipped defaults are the budget pair, and explicit flags override them', async () => {
  // The defaults are a safety property, not a preference: an install that has
  // only ever been cloned must not be able to bill frontier prices by accident.
  // Asserted on job.json rather than the constants because the record is what
  // the supervisor hands to `codex exec --model/-c model_reasoning_effort`.
  const brief = writeBrief('briefdefaults.md', 'quick');

  const d = run(['dispatch', '--brief', brief, '--role', 'defaults']);
  assert.equal(d.status, 0, d.stderr);
  const defaulted = record(jobIdFrom(d.stdout));
  assert.equal(defaulted.model, 'gpt-5.6-luna', 'ships at the budget model, not the frontier one');
  assert.equal(defaulted.effort, 'medium', 'and at medium effort, not xhigh');
  assert.equal(defaulted.sandbox, 'read-only', 'and read-only, as always');

  const o = run(['dispatch', '--brief', brief, '--role', 'overridden',
    '--model', 'gpt-5.6-sol', '--effort', 'xhigh']);
  assert.equal(o.status, 0, o.stderr);
  const overridden = record(jobIdFrom(o.stdout));
  assert.equal(overridden.model, 'gpt-5.6-sol', 'frontier is two flags away');
  assert.equal(overridden.effort, 'xhigh');

  for (const id of [jobIdFrom(d.stdout), jobIdFrom(o.stdout)]) await poll(() => done(id));
});

test('rapid successive dispatches get unique job dirs', async () => {
  const brief = writeBrief('brief2.md', 'quick');
  // roles are [a-z]+ only, so that job ids stay inside the id whitelist
  const ids = ['ua', 'ub', 'uc'].map((role) => {
    const r = run(['dispatch', '--brief', brief, '--role', role]);
    assert.equal(r.status, 0, r.stderr);
    return jobIdFrom(r.stdout);
  });
  assert.equal(new Set(ids).size, 3, 'all job dirs distinct');
  for (const id of ids) await poll(() => done(id));
});

test('same-role double dispatch refuses; --force kills the old tree first', async () => {
  const brief = writeBrief('brief3.md', 'slow');
  const env = { FAKE_CODEX_SLEEP_MS: '60000' };
  const { keep, cancelAll } = reaper();
  try {
    const first = run(['dispatch', '--brief', brief, '--role', 'dup'], env);
    assert.equal(first.status, 0, first.stderr);
    const firstId = keep(jobIdFrom(first.stdout));
    await poll(() => record(firstId).codexPid);

    const refused = run(['dispatch', '--brief', brief, '--role', 'dup'], env);
    assert.notEqual(refused.status, 0, 'second dispatch must refuse');
    assert.ok(refused.stderr.includes(firstId), 'refusal must name the running job');
    assert.match(refused.stderr, /^out: /m);

    const forced = run(['dispatch', '--brief', brief, '--role', 'dup', '--force'], env);
    assert.equal(forced.status, 0, forced.stderr);
    const forcedId = keep(jobIdFrom(forced.stdout));
    assert.notEqual(forcedId, firstId);

    const old = record(firstId);
    assert.equal(old.state, 'killed');
    assert.ok(await poll(() => !pidAlive(old.supervisorPid)), 'old supervisor must be dead');
    assert.ok(await poll(() => !pidAlive(old.codexPid)), 'old codex must be dead');
  } finally {
    cancelAll();
  }
});

test('concurrent same-role dispatches: exactly one wins the claim', async () => {
  // The scan-then-create guard could be beaten by two dispatches reading the same
  // empty world; the role is claimed with mkdir, where exactly one racer wins.
  const brief = writeBrief('briefrace.md', 'slow');
  const env = { ...baseEnv, FAKE_CODEX_SLEEP_MS: '60000' };
  const launch = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNTIME, 'dispatch', '--brief', brief, '--role', 'race'],
      { env, cwd: REPO });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  const { keep, cancelAll } = reaper();
  try {
    const results = await Promise.all([launch(), launch()]);
    const winners = results.filter((r) => r.code === 0);
    const losers = results.filter((r) => r.code !== 0);
    // Registered BEFORE the count is asserted: the failure this test exists to
    // catch is two winners, and that is exactly the case where letting the assert
    // throw first would leave a minute-long fake behind.
    for (const w of winners) keep(jobIdFrom(w.stdout));
    assert.equal(winners.length, 1, `exactly one dispatch may win the role: ${JSON.stringify(results)}`);
    assert.equal(losers.length, 1);
    assert.match(losers[0].stderr, /race/, 'the loser must say which role it lost');
    assert.equal(losers[0].stdout.includes('job: '), false, 'the loser must not hand out a job handle');

    const dirs = fs.readdirSync(JOBS).filter((n) => n.startsWith('race-'));
    assert.equal(dirs.length, 1, 'and must leave no job dir behind');
  } finally {
    cancelAll();
  }
});

test('a stale same-role job blocks dispatch and is named as stale', async () => {
  const dir = path.join(JOBS, 'phantom-1-99998');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    id: 'phantom-1-99998', role: 'phantom', state: 'running',
    started: new Date(Date.now() - 3600000).toISOString(),
    supervisorPid: 999999998, codexPid: null,
  }));
  const brief = writeBrief('brief6.md', 'quick');
  const refused = run(['dispatch', '--brief', brief, '--role', 'phantom']);
  assert.notEqual(refused.status, 0, 'a stale same-role job must block dispatch');
  assert.ok(refused.stderr.includes('phantom-1-99998'), 'refusal must name the stale job');
  assert.match(refused.stderr, /already stale/, 'refusal must say stale, not running');
  assert.match(refused.stderr, /^out: /m);
});

test('--force reaps a codex orphaned by a dead supervisor', async () => {
  // The grandchild here is reachable ONLY through the tree kill — `child.pid` is
  // written by the fake and read by this test, and is not a file the runtime
  // treats as a kill target. While it was one, the grandchild was a DIRECT target
  // and this assertion could not fail however badly `taskkill /T` (or the POSIX
  // group kill) traversed. Same unmasking the group-kill test below does by hand.
  const brief = writeBrief('brief7.md', 'slow');
  const env = { FAKE_CODEX_SLEEP_MS: '60000' };
  const { keep, cancelAll } = reaper();
  try {
    const r = run(['dispatch', '--brief', brief, '--role', 'orphan'], env);
    assert.equal(r.status, 0, r.stderr);
    const id = keep(jobIdFrom(r.stdout));
    const childPidFile = path.join(JOBS, id, 'child.pid');
    assert.ok(
      await poll(() => record(id).codexPid && fs.existsSync(childPidFile)),
      'fake codex should start and record its child'
    );
    const { supervisorPid, codexPid } = record(id);
    const grandchildPid = Number(fs.readFileSync(childPidFile, 'utf8'));

    // Kill ONLY the supervisor: codex is reparented and keeps running (and billing).
    process.kill(supervisorPid);
    assert.ok(await poll(() => !pidAlive(supervisorPid)), 'supervisor must be dead');
    assert.ok(pidAlive(codexPid), 'orphaned codex must survive its supervisor');
    assert.match(run(['status', id]).stdout, /^state: stale$/m, 'job should read as stale');

    const refused = run(['dispatch', '--brief', brief, '--role', 'orphan'], env);
    assert.notEqual(refused.status, 0, 'the stale job must still block a same-role dispatch');

    const forced = run(['dispatch', '--brief', brief, '--role', 'orphan', '--force'], env);
    assert.equal(forced.status, 0, forced.stderr);
    keep(jobIdFrom(forced.stdout));
    assert.equal(record(id).state, 'killed', '--force must mark the stale job killed');
    assert.ok(await poll(() => !pidAlive(codexPid)), '--force must reap the orphaned codex');
    assert.ok(await poll(() => !pidAlive(grandchildPid)), 'and the orphan\'s own child');
  } finally {
    cancelAll();
  }
});

test('a kill that does not take is kill-failed, not killed, and blocks --force', async () => {
  // The survivor is simulated: CODEX_DISPATCH_TEST_NOKILL makes killTree a no-op,
  // standing in for a taskkill that returns success and changes nothing (access
  // denied, an elevated child, a process wedged in a driver). The approximation
  // is deliberate — what is under test is what the runtime does once the pids are
  // still alive afterwards, not the mechanism by which they survived.
  const brief = writeBrief('briefnokill.md', 'slow');
  const env = { FAKE_CODEX_SLEEP_MS: '60000' };
  const { keep, cancelAll } = reaper();
  try {
    const r = run(['dispatch', '--brief', brief, '--role', 'nokill'], env);
    assert.equal(r.status, 0, r.stderr);
    const id = keep(jobIdFrom(r.stdout));
    assert.ok(await poll(() => record(id).codexPid), 'fake codex should start');
    const { supervisorPid, codexPid } = record(id);

    const c = run(['cancel', id], { CODEX_DISPATCH_TEST_NOKILL: '1' });
    assert.notEqual(c.status, 0, 'a kill that did not take must exit nonzero');
    assert.match(c.stderr, /KILL FAILED/, 'and say so loudly');
    assert.ok(c.stderr.includes(String(supervisorPid)), 'naming the survivors');

    const rec = record(id);
    assert.equal(rec.state, 'kill-failed', 'the state is kill-failed, NOT killed');
    assert.ok(rec.killSurvivors.includes(String(codexPid)), 'survivors are recorded');
    assert.ok(pidAlive(supervisorPid), 'and the survivor really is still alive');

    const st = run(['status', id]);
    assert.match(st.stdout, /^state: kill-failed$/m);
    assert.match(st.stdout, /^survivors: /m);

    const stillRefused = run(['dispatch', '--brief', brief, '--role', 'nokill'], env);
    assert.notEqual(stillRefused.status, 0, 'a kill-failed job keeps blocking its role');
    assert.match(stillRefused.stderr, /already kill-failed/);

    const forcedFail = run(['dispatch', '--brief', brief, '--role', 'nokill', '--force'],
      { ...env, CODEX_DISPATCH_TEST_NOKILL: '1' });
    assert.notEqual(forcedFail.status, 0, '--force must refuse to launch alongside a survivor');
    assert.match(forcedFail.stderr, /REFUSING to launch/);
    assert.match(forcedFail.stderr, /^survivors: /m);
    assert.equal(forcedFail.stdout.includes('job: '), false, 'and hand out no new job');

    // With kills working again, --force reaps it and proceeds.
    //
    // Retried on a TEST-side deadline. The runtime verifies a kill inside its own
    // KILL_VERIFY_MS, and the tree here is three processes deep with the
    // grandchild reachable only by traversal — on a loaded box that can miss one
    // verification window and be gone by the next. A --force that refuses because
    // it still saw a survivor is precisely the refusal this runtime is designed to
    // be retried through, so the margin belongs here and the runtime's timing
    // constant is deliberately left alone. Nothing is weakened: a real regression
    // refuses every attempt, and the two assertions below are unchanged.
    let forcedOk = run(['dispatch', '--brief', brief, '--role', 'nokill', '--force'], env);
    for (let attempt = 0; attempt < 5 && forcedOk.status !== 0; attempt++) {
      await new Promise((r) => setTimeout(r, 500));
      forcedOk = run(['dispatch', '--brief', brief, '--role', 'nokill', '--force'], env);
    }
    assert.equal(forcedOk.status, 0, forcedOk.stderr);
    keep(jobIdFrom(forcedOk.stdout));
    assert.equal(record(id).state, 'killed', 'the verified kill finally lands');
    assert.ok(await poll(() => !pidAlive(supervisorPid)), 'and the survivor is gone');
  } finally {
    cancelAll();
  }
});

test('a liveness probe that hits EPERM means ALIVE, so the kill counts as failed', async () => {
  // The probe used to read every exception as "dead", which inverts the one case
  // that matters: process.kill(pid, 0) raises EPERM exactly when the process
  // EXISTS but may not be signalled — an elevated child, another user's, a
  // protected one. That is the shape a survived kill takes, and calling it death
  // reported the kill as verified. Injected, because real elevation is not
  // producible in CI and what is under test is the decision, not the denial.
  const brief = writeBrief('briefeperm.md', 'slow');
  const env = { FAKE_CODEX_SLEEP_MS: '60000' };
  const { keep, cancelAll } = reaper();
  try {
    const r = run(['dispatch', '--brief', brief, '--role', 'eperm'], env);
    assert.equal(r.status, 0, r.stderr);
    const id = keep(jobIdFrom(r.stdout));
    assert.ok(await poll(() => record(id).codexPid), 'fake codex should start');
    const { codexPid } = record(id);

    const c = run(['cancel', id], { CODEX_DISPATCH_TEST_EPERM: String(codexPid) });
    assert.notEqual(c.status, 0, 'a pid that answers EPERM is a survivor, so the cancel fails');
    assert.match(c.stderr, /KILL FAILED/);
    assert.ok(c.stderr.includes(String(codexPid)), 'naming the pid it could not verify dead');

    const rec = record(id);
    assert.equal(rec.state, 'kill-failed', 'kill-failed, NOT killed');
    assert.ok(rec.killSurvivors.includes(String(codexPid)));
    assert.match(run(['status', id]).stdout, /^state: kill-failed$/m);

    // Without the injection the same pids verify as gone, and the kill lands.
    // Retried on a test-side deadline rather than once: the runtime verifies a
    // kill within its own KILL_VERIFY_MS, and on a loaded box a tree that is on
    // its way out can miss one window and be gone by the next. The runtime's
    // timing constant is the subject of other tests and is deliberately not
    // touched — what is asserted here is that the kill LANDS, not how fast.
    assert.ok(await poll(() => run(['cancel', id]).status === 0 && record(id).state === 'killed', 20000),
      `a cancel with no injection must verify the death: ${JSON.stringify(record(id))}`);
  } finally {
    cancelAll();
  }
});

test('a recorded pid the OS has reissued is not fired at, and is not read as alive', async () => {
  // Pid reuse. The numbers in a record are written down once and fired at
  // whenever a cancel gets round to them — `taskkill /PID <n> /T /F`, hours
  // later, at whatever holds that number by then. reaped.pids does not cover it:
  // that stops a SECOND shot, and the first is the one that hits a stranger. The
  // same number read as alive is how a dead job reads `running` for ever.
  //
  // The reuse itself is not producible on demand — it needs the OS to reissue a
  // chosen number — so CODEX_DISPATCH_TEST_START_TIME stands in for what the OS
  // would report, exactly as CODEX_DISPATCH_TEST_EPERM stands in for a denied
  // liveness probe. The sleepers below are the innocent processes: real, alive,
  // and nothing to do with these jobs.
  const sleeper = () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    child.unref();
    return child;
  };
  const mine = sleeper();
  const stranger = sleeper();
  const fixture = (id, pid, recordedStart) => {
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      recordVersion: RECORD_VERSION, id, role: id.split('-')[0], state: 'running',
      started: new Date(Date.now() - 3600000).toISOString(),
      launch: 'spawned', supervisorPid: pid, codexPid: null,
      pidStarts: { [pid]: recordedStart },
    }));
    return id;
  };
  try {
    assert.ok(await poll(() => pidAlive(mine.pid) && pidAlive(stranger.pid)), 'both sleepers must be up');
    const AT = '2026-08-06T13:49:29.0000000+00:00';
    const LATER = '2026-08-06T19:20:21.0000000+00:00';

    // The control: the number still carries the start time the record wrote down,
    // so it IS this job's process. Nothing about identity may change that.
    const same = fixture('reusedsame-1-99989', mine.pid, AT);
    const sameEnv = { CODEX_DISPATCH_TEST_START_TIME: `${mine.pid}:${AT}` };
    assert.match(run(['status', same], sameEnv).stdout, /^state: running$/m,
      'a matching start time leaves the pid alive, as before');
    const killed = run(['cancel', same], sameEnv);
    assert.equal(killed.status, 0, killed.stderr);
    assert.ok(await poll(() => !pidAlive(mine.pid)), 'and the kill still lands on it');

    // The reused number: alive, but started long after this job recorded it.
    const reused = fixture('reused-1-99988', stranger.pid, AT);
    const reusedEnv = { CODEX_DISPATCH_TEST_START_TIME: `${stranger.pid}:${LATER}` };
    assert.match(run(['status', reused], reusedEnv).stdout, /^state: stale$/m,
      'a live number that is not ours must not read as running');

    const c = run(['cancel', reused], reusedEnv);
    assert.equal(c.status, 0, c.stderr);
    assert.equal(record(reused).state, 'killed', 'the job is dead: its process went, the number stayed');
    assert.ok(c.stderr.includes(String(stranger.pid)), 'and the pid it declined to signal is named');
    assert.match(c.stderr, /reissued/);
    assert.ok(pidAlive(stranger.pid), 'the process holding that number now must be untouched');

    // Fail open, both ways round: a record from before start times were kept, and
    // one whose current start time cannot be read, keep the old behaviour.
    const legacy = path.join(JOBS, 'reusedold-1-99987');
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(legacy, 'job.json'), JSON.stringify({
      recordVersion: RECORD_VERSION, id: 'reusedold-1-99987', role: 'reusedold', state: 'running',
      started: new Date(Date.now() - 3600000).toISOString(),
      launch: 'spawned', supervisorPid: stranger.pid, codexPid: null,
    }));
    assert.match(run(['status', 'reusedold-1-99987'], reusedEnv).stdout, /^state: running$/m,
      'nothing recorded, nothing to check: the pid keeps the standing it had');
  } finally {
    for (const child of [mine, stranger]) { try { process.kill(child.pid); } catch { /* gone */ } }
  }
});

test('a claimer descheduled after winning the role detects the takeover and aborts', async () => {
  // mkdir-then-write-owner left a fence: a claimer paused inside the window could
  // be reclaimed and then wake up and write its own name back over the new
  // owner's. The claim is now built complete and renamed into place, the reclaim
  // is a rename of the whole lock directory, and the claimer re-reads the owner
  // before it is allowed to launch anything.
  const brief = writeBrief('brieffence.md', 'quick');
  const env = { ...baseEnv, CODEX_DISPATCH_TEST_CLAIM_PAUSE_MS: '4000' };
  const paused = new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNTIME, 'dispatch', '--brief', brief, '--role', 'fence'],
      { env, cwd: REPO });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  // Let the pauser take the claim and write its record, then take the role off it.
  await new Promise((r) => setTimeout(r, 1200));
  const taker = run(['dispatch', '--brief', brief, '--role', 'fence', '--force']);
  assert.equal(taker.status, 0, `the takeover must succeed: ${taker.stderr}`);
  const takerId = jobIdFrom(taker.stdout);

  const loser = await paused;
  assert.notEqual(loser.code, 0, 'the descheduled claimer must NOT launch');
  assert.match(loser.stderr, /CLAIM LOST/, 'and must say the role was taken from it');
  assert.equal(loser.stdout.includes('out: '), false, 'and hand out no usable job handle');

  const dirs = fs.readdirSync(JOBS).filter((n) => n.startsWith('fence-'));
  assert.deepEqual(dirs, [takerId], 'exactly one fence job dir, and it is the taker\'s');
  assert.ok(await poll(() => done(takerId)), 'the survivor is the one that runs');
});

test('taking a role from an owner that cannot vouch for itself kills first, or refuses', async () => {
  // A corrupt record says NOTHING about whether its processes are alive, which is
  // not the same as saying they are dead. The reclaim path used to take the role
  // on that silence and launch beside whatever was still running.
  const brief = writeBrief('briefreclaim.md', 'slow');
  const env = { FAKE_CODEX_SLEEP_MS: '60000' };
  const { keep, cancelAll } = reaper();
  try {
    const r = run(['dispatch', '--brief', brief, '--role', 'unvouched'], env);
    assert.equal(r.status, 0, r.stderr);
    const id = keep(jobIdFrom(r.stdout));
    const childPidFile = path.join(JOBS, id, 'child.pid');
    assert.ok(await poll(() => record(id).codexPid && fs.existsSync(childPidFile)), 'fake codex should start');
    const { supervisorPid, codexPid } = record(id);
    const grandchildPid = Number(fs.readFileSync(childPidFile, 'utf8'));

    fs.writeFileSync(path.join(JOBS, id, 'job.json'), '{"state":"running", TRUNCATED');
    assert.match(run(['status', id]).stdout, /^state: corrupt$/m, 'and now it cannot vouch for itself');

    // Kills that do not take: the takeover must be refused, not proceeded past.
    const refused = run(['dispatch', '--brief', brief, '--role', 'unvouched'],
      { ...env, CODEX_DISPATCH_TEST_NOKILL: '1' });
    assert.notEqual(refused.status, 0, 'a survivor must block the takeover');
    assert.match(refused.stderr, /REFUSING to launch/);
    assert.match(refused.stderr, /^survivors: /m);
    assert.equal(refused.stdout.includes('job: '), false, 'and no job may be handed out');
    assert.ok(pidAlive(supervisorPid), 'the unvouched-for job is still running, which is the point');

    // Kills that work: the role changes hands only after the processes are gone.
    const taken = run(['dispatch', '--brief', brief, '--role', 'unvouched'], env);
    assert.equal(taken.status, 0, taken.stderr);
    keep(jobIdFrom(taken.stdout));
    assert.match(taken.stdout, /reaped unvouched-for job before taking role/);
    assert.ok(await poll(() => !pidAlive(supervisorPid)), 'its supervisor must be dead');
    assert.ok(await poll(() => !pidAlive(codexPid)), 'its codex must be dead');
    assert.ok(await poll(() => !pidAlive(grandchildPid)), 'and codex\'s own child');
    assert.equal(
      fs.readFileSync(path.join(JOBS, id, 'job.json'), 'utf8'), '{"state":"running", TRUNCATED',
      'the corrupt record is still evidence and is left byte-for-byte'
    );
  } finally {
    cancelAll();
  }
});

test('a pid file that cannot be renamed is reported, and its pids still never fire twice', async () => {
  // Consuming a spent pid file has two halves: writing the numbers down, and
  // renaming the file out of the way. Only the second can fail, and it used to
  // fail silently — leaving the numbers loaded AND the operator believing they
  // were not. Now the failure is reported and the written-down list, not the file
  // name, is what the next reap consults.
  const dir = path.join(JOBS, 'renamefail-1-99991');
  fs.mkdirSync(dir, { recursive: true });
  const raw = 'not json at all either';
  fs.writeFileSync(path.join(dir, 'job.json'), raw);
  const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
    stdio: 'ignore', detached: true,
  });
  victim.unref();
  fs.writeFileSync(path.join(dir, 'codex.pid'), String(victim.pid));

  const c = run(['cancel', 'renamefail-1-99991'], { CODEX_DISPATCH_TEST_RENAME_FAIL: 'codex.pid' });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, new RegExp(`killed recorded pids: ${victim.pid}`));
  assert.match(c.stderr, /WARNING/, 'the failed rename is surfaced, not swallowed');
  assert.match(c.stderr, /could not rename spent pid file\(s\): codex\.pid \(EPERM\)/);
  assert.match(c.stdout, /reaped pids recorded in reaped\.pids/, 'and the durable half is named');
  assert.ok(await poll(() => !pidAlive(victim.pid)), 'the pid was still killed');

  assert.ok(fs.existsSync(path.join(dir, 'codex.pid')), 'the pid file really did survive');
  assert.equal(
    fs.readFileSync(path.join(dir, 'reaped.pids'), 'utf8').trim(), String(victim.pid),
    'and the number is written down as spent'
  );
  assert.equal(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'), raw, 'evidence untouched');

  const second = run(['cancel', 'renamefail-1-99991']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already reaped: pids \d+ \(recorded in reaped\.pids\)/);
  assert.equal(second.stdout.includes('killed recorded pids'), false,
    'a loaded pid file whose numbers are spent must not be fired again');
});

test('result before done exits nonzero and prints the out: line', async () => {
  const brief = writeBrief('brief4.md', 'slow');
  const { keep, cancelAll } = reaper();
  try {
    const r = run(['dispatch', '--brief', brief, '--role', 'notready'], { FAKE_CODEX_SLEEP_MS: '60000' });
    const id = keep(jobIdFrom(r.stdout));
    const res = run(['result', id]);
    assert.notEqual(res.status, 0, 'result before done must exit nonzero');
    assert.equal(res.stdout, '', 'stdout must stay empty when not ready');
    assert.match(res.stderr, /^out: .+out\.txt$/m);
    assert.match(res.stderr, /running/);
  } finally {
    cancelAll();
  }
});

test('the record is authoritative: an answer file is not a verdict', async () => {
  // Revoked here: out.txt existence used to promote a job to done. It appears the
  // instant codex writes it — before the exit code is recorded and before any
  // sight verdict — so the promotion published answers nothing had vouched for.
  const failed = path.join(JOBS, 'refused-1-99994');
  fs.mkdirSync(failed, { recursive: true });
  fs.writeFileSync(path.join(failed, 'job.json'), JSON.stringify({
    id: 'refused-1-99994', role: 'refused', state: 'failed',
    started: new Date().toISOString(), finished: new Date().toISOString(),
    exitCode: 1, supervisorPid: null, codexPid: null,
  }));
  fs.writeFileSync(path.join(failed, 'out.txt'), 'a confident answer nobody vouched for\n');

  const res = run(['result', 'refused-1-99994']);
  assert.notEqual(res.status, 0, 'a failed job must refuse even with an answer file on disk');
  assert.equal(res.stdout, '', 'the unvouched-for answer must never reach stdout');
  assert.match(res.stderr, /NOT DELIVERED/);
  assert.match(res.stderr, /is failed/, 'the refusal names the state');
  assert.match(res.stderr, /An answer file DOES exist/, 'and admits the file is there');
  assert.match(res.stderr, /^out: .+out\.txt$/m);

  // The same rule for a job whose supervisor died after codex wrote the answer:
  // stale, not done.
  const orphaned = path.join(JOBS, 'unfinalized-1-99992');
  fs.mkdirSync(orphaned, { recursive: true });
  fs.writeFileSync(path.join(orphaned, 'job.json'), JSON.stringify({
    id: 'unfinalized-1-99992', role: 'unfinalized', state: 'running',
    started: new Date(Date.now() - 3600000).toISOString(),
    supervisorPid: 999999997, codexPid: null,
  }));
  fs.writeFileSync(path.join(orphaned, 'out.txt'), 'finished but never finalized\n');

  const st = run(['status', 'unfinalized-1-99992']);
  assert.match(st.stdout, /^state: stale$/m, 'an out file no longer promotes a job to done');
  const res2 = run(['result', 'unfinalized-1-99992']);
  assert.notEqual(res2.status, 0);
  assert.equal(res2.stdout, '');
  assert.match(res2.stderr, /is stale/);
  assert.match(run(['list']).stdout, /^unfinalized-1-99992  stale  out: /m);
});

test('cancel kills the whole tree (supervisor, codex, and its child)', async () => {
  // `child.pid` is the fake's own artifact and is read here, not by the runtime:
  // the grandchild is a kill target only by descent, so a `/T` that stopped
  // traversing would fail this rather than pass through a recorded pid.
  const brief = writeBrief('brief5.md', 'slow');
  const r = run(['dispatch', '--brief', brief, '--role', 'kill'], { FAKE_CODEX_SLEEP_MS: '60000' });
  const id = jobIdFrom(r.stdout);
  const childPidFile = path.join(JOBS, id, 'child.pid');
  assert.ok(await poll(() => fs.existsSync(childPidFile) && record(id).codexPid), 'fake codex should start');
  const childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
  const { supervisorPid, codexPid } = record(id);
  assert.ok(pidAlive(supervisorPid) && pidAlive(codexPid) && pidAlive(childPid), 'tree alive before cancel');

  const c = run(['cancel', id]);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(record(id).state, 'killed');
  assert.ok(await poll(() => !pidAlive(supervisorPid)), 'supervisor dead');
  assert.ok(await poll(() => !pidAlive(codexPid)), 'codex dead');
  assert.ok(await poll(() => !pidAlive(childPid)), 'codex child dead');

  const st = run(['status', id]);
  assert.match(st.stdout, /^state: killed$/m);
});

test('a sandbox failure with an UNRECOGNIZED error is caught before codex spends anything', async () => {
  // The keystone. The fake's sandbox failure matches no entry in BLIND_SIGNATURES
  // on purpose: a positive proof does not need to have met the failure before,
  // which is exactly what the old post-hoc signature scan could not say.
  const brief = writeBrief('briefprecheck.md', 'review something');
  const r = run(['dispatch', '--brief', brief, '--role', 'precheck'], { FAKE_CODEX_SANDBOX_BROKEN: '1' });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => record(id).state !== 'running'), 'the supervisor must finalize');

  const rec = record(id);
  assert.equal(rec.state, 'failed');
  assert.equal(rec.reason, 'sandbox-blind-precheck');
  assert.match(rec.sight, /FAILED/, 'the failed proof is recorded');
  assert.match(rec.sight, /jail_bootstrap_unavailable/, 'quoting the novel error verbatim');
  for (const sig of ['orchestrator_helper_launch_failed', 'helper=codex-windows-sandbox-setup.exe',
    'CreateProcessWithLogonW failed', 'helper copy failed']) {
    assert.equal(rec.sight.includes(sig), false, 'no known signature is present — only the proof caught it');
  }
  assert.equal(rec.exitCode, null, 'codex exec never ran');
  assert.equal(fs.existsSync(path.join(JOBS, id, 'out.txt')), false, 'so there is no answer, and nothing was spent');
  assert.equal(
    fs.readFileSync(path.join(JOBS, id, 'run.log'), 'utf8').includes('brief bytes'),
    false,
    'and the brief never reached a model'
  );

  const st = run(['status', id]);
  assert.match(st.stdout, /^state: failed$/m);
  assert.match(st.stdout, /^reason: sandbox-blind-precheck$/m);

  const res = run(['result', id]);
  assert.notEqual(res.status, 0, 'result on a precheck-failed job must exit nonzero');
  assert.equal(res.stdout, '', 'nothing may reach stdout');
  assert.match(res.stderr, /BLIND/);
  assert.match(res.stderr, /npm install -g @openai\/codex/, 'with the fix');
  assert.match(res.stderr, /^out: /m);
  assert.match(run(['list']).stdout, new RegExp(`^${id}  failed\\(sandbox-blind-precheck\\)`, 'm'));

  // A failed precheck is terminal, so it must hand the role back.
  const again = run(['dispatch', '--brief', brief, '--role', 'precheck']);
  assert.equal(again.status, 0, `a failed precheck must release its role claim: ${again.stderr}`);
  await poll(() => done(jobIdFrom(again.stdout)));
});

test('sandbox signatures in the log are a warning now, not a verdict', async () => {
  // Demoted: sight is established positively before the run, so a signature in
  // run.log afterwards is something to say out loud, not something that overrules
  // a proof. (New error shapes false-negative this scan; recovered failures
  // false-positive it. Neither can flip a job any more.)
  const brief = writeBrief('brief8.md', 'review something');
  const r = run(['dispatch', '--brief', brief, '--role', 'blind'], { FAKE_CODEX_BLIND: '1' });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => record(id).state !== 'running'), 'job should finalize');

  const rec = record(id);
  assert.equal(rec.exitCode, 0, 'the blind failure is invisible to the exit code — that is the point');
  assert.equal(rec.state, 'done', 'the proven precheck decides the state, not the scan');
  assert.match(rec.warning, /sandbox-failure signatures in log/);
  assert.match(rec.blindSignature, /orchestrator_helper_launch_failed|CreateProcessWithLogonW/);
  assert.match(rec.sight, /^(cwd-file:|job-nonce)/, 'and sight was proven for this job, in its cwd');

  const st = run(['status', id]);
  assert.match(st.stdout, /^state: done$/m);
  assert.match(st.stdout, /^warning: sandbox-failure signatures in log/m);

  const res = run(['result', id]);
  assert.equal(res.status, 0, 'a warning does not withhold the answer');
  assert.match(res.stderr, /WARNING/, 'but it is shouted on stderr');
  assert.deepEqual(
    Buffer.from(res.stdout),
    fs.readFileSync(path.join(JOBS, id, 'out.txt')),
    'and stdout stays byte-verbatim'
  );
  assert.match(run(['list']).stdout, new RegExp(`^${id}  done  out: .+warning: sandbox-failure`, 'm'));
});

test('a job that merely reads source containing the signatures is not even warned about', async () => {
  // Found live: the first true end-to-end review echoed this runtime's own source
  // — signature string literals and all — and a merged-log scan failed the one
  // job that had actually worked.
  const brief = writeBrief('brief11.md', 'review the runtime');
  const r = run(['dispatch', '--brief', brief, '--role', 'echo'], { FAKE_CODEX_ECHO: '1' });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => record(id).state !== 'running'), 'job should finalize');

  const rec = record(id);
  assert.equal(rec.state, 'done', 'signatures as content are content, not diagnosis');
  assert.equal(rec.reason, undefined);
  assert.equal(rec.warning, undefined, 'and not even a warning');
  assert.ok(
    fs.readFileSync(path.join(JOBS, id, 'run.log'), 'utf8').includes('orchestrator_helper_launch_failed'),
    'the run log really does contain the signature'
  );
  assert.equal(run(['result', id]).status, 0, 'and the answer is delivered');
});

test('a codex with no sandbox subcommand is REFUSED, not politely delivered', async () => {
  // REWRITTEN. This used to assert that an unprovable sandbox ran and delivered
  // with a warning attached, on the reasoning that refusing a CLI too old to have
  // the subcommand would be inventing a defect. That reasoning was the hole: an
  // answer nobody could vouch for went out anyway, carrying a caveat instead of a
  // refusal — the blind-success route, reopened by politeness. Deliverability now
  // requires PROVEN sight, and nothing else does.
  const brief = writeBrief('briefnosub.md', 'quick');
  const r = run(['dispatch', '--brief', brief, '--role', 'nosub'], { FAKE_CODEX_SANDBOX_UNAVAILABLE: '1' });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => record(id).state !== 'running'), 'the supervisor must finalize');

  const rec = record(id);
  assert.equal(rec.state, 'failed', 'an unprovable sandbox does not get to deliver');
  assert.equal(rec.reason, 'sight-unproven');
  assert.match(rec.sight, /^unproven: /);
  assert.match(rec.sight, /no "sandbox" subcommand/, 'naming which cure applies');
  assert.equal(rec.exitCode, null, 'codex exec never ran, so nothing was billed');
  assert.equal(fs.existsSync(path.join(JOBS, id, 'out.txt')), false, 'and there is no answer to be tempted by');

  const st = run(['status', id]);
  assert.match(st.stdout, /^state: failed$/m);
  assert.match(st.stdout, /^reason: sight-unproven$/m);

  const res = run(['result', id]);
  assert.notEqual(res.status, 0, 'result must refuse it');
  assert.equal(res.stdout, '', 'nothing may reach stdout');
  assert.match(res.stderr, /UNPROVEN/);
  assert.match(res.stderr, /--allow-unproven-sight/, 'and must name the explicit opt-in');
  assert.match(res.stderr, /npm install -g @openai\/codex/, 'and the cure that avoids needing it');
  assert.match(res.stderr, /^out: /m);
  assert.match(run(['list']).stdout, new RegExp(`^${id}  failed\\(sight-unproven\\)`, 'm'));

  // Terminal, so it must hand the role back.
  const again = run(['dispatch', '--brief', brief, '--role', 'nosub']);
  assert.equal(again.status, 0, `a refused job must release its role claim: ${again.stderr}`);
  await poll(() => done(jobIdFrom(again.stdout)));
});

test('--allow-unproven-sight runs it anyway, records the acceptance, and shouts on delivery', async () => {
  // The escape hatch has to exist — a machine with an old CLI is not a defect to
  // be invented — but it is an explicit, recorded decision by the caller, not a
  // default the runtime makes on their behalf. That is the whole difference
  // between this and what it replaced.
  const brief = writeBrief('briefaccepted.md', 'quick');
  const r = run(['dispatch', '--brief', brief, '--role', 'accepted', '--allow-unproven-sight'],
    { FAKE_CODEX_SANDBOX_UNAVAILABLE: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^sight: UNPROVEN ACCEPTED/m, 'the dispatch says so up front');
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => done(id)), 'the job runs to completion');

  const rec = record(id);
  assert.equal(rec.allowUnprovenSight, true, 'the opt-in is recorded on the job');
  assert.equal(rec.sight, 'unproven (accepted by caller)');
  assert.match(rec.warning, /accepted by caller \(--allow-unproven-sight\)/);

  const st = run(['status', id]);
  assert.match(st.stdout, /^sight: unproven \(accepted by caller\)$/m, 'status says it loudly');
  assert.match(st.stdout, /^warning: sight not proven/m);

  const res = run(['result', id]);
  assert.equal(res.status, 0, 'the caller opted in, so the bytes are delivered');
  assert.match(res.stderr, /UNPROVEN SIGHT/, 'with the caveat shouted on stderr');
  assert.match(res.stderr, /--allow-unproven-sight/, 'naming why it was delivered at all');
  assert.deepEqual(
    Buffer.from(res.stdout),
    fs.readFileSync(path.join(JOBS, id, 'out.txt')),
    'and stdout stays the verbatim answer, nothing prepended'
  );
});

test('a cwd with nothing readable is unproven too: job-nonce no longer counts as proof', async () => {
  // The job-nonce fallback proves that sandboxed execution works FROM a directory,
  // never that the directory can be read — which is the claim an answer about that
  // directory rests on. It was recorded honestly as the weaker form and then
  // delivered exactly like the strong one; now it is on the refuse-or-opt-in side
  // of the line with everything else that was never proven.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-emptycwd-'));
  try {
    const brief = writeBrief('briefnonce.md', 'quick');
    const r = run(['dispatch', '--brief', brief, '--role', 'nonce', '--cd', empty]);
    assert.equal(r.status, 0, r.stderr);
    const id = jobIdFrom(r.stdout);
    assert.ok(await poll(() => record(id).state !== 'running'), 'the supervisor must finalize');

    const rec = record(id);
    assert.equal(rec.state, 'failed');
    assert.equal(rec.reason, 'sight-unproven');
    assert.match(rec.sight, /job-nonce fallback/, 'and says which weak proof it refused to accept');
    assert.equal(fs.existsSync(path.join(JOBS, id, 'out.txt')), false);
    assert.notEqual(run(['result', id]).status, 0);

    const ok = run(['dispatch', '--brief', brief, '--role', 'nonce', '--cd', empty,
      '--allow-unproven-sight']);
    assert.equal(ok.status, 0, ok.stderr);
    const okId = jobIdFrom(ok.stdout);
    assert.ok(await poll(() => done(okId)), 'the opt-in runs it');
    assert.equal(record(okId).sight, 'unproven (accepted by caller)');
    assert.equal(run(['result', okId]).status, 0, 'and delivers it');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test('a corrupt job.json is contained: other verbs keep working and name it', async () => {
  const dir = path.join(JOBS, 'corrupt-1-99997');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), '{"id":"corrupt-1-99997","state":"run');

  const l = run(['list']);
  assert.equal(l.status, 0, l.stderr);
  assert.match(l.stdout, /^corrupt-1-99997  corrupt  out: /m, 'list must render it as corrupt');

  const stAll = run(['status']);
  assert.equal(stAll.status, 0, stAll.stderr);
  assert.match(stAll.stdout, /^state: corrupt$/m, 'status of all jobs must survive it');

  const st = run(['status', 'corrupt-1-99997']);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /^reason: corrupt job\.json/m);

  const res = run(['result', 'corrupt-1-99997']);
  assert.notEqual(res.status, 0, 'result on a corrupt job must exit nonzero');
  assert.match(res.stderr, /CORRUPT/);

  const brief = writeBrief('brief9.md', 'quick');
  const d = run(['dispatch', '--brief', brief, '--role', 'aftercorrupt']);
  assert.equal(d.status, 0, `dispatch must not be bricked by a corrupt job: ${d.stderr}`);
  await poll(() => done(jobIdFrom(d.stdout)));
});

test('cancel on a corrupt job reaps its pids, preserves job.json, and consumes the pid files', async () => {
  const dir = path.join(JOBS, 'corruptkill-1-99996');
  fs.mkdirSync(dir, { recursive: true });
  const raw = 'not json at all';
  fs.writeFileSync(path.join(dir, 'job.json'), raw);
  const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
    stdio: 'ignore', detached: true,
  });
  victim.unref();
  fs.writeFileSync(path.join(dir, 'codex.pid'), String(victim.pid));

  const c = run(['cancel', 'corruptkill-1-99996']);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /corrupt job\.json/);
  assert.match(c.stdout, new RegExp(`killed recorded pids: ${victim.pid}`));
  assert.match(c.stdout, /consumed pid files: codex\.pid\.reaped-/);
  assert.ok(await poll(() => !pidAlive(victim.pid)), 'the recorded pid must be killed');
  assert.equal(
    fs.readFileSync(path.join(dir, 'job.json'), 'utf8'), raw,
    'the corrupt record is evidence — cancel must not overwrite it'
  );
  assert.equal(fs.existsSync(path.join(dir, 'codex.pid')), false, 'the spent pid file is gone');
});

test('a second cancel on a corrupt job replays nothing and touches nothing', async () => {
  // Pid numbers are reused. A cancel that could be replayed is a cancel that can
  // kill an innocent process that inherited the number, so consumed pid files are
  // renamed out of the way and a second cancel has nothing to fire.
  const dir = path.join(JOBS, 'doublecancel-1-99993');
  fs.mkdirSync(dir, { recursive: true });
  const raw = '{"state":"running", TRUNCATED';
  fs.writeFileSync(path.join(dir, 'job.json'), raw);
  const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
    stdio: 'ignore', detached: true,
  });
  victim.unref();
  fs.writeFileSync(path.join(dir, 'codex.pid'), String(victim.pid));

  const first = run(['cancel', 'doublecancel-1-99993']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`killed recorded pids: ${victim.pid}`));
  assert.ok(await poll(() => !pidAlive(victim.pid)));

  const snapshot = () => fs.readdirSync(dir).sort().map((n) => {
    const p = path.join(dir, n);
    return `${n}:${fs.statSync(p).size}:${fs.readFileSync(p, 'utf8')}`;
  });
  const before = snapshot();
  assert.ok(before.some((e) => e.startsWith('codex.pid.reaped-')), 'the pid file was renamed, not deleted');

  const second = run(['cancel', 'doublecancel-1-99993']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already reaped: codex\.pid\.reaped-/);
  assert.equal(second.stdout.includes('killed recorded pids'), false, 'nothing may be killed twice');
  assert.deepEqual(snapshot(), before, 'and the job dir must be byte-for-byte as it was');
});

test('a wrong-typed field is contained like any other corruption', async () => {
  // `started: 12345` parses fine and is an object, so the old is-an-object check
  // passed it through — and then allJobs' sort called .localeCompare on a number,
  // taking down every verb that lists jobs, for every job.
  const dir = path.join(JOBS, 'badtype-1-99995');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    id: 'badtype-1-99995', role: 'badtype', state: 'running',
    started: 12345, supervisorPid: null, codexPid: null,
  }));

  const l = run(['list']);
  assert.equal(l.status, 0, `list must survive a wrong-typed record: ${l.stderr}`);
  assert.match(l.stdout, /^badtype-1-99995  corrupt  out: /m, 'list must render it as corrupt');

  const stAll = run(['status']);
  assert.equal(stAll.status, 0, `status of all jobs must survive it: ${stAll.stderr}`);

  const st = run(['status', 'badtype-1-99995']);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /^reason: corrupt job\.json \(field "started" is not a string \(number\)\)$/m,
    'and must name the offending field');

  // Corrupt means it cannot claim to be running, so it must not block its role.
  const brief = writeBrief('brief12.md', 'quick');
  const d = run(['dispatch', '--brief', brief, '--role', 'badtype']);
  assert.equal(d.status, 0, `a wrong-typed record must not block dispatch: ${d.stderr}`);
  await poll(() => done(jobIdFrom(d.stdout)));
});

test('the watcher prints a loud finished banner and exits', async () => {
  // `_watch` is the body of the detached console window; running it inline is how
  // it gets asserted without opening one.
  const brief = writeBrief('briefwatch.md', 'quick');
  const r = run(['dispatch', '--brief', brief, '--role', 'watched']);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => done(id)), 'job should finish');

  const w = run(['_watch', id]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /JOB FINISHED - result is ready/, 'the banner, not a silent tail');
  assert.match(w.stdout, new RegExp(`job:\\s+${id}`));
  assert.match(w.stdout, /state:\s+done/);
  assert.match(w.stdout, /out:\s+.+out\.txt/);
  assert.match(w.stdout, /collect: node .+ result /, 'and how to collect it');
});

test('the finished banner states the REAL terminal state, per state', async () => {
  // It used to shout "JOB FINISHED - result is ready" for every terminal state,
  // so a job that failed its precheck, was killed, or could not be killed all
  // ended on the same cheerful line — and `result` then refused the answer the
  // window had just promised. A window that shouts is only worth having if what
  // it shouts is true.
  // Only the states in which NOTHING can still be alive end the watch. The live
  // ones (kill-pending, kill-failed, stale, unknown) are the next test: the
  // watcher used to print JOB ENDED for those too, which is a declared end while
  // a process may be billing.
  const cases = [
    ['bannerfailed-1-99981', { state: 'failed', reason: 'sight-unproven', exitCode: null },
      /JOB ENDED - state: failed/, /result will REFUSE this job \(sight-unproven\)/],
    ['bannerkilled-1-99982', { state: 'killed' },
      /JOB ENDED - state: killed/, /result will REFUSE it/],
  ];
  for (const [id, patch, headline, next] of cases) {
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      id, role: id.split('-')[0], started: new Date(Date.now() - 3600000).toISOString(), ...patch,
    }));
    const w = run(['_watch', id]);
    assert.equal(w.status, 0, w.stderr);
    assert.match(w.stdout, headline, `${id}: the banner must name the real state`);
    assert.match(w.stdout, next, `${id}: and the next step must fit that state`);
    assert.equal(/JOB FINISHED/.test(w.stdout), false, `${id}: must not claim a result is ready`);
    assert.equal(w.stdout.includes('collect: node'), false, `${id}: nothing to collect`);
  }

  // …and `done` still gets the cheerful one, because for `done` it is true.
  const brief = writeBrief('briefbannerdone.md', 'quick');
  const r = run(['dispatch', '--brief', brief, '--role', 'bannerdone']);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => done(id)));
  const w = run(['_watch', id]);
  assert.match(w.stdout, /JOB FINISHED - result is ready/);
  assert.match(w.stdout, /collect: node .+ result /);
});

test('a transiently corrupt record does not end the watch; a persistent one does', async () => {
  // job.json is replaced by rename and a reader can land in the gap. Treating the
  // first unreadable read as the end killed the watcher on a perfectly healthy job.
  const id = 'bannerflap-1-99985';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  // Stamped and sighted: the banner promises a ready result only for a record
  // that vouches for its run, so a fixture that wants the cheerful headline has
  // to carry what a real 0.4.0 record carries.
  const good = JSON.stringify({
    recordVersion: RECORD_VERSION, id, role:'bannerflap', state: 'done', sight: 'cwd-file:LICENSE',
    started: new Date().toISOString(), exitCode: 0,
  });
  fs.writeFileSync(path.join(dir, 'job.json'), '{"state": TRUNCATED MID-REPLACE');
  // Repaired while the watcher is re-reading, the way an atomic rename repairs it.
  // From another process, because the watch below is spawned SYNCHRONOUSLY: a
  // timer in this one could not fire until after the thing it is meant to race.
  const repairer = spawn(process.execPath, ['-e',
    `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(path.join(dir, 'job.json'))}, ${JSON.stringify(good)}), 300)`,
  ], { stdio: 'ignore', detached: true });
  repairer.unref();
  const w = run(['_watch', id]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /JOB FINISHED - result is ready/,
    'the watcher must have re-read and seen the real record');
  assert.equal(/JOB ENDED - state: corrupt/.test(w.stdout), false);

  // A record that stays corrupt does end it — saying so, and refusing to promise.
  const stuck = 'bannerstuck-1-99986';
  fs.mkdirSync(path.join(JOBS, stuck), { recursive: true });
  fs.writeFileSync(path.join(JOBS, stuck, 'job.json'), '{"state": STILL TRUNCATED');
  const w2 = run(['_watch', stuck]);
  assert.equal(w2.status, 0, w2.stderr);
  assert.match(w2.stdout, /JOB ENDED - state: corrupt/);
  assert.match(w2.stdout, /stayed unreadable across re-reads/);
});

test('terminal control bytes in the log never reach the console', () => {
  // run.log is untrusted: it is whatever codex printed, including file contents
  // and tool output it echoed. An escape sequence in there can retitle the window,
  // clear the screen, or move the cursor back over the finished banner — the one
  // thing in this window that has to be true.
  const id = 'bannerctl-1-99987';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role:'bannerctl', state: 'done', sight: 'cwd-file:LICENSE',
    started: new Date().toISOString(), exitCode: 0,
  }));
  fs.writeFileSync(path.join(dir, 'run.log'),
    '\x1b]0;PWNED WINDOW TITLE\x07visible-one\n\x1b[2J\x1b[1;1Hvisible-two\n\x00\x08nul-and-bs\n');

  const w = run(['_watch', id]);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(w.stdout.includes('\x1b'), false, 'no ESC may reach the console');
  assert.equal(w.stdout.includes('\x00'), false, 'nor NUL');
  assert.equal(w.stdout.includes(']0;PWNED WINDOW TITLE'), true,
    'the sequence is defanged into text, not silently dropped whole');
  for (const kept of ['visible-one', 'visible-two', 'nul-and-bs']) {
    assert.ok(w.stdout.includes(kept), `the readable content survives: ${kept}`);
  }
  assert.match(w.stdout, /JOB FINISHED - result is ready/);
});

test('watch reports a launcher that cannot open a window instead of claiming it did', async () => {
  const brief = writeBrief('briefwatchfail.md', 'quick');
  const r = run(['dispatch', '--brief', brief, '--role', 'watchfail']);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => done(id)));

  const missing = run(['watch', id], { CODEX_DISPATCH_TEST_WATCH_BIN: 'codex-dispatch-no-such-launcher' });
  assert.notEqual(missing.status, 0, 'a spawn that failed must not report success');
  assert.match(missing.stderr, /FAILED to open a watcher console window/);
  assert.equal(missing.stdout.includes('watching:'), false, 'and must not claim a window is open');
  assert.match(missing.stderr, /status /, 'it names what to use instead');

  // A launcher that starts and immediately falls over is the other half: `node`
  // handed cmd's arguments exits nonzero without ever opening anything.
  const brokeEarly = run(['watch', id], { CODEX_DISPATCH_TEST_WATCH_BIN: process.execPath });
  assert.notEqual(brokeEarly.status, 0, 'an immediate nonzero exit is a failure too');
  assert.match(brokeEarly.stderr, /exited \d+ without opening a window/);
});

test('the watcher command line RUNS — every combination of spaced and unspaced paths',
  { skip: process.platform === 'win32' ? false : 'Windows-only: cmd.exe is what parses this line' },
  async () => {
    // THE TEST THAT WOULD HAVE CAUGHT IT. The first version of watchLaunchArgs
    // passed a perfect argv-shape assertion and produced a window that printed
    // "'C:\Program' is not recognized" whenever BOTH the node path and the plugin
    // path needed quoting — `cmd /k` keeps quotes only when the tail has exactly
    // two of them, and otherwise strips the first character and the last quote.
    // Every install under `C:\Program Files\nodejs` with a plugin under a path
    // with a space is that case, and `watch` still reported success.
    //
    // So this one EXECUTES the line the runtime builds, for all four
    // combinations, headless: `/k` becomes `/c` and `start` gets `/B /WAIT`, so
    // nothing opens a console and the assertion is that the script really ran
    // with the arguments it was supposed to get.
    const room = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-watchline-'));
    let junction = null;
    try {
      const probe = 'import fs from "node:fs";\n' +
        'fs.writeFileSync(process.argv[2], "RAN " + process.argv.slice(3).join("|"));\n';
      const spacedDir = path.join(room, 'plugin dir');
      const plainDir = path.join(room, 'plugindir');
      fs.mkdirSync(spacedDir); fs.mkdirSync(plainDir);
      fs.writeFileSync(path.join(spacedDir, 'runtime.mjs'), probe);
      fs.writeFileSync(path.join(plainDir, 'runtime.mjs'), probe);

      // Two node paths, one needing quoting and one not. The unspaced one is a
      // junction to the real node directory: a hard link into Program Files needs
      // write access there, and copying node.exe to make a test decidable is not
      // a trade worth making.
      const nodes = [];
      if (process.execPath !== cmdQuote(process.execPath)) nodes.push(['quoted', process.execPath]);
      try {
        const dir = path.join(room, 'nodedir');
        fs.symlinkSync(path.dirname(process.execPath), dir, 'junction');
        junction = dir;
        const linked = path.join(dir, path.basename(process.execPath));
        if (linked === cmdQuote(linked)) nodes.push(['bare', linked]);
      } catch { /* reported below */ }
      assert.ok(nodes.length, 'SKIPPED: neither a quoted nor an unquoted node path could be produced');
      if (nodes.length < 2) {
        process.stderr.write(
          'NOTE: only one of the two node-path shapes was available on this machine ' +
          `(${nodes.map(([k]) => k).join(', ')}); the other half of the matrix was not exercised.\n`
        );
      }

      let ran = 0;
      for (const [nodeKind, node] of nodes) {
        for (const [selfKind, self] of [['quoted', path.join(spacedDir, 'runtime.mjs')],
          ['bare', path.join(plainDir, 'runtime.mjs')]]) {
          const marker = path.join(room, `marker-${nodeKind}-${selfKind}.txt`);
          // The runtime's own line, with the two headless substitutions and the
          // marker path threaded in as the probe's first argument. Everything
          // else — the quoting, the /s, the outer pair — is what ships.
          const args = watchLaunchArgs('review-1-2', { node, self })
            .map((a) => (a === '/k' ? '/c' : a))
            .map((a) => a.replace('_watch review-1-2"', `${cmdQuote(marker)} _watch review-1-2"`));
          args.splice(3, 0, '/B', '/WAIT');

          const r = await new Promise((resolve) => {
            const c = spawn('cmd', args, { windowsVerbatimArguments: true, encoding: 'utf8' });
            let out = '';
            c.stdout.on('data', (d) => { out += d; });
            c.stderr.on('data', (d) => { out += d; });
            c.on('close', (code) => resolve({ code, out }));
          });

          const what = `node:${nodeKind} self:${selfKind}`;
          assert.ok(fs.existsSync(marker),
            `${what}: the watcher command never ran at all — cmd.exe said: ${r.out.trim()}`);
          assert.equal(fs.readFileSync(marker, 'utf8'), 'RAN _watch|review-1-2',
            `${what}: it ran with the wrong arguments`);
          assert.equal(/is not recognized/.test(r.out), false,
            `${what}: cmd.exe could not find what the line named: ${r.out.trim()}`);
          ran++;
        }
      }
      assert.ok(ran >= 2, 'the matrix must actually have been exercised');
    } finally {
      if (junction) { try { fs.unlinkSync(junction); } catch { /* best effort */ } }
      fs.rmSync(room, { recursive: true, force: true });
    }
  });

test('job ids outside the whitelist are refused before any path use', () => {
  const bad = ['../../etc/passwd', '..\\..\\windows\\system32', 'Review-1-2', 'foo-1', 'foo/1-2'];
  for (const id of bad) {
    for (const verb of ['status', 'result', 'cancel', 'watch']) {
      const r = run([verb, id]);
      assert.notEqual(r.status, 0, `${verb} ${id} must be refused`);
      assert.match(r.stderr, /invalid job id/, `${verb} ${id} must say why`);
    }
  }
});

test('roles that could not produce a whitelisted id are refused at dispatch', () => {
  const brief = writeBrief('brief10.md', 'quick');
  for (const role of ['../evil', 'Live-Smoke', 'u1', 'a b']) {
    const r = run(['dispatch', '--brief', brief, '--role', role]);
    assert.notEqual(r.status, 0, `--role ${role} must be refused`);
    assert.match(r.stderr, /invalid --role/);
  }
});

// ---------------------------------------------------------------------------
// preflight, which every other test in this file skips past.
// ---------------------------------------------------------------------------

test('preflight really runs its checks, and each failing one is named', () => {
  // CODEX_DISPATCH_BIN short-circuits preflight to a one-line "using override",
  // and the suite sets it for every run — so the version check, the auth check,
  // the sandbox probe and the three warnings hanging off it had never executed
  // here. CODEX_DISPATCH_TEST_PREFLIGHT_FULL forces the real checks against the
  // pinned stand-in; the stand-in answers `--version` and `login status` in
  // codex-cli's shapes, so what is exercised is the parse, not a stub.
  const FULL = { CODEX_DISPATCH_TEST_PREFLIGHT_FULL: '1' };

  // The pin on its own still short-circuits — the hook is the ONLY difference,
  // so nothing below can be an accident of the override changing meaning.
  const pinned = run(['preflight']);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.match(pinned.stdout, /^preflight: using CODEX_DISPATCH_BIN override/m);
  assert.equal(pinned.stdout.includes('preflight: ok'), false, 'and it checks nothing');

  // ok: a binary that runs, is authenticated, and whose sandbox provably reads.
  const ok = run(['preflight'], FULL);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /^preflight: ok$/m);
  assert.match(ok.stdout, new RegExp(`^bin: ${FAKE.replace(/[\\.]/g, '\\$&')}$`, 'm'),
    'the resolved binary is named — that IS the diagnosis when the wrong one is found');
  assert.match(ok.stdout, /^version: codex-cli 0\.146\.0$/m, 'the version line is what --version said');
  assert.match(ok.stdout, /^auth: Logged in using ChatGPT$/m, 'and the auth line what login status said');
  assert.match(ok.stdout, /^sandbox: functional \(file reads work inside --sandbox read-only\)$/m);

  // auth: unauthenticated is fatal, and the cure is the interactive login — which
  // this runtime must tell the operator to run, never run for them.
  const auth = run(['preflight'], { ...FULL, FAKE_CODEX_LOGIN_FAIL: '1' });
  assert.notEqual(auth.status, 0, 'an unauthenticated codex must fail preflight');
  assert.match(auth.stderr, /is not authenticated/);
  assert.match(auth.stderr, /Run: codex login/, 'naming the cure');
  assert.equal(auth.stdout.includes('preflight: ok'), false, 'and never claiming ok');

  // version: a binary that is there and will not run is refused before anything
  // downstream gets to blame the sandbox for it.
  const version = run(['preflight'], { ...FULL, FAKE_CODEX_VERSION_FAIL: '1' });
  assert.notEqual(version.status, 0);
  assert.match(version.stderr, /--version" failed/);
  assert.match(version.stderr, /npm install -g @openai\/codex/);
  assert.equal(version.stderr.includes('not authenticated'), false,
    'a binary that will not run says nothing about authentication');

  // sandbox: the probe runs and DISPROVES the read. Fatal on Windows, where the
  // probe is verified; loud but non-fatal elsewhere, and the assertions below hold
  // either way because the message is the part that has to be right.
  const broken = run(['preflight'], { ...FULL, FAKE_CODEX_SANDBOX_BROKEN: '1' });
  const brokenText = broken.stdout + broken.stderr;
  assert.match(brokenText, /codex sandbox is NOT functional/);
  assert.match(brokenText, /every job would run blind/);
  assert.match(brokenText, /jail_bootstrap_unavailable/, 'quoting the probe\'s own error verbatim');
  assert.match(brokenText, /npm install -g @openai\/codex/, 'and the fix');
  if (process.platform === 'win32') {
    assert.notEqual(broken.status, 0, 'on Windows a disproven sandbox is fatal, not a warning');
    assert.equal(broken.stdout.includes('preflight: ok'), false);
  }

  // A codex too old to have the subcommand is a WARNING, not a refusal: preflight
  // reports the install, and it is `dispatch` that refuses jobs it cannot vouch
  // for. Saying "ok" here would be the politeness the sight gate exists to refuse.
  const old = run(['preflight'], { ...FULL, FAKE_CODEX_SANDBOX_UNAVAILABLE: '1' });
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stderr, /no "sandbox" subcommand/);
  assert.match(old.stderr, /REFUSED as "sight-unproven"/, 'and says what will happen to dispatches');
  assert.match(old.stderr, /--allow-unproven-sight/, 'naming the explicit opt-in');
  assert.match(old.stdout, /^sandbox: unavailable$/m, 'the summary states it rather than eliding it');

  // A probe that could not be RUN is a transport failure and must not be reported
  // as a finding about the sandbox — the same distinction the dispatch gate makes.
  const probeErr = run(['preflight'], { ...FULL, CODEX_DISPATCH_TEST_PROBE_ERROR: '99' });
  assert.equal(probeErr.status, 0, probeErr.stderr);
  assert.match(probeErr.stderr, /the sandbox probe could not be RUN/);
  assert.match(probeErr.stderr, /not evidence\r?\nthat codex cannot see/);
  assert.equal(probeErr.stderr.includes('is NOT functional'), false,
    'a spawn that never ran may not be reported as a broken sandbox');
});

// ---------------------------------------------------------------------------
// The deliverability gate: what a record has to SAY before its bytes go out.
// ---------------------------------------------------------------------------

test('the deliverability matrix: only a stamped record with proof or a recorded opt-in delivers', () => {
  // The hole this pins: `result` used to gate on state === 'done' alone, so a
  // record written by 0.1/0.2 — no `sight` at all, or the old `unproven` label —
  // delivered silently on upgrade, and the `unproven` one collected a caveat
  // claiming the caller had opted in, which nobody had.
  const ANSWER = 'the answer bytes\n';
  const fixture = (id, record) => {
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      id, role: id.split('-')[0], state: 'done', exitCode: 0,
      started: new Date().toISOString(), finished: new Date().toISOString(), ...record,
    }));
    fs.writeFileSync(path.join(dir, 'out.txt'), ANSWER);
    return id;
  };

  const V = RECORD_VERSION;
  const cases = [
    // [id, record, delivers?, what the refusal must name]
    ['legacynosight-1-99971', {}, false, /no current schema stamp/],
    ['legacyunproven-1-99972', { sight: 'unproven' }, false, /no current schema stamp/],
    ['legacynonce-1-99973', { sight: 'job-nonce' }, false, /no current schema stamp/],
    ['stampednosight-1-99974', { recordVersion: V }, false, /sight is not recorded/],
    ['stampednonce-1-99975', { recordVersion: V, sight: 'job-nonce' }, false, /not proof/],
    ['stampedproven-1-99976', { recordVersion: V, sight: 'cwd-file:LICENSE' }, true, null],
    ['stampedoptin-1-99977',
      { recordVersion: V, sight: 'unproven (accepted by caller)', allowUnprovenSight: true }, true, null],
    // The forged one: the label without the boolean the dispatch would have written.
    ['forgedoptin-1-99978',
      { recordVersion: V, sight: 'unproven (accepted by caller)' }, false, /no recorded opt-in/],
    ['badexit-1-99979', { recordVersion: V, sight: 'cwd-file:LICENSE', exitCode: 3 }, false, /exitCode is 3/],
    // The release BEFORE this one. Its records were written under a gate that read
    // fields instead of validating them, so the stamp does not carry over.
    ['prevversion-1-99961', { recordVersion: V - 1, sight: 'cwd-file:LICENSE' }, false,
      /no current schema stamp/],
    // ROUND THREE. A `sight` that is the proof PREFIX and nothing else passed the
    // gate: `startsWith('cwd-file:')` was the whole test, so an empty file name
    // was a proof. It is corruption now, which is a refusal either way.
    ['emptysight-1-99962', { recordVersion: V, sight: 'cwd-file:' }, false, /CORRUPT|prefix/],
    ['spacesight-1-99963', { recordVersion: V, sight: 'cwd-file:   ' }, false, /CORRUPT|prefix/],
    // The shape the supervisor itself used to write for a DISPROVEN read:
    // `cwd-file:a.txt FAILED: ...` — it begins with the proof prefix.
    ['failedsight-1-99964',
      { recordVersion: V, sight: "cwd-file:a.txt FAILED: the file's bytes never came back" },
      false, /CORRUPT|prefix/],
    // A traversal wearing the proof prefix.
    ['escapesight-1-99965', { recordVersion: V, sight: 'cwd-file:../../etc/passwd' }, false,
      /CORRUPT|prefix/],
    // A state outside the known set is live-and-unvouched, never deliverable —
    // and never quietly "some other terminal state".
    ['unknownstate-1-99966', { recordVersion: V, sight: 'cwd-file:LICENSE', state: 'runnng' }, false,
      /NOT DELIVERED|not one this release knows/],
    ['futurestate-1-99967', { recordVersion: V, sight: 'cwd-file:LICENSE', state: 'cancelling' }, false,
      /NOT DELIVERED|not one this release knows/],
    // A pid outside the pid domain is corruption before it can become a signal.
    ['negpid-1-99968', { recordVersion: V, sight: 'cwd-file:LICENSE', supervisorPid: -1 }, false,
      /CORRUPT|not a pid/],
    ['zeropid-1-99969', { recordVersion: V, sight: 'cwd-file:LICENSE', codexPid: 0 }, false,
      /CORRUPT|not a pid/],
  ];

  for (const [id, record, delivers, names] of cases) {
    fixture(id, record);
    const res = run(['result', id]);
    if (delivers) {
      assert.equal(res.status, 0, `${id} must deliver: ${res.stderr}`);
      assert.equal(res.stdout, ANSWER, `${id} must deliver the bytes verbatim`);
      continue;
    }
    assert.notEqual(res.status, 0, `${id} must be refused`);
    assert.equal(res.stdout, '', `${id}: an unvouched-for answer must produce ZERO stdout`);
    assert.match(res.stderr, /UNVOUCHED|CORRUPT|NOT DELIVERED/,
      `${id}: the refusal names the class`);
    assert.match(res.stderr, names, `${id}: the refusal names the specific reason`);
    assert.match(res.stderr, /^out: .+out\.txt$/m, `${id}: and still points at the bytes`);
    assert.equal(/It is being delivered only because/.test(res.stderr), false,
      `${id}: a refusal must never claim a caller consented`);
  }

  // The opt-in that IS recorded still shouts, and only that one.
  const optedIn = run(['result', 'stampedoptin-1-99977']);
  assert.match(optedIn.stderr, /UNPROVEN SIGHT/);
  assert.match(optedIn.stderr, /recorded --allow-unproven-sight/);
  assert.equal(run(['result', 'stampedproven-1-99976']).stderr.includes('UNPROVEN SIGHT'), false,
    'a proven job says nothing about unproven sight');

  // status and list say `unvouched` rather than a bare, misleading `done`.
  const st = run(['status', 'legacynosight-1-99971']);
  assert.match(st.stdout, /^state: done$/m, 'the state is still reported honestly');
  assert.match(st.stdout, /^deliverable: NO - unvouched: /m, 'and so is what it buys');
  assert.match(run(['status', 'stampedproven-1-99976']).stdout, /^deliverable: yes \(sight proven/m);
  const list = run(['list']).stdout;
  assert.match(list, /^legacynosight-1-99971  done\(unvouched\)  out: /m);
  assert.match(list, /^stampedproven-1-99976  done  out: /m);
});

test('--allow-unproven-sight does NOT rescue a sandbox that was DISPROVEN', async () => {
  // Ordering is the property: the opt-in is for sight that could not be proven
  // EITHER WAY, never for a sandbox that was shown to be broken. Hoisting the
  // allowUnprovenSight check above the `broken` branch would deliver a
  // demonstrably blind answer, so the check order is pinned here.
  const brief = writeBrief('briefbrokenoptin.md', 'quick');
  for (const [role, env] of [
    ['brokenoptin', { FAKE_CODEX_SANDBOX_BROKEN: '1' }],
    ['echooptin', { FAKE_CODEX_SANDBOX_ARGV_ECHO: '1' }],
  ]) {
    const r = run(['dispatch', '--brief', brief, '--role', role, '--allow-unproven-sight'], env);
    assert.equal(r.status, 0, r.stderr);
    const id = jobIdFrom(r.stdout);
    assert.ok(await poll(() => record(id).state !== 'running'), `${role}: the supervisor must finalize`);

    const rec = record(id);
    assert.equal(rec.state, 'failed', `${role}: a disproven sandbox is refused even with the opt-in`);
    assert.equal(rec.reason, 'sandbox-blind-precheck', `${role}: and refused as blind, not as unproven`);
    assert.equal(rec.allowUnprovenSight, true, `${role}: the opt-in really was passed`);
    assert.equal(rec.exitCode, null, `${role}: codex never ran`);
    assert.equal(fs.existsSync(path.join(JOBS, id, 'out.txt')), false, `${role}: nothing to be tempted by`);

    const res = run(['result', id]);
    assert.notEqual(res.status, 0, `${role}: result must refuse`);
    assert.equal(res.stdout, '', `${role}: zero stdout`);
    assert.match(res.stderr, /BLIND/);
  }
});

test('a stand-in that echoes its argv and reads nothing fails the sight proof', async () => {
  // Reproduced in review: the token was the probe file's FIRST line, matched
  // against stdout and stderr merged, so a codex that opened nothing and merely
  // echoed the command it was handed could earn `sight: cwd-file:...`.
  //
  // This cwd is built to be that trap: the only file's first line is its own
  // NAME, and the name is on the command line. Under the old rule the token was
  // "a.txt", the echo returned it, and the proof passed on a stand-in that never
  // opened anything. The token now comes from below the first line and must be
  // unrelated to the name, and the match is stdout-only.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-echocwd-'));
  try {
    fs.writeFileSync(path.join(cwd, 'a.txt'), 'a.txt\nonly a reader can see this line\n');
    const brief = writeBrief('briefargvecho.md', 'quick');
    const r = run(['dispatch', '--brief', brief, '--role', 'argvecho', '--cd', cwd],
      { FAKE_CODEX_SANDBOX_ARGV_ECHO: '1' });
    assert.equal(r.status, 0, r.stderr);
    const id = jobIdFrom(r.stdout);
    assert.ok(await poll(() => record(id).state !== 'running'), 'the supervisor must finalize');

    const rec = record(id);
    assert.equal(rec.state, 'failed', 'an echo is not a read');
    assert.equal(rec.reason, 'sandbox-blind-precheck');
    // The label leads with FAILED now, and that is load-bearing rather than
    // cosmetic: it used to be `cwd-file:a.txt FAILED: ...`, which BEGINS with the
    // one prefix the delivery gate treats as proof — a disproven read wrote a
    // string shaped like evidence of a proven one.
    assert.match(rec.sight, /^FAILED cwd-file:a\.txt: /,
      'the probe really did target the file in the job cwd, and the verdict leads');
    assert.equal(rec.sight.startsWith('cwd-file:'), false,
      'a DISPROVEN read must never write a label that starts with the proof prefix');
    assert.match(rec.sight, /the file's bytes never came back/,
      'and the refusal names what was missing: the content');
    // The evidence that this is the old hole and not a different one: the thing
    // the old rule accepted as proof IS in the output, and it still fails.
    assert.match(rec.sight, /sandbox invoked with: .*a\.txt/,
      'the echo did return the old first-line token, and it bought nothing');
    assert.equal(rec.exitCode, null, 'nothing was billed');
    assert.equal(fs.existsSync(path.join(JOBS, id, 'out.txt')), false);
    assert.notEqual(run(['result', id]).status, 0, 'and no answer is delivered');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('control bytes from codex reach neither the record nor a banner', async () => {
  // Codex's own error text lands in job.json's `sight:`/`warning:` and is printed
  // by status, list, result and the watcher's banner. An OSC/CSI sequence in
  // there could retitle the window, clear the screen, and redraw the banner —
  // the one line in this runtime that has to be true. Stripped at the write
  // boundary AND at every print boundary.
  const brief = writeBrief('briefansi.md', 'quick');
  const r = run(['dispatch', '--brief', brief, '--role', 'ansi'], { FAKE_CODEX_SANDBOX_ANSI: '1' });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => record(id).state !== 'running'), 'the supervisor must finalize');

  const ESC = String.fromCharCode(27);
  const raw = fs.readFileSync(path.join(JOBS, id, 'job.json'), 'utf8');
  assert.equal(raw.includes(ESC), false, 'no ESC may be PERSISTED into the record');
  for (const code of [0, 7, 8, 27, 0x9b]) {
    assert.equal(raw.includes(String.fromCharCode(code)), false, `control byte ${code} must not be persisted`);
  }
  const rec = record(id);
  assert.match(rec.sight, /forged-banner-attempt/, 'the text survives, defanged rather than dropped');
  assert.match(rec.sight, /PWNED-BY-SIGHT-DETAIL/, 'including what the sequence was trying to say');

  for (const [what, out] of [
    ['status', run(['status', id]).stdout],
    ['list', run(['list']).stdout],
    ['result', run(['result', id]).stderr],
  ]) {
    assert.equal(out.includes(ESC), false, `${what} must not print an ESC`);
  }

  const w = run(['_watch', id]);
  assert.equal(w.status, 0, w.stderr);
  assert.equal(w.stdout.includes(ESC), false, 'the watcher must not print an ESC');
  assert.match(w.stdout, /^ {2}JOB ENDED - state: failed$/m, 'the banner states the real state');
  assert.equal(/^ {2}JOB FINISHED - result is ready$/m.test(w.stdout), false,
    'and a forged banner inside a record field must never become the banner');
});

// ---------------------------------------------------------------------------
// Untrusted strings that used to become paths.
// ---------------------------------------------------------------------------

test('a role claim whose owner is not a job id is refused, and nothing outside the jobs root is touched', async () => {
  // Reproduced in review: an `owner` file containing `../not-a-job-dir` was
  // path-joined to the jobs root, so a dispatch read pid files there, killed an
  // unrelated process, wrote reaped.pids and renamed files outside the root —
  // and exited 0 saying "reaped unvouched-for job".
  const canary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-canary-'));
  const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
    stdio: 'ignore', detached: true,
  });
  victim.unref();
  try {
    fs.writeFileSync(path.join(canary, 'codex.pid'), String(victim.pid));
    fs.writeFileSync(path.join(canary, 'precious.txt'), 'do not touch\n');

    const lockDir = path.join(JOBS, '.role-locks', 'escape');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner'), path.relative(JOBS, canary) + '\n');
    // Older than the mid-claim grace, so the old code would have treated it as
    // reclaimable and reaped it rather than waiting.
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lockDir, old, old);

    const brief = writeBrief('briefescape.md', 'quick');
    const refused = run(['dispatch', '--brief', brief, '--role', 'escape']);
    assert.notEqual(refused.status, 0, 'a claim owner that is not a job id must refuse the dispatch');
    assert.match(refused.stderr, /REFUSING to launch/);
    assert.match(refused.stderr, /does not name a job this runtime could\r?\nhave created/);
    assert.equal(refused.stdout.includes('job: '), false, 'and hand out no job');
    assert.equal(refused.stdout.includes('reaped unvouched-for job'), false,
      'and above all must not claim to have reaped anything');

    assert.ok(pidAlive(victim.pid), 'the process outside the jobs root must be untouched');
    assert.deepEqual(fs.readdirSync(canary).sort(), ['codex.pid', 'precious.txt'],
      'nothing outside the jobs root may be created, renamed or removed');
    assert.equal(fs.readFileSync(path.join(canary, 'codex.pid'), 'utf8'), String(victim.pid));
  } finally {
    try { process.kill(victim.pid); } catch { /* already gone */ }
    fs.rmSync(canary, { recursive: true, force: true });
    fs.rmSync(path.join(JOBS, '.role-locks', 'escape'), { recursive: true, force: true });
  }
});

test('a corrupt record whose role escapes the jobs root cannot rename or delete anything', () => {
  // The other door onto the same class: validateRecord type-checked `role` as a
  // string but never applied ROLE_RE, so `role: "../../victim"` flowed through
  // killJob into releaseRole, which joins it, RENAMES that directory into the
  // jobs root and then removes it recursively.
  const canary = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-rolecanary-'));
  // A live pid, so the record reads as a running job that cancel will act on —
  // and a process nothing in this test is entitled to kill.
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
    stdio: 'ignore', detached: true,
  });
  bystander.unref();
  try {
    fs.writeFileSync(path.join(canary, 'precious.txt'), 'do not touch\n');
    const escapingRole = path.join('..', '..', path.basename(canary));

    const id = 'roleescape-1-99961';
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    const raw = JSON.stringify({
      recordVersion: RECORD_VERSION, id, role:escapingRole, state: 'running',
      started: new Date().toISOString(), supervisorPid: bystander.pid, codexPid: null,
    });
    fs.writeFileSync(path.join(dir, 'job.json'), raw);

    // A role that is not a role makes the record corrupt — the classification
    // every verb already knows how to contain — so no verb ever joins it.
    const st = run(['status', id]);
    assert.equal(st.status, 0, st.stderr);
    assert.match(st.stdout, /^state: corrupt$/m);
    assert.match(st.stdout, /field "role" is not a role/, 'and the corruption is named precisely');

    const c = run(['cancel', id]);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /corrupt job\.json/, 'cancel takes the corrupt path, not the kill path');

    assert.ok(fs.existsSync(canary), 'the directory the role pointed at must still exist');
    assert.deepEqual(fs.readdirSync(canary), ['precious.txt'], 'with its contents intact');
    assert.equal(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'), raw, 'and the evidence untouched');
    assert.ok(pidAlive(bystander.pid), 'and a corrupt record\'s pids are not kill targets');
    // Nothing may have been moved INTO the jobs root either — that is how the
    // recursive removal used to get its target.
    assert.equal(
      fs.readdirSync(path.join(JOBS, '.role-locks')).some((n) => n.includes(path.basename(canary))),
      false,
      'no tombstone naming the victim may exist'
    );
  } finally {
    try { process.kill(bystander.pid); } catch { /* already gone */ }
    fs.rmSync(canary, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The supervisor registration window.
// ---------------------------------------------------------------------------

test('a dispatch registers its kill target before it returns', async () => {
  // The window: dispatch spawned the supervisor and the supervisor recorded its
  // own pid a moment later, so a cancel in between killed nothing, "verified" it,
  // marked the job killed and released the role — while the supervisor went on to
  // launch codex. The pid is knowable in the parent, so it is written there.
  const brief = writeBrief('briefregister.md', 'slow');
  const r = run(['dispatch', '--brief', brief, '--role', 'register'], { FAKE_CODEX_SLEEP_MS: '60000' });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);

  // Read the instant dispatch returns — no polling, because the guarantee is
  // that there is no instant at which this is unset.
  const rec = record(id);
  assert.equal(typeof rec.supervisorPid, 'number', 'the kill target is recorded before dispatch returns');
  assert.equal(rec.launch, 'spawned', 'and the phase says a supervisor exists');
  assert.ok(fs.existsSync(path.join(JOBS, id, 'supervisor.pid')), 'the pid file mirrors it immediately');
  assert.ok(pidAlive(rec.supervisorPid), 'and it names a real process');

  // This cancel races the supervisor's own codex-exec window: the supervisor
  // spawns codex and writes its pids a moment later, and a cancel that decides on
  // the record as it is NOW (rather than on the snapshot it was handed) sees that
  // phase and answers `kill-pending` — which is the honest answer there, and one
  // the supervisor lands itself. So the assertion is the END state, not which of
  // the two paths reached it; the subject of this test is the line above.
  const c = run(['cancel', id]);
  if (c.status !== 0) assert.match(c.stderr, /KILL PENDING/, c.stderr);
  assert.ok(await poll(() => record(id).state === 'killed'),
    `the job must end up killed either way: ${record(id).state}`);
});

test('a cancel inside the registration window kills nothing and refuses to call it a death', async () => {
  const started = new Date().toISOString();
  const mk = (id, patch) => {
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      recordVersion: RECORD_VERSION, id, role:id.split('-')[0], state: 'running',
      started, supervisorPid: null, codexPid: null, ...patch,
    }));
    return id;
  };

  // A supervisor was spawned and has not registered: there is nothing to kill and
  // that is exactly why this may not be recorded as killed.
  const spawning = mk('regwindow-1-99951', { launch: 'spawning' });
  const c = run(['cancel', spawning]);
  assert.notEqual(c.status, 0, 'a cancel that killed nothing must not exit 0');
  assert.match(c.stderr, /KILL PENDING/);
  assert.match(c.stderr, /Killing nothing is not killing it/);
  assert.equal(record(spawning).state, 'kill-pending', 'the state says pending, NOT killed');

  const st = run(['status', spawning]);
  assert.match(st.stdout, /^state: kill-pending$/m);

  // The role stays blocked while that is unresolved.
  const brief = writeBrief('briefregwindow.md', 'quick');
  const blocked = run(['dispatch', '--brief', brief, '--role', 'regwindow']);
  assert.notEqual(blocked.status, 0, 'a kill-pending job keeps blocking its role');
  assert.match(blocked.stderr, /already kill-pending/);
  const forced = run(['dispatch', '--brief', brief, '--role', 'regwindow', '--force']);
  assert.notEqual(forced.status, 0, '--force must not launch beside a job it could not kill');
  assert.match(forced.stderr, /could not be shown to have died/);

  // Past the window with still nothing registered, the supervisor provably never
  // arrived, so a retry resolves it rather than blocking forever.
  const stale = mk('regstale-1-99952', {
    launch: 'spawning', started: new Date(Date.now() - 3600000).toISOString(),
  });
  const c2 = run(['cancel', stale]);
  assert.equal(c2.status, 0, c2.stderr);
  assert.equal(record(stale).state, 'killed', 'outside the window, nothing-to-kill IS the whole kill');

  // And a dispatch that has not spawned anything at all is not in the window: its
  // claim fence stops it launching, so the role can be taken from it safely.
  const pending = mk('regpending-1-99953', { launch: 'pending' });
  const c3 = run(['cancel', pending]);
  assert.equal(c3.status, 0, c3.stderr);
  assert.equal(record(pending).state, 'killed', 'a job that never spawned is killed by killing nothing');
});

test('a cancel reaches codex descendants through the process group', { skip: process.platform === 'win32' ? 'POSIX-only: Windows uses taskkill /T' : false }, async () => {
  // Off Windows there was no tree kill at all — killTree signalled the two
  // recorded pids and nothing else, so codex's own children survived. The
  // supervisor and codex are now process-group leaders and the group is killed.
  // The fake's child.pid file is deleted first regardless: it is a test artifact
  // and no longer a kill target, and removing it keeps that true here even if the
  // runtime's PID_FILES ever grows it back — a recorded grandchild would hide
  // whether the group kill reached anything at all.
  const brief = writeBrief('briefgroup.md', 'slow');
  const r = run(['dispatch', '--brief', brief, '--role', 'group'], { FAKE_CODEX_SLEEP_MS: '60000' });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  const childPidFile = path.join(JOBS, id, 'child.pid');
  assert.ok(await poll(() => record(id).codexPid && fs.existsSync(childPidFile)), 'fake codex should start');
  const grandchild = Number(fs.readFileSync(childPidFile, 'utf8'));
  fs.rmSync(childPidFile); // the grandchild is now reachable only through the group

  const c = run(['cancel', id]);
  assert.equal(c.status, 0, c.stderr);
  assert.ok(await poll(() => !pidAlive(grandchild)), 'the descendant must die with the group');
});

// ---------------------------------------------------------------------------
// Round three: the validator, the real kill target, and the second window.
// ---------------------------------------------------------------------------

test('an unknown state is live and unvouched: it blocks its role and never delivers', async () => {
  // It used to pass through effectiveState verbatim, so it was neither `running`
  // nor in LIVE_STATES: a typo'd `"runnng"` or a future `"cancelling"` lost its
  // role claim while codex ran, and a done-shaped record with an unknown state
  // could be reasoned about as though it were terminal.
  const id = 'weird-1-99941';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'weird', state: 'cancelling',
    started: new Date(Date.now() - 3600000).toISOString(), supervisorPid: null, codexPid: null,
    launch: 'spawned', sight: 'cwd-file:LICENSE', exitCode: 0,
  }));
  fs.writeFileSync(path.join(dir, 'out.txt'), 'an answer under a state nobody knows\n');

  const st = run(['status', id]);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /^state: unknown$/m, 'an unrecognised state reads as unknown, not as itself');
  assert.match(st.stdout, /not one this release knows/, 'and says so, naming the raw value');
  assert.match(st.stdout, /"cancelling"/);

  assert.match(run(['list']).stdout, new RegExp(`^${id}  unknown\\(cancelling\\)  out: `, 'm'));

  const res = run(['result', id]);
  assert.notEqual(res.status, 0, 'an unknown state must never deliver');
  assert.equal(res.stdout, '', 'and must produce zero stdout');

  // The half that costs money: it must still BLOCK its role.
  const brief = writeBrief('briefweird.md', 'quick');
  const blocked = run(['dispatch', '--brief', brief, '--role', 'weird']);
  assert.notEqual(blocked.status, 0, 'an unknown state may still own processes, so it blocks');
  assert.match(blocked.stderr, /already unknown/);

  // And it is cancellable, which is how it gets resolved.
  const c = run(['cancel', id]);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(record(id).state, 'killed');
});

test('a pid outside the pid domain is refused before anything is signalled', () => {
  // `supervisorPid: -1` reached killPlan(-1), which off Windows expands to
  // `kill(-1)` — every process this account may signal — after `kill(1)`.
  const id = 'badpid-1-99942';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  const raw = JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'badpid', state: 'running',
    started: new Date().toISOString(), supervisorPid: -1, codexPid: null,
  });
  fs.writeFileSync(path.join(dir, 'job.json'), raw);

  const st = run(['status', id]);
  assert.equal(st.status, 0, st.stderr);
  assert.match(st.stdout, /^state: corrupt$/m, 'a negative pid makes the record corrupt');
  assert.match(st.stdout, /field "supervisorPid" is not a pid/, 'and names the field');

  const c = run(['cancel', id]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /corrupt job\.json/, 'cancel takes the corrupt path, never the signal path');
  assert.equal(c.stderr.includes('-1'), false, 'and -1 is never a target');
  assert.equal(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'), raw, 'evidence untouched');

  // Zero is the other end of the same hole: falsy, so the old guards skipped it
  // rather than refusing it.
  const zero = 'zeropidrec-1-99943';
  fs.mkdirSync(path.join(JOBS, zero), { recursive: true });
  fs.writeFileSync(path.join(JOBS, zero, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id: zero, role: 'zeropidrec', state: 'running',
    started: new Date().toISOString(), codexPid: 0,
  }));
  assert.match(run(['status', zero]).stdout, /field "codexPid" is not a pid/);
});

test('a sight that is only the proof PREFIX is refused, not delivered', () => {
  // `sight: "cwd-file:"` passed the delivery gate: the check was startsWith, so
  // the prefix WAS the proof. So was `cwd-file:<name> FAILED: ...`, which is what
  // the supervisor itself wrote for a read it had just DISPROVEN.
  const cases = [
    ['prefixonly-1-99944', 'cwd-file:'],
    ['prefixslash-1-99945', 'cwd-file:../escape'],
    ['prefixdisproven-1-99946', "cwd-file:a.txt FAILED: the file's bytes never came back"],
  ];
  for (const [id, sight] of cases) {
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      recordVersion: RECORD_VERSION, id, role: id.split('-')[0], state: 'done', exitCode: 0,
      started: new Date().toISOString(), finished: new Date().toISOString(), sight,
    }));
    fs.writeFileSync(path.join(dir, 'out.txt'), 'bytes nothing vouched for\n');

    const res = run(['result', id]);
    assert.notEqual(res.status, 0, `${id}: a prefix is not a proof`);
    assert.equal(res.stdout, '', `${id}: zero stdout`);
    assert.match(run(['status', id]).stdout, /claims the proof prefix/,
      `${id}: and the record is named as corrupt for claiming it`);
  }
});

test('the supervisor asserts the record version it picked up', async () => {
  // Dispatch and _supervise are separate processes and can be different installed
  // copies of this runtime. A supervisor running an older gate against a record
  // stamped by a newer dispatch applies the weaker proof, and `result` then reads
  // the stamp the DISPATCH wrote and delivers as vouched.
  const id = 'oldstamp-1-99947';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), 'quick');
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION - 1, id, role: 'oldstamp', state: 'running',
    model: 'm', effort: 'low', sandbox: 'read-only', cwd: REPO, bin: FAKE,
    started: new Date().toISOString(), launch: 'spawned', supervisorPid: null, codexPid: null,
  }));

  const s = run(['_supervise', dir]);
  assert.notEqual(s.status, 0, 'a mismatched stamp must stop the supervisor');
  assert.match(s.stderr, /RECORD VERSION MISMATCH/);
  assert.equal(record(id).state, 'failed');
  assert.equal(record(id).reason, 'record-version-mismatch');
  assert.equal(fs.existsSync(path.join(dir, 'out.txt')), false, 'and nothing was billed');
});

test('a pre-launch refusal is a compare-and-swap, so a verdict it finds survives it', async () => {
  // THE SUPERVISOR'S SEVEN PRE-LAUNCH REFUSALS, all of which wrote unconditionally
  // — with a sight probe's seconds of shell sitting between the record they read
  // and the write. A cancel that reached a verdict inside that gap had it
  // overwritten by a `failed` about a launch that never happened, and its role
  // handed away underneath it: `killed(sight-unproven)` from one direction, a
  // released claim from the other.
  //
  // The version-mismatch refusal is the cheapest of the seven to pose — no probe,
  // no launch, one record read — and the swap it now carries is the same
  // `stillCancellable` every other writer in this seam uses. The verdict is
  // already on the record when the supervisor starts, which is the same
  // interleaving the gap produces and needs no injected hold at all.
  const id = 'refusecas-1-99948';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), 'quick');
  const verdict = {
    recordVersion: RECORD_VERSION - 1, id, role: 'refusecas',
    state: 'killed', reason: 'cancelled-during-registration',
    model: 'm', effort: 'low', sandbox: 'read-only', cwd: REPO, bin: FAKE,
    started: new Date().toISOString(), finished: new Date().toISOString(),
    launch: 'spawned', supervisorPid: null, codexPid: null,
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(verdict));
  const lock = path.join(JOBS, '.role-locks', 'refusecas');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), id);
  try {
    const s = run(['_supervise', dir]);
    assert.notEqual(s.status, 0, 'a mismatched stamp still stops the supervisor');
    assert.match(s.stderr, /RECORD VERSION MISMATCH/);

    const rec = record(id);
    assert.equal(rec.state, 'killed', `the cancel's verdict stands: ${JSON.stringify(rec)}`);
    assert.equal(rec.reason, 'cancelled-during-registration',
      'with the reason its writer paired with it — not this refusal\'s own');
    assert.match(s.stderr, /already reached "killed"/, 'and the refusal reports what it found');
    // The half that costs money when it is wrong: whoever wrote the verdict owns
    // the release decision, so a refusal that lost the swap releases nothing.
    assert.match(s.stderr, /no role claim was\nreleased/, 'saying only what it did itself');
    assert.equal(fs.existsSync(path.join(lock, 'owner')), true,
      'the claim is NOT released by a writer that lost its precondition');
    assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8').trim(), id, 'and still names this job');
    assert.equal(fs.existsSync(path.join(dir, 'out.txt')), false, 'and nothing was billed');
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('a pre-launch refusal may not write over a state a CANCEL authored, or free its claim',
  () => {
    // `stillCancellable` alone was not the line. `kill-pending` and `kill-failed`
    // are LIVE states — they have to be, so a second cancel can retry them — so a
    // refusal satisfied that precondition and wrote `failed(record-version-mismatch)`
    // straight over a cancel's verdict, then released the role. For `kill-failed`
    // that is the exact pair this repo documents as impossible: `cancel` has
    // already told the operator that pids survived and that the role stays blocked,
    // and the next dispatch then launches beside whatever survived. For
    // `kill-pending` it is the launch-block itself being erased under the live
    // cancel that armed it.
    //
    // So a refusal that finds a cancel-authored state stands down: nothing
    // overwritten, nothing released, and it says which state it found. The one
    // exception is the kill-pending HONOUR path, which is not overwriting that
    // cancel but carrying it out — pinned by the sibling test below.
    const subjects = [
      {
        id: 'refusekf-1-99955', role: 'refusekf',
        patch: { state: 'kill-failed', killSurvivors: '4242, 4243' },
        found: 'kill-failed',
      },
      {
        id: 'refusekp-1-99956', role: 'refusekp',
        patch: { state: 'kill-pending' },
        found: 'kill-pending',
      },
    ];
    for (const subject of subjects) {
      const { id, role } = subject;
      const dir = path.join(JOBS, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'prompt.md'), 'quick');
      fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
        // The stamp is what makes this the cheapest of the six non-honour
        // refusals to pose: no probe, no launch, one record read.
        recordVersion: RECORD_VERSION - 1, id, role,
        model: 'm', effort: 'low', sandbox: 'read-only', cwd: REPO, bin: FAKE,
        started: new Date().toISOString(),
        launch: 'spawned', supervisorPid: null, codexPid: null,
        ...subject.patch,
      }));
      // The claim `kill-failed` exists to keep blocked — and the thing a released
      // one costs is a second codex running beside whatever survived.
      const lock = path.join(JOBS, '.role-locks', role);
      fs.mkdirSync(lock, { recursive: true });
      fs.writeFileSync(path.join(lock, 'owner'), id);
      try {
        const s = run(['_supervise', dir]);
        assert.notEqual(s.status, 0, 'a mismatched stamp still stops the supervisor');
        assert.match(s.stderr, /RECORD VERSION MISMATCH/);

        const rec = record(id);
        assert.equal(rec.state, subject.patch.state,
          `the cancel's state stands: ${JSON.stringify(rec)}`);
        assert.equal(rec.reason, undefined,
          'and no refusal reason is pinned to a state that never carried one');
        assert.equal(rec.killSurvivors, subject.patch.killSurvivors,
          'the survivor list is the cancel\'s too — it is what tells an operator what to kill');
        assert.match(s.stderr, new RegExp(`already reached "${subject.found}"`),
          'the refusal names the state it found');
        assert.match(s.stderr, /has NOT been overwritten and no role claim was\nreleased/,
          'and says both halves of what it did not do');
        assert.equal(fs.existsSync(path.join(lock, 'owner')), true,
          'the claim a cancel-authored state holds is NOT handed away by a refusal');
        assert.equal(fs.readFileSync(path.join(lock, 'owner'), 'utf8').trim(), id,
          'and still names this job');
        assert.equal(fs.existsSync(path.join(dir, 'out.txt')), false, 'and nothing was billed');
      } finally {
        fs.rmSync(lock, { recursive: true, force: true });
      }
    }
  });

test('the supervisor still HONOURS a kill-pending it finds, which is the one refusal that may',
  () => {
    // THE EXCEPTION, AND WHY IT IS ONE. The refusal above stands down on a
    // cancel-authored state; this one writes over the same state and must go on
    // doing so, because it is not overwriting that cancel — it is completing it.
    // The cancel could not reach this supervisor when it landed (nothing was
    // registered to kill), and this is the process that can finish the job it
    // started. It keeps the seam's own precondition, `stillCancellable`, so it
    // still refuses to write over a verdict somebody else landed in between.
    //
    // Without it, `kill-pending` would be a state nothing ever resolves from the
    // supervisor's side: the job would sit live, holding its role, until a second
    // cancel arrived.
    const id = 'honorkp-1-99957';
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'quick');
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      // The CURRENT stamp: the version refusal must not fire, so the supervisor
      // reaches its pre-launch check and finds the cancel there.
      recordVersion: RECORD_VERSION, id, role: 'honorkp', state: 'kill-pending',
      model: 'm', effort: 'low', sandbox: 'read-only', cwd: REPO, bin: FAKE,
      started: new Date().toISOString(),
      launch: 'spawned', supervisorPid: null, codexPid: null,
    }));
    const lock = path.join(JOBS, '.role-locks', 'honorkp');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner'), id);
    try {
      const s = run(['_supervise', dir]);
      assert.notEqual(s.status, 0, 'a cancelled job is not a successful supervision');
      const rec = record(id);
      assert.equal(rec.state, 'killed', `the pending cancel is landed, not stood down from: ${JSON.stringify(rec)}`);
      assert.equal(rec.reason, 'cancelled-during-registration', 'naming which window it landed in');
      assert.equal(rec.killSurvivors, undefined, 'nothing was killed, so nothing survived it');
      assert.match(s.stderr, /this job was cancelled before codex was launched/);
      assert.equal(/has NOT been overwritten/.test(s.stderr), false,
        'this refusal is the exception: it may write here, and it did');
      assert.equal(fs.existsSync(path.join(lock, 'owner')), false,
        'and the role it just finished with is handed back');
      assert.equal(fs.existsSync(path.join(dir, 'out.txt')), false, 'nothing was billed');
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  });

test('a pre-launch refusal that DOES land carries no earlier cancel\'s survivor list', async () => {
  // The other side of the same write, and the reason the state, the reason and the
  // survivor list travel as ONE. A state this release cannot name reads as
  // `unknown` — LIVE, and nobody's cancel verdict — so the swap above is satisfied
  // and this refusal legitimately lands, over a record carrying a `killSurvivors`
  // whoever wrote it left behind. A `failed(record-version-mismatch)` that kept it
  // would report survivors of a kill its own state never mentions. The state name
  // is a foreign release's, which is exactly the record this refusal exists for.
  //
  // NOT `kill-failed`, which was the first shape of this fixture: that is a
  // cancel-authored verdict, and this refusal is now forbidden to overwrite one
  // (see the compare-and-swap above) — the clearing rule is what is under test
  // here, not the right to land on somebody's cancel.
  const id = 'refuseclear-1-99949';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'prompt.md'), 'quick');
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION - 1, id, role: 'refuseclear',
    state: 'winding-down', killSurvivors: '4242, 4243',
    model: 'm', effort: 'low', sandbox: 'read-only', cwd: REPO, bin: FAKE,
    started: new Date().toISOString(),
    launch: 'spawned', supervisorPid: null, codexPid: null,
  }));

  const s = run(['_supervise', dir]);
  assert.notEqual(s.status, 0);
  const rec = record(id);
  assert.equal(rec.state, 'failed',
    `a live state no cancel authored does not stop this refusal: ${JSON.stringify(rec)}`);
  assert.equal(rec.reason, 'record-version-mismatch');
  assert.equal(rec.killSurvivors, undefined,
    'and the survivor list goes with the state that mentioned it');
  assert.match(run(['status', id]).stdout, /^state: failed$/m);
  assert.equal(/4242/.test(run(['status', id]).stdout), false,
    'so nothing reports survivors of a kill this record no longer describes');
});

test('a corrupt record blocks its role: the backstop scan no longer skips it', async () => {
  // REPRODUCED in review with the claim directory deleted — which the runtime's
  // own corrupt-claim message told the operator to do. findRoleConflict skipped
  // corrupt records by design, so two codexes ran under one role.
  const brief = writeBrief('briefscan.md', 'slow');
  const env = { FAKE_CODEX_SLEEP_MS: '60000' };
  const { keep, cancelAll } = reaper();
  try {
    const r = run(['dispatch', '--brief', brief, '--role', 'scanblock'], env);
    assert.equal(r.status, 0, r.stderr);
    const id = keep(jobIdFrom(r.stdout));
    assert.ok(await poll(() => record(id).codexPid), 'fake codex should start');
    const { supervisorPid } = record(id);

    // Corrupt the record AND remove the role lock — the state the reproduction ran
    // in, and the one the old scan was blind to.
    fs.writeFileSync(path.join(JOBS, id, 'job.json'), '{"state":"running", TRUNCATED');
    fs.rmSync(path.join(JOBS, '.role-locks', 'scanblock'), { recursive: true, force: true });
    assert.match(run(['status', id]).stdout, /^state: corrupt$/m);
    assert.ok(pidAlive(supervisorPid), 'and its supervisor really is still alive');

    // Kills that do not take: the role must NOT change hands.
    const refused = run(['dispatch', '--brief', brief, '--role', 'scanblock'],
      { ...env, CODEX_DISPATCH_TEST_NOKILL: '1' });
    assert.notEqual(refused.status, 0, 'a corrupt record with live pids must block its role');
    assert.match(refused.stderr, /REFUSING to launch/);
    assert.match(refused.stderr, /^survivors: /m);
    assert.equal(refused.stdout.includes('job: '), false, 'and no second codex may be handed out');
    assert.ok(pidAlive(supervisorPid), 'which is the point: it is still running');

    // Kills that work: the role changes hands only after a VERIFIED reap.
    const taken = run(['dispatch', '--brief', brief, '--role', 'scanblock'], env);
    assert.equal(taken.status, 0, taken.stderr);
    keep(jobIdFrom(taken.stdout));
    assert.match(taken.stdout, /reaped unvouched-for job before taking role/);
    assert.ok(await poll(() => !pidAlive(supervisorPid)), 'and only after it was killed and verified');
  } finally {
    cancelAll();
  }
});

test('the corrupt-claim message does not open by telling you to delete the guard', () => {
  // The runtime instructed the operator to remove the lock directory — the only
  // remaining guard against a second codex under that role — as step one.
  const lockDir = path.join(JOBS, '.role-locks', 'badclaim');
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner'), 'not-a-job-id\n');
  const old = new Date(Date.now() - 120000);
  fs.utimesSync(lockDir, old, old);
  try {
    const brief = writeBrief('briefbadclaim.md', 'quick');
    const r = run(['dispatch', '--brief', brief, '--role', 'badclaim']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /RECOVERY, in this order/);
    assert.match(r.stderr, /Removing the lock is the LAST step/);
    assert.match(r.stderr, /ONLY THEN remove the lock directory/);
    assert.match(r.stderr, /dispatch under another --role/, 'and names the free alternative');
    // The old wording, which must not survive: an instruction to delete it with
    // nothing checked first.
    assert.equal(/If it is junk, delete the lock directory/.test(r.stderr), false);
    const deleteAt = r.stderr.indexOf('remove the lock directory');
    const checkAt = r.stderr.indexOf('Find out whether a');
    assert.ok(checkAt > 0 && checkAt < deleteAt, 'the check must come before the deletion');
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test('containment follows junctions: a linked job dir is refused, not read through', () => {
  // isInsideRoot resolved `..` and nothing else, so a validly-named junction under
  // the jobs root directed pid reads, kills, renames and removals wherever it
  // pointed. Windows junctions need no elevation, which is what makes this cheap.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-junction-'));
  const id = 'junction-1-99948';
  const link = path.join(JOBS, id);
  let linked = false;
  try {
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'do not touch\n');
    fs.writeFileSync(path.join(outside, 'codex.pid'), '999999995\n');
    fs.writeFileSync(path.join(outside, 'job.json'), JSON.stringify({
      recordVersion: RECORD_VERSION, id, role: 'junction', state: 'running',
      started: new Date().toISOString(), supervisorPid: null, codexPid: null,
    }));
    try {
      fs.symlinkSync(outside, link, 'junction');
      linked = true;
    } catch {
      // No reparse points available (an unprivileged POSIX box with symlinks
      // disabled, a filesystem that cannot). Say so rather than pass silently.
      assert.ok(true, 'SKIPPED: this platform would not create a junction/symlink');
      return;
    }

    const st = run(['status', id]);
    assert.notEqual(st.status, 0, 'a linked job dir must not be opened');
    assert.match(st.stderr, /REFUSING to open a job directory|outside the jobs root/);

    for (const verb of ['result', 'cancel']) {
      const v = run([verb, id]);
      assert.notEqual(v.status, 0, `${verb} must refuse a linked job dir`);
      assert.match(v.stderr, /outside the jobs root/, `${verb} must say why`);
    }

    // The listing verbs must see it and name it rather than reading through it.
    const l = run(['list']);
    assert.equal(l.status, 0, l.stderr);
    assert.match(l.stdout, new RegExp(`^${id}  corrupt  out: `, 'm'),
      'list must render a link as corrupt, not as a job');

    // AND THE ROLE SCAN MUST NOT READ THROUGH IT EITHER. `findRoleConflict`
    // treated a corrupt entry — which is how `allJobs` classifies exactly this —
    // as "read its pid files and its record, then probe those numbers for
    // liveness". Every one of those reads went through the junction, before any
    // containment check, and the pids they returned belonged to whatever was on
    // the other side. The kill was refused later; the read was not. A dispatch
    // under the linked entry's role is refused now, naming the entry, having
    // read nothing.
    const brief = writeBrief('briefjunctionrole.md', 'quick');
    const d = run(['dispatch', '--brief', brief, '--role', 'junction']);
    assert.notEqual(d.status, 0, 'an entry that cannot be read cannot be proved dead, so it blocks');
    assert.match(d.stderr, /not a job directory this runtime created/);
    assert.ok(d.stderr.includes(link), 'and the refusal names the entry to go and look at');
    assert.equal(fs.existsSync(path.join(JOBS, '.role-locks', 'junction')), false,
      'no claim was taken');
    const forced = run(['dispatch', '--brief', brief, '--role', 'junction', '--force']);
    assert.notEqual(forced.status, 0, '--force is not a way through it either');

    assert.deepEqual(fs.readdirSync(outside).sort(), ['codex.pid', 'job.json', 'precious.txt'],
      'and nothing outside the jobs root may be created, renamed or removed');
  } finally {
    if (linked) { try { fs.unlinkSync(link); } catch { fs.rmSync(link, { recursive: true, force: true }); } }
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a cancel that lands mid-write is not undone by the write it interrupted', async () => {
  // updateRecord is a READ-MODIFY-WRITE, and 0.4.0 opened a window in which
  // dispatch and cancel both write it. The dangerous interleaving: cancel takes
  // the honest nothing-to-kill path and records `killed`, then dispatch's
  // `{supervisorPid, launch:'spawned'}` — built on a read from BEFORE that — puts
  // `running` back. The operator was told "killed", the role was released, and
  // codex ran. The pause is injected because a scheduler gap of the right length
  // is not producible on demand; what is under test is the runtime's decision.
  const brief = writeBrief('briefcas.md', 'slow');
  const env = { ...baseEnv, FAKE_CODEX_SLEEP_MS: '60000', CODEX_DISPATCH_TEST_RECORD_PAUSE_MS: '2500' };
  const dispatching = new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNTIME, 'dispatch', '--brief', brief, '--role', 'casrace'],
      { env, cwd: REPO });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

  // The job dir appears before the handle is printed, so it is how the cancel
  // finds a job that is still mid-dispatch.
  const findDir = () => fs.readdirSync(JOBS).find((n) => n.startsWith('casrace-'));
  const { keep, cancelAll } = reaper();
  try {
    assert.ok(await poll(() => findDir() && fs.existsSync(path.join(JOBS, findDir(), 'job.json'))),
      'the dispatch should have written its record');
    const id = keep(findDir());

    const c = run(['cancel', id]);
    const loser = await dispatching;

    const rec = record(id);
    const trace = `cancel(${c.status}): ${c.stdout}${c.stderr}\ndispatch(${loser.code}): ${loser.stdout}${loser.stderr}\nrecord: ${JSON.stringify(rec)}`;
    assert.notEqual(rec.state, 'running',
      `a cancel that recorded a verdict must not be overwritten by the write it raced\n${trace}`);
    assert.ok(['killed', 'kill-pending', 'kill-failed'].includes(rec.state),
      `the cancel's verdict must survive, got ${rec.state}`);
    assert.ok(Number.isInteger(rec.generation), 'and every write stamps a generation');

    // Either order is legal — what is not legal is the cancel's verdict being
    // undone. So: the job never runs, nothing it recorded outlives it, and if the
    // dispatch reported failure it says why.
    if (loser.code !== 0) {
      assert.match(loser.stderr, /cancelled while it was starting|KILL PENDING|already|CLAIM LOST/,
        'a dispatch that lost must say what happened');
    }
    await new Promise((r) => setTimeout(r, 1500));
    assert.notEqual(record(id).state, 'running', 'and it must not have gone back to running');
    assert.notEqual(record(id).state, 'done',
      'a job the operator was told was cancelled must never produce an answer');
    assert.equal(fs.existsSync(path.join(JOBS, id, 'out.txt')), false, 'so there is no answer file');
    for (const pid of [record(id).supervisorPid, ...(record(id).codexPids || [])].filter(Boolean)) {
      assert.ok(await poll(() => !pidAlive(pid)),
        `pid ${pid} must not outlive a job the operator was told was cancelled`);
    }
  } finally {
    cancelAll();
  }
});

test('the catch-all finalizes the record instead of leaving a ghost', () => {
  // Any throw after writeRecord and before the pid check used to release the role
  // and leave the record `running` with no supervisor: a job that reads `stale`
  // forever, blocks its own role, and whose refusal claims codex "may still be
  // billing" for a process that never existed. Closure 11 removed that on the
  // spawn-failure path; it stayed reachable through every other throw.
  //
  // The throw is injected: a disk that fills, a log file that will not open or a
  // pid file that will not write between those two lines is not producible on
  // demand, and what is under test is what the record says afterwards.
  const brief = writeBrief('briefghost.md', 'quick');
  const r = run(['dispatch', '--brief', brief, '--role', 'ghostly'],
    { CODEX_DISPATCH_TEST_THROW_AFTER_RECORD: '1' });
  assert.notEqual(r.status, 0, 'the dispatch must fail');
  assert.match(r.stderr, /dispatch-failed/, 'and name what it recorded');

  const dirs = fs.readdirSync(JOBS).filter((n) => n.startsWith('ghostly-'));
  assert.equal(dirs.length, 1, 'exactly one job dir');
  const rec = JSON.parse(fs.readFileSync(path.join(JOBS, dirs[0], 'job.json'), 'utf8'));
  assert.equal(rec.state, 'failed', 'the record is FINALIZED, not left saying running');
  assert.equal(rec.reason, 'dispatch-failed');
  assert.ok(rec.finished, 'and it has an end time');
  assert.match(run(['status', dirs[0]]).stdout, /^state: failed$/m,
    'so it never reads as stale, and never claims codex may be billing');

  // The role is free again, which is the other half: a ghost blocked it forever.
  const again = run(['dispatch', '--brief', brief, '--role', 'ghostly']);
  assert.equal(again.status, 0, `the role must have been released: ${again.stderr}`);
  run(['cancel', jobIdFrom(again.stdout)]);
});

test('a transport failure in the sight probe is not a finding of blindness', async () => {
  // Seen live: a console error box, `error 2147942632 (0x800700E8)` — ERROR_NO_DATA,
  // "the pipe is being closed" — on the probe spawn against a perfectly good
  // binary. spawnSync sets `error` and leaves `status` null when a launch fails,
  // and every one of those used to fall out of sandboxRead as `broken`: a verdict
  // of PROVEN blindness, on the strength of an infrastructure hiccup. Under a
  // fail-closed gate that refuses good jobs and blames the wrong thing.
  const brief = writeBrief('briefprobeerr.md', 'quick');

  // Transient: the first attempt fails to launch, the retry succeeds, the job runs.
  const ok = run(['dispatch', '--brief', brief, '--role', 'probeflake'],
    { CODEX_DISPATCH_TEST_PROBE_ERROR: '1' });
  assert.equal(ok.status, 0, ok.stderr);
  const okId = jobIdFrom(ok.stdout);
  assert.ok(await poll(() => done(okId)), 'a bounded retry must absorb a one-off transport failure');
  assert.match(record(okId).sight, /^cwd-file:/, 'and the retry proves sight normally');
  assert.equal(run(['result', okId]).status, 0, 'and the answer is delivered');

  // Persistent: refused, but as a probe error — NOT as blindness.
  const bad = run(['dispatch', '--brief', brief, '--role', 'probeerr'],
    { CODEX_DISPATCH_TEST_PROBE_ERROR: '99' });
  assert.equal(bad.status, 0, bad.stderr);
  const badId = jobIdFrom(bad.stdout);
  assert.ok(await poll(() => record(badId).state !== 'running'), 'the supervisor must finalize');

  const rec = record(badId);
  assert.equal(rec.state, 'failed');
  assert.equal(rec.reason, 'sight-probe-error', 'the reason names the transport, not the sandbox');
  assert.notEqual(rec.reason, 'sandbox-blind-precheck',
    'a spawn that never ran cannot be evidence that codex is blind');
  assert.match(rec.sight, /could not be run/);
  assert.equal(rec.exitCode, null, 'nothing was billed');

  const res = run(['result', badId]);
  assert.notEqual(res.status, 0, 'result must refuse it');
  assert.equal(res.stdout, '', 'zero stdout');
  assert.match(res.stderr, /PROBE ERROR/);
  assert.match(res.stderr, /NOT a finding that codex is blind/);
  assert.equal(res.stderr.includes('sandbox-blind'), false,
    'and must not print the blindness diagnosis or its cure');
  assert.match(run(['list']).stdout, new RegExp(`^${badId}  failed\\(sight-probe-error\\)`, 'm'));

  // It is the UNPROVEN class, so the recorded opt-in is the way past it.
  const forced = run(['dispatch', '--brief', brief, '--role', 'probeoptin', '--allow-unproven-sight'],
    { CODEX_DISPATCH_TEST_PROBE_ERROR: '99' });
  assert.equal(forced.status, 0, forced.stderr);
  const forcedId = jobIdFrom(forced.stdout);
  assert.ok(await poll(() => done(forcedId)), 'the caller may accept an unrunnable probe knowingly');
  assert.equal(record(forcedId).sight, 'unproven (accepted by caller)');
});

test('a codex behind a .cmd wrapper is recorded and verified, not its cmd.exe proxy',
  { skip: process.platform === 'win32' ? false : 'Windows-only: the .cmd shell wrapper is a Windows path' },
  async () => {
    // MEASURED IN REVIEW: `codex.cmd` is not a script this runtime can run under
    // node, so spawnCodex goes through cmd.exe with shell:true — and the pid it
    // gets back is the WRAPPER (43124), not the worker (40732, ppid 43124). Every
    // killPids/waitGone therefore verified a proxy: a surviving worker left the
    // job marked `killed`, the role released, and the next dispatch running beside
    // a codex that was still billing. `kill-failed` could not fire.
    //
    // CI was blind to all of it because CODEX_DISPATCH_BIN was always a `.mjs`, so
    // the shell branch never executed. That is what fake-codex.cmd is for.
    const brief = writeBrief('briefwrapper.md', 'slow');
    const env = { CODEX_DISPATCH_BIN: FAKE_CMD, FAKE_CODEX_SLEEP_MS: '60000' };
    const r = run(['dispatch', '--brief', brief, '--role', 'wrapper'], env);
    assert.equal(r.status, 0, r.stderr);
    const id = jobIdFrom(r.stdout);
    assert.ok(await poll(() => (record(id).codexPids || []).length, 30000),
      'the worker behind the wrapper must be resolved and recorded');

    const rec = record(id);
    assert.ok(rec.codexPids.includes(rec.codexPid), 'the wrapper pid is still a target');
    const workers = rec.codexPids.filter((p) => p !== rec.codexPid);
    assert.ok(workers.length, 'and the REAL process behind it is recorded alongside it');
    assert.ok(workers.some(pidAlive), 'and it is a live process, not a number');
    assert.equal(
      fs.readFileSync(path.join(JOBS, id, 'codex.pid'), 'utf8').trim().split(/\s+/).length,
      rec.codexPids.length,
      'the pid file mirrors every one of them, so a corrupt record cannot orphan the worker'
    );

    // A kill that does not take must name the WORKER as a survivor. Under 0.4.0
    // the worker was not a target at all, so it could never appear here — the job
    // read `killed` while it was still running.
    const c = run(['cancel', id], { ...env, CODEX_DISPATCH_TEST_NOKILL: '1' });
    assert.notEqual(c.status, 0, 'a kill that did not take must exit nonzero');
    assert.match(c.stderr, /KILL FAILED/);
    const failed = record(id);
    assert.equal(failed.state, 'kill-failed', 'kill-failed, NOT killed');
    for (const worker of workers) {
      assert.ok(failed.killSurvivors.includes(String(worker)),
        `the surviving worker ${worker} must be named — verifying the wrapper is verifying a proxy`);
    }

    // With kills working, the whole tree goes and the job is honestly killed.
    const done2 = run(['cancel', id], env);
    assert.equal(done2.status, 0, done2.stderr);
    assert.equal(record(id).state, 'killed');
    for (const worker of workers) {
      assert.ok(await poll(() => !pidAlive(worker)), `the worker ${worker} must actually be dead`);
    }
  });

test('a cancel inside the codex-exec window is kill-pending, never killed', async () => {
  // The SECOND registration window, in the same shape as the first: the supervisor
  // spawns codex and records its pid a moment later, so a cancel landing in
  // between kills the supervisor, verifies the targets it knows about, marks the
  // job `killed` and releases the role — while codex runs on and bills.
  const started = new Date().toISOString();
  const id = 'execwindow-1-99940';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'execwindow', state: 'running', started,
    // A supervisor that IS registered — so this is not the first window — sitting
    // in the phase where codex has been spawned and not yet recorded.
    launch: 'exec-spawning', supervisorPid: null, codexPid: null,
  }));

  const c = run(['cancel', id]);
  assert.notEqual(c.status, 0, 'a cancel that could not reach codex must not exit 0');
  assert.match(c.stderr, /KILL PENDING/);
  assert.equal(record(id).state, 'kill-pending', 'kill-pending, NOT killed');

  // The role stays blocked, and --force may not launch beside it.
  const brief = writeBrief('briefexecwindow.md', 'quick');
  const blocked = run(['dispatch', '--brief', brief, '--role', 'execwindow']);
  assert.notEqual(blocked.status, 0, 'the role stays blocked while that is unresolved');
  assert.match(blocked.stderr, /already kill-pending/);
  const forced = run(['dispatch', '--brief', brief, '--role', 'execwindow', '--force']);
  assert.notEqual(forced.status, 0, '--force must not launch beside a job it could not kill');
  assert.match(forced.stderr, /could not be shown to have died/);

  // And unlike the supervisor window, this one is NOT time-boxed: the phase is
  // left behind by the supervisor itself, so waiting cannot resolve it.
  const oldId = 'execold-1-99939';
  fs.mkdirSync(path.join(JOBS, oldId), { recursive: true });
  fs.writeFileSync(path.join(JOBS, oldId, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id: oldId, role: 'execold', state: 'running',
    started: new Date(Date.now() - 3600000).toISOString(),
    launch: 'exec-spawning', supervisorPid: null, codexPid: null,
  }));
  const c2 = run(['cancel', oldId]);
  assert.notEqual(c2.status, 0, 'an hour later it is still a codex nobody can prove is dead');
  assert.equal(record(oldId).state, 'kill-pending');
});

test('a real cancel inside the exec window is not recorded as a death, and the supervisor lands it',
  async () => {
    // The LIVE half of the second window, with the supervisor actually held inside
    // it. A cancel here can only reach what has been recorded, and codex has not
    // been: 0.4.0 killed the supervisor, verified the targets it knew about,
    // recorded `killed` and released the role. Two claims it could not support.
    const brief = writeBrief('briefexecland.md', 'slow');
    const env = {
      ...baseEnv,
      FAKE_CODEX_SLEEP_MS: '60000',
      CODEX_DISPATCH_TEST_EXEC_PAUSE_MS: '6000',
    };
    const dispatching = new Promise((resolve) => {
      const child = spawn(process.execPath, [RUNTIME, 'dispatch', '--brief', brief, '--role', 'execland'],
        { env, cwd: REPO });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    const { keep, cancelAll } = reaper();
    try {
      const d = await dispatching;
      assert.equal(d.code, 0, d.stderr);
      const id = keep(jobIdFrom(d.stdout));

      // Get inside the window. Its defining property is release-independent and is
      // asserted rather than assumed: codex has been spawned and nothing has written
      // down what was spawned. The sight probe takes a few hundred milliseconds and
      // the hold is six seconds, so this lands well inside it.
      await new Promise((r) => setTimeout(r, 2500));
      assert.equal(record(id).codexPid, null,
        'the supervisor should be held with codex spawned and unrecorded — that IS the window');
      assert.ok(pidAlive(record(id).supervisorPid), 'with its supervisor alive and about to register');

      const c = run(['cancel', id]);
      assert.notEqual(c.status, 0, 'a cancel that could not reach codex must not report success');
      assert.match(c.stderr, /KILL PENDING/);
      assert.equal(record(id).state, 'kill-pending',
        'kill-pending, NOT killed: codex was spawned and nothing here could verify its death');

      // And the supervisor, which does have the pids, lands the cancel rather than
      // leaving a kill-pending job with a live codex under it.
      assert.ok(await poll(() => ['killed', 'kill-failed'].includes(record(id).state), 30000),
        `the supervisor must honour the pending cancel: ${record(id).state}`);
      const rec = record(id);
      assert.equal(rec.state, 'killed', 'and it must be able to verify the death it records');
      assert.equal(rec.reason, 'cancelled-during-exec', 'naming which window it landed in');
      for (const pid of [rec.supervisorPid, ...(rec.codexPids || [])].filter(Boolean)) {
        assert.ok(await poll(() => !pidAlive(pid)), `pid ${pid} must not outlive a cancelled job`);
      }
      assert.equal(fs.existsSync(path.join(JOBS, id, 'out.txt')), false, 'and no answer was produced');

      // The role is free again, which is the half that costs money when it is wrong.
      const again = run(['dispatch', '--brief', brief, '--role', 'execland']);
      assert.equal(again.status, 0, `a landed cancel must release the role: ${again.stderr}`);
      keep(jobIdFrom(again.stdout));
    } finally {
      cancelAll();
    }
  });

test('a cancel decides on the record as it is NOW, not as it was when the job was read',
  async () => {
    // The stale-snapshot race. `killJob` took its kill window AND its target list
    // from the record the caller read at `getJob` time, then spent seconds in
    // `effectiveState` and the pid-identity check before acting on them. A
    // supervisor entering the codex-exec window inside that gap was invisible: the
    // window read `none`, the supervisor was killed, and off Windows the codex it
    // had just spawned leads its own group and reparents to init — so the kill
    // verified, the leftover sweep saw nothing descended from anything, and the job
    // was recorded `killed` with its role released while codex billed on.
    //
    // The hold is injected because the real gap is shell time measured in
    // milliseconds and cannot be aimed at; what is under test is WHICH record the
    // decision is made on.
    const id = 'killrace-1-99937';
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
      stdio: 'ignore', detached: true,
    });
    victim.unref();
    // A supervisor that has registered: there IS a target, so the pre-fix path
    // killed it, verified it, and recorded a death.
    const base = {
      recordVersion: RECORD_VERSION, id, role: 'killrace', state: 'running',
      started: new Date().toISOString(), supervisorPid: victim.pid,
      codexPid: null, launch: 'spawned',
    };
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(base));

    try {
      const cancelling = new Promise((resolve) => {
        const child = spawn(process.execPath, [RUNTIME, 'cancel', id],
          { env: { ...baseEnv, CODEX_DISPATCH_TEST_KILL_PAUSE_MS: '5000' }, cwd: REPO });
        let stdout = '', stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
      // The supervisor reaches the codex-exec window AFTER the cancel read the
      // record. That is the whole race.
      await new Promise((r) => setTimeout(r, 1500));
      fs.writeFileSync(path.join(dir, 'job.json'),
        JSON.stringify({ ...base, launch: 'exec-spawning' }));

      const c = await cancelling;
      assert.notEqual(c.code, 0, 'a cancel that could not reach codex must not report success');
      assert.match(c.stderr, /KILL PENDING/);
      assert.equal(record(id).state, 'kill-pending',
        'kill-pending, NOT killed: the phase moved between the read and the trigger');
      assert.ok(pidAlive(victim.pid),
        'and the supervisor — the one process that knows what it just spawned — is alive to land it');
    } finally {
      try { process.kill(victim.pid); } catch { /* already gone */ }
    }
  });

// A cancel run out of band, so a verdict can be posed against it while it is
// mid-decision. Shared by the verdict-race tests below: every one of them needs
// the same three lines, and the interleaving is the whole fixture.
function cancelling(id, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNTIME, 'cancel', id],
      { env: { ...baseEnv, ...env }, cwd: REPO });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// A job with a live process standing in for its supervisor, past both
// registration windows: the `none` kill window, which is the one that actually
// fires — and therefore the one whose writes are compare-and-swaps.
function killableJob(id, role, extra = {}) {
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
    stdio: 'ignore', detached: true,
  });
  victim.unref();
  const base = {
    recordVersion: RECORD_VERSION, id, role, state: 'running',
    started: new Date().toISOString(), supervisorPid: victim.pid,
    codexPid: null, launch: 'spawned', ...extra,
  };
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(base));
  return { dir, victim: victim.pid, base };
}

test('a cancel never writes its verdict over a terminal one the supervisor reached first',
  async () => {
    // THE OTHER HALF OF THE SAME RACE, and the one the phase test above could not
    // see: it moved the launch PHASE during the injected pause and never the
    // STATE. Every other writer in this seam carries a precondition — the
    // supervisor's exit handler, the exec-spawning mark, dispatch's post-spawn
    // check all write `expect: canonicalState === 'running'` — and killJob's
    // writes carried none. So a cancel that lost the race to the supervisor's own
    // verdict wrote `killed` straight over it: `killed(sight-unproven)`, a pair
    // tests/resolution.test.mjs asserts impossible, or a deliverable `done`
    // destroyed by a cancel that killed nothing that was still alive.
    //
    // TWO INTERLEAVINGS, BECAUSE THERE ARE TWO GUARDS, and one of them used to
    // hide the other. A verdict landing during the pre-trigger pause is caught by
    // the re-read bail (`!stillCancellable(r)` before the kill) and the cancel
    // returns without firing at anything — so a test that poses only that
    // interleaving passes with `expect: stillCancellable` deleted from every write
    // below it, which is what this test used to do. The second phase poses the
    // verdict AFTER the kill and after the survivor check has re-read, in the last
    // gap there is, where the compare-and-swap on the `killed` write is the only
    // thing left between the supervisor's answer and a cancel's `killed`.
    // PHASE 1 — the pre-trigger bail. Pins the `!stillCancellable(r)` re-read
    // check: delete it and the supervisor is killed and its verdict overwritten,
    // so both the state and the live-victim assertions fail.
    {
      const id = 'killverdict-1-99930';
      const { victim, dir } = killableJob(id, 'killverdict');
      try {
        const c = cancelling(id, { CODEX_DISPATCH_TEST_KILL_PAUSE_MS: '5000' });
        // The one interleaving in this file that cannot be polled for: this pause
        // sits between killJob's two reads and NOTHING is written during it, so
        // there is no state to observe. The margin is the guarantee instead — the
        // hold is five seconds and the verdict lands well inside it, and if it ever
        // landed after the pause the phase-2 assertions below are what would catch
        // the difference.
        await new Promise((r) => setTimeout(r, 1200));
        fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
          ...record(id), state: 'failed', reason: 'sight-unproven',
          sight: 'unproven: nothing proved this job could read files',
          finished: new Date().toISOString(),
        }));

        const c1 = await c;
        const rec = record(id);
        assert.equal(rec.state, 'failed', `the terminal verdict must survive: ${JSON.stringify(rec)}`);
        assert.equal(rec.reason, 'sight-unproven',
          'and it must still carry the reason its writer paired with it');
        assert.equal(c1.code, 0, `${c1.stdout}${c1.stderr}`);
        assert.match(c1.stdout, /^job \S+ is already failed, nothing to kill$/m);
        assert.match(c1.stdout, /^out: /m, 'and it still names the out path');
        assert.ok(pidAlive(victim),
          'and NOTHING is killed on behalf of a job whose verdict was already on disk');
      } finally {
        try { process.kill(victim); } catch { /* already gone */ }
      }
    }

    // PHASE 2 — the compare-and-swap itself. The signals have already gone out and
    // the survivor check has already re-read the record when the verdict lands, so
    // no earlier guard can answer: the `expect: stillCancellable` on the `killed`
    // write is the only thing that stops it. Delete it and this record reads
    // `killed`, the answer file stops being deliverable, and the cancel announces
    // `killed: <id>` instead of the finished-job line — three failures, none of
    // which the phase-1 interleaving can produce.
    {
      const id = 'killdone-1-99931';
      const { victim, dir } = killableJob(id, 'killdone');
      fs.writeFileSync(path.join(dir, 'out.txt'), 'the answer that survived a cancel\n');
      try {
        const c = cancelling(id, { CODEX_DISPATCH_TEST_VERDICT_PAUSE_MS: '9000' });
        // The fence is the observable start of the kill: `kill-pending` is written
        // before the signals go out, so seeing it means killJob is past every
        // decision it makes on the pre-kill record and is inside the pause.
        assert.ok(await poll(() => record(id).state === 'kill-pending', 20000),
          'the cancel must have fenced the record and started killing');
        assert.ok(await poll(() => !pidAlive(victim), 20000),
          'and the signals must really have gone out — this is a kill, not a refusal');
        fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
          ...record(id), state: 'done', exitCode: 0, sight: 'cwd-file:LICENSE',
          finished: new Date().toISOString(),
        }));

        const c2 = await c;
        const rec = record(id);
        assert.equal(rec.state, 'done', `the verdict that landed mid-kill stands: ${JSON.stringify(rec)}`);
        assert.notEqual(rec.state, 'killed',
          'a cancel may not mint a death for a job that had already finished');
        assert.equal(rec.killSurvivors, undefined, 'and no kill bookkeeping is written over it');
        assert.equal(c2.code, 0, `${c2.stdout}${c2.stderr}`);
        assert.match(c2.stdout, /^job \S+ is already done, nothing to kill$/m,
          'the cancel reports the state that beat its swap');
        assert.equal(/^killed: /m.test(c2.stdout), false,
          'and never announces a death it did not record');
        assert.equal(run(['result', id]).status, 0,
          'the answer the job had earned is still deliverable');
      } finally {
        try { process.kill(victim); } catch { /* already gone */ }
      }
    }
  });

test('a kill-failed that loses to a verdict reports the verdict, not the failed write', async () => {
  // THE SAME SWAP, ON THE OTHER WRITE. A kill that could not be verified — pids
  // that outlived it, or a process table nothing could read — writes `kill-failed`
  // under the same precondition, and that one alone came back with no `terminal`
  // on it. So a swap it lost read like a plain failure: `cancel` announced
  // "state: kill-failed (NOT killed)" for a record saying `done` and exited
  // nonzero, and `--force` treated a job that had finished as an unresolved
  // conflict and refused to launch.
  //
  // The unreadable process table is injected (a host whose PowerShell will not
  // run is not producible in CI) and the verdict is posed inside the same
  // post-kill pause, so what is under test is the ANSWER the lost swap gives.
  const id = 'killverif-1-99932';
  const { victim, dir } = killableJob(id, 'killverif');
  try {
    const c = cancelling(id, {
      CODEX_DISPATCH_TEST_NO_PROCESS_TABLE: '1',
      CODEX_DISPATCH_TEST_VERDICT_PAUSE_MS: '9000',
    });
    assert.ok(await poll(() => record(id).state === 'kill-pending', 20000),
      'the cancel must have fenced the record and started killing');
    assert.ok(await poll(() => !pidAlive(victim), 20000),
      'the signals really went out — the verification is what failed, not the kill');
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      ...record(id), state: 'done', exitCode: 0, sight: 'cwd-file:LICENSE',
      finished: new Date().toISOString(),
    }));

    const done = await c;
    const rec = record(id);
    assert.equal(rec.state, 'done', `the verdict stands: ${JSON.stringify(rec)}`);
    assert.equal(rec.warning, undefined,
      'and the unenumerated-kill warning is not written over a record this cancel did not own');
    // The wording is the fix: "nothing to kill" would be a claim about processes
    // this cancel really did fire at, so the finished-job line says what happened.
    assert.match(done.stdout,
      new RegExp(`^job ${id} finished as done while the kill was verifying, and that verdict stands$`, 'm'));
    assert.equal(/nothing to kill/.test(done.stdout), false,
      'it fired at something, so it may not borrow the sentence for a cancel that did not');
    assert.equal(done.code, 0,
      `a verdict that was reached is not this cancel's failure: ${done.stdout}${done.stderr}`);
    assert.match(done.stderr, /had already reached "done"/,
      'and what could not be verified is still reported, on stderr, where the kill wrote it');
  } finally {
    try { process.kill(victim); } catch { /* already gone */ }
  }
});

test('--force treats a job that finished under it as finished, not as a conflict', async () => {
  // The same hole through the OTHER door: `--force` reaches killJob via
  // claimRole, and a job that reaches a terminal state while the force is
  // deciding is not a conflict at all — the role is free, so the dispatch may
  // take it. Before the preconditions it wrote `killed` over that verdict and
  // then launched, which is the corruption plus a claim about a kill it never
  // made.
  //
  // Posed AFTER the kill, in the post-kill pause, for the reason the test above
  // spells out: a verdict written before the trigger is caught by the re-read bail
  // and proves nothing about the write. Here the `killed` swap is the only thing
  // between the force and an overwritten verdict, and its answer is what claimRole
  // reads to decide whether this is a conflict at all.
  const id = 'forcedone-1-99933';
  const { victim, dir } = killableJob(id, 'forcedone');
  // The answer it will have earned by the time the force gets there: the point of
  // not overwriting the verdict is that these bytes stay deliverable.
  fs.writeFileSync(path.join(dir, 'out.txt'), 'the answer that survived a --force\n');
  const lock = path.join(JOBS, '.role-locks', 'forcedone');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), id);

  const brief = writeBrief('briefforcedone.md', 'quick');
  const { keep, cancelAll } = reaper();
  try {
    const dispatching = new Promise((resolve) => {
      const child = spawn(process.execPath,
        [RUNTIME, 'dispatch', '--brief', brief, '--role', 'forcedone', '--force'],
        { env: { ...baseEnv, CODEX_DISPATCH_TEST_VERDICT_PAUSE_MS: '9000' }, cwd: REPO });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.ok(await poll(() => record(id).state === 'kill-pending', 20000),
      'the force must have fenced the old job and started killing it');
    assert.ok(await poll(() => !pidAlive(victim), 20000), 'and the signals must have gone out');
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      ...record(id), state: 'done', exitCode: 0, sight: 'cwd-file:LICENSE',
      finished: new Date().toISOString(),
    }));

    const d = await dispatching;
    assert.equal(d.code, 0, `the role was free, so the forced dispatch proceeds: ${d.stderr}`);
    const rec = record(id);
    assert.equal(rec.state, 'done', `the old job's verdict is untouched: ${JSON.stringify(rec)}`);
    assert.equal(d.stdout.includes('killed previous job'), false,
      'and the force does not claim a kill it never made');
    assert.match(d.stdout, new RegExp(`previous job finished on its own: ${id} \\(done\\)`),
      'it reports the verdict its swap lost to — the shape only the lost swap produces');
    keep(jobIdFrom(d.stdout));
    assert.equal(run(['result', id]).status, 0,
      'the answer it had already earned is still deliverable');
  } finally {
    cancelAll();
    try { process.kill(victim); } catch { /* already gone */ }
  }
});

test('the kill fences the record, so a supervisor cannot spawn codex behind it', async () => {
  // THE WINDOW THAT DOES KILL, FENCED. Outside both registration windows a cancel
  // has targets and spends seconds reading the process table — and the record went
  // on saying `running` for all of it, which is exactly the precondition the
  // supervisor's `launch: 'exec-spawning'` mark asks for. A supervisor reaching it
  // in that gap spends money the kill can no longer reach: off Windows codex is
  // detached, leads its own group and reparents to init the moment the supervisor
  // dies, so the leftover sweep finds nothing and the pre-kill record carries no
  // `codexPgid` to check it by. A verified kill, a released role, a billed orphan.
  //
  // ORDERING A: the fence lands first. The supervisor is held immediately before
  // its mark, the cancel's `kill-pending` is written while it waits, and the mark
  // then loses its precondition. What this pins is the FENCE and not merely the
  // final verdict: the supervisor is observed dying while the record still says
  // `kill-pending` — a state that exists only because the mark is written BEFORE
  // the kill. Move it back after the kill and the supervisor wakes to a record
  // saying `running`, its mark succeeds, and a codex.pid appears for a job that
  // was cancelled.
  //
  // NOKILL is what keeps the supervisor alive to reach its mark at all: a real
  // kill would take it away and there would be no interleaving to pose.
  const brief = writeBrief('briefexecfence.md', 'slow');
  const r = run(['dispatch', '--brief', brief, '--role', 'execfence'], {
    FAKE_CODEX_SLEEP_MS: '60000',
    CODEX_DISPATCH_TEST_PRELAUNCH_PAUSE_MS: '10000',
  });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  const dir = path.join(JOBS, id);
  let supervisorPid;
  try {
    // Sight is written one step before the pre-launch check, so a record carrying
    // it is a supervisor at (or about to reach) the hold.
    assert.ok(await poll(() => record(id).sight && record(id).supervisorPid, 30000),
      'the supervisor must have proved sight and be about to mark the exec window');
    supervisorPid = record(id).supervisorPid;
    assert.equal(record(id).launch, 'spawned',
      'and it must NOT have marked it yet — that is the whole ordering');

    const c = cancelling(id, {
      CODEX_DISPATCH_TEST_NOKILL: '1',
      CODEX_DISPATCH_TEST_VERDICT_PAUSE_MS: '15000',
    });
    assert.ok(await poll(() => record(id).state === 'kill-pending', 20000),
      'the kill must fence the record BEFORE it fires — that is the fix');
    // The supervisor comes out of its hold inside that fence and aborts. Both
    // halves are asserted: that it died, and that the record it died against was
    // the fence rather than the cancel's final verdict.
    assert.ok(await poll(() => !pidAlive(supervisorPid), 30000),
      'the supervisor must abort rather than launch');
    assert.equal(record(id).state, 'kill-pending',
      'and it aborted against the FENCE: the cancel has not written its verdict yet');

    await c;
    // Deliberately no claim about the cancel's own exit code: the supervisor
    // aborts of its own accord inside the kill, so whether it is still standing
    // when the verification looks is a race with no bearing on the fence. What
    // the record may NOT say is `running` — this job never ran.
    assert.ok(['killed', 'kill-failed'].includes(record(id).state),
      `the cancel still records what it found: ${JSON.stringify(record(id))}`);
    assert.equal(fs.existsSync(path.join(dir, 'codex.pid')), false,
      'NO codex was spawned behind the fence — the one thing that costs money');
    assert.equal(record(id).codexPid, null, 'and none was recorded');
    assert.equal(record(id).launch, 'spawned', 'the exec window was never entered');
    assert.equal(fs.existsSync(path.join(dir, 'out.txt')), false, 'and nothing was billed');
    const logs = ['run.log', 'supervisor.log']
      .map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } })
      .join('\n');
    assert.match(logs, /ABORTING before codex was launched/, 'and it says so where a human looks');
    assert.match(logs, /stopped saying "running"/, 'naming the precondition it lost');
  } finally {
    if (supervisorPid) { try { process.kill(supervisorPid); } catch { /* already gone */ } }
    run(['cancel', id]);
    fs.rmSync(path.join(JOBS, '.role-locks', 'execfence'), { recursive: true, force: true });
  }
});

test('a cancel that arrives after the exec mark answers pending, and kills nothing', async () => {
  // ORDERING B of the same two writers: the supervisor's mark won first. The
  // record says `exec-spawning` under a LIVE supervisor, which is the codex-exec
  // window — so the answer is the window's, not the kill's: nothing is signalled,
  // the state goes to `kill-pending`, and the supervisor (the one process that
  // knows what it just spawned) lands the cancel itself. Killing here is what
  // 0.4.0 did: it took away the only process that could verify the death.
  //
  // Fabricated rather than raced: what is under test is the DECISION taken on that
  // record shape, and the live pid is what makes "killed nothing" observable.
  const id = 'execwon-1-99934';
  const { victim } = killableJob(id, 'execwon', { launch: 'exec-spawning' });
  try {
    const c = run(['cancel', id]);
    assert.notEqual(c.status, 0, 'a cancel that could not reach codex must not report success');
    assert.match(c.stderr, /KILL PENDING/);
    assert.equal(record(id).state, 'kill-pending',
      'kill-pending, NOT killed: the supervisor lands this one');
    assert.ok(pidAlive(victim),
      'and the supervisor is alive to land it — killing it is how the codex pid is lost');
    assert.equal(record(id).killSurvivors, undefined, 'nothing was fired at, so nothing survived it');
  } finally {
    try { process.kill(victim); } catch { /* already gone */ }
  }
});

test('a pid file holding numbers this kill never fired at stays loaded', async () => {
  // CONSUMING A PID FILE IS SPENDING IT. The rename used to happen for every pid
  // file whatever the kill had targeted, so the one recorded target an orphan has
  // — a `codex.pid` written moments before its supervisor died — was renamed away
  // by a cancel that never signalled a number in it, and the next cancel found
  // nothing to fire at.
  //
  // The unfired pid here is one the identity check REFUSED: the record's recorded
  // start time and the one the OS reports (injected, because real pid reuse cannot
  // be aimed at in CI) disagree, so the number belongs to something else and is
  // not a target. The file, however, is still the job's own evidence.
  const id = 'unfired-1-99935';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  const stranger = 424242;
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'unfired', state: 'running',
    // An hour old, no supervisor pid: past every window, so this is the path that
    // kills and then consumes.
    started: new Date(Date.now() - 3600000).toISOString(),
    supervisorPid: null, codexPid: null, launch: 'exec',
    pidStarts: { [String(stranger)]: '2020-01-01T00:00:00.000Z' },
  }));
  fs.writeFileSync(path.join(dir, 'codex.pid'), `${stranger}\n`);

  const c = run(['cancel', id], { CODEX_DISPATCH_TEST_START_TIME: `${stranger}:2026-01-01T00:00:00.000Z` });
  assert.equal(c.status, 0, `nothing was targeted, so the kill verifies: ${c.stderr}`);
  assert.equal(record(id).state, 'killed');
  assert.equal(fs.existsSync(path.join(dir, 'codex.pid')), true,
    'the file holds a number nothing fired at, so it stays loaded and stays a target');
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('codex.pid.reaped-')), false,
    'and it was not renamed out of the way');
  assert.equal([...fs.readFileSync(path.join(dir, 'codex.pid'), 'utf8').matchAll(/\d+/g)][0][0],
    String(stranger), 'byte-for-byte the same numbers');
  assert.equal(c.stdout.includes('consumed pid files'), false,
    'and the cancel does not claim to have spent it');
});

test('the watcher keeps watching a live state instead of declaring an end', async () => {
  // kill-pending and kill-failed are declared live and process-owning, and the
  // watcher printed JOB ENDED for them and exited — an end declared while a
  // process may still be billing, in the one line meant to be believed from
  // across the room.
  const id = 'watchlive-1-99950';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  const live = JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'watchlive', state: 'kill-failed',
    killSurvivors: '4242, 4243', started: new Date(Date.now() - 3600000).toISOString(),
  });
  fs.writeFileSync(path.join(dir, 'job.json'), live);

  const w = spawn(process.execPath, [RUNTIME, '_watch', id], { env: baseEnv, cwd: REPO });
  let out = '';
  let exited = null;
  w.stdout.on('data', (d) => { out += d; });
  w.on('close', (code) => { exited = code; });
  try {
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(exited, null, 'a live state must NOT end the watch');
    assert.match(out, /JOB NOT FINISHED - state: kill-failed/, 'it says what is happening');
    assert.match(out, /pids 4242, 4243 SURVIVED/, 'and what that means');
    assert.match(out, /still watching/);
    assert.equal(/JOB ENDED/.test(out), false, 'and never declares an end while a process may live');

    // A retried cancel resolving it is what the window was waiting for.
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      ...JSON.parse(live), state: 'killed', killSurvivors: undefined,
      finished: new Date().toISOString(),
    }));
    assert.ok(await poll(() => exited !== null, 10000), 'and it ends once the job really has');
    assert.match(out, /JOB ENDED - state: killed/);
  } finally {
    try { w.kill(); } catch { /* already gone */ }
  }
});

test('list classifies states including stale pids', async () => {
  // Self-sufficient by construction. It used to assert bare `done  out: ` and
  // `killed  out: ` against whatever earlier tests happened to have left in the
  // shared jobs tree — so it passed on its neighbours' leftovers, and would have
  // gone on passing if `list` stopped classifying either state, as long as some
  // other test still produced one. Every line asserted below is now a job this
  // test created, matched by its own id.
  const staleDir = path.join(JOBS, 'ghost-1-99999');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'job.json'), JSON.stringify({
    id: 'ghost-1-99999', role: 'ghost', state: 'running',
    started: new Date(Date.now() - 3600000).toISOString(),
    supervisorPid: 999999999, codexPid: null,
  }));

  // A real job run to done, so the `done` line comes from the lifecycle rather
  // than from a hand-written record that could not fail the same way.
  const brief = writeBrief('brieflist.md', 'quick');
  const d = run(['dispatch', '--brief', brief, '--role', 'listdone']);
  assert.equal(d.status, 0, d.stderr);
  const doneId = jobIdFrom(d.stdout);
  assert.ok(await poll(() => done(doneId)), 'the done job must finish');

  // And a real one cancelled, for the `killed` line.
  const k = run(['dispatch', '--brief', brief, '--role', 'listkill'], { FAKE_CODEX_SLEEP_MS: '60000' });
  assert.equal(k.status, 0, k.stderr);
  const killedId = jobIdFrom(k.stdout);
  assert.ok(await poll(() => record(killedId).codexPid), 'the fake must be up before it is cancelled');
  const c = run(['cancel', killedId]);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(record(killedId).state, 'killed');

  const r = run(['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ghost-1-99999  stale  out: /m, 'dead-pid running job listed as stale');
  assert.match(r.stdout, new RegExp(`^${doneId}  done  out: `, 'm'), 'finished jobs listed as done');
  assert.match(r.stdout, new RegExp(`^${killedId}  killed  out: `, 'm'), 'cancelled jobs listed as killed');
});

test('a cwd carrying a cmd.exe metacharacter is refused, even with no --cd to inspect',
  { skip: process.platform === 'win32' ? false : 'Windows-only: only Windows builds a command line' },
  () => {
    // The 0.7.0 regression, reproduced. That release validated `opts.cd` — so a
    // dispatch with NO --cd skipped the check entirely and put `process.cwd()`
    // into the record unexamined. The supervisor then threw inside a detached
    // process with nobody to catch it: the record kept saying `running` with no
    // supervisor behind it, the job read `stale`, and it held its role until
    // someone noticed. Confirmed by hand against 0.7.0 before this was written.
    const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'pct%dir-'));
    fs.writeFileSync(path.join(odd, 'readable.txt'), 'line one\nenough content to yield a token\n');
    const brief = path.join(odd, 'b.md');
    fs.writeFileSync(brief, 'review something');

    const before = fs.readdirSync(JOBS).length;
    const r = spawnSync(process.execPath, [RUNTIME, 'dispatch', '--brief', brief, '--role', 'pct'], {
      env: baseEnv, cwd: odd, encoding: 'utf8',
    });

    assert.notEqual(r.status, 0, 'must be refused, not dispatched');
    assert.match(r.stderr + r.stdout, /--cd .*contains one of/,
      'the refusal names the resolved cwd, which is the value that was never checked');
    assert.equal(fs.readdirSync(JOBS).length, before,
      'refused before anything was created: no job dir, no role claim, no ghost');

    fs.rmSync(odd, { recursive: true, force: true });
  });

test('a jobs root that cannot survive a cmd.exe command line is refused up front',
  { skip: process.platform === 'win32' ? false : 'Windows-only: only Windows builds a command line' },
  () => {
    // The gate checked --model, --effort and --cd and not the jobs root — which
    // lands on the same command line as `--output-last-message
    // <jobs-root>\<id>\out.txt`. `%` and `!` are legal in a Windows user name, so
    // the DEFAULT root under %LOCALAPPDATA% can carry one: preflight passed, the
    // sight probe passed, a role was claimed and a supervisor spawned, and then
    // every job failed late as codex-argv-refused with the fault named nowhere
    // near where it could be fixed.
    const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'pct%jobs-'));
    try {
      const brief = writeBrief('briefpctjobs.md', 'quick');
      const d = run(['dispatch', '--brief', brief, '--role', 'pctjobs'], { CODEX_DISPATCH_JOBS: odd });
      assert.notEqual(d.status, 0, 'refused, not dispatched');
      assert.match(d.stderr, /jobs root .*contains one of/, 'and it names the jobs root, not a flag');
      assert.match(d.stderr, /CODEX_DISPATCH_JOBS/, 'and the override that fixes it');
      assert.deepEqual(fs.readdirSync(odd), [],
        'refused before anything was created: no job dir, no role lock, no ghost');

      // Preflight is where an install-level fault belongs, so it says so there too
      // — including under CODEX_DISPATCH_BIN, which short-circuits every other
      // check and would otherwise report a healthy install.
      const p = run(['preflight'], { CODEX_DISPATCH_JOBS: odd });
      assert.notEqual(p.status, 0, 'an install whose every job would fail is not "ok"');
      assert.match(p.stderr, /jobs root .*contains one of/);
    } finally {
      fs.rmSync(odd, { recursive: true, force: true });
    }
  });

test('a refused argv finalizes the record instead of stranding the job',
  { skip: process.platform === 'win32' ? false : 'Windows-only: only Windows builds a command line' },
  async () => {
    // The other half of the same fix. The boundary gate is closed now, but a
    // record written by an OLDER dispatch reaches the supervisor's spawn with the
    // same unquotable value, so the throw has to land somewhere that finalizes.
    // Written straight to disk, which is exactly what an older dispatch left.
    //
    // Two details this test has to get right, both learned by getting them wrong.
    // The cwd must REALLY EXIST and hold a readable file, because the sight probe
    // runs first and a missing directory fails the job as blind long before the
    // argv is built. And `bin` must be the .cmd shim: a `.mjs` is spawned through
    // node with an argv ARRAY, which never touches cmdQuote at all — the shell
    // branch is the only one that builds a command line.
    const odd = fs.mkdtempSync(path.join(os.tmpdir(), 'pct%cwd-'));
    fs.writeFileSync(path.join(odd, 'readable.txt'), 'line one\nenough content to yield a token\n');

    const id = 'argv-1-4242';
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.md'), 'brief');
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      recordVersion: RECORD_VERSION, generation: 1, id, role: 'argv',
      model: 'gpt-5.6-luna', effort: 'medium', sandbox: 'read-only',
      cwd: odd, bin: FAKE_CMD, started: new Date().toISOString(),
      state: 'running', launch: 'spawned', supervisorPid: process.pid,
      codexPid: null, exitCode: null, finished: null,
      allowUnprovenSight: false,
    }));
    // The supervisor re-reads its claim before spawning anything and aborts as
    // `claim-lost` if the role is not still ours — so a hand-written record needs
    // the claim a real dispatch would have taken.
    const lock = path.join(JOBS, '.role-locks', 'argv');
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, 'owner'), id);

    const r = spawnSync(process.execPath, [RUNTIME, '_supervise', dir], {
      env: baseEnv, cwd: REPO, encoding: 'utf8',
    });

    assert.notEqual(r.status, 0, 'the supervisor exits nonzero rather than carrying on');
    const rec = record(id);
    assert.equal(rec.state, 'failed', 'finalized — NOT left saying running for staleness to infer');
    assert.equal(rec.reason, 'codex-argv-refused', 'and it says which refusal, not just that one happened');
    assert.equal(rec.exitCode, -1, 'codex never ran');
    // Sight was PROVEN before the argv was built — which is the point: this is not
    // a blind job wearing a different label, it is a readable cwd whose own name
    // cannot survive a cmd.exe command line.
    assert.match(rec.sight || '', /^cwd-file:/, 'the probe passed; the refusal came later');

    fs.rmSync(odd, { recursive: true, force: true });
  });

test('a --cd that does not exist is refused before a role is claimed or a job dir made', () => {
  // The characters of this path were checked long before anything checked that it
  // EXISTS, so a typo'd --cd claimed the role, built a job dir, spawned a
  // supervisor and only then failed the sight probe — a job dir and a blocked role
  // bought by a one-line mistake. Worse, that failure is the one the post-spawn
  // check used to overwrite: the reproduction in review was exactly this dispatch
  // finishing as `killed(sandbox-blind-precheck)`.
  const missing = path.join(os.tmpdir(), `codex-dispatch-no-such-dir-${process.pid}`);
  assert.equal(fs.existsSync(missing), false, 'the fixture only works if the path really is absent');
  const brief = writeBrief('briefnocd.md', 'quick');

  const before = fs.readdirSync(JOBS);
  const r = run(['dispatch', '--brief', brief, '--role', 'nocd', '--cd', missing]);
  assert.notEqual(r.status, 0, 'a cwd that is not there must be refused, not dispatched into');
  // JSON-quoted, as every path this runtime prints is: a bare one ending in a
  // backslash is unreadable next to the prose around it.
  assert.ok((r.stderr + r.stdout).includes(JSON.stringify(missing)),
    `the refusal must name the path it could not find: ${r.stderr}`);
  assert.match(r.stderr + r.stdout, /does not exist/);
  assert.equal(r.stdout.includes('job: '), false, 'and hand out no job handle');
  assert.deepEqual(fs.readdirSync(JOBS).sort(), before.sort(),
    'nothing was created: no job dir, and no role lock');
  assert.equal(fs.existsSync(path.join(JOBS, '.role-locks', 'nocd')), false,
    'and no claim was taken, so the role is free for the corrected re-run');

  // The other half of the same check: a path that exists and is not a directory.
  // codex is handed it with --cd, so a file is as undispatchable as a hole.
  const file = writeBrief('notadir.txt', 'this is a file, not a directory\n');
  const f = run(['dispatch', '--brief', brief, '--role', 'nocd', '--cd', file]);
  assert.notEqual(f.status, 0, 'a file is not somewhere codex can be run');
  assert.ok((f.stderr + f.stdout).includes(JSON.stringify(file)), f.stderr);
  assert.match(f.stderr + f.stdout, /is not a directory/);
  assert.equal(fs.existsSync(path.join(JOBS, '.role-locks', 'nocd')), false);
});

test('a verdict the supervisor reached while dispatch was still starting is left alone', async () => {
  // THE 0.7.2 CORRUPTION, reproduced from the other side. Between recording
  // `launch: 'spawned'` and re-reading the record, the parent spends real time
  // (`startTimesFor` is half a second of PowerShell on a warm machine) — and a
  // supervisor whose sight precheck fails gets to a terminal state inside it. The
  // check there fired on ANY non-running reading, so the parent killed a pid that
  // was already gone and wrote `killed` over a verdict it never reached: the job
  // finished as `killed(sandbox-blind-precheck)`, a pair the docs call impossible,
  // under a message about a cancel nobody ran.
  //
  // The hold is injected because a real one of these windows is milliseconds wide
  // and cannot be aimed at; the fast verdict is real, and is produced by a codex
  // with no `sandbox` subcommand, which the precheck refuses in well under a
  // second. What is under test is which state the parent treats as a cancel.
  const brief = writeBrief('briefspawnrace.md', 'quick');
  const r = run(['dispatch', '--brief', brief, '--role', 'spawnrace'], {
    CODEX_DISPATCH_TEST_SPAWN_PAUSE_MS: '8000',
    FAKE_CODEX_SANDBOX_UNAVAILABLE: '1',
  });
  assert.equal(r.status, 0,
    `a race the parent lost is not a fact about the job, so the dispatch still succeeds: ${r.stderr}`);
  const id = jobIdFrom(r.stdout);

  const rec = record(id);
  assert.equal(rec.state, 'failed', `the supervisor's own verdict stands: ${JSON.stringify(rec)}`);
  assert.equal(rec.reason, 'sight-unproven', 'and the reason it wrote is still there, unpaired with a kill');
  assert.equal(rec.killSurvivors, undefined, 'nothing was killed, so nothing survived a kill');
  assert.equal(rec.exitCode, null, 'codex never ran');

  // The note is the parent saying what it found and what it did NOT do about it.
  assert.match(r.stderr, /is no longer "running"/);
  assert.match(r.stderr, /its supervisor reached "failed" \(sight-unproven\)/,
    'it names the verdict it deferred to, not a cancel');
  assert.match(r.stderr, /nothing was killed/);
  assert.equal(/was cancelled while it was starting/.test(r.stderr), false,
    'and never reports a cancel nobody ran');

  // Terminal and honestly recorded, so the role really is free again.
  assert.match(run(['list']).stdout, new RegExp(`^${id}  failed\\(sight-unproven\\)`, 'm'));
  const again = run(['dispatch', '--brief', brief, '--role', 'spawnrace']);
  assert.equal(again.status, 0, `the role must have been released: ${again.stderr}`);
  assert.ok(await poll(() => done(jobIdFrom(again.stdout))));
});

test('a kill-failed job keeps its role claim when its supervisor finally exits', async () => {
  // The supervisor used to hand the role back unconditionally once codex exited.
  // `kill-failed` means a cancel could not be verified — this supervisor survived
  // it — and releasing there lets the next dispatch run beside whatever survived.
  // Only `findRoleConflict`'s backstop scan was keeping that promise, so the claim
  // itself is what is asserted here, not merely the refusal it produces.
  const brief = writeBrief('briefkeepclaim.md', 'slow');
  // Long enough that the cancel lands while codex is unmistakably alive, short
  // enough that this test does not sit through a minute: the fake's own exit is
  // what brings the supervisor to the handler under test.
  const r = run(['dispatch', '--brief', brief, '--role', 'keepclaim'], { FAKE_CODEX_SLEEP_MS: '15000' });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => record(id).codexPid), 'the fake must be up before it is cancelled');
  const { supervisorPid } = record(id);

  // A kill that reports success and changes nothing — the same injection the
  // kill-failed tests use. Codex is untouched and runs to its own end, which is
  // what brings the supervisor to the exit handler this test is about.
  const c = run(['cancel', id], { CODEX_DISPATCH_TEST_NOKILL: '1' });
  assert.notEqual(c.status, 0, `a kill that did not take must exit nonzero: ${c.stdout}${c.stderr}`);
  assert.equal(record(id).state, 'kill-failed');

  assert.ok(await poll(() => !pidAlive(supervisorPid), 40000),
    'the supervisor must reach its exit handler, which is where the release decision is made');

  const rec = record(id);
  assert.equal(rec.state, 'kill-failed', 'the exit must not rewrite a verdict it did not reach');
  const owner = path.join(JOBS, '.role-locks', 'keepclaim', 'owner');
  assert.equal(fs.existsSync(owner), true, 'the role lock must still be there');
  assert.equal(fs.readFileSync(owner, 'utf8').trim(), id, 'and must still name this job');
  assert.match(fs.readFileSync(path.join(JOBS, id, 'supervisor.log'), 'utf8'),
    /not releasing the "keepclaim" role/,
    'and the supervisor says so where a human will look');

  const refused = run(['dispatch', '--brief', brief, '--role', 'keepclaim']);
  assert.notEqual(refused.status, 0, 'so a same-role dispatch is still refused');
  assert.match(refused.stderr, /already kill-failed/);
});

test('a pid already reaped is never fired at again, even when the record still names it', async () => {
  // The anti-target list applied to the pid FILES and the record fields walked
  // straight past it — so a cancel whose kill worked and whose record write did
  // not (the case the operator is explicitly told to retry) re-armed the very
  // numbers the last one wrote down as spent. Pid numbers are reused; a replayed
  // kill lands on whatever inherited them.
  //
  // CODEX_DISPATCH_TEST_NOKILL is what makes this decidable without racing a real
  // kill: anything actually TARGETED survives the no-op kill and is reported as a
  // survivor by name. A filtered pid produces a clean `killed`; an unfiltered one
  // cannot.
  const victims = [];
  const spawnVictim = () => {
    const v = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
      stdio: 'ignore', detached: true,
    });
    v.unref();
    victims.push(v.pid);
    return v.pid;
  };
  const mk = (id, patch, extra = () => {}) => {
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      recordVersion: RECORD_VERSION, id, role: id.split('-')[0], state: 'running',
      // An hour ago, with no supervisor pid: past the registration window, so the
      // cancel decides on the targets rather than answering `kill-pending`.
      started: new Date(Date.now() - 3600000).toISOString(),
      supervisorPid: null, codexPid: null, launch: 'exec', ...patch,
    }));
    extra(dir);
    return id;
  };

  try {
    // Both homes of the spent list: one pid written down in the record, one in the
    // reaped.pids file that exists for records which must not be rewritten. Both
    // are ALSO named by the record's own kill-target fields, which is the defect.
    const inRecord = spawnVictim();
    const inFile = spawnVictim();
    const reaped = mk('reapfilter-1-99931',
      { codexPid: inRecord, codexPids: [inRecord, inFile], reapedPids: [inRecord] },
      (dir) => fs.writeFileSync(path.join(dir, 'reaped.pids'), `${inFile}\n`));

    const c = run(['cancel', reaped], { CODEX_DISPATCH_TEST_NOKILL: '1' });
    assert.equal(c.status, 0, `a cancel with nothing left to fire at must succeed: ${c.stderr}`);
    assert.equal(record(reaped).state, 'killed');
    for (const pid of [inRecord, inFile]) {
      assert.equal((c.stdout + c.stderr).includes(String(pid)), false,
        `pid ${pid} is spent, so it may not be named as a target or a survivor`);
      assert.ok(pidAlive(pid), `pid ${pid} was fired at again — the record route bypassed the spent list`);
    }

    // The control, and the reason the assertions above can fail: the identical
    // record with nothing recorded as spent DOES target its pid, and the no-op
    // kill leaves it standing as a named survivor.
    const live = spawnVictim();
    const armed = mk('reaparmed-1-99930', { codexPid: live, codexPids: [live] });
    const a = run(['cancel', armed], { CODEX_DISPATCH_TEST_NOKILL: '1' });
    assert.notEqual(a.status, 0, 'an unreaped pid is a real target, so the no-op kill fails');
    assert.match(a.stderr, /KILL FAILED/);
    assert.ok(a.stderr.includes(String(live)), 'and it is named — which is what the spent list prevents');
    assert.equal(record(armed).state, 'kill-failed');
  } finally {
    for (const pid of victims) { try { process.kill(pid); } catch { /* already gone */ } }
  }
});

test('a bin path under a directory with a cmd.exe token separator still launches',
  { skip: process.platform === 'win32' ? false : 'Windows-only: only Windows builds a command line' },
  async () => {
    // MEASURED IN REVIEW: cmd.exe ends a command token on `,`, `;` and `=` exactly
    // as it does on whitespace, and cmdQuote quoted `& | < > ( ) ^` while leaving
    // those three alone. A `.cmd` under `to,ols\` was therefore handed over
    // unquoted and read as two tokens — "is not recognized", or worse, a resolved
    // bin path silently becoming a different one.
    //
    // The .cmd shim is the only spawn path that builds a command line at all: a
    // `.mjs` goes through node with an argv ARRAY and never touches cmdQuote.
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-sep-'));
    const dir = path.join(parent, 'to,ols;x=y');
    fs.mkdirSync(dir);
    for (const name of ['fake-codex.cmd', 'fake-codex.mjs']) {
      fs.copyFileSync(path.join(HERE, name), path.join(dir, name));
    }
    try {
      const brief = writeBrief('briefsepdir.md', 'quick');
      const r = run(['dispatch', '--brief', brief, '--role', 'sepdir'],
        { CODEX_DISPATCH_BIN: path.join(dir, 'fake-codex.cmd') });
      assert.equal(r.status, 0, r.stderr);
      const id = jobIdFrom(r.stdout);
      // Reaching `done` is the whole assertion: the sight probe and the exec both
      // go through cmd.exe with this path on the command line, and an unquoted one
      // never runs at all.
      assert.ok(await poll(() => record(id).state !== 'running', 30000),
        'the job must finish rather than hang');
      assert.equal(record(id).state, 'done',
        `a separator in the bin path must not change which binary runs: ${JSON.stringify(record(id))}`);
      assert.equal(run(['result', id]).status, 0, 'and the answer is deliverable');
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

test('clean removes finished jobs, refuses live ones, and never leaves the jobs root', async () => {
  // Nothing ever removed a job directory: every dispatch left one behind for
  // ever, run.log and all, until somebody deleted the tree by hand — which is
  // the one operation this runtime works hardest to make unsafe to do by hand.
  // `clean` is that operation, done through the same invariants: the id
  // whitelist, the junction refusal, the containment assert, and the record lock.
  const room = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-clean-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-clean-outside-'));
  const env = { CODEX_DISPATCH_JOBS: room };
  const mk = (id, patch) => {
    const dir = path.join(room, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      recordVersion: RECORD_VERSION, id, role: id.split('-')[0],
      started: new Date(Date.now() - 10 * 86400000).toISOString(),
      supervisorPid: null, codexPid: null, ...patch,
    }));
    fs.writeFileSync(path.join(dir, 'out.txt'), 'answer\n');
    return dir;
  };
  let linked = false;
  const link = path.join(room, 'linked-1-99902');
  try {
    const old = new Date(Date.now() - 9 * 86400000).toISOString();
    const fresh = new Date().toISOString();
    mk('donejob-1-99901', { state: 'done', exitCode: 0, finished: old, sight: 'cwd-file:LICENSE' });
    mk('failjob-1-99903', { state: 'failed', reason: 'sight-unproven', finished: old });
    mk('killjob-1-99904', { state: 'killed', finished: old });
    mk('freshjob-1-99905', { state: 'done', exitCode: 0, finished: fresh, sight: 'cwd-file:LICENSE' });
    // Every live state, one job each: none of them may be removed by any flag.
    mk('runjob-1-99906', { state: 'running', supervisorPid: process.pid, started: fresh });
    mk('stalejob-1-99907', { state: 'running', supervisorPid: 999999999 });
    mk('pendjob-1-99908', { state: 'kill-pending' });
    mk('kfjob-1-99909', { state: 'kill-failed', killSurvivors: '4242' });
    mk('unkjob-1-99910', { state: 'cancelling' });
    // A corrupt record is evidence, not litter.
    const corrupt = path.join(room, 'corruptjob-1-99911');
    fs.mkdirSync(corrupt, { recursive: true });
    fs.writeFileSync(path.join(corrupt, 'job.json'), '{ not json');
    // And a junction named like a job id, pointing at something precious.
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'do not touch\n');
    fs.writeFileSync(path.join(outside, 'job.json'), JSON.stringify({
      recordVersion: RECORD_VERSION, id: 'linked-1-99902', role: 'linked', state: 'done',
      exitCode: 0, sight: 'cwd-file:LICENSE', started: old, finished: old,
    }));
    try { fs.symlinkSync(outside, link, 'junction'); linked = true; } catch { /* reported below */ }

    // With no flag it removes NOTHING and says what to type: an explicit ask for
    // a verb that deletes, rather than a default that does.
    const bare = run(['clean'], env);
    assert.notEqual(bare.status, 0, 'a verb that deletes must not have a default');
    assert.match(bare.stderr, /--all/);
    assert.match(bare.stderr, /--older-than/);
    assert.equal(fs.existsSync(path.join(room, 'donejob-1-99901')), true, 'and it removed nothing');

    // An age filter takes only what is old enough, and only what is terminal.
    const aged = run(['clean', '--older-than', '5'], env);
    assert.equal(aged.status, 0, aged.stderr);
    for (const id of ['donejob-1-99901', 'failjob-1-99903', 'killjob-1-99904']) {
      assert.match(aged.stdout, new RegExp(`^removed: ${id}$`, 'm'), `${id} is terminal and old`);
      assert.equal(fs.existsSync(path.join(room, id)), false, `${id} must be gone from disk`);
    }
    assert.equal(fs.existsSync(path.join(room, 'freshjob-1-99905')), true,
      'a job younger than the cutoff stays');

    // --all takes the rest of the terminal ones and NONE of the live ones.
    const all = run(['clean', '--all'], env);
    assert.equal(all.status, 0, all.stderr);
    assert.equal(fs.existsSync(path.join(room, 'freshjob-1-99905')), false, 'the fresh done job goes now');
    for (const [id, why] of [
      ['runjob-1-99906', 'running'], ['stalejob-1-99907', 'stale'],
      ['pendjob-1-99908', 'kill-pending'], ['kfjob-1-99909', 'kill-failed'],
      ['unkjob-1-99910', 'unknown'], ['corruptjob-1-99911', 'corrupt'],
    ]) {
      assert.equal(fs.existsSync(path.join(room, id)), true,
        `${id} is ${why} — it may still own processes, or it is the only evidence of how it broke`);
      assert.match(all.stdout, new RegExp(`^  ${id}  ${why}`, 'm'), `and clean says so: ${id}`);
    }
    if (linked) {
      assert.equal(fs.existsSync(link), true, 'a junction named like a job id is refused, not removed');
      assert.match(all.stdout, /linked-1-99902\s+refused: not a job directory/);
      assert.deepEqual(fs.readdirSync(outside).sort(), ['job.json', 'precious.txt'],
        'and NOTHING outside the jobs root is touched — that is the whole point of the refusal');
    }
    // --force is not a way past the taxonomy either: there is no such flag here.
    const forced = run(['clean', '--all', '--force'], env);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(fs.existsSync(path.join(room, 'kfjob-1-99909')), true,
      'a live state is live whatever flags are passed');

    // A REMOVAL THAT CANNOT FINISH MUST STAY VISIBLE, AND MUST NOT END THE RUN.
    // Two things matter when one fails: the job keeps its job.json — without one
    // `allJobs` cannot see the directory at all, so a record removed first would
    // leave a tree nothing could ever list or clean again — and the other job in
    // the same run is still removed rather than the whole clean aborting on a
    // throw out of the lock.
    //
    // The blocker is a live process whose CWD is a directory inside the job dir.
    // An open file handle is not one: libuv opens with FILE_SHARE_DELETE, so the
    // unlink succeeds. A cwd is what an antivirus scan, a shell somebody left
    // sitting in the folder, or a watcher process really looks like, and Windows
    // refuses to remove it (EPERM) for as long as it is one.
    //
    // ITS NAME SORTS AFTER `job.json`, and that is the whole point of the
    // fixture rather than an accident of it: a plain recursive rm walks the
    // directory in readdir order, so a blocker named earlier fails before the
    // record is reached and this test would pass against the defect. Every real
    // blocker sorts later — `out.txt`, `run.log`, `supervisor.log` all do — which
    // is exactly why the record has to be removed last deliberately.
    const stuckDir = mk('stuckjob-1-99912', { state: 'done', exitCode: 0, finished: old, sight: 'cwd-file:LICENSE' });
    const busy = path.join(stuckDir, 'zz-busy');
    fs.mkdirSync(busy);
    mk('alsojob-1-99913', { state: 'done', exitCode: 0, finished: old, sight: 'cwd-file:LICENSE' });
    const sitting = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'],
      { cwd: busy, stdio: 'ignore', detached: true });
    sitting.unref();
    let stuck;
    try {
      await poll(() => pidAlive(sitting.pid), 5000, 50);
      stuck = run(['clean', '--all'], env);
    } finally {
      try { process.kill(sitting.pid); } catch { /* already gone */ }
    }
    assert.equal(stuck.status, 0, stuck.stderr);
    assert.match(stuck.stdout, /^removed: alsojob-1-99913$/m,
      'one stuck file must not abort the run for every other job');
    if (fs.existsSync(stuckDir)) {
      assert.equal(fs.existsSync(path.join(stuckDir, 'job.json')), true,
        'the record is removed LAST, so a partial removal stays visible and retryable');
      assert.match(stuck.stdout, /stuckjob-1-99912\s+could not be removed/,
        'and clean says which job and why');
      assert.match(stuck.stderr, /WARNING: 1 job directory could not be removed/);
      assert.match(run(['list'], env).stdout, /^stuckjob-1-99912  done/m,
        'it still lists — which is what makes "clean it again" a real cure');
      // And once nothing is sitting in it, it really is retryable.
      assert.ok(await poll(() => !pidAlive(sitting.pid), 10000), 'the blocker must be gone first');
      const retry = run(['clean', '--all'], env);
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(fs.existsSync(stuckDir), false, 'the retry finishes what the first run could not');
    } else {
      // A platform that lets a process's cwd be removed underneath it (POSIX
      // does) removes it cleanly. Say so rather than assert nothing.
      process.stderr.write('NOTE: this platform allowed the removal of a directory in use; ' +
        'the partial-failure half of the clean test did not fire.\n');
      assert.match(stuck.stdout, /^removed: stuckjob-1-99912$/m);
    }
  } finally {
    if (linked) { try { fs.unlinkSync(link); } catch { fs.rmSync(link, { recursive: true, force: true }); } }
    fs.rmSync(room, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// A dispatch held in its post-spawn window, so the record can be moved
// underneath it. Shared by the two blocks below because the fixture is the whole
// setup: the window is milliseconds wide in reality and cannot be aimed at.
function dispatchPaused(brief, role, pauseMs, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNTIME, 'dispatch', '--brief', brief, '--role', role], {
      env: { ...baseEnv, CODEX_DISPATCH_TEST_SPAWN_PAUSE_MS: String(pauseMs), ...env },
      cwd: REPO,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('the dispatch that spawned a job may not write over a verdict reached while it paused',
  async () => {
    // THE ONE WRITER IN THE KILL SEAM THAT NEVER HAD ITS COMPARE-AND-SWAP — and
    // the runtime's own docs said for a release that it did. The post-spawn check
    // reads the record once, then spends the seconds a verified kill costs, then
    // writes `killed` or `kill-failed`. Anything that reached a verdict in
    // between was overwritten, the role was released on the strength of it, and
    // the message announced a kill this dispatch had not made.
    //
    // The verdict is a `killed` a cancel landed while this dispatch was starting
    // — which is a state a CANCEL writes, so the branch really is entered — and
    // it is written during the injected hold, deterministically, rather than
    // raced.
    // A codex that is still running through the whole hold, deliberately: with a
    // fast one the supervisor reaches its own exit handler inside the window and
    // releases the role on the terminal verdict it finds — legitimately, being
    // the process that owns that decision — and the claim assertion below could
    // then be measuring the wrong writer.
    const brief = writeBrief('briefpostspawncas.md', 'slow');
    const dispatching = dispatchPaused(brief, 'postspawn', 9000, { FAKE_CODEX_SLEEP_MS: '60000' });
    const findDir = () => fs.readdirSync(JOBS).find((n) => n.startsWith('postspawn-'));
    assert.ok(await poll(() => findDir() && record(findDir()).supervisorPid, 20000),
      'the dispatch must have registered its supervisor before the hold');
    const id = findDir();
    const supervisorPid = record(id).supervisorPid;
    const verdict = {
      ...record(id),
      state: 'killed',
      reason: 'cancelled-during-registration',
      finished: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(JOBS, id, 'job.json'), JSON.stringify(verdict));

    const d = await dispatching;
    assert.notEqual(d.code, 0, 'a job that was cancelled while starting is still a failed dispatch');
    const rec = record(id);
    assert.equal(rec.state, 'killed', `the verdict stands: ${JSON.stringify(rec)}`);
    assert.equal(rec.reason, 'cancelled-during-registration',
      'with the reason its writer paired with it');
    assert.equal(rec.killSurvivors, undefined, 'and no kill bookkeeping written over it');
    // The half that costs money when it is wrong: the writer of that verdict owns
    // the release decision too, so this dispatch may not make it.
    const owner = path.join(JOBS, '.role-locks', 'postspawn', 'owner');
    assert.equal(fs.existsSync(owner), true, 'the role claim is NOT released by a dispatch that lost');
    assert.equal(fs.readFileSync(owner, 'utf8').trim(), id, 'and still names this job');
    assert.match(d.stderr, /reached "killed"/, 'the message reports the verdict it found');
    // What it says is what it KNOWS: this dispatch released nothing. It may not
    // claim the claim is still held — the cancel that wrote that verdict owns
    // the release decision and may already have made it.
    assert.match(d.stderr, /this dispatch released\nnothing/,
      'and says only what it did itself');
    assert.equal(/killed and verified dead/.test(d.stderr), false,
      'never a claim about a kill it recorded');
    assert.ok(await poll(() => !pidAlive(supervisorPid), 20000),
      'the supervisor is still killed — the verdict is about the record, not about what is alive');
    for (const pid of [supervisorPid, ...(record(id).codexPids || [])].filter(Boolean)) {
      try { process.kill(pid); } catch { /* the tree kill took it */ }
    }
    fs.rmSync(path.join(JOBS, '.role-locks', 'postspawn'), { recursive: true, force: true });
  });

test('the post-spawn kill fires through the reaped-pid list like every other kill', async () => {
  // Every kill target in this runtime is filtered through the numbers already
  // fired at — the record fields, the pid files, all of them — because a pid is
  // reissued and a replayed kill lands on whatever inherited it. This one branch
  // fired `child.pid` unfiltered.
  //
  // Decidable because the supervisor is ALIVE and stays that way: a targeted pid
  // would be killed and verified, a filtered one is left standing.
  const brief = writeBrief('briefpostspawnreaped.md', 'slow');
  const dispatching = dispatchPaused(brief, 'postreap', 12000, { FAKE_CODEX_SLEEP_MS: '60000' });
  const findDir = () => fs.readdirSync(JOBS).find((n) => n.startsWith('postreap-'));
  let id, supervisorPid;
  try {
    // Wait for the supervisor to be past its own last check (codex launched), so
    // that writing a cancel-shaped state below cannot make it land the cancel
    // itself — this test is about what the DISPATCH does with that state.
    assert.ok(await poll(() => findDir() && record(findDir()).launch === 'exec', 20000),
      'codex must be running before the record is moved');
    id = findDir();
    supervisorPid = record(id).supervisorPid;
    fs.writeFileSync(path.join(JOBS, id, 'job.json'), JSON.stringify({
      ...record(id),
      // Cancel-shaped and still LIVE, so the branch is entered and its write
      // keeps its precondition — and the supervisor does not land it (only
      // kill-pending is landed there).
      state: 'kill-failed',
      killSurvivors: String(supervisorPid),
      reapedPids: [supervisorPid],
    }));

    const d = await dispatching;
    assert.notEqual(d.code, 0);
    assert.equal(d.stdout.includes(String(supervisorPid)), false,
      'a spent pid may not be named as a target');
    assert.equal(d.stderr.includes(String(supervisorPid)), false,
      'nor as a survivor of a kill it was never fired at');
    assert.ok(pidAlive(supervisorPid),
      `pid ${supervisorPid} was recorded as reaped and was fired at anyway`);
    const rec = record(id);
    assert.equal(rec.state, 'killed', 'with nothing left to fire at, the kill is verified and recorded');
    // The state it wrote over was a `kill-failed` carrying a survivor list. A
    // `killed` record that keeps one makes `result` and `status` report
    // survivors of a kill that verified.
    assert.equal(rec.killSurvivors, undefined,
      'and the earlier kill-failed survivor list is cleared, not carried into a verified death');
  } finally {
    for (const pid of [supervisorPid, ...(id ? (record(id).codexPids || []) : [])].filter(Boolean)) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    fs.rmSync(path.join(JOBS, '.role-locks', 'postreap'), { recursive: true, force: true });
  }
});

test('the supervisor landing a cancel may not write over a verdict either', async () => {
  // THE SAME RULE, ONE WRITER TO THE LEFT. The supervisor reads the record
  // before a kill that spends seconds in a shell, and it is not the only writer
  // looking at that cancel-shaped record: the dispatch that spawned it sees the
  // same state, kills THIS process, records `killed` and releases the role. The
  // landing write carried no precondition, so it went straight over that verdict
  // — a `kill-failed(cancelled-during-exec)` record whose role was already free.
  //
  // The supervisor is held inside the codex-exec window while the verdict is
  // written, so the interleaving is posed rather than raced. The role claim is
  // left in place deliberately: in the real race the dispatch has already
  // released it, and what is under test is that this supervisor does not make
  // that decision a second time.
  const brief = writeBrief('briefexecverdict.md', 'slow');
  const r = run(['dispatch', '--brief', brief, '--role', 'execverdict'], {
    FAKE_CODEX_SLEEP_MS: '60000',
    CODEX_DISPATCH_TEST_EXEC_PAUSE_MS: '8000',
  });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  const dir = path.join(JOBS, id);
  try {
    assert.ok(await poll(() => record(id).launch === 'exec-spawning', 20000),
      'the supervisor must be inside the codex-exec window');
    const verdict = {
      ...record(id),
      state: 'killed',
      reason: 'cancelled-during-registration',
      finished: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(verdict));

    // The landing is over when the supervisor is: it kills codex, decides what
    // it may write, and exits. Reading before that is reading mid-decision.
    const supervisorPid = record(id).supervisorPid;
    assert.ok(await poll(() => record(id).launch === 'exec', 20000),
      'the supervisor must come out of the window and land the cancel');
    assert.ok(await poll(() => !pidAlive(supervisorPid), 30000), 'and then exit');
    // It kills codex either way — the verdict is about the RECORD, not about
    // what is alive.
    assert.equal((record(id).codexPids || []).some(pidAlive), false,
      'codex is still killed for the cancel it found');

    const rec = record(id);
    assert.equal(rec.state, 'killed', `the verdict stands: ${JSON.stringify(rec)}`);
    assert.equal(rec.reason, 'cancelled-during-registration',
      'not overwritten with this supervisor\'s own cancelled-during-exec');
    assert.equal(rec.killSurvivors, undefined);
    // Both places a human looks: the job's own transcript and the supervisor's
    // diagnostics, which is where its stderr lands.
    const logs = ['run.log', 'supervisor.log']
      .map((f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } })
      .join('\n');
    assert.match(logs, /released no role claim/, 'and it says what it did not do, where a human looks');
    assert.match(logs, /already reached "killed"/, 'naming the verdict it found');
    const owner = path.join(JOBS, '.role-locks', 'execverdict', 'owner');
    assert.equal(fs.existsSync(owner), true,
      'the claim is not released twice: the writer of the verdict owns that decision');
    assert.equal(fs.readFileSync(owner, 'utf8').trim(), id);
  } finally {
    for (const pid of [record(id).supervisorPid, ...(record(id).codexPids || [])].filter(Boolean)) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    fs.rmSync(path.join(JOBS, '.role-locks', 'execverdict'), { recursive: true, force: true });
  }
});

test('a kill nothing could enumerate is not a verified kill', async () => {
  // `killPids` has always reported `enumerated: false` when neither shell would
  // answer, and only cancel's corrupt-record branch ever read it — so everywhere
  // else "the process table could not be read" was silently "there was nothing
  // there": a verified `killed`, a released role, and the codex behind a .cmd
  // wrapper (a DESCENDANT, which is exactly what an enumeration finds) never
  // checked at all.
  //
  // The unreadable table is injected: a host whose PowerShell will not run is
  // not producible in CI, and what is under test is the decision made about it.
  const id = 'noenum-1-99940';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
    stdio: 'ignore', detached: true,
  });
  victim.unref();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'noenum', state: 'running',
    started: new Date(Date.now() - 3600000).toISOString(),
    supervisorPid: victim.pid, codexPid: null, launch: 'exec',
  }));
  try {
    const c = run(['cancel', id], { CODEX_DISPATCH_TEST_NO_PROCESS_TABLE: '1' });
    assert.notEqual(c.status, 0, 'a kill that verified nothing must not exit 0');
    assert.match(c.stderr, /KILL NOT VERIFIED/);
    assert.match(c.stderr, /process table/, 'and it names what could not be read');
    assert.equal(/these pids survived/.test(c.stderr), false,
      'it must not name survivors nobody enumerated');

    const rec = record(id);
    assert.equal(rec.state, 'kill-failed', `kill-failed, NOT killed: ${JSON.stringify(rec)}`);
    assert.equal(rec.killSurvivors, undefined, 'nothing was seen to survive, so nothing is listed');
    assert.match(rec.warning, /process table/, 'the record says why it could not be verified');
    // The signals really were sent — this is a verification failure, not a
    // refusal to try.
    assert.ok(await poll(() => !pidAlive(victim.pid)), 'the targets were still signalled');
    // And the state that says so keeps blocking the role, which is the point.
    const brief = writeBrief('briefnoenum.md', 'quick');
    const blocked = run(['dispatch', '--brief', brief, '--role', 'noenum']);
    assert.notEqual(blocked.status, 0, 'an unverified kill keeps its role blocked');
    assert.match(blocked.stderr, /already kill-failed/);
  } finally {
    try { process.kill(victim.pid); } catch { /* already gone */ }
  }
});

test('a corrupt job whose kill could not be enumerated keeps its pid files loaded', async () => {
  // A CORRUPT RECORD'S PID FILES ARE THE ONLY KILL TARGETS IT HAS — job.json is
  // evidence and may never be rewritten, so there is no state to move and nothing
  // else to fire at next time. This branch used to warn that the process table
  // could not be read and then consume them anyway, exiting 0: the retry the
  // warning asked for read "already reaped" and fired at nothing, while whatever
  // was behind those pids — a codex, if this job had one — was never enumerated at
  // all. Every other writer in the kill seam already treats `enumerated: false` as
  // a failed verification; this one now does too.
  //
  // The unreadable table is injected, as it is everywhere else in this file: a host
  // whose PowerShell will not run is not producible in CI, and what is under test
  // is the decision made about it.
  const id = 'corruptenum-1-99953';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  const raw = '{"state":"running", TRUNCATED';
  fs.writeFileSync(path.join(dir, 'job.json'), raw);
  const victim = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
    stdio: 'ignore', detached: true,
  });
  victim.unref();
  fs.writeFileSync(path.join(dir, 'codex.pid'), `${victim.pid}\n`);
  try {
    const first = run(['cancel', id], { CODEX_DISPATCH_TEST_NO_PROCESS_TABLE: '1' });
    assert.notEqual(first.status, 0, 'a kill nothing could verify must not exit 0');
    assert.match(first.stderr, /KILL NOT VERIFIED/);
    assert.match(first.stderr, /pid files stay loaded; re-run cancel when the process table answers\./,
      'and it says exactly what it left behind for the retry');
    assert.equal(fs.existsSync(path.join(dir, 'codex.pid')), true,
      'the only target this job has is still loaded');
    assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('codex.pid.reaped-')), false,
      'nothing was spent on a sweep nothing witnessed');
    assert.equal(first.stdout.includes('consumed pid files'), false,
      'and the cancel does not claim to have spent it');
    assert.equal(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'), raw,
      'the corrupt record is evidence — cancel must not overwrite it');
    // The signals really were sent: this is a verification failure, not a refusal
    // to try, which is why the retry below has a DEAD pid to verify.
    assert.ok(await poll(() => !pidAlive(victim.pid)), 'the recorded pid was still signalled');

    // And the retry the message asks for is a real cure, because it still has a
    // number to fire at. Before the fix it read "already reaped".
    const second = run(['cancel', id]);
    assert.equal(second.status, 0, `with a readable table the same kill verifies: ${second.stderr}`);
    assert.match(second.stdout, new RegExp(`killed recorded pids: ${victim.pid}`),
      'the number was still there to be fired at');
    assert.match(second.stdout, /consumed pid files: codex\.pid\.reaped-/,
      'and only a verified kill spends it');
    assert.equal(fs.existsSync(path.join(dir, 'codex.pid')), false);
  } finally {
    try { process.kill(victim.pid); } catch { /* already gone */ }
  }
});

test('a kill-pending that could not be written is never reported as one', async () => {
  // `lostToVerdict` answers null for a write that could not take the lock and for
  // one that found a corrupt record, exactly as it does for a write that
  // SUCCEEDED — so `markPending` read a failed write as a mark, `cancel`
  // announced "the state is kill-pending", and the launch-block that state exists
  // to arm was not armed. A state nobody wrote, reported as fact.
  //
  // The lock is held by a live process this test names as the holder, which is
  // also the other half of the fixture: a lock whose holder is alive is not
  // stale however old it gets, so the write really does time out rather than
  // breaking in after five seconds.
  const id = 'unrecpend-1-99941';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'unrecpend', state: 'running',
    // Inside the supervisor-registration window, with nothing recorded to kill:
    // the path whose only outcome is a mark.
    started: new Date().toISOString(), supervisorPid: null, codexPid: null,
    launch: 'spawning',
  }));
  const lock = path.join(dir, 'job.json.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'holder'), `${process.pid}\n`);
  try {
    const c = run(['cancel', id]);
    assert.notEqual(c.status, 0, 'a cancel that recorded nothing must not exit 0');
    assert.match(c.stderr, /KILL NOT RECORDED/);
    assert.match(c.stderr, /NOTHING was killed/,
      'and it must not borrow the sentence about processes killed and verified dead');
    assert.equal(/KILL PENDING/.test(c.stderr), false, 'no state is announced that was not written');
    assert.equal(record(id).state, 'running',
      'the record is exactly as it was: the mark never reached it');
    // The live holder kept its lock for the whole wait — the age-only break would
    // have taken it after five seconds and written the mark.
    assert.equal(fs.existsSync(path.join(lock, 'holder')), true,
      'a lock whose holder is alive is not stale, however old it is');
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('a live holder stalled past the stale age keeps the record lock', async () => {
  // The other side of the same rule, with a REAL writer rather than a named
  // holder: the lock's mtime is never refreshed, so a writer descheduled inside
  // its critical section for longer than five seconds used to lose mutual
  // exclusion — the breaker read the record, wrote, and then the resumed holder
  // wrote from its own earlier read, over the top. The pause is injected because
  // a stall of a chosen length is not producible on demand.
  const id = 'lockhold-1-99942';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'lockhold', state: 'running',
    // An hour old with nothing to kill: the first cancel takes the kill path,
    // which writes under the lock TWICE — the `kill-pending` fence that arms the
    // supervisor's launch block, then the verdict — and the injected pause fires
    // on each of them. Six seconds is past the five-second stale age (which is
    // the point: a live holder stalled that long is still not evictable) and the
    // two writes together are twelve, inside the fifteen-second lock wait the
    // second cancel gets, with three seconds of margin. Eight seconds a write
    // would be sixteen, and the second cancel would time out on the arithmetic
    // rather than on anything this test is about.
    started: new Date(Date.now() - 3600000).toISOString(),
    supervisorPid: null, codexPid: null, launch: 'exec',
  }));
  const cancelling = (env, ms = 0) => new Promise((resolve) => setTimeout(() => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [RUNTIME, 'cancel', id], { env: { ...baseEnv, ...env }, cwd: REPO });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: Date.now() - t0 }));
  }, ms));

  const [held, second] = await Promise.all([
    cancelling({ CODEX_DISPATCH_TEST_RECORD_PAUSE_MS: '6000' }),
    cancelling({}, 1000),
  ]);
  assert.equal(held.code, 0, `the stalled writer still completes its write: ${held.stderr}`);
  assert.match(held.stdout, new RegExp(`^killed: ${id}$`, 'm'));
  // The second cancel had to WAIT — and then decide on the record the first one
  // had finished writing, which is what serialization means. Breaking in at five
  // seconds made it read the pre-write record and announce a kill of its own.
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /is already killed, nothing to kill/,
    'the second writer decides on the finished record, not on the one it broke into');
  assert.ok(second.ms > 5000, `it waited rather than breaking the lock (took ${second.ms}ms)`);
});

test('a holderless lock is broken, and a staging orphan is never the lock', () => {
  // ACQUISITION IS A RENAME NOW, because `mkdir` then write is two steps and the
  // gap between them is a lock with nothing inside it: a second writer stats it
  // past the stale age, finds no holder to prove alive, breaks in — and the
  // creator, merely descheduled, writes its pid into the BREAKER's fresh directory
  // at the same path. So the holder file is assembled inside a staging directory
  // and the rename of that directory onto the lock path is the acquisition.
  //
  // Two artifacts follow from that, and this pins both:
  //
  // (c) A HOLDERLESS LOCK IS NO LONGER A LIVE ACQUIRER — it can only be a
  //     pre-upgrade artifact or a corrupt directory — and past the stale age it is
  //     still broken, because neither may wedge a job for ever. Make the break
  //     require a readable holder and this cancel waits out its fifteen seconds
  //     and records nothing.
  //
  // (a) A STAGING DIRECTORY IS NOT THE LOCK. It is a live holder's pid inside a
  //     directory that sorts beside `job.json.lock`, and it must neither block an
  //     acquisition nor outlive its acquirer: this one names a pid that IS alive
  //     (the test runner's), so a runtime that mistook the path for the lock would
  //     find it held for ever, and one that never swept would leave it on disk.
  const id = 'lockart-1-99951';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'lockart', state: 'running',
    started: new Date(Date.now() - 3600000).toISOString(),
    supervisorPid: null, codexPid: null, launch: 'exec',
  }));
  const old = new Date(Date.now() - 60000);
  const lock = path.join(dir, 'job.json.lock');
  fs.mkdirSync(lock);
  fs.utimesSync(lock, old, old);
  const orphan = path.join(dir, 'job.json.lock.staging-424242-abcdef');
  fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, 'holder'), `${process.pid}\n`);
  fs.utimesSync(orphan, old, old);

  const t0 = Date.now();
  const c = run(['cancel', id]);
  assert.equal(c.status, 0, `the artifacts must not wedge the job: ${c.stderr}`);
  assert.ok(Date.now() - t0 < 12000,
    'and it must break in rather than wait out the lock timeout');
  assert.equal(record(id).state, 'killed', 'the write really went through the lock');
  assert.equal(fs.existsSync(orphan), false,
    'the staging orphan is swept once it is older than any acquisition in flight could be');
  assert.equal(fs.existsSync(lock), false, 'and the lock this cancel took is released behind it');
});

test('a record lock that changed hands is not removed by the writer that finished', async () => {
  // RELEASE BY IDENTITY, NOT BY PATH. `rmSync` on the lock path removes whatever
  // is there — and after a legitimate stale break that is somebody ELSE's lock, so
  // the writer that finishes first deletes the directory another writer is still
  // working under, reopening the lost-update window this lock exists to close.
  //
  // The hand-over is posed rather than raced: the cancel is held inside its
  // critical section (the same injected pause the stalled-holder test uses) and the
  // holder file is rewritten to name a DIFFERENT live pid — this test runner's.
  // What the release must then do is nothing at all.
  const id = 'lockident-1-99952';
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'lockident', state: 'running',
    // The codex-exec window: exactly one locked write on this path, so the pause
    // fires once and the hand-over cannot land against the wrong one.
    started: new Date().toISOString(),
    supervisorPid: null, codexPid: null, launch: 'exec-spawning',
  }));
  const lock = path.join(dir, 'job.json.lock');
  const holder = path.join(lock, 'holder');
  try {
    const c = cancelling(id, { CODEX_DISPATCH_TEST_RECORD_PAUSE_MS: '6000' });
    assert.ok(await poll(() => fs.existsSync(holder), 20000),
      'the cancel must be holding the lock before it is taken from it');
    const mine = `${process.pid}\n`;
    // The PID, not the whole line: a holder is `pid nonce` now (see the holder-line
    // test below), so comparing the trimmed line against a bare pid could never
    // match and the check stopped discriminating anything the day the nonce landed.
    assert.notEqual(fs.readFileSync(holder, 'utf8').trim().split(' ')[0], String(process.pid),
      'the lock it took names ITS pid — otherwise this test proves nothing');
    fs.writeFileSync(holder, mine);

    const done = await c;
    assert.notEqual(done.code, 0, 'nothing was killed in the exec window, as ever');
    assert.match(done.stderr, /KILL PENDING/);
    assert.equal(record(id).state, 'kill-pending', 'and its write still landed');
    assert.equal(fs.existsSync(lock), true,
      'the lock it no longer holds is NOT its to remove — its own holder releases it');
    assert.equal(fs.readFileSync(holder, 'utf8'), mine, 'and it is untouched, holder and all');
    // AND IT WAS NEVER MOVED EITHER. Releasing is a rename to a tombstone now,
    // and the identity test still comes first: a release that renamed and then
    // asked would have taken this live lock off its path for as long as the
    // self-check took, which is the holderless-lock window the staged
    // acquisition exists to make impossible.
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('job.json.lock.stale-')), [],
      'a lock that is not ours is not ours to MOVE, not merely not ours to delete');
    assert.equal(/was NOT this writer's by the time it was released/.test(done.stderr), false,
      'and the release has nothing to report: it asked before it moved, so it never found out'
      + ' the hard way that what it was holding had changed hands');
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

// ------------------------------------------------------- record-lock fixtures
//
// The lock tests below fabricate the artifacts a crashed or descheduled writer
// leaves behind — a lock, a staging directory, a break tombstone — and then run
// REAL cancels against them. Shared here because the four of them differ only in
// which artifact is planted and how old it is.
const DEAD_PID = 424242; // ESRCH on every platform this suite runs on
const lockPathOf = (dir) => path.join(dir, 'job.json.lock');
const holderOf = (p) => path.join(p, 'holder');

function lockJob(id, role, extra = {}) {
  const dir = path.join(JOBS, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role, state: 'running',
    started: new Date().toISOString(), supervisorPid: null, codexPid: null,
    launch: 'spawning', ...extra,
  }));
  return dir;
}

// A lock-shaped directory: `holder` is a pid to write inside it, or null for the
// holderless artifact. Never assembled in place by the runtime — that is what the
// staging rename exists to prevent — so a test that wants one builds it directly.
function lockLike(p, holder) {
  fs.mkdirSync(p, { recursive: true });
  if (holder !== null) fs.writeFileSync(holderOf(p), `${holder}\n`);
  return p;
}

// Older than any acquisition in flight could be (the stale age is five seconds).
function aged(p) {
  const t = new Date(Date.now() - 60000);
  fs.utimesSync(p, t, t);
  return p;
}

const tombsIn = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('job.json.lock.stale-'));

test('a record lock whose holder cannot be READ is not broken, however old it is', () => {
  // ENOENT ALONE IS "NO HOLDER". `lockHolderLives` used to answer null — no
  // evidence, let the clock decide — for every failed read of the holder file,
  // which hands the age-only break to any transient EBUSY, EPERM, EIO or ACL on a
  // LIVE holder's file: the one reading that must never authorize a break is the
  // one that failed. Now only ENOENT is absence; anything else is a holder that
  // exists and could not be read, and an unreadable holder answers ALIVE.
  //
  // Unreadable on Windows without an ACL: the holder is a DIRECTORY of that name,
  // so `readFileSync` raises EISDIR — a real non-ENOENT error out of the real
  // call, not an injected one. The genuine-absence half of the rule (a holderless
  // lock IS broken) is pinned by the staging-artifact test above; this is the
  // other half, and the two together are the whole of the rule.
  const id = 'lockunread-1-99961';
  const dir = lockJob(id, 'lockunread');
  const lock = aged(lockLike(lockPathOf(dir), null));
  fs.mkdirSync(holderOf(lock));
  try {
    const t0 = Date.now();
    const c = run(['cancel', id]);
    // Non-vacuity (observed): with `lockHolderLives`'s unreadable branch reverted
    // to null, this cancel CONDEMNS the lock and renames it away — the last
    // assertion below fails on the hand-over warning that follows. The lock still
    // survives, because `tombIsCondemned` refuses to remove a tombstone whose
    // evidence was unreadable and puts it back; that is the second line of
    // defence doing its job, and it is not this rule.
    assert.notEqual(c.status, 0, `a lock that could not be proved dead must not be broken: ${c.stderr}`);
    assert.match(c.stderr, /KILL NOT RECORDED/);
    assert.ok(Date.now() - t0 > 10000,
      'the cancel waited out its lock timeout rather than breaking in at five seconds');
    assert.equal(record(id).state, 'running', 'and it wrote nothing under a lock it never held');
    assert.equal(fs.existsSync(lock), true, 'the lock is exactly where it was');
    assert.equal(fs.statSync(holderOf(lock)).isDirectory(), true,
      'holder and all — nothing here was removed, renamed or read past');
    assert.deepEqual(tombsIn(dir), [], 'and no tombstone was cut for it');
    assert.equal(/changed hands/.test(c.stderr), false,
      'it was never even MOVED: a lock whose holder could not be read is not condemned at all,'
      + ' so nothing downstream has to put it back');
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('a break removes only what it CONDEMNED: a successor that took the path is put back', async () => {
  // THE ABA. Winning the tombstone rename is single-winner per RENAME, not per
  // LOCK. Two breakers condemn the same dead lock; the first breaks it, acquires
  // and publishes a LIVE lock at the same path; the second — descheduled in
  // between — then renames that successor into its own tombstone and deletes it.
  // Two writers again, by way of the mechanism meant to stop them, because a
  // pathname was all that bound the decision to the act and the pathname is
  // exactly what changed hands.
  //
  // The interleaving is posed rather than raced: the cancel is held at the new
  // condemn-to-rename pause, and the test plays breaker B in the window. The
  // signal that the cancel has REACHED that window is the aged staging orphan —
  // the sweep runs immediately before the pause, so the orphan's disappearance
  // means the lock has been condemned and not yet moved.
  const id = 'lockaba-1-99962';
  const dir = lockJob(id, 'lockaba');
  const lock = lockPathOf(dir);
  const l0 = aged(lockLike(lock, DEAD_PID));
  const orphan = aged(lockLike(path.join(dir, 'job.json.lock.staging-424242-abcdef'), process.pid));
  try {
    const breaker = cancelling(id, { CODEX_DISPATCH_TEST_BREAK_PAUSE_MS: '8000' });
    assert.ok(await poll(() => !fs.existsSync(orphan), 20000),
      'the cancel must have condemned the lock and be waiting to move it');

    // Breaker B, complete: L0 broken and gone, a LIVE successor published at the
    // path by the atomic rename the runtime itself uses. Its holder is this test
    // runner — a pid that is alive, so it can never age out from under the
    // assertions below.
    fs.renameSync(l0, path.join(dir, 'l0-taken-by-b'));
    const mine = `${process.pid}\n`;
    const stage = lockLike(path.join(dir, 'b-stage'), process.pid);
    fs.renameSync(stage, lock);

    const done = await breaker;
    // Non-vacuity (observed): with `tombIsCondemned` forced to true, the resumed
    // breaker DELETES L1 and takes the path — the three assertions that follow
    // fail (no lock, no holder, no warning) and the cancel goes on to write
    // `kill-pending` under a lock it took from a live holder, which is the
    // lost-update window reopened by way of the mechanism meant to close it.
    assert.equal(fs.existsSync(lock), true, "L1 is back at the lock path: it is not this breaker's to take");
    assert.equal(fs.readFileSync(holderOf(lock), 'utf8'), mine,
      'and it survived byte for byte — a mismatched tombstone is somebody\'s lock, not a tombstone');
    assert.match(done.stderr, /WARNING: the record lock at .*job\.json\.lock changed hands/,
      'the hand-over is announced, not swallowed');
    assert.match(done.stderr, /moved back and NOT removed/);
    assert.deepEqual(tombsIn(dir), [], 'nothing is stranded: the restore put it back where it was');
    assert.equal(record(id).state, 'running',
      'and the breaker wrote nothing: a failed break is not an acquisition');
    assert.notEqual(done.code, 0, 'it refuses loudly instead');
    assert.match(done.stderr, /KILL NOT RECORDED/);
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('the staging sweep MOVES before it removes, and its tombstone goes with it', async () => {
  // `rmSync` on a live path is not a single-winner move and it is not atomic: it
  // unlinks the holder file first, and a stage's owner checks the LOCK before
  // publishing, never its own stage. So an aged-but-still-owned stage hollowed out
  // by a sweep is renamed onto the lock path by its owner as an EMPTY lock — the
  // holderless lock staged acquisition exists to make impossible. The sweep is
  // therefore a rename to a unique tombstone first, and only then a removal.
  //
  // Held at the new sweep pause, which stands in for the sweeper dying between the
  // two: what is visible from outside in that window is the whole point.
  const id = 'locksweep-1-99963';
  const dir = lockJob(id, 'locksweep', {
    started: new Date(Date.now() - 3600000).toISOString(), launch: 'exec',
  });
  const lock = aged(lockLike(lockPathOf(dir), null)); // holderless: breakable, so the sweep runs
  const orphan = aged(lockLike(path.join(dir, 'job.json.lock.staging-424242-abcdef'), process.pid));

  const c = cancelling(id, { CODEX_DISPATCH_TEST_SWEEP_PAUSE_MS: '6000' });
  assert.ok(await poll(() => !fs.existsSync(orphan) && tombsIn(dir).length > 0, 20000),
    'mid-sweep: the orphan has left its own path and a tombstone stands for it');
  assert.equal(fs.existsSync(lock), true,
    'and the lock itself is untouched while its neighbour is swept');

  const done = await c;
  assert.equal(done.code, 0, `the artifacts must not wedge the job: ${done.stderr}`);
  assert.equal(record(id).state, 'killed', 'the write went through the lock the cancel took');
  assert.equal(fs.existsSync(orphan), false, 'the orphan is gone');
  assert.deepEqual(tombsIn(dir), [], 'and so is every tombstone cut on the way');
  assert.equal(fs.existsSync(lock), false, 'and the lock this cancel took is released behind it');
});

test('an abandoned break tombstone ages out like any other orphan', () => {
  // The leak the shared suffix closes: a breaker that dies between its rename and
  // its removal used to leave a directory that nothing would ever collect, because
  // only `.staging-` was swept. One suffix for both means an abandoned tombstone
  // is itself sweepable — and, like the staging suffix, it is strictly longer than
  // the lock's own name, so no swept prefix can ever match the lock.
  const id = 'locktomb-1-99964';
  const dir = lockJob(id, 'locktomb', {
    started: new Date(Date.now() - 3600000).toISOString(), launch: 'exec',
  });
  const lock = aged(lockLike(lockPathOf(dir), DEAD_PID));
  const abandoned = aged(lockLike(path.join(dir, 'job.json.lock.stale-424242-abandon'), DEAD_PID));

  const c = run(['cancel', id]);
  // Non-vacuity (observed): with the `RECORD_LOCK_TOMB` arm of the sweep's filter
  // removed, the abandoned tombstone survives this cancel and the assertion below
  // fails; everything else about the run is unchanged.
  assert.equal(c.status, 0, c.stderr);
  assert.equal(fs.existsSync(abandoned), false,
    'an aged tombstone is swept by the next acquisition that reaches the break path');
  assert.deepEqual(tombsIn(dir), [], 'including the one this break cut for itself');
  assert.equal(fs.existsSync(lock), false, 'and the lock it broke and took is released');
});

test('a sweep interrupted after its rename strands a tombstone, never a hollowed stage', async () => {
  // The other half of move-before-remove: the state a sweeper that DIES mid-sweep
  // leaves on disk. Only what it moved can be half-removed, so the residue is a
  // tombstone — the stage is whole somewhere, or gone, and never a directory its
  // owner can publish empty onto the lock path.
  //
  // The owner is played by this test: it holds an aged stage and does exactly what
  // `stageRecordLock` does with one, which is to publish it the moment the lock
  // path is free. Losing must mean ENOENT, not a hollow publish.
  const id = 'lockhollow-1-99965';
  const dir = lockJob(id, 'lockhollow', {
    started: new Date(Date.now() - 3600000).toISOString(), launch: 'exec',
  });
  const lock = aged(lockLike(lockPathOf(dir), DEAD_PID));
  const stage = aged(lockLike(path.join(dir, 'job.json.lock.staging-424242-owned'), process.pid));

  const child = spawn(process.execPath, [RUNTIME, 'cancel', id], {
    env: { ...baseEnv, CODEX_DISPATCH_TEST_SWEEP_PAUSE_MS: '10000' }, cwd: REPO,
  });
  const closed = new Promise((r) => child.on('close', r));
  try {
    // A holderless lock at the lock path is the defect, and it is confirmed rather
    // than snapped: `rmSync` releasing a lock unlinks the holder a moment before
    // the directory, and that transient is not a hollow publish. A published hollow
    // stage has no releaser and stays.
    let hollow = false;
    const hollowNow = () => fs.existsSync(lock) && !fs.existsSync(holderOf(lock));
    // Waited for in a form that is true whichever way the sweep works — the stage
    // no longer answers for its holder, because it was moved away or emptied — so
    // the interruption below lands at the same point in both, and what differs is
    // only what is left behind.
    assert.ok(await poll(() => {
      if (hollowNow()) hollow = true;
      return !fs.existsSync(holderOf(stage));
    }, 20000, 20), 'the sweeper must have reached the middle of its sweep');
    child.kill('SIGKILL');
    await closed;
    assert.equal(fs.existsSync(stage), false,
      'the stage was moved WHOLE, not emptied where it stood');

    // The lock the killed sweeper never got as far as breaking: some later writer
    // breaks it and releases it, which is the ordinary way the path comes free —
    // and a free path is exactly when a stage's owner publishes.
    assert.equal(fs.readFileSync(holderOf(lock), 'utf8'), `${DEAD_PID}\n`,
      'the lock is as it was: a sweep never touches it');
    fs.rmSync(lock, { recursive: true, force: true });

    // The owner, resuming into that window and doing what `stageRecordLock` does.
    // Non-vacuity (observed): with the sweep reverted to removing the stage in
    // place — holder unlinked, then the pause, then the directory, which is
    // `rmSync`'s own order — the kill leaves the stage hollow, this rename
    // SUCCEEDS, and a lock with no owner stands at the lock path.
    let ownerErr = null;
    if (!fs.existsSync(lock)) {
      try { fs.renameSync(stage, lock); } catch (err) { ownerErr = err; }
    }
    assert.equal(ownerErr && ownerErr.code, 'ENOENT',
      'the owner loses cleanly: what it staged was gone, not emptied under it');
    assert.equal(hollow || hollowNow(), false,
      'and no lock without an owner ever stood at the lock path');

    // The residue of a sweep that died halfway is a tombstone and nothing else —
    // and one that ages out, since the rename it was made by carries the mtime the
    // stage had (see the abandoned-tombstone test above).
    const stranded = tombsIn(dir);
    assert.equal(stranded.length, 1, 'exactly one tombstone is stranded by the interrupted sweep');
    const strandedAt = path.join(dir, stranded[0]);
    assert.equal(fs.readFileSync(holderOf(strandedAt), 'utf8'), `${process.pid}\n`,
      'with the contents it was moved with: only what this process moved was ever to be removed');
    assert.ok(Date.now() - fs.statSync(strandedAt).mtimeMs > 5000,
      'and aged from birth, so the next sweep collects it');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

// A holder line as this release writes one: a pid, a space, sixteen hex digits.
// Fabricated tombstones carry the same shape as the real thing, so a reader that
// only ever coped with a bare pid would be caught by the fixtures too.
const holderText = (pid, nonce = '0123456789abcdef') => `${pid} ${nonce}`;

test('a live lock stranded in a tombstone is not staged past: the room is closed', async () => {
  // THE CRASH-STRAND, fabricated as the state itself rather than raced into: the
  // canonical lock path stands FREE and a live holder's lock is sitting in a
  // `.stale-*` tombstone, which is where a breaker that died between its rename
  // and its restore leaves it. Acquisition consults one path, so before the guard
  // the next writer simply took the free one and the stranded holder was in a
  // silent double-hold — two writers under one record, arrived at by the very
  // mechanism that exists to prevent them.
  //
  // The holder named is this test runner, so it cannot die out from under the
  // assertions; the tombstone is aged past the stale age so that nothing about
  // this depends on the sweep being slow.
  const id = 'lockstrand-1-99966';
  const dir = lockJob(id, 'lockstrand');
  const tomb = aged(lockLike(path.join(dir, 'job.json.lock.stale-424242-strand'),
    holderText(process.pid)));
  const lock = lockPathOf(dir);
  try {
    const t0 = Date.now();
    const c = run(['cancel', id]);
    // Non-vacuity (observed): with `liveLockTomb` forced to return null AND the
    // sweep's restore branch reverted to `continue`, this cancel takes the free
    // lock path in 80ms, says nothing at all, and writes `kill-pending` under a
    // record a live holder still believes it owns — every assertion below fails
    // except the ones about the tombstone's bytes, which survive because nothing
    // in that shape looks at it.
    assert.notEqual(c.status, 0, 'a lock held in a tombstone is still held');
    assert.match(c.stderr, /KILL NOT RECORDED/);
    assert.match(c.stderr, /could not be taken: a lock whose holder is still ALIVE/,
      'the refusal is loud, and it is a refusal rather than a break');
    assert.ok(c.stderr.includes(tomb),
      'and it names the tombstone: "re-run in a moment" is useless advice against this state');
    assert.ok(Date.now() - t0 > 10000,
      'it waited its whole deadline out rather than staging past the strand');
    assert.equal(record(id).state, 'running', 'nothing was written under a lock never taken');
    assert.equal(fs.existsSync(lock), false,
      'and the lock path is left exactly as free as it was found: this refuses, it does not repair');
    assert.equal(fs.readFileSync(holderOf(tomb), 'utf8'), `${holderText(process.pid)}\n`,
      "the stranded lock's cargo survives byte for byte — nothing here is deleted");
  } finally {
    fs.rmSync(tomb, { recursive: true, force: true });
  }
});

test('a tombstone whose holder is DEAD blocks nothing', () => {
  // The other half of the same guard, and the half that keeps it from being a
  // wedge: a tombstone with a dead holder is litter awaiting the sweep, and
  // blocking on it would put every acquisition in the job behind a corpse nobody
  // is ever coming back for. Same fabrication as the test above, one pid apart.
  const id = 'lockdead-1-99967';
  const dir = lockJob(id, 'lockdead', {
    started: new Date(Date.now() - 3600000).toISOString(), launch: 'exec',
  });
  const tomb = aged(lockLike(path.join(dir, 'job.json.lock.stale-424242-corpse'),
    holderText(DEAD_PID)));
  const t0 = Date.now();
  const c = run(['cancel', id]);
  // Non-vacuity (observed): with `liveLockTomb`'s liveness test widened to block
  // on any tombstone at all, this cancel waits out fifteen seconds and records
  // nothing — the timing assertion and the state assertion both fail.
  assert.equal(c.status, 0, `a dead holder's tombstone must not wedge the job: ${c.stderr}`);
  assert.ok(Date.now() - t0 < 12000, 'and it must not wait a deadline out for a corpse');
  assert.equal(record(id).state, 'killed', 'the write went through the lock it took at once');
  assert.equal(/could not be taken/.test(c.stderr), false,
    'nothing is refused: there is no live holder anywhere in this job');
  assert.equal(fs.existsSync(lockPathOf(dir)), false, 'and the lock it took is released behind it');
});

test('a restore that lost the path is retried, and lands when the path comes free', async () => {
  // THE OTHER REPAIR (the sweep is one; this is the breaker's own). A breaker that
  // condemns a lock, finds a live successor in its tombstone and cannot put it
  // back — a third writer took the freed path in between — used to abandon it:
  // the successor stayed stranded and the next acquirer staged past it. Now the
  // tombstone is kept in hand, retried at every turn of the wait, and until it
  // lands this process refuses to stage either.
  //
  // Both windows are posed rather than raced. The break pause holds the breaker
  // between condemning and moving, where this test plays breaker B and publishes
  // the live successor L1; the restore pause holds it between moving and putting
  // back, where this test plays the third writer C and takes the path with L2.
  // Then C releases, and what must follow is the restore landing.
  const id = 'lockretry-1-99968';
  const dir = lockJob(id, 'lockretry');
  const lock = lockPathOf(dir);
  const l0 = aged(lockLike(lock, DEAD_PID));
  const orphan = aged(lockLike(path.join(dir, 'job.json.lock.staging-424242-abcdef'), process.pid));
  const child = spawn(process.execPath, [RUNTIME, 'cancel', id], {
    env: {
      ...baseEnv,
      CODEX_DISPATCH_TEST_BREAK_PAUSE_MS: '5000',
      CODEX_DISPATCH_TEST_RESTORE_PAUSE_MS: '4000',
    },
    cwd: REPO,
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const closed = new Promise((r) => child.on('close', r));
  try {
    // The aged staging orphan is the signal, exactly as in the ABA test: the sweep
    // runs immediately before the break pause, so its disappearance means the lock
    // has been condemned and not yet moved.
    assert.ok(await poll(() => !fs.existsSync(orphan), 20000),
      'the cancel must have condemned the lock and be waiting to move it');
    fs.renameSync(l0, path.join(dir, 'l0-taken-by-b'));
    const mine = `${holderText(process.pid, 'deadbeefdeadbeef')}\n`;
    const stage = lockLike(path.join(dir, 'b-stage'), holderText(process.pid, 'deadbeefdeadbeef'));
    fs.renameSync(stage, lock);

    // The breaker now moves L1 into its tombstone and pauses before putting it
    // back. Writer C takes the freed path in that window.
    assert.ok(await poll(() => tombsIn(dir).length === 1 && !fs.existsSync(lock), 20000, 20),
      'mid-break: the successor is in a tombstone and the lock path stands free');
    const c2 = lockLike(path.join(dir, 'c-stage'), holderText(process.pid, 'cccccccccccccccc'));
    fs.renameSync(c2, lock);

    assert.ok(await poll(() => /could not be moved back/.test(stderr), 20000, 20),
      'the restore fails against an occupied path, and says so');
    assert.match(stderr, /could not be moved back \((EPERM|EACCES|ENOTEMPTY|EEXIST)/,
      "the rename's own errno is the evidence, and it is not the calm ENOENT branch");
    assert.match(stderr, /It is left in .*job\.json\.lock\.stale-/,
      'and the tombstone it is left in is named, because that is where somebody has to look');
    assert.match(stderr, /retried until this writer gives up/);

    // C releases. Non-vacuity (observed): with the `stranded` retry block deleted
    // from the top of the wait loop, no NOTE ever arrives, the tombstone is still
    // standing when the cancel gives up, and the lock path is left empty — the
    // stranded state this whole pass exists to end.
    fs.rmSync(lock, { recursive: true, force: true });
    assert.ok(await poll(() => /restored on retry/.test(stderr), 20000, 20),
      'the restore is retried once the path comes free, and lands');

    const code = await closed;
    assert.equal(fs.existsSync(lock), true, 'L1 is back where its holder left it');
    assert.equal(fs.readFileSync(holderOf(lock), 'utf8'), mine,
      'byte for byte: a mismatched tombstone is somebody\'s lock, not a tombstone');
    assert.deepEqual(tombsIn(dir), [], 'and nothing is stranded behind it');
    assert.notEqual(code, 0, 'the breaker itself never acquired: it refuses loudly instead');
    assert.match(stderr, /KILL NOT RECORDED/);
    assert.equal(record(id).state, 'running', 'a failed break is not an acquisition');
    assert.equal(/^killed:/m.test(stdout), false, 'and it claims nothing it did not do');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(lock, { recursive: true, force: true });
  }
});

test('a holder line is a pid AND a nonce, minted per ACQUISITION', async () => {
  // IDENTITY, NOT JUST LIVENESS. `tombIsCondemned` compares holder bytes to decide
  // whether the directory it is about to delete is the one it condemned, and a
  // holder that was only a pid made that comparison blind to the one case it is
  // for: a process acquires this lock many times in a run — this cancel does it
  // twice — so a breaker that condemned "1234" could find "1234" in its tombstone
  // and delete a LATER lock of the same process as the one it proved dead.
  //
  // The two acquisitions are the cancel's own: the kill-pending fence and the
  // verdict, each held open by the record pause long enough to be read from here.
  const id = 'locknonce-1-99969';
  const dir = lockJob(id, 'locknonce', {
    started: new Date(Date.now() - 3600000).toISOString(), launch: 'exec',
  });
  const holder = holderOf(lockPathOf(dir));
  const c = cancelling(id, { CODEX_DISPATCH_TEST_RECORD_PAUSE_MS: '2500' });
  const seen = new Set();
  const sampler = setInterval(() => {
    try { seen.add(fs.readFileSync(holder, 'utf8')); } catch { /* between acquisitions */ }
  }, 20);
  let done;
  try { done = await c; } finally { clearInterval(sampler); }
  assert.equal(done.code, 0, done.stderr);

  const lines = [...seen];
  // Non-vacuity (observed): with `lockHolderLine` reverted to `${process.pid}\n`,
  // the format assertion fails on the first line and the two acquisitions collapse
  // to one identical string, which the count assertion catches.
  assert.ok(lines.length >= 2,
    `the cancel writes under the lock twice; saw ${lines.length} distinct holder line(s)`);
  for (const line of lines) {
    assert.match(line, /^\d+ [0-9a-f]{16}\n$/,
      'a holder is a pid the liveness check parses and a nonce the identity check compares');
  }
  const pids = new Set(lines.map((l) => l.split(' ')[0]));
  assert.equal(pids.size, 1, 'one process took both locks — the pid half is the same');
  assert.equal(new Set(lines.map((l) => l.split(' ')[1])).size, lines.length,
    'and the nonce half is not: two acquisitions of one process must never match each other');
});

test('a clean refuses a job whose directory holds a live stranded lock', async () => {
  // `removeJobDir` deletes everything but the record and the lock — tombstones
  // included — so a `.stale-*` directory holding a LIVE holder's lock made the
  // tidying-up verb the one place in this runtime that deletes a live lock. The
  // job is refused instead, by job and loudly: one stuck job does not end the run,
  // it still lists, and a later clean takes it once the strand is gone.
  const room = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-strand-'));
  const env = { CODEX_DISPATCH_JOBS: room };
  const finished = (id) => ({
    recordVersion: RECORD_VERSION, id, role: 'cleanstrand', state: 'done', exitCode: 0,
    sight: 'cwd-file:LICENSE', started: new Date(Date.now() - 10 * 86400000).toISOString(),
    finished: new Date(Date.now() - 9 * 86400000).toISOString(),
  });
  const plant = (id, holderPid) => {
    const dir = path.join(room, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(finished(id)));
    fs.writeFileSync(path.join(dir, 'out.txt'), 'answer\n');
    aged(lockLike(path.join(dir, 'job.json.lock.stale-424242-strand'), holderText(holderPid)));
    return dir;
  };
  try {
    const liveId = 'cleanstrand-1-99970';
    const liveDir = plant(liveId, process.pid);
    const stuck = run(['clean', '--all'], env);
    // Non-vacuity (observed): with `liveLockTomb` forced to return null, this clean
    // removes the whole job — the live holder's lock deleted out from under it —
    // and every assertion below fails.
    assert.equal(stuck.status, 0, `one refused job does not end the run: ${stuck.stderr}`);
    assert.match(stuck.stdout, new RegExp(`${liveId}\\s+its record could not be locked — not removed`),
      'the job is kept, and the reason given is the lock it could not take');
    assert.match(stuck.stderr, /could not be taken: a lock whose holder is still ALIVE/,
      'and the strand is named on stderr, not swallowed into a one-line "kept"');
    assert.equal(fs.existsSync(path.join(liveDir, 'job.json')), true,
      'the record is untouched, so the job still lists and a later clean can take it');
    assert.match(run(['list'], env).stdout, new RegExp(`^${liveId}  done`, 'm'));
    assert.equal(fs.existsSync(path.join(liveDir, 'job.json.lock.stale-424242-strand')), true,
      'and the live lock is exactly where it was: this verb removes nothing it cannot prove dead');

    // And the contrast, in a room of its own so the two cannot be confused: a
    // tombstone whose holder is dead goes with the job, as it always did.
    fs.rmSync(liveDir, { recursive: true, force: true });
    const deadId = 'cleanstrand-1-99971';
    const deadDir = plant(deadId, DEAD_PID);
    const swept = run(['clean', '--all'], env);
    assert.equal(swept.status, 0, swept.stderr);
    assert.match(swept.stdout, new RegExp(`^removed: ${deadId}$`, 'm'));
    assert.equal(fs.existsSync(deadDir), false, "a dead holder's tombstone is litter, and goes");
  } finally {
    fs.rmSync(room, { recursive: true, force: true });
  }
});

test('a cancel does not leave a reason it did not write, and result reads the state first',
  () => {
    // A live record CAN carry a reason: a version skew puts one beside a state
    // this release calls `unknown`, which is live and cancellable. The terminal
    // kill patches never touched `reason`, so cancelling one produced
    // `killed(sight-unproven)` — the pair this repo documents as impossible.
    const id = 'reasonpair-1-99943';
    const dir = path.join(JOBS, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
      recordVersion: RECORD_VERSION, id, role: 'reasonpair', state: 'cancelling',
      reason: 'sight-unproven', sight: 'unproven: nothing proved this job could read files',
      started: new Date(Date.now() - 3600000).toISOString(),
      supervisorPid: null, codexPid: null, launch: 'exec',
    }));
    const c = run(['cancel', id]);
    assert.equal(c.status, 0, `nothing to kill, so the cancel succeeds: ${c.stderr}`);
    const rec = record(id);
    assert.equal(rec.state, 'killed');
    assert.equal(rec.reason, undefined,
      'the state and the reason are written as a pair, so a stale reason does not survive');
    assert.match(run(['list']).stdout, new RegExp(`^${id}  killed  `, 'm'),
      'and the listing shows no reason this cancel did not write');

    // The other half: `result` read `reason` BEFORE it read `state`, so a killed
    // job carrying one of the never-ran reasons was reported as a job that never
    // ran. The pair is what means something, and only `failed` can carry these.
    const room = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-reason-'));
    try {
      const stale = 'reasonres-1-99944';
      fs.mkdirSync(path.join(room, stale));
      fs.writeFileSync(path.join(room, stale, 'job.json'), JSON.stringify({
        recordVersion: RECORD_VERSION, id: stale, role: 'reasonres', state: 'killed',
        reason: 'sight-unproven', started: new Date(Date.now() - 3600000).toISOString(),
        finished: new Date().toISOString(),
      }));
      const r = run(['result', stale], { CODEX_DISPATCH_JOBS: room });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /NOT DELIVERED/, 'the state is what this job is refused for');
      assert.match(r.stderr, /is killed/);
      assert.equal(/never ran/.test(r.stderr), false,
        'a reason may not outrank a state: this job was killed, not refused before it ran');
    } finally {
      fs.rmSync(room, { recursive: true, force: true });
    }
  });

test('a clean whose LAST step fails leaves a job that still lists', async () => {
  // `removeJobDir` removes the contents, then `job.json`, then the directory —
  // and that last `rmdir` fails on its own whenever the directory is some
  // process's current one: every file unlinked, the directory left behind, the
  // record gone. Which is precisely the outcome removing the record last exists
  // to prevent — a job `list`, `status` and `clean` can never see again.
  //
  // The blocker sits in the JOB DIRECTORY ITSELF rather than in a child of it
  // (the partial-failure fixture above), because a blocked child fails in the
  // loop, long before the record is touched.
  const room = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-lastrm-'));
  const env = { CODEX_DISPATCH_JOBS: room };
  const id = 'lastrm-1-99945';
  const dir = path.join(room, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
    recordVersion: RECORD_VERSION, id, role: 'lastrm', state: 'done', exitCode: 0,
    sight: 'cwd-file:LICENSE', started: new Date(Date.now() - 10 * 86400000).toISOString(),
    finished: new Date(Date.now() - 9 * 86400000).toISOString(),
  }));
  fs.writeFileSync(path.join(dir, 'out.txt'), 'answer\n');
  const sitting = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'],
    { cwd: dir, stdio: 'ignore', detached: true });
  sitting.unref();
  let stuck;
  try {
    await poll(() => pidAlive(sitting.pid), 5000, 50);
    stuck = run(['clean', '--all'], env);
  } finally {
    try { process.kill(sitting.pid); } catch { /* already gone */ }
  }
  assert.equal(stuck.status, 0, stuck.stderr);
  if (fs.existsSync(dir)) {
    assert.equal(fs.existsSync(path.join(dir, 'job.json')), true,
      'the record is PUT BACK when the directory removal fails, or the job is invisible for ever');
    assert.match(stuck.stdout, /lastrm-1-99945\s+could not be removed/, 'and clean says so');
    assert.match(run(['list'], env).stdout, /^lastrm-1-99945  done/m,
      'it still lists — which is what makes "clean it again" a real cure');
    assert.match(run(['status', id], env).stdout, /^state: done$/m, 'and still reads as finished');
    assert.ok(await poll(() => !pidAlive(sitting.pid), 10000), 'the blocker must be gone first');
    const retry = run(['clean', '--all'], env);
    assert.equal(retry.status, 0, retry.stderr);
    assert.equal(fs.existsSync(dir), false, 'and the retry finishes what the first run could not');
  } else {
    // POSIX lets a process's cwd be removed underneath it, so there is nothing to
    // block. Say so rather than assert nothing.
    process.stderr.write('NOTE: this platform allowed the removal of a directory in use; ' +
      'the last-step-failure test did not fire.\n');
    assert.match(stuck.stdout, /^removed: lastrm-1-99945$/m);
  }
  fs.rmSync(room, { recursive: true, force: true });
});

test('the record a failed clean puts back is written under the lock, and the lock is given back',
  async () => {
    // THE PUT-BACK IS A WRITE TO job.json, so it happens under the record lock like
    // every other one. `fs.rmSync(dir, { recursive: true })` removes the CHILDREN
    // first — the lock this removal is holding among them — and only then fails on
    // the directory itself, so the restore was an unlocked write over a
    // lock-governed file, racing whatever took the lock in the meantime. The order
    // is fixed instead: the record goes while the lock is still held, the lock is
    // handed back next, and the restore re-acquires it through the ordinary path.
    //
    // What that has to leave behind is a job another writer can simply take the
    // lock for — which is what the cancel at the end measures, and what a restore
    // that left its lock (or wrote without one and never released) would fail.
    const room = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-relock-'));
    const env = { CODEX_DISPATCH_JOBS: room };
    const id = 'relock-1-99954';
    const dir = path.join(room, id);
    fs.mkdirSync(dir, { recursive: true });
    const raw = JSON.stringify({
      recordVersion: RECORD_VERSION, id, role: 'relock', state: 'done', exitCode: 0,
      sight: 'cwd-file:LICENSE', started: new Date(Date.now() - 10 * 86400000).toISOString(),
      finished: new Date(Date.now() - 9 * 86400000).toISOString(),
    });
    fs.writeFileSync(path.join(dir, 'job.json'), raw);
    fs.writeFileSync(path.join(dir, 'out.txt'), 'answer\n');
    // The blocker sits in the job directory ITSELF: a child would fail in the loop,
    // long before the record is touched. (Same fixture as the last-step test.)
    const sitting = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'],
      { cwd: dir, stdio: 'ignore', detached: true });
    sitting.unref();
    let stuck;
    try {
      await poll(() => pidAlive(sitting.pid), 5000, 50);
      stuck = run(['clean', '--all'], env);
    } finally {
      try { process.kill(sitting.pid); } catch { /* already gone */ }
    }
    assert.equal(stuck.status, 0, stuck.stderr);
    try {
      if (!fs.existsSync(dir)) {
        // POSIX lets a process's cwd be removed underneath it, so there is nothing
        // to block. Say so rather than assert nothing.
        process.stderr.write('NOTE: this platform allowed the removal of a directory in use; ' +
          'the restore-under-the-lock test did not fire.\n');
        assert.match(stuck.stdout, /^removed: relock-1-99954$/m);
        return;
      }
      assert.equal(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'), raw,
        'the record is put back byte-for-byte, or the job is invisible for ever');
      assert.equal(fs.existsSync(path.join(dir, 'job.json.lock')), false,
        'and the lock the restore took is given back — a leftover one wedges every later writer');
      assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('job.json.lock')), false,
        'staging directories included: nothing lock-shaped is left in the job dir');
      assert.equal(stuck.stderr.includes('could not be put back'), false,
        `the restore succeeded, so nothing may say otherwise: ${stuck.stderr}`);

      // And the proof that the lock is really free: a writer that needs it takes
      // it, promptly, and its write lands. A lock left behind would make this wait
      // out the fifteen-second timeout and record nothing.
      fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({
        ...JSON.parse(raw), state: 'running', finished: undefined,
        started: new Date(Date.now() - 3600000).toISOString(),
        supervisorPid: null, codexPid: null, launch: 'exec',
      }));
      const t0 = Date.now();
      const c = run(['cancel', id], env);
      assert.equal(c.status, 0, `the next writer takes the lock normally: ${c.stderr}`);
      assert.ok(Date.now() - t0 < 12000, `and does not wait one out (took ${Date.now() - t0}ms)`);
      assert.match(run(['status', id], env).stdout, /^state: killed$/m, 'its write landed');

      assert.ok(await poll(() => !pidAlive(sitting.pid), 10000), 'the blocker must be gone first');
      const retry = run(['clean', '--all'], env);
      assert.equal(retry.status, 0, retry.stderr);
      assert.equal(fs.existsSync(dir), false, 'and the retry finishes what the first run could not');
    } finally {
      fs.rmSync(room, { recursive: true, force: true });
    }
  });

// ----------------------------------------------- writes that cannot be made
//
// A WEDGE EVERY WRITER IN A JOB HAS TO WAIT OUT, planted from outside and lifted
// on demand. The acquisition guard refuses to stage past a tombstone whose holder
// is ALIVE (the strand test above pins that rule), and this test runner is alive
// for as long as the suite is — so a `.stale-*` directory naming its pid makes
// every locked write to that record answer `locked`, whichever phase of a run is
// trying to make one. Planting it before the phase under test and lifting it
// after is how each of these reaches a write-refused branch that nothing else can
// produce on demand. Fresh rather than aged, so no sweep can collect it out from
// under a test; removing it lets the very next 20ms turn of the wait through.
const wedgeRecord = (dir) =>
  lockLike(path.join(dir, 'job.json.lock.stale-424242-wedge'), holderText(process.pid));
const liftWedge = (p) => fs.rmSync(p, { recursive: true, force: true });

// The job's own log, which is where every one of these refusals has to appear.
const runLogOf = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'run.log'), 'utf8'); } catch { return ''; }
};

test('a verdict the finalizer cannot record is INSISTED on, then said out loud in both places',
  async () => {
    // THE WORST CASE THIS PASS CLOSES. codex ran, codex answered, and the one
    // write that turns that into a finished job could not be made. Unchecked, that
    // was SILENT: `updateRecord` answered null, the exit handler walked straight on
    // to the role release, and what was left was a job reading `stale` for ever
    // beside an out.txt nobody would ever be allowed to deliver, with nothing
    // anywhere saying why. The write is insisted on now, and when it still cannot
    // be made the job's log and the supervisor's stderr both say so, name the
    // answer file, and name the one command that resolves it.
    //
    // The wedge goes in AFTER registration, so the only write it can catch is the
    // finalization. The budget knob is what keeps this test to half a minute
    // rather than the full shipped minute; 20s buys exactly two attempts, which is
    // what "it retried" means here.
    const brief = writeBrief('briefwedgefin.md', 'the finalizer will not be able to write');
    const d = run(['dispatch', '--brief', brief, '--role', 'wedgefin'], {
      FAKE_CODEX_SLEEP_MS: '5000',
      CODEX_DISPATCH_TEST_WRITE_BUDGET_MS: '20000',
    });
    assert.equal(d.status, 0, d.stderr);
    const id = jobIdFrom(d.stdout);
    const dir = path.join(JOBS, id);
    assert.ok(await poll(() => record(id).launch === 'exec', 20000, 25),
      'codex must be registered before the wedge goes in, or this wedges the wrong write');
    const wedge = wedgeRecord(dir);
    try {
      assert.equal(record(id).state, 'running',
        'and it must be in before codex exits, or the write under test already happened');
      assert.ok(await poll(() => fs.existsSync(path.join(dir, 'out.txt')), 30000, 25),
        'codex must finish and leave an answer: that is what makes a lost verdict expensive');
      const t0 = Date.now();
      assert.ok(await poll(() => /verdict could not be recorded/.test(runLogOf(dir)), 60000, 100),
        `the finalizer must say so in the job's own log:\n${runLogOf(dir)}`);
      const waited = Date.now() - t0;
      // Non-vacuity (observed): with the finalization reverted to the unchecked
      // `updateRecord`, the supervisor exits in silence — run.log ends at codex's
      // own last line, supervisor.log is empty, and the poll above times out.
      // Nothing else about the run changes, which is exactly the defect: the job
      // reads stale and no message anywhere explains it.
      assert.ok(waited > 20000,
        `one refusal is not an answer: the write is retried to its budget (gave up after ${waited}ms)`);

      const log = runLogOf(dir);
      assert.match(log, /supervisor: codex exited 0, but its verdict could not be recorded \(locked\)/);
      assert.ok(log.includes(path.join(dir, 'out.txt')),
        'and it names the answer file, because that is the thing being left undeliverable');
      assert.match(log, new RegExp(`Resolve the record: cancel ${id}`),
        'and the one command that ends the state it is describing');
      const sup = fs.readFileSync(path.join(dir, 'supervisor.log'), 'utf8');
      assert.match(sup, /verdict could not be recorded/,
        "on stderr as well as in the log: a detached supervisor's two places a human looks");
      assert.match(sup, /not releasing the "wedgefin" role/,
        'and a job that still reads running keeps its claim — the record is what decides that');

      assert.equal(record(id).state, 'running',
        'the record says exactly what it said: nothing was written under a lock never taken');
      assert.ok(await poll(() => !pidAlive(record(id).supervisorPid), 20000),
        'the supervisor exits rather than hanging on the wedge for ever');
      assert.match(run(['status', id]).stdout, /^state: stale$/m,
        'which is the state the message promised: stale, holding its role, waiting for a cancel');

      // And the advice is real advice: lift the wedge and the named cure works.
      liftWedge(wedge);
      const c = run(['cancel', id]);
      assert.equal(c.status, 0, `the cure the message names must be one: ${c.stderr}`);
      assert.equal(record(id).state, 'killed',
        'the cancel resolves the record the finalizer could not, and the job stops reading stale');
    } finally {
      liftWedge(wedge);
      run(['cancel', id]);
    }
  });

// A directory whose CONTENTS cannot be listed while it can still be entered and
// written: readdir fails, and `mkdir` of a staging directory inside it does not.
// Windows by ACL — a deny of FILE_LIST_DIRECTORY (RD) on this user — and POSIX by
// dropping the read bit while keeping write and traverse. Returns the undo, or
// null when the platform would not cooperate (an elevated or root runner can read
// through both of these), so the caller can say so rather than assert nothing.
function denyListing(dir) {
  const readable = () => { try { fs.readdirSync(dir); return true; } catch { return false; } };
  if (process.platform === 'win32') {
    const who = process.env.USERNAME;
    if (!who) return null;
    const undo = () => spawnSync('icacls', [dir, '/remove:d', who],
      { encoding: 'utf8', windowsHide: true });
    const r = spawnSync('icacls', [dir, '/deny', `${who}:(RD)`], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || readable()) { undo(); return null; }
    return undo;
  }
  const before = fs.statSync(dir).mode;
  const undo = () => fs.chmodSync(dir, before);
  fs.chmodSync(dir, 0o311);
  if (readable()) { undo(); return null; }
  return undo;
}

test('a job directory that cannot be ENUMERATED blocks the lock, in words of its own', async () => {
  // A GUARD THAT COULD NOT LOOK HAS NOT CLEARED ANYTHING. The acquisition guard
  // reads the job directory to find a live lock stranded in a tombstone, and a
  // `readdir` that FAILS used to be swallowed into "no tombstone here" — the one
  // fail-open direction in the seam, which readmits the silent double-hold it was
  // built to close. Unproven absence does not stage: every errno but ENOENT is
  // treated as blocked, and the refusal that follows is its own, because routing
  // it through the tombstone text would name a directory nobody ever read.
  const id = 'lockblind-1-99972';
  const dir = lockJob(id, 'lockblind', {
    started: new Date(Date.now() - 3600000).toISOString(), launch: 'exec',
  });
  const undo = denyListing(dir);
  if (!undo) {
    process.stderr.write('NOTE: this runner can list a directory it was denied listing on ' +
      '(elevated or root); the unenumerable-job-dir test did not fire.\n');
    return;
  }
  try {
    assert.equal(fs.existsSync(path.join(dir, 'job.json')), true,
      'the record is still READABLE by name — only the listing is denied, or this proves nothing');
    const t0 = Date.now();
    const c = run(['cancel', id]);
    // Non-vacuity (observed): with `liveLockTomb`'s unenumerable branch reverted
    // to a bare `catch { return { tomb: null } }`, this cancel stages straight
    // past the directory it could not read, takes the lock in ~80ms and records
    // `killed` — the timing, the message and the state assertions all fail.
    assert.notEqual(c.status, 0, `an unreadable directory is not an empty one: ${c.stderr}`);
    assert.match(c.stderr, /KILL NOT RECORDED/);
    assert.match(c.stderr, /could not be taken: the job directory could not be\s+enumerated \(/,
      'the refusal is the could-not-look one');
    assert.equal(/a lock whose holder is still ALIVE/.test(c.stderr), false,
      'and NOT the tombstone refusal: it would name a path this process never read');
    assert.ok(c.stderr.includes(dir),
      'it names the directory to investigate, which is the only lead there is');
    assert.ok(Date.now() - t0 > 10000,
      'and it waited its deadline out like any other contention rather than failing fast');
    assert.equal(record(id).state, 'running', 'nothing was written under a lock never taken');
  } finally {
    undo();
  }
});

test('a launch marker that could not be written stops the dispatch BEFORE it spawns anything',
  async () => {
    // `launch: 'spawning'` is what stops a cancel reading the registration window
    // as "nothing was ever started". Written unchecked, a refused one left the
    // record saying `launch: 'pending'` under a supervisor that was launched
    // anyway — the one reading that lets a cancel call a running job dead. So the
    // marker is checked, and a marker that did not land means the spawn does not
    // happen: everything to that point is reversible and a spawned supervisor is
    // not.
    //
    // The record is corrupted rather than locked, in the claim-pause window that
    // sits between writing it and marking it: `corrupt` is refused on the first
    // attempt where `locked` costs a fifteen-second wait, and this branch does not
    // care which refusal it was handed. It also gives the second half of the test
    // for free — the catch-all's own finalization is refused for the same reason,
    // which is the branch that must not claim a failure it never recorded.
    const brief = writeBrief('briefmarkerwedge.md', 'nothing may be spawned behind this record');
    const child = spawn(process.execPath,
      [RUNTIME, 'dispatch', '--brief', brief, '--role', 'markerwedge'],
      { env: { ...baseEnv, CODEX_DISPATCH_TEST_CLAIM_PAUSE_MS: '6000' }, cwd: REPO });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const closed = new Promise((r) => child.on('close', r));
    const dirOf = () => {
      const name = fs.readdirSync(JOBS).find((n) => n.startsWith('markerwedge-'));
      return name ? path.join(JOBS, name) : null;
    };
    assert.ok(await poll(() => !!dirOf() && fs.existsSync(path.join(dirOf(), 'job.json')), 20000, 25),
      'the dispatch must have written its record before this can break it');
    const dir = dirOf();
    fs.writeFileSync(path.join(dir, 'job.json'), '{ not json');

    const code = await closed;
    // Non-vacuity (observed): with the marker reverted to an unchecked
    // `updateRecord`, this dispatch spawns its supervisor anyway — supervisor.log
    // appears, the last assertion fails, and the job goes on behind a record that
    // still reads as never having started.
    assert.notEqual(code, 0, `a marker that did not land is not a launch: ${stderr}`);
    assert.match(stderr, /the pre-spawn launch marker could not be written to the record \(corrupt\)/,
      'and it says which write it was and what answer it got');
    assert.match(stderr, /The failure could NOT be recorded \(dispatch-failed\)/,
      'the catch-all may not claim a finalization it could not make either');
    assert.match(stderr, /Resolve the record: cancel markerwedge-/,
      'so it hands over the one thing that resolves it instead');
    assert.equal(/is recorded as failed \(dispatch-failed\)/.test(stderr), false,
      'the sentence that would be a lie here is the one branch this fix exists to remove');
    assert.equal(/^job: /m.test(stdout), false, 'and no job handle is printed for a job that never ran');
    assert.equal(fs.existsSync(path.join(dir, 'prompt.md')), true,
      'the job dir was reached, or this test wedged something else entirely');
    assert.equal(fs.existsSync(path.join(dir, 'supervisor.log')), false,
      'and NOTHING was spawned: that log is opened by the same line that spawns the supervisor');
  });

test('a sight label that will not land is refused BEFORE codex is spawned', async () => {
  // The sight label is the only evidence the delivery gate ever reads, so a label
  // that does not land is a run that can never be delivered however well it goes:
  // `result` looks for `sight`, finds nothing, and refuses the answer codex was
  // paid to produce. Written fire-and-forget, that was discovered AFTER the spend;
  // now it is refused before it, while everything is still reversible.
  //
  // THE PROBE IS THE WINDOW, and the fake says when it is open. Two writes come
  // before the label — the dispatch's registration and the supervisor's own
  // fallback one — and both carry a `startTimesFor` that spends PowerShell time,
  // so "after the dispatch process exits" is not after them under load: a wedge
  // aimed by that clock landed on the supervisor's pid write instead, which
  // refuses in another place entirely (supervisor.log, not run.log) and leaves
  // this test hanging on a message nobody was ever going to write. The probe mark
  // is downstream of both.
  const brief = writeBrief('briefsightwedge.md', 'the label will not land');
  // Outside the jobs root: everything in there is a job directory as far as this
  // runtime is concerned, and a stray file in it is not this test's to invent.
  const mark = path.join(os.tmpdir(), `codex-dispatch-sightwedge-${process.pid}.mark`);
  fs.rmSync(mark, { force: true });
  const child = spawn(process.execPath,
    [RUNTIME, 'dispatch', '--brief', brief, '--role', 'sightwedge'], {
      env: {
        ...baseEnv,
        FAKE_CODEX_SLEEP_MS: '60000',
        FAKE_CODEX_SANDBOX_DELAY_MS: '10000',
        FAKE_CODEX_SANDBOX_MARK: mark,
        CODEX_DISPATCH_TEST_WRITE_BUDGET_MS: '1000',
      },
      cwd: REPO,
    });
  child.stdout.resume();
  child.stderr.resume();
  const dirOf = () => {
    const name = fs.readdirSync(JOBS).find((n) => n.startsWith('sightwedge-'));
    return name ? path.join(JOBS, name) : null;
  };
  assert.ok(await poll(() => fs.existsSync(mark) && !!dirOf(), 40000, 20),
    'the supervisor must be inside its sight probe, which is the write before the label');
  const dir = dirOf();
  const id = path.basename(dir);
  const wedge = wedgeRecord(dir);
  try {
    assert.equal(record(id).sight, undefined,
      'the wedge must be in before the label is written, or this test proves nothing');
    assert.ok(await poll(() => /SIGHT LABEL COULD NOT BE RECORDED/.test(runLogOf(dir)), 60000, 100),
      `the supervisor must refuse the run rather than spend on an undeliverable one:\n` +
      `run.log: ${runLogOf(dir)}\nsupervisor.log: ${
        (() => { try { return fs.readFileSync(path.join(dir, 'supervisor.log'), 'utf8'); } catch { return '(none)'; } })()}`);
    const log = runLogOf(dir);
    assert.match(log, /THE SIGHT LABEL COULD NOT BE RECORDED \(locked\) — refusing to run\./);
    assert.match(log, /Nothing has been launched, so nothing was billed/);
  } finally {
    liftWedge(wedge);
    fs.rmSync(mark, { force: true });
  }
  // Lifted, the refusal itself lands — which is the other half of the contract:
  // the job is FAILED with a reason the docs carry, not left reading running.
  assert.ok(await poll(() => record(id).state === 'failed', 20000, 50),
    `the refusal lands once the lock comes free: ${JSON.stringify(record(id))}`);
  assert.equal(record(id).reason, 'record-write-refused');
  // Non-vacuity (observed): with `recordSightLabel` reverted to the fire-and-forget
  // `updateRecord`, nothing is said about the label at all — the poll above times
  // out, run.log is empty, and the supervisor walks on to the next write and dies
  // against it with a message about the record no longer saying "running". What is
  // left is a job reading `running` with NO sight on it: stale for ever, holding
  // its role, and refused as unvouched if it had ever produced anything.
  assert.equal(fs.existsSync(path.join(dir, 'received-brief.bin')), false,
    'codex was never reached: the fake writes that file the moment it starts');
  assert.equal(fs.existsSync(path.join(dir, 'child.pid')), false, 'nor anything under it');
  assert.equal(fs.existsSync(path.join(dir, 'out.txt')), false, 'and nothing was produced or billed');
});

test('codex that was spawned and could not be recorded is KILLED, not left billing', async () => {
  // The write that turns a spawned codex into a KILLABLE one. Lost, the record
  // keeps `launch: 'exec-spawning'` and no `codexPids`, so every cancel writes
  // `kill-pending` and kills nothing while codex runs on and bills — a run nobody
  // can stop except by promise. So the registration is insisted on, and a failure
  // kills what was just spawned rather than leaving it unkillable.
  //
  // The exec pause is the seam — it holds the supervisor between codex existing
  // and its pids being written down — and the record is corrupted inside it: the
  // branch does not care which refusal it got, and `corrupt` is refused at once
  // where `locked` costs a lock wait.
  const brief = writeBrief('briefregwedge.md', 'this codex will never be recorded');
  const d = run(['dispatch', '--brief', brief, '--role', 'regwedge'], {
    FAKE_CODEX_SLEEP_MS: '60000',
    CODEX_DISPATCH_TEST_EXEC_PAUSE_MS: '5000',
  });
  assert.equal(d.status, 0, d.stderr);
  const id = jobIdFrom(d.stdout);
  const dir = path.join(JOBS, id);
  assert.ok(await poll(() => fs.existsSync(path.join(dir, 'child.pid')), 30000, 25),
    'codex must be up and the supervisor inside the exec window');
  fs.writeFileSync(path.join(dir, 'job.json'), '{ not json');
  const grandchild = Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8').trim());

  // Non-vacuity (observed): with the registration reverted to the fire-and-forget
  // `updateRecord`, nothing is said and nothing is killed — the poll below times
  // out, the fake codex is still alive at the end of it, and it goes on to write
  // its answer sixty seconds later under a record that cannot name a target.
  assert.ok(await poll(() => /COULD NOT BE RECORDED/.test(runLogOf(dir)), 40000, 100),
    `a codex that cannot be recorded must be refused out loud:\n${runLogOf(dir)}`);
  // The refusal write's own report is the LAST line of this sequence and it is
  // appended a kill later, so it is waited for rather than read out of a snapshot
  // taken the instant the first message landed.
  assert.ok(await poll(() => /refusal could not be written/.test(runLogOf(dir)), 30000, 50),
    `the refusal write is checked too, and reported:\n${runLogOf(dir)}`);
  const log = runLogOf(dir);
  assert.match(log, /supervisor: CODEX WAS SPAWNED AND COULD NOT BE RECORDED \(corrupt\) — refusing to run it\./);
  assert.match(log, /A codex whose pids are not on the record cannot be cancelled/);
  assert.match(log, /It has been killed\s+instead, and verified dead/,
    'and the kill is stated with its verification, like every other kill here');
  assert.match(log, /this refusal could not be written to the record \(corrupt\)/,
    'the refusal write is checked too: a record it could not reach is reported, never assumed');
  assert.match(log, /What was spawned has been killed and verified dead; the\s+"regwedge" role claim has been released/,
    'and it says what really happened here: this is the one refusal path that reaches this report AFTER a spawn');
  assert.equal(/Nothing was launched/.test(log), false,
    'the generic sentence is a lie on this path — codex existed, was killed, and was watched die');

  const pids = fs.readFileSync(path.join(dir, 'codex.pid'), 'utf8').trim().split(/\r?\n/).map(Number);
  assert.ok(pids.length && pids.every(isFinite), `codex's pids were written down: ${pids}`);
  assert.ok(await poll(() => pids.every((p) => !pidAlive(p)), 20000),
    'codex is dead — milliseconds of it are cheaper than the only handle on it');
  assert.ok(await poll(() => !pidAlive(grandchild), 20000),
    'and so is its child: the kill goes through the tree, or "verified dead" means nothing');
  assert.equal(fs.existsSync(path.join(dir, 'out.txt')), false,
    'it never got as far as an answer, which is the trade this branch makes on purpose');
});

test('every state/reason pair this suite put on disk is one the docs allow', () => {
  // The record-level half of the pair contract (the source-level half is in
  // tests/resolution.test.mjs). It reads the pairs this runtime ACTUALLY wrote
  // while the tests above ran it through failed precheck, cancels inside both
  // registration windows, kills that did not take, corrupt records and races — so
  // a pair produced by one write setting `state` over another's `reason`, which no
  // source scan can see, fails here. `killed(sandbox-blind-precheck)` was exactly
  // that shape, and it is what this sweep exists to catch coming back.
  //
  // Deliberately last in the file: node:test runs a file's top-level tests in
  // order, so by here every job the suite created is on disk.
  const doc = fs.readFileSync(path.join(REPO, 'commands', 'list.md'), 'utf8');
  const documented = new Set(
    [...doc.matchAll(/`([a-z][a-z-]*)\(([a-z][a-z0-9-]*)\)`/g)].map((m) => `${m[1]}(${m[2]})`)
  );
  assert.ok(documented.size >= 10, 'the documented pairs must be readable, or this sweep proves nothing');

  const seen = new Set();
  for (const name of fs.readdirSync(JOBS)) {
    const file = path.join(JOBS, name, 'job.json');
    let rec;
    try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!rec || typeof rec !== 'object' || typeof rec.reason !== 'string') continue;
    // Only the pairs this runtime writes: a corrupt-record fixture's reason is a
    // string somebody put there by hand, and `state(reason)` only means anything
    // for a state this release actually writes.
    if (typeof rec.state !== 'string') continue;
    seen.add(`${rec.state}(${rec.reason})`);
  }
  // A sweep that saw nothing must fail rather than pass vacuously: several tests
  // above finish jobs with a reason on the record.
  assert.ok(seen.size >= 2, `expected the suite to have produced several state/reason pairs, saw ${seen.size}`);
  for (const pair of seen) {
    assert.ok(documented.has(pair),
      `this suite produced ${pair} on disk, which commands/list.md documents as impossible`);
  }
});

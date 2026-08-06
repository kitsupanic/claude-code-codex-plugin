// Lifecycle tests for codex-dispatch, run against the fake codex.
// Usage: node --test tests/dispatch.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Imported, not hard-coded: the schema stamp is the thing the delivery gate reads,
// so a fixture that wants to be deliverable has to carry whatever this release
// writes. Hard-coded 1s silently stopped meaning "current" the moment it moved.
import { RECORD_VERSION } from '../scripts/codex-dispatch.mjs';

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

  const st = run(['status', id]);
  assert.match(st.stdout, /^state: done$/m);
  assert.match(st.stdout, /^sight: (cwd-file:|job-nonce)/m, 'sight must be proven and recorded, per job');
  assert.match(st.stdout, /^out: /m, 'status must contain the out: line');

  const res = run(['result', id]);
  assert.equal(res.status, 0);
  assert.deepEqual(
    Buffer.from(res.stdout),
    fs.readFileSync(path.join(dir, 'out.txt')),
    'result must be byte-identical to the out file'
  );
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
  const first = run(['dispatch', '--brief', brief, '--role', 'dup'], env);
  assert.equal(first.status, 0, first.stderr);
  const firstId = jobIdFrom(first.stdout);
  await poll(() => record(firstId).codexPid);

  const refused = run(['dispatch', '--brief', brief, '--role', 'dup'], env);
  assert.notEqual(refused.status, 0, 'second dispatch must refuse');
  assert.ok(refused.stderr.includes(firstId), 'refusal must name the running job');
  assert.match(refused.stderr, /^out: /m);

  const forced = run(['dispatch', '--brief', brief, '--role', 'dup', '--force'], env);
  assert.equal(forced.status, 0, forced.stderr);
  const forcedId = jobIdFrom(forced.stdout);
  assert.notEqual(forcedId, firstId);

  const old = record(firstId);
  assert.equal(old.state, 'killed');
  assert.ok(await poll(() => !pidAlive(old.supervisorPid)), 'old supervisor must be dead');
  assert.ok(await poll(() => !pidAlive(old.codexPid)), 'old codex must be dead');

  run(['cancel', forcedId]);
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

  const results = await Promise.all([launch(), launch()]);
  const winners = results.filter((r) => r.code === 0);
  const losers = results.filter((r) => r.code !== 0);
  assert.equal(winners.length, 1, `exactly one dispatch may win the role: ${JSON.stringify(results)}`);
  assert.equal(losers.length, 1);
  assert.match(losers[0].stderr, /race/, 'the loser must say which role it lost');
  assert.equal(losers[0].stdout.includes('job: '), false, 'the loser must not hand out a job handle');

  const dirs = fs.readdirSync(JOBS).filter((n) => n.startsWith('race-'));
  assert.equal(dirs.length, 1, 'and must leave no job dir behind');

  run(['cancel', jobIdFrom(winners[0].stdout)]);
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
  const brief = writeBrief('brief7.md', 'slow');
  const env = { FAKE_CODEX_SLEEP_MS: '60000' };
  const r = run(['dispatch', '--brief', brief, '--role', 'orphan'], env);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
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
  assert.equal(record(id).state, 'killed', '--force must mark the stale job killed');
  assert.ok(await poll(() => !pidAlive(codexPid)), '--force must reap the orphaned codex');
  assert.ok(await poll(() => !pidAlive(grandchildPid)), 'and the orphan\'s own child');

  run(['cancel', jobIdFrom(forced.stdout)]);
});

test('a kill that does not take is kill-failed, not killed, and blocks --force', async () => {
  // The survivor is simulated: CODEX_DISPATCH_TEST_NOKILL makes killTree a no-op,
  // standing in for a taskkill that returns success and changes nothing (access
  // denied, an elevated child, a process wedged in a driver). The approximation
  // is deliberate — what is under test is what the runtime does once the pids are
  // still alive afterwards, not the mechanism by which they survived.
  const brief = writeBrief('briefnokill.md', 'slow');
  const env = { FAKE_CODEX_SLEEP_MS: '60000' };
  const r = run(['dispatch', '--brief', brief, '--role', 'nokill'], env);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
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
  const forcedOk = run(['dispatch', '--brief', brief, '--role', 'nokill', '--force'], env);
  assert.equal(forcedOk.status, 0, forcedOk.stderr);
  assert.equal(record(id).state, 'killed', 'the verified kill finally lands');
  assert.ok(await poll(() => !pidAlive(supervisorPid)), 'and the survivor is gone');
  run(['cancel', jobIdFrom(forcedOk.stdout)]);
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
  const r = run(['dispatch', '--brief', brief, '--role', 'eperm'], env);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
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
  const again = run(['cancel', id]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(record(id).state, 'killed');
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
  const r = run(['dispatch', '--brief', brief, '--role', 'unvouched'], env);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
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
  assert.match(taken.stdout, /reaped unvouched-for job before taking role/);
  assert.ok(await poll(() => !pidAlive(supervisorPid)), 'its supervisor must be dead');
  assert.ok(await poll(() => !pidAlive(codexPid)), 'its codex must be dead');
  assert.ok(await poll(() => !pidAlive(grandchildPid)), 'and codex\'s own child');
  assert.equal(
    fs.readFileSync(path.join(JOBS, id, 'job.json'), 'utf8'), '{"state":"running", TRUNCATED',
    'the corrupt record is still evidence and is left byte-for-byte'
  );
  run(['cancel', jobIdFrom(taken.stdout)]);
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
  fs.writeFileSync(path.join(dir, 'child.pid'), String(victim.pid));

  const c = run(['cancel', 'renamefail-1-99991'], { CODEX_DISPATCH_TEST_RENAME_FAIL: 'child.pid' });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, new RegExp(`killed recorded pids: ${victim.pid}`));
  assert.match(c.stderr, /WARNING/, 'the failed rename is surfaced, not swallowed');
  assert.match(c.stderr, /could not rename spent pid file\(s\): child\.pid \(EPERM\)/);
  assert.match(c.stdout, /reaped pids recorded in reaped\.pids/, 'and the durable half is named');
  assert.ok(await poll(() => !pidAlive(victim.pid)), 'the pid was still killed');

  assert.ok(fs.existsSync(path.join(dir, 'child.pid')), 'the pid file really did survive');
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
  const r = run(['dispatch', '--brief', brief, '--role', 'notready'], { FAKE_CODEX_SLEEP_MS: '60000' });
  const id = jobIdFrom(r.stdout);
  const res = run(['result', id]);
  assert.notEqual(res.status, 0, 'result before done must exit nonzero');
  assert.equal(res.stdout, '', 'stdout must stay empty when not ready');
  assert.match(res.stderr, /^out: .+out\.txt$/m);
  assert.match(res.stderr, /running/);
  run(['cancel', id]);
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
  fs.writeFileSync(path.join(dir, 'child.pid'), String(victim.pid));

  const c = run(['cancel', 'corruptkill-1-99996']);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /corrupt job\.json/);
  assert.match(c.stdout, new RegExp(`killed recorded pids: ${victim.pid}`));
  assert.match(c.stdout, /consumed pid files: child\.pid\.reaped-/);
  assert.ok(await poll(() => !pidAlive(victim.pid)), 'the recorded pid must be killed');
  assert.equal(
    fs.readFileSync(path.join(dir, 'job.json'), 'utf8'), raw,
    'the corrupt record is evidence — cancel must not overwrite it'
  );
  assert.equal(fs.existsSync(path.join(dir, 'child.pid')), false, 'the spent pid file is gone');
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
  fs.writeFileSync(path.join(dir, 'child.pid'), String(victim.pid));

  const first = run(['cancel', 'doublecancel-1-99993']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`killed recorded pids: ${victim.pid}`));
  assert.ok(await poll(() => !pidAlive(victim.pid)));

  const snapshot = () => fs.readdirSync(dir).sort().map((n) => {
    const p = path.join(dir, n);
    return `${n}:${fs.statSync(p).size}:${fs.readFileSync(p, 'utf8')}`;
  });
  const before = snapshot();
  assert.ok(before.some((e) => e.startsWith('child.pid.reaped-')), 'the pid file was renamed, not deleted');

  const second = run(['cancel', 'doublecancel-1-99993']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /already reaped: child\.pid\.reaped-/);
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
    fs.writeFileSync(path.join(canary, 'child.pid'), String(victim.pid));
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
    assert.deepEqual(fs.readdirSync(canary).sort(), ['child.pid', 'precious.txt'],
      'nothing outside the jobs root may be created, renamed or removed');
    assert.equal(fs.readFileSync(path.join(canary, 'child.pid'), 'utf8'), String(victim.pid));
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

  const c = run(['cancel', id]);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(record(id).state, 'killed');
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
  // Asserted WITHOUT the fake's child.pid file, which would otherwise make the
  // grandchild a recorded target and hide whether the group kill worked.
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

test('a corrupt record blocks its role: the backstop scan no longer skips it', async () => {
  // REPRODUCED in review with the claim directory deleted — which the runtime's
  // own corrupt-claim message told the operator to do. findRoleConflict skipped
  // corrupt records by design, so two codexes ran under one role.
  const brief = writeBrief('briefscan.md', 'slow');
  const env = { FAKE_CODEX_SLEEP_MS: '60000' };
  const r = run(['dispatch', '--brief', brief, '--role', 'scanblock'], env);
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
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
  assert.match(taken.stdout, /reaped unvouched-for job before taking role/);
  assert.ok(await poll(() => !pidAlive(supervisorPid)), 'and only after it was killed and verified');
  run(['cancel', jobIdFrom(taken.stdout)]);
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
    fs.writeFileSync(path.join(outside, 'child.pid'), '999999995\n');
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

    assert.deepEqual(fs.readdirSync(outside).sort(), ['child.pid', 'job.json', 'precious.txt'],
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
  assert.ok(await poll(() => findDir() && fs.existsSync(path.join(JOBS, findDir(), 'job.json'))),
    'the dispatch should have written its record');
  const id = findDir();

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
  run(['cancel', id]);
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
    const d = await dispatching;
    assert.equal(d.code, 0, d.stderr);
    const id = jobIdFrom(d.stdout);

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
    run(['cancel', jobIdFrom(again.stdout)]);
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
  const staleDir = path.join(JOBS, 'ghost-1-99999');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'job.json'), JSON.stringify({
    id: 'ghost-1-99999', role: 'ghost', state: 'running',
    started: new Date(Date.now() - 3600000).toISOString(),
    supervisorPid: 999999999, codexPid: null,
  }));
  const r = run(['list']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ghost-1-99999  stale  out: /m, 'dead-pid running job listed as stale');
  assert.match(r.stdout, /done  out: /, 'finished jobs listed as done');
  assert.match(r.stdout, /killed  out: /, 'cancelled jobs listed as killed');
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

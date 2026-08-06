// Lifecycle tests for codex-dispatch, run against the fake codex.
// Usage: node --test tests/dispatch.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, '..', 'scripts', 'codex-dispatch.mjs');
const FAKE = path.join(HERE, 'fake-codex.mjs');
const JOBS = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-test-'));

const baseEnv = { ...process.env, CODEX_DISPATCH_JOBS: JOBS, CODEX_DISPATCH_BIN: FAKE };

function run(args, env = {}) {
  return spawnSync(process.execPath, [RUNTIME, ...args], {
    env: { ...baseEnv, ...env },
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
    const child = spawn(process.execPath, [RUNTIME, 'dispatch', '--brief', brief, '--role', 'race'], { env });
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

test('a codex with no sandbox subcommand runs, warned, rather than being refused', async () => {
  // An unprovable sandbox is not the same claim as a broken one: failing every
  // job on a CLI too old to have the subcommand would be inventing a defect.
  const brief = writeBrief('briefnosub.md', 'quick');
  const r = run(['dispatch', '--brief', brief, '--role', 'nosub'], { FAKE_CODEX_SANDBOX_UNAVAILABLE: '1' });
  assert.equal(r.status, 0, r.stderr);
  const id = jobIdFrom(r.stdout);
  assert.ok(await poll(() => done(id)), 'the job still runs');
  const rec = record(id);
  assert.equal(rec.sight, 'unproven');
  assert.match(rec.warning, /sight not proven/);
  assert.match(run(['status', id]).stdout, /^warning: sight not proven/m);
  const res = run(['result', id]);
  assert.equal(res.status, 0, 'the answer is delivered');
  assert.match(res.stderr, /WARNING/, 'with the caveat on stderr');
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

// Unit tests for the pure parts of the runtime: which codex binary gets picked,
// what counts as a sandbox-blind run log, and what counts as a usable job id.
// These import the runtime rather than spawning it, which is why the runtime
// only calls main() when it is the entry point.
// Usage: node --test tests/resolution.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BLIND_SIGNATURES,
  JOB_ID_RE,
  LIVE_STATES,
  ROLE_RE,
  binCandidates,
  isDesktopApp,
  livenessFromError,
  parseArgs,
  pickProbeTarget,
  scanBlindLog,
  scanBlindText,
  stripControlBytes,
  validateRecord,
  verifyClaim,
} from '../scripts/codex-dispatch.mjs';

const NPM = path.join('C:\\Users\\me\\AppData\\Roaming', 'npm', 'codex.cmd');
const DESKTOP = path.join(
  'C:\\Users\\me\\AppData\\Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'
);
const env = { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };

test('the npm build is tried first and the desktop app last', () => {
  const list = binCandidates(env, []);
  assert.equal(list[0], NPM, 'the npm build vendors the sandbox helpers, so it wins');
  assert.equal(list[list.length - 1], DESKTOP, 'the desktop app is the blind one, so it loses');
  // Bare `codex` resolves to the desktop app on a machine with both installed:
  // it must still be tried before the explicit desktop path, and after npm.
  assert.ok(list.indexOf('codex') > 0 && list.indexOf('codex') < list.length - 1);
});

test('a codex.cmd found on PATH is inserted after the npm shim, deduped', () => {
  const other = 'D:\\alt-npm\\codex.cmd';
  const list = binCandidates(env, [other, NPM]);
  assert.deepEqual(list, [NPM, other, 'codex', DESKTOP]);
});

test('without Windows env vars only PATH codex is a candidate', () => {
  assert.deepEqual(binCandidates({}, []), ['codex']);
});

test('the desktop-app build is recognizable from its path', () => {
  assert.equal(isDesktopApp(DESKTOP), true);
  assert.equal(isDesktopApp(DESKTOP.replace(/\\/g, '/')), true);
  assert.equal(isDesktopApp(NPM), false);
  assert.equal(isDesktopApp('codex'), false);
  assert.equal(isDesktopApp(undefined), false);
});

// The shape of a real blind run's tracing line, as captured live from
// codex-cli 0.146.0.
const traceLine = (sig) =>
  `2026-08-06T13:49:29.446054Z ERROR codex_core::exec: exec error: windows sandbox: ${sig}: 2`;

test('every blind signature is detected on a codex tracing line', () => {
  assert.equal(BLIND_SIGNATURES.length, 4);
  for (const sig of BLIND_SIGNATURES) {
    assert.equal(scanBlindText(`codex\nthinking\n${traceLine(sig)}\ntokens used: 8420\n`), sig);
  }
  assert.equal(
    scanBlindText('2026-08-06T13:49:29.446949Z ERROR codex_core::tools::router: error=execution ' +
      'error: Io(Custom { kind: Other, error: "windows sandbox: CreateProcessWithLogonW failed: 2" })'),
    'CreateProcessWithLogonW failed',
    'the router target must count too, not just codex_core::exec'
  );
  assert.equal(scanBlindText('thinking\ncodex\ntokens used: 1234\n'), null);
});

test('a signature that is only echoed content or prose is not a diagnosis', () => {
  // This is the live false positive: the job read source that contains the
  // signatures as literals, and the merged log made that look like a failure.
  assert.equal(scanBlindText(
    "182: export const BLIND_SIGNATURES = [\n" +
    "183:   'orchestrator_helper_launch_failed',\n" +
    "184:   'helper=codex-windows-sandbox-setup.exe',\n"
  ), null);
  assert.equal(scanBlindText("  'CreateProcessWithLogonW failed',\n"), null);
  // A blind run's own answer names the helper too; it is not the evidence.
  assert.equal(scanBlindText(
    'I cannot read README.md because codex-windows-sandbox-setup.exe was not found.'
  ), null);
  // Right words, wrong shape: no timestamp, or not a codex target.
  assert.equal(scanBlindText('ERROR: orchestrator_helper_launch_failed'), null);
  assert.equal(scanBlindText('2026-08-06T13:49:29.446054Z ERROR myapp::x: helper copy failed'), null);
});

test('a tracing line split across a read-chunk boundary is still found', () => {
  const file = path.join(os.tmpdir(), `codex-dispatch-blindscan-${process.pid}.log`);
  const line = traceLine('CreateProcessWithLogonW failed');
  // Straddle the 64 KiB read boundary: the line starts before it and ends after.
  fs.writeFileSync(file, 'x'.repeat(65536 - 20) + '\n' + line + '\n' + 'y'.repeat(100));
  try {
    assert.equal(scanBlindLog(file), 'CreateProcessWithLogonW failed');
  } finally {
    fs.unlinkSync(file);
  }
  assert.equal(scanBlindLog(path.join(os.tmpdir(), 'codex-dispatch-no-such.log')), null);
});

test('a signature on the very last line, with no trailing newline, is found', () => {
  const file = path.join(os.tmpdir(), `codex-dispatch-blindtail-${process.pid}.log`);
  fs.writeFileSync(file, `header\n${traceLine('helper copy failed')}`);
  try {
    assert.equal(scanBlindLog(file), 'helper copy failed');
  } finally {
    fs.unlinkSync(file);
  }
});

test('the sight probe reads the cwd and never writes to it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-probe-'));
  try {
    assert.equal(pickProbeTarget(dir), null, 'an empty directory has nothing to read');
    fs.mkdirSync(path.join(dir, 'sub'));
    assert.equal(pickProbeTarget(dir), null, 'a directory is not a file');

    // Sorted, so the order below is the order examined: the %-name is skipped
    // (cmd.exe would expand it), the binary yields no ASCII token, the text file
    // wins — and nothing new appears in the directory.
    fs.writeFileSync(path.join(dir, 'a%pct.txt'), 'percent names are skipped\n');
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.from([0, 1, 2, 3, 4, 5]));
    fs.writeFileSync(path.join(dir, 'b.txt'), '\n  \nhello from b\nmore\n');
    const picked = pickProbeTarget(dir);
    assert.equal(picked.name, 'b.txt');
    assert.equal(picked.token, 'hello from b', 'the token is a short ASCII line to verify the read by');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['a%pct.txt', 'a.bin', 'b.txt', 'sub'],
      'a job cwd is somebody\'s repo: the probe must leave nothing in it');

    fs.writeFileSync(path.join(dir, 'b.txt'), '');
    assert.equal(pickProbeTarget(dir), null, 'an empty file proves nothing, so it is not a target');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the record fields the new states carry are type-checked like the rest', () => {
  const base = { state: 'done', started: '2026-08-06T00:00:00.000Z' };
  assert.equal(validateRecord({ ...base, warning: 'w', sight: 'cwd-file:x', killSurvivors: '1, 2' }), null);
  assert.match(validateRecord({ ...base, warning: 5 }), /field "warning" is not a string \(number\)/);
  assert.match(validateRecord({ ...base, sight: {} }), /field "sight" is not a string \(object\)/);
  assert.match(validateRecord({ ...base, killSurvivors: [1, 2] }), /field "killSurvivors" is not a string \(array\)/);

  // The opt-in and the spent-pid list are read by the supervisor and by every
  // reap, so they are validated exactly as hard as the rest.
  assert.equal(validateRecord({ ...base, allowUnprovenSight: true, reapedPids: [1, 2] }), null);
  assert.equal(validateRecord({ ...base, allowUnprovenSight: false, reapedPids: [] }), null);
  assert.match(validateRecord({ ...base, allowUnprovenSight: 'yes' }),
    /field "allowUnprovenSight" is not a boolean \(string\)/,
    'a truthy string must not be able to buy an unproven delivery');
  assert.match(validateRecord({ ...base, reapedPids: '1,2' }),
    /field "reapedPids" is not an array \(string\)/);
  assert.match(validateRecord({ ...base, reapedPids: [1, '2'] }),
    /field "reapedPids" holds a non-number \(string\)/);
});

test('only ESRCH means dead: an access-denied liveness probe means ALIVE', () => {
  // The inversion this fixes: every exception used to read as "dead", so a kill
  // that failed because the target could not be signalled — elevated, another
  // user's, protected — reported itself as verified. EPERM is the shape of a
  // survivor, and a survivor may be codex, and codex alive is codex billing.
  assert.equal(livenessFromError({ code: 'ESRCH' }), false, 'no such process: dead');
  assert.equal(livenessFromError({ errno: -3 }), false, 'UV_ESRCH by errno: dead');
  for (const err of [
    { code: 'EPERM' },            // POSIX: exists, may not signal
    { code: 'EACCES' },           // Windows access-denied shapes
    { code: 'UNKNOWN' },
    { code: undefined },
    {},
    null,
  ]) {
    assert.equal(livenessFromError(err), true,
      `${JSON.stringify(err)} is not evidence of death, so it must read as alive`);
  }
});

test('control bytes are stripped from log output; text and whitespace survive', () => {
  assert.equal(stripControlBytes('\x1b]0;title\x07after'), ']0;titleafter', 'ESC and BEL go');
  assert.equal(stripControlBytes('\x1b[2J\x1b[1;1Hcleared'), '[2J[1;1Hcleared');
  assert.equal(stripControlBytes('a\x00b\x08c\x7fd'), 'abcd');
  assert.equal(stripControlBytes('keep\tthese\r\nand\nthese'), 'keep\tthese\r\nand\nthese',
    'tab, CR and LF are the log\'s own formatting and must survive');
  assert.equal(stripControlBytes('hyphens-and-dashes — stay'), 'hyphens-and-dashes — stay',
    'the character class must not eat a literal hyphen');
  assert.equal(stripControlBytes("C1controlstoo"), "C1controlstoo",
    'the C1 range some terminals still act on goes too');
});

test('verify-own-claim compares the owner, not the existence of the lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-claim-'));
  try {
    assert.equal(verifyClaim(dir, 'a-1-2'), false, 'no owner file: the claim is not ours');
    fs.writeFileSync(path.join(dir, 'owner'), 'a-1-2\n');
    assert.equal(verifyClaim(dir, 'a-1-2'), true);
    assert.equal(verifyClaim(dir, 'b-1-2'), false, 'somebody else took it over');
    assert.equal(verifyClaim(path.join(dir, 'gone'), 'a-1-2'), false, 'the lock dir vanished');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--allow-unproven-sight parses as a flag, not as a value-taking option', () => {
  const o = parseArgs(['dispatch', '--brief', 'b.md', '--role', 'r', '--allow-unproven-sight', '--force']);
  assert.equal(o.allowUnprovenSight, true);
  assert.equal(o.force, true);
  assert.equal(o.brief, 'b.md');
  assert.equal(o.role, 'r', 'the flag must not swallow the next argument');
  assert.equal(parseArgs(['dispatch', '--brief', 'b.md']).allowUnprovenSight, undefined,
    'and it is off unless it is asked for');
});

test('the states that may still own processes are the ones that block a role', () => {
  assert.deepEqual(LIVE_STATES, ['running', 'stale', 'kill-failed']);
  for (const terminal of ['done', 'failed', 'killed']) {
    assert.equal(LIVE_STATES.includes(terminal), false, `${terminal} must not block its role`);
  }
});

test('the job-id and role whitelists accept ours and reject the rest', () => {
  for (const id of ['reviewer-1786022862-31668', 'a-0-0']) assert.match(id, JOB_ID_RE);
  for (const id of [
    '../../etc/passwd', '..\\x', 'Reviewer-1-2', 'live-smoke-1-2', 'u1-1-2',
    'foo-1', 'foo-1-2-3', 'foo-1-2/x', '', ' foo-1-2',
  ]) assert.doesNotMatch(id, JOB_ID_RE);

  for (const role of ['reviewer', 'dispatch', 'a']) assert.match(role, ROLE_RE);
  for (const role of ['../evil', 'Live-Smoke', 'u1', 'a b', '', 'live-smoke']) {
    assert.doesNotMatch(role, ROLE_RE);
  }
});

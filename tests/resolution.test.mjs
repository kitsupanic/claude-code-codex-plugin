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
  ROLE_RE,
  binCandidates,
  isDesktopApp,
  scanBlindLog,
  scanBlindText,
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

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
  ACCEPTED_SIGHT,
  BLIND_SIGNATURES,
  CANCEL_STATES,
  CMD_UNSAFE,
  JOB_ID_RE,
  JOB_REASONS,
  KNOWN_LAUNCH_PHASES,
  KNOWN_STATES,
  LIVE_STATES,
  PID_MAX,
  PROBE_UNSAFE_NAME,
  PROVEN_SIGHT_PREFIX,
  RECORD_VERSION,
  ROLE_RE,
  ROLE_RELEASE_STATES,
  binCandidates,
  canonicalState,
  cmdQuote,
  deliverability,
  descendantsOf,
  livingDescendantsOf,
  inRegistrationWindow,
  isDesktopApp,
  isInsideRoot,
  isInsideRootReal,
  isPid,
  isProbeFileName,
  jobDirFor,
  killPlan,
  killWindow,
  launchPhase,
  livenessFromError,
  parseArgs,
  parseClaimOwner,
  pickProbeTarget,
  pickProbeToken,
  roleOfJob,
  sameStartTime,
  scanBlindLog,
  scanBlindText,
  shQuote,
  sightVerdict,
  stripControlBytes,
  validateRecord,
  verifyClaim,
  watchLaunchArgs,
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

    // Sorted, so the order below is the order examined: the $-name is skipped
    // (sh would RUN it — `sh -c "cat $(hostname).md"` executes the substitution),
    // the %-name is skipped (cmd.exe would expand it), the binary yields no ASCII
    // token, the text file wins — and nothing new appears in the directory.
    fs.writeFileSync(path.join(dir, '$(hostname).md'), 'command substitution names are skipped\n');
    fs.writeFileSync(path.join(dir, 'a%pct.txt'), 'percent names are skipped\n');
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.from([0, 1, 2, 3, 4, 5]));
    fs.writeFileSync(path.join(dir, 'b.txt'), '\n  \nhello from b\nmore\n');
    const picked = pickProbeTarget(dir);
    assert.equal(picked.name, 'b.txt');
    assert.equal(picked.token, 'hello from b', 'the token is a short ASCII line to verify the read by');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['$(hostname).md', 'a%pct.txt', 'a.bin', 'b.txt', 'sub'],
      'a job cwd is somebody\'s repo: the probe must leave nothing in it');

    fs.writeFileSync(path.join(dir, 'b.txt'), '');
    assert.equal(pickProbeTarget(dir), null, 'an empty file proves nothing, so it is not a target');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a file name a shell would expand is never quoted, and never picked', () => {
  // The POSIX probe is `sh -c "cat <name>"`, and the name comes off a directory
  // somebody else fills. JSON.stringify was doing the quoting, and it produces a
  // DOUBLE-quoted string — inside which sh expands $(...), backticks and
  // backslashes — so a file called `$(cmd).md` in the probed cwd RAN during the
  // read that was meant to prove sight. Single quotes expand nothing.
  const bs = String.fromCharCode(92);
  assert.equal(shQuote('plain.txt'), "'plain.txt'");
  assert.equal(shQuote('$(id).md'), "'$(id).md'", 'a substitution inside single quotes is inert text');
  assert.equal(shQuote('a`b`c'), "'a`b`c'");
  assert.equal(shQuote(`a${bs}b`), `'a${bs}b'`, 'a backslash is literal in single quotes, so it stays');
  // The one character single quotes cannot hold: closed, escaped, reopened.
  assert.equal(shQuote("it's.md"), `'it'${bs}''s.md'`);

  // And the second lock: both shells' expansion characters are skipped outright
  // rather than trusted to that quoting.
  for (const name of ['$(id).md', 'a`b', "it's.md", `a${bs}b`, 'a%b', 'a^b', 'a&b', 'a!b', 'a"b']) {
    assert.equal(PROBE_UNSAFE_NAME.test(name), true, `${name} must be passed over, not quoted`);
  }
  for (const name of ['README.md', 'a-b_c.1.txt', 'a b.txt', 'ünïcode.txt']) {
    assert.equal(PROBE_UNSAFE_NAME.test(name), false, `${name} is an ordinary name`);
  }
});

test('cmdQuote: a trailing backslash cannot eat the closing quote', () => {
  const bs = String.fromCharCode(92);

  // Untouched when nothing needs quoting — the cheap path stays cheap.
  assert.equal(cmdQuote('gpt-5.6-luna'), 'gpt-5.6-luna');
  assert.equal(cmdQuote('medium'), 'medium');

  // The defect (Codex review, 2026-08-07): `"foo bar\"` is read by
  // CommandLineToArgvW as an ESCAPED quote, so the argument loses its delimiter
  // and swallows the next one — `--model "x\" --sandbox read-only` stops being
  // two arguments. Doubling the run restores a delimiter that survives the parse.
  assert.equal(cmdQuote(`foo bar${bs}`), `"foo bar${bs}${bs}"`);
  assert.equal(cmdQuote(`a b${bs}${bs}`), `"a b${bs}${bs}${bs}${bs}"`);
  // Interior backslashes are NOT doubled: only the run against the delimiter is
  // ambiguous, and a path is mostly interior backslashes.
  assert.equal(cmdQuote(`C:${bs}Program Files${bs}x`), `"C:${bs}Program Files${bs}x"`);
});

test('cmdQuote: , ; and = end a cmd.exe token exactly as a space does', () => {
  // The gap (Codex review, 2026-08-07): `& | < > ( ) ^` were quoted and the three
  // characters cmd.exe treats as ordinary ARGUMENT SEPARATORS were not. A resolved
  // bin path under a directory called `to,ols` was therefore handed over unquoted
  // and cmd.exe read it as two tokens — the launch failing with "is not recognized"
  // is the good case; a resolved path silently becoming a different one is the
  // failure this function exists to refuse.
  const bs = String.fromCharCode(92);
  for (const sep of [',', ';', '=']) {
    assert.equal(cmdQuote(`D:${bs}to${sep}ols${bs}codex.cmd`), `"D:${bs}to${sep}ols${bs}codex.cmd"`,
      `${sep} splits a command token, so a path containing one must be quoted`);
    assert.equal(cmdQuote(sep), `"${sep}"`, 'even alone, with nothing else to need quoting');
  }
  // All three at once, and the trailing-backslash rule still applies over the top:
  // the run against the closing quote is doubled so the delimiter survives
  // CommandLineToArgvW.
  assert.equal(cmdQuote(`C:${bs}a,b;c=d${bs}`), `"C:${bs}a,b;c=d${bs}${bs}"`);
  // And the cheap path stays cheap: a path with none of them is still untouched.
  assert.equal(cmdQuote(`D:${bs}github${bs}repo${bs}codex.cmd`), `D:${bs}github${bs}repo${bs}codex.cmd`);
});

test('the watcher window launches THIS node, quoted for the cmd.exe line it lands on', () => {
  // The one spawn in this runtime that did not use process.execPath: the watcher
  // window was `cmd /c start <title> cmd /k node <self> _watch <id>`, with `node`
  // as a literal. A machine whose interactive PATH has no node — an nvm shim, a
  // portable install, a PATH a parent trimmed — opened a window that printed
  // "'node' is not recognized" while `watch` reported success. Every other spawn
  // here goes through process.execPath, which is the node that is demonstrably
  // running this code.
  //
  // THIS TEST ASSERTS SHAPE, AND SHAPE IS NOT ENOUGH — the version of
  // `watchLaunchArgs` that broke every install with a space in BOTH its node
  // path and its plugin path satisfied every assertion below. The test that
  // would have caught it is the one that runs the line; it lives in
  // tests/dispatch.test.mjs and this one is kept beside it, not instead of it.
  const bs = String.fromCharCode(92);
  const args = watchLaunchArgs('review-1-2');
  assert.deepEqual(args.slice(0, 2), ['/c', 'start'], 'start is what gives it its own window');
  assert.equal(args[3], 'cmd');
  assert.equal(args[4], '/s', '/s is what makes cmd strip exactly the outer quote pair below');
  assert.equal(args[5], '/k', 'and /k is what keeps the window open after the banner');
  assert.equal(args.includes('node'), false, 'never the bare word, which is a wish about PATH');
  assert.ok(args[6].includes(cmdQuote(process.execPath)), 'the node running this, quoted for cmd.exe');
  assert.match(args[6], /^".*"$/, 'and the whole tail carries the outer pair /s consumes');
  assert.match(args[6], /_watch review-1-2"$/);
  assert.equal(args.length, 7, 'the tail is ONE argument: cmd /k does not parse an argv');

  // A path with a space is quoted once, by cmdQuote — the spawn is verbatim, so
  // this is the only quoting pass and it has to be right. Both quoted at once is
  // the case that was broken: four quotes inside, one outer pair around them.
  const spaced = watchLaunchArgs('review-1-2', {
    node: `C:${bs}Program Files${bs}nodejs${bs}node.exe`,
    self: `D:${bs}my repo${bs}codex-dispatch.mjs`,
    title: 'codex-dispatch review-1-2',
  });
  assert.equal(spaced[2], '"codex-dispatch review-1-2"', 'the title start reads must survive as one token');
  assert.equal(
    spaced[6],
    `""C:${bs}Program Files${bs}nodejs${bs}node.exe" "D:${bs}my repo${bs}codex-dispatch.mjs" _watch review-1-2"`
  );

  // And it fails CLOSED on a path cmd.exe would re-parse, exactly like every
  // other value bound for a command line here — a refusal that names the fault
  // beats a window running something else.
  assert.throws(
    () => watchLaunchArgs('review-1-2', { node: `C:${bs}node%dir${bs}node.exe` }),
    (err) => err.code === 'CMD_UNQUOTABLE'
  );
  assert.throws(
    () => watchLaunchArgs('review-1-2', { self: `D:${bs}re!po${bs}codex-dispatch.mjs` }),
    (err) => err.code === 'CMD_UNQUOTABLE'
  );
});

test('cmdQuote: % ! and " are refused, because no escaping on a command line reaches them', () => {
  // `%` and `!` are expanded by cmd.exe AFTER quote stripping, so `"%PATH%"`
  // expands exactly like `%PATH%` — quoting is not a defence and no in-band escape
  // exists. `"` is refused for a different reason: cmd.exe tracks quote PARITY
  // while CommandLineToArgvW reads `\"` as an escape, so `""` satisfies one parser
  // and breaks the other. 0.7.0 escaped it as `""`, and `a\"` did not round-trip.
  const bs = String.fromCharCode(92);
  for (const v of ['%COMSPEC%', 'gpt-5 %PATH%', `D:${bs}rep%o`, '%', '!MODEL!', 'a!b', `a${bs}"`, 'say "hi"']) {
    assert.throws(() => cmdQuote(v), (err) => {
      assert.match(err.message, /cannot quote for cmd\.exe/);
      // Tagged, so main() can report it as the refusal it is instead of a stack
      // trace — and so that catch cannot silently widen to every other throw.
      assert.equal(err.code, 'CMD_UNQUOTABLE');
      return true;
    }, `${v} must be refused, not quoted`);
  }
  // Ordinary values are untouched by the guard.
  for (const v of ['gpt-5.6-sol', 'xhigh', `D:${bs}github${bs}repo`, 'C:\\Program Files\\x']) {
    assert.equal(CMD_UNSAFE.test(v), false, `${v} is an ordinary value`);
    assert.doesNotThrow(() => cmdQuote(v));
  }
});

test('a recorded pid whose start time has moved is not that process any more', () => {
  // Pid identity, decided in one place. Absence on either side is the fail-open
  // case: an older record, or an OS that would not answer, must leave the pid
  // exactly the standing it had — killed, and read as alive.
  const t = '2026-08-06T13:49:29.0000000+00:00';
  assert.equal(sameStartTime(t, t), true);
  assert.equal(sameStartTime(t, '2026-08-06T13:49:30.5000000+00:00'), true,
    'two readings of one instant differ by whatever rounded them');
  assert.equal(sameStartTime(t, '2026-08-06T13:49:40.0000000+00:00'), false,
    'ten seconds apart is a different process wearing a recycled number');
  assert.equal(sameStartTime(undefined, t), true, 'nothing recorded: keep the old behaviour');
  assert.equal(sameStartTime(t, undefined), true, 'nothing readable now: keep the old behaviour');
  assert.equal(sameStartTime('', t), true);
  assert.equal(sameStartTime('not a time', 'not a time'), true, 'identical text is identical');
  assert.equal(sameStartTime('not a time', 'some other text'), false,
    'both readings come from the same command on the same machine');
});

test('the pid start-time map is validated like every other record field', () => {
  const base = { state: 'running', started: '2026-08-06T00:00:00.000Z' };
  assert.equal(validateRecord({ ...base, pidStarts: { 1234: '2026-08-06T13:49:29Z' } }), null);
  assert.equal(validateRecord({ ...base }), null, 'a record without one stays valid');
  assert.equal(validateRecord({ ...base, pidStarts: {} }), null);
  assert.match(validateRecord({ ...base, pidStarts: [] }), /field "pidStarts" is not an object \(array\)/);
  assert.match(validateRecord({ ...base, pidStarts: '1234=x' }), /field "pidStarts" is not an object \(string\)/);
  assert.match(validateRecord({ ...base, pidStarts: { 0: 'x' } }), /is keyed by something that is not a pid/,
    'the keys are kill targets, so they live in the pid domain like every other pid');
  assert.match(validateRecord({ ...base, pidStarts: { '../x': 'y' } }), /is keyed by something that is not a pid/);
  assert.match(validateRecord({ ...base, pidStarts: { 1234: 5 } }), /holds a start time that is not a string/);
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
  // Written as \u escapes, never as the raw bytes that used to sit here. Those
  // bytes survive on disk today, but they are invisible in every editor and one
  // transcoding pass — a save as UTF-16, a tool that normalises the file — turns
  // them into something stripControlBytes has no reason to touch. The assert would
  // then read "this text equals itself" and go on passing, having quietly stopped
  // testing the C1 range at all. \u009b is CSI and \u0080 is PAD: both inside
  // 0x80-0x9f, the range some terminals still act on.
  assert.equal(stripControlBytes('C1\u009bcontrols\u0080too'), 'C1controlstoo',
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
  assert.deepEqual(LIVE_STATES, ['running', 'kill-pending', 'stale', 'kill-failed', 'unknown']);
  for (const terminal of ['done', 'failed', 'killed']) {
    assert.equal(LIVE_STATES.includes(terminal), false, `${terminal} must not block its role`);
  }
  assert.ok(LIVE_STATES.includes('kill-pending'),
    'a cancel that killed nothing leaves a job that may still own processes');
  assert.ok(LIVE_STATES.includes('unknown'),
    'a state this release cannot reason about is a job it cannot call finished');
});

test('only a state a CANCEL writes counts as "this job was cancelled while it was starting"', () => {
  // The window: a dispatch has just registered its supervisor's pid and re-reads
  // the record. It used to treat ANY non-running reading there as a cancel — and
  // the supervisor reaches a terminal state faster than the parent gets back to
  // that line, so a `failed` verdict the supervisor had already reached was killed
  // and overwritten with `killed`. Reproduced in review as
  // `killed(sandbox-blind-precheck)`: a state/reason pair the docs call impossible,
  // under a message about a cancel nobody ran. Membership is the whole fix, so
  // membership is what is pinned.
  assert.deepEqual(CANCEL_STATES, ['kill-pending', 'killed', 'kill-failed']);
  for (const written of ['failed', 'done', 'running']) {
    assert.equal(CANCEL_STATES.includes(written), false,
      `${written} is a verdict the SUPERVISOR reaches, and no cancel ever writes it`);
  }
  for (const derived of ['unknown', 'corrupt', 'stale']) {
    assert.equal(CANCEL_STATES.includes(derived), false,
      `${derived} is a reading, not a state a cancel wrote`);
  }
  for (const state of CANCEL_STATES) {
    assert.ok(KNOWN_STATES.includes(state), `${state} must be a state this release actually writes`);
  }
});

test('a role is released only from a terminal state, and a survived kill is not one', () => {
  // The supervisor used to hand the role back unconditionally once codex exited —
  // including for `kill-failed`, whose entire contract is that a cancel killed
  // codex, this supervisor SURVIVED it, and the job goes on blocking dispatch
  // (DESIGN.md, "Kills are verified"). Releasing there is a claim that everything
  // the job owned is gone, made about a process demonstrably still alive.
  assert.deepEqual(ROLE_RELEASE_STATES, ['done', 'failed', 'killed']);
  for (const live of LIVE_STATES) {
    assert.equal(ROLE_RELEASE_STATES.includes(live), false,
      `${live} may still own processes, so it must not release the role`);
  }
  assert.equal(ROLE_RELEASE_STATES.includes('kill-failed'), false,
    'a cancel that did not take keeps its claim');
  assert.equal(ROLE_RELEASE_STATES.includes('kill-pending'), false,
    'a cancel nothing has landed yet has killed nothing');
  assert.equal(ROLE_RELEASE_STATES.includes('corrupt'), false,
    'an unreadable record is silence, and silence is not death');
  for (const state of ROLE_RELEASE_STATES) {
    assert.ok(KNOWN_STATES.includes(state), `${state} must be a state this release actually writes`);
  }
});

// ---------------------------------------------------------------------------
// The validator: one gate, version-aware, fail-closed.
// ---------------------------------------------------------------------------

test('an unrecognised state resolves to unknown, which is live — never to itself', () => {
  // It used to pass through: `state !== 'running'` returned it verbatim, so a
  // typo'd "runnng" or a future "cancelling" was neither running nor a member of
  // LIVE_STATES. The job lost its role claim while codex ran.
  for (const state of KNOWN_STATES) {
    assert.equal(canonicalState({ state }), state, `${state} is a state this release writes`);
  }
  for (const state of ['runnng', 'cancelling', 'Done', 'done ', '', 'RUNNING', 'stale', 'corrupt']) {
    assert.equal(canonicalState({ state }), 'unknown',
      `${JSON.stringify(state)} must not be taken at face value`);
  }
  assert.equal(canonicalState({ __corrupt: true }), 'corrupt');
  assert.equal(canonicalState(null), 'corrupt');
  // `stale` and `corrupt` are DERIVED readings, never written — a record claiming
  // one of them is claiming something only this runtime may conclude.
  assert.equal(KNOWN_STATES.includes('stale'), false);
  assert.equal(KNOWN_STATES.includes('corrupt'), false);
});

test('an unrecognised launch phase resolves to the most dangerous one', () => {
  for (const phase of KNOWN_LAUNCH_PHASES) {
    assert.equal(launchPhase({ launch: phase }), phase);
  }
  assert.equal(launchPhase({}), 'legacy', 'absent means the record predates the field');
  for (const phase of ['spawnin', 'launching', 'EXEC', '']) {
    assert.equal(launchPhase({ launch: phase }), 'exec-spawning',
      `${JSON.stringify(phase)} must resolve to the phase in which codex may be alive and unrecorded`);
  }
  assert.equal(launchPhase({ __corrupt: true }), 'exec-spawning');
});

test('there are two kill windows, and the codex one is not time-boxed', () => {
  const now = Date.parse('2026-08-06T00:00:10.000Z');
  const started = '2026-08-06T00:00:00.000Z';
  const old = '2026-08-06T00:00:00.000Z';
  assert.equal(killWindow({ state: 'running', started, launch: 'spawning' }, now), 'supervisor');
  assert.equal(killWindow({ state: 'running', started, launch: 'spawning', supervisorPid: 42 }, now), 'none');
  assert.equal(killWindow({ state: 'running', started, launch: 'pending' }, now), 'none');
  assert.equal(killWindow({ state: 'running', started, launch: 'spawning' }, now + 60000), 'none',
    'a supervisor that never registered provably never arrived');

  // The codex window: the supervisor IS registered, and codex has been spawned
  // without being recorded. Waiting does not resolve that — only the supervisor
  // leaving the phase does — so it is not time-boxed.
  assert.equal(killWindow({ state: 'running', started: old, launch: 'exec-spawning', supervisorPid: 42 },
    now + 3600000), 'exec');
  assert.equal(killWindow({ state: 'running', started: old, launch: 'exec', supervisorPid: 42 }, now), 'none');
  // A record with no supervisor pid cannot show the supervisor is gone, so the
  // window holds — fail-closed, as everywhere else.
  assert.equal(killWindow({ state: 'running', started: old, launch: 'exec-spawning' }, now,
    { supervisorDead: true }), 'exec');
  // But a supervisor that IS recorded and provably dead can never land the cancel,
  // so the window closes rather than wedging the job at kill-pending for ever.
  assert.equal(killWindow({ state: 'running', started: old, launch: 'exec-spawning', supervisorPid: 42 }, now,
    { supervisorDead: true }), 'none');
  assert.equal(inRegistrationWindow({ state: 'running', started: old, launch: 'exec-spawning' }, now + 1e9),
    true, 'and it still reads as a registration window');
});

test('a pid is a positive integer in a domain an OS could have issued', () => {
  for (const good of [1, 4, 4242, 999999999, PID_MAX]) assert.equal(isPid(good), true, `${good}`);
  for (const bad of [0, -1, -4242, 1.5, NaN, Infinity, PID_MAX + 1, '4242', null, undefined, {}]) {
    assert.equal(isPid(bad), false, `${JSON.stringify(bad)} is not a pid`);
  }
  // The consequence, which is the reason for the domain: killPlan(-1) off Windows
  // used to expand to kill(-1) — every process this account may signal.
  assert.match(killPlan(-1, false).refuse, /not a pid/);
  assert.equal(killPlan(-1, false).signals, undefined, 'no signals, at all');
  assert.match(killPlan(0, true).refuse, /not a pid/);
  assert.equal(killPlan(0, true).tool, undefined);
  assert.match(killPlan(1.5, false).refuse, /not a pid/);
});

test('a record whose pid fields leave the pid domain is corrupt', () => {
  const base = { state: 'running', started: '2026-08-06T00:00:00.000Z' };
  assert.equal(validateRecord({ ...base, supervisorPid: 4242, codexPid: 4243 }), null);
  assert.equal(validateRecord({ ...base, supervisorPid: null, codexPid: null }), null);
  assert.match(validateRecord({ ...base, supervisorPid: -1 }), /field "supervisorPid" is not a pid/);
  assert.match(validateRecord({ ...base, supervisorPid: 0 }), /field "supervisorPid" is not a pid/);
  assert.match(validateRecord({ ...base, codexPid: 1.5 }), /field "codexPid" is not a pid/);
  assert.match(validateRecord({ ...base, codexPgid: -99 }), /field "codexPgid" is not a pid/);
  assert.equal(validateRecord({ ...base, codexPids: [10, 11] }), null);
  assert.match(validateRecord({ ...base, codexPids: [10, -11] }), /field "codexPids" holds something that is not a pid/);
  assert.match(validateRecord({ ...base, reapedPids: [0] }), /field "reapedPids" holds something that is not a pid/);
  // Counters may be zero; they may not be negative or fractional.
  assert.equal(validateRecord({ ...base, recordVersion: 0, generation: 0 }), null);
  assert.match(validateRecord({ ...base, generation: -1 }), /field "generation" is not a non-negative integer/);
  assert.match(validateRecord({ ...base, recordVersion: 1.5 }), /field "recordVersion" is not a non-negative integer/);
  // exitCode is the one number that is legitimately negative (-1 = never ran).
  assert.equal(validateRecord({ ...base, exitCode: -1 }), null);
  assert.match(validateRecord({ ...base, exitCode: 0.5 }), /field "exitCode" is not an integer/);
});

test('the fields that reach a codex command line are domain- and shape-checked', () => {
  // These three are handed STRAIGHT to codex by the supervisor and were only ever
  // type-checked. `sandbox` has a two-word domain; a rewritten job.json saying
  // `danger-full-access` was a string, so it validated, so codex launched
  // unsandboxed on a record this runtime never wrote.
  const base = { state: 'running', started: '2026-08-06T00:00:00.000Z' };
  assert.equal(validateRecord({ ...base, sandbox: 'read-only' }), null);
  assert.equal(validateRecord({ ...base, sandbox: 'workspace-write' }), null);
  assert.equal(validateRecord({ ...base }), null, 'and absent stays valid');
  for (const bad of ['danger-full-access', 'Read-Only', 'read-only ', '', 'none']) {
    assert.match(validateRecord({ ...base, sandbox: bad }), /field "sandbox" is not a sandbox mode/,
      `sandbox ${JSON.stringify(bad)} must make the record corrupt`);
  }
  assert.match(validateRecord({ ...base, sandbox: 5 }), /field "sandbox" is not a string/,
    'the type check still runs first');

  // model/effort get no whitelist — codex adds models — so the SHAPE is the check.
  for (const good of ['gpt-5.6-luna', 'gpt-5.6-sol', 'o3_mini', 'medium', 'xhigh', 'a']) {
    assert.equal(validateRecord({ ...base, model: good, effort: good }), null, good);
  }
  for (const bad of ['gpt 5', 'a;rm -rf /', '$(id)', 'a|b', 'a>b', '%PATH%', '', 'x'.repeat(81)]) {
    assert.match(validateRecord({ ...base, model: bad }),
      /field "model" is not a name this runtime would put on a codex command line/,
      `model ${JSON.stringify(bad)} must make the record corrupt`);
    assert.match(validateRecord({ ...base, effort: bad }), /field "effort" is not a name/);
  }
});

test('a started that is not a time makes the record corrupt, not the window harmless', () => {
  // `killWindow` measures the supervisor-registration window from `started`, and
  // an unparseable one fell out of Number.isFinite(Date.parse(...)) as window
  // `none` — so a cancel inside the window killed nothing, recorded `killed` and
  // released the role while the supervisor went on to launch codex. Fail-open, in
  // the one place this runtime may not be.
  assert.equal(validateRecord({ state: 'running', started: '2026-08-06T00:00:00.000Z' }), null);
  assert.equal(validateRecord({ state: 'running', started: '2026-08-06' }), null,
    'any shape Date.parse understands is a time');
  for (const bad of ['x', 'soon', 'yesterday', '2026-13-45T99:99:99Z']) {
    assert.match(validateRecord({ state: 'running', started: bad }),
      /field "started" is not a date/, `started ${JSON.stringify(bad)} must make the record corrupt`);
  }
  assert.match(validateRecord({ state: 'running' }), /field "started" is missing/,
    'and missing is still reported as missing, not as unparseable');
});

test('a sight is a proof or it is not — a prefix is never one', () => {
  assert.equal(isProbeFileName('LICENSE'), true);
  assert.equal(isProbeFileName('a file with spaces.txt'), true);
  for (const bad of ['', '   ', '.', '..', 'a/b', 'a\\b', 'a:b', ' lead', 'trail ', 'x'.repeat(256)]) {
    assert.equal(isProbeFileName(bad), false, `${JSON.stringify(bad)} is not a probe file name`);
  }

  assert.equal(sightVerdict({ sight: 'cwd-file:LICENSE' }).kind, 'proven');
  assert.equal(sightVerdict({ sight: 'cwd-file:LICENSE' }).file, 'LICENSE');
  assert.equal(sightVerdict({ sight: ACCEPTED_SIGHT }).kind, 'accepted');
  assert.equal(sightVerdict({ sight: 'job-nonce' }).kind, 'unproven');
  assert.equal(sightVerdict({ sight: 'unproven' }).kind, 'unproven');
  assert.equal(sightVerdict({}).kind, 'unproven');
  // The shapes that used to satisfy `startsWith(PROVEN_SIGHT_PREFIX)`.
  for (const forged of [
    'cwd-file:',
    'cwd-file:   ',
    'cwd-file:../../etc/passwd',
    "cwd-file:a.txt FAILED: the file's bytes never came back",
  ]) {
    assert.equal(sightVerdict({ sight: forged }).kind, 'malformed',
      `${JSON.stringify(forged)} claims the prefix and is not a proof`);
    assert.match(validateRecord({ state: 'done', started: '2026-08-06T00:00:00.000Z', sight: forged }),
      /field "sight" claims the proof prefix/,
      'and a record carrying it is corrupt, not merely undeliverable');
  }
});

test('deliverability reads the state through the validator too', () => {
  const done = {
    state: 'done', started: '2026-08-06T00:00:00.000Z', exitCode: 0,
    recordVersion: RECORD_VERSION, sight: `${PROVEN_SIGHT_PREFIX}LICENSE`,
  };
  assert.equal(deliverability(done).ok, true);
  for (const state of ['running', 'failed', 'killed', 'kill-pending', 'kill-failed']) {
    assert.equal(deliverability({ ...done, state }).ok, false, `${state} must not deliver`);
  }
  const weird = deliverability({ ...done, state: 'cancelling' });
  assert.equal(weird.ok, false, 'and an unknown state least of all');
  assert.match(weird.reason, /not one this release knows/);
  assert.equal(deliverability({ ...done, sight: 'cwd-file:' }).ok, false, 'a prefix is not a proof');
  assert.match(deliverability({ ...done, sight: 'cwd-file:' }).reason, /prefix is not a proof/);
});

test('a job belongs to the role its DIRECTORY names, so a corrupt record still has one', () => {
  // The record's `role` is unreadable exactly when it matters most. The directory
  // name is the id, and the id has already been proved to match the whitelist.
  assert.equal(roleOfJob({ id: 'review-1786022862-31668', record: {} }), 'review');
  assert.equal(roleOfJob({ id: 'review-1-2', record: { __corrupt: true } }), 'review',
    'a corrupt record must still be attributable to its role');
  assert.equal(roleOfJob({ id: 'not-an-id', record: { role: 'review' } }), 'review');
  assert.equal(roleOfJob({ id: 'not-an-id', record: { __corrupt: true } }), null);
});

test('the process tree is walked from a table, without following a cycle', () => {
  // Windows keeps a dead parent's pid on its orphans, and pids get reused, so a
  // reported parentage can loop. It must terminate, and it must not claim a root
  // as its own descendant.
  const table = new Map([[100, 1], [200, 100], [300, 200], [400, 1], [500, 500]]);
  assert.deepEqual(descendantsOf([100], table).sort(), [200, 300]);
  assert.deepEqual(descendantsOf([200], table), [300]);
  assert.deepEqual(descendantsOf([400], table), []);
  assert.deepEqual(descendantsOf([100, 200], table), [300], 'a targeted pid is not its own descendant');
  assert.deepEqual(descendantsOf([500], table), [], 'a self-parented pid must not spin');
  assert.equal(descendantsOf([100], null), null, 'an unreadable table is null, never an empty tree');
  const loop = new Map([[10, 11], [11, 10]]);
  assert.deepEqual(descendantsOf([10], loop), [11]);
  assert.deepEqual(descendantsOf([99], loop), []);
});

test('a process older than its supposed parent is not its child, and is not adopted', () => {
  // Windows leaves a dead parent's pid on its orphans, so when that number is
  // reissued to the wrapper this runtime just spawned, an unrelated process from
  // before appears in the table as our descendant — and then gets recorded in
  // codexPids with its own current start time, which is what makes it pass the
  // identity check at kill time. `taskkill /PID <n> /T /F` at a stranger's tree.
  //
  // The start times are injected, exactly as they are for the pid-reuse test: the
  // OS reissuing a chosen number is not producible on demand, and what is under
  // test is the ordering decision.
  // Numbers no live process can hold, so the second half really does get "the OS
  // would not say" rather than some unrelated process's real start time.
  //   ...801 — the fresh wrapper           ...803 — an old process still naming it
  //   ...802 — a real child of the wrapper ...804 — a real child of the stranger
  const [wrapper, child, stranger, its] = [999999801, 999999802, 999999803, 999999804];
  const table = new Map([[wrapper, 1], [child, wrapper], [stranger, wrapper], [its, stranger]]);
  const at = (s) => `2026-08-06T00:00:${String(s).padStart(2, '0')}.000Z`;
  const prior = process.env.CODEX_DISPATCH_TEST_START_TIME;
  process.env.CODEX_DISPATCH_TEST_START_TIME =
    `${wrapper}:${at(30)} ${child}:${at(31)} ${stranger}:${at(10)} ${its}:${at(11)}`;
  const sorted = (a) => a.sort((x, y) => x - y);
  try {
    assert.deepEqual(sorted(descendantsOf([wrapper], table)), [child, stranger, its],
      'the raw walk believes the ppid table, which is the defect');
    assert.deepEqual(livingDescendantsOf([wrapper], table), [child],
      'the stranger is dropped — and so is everything reachable only through it');

    // No opinion is not a verdict: an unanswered start time leaves the walk alone.
    process.env.CODEX_DISPATCH_TEST_START_TIME = `${wrapper}:${at(30)}`;
    assert.deepEqual(sorted(livingDescendantsOf([wrapper], table)), [child, stranger, its],
      'absence on either side is no opinion, and the check only ever subtracts what it can disprove');
  } finally {
    if (prior === undefined) delete process.env.CODEX_DISPATCH_TEST_START_TIME;
    else process.env.CODEX_DISPATCH_TEST_START_TIME = prior;
  }
});

test('containment is proved against the real path, not just a lexical one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-real-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-outside-'));
  try {
    const inside = path.join(root, 'review-1-2');
    fs.mkdirSync(inside);
    assert.equal(isInsideRootReal(root, inside), true);
    assert.equal(isInsideRootReal(root, path.join(root, 'not-created-yet')), true,
      'a path about to be created is judged on its deepest existing ancestor');
    assert.equal(isInsideRootReal(root, outside), false);

    const link = path.join(root, 'review-9-9');
    let linked = false;
    try { fs.symlinkSync(outside, link, 'junction'); linked = true; } catch { /* not available */ }
    if (linked) {
      assert.equal(isInsideRoot(root, link), true,
        'lexically it is inside — which is exactly why lexical containment is not containment');
      assert.equal(isInsideRootReal(root, link), false, 'and really it is not');
      assert.equal(jobDirFor(root, 'review-9-9'), null, 'so it never becomes a job directory');
      assert.equal(isInsideRootReal(root, path.join(link, 'child.pid')), false,
        'nor does anything under it');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('every reason the runtime writes is declared, and documented in commands/list.md', () => {
  // `cmdList` prints `state(reason)` for ANY reason, so the emittable set is a
  // contract with the operator. Generated from the source of truth rather than
  // remembered: a new reason that is not declared, or not documented, fails here.
  //
  // WHAT THIS SCAN CANNOT SEE, stated rather than left to be discovered: a reason
  // assembled at runtime (`reason: \`x-${y}\``, a variable, a ternary, a value
  // spread in from another object) is invisible to a source regex, and so is one
  // written through a helper that does not spell the key. Those shapes are the
  // reason the assertion below is a floor on the COUNT as well as a per-reason
  // check — a scan that suddenly matches nothing must fail loudly rather than
  // vacuously pass. All three quoting forms are matched so that merely changing a
  // quote style cannot silently drop a reason out of the contract.
  const source = fs.readFileSync(new URL('../scripts/codex-dispatch.mjs', import.meta.url), 'utf8');
  const written = new Set();
  for (const m of source.matchAll(/\breason:\s*(['"`])([a-z][a-z0-9-]*)\1/g)) written.add(m[2]);
  assert.ok(written.size >= 8, `expected the runtime to write several reasons, found ${written.size}`);
  for (const reason of written) {
    assert.ok(JOB_REASONS.includes(reason),
      `the runtime writes reason "${reason}" but JOB_REASONS does not declare it`);
  }
  const doc = fs.readFileSync(new URL('../commands/list.md', import.meta.url), 'utf8');
  for (const reason of JOB_REASONS) {
    assert.ok(doc.includes(reason), `commands/list.md does not document the reason "${reason}"`);
  }
});

test('every state/reason PAIR the runtime writes is one commands/list.md documents', () => {
  // The reason scan above checks the reasons one at a time; this is the other
  // dimension, and it is the one the 0.7.2 corruption lived in. `killed` and
  // `sandbox-blind-precheck` are each perfectly legal on their own —
  // `killed(sandbox-blind-precheck)` is a job that was both cancelled and never
  // launched, which cannot happen, and it is exactly what the post-spawn check
  // produced by writing `killed` over a verdict the supervisor had already reached.
  //
  // WHAT THIS SCAN CANNOT SEE, stated rather than left to be discovered: it pairs
  // the literals written TOGETHER in one object, so a write that sets `state`
  // while leaving an earlier `reason` in place — which is precisely how the 0.7.2
  // pair was produced — is invisible here. The record-level sweep at the end of
  // tests/dispatch.test.mjs is the half that catches those, by reading the pairs
  // this runtime actually put on disk. Both are needed; neither replaces the other.
  const source = fs.readFileSync(new URL('../scripts/codex-dispatch.mjs', import.meta.url), 'utf8');
  const states = [...source.matchAll(/\bstate:\s*(['"`])([a-z][a-z-]*)\1/g)].map((m) => [m.index, m[2]]);
  assert.ok(states.length >= 8, `expected the runtime to write several states, found ${states.length}`);

  const pairs = new Set();
  const statesByReason = new Map();
  for (const m of source.matchAll(/\breason:\s*(['"`])([a-z][a-z0-9-]*)\1/g)) {
    let owner = null;
    for (const entry of states) {
      if (entry[0] > m.index) break;
      owner = entry;
    }
    // The pairing is by proximity, so it has to be able to REFUSE rather than
    // guess: a reason written far from any state, or across an object boundary,
    // fails here instead of being silently attributed to the wrong state.
    assert.ok(owner, `the runtime writes reason "${m[2]}" with no state written before it`);
    const between = source.slice(owner[0], m.index);
    assert.ok(m.index - owner[0] < 200 && !between.includes('}'),
      `reason "${m[2]}" is not written alongside a state this scan can attribute it to; ` +
      'the pair dimension is unchecked until that is fixed');
    pairs.add(`${owner[1]}(${m[2]})`);
    if (!statesByReason.has(m[2])) statesByReason.set(m[2], new Set());
    statesByReason.get(m[2]).add(owner[1]);
  }
  // A scan that matched nothing must fail loudly rather than vacuously pass, and
  // every declared reason has to turn up in a pair or the contract has a hole.
  for (const reason of JOB_REASONS) {
    assert.ok(statesByReason.has(reason),
      `JOB_REASONS declares "${reason}" but no state/reason pair for it was found in the source`);
  }

  // The documented pairs, read out of the operator-facing contract rather than
  // remembered here. `commands/list.md` spells each one as `state(reason)`.
  const doc = fs.readFileSync(new URL('../commands/list.md', import.meta.url), 'utf8');
  const documented = new Set(
    [...doc.matchAll(/`([a-z][a-z-]*)\(([a-z][a-z0-9-]*)\)`/g)].map((m) => `${m[1]}(${m[2]})`)
  );
  assert.ok(documented.size >= JOB_REASONS.length,
    `commands/list.md must document a pair per reason, found ${documented.size}`);
  for (const pair of pairs) {
    assert.ok(documented.has(pair),
      `the runtime can write ${pair}, which commands/list.md does not document as possible`);
  }

  // And the two invariants the documentation states, applied to every pair either
  // side knows about — so neither the runtime nor the doc can start allowing one.
  const CANCEL_REASONS = ['cancelled-during-registration', 'cancelled-during-exec'];
  const NEVER_CANCELLED = [
    'sandbox-blind-precheck', 'sight-unproven', 'sight-probe-error', 'claim-lost',
    'record-version-mismatch', 'codex-argv-refused',
  ];
  for (const pair of new Set([...pairs, ...documented])) {
    const [, state, reason] = pair.match(/^([a-z-]+)\(([a-z0-9-]+)\)$/);
    if (state === 'killed') {
      assert.ok(CANCEL_REASONS.includes(reason),
        `${pair}: "killed" is what a CANCEL leaves, and ${reason} is not a cancel`);
    }
    if (NEVER_CANCELLED.includes(reason)) {
      assert.equal(state, 'failed',
        `${pair}: ${reason} is a refusal reached before or instead of a run — the only state that ` +
        'can carry it is "failed"');
    }
  }
  // `kill-failed(cancelled-during-exec)` is the one non-`killed` cancel pair, and
  // it is documented: a cancel that reached codex and could not be verified.
  assert.ok(documented.has('kill-failed(cancelled-during-exec)'));
  assert.equal(documented.has('killed(sight-unproven)'), false);
  assert.equal(documented.has('killed(sandbox-blind-precheck)'), false,
    'the pair the post-spawn check used to produce is documented as impossible');
});

test('deliverability needs the stamp, a clean exit, and proof or a recorded opt-in', () => {
  const done = { state: 'done', started: '2026-08-06T00:00:00.000Z', exitCode: 0 };
  const proven = { ...done, recordVersion: RECORD_VERSION, sight: `${PROVEN_SIGHT_PREFIX}LICENSE` };
  assert.equal(deliverability(proven).ok, true);
  assert.equal(deliverability({ ...proven, sight: 'cwd-file:a.txt' }).ok, true);

  // The stamp is what separates this release's gate from the ones before it.
  assert.equal(deliverability({ ...proven, recordVersion: undefined }).ok, false);
  assert.match(deliverability({ ...proven, recordVersion: undefined }).reason, /no current schema stamp/);
  assert.equal(deliverability({ ...proven, recordVersion: RECORD_VERSION - 1 }).ok, false);

  // Legacy shapes, exactly as 0.1/0.2 wrote them.
  for (const sight of [undefined, 'unproven', 'unproven (accepted by caller)', 'job-nonce']) {
    assert.equal(deliverability({ ...done, sight }).ok, false,
      `an unstamped record with sight ${JSON.stringify(sight)} must not deliver`);
  }

  // Consent is a boolean this runtime wrote, never a phrase in a label.
  assert.equal(deliverability({ ...done, recordVersion: RECORD_VERSION, sight: ACCEPTED_SIGHT }).ok, false);
  assert.match(
    deliverability({ ...done, recordVersion: RECORD_VERSION, sight: ACCEPTED_SIGHT }).reason,
    /no recorded opt-in/
  );
  const accepted = deliverability({
    ...done, recordVersion: RECORD_VERSION, sight: ACCEPTED_SIGHT, allowUnprovenSight: true,
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.accepted, true, 'and it is flagged so the caveat rides with the bytes');

  // A weaker sight, and a dirty exit, are each disqualifying on their own.
  assert.equal(deliverability({ ...proven, sight: 'job-nonce' }).ok, false);
  assert.equal(deliverability({ ...proven, exitCode: 1 }).ok, false);
  assert.equal(deliverability({ ...proven, exitCode: null }).ok, false);
  assert.equal(deliverability({ __corrupt: true, corruptReason: 'x' }).ok, false);
  assert.equal(deliverability(null).ok, false);
});

test('a path that leaves the jobs root is never inside it', () => {
  const root = path.join(os.tmpdir(), 'codex-dispatch-root');
  assert.equal(isInsideRoot(root, path.join(root, 'review-1-2')), true);
  assert.equal(isInsideRoot(root, path.join(root, '.role-locks', 'review')), true);
  assert.equal(isInsideRoot(root, root), false, 'the root itself is not a job inside it');
  assert.equal(isInsideRoot(root, path.join(root, '..', 'victim')), false);
  assert.equal(isInsideRoot(root, path.join(root, 'a', '..', '..', 'victim')), false);
  assert.equal(isInsideRoot(root, path.resolve(os.tmpdir(), 'elsewhere')), false);
  // A sibling whose name merely starts with the root's is outside it.
  assert.equal(isInsideRoot(root, `${root}-evil`), false);

  assert.equal(jobDirFor(root, 'review-1-2'), path.join(root, 'review-1-2'));
  for (const bad of ['../victim', '..\\victim', 'Review-1-2', 'foo-1', '', null, undefined, 42, {}]) {
    assert.equal(jobDirFor(root, bad), null, `${JSON.stringify(bad)} must not resolve to a job dir`);
  }
});

test('a claim owner is whitelisted where it is READ, not where it is used', () => {
  assert.deepEqual(parseClaimOwner('review-1786022862-31668\n'), { owner: 'review-1786022862-31668' });
  assert.deepEqual(parseClaimOwner('   a-0-0  '), { owner: 'a-0-0' });
  assert.deepEqual(parseClaimOwner(''), { owner: null });
  assert.deepEqual(parseClaimOwner('\n \n'), { owner: null });
  assert.deepEqual(parseClaimOwner(undefined), { owner: null });
  for (const bad of ['../not-a-job-dir', '..\\..\\windows', '/etc', 'C:\\Windows', 'Review-1-2']) {
    const parsed = parseClaimOwner(bad);
    assert.equal(parsed.owner, null, `${bad} must never be returned as a usable owner`);
    assert.equal(parsed.invalid, bad, 'it comes back classified as invalid instead');
  }
  // What it reports is printed, so it is defanged on the way out.
  const ESC = String.fromCharCode(27);
  assert.equal(parseClaimOwner(`${ESC}[2Jsneaky`).invalid, '[2Jsneaky');
});

test('the record fields that become paths are whitelisted, not merely typed', () => {
  const base = { state: 'done', started: '2026-08-06T00:00:00.000Z' };
  assert.equal(validateRecord({ ...base, role: 'review', id: 'review-1-2' }), null);
  // Strings, all of them — and every one of them a path segment somewhere.
  for (const role of ['../../victim', '..\\victim', 'Review', 'live-smoke', 'a b', '']) {
    assert.match(validateRecord({ ...base, role }), /field "role" is not a role/,
      `role ${JSON.stringify(role)} must make the record corrupt`);
  }
  for (const id of ['../../victim', 'Review-1-2', 'foo-1']) {
    assert.match(validateRecord({ ...base, id }), /field "id" is not a job id/);
  }
  assert.match(validateRecord({ ...base, role: 5 }), /field "role" is not a string/,
    'the type check still runs first, and still names the type');
  assert.equal(validateRecord({ ...base, recordVersion: 1 }), null);
  assert.match(validateRecord({ ...base, recordVersion: '1' }), /field "recordVersion" is not a number/);
  assert.equal(validateRecord({ ...base, launch: 'spawning' }), null);
});

test('the sight token comes from inside the file, never from its first line or its name', () => {
  // The weakness this closes: a token taken from the first line is the part a
  // stand-in that never opened the file is most likely to be able to produce —
  // a header, or the file's own name echoed back off the command line.
  assert.equal(pickProbeToken('first line here\nsecond line of content\n', 'a.txt'),
    'second line of content');
  assert.equal(pickProbeToken('only one line, quite a long one', 'a.txt'), null,
    'a one-line file yields nothing: line 0 is never the token');
  assert.equal(pickProbeToken('header\nshort\n', 'a.txt'), null, 'too short to be content');
  assert.equal(pickProbeToken('header\nname-echo.txt\nreal content on this line\n', 'name-echo.txt'),
    'real content on this line', 'a line that merely echoes the file name is skipped');
  assert.equal(pickProbeToken('header\ncafé and other non-ascii text\nplain ascii content here\n', 'a.txt'),
    'plain ascii content here', 'non-ASCII lines cannot survive a console codepage, so they are skipped');
  assert.equal(pickProbeToken('h\n' + 'x'.repeat(200) + '\n', 'a.txt').length, 60, 'and it is capped');

  // End to end through the file picker, on a directory that has both traps.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-dispatch-token-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a.txt\n');            // one line, and it is the name
    fs.writeFileSync(path.join(dir, 'b.txt'), 'title\nthe content of b lives here\nmore\n');
    const picked = pickProbeTarget(dir);
    assert.equal(picked.name, 'b.txt', 'a file with no usable token is passed over');
    assert.equal(picked.token, 'the content of b lives here');
    assert.equal(picked.token.includes(picked.name), false, 'the token cannot echo the name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a tree kill reaches the process group off Windows, and taskkill on it', () => {
  assert.deepEqual(killPlan(4242, true), { tool: 'taskkill', args: ['/PID', '4242', '/T', '/F'] });
  const posix = killPlan(4242, false);
  assert.equal(posix.tool, undefined, 'there is no taskkill off Windows');
  assert.deepEqual(posix.signals, [-4242, 4242],
    'the GROUP comes first: codex\'s own children are in it, and a bare pid never reached them');
});

test('the registration window is a recorded phase, not a missing field', () => {
  const now = Date.parse('2026-08-06T00:00:10.000Z');
  const started = '2026-08-06T00:00:00.000Z';
  // A supervisor was spawned and has not registered: nothing may call it dead.
  assert.equal(inRegistrationWindow({ state: 'running', started, launch: 'spawning' }, now), true);
  // Registered: there is a target, so a kill can be verified in the usual way.
  assert.equal(
    inRegistrationWindow({ state: 'running', started, launch: 'spawning', supervisorPid: 42 }, now), false);
  // Nothing was ever spawned, and the claim fence stops it launching later.
  assert.equal(inRegistrationWindow({ state: 'running', started, launch: 'pending' }, now), false);
  // Past the window, a supervisor that never registered provably never arrived.
  assert.equal(inRegistrationWindow({ state: 'running', started, launch: 'spawning' },
    now + 60000), false);
  // A record with no phase at all predates 0.4.0: conservative reading.
  assert.equal(inRegistrationWindow({ state: 'running', started }, now), true);
  assert.equal(inRegistrationWindow({ __corrupt: true }, now), false);
  assert.equal(inRegistrationWindow(null, now), false);
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

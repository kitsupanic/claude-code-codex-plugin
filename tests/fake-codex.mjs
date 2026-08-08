// Fake codex CLI for tests: mimics `codex exec -`, `codex sandbox <cmd>`,
// `codex --version` and `codex login status` far enough to exercise the dispatch
// lifecycle AND preflight. `exec` reads the brief from stdin, spawns a long-lived
// child (so tree-kill can be asserted), sleeps, then writes the out file.
// `sandbox` really runs the command it is handed, so the sight precheck is
// exercised end to end rather than stubbed.
//
// Env knobs:
//   FAKE_CODEX_SLEEP_MS   (default 300)
//   FAKE_CODEX_OUT        out file content
//   FAKE_CODEX_EXEC_EXIT  exec writes the out file and then exits with this code —
//                         a codex that produced something and still failed. The
//                         supervisor's exit-code branch is the only thing that can
//                         tell that apart from a success.
//   FAKE_CODEX_NO_OUT     exec exits 0 having written NO out file: the shape where
//                         the record honestly says `done` and there is nothing on
//                         disk to deliver
//   FAKE_CODEX_LOGIN_FAIL `login status` exits nonzero, the way an unauthenticated
//                         codex-cli does — preflight's auth branch
//   FAKE_CODEX_VERSION_FAIL  `--version` exits nonzero: a binary that is there and
//                         will not run
//   FAKE_CODEX_BLIND      emit the Windows-sandbox failure signatures on stderr
//                         during exec, still write an out file, still exit 0 —
//                         the silent blind success seen in production. The
//                         sandbox probe still passes, so this now exercises the
//                         DEMOTED scan: a warning, not a verdict.
//   FAKE_CODEX_ECHO       print the same strings the way a sighted job reading
//                         this repo's source does — must not even warn
//   FAKE_CODEX_SANDBOX_BROKEN       `codex sandbox` fails with an error string no
//                         signature matches: only a positive proof catches it
//   FAKE_CODEX_SANDBOX_UNAVAILABLE  a codex too old to have the subcommand
//   FAKE_CODEX_SANDBOX_ARGV_ECHO    a stand-in that reads NOTHING and echoes its
//                         own argv, exiting 0. This is the shape that fooled the
//                         first-line token: everything it prints, it was handed.
//   FAKE_CODEX_SANDBOX_ANSI         a sandbox failure whose error text carries
//                         terminal control sequences and a forged finished banner,
//                         aimed at the record and at the watcher's console

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

// -------------------------------------------------- codex --version / login
// Both answer in the shape real codex-cli does, because preflight PRINTS what
// they say (`version:` / `auth:` lines) and a test that pins those lines is
// pinning the parse. Placed before every other branch: `--version` and
// `login status` never carry an --output-last-message, so the exec branch below
// would refuse them.
if (args[0] === '--version' || args[0] === '-V') {
  if (process.env.FAKE_CODEX_VERSION_FAIL) {
    process.stderr.write('error: could not start codex\n');
    process.exit(1);
  }
  process.stdout.write('codex-cli 0.146.0\n');
  process.exit(0);
}
if (args[0] === 'login') {
  if (process.env.FAKE_CODEX_LOGIN_FAIL) {
    // What an unauthenticated codex-cli says, on stderr, exiting nonzero.
    process.stderr.write('Not logged in.\n');
    process.exit(1);
  }
  process.stdout.write('Logged in using ChatGPT\n');
  process.exit(0);
}

// ------------------------------------------------------------ codex sandbox
if (args[0] === 'sandbox') {
  const cmd = args.slice(1);
  // A WINDOW A TEST CAN AIM AT, AND A SIGNAL THAT IT IS OPEN. The sight probe is
  // the last thing the supervisor does before it writes the sight label, and the
  // test that wedges the record lock in between has to get its wedge in after
  // every write that comes BEFORE the probe (the supervisor's own pid
  // registration, which can be seconds late because the patch it carries spends
  // PowerShell time) and before the label itself. The mark says the probe has
  // started; the delay is how long it stays open.
  const mark = process.env.FAKE_CODEX_SANDBOX_MARK;
  if (mark) { try { fs.writeFileSync(mark, 'probe started\n'); } catch { /* best effort */ } }
  const delay = Number(process.env.FAKE_CODEX_SANDBOX_DELAY_MS || 0);
  if (Number.isFinite(delay) && delay > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
  if (process.env.FAKE_CODEX_SANDBOX_UNAVAILABLE) {
    process.stderr.write("error: unrecognized subcommand 'sandbox'\n\nUsage: codex [OPTIONS] [PROMPT]\n");
    process.exit(2);
  }
  if (process.env.FAKE_CODEX_SANDBOX_ARGV_ECHO) {
    // Reads nothing at all. It only proves that a process ran and could see the
    // command line it was given — which is precisely what a sight proof must not
    // accept as evidence of a read.
    process.stdout.write(`sandbox invoked with: ${cmd.join(' ')}\n`);
    process.stdout.write(`(this stand-in opened no files)\n`);
    process.exit(0);
  }
  if (process.env.FAKE_CODEX_SANDBOX_ANSI) {
    // Untrusted text with teeth: an OSC title change, a screen clear, a cursor
    // home, and a forged banner. It lands in job.json's `sight:` and from there
    // in status, list, result's stderr and the watcher's console.
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    process.stderr.write(
      `${ESC}]0;PWNED-BY-SIGHT-DETAIL${BEL}${ESC}[2J${ESC}[1;1H` +
      'sandbox refused: forged-banner-attempt JOB FINISHED - result is ready\n'
    );
    process.exit(1);
  }
  if (process.env.FAKE_CODEX_SANDBOX_BROKEN) {
    // Deliberately a failure shape NO entry in BLIND_SIGNATURES matches. The
    // whole point of a positive proof is that it does not need to have met the
    // failure before.
    process.stderr.write(
      '2026-08-06T21:02:11.001122Z ERROR codex_core::exec: exec error: sandbox: ' +
      'jail_bootstrap_unavailable: could not enter the isolation namespace (0x8007000d)\n'
    );
    process.exit(1);
  }
  // stdin is NUL and the window is hidden, for the same reason the runtime's own
  // probe spawn does both: spawnSync's default stdio hands the child a pipe whose
  // write end is closed immediately, and `cmd /c type` inheriting that can fail
  // the launch with ERROR_NO_DATA (0x800700E8) — which surfaced as a console error
  // box during a probe against a perfectly healthy binary.
  const r = spawnSync(cmd[0], cmd.slice(1), {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status === null ? 1 : r.status);
}

// ---------------------------------------------------------------- codex exec
const out = args[args.indexOf('--output-last-message') + 1];
if (!out) { process.stderr.write('fake-codex: no --output-last-message\n'); process.exit(2); }
const jobDir = path.dirname(out);
const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS || 300);

const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], {
  stdio: 'ignore', windowsHide: true,
});
// A TEST ARTIFACT, not a kill target. It exists so a test can learn the
// grandchild's pid and then assert it died — by DESCENT, through `taskkill /T` or
// the process group. The runtime deliberately does not read this file: while it
// did, the grandchild was a directly recorded target and the tree-kill tests
// could not fail on the traversal they exist to prove.
fs.writeFileSync(path.join(jobDir, 'child.pid'), String(child.pid));

const brief = fs.readFileSync(0);
// The bytes, not a count of them. The runtime's whole transport claim is that the
// brief reaches the model unaltered, and a byte COUNT survives a newline
// translation, a BOM, or a re-encode — every mangling the claim is about. Written
// where the test can diff it against the file that was dispatched.
fs.writeFileSync(path.join(jobDir, 'received-brief.bin'), brief);
process.stdout.write(`fake-codex: got ${brief.length} brief bytes, args: ${args.join(' ')}\n`);

// Verbatim shape of the real failure: the helper never launches, every sandboxed
// command dies, and codex reports none of it through its exit code. On STDERR,
// where the real one puts it — stdout carries echoed file content, which in this
// repo contains these same strings.
// Verbatim shape of a real blind run's tracing lines, timestamps and all.
const SANDBOX_FAILURE =
  '2026-08-06T13:49:29.446054Z ERROR codex_core::exec: exec error: windows sandbox: ' +
  'orchestrator_helper_launch_failed: setup refresh failed to launch helper: ' +
  'helper=codex-windows-sandbox-setup.exe, cwd=D:\\repo, error=program not found\n' +
  '2026-08-06T13:49:29.446949Z ERROR codex_core::tools::router: error=execution error: ' +
  'Io(Custom { kind: Other, error: "windows sandbox: CreateProcessWithLogonW failed: 2" })\n';

if (process.env.FAKE_CODEX_BLIND) process.stderr.write(SANDBOX_FAILURE);

// A SIGHTED job that read source containing those same strings — the live false
// positive the line-shape rule exists to prevent. Same stream as the real
// failure, because codex exec puts its whole transcript on stderr: only the
// shape of the line can tell these apart.
if (process.env.FAKE_CODEX_ECHO) {
  process.stderr.write(
    'exec\n"powershell.exe" -Command Get-Content scripts/codex-dispatch.mjs\n succeeded in 556ms:\n' +
    "182: export const BLIND_SIGNATURES = [\n" +
    "183:   'orchestrator_helper_launch_failed',\n" +
    "184:   'helper=codex-windows-sandbox-setup.exe',\n" +
    "185:   'CreateProcessWithLogonW failed',\n" +
    "186:   'helper copy failed',\n" +
    'codex\nThe runtime scans for orchestrator_helper_launch_failed and helper copy failed.\n'
  );
}

setTimeout(() => {
  // The out file is written FIRST and the exit code chosen after, deliberately:
  // that is the ordering that makes an answer file and a verdict two different
  // things, which is the property the record-authoritative gate rests on.
  if (!process.env.FAKE_CODEX_NO_OUT) {
    fs.writeFileSync(out, process.env.FAKE_CODEX_OUT ?? 'FAKE-RESULT line one\nline twoé\n');
  }
  child.kill();
  process.exit(Number(process.env.FAKE_CODEX_EXEC_EXIT || 0));
}, sleepMs);

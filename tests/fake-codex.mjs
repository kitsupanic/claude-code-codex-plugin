// Fake codex CLI for tests: mimics `codex exec -` and `codex sandbox <cmd>` far
// enough to exercise the dispatch lifecycle. `exec` reads the brief from stdin,
// spawns a long-lived child (so tree-kill can be asserted), sleeps, then writes
// the out file. `sandbox` really runs the command it is handed, so the sight
// precheck is exercised end to end rather than stubbed.
//
// Env knobs:
//   FAKE_CODEX_SLEEP_MS   (default 300)
//   FAKE_CODEX_OUT        out file content
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

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);

// ------------------------------------------------------------ codex sandbox
if (args[0] === 'sandbox') {
  const cmd = args.slice(1);
  if (process.env.FAKE_CODEX_SANDBOX_UNAVAILABLE) {
    process.stderr.write("error: unrecognized subcommand 'sandbox'\n\nUsage: codex [OPTIONS] [PROMPT]\n");
    process.exit(2);
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
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status === null ? 1 : r.status);
}

// ---------------------------------------------------------------- codex exec
const out = args[args.indexOf('--output-last-message') + 1];
if (!out) { process.stderr.write('fake-codex: no --output-last-message\n'); process.exit(2); }
const jobDir = path.dirname(out);
const sleepMs = Number(process.env.FAKE_CODEX_SLEEP_MS || 300);

const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 300000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(jobDir, 'child.pid'), String(child.pid));

const brief = fs.readFileSync(0);
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
  fs.writeFileSync(out, process.env.FAKE_CODEX_OUT ?? 'FAKE-RESULT line one\nline twoé\n');
  child.kill();
  process.exit(0);
}, sleepMs);

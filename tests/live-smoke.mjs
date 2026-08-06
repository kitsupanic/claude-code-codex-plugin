// Conditional live smoke: one real, cheap Codex dispatch — only if preflight
// passes. Skips loudly (exit 0) when codex is absent or logged out.
// Usage: node tests/live-smoke.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.join(HERE, '..', 'scripts', 'codex-dispatch.mjs');

const run = (args) => spawnSync(process.execPath, [RUNTIME, ...args], { encoding: 'utf8' });

if (process.env.CODEX_DISPATCH_BIN) {
  console.log('LIVE SMOKE SKIPPED: CODEX_DISPATCH_BIN is set; this test needs the real codex.');
  process.exit(0);
}
const pre = run(['preflight']);
if (pre.status !== 0) {
  console.log(`LIVE SMOKE SKIPPED: preflight failed:\n${(pre.stderr || pre.stdout).trim()}`);
  process.exit(0);
}
console.log(pre.stdout.trim());

const brief = path.join(os.tmpdir(), `codex-dispatch-smoke-${process.pid}.md`);
fs.writeFileSync(brief, 'Reply with exactly: DISPATCH-OK\n');

const d = run(['dispatch', '--brief', brief, '--role', 'smoke',
  '--model', 'gpt-5.3-codex-spark', '--effort', 'low', '--cd', path.join(HERE, '..'), '--force']);
if (d.status !== 0) { console.error(`LIVE SMOKE FAILED: dispatch: ${d.stderr}`); process.exit(1); }
const id = d.stdout.match(/^job: (.+)$/m)[1];
console.log(d.stdout.trim());

const deadline = Date.now() + 10 * 60 * 1000;
let state = 'running';
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 5000));
  state = run(['status', id]).stdout.match(/^state: (\w+)$/m)[1];
  if (state !== 'running') break;
  process.stdout.write('.');
}
console.log(`\nstate: ${state}`);
if (state !== 'done') { console.error(`LIVE SMOKE FAILED: job ended ${state}`); process.exit(1); }

const res = run(['result', id]);
// trailing-newline tolerance only; the transported bytes themselves are untouched
if (res.status !== 0 || res.stdout.trimEnd() !== 'DISPATCH-OK') {
  console.error(`LIVE SMOKE FAILED: expected "DISPATCH-OK", got: ${JSON.stringify(res.stdout)}`);
  process.exit(1);
}
console.log('LIVE SMOKE PASSED: result is verbatim DISPATCH-OK');

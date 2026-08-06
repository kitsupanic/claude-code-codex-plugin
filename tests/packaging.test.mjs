// Packaging tests: the manifests and command/skill files a plugin install reads.
// A broken manifest makes the plugin uninstallable and nothing else catches it.
// Usage: node --test tests/packaging.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const plugin = readJson('.claude-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');
const entry = marketplace.plugins[0];

// Frontmatter of a markdown file, as `key: value` pairs. Good enough for the
// flat, one-level frontmatter Claude Code command and skill files use.
function frontmatter(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, `${path.basename(file)} has no frontmatter block`);
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([a-zA-Z-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return { fields: out, body: text.slice(m[0].length) };
}

test('marketplace names this plugin and points at the repo root', () => {
  // The catalog is named for its owner, not for the one plugin it holds today:
  // the install string is `<plugin>@<marketplace>` = `codex-dispatch@kitsupanic`.
  assert.equal(marketplace.name, 'kitsupanic');
  assert.notEqual(marketplace.name, plugin.name);
  assert.equal(entry.name, plugin.name);
  // Root layout: the plugin IS the repo, so source is './' and plugin.json
  // must sit under .claude-plugin/ at that same root.
  assert.equal(entry.source, './');
  assert.ok(fs.existsSync(path.join(ROOT, entry.source, '.claude-plugin', 'plugin.json')));
  assert.ok(marketplace.owner?.name, 'marketplace needs an owner');
  assert.ok(marketplace.description, 'marketplace needs a description for the listing');
});

test('version is identical in all three places that carry it', () => {
  assert.equal(plugin.version, entry.version);
  assert.equal(plugin.version, marketplace.metadata.version);
});

test('every command file carries the frontmatter the loader and UI read', () => {
  const dir = path.join(ROOT, 'commands');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.deepEqual(files.sort(), ['cancel.md', 'dispatch.md', 'list.md', 'result.md', 'status.md']);
  for (const f of files) {
    const { fields, body } = frontmatter(path.join(dir, f));
    assert.ok(fields.description, `${f}: description is required`);
    assert.equal(fields['disable-model-invocation'], 'true', `${f}: user-invoked only`);
    assert.ok(fields['allowed-tools'], `${f}: allowed-tools is required`);
    // A command that reads $ARGUMENTS must tell the user what to type.
    if (body.includes('$ARGUMENTS')) {
      assert.ok(fields['argument-hint'], `${f}: takes arguments, so needs argument-hint`);
    }
    // Commands address the runtime through the plugin root, never a relative path.
    if (body.includes('codex-dispatch.mjs')) {
      assert.match(body, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/codex-dispatch\.mjs/);
    }
  }
});

test('the runtime skill is present and not user-invocable', () => {
  const skill = path.join(ROOT, 'skills', 'codex-dispatch-runtime', 'SKILL.md');
  const { fields } = frontmatter(skill);
  assert.equal(fields.name, 'codex-dispatch-runtime');
  assert.ok(fields.description);
  assert.equal(fields['user-invocable'], 'false');
});

test('no hooks ship, by design', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'hooks')), false);
  assert.equal(plugin.hooks, undefined);
});

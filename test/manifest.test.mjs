import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const manifestPath = path.join(process.cwd(), 'kimi.plugin.json');
const supportedFields = new Set([
  'name',
  'version',
  'description',
  'keywords',
  'author',
  'homepage',
  'license',
  'interface',
  'hooks',
]);
const supportedEvents = new Set([
  'StopFailure',
  'UserPromptSubmit',
  'SessionEnd',
  'Interrupt',
  'Stop',
]);

test('plugin manifest uses supported metadata and executable hook paths', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.match(manifest.name, /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*(@[A-Za-z0-9_-]+)?$/);
  assert.equal(manifest.name, 'kimi-code-429-retry');
  assert.equal(manifest.version, '1.0.0');
  for (const field of Object.keys(manifest)) {
    assert.equal(supportedFields.has(field), true, `unsupported manifest field: ${field}`);
  }

  assert.deepEqual(new Set(manifest.hooks.map((hook) => hook.event)), supportedEvents);
  for (const hook of manifest.hooks) {
    assert.match(hook.command, /^node \.\/hooks\/[a-z-]+\.mjs$/);
    assert.equal(Number.isInteger(hook.timeout), true);
    assert.equal(hook.timeout >= 1 && hook.timeout <= 600, true);
    const relativePath = hook.command.slice('node ./'.length);
    await access(path.join(process.cwd(), relativePath));
  }
});

test('package metadata stays aligned with the plugin manifest', async () => {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
  assert.equal(packageJson.name, manifest.name);
  assert.equal(packageJson.version, manifest.version);
  assert.equal(packageJson.license, manifest.license);
});

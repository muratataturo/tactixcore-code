import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { workspaceTools } from '../src/workspace-tools.mjs';

const key = 'sk-or-v1-' + 'f'.repeat(64);
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'tactixcore-interactive-'));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
}

test('configure saves the source path without persisting the value', async t => {
  const envDir = scratch(t);
  const envFile = join(envDir, 'secrets.env');
  writeFileSync(envFile, `OPENROUTER_API_KEY=${key}\n`);
  const env = { HOME: envDir };
  const out = () => {};
  assert.equal(await main(['configure', '--env-file', envFile], { env, out, err: assert.fail }), 0);
  assert.deepEqual(JSON.parse(readFileSync(join(envDir, '.config/tactixcore-code/config.json'), 'utf8')),
    { schema: 1, env_file: envFile });
  assert.equal(await main(['doctor'], { env, out, err: assert.fail }), 0);
});

test('bare command explains why the native interface needs a TTY', async () => {
  const errors = [];
  assert.equal(await main([], { isTerminal: false, err: text => errors.push(text) }), 2);
  assert.match(errors[0], /requires a terminal/);
});

test('interactive coding tools work on normal files and reject secret or external paths', async t => {
  const root = scratch(t);
  const other = scratch(t);
  const envFile = join(root, 'external-key-file');
  writeFileSync(envFile, `OPENROUTER_API_KEY=${key}\n`);
  writeFileSync(join(root, '.env'), 'sensitive');
  writeFileSync(join(root, 'hardcoded.js'), 'export const example = ' + JSON.stringify(key));
  writeFileSync(join(root, 'regular.js'), 'export const value = 1;\n');
  symlinkSync(join(root, 'regular.js'), join(root, 'symlink.js'));
  mkdirSync(join(root, 'data'));
  const tools = Object.fromEntries(workspaceTools(root, envFile).map(tool => [tool.name, tool]));
  const output = await tools.workspace_read.execute('1', { path: 'regular.js' });
  assert.match(output.content[0].text, /value = 1/);
  await tools.workspace_write.execute('2', { path: 'src/new.js', content: 'export const created = true;' });
  assert.match(readFileSync(join(root, 'src/new.js'), 'utf8'), /created/);
  for (const path of ['.env', envFile, 'hardcoded.js', 'symlink.js', join(other, 'secret')]) {
    await assert.rejects(tools.workspace_read.execute('3', { path }));
  }
  await assert.rejects(tools.workspace_write.execute('4', { path: 'not-created/.env', content: 'secret' }));
  const listing = await tools.workspace_list.execute('5', {});
  assert.doesNotMatch(listing.content[0].text, /external-key-file|\.env|data/);
});

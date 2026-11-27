import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';

const fixtureKey = 'sk-or-v1-' + 'a'.repeat(64);
function invocation(fetchKey, env = {}) {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    run: args => main(args, {
      env, fetchKey, out: value => stdout.push(value), err: value => stderr.push(value)
    })
  };
}

test('doctor reads only the named key from a selected dotenv file and stays offline', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tactixcore-code-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, '.env');
  writeFileSync(file, `OTHER=unrelated-fixture\nexport OPENROUTER_API_KEY="${fixtureKey}"\n`);
  const app = invocation(() => assert.fail('Unexpected network request'), {
    OPENROUTER_API_KEY: 'invalid'
  });
  assert.equal(await app.run(['doctor', '--env-file', file]), 0);
  assert.deepEqual(app.stderr, []);
  assert.doesNotMatch(app.stdout.join(), /unrelated-fixture|sk-or-v1/);
  writeFileSync(file, 'OTHER=unrelated-fixture\n');
  assert.equal(await app.run(['doctor', '--env-file', file]), 1);
});

test('check-openrouter sends the key only to the fixed endpoint and allowlists output', async () => {
  const app = invocation(async (url, request) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key');
    assert.equal(request.method, 'GET');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer ' + fixtureKey);
    return Response.json({
      data: { is_free_tier: false, limit_remaining: 12, label: fixtureKey }
    });
  }, { OPENROUTER_API_KEY: fixtureKey });
  assert.equal(await app.run(['check-openrouter']), 0);
  assert.deepEqual(app.stderr, []);
  assert.deepEqual(JSON.parse(app.stdout[0]), {
    authenticated: true, is_free_tier: false, key_limit_remaining_usd: 12
  });
});

test('OpenRouter errors and invalid CLI arguments do not print supplied secrets', async () => {
  const app = invocation(async () => new Response(fixtureKey, { status: 401 }), {
    OPENROUTER_API_KEY: fixtureKey
  });
  assert.equal(await app.run(['check-openrouter']), 1);
  assert.equal(await app.run(['doctor', '--unknown', fixtureKey]), 2);
  assert.deepEqual(app.stdout, []);
  assert.equal(app.stderr[0], 'OpenRouter key check failed (HTTP 401).');
  assert.ok(!app.stderr.join().includes(fixtureKey));
});

test('fetch exceptions do not print underlying diagnostics', async () => {
  const app = invocation(async () => { throw new Error(fixtureKey); }, {
    OPENROUTER_API_KEY: fixtureKey
  });
  assert.equal(await app.run(['check-openrouter']), 1);
  assert.deepEqual(app.stdout, []);
  assert.ok(!app.stderr.join().includes(fixtureKey));
});

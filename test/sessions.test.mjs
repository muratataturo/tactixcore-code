import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createUsageLedger } from '../src/usage.mjs';
import { readSessionDiagnostics, runSessionsCommand, sessionRecorder } from '../src/sessions.mjs';

test('native transcripts and allowlisted diagnostics can be located and inspected offline', async t => {
  const profile = mkdtempSync(join(tmpdir(), 'tactixcore-sessions-'));
  t.after(() => rmSync(profile, { recursive: true, force: true }));
  const agent = join(profile, 'agent');
  mkdirSync(agent);
  const previous = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  process.env.PI_CODING_AGENT_DIR = agent;
  const manager = SessionManager.create(profile);
  manager.appendMessage({ role: 'user', content: 'Private transcript fixture', timestamp: Date.now() });
  assert.match(readFileSync(manager.getSessionFile(), 'utf8'), /Private transcript fixture/);
  const record = sessionRecorder(profile, manager, createUsageLedger(), true);
  record.inference({
    outcome: 'output_limit', source: 'conversation', finishReason: 'length', tokenLimit: 12288,
    requestedModel: 'openrouter/auto', model: 'openai/gpt-5-mini', httpStatus: 200,
    usage: { prompt_tokens: 400, completion_tokens: 10, cost: 0.001, error: 'Provider body fixture' }
  });
  record.compaction({ type: 'session_compact', reason: 'manual',
    compactionEntry: { tokensBefore: 500, summary: 'Private summary fixture' } });
  const out = [];
  const id = manager.getSessionId();
  assert.equal(await runSessionsCommand(['inspect', id], { profile, out: value => out.push(value), err: assert.fail }), 0);
  assert.doesNotMatch(out[0], /Private transcript|Private summary|Provider body/);
  const inspected = JSON.parse(out[0]);
  assert.equal(inspected.usage.usd, 0.001);
  assert.equal(inspected.events[0].outcome, 'output_limit');
  assert.equal(inspected.events[1].tokens_before, 500);
  assert.equal(statSync(join(profile, 'diagnostics', id + '.ndjson')).mode & 0o777, 0o600);
  const restored = createUsageLedger();
  sessionRecorder(profile, manager, restored, true);
  assert.equal(restored.snapshot().requests, 1);
  const ephemeral = sessionRecorder(profile, SessionManager.inMemory(profile), createUsageLedger(), false);
  ephemeral.inference({ outcome: 'aborted' });
  assert.equal(readSessionDiagnostics(profile, id).length, 2);
});

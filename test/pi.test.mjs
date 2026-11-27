import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveRoute, runPi } from '../src/pi.mjs';

const fixtureKey = 'sk-or-v1-' + 'a'.repeat(64);

test('routing checks the stage and a fixed model before inference', () => {
  assert.equal(resolveRoute('agentrouter/auto').id, 'openrouter/auto');
  assert.equal(resolveRoute('openai/gpt-5-nano').id, 'openai/gpt-5-nano');
  assert.throws(() => resolveRoute('openai/gpt-5-nano', 'synthesis'));
  assert.throws(() => resolveRoute(undefined, '__proto__'));
});

test('Pi streams a routed answer and exports only approved OTLP attributes', async () => {
  const stdout = [];
  const stderr = [];
  const prompt = 'test prompt must stay out of metrics';
  let payload;
  let headers;
  let otlp;
  let modelCalls = 0;
  const status = await runPi({
    key: fixtureKey, prompt, endpoint: 'http://127.0.0.1:4318/v1/traces',
    out: text => stdout.push(text), err: text => stderr.push(text),
    fetchModel: async (url, init) => {
      modelCalls++;
      assert.equal(String(url), 'https://openrouter.ai/api/v1/chat/completions');
      assert.equal(init.redirect, 'error');
      payload = JSON.parse(init.body);
      headers = new Headers(init.headers);
      const base = { id: 'gen-fixture', created: 1, object: 'chat.completion.chunk', model: 'openai/gpt-5-nano' };
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { ...base, choices: [], usage: { prompt_tokens: 12, completion_tokens: 1, total_tokens: 13, cost: 0.000001 },
          openrouter_metadata: { attempts: [{}], raw: fixtureKey } }
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    },
    fetchTrace: async (_url, init) => {
      otlp = JSON.parse(init.body);
      return Response.json({});
    }
  });
  assert.equal(status, 0, stderr.join('\n'));
  assert.equal(modelCalls, 1);
  assert.equal(payload.model, 'openrouter/auto');
  assert.deepEqual(payload.plugins[0].allowed_models, ['openai/gpt-5-nano', 'openai/gpt-5-mini']);
  assert.deepEqual(payload.usage, { include: true });
  assert.equal(payload.max_tokens ?? payload.max_completion_tokens, 16384);
  assert.equal(payload.provider.data_collection, 'deny');
  assert.equal(payload.tools, undefined);
  assert.equal(headers.get('Authorization'), `Bearer ${fixtureKey}`);
  assert.equal(headers.get('X-OpenRouter-Metadata'), 'enabled');
  assert.deepEqual(stdout, ['OK']);
  assert.doesNotMatch(JSON.stringify(otlp), /test prompt|sk-or-v1/);
  const [inference, agent] = otlp.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(inference.traceId, agent.traceId);
  assert.equal(inference.parentSpanId, agent.spanId);
  const fields = Object.fromEntries(inference.attributes.map(({ key, value }) => [key, value]));
  assert.equal(fields['gen_ai.response.model'].stringValue, 'openai/gpt-5-nano');
  assert.equal(fields['tactixcore.cost.usd'].doubleValue, 0.000001);
});

test('interactive routing keeps cache affinity, honors output budgets, and records length separately', async () => {
  const { createOpenRouterRuntime, openRouterStream, responseOutcome } = await import('../src/pi.mjs');
  const { Trace } = await import('../src/telemetry.mjs');
  const requests = [];
  const observed = [];
  const route = resolveRoute('openai/gpt-5-nano');
  const trace = new Trace();
  const stream = openRouterStream({
    trace, route, key: fixtureKey, maxRequests: 3, maxTokens: 12288,
    sessionKey: () => 'same-session-key',
    recordUsage: record => observed.push(record),
    fetchModel: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const base = { id: 'gen-fixture', created: 1, object: 'chat.completion.chunk', model: route.id };
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Partial answer' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
        { ...base, choices: [], usage: { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26, cost: 0.001 } }
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    }
  });
  const { model } = await createOpenRouterRuntime(route, stream, 12288);
  const prompt = { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] };
  await stream(model, prompt).result();
  await stream(model, prompt).result();
  await stream(model, prompt, { cacheRetention: 'none', maxTokens: 2048 }).result();
  assert.deepEqual(requests.map(request => request.session_id), ['same-session-key', 'same-session-key', undefined]);
  assert.deepEqual(requests.map(request => request.max_tokens ?? request.max_completion_tokens), [12288, 12288, 2048]);
  assert.deepEqual(observed.map(item => item.outcome), ['output_limit', 'output_limit', 'output_limit']);
  assert.equal(observed[2].source, 'summary');
  assert.equal(responseOutcome({ stopReason: 'error', errorMessage: 'Stream ended without finish_reason' }), 'stream_interrupted');
});

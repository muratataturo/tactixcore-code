import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager
} from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { Trace } from './telemetry.mjs';

const provider = 'tactixcore-openrouter';
const origin = 'https://openrouter.ai/api/v1';
const routingPolicyVersion = '1';
const routes = {
  triage: { tier: 'low', models: ['openai/gpt-5-nano', 'openai/gpt-5-mini'] },
  synthesis: { tier: 'medium', models: ['openai/gpt-5-mini', 'openai/gpt-5.4-mini'] }
};

export function resolveRoute(model = 'agentrouter/auto', stage = 'triage') {
  if (!Object.hasOwn(routes, stage)) throw new Error('Invalid routing stage');
  const route = routes[stage];
  if (model === 'agentrouter/auto' || model === 'openrouter/auto') {
    return { ...route, id: 'openrouter/auto', stage };
  }
  if (!route.models.includes(model)) throw new Error('Model is not enabled for this stage');
  return { ...route, id: model, stage };
}

function openRouterStream({ trace, parent, route, key, fetchModel }) {
  let started = false;
  return (model, context, options) => {
    if (started) throw new Error('Pi request limit reached');
    started = true;
    const span = trace.start(`chat ${route.id}`, {
      parent, kind: 3, fields: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': 'openrouter',
        'gen_ai.request.model': route.id,
        'server.address': 'openrouter.ai',
        'tactixcore.routing.stage': route.stage,
        'tactixcore.routing.policy_version': routingPolicyVersion,
        'tactixcore.routing.cost_tier': route.tier
      }
    });
    let actualModel;
    let usage;
    let metadata;
    let httpStatus;
    let policyError;
    try {
      const stream = streamSimple(model, context, {
        ...options, apiKey: key, maxRetries: 0, maxTokens: 512, timeoutMs: 30_000,
        cacheRetention: 'none',
        headers: { 'X-OpenRouter-Metadata': 'enabled' },
        fetch: async (input, init) => {
          const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
          if (url.href !== origin + '/chat/completions') throw new Error('Unexpected OpenRouter endpoint');
          const response = await fetchModel(input, { ...init, redirect: 'error' });
          httpStatus = response.status;
          return response;
        },
        onPayload: async (payload, requestModel) => {
          const enriched = await options?.onPayload?.(payload, requestModel) ?? payload;
          return {
            ...enriched,
            model: route.id,
            provider: { data_collection: 'deny', require_parameters: true },
            ...(route.id === 'openrouter/auto' ? {
              plugins: [{ id: 'auto-router', allowed_models: route.models, cost_tier: route.tier }]
            } : {})
          };
        },
        onProviderStreamEvent: async (chunk, requestModel) => {
          if (typeof chunk.model === 'string' && route.models.includes(chunk.model)) actualModel = chunk.model;
          else if (typeof chunk.model === 'string' && chunk.model !== 'openrouter/auto') {
            policyError = true;
            throw new Error('OpenRouter returned a model outside the routing policy');
          }
          if (chunk.usage) usage = chunk.usage;
          if (chunk.openrouter_metadata) metadata = chunk.openrouter_metadata;
          await options?.onProviderStreamEvent?.(chunk, requestModel);
        }
      });
      void stream.result().then(message => {
        span.end({
          'gen_ai.response.model': actualModel,
          'gen_ai.usage.input_tokens': usage?.prompt_tokens,
          'gen_ai.usage.output_tokens': usage?.completion_tokens,
          'tactixcore.cost.usd': usage?.cost,
          'tactixcore.routing.metadata_observed': Boolean(metadata),
          'tactixcore.routing.provider_attempts': Array.isArray(metadata?.attempts) ? metadata.attempts.length : undefined,
          'http.response.status_code': httpStatus
        }, policyError ? 'model_outside_policy' : ['error', 'aborted'].includes(message.stopReason)
          ? (httpStatus >= 400 ? String(httpStatus) : message.stopReason) : undefined);
      }, () => span.end({}, 'stream_error'));
      return stream;
    } catch {
      span.end({}, 'stream_setup');
      throw new Error('OpenRouter stream could not start');
    }
  };
}

export async function runPi({
  key, prompt, model, stage, endpoint, out, err,
  fetchModel = globalThis.fetch, fetchTrace = globalThis.fetch
}) {
  const route = resolveRoute(model, stage);
  const trace = new Trace(endpoint, fetchTrace);
  const root = trace.start('invoke_agent tactixcore-code', {
    fields: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'tactixcore-code' }
  });
  const cwd = import.meta.dirname;
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  let session;
  let failure;
  try {
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
      modelsPath: null, refreshOnCreate: false
    });
    modelRuntime.registerProvider(provider, {
      baseUrl: origin, api: 'openai-completions', apiKey: 'runtime-credential',
      streamSimple: openRouterStream({ trace, parent: root, route, key, fetchModel }),
      models: [{
        id: route.id, name: route.id, input: ['text'],
        contextWindow: 16_384, maxTokens: 512, reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsStore: false }
      }]
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: 'You are TactixCore. Help with soccer questions. Say when evidence is missing.'
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd, agentDir: cwd, modelRuntime, model: modelRuntime.getModel(provider, route.id),
      settingsManager, sessionManager: SessionManager.inMemory(cwd), resourceLoader, tools: []
    }));
    await session.prompt(prompt, { expandPromptTemplates: false });
    const answer = session.getLastAssistantText();
    const last = session.messages.findLast(message => message.role === 'assistant');
    if (!answer?.trim() || ['error', 'aborted', 'length'].includes(last?.stopReason)) {
      failure = 'missing_response';
      err('Pi returned no answer. Check OpenRouter authentication, quota, and model availability.');
      return 1;
    }
    out(answer);
    return 0;
  } catch {
    failure = 'agent_error';
    err('Pi request failed.');
    return 1;
  } finally {
    session?.dispose();
    root.end({}, failure);
    if (!await trace.flush()) err('OTLP trace export failed.');
  }
}

import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager
} from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, InMemoryModelsStore, isContextOverflow } from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { Type } from 'typebox';
import { Trace } from './telemetry.mjs';
import { readBundledSkill } from './analysis-cli.mjs';
import { executeAnalysis } from './analysis.mjs';

const provider = 'tactixcore-openrouter';
const origin = 'https://openrouter.ai/api/v1';
const routingPolicyVersion = '1';
export const contextWindow = 96_000;
export const defaultOutputTokens = 16_384;
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

export function openRouterStream({
  trace, parent, route, key, fetchModel = globalThis.fetch, analysis,
  maxRequests = analysis ? 2 : 1, maxTokens = 512, recordUsage, sessionKey
}) {
  let requests = 0;
  return (model, context, options) => {
    const turn = ++requests;
    if (turn > maxRequests) throw new Error('Pi request limit reached');
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
    let requested = false;
    let finishReason;
    const tokenLimit = Math.min(maxTokens, options?.maxTokens ?? maxTokens);
    const summary = Boolean(sessionKey) && options?.cacheRetention === 'none';
    const started = performance.now();
    try {
      const stream = streamSimple(model, context, {
        ...options, apiKey: key, maxRetries: 0, maxTokens: tokenLimit, timeoutMs: 120_000,
        cacheRetention: sessionKey && !summary ? 'short' : 'none',
        headers: { 'X-OpenRouter-Metadata': 'enabled' },
        fetch: async (input, init) => {
          const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
          if (url.href !== origin + '/chat/completions') throw new Error('Unexpected OpenRouter endpoint');
          requested = true;
          const response = await fetchModel(input, { ...init, redirect: 'error' });
          httpStatus = response.status;
          return response;
        },
        onPayload: async (payload, requestModel) => {
          const enriched = await options?.onPayload?.(payload, requestModel) ?? payload;
          return {
            ...enriched,
            model: route.id,
            usage: { include: true },
            ...(sessionKey && !summary ? { session_id: sessionKey() } : {}),
            provider: { data_collection: 'deny', require_parameters: true },
            ...(analysis ? { tool_choice: turn === 1 ? 'required' : 'none' } : {}),
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
          if (chunk.usage) usage = { ...usage, ...chunk.usage };
          const reported = chunk.choices?.[0]?.finish_reason;
          if (['stop', 'length', 'tool_calls', 'content_filter', 'error'].includes(reported)) finishReason = reported;
          if (chunk.openrouter_metadata) metadata = chunk.openrouter_metadata;
          await options?.onProviderStreamEvent?.(chunk, requestModel);
        }
      });
      void stream.result().then(message => {
        const outcome = responseOutcome(message, httpStatus);
        if (requested) recordUsage?.({
          usage, model: actualModel, requestedModel: route.id, source: summary ? 'summary' : 'conversation',
          finishReason, outcome, httpStatus, tokenLimit, elapsedMs: Math.round(performance.now() - started),
          traceId: trace.traceId
        });
        const attempts = Array.isArray(metadata?.attempts) ? metadata.attempts.length : undefined;
        const position = Number.isSafeInteger(metadata?.attempt) ? metadata.attempt : undefined;
        const routingStrategy = ['direct', 'auto', 'free', 'latest', 'alias', 'fallback', 'pareto', 'bodybuilder', 'fusion']
          .includes(metadata?.strategy) ? metadata.strategy : undefined;
        span.end({
          'gen_ai.response.model': actualModel,
          'gen_ai.usage.input_tokens': usage?.prompt_tokens,
          'gen_ai.usage.output_tokens': usage?.completion_tokens,
          'gen_ai.usage.cache_read.input_tokens': usage?.prompt_tokens_details?.cached_tokens,
          'tactixcore.response.outcome': outcome,
          'tactixcore.request.output_limit': tokenLimit,
          'tactixcore.cost.usd': usage?.cost,
          'tactixcore.routing.metadata_observed': Boolean(metadata),
          'tactixcore.routing.provider_attempts': attempts ?? position,
          'tactixcore.routing.strategy': routingStrategy,
          'tactixcore.routing.used_fallback': position === undefined ? undefined : position > 1,
          'http.response.status_code': httpStatus
        }, policyError ? 'model_outside_policy' : ['error', 'aborted'].includes(message.stopReason)
          ? (httpStatus >= 400 ? String(httpStatus) : message.stopReason) : undefined);
      }, () => {
        if (requested) recordUsage?.({
          usage, model: actualModel, requestedModel: route.id, source: summary ? 'summary' : 'conversation',
          finishReason, outcome: 'stream_interrupted', httpStatus, tokenLimit,
          elapsedMs: Math.round(performance.now() - started), traceId: trace.traceId
        });
        span.end({}, 'stream_error');
      });
      return stream;
    } catch {
      span.end({}, 'stream_setup');
      throw new Error('OpenRouter stream could not start');
    }
  };
}

export function responseOutcome(message, status) {
  if (message.stopReason === 'aborted') return 'aborted';
  if (isContextOverflow(message, contextWindow)) return 'context_overflow';
  if (message.stopReason === 'length') return 'output_limit';
  if (message.stopReason !== 'error') return 'completed';
  if (status >= 400) return 'http_error';
  if (/timeout|timed out/i.test(message.errorMessage ?? '')) return 'timeout';
  if (/without finish_reason|terminated|socket|fetch failed|connection|network error/i.test(message.errorMessage ?? '')) {
    return 'stream_interrupted';
  }
  return 'provider_error';
}

export async function createOpenRouterRuntime(route, stream, maxTokens = 512) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false
  });
  modelRuntime.registerProvider(provider, {
    baseUrl: origin, api: 'openai-completions', apiKey: 'runtime-credential',
    streamSimple: stream,
    models: [{
      id: route.id, name: route.id, input: ['text'],
      contextWindow, maxTokens, reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsStore: false }
    }]
  });
  return { modelRuntime, model: modelRuntime.getModel(provider, route.id) };
}

export async function runPi({
  key, prompt, model, stage, skill, endpoint, out, err,
  analysis, env = process.env, analysisStart, fetchModel = globalThis.fetch, fetchTrace = globalThis.fetch,
  maxTokens = defaultOutputTokens
}) {
  const route = resolveRoute(model, stage);
  const guidance = skill ? readBundledSkill(skill) : null;
  const trace = new Trace(endpoint, fetchTrace);
  const root = trace.start('invoke_agent tactixcore-code', {
    fields: {
      'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'tactixcore-code',
      'tactixcore.skill.id': skill, 'tactixcore.skill.version': skill ? '1' : undefined
    }
  });
  const cwd = import.meta.dirname;
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
  let session;
  let failure;
  let analysisState = 'not_started';
  const toolName = 'run_scoped_soccer_analysis';
  try {
    const runtime = await createOpenRouterRuntime(route, openRouterStream({
      trace, parent: root, route, key, fetchModel, analysis, maxTokens
    }), maxTokens);
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: [
        'You are TactixCore. Help with soccer questions. Say when evidence is missing.',
        guidance,
        analysis && 'The user authorized exactly one preconfigured analysis. Call run_scoped_soccer_analysis once, then report its status. The report contents are local.'
      ].filter(Boolean).join('\n\n')
    });
    await resourceLoader.reload();
    const customTools = analysis ? [{
      name: toolName, label: 'Scoped soccer analysis',
      description: 'Run the user-selected soccer analysis on the exact prevalidated local inputs.',
      parameters: Type.Object({}, { additionalProperties: false }),
      execute: async (_id, params, signal) => {
        if (analysisState !== 'not_started' || Object.keys(params).length !== 0) {
          return { content: [{ type: 'text', text: 'Analysis was not run again. The tool accepts no arguments.' }], details: {} };
        }
        analysisState = 'running';
        const status = await executeAnalysis(analysis, { trace, parent: root, env, out, err, signal, start: analysisStart });
        analysisState = status === 0 ? 'completed' : 'failed';
        return {
          content: [{ type: 'text', text: status === 0 ? 'Local report generated.' : 'Local analysis failed.' }],
          details: {}
        };
      }
    }] : [];
    ({ session } = await createAgentSession({
      cwd, agentDir: cwd, ...runtime,
      settingsManager, sessionManager: SessionManager.inMemory(cwd), resourceLoader,
      tools: analysis ? [toolName] : [], customTools
    }));
    await session.prompt(prompt, { expandPromptTemplates: false });
    const answer = session.getLastAssistantText();
    const last = session.messages.findLast(message => message.role === 'assistant');
    if (last?.stopReason === 'length') {
      if (answer?.trim()) out(answer);
      failure = responseOutcome(last);
      err('The answer reached a token limit. Use a smaller task or increase --max-output-tokens.');
      return 1;
    }
    if (!answer?.trim() || ['error', 'aborted'].includes(last?.stopReason)) {
      failure = 'missing_response';
      err('Pi returned no answer. Check OpenRouter authentication, quota, and model availability.');
      return 1;
    }
    out(answer);
    if (analysis && analysisState !== 'completed') {
      failure = 'analysis_failed';
      return 1;
    }
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

import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { Type } from 'typebox';
import { Trace } from './telemetry.mjs';

const blocked = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) blocked.addSubnet(ip, prefix);
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(ip, prefix, 'ipv6');
}
const global6 = new BlockList();
global6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) return !blocked.check(address);
  return version === 6 && global6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid public URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.')) {
    throw new Error('Only public HTTPS hostnames are allowed');
  }
  if ([...url.searchParams.keys()].some(name => /^(?:access_token|api_key|apikey|password|authorization|signature|x-amz-signature|x-goog-signature)$/i.test(name))) {
    throw new Error('Only public URLs without access tokens are allowed');
  }
  url.hash = '';
  return url;
}

export async function searchPublic(query, key, { requestModel = globalThis.fetch, reportUsage, onRequest, signal } = {}) {
  if (!query?.trim() || Buffer.byteLength(query) > 600) throw new Error('Invalid public query');
  if (/sk-or-v1-|-----BEGIN |https?:\/\/\S+@|\b(?:file|gs):\/\/|\/(?:Users|home)\//i.test(query)) {
    throw new Error('Query contains a private reference');
  }
  const timeout = AbortSignal.timeout(25_000);
  const deadline = signal ? AbortSignal.any([timeout, signal]) : timeout;
  deadline.throwIfAborted();
  onRequest?.();
  const response = await requestModel('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST', redirect: 'error', signal: deadline,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-5-nano', max_tokens: 400, usage: { include: true },
      provider: { data_collection: 'deny' },
      plugins: [{ id: 'web', engine: 'exa', max_results: 5 }],
      messages: [{ role: 'user', content: query }]
    })
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Search provider refused the request');
  }
  const payload = await response.json();
  reportUsage?.(payload.usage, payload.model);
  const annotations = payload.choices?.[0]?.message?.annotations;
  const candidates = new Map();
  for (const item of Array.isArray(annotations) ? annotations.slice(0, 10) : []) {
    if (item.type !== 'url_citation') continue;
    const cite = item.url_citation;
    try {
      const url = publicUrl(cite?.url).href;
      if (!candidates.has(url)) candidates.set(url, {
        url, title: typeof cite.title === 'string' ? cite.title.slice(0, 240) : '',
        status: 'unverified_search_result',
        ...(typeof cite.content === 'string' ? { excerpt: cite.content.slice(0, 1000) } : {})
      });
    } catch {
      // Search results can include malformed and unsupported URLs.
    }
  }
  return { retrieved_at: new Date().toISOString(), results: [...candidates.values()] };
}

export async function runWeb(command, value, { key, endpoint, out, err }) {
  const trace = new Trace(endpoint);
  try {
    out(JSON.stringify(await executePublicWeb(command, value, { key, trace })));
    return 0;
  } catch {
    err(command === 'web-search' ? 'Public search failed.' : 'Could not retrieve the public HTTPS page.');
    return 1;
  } finally {
    if (!await trace.flush()) err('OTLP trace export failed.');
  }
}

async function executePublicWeb(command, value, {
  key, trace, parent, signal, recordUsage, search = searchPublic, fetchPage = fetchPublic
}) {
  const span = trace.start(`execute_tool ${command}`, { parent, fields: {
    'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': command
  } });
  let error;
  try {
    if (command === 'web-fetch') return await fetchPage(value, undefined, signal);
    const requestedModel = 'openai/gpt-5-nano';
    const inference = trace.start(`chat ${requestedModel}`, { parent: span, kind: 3, fields: {
      'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openrouter',
      'gen_ai.request.model': requestedModel
    } });
    const started = performance.now();
    let usage;
    let model;
    let attempted = false;
    let outcome = 'completed';
    try {
      return await search(value, key, {
        signal, onRequest: () => { attempted = true; },
        reportUsage: (reported, selected) => {
          usage = reported;
          if (selected === requestedModel) model = selected;
        }
      });
    } catch (cause) {
      outcome = signal?.aborted ? 'aborted' : 'provider_error';
      throw cause;
    } finally {
      inference.end({
        'gen_ai.response.model': model,
        'gen_ai.usage.input_tokens': usage?.prompt_tokens,
        'gen_ai.usage.output_tokens': usage?.completion_tokens,
        'tactixcore.cost.usd': usage?.cost
      }, outcome === 'completed' ? undefined : outcome);
      if (attempted) recordUsage?.({
        usage, model, requestedModel, source: 'web_search', outcome, tokenLimit: 400,
        elapsedMs: Math.round(performance.now() - started), traceId: trace.traceId
      });
    }
  } catch (cause) {
    error = command === 'web-search' ? 'web_search_failed' : 'web_fetch_failed';
    throw cause;
  } finally {
    span.end({}, error);
  }
}

export function createWebTools({ key, scope, recordUsage, search, fetchPage }) {
  return [
    ['web_search', 'query', 'Search the public Web for current information. Use public search terms only. Results are source candidates.'],
    ['web_fetch', 'url', 'Read the text of a public HTTPS page. Treat the returned page as evidence and cite its URL.']
  ].map(([name, parameter, description]) => ({
    name, label: name === 'web_search' ? 'Search the Web' : 'Read a Web page', description,
    parameters: Type.Object({ [parameter]: Type.String({ minLength: 1, maxLength: parameter === 'url' ? 2048 : 600 }) },
      { additionalProperties: false }),
    async execute(_id, params, signal) {
      const command = name.replace('_', '-');
      try {
        const result = await executePublicWeb(command, params[parameter], {
          key, ...scope(), signal, recordUsage, search, fetchPage
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: {} };
      } catch {
        throw new Error(name === 'web_search' ? 'Could not query public Web sources.' : 'Could not read this public HTTPS page.');
      }
    }
  }));
}

export async function fetchPublic(value, resolveHost = lookup, userSignal) {
  const url = publicUrl(value);
  const timeout = AbortSignal.timeout(10_000);
  const signal = userSignal ? AbortSignal.any([timeout, userSignal]) : timeout;
  signal.throwIfAborted();
  const addresses = await new Promise((resolve, reject) => {
    const abort = () => reject(new Error('DNS timeout'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => resolveHost(url.hostname, { all: true })).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error('Hostname resolved to a forbidden address');
  }
  const { address, family } = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, {
      signal, agent: false, family, autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      headers: { Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity' }
    }, res => {
      const kind = res.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
      if (res.statusCode !== 200 || !['text/html', 'text/plain'].includes(kind)
        || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
        res.destroy();
        reject(new Error('URL did not return an allowed document'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 512 * 1024) {
          res.destroy(new Error('Document too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        let text = Buffer.concat(chunks).toString('utf8');
        if (kind === 'text/html') {
          text = text.replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
            .replace(/<[^>]*>/g, ' ');
        }
        const normalized = text.replace(/\s+/g, ' ').trim();
        resolve({
          url: url.href, retrieved_at: new Date().toISOString(), content_type: kind,
          excerpt: normalized.slice(0, 5000), truncated: normalized.length > 5000
        });
      });
    });
    req.once('error', reject);
    req.end();
  });
}

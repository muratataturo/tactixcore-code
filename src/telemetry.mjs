import { randomBytes } from 'node:crypto';

function attributes(values) {
  return Object.entries(values).flatMap(([key, value]) => {
    if (typeof value === 'string') return [{ key, value: { stringValue: value } }];
    if (typeof value === 'boolean') return [{ key, value: { boolValue: value } }];
    if (!Number.isFinite(value)) return [];
    return [{
      key, value: Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value }
    }];
  });
}

export class Trace {
  constructor(endpoint, fetchTrace = globalThis.fetch) {
    this.traceId = randomBytes(16).toString('hex');
    this.spans = [];
    this.fetchTrace = fetchTrace;
    if (endpoint) {
      const url = new URL(endpoint);
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
        || url.username || url.password || url.search || url.hash) {
        throw new Error('Invalid OTLP endpoint');
      }
      this.endpoint = url;
    }
  }

  start(name, { parent, kind = 1, fields = {} } = {}) {
    const spanId = randomBytes(8).toString('hex');
    const start = BigInt(Date.now()) * 1_000_000n;
    const clock = process.hrtime.bigint();
    let ended = false;
    return {
      spanId,
      traceparent: `00-${this.traceId}-${spanId}-01`,
      end: (extra = {}, errorType) => {
        if (ended) return;
        ended = true;
        this.spans.push({
          traceId: this.traceId,
          spanId,
          ...(parent ? { parentSpanId: parent.spanId } : {}),
          name,
          kind,
          startTimeUnixNano: String(start),
          endTimeUnixNano: String(start + process.hrtime.bigint() - clock),
          attributes: attributes({ ...fields, ...extra, 'error.type': errorType }),
          status: { code: errorType ? 2 : 1 }
        });
      }
    };
  }

  async flush() {
    if (!this.endpoint || !this.spans.length) return true;
    try {
      const response = await this.fetchTrace(this.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(3_000),
        body: JSON.stringify({
          resourceSpans: [{
            resource: { attributes: attributes({ 'service.name': 'tactixcore-code' }) },
            scopeSpans: [{ scope: { name: 'tactixcore-code' }, spans: this.spans }]
          }]
        })
      });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const text = await response.text();
      const rejected = text && JSON.parse(text).partialSuccess?.rejectedSpans;
      return !Number(rejected);
    } catch {
      return false;
    }
  }
}

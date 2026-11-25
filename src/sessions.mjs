import { appendFileSync, constants, existsSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createUsageLedger } from './usage.mjs';

const safeId = /^[a-zA-Z0-9-]{8,80}$/;
const safeModel = /^[a-zA-Z0-9_./:-]{1,120}$/;
const modelName = value => typeof value === 'string' && safeModel.test(value) ? value : undefined;
const num = value => Number.isFinite(value) && value >= 0 ? value : undefined;
const reason = (value, allowed) => allowed.includes(value) ? value : undefined;

function diagnosticFile(profile, id) {
  if (!safeId.test(id)) throw new Error('Invalid session ID');
  return join(profile, 'diagnostics', id + '.ndjson');
}

export function readSessionDiagnostics(profile, id) {
  const file = diagnosticFile(profile, id);
  if (!existsSync(file)) return [];
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } finally { closeSync(fd); }
}

function append(profile, id, data) {
  mkdirSync(join(profile, 'diagnostics'), { mode: 0o700, recursive: true });
  const file = diagnosticFile(profile, id);
  const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW;
  const fd = openSync(file, flags, 0o600);
  try {
    appendFileSync(fd, JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n');
  } finally { closeSync(fd); }
}

export function sessionRecorder(profile, manager, usageLedger, enabled) {
  const sessionId = () => manager.getSessionId();
  const warn = { failed: false };
  if (enabled) {
    for (const event of readSessionDiagnostics(profile, sessionId())) {
      if (event.type === 'inference') usageLedger.record({ usage: event.usage, model: event.model });
    }
  }
  function write(event) {
    if (!enabled) return;
    try { append(profile, sessionId(), event); }
    catch {
      if (!warn.failed) process.stderr.write('TactixCore session diagnostics could not be saved.\n');
      warn.failed = true;
    }
  }
  return {
    inference(record) {
      usageLedger.record(record);
      const { usage } = record;
      write({
        type: 'inference', source: reason(record.source, ['conversation', 'summary']),
        model: modelName(record.model), requested_model: modelName(record.requestedModel),
        outcome: reason(record.outcome, ['completed', 'output_limit', 'context_overflow', 'timeout',
          'stream_interrupted', 'provider_error', 'http_error', 'aborted']),
        finish_reason: reason(record.finishReason, ['stop', 'length', 'tool_calls', 'content_filter', 'error']),
        http_status: num(record.httpStatus), output_limit: num(record.tokenLimit), elapsed_ms: num(record.elapsedMs),
        trace_id: /^[a-f0-9]{32}$/.test(record.traceId ?? '') ? record.traceId : undefined,
        usage: {
          prompt_tokens: num(usage?.prompt_tokens), completion_tokens: num(usage?.completion_tokens),
          cost: num(usage?.cost),
          prompt_tokens_details: { cached_tokens: num(usage?.prompt_tokens_details?.cached_tokens) },
          completion_tokens_details: { reasoning_tokens: num(usage?.completion_tokens_details?.reasoning_tokens) }
        }
      });
    },
    compaction(event) {
      write({
        type: 'compaction', reason: reason(event.reason, ['manual', 'threshold', 'overflow']),
        outcome: event.type === 'session_compact' ? 'completed' : event.aborted ? 'aborted' : 'failed',
        tokens_before: num(event.compactionEntry?.tokensBefore)
      });
    }
  };
}

export async function runSessionsCommand(args, { profile, out, err }) {
  const [operation, id] = args;
  if ((operation === 'list' && args.length !== 1) || (['inspect', 'path'].includes(operation) && args.length !== 2)
    || !['list', 'inspect', 'path'].includes(operation)) {
    err('Usage: tactixcore-code sessions list | inspect SESSION_ID | path SESSION_ID');
    return 2;
  }
  try {
    process.env.PI_CODING_AGENT_DIR = join(profile, 'agent');
    const sessions = (await SessionManager.listAll()).map(item => ({
      id: item.id, cwd: item.cwd, created: item.created, modified: item.modified,
      messages: item.messageCount, transcript: item.path
    }));
    if (operation === 'list') {
      out(JSON.stringify(sessions, null, 2));
      return 0;
    }
    const session = sessions.find(item => item.id === id);
    if (!session) {
      err('Saved session not found.');
      return 1;
    }
    if (operation === 'path') {
      out(session.transcript);
      return 0;
    }
    const events = readSessionDiagnostics(profile, id);
    const usage = createUsageLedger();
    for (const event of events) {
      if (event.type === 'inference') usage.record({ usage: event.usage, model: event.model });
    }
    out(JSON.stringify({ ...session, usage: usage.snapshot(), events }, null, 2));
    return 0;
  } catch {
    err('Could not read local sessions.');
    return 1;
  }
}

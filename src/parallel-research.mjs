import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { createOpenRouterRuntime, openRouterStream } from './pi.mjs';

const budget = 2048;
const timeout = 90_000;

export function createParallelResearchTool({ reserve, runWorker, onFinished }) {
  let active = 0;
  return {
    active: () => active,
    tool: {
      name: 'parallel_research',
      label: 'Parallel read-only research',
      description: 'Delegate two or three independent code investigations in parallel. Use for distinct areas that can be investigated without waiting for another result. Workers can read the workspace and return evidence.',
      parameters: Type.Object({
        tasks: Type.Array(Type.Object({
          title: Type.String({ minLength: 1, maxLength: 80 }),
          task: Type.String({ minLength: 1, maxLength: 4000 })
        }, { additionalProperties: false }), { minItems: 2, maxItems: 3 })
      }, { additionalProperties: false }),
      async execute(_id, { tasks }, signal, onUpdate) {
        const titles = tasks.map(task => task.title.trim());
        if (tasks.some(task => !task.task.trim()) || titles.some(title => !title)
          || new Set(titles.map(title => title.toLowerCase())).size !== tasks.length
          || new Set(tasks.map(task => task.task.trim())).size !== tasks.length) {
          throw new Error('Provide two or three distinct investigations.');
        }
        signal?.throwIfAborted();
        const scope = reserve();
        const deadline = AbortSignal.timeout(timeout);
        const cancelled = signal ? AbortSignal.any([signal, deadline]) : deadline;
        let finishedCount = 0;
        const results = await Promise.allSettled(tasks.map(async task => {
          active++;
          try {
            return await runWorker(task, scope, cancelled);
          } finally {
            active--;
            finishedCount++;
            onUpdate?.({
              content: [{ type: 'text', text: `Parallel research ${finishedCount}/${tasks.length}` }],
              details: { finishedCount, taskCount: tasks.length }
            });
          }
        }));
        const reports = results.map((result, index) => result.status === 'fulfilled'
          ? { title: titles[index], ...result.value }
          : { title: titles[index], status: cancelled.aborted ? 'aborted' : 'failed' });
        onFinished(scope, reports);
        return {
          content: [{ type: 'text', text: JSON.stringify(reports) }],
          details: { taskCount: reports.length, completed: reports.filter(report => report.status === 'completed').length }
        };
      }
    }
  };
}

export async function runResearchWorker({
  task, signal, trace, parent, route, key, workspace, agentDir, tools, recordUsage
}) {
  const span = trace.start('invoke_agent tactixcore-research', {
    parent, fields: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'tactixcore-research' }
  });
  let session;
  let outcome = 'failed';
  const abort = () => { void session?.abort().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const provider = await createOpenRouterRuntime(route, openRouterStream({
      trace, parent: span, route, key, maxRequests: 4, maxTokens: budget,
      recordUsage: record => recordUsage({ ...record, source: 'subagent' })
    }), budget);
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false }, compaction: { enabled: false }
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: 'Investigate the assigned coding question using only the read-only workspace tools. Cite files and line numbers when possible. Return concise evidence, uncertainties, and no edits.'
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: workspace, agentDir, ...provider, settingsManager, resourceLoader,
      sessionManager: SessionManager.inMemory(workspace), customTools: tools, tools: tools.map(tool => tool.name)
    }));
    signal.throwIfAborted();
    await session.prompt(task, { expandPromptTemplates: false });
    signal.throwIfAborted();
    const message = session.messages.findLast(item => item.role === 'assistant');
    const response = session.getLastAssistantText()?.trim();
    if (!response || ['error', 'aborted'].includes(message?.stopReason)) return { status: 'failed' };
    outcome = message?.stopReason === 'length' || response.length > 5000 ? 'partial' : 'completed';
    return { status: outcome, findings: response.slice(0, 5000) };
  } catch {
    outcome = signal.aborted ? 'aborted' : 'failed';
    return { status: outcome };
  } finally {
    signal.removeEventListener('abort', abort);
    session?.dispose();
    span.end({}, outcome === 'completed' ? undefined : outcome);
  }
}

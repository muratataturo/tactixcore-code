import { mkdirSync, realpathSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  InteractiveMode, initTheme, SessionManager, SettingsManager
} from '@earendil-works/pi-coding-agent';
import { getCapabilities } from '@earendil-works/pi-tui';
import { bundledSkills, readBundledSkill } from './analysis-cli.mjs';
import { createOpenRouterRuntime, defaultOutputTokens, openRouterStream, resolveRoute, responseOutcome } from './pi.mjs';
import { Trace } from './telemetry.mjs';
import { workspaceTools } from './workspace-tools.mjs';
import { dashboardExtension } from './dashboard.mjs';
import { createUsageLedger } from './usage.mjs';
import { resumeCommand, resumeSession, sessionRecorder } from './sessions.mjs';
import { createParallelResearchTool, runResearchWorker } from './parallel-research.mjs';

export async function openInteractivePi({
  key, envFile, model, stage, skill, endpoint, profile, maxTokens = defaultOutputTokens, persist = true,
  resume, parallel = true
}) {
  const route = resolveRoute(model, stage ?? (model ? 'triage' : 'synthesis'));
  const cwd = realpathSync(process.cwd());
  const agentDir = join(profile, 'agent');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  if (persist) mkdirSync(join(agentDir, 'sessions'), { recursive: true, mode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  process.env.PI_TELEMETRY = '0';
  // The trusted transport keeps the key in its closure. Pi's terminal features use process.env.
  delete process.env.OPENROUTER_API_KEY;
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: true, reserveTokens: Math.max(16384, maxTokens + 4096), keepRecentTokens: 12000 },
    quietStartup: true
  });
  const initial = resume ? await resumeSession(profile, resume)
    : persist ? SessionManager.create(cwd) : SessionManager.inMemory(cwd);
  const systemPrompt = [
    'You are TactixCore Code, a Pi coding agent for the current workspace. Use the workspace tools to inspect and edit code.',
    'Workspace tools have no shell access. If a check requires a shell command, give it to the user.',
    'Use the bundled soccer skills when applicable. Match execution uses the scoped analysis CLI with explicit inputs.',
    parallel && 'When a task has independent investigations that are substantial enough to benefit from parallel work, delegate them with parallel_research. Use the returned findings as evidence and perform edits yourself. Handle simple or dependent steps in order.',
    skill && readBundledSkill(skill)
  ].filter(Boolean).join('\n\n');

  const runtime = await createAgentSessionRuntime(async sessionOptions => {
    const workspace = realpathSync(sessionOptions.cwd);
    const fileTools = workspaceTools(workspace, envFile, [profile]);
    const usage = createUsageLedger();
    const recorder = sessionRecorder(profile, sessionOptions.sessionManager, usage, persist);
    const sessionKey = () => createHash('sha256').update(sessionOptions.sessionManager.getSessionId()).digest('hex');
    let turn;
    function endTurn(last) {
      if (!turn) return;
      const current = turn;
      turn = undefined;
      const outcome = last ? responseOutcome(last) : 'completed';
      current.parent.end({}, outcome !== 'completed' ? outcome : undefined);
      void current.trace.flush();
    }
    const contextExtension = pi => {
      pi.on('session_shutdown', (event, ctx) => {
        if (!persist || event.reason !== 'quit' || !ctx.hasUI) return;
        const command = resumeCommand(sessionOptions.sessionManager, { model, stage, skill, maxTokens, parallel });
        if (command) process.once('exit', code => {
          if (code !== 0) return;
          try { writeSync(1, `\nResume TactixCore Code: ${command}\n`); }
          catch { /* A disconnected terminal cannot display a resume command. */ }
        });
      });
      pi.on('session_before_switch', (event, ctx) => {
        if (!persist && event.reason === 'resume') {
          if (ctx.hasUI) ctx.ui.notify('Resume is unavailable in a --no-session conversation.', 'warning');
          return { cancel: true };
        }
      });
      const compacted = event => {
        recorder.compaction(event);
        if (event.reason === 'manual') endTurn();
      };
      pi.on('session_compact', compacted);
      pi.on('session_compact_failed', compacted);
      pi.on('agent_settled', (_event, ctx) => {
        const entry = ctx.sessionManager.getBranch().findLast(item =>
          item.type === 'message' && item.message.role === 'assistant');
        if (!entry || !ctx.hasUI) return;
        const outcome = responseOutcome(entry.message);
        if (outcome === 'output_limit') {
          ctx.ui.notify('Output limit reached. Ask Pi to continue in smaller sections or increase --max-output-tokens.', 'warning');
        } else if (outcome === 'stream_interrupted' || outcome === 'timeout') {
          ctx.ui.notify('OpenRouter stream was interrupted. Ask Pi to continue from the last complete step.', 'warning');
        }
      });
    };
    const newTurn = () => {
      const trace = new Trace(endpoint);
      const parent = trace.start('invoke_agent tactixcore-code', { fields: {
        'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'tactixcore-code'
      } });
      return {
        trace, parent, parallelStarted: false,
        stream: openRouterStream({
          trace, parent, route, key, maxRequests: 12, maxTokens, recordUsage: recorder.inference, sessionKey
        })
      };
    };
    const research = parallel ? createParallelResearchTool({
      reserve() {
        turn ??= newTurn();
        if (turn.parallelStarted) throw new Error('A parallel research batch already ran in this turn.');
        turn.parallelStarted = true;
        return {
          trace: turn.trace,
          parent: turn.trace.start('execute_tool parallel_research', { parent: turn.parent, fields: {
            'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'parallel_research'
          } })
        };
      },
      runWorker(task, scope, signal) {
        return runResearchWorker({
          task: task.task, workspace, agentDir, key, signal, ...scope,
          route: route.id === 'openrouter/auto' ? resolveRoute(undefined, 'triage') : route,
          tools: fileTools.filter(tool => ['workspace_read', 'workspace_list'].includes(tool.name)),
          recordUsage: recorder.inference
        });
      },
      onFinished({ trace, parent }, reports) {
        const completed = reports.filter(report => report.status === 'completed').length;
        recorder.parallel({
          taskCount: reports.length, completed,
          aborted: reports.filter(report => report.status === 'aborted').length, traceId: trace.traceId
        });
        parent.end({ 'tactixcore.parallel.tasks': reports.length, 'tactixcore.parallel.completed': completed });
      }
    }) : undefined;
    const customTools = research ? [...fileTools, research.tool] : fileTools;
    const provider = await createOpenRouterRuntime(route, (...args) => (turn ??= newTurn()).stream(...args), maxTokens);
    const services = await createAgentSessionServices({
      cwd: workspace, agentDir, modelRuntime: provider.modelRuntime, settingsManager,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [
          { name: 'tactixcore-dashboard', factory: dashboardExtension(usage, research?.active) },
          { name: 'tactixcore-context', factory: contextExtension }
        ],
        additionalSkillPaths: bundledSkills.map(name => fileURLToPath(new URL(`../skills/${name}/SKILL.md`, import.meta.url))),
        systemPrompt
      }
    });
    const result = await createAgentSessionFromServices({
      services, sessionManager: sessionOptions.sessionManager, sessionStartEvent: sessionOptions.sessionStartEvent,
      model: provider.model, customTools, tools: customTools.map(tool => tool.name)
    });
    result.session.subscribe(event => {
      if (event.type === 'agent_settled' && turn) {
        const last = result.session.messages.findLast(message => message.role === 'assistant');
        endTurn(last);
      }
    });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd: initial.getCwd(), agentDir, sessionManager: initial });
  initTheme(settingsManager.getTheme());
  try {
    await new InteractiveMode(runtime, {
      startupDiagnostics: runtime.diagnostics,
      // Pi disables the iTerm2 graphics protocol in its alternate-screen renderer.
      tuiMode: getCapabilities().images === 'iterm2' ? 'regular' : undefined
    }).run();
  } finally {
    await runtime.dispose();
  }
}

import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices,
  InteractiveMode, initTheme, SessionManager, SettingsManager
} from '@earendil-works/pi-coding-agent';
import { bundledSkills, readBundledSkill } from './analysis-cli.mjs';
import { createOpenRouterRuntime, openRouterStream, resolveRoute } from './pi.mjs';
import { Trace } from './telemetry.mjs';
import { workspaceTools } from './workspace-tools.mjs';
import { dashboardExtension } from './dashboard.mjs';
import { createUsageLedger } from './usage.mjs';

const maxTokens = 4096;

export async function openInteractivePi({ key, envFile, model, stage, skill, endpoint, profile }) {
  const route = resolveRoute(model, stage ?? (model ? 'triage' : 'synthesis'));
  const cwd = realpathSync(process.cwd());
  const agentDir = join(profile, 'agent');
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = '1';
  process.env.PI_TELEMETRY = '0';
  // The trusted transport keeps the key in its closure. Pi's terminal features use process.env.
  delete process.env.OPENROUTER_API_KEY;
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
    quietStartup: true
  });
  const customTools = workspaceTools(cwd, envFile);
  const systemPrompt = [
    'You are TactixCore Code, a Pi coding agent for the current workspace. Use the workspace tools to inspect and edit code.',
    'Workspace tools have no shell access. If a check requires a shell command, give it to the user.',
    'Use the bundled soccer skills when applicable. Match execution uses the scoped analysis CLI with explicit inputs.',
    skill && readBundledSkill(skill)
  ].filter(Boolean).join('\n\n');

  const runtime = await createAgentSessionRuntime(async sessionOptions => {
    const usage = createUsageLedger();
    const newTurn = () => {
      const trace = new Trace(endpoint);
      const parent = trace.start('invoke_agent tactixcore-code', { fields: {
        'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'tactixcore-code'
      } });
      return {
        trace, parent,
        stream: openRouterStream({
          trace, parent, route, key, maxRequests: 12, maxTokens, recordUsage: usage.record
        })
      };
    };
    let turn;
    const provider = await createOpenRouterRuntime(route, (...args) => (turn ??= newTurn()).stream(...args), maxTokens);
    const services = await createAgentSessionServices({
      cwd, agentDir, modelRuntime: provider.modelRuntime, settingsManager,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [{ name: 'tactixcore-dashboard', factory: dashboardExtension(usage) }],
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
        const current = turn;
        turn = undefined;
        const last = result.session.messages.findLast(message => message.role === 'assistant');
        current.parent.end({}, ['error', 'aborted'].includes(last?.stopReason) ? last.stopReason : undefined);
        void current.trace.flush();
      }
    });
    return { ...result, services, diagnostics: services.diagnostics };
  }, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
  initTheme(settingsManager.getTheme());
  try {
    await new InteractiveMode(runtime, { startupDiagnostics: runtime.diagnostics }).run();
  } finally {
    await runtime.dispose();
  }
}

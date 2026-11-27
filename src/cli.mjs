import { constants, openSync, closeSync, fstatSync, readFileSync, readSync } from 'node:fs';
import { parseArgs, parseEnv } from 'node:util';
import { profileDirectory, saveEnvFile, selectEnvFile } from './profile.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const help = `Usage
  tactixcore-code [--resume SESSION_ID] [--env-file PATH] [--model MODEL] [--max-output-tokens N] [--no-session] [--no-parallel]
  tactixcore-code --version
  tactixcore-code configure --env-file PATH
  tactixcore-code doctor [--env-file PATH]
  tactixcore-code check-openrouter [--env-file PATH]
  tactixcore-code studio login|status|logout|teams|games|videos|annotations|results|fetch|cache|cache-policy|clean [--environment dev|prd] [--quiet]
  tactixcore-code pi --prompt TEXT [--skill SKILL] [--env-file PATH] [--model MODEL]
  tactixcore-code pi --prompt TEXT --skill SKILL --playground PATH --team ID --game ID --analysis-input FILE
  tactixcore-code skills list
  tactixcore-code sessions list | inspect SESSION_ID | path SESSION_ID
  tactixcore-code run SKILL --playground PATH --team ID --game ID --input FILE [--dry-run]
  tactixcore-code web-search --query PUBLIC_QUERY [--env-file PATH]
  tactixcore-code web-fetch --url PUBLIC_HTTPS_URL
  tactixcore-code improve status | scan --playground PATH [--observations FILE]

Use an external dotenv file or an existing OPENROUTER_API_KEY environment variable.
doctor checks local configuration. check-openrouter queries key status only.`;
const maxEnvBytes = 64 * 1024;

function readKey(path, env) {
  let key = env.OPENROUTER_API_KEY;
  if (path !== undefined) {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Invalid file type');
      const bytes = Buffer.alloc(maxEnvBytes + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = readSync(fd, bytes, count, bytes.length - count, null);
        if (read === 0) break;
        count += read;
      }
      if (count > maxEnvBytes) throw new Error('File exceeds size limit');
      key = parseEnv(bytes.toString('utf8', 0, count)).OPENROUTER_API_KEY;
    } finally {
      closeSync(fd);
    }
  }
  if (typeof key !== 'string' || !/^sk-or-v1-[A-Za-z0-9_-]{20,200}$/.test(key)) {
    throw new Error('Missing or invalid OpenRouter key');
  }
  return key;
}

export async function main(args, {
  env = process.env,
  fetchKey = globalThis.fetch,
  out = console.log,
  err = console.error,
  isTerminal = process.stdin.isTTY && process.stdout.isTTY
} = {}) {
  const first = args[0];
  if (first === '--version' || first === '-v' || first === 'version') {
    out(`${pkg.name} ${pkg.version} (pi ${pkg.dependencies['@earendil-works/pi-coding-agent']})`);
    return 0;
  }
  if (first === '--help' || first === 'help') {
    out(help);
    return 0;
  }
  const defaultCommand = first === undefined || first.startsWith('--');
  const command = defaultCommand ? 'pi' : first;
  const flags = defaultCommand ? args : args.slice(1);
  if (command === 'studio') {
    const { runStudioCommand } = await import('./studio-mcp.mjs');
    return runStudioCommand(flags, { profile: profileDirectory(env), out, err });
  }
  if (command === 'sessions') {
    const { runSessionsCommand } = await import('./sessions.mjs');
    return runSessionsCommand(flags, { profile: profileDirectory(env), out, err });
  }
  if (command === 'skills' || command === 'run') {
    const { runAnalysisCommand } = await import('./analysis-cli.mjs');
    return runAnalysisCommand(command, flags, { env, out, err });
  }
  if (command === 'improve') {
    const { runImproveCommand } = await import('./improve.mjs');
    return runImproveCommand(flags, { env, out, err });
  }
  if (!['configure', 'doctor', 'check-openrouter', 'pi', 'web-search', 'web-fetch'].includes(command)) {
    err(help);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: flags,
      options: {
        'env-file': { type: 'string' }, help: { type: 'boolean' },
        ...(command === 'pi' ? {
          prompt: { type: 'string' }, model: { type: 'string' }, stage: { type: 'string' }, skill: { type: 'string' },
          'otlp-endpoint': { type: 'string' }, 'analysis-input': { type: 'string' },
          'max-output-tokens': { type: 'string' }, 'no-session': { type: 'boolean' },
          resume: { type: 'string' }, 'no-parallel': { type: 'boolean' },
          playground: { type: 'string' }, team: { type: 'string' }, game: { type: 'string' },
          opponent: { type: 'string' }, player: { type: 'string' }
        } : {}),
        ...(command === 'web-search' ? { query: { type: 'string' } } : {}),
        ...(command === 'web-fetch' ? { url: { type: 'string' } } : {})
      }
    }));
  } catch {
    err(help);
    return 2;
  }
  if (values.help) {
    out(help);
    return 0;
  }
  const interactive = command === 'pi' && values.prompt === undefined;
  if (values.resume !== undefined && (!interactive || values['no-session'])) {
    err('--resume requires interactive mode with session storage enabled.');
    return 2;
  }
  const outputBudget = values['max-output-tokens'];
  const maxTokens = outputBudget === undefined ? undefined : Number(outputBudget);
  if (outputBudget !== undefined && (!/^\d+$/.test(outputBudget) || maxTokens < 1024 || maxTokens > 24576)) {
    err('--max-output-tokens must be an integer between 1024 and 24576.');
    return 2;
  }
  if (interactive && !isTerminal) {
    err('Pi interactive mode requires a terminal. Use pi --prompt TEXT for one-shot use.');
    return 2;
  }
  if (interactive && [values['analysis-input'], values.playground, values.team, values.game, values.player, values.opponent].some(value => value !== undefined)) {
    err('Scoped match analysis requires pi --prompt TEXT.');
    return 2;
  }
  if (command === 'web-fetch') {
    try {
      const { runWeb } = await import('./web.mjs');
      return await runWeb(command, values.url, { endpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, out, err });
    } catch {
      err('Could not retrieve the public HTTPS page.');
      return 1;
    }
  }

  if (command === 'configure' && !values['env-file']) {
    err('Usage: tactixcore-code configure --env-file PATH');
    return 2;
  }
  let key;
  let envFile;
  try {
    envFile = selectEnvFile(values['env-file'], env);
    key = readKey(envFile, env);
  } catch {
    err('OpenRouter key unavailable. Run tactixcore-code configure --env-file PATH.');
    return 1;
  }
  if (command === 'configure') {
    try {
      saveEnvFile(env, envFile);
      out('OpenRouter credential file configured. Run tactixcore-code to start Pi.');
      return 0;
    } catch {
      err('Could not save the credential file setting.');
      return 1;
    }
  }
  if (command === 'doctor') {
    out('OpenRouter key configured. Run check-openrouter to verify credentials.');
    return 0;
  }
  if (command === 'pi') {
    if (interactive) {
      try {
        const { openInteractivePi } = await import('./interactive.mjs');
        await openInteractivePi({
          key, envFile, model: values.model, stage: values.stage, skill: values.skill,
          endpoint: values['otlp-endpoint'] ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
          profile: profileDirectory(env), maxTokens, persist: !values['no-session'],
          resume: values.resume, parallel: !values['no-parallel']
        });
        return 0;
      } catch {
        err(values.resume === undefined ? 'Pi could not start. Check the terminal, workspace, and configured model.'
          : 'Could not resume. Verify the session ID with tactixcore-code sessions list.');
        return 1;
      }
    }
    if (!values.prompt?.trim() || Buffer.byteLength(values.prompt) > 16_384) {
      err('Provide a --prompt between 1 and 16384 UTF-8 bytes.');
      return 2;
    }
    try {
      const { runPi } = await import('./pi.mjs');
      let analysis;
      if (values['analysis-input'] !== undefined) {
        const { planAnalysis } = await import('./analysis.mjs');
        analysis = planAnalysis(values.skill, {
          playground: values.playground ?? env.TACTIXCORE_PLAYGROUND, input: values['analysis-input'],
          team: values.team, game: values.game, opponent: values.opponent, player: values.player, env
        });
      }
      return await runPi({
        key, prompt: values.prompt, model: values.model, stage: values.stage, skill: values.skill,
        endpoint: values['otlp-endpoint'] ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
        analysis, env, out, err, maxTokens
      });
    } catch {
      err('Pi could not complete the request. Check the model, endpoint, and any selected analysis inputs.');
      return 1;
    }
  }
  if (command === 'web-search') {
    try {
      const { runWeb } = await import('./web.mjs');
      return await runWeb(command, values.query, { key, endpoint: env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, out, err });
    } catch {
      err('Public search failed. Check the query and OpenRouter connectivity.');
      return 1;
    }
  }

  try {
    const response = await fetchKey('https://openrouter.ai/api/v1/key', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      err(`OpenRouter key check failed (HTTP ${response.status}).`);
      return 1;
    }
    const { data } = await response.json();
    if (typeof data?.is_free_tier !== 'boolean') throw new Error('Invalid response');
    out(JSON.stringify({
      authenticated: true,
      is_free_tier: data.is_free_tier,
      key_limit_remaining_usd: Number.isFinite(data.limit_remaining) ? data.limit_remaining : null
    }));
    return 0;
  } catch {
    err('OpenRouter key check failed. Check network connectivity and try again.');
    return 1;
  }
}

import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { analysisSkills, executeAnalysis, planAnalysis } from './analysis.mjs';

const help = 'Usage: tactixcore-code run SKILL --playground PATH --team ID --game ID --input FILE [--dry-run]';
export const bundledSkills = [...Object.keys(analysisSkills), 'web-search', 'web-fetch'];
export function readBundledSkill(name) {
  if (!bundledSkills.includes(name)) throw new Error('Unknown bundled skill');
  return readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
}

export async function runAnalysisCommand(command, args, { env, out, err }) {
  if (command === 'skills') {
    if (args[0] === 'list' && args.length === 1) {
      out(bundledSkills.join('\n'));
      return 0;
    }
    if (args[0] === 'show' && args.length === 2 && bundledSkills.includes(args[1])) {
      out(readBundledSkill(args[1]));
      return 0;
    }
    err('Usage: tactixcore-code skills list | show SKILL');
    return 2;
  }
  let values;
  let positionals;
  try {
    ({ values, positionals } = parseArgs({
      args, allowPositionals: true, options: {
        playground: { type: 'string' }, team: { type: 'string' }, game: { type: 'string' },
        input: { type: 'string' }, opponent: { type: 'string' }, player: { type: 'string' },
        'dry-run': { type: 'boolean' }, 'otlp-endpoint': { type: 'string' }, help: { type: 'boolean' }
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
  if (positionals.length !== 1 || !values.input) {
    err(help);
    return 2;
  }
  try {
    const plan = planAnalysis(positionals[0], {
      ...values, playground: values.playground ?? env.TACTIXCORE_PLAYGROUND
    });
    if (values['dry-run']) {
      out(JSON.stringify({
        skill_id: plan.skill, team_id: plan.team, game_ids: [plan.game],
        run_id: plan.runId, manifest_sha256: plan.manifestSha256,
        engine_entrypoint_sha256: plan.engineEntrypointSha256, report_parent: plan.reportParent
      }));
      return 0;
    }
    return await executeAnalysis(plan, {
      env, out, err, endpoint: values['otlp-endpoint'] ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    });
  } catch {
    err('Analysis inputs are invalid or unavailable. Check skill, scope, manifest, and Python environment.');
    return 1;
  }
}

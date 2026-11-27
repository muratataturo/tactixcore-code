import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { bundledSkills, readBundledSkill } from './analysis-cli.mjs';

const rules = {
  missing_evidence: ['soccer-ownteam', '既存の結論ごとに、時刻付きの参照と集計対象を確かめる。欠けている場合は評価を保留する。'],
  opponent_scope_mismatch: ['soccer-opponent', '資料のチーム、年代、大会、シーズンを取得時と集約時に照合する。'],
  player_unconfirmed: ['soccer-player', '対象本人と強調トラックを場面ごとに分けて照合する。本人未確認の場面を保留する。'],
  stale_source: ['web-search', '公式資料の対象年度と取得時刻を確認し、要求と異なる年度の資料を保留する。'],
  inaccessible_source: ['web-fetch', '取得できた範囲を記録し、本文を取得できなかったページの判断を保留する。'],
  unsupported_evidence_review: [null, '自チーム、対戦相手、選手の分析に含まれる根拠を見直す。対象試合、時刻、分母、出典を確認し、判断できない項目を明示する。']
};
const hash = value => createHash('sha256').update(value).digest('hex');
const traceIdPattern = /^[0-9a-f]{32}$/;

export function collectCandidates(observations) {
  if (!Array.isArray(observations) || observations.length > 500) throw new Error('Invalid observations');
  const groups = new Map();
  for (const observation of observations) {
    if (!observation || !Object.hasOwn(rules, observation.kind) || !traceIdPattern.test(observation.trace_id)
      || observation.reviewed !== true) throw new Error('Invalid reviewed observation');
    const [skill] = rules[observation.kind];
    if (observation.skill_id !== skill) throw new Error('Observation scope mismatch');
    if (!groups.has(observation.kind)) groups.set(observation.kind, new Set());
    groups.get(observation.kind).add(observation.trace_id);
  }
  return [...groups].flatMap(([kind, traceIds]) => {
    if (traceIds.size < 3) return [];
    const [skill, change] = rules[kind];
    const existing = skill !== null;
    const name = skill ?? 'soccer-evidence-review';
    const baseline = existing && bundledSkills.includes(name) ? readBundledSkill(name) : null;
    const baseHash = baseline ? hash(baseline) : null;
    const sources = [...traceIds].sort();
    const candidateId = hash(JSON.stringify({ kind, sources, baseHash }));
    const markdown = existing ? `${baseline.trimEnd()}\n\n${change}\n`
      : `---\nname: ${name}\ndescription: サッカー分析の根拠と対象範囲を点検する。\n---\n\n${change}\n`;
    return [{
      schema: 1, candidate_id: candidateId, skill: name, kind, mode: existing ? 'update' : 'new',
      baseline_sha256: baseHash, skill_sha256: hash(markdown), skill_markdown: markdown,
      source_trace_ids: sources, status: 'pending_independent_evaluation'
    }];
  });
}

export function runImproveCommand(args, { env, out, err }) {
  const usage = 'Usage: tactixcore-code improve status | scan --playground PATH [--observations FILE]';
  try {
    const { values, positionals } = parseArgs({
      args, allowPositionals: true, options: { playground: { type: 'string' }, observations: { type: 'string' } }
    });
    const [action] = positionals;
    if (positionals.length !== 1 || !['status', 'scan'].includes(action)) {
      err(usage);
      return 2;
    }
    const root = realpathSync(values.playground ?? env.TACTIXCORE_PLAYGROUND);
    const state = join(root, '.local', 'autonomy');
    if (realpathSync(state) !== state) throw new Error('Unexpected managed state directory');
    const stopped = existsSync(join(state, 'STOP.json'));
    if (action === 'status') {
      out(JSON.stringify({ stopped, runner: 'playground autonomy.py', scheduled_by_this_cli: false }));
      return 0;
    }
    const input = realpathSync(values.observations);
    if (statSync(input).size > 128 * 1024) throw new Error('Observations too large');
    const candidates = collectCandidates(JSON.parse(readFileSync(input, 'utf8')));
    if (candidates.length) {
      const directory = join(state, 'tactixcore-code-candidates');
      try { mkdirSync(directory, { mode: 0o700 }); }
      catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
      if (realpathSync(directory) !== directory) throw new Error('Unexpected proposal directory');
      for (const candidate of candidates) {
        const file = join(directory, candidate.candidate_id + '.json');
        try {
          writeFileSync(file, JSON.stringify(candidate, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        } catch (cause) {
          if (cause.code !== 'EEXIST') throw cause;
        }
      }
    }
    out(JSON.stringify({
      stopped, mode: 'scan_only',
      candidates: candidates.map(({ candidate_id, skill, status }) => ({ candidate_id, skill, status }))
    }));
    return 0;
  } catch {
    err('Improvement scan failed. Check managed state and reviewed observations.');
    return 1;
  }
}

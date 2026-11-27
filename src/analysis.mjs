import { createHash, randomUUID } from 'node:crypto';
import { realpathSync, statSync, readFileSync, mkdirSync, writeFileSync, accessSync, constants, createReadStream, readdirSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { Trace } from './telemetry.mjs';

export const analysisSkills = {
  'soccer-ownteam': ['ownteam_analysis_adk', 'ownteam_analysis_adk.cli'],
  'soccer-opponent': ['opponent_analysis_adk', 'opponent_analysis_adk.cli'],
  'soccer-player': ['focus_player_comment', 'focus_player_comment.cli']
};

function inside(root, candidate, kind) {
  const path = realpathSync(resolve(root, candidate));
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Path outside playground');
  const stat = statSync(path);
  if (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()) throw new Error('Unexpected input type');
  return path;
}

function label(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200
    || value.startsWith('-') || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid label');
  return value;
}

function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) {
    throw new Error('Invalid ID');
  }
  return value;
}

function loadJson(path, max = 4 * 1024 * 1024) {
  if (statSync(path).size > max) throw new Error('Input JSON is too large');
  const bytes = readFileSync(path);
  return { data: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex') };
}

function playerClips(data, root, scope) {
  const comments = inside(root, data.comments, 'file');
  const source = loadJson(comments).data;
  if (source.team_id !== scope.team || source.game_id !== scope.game
    || source.video_id !== id(data.video_id) || data.player_id !== id(scope.player)) {
    throw new Error('Player input scope mismatch');
  }
  const selected = data.confirmed_annotation_ids;
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 12
    || selected.length !== new Set(selected.map(id)).size) throw new Error('Invalid reviewed annotation list');
  const human = source.annotations.filter(row => row.author_role === 'coach' && !row.source
    && typeof row.comment === 'string' && row.comment.trim()).sort((a, b) => Number(a.time ?? 0) - Number(b.time ?? 0));
  return {
    comments,
    indices: selected.map(annotationId => {
      const matches = human.map((row, index) => String(row.id) === annotationId ? index : -1).filter(index => index >= 0);
      if (matches.length !== 1 || !Number.isFinite(Number(human[matches[0]].time))) {
        throw new Error('Reviewed annotation has no unique timestamped source');
      }
      return matches[0] + 1;
    })
  };
}

export function planAnalysis(skill, options) {
  if (!Object.hasOwn(analysisSkills, skill)) throw new Error('Unknown analysis skill');
  const [dir, module] = analysisSkills[skill];
  const root = realpathSync(options.playground);
  const team = id(options.team);
  const game = id(options.game);
  const { data, sha256 } = loadJson(inside(root, options.input, 'file'));
  if (data.schema !== 1 || data.team_id !== team || data.game_id !== game || data.skill !== skill) {
    throw new Error('Manifest scope mismatch');
  }
  const engine = inside(root, join('dataset_collector', dir), 'dir');
  const moduleFile = inside(root, join(engine, 'src', dir, 'cli.py'), 'file');
  const python = ['.venv/bin/python', '../.venv/bin/python'].map(path => resolve(engine, path))
    .find(path => {
      try { accessSync(path, constants.X_OK); return true; } catch { return false; }
    });
  if (!python) throw new Error('Playground Python environment unavailable');
  const runId = randomUUID();
  const family = skill === 'soccer-ownteam' ? 'ownanalysis'
    : skill === 'soccer-opponent' ? 'enemyanalysis' : 'playeranalysis';
  const base = inside(root, join('temp', family), 'dir');
  const output = ':native-output:';
  const args = ['-m', module];
  let artifact;
  let evidence;
  if (skill === 'soccer-ownteam') {
    const version = 'v001';
    args.push('--team-id', team, '--team-name', label(data.team_name), '--match-id', game,
      '--items', inside(root, data.items, 'dir'), '--videos', inside(root, data.videos, 'file'),
      '--detections', inside(root, data.detections, 'file'), '--keypoints', inside(root, data.keypoints, 'file'),
      '--output-root', output, '--keep-versions', '0', '--version', version);
    artifact = join(output, `${game}_${version}`, 'report.html');
    evidence = join(output, `${game}_${version}`, 'evidence.json');
  } else if (skill === 'soccer-opponent') {
    if (id(options.opponent) !== data.opponent_id
      || !['4-2-3-1', '4-4-2'].includes(data.formation)
      || !/^\d{4}-\d{2}-\d{2}$/.test(data.as_of)
      || !['opponent', 'other'].includes(data.video_annotated_team)) throw new Error('Invalid opponent scope');
    if (!Array.isArray(data.video_files) || data.video_files.length < 1 || data.video_files.length > 2) {
      throw new Error('Provide one or two scoped match videos');
    }
    args.push('run', '--own-team', label(data.team_name), '--opponent', label(data.opponent),
      '--competition', label(data.competition), '--as-of', data.as_of, '--game-id', game,
      '--video-items', inside(root, data.items, 'dir'), '--own-formation', data.formation,
      '--video-match-opponent', label(data.video_match_opponent),
      '--video-annotated-team', data.video_annotated_team,
      '--video-coverage-note', label(data.video_coverage_note),
      ...data.video_files.flatMap(path => ['--video-file', inside(root, path, 'file')]),
      '--output', output, '--keep-versions', '0');
    if (data.source_registry) args.push('--source-registry', inside(root, data.source_registry, 'file'));
    artifact = join(output, 'report.html');
    evidence = join(output, 'analysis.json');
  } else {
    const { comments, indices } = playerClips(data, root, { team, game, player: options.player });
    args.push('run', '--video', inside(root, data.video, 'file'), '--comments', comments,
      '--tracks-dir', inside(root, data.tracks_dir, 'dir'), '--output', output,
      '--no-baseline', ...indices.flatMap(index => ['--clip', String(index)]));
    artifact = join(output, 'index.html');
    evidence = join(output, 'manifest.json');
  }
  return {
    skill, team, game, runId, root, engine, python, args, base, artifact, evidence,
    reportParent: join(base, team, 'tactixcore-code', 'reports'),
    manifestSha256: sha256, engineEntrypointSha256: createHash('sha256').update(readFileSync(moduleFile)).digest('hex')
  };
}

function startEngine(plan, env, traceparent, signal) {
  const allowed = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'CLOUDSDK_CONFIG', 'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'YOUTUBE_API_KEY'];
  const engineEnv = Object.fromEntries(allowed.filter(name => env[name]).map(name => [name, env[name]]));
  const pythonpath = [join(plan.engine, 'src'), plan.engine, join(plan.root, 'dataset_collector', 'common', 'src')].join(':');
  return new Promise((done, fail) => {
    const child = spawn(plan.python, plan.args, {
      cwd: plan.root, stdio: 'ignore', signal, env: {
        ...engineEnv, PYTHONPATH: pythonpath, TRACEPARENT: traceparent, PYTHONDONTWRITEBYTECODE: '1'
      }
    });
    child.once('error', fail);
    child.once('close', code => done(code));
  });
}

function allocateGeneration(plan) {
  for (const directory of [join(plan.base, plan.team), join(plan.base, plan.team, 'tactixcore-code'), plan.reportParent]) {
    try { mkdirSync(directory, { mode: 0o700 }); }
    catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
    if (inside(plan.base, directory, 'dir') !== directory) throw new Error('Unsafe output directory');
  }
  let last = 0;
  const prefix = plan.game + '_v';
  for (const name of readdirSync(plan.reportParent)) {
    if (!name.startsWith(prefix)) continue;
    const version = name.slice(prefix.length);
    if (/^\d{3,8}(?:\.zip)?$/.test(version)) last = Math.max(last, Number(version.replace(/\.zip$/, '')));
  }
  for (let version = last + 1; version < last + 100; version++) {
    const path = join(plan.reportParent, prefix + String(version).padStart(3, '0'));
    try {
      mkdirSync(path, { mode: 0o700 });
      return path;
    } catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
  }
  throw new Error('Unable to reserve output generation');
}

export async function executeAnalysis(plan, {
  env, endpoint, out, err, start = startEngine, signal, trace = new Trace(endpoint), parent
}) {
  const root = parent ?? trace.start('tactixcore.analysis', { fields: { 'tactixcore.skill.id': plan.skill } });
  const tool = trace.start(`execute_tool ${plan.skill}`, { parent: root, fields: {
    'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': plan.skill
  } });
  let error;
  try {
    const output = allocateGeneration(plan);
    const native = join(output, 'engine');
    const outputIndex = plan.args.findIndex(arg => arg === '--output-root' || arg === '--output') + 1;
    const args = [...plan.args];
    args[outputIndex] = native;
    plan = { ...plan, output, args,
      artifact: join(native, relative(':native-output:', plan.artifact)),
      evidence: join(native, relative(':native-output:', plan.evidence))
    };
    const code = await start(plan, env, tool.traceparent, signal);
    if (code !== 0) throw new Error('Engine process failed');
    // Some opponent profiles publish the native enemy-report.html name.
    let report = plan.artifact;
    if (plan.skill === 'soccer-opponent') {
      const evaluation = loadJson(inside(native, 'evaluation.json', 'file')).data;
      if (evaluation.status !== 'accepted') throw new Error('Opponent quality gate did not accept the result');
      try { inside(native, report, 'file'); } catch { report = join(native, 'enemy-report.html'); }
    }
    const evidencePath = inside(plan.output, plan.evidence, 'file');
    const evidenceHash = createHash('sha256');
    for await (const chunk of createReadStream(evidencePath)) evidenceHash.update(chunk);
    const result = {
      schema: 1, status: 'completed', skill_id: plan.skill, skill_version: '1',
      team_id: plan.team, game_ids: [plan.game], run_id: plan.runId, trace_id: trace.traceId,
      manifest_sha256: plan.manifestSha256, engine_entrypoint_sha256: plan.engineEntrypointSha256,
      report: relative(plan.output, inside(plan.output, report, 'file')),
      evidence: relative(plan.output, evidencePath), evidence_sha256: evidenceHash.digest('hex'),
      unverified: plan.skill === 'soccer-player' ? ['Engine-selected track identity needs coach verification'] : []
    };
    writeFileSync(join(plan.output, 'tactixcore-run.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    writeFileSync(join(plan.output, 'manifest.json'), JSON.stringify({
      schema: 'tactixcore-code-report/v1', status: 'complete', team_id: plan.team, match_id: plan.game,
      outputs: [result.report, result.evidence, 'tactixcore-run.json']
    }) + '\n', { mode: 0o600, flag: 'wx' });
    out(JSON.stringify({ ...result, directory: plan.output }));
    return 0;
  } catch {
    error = 'analysis_failed';
    err(`Analysis failed or did not produce a verified report. Run ID: ${plan.runId}`);
    return 1;
  } finally {
    tool.end({}, error);
    if (!parent) {
      root.end({}, error);
      if (!await trace.flush()) err('OTLP trace export failed.');
    }
  }
}

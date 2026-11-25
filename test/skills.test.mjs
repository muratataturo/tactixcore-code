import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { executeAnalysis, planAnalysis } from '../src/analysis.mjs';
import { fetchPublic, isPublicAddress, searchPublic } from '../src/web.mjs';
import { runPi } from '../src/pi.mjs';

function playground(t, skill, engine, family) {
  const dir = mkdtempSync(join(tmpdir(), 'playground-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  function file(path, value = '', mode) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value), { mode });
    return full;
  }
  file(`dataset_collector/${engine}/src/${engine}/cli.py`, '# stub');
  file(`dataset_collector/${engine}/.venv/bin/python`, '# stub', 0o700);
  mkdirSync(join(dir, 'temp', family), { recursive: true });
  mkdirSync(join(dir, 'items'));
  mkdirSync(join(dir, 'tracks'));
  return { dir, file, scope: { schema: 1, team_id: 'test-team', game_id: 'test-game', skill } };
}

test('own-team fixture preserves the report and evidence from the scoped adapter', async t => {
  const skill = 'soccer-ownteam';
  const { dir, file, scope } = playground(t, skill, 'ownteam_analysis_adk', 'ownanalysis');
  for (const path of ['videos.json', 'detections.json', 'keypoints.json']) file(path, {});
  file('input.json', {
    ...scope, team_name: 'Test', items: 'items', videos: 'videos.json',
    detections: 'detections.json', keypoints: 'keypoints.json'
  });
  const options = { playground: dir, team: scope.team_id, game: scope.game_id, input: 'input.json' };
  assert.throws(() => planAnalysis(skill, { ...options, team: 'other' }));
  symlinkSync('/does-not-exist', join(dir, 'wrong.json'));
  assert.throws(() => planAnalysis(skill, { ...options, input: 'wrong.json' }));
  const plan = planAnalysis(skill, options);
  assert.equal(plan.args.includes('--output-root'), true);
  const output = [];
  const status = await executeAnalysis(plan, {
    env: {}, out: text => output.push(JSON.parse(text)), err: assert.fail,
    start: async (planned, _env, traceparent) => {
      assert.match(traceparent, /^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
      mkdirSync(dirname(planned.artifact), { recursive: true });
      writeFileSync(planned.artifact, '<html>Fixture</html>');
      writeFileSync(planned.evidence, '{}');
      return 0;
    }
  });
  assert.equal(status, 0);
  assert.equal(output[0].evidence, 'engine/test-game_v001/evidence.json');
  assert.match(output[0].evidence_sha256, /^[a-f0-9]{64}$/);
});

test('Pi runs one pre-bound analysis and keeps its report out of the model transcript', async t => {
  const skill = 'soccer-ownteam';
  const { dir, file, scope } = playground(t, skill, 'ownteam_analysis_adk', 'ownanalysis');
  for (const path of ['videos.json', 'detections.json', 'keypoints.json']) file(path, {});
  file('input.json', {
    ...scope, team_name: 'Private team fixture', items: 'items', videos: 'videos.json',
    detections: 'detections.json', keypoints: 'keypoints.json'
  });
  const analysis = planAnalysis(skill, { playground: dir, team: scope.team_id, game: scope.game_id, input: 'input.json' });
  const outputs = [];
  const errors = [];
  let calls = 0;
  let engineRuns = 0;
  let spans;
  const status = await runPi({
    skill, analysis, env: {}, key: 'unused-fixture-key', prompt: 'Run the selected analysis',
    out: value => outputs.push(value), err: value => errors.push(value),
    endpoint: 'http://127.0.0.1:4318/v1/traces',
    fetchTrace: async (url, init) => {
      spans = JSON.parse(init.body).resourceSpans[0].scopeSpans[0].spans;
      return Response.json({});
    },
    analysisStart: async planned => {
      engineRuns++;
      mkdirSync(dirname(planned.artifact), { recursive: true });
      writeFileSync(planned.artifact, 'Private report fixture');
      writeFileSync(planned.evidence, '{}');
      return 0;
    },
    fetchModel: async (url, init) => {
      calls++;
      assert.doesNotMatch(init.body, /Private team fixture|Private report fixture|tactixcore-run.json/);
      const body = JSON.parse(init.body);
      assert.equal(body.tool_choice, calls === 1 ? 'required' : 'none');
      const toolName = 'run_scoped_soccer_analysis';
      const finish = calls === 1 ? 'tool_calls' : 'stop';
      const delta = calls === 1 ? {
        role: 'assistant',
        tool_calls: [{ index: 0, id: 'call_fixture', type: 'function',
          function: { name: toolName, arguments: '{}' } }]
      } : { role: 'assistant', content: 'Local analysis completed.' };
      const base = { id: 'gen-fixture-' + calls, created: 1, object: 'chat.completion.chunk', model: 'openai/gpt-5-nano' };
      const chunks = [
        { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] }
      ];
      return new Response(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
  });
  assert.equal(status, 0, errors.join('\n'));
  assert.equal(calls, 2);
  assert.equal(engineRuns, 1);
  assert.equal(outputs.length, 2);
  assert.equal(JSON.parse(outputs[0]).skill_id, skill);
  const agent = spans.find(span => span.name.startsWith('invoke_agent'));
  assert.equal(spans.length, 4);
  assert.ok(spans.filter(span => span !== agent).every(span => span.parentSpanId === agent.spanId));
});

test('player adapter requires a confirmed player and maps human annotation IDs deterministically', t => {
  const skill = 'soccer-player';
  const { dir, file, scope } = playground(t, skill, 'focus_player_comment', 'playeranalysis');
  file('video-test.mp4');
  file('comments.json', {
    team_id: scope.team_id, game_id: scope.game_id, video_id: 'video-test',
    annotations: [
      { id: 'generated', author_role: 'coach', source: 'scene_analysis', time: 1, comment: 'AI' },
      { id: 'human-2', author_role: 'coach', time: 30, comment: 'Second' },
      { id: 'human-1', author_role: 'coach', time: 20, comment: 'First' }
    ]
  });
  file('input.json', {
    ...scope, player_id: 'confirmed-player', video_id: 'video-test', confirmed_annotation_ids: ['human-2'],
    comments: 'comments.json', video: 'video-test.mp4', tracks_dir: 'tracks'
  });
  const options = { playground: dir, team: scope.team_id, game: scope.game_id, input: 'input.json' };
  assert.throws(() => planAnalysis(skill, { ...options, player: 'someone-else' }));
  const plan = planAnalysis(skill, { ...options, player: 'confirmed-player' });
  assert.deepEqual(plan.args.slice(-2), ['--clip', '2']);
});

test('opponent fixture rejects a different team and an unaccepted engine result', async t => {
  const skill = 'soccer-opponent';
  const { dir, file, scope } = playground(t, skill, 'opponent_analysis_adk', 'enemyanalysis');
  file('video.mp4');
  file('input.json', {
    ...scope, team_name: 'Test', opponent_id: 'their-team', opponent: 'Opponent',
    competition: 'Test cup', as_of: '2026-11-25', formation: '4-2-3-1',
    items: 'items', video_files: ['video.mp4'], video_match_opponent: 'Previous opponent',
    video_annotated_team: 'opponent', video_coverage_note: 'First half'
  });
  const options = { playground: dir, team: scope.team_id, game: scope.game_id, input: 'input.json' };
  assert.throws(() => planAnalysis(skill, { ...options, opponent: 'other-team' }));
  const plan = planAnalysis(skill, { ...options, opponent: 'their-team' });
  assert.equal(plan.args.includes('--video-match-opponent'), true);
  const errors = [];
  assert.equal(await executeAnalysis(plan, {
    env: {}, out: assert.fail, err: text => errors.push(text),
    start: async planned => {
      const native = dirname(planned.artifact);
      mkdirSync(native);
      writeFileSync(join(native, 'evaluation.json'), '{"status":"rejected"}');
      return 0;
    }
  }), 1);
  assert.match(errors[0], /Analysis failed/);
});

test('web search normalizes only public citation candidates', async () => {
  const key = 'fixture';
  const result = await searchPublic('official league', key, { requestModel: async (_url, init) => {
    assert.equal(init.redirect, 'error');
    assert.equal(JSON.parse(init.body).messages.length, 1);
    return Response.json({ choices: [{ message: {
      content: 'untrusted answer',
      annotations: [
        { type: 'url_citation', url_citation: { url: 'https://www.example.com/match#anchor', title: 'Fixture' } },
        { type: 'url_citation', url_citation: { url: 'https://127.0.0.1/test' } }
      ]
    } }] });
  }});
  assert.deepEqual(result.results, [{
    url: 'https://www.example.com/match', title: 'Fixture', status: 'unverified_search_result'
  }]);
});

test('web fetch rejects protected addresses including mixed public and private DNS', async () => {
  for (const ip of ['127.0.0.1', '169.254.169.254', '::ffff:127.0.0.1', 'fe80::1', '100.64.0.1']) {
    assert.equal(isPublicAddress(ip), false);
  }
  await assert.rejects(fetchPublic('https://example.com', async () => [
    { address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }
  ]), /forbidden address/);
  await assert.rejects(fetchPublic('https://user:password@example.com'), /public HTTPS/);
});

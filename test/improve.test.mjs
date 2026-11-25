import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectCandidates, runImproveCommand } from '../src/improve.mjs';

function observations(kind, skill_id) {
  return ['a', 'b', 'c'].map(letter => ({
    kind, skill_id, trace_id: letter.repeat(32), reviewed: true, note: 'Raw review text'
  }));
}

test('candidate generation deduplicates evidence and stages only declared skill content', () => {
  const reviewed = observations('missing_evidence', 'soccer-ownteam');
  assert.deepEqual(collectCandidates([reviewed[0], reviewed[0], reviewed[1]]), []);
  const [candidate] = collectCandidates(reviewed);
  assert.equal(candidate.mode, 'update');
  assert.equal(candidate.status, 'pending_independent_evaluation');
  assert.equal(candidate.candidate_id, collectCandidates([...reviewed].reverse())[0].candidate_id);
  assert.doesNotMatch(JSON.stringify(candidate), /Raw review text/);
  const [newSkill] = collectCandidates(observations('unsupported_evidence_review', null));
  assert.equal(newSkill.mode, 'new');
  assert.equal(newSkill.skill, 'soccer-evidence-review');
  assert.equal(newSkill.baseline_sha256, null);
});

test('candidate scan preserves the managed STOP latch and does not change active skills', t => {
  const dir = mkdtempSync(join(tmpdir(), 'improvement-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, '.local', 'autonomy');
  mkdirSync(state, { recursive: true });
  const stop = join(state, 'STOP.json');
  writeFileSync(stop, '{}');
  const file = join(dir, 'observations.json');
  writeFileSync(file, JSON.stringify(observations('unsupported_evidence_review', null)));
  const output = [];
  const options = { env: {}, out: value => output.push(JSON.parse(value)), err: assert.fail };
  assert.equal(runImproveCommand(['scan', '--playground', dir, '--observations', file], options), 0);
  assert.equal(output[0].stopped, true);
  assert.equal(output[0].mode, 'scan_only');
  assert.deepEqual(readdirSync(state).sort(), ['STOP.json', 'tactixcore-code-candidates']);
  assert.equal(readFileSync(stop, 'utf8'), '{}');
});

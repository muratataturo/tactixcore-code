import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createParallelResearchTool } from '../src/parallel-research.mjs';

test('parallel research starts independent workers concurrently and preserves result order', async () => {
  const release = [];
  const tasks = [{ title: 'Inputs', task: 'Inspect adapter inputs' }, { title: 'Outputs', task: 'Inspect report outputs' }];
  let reports;
  const research = createParallelResearchTool({
    reserve: () => 'fixture',
    runWorker: ({ title }, scope, signal) => new Promise((resolve, reject) => {
      assert.equal(scope, 'fixture');
      assert.equal(signal.aborted, false);
      release.push(title === 'Inputs' ? () => resolve({ status: 'completed', findings: 'one' })
        : () => reject(new Error('private error')));
    }),
    onFinished: (_scope, value) => { reports = value; }
  });
  const completed = research.tool.execute('fixture', { tasks });
  assert.equal(research.active(), 2);
  release[1]();
  release[0]();
  const result = await completed;
  assert.equal(research.active(), 0);
  assert.deepEqual(reports.map(item => item.title), ['Inputs', 'Outputs']);
  assert.deepEqual(reports.map(item => item.status), ['completed', 'failed']);
  assert.doesNotMatch(JSON.stringify(result), /private error/);
  await assert.rejects(research.tool.execute('duplicate', { tasks: [tasks[0], tasks[0]] }), /distinct/);
});

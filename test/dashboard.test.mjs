import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderDashboardHeader, renderDashboardFooter, usageDetails } from '../src/dashboard.mjs';
import { createUsageLedger, formatCount, formatUsd } from '../src/usage.mjs';

const theme = { fg: (_color, value) => value, bold: value => value };

test('usage ledger sums provider figures and marks unreported values', () => {
  const ledger = createUsageLedger();
  let updates = 0;
  const remove = ledger.subscribe(() => updates++);
  ledger.record({ usage: {
    prompt_tokens: 1_200, completion_tokens: 30, cost: 0.00001987,
    prompt_tokens_details: { cached_tokens: 100 },
    completion_tokens_details: { reasoning_tokens: 5 }
  }, model: 'openai/gpt-5-mini' });
  remove();
  ledger.record({ usage: { prompt_tokens: 300, completion_tokens: 3, cost: 0 } });
  ledger.record({});
  const totals = ledger.snapshot();
  assert.equal(updates, 1);
  assert.equal(totals.requests, 3);
  assert.equal(totals.input, 1_500);
  assert.equal(totals.output, 33);
  assert.equal(totals.usd, 0.00001987);
  assert.equal(totals.model, 'openai/gpt-5-mini');
  assert.equal(formatCount(totals.input, totals.inputMissing, totals.requests), '1,500+');
  assert.equal(formatUsd(totals.usd, totals.costMissing, totals.requests), '$0.00001987+');
  assert.equal(formatUsd(0, 1, 1), '—');
  assert.equal(formatUsd(0, 0, 1), '$0.00');
  assert.equal(formatUsd(0.000000001, 0, 1), '<$0.00000001');
  assert.match(usageDetails(totals, 'openrouter/auto').join('\n'), /100\+ included in input/);
});

test('pixel header and usage stay within normal and narrow terminal widths', () => {
  const state = createUsageLedger().snapshot();
  for (const width of [24, 40, 66, 80, 120]) {
    const header = renderDashboardHeader(width, 35, theme);
    assert.ok(header.some(line => line.includes('TactixCore Code')));
    assert.ok(header.every(line => visibleWidth(line) <= width));
    if (width >= 40) assert.ok(header.some(line => line.includes('▀')));
    const footer = renderDashboardFooter(width, theme, {
      state, model: 'openrouter/auto', workspace: 'tactixcore-code', branch: 'feature/dashboard',
      context: { percent: 32.2 }
    });
    assert.ok(footer.every(line => visibleWidth(line) <= width));
    assert.match(footer.join('\n'), /Tokens 0 in \/ 0 out/);
    assert.match(footer.join('\n'), /Session \$0\.00/);
  }
  assert.ok(renderDashboardHeader(80, 19, theme).every(line => !line.includes('▀')));
});

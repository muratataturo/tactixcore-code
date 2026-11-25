import { basename } from 'node:path';
import { matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { pomeranianLogo } from './pomeranian-logo.mjs';
import { formatCount, formatUsd } from './usage.mjs';

const art = pomeranianLogo();
const dot = '  ·  ';
const text = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, '');

function fit(lines, width) {
  return lines.map(line => truncateToWidth(line, width));
}

function rows(items, width) {
  const lines = [];
  let line = '';
  for (const item of items) {
    if (!item) continue;
    const next = line ? line + dot + item : item;
    if (line && visibleWidth(next) > width) {
      lines.push(line);
      line = item;
    } else line = next;
  }
  if (line) lines.push(line);
  return fit(lines, width);
}

export function renderDashboardHeader(width, height, theme) {
  const title = theme.fg('accent', theme.bold('TactixCore Code'));
  const context = theme.fg('muted', 'Pi  /  OpenRouter');
  const shortcuts = theme.fg('dim', '/usage   /skill:   Ctrl+D');
  if (width < 40 || height < 22) return fit([title, shortcuts], width);
  if (width < 70) return [...art, ...fit([title + '  ' + context, shortcuts], width), ''];
  const labels = new Map([[2, title], [3, context], [6, shortcuts]]);
  return [...art.map((line, index) => truncateToWidth(line + '    ' + (labels.get(index) ?? ''), width)), ''];
}

function counts(state) {
  return {
    input: formatCount(state.input, state.inputMissing, state.requests),
    output: formatCount(state.output, state.outputMissing, state.requests),
    spend: formatUsd(state.usd, state.costMissing, state.requests)
  };
}

export function renderDashboardFooter(width, theme, { state, model, workspace, branch, context, statuses = [] }) {
  const { input, output, spend } = counts(state);
  const partial = state.costMissing || state.inputMissing || state.outputMissing;
  const usage = rows([
    theme.fg('muted', 'Tokens ') + theme.fg('text', input + ' in / ' + output + ' out'),
    theme.fg('muted', 'Session ') + theme.fg(partial ? 'warning' : 'accent', spend),
    Number.isFinite(context?.percent) ? theme.fg('muted', 'Context ' + Math.round(context.percent) + '%') : ''
  ], width);
  const location = text(workspace) + (branch ? ' (' + text(branch) + ')' : '');
  const selected = text(model);
  const actual = text(state.model);
  return [
    ...usage,
    ...rows([theme.fg('dim', location), theme.fg('muted', actual ? `${actual} · via OpenRouter` : selected)], width),
    ...rows(statuses, width)
  ];
}

export function usageDetails(state, configuredModel) {
  const { input, output, spend } = counts(state);
  const rows = [
    'Requests    ' + formatCount(state.requests),
    'Input       ' + input + ' tokens',
    'Output      ' + output + ' tokens',
    'Total USD   ' + spend,
    'Model       ' + text(state.model ?? configuredModel)
  ];
  if (state.cachedReported) rows.push('Cache read  ' + formatCount(state.cached, state.requests - state.cachedReported, state.requests) + ' included in input');
  if (state.reasoningReported) rows.push('Reasoning   ' + formatCount(state.reasoning, state.requests - state.reasoningReported, state.requests) + ' included in output');
  if (state.costMissing || state.inputMissing || state.outputMissing) {
    rows.push('', '+ partial   — unavailable');
  }
  return rows;
}

export function dashboardExtension(ledger) {
  return pi => {
    pi.on('session_start', (_event, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.setHeader((tui, theme) => ({
        render: width => renderDashboardHeader(width, tui.terminal.rows, theme),
        invalidate() {}
      }));
      ctx.ui.setFooter((tui, theme, data) => {
        const removeUsage = ledger.subscribe(() => tui.requestRender());
        const removeBranch = data.onBranchChange(() => tui.requestRender());
        return {
          render: width => renderDashboardFooter(width, theme, {
            state: ledger.snapshot(), model: ctx.model?.id, workspace: basename(ctx.cwd),
            branch: data.getGitBranch(), context: ctx.getContextUsage(),
            statuses: [...data.getExtensionStatuses().values()]
          }),
          invalidate() {},
          dispose() { removeBranch(); removeUsage(); }
        };
      });
    });
    pi.registerCommand('usage', {
      description: 'Show OpenRouter token and cost details for this session',
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) return;
        await ctx.ui.custom((_tui, theme, _keys, done) => ({
          render: width => fit([
            theme.fg('accent', theme.bold('OpenRouter usage')), '',
            ...usageDetails(ledger.snapshot(), ctx.model?.id),
            '', theme.fg('dim', 'Esc or Enter to close')
          ], width),
          invalidate() {},
          handleInput(data) {
            if (matchesKey(data, 'escape') || matchesKey(data, 'enter')) done(undefined);
          }
        }));
      }
    });
  };
}

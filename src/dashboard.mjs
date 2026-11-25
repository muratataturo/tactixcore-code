import { basename } from 'node:path';
import { getCapabilities, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { createMascotImage, renderMascotThumbnail } from './pomeranian-logo.mjs';
import { formatCount, formatUsd } from './usage.mjs';
import { mascotMotion } from './mascot-motion.mjs';

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

export function renderDashboardHeader(width, height, theme, image) {
  const title = theme.fg('accent', theme.bold('TactixCore Code'));
  const context = theme.fg('muted', 'Pi  /  OpenRouter');
  const shortcuts = theme.fg('dim', '/usage   /skill:   Ctrl+D');
  if (width < 40 || height < 22) return fit([title, shortcuts], width);
  if (image) return [...fit([title + '  ' + context, shortcuts], width), ...image.render(width), ''];
  const art = renderMascotThumbnail(height < 28 ? 24 : Math.min(30, width));
  if (width < 76) return [...art, ...fit([title + '  ' + context, shortcuts], width), ''];
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

export function dashboardExtension(ledger, activeWorkers = () => 0) {
  return pi => {
    const motion = mascotMotion();
    const tools = new Set();
    let running = false;
    let failed = false;
    const reduced = process.env.TACTIXCORE_REDUCED_MOTION === '1';
    pi.on('agent_start', () => {
      running = true;
      failed = false;
      tools.clear();
      motion.change('thinking');
    });
    pi.on('message_update', event => {
      if (running && !tools.size && event.assistantMessageEvent.type === 'text_delta') motion.change('answering');
    });
    pi.on('tool_execution_start', event => {
      tools.add(event.toolCallId);
      motion.change('working');
    });
    pi.on('tool_execution_end', event => {
      tools.delete(event.toolCallId);
      if (!tools.size) motion.change(running ? 'thinking' : 'done');
    });
    pi.on('message_end', event => {
      if (event.message.role === 'assistant') failed = ['error', 'length', 'aborted'].includes(event.message.stopReason);
    });
    pi.on('session_before_compact', () => motion.change('compacting'));
    pi.on('session_compact', () => motion.change(running ? 'thinking' : 'done'));
    pi.on('session_compact_failed', () => motion.change(running ? 'thinking' : 'paused'));
    pi.on('agent_settled', event => {
      running = false;
      tools.clear();
      motion.change(event.aborted || failed ? 'paused' : 'done');
    });
    pi.on('session_start', (_event, ctx) => {
      if (!ctx.hasUI) return;
      ctx.ui.setHeader((tui, theme) => {
        let compact;
        let full;
        return {
          render(width) {
            const height = tui.terminal.rows;
            let image;
            if (width >= 40 && height >= 22 && getCapabilities().images) {
              image = height < 28
                ? (compact ??= createMascotImage(theme, 8))
                : (full ??= createMascotImage(theme, 12));
            }
            return renderDashboardHeader(width, height, theme, image);
          },
          invalidate() { compact?.invalidate(); full?.invalidate(); }
        };
      });
      ctx.ui.setWidget('tactixcore-mascot', (tui, theme) => {
        let timer;
        const redraw = () => {
          tui.requestRender();
          if (motion.pose().visible && !timer) {
            timer = setInterval(() => {
              tui.requestRender();
              if (!motion.pose().visible) {
                clearInterval(timer);
                timer = undefined;
              }
            }, 430).unref();
          }
        };
        const removeMotion = motion.subscribe(redraw);
        return {
          render(width) {
            const pose = motion.pose(activeWorkers(), reduced);
            if (!pose.visible) return [];
            const label = theme.fg('accent', pose.label);
            if (width < 38 || tui.terminal.rows < 24) return [truncateToWidth(label, width)];
            const sprite = renderMascotThumbnail(tui.terminal.rows >= 32 ? 16 : 10, undefined, pose.frame);
            const center = Math.floor(sprite.length / 2);
            return sprite.map((line, row) => truncateToWidth(line + (row === center ? '   ' + label : ''), width));
          },
          invalidate() {},
          dispose() { removeMotion(); clearInterval(timer); }
        };
      });
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

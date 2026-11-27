import { basename } from 'node:path';
import { deleteKittyImage, getCapabilities, matchesKey, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { createMascotImage, mascotFrames, renderMascotThumbnail } from './pomeranian-logo.mjs';
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

export function renderDashboardHeader(width, theme) {
  const title = theme.fg('accent', theme.bold('🐾 TactixCore Code'));
  const context = theme.fg('muted', 'Pi  /  OpenRouter');
  const shortcuts = theme.fg('dim', '/mascot   /usage   /skill:   Ctrl+D');
  return [...rows([title, context], width), ...fit([shortcuts], width)];
}

export function mascotPreview(tui, theme) {
  let image;
  let current;
  const dispose = () => {
    const id = image?.getImageId();
    if (id !== undefined) tui.terminal.write(deleteKittyImage(id));
    image = undefined;
    current = undefined;
  };
  return {
    render(width, height, frame) {
      const key = `${width}/${height}/${frame}`;
      if (current !== key) {
        dispose();
        current = key;
        if (getCapabilities().images === 'kitty') image = createMascotImage(theme, height, frame);
      }
      return image?.render(width) ?? renderMascotThumbnail(width, undefined, frame, height);
    },
    invalidate() { image?.invalidate(); },
    dispose
  };
}

export function renderWorkingMascot(width, theme, pose) {
  if (!pose.visible) return [];
  const icons = { idle: '🐾', think: '🐶', dribble: '🐾', kick: '⚽', celebrate: '✨', concern: '🐶' };
  return fit([theme.fg('accent', `${icons[pose.frame]} Luke · ${pose.label}`)], width);
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
    const tools = new Map();
    let running = false;
    let failed = false;
    const reduced = process.env.TACTIXCORE_REDUCED_MOTION === '1';
    const updateToolActivity = () => {
      const names = [...tools.values()];
      if (names.includes('web_search')) motion.change('searching');
      else if (names.includes('web_fetch') || names.includes('studio_mcp')) motion.change('fetching');
      else if (names.length) motion.change('working');
      else motion.change(running ? 'thinking' : 'done');
    };
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
      tools.set(event.toolCallId, event.toolName);
      updateToolActivity();
    });
    pi.on('tool_execution_end', event => {
      tools.delete(event.toolCallId);
      updateToolActivity();
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
      ctx.ui.setHeader((_tui, theme) => ({
        render: width => renderDashboardHeader(width, theme),
        invalidate() {}
      }));
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
            return renderWorkingMascot(width, theme, motion.pose(activeWorkers(), reduced));
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
    pi.registerCommand('mascot', {
      description: 'View all six mascot poses at a larger size',
      handler: async (_args, ctx) => {
        if (!ctx.hasUI) return;
        await ctx.ui.custom((tui, theme, _keys, done) => {
          let index = 0;
          const panel = mascotPreview(tui, theme);
          return {
            render(width) {
              const names = ['Idle', 'Thinking', 'Dribbling', 'Kick', 'Celebrating', 'Concerned'];
              const heading = theme.fg('accent', theme.bold(`Luke · ${names[index]} (${index + 1}/6)`));
              return [...fit([heading, '← / → or 1–6    Esc to close'], width),
                ...panel.render(width, Math.max(4, Math.min(26, tui.terminal.rows - 9)), mascotFrames[index])];
            },
            invalidate: panel.invalidate,
            dispose: panel.dispose,
            handleInput(data) {
              if (matchesKey(data, 'escape') || matchesKey(data, 'enter')) return done(undefined);
              if (matchesKey(data, 'left')) index = (index + 5) % 6;
              else if (matchesKey(data, 'right')) index = (index + 1) % 6;
              else if (/^[1-6]$/.test(data)) index = Number(data) - 1;
              else return;
              tui.requestRender();
            }
          };
        });
      }
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

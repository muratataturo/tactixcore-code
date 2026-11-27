const integer = new Intl.NumberFormat('en-US');
const fractional = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 8 });

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function createUsageLedger() {
  const totals = {
    requests: 0, input: 0, output: 0, cached: 0, reasoning: 0, usd: 0,
    inputMissing: 0, outputMissing: 0, costMissing: 0, cachedReported: 0, reasoningReported: 0,
    model: undefined
  };
  const listeners = new Set();
  return {
    record({ usage, model }) {
      totals.requests++;
      for (const [name, value] of [['input', usage?.prompt_tokens], ['output', usage?.completion_tokens]]) {
        const amount = count(value);
        if (amount === undefined) totals[name + 'Missing']++;
        else totals[name] += amount;
      }
      for (const [name, value] of [['cached', usage?.prompt_tokens_details?.cached_tokens],
        ['reasoning', usage?.completion_tokens_details?.reasoning_tokens]]) {
        const amount = count(value);
        if (amount !== undefined) {
          totals[name] += amount;
          totals[name + 'Reported']++;
        }
      }
      if (Number.isFinite(usage?.cost) && usage.cost >= 0) totals.usd += usage.cost;
      else totals.costMissing++;
      if (model) totals.model = model;
      for (const notify of listeners) notify();
    },
    snapshot: () => ({ ...totals }),
    subscribe(notify) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    }
  };
}

export function formatCount(value, missing = 0, requests = 0) {
  return missing > 0 && missing === requests ? '—' : integer.format(value) + (missing ? '+' : '');
}

export function formatUsd(value, missing, requests) {
  if (missing > 0 && missing === requests) return '—';
  const amount = value > 0 && value < 0.00000001 ? '<$0.00000001' : '$' + fractional.format(value);
  return amount + (missing ? '+' : '');
}

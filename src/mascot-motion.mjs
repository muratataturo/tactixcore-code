const poses = {
  idle: ['idle'],
  thinking: ['think', 'think', 'idle'],
  answering: ['dribble', 'dribble', 'kick', 'dribble'],
  working: ['dribble', 'kick', 'dribble'],
  compacting: ['think', 'idle', 'think'],
  done: ['kick', 'celebrate', 'celebrate', 'idle'],
  paused: ['concern', 'concern', 'idle']
};
const labels = {
  idle: 'Ready', thinking: 'Thinking', answering: 'Writing response', working: 'Running tools',
  compacting: 'Compacting context', done: 'Completed', paused: 'Paused'
};

export function mascotPose(state, elapsedMs, workers = 0, reduced = false) {
  const expired = ['done', 'paused'].includes(state) && elapsedMs >= 2_700;
  if (expired) state = 'idle';
  const cycle = poses[state];
  const index = reduced ? (state === 'done' ? 1 : 0) : Math.floor(elapsedMs / 430) % cycle.length;
  return {
    frame: cycle[index],
    label: state === 'working' && workers ? `Subagents running · ${workers}` : labels[state],
    visible: state !== 'idle'
  };
}

export function mascotMotion(now = Date.now) {
  let state = 'idle';
  let start = now();
  const listeners = new Set();
  return {
    change(next) {
      if (state === next) return;
      state = next;
      start = now();
      for (const listener of listeners) listener();
    },
    pose(workers, reduced) { return mascotPose(state, now() - start, workers, reduced); },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

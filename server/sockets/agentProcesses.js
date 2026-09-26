import { getRunningAgents } from '../services/agents.js';

// External CLI processes have no push API. All mounted viewers share one
// non-overlapping host scan; snapshots avoid a second probe per browser.
const subscribers = new Set();
let run = null;

function start() {
  if (run) return;
  const owner = { timer: null, signature: null };
  run = owner;
  const tick = () => getRunningAgents().then(agents => {
    if (run !== owner) return;
    // Unix start time is derived from elapsed seconds and jitters per scan.
    // Keep elapsed runtime in the frame so the page clock remains current.
    const signature = JSON.stringify(agents.map(({ startTime, ...agent }) => agent));
    if (signature === owner.signature) return;
    owner.signature = signature;
    for (const socket of subscribers) socket.emit('agent-processes:changed', { agents });
  }).catch(err => console.error(`❌ Agent process watcher failed: ${err.message}`))
    .finally(() => {
      if (run === owner) owner.timer = setTimeout(tick, 3000);
    });
  void tick();
}

function release(socket) {
  subscribers.delete(socket);
  if (subscribers.size || !run) return;
  clearTimeout(run.timer);
  run = null;
}

export function registerAgentProcessHandlers(socket) {
  socket.on('agent-processes:subscribe', () => {
    subscribers.add(socket);
    start();
  });
  socket.on('agent-processes:unsubscribe', () => release(socket));
  socket.on('disconnect', () => release(socket));
}

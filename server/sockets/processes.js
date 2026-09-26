import { getAllApps } from '../services/apps.js';
import { listProcessesStrict } from '../services/pm2.js';

// PM2's Node singleton targets one daemon; CLI reads also support per-app homes.
// Share one sampling loop across all viewers, and send snapshots rather than
// making every viewer shell out again after an invalidation.
const subscribers = new Set();
let run = null;

async function sample(owner) {
  const apps = await getAllApps({ includeArchived: false });
  const homes = new Map([[null, []]]);
  for (const app of apps) {
    const home = app.pm2Home || null;
    if (!homes.has(home)) homes.set(home, []);
    homes.get(home).push(app.id);
  }
  for (const [home, appIds] of homes) {
    if (run !== owner) return;
    const processes = await listProcessesStrict(home);
    if (run !== owner) return;
    const frame = { appIds, defaultHome: home === null, processes };
    // Uptime increases even on an idle daemon. CPU/memory are telemetry and
    // arrive in the same push without another HTTP read from every viewer.
    const signature = JSON.stringify({ ...frame, processes: processes?.map(({ uptime, ...proc }) => proc) ?? null });
    if (owner.snapshots.get(home) === signature) continue;
    owner.snapshots.set(home, signature);
    for (const socket of subscribers) socket.emit('processes:changed', frame);
  }
  for (const home of owner.snapshots.keys()) {
    if (!homes.has(home)) owner.snapshots.delete(home);
  }
}

function start() {
  if (run) return;
  const owner = { timer: null, snapshots: new Map() };
  run = owner;
  const tick = () => sample(owner)
    .catch(err => console.error(`❌ Process status watcher failed: ${err.message}`))
    .finally(() => {
      if (run === owner) owner.timer = setTimeout(tick, 1500);
    });
  void tick();
}

function release(socket) {
  subscribers.delete(socket);
  if (subscribers.size || !run) return;
  clearTimeout(run.timer);
  run = null;
}

export function registerProcessHandlers(socket) {
  socket.on('processes:subscribe', () => {
    subscribers.add(socket);
    start();
  });
  socket.on('processes:unsubscribe', () => release(socket));
  socket.on('disconnect', () => release(socket));
}

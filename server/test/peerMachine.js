/**
 * One PortOS machine for in-process federation tests, run as a worker thread
 * (see services/mediaPeerDelete.e2e.test.js). Each worker has its own module
 * graph and data root (PORTOS_DATA_ROOT, a disposable temp root), so two
 * workers are two instances with separate identities, registries and stores.
 *
 * Real: the Express app with authGate, `/api/sync` and `/api/peer-media`,
 * a Socket.IO server with the peer-sync room and frame delivery, the peer
 * relay client, the sync orchestrator, and every history/tombstone/delete
 * service. Replaced: the OS trash (files move into `<root>/trash-bin`) and the
 * socket.js wiring, reduced to the two peer-sync forwards it installs.
 *
 * The parent sends `{ id, cmd, args }` and receives `{ id, result }` or
 * `{ id, error: { message, status, code } }`.
 */
import { EventEmitter } from 'node:events';
import { registerHooks } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const TRASH_STAND_IN = new URL('./peerMachineTrash.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url.endsWith('/server/lib/nativeTrash.js') ? { ...resolved, url: TRASH_STAND_IN, shortCircuit: true } : resolved;
  },
});

const [
  { default: express },
  { Server },
  { authGate, socketAuthGate },
  { errorMiddleware },
  { default: dataSyncRoutes },
  { default: peerMediaRoutes },
  { default: videoGenRoutes },
  bus,
  relay,
  orchestrator,
  { deleteMediaAnywhere },
  { loadHistory, mutateVideoHistory },
  { listMediaTombstones },
  { instanceEvents },
  { loadData: readRegistry },
  { PATHS, atomicWrite },
  { peerFetch },
] = await Promise.all([
  import('express'),
  import('socket.io'),
  import('../services/authGate.js'),
  import('../lib/errorHandler.js'),
  import('../routes/dataSync.js'),
  import('../routes/peerMedia.js'),
  import('../routes/videoGen.js'),
  import('../services/peerSyncEventBus.js'),
  import('../services/peerSocketRelay.js'),
  import('../services/syncOrchestrator.js'),
  import('../services/mediaRemoteDelete.js'),
  import('../services/videoGen/history.js'),
  import('../services/mediaTombstones.js'),
  import('../services/instanceEvents.js'),
  import('../services/instanceIdentity.js'),
  import('../lib/fileUtils.js'),
  import('../lib/peerHttpClient.js'),
]);

const requests = [];
const delivered = [];
const deliveries = new EventEmitter();
const app = express();
app.use((req, res, next) => { requests.push(`${req.method} ${req.path}`); next(); });
app.use(express.json());
app.use(authGate);
app.use('/api/sync', dataSyncRoutes);
app.use('/api/peer-media', peerMediaRoutes);
app.use('/api/video-gen', videoGenRoutes);
app.use(errorMiddleware);

const httpServer = createServer(app);
const io = new Server(httpServer);
io.use(socketAuthGate);
io.on('connection', (socket) => bus.registerPeerSyncSubscriber(socket));
// socket.js setupPeerSyncEventForwarding, recording what each frame reached.
bus.peerSyncBus.on('event', (event) => {
  void bus.deliverPeerSyncEvent(io, event).then((sockets) => {
    const entry = { op: event.op, id: event.id, sockets };
    delivered.push(entry);
    deliveries.emit('delivered', entry);
  });
});
bus.peerSyncBus.on('media-history-changed', (payload) => io.except(bus.PEER_SYNC_ROOM).emit('media:history:changed', payload));

const registryFile = () => join(PATHS.data, 'instances.json');
const peerById = async (peerId) => {
  const peer = (await readRegistry()).peers.find((p) => p.id === peerId);
  if (!peer) throw new Error(`no peer ${peerId} in the registry`);
  return peer;
};

// One-shot waiters on this machine's local history invalidation, which every
// committed add or delete emits, peer-applied or not.
const waiters = new Map();
let armed = 0;
bus.peerSyncBus.on('media-history-changed', ({ kind, op, ids }) => {
  for (const waiter of waiters.values()) {
    if (!waiter.settled && waiter.kind === kind && waiter.op === op && ids.includes(waiter.id)) waiter.settle();
  }
});

const realNow = Date.now.bind(Date);
const WAIT_LIMIT_MS = 10_000;

const commands = {
  async listen() {
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    return { port: httpServer.address().port };
  },
  async writeRegistry({ self, peers }) {
    mkdirSync(PATHS.data, { recursive: true });
    writeFileSync(registryFile(), JSON.stringify({ self, peers }, null, 2));
  },
  async setPeerFields({ peerId, fields }) {
    const data = await readRegistry();
    data.peers = data.peers.map((p) => (p.id === peerId ? { ...p, ...fields } : p));
    await atomicWrite(registryFile(), data);
  },
  // A render made here: its bytes, then the row through the history writer
  // every local render uses (it stamps this machine as origin and announces it).
  async seedVideo({ id }) {
    mkdirSync(PATHS.videos, { recursive: true });
    mkdirSync(PATHS.videoThumbnails, { recursive: true });
    writeFileSync(join(PATHS.videos, `${id}.mp4`), Buffer.from(`synthetic-video-${id}`));
    writeFileSync(join(PATHS.videoThumbnails, `${id}.jpg`), Buffer.from(`synthetic-thumb-${id}`));
    const row = { id, filename: `${id}.mp4`, thumbnail: `${id}.jpg`, prompt: 'Example prompt', createdAt: new Date(realNow()).toISOString() };
    await mutateVideoHistory((history) => { history.unshift(row); return history; });
  },
  async rows() {
    return (await loadHistory()).map(({ id, originInstanceId, pendingDelete, hidden }) => ({ id, originInstanceId, pendingDelete, hidden }));
  },
  async files({ id }) {
    return {
      video: existsSync(join(PATHS.videos, `${id}.mp4`)),
      thumbnail: existsSync(join(PATHS.videoThumbnails, `${id}.jpg`)),
    };
  },
  async tombstones() {
    return (await listMediaTombstones('video')).map((t) => t.key);
  },
  async deleteVideo({ id }) {
    return deleteMediaAnywhere('video', id);
  },
  // The Media History delete button's request, against this machine's own server.
  async deleteVideoFromUi({ id }) {
    const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/video-gen/history/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return { status: res.status, body: await res.json() };
  },
  async armHistoryChange({ op, id }) {
    const token = `${op}:${id}:${++armed}`;
    const waiter = { kind: 'video', op, id, settled: false };
    waiter.done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiter.settled = true;
        reject(new Error(`no video ${op} of ${id} applied here within ${WAIT_LIMIT_MS}ms`));
      }, WAIT_LIMIT_MS);
      waiter.settle = () => {
        waiter.settled = true;
        clearTimeout(timer);
        resolve();
      };
    });
    waiter.done.catch(() => {});
    waiters.set(token, waiter);
    return { token };
  },
  async awaitHistoryChange({ token }) {
    const waiter = waiters.get(token);
    if (!waiter) throw new Error(`no waiter ${token}`);
    try {
      await waiter.done;
    } finally {
      waiters.delete(token);
    }
  },
  // The relay as the instance probe opens it: a first peer request has already
  // resolved this install's identity, so the socket names it to the peer.
  async connectRelay({ peerId }) {
    if (relay.peerRealtimeSyncSince(peerId) !== null) return { since: relay.peerRealtimeSyncSince(peerId) };
    const peer = await peerById(peerId);
    await peerFetch(`http://${peer.address}:${peer.port}/api/sync/`, {}, peer).then((res) => res.arrayBuffer());
    const live = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`relay to ${peerId} not subscribed within ${WAIT_LIMIT_MS}ms`)), WAIT_LIMIT_MS);
      const onRealtime = (state) => {
        if (state.peerId !== peerId || !state.live) return;
        clearTimeout(timer);
        instanceEvents.off('peer:sync:realtime', onRealtime);
        resolve();
      };
      instanceEvents.on('peer:sync:realtime', onRealtime);
    });
    relay.connectToPeer(peer);
    await live;
    return { since: relay.peerRealtimeSyncSince(peerId) };
  },
  async disconnectRelay({ peerId }) {
    relay.disconnectFromPeer(peerId);
  },
  async realtimeSince({ peerId }) {
    return relay.peerRealtimeSyncSince(peerId);
  },
  async syncWithPeer({ peerId }) {
    await orchestrator.syncWithPeer(await peerById(peerId));
  },
  async syncTick() {
    await orchestrator.syncAllPeers();
  },
  // Reconnect as boot wires it: the orchestrator's peer:online handler syncs.
  async startOrchestrator() {
    orchestrator.initSyncOrchestrator();
  },
  async stopOrchestrator() {
    orchestrator.stopSyncOrchestrator();
  },
  // Resolves when the sync that handler started has completed.
  async emitPeerOnline({ peerId }) {
    const peer = await peerById(peerId);
    const complete = new Promise((resolve) => {
      const onProgress = (progress) => {
        if (progress.peerId !== peer.instanceId || progress.phase !== 'complete') return;
        instanceEvents.off('sync:progress', onProgress);
        resolve(progress);
      };
      instanceEvents.on('sync:progress', onProgress);
    });
    instanceEvents.emit('peer:online', peer);
    return complete;
  },
  // Fake time for the cadence decision only: the relay sockets send nothing
  // while it is shifted, so their ping bookkeeping never reads it.
  async shiftClock({ ms }) {
    Date.now = ms ? () => realNow() + ms : realNow;
  },
  async takeRequests() {
    return requests.splice(0);
  },
  // Resolves with the delivery of the frame this machine emitted for `op`/`id`.
  async awaitDelivery({ op, id }) {
    const match = (entry) => entry.op === op && entry.id === id;
    const done = delivered.find(match);
    if (done) return done;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        deliveries.off('delivered', onDelivered);
        reject(new Error(`no ${op} frame for ${id} emitted within ${WAIT_LIMIT_MS}ms`));
      }, WAIT_LIMIT_MS);
      const onDelivered = (entry) => {
        if (!match(entry)) return;
        clearTimeout(timer);
        deliveries.off('delivered', onDelivered);
        resolve(entry);
      };
      deliveries.on('delivered', onDelivered);
    });
  },
  async stop() {
    for (const peer of (await readRegistry()).peers) relay.disconnectFromPeer(peer.id);
    await new Promise((resolve) => io.close(() => resolve()));
  },
};

parentPort.on('message', async ({ id, cmd, args }) => {
  try {
    if (!commands[cmd]) throw new Error(`unknown command ${cmd}`);
    parentPort.postMessage({ id, result: await commands[cmd](args ?? {}) });
  } catch (err) {
    parentPort.postMessage({ id, error: { message: err?.message ?? String(err), status: err?.status ?? null, code: err?.code ?? null } });
  }
});
parentPort.postMessage({ ready: workerData.name });

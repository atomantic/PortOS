/**
 * Optional document playback. Exact seeks and native capture lifetimes share
 * one queue; only the page's cooperative producer advances playing frames.
 */
import { AUTHORED_PREVIEW_HANDSHAKE_MS, AUTHORED_PREVIEW_PLAYBACK_TARGET, authoredPreviewPlaybackReplies, generatedPreviewPlaybackSchema as playbackSchema } from '../../lib/generatedPreviewPlaybackSchema.js';
export { playbackSchema };

const AUTHORED_METHOD_MS = { clock: AUTHORED_PREVIEW_HANDSHAKE_MS, prepare: 3000, play: 1500, sync: 1500, pause: 3000 };
const DRAIN_MS = 1500;
const START_FENCE_MS = 750;
const canonicalCall = (page, method, args = {}) => page.evaluate(
  `globalThis.portosComposition.previewPlayback.${method}(${JSON.stringify(args)})`,
);

export function createCooperativePlayback(session, { seekPage, capture, emitFrame, fail, closeSession, authored = false }) {
  let tail = Promise.resolve();
  let intent = 0;
  let epoch = 0;
  let anchorSequence = -1;
  let frameSequence = 0;
  let mode = 'paused';
  let stream = null;
  let active = false;
  let closed = false;
  let time = 0;
  let acceptedGeneration = 0;
  let controlRevision = 0;
  let exactBarrier = 0;
  let resyncEpoch = null;
  let lastClock = -1;
  const pendingCalls = new Set();

  const enqueue = (operation) => {
    const result = tail.catch(() => {}).then(() => closed ? undefined : operation());
    tail = result;
    return result;
  };
  const reply = (payload) => {
    if (!closed && !session.closed) session.socket.emit('generated-preview:playback-state', {
      requestId: session.requestId, sessionId: session.id, ...payload,
    });
  };
  const gate = () => { if (stream) stream.forward = false; };
  const terminate = (error) => {
    if (closed || session.closed) return;
    gate();
    mode = 'error';
    console.error(`❌ Cooperative preview failed: ${error?.message || error}`);
    fail(session.socket, { requestId: session.requestId, sessionId: session.id, code: 'PREVIEW_PLAYBACK_FAILED', message: 'Live preview stopped. Retry the preview to continue.' });
    closeSession(session.id, 'playback-failed').catch(() => {});
  };

  const nativeCall = async (method, args = {}) => {
    if (!authored) return canonicalCall(session.page, method, args);
    if (closed || session.closed) throw new Error('Preview closed');
    const startedAt = performance.now();
    const timeoutMs = AUTHORED_METHOD_MS[method];
    let timer;
    let rejectClosed;
    const canceled = new Promise((_, reject) => { rejectClosed = reject; });
    pendingCalls.add(rejectClosed);
    const invocation = `globalThis.${AUTHORED_PREVIEW_PLAYBACK_TARGET}.${method}(${JSON.stringify(args)})`;
    // CDP awaits returned Promises, so enforce the synchronous clock contract
    // inside the renderer before the transport can assimilate a thenable.
    const source = method === 'clock'
      ? `(() => { const value = ${invocation}; if (value && typeof value.then === 'function') throw new Error('Authored preview clock must be synchronous'); return value; })()`
      : invocation;
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          if (closed || session.closed) throw new Error('Preview closed');
          return session.page.evaluate(source);
        }),
        canceled,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Authored preview ${method} timed out`)), timeoutMs); }),
      ]);
      // Overdue timers can run after a CDP response microtask. Elapsed time is
      // authoritative even when the response wins that event-loop race.
      if (performance.now() - startedAt >= timeoutMs) throw new Error(`Authored preview ${method} timed out`);
      const parsed = authoredPreviewPlaybackReplies[method].safeParse(value);
      if (!parsed.success) throw new Error(`Authored preview ${method} returned an invalid response`);
      const result = parsed.data;
      if (method === 'clock') {
        if (result < lastClock) throw new Error('Authored preview clock regressed');
        lastClock = result;
      } else if (result.epoch !== args.epoch || ('sequence' in args && result.sequence !== args.sequence) || (method === 'prepare' && result.t !== args.t)) {
        throw new Error(`Authored preview ${method} response did not match its request`);
      }
      return result;
    } catch (error) {
      // A timed-out author Promise is still running. Close before any queued
      // exact seek or control can reuse that uncertain page.
      terminate(error);
      throw error;
    } finally {
      clearTimeout(timer);
      pendingCalls.delete(rejectClosed);
    }
  };

  async function stopStream() {
    const previous = stream;
    if (!previous) return;
    previous.forward = false;
    previous.draining = true;
    await Promise.all([...previous.acks]);
    if (closed) return;
    if (!previous.held) {
      // A forced repaint is used only at a state transition. Holding the sole
      // completed cap=1 event proves no older JPEG encoder can be relabelled
      // by the next Start. ACK alone is not a raw-capture freshness barrier.
      const waiting = new Promise((resolve, reject) => {
        previous.resolveHeld = resolve;
        previous.rejectHeld = reject;
        previous.timer = setTimeout(() => reject(new Error('Native playback capture did not drain')), DRAIN_MS);
      });
      const repaint = capture(session.page);
      try { await Promise.all([waiting, repaint]); }
      finally { clearTimeout(previous.timer); previous.resolveHeld = null; previous.rejectHeld = null; }
    }
    if (closed) return;
    await session.page.send('Page.stopScreencast');
    // Deliberately retire the held credit without ACKing a stopped lifetime.
    if (stream === previous) stream = null;
  }

  async function quiesce() {
    gate();
    if (stream) stream.draining = true;
    await nativeCall('pause', { epoch });
    await stopStream();
  }

  const beginClockResync = (action, sequence) => {
    if (closed || session.closed || resyncEpoch === epoch) return;
    const failedEpoch = epoch;
    gate();
    mode = 'paused';
    resyncEpoch = failedEpoch;
    // Queue retirement before notifying the master. Its next prepare must
    // follow this drain, but its audio must stop without awaiting that drain.
    // Do not return this tail from a currently queued operation: it would
    // await itself through the next queue entry.
    enqueue(() => quiesce()).catch(terminate);
    reply({ action, epoch: failedEpoch, sequence, status: 'resync-required', reason: 'clock', message: 'Preview clock needs synchronization.' });
  };

  async function startStream() {
    const next = { epoch, forward: false, draining: false, held: null, acks: new Set(), lifetime: null };
    stream = next;
    await session.page.send('Page.startScreencast', {
      format: 'jpeg', quality: 55, everyNthFrame: 1, maxFramesInFlight: 1, sendLastFrame: false,
    });
  }

  async function startAfterMotionFence(valid) {
    let timer;
    try {
      return await Promise.race([
        (async () => {
          // Capture only on this transition, after motion mode is active. The
          // next capturer must not bootstrap from the expensive exact surface.
          await capture(session.page);
          if (!valid()) return false;
          await startStream();
          return valid();
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native playback startup repaint timed out')), START_FENCE_MS); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  const onFrame = (params) => {
    const current = stream;
    if (closed || !current || !params?.data) return;
    const lifetime = params.sessionId;
    if (!Number.isInteger(lifetime) || (current.lifetime !== null && current.lifetime !== lifetime)) {
      terminate(new Error('Native capture lifetime changed unexpectedly'));
      return;
    }
    current.lifetime = lifetime;
    if (current.draining) {
      if (current.held) { terminate(new Error('Native capture exceeded one in-flight frame')); return; }
      current.held = params;
      current.resolveHeld?.();
      return;
    }
    if (current.forward && mode === 'playing' && current.epoch === epoch) {
      emitFrame(session, null, params.data, { playbackEpoch: epoch, sequence: ++frameSequence });
    }
    const ack = session.page.send('Page.screencastFrameAck', { sessionId: lifetime });
    current.acks.add(ack);
    ack.then(() => current.acks.delete(ack), (error) => { current.acks.delete(ack); terminate(error); });
  };

  const seek = (generation, t, playing = false) => {
    if (generation < acceptedGeneration) return Promise.resolve();
    acceptedGeneration = generation;
    time = t;
    const current = ++intent;
    const legacyPlaying = playing && !active;
    if (!legacyPlaying || mode !== 'legacy-playing') exactBarrier += 1;
    const barrier = exactBarrier;
    gate();
    mode = legacyPlaying ? 'legacy-playing' : 'paused';
    const validCompletion = () => current === intent || legacyPlaying && mode === 'legacy-playing' && barrier === exactBarrier;
    return enqueue(async () => {
      await quiesce();
      if (current !== intent) return;
      await seekPage(session, t, playing);
      if (!validCompletion() || closed) return;
      const data = await capture(session.page);
      if (!validCompletion() || closed) return;
      session.appliedGeneration = generation;
      emitFrame(session, generation, data);
    });
  };

  const handle = (input) => {
    if (input.requestId !== session.requestId) return Promise.resolve();
    if (input.action === 'clock') return enqueue(async () => {
      const workerTime = await nativeCall('clock');
      reply({ action: 'clock', probeId: input.probeId, clientTime: input.clientTime, workerTime });
    });
    if (input.action === 'pause') {
      if (input.epoch < epoch || input.generation < acceptedGeneration) return Promise.resolve();
      epoch = input.epoch;
      return seek(input.generation, input.t);
    }
    if (input.action === 'prepare') {
      if (input.epoch <= epoch || input.generation < acceptedGeneration) return Promise.resolve();
      acceptedGeneration = input.generation;
      time = input.t;
      active = true;
      exactBarrier += 1;
      epoch = input.epoch;
      anchorSequence = input.sequence;
      frameSequence = 0;
      const current = ++intent;
      const revision = controlRevision;
      gate();
      mode = 'preparing';
      return enqueue(async () => {
        await quiesce();
        if (current !== intent) return;
        await seekPage(session, input.t, false);
        if (current !== intent) return;
        const prepared = await nativeCall('prepare', { epoch: input.epoch, ...(authored ? { sequence: input.sequence } : {}), t: input.t });
        if (current !== intent || revision !== controlRevision || prepared?.status === 'superseded') return;
        const data = await capture(session.page);
        if (current !== intent || revision !== controlRevision || closed) return;
        time = input.t;
        session.appliedGeneration = input.generation;
        mode = 'prepared';
        emitFrame(session, input.generation, data);
        reply({ action: 'prepare', epoch, sequence: input.sequence, status: 'ready' });
      });
    }
    if (input.epoch !== epoch || input.sequence <= anchorSequence || !['prepared', 'starting', 'playing'].includes(mode)) return Promise.resolve();
    anchorSequence = input.sequence;
    const current = intent;
    const revision = controlRevision;
    return enqueue(async () => {
      if (current !== intent || revision !== controlRevision || input.epoch !== epoch) return;
      if (input.action === 'play') {
        if (mode !== 'prepared') return;
        mode = 'starting';
        const result = await nativeCall('play', { epoch: input.epoch, t: input.t, workerTime: input.workerTime, sequence: input.sequence });
        if (current !== intent || revision !== controlRevision || mode !== 'starting' || closed) return;
        if (result?.status === 'resync-required' || authored && ['stale', 'superseded'].includes(result.status)) {
          beginClockResync('play', input.sequence);
          return;
        }
        if (result?.status !== 'playing') throw new Error('Native playback did not start');
        const valid = () => current === intent && revision === controlRevision && mode === 'starting' && input.epoch === epoch && !closed;
        if (!await startAfterMotionFence(valid)) return;
        mode = 'playing';
        time = input.t;
        if (stream) stream.forward = true;
        reply({ action: 'play', epoch, sequence: input.sequence, status: 'playing' });
      } else if (mode === 'playing') {
        const result = await nativeCall('sync', { epoch: input.epoch, t: input.t, workerTime: input.workerTime, sequence: input.sequence });
        if (current !== intent || revision !== controlRevision || mode !== 'playing' || closed) return;
        time = input.t;
        if (result?.status === 'resync-required' || authored && result.status === 'stale') {
          beginClockResync('sync', input.sequence);
          return;
        }
        if (current !== intent || input.epoch !== epoch || closed) return;
        reply({ action: 'sync', epoch: input.epoch, sequence: input.sequence, status: result?.status || 'error' });
      }
    });
  };

  const control = (operation) => {
    const needsResync = ['preparing', 'prepared', 'starting', 'playing'].includes(mode);
    const controlEpoch = epoch;
    const controlSequence = anchorSequence;
    const revision = ++controlRevision;
    exactBarrier += 1;
    const current = intent;
    gate();
    mode = 'paused';
    const queued = enqueue(async () => {
      await quiesce();
      if (closed) return;
      // Mutations retain queue order even when their now-obsolete image is
      // superseded by a later control or seek.
      await operation();
      if (current !== intent || revision !== controlRevision || closed) return;
      await seekPage(session, time, false);
      if (current !== intent || revision !== controlRevision || closed) return;
      const data = await capture(session.page);
      if (current !== intent || revision !== controlRevision || closed) return;
      session.appliedGeneration = acceptedGeneration;
      emitFrame(session, acceptedGeneration, data);
    });
    // Queue the mutation first, then cancel the client's preparation/playing
    // handshake. Its replacement prepare necessarily follows this mutation.
    if (needsResync && resyncEpoch !== controlEpoch) {
      resyncEpoch = controlEpoch;
      reply({ action: 'sync', epoch: controlEpoch, sequence: controlSequence, status: 'resync-required', reason: 'controls', message: 'Preview controls changed.' });
    }
    return queued;
  };

  const onEvent = (params) => {
    if (params?.epoch !== epoch || !active) return;
    if (params.type === 'portos-mv:playback-error') terminate(new Error(params.message || 'Native playback failed'));
    else if (params.type === 'portos-mv:playback-resync' && ['preparing', 'prepared', 'starting', 'playing'].includes(mode)) beginClockResync('sync', anchorSequence);
  };

  return {
    get active() { return active; }, handle, seek, control, onFrame, onEvent, terminate,
    close() {
      closed = true;
      intent += 1;
      gate();
      for (const reject of pendingCalls) reject(new Error('Preview closed'));
      pendingCalls.clear();
      if (stream) {
        clearTimeout(stream.timer);
        stream.rejectHeld?.(new Error('Preview closed'));
      }
    },
    async settled() { await Promise.allSettled([tail, ...(stream ? stream.acks : [])]); },
  };
}

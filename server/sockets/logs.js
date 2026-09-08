import { buildEnv, spawnPm2 } from '../services/pm2.js';
import { getAppById, resolvePm2HomeForProcess } from '../services/apps.js';
import {
  logsSubscribeSchema,
  logsUnsubscribeSchema,
  validateSocketData
} from '../lib/socketValidation.js';

// Store active log streams per socket/process pair.
const activeStreams = new Map();
const streamKey = (socketId, processName) => `${socketId}:${processName}`;

// Monotonic per-stream subscribe generation. `logs:subscribe` awaits an app
// lookup before it can spawn `pm2 logs`, so the request it started for may be
// obsolete by the time it resolves. Stream occupancy alone cannot tell the cases
// apart: an `logs:unsubscribe` that lands mid-lookup leaves the slot EMPTY, so a
// stale handler would spawn an orphan `pm2 logs` nothing ever kills; and when two
// subscribes for the same process overlap, the OLDER one can fill the slot first,
// so the newer one bails and its client waits forever for `logs:subscribed`.
const streamGenerations = new Map();
const bumpStreamGeneration = (key) => {
  const next = (streamGenerations.get(key) || 0) + 1;
  streamGenerations.set(key, next);
  return next;
};

const cleanupStream = (key) => {
  // Bump unconditionally, even with no stream to kill: this is the cancellation
  // point for a `logs:subscribe` still awaiting its app lookup, which has not
  // claimed the slot yet and so would otherwise survive an unsubscribe.
  bumpStreamGeneration(key);
  const stream = activeStreams.get(key);
  if (stream) {
    stream.process.kill('SIGTERM');
    activeStreams.delete(key);
  }
};

export const cleanupSocketStreams = (socketId) => {
  const prefix = `${socketId}:`;
  for (const [key, stream] of activeStreams) {
    if (!key.startsWith(prefix)) continue;
    stream.process.kill('SIGTERM');
    activeStreams.delete(key);
  }
  // Dropping a pending stream's generation invalidates an in-flight lookup
  // without needing a synthetic process entry to represent it.
  for (const key of streamGenerations.keys()) {
    if (key.startsWith(prefix)) streamGenerations.delete(key);
  }
};

export const registerLogHandlers = (socket, _io) => {
  socket.on('logs:subscribe', async (rawData) => {
    // Declared outside the try so the catch can echo it back: the client's
    // logs:error listener filters on processName, so an error emitted without
    // it is silently dropped and the log panel just hangs.
    let processName;
    try {
      const data = validateSocketData(logsSubscribeSchema, rawData, socket, 'logs:subscribe');
      if (!data) return;
      let lines, appId;
      ({ processName, lines, appId } = data);
      const key = streamKey(socket.id, processName);

      // Clean up only this process's existing stream, then claim this request.
      // Claiming AFTER the cleanup bump is what makes this generation current.
      cleanupStream(key);
      const generation = bumpStreamGeneration(key);

      // Resolve the app's custom PM2_HOME so the stream tails the home its
      // processes actually run in. appId remains the disambiguating fast path;
      // legacy callers without it fall back to the process-name registry lookup.
      // This runs outside the Express lifecycle, so a lookup failure must not
      // throw — fall back to the default home.
      let pm2Home = null;
      if (appId) {
        pm2Home = await getAppById(appId)
          .then(app => app?.pm2Home || null)
          .catch(err => {
            console.error(`❌ logs:subscribe could not resolve app ${appId}: ${err.message}`);
            return null;
          });
      } else {
        pm2Home = await resolvePm2HomeForProcess(processName)
          .catch(err => {
            console.error(`❌ logs:subscribe could not resolve ${processName}: ${err.message}`);
            return null;
          });
      }

      // The await above yields, so a disconnect, an unsubscribe, or a newer
      // subscribe may have landed in the meantime. Bail if this socket is gone
      // rather than spawning an orphan `pm2 logs` nothing will ever clean up.
      if (socket.disconnected) return;
      if (streamGenerations.get(key) !== generation) return;

      console.log(`📜 Log stream started: ${processName} (${lines} lines)`);
      const logProcess = spawnPm2(
        ['logs', processName, '--raw', '--lines', String(lines)],
        { env: buildEnv(pm2Home) }
      );

      activeStreams.set(key, { process: logProcess, processName });

      // One reader per stream. stdout and stderr are independent EventEmitters
      // on the same child, so a single shared tail buffer lets a chunk from one
      // stream be spliced onto the other's partial line and emitted under the
      // wrong `type` — unrecoverably, since the original two lines can no
      // longer be separated. A closure per stream removes the shared state.
      const makeLineReader = (type) => {
        let buffer = '';
        const send = (line) => {
          if (!line.trim()) return;
          socket.emit('logs:line', { line, type, timestamp: Date.now(), processName });
        };
        return {
          push(chunk) {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            lines.forEach(send);
          },
          flush() {
            const remainder = buffer;
            buffer = '';
            send(remainder);
          }
        };
      };

      const stdoutReader = makeLineReader('stdout');
      const stderrReader = makeLineReader('stderr');

      logProcess.stdout.on('data', (data) => stdoutReader.push(data));
      logProcess.stderr.on('data', (data) => stderrReader.push(data));

      logProcess.on('error', (err) => {
        socket.emit('logs:error', { error: err.message, processName });
      });

      logProcess.on('close', (code) => {
        // A SIGTERM'd predecessor's `close` fires asynchronously — after the
        // replacement stream has already registered — so it must not delete the
        // live replacement or emit a misleading close frame.
        if (activeStreams.get(key)?.process !== logProcess) return;
        // A crashing process leaves its last line unterminated; flush both tails
        // before the close frame so it arrives in order instead of being dropped.
        stdoutReader.flush();
        stderrReader.flush();
        socket.emit('logs:close', { code, processName });
        activeStreams.delete(key);
        streamGenerations.delete(key);
      });

      socket.emit('logs:subscribed', { processName, timestamp: Date.now() });
    } catch (err) {
      const message = err?.message ?? String(err);
      console.error(`❌ Socket handler error [logs:subscribe]: ${message}`);
      socket.emit('logs:error', { error: message, processName });
    }
  });

  socket.on('logs:unsubscribe', (rawData) => {
    const data = validateSocketData(logsUnsubscribeSchema, rawData, socket, 'logs:unsubscribe');
    if (!data) return;
    if (data.processName) cleanupStream(streamKey(socket.id, data.processName));
    else cleanupSocketStreams(socket.id);
    socket.emit('logs:unsubscribed', { processName: data.processName });
  });
};

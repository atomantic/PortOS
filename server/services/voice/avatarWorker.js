// Run the offline avatar model over private child-process pipes and admit one render at a time.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawn } from '../../lib/childProcess.js';
import { ServerError } from '../../lib/errorHandler.js';
import { avatarOfflineEnv, avatarPortrait, avatarScript, avatarWeights, denyNetwork } from './avatarInstall.js';

export const avatarError = (message, status = 409) => new ServerError(message, { status, code: 'VOICE_AVATAR' });
const maxSpeakFrames = 400;
const maxIdleFrames = 1500;
const speakTimeoutMs = 35_000;
const idleStallTimeoutMs = 15_000;

export function openAvatarWorker(python, onClose, launch = spawn) {
  const child = launch('/usr/bin/sandbox-exec', ['-p', denyNetwork, python, '-uB', avatarScript('stream'), avatarWeights, avatarPortrait],
    { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: avatarOfflineEnv() });
  let active;
  let ready = false;
  let expectedStop = false;
  let startError;
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  const terminate = () => child.kill('SIGKILL');
  const armTimer = (entry, timeoutMs) => {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(terminate, timeoutMs);
    entry.timer.unref?.();
  };
  const cancelActive = (entry) => {
    if (!entry || entry.cancelSent) return;
    entry.cancelSent = true;
    send({ type: 'cancel', id: entry.id });
    if (active?.id === entry.id) {
      entry.cancelTimer = setTimeout(terminate, 3_000);
      entry.cancelTimer.unref?.();
    }
  };
  const cleanupRender = (error) => {
    if (!active) return;
    const { timer, cancelTimer, signal, abort, resolve, reject } = active;
    active = undefined;
    clearTimeout(timer);
    clearTimeout(cancelTimer);
    signal.removeEventListener('abort', abort);
    if (error) reject(error);
    else resolve();
  };
  const { promise: warmed, resolve: warmedUp, reject: warmFailed } = Promise.withResolvers();
  const warmTimer = setTimeout(() => {
    startError = avatarError('AvatarForcing did not finish warming up. Start it again.', 503);
    terminate();
  }, 90_000);
  warmTimer.unref?.();
  child.stderr.resume(); // Do not log speech, subprocess paths or model diagnostics to server logs.
  child.stdin.on('error', terminate);
  child.on('error', () => { startError = avatarError('Could not launch the offline AvatarForcing worker.', 503); });
  child.once('close', () => {
    clearTimeout(warmTimer);
    const error = startError ?? avatarError('AvatarForcing stopped before it finished.', 503);
    if (!ready) warmFailed(error);
    ready = false;
    cleanupRender(error);
    onClose(expectedStop);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'ready' && !ready) {
        clearTimeout(warmTimer);
        ready = true;
        warmedUp();
      } else if (active && active.id === event.id) {
        if (event.type === 'frame' && !active.signal.aborted && !active.preempted) {
          if (event.index !== active.next || event.index >= active.maxFrames || event.timeMs !== event.index * 40
            || typeof event.jpeg !== 'string' || event.jpeg.length > 256_000) throw new Error('Invalid avatar frame');
          active.next += 1;
          if (active.kind === 'idle') armTimer(active, idleStallTimeoutMs);
          active.onFrame({ index: event.index, timeMs: event.timeMs, jpeg: event.jpeg });
        } else if (event.type === 'done' || event.type === 'cancelled') {
          cleanupRender();
        } else if (event.type === 'error') {
          cleanupRender(avatarError(
            active.kind === 'idle' ? 'AvatarForcing could not animate idle frames.' : 'AvatarForcing could not animate this audio.',
            422,
          ));
        }
      }
    } catch {
      terminate(); // Pipe protocol is broken; fail closed and let voice audio continue.
    }
  });

  const startRender = ({ kind, maxFrames, timeoutMs, command, onFrame, signal }) => {
    const { promise, resolve, reject } = Promise.withResolvers();
    const id = randomUUID();
    const entry = {
      id, kind, maxFrames, promise, resolve, reject, signal, onFrame,
      next: 0, preempted: false, cancelSent: false, timer: null, cancelTimer: null, abort: null,
    };
    entry.abort = () => cancelActive(entry);
    armTimer(entry, timeoutMs);
    active = entry;
    signal.addEventListener('abort', entry.abort, { once: true });
    send({ ...command, id });
    return promise;
  };

  return {
    warmed,
    stop() { expectedStop = true; terminate(); },
    async render(wav, { onFrame, signal }) {
      // Preempt continuous idle or wait for an already-aborted turn to unwind,
      // never waiting on another tab's live speech request.
      while (active && (active.signal.aborted || active.kind === 'idle')) {
        const current = active;
        if (current.kind === 'idle') {
          current.preempted = true;
          cancelActive(current);
        }
        await current.promise.catch(() => {});
      }
      if (!ready) throw avatarError('Start AvatarForcing before animating.', 503);
      if (active) throw avatarError('AvatarForcing is already animating.');
      if (signal.aborted) return;
      await startRender({
        kind: 'speak',
        maxFrames: maxSpeakFrames,
        timeoutMs: speakTimeoutMs,
        command: { type: 'speak', wav: wav.toString('base64') },
        onFrame,
        signal,
      });
    },
    async renderIdle({ stage = 'idle', onFrame, signal }) {
      if (!ready) throw avatarError('Start AvatarForcing before animating.', 503);
      if (signal.aborted) return;
      if (active?.kind === 'speak') return;
      while (active?.kind === 'idle') {
        const current = active;
        current.preempted = true;
        cancelActive(current);
        await current.promise.catch(() => {});
      }
      if (!ready || signal.aborted || active) return;
      await startRender({
        kind: 'idle',
        maxFrames: maxIdleFrames,
        timeoutMs: idleStallTimeoutMs,
        command: { type: 'idle', stage },
        onFrame,
        signal,
      });
    },
  };
}

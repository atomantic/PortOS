// Run the offline avatar model over private child-process pipes and admit one render at a time.
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawn } from '../../lib/childProcess.js';
import { ServerError } from '../../lib/errorHandler.js';
import { avatarOfflineEnv, avatarPortrait, avatarScript, avatarWeights, denyNetwork } from './avatarInstall.js';

export const avatarError = (message, status = 409) => new ServerError(message, { status, code: 'VOICE_AVATAR' });
const maxFrames = 400;

export function openAvatarWorker(python, onClose, launch = spawn) {
  const child = launch('/usr/bin/sandbox-exec', ['-p', denyNetwork, python, '-uB', avatarScript('stream'), avatarWeights, avatarPortrait],
    { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: avatarOfflineEnv() });
  let active;
  let ready = false;
  let expectedStop = false;
  let startError;
  const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  const terminate = () => child.kill('SIGKILL');
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
        if (event.type === 'frame' && !active.signal.aborted) {
          if (event.index !== active.next || event.index >= maxFrames || event.timeMs !== event.index * 40
            || typeof event.jpeg !== 'string' || event.jpeg.length > 256_000) throw new Error('Invalid avatar frame');
          active.next += 1;
          active.onFrame({ index: event.index, timeMs: event.timeMs, jpeg: event.jpeg });
        } else if (event.type === 'done' || event.type === 'cancelled') {
          cleanupRender();
        } else if (event.type === 'error') {
          cleanupRender(avatarError('AvatarForcing could not animate this audio.', 422));
        }
      }
    } catch {
      terminate(); // Pipe protocol is broken; fail closed and let voice audio continue.
    }
  });

  return {
    warmed,
    stop() { expectedStop = true; terminate(); },
    async render(wav, { onFrame, signal }) {
      // An immediate reply after Interrupt may arrive before the current GPU
      // block returns. Wait for that cancelled render, never for another tab's
      // live request, and recheck ownership after the await.
      if (active?.signal.aborted) await active.promise.catch(() => {});
      if (!ready) throw avatarError('Start AvatarForcing before animating.', 503);
      if (active) throw avatarError('AvatarForcing is already animating.');
      if (signal.aborted) return;
      const { promise, resolve, reject } = Promise.withResolvers();
      const id = randomUUID();
      const abort = () => {
        send({ type: 'cancel', id });
        if (active?.id === id) {
          active.cancelTimer = setTimeout(terminate, 3_000);
          active.cancelTimer.unref?.();
        }
      };
      active = { id, promise, resolve, reject, signal, onFrame, abort, next: 0, timer: setTimeout(terminate, 35_000) };
      active.timer.unref?.();
      signal.addEventListener('abort', abort, { once: true });
      send({ type: 'speak', id, wav: wav.toString('base64') });
      await promise;
    },
  };
}

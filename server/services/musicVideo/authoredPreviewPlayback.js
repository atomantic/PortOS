import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  AUTHORED_PREVIEW_HANDSHAKE_MS, AUTHORED_PREVIEW_PLAYBACK_TARGET,
} from '../../lib/generatedPreviewPlaybackSchema.js';

const CONTRACT = 'portos-complete-frame-v1';
const MAX_DECLARATION_BYTES = 1024;
const declarationShape = z.object({ version: z.number().int(), contract: z.string() }).strict();
const supportedDeclaration = z.object({ version: z.literal(1), contract: z.literal(CONTRACT) }).strict();

/** An explicit opt-in identifies an author's promise, not source purity. */
export async function readAuthoredPreviewDeclaration(directory, { scenes = [] } = {}) {
  const path = join(directory, 'preview-playback.json');
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return { declared: false, supported: false, reason: 'absent' };
  const declined = reason => ({ declared: true, supported: false, reason });
  if (!info.isFile() || info.size > MAX_DECLARATION_BYTES) return declined('invalid-declaration');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > MAX_DECLARATION_BYTES) return declined('invalid-declaration');
  let declaration;
  try { declaration = JSON.parse(text); }
  catch { return declined('invalid-declaration'); }
  if (!declarationShape.safeParse(declaration).success) return declined('invalid-declaration');
  if (!supportedDeclaration.safeParse(declaration).success) return declined('unsupported-declaration');
  if (scenes.some(scene => scene.media?.kind === 'video'
    && (!Number.isFinite(scene.media.fps) || scene.media.fps <= 10))) return declined('unsupported-video-fps');
  return { declared: true, supported: true, version: 1, contract: CONTRACT };
}

// This executes in the owned page. The root read preserves PortOS's existing
// film/title accessors; authored API field getters are never invoked.
function inspectAndBind(target) {
  const unsupported = reason => ({ supported: false, reason });
  const ownValue = (object, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
  };
  const composition = globalThis.portosComposition;
  if (!composition || typeof composition !== 'object') return unsupported('unsupported-runtime');
  const api = ownValue(composition, 'previewPlayback');
  if (!api || typeof api !== 'object' || Array.isArray(api)) return unsupported('unsupported-runtime');
  const metadata = { version: 1, fps: 30, presentation: 'atomic-canvas-v1', mediaTiming: 'staged-output-v1' };
  for (const [key, value] of Object.entries(metadata)) {
    if (ownValue(api, key) !== value) return unsupported('unsupported-runtime');
  }
  const methods = Object.create(null);
  for (const name of ['clock', 'prepare', 'play', 'sync', 'pause', 'dispose']) {
    const method = ownValue(api, name);
    if (typeof method !== 'function') return unsupported('unsupported-runtime');
    methods[name] = Function.prototype.bind.call(method, api);
  }
  if (Object.getOwnPropertyDescriptor(globalThis, target)) return unsupported('occupied-bridge');
  const bridge = Object.freeze(Object.assign(Object.create(null), metadata, methods));
  Object.defineProperty(globalThis, target, { value: bridge, writable: false, configurable: false });
  return { supported: true, ...metadata, target };
}

const handshakeError = code => Object.assign(new Error(code === 'AUTHORED_PREVIEW_HANDSHAKE_TIMEOUT'
  ? 'Authored preview inspection exceeded its deadline'
  : 'Authored preview inspection returned an invalid receipt'), { code });

/** Uncertain inspection throws: callers must close the page before exact reuse. */
export function bindAuthoredPreviewPlayback(page) {
  const started = performance.now();
  const expression = `(${inspectAndBind.toString()})(${JSON.stringify(AUTHORED_PREVIEW_PLAYBACK_TARGET)})`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(handshakeError('AUTHORED_PREVIEW_HANDSHAKE_TIMEOUT')), AUTHORED_PREVIEW_HANDSHAKE_MS);
    Promise.resolve().then(() => page.evaluate(expression)).then(receipt => {
      clearTimeout(timer);
      if (performance.now() - started >= AUTHORED_PREVIEW_HANDSHAKE_MS) {
        reject(handshakeError('AUTHORED_PREVIEW_HANDSHAKE_TIMEOUT'));
      } else if (receipt?.supported === false && ['unsupported-runtime', 'occupied-bridge'].includes(receipt.reason)) {
        resolve({ supported: false, reason: receipt.reason });
      } else if (receipt?.supported === true && receipt.version === 1 && receipt.fps === 30
        && receipt.presentation === 'atomic-canvas-v1' && receipt.mediaTiming === 'staged-output-v1'
        && receipt.target === AUTHORED_PREVIEW_PLAYBACK_TARGET) {
        resolve({ supported: true, version: 1, fps: 30, presentation: receipt.presentation,
          mediaTiming: receipt.mediaTiming, target: receipt.target });
      } else reject(handshakeError('AUTHORED_PREVIEW_HANDSHAKE_INVALID'));
    }).catch(error => { clearTimeout(timer); reject(error); });
  });
}

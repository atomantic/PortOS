// Manage the operator-controlled AvatarForcing installation and its optional warm worker.
import { readFile, rm } from 'node:fs/promises';
import { release } from 'node:os';
import { avatarBundle, avatarFilesPresent, avatarMarker, avatarPython, avatarRoot, installAvatar } from './avatarInstall.js';
import { DEFAULT_PORTRAIT_KEY, avatarError, openAvatarWorker } from './avatarWorker.js';
import { isHostShuttingDown } from '../../lib/hostShutdown.js';
import { emitToOperators } from '../socketIo.js';

const supported = process.platform === 'darwin' && process.arch === 'arm64' && Number.parseInt(release(), 10) >= 25;
let phase = 'stopped';
let detail = '';
let worker;
let installer;
let busy = false;

async function installation() {
  if (!supported) return null;
  const saved = await readFile(avatarMarker, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  return /^[a-f0-9]{24}$/.test(saved) && await avatarFilesPresent(saved) ? saved : null;
}

export async function getAvatarStatus() {
  const installed = await installation();
  return { supported, installed: Boolean(installed), updateAvailable: Boolean(installed && installed !== await avatarBundle()),
    phase, detail };
}

function publish(next, message = '') {
  phase = next;
  detail = message;
  emitToOperators('voice:avatar:changed');
}

function assertAvatarCanLaunch() {
  if (isHostShuttingDown()) throw avatarError('PortOS is shutting down.', 503);
}

function install() {
  assertAvatarCanLaunch();
  installer = new AbortController();
  const { signal } = installer;
  publish('installing', 'Preparing model install…');
  installAvatar({ signal, progress: message => publish('installing', message) }).then(
    () => publish('stopped', 'Model installed. Start it when you’re ready.'),
    error => publish(signal.aborted ? 'stopped' : 'failed', signal.aborted ? 'Installation canceled.' :
      error.code === 'MKSERVE_INSTALL_FAILED' ? 'Could not prepare the pinned Python installer. Check your connection and retry.' :
        error.constructor === Error && !error.code ? error.message : 'Installation failed. Check disk space and network access.'),
  ).finally(() => { installer = undefined; });
}

function stopWorker() {
  if (!worker || phase === 'stopping') return;
  publish('stopping');
  worker.stop();
}

export function stopAvatarForShutdown() {
  installer?.abort();
  stopWorker();
}

function start(bundle) {
  assertAvatarCanLaunch();
  publish('starting', 'Warming the avatar model…');
  const owned = openAvatarWorker(avatarPython(bundle), expected => {
    if (worker !== owned) return;
    worker = undefined;
    publish(expected ? 'stopped' : 'failed', expected ? '' : 'The worker stopped. Voice audio still works. Try Start again.');
  });
  worker = owned;
  owned.warmed.then(() => { if (worker === owned && phase === 'starting') publish('running'); },
    () => {});
}

export async function manageAvatar(action) {
  if (!supported) throw avatarError('AvatarForcing requires Apple Silicon and macOS 26 or later.', 400);
  if (busy) throw avatarError('Another avatar action is in progress.');
  if (action === 'cancel') {
    if (!installer || phase !== 'installing') throw avatarError('No avatar installation is in progress.');
    installer.abort();
    return getAvatarStatus();
  }
  if (installer) throw avatarError('Wait for the avatar installation to finish.');
  busy = true;
  try {
    if (action === 'stop') {
      stopWorker();
    } else {
      if (worker) throw avatarError('Stop AvatarForcing before making this change.');
      const bundle = await installation();
      if (action === 'install' || action === 'update') install();
      else if (action === 'start') {
        if (!bundle) throw avatarError('Install AvatarForcing before starting it.');
        if (bundle !== await avatarBundle()) throw avatarError('Update AvatarForcing before starting it.');
        start(bundle);
      } else if (action === 'uninstall') {
        await rm(avatarRoot, { recursive: true, force: true });
        publish('stopped', 'AvatarForcing and its downloaded weights were removed.');
      }
    }
    return await getAvatarStatus();
  } finally {
    busy = false;
  }
}

// The face the active transceiver channel wears; an unreadable assignment keeps the default.
// Loaded on first render: the library pulls settings and media collections, which the
// runtime's install/start/stop lifecycle never needs.
async function activePortrait() {
  const { getActiveAvatarFilename, loadAvatarPortrait } = await import('./avatarLibrary.js');
  const filename = await getActiveAvatarFilename().catch(() => null);
  return filename ? { key: filename, load: () => loadAvatarPortrait(filename) } : { key: DEFAULT_PORTRAIT_KEY };
}

function runningWorker() {
  if (!worker || phase !== 'running') throw avatarError('Start AvatarForcing before animating.', 503);
  return worker;
}

export async function renderAvatar(wav, options) {
  runningWorker();
  const portrait = await activePortrait();
  return runningWorker().render(wav, { ...options, portrait });
}

export async function renderAvatarIdle(options) {
  runningWorker();
  const portrait = await activePortrait();
  return runningWorker().renderIdle({ ...options, portrait });
}

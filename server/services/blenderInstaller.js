/**
 * Managed Blender for Settings › Software (macOS). Finds the newest patch release of
 * the series PortOS is checked against (`LATEST_BLENDER_VERSION`'s major.minor) on
 * download.blender.org, verifies the DMG against Blender's published SHA-256 list,
 * copies Blender.app to a versioned ~/Applications path, points Code Animation at it
 * and re-runs the execution check. A failed check restores the previous executable;
 * the previous install is never removed.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from '../lib/childProcess.js';
import { blenderSeries, LATEST_BLENDER_VERSION } from '../lib/blenderVersion.js';
import { ServerError } from '../lib/errorHandler.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { safeChildProcessOptions, withoutServerSecretsEnv } from '../lib/processEnv.js';

const runFile = promisify(execFile);
const RELEASE_ROOT = 'https://download.blender.org/release';
const OFFER_TTL_MS = 6 * 60 * 60 * 1000;
const OFFER_ERROR_TTL_MS = 15 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const BLENDER_PROGRESS_EVENT = 'software:blender';

const compare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i += 1) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

const dmgArch = (arch) => (arch === 'arm64' ? 'arm64' : 'x64');

/** Newest `X.Y.Z` with a macOS DMG for `arch` in a series folder listing, or null. */
function newestPatchInListing(html, series, arch) {
  const pattern = new RegExp(`blender-(${series.replace('.', '\\.')}\\.\\d+)-macos-${dmgArch(arch)}\\.dmg"`, 'g');
  const versions = [...String(html).matchAll(pattern)].map((match) => match[1]);
  return versions.sort(compare).at(-1) || null;
}

/** The SHA-256 Blender publishes for `file` in its `blender-X.Y.Z.sha256` list, or null. */
function checksumFor(list, file) {
  const line = String(list).split('\n').find((row) => row.trim().endsWith(`  ${file}`) || row.trim().endsWith(` ${file}`));
  const hash = line?.trim().split(/\s+/)[0];
  return /^[0-9a-f]{64}$/i.test(hash || '') ? hash.toLowerCase() : null;
}

/** Newest series folder in the release index, so the page can mention a series PortOS is not checked against yet. */
function newestSeriesInIndex(html) {
  const series = [...String(html).matchAll(/href="Blender(\d+\.\d+)\/"/g)].map((match) => match[1]);
  return series.sort(compare).at(-1) || null;
}

const createOfferReader = ({ fetchText, arch = process.arch, now = Date.now }) => {
  let cache = null;
  return async ({ fresh = false } = {}) => {
    const age = cache ? now() - cache.at : Infinity;
    if (!fresh && cache && age < (cache.offer ? OFFER_TTL_MS : OFFER_ERROR_TTL_MS)) return cache.offer;
    const series = blenderSeries(LATEST_BLENDER_VERSION);
    const offer = await (async () => {
      const [listing, index] = await Promise.all([
        fetchText(`${RELEASE_ROOT}/Blender${series}/`),
        fetchText(`${RELEASE_ROOT}/`).catch(() => ''),
      ]);
      const version = newestPatchInListing(listing, series, arch);
      if (!version) return null;
      const file = `blender-${version}-macos-${dmgArch(arch)}.dmg`;
      const sha256 = checksumFor(await fetchText(`${RELEASE_ROOT}/Blender${series}/blender-${version}.sha256`), file);
      if (!sha256) return null;
      return { version, series, file, url: `${RELEASE_ROOT}/Blender${series}/${file}`, sha256, newestSeries: newestSeriesInIndex(index) };
    })().catch((error) => {
      console.log(`⏭️ Blender release lookup failed: ${error.message}`);
      return null;
    });
    cache = { offer, at: now() };
    return offer;
  };
};

const fetchText = async (url) => {
  const response = await fetchWithTimeout(url, {}, 15_000);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.text();
};

export const getBlenderOffer = createOfferReader({ fetchText });

/** Where a managed install lands: versioned, outside PortOS data, not directly in the home directory. */
const managedBlenderApp = (version, home = homedir()) => join(home, 'Applications', `Blender-${version}.app`);
const managedBlenderExecutable = (version, home) => join(managedBlenderApp(version, home), 'Contents', 'MacOS', 'Blender');

async function downloadVerified(url, destination, sha256, emit) {
  const response = await fetchWithTimeout(url, {}, DOWNLOAD_TIMEOUT_MS);
  if (!response.ok || !response.body) throw new ServerError(`Download failed: ${response.status}`, { status: 502, code: 'BLENDER_DOWNLOAD_FAILED' });
  const total = Number(response.headers.get('content-length')) || null;
  const hash = createHash('sha256');
  let received = 0;
  let lastPercent = -1;
  const meter = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk);
      received += chunk.length;
      const percent = total ? Math.floor((received / total) * 100) : null;
      if (percent !== null && percent !== lastPercent && percent % 5 === 0) {
        lastPercent = percent;
        emit('download', 'running', `Downloading Blender… ${percent}%`);
      }
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination));
  const digest = hash.digest('hex');
  if (digest !== sha256) {
    throw new ServerError('The download did not match Blender\'s published SHA-256, so it was discarded.', { status: 502, code: 'BLENDER_CHECKSUM_MISMATCH' });
  }
}

const command = (file, args) => runFile(file, args, safeChildProcessOptions({ timeout: COMMAND_TIMEOUT_MS, env: withoutServerSecretsEnv(process.env) }));

let currentJob = null;
export const getBlenderJob = () => (currentJob ? { ...currentJob } : null);

/**
 * Start a managed install of the offered Blender. Resolves once the job is accepted;
 * progress, failure and completion stream on `software:blender`.
 */
export async function startBlenderInstall({ io, acknowledgeBusy = false, deps = {} }) {
  const {
    platform = process.platform,
    readOffer = getBlenderOffer,
    assertIdle = (await import('./nodeRuntime.js')).assertIdleUnlessAcknowledged,
    execution = await import('./codeAnimation/execution.js'),
    home = homedir(),
    download = downloadVerified,
    run = command,
  } = deps;
  if (platform !== 'darwin') {
    throw new ServerError('PortOS installs Blender on macOS. Install it from blender.org, then select it in Code Animation.', { status: 409, code: 'BLENDER_INSTALL_UNSUPPORTED' });
  }
  if (currentJob) throw new ServerError('A Blender install is already running.', { status: 409, code: 'BLENDER_INSTALL_BUSY' });
  const offer = await readOffer({ fresh: true });
  if (!offer) throw new ServerError('Could not find a verified Blender release on download.blender.org.', { status: 502, code: 'BLENDER_RELEASE_UNAVAILABLE' });
  await assertIdle({ acknowledgeBusy, action: 'Switching Blender changes the renderer for new Code Animation renders' });

  const emit = (step, status, message) => io?.emit(BLENDER_PROGRESS_EVENT, { step, status, message, version: offer.version });
  currentJob = { version: offer.version, startedAt: new Date().toISOString() };
  Promise.resolve().then(async () => {
    const work = await mkdtemp(join(tmpdir(), 'portos-blender-'));
    const dmg = join(work, offer.file);
    const mount = join(work, 'mount');
    let mounted = false;
    try {
      const destination = managedBlenderApp(offer.version, home);
      const executable = managedBlenderExecutable(offer.version, home);
      // An app already at the versioned path (an earlier managed install) is reused,
      // never replaced: nothing here deletes an existing bundle.
      if (await stat(executable).catch(() => null)) {
        emit('install', 'done', `Blender ${offer.version} is already installed at ${destination}`);
      } else {
        emit('download', 'running', `Downloading Blender ${offer.version}…`);
        await download(offer.url, dmg, offer.sha256, emit);
        emit('download', 'done', 'Download verified against Blender\'s SHA-256');

        emit('install', 'running', 'Copying Blender.app…');
        await mkdir(mount);
        await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg]);
        mounted = true;
        const app = (await readdir(mount)).find((name) => /^Blender.*\.app$/.test(name));
        if (!app) throw new ServerError('The Blender disk image has no Blender.app.', { status: 502, code: 'BLENDER_IMAGE_INVALID' });
        if (await stat(destination).catch(() => null)) {
          throw new ServerError(`${destination} already exists without a Blender executable; move it aside and try again.`, { status: 409, code: 'BLENDER_DESTINATION_EXISTS' });
        }
        // Copied to a uniquely named sibling this job owns, then renamed into place in
        // one step, so the trusted path only ever holds a complete app.
        await mkdir(join(home, 'Applications'), { recursive: true });
        const partial = `${destination}.partial-${process.pid}-${Date.now()}`;
        try {
          await run('/usr/bin/ditto', [join(mount, app), partial]);
          await rename(partial, destination);
        } catch (error) {
          await rm(partial, { recursive: true, force: true }).catch(() => null);
          throw error;
        }
        emit('install', 'done', `Installed at ${destination}`);
      }

      emit('verify', 'running', 'Running the Code Animation execution check…');
      const before = (await execution.getCodeAnimationExecution()).tools.blender;
      const select = (path) => execution.setCodeAnimationExecutionTools({ blender: {
        executable: path, executionMode: before.executionMode, engine: before.engine,
      } });
      await select(executable);
      let failure = null;
      try {
        const checked = await execution.probeCodeAnimationExecution();
        if (!checked.lanes?.blender?.ready) failure = checked.lanes?.blender?.reason || 'unknown reason';
      } catch (error) {
        failure = error.message;
      }
      if (failure) {
        // Any failure after selecting puts the previous selection back (including none),
        // and re-runs the check so a previously working renderer is ready again.
        const restored = await select(before.executable || null).then(async () => {
          if (before.executable) await execution.probeCodeAnimationExecution().catch(() => null);
          return true;
        }, (error) => {
          console.error(`❌ Could not restore the previous Blender selection: ${error.message}`);
          return false;
        });
        const kept = !restored ? ' Restoring the previous selection also failed; select Blender in Code Animation.'
          : before.executable ? ' Code Animation is back on the previous Blender.' : ' Code Animation has no Blender selected again.';
        throw new ServerError(`Blender ${offer.version} is installed at ${destination} but did not pass the execution check: ${failure}.${kept}`,
          { status: 502, code: 'BLENDER_CHECK_FAILED' });
      }
      emit('complete', 'done', `Blender ${offer.version} is installed and passed the execution check.`);
      console.log(`🎬 Blender ${offer.version} installed and selected for Code Animation`);
    } catch (error) {
      console.error(`❌ Blender install failed: ${error.message}`);
      emit('error', 'error', error.message);
    } finally {
      if (mounted) await run('/usr/bin/hdiutil', ['detach', mount, '-force']).catch(() => null);
      await rm(work, { recursive: true, force: true }).catch(() => null);
      currentJob = null;
      io?.emit('software:changed', { reason: 'blender' });
    }
  });
  return { started: true, version: offer.version };
}

/** Installed Blender apps a managed or manual install left in the usual places, newest first. */
export async function findInstalledBlenderApps({ home = homedir(), readVersion, roots = ['/Applications', join(home, 'Applications')] }) {
  const found = [];
  for (const root of roots) {
    const names = await readdir(root).catch(() => []);
    for (const name of names.filter((entry) => /^Blender.*\.app$/.test(entry))) {
      const executable = join(root, name, 'Contents', 'MacOS', 'Blender');
      if (!(await stat(executable).catch(() => null))) continue;
      const version = await readVersion(executable);
      if (version) found.push({ executable, version });
    }
  }
  return found.sort((a, b) => compare(b.version, a.version));
}

export const __testing = { createOfferReader, newestPatchInListing, checksumFor, newestSeriesInIndex, managedBlenderExecutable };

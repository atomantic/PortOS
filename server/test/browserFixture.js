import { lstatSync, mkdtempSync, realpathSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import { browserCleanupDeadline, reapOwnedBrowser } from '../../scripts/lib/ownedBrowserCleanup.js';

// The capability is the retained BrowserServer's exact ChildProcess, not a
// process search or a prefix match. Playwright has no public launchServer
// userDataDir option: its generated profile lives beside our private root.
const captureProfile = (child, parentTemp) => {
  const args = child?.spawnargs ?? [];
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--user-data-dir') paths.push(args[++i]);
    else if (args[i].startsWith('--user-data-dir=')) paths.push(args[i].slice('--user-data-dir='.length));
  }
  const path = paths[0];
  if (paths.length !== 1 || !path || !isAbsolute(path) || normalize(path) !== path
    || !/^playwright_chromiumdev_profile-[\w-]+$/.test(basename(path))) return null;
  try {
    if (realpathSync(dirname(path)) !== parentTemp) return null;
    const canonical = join(parentTemp, basename(path));
    const stat = lstatSync(canonical, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) return null;
    return { path: canonical, stat };
  } catch { return null; }
};

/**
 * Test-only browser owned by this fixture, with no Vite or production graph.
 * launchServer/connect retain the supported process/kill capability; external
 * CDP adapters are deliberately ineligible. Startup plus cleanup fit the
 * existing 30s hooks. No retries: a failed launch remains a failed fixture.
 */
export async function startOwnedBrowserFixture({
  chromium, launchOptions = {}, startupMs = 20000, cleanupMs = 5000,
}) {
  if (typeof chromium.launchServer !== 'function' || typeof chromium.connect !== 'function') {
    throw new Error('Owned browser fixture requires launchServer/connect');
  }
  if (![startupMs, cleanupMs].every(ms => Number.isFinite(ms) && ms > 0)
    || startupMs + cleanupMs >= 30000) {
    throw new Error('Browser startup and cleanup budgets must fit inside the 30000ms hook');
  }
  const parentTemp = realpathSync(tmpdir());
  const temp = mkdtempSync(join(parentTemp, 'portos-owned-browser-'));
  const bounded = (work, ms, label) => browserCleanupDeadline(Promise.resolve().then(work), ms,
    () => new Error(`${label} stalled after ${ms}ms`));
  // No absolute fixture paths or raw launch errors in asynchronous diagnostics.
  const reportLate = promise => promise.catch(() => {
    console.error('❌ Owned browser fixture late cleanup failed; exit or private root removal is unconfirmed');
  });
  let server, child, browser, profile, abandoned = false;
  let removing, reaping, disconnecting, closing;
  const requireAbsent = async (path, label) => {
    const remaining = await lstat(path).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (remaining) throw new Error(`${label} still exists after removal`);
  };
  const removeRoot = () => removing ??= bounded(async () => {
    // Playwright creates its profile using the parent's os.tmpdir(), not the
    // child's env. Verify/remove only the captured directory after owned exit;
    // a swapped directory or symlink is not the resource we launched with.
    if (server) {
      if (!profile) throw new Error('Owned browser profile path is unconfirmed');
      const remaining = await lstat(profile.path).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (remaining) {
        if (!remaining.isDirectory() || remaining.isSymbolicLink() || !profile.stat
          || remaining.dev !== profile.stat.dev || remaining.ino !== profile.stat.ino) {
          throw new Error('Owned browser profile identity changed');
        }
        await rm(profile.path, { recursive: true, force: true });
      }
      await requireAbsent(profile.path, 'Owned browser profile');
    }
    await rm(temp, { recursive: true, force: true });
    await requireAbsent(temp, 'Browser private root');
  }, Math.max(1, Math.floor(cleanupMs * 0.1)), 'Browser private root removal');
  const reap = () => reaping ??= bounded(async () => {
    if (server.process() !== child) throw new Error('Owned browser process identity changed');
    await reapOwnedBrowser(server, cleanupMs);
    // A timeout or missing exit status above preserves the root as evidence.
    await removeRoot();
  }, cleanupMs, 'Owned browser cleanup');
  const disconnect = () => disconnecting ??= bounded(() => browser.close(), cleanupMs, 'Browser client disconnect');
  const launching = Promise.resolve().then(() => chromium.launchServer({
    ...launchOptions, timeout: startupMs, artifactsDir: temp,
    env: { ...process.env, ...launchOptions.env,
      TMPDIR: temp, TMP: temp, TEMP: temp, MAC_CHROMIUM_TMPDIR: temp },
  })).then(value => {
    server = value;
    child = server.process();
    profile = captureProfile(child, parentTemp);
    // Even after close's deadline rejected, the eventual capability is ours.
    if (abandoned) reportLate(reap());
    return value;
  }, error => {
    if (abandoned) reportLate(removeRoot());
    throw error;
  });
  // Cache the verdict as well as the work, including failures. A second close
  // must not signal again or turn an unconfirmed first close into success.
  const close = () => closing ??= bounded(async () => {
    await launching.catch(async () => { await removeRoot(); });
    if (server) {
      const results = await Promise.allSettled([reap(), ...(browser ? [disconnect()] : [])]);
      const failures = results.filter(result => result.status === 'rejected');
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Owned browser cleanup failed');
    }
  }, cleanupMs, 'Owned browser cleanup');
  try {
    await bounded(async () => {
      await launching;
      if (abandoned) return;
      const connected = await chromium.connect(server.wsEndpoint(), { timeout: startupMs });
      browser = connected;
      // A connection can finish after the server was already reaped. Release
      // that client independently; never delay owned termination for it.
      if (abandoned) reportLate(disconnect());
    }, startupMs, 'Owned browser startup');
    return { browser, temp, close };
  } catch (error) {
    abandoned = true;
    const cleanup = await close().then(() => 'cleaned up', () => 'cleanup unconfirmed');
    throw new Error(`Owned browser startup failed; ${cleanup}`, { cause: error });
  }
}

import { probeCdpVersion } from './cdpProbe.js';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, homedir } from 'os';
import { browserExecutablePath, deriveMacAppBundleFromChromePath } from '../server/lib/browserConfig.js';
import { isDirectlyInvoked } from '../scripts/lib/directInvocation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CONFIG_FILE = resolve(PROJECT_ROOT, 'data', 'browser-config.json');
const DEFAULT_PROFILE_DIR = resolve(PROJECT_ROOT, 'data', 'browser-profile');
const DEFAULT_DOWNLOAD_DIR = join(homedir(), 'Downloads');

const CDP_PORT = parseInt(process.env.CDP_PORT || '5556', 10);
const HEALTH_PORT = parseInt(process.env.PORT || '5557', 10);
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';

// Two misses at the initial interval ignore a one-off CDP blip. Further launch
// failures wait 2s, 4s, … capped at 60s, and a CDP answer resets that wait.
const BACKOFF_INITIAL_MS = 2000;
const BACKOFF_MAX_MS = 60_000;
const MISSES_BEFORE_RELAUNCH = 2;
const LAUNCH_POLL_MS = 500;
const LAUNCH_POLLS = 20;

const PREFS_MISSING = Symbol('prefs-missing');
const PREFS_UNREADABLE = Symbol('prefs-unreadable');

const DEFAULT_MAC_CHROME_APP = '/Applications/Google Chrome.app';

function getMacAppBundle(config, chromePath) {
  if (typeof config?.macAppBundle === 'string' && config.macAppBundle.trim()) {
    return config.macAppBundle;
  }
  const derived = deriveMacAppBundleFromChromePath(chromePath);
  if (derived) return derived;
  return DEFAULT_MAC_CHROME_APP;
}

async function loadConfig() {
  const raw = await readFile(CONFIG_FILE, 'utf-8').catch(() => null);
  if (!raw) return {};
  // Corrupt user-editable config must not put the browser child in a restart loop.
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`⚠️ Corrupt browser-config.json, using defaults: ${err.message}`);
    return {};
  }
}

const probeConfiguredCdp = () => probeCdpVersion(`http://${CDP_HOST}:${CDP_PORT}/json/version`);

// CDP Browser.setDownloadBehavior replaces Chrome's native download delegate,
// making Open/Show in Finder no-ops (verified on Chrome 151). Set the unprotected
// profile prefs instead, before Chrome starts: it overwrites them on exit.
async function applyDownloadDirPreference(profileDir, downloadDir) {
  const prefsPath = join(profileDir, 'Default', 'Preferences');
  const raw = await tryReadJson(prefsPath);
  // A profile that has never launched has no Preferences file yet; Chrome
  // merges our partial object with its defaults on first run. Do not treat a
  // corrupt or unreadable existing file as an empty profile: rewriting it
  // would discard unrelated Chrome settings. Let Chrome repair it on launch
  // while preserving the user's original bytes.
  if (raw === PREFS_UNREADABLE) return false;
  const prefs = raw === PREFS_MISSING ? {} : raw;
  if (prefs.download?.default_directory === downloadDir
    && prefs.savefile?.default_directory === downloadDir) {
    return false;
  }
  prefs.download = { ...asObject(prefs.download), default_directory: downloadDir };
  prefs.savefile = { ...asObject(prefs.savefile), default_directory: downloadDir };
  // `prompt_for_download: false` keeps downloads non-interactive, matching the
  // previous behavior of the CDP `allow` behavior.
  prefs.download.prompt_for_download = false;
  await mkdir(dirname(prefsPath), { recursive: true });
  await writeFile(prefsPath, JSON.stringify(prefs));
  return true;
}

// Arrays and `null` are typeof 'object' but are not safe spread/assign targets
// for a key-value pref branch, so both are rejected alongside primitives.
function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

async function tryReadJson(path) {
  const raw = await readFile(path, 'utf-8').catch(err => {
    if (err.code === 'ENOENT') return PREFS_MISSING;
    console.error(`⚠️ Unable to read Chrome Preferences, preserving file: ${err.message}`);
    return PREFS_UNREADABLE;
  });
  if (raw === PREFS_MISSING || raw === PREFS_UNREADABLE) return raw;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      console.error('⚠️ Chrome Preferences root is not an object, preserving file');
      return PREFS_UNREADABLE;
    }
    return value;
  } catch (err) {
    console.error(`⚠️ Corrupt Chrome Preferences, preserving file: ${err.message}`);
    return PREFS_UNREADABLE;
  }
}

/**
 * PM2 fork mode runs `node ProcessContainerFork.js`, which then imports this
 * file. `argv[1]` is that container; the script PM2 was asked to run is
 * `pm_exec_path`. Vitest's argv is not this file and does not set that
 * variable, so importing the module under test does not bind a port.
 */
export function shouldStartSupervisor(moduleUrl, env = process.env, invokedPath = process.argv[1]) {
  if (isDirectlyInvoked(moduleUrl, invokedPath)) return true;
  const pmExec = env?.pm_exec_path;
  return typeof pmExec === 'string' && pmExec.length > 0 && isDirectlyInvoked(moduleUrl, pmExec);
}

/**
 * Supervise one managed Chrome. `options.checkCdp` / `options.spawn` (and the
 * other overrides) exist so tests can run the loop without a real browser.
 * The health server is listening before the first launch, so a rejection is
 * reported at /health instead of killing the process.
 */
export function createBrowserSupervisor(options = {}) {
  const deps = {
    checkCdp: options.checkCdp || probeConfiguredCdp,
    spawn: options.spawn || spawn,
    mkdir: options.mkdir || mkdir,
    sleep: options.sleep || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); })),
    loadConfig: options.loadConfig || loadConfig,
    platform: options.platform || platform(),
    WebSocket: options.WebSocket || globalThis.WebSocket,
    applyDownloadDirPreference: options.applyDownloadDirPreference || applyDownloadDirPreference,
    exitProcess: options.exitProcess,
    healthPort: options.healthPort ?? HEALTH_PORT,
    bindSignals: options.bindSignals === true,
  };

  let chromeProcess = null;
  let headlessMode = false;
  let downloadWs = null;
  let shuttingDown = false;
  let relaunching = false;
  let attempt = 0;
  let lastError = null;
  let sawFailure = false;
  let spawnError = null;
  let consecutiveMisses = 0;
  let delayMs = BACKOFF_INITIAL_MS;
  let pendingRecoveryLog = false;
  let wakeSupervise = null;
  let shutdownPromise = null;

  function detachKeepAlive({ intentional }) {
    const ws = downloadWs;
    if (!ws) return;
    downloadWs = null;
    if (intentional) ws.intentionalClose = true;
    try { ws.close(); } catch { /* already closed */ }
  }

  // A CDP WebSocket held open for the lifetime of this process, used purely to
  // detect Chrome exiting (the 'close' event). On macOS we launch Chrome via
  // `open` and never hold its PID, so this socket is our only liveness signal.
  // It deliberately sends no commands — see applyDownloadDirPreference above for
  // why `Browser.setDownloadBehavior` must not be used here.
  async function openLivenessKeepAlive() {
    const WebSocketImpl = deps.WebSocket;
    if (typeof WebSocketImpl !== 'function') {
      console.log('⚠️ WebSocket not available — Chrome exit detection disabled (requires Node.js 21+)');
      return;
    }

    if (downloadWs) detachKeepAlive({ intentional: true });

    const version = await deps.checkCdp();
    const wsUrl = version?.webSocketDebuggerUrl;
    if (!wsUrl) {
      console.log('⚠️ CDP unreachable — cannot open keep-alive');
      return;
    }

    const ws = new WebSocketImpl(wsUrl);
    downloadWs = ws;

    ws.addEventListener('close', () => {
      if (downloadWs === ws) downloadWs = null;
      if (shuttingDown || ws.intentionalClose) return;
      console.log('⚠️ Keep-alive WS closed — will reconnect');
      // A close during the post-failure wait must not skip the backoff.
      if (!relaunching) wakeSupervise?.();
    });

    ws.addEventListener('error', (event) => {
      if (shuttingDown) return;
      const message = event?.error?.message || event?.message || event?.error?.code || 'connection lost';
      console.warn(`⚠️ Keep-alive WS reset: ${message} — will reconnect`);
    });
  }

  async function ensureKeepAlive() {
    if (downloadWs || shuttingDown) return;
    try {
      await openLivenessKeepAlive();
    } catch (err) {
      console.error(`❌ Keep-alive open failed: ${err.message}`);
    }
  }

  async function launchBrowser() {
    if (shuttingDown) return;
    const config = await deps.loadConfig();
    if (shuttingDown) return;
    const downloadDir = config.downloadDir || DEFAULT_DOWNLOAD_DIR;
    headlessMode = config.headless === true;
    spawnError = null;

    // Reuse existing Chrome if CDP is already reachable (e.g. after PM2 restart)
    if (await deps.checkCdp()) {
      if (shuttingDown) return;
      console.log(`♻️ Existing Chrome CDP found at ${CDP_HOST}:${CDP_PORT}, reusing`);
      await deps.mkdir(downloadDir, { recursive: true });
      // Chrome owns Preferences while it runs and rewrites the file from memory
      // on exit, so a running instance keeps whatever download dir it launched
      // with; the pref is applied on the next launch.
      await ensureKeepAlive();
      return;
    }

    if (shuttingDown) return;
    const profileDir = config.userDataDir || DEFAULT_PROFILE_DIR;
    const chromePath = browserExecutablePath(config);
    const macAppBundle = getMacAppBundle(config, chromePath);

    await deps.mkdir(profileDir, { recursive: true });
    if (shuttingDown) return;
    await deps.mkdir(downloadDir, { recursive: true });
    if (shuttingDown) return;

    // Chrome is not running yet, so Preferences is ours to write.
    if (await deps.applyDownloadDirPreference(profileDir, downloadDir)) {
      console.log(`📥 Download directory pref set → ${downloadDir}`);
    }
    if (shuttingDown) return;

    const args = [
      `--remote-debugging-port=${CDP_PORT}`,
      `--remote-debugging-address=${CDP_HOST}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-ipc-flooding-protection'
    ];

    if (headlessMode) args.push('--headless=new');

    console.log(`🌐 Launching Chrome (headless=${headlessMode}, profile=${profileDir}, binary=${deps.platform === 'darwin' && !headlessMode ? macAppBundle : chromePath}) CDP on ${CDP_HOST}:${CDP_PORT}`);

    // macOS headed mode: launch via LaunchServices (`open -na`) so Chrome owns
    // its own TCC identity. As a direct subprocess of node/PM2, Chrome inherits
    // PM2's responsibility for AppleEvents + LaunchServices calls — every shell
    // handoff from the download UI ("Show in Finder", "Open file", chrome://
    // downloads row click) silently no-ops because PM2 isn't granted Automation
    // / Files-and-Folders access. `open -na` makes launchd the responsible
    // launcher, so tccd resolves Chrome's requests against the user's existing
    // Chrome.app grants. Trade-off: `open` returns immediately, so we lose the
    // direct PID — shutdown uses CDP `Browser.close` instead of SIGTERM.
    // Headless mode skips this (no UI to click) and non-darwin platforms don't
    // have the TCC-responsibility problem at all.
    let child;
    if (deps.platform === 'darwin' && !headlessMode) {
      // `open` has usually already exited, so there is no Chrome PID to signal.
      // When CDP still answers, close that instance before `open -na` starts
      // another. A hung Chrome that no longer answers CDP cannot be reaped
      // from here; the next attempt is the recovery.
      await closeBrowserViaCdp().catch(() => {});
      if (chromeProcess && !chromeProcess.killed) return;
      // windowsHide is a no-op on POSIX and this branch is darwin-only, but every
      // spawn in this package carries it: portos-browser is a PM2 fork, so the
      // guard holds the whole tree to one rule rather than reasoning about which
      // branch runs where. See docs/WINDOWS_CONSOLE.md.
      child = deps.spawn('/usr/bin/open', ['-na', macAppBundle, '--args', ...args], { stdio: 'ignore', windowsHide: true });
      child.on('exit', () => {
        // `open` returns ~immediately once Chrome is handed off to launchd; that
        // exit is not Chrome's death. Chrome-exit detection happens via the
        // liveness keep-alive WS close event instead.
        if (chromeProcess === child) chromeProcess = null;
      });
      // A bad macAppBundle (user-editable via the Browser settings UI) emits
      // 'error'; with no listener that becomes an uncaughtException → PM2
      // restart-loop. Log and null out so the supervise loop relaunches.
      child.on('error', (err) => {
        spawnError = err.message;
        console.error(`❌ Failed to spawn Chrome via open: ${err.message}`);
        if (chromeProcess === child) chromeProcess = null;
      });
    } else {
      // A launch that never reached CDP, or a hung Chrome, is still our child.
      // Spawn the replacement only after signaling that one, or shutdown can
      // reap only the newest PID and the profile stays locked.
      if (chromeProcess && !chromeProcess.killed) {
        try { chromeProcess.kill('SIGTERM'); } catch { /* already gone */ }
        chromeProcess = null;
      }
      child = deps.spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });
      child.on('exit', (code) => {
        console.log(`⚠️ Chrome exited with code ${code}`);
        if (chromeProcess === child) chromeProcess = null;
        detachKeepAlive({ intentional: false });
      });
      // A bad chromePath (user-editable via the Browser settings UI) emits
      // 'error'; with no listener that becomes an uncaughtException → PM2
      // restart-loop. Log and null out so the supervise loop relaunches.
      child.on('error', (err) => {
        spawnError = err.message;
        console.error(`❌ Failed to spawn Chrome (${chromePath}): ${err.message}`);
        if (chromeProcess === child) chromeProcess = null;
        detachKeepAlive({ intentional: false });
      });
    }
    chromeProcess = child;

    // Listeners are on before the first wait: a failed spawn emits 'error'
    // on next tick, and an unhandled error would take the process down.
    for (let i = 0; i < LAUNCH_POLLS; i++) {
      if (shuttingDown) return;
      await deps.sleep(LAUNCH_POLL_MS);
      if (shuttingDown) return;
      if (await deps.checkCdp()) {
        console.log(`✅ Chrome launched, CDP available at ws://${CDP_HOST}:${CDP_PORT}`);
        await ensureKeepAlive();
        return;
      }
    }

    console.error('❌ Chrome launched but CDP not reachable after 10s');
  }

  function noteRecovered() {
    if (sawFailure || pendingRecoveryLog) console.log('✅ Chrome CDP recovered');
    pendingRecoveryLog = false;
    sawFailure = false;
    lastError = null;
    relaunching = false;
    attempt = 0;
    consecutiveMisses = 0;
    delayMs = BACKOFF_INITIAL_MS;
    spawnError = null;
  }

  function takeFailureWait() {
    const wait = delayMs;
    delayMs = Math.min(delayMs * 2, BACKOFF_MAX_MS);
    return wait;
  }

  async function probeUp() {
    try {
      return Boolean(await deps.checkCdp());
    } catch (err) {
      lastError = err.message;
      console.error(`❌ CDP check failed: ${err.message}`);
      return false;
    }
  }

  async function attemptLaunch({ relaunch }) {
    if (shuttingDown) return false;
    relaunching = true;
    attempt += 1;
    if (relaunch) {
      pendingRecoveryLog = true;
      console.log(`🔁 Relaunching Chrome (attempt ${attempt})`);
    }
    try {
      await launchBrowser();
    } catch (err) {
      sawFailure = true;
      lastError = err.message;
      console.error(`❌ Chrome launch failed: ${err.message}`);
      return false;
    }
    if (shuttingDown) return false;
    if (await probeUp()) {
      noteRecovered();
      return true;
    }
    sawFailure = true;
    lastError = spawnError || 'Chrome launched but CDP not reachable after 10s';
    return false;
  }

  function superviseDelay(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (wakeSupervise === finish) wakeSupervise = null;
        resolve();
      };
      wakeSupervise = finish;
      Promise.resolve()
        .then(() => deps.sleep(ms))
        .then(finish, (err) => {
          lastError = err?.message || 'sleep failed';
          sawFailure = true;
          relaunching = true;
          console.error(`❌ Browser supervise wait failed: ${lastError}`);
          finish();
        });
    });
  }

  // Replaces the old reconnect-only poll: Chrome exiting (or a launch throw)
  // stays inside this loop until CDP answers or the process is stopped.
  async function superviseLoop() {
    relaunching = true;
    let booting = true;
    while (!shuttingDown) {
      let wait = delayMs;
      try {
        if (booting) {
          booting = false;
          const ok = await attemptLaunch({ relaunch: false });
          if (shuttingDown) break;
          wait = ok ? delayMs : takeFailureWait();
        } else {
          const up = await probeUp();
          if (shuttingDown) break;
          if (up) {
            noteRecovered();
            await ensureKeepAlive();
            wait = delayMs;
          } else {
            detachKeepAlive({ intentional: true });
            consecutiveMisses += 1;
            if (relaunching || consecutiveMisses >= MISSES_BEFORE_RELAUNCH) {
              const ok = await attemptLaunch({ relaunch: true });
              if (shuttingDown) break;
              wait = ok ? delayMs : takeFailureWait();
            } else {
              wait = delayMs;
            }
          }
        }
      } catch (err) {
        sawFailure = true;
        relaunching = true;
        lastError = err.message;
        console.error(`❌ Browser supervise loop error: ${err.message}`);
        wait = takeFailureWait();
      }
      if (shuttingDown) break;
      await superviseDelay(wait);
    }
  }

  async function healthBody() {
    let connected = false;
    try {
      connected = Boolean(await deps.checkCdp());
    } catch {
      connected = false;
    }
    const status = connected ? 'healthy' : (relaunching ? 'relaunching' : 'unhealthy');
    return {
      httpStatus: connected ? 200 : 503,
      body: {
        status,
        attempt: status === 'relaunching' ? attempt : 0,
        lastError: status === 'relaunching' ? lastError : null,
        cdpPort: CDP_PORT,
        cdpHost: CDP_HOST,
        cdpEndpoint: `ws://${CDP_HOST}:${CDP_PORT}`,
        headless: headlessMode,
      },
    };
  }

  const healthServer = createServer(async (req, res) => {
    try {
      if (req.url === '/health') {
        const { httpStatus, body } = await healthBody();
        res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      } else if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          service: 'portos-browser',
          cdpPort: CDP_PORT,
          cdpHost: CDP_HOST,
          healthPort: healthServer.address()?.port ?? deps.healthPort,
          endpoints: {
            health: '/health',
            cdp: `ws://${CDP_HOST}:${CDP_PORT}`,
          },
        }));
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    } catch (err) {
      console.error(`❌ Browser health request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'unhealthy', lastError: err.message }));
    }
  });

  async function closeBrowserViaCdp() {
    const WebSocketImpl = deps.WebSocket;
    if (typeof WebSocketImpl !== 'function') return;
    const version = await deps.checkCdp();
    const wsUrl = version?.webSocketDebuggerUrl;
    if (!wsUrl) return;
    await new Promise((resolveClose) => {
      const ws = new WebSocketImpl(wsUrl);
      const done = () => { try { ws.close(); } catch { /* already closed */ } resolveClose(); };
      const safety = setTimeout(done, 2000);
      ws.addEventListener('open', () => {
        try { ws.send(JSON.stringify({ id: 999, method: 'Browser.close' })); } catch { /* socket already gone */ }
        // Give Chrome a moment to tear down before we exit the supervisor
        setTimeout(() => { clearTimeout(safety); done(); }, 500);
      });
      ws.addEventListener('error', () => { clearTimeout(safety); done(); });
    });
  }

  function onSignal() {
    shutdown().catch((err) => {
      console.error(`❌ Browser shutdown failed: ${err.message}`);
    });
  }

  if (deps.bindSignals) {
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
  }

  async function doShutdown() {
    shuttingDown = true;
    if (deps.bindSignals) {
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
    }
    wakeSupervise?.();
    console.log('🛑 Shutting down browser...');
    // macOS headed mode: we launched via `open` which exited immediately, so
    // SIGTERM on `chromeProcess` is a no-op. Send CDP Browser.close instead.
    if (deps.platform === 'darwin' && !headlessMode) {
      await closeBrowserViaCdp().catch(() => {});
    } else if (chromeProcess && !chromeProcess.killed) {
      chromeProcess.kill('SIGTERM');
    }
    detachKeepAlive({ intentional: true });
    healthServer.closeAllConnections?.();
    await new Promise((resolveClose) => {
      if (!healthServer.listening) return resolveClose();
      healthServer.close(() => resolveClose());
    });
    if (deps.exitProcess) deps.exitProcess(0);
  }

  function shutdown() {
    if (!shutdownPromise) shutdownPromise = doShutdown();
    return shutdownPromise;
  }

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  async function listenHealth() {
    await new Promise((resolve, reject) => {
      let listening = false;
      healthServer.on('error', (err) => {
        if (!listening) {
          listening = true;
          reject(err);
          return;
        }
        console.error(`❌ Browser health server error: ${err.message}`);
      });
      healthServer.once('listening', () => {
        listening = true;
        resolve();
      });
      healthServer.listen(deps.healthPort, '127.0.0.1');
    });
    const address = healthServer.address();
    console.log(`📡 Health check server listening on port ${address?.port ?? deps.healthPort}`);
  }

  async function main() {
    try {
      await listenHealth();
      resolveReady();
    } catch (err) {
      rejectReady(err);
      throw err;
    }
    await superviseLoop();
  }

  return { main, shutdown, ready, healthServer };
}

if (shouldStartSupervisor(import.meta.url)) {
  const supervisor = createBrowserSupervisor({
    exitProcess: (code) => process.exit(code),
    bindSignals: true,
  });
  // listenHealth is the only rejection main() lets out. The supervise loop
  // retries launch failures itself. A taken health port has no loop to retry
  // inside, and PM2's IPC channel would keep the caught error alive as a
  // silent online process. Exit non-zero so PM2 restarts.
  supervisor.main().catch((err) => {
    console.error(`❌ Browser supervisor failed: ${err.message}`);
    process.exit(1);
  });
}

import { spawn } from 'child_process';
import { createServer } from 'http';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, homedir } from 'os';
import { deriveMacAppBundleFromChromePath } from '../server/lib/browserConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CONFIG_FILE = resolve(PROJECT_ROOT, 'data', 'browser-config.json');
const DEFAULT_PROFILE_DIR = resolve(PROJECT_ROOT, 'data', 'browser-profile');
const DEFAULT_DOWNLOAD_DIR = join(homedir(), 'Downloads');

const CDP_PORT = parseInt(process.env.CDP_PORT || '5556', 10);
const HEALTH_PORT = parseInt(process.env.PORT || '5557', 10);
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';

let chromeProcess = null;
// Default headed — PortOS runs on a single user's dev machine where seeing
// the browser window matters (auto-opening the UI on setup/update, debugging
// CDP automation visually). Set `headless: true` in data/browser-config.json
// to opt back in for headless workflows.
let headlessMode = false;
let downloadWs = null;
let downloadWsReconnectTimer = null;
let shuttingDown = false;

const DEFAULT_MAC_CHROME_APP = '/Applications/Google Chrome.app';

function defaultChromeBinary() {
  const os = platform();
  if (os === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (os === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return 'google-chrome';
}

function getChromePath(config) {
  if (typeof config?.chromePath === 'string' && config.chromePath.trim()) {
    return config.chromePath;
  }
  return defaultChromeBinary();
}

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
  // Guard against a partially-written / corrupt config (now user-editable via
  // the Browser settings UI). An unguarded JSON.parse here throws on boot —
  // loadConfig is awaited from launchBrowser()→main() with no catch, so a bad
  // file would crash the PM2 child into a restart-loop. Fall back to defaults.
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`⚠️ Corrupt browser-config.json, using defaults: ${err.message}`);
    return {};
  }
}

async function checkCdp() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, { signal: controller.signal }).catch(() => null);
  clearTimeout(timeout);
  if (!res?.ok) return null;
  // A 200 here doesn't guarantee it's Chrome's CDP endpoint — something else
  // (a stray dev server, a captive portal, a Chrome HTML error page) can answer
  // on this port with `<!DOCTYPE html>…`. `res.json()` would then reject with
  // "Unexpected token '<'", and that rejection escapes through every caller —
  // most visibly spamming scheduleDownloadReconnect()'s catch every 2s. Treat
  // any non-JSON or non-CDP body as "not reachable" by returning null.
  const version = await res.json().catch(() => null);
  if (!version?.webSocketDebuggerUrl) return null;
  return version;
}

// Chrome's download directory is set through the profile's own `Preferences`
// file, NOT through CDP's `Browser.setDownloadBehavior`.
//
// `Browser.setDownloadBehavior` looks like the obvious lever, but setting it
// swaps Chrome's `ChromeDownloadManagerDelegate` for the automation-only
// `DevToolsDownloadManagerDelegate`. That delegate routes the bytes to the
// requested path — downloads land correctly and the download UI lists them —
// but it leaves `OpenDownload()` / `ShowDownloadInShell()` as no-ops. The
// result: every shell handoff from the download UI ("Show in Finder", "Open
// file", clicking a row in chrome://downloads or the download bubble) silently
// does nothing, with no error anywhere. Verified against Chrome 151 by
// A/B-ing two otherwise identical browsers: without the CDP call the reveal
// selects the file in Finder, with it nothing happens at the OS level.
//
// Writing `download.default_directory` into the profile keeps the native
// delegate, so downloads land in the configured directory AND the UI stays
// clickable. The pref is not one of Chrome's MAC-protected prefs, so writing
// it directly is safe. It must be written while Chrome is NOT running —
// Chrome rewrites Preferences from memory on exit.
async function applyDownloadDirPreference(profileDir, downloadDir) {
  const prefsPath = join(profileDir, 'Default', 'Preferences');
  const raw = await tryReadJson(prefsPath);
  // A profile that has never launched has no Preferences file yet; Chrome
  // merges our partial object with its defaults on first run.
  const prefs = raw || {};
  if (prefs.download?.default_directory === downloadDir
    && prefs.savefile?.default_directory === downloadDir) {
    return false;
  }
  prefs.download = { ...prefs.download, default_directory: downloadDir };
  prefs.savefile = { ...prefs.savefile, default_directory: downloadDir };
  // `prompt_for_download: false` keeps downloads non-interactive, matching the
  // previous behavior of the CDP `allow` behavior.
  prefs.download.prompt_for_download = false;
  await mkdir(dirname(prefsPath), { recursive: true });
  await writeFile(prefsPath, JSON.stringify(prefs));
  return true;
}

async function tryReadJson(path) {
  const raw = await readFile(path, 'utf-8').catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`⚠️ Corrupt Chrome Preferences, rewriting: ${err.message}`);
    return null;
  }
}

// A CDP WebSocket held open for the lifetime of this process, used purely to
// detect Chrome exiting (the 'close' event). On macOS we launch Chrome via
// `open` and never hold its PID, so this socket is our only liveness signal.
// It deliberately sends no commands — see applyDownloadDirPreference above for
// why `Browser.setDownloadBehavior` must not be used here.
async function openLivenessKeepAlive() {
  // WebSocket is a global in Node.js 21+ (project targets Node 22+)
  if (typeof WebSocket === 'undefined') {
    console.log('⚠️ WebSocket not available — Chrome exit detection disabled (requires Node.js 21+)');
    return;
  }

  // Tear down any existing keep-alive before opening a new one
  if (downloadWs) {
    try { downloadWs.close(); } catch {}
    downloadWs = null;
  }
  if (downloadWsReconnectTimer) {
    clearTimeout(downloadWsReconnectTimer);
    downloadWsReconnectTimer = null;
  }

  const version = await checkCdp();
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl) {
    console.log('⚠️ CDP unreachable — cannot open keep-alive');
    scheduleDownloadReconnect();
    return;
  }

  const ws = new WebSocket(wsUrl);
  downloadWs = ws;

  ws.addEventListener('close', () => {
    if (downloadWs === ws) downloadWs = null;
    if (shuttingDown) return;
    console.log('⚠️ Keep-alive WS closed — will reconnect');
    scheduleDownloadReconnect();
  });

  ws.addEventListener('error', (event) => {
    console.error(`❌ Keep-alive WS error: ${event?.message || 'unknown'}`);
  });
}

function scheduleDownloadReconnect() {
  if (shuttingDown || downloadWsReconnectTimer) return;
  downloadWsReconnectTimer = setTimeout(async () => {
    downloadWsReconnectTimer = null;
    if (shuttingDown) return;
    // Contain any rejection from checkCdp/openLivenessKeepAlive so an
    // async setTimeout callback can't escape as an unhandledRejection.
    try {
      if (await checkCdp()) {
        await openLivenessKeepAlive();
      } else {
        scheduleDownloadReconnect();
      }
    } catch (err) {
      console.error(`⚠️ Keep-alive reconnect failed: ${err.message}`);
      scheduleDownloadReconnect();
    }
  }, 2000);
}

async function launchBrowser() {
  const config = await loadConfig();
  const downloadDir = config.downloadDir || DEFAULT_DOWNLOAD_DIR;
  headlessMode = config.headless === true;

  // Reuse existing Chrome if CDP is already reachable (e.g. after PM2 restart)
  if (await checkCdp()) {
    console.log(`♻️ Existing Chrome CDP found at ${CDP_HOST}:${CDP_PORT}, reusing`);
    await mkdir(downloadDir, { recursive: true });
    // Chrome owns Preferences while it runs and rewrites the file from memory
    // on exit, so a running instance keeps whatever download dir it launched
    // with; the pref is applied on the next launch.
    await openLivenessKeepAlive();
    return;
  }

  const profileDir = config.userDataDir || DEFAULT_PROFILE_DIR;
  const chromePath = getChromePath(config);
  const macAppBundle = getMacAppBundle(config, chromePath);

  await mkdir(profileDir, { recursive: true });
  await mkdir(downloadDir, { recursive: true });

  // Chrome is not running yet, so Preferences is ours to write.
  if (await applyDownloadDirPreference(profileDir, downloadDir)) {
    console.log(`📥 Download directory pref set → ${downloadDir}`);
  }

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

  if (headlessMode) {
    args.push('--headless=new');
  }

  console.log(`🌐 Launching Chrome (headless=${headlessMode}, profile=${profileDir}, binary=${platform() === 'darwin' && !headlessMode ? macAppBundle : chromePath}) CDP on ${CDP_HOST}:${CDP_PORT}`);

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
  if (platform() === 'darwin' && !headlessMode) {
    // windowsHide is a no-op on POSIX and this branch is darwin-only, but every
    // spawn in this package carries it: portos-browser is a PM2 fork, so the
    // guard holds the whole tree to one rule rather than reasoning about which
    // branch runs where. See docs/WINDOWS_CONSOLE.md.
    chromeProcess = spawn('/usr/bin/open', ['-na', macAppBundle, '--args', ...args], { stdio: 'ignore', windowsHide: true });
    chromeProcess.on('exit', () => {
      // `open` returns ~immediately once Chrome is handed off to launchd; that
      // exit is not Chrome's death. Chrome-exit detection happens via the
      // download keep-alive WS close event + reconnect loop instead.
      chromeProcess = null;
    });
    // A bad macAppBundle (user-editable via the Browser settings UI) emits
    // 'error'; with no listener that becomes an uncaughtException → PM2
    // restart-loop. Log and null out so the CDP-wait loop reports unreachable.
    chromeProcess.on('error', (err) => {
      console.error(`❌ Failed to spawn Chrome via open: ${err.message}`);
      chromeProcess = null;
    });
  } else {
    chromeProcess = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });
    chromeProcess.on('exit', (code) => {
      console.log(`⚠️ Chrome exited with code ${code}`);
      chromeProcess = null;
      if (downloadWs) {
        try { downloadWs.close(); } catch {}
        downloadWs = null;
      }
    });
    // A bad chromePath (user-editable via the Browser settings UI) emits
    // 'error'; with no listener that becomes an uncaughtException → PM2
    // restart-loop. Log and null out so the CDP-wait loop reports unreachable.
    chromeProcess.on('error', (err) => {
      console.error(`❌ Failed to spawn Chrome (${chromePath}): ${err.message}`);
      chromeProcess = null;
      if (downloadWs) {
        try { downloadWs.close(); } catch {}
        downloadWs = null;
      }
    });
  }

  // Wait for CDP to become available
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkCdp()) {
      console.log(`✅ Chrome launched, CDP available at ws://${CDP_HOST}:${CDP_PORT}`);
      await openLivenessKeepAlive();
      return;
    }
  }

  console.error('❌ Chrome launched but CDP not reachable after 10s');
}

// Health check server
const healthServer = createServer(async (req, res) => {
  if (req.url === '/health') {
    const connected = await checkCdp();
    const status = connected ? 'healthy' : 'unhealthy';
    res.writeHead(connected ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status,
      cdpPort: CDP_PORT,
      cdpHost: CDP_HOST,
      cdpEndpoint: `ws://${CDP_HOST}:${CDP_PORT}`,
      headless: headlessMode
    }));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'portos-browser',
      cdpPort: CDP_PORT,
      cdpHost: CDP_HOST,
      healthPort: HEALTH_PORT,
      endpoints: {
        health: '/health',
        cdp: `ws://${CDP_HOST}:${CDP_PORT}`
      }
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

async function closeBrowserViaCdp() {
  if (typeof WebSocket === 'undefined') return;
  const version = await checkCdp();
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl) return;
  await new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const done = () => { try { ws.close(); } catch {} resolve(); };
    const safety = setTimeout(done, 2000);
    ws.addEventListener('open', () => {
      try { ws.send(JSON.stringify({ id: 999, method: 'Browser.close' })); } catch {}
      // Give Chrome a moment to tear down before we exit the supervisor
      setTimeout(() => { clearTimeout(safety); done(); }, 500);
    });
    ws.addEventListener('error', () => { clearTimeout(safety); done(); });
  });
}

async function shutdown() {
  console.log('🛑 Shutting down browser...');
  shuttingDown = true;
  if (downloadWsReconnectTimer) {
    clearTimeout(downloadWsReconnectTimer);
    downloadWsReconnectTimer = null;
  }
  // macOS headed mode: we launched via `open` which exited immediately, so
  // SIGTERM on `chromeProcess` is a no-op. Send CDP Browser.close instead.
  if (platform() === 'darwin' && !headlessMode) {
    await closeBrowserViaCdp().catch(() => {});
  } else if (chromeProcess && !chromeProcess.killed) {
    chromeProcess.kill('SIGTERM');
  }
  if (downloadWs) {
    try { downloadWs.close(); } catch {}
    downloadWs = null;
  }
  healthServer.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function main() {
  await launchBrowser();

  healthServer.listen(HEALTH_PORT, '0.0.0.0', () => {
    console.log(`📡 Health check server listening on port ${HEALTH_PORT}`);
  });
}

main();

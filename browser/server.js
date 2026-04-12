import { spawn } from 'child_process';
import { createServer } from 'http';
import { readFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CONFIG_FILE = resolve(PROJECT_ROOT, 'data', 'browser-config.json');
const DEFAULT_PROFILE_DIR = resolve(PROJECT_ROOT, 'data', 'browser-profile');
const DEFAULT_DOWNLOAD_DIR = resolve(PROJECT_ROOT, 'data', 'browser-downloads');

const CDP_PORT = parseInt(process.env.CDP_PORT || '5556', 10);
const HEALTH_PORT = parseInt(process.env.PORT || '5557', 10);
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';

let chromeProcess = null;
let headlessMode = true;
let downloadWs = null;
let downloadWsReconnectTimer = null;
let downloadDirCurrent = null;
let shuttingDown = false;

function getChromePath() {
  const os = platform();
  if (os === 'darwin') return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (os === 'win32') return 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  return 'google-chrome';
}

async function loadConfig() {
  const raw = await readFile(CONFIG_FILE, 'utf-8').catch(() => null);
  return raw ? JSON.parse(raw) : {};
}

async function checkCdp() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`, { signal: controller.signal }).catch(() => null);
  clearTimeout(timeout);
  if (!res?.ok) return null;
  return res.json();
}

// Chrome's `Browser.setDownloadBehavior` is DevTools-session-scoped — when the
// WebSocket that issued the command closes, Chrome tears down the BrowserHandler
// and the setting reverts to default (`~/Downloads`). We must keep a live CDP
// connection open for the lifetime of this process so downloads keep landing in
// our managed directory.
async function configureDownloadBehavior(downloadDir) {
  downloadDirCurrent = downloadDir;

  // WebSocket is a global in Node.js 21+ (project targets Node 22+)
  if (typeof WebSocket === 'undefined') {
    console.log('⚠️ WebSocket not available — download configuration skipped (requires Node.js 21+)');
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
    console.log('⚠️ CDP unreachable — cannot configure download behavior');
    scheduleDownloadReconnect();
    return;
  }

  const ws = new WebSocket(wsUrl);
  downloadWs = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'allow', downloadPath: downloadDir }
    }));
  });

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id === 1) {
      if (msg.error) {
        console.error(`❌ Browser.setDownloadBehavior failed: ${msg.error.message || JSON.stringify(msg.error)}`);
      } else {
        console.log(`📥 Downloads configured → ${downloadDir} (keep-alive WS open)`);
      }
    }
  });

  ws.addEventListener('close', () => {
    if (downloadWs === ws) downloadWs = null;
    if (shuttingDown) return;
    console.log('⚠️ Download keep-alive WS closed — will reconnect');
    scheduleDownloadReconnect();
  });

  ws.addEventListener('error', (event) => {
    console.error(`❌ Download keep-alive WS error: ${event?.message || 'unknown'}`);
  });
}

function scheduleDownloadReconnect() {
  if (shuttingDown || downloadWsReconnectTimer) return;
  downloadWsReconnectTimer = setTimeout(async () => {
    downloadWsReconnectTimer = null;
    if (shuttingDown || !downloadDirCurrent) return;
    if (await checkCdp()) {
      await configureDownloadBehavior(downloadDirCurrent);
    } else {
      scheduleDownloadReconnect();
    }
  }, 2000);
}

async function launchBrowser() {
  const config = await loadConfig();
  const downloadDir = config.downloadDir || DEFAULT_DOWNLOAD_DIR;

  // Reuse existing Chrome if CDP is already reachable (e.g. after PM2 restart)
  if (await checkCdp()) {
    console.log(`♻️ Existing Chrome CDP found at ${CDP_HOST}:${CDP_PORT}, reusing`);
    await mkdir(downloadDir, { recursive: true });
    await configureDownloadBehavior(downloadDir);
    return;
  }

  headlessMode = config.headless !== false;
  const profileDir = config.userDataDir || DEFAULT_PROFILE_DIR;
  const chromePath = getChromePath();

  await mkdir(profileDir, { recursive: true });
  await mkdir(downloadDir, { recursive: true });

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

  console.log(`🌐 Launching Chrome (headless=${headlessMode}, profile=${profileDir}) CDP on ${CDP_HOST}:${CDP_PORT}`);

  chromeProcess = spawn(chromePath, args, { stdio: 'ignore', windowsHide: true });

  chromeProcess.on('exit', (code) => {
    console.log(`⚠️ Chrome exited with code ${code}`);
    chromeProcess = null;
    if (downloadWs) {
      try { downloadWs.close(); } catch {}
      downloadWs = null;
    }
  });

  // Wait for CDP to become available
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkCdp()) {
      console.log(`✅ Chrome launched, CDP available at ws://${CDP_HOST}:${CDP_PORT}`);
      await configureDownloadBehavior(downloadDir);
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

function shutdown() {
  console.log('🛑 Shutting down browser...');
  shuttingDown = true;
  if (downloadWsReconnectTimer) {
    clearTimeout(downloadWsReconnectTimer);
    downloadWsReconnectTimer = null;
  }
  if (downloadWs) {
    try { downloadWs.close(); } catch {}
    downloadWs = null;
  }
  if (chromeProcess && !chromeProcess.killed) {
    chromeProcess.kill('SIGTERM');
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

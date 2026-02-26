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

const CDP_PORT = parseInt(process.env.CDP_PORT || '5556', 10);
const HEALTH_PORT = parseInt(process.env.PORT || '5557', 10);
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';

let chromeProcess = null;
let headlessMode = true;

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
  return res?.ok ?? false;
}

async function launchBrowser() {
  // Reuse existing Chrome if CDP is already reachable (e.g. after PM2 restart)
  if (await checkCdp()) {
    console.log(`♻️ Existing Chrome CDP found at ${CDP_HOST}:${CDP_PORT}, reusing`);
    return;
  }

  const config = await loadConfig();
  headlessMode = config.headless !== false;
  const profileDir = config.userDataDir || DEFAULT_PROFILE_DIR;
  const chromePath = getChromePath();

  await mkdir(profileDir, { recursive: true });

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
  });

  // Wait for CDP to become available
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await checkCdp()) {
      console.log(`✅ Chrome launched, CDP available at ws://${CDP_HOST}:${CDP_PORT}`);
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

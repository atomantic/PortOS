import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile, mkdir } from 'fs/promises';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');
const CONFIG_FILE = resolve(PROJECT_ROOT, 'data', 'browser-config.json');
const DEFAULT_PROFILE_DIR = resolve(PROJECT_ROOT, 'data', 'browser-profile');

const CDP_PORT = parseInt(process.env.CDP_PORT || '5556', 10);
const HEALTH_PORT = parseInt(process.env.PORT || '5557', 10);
// Security: CDP binds to localhost only - remote access should go through
// portos-server which can proxy connections with proper authentication
const CDP_HOST = process.env.CDP_HOST || '127.0.0.1';

let context = null;
let headlessMode = true;

async function loadConfig() {
  const raw = await readFile(CONFIG_FILE, 'utf-8').catch(() => null);
  return raw ? JSON.parse(raw) : {};
}

function isConnected() {
  return context?.browser()?.isConnected() ?? false;
}

async function launchBrowser() {
  const config = await loadConfig();
  headlessMode = config.headless !== false;
  const profileDir = config.userDataDir || DEFAULT_PROFILE_DIR;

  await mkdir(profileDir, { recursive: true });

  console.log(`🌐 Launching browser (headless=${headlessMode}, profile=${profileDir}) CDP on ${CDP_HOST}:${CDP_PORT}`);

  context = await chromium.launchPersistentContext(profileDir, {
    headless: headlessMode,
    args: [
      `--remote-debugging-port=${CDP_PORT}`,
      `--remote-debugging-address=${CDP_HOST}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-translate',
      '--disable-extensions',
      '--disable-infobars',
      '--disable-notifications'
    ]
  });

  context.browser()?.on('disconnected', () => {
    console.log('⚠️ Browser disconnected, restarting...');
    context = null;
    setTimeout(launchBrowser, 1000);
  });

  console.log(`✅ Browser launched, CDP available at ws://${CDP_HOST}:${CDP_PORT}`);
}

// Simple health check server
const healthServer = createServer((req, res) => {
  if (req.url === '/health') {
    const connected = isConnected();
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

async function shutdown() {
  console.log('🛑 Shutting down browser...');
  if (context) {
    await context.close().catch(() => {});
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

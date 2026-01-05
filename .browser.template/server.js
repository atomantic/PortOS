import { chromium } from 'playwright';
import { createServer } from 'http';

const CDP_PORT = parseInt(process.env.CDP_PORT || '5556', 10);
const HEALTH_PORT = parseInt(process.env.PORT || '5557', 10);

let browser = null;

async function launchBrowser() {
  console.log(`🌐 Launching persistent Chromium browser with CDP on port ${CDP_PORT}`);

  browser = await chromium.launch({
    headless: true,
    args: [
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-debugging-address=0.0.0.0',
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

  browser.on('disconnected', () => {
    console.log('⚠️ Browser disconnected, restarting...');
    setTimeout(launchBrowser, 1000);
  });

  console.log(`✅ Browser launched, CDP available at ws://0.0.0.0:${CDP_PORT}`);
  return browser;
}

// Simple health check server
const healthServer = createServer((req, res) => {
  if (req.url === '/health') {
    const status = browser && browser.isConnected() ? 'healthy' : 'unhealthy';
    res.writeHead(browser && browser.isConnected() ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status,
      cdpPort: CDP_PORT,
      cdpEndpoint: `ws://0.0.0.0:${CDP_PORT}`
    }));
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'portos-browser',
      cdpPort: CDP_PORT,
      healthPort: HEALTH_PORT,
      endpoints: {
        health: '/health',
        cdp: `ws://0.0.0.0:${CDP_PORT}`
      }
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

async function shutdown() {
  console.log('🛑 Shutting down browser...');
  if (browser) {
    await browser.close();
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

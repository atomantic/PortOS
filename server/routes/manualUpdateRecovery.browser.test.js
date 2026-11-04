import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Server } from 'socket.io';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun, resolveTestChrome } from '../lib/browserSuiteGate.js';
import { reapOwnedBrowser } from '../../scripts/lib/ownedBrowserCleanup.js';
import { sandboxedChromiumOptions } from '../../scripts/lib/playwrightSandbox.js';

const chrome = resolveTestChrome();
const canRun = browserSuiteCanRun('Legacy manual update confirmation', { chrome });
const html = readFileSync(new URL('../../scripts/manual-update-recovery.html', import.meta.url), 'utf8');
const attempt = '00000000-0000-4000-8000-000000000001';
const workspace = 'C:\\Workspaces\\PortOS checkout';

describe.skipIf(!canRun)('manual confirmation over the older static and command transports', () => {
  let http, io, browserServer, browser, origin, page, context;
  let calls, outcome;
  beforeAll(async () => {
    const app = express(); app.use(express.json());
    app.get('/manual-update.html', (_req, res) => res.type('html').send(html));
    app.use('/api', (req, res, next) => req.headers.cookie === 'operator=fixture' ? next() : res.status(401).json({ error: 'Sign in' }));
    app.get('/api/apps/portos-default', (_req, res) => res.json({ repoPath: workspace }));
    http = createServer(app); io = new Server(http);
    io.use((socket, next) => next(socket.handshake.headers.cookie === 'operator=fixture' ? undefined : new Error('Sign in')));
    io.on('connection', socket => socket.on('command:subscribe', () => { socket.join('commands'); socket.emit('command:subscribed'); }));
    app.post('/api/commands/execute', (req, res) => {
      calls.push(req.body);
      const commandId = `fixture-command-${calls.length}`;
      // The real old endpoint returns a spawn acknowledgment, while command
      // output can race ahead of that HTTP response. Pin that public contract.
      if (outcome === 'refused') {
        io.to('commands').emit(`command:${commandId}:data`, { data: 'Installer already running; no update started.\n' });
        io.to('commands').emit(`command:${commandId}:complete`, { success: false });
      }
      setTimeout(() => res.status(202).json({ commandId, status: 'started' }), 30);
    });
    await new Promise((resolve, reject) => { http.once('error', reject); http.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${http.address().port}`;
    browserServer = await chromium.launchServer(sandboxedChromiumOptions({ executablePath: chrome, headless: true, timeout: 20000 }));
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5000 });
  }, 30000);
  beforeEach(async () => {
    calls = []; outcome = 'pending';
    context = await browser.newContext(); page = await context.newPage();
  });
  afterEach(async () => { await context?.close(); });
  afterAll(async () => {
    try { if (browserServer) await reapOwnedBrowser(browserServer, 5000, { requireProfileRemoval: true }); }
    finally {
      if (io) await new Promise(resolve => io.close(resolve));
      else if (http) await new Promise(resolve => http.close(resolve));
    }
  });
  const open = async authenticated => {
    if (authenticated) await context.addCookies([{ name: 'operator', value: 'fixture', url: origin }]);
    await page.goto(`${origin}/manual-update.html?attempt=${attempt}`);
    expect(calls).toEqual([]);
    expect(html).not.toContain(workspace);
    expect(html).not.toContain(attempt);
  };

  it('keeps the page public but requires the operator session before any command', async () => {
    await open(false);
    await page.getByRole('button', { name: 'Update now and interrupt active work' }).click();
    await expect.poll(() => page.locator('#status').textContent()).toContain('Sign in');
    expect(calls).toEqual([]);
  });

  it('shows a fast launcher refusal received before HTTP 202 and keeps Windows paths out of the command', async () => {
    outcome = 'refused';
    await open(true);
    await page.getByRole('button', { name: 'Update now and interrupt active work' }).click();
    await expect.poll(() => page.locator('#status').textContent()).toContain('command failed');
    expect(await page.locator('#output').textContent()).toContain('Installer already running');
    expect(calls).toEqual([{ command: `node scripts/manual-update-recovery.mjs ${attempt}`, workspacePath: workspace }]);
  });

  it('keeps accepted and disconnected attempts explicitly unverified', async () => {
    await open(true);
    await page.getByRole('button', { name: 'Update now and interrupt active work' }).click();
    await expect.poll(() => page.locator('#status').textContent()).toContain('Command accepted');
    expect(await page.locator('#status').textContent()).toContain('success has not been verified');
    io.disconnectSockets(true);
    await expect.poll(() => page.locator('#status').textContent()).toContain('completion is unverified');
    expect(calls).toHaveLength(1);
    expect(await page.locator('#continue').isDisabled()).toBe(true);
  });
});

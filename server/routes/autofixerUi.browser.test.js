import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun, resolveTestChrome } from '../lib/browserSuiteGate.js';
import { createRecordedStaticServer } from '../../scripts/lib/browserServedFiles.js';
import { reapOwnedBrowser } from '../../scripts/lib/ownedBrowserCleanup.js';
import { sandboxedChromiumOptions } from '../../scripts/lib/playwrightSandbox.js';

const chrome = resolveTestChrome();
const canRun = browserSuiteCanRun('Autofixer UI accessibility', { chrome });
const html = readFileSync(new URL('../../autofixer/ui.template.html', import.meta.url), 'utf8');

function relativeLuminance(rgb) {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseColor(css) {
  const nums = css.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return [nums[0], nums[1], nums[2], nums[3] ?? 1];
}

function compositeOver(fg, bg) {
  const alpha = fg[3] ?? 1;
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
    1,
  ];
}

function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg.slice(0, 3));
  const l2 = relativeLuminance(bg.slice(0, 3));
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe.skipIf(!canRun)('Autofixer UI accessibility', () => {
  let http;
  let browserServer;
  let browser;
  let origin;
  let context;
  let page;
  let state;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.get('/', (_req, res) => res.type('html').send(html));
    app.get('/api/auth/status', (_req, res) => res.json({ enabled: state.authEnabled, authenticated: state.authenticated }));
    app.post('/api/auth/login', (req, res) => {
      if (req.body?.password !== 'example-password') return res.status(401).json({ error: 'Invalid password' });
      state.authenticated = true;
      res.json({ success: true });
    });
    app.post('/api/auth/logout', (_req, res) => {
      state.authenticated = false;
      res.json({ success: true });
    });
    app.get('/api/apps', (_req, res) => res.json([
      { name: 'Example App', pm2ProcessNames: ['example-api', 'example-worker'] },
    ]));
    app.get('/api/status', (_req, res) => {
      state.statusCalls += 1;
      res.json([
        { name: 'example-api', status: 'online' },
        { name: 'example-worker', status: 'errored' },
      ]);
    });
    app.post('/api/restart/:process', (_req, res) => res.json({ success: true }));
    app.post('/api/stop/:process', (_req, res) => res.json({ success: false, error: 'Stop refused' }));
    app.get('/api/history', (_req, res) => res.json([
      {
        sessionId: 'autofixer_example_1',
        processName: 'example-api',
        appName: 'Example App',
        startTime: '2026-01-01T00:00:00.000Z',
        duration: 4000,
        success: true,
        staged: true,
      },
    ]));
    app.get('/api/fixes/:session', (_req, res) => res.json({ patch: '--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-old\n+new\n' }));
    app.post('/api/fixes/:session/apply', (_req, res) => res.json({ disposition: 'applied' }));
    app.post('/api/fixes/:session/discard', (_req, res) => res.json({ disposition: 'discarded' }));
    app.get('/logs', (_req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.write(': connected\n\n');
    });

    const fixture = createRecordedStaticServer(express);
    http = await fixture.start(app);
    origin = `http://127.0.0.1:${http.address().port}`;
    browserServer = await chromium.launchServer(sandboxedChromiumOptions({ executablePath: chrome, headless: true, timeout: 20000 }));
    browser = await chromium.connect(browserServer.wsEndpoint(), { timeout: 5000 });
  }, 30000);

  beforeEach(async () => {
    state = { authEnabled: false, authenticated: true, statusCalls: 0 };
    context = await browser.newContext();
    page = await context.newPage();
  });

  afterEach(async () => {
    await context?.close();
  });

  afterAll(async () => {
    try {
      if (browserServer) await reapOwnedBrowser(browserServer, 5000, { requireProfileRemoval: true });
    } finally {
      if (http) await new Promise((resolve) => http.close(resolve));
    }
  });

  it('traps Tab/Shift+Tab inside #loginOverlay while visible and restores background reachability after sign-in', async () => {
    state.authEnabled = true;
    state.authenticated = false;
    await page.goto(origin);
    await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('loginPassword');

    const isolation = await page.evaluate(() => ({
      role: document.getElementById('loginOverlay').getAttribute('role'),
      modal: document.getElementById('loginOverlay').getAttribute('aria-modal'),
      labelledby: document.getElementById('loginOverlay').getAttribute('aria-labelledby'),
      errorRole: document.getElementById('loginError').getAttribute('role'),
      headerInert: document.querySelector('header').inert,
      containerInert: document.querySelector('.container').inert,
    }));
    expect(isolation).toEqual({
      role: 'dialog',
      modal: 'true',
      labelledby: 'loginTitle',
      errorRole: 'alert',
      headerInert: true,
      containerInert: true,
    });

    const visitedIds = [];
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      visitedIds.push(await page.evaluate(() => document.activeElement?.id));
    }
    expect(visitedIds).toEqual(['loginSubmit', 'loginPassword', 'loginSubmit', 'loginPassword']);

    await page.keyboard.press('Shift+Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('loginSubmit');

    await page.fill('#loginPassword', 'wrong-password');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#loginError').textContent()).toContain('Invalid password');

    await page.fill('#loginPassword', 'example-password');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.locator('#loginOverlay').isHidden()).toBe(true);
    expect(await page.evaluate(() => ({
      headerInert: document.querySelector('header').inert,
      containerInert: document.querySelector('.container').inert,
    }))).toEqual({ headerInert: false, containerInert: false });

    const backgroundReachable = [];
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press('Tab');
      backgroundReachable.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.dataset?.name || ''));
    }
    expect(backgroundReachable).toContain('portosDashboardLink');
    expect(backgroundReachable).toContain('example-api');
  });

  it('selects processes via keyboard, announces status, enables toolbar controls, and retains focus across refreshes', async () => {
    await page.goto(origin);
    await expect.poll(() => page.locator('ul#processList > li > button.process-item').count()).toBe(2);

    const firstMeta = await page.evaluate(() => {
      const btn = document.querySelector('ul#processList > li > button.process-item');
      const dot = btn.querySelector('.process-status');
      const sr = btn.querySelector('.sr-only');
      return {
        type: btn.getAttribute('type'),
        dotHidden: dot.getAttribute('aria-hidden'),
        srText: sr.textContent.trim(),
      };
    });
    expect(firstMeta).toEqual({ type: 'button', dotHidden: 'true', srText: '(online)' });

    await page.locator('button.process-item[data-name="example-api"]').focus();
    await page.keyboard.press('Enter');

    await expect.poll(() => page.locator('#restartBtn').isDisabled()).toBe(false);
    expect(await page.locator('#stopBtn').isDisabled()).toBe(false);
    expect(await page.evaluate(() => ({
      activeName: document.activeElement?.dataset?.name,
      ariaCurrent: document.activeElement?.getAttribute('aria-current'),
      outlineStyle: getComputedStyle(document.activeElement).outlineStyle,
      outlineColor: getComputedStyle(document.activeElement).outlineColor,
      statusLive: document.querySelector('.status-indicator')?.getAttribute('aria-live'),
      statusRole: document.querySelector('.status-indicator')?.getAttribute('role'),
      dotHidden: document.getElementById('statusDot')?.getAttribute('aria-hidden'),
    }))).toEqual({
      activeName: 'example-api',
      ariaCurrent: 'true',
      outlineStyle: 'solid',
      outlineColor: 'rgb(147, 197, 253)',
      statusLive: 'polite',
      statusRole: 'status',
      dotHidden: 'true',
    });

    await expect.poll(() => page.locator('#statusText').textContent()).toBe('Connected');

    await page.locator('#restartBtn').click();
    await expect.poll(() => page.locator('#toast').textContent()).toContain('Restarted example-api');
    expect(await page.locator('#toast').getAttribute('role')).toBe('status');
    expect(await page.locator('#toast').getAttribute('aria-live')).toBe('polite');

    await page.locator('#stopBtn').click();
    await expect.poll(() => page.locator('#toast').textContent()).toContain('Failed to stop: Stop refused');
    expect(await page.locator('#toast').getAttribute('role')).toBe('alert');
    expect(await page.locator('#toast').getAttribute('aria-live')).toBe('assertive');

    const callsBefore = state.statusCalls;
    await page.locator('button.process-item[data-name="example-api"]').focus();
    await page.evaluate(() => globalThis.fetchStatus());
    await expect.poll(() => state.statusCalls).toBeGreaterThan(callsBefore);
    expect(await page.evaluate(() => document.activeElement?.dataset?.name)).toBe('example-api');
  });

  it('transfers focus across History patch review/discard and supports ArrowLeft/ArrowRight tabs', async () => {
    await page.goto(origin);
    await page.locator('#logsTab').focus();
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => ({
      activeId: document.activeElement?.id,
      logsSelected: document.getElementById('logsTab').getAttribute('aria-selected'),
      historySelected: document.getElementById('historyTab').getAttribute('aria-selected'),
      logsHidden: document.getElementById('logs').hidden,
      historyHidden: document.getElementById('historyPanel').hidden,
    }))).toEqual({
      activeId: 'historyTab',
      logsSelected: 'false',
      historySelected: 'true',
      logsHidden: true,
      historyHidden: false,
    });

    await expect.poll(() => page.locator('#historyPanel button').count()).toBe(1);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.history-item')).cursor)).toBe('auto');
    const reviewBtn = page.locator('#historyPanel button', { hasText: 'Review patch' });
    await reviewBtn.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => document.activeElement?.textContent)).toBe('Apply and restart');

    await page.locator('#historyPanel button', { hasText: 'Discard' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => ({
      activeClass: document.activeElement?.className,
      text: document.activeElement?.textContent,
      tabIndex: document.activeElement?.getAttribute('tabindex'),
    }))).toEqual({
      activeClass: 'result success',
      text: 'Discarded',
      tabIndex: '-1',
    });
  });

  it('maintains WCAG AA contrast, zero clipping at 200% zoom (640x360), and reduced-motion compliance', async () => {
    await page.setViewportSize({ width: 640, height: 360 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(origin);
    await expect.poll(() => page.locator('ul#processList > li > button.process-item').count()).toBe(2);
    await page.locator('button.process-item[data-name="example-api"]').click();
    await expect.poll(() => page.locator('#stopBtn').isDisabled()).toBe(false);

    const layoutAndMotion = await page.evaluate(() => {
      const statusRect = document.querySelector('.status-bar').getBoundingClientRect();
      const transition = getComputedStyle(document.querySelector('.process-item')).transitionDuration;
      return {
        statusBottom: Math.round(statusRect.bottom),
        innerHeight: window.innerHeight,
        transition,
      };
    });
    expect(layoutAndMotion.statusBottom).toBeLessThanOrEqual(layoutAndMotion.innerHeight);
    expect(layoutAndMotion.transition).toBe('0s');

    const colors = await page.evaluate(() => {
      const readPair = (selector, bgSelector, underSelector) => {
        const el = document.querySelector(selector);
        const bgEl = bgSelector ? document.querySelector(bgSelector) : el;
        const underEl = underSelector ? document.querySelector(underSelector) : null;
        return {
          fg: getComputedStyle(el).color,
          bg: getComputedStyle(bgEl).backgroundColor,
          under: underEl ? getComputedStyle(underEl).backgroundColor : null,
        };
      };
      return {
        sidebarHeading: readPair('.sidebar h2', '.sidebar'),
        processApp: readPair('.process-app', '.process-item'),
        statusBar: readPair('.status-bar'),
        stopBtn: readPair('#stopBtn', '#stopBtn', '.toolbar'),
        restartBtn: readPair('#restartBtn', '#restartBtn', '.toolbar'),
        loginSubmit: readPair('#loginSubmit'),
      };
    });
    for (const pair of Object.values(colors)) {
      const fg = parseColor(pair.fg);
      const rawBg = parseColor(pair.bg);
      const bg = pair.under ? compositeOver(rawBg, parseColor(pair.under)) : rawBg;
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

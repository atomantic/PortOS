import { createServer, request as httpRequest } from 'node:http';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun, resolveTestChrome } from '../../../lib/browserSuiteGate.js';
import { FABLELOOM_STATIC_PLAYER_FILES } from '../staticPlayerFiles.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const chrome = resolveTestChrome();
const canRun = browserSuiteCanRun('fableloom static player', { Chrome: chrome });
const HASH = 'a'.repeat(64);

function graph(version = '1.0.0') {
  const clip = { file: `media/${HASH}.mp4`, durationMs: 1000, loopable: true,
    audioOccupancy: { safeForLiveVoice: true, characterDialogue: [], effects: [], clipping: false } };
  return {
    schemaVersion: version,
    runtimeVersion: '1.0.0',
    loom: {
      name: 'Example gate',
      participationMode: 'protagonist',
      episodes: [
        {
          id: 'episode-one', title: 'Gate', startNodeId: 'cut-open',
          nodes: [
            {
              id: 'cut-open', title: 'Opening',
              prose: 'A gate.<img src="x" onerror="alert(1)"><script>alert(1)</script>',
              playbackMode: 'cut', audienceConnection: 'disconnected', protagonistPresence: 'offscreen',
              isEnding: false, endingLabel: '',
              transitions: [{ id: 'arrive', intent: 'Arrive', triggers: [], description: '', targetNodeId: 'decision-gate' }],
              playbackAssets: { still: null, entry: clip, holds: [], exits: {} },
            },
            {
              id: 'decision-gate', title: 'The gate', prose: 'The gate holds.',
              playbackMode: 'decision', audienceConnection: 'connected', protagonistPresence: 'offscreen',
              isEnding: false, endingLabel: '',
              transitions: [
                { id: 'wait', intent: 'Wait here', triggers: ['wait here'], description: 'Stay', targetNodeId: 'decision-gate' },
                { id: 'open', intent: 'Open the gate', triggers: ['open the gate'], description: 'Leave', targetNodeId: 'ending-home' },
              ],
              playbackAssets: { still: null, entry: null, holds: [clip], exits: {} },
            },
            {
              id: 'ending-home', title: 'Home', prose: 'Home.',
              playbackMode: 'cut', audienceConnection: 'disconnected', protagonistPresence: 'offscreen',
              isEnding: true, endingLabel: 'Home', transitions: [],
              playbackAssets: { still: null, entry: clip, holds: [], exits: {} },
            },
          ],
        },
        {
          id: 'episode-other', title: 'Other', startNodeId: 'other-start',
          nodes: [{
            id: 'other-start', title: 'Elsewhere', prose: 'Elsewhere.',
            playbackMode: 'decision', audienceConnection: 'connected', protagonistPresence: 'offscreen',
            isEnding: false, endingLabel: '', transitions: [],
            playbackAssets: { still: null, entry: null, holds: [clip], exits: {} },
          }],
        },
      ],
    },
  };
}

function contentType(path) {
  if (extname(path) === '.js') return 'text/javascript; charset=utf-8';
  if (extname(path) === '.css') return 'text/css; charset=utf-8';
  if (extname(path) === '.html') return 'text/html; charset=utf-8';
  if (extname(path) === '.json') return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function startPackageServer(root) {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  const server = createServer((request, response) => {
    const fail = (code) => { response.writeHead(code); response.end(); };
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); } catch { fail(400); return; }
    if (pathname.includes('\0')) { fail(400); return; }
    const path = normalize(join(root, pathname));
    if (path !== root && !path.startsWith(rootWithSep)) { fail(403); return; }
    readFile(path).then((data) => {
      response.writeHead(200, { 'content-type': contentType(path), 'cache-control': 'no-store' });
      response.end(data);
    }).catch(() => fail(404));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      port: server.address().port,
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function stage(dir, manifest) {
  await mkdir(join(dir, 'player'), { recursive: true });
  for (const name of FABLELOOM_STATIC_PLAYER_FILES) await cp(join(here, name), join(dir, 'player', name));
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
}

async function ended(page) {
  await page.locator('#stage').evaluate((video) => video.dispatchEvent(new Event('ended')));
}

describe.skipIf(!canRun)('static reference player in a generic file server', () => {
  let browser;
  let server;
  let origin;
  let root;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'fableloom-player-'));
    await stage(join(root, 'good'), graph());
    await stage(join(root, 'bad'), graph('2.0.0'));
    server = await startPackageServer(root);
    origin = server.origin;
    const escaped = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: server.port, path: '/../../../../../../etc/passwd' }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.end();
    });
    expect(escaped).not.toBe(200);
    browser = await chromium.launch({ executablePath: chrome, headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function open(path, init) {
    const page = await browser.newPage();
    const requests = [];
    const dialogs = [];
    const errors = [];
    page.on('request', (request) => requests.push(request.url()));
    page.on('dialog', (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss().catch(() => {}); });
    page.on('pageerror', (error) => errors.push(error.message));
    if (init) await page.addInitScript(init);
    await page.goto(`${origin}${path}`);
    return { page, requests, dialogs, errors };
  }

  it('plays a cut into a decision loop and an ending with local text, keyboard and tap', async () => {
    const { page, requests, dialogs, errors } = await open('/good/player/index.html', () => {
      const original = globalThis.fetch.bind(globalThis);
      globalThis.__fetches = [];
      globalThis.fetch = (input, init) => {
        globalThis.__fetches.push(String(input));
        return original(input, init);
      };
    });
    try {
      await page.waitForSelector('[data-node="cut-open"][data-phase="entry"]');
      const prose = page.locator('#prose');
      expect(await prose.innerText()).toContain('<script>alert(1)</script>');
      expect(await prose.locator('img, script').count()).toBe(0);
      expect(parseFloat(await prose.evaluate((node) => getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(18);
      await ended(page);
      await page.waitForSelector('[data-node="decision-gate"][data-phase="hold"]');
      expect(await page.locator('#stage').evaluate((video) => video.loop)).toBe(true);
      await ended(page);
      expect(await page.locator('#player').getAttribute('data-node')).toBe('decision-gate');
      const chip = page.locator('button[data-choice="wait"]');
      expect(await chip.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await chip.click();
      await page.waitForFunction(() => document.querySelector('#player').dataset.turn !== 'speaking');
      expect(await page.locator('#player').getAttribute('data-node')).toBe('decision-gate');
      await page.locator('#message').fill('open the gate');
      await page.locator('#composer button[type="submit"]').click();
      await page.waitForSelector('[data-node="ending-home"][data-phase="entry"]');
      expect(await page.locator('#choices button').count()).toBe(0);
      expect(await page.locator('#composer').isHidden()).toBe(true);
      await ended(page);
      await page.waitForSelector('[data-phase="ended"][data-ended="true"]');
      expect(await page.locator('#ending').innerText()).toBe('Home');
      expect(dialogs).toEqual([]);
      expect(errors).toEqual([]);
      const fetches = await page.evaluate(() => globalThis.__fetches);
      expect(fetches).toHaveLength(1);
      expect(fetches[0]).toContain('manifest.json');
      expect(requests.every((url) => new URL(url).host === new URL(origin).host)).toBe(true);
      expect(requests.some((url) => url.includes('contract-example') || url.includes('/story/turn'))).toBe(false);
    } finally { await page.close(); }
  });

  it('moves the choice focus with the keyboard and activates the focused chip', async () => {
    const { page, errors } = await open('/good/player/index.html');
    try {
      await page.waitForSelector('[data-node="cut-open"]');
      await ended(page);
      await page.waitForSelector('button[data-choice="open"]');
      await page.locator('button[data-choice="wait"]').focus();
      await page.keyboard.press('ArrowRight');
      expect(await page.evaluate(() => document.activeElement?.dataset.choice)).toBe('open');
      await page.keyboard.press('Enter');
      await page.waitForSelector('[data-node="ending-home"]');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('keeps a custom resolver on the graph and ignores a speech result for an earlier episode', async () => {
    const { page, errors } = await open('/good/player/index.html', () => {
      globalThis.FableLoomPlayer = {
        resolveTurn: async (_nodeId, message) => (
          message === 'missing' ? { move: 'not-real' } : { stay: 'held here' }
        ),
        completeSpeech: (turn) => {
          const outcome = {
            status: turn.text ? 'completed' : 'empty', turnId: turn.turnId, nodeId: turn.nodeId,
            episodeId: turn.episodeId, generation: turn.generation,
          };
          if (turn.text) return outcome;
          return new Promise((resolve) => { globalThis.__finish = () => resolve({ ...outcome, status: 'completed' }); });
        },
      };
    });
    try {
      await page.waitForSelector('[data-node="cut-open"]');
      await ended(page);
      await page.waitForSelector('[data-node="decision-gate"][data-turn="listening"]');
      await page.locator('#message').fill('missing');
      await page.locator('#composer button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelector('#status').textContent.includes('not on this scene'));
      expect(await page.locator('#player').getAttribute('data-node')).toBe('decision-gate');
      await page.locator('#message').fill('hello');
      await page.locator('#composer button[type="submit"]').click();
      await page.waitForFunction(() => document.querySelector('#narration').textContent === 'held here');
      expect(await page.locator('#player').getAttribute('data-node')).toBe('decision-gate');
      await page.locator('button[data-choice="open"]').click();
      await page.waitForSelector('[data-turn="speaking"]');
      expect(await page.locator('#player').getAttribute('data-node')).toBe('decision-gate');
      await page.evaluate(() => globalThis.FableLoomPlayer.session.selectEpisode('episode-other'));
      await page.waitForSelector('[data-node="other-start"]');
      await page.evaluate(() => globalThis.__finish());
      expect(await page.locator('#player').getAttribute('data-node')).toBe('other-start');
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('opens the requested episode and refuses a newer package major', async () => {
    const other = await open('/good/player/index.html?episode=episode-other');
    try {
      await other.page.waitForSelector('[data-node="other-start"]');
      expect(other.errors).toEqual([]);
    } finally { await other.page.close(); }
    const bad = await open('/bad/player/index.html');
    try {
      await bad.page.waitForSelector('#failure:not([hidden])');
      expect(await bad.page.locator('#failure').innerText()).toMatch(/major version 1/);
      expect(await bad.page.locator('#player').getAttribute('data-node')).toBeNull();
      expect(bad.dialogs).toEqual([]);
    } finally { await bad.page.close(); }
  });
});

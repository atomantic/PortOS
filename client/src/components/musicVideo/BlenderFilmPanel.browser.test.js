// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright-core';
import { BROWSER_FIXTURE_STARTUP_MS, startBrowserFixture } from '../../test/browserFixture.js';
import { resolveTestChrome } from '../../../../scripts/lib/testChrome.js';

const chrome = resolveTestChrome();
const root = fileURLToPath(new URL('../../..', import.meta.url));

// An eighty-shot film with an invented state, mounted without the hook: the panel only reads `board.blender`.
// The first shot is three times as long as the rest, so the timeline has a proportion to get right.
const FIXTURE = `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { MemoryRouter } from 'react-router';
  import BlenderFilmPanel from '/src/components/musicVideo/BlenderFilmPanel.jsx';
  import { blenderOptionFields } from '/src/lib/musicVideoBlender.js';
  import '/src/index.css';
  const h = React.createElement;
  const shots = [];
  let at = 0;
  for (let i = 0; i < 80; i += 1) {
    const length = i === 0 ? 6 : 2;
    shots.push({ id: 's' + String((i + 1) * 10).padStart(4, '0'), label: 'Example shot number ' + (i + 1), start: at, end: at + length, frames: length * 24,
      set: 'stage', summary: 'One line about what this shot shows.', action: 'Something happens on the stage.', staging: 'Wide, centred.', camera: 'Slow push in.', transition: 'Cut', sceneId: 'scene-' + i });
    at += length;
  }
  const done = (file, extra) => Object.assign({ file, frames: 48, complete: true, stale: false, finishedAt: '2026-10-01T10:00:00.000Z', durationMs: 40000 }, extra);
  const renders = {};
  shots.slice(0, 30).forEach((shot, i) => {
    renders[shot.id] = { preview: done(shot.id + '/preview/shot.mp4', i > 24 ? { stale: true, staleReasons: ['source'] } : {}), stills: [] };
    if (i < 10) renders[shot.id].final = done(shot.id + '/final/shot.mp4');
  });
  renders[shots[0].id].stills = [{ file: shots[0].id + '/stills/t000003000.png', timeSec: 3 }];
  const state = {
    settings: { engine: 'BLENDER_EEVEE_NEXT', width: 1920, height: 1080, fps: 24, previewScale: 0.5, previewSamples: 16, finalSamples: 64, concurrency: 2, saveBlend: false, options: { palette: 'neon' } },
    tool: { ready: true, reason: '', executionMode: 'trusted-local', engine: 'BLENDER_EEVEE_NEXT', version: '5.2.3' },
    workspace: { exists: true, dir: 'data/music-video/mv-test/blender', hasFilm: true, files: 12 },
    manifest: { title: 'Example Film', syncedAt: '2026-10-01T09:00:00.000Z', fps: 24, srcChanged: false, problems: [], shots, options: [
      { key: 'palette', label: 'Palette', type: 'choice', choices: [{ value: 'shot', label: 'Each shot its own' }, { value: 'neon', label: 'Neon' }], default: 'shot', help: 'The colors of the sky, the lights and the figures.' },
      { key: 'debug', label: 'Debug overlay with a deliberately long label to wrap', type: 'boolean', default: false },
      { key: 'glow', label: 'Glow', type: 'number', min: 0, max: 1, step: 0.05, default: 0.35 },
      { key: 'card', label: 'Title card', type: 'text', default: '' },
    ] },
    renders,
    cuts: [{ id: 'cut-1', quality: 'preview', file: 'cuts/preview-1.mp4', createdAt: '2026-10-01T11:00:00.000Z', durationSec: at, missing: shots.slice(30).map((shot) => shot.id), stale: [], filmLook: true }],
    jobs: [
      { id: 'j1', kind: 'render', shotId: shots[30].id, quality: 'preview', status: 'running', index: 12, total: 48, secPerFrame: 0.41, startedAt: '2026-10-01T11:30:00.000Z', logFile: 'logs/j1.log' },
      { id: 'j2', kind: 'render', shotId: shots[31].id, quality: 'preview', status: 'queued' },
    ],
    notes: { [shots[0].id]: { text: 'Hold the last frame a little longer.', status: 'review', updatedAt: '2026-10-01T10:30:00.000Z' } },
  };
  const ok = async () => ({ ok: true, answer: null, error: null });
  const nothing = () => {};
  const blender = {
    projectId: 'mv-test', state, status: 'ready', error: null, refresh: nothing, pending: {}, filesRevision: 0, usageRevision: 0, runBlocker: null, renderBlocker: null,
    optionFields: blenderOptionFields(state.manifest.options, state.settings.options), editOption: nothing, clearFrames: ok,
    settings: state.settings, settingsChanges: {}, settingsDirty: false, settingsSaving: false, editSettings: nothing, discardSettings: nothing, saveSettings: ok,
    noteDrafts: {}, editNote: nothing, discardNote: nothing, saveNote: ok, fileDrafts: {}, editFile: nothing, discardFile: nothing, saveFile: ok, deleteFile: ok,
    createWorkspace: ok, sync: ok, render: ok, cancelJob: ok, cancelAll: ok, assembleCut: ok, openShot: ok,
  };
  const sections = [{ label: 'Intro', startSec: 0, endSec: 20 }, { label: 'Verse', startSec: 20, endSec: 80 }, { label: 'Chorus', startSec: 80, endSec: at }];
  const project = { id: 'mv-test', name: 'Example Song', audioAnalysis: { durationSec: at, sections }, composition: { mode: 'blender' } };
  const column = new URLSearchParams(location.search).get('column') || '100%';
  createRoot(document.getElementById('root')).render(h(MemoryRouter, { initialEntries: ['/music-video/mv-test/produce' + location.search] },
    h('main', { style: { maxWidth: column, margin: '0 auto', padding: '16px' } },
      h(BlenderFilmPanel, { board: { project, blender, audioUrl: null, openPreview: nothing, goToStage: nothing } }))));
`;

describe.skipIf(!chrome)('Blender film panel layout in Chromium', () => {
  let fixture;
  beforeAll(async () => {
    fixture = await startBrowserFixture({
      name: 'blender-film-panel', createServer, chromium,
      launchOptions: { executablePath: chrome, args: ['--mute-audio'] },
      viteConfig: temp => ({
        configFile: false, root, cacheDir: join(temp, 'vite-cache'),
        optimizeDeps: { entries: ['src/components/musicVideo/BlenderFilmPanel.jsx'], include: ['react', 'react-dom/client', 'react-router'] },
        plugins: [react(), {
          name: 'blender-film-fixture', enforce: 'pre',
          resolveId(id) { if (id === '/blender-film-fixture.jsx') return '\0blender-film-fixture.jsx'; },
          load(id) { if (id === '\0blender-film-fixture.jsx') return FIXTURE; },
          configureServer(vite) {
            vite.middlewares.use('/blender-film-test', async (_req, res) => {
              res.setHeader('Content-Type', 'text/html');
              res.end(await vite.transformIndexHtml('/blender-film-test', '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/blender-film-fixture.jsx"></script></body></html>'));
            });
          },
        }],
        server: { host: '127.0.0.1', port: 0 },
      }),
    });
  }, BROWSER_FIXTURE_STARTUP_MS);
  afterAll(() => fixture?.close());

  const open = async (context, search = '') => {
    const page = await fixture.browser.newPage(context);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // The fixture has no server behind it: media and API reads fail fast instead of hanging.
    // The film's source is the one read a tab makes itself, so it is answered here.
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/music-video/mv-test/blender/files') {
        return route.fulfill({ json: { files: ['film.py', 'kit/stage.py', 'shots/s0010.py', 'plates/sky.png'].map(path => ({ path, bytes: 2048, mtime: '2026-10-01T09:00:00.000Z', text: path.endsWith('.py') })) } });
      }
      if (url.pathname === '/api/music-video/mv-test/blender/file') return route.fulfill({ json: { path: url.searchParams.get('path'), content: 'def describe(ctx):\n    return {"shots": []}\n' } });
      return url.origin === new URL(fixture.origin).origin && !/^\/(api|data|socket\.io)(\/|$)/.test(url.pathname) ? route.continue() : route.abort();
    });
    await page.goto(`${fixture.origin}blender-film-test${search}`);
    await page.getByRole('region', { name: 'Blender film' }).waitFor();
    return { page, errors };
  };
  const box = locator => locator.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height };
  });

  it('keeps the selected shot\'s actions and player above the fold on a laptop, beside a list that scrolls on its own', async () => {
    // The stage column of a 1440 x 900 laptop, with roughly 300px of page chrome above the panel.
    const { page, errors } = await open({ viewport: { width: 1440, height: 900 } }, '?column=930px');
    try {
      const panel = await box(page.getByRole('region', { name: 'Blender film' }));
      const detail = page.getByRole('region', { name: 'Shot s0010' });
      const list = await box(page.getByRole('list', { name: 'Shots' }));
      const detailBox = await box(detail);
      const actions = await box(detail.getByRole('group', { name: 'Render this shot' }));
      const video = await box(detail.locator('video'));
      const foldBelowPanel = 900 - 300;
      expect(list.right).toBeLessThanOrEqual(detailBox.left);
      expect(actions.bottom - panel.top).toBeLessThanOrEqual(foldBelowPanel);
      expect(video.bottom - panel.top).toBeLessThanOrEqual(foldBelowPanel);
      expect(video.width / video.height).toBeCloseTo(16 / 9, 1);
      // Eighty rows stay inside the list's own scroller instead of stretching the page.
      expect(list.height).toBeLessThanOrEqual(900 * 0.7 + 1);
      expect(await page.getByRole('list', { name: 'Shots' }).evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);

      // The timeline is proportional: the six-second shot is three times as wide as a two-second one.
      const strip = page.getByRole('toolbar', { name: 'Shots across the song' });
      const first = await box(strip.getByRole('button').nth(0));
      const second = await box(strip.getByRole('button').nth(1));
      expect(first.width / second.width).toBeCloseTo(3, 1);
      expect(second.left).toBeCloseTo(first.right, 0);

      // Stepping with the keys moves the selection and brings its row into the list's view without moving the page.
      await strip.getByRole('button').nth(0).focus();
      // Forty presses in a row, as a held key sends them: none may be lost to a selection still committing.
      for (let step = 0; step < 40; step += 1) await page.keyboard.press('ArrowRight');
      await page.getByRole('region', { name: 'Shot s0410' }).waitFor();
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toMatch(/^s0410 /);
      const listAfter = await box(page.getByRole('list', { name: 'Shots' }));
      const row = await box(page.getByRole('list', { name: 'Shots' }).getByRole('button', { pressed: true }));
      expect(row.top).toBeGreaterThanOrEqual(listAfter.top - 1);
      expect(row.bottom).toBeLessThanOrEqual(listAfter.bottom + 1);
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);

  it('puts the source list beside the editor on a laptop, and sizes a lone film option for its content', async () => {
    const { page, errors } = await open({ viewport: { width: 1440, height: 900 } }, '?column=930px&btab=files&bfile=film.py');
    try {
      const list = page.getByRole('list', { name: 'Source files' });
      const editor = page.getByLabel('src/film.py');
      await editor.waitFor();
      const [listBox, editorBox] = [await box(list), await box(editor)];
      // Side by side, not stacked: the editor starts where the list ends and at the same height.
      expect(listBox.right).toBeLessThanOrEqual(editorBox.left);
      expect(Math.abs(listBox.top - editorBox.top)).toBeLessThan(80);
      expect(editorBox.width).toBeGreaterThan(listBox.width);

      await page.getByRole('tab', { name: 'Settings' }).click();
      const options = page.getByRole('group', { name: 'Film options' });
      const panel = await box(page.getByRole('region', { name: 'Blender film' }));
      // Options share rows in bounded columns instead of each stretching across the panel.
      const palette = await box(options.getByLabel('Palette'));
      const debug = await box(options.getByLabel(/^Debug overlay/));
      expect(palette.width).toBeLessThanOrEqual(panel.width / 2);
      expect(debug.left).toBeGreaterThanOrEqual(palette.right);
      expect(debug.top).toBeLessThan(palette.bottom);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);

  it.each(['shots', 'cut', 'settings', 'files', 'jobs'])('stacks the %s tab on a phone with no sideways scroll and touch-sized controls', async tab => {
    const { page, errors } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }, `?btab=${tab}`);
    try {
      await page.getByRole('tabpanel').waitFor();
      const overflow = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: document.documentElement.clientWidth }));
      expect(overflow.page).toBeLessThanOrEqual(overflow.view);
      // Child rectangles too: clipped content does not show up as scroll width.
      const controls = await page.locator('[aria-label="Blender film"] :is(button, select, input, textarea, video)').evaluateAll(elements => elements
        .filter(element => element.getClientRects().length > 0)
        .map(element => {
          const rect = element.getBoundingClientRect();
          const scroller = element.closest('ul, [role="tablist"], [role="toolbar"]');
          return { tag: element.tagName, name: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 40), left: rect.left, right: rect.right, height: rect.height,
            type: element.getAttribute('type'), scrolled: !!scroller && scroller.scrollWidth > scroller.clientWidth };
        }));
      expect(controls.length).toBeGreaterThan(3);
      for (const control of controls.filter(entry => !entry.scrolled)) {
        expect(control.left, control.name).toBeGreaterThanOrEqual(0);
        expect(control.right, control.name).toBeLessThanOrEqual(390);
      }
      const short = controls.filter(entry => entry.tag === 'BUTTON' && entry.height < 43.5).map(entry => entry.name);
      expect(short).toEqual([]);
      if (tab === 'shots') {
        const list = await box(page.getByRole('list', { name: 'Shots' }));
        const detail = await box(page.getByRole('region', { name: 'Shot s0010' }));
        expect(detail.top).toBeGreaterThanOrEqual(list.bottom);
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  }, 60000);
});

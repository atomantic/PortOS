import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { findFfmpeg } from '../../../../lib/ffmpeg.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import { browserSuiteCanRun, resolveTestChrome } from '../../../../lib/browserSuiteGate.js';
import { startOwnedBrowserFixture } from '../../../../test/browserFixture.js';

const engine = readFileSync(new URL('./engine.js', import.meta.url), 'utf8');
// Frozen shipped engine: compare both engines in the same browser, since canvas rasterization differs across OS/Chrome builds.
const priorEngine = readFileSync(new URL('../../../../routes/fixtures/musicVideoLayeredEngineBeforeTemplateControls.txt', import.meta.url), 'utf8');
const rig = readFileSync(new URL('./cameraRig.js', import.meta.url), 'utf8');
const chrome = resolveTestChrome();
const ffmpeg = await findFfmpeg();
const canRun = browserSuiteCanRun('layered template controls', { Chrome: chrome, ffmpeg });
const defaults = { beatReaction: 1, stillMotion: 1, footagePush: 1, grain: 0.09, vignette: 0.5 };
const off = Object.fromEntries(Object.keys(defaults).map(key => [key, 0]));
const digest = pixels => createHash('sha256').update(Buffer.from(pixels)).digest('hex');

describe.skipIf(!canRun)('layered template additions at fixed song frames', () => {
  let fixture, clip;
  beforeAll(async () => {
    clip = `data:video/webm;base64,${execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'smptebars=s=320x180:r=24:d=8', '-c:v', 'libvpx', '-g', '1', '-f', 'webm', 'pipe:1'], { maxBuffer: 8 << 20 }).toString('base64')}`;
    fixture = await startOwnedBrowserFixture({ chromium, launchOptions: { executablePath: chrome, headless: true } });
  }, 30000);
  afterAll(async () => { await fixture?.close(); });

  async function frames({ video, shot, selected = false, footage = false, engineSource = engine, card = false, section = 'Chorus', reactiveGain = 0.25 } = {}) {
    const page = await fixture.browser.newPage();
    try {
      await page.setContent('<canvas id="stage"></canvas>');
      const raw = await page.evaluate(({ video, shot, selected, clip, card, section, reactiveGain }) => {
        const source = document.createElement('canvas'); source.width = 320; source.height = 180;
        const ctx = source.getContext('2d');
        for (let y = 0; y < 180; y += 4) for (let x = 0; x < 320; x += 4) {
          ctx.fillStyle = (x + y) % 8 ? '#2581da' : '#edc75f'; ctx.fillRect(x, y, 4, 4);
        }
        globalThis.PORTOS_MV = { project: { templateEffects: video }, render: { width: 320, height: 180, fps: 24, durationSec: 8 },
          song: { beats: [0, 1, 2, 3], downbeats: [0, 2], sections: [{ startSec: 0, label: section }] },
          scenes: [{ sceneId: 'example', startSec: 0, endSec: 8, visualLayer: card ? 'card' : 'still', cardText: 'EXAMPLE', stillMove: 'pan', templateEffects: shot,
            media: clip ? { kind: 'video', src: clip, fps: 24, inSec: 0, outSec: 8 } : { kind: 'image', src: source.toDataURL() } }],
          effectFrames: selected ? [{ frame: 48, params: { chosen: true } }] : [],
        };
        globalThis.PORTOS_MV_EVENT_STATE = (_song, t) => ({ t, reactiveGain, activeEvents: [], hold: false });
        globalThis.PORTOS_LYRIC_TYPE = { createLyricType: () => ({ ready: Promise.resolve(), draw() {} }) };
        globalThis.__portosMusicVideoGlitch = (canvas) => {
          const c = canvas.getContext('2d'); c.fillStyle = '#ff0000'; c.fillRect(0, 0, 20, 20);
        };
        return Array.from(ctx.getImageData(0, 0, 320, 180).data);
      }, { video, shot, selected, clip: footage ? clip : null, card, section, reactiveGain });
      await page.addScriptTag({ content: rig });
      await page.addScriptTag({ content: engineSource });
      const pixels = [];
      for (const t of [0, 0.25, 2, 3.75]) {
        pixels.push(await page.evaluate(async t => {
          await globalThis.portosComposition.seek(t);
          return Array.from(document.getElementById('stage').getContext('2d').getImageData(0, 0, 320, 180).data);
        }, t));
      }
      return { raw: digest(raw), hashes: pixels.map(digest) };
    } finally { await page.close(); }
  }

  // Pins the pre-controls engine's pixels (texture only, no font/platform-dependent glyphs).
  it('keeps shipped default frames pixel-identical, with explicit defaults or absent settings', async () => {
    const implicit = await frames();
    expect(createHash('sha256').update(priorEngine).digest('hex')).toBe('b45ad91d8def477e02761e4a2b61c4546b68a3e53cf5f4038fcaa30c9596bac8');
    expect(implicit.hashes).toEqual((await frames({ engineSource: priorEngine })).hashes);
    expect((await frames({ video: defaults })).hashes).toEqual(implicit.hashes);
  });

  // A quiet reference uniquely catches the card's own glitch bypassing beatReaction.
  it.each(['Verse', 'Chorus'])('honors card beat controls in %s while preserving shipped defaults', async section => {
    const card = { card: true, section };
    const quiet = await frames({ ...card, video: off, reactiveGain: 0 });
    const disabled = await frames({ ...card, video: off });
    expect(disabled.hashes).toEqual(quiet.hashes);
    expect((await frames({ ...card, video: defaults, shot: off })).hashes).toEqual(quiet.hashes);
    const enabled = await frames({ ...card, video: { ...off, beatReaction: 1 } });
    expect(enabled.hashes[2]).not.toEqual(quiet.hashes[2]);
    expect((await frames({ ...card, video: off, shot: { beatReaction: 1 } })).hashes).toEqual(enabled.hashes);
    const shipped = await frames({ ...card, engineSource: priorEngine });
    expect((await frames(card)).hashes).toEqual(shipped.hashes);
    expect((await frames({ ...card, video: defaults })).hashes).toEqual(shipped.hashes);
  });

  it('removes the footage push across song frames and lets a shot restore it', async () => {
    const clean = await frames({ video: off, footage: true });
    expect(new Set(clean.hashes).size).toBe(1);
    const pushed = await frames({ video: off, shot: { footagePush: 1 }, footage: true });
    expect(pushed.hashes).not.toEqual(clean.hashes);
    expect(new Set(pushed.hashes).size).toBeGreaterThan(1);
  }, 30000);

  // Uniquely catches zero being treated as absent or selected effects being disabled with template effects.
  it('turns additions off without changing the source, retains selected effects, and inherits shot overrides per field', async () => {
    const clean = await frames({ video: off });
    expect(clean.hashes).toEqual(Array(4).fill(clean.raw));
    const chosen = await frames({ video: off, selected: true });
    expect(chosen.hashes[2]).not.toBe(clean.raw);
    expect(chosen.hashes[1]).toBe(clean.raw);
    expect((await frames({ video: defaults, shot: off })).hashes).toEqual(clean.hashes);
    expect((await frames({ video: off, shot: { grain: 0.09 } })).hashes).not.toEqual(clean.hashes);
    expect((await frames({ video: off, shot: { grain: null } })).hashes).toEqual(clean.hashes);
  });
});

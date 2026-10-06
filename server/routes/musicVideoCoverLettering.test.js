/**
 * Cover lettering controls (#10345), through the real router, the real
 * multipart parser and the real stores: uploading a typeface (accepted only
 * once the renderer can set text in it), a song's lettering saved straight from
 * the controls, and a saved style per artist. The renderer itself is faked
 * here (its widths stand in for fontconfig/CoreText); the real render is
 * exercised in services/musicVideo/coverArt.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { rmSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-cover-lettering-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
// Settings in memory: the artist styles live in `musicVideoPublishing`.
let stored = {};
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => stored),
  updateSettingsWith: vi.fn(async (mutate) => { stored = await mutate(stored); return stored; }),
}));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const fonts = await import('../services/musicVideo/coverFonts.js');
const { sfntFont } = await import('../services/musicVideo/__fontFixture.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

// A renderer where a font "loads" when its family is one this fake knows: the
// probe string then measures differently from a missing family's fallback.
const RENDERABLE = ['Example Sans'];
const fakeSharp = (input) => {
  const chain = {
    trim: () => chain,
    png: () => chain,
    toBuffer: async (opts) => {
      if (!opts?.resolveWithObject) return Buffer.alloc(0);
      const svg = Buffer.isBuffer(input) ? input.toString() : '';
      return { info: { width: RENDERABLE.some((family) => svg.includes(`'${family}'`)) ? 1500 : 1000 } };
    },
  };
  return chain;
};

async function upload(name, body) {
  const form = new FormData();
  form.append('font', new Blob([body], { type: 'application/octet-stream' }), name);
  const encoded = new Request('http://localhost/', { method: 'POST', body: form });
  return request(app).post('/api/music-video/publish/cover-fonts')
    .set('content-type', encoded.headers.get('content-type'))
    .send(Buffer.from(await encoded.arrayBuffer()));
}

beforeEach(() => {
  stored = {};
  rmSync(join(ROOT(), 'cover-fonts'), { recursive: true, force: true });
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  fonts.__setCoverFontDepsForTests({ sharp: async () => fakeSharp, mirrorDir: null, waitMs: 0 });
});
afterAll(cleanupTempDataRoots);

describe('uploaded cover typefaces', () => {
  it('accepts a font the renderer can set, lists it with its measured width, serves the file, and removes it', async () => {
    const res = await upload('ExampleSans-Regular.ttf', sfntFont('Example Sans'));
    expect(res.status).toBe(201);
    expect(res.body.font).toMatchObject({ id: 'example-sans', family: 'Example Sans', ext: 'ttf' });
    // 1500 / 100px probe units over the 27-character probe string.
    expect(res.body.font.width).toBeCloseTo(15 / 27, 2);
    expect((await request(app).get('/api/music-video/publish/cover-fonts')).body.fonts.map((f) => f.id)).toEqual(['example-sans']);

    const file = await request(app).get('/api/music-video/publish/cover-fonts/example-sans/file');
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('font/ttf');

    // The same family again replaces it under the same id, so designs naming it keep working.
    const again = await upload('ExampleSans-Regular-v2.ttf', sfntFont('Example Sans'));
    expect(again.body.fonts.map((f) => f.id)).toEqual(['example-sans']);

    const removed = await request(app).delete('/api/music-video/publish/cover-fonts/example-sans');
    expect(removed.body.fonts).toEqual([]);
    expect((await request(app).get('/api/music-video/publish/cover-fonts/example-sans/file')).status).toBe(404);
  });

  it('refuses a file that is not a font, a font the renderer cannot set, and the wrong extension', async () => {
    expect((await upload('notes.ttf', 'just some text, not a font')).status).toBe(422);
    const unusable = await upload('Unrenderable.otf', sfntFont('Unrenderable Face'));
    expect(unusable.status).toBe(422);
    expect(unusable.body.code).toBe('COVER_FONT_UNUSABLE');
    expect((await upload('Example.exe', sfntFont('Example Sans'))).status).toBe(400);
    // Nothing was kept from the refused uploads.
    expect((await request(app).get('/api/music-video/publish/cover-fonts')).body.fonts).toEqual([]);
  });
});

describe('lettering saved from the controls', () => {
  it('saves a partial design over the song, validates it, and lets an uploaded font through by id', async () => {
    const { id } = await projects.createProject({ name: 'Example Song' });
    const put = (body) => request(app).put(`/api/music-video/${id}/publish-kit/cover-art/design`).send(body);

    const saved = await put({ design: { layout: 'center', titleStyle: 'stencil', tagLayout: 'with-title', titleColor: '#ff8800' } });
    expect(saved.status).toBe(200);
    expect(saved.body.project.publishKit.coverArt.design).toMatchObject({ layout: 'center', titleStyle: 'stencil', tagLayout: 'with-title', titleColor: '#ff8800', typeface: 'sans' });

    expect((await put({ design: { titleStyle: 'confetti' } })).status).toBe(400);
    expect((await put({ design: { titleColor: 'orange' } })).status).toBe(400);
    expect((await put({ design: { unknown: true } })).status).toBe(400);

    await upload('ExampleSans-Regular.ttf', sfntFont('Example Sans'));
    const withFont = await put({ design: { typeface: 'font:example-sans' } });
    expect(withFont.body.project.publishKit.coverArt.design).toMatchObject({ typeface: 'font:example-sans', titleStyle: 'stencil' });
  });
});

describe('artist styles', () => {
  it('saves one design per artist (name case aside), lists them, applies from the list, and removes one', async () => {
    const put = (body) => request(app).put('/api/music-video/publish/artist-styles').send(body);
    const first = await put({ name: 'Example Artist', design: { layout: 'top-left', typeface: 'serif', titleStyle: 'outline' } });
    expect(first.status).toBe(200);
    expect(first.body.style).toMatchObject({ key: 'example artist', name: 'Example Artist', design: { layout: 'top-left', typeface: 'serif', titleStyle: 'outline' } });

    await put({ name: 'EXAMPLE  artist', design: { layout: 'center' } }); // same artist: replaces
    await put({ name: 'Another Example', design: { weight: 'light' } });
    const listed = (await request(app).get('/api/music-video/publish/artist-styles')).body.styles;
    expect(listed.map((s) => s.name)).toEqual(['Another Example', 'EXAMPLE artist']);
    expect(listed[1].design).toMatchObject({ layout: 'center', typeface: 'sans' }); // a full design, not a patch

    // Platform settings saved beside the styles are untouched by them.
    stored = { ...stored, musicVideoPublishing: { ...stored.musicVideoPublishing, platforms: { x: { enabled: true, account: 'example' } } } };
    await put({ name: 'Third Example', design: {} });
    expect(stored.musicVideoPublishing.platforms.x).toEqual({ enabled: true, account: 'example' });

    expect((await request(app).delete('/api/music-video/publish/artist-styles?name=another%20example')).status).toBe(200);
    expect((await request(app).delete('/api/music-video/publish/artist-styles?name=another%20example')).status).toBe(404);
    expect((await put({ name: '', design: {} })).status).toBe(400);
  });
});

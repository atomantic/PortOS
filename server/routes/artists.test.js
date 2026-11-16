import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real artists service (file backend under the test runner) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-artists-routes-') }));
afterAll(cleanupTempDataRoots);

const { default: artistsRoutes } = await import('./artists.js');

const app = express();
app.use(express.json());
app.use('/api/artists', artistsRoutes);
app.use(errorMiddleware);

const api = (method, path = '', body) => request(app)[method](`/api/artists${path}`).send(body);

describe('artists routes', () => {
  it('creates an artist that reads back by id and in the list, then patches and soft-deletes it', async () => {
    const created = await api('post', '', { name: 'Nova', genre: 'indie folk' });
    expect(created.status).toBe(201);
    const { id } = created.body;

    expect((await api('get', `/${id}`)).body).toMatchObject({ id, name: 'Nova', genre: 'indie folk' });
    expect((await api('get')).body.map((a) => a.id)).toContain(id);

    const patched = await api('patch', `/${id}`, { name: 'Nova Star' });
    expect(patched.status).toBe(200);
    expect((await api('get', `/${id}`)).body).toMatchObject({ name: 'Nova Star', genre: 'indie folk' });

    expect((await api('delete', `/${id}`)).status).toBe(200);
    expect((await api('get', `/${id}`)).status).toBe(404);
    expect((await api('get')).body.map((a) => a.id)).not.toContain(id);
  });

  // Regression guard: every client caller (ArtistsManager, ArtistPicker) calls
  // listArtists() with no query params. If this ever returns an envelope instead
  // of a bare array, those lists silently render empty.
  it('lists a bare unbounded array by default and a bounded envelope when pagination is requested', async () => {
    for (let i = 0; i < 4; i++) await api('post', '', { name: `Paged ${i}` });

    const bare = await api('get');
    expect(Array.isArray(bare.body)).toBe(true);
    const total = bare.body.length;
    expect(total).toBeGreaterThanOrEqual(4);

    const page = await api('get', '?limit=2&offset=1');
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total, limit: 2, offset: 1 });
    expect(page.body.items.map((a) => a.id)).toEqual(bare.body.slice(1, 3).map((a) => a.id));
  });

  it('saves press and submission fields (trimmed) and refuses an over-long one without persisting it', async () => {
    const { body: { id } } = await api('post', '', { name: 'Press Kit' });
    const ok = await api('patch', `/${id}`, { bioShort: '  Makes songs.  ', sunoUrl: 'https://suno.com/@nova' });
    expect(ok.status).toBe(200);
    expect((await api('get', `/${id}`)).body).toMatchObject({ bioShort: 'Makes songs.', sunoUrl: 'https://suno.com/@nova' });

    expect((await api('patch', `/${id}`, { bioOneLine: 'x'.repeat(301) })).status).toBe(400);
    expect((await api('get', `/${id}`)).body.bioOneLine).toBe('');
  });

  it('builds the submission profile from the stored artist, listing what is still missing', async () => {
    const { body: { id } } = await api('post', '', { name: 'Nova', bioShort: 'Makes songs.', spotifyUrl: 'https://open.spotify.com/artist/x' });
    const r = await api('get', `/${id}/submission-profile`);
    expect(r.status).toBe(200);
    expect(r.body.profile).toMatchObject({ name: 'Nova', bioShort: 'Makes songs.', creditName: '' });
    expect(r.body.missing).toContain('Name for credits');
    expect(r.body.missing).not.toContain('Links');
    expect(r.body.markdown).toContain('- Spotify: https://open.spotify.com/artist/x');
    expect(r.body.markdown).toContain('- Short bio: Makes songs.');
    expect((await api('get', '/artist-missing/submission-profile')).status).toBe(404);
  });

  it('rejects a missing name and an empty patch without persisting anything', async () => {
    const before = (await api('get')).body.length;
    expect((await api('post', '', { genre: 'no name' })).status).toBe(400);
    expect((await api('get')).body).toHaveLength(before);

    const { body } = await api('post', '', { name: 'Stable' });
    expect((await api('patch', `/${body.id}`, {})).status).toBe(400);
    expect((await api('get', `/${body.id}`)).body.name).toBe('Stable');
  });

  it('returns 404 for an unknown artist', async () => {
    expect((await api('get', '/artist-missing')).status).toBe(404);
  });
});

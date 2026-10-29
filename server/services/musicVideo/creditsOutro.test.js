import { beforeEach, describe, expect, it, vi } from 'vitest';

const { store } = vi.hoisted(() => ({ store: { tracks: {}, artists: [], albums: {} } }));
vi.mock('../tracks/index.js', () => ({ getTrack: async (id) => store.tracks[id] || null }));
vi.mock('../artists/index.js', () => ({
  getArtist: async (id) => {
    if (store.failArtist) throw store.failArtist;
    return store.artists.find((a) => a.id === id) || null;
  },
  listArtists: async () => store.artists,
}));
vi.mock('../albums/index.js', () => ({ getAlbum: async (id) => store.albums[id] || null }));

const { getMusicVideoCreditsPrefill } = await import('./creditsOutro.js');

beforeEach(() => {
  store.failArtist = null;
  store.tracks = { 'track-1': { title: 'Example Song', artistId: 'artist-1', albumId: 'album-1' } };
  store.artists = [{ id: 'artist-1', name: 'Example Artist', creditName: '' }, { id: 'artist-2', name: 'Other Artist' }];
  store.albums = { 'album-1': { title: 'Example Album' } };
});

describe('credits prefill', () => {
  it('credits the track\'s own artist and album', async () => {
    const credits = await getMusicVideoCreditsPrefill({ name: 'Example Song v2', trackId: 'track-1' });
    expect(credits).toMatchObject({ title: 'Example Song', artist: 'Example Artist' });
    expect(credits.lines).toContainEqual({ role: 'From the album', name: 'Example Album' });
  });

  it('falls back to the only artist on the install, and to nobody when there are several', async () => {
    store.artists = [store.artists[0]];
    expect(await getMusicVideoCreditsPrefill({ name: 'Uploaded Song', trackId: null })).toMatchObject({ title: 'Uploaded Song', artist: 'Example Artist' });
    store.artists.push({ id: 'artist-2', name: 'Other Artist' });
    expect(await getMusicVideoCreditsPrefill({ name: 'Uploaded Song', trackId: null })).toMatchObject({ artist: '' });
  });

  it('never credits someone else when the linked artist is gone, and reports a failed lookup', async () => {
    store.artists = [{ id: 'artist-2', name: 'Other Artist' }];
    store.tracks['track-2'] = { title: 'Example Song', artistId: 'artist-gone' };
    expect(await getMusicVideoCreditsPrefill({ name: 'Example Song', trackId: 'track-2' })).toMatchObject({ artist: '' });
    store.tracks['track-2'].artist = 'Track Text';
    expect(await getMusicVideoCreditsPrefill({ name: 'Example Song', trackId: 'track-2' })).toMatchObject({ artist: 'Track Text' });
    store.failArtist = new Error('database unavailable');
    await expect(getMusicVideoCreditsPrefill({ name: 'Example Song', trackId: 'track-1' })).rejects.toThrow('database unavailable');
  });
});

/**
 * Music Video — the credits ending's prefill (lib/musicVideoCreditsOutro.js):
 * what PortOS already knows about the song, read from the project's track,
 * the track's artist (Create › Music › Artists) and its album. Read-only;
 * the client applies it only when the director turns the credits on or asks
 * to refill them.
 */

import { creditsOutroPrefill } from '../../lib/musicVideoCreditsOutro.js';

/**
 * The suggested credits for `project`. With no artist on the track (and no
 * artist text either), an install with exactly one artist is credited with it.
 */
export async function getMusicVideoCreditsPrefill(project) {
  const [{ getTrack }, { getArtist, listArtists }, { getAlbum }] = await Promise.all([
    import('../tracks/index.js'), import('../artists/index.js'), import('../albums/index.js'),
  ]);
  const track = project?.trackId ? await getTrack(project.trackId).catch(() => null) : null;
  let artist = track?.artistId ? await getArtist(track.artistId).catch(() => null) : null;
  if (!artist && !track?.artist) {
    const artists = await listArtists().catch(() => []);
    if (Array.isArray(artists) && artists.length === 1) artist = artists[0];
  }
  const album = track?.albumId ? await getAlbum(track.albumId).catch(() => null) : null;
  return creditsOutroPrefill({ project, track, artist, album });
}

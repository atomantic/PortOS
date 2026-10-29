/**
 * Music Video — the credits ending's prefill (lib/musicVideoCreditsOutro.js):
 * what PortOS already knows about the song, read from the project's track,
 * the track's artist (Create › Music › Artists) and its album. Read-only;
 * the client applies it only when the director turns the credits on or asks
 * to refill them.
 */

import { creditsOutroPrefill } from '../../lib/musicVideoCreditsOutro.js';

/**
 * The suggested credits for `project`. Only a song known to have no artist
 * (no linked track, or a track with neither a linked artist nor artist text)
 * is credited to an install's one artist. A linked track or artist that is
 * gone leaves the artist unknown (the track's own artist text when there is
 * one), never someone else. A failed lookup rejects.
 */
export async function getMusicVideoCreditsPrefill(project) {
  const [{ getTrack }, { getArtist, listArtists }, { getAlbum }] = await Promise.all([
    import('../tracks/index.js'), import('../artists/index.js'), import('../albums/index.js'),
  ]);
  const track = project?.trackId ? await getTrack(project.trackId) : null;
  let artist = track?.artistId ? await getArtist(track.artistId) : null;
  const trackKnown = !project?.trackId || !!track;
  if (trackKnown && !track?.artistId && !track?.artist) {
    const artists = await listArtists();
    if (Array.isArray(artists) && artists.length === 1) artist = artists[0];
  }
  const album = track?.albumId ? await getAlbum(track.albumId) : null;
  return creditsOutroPrefill({ project, track, artist, album });
}

/**
 * Files completed Music Studio audio jobs onto their track, even when the
 * browser that started the render has unmounted (#4353).
 */
import { renderFederatedMediaAudioPrompt } from '../lib/federatedMediaWire.js';
import { createMediaJobImageHook } from './mediaJobImageHook.js';
import { updateJobResult } from './mediaJobQueue/index.js';
import * as tracks from './tracks/index.js';
import * as albums from './albums/index.js';

const hook = createMediaJobImageHook({
  label: 'Music Studio',
  initLog: '🎵 Music Studio completion hook initialized',
  kind: 'audio',
  tagKey: 'musicStudio',
  identify: (tag) => (tag && (tag.trackId === null || typeof tag.trackId === 'string')
    ? { trackId: tag.trackId || null } : null),
  serializeKey: ({ trackId }) => trackId || 'standalone',
  describe: ({ trackId }) => trackId || 'standalone',
  extractResult: (job) => {
    const filename = job.result?.filename;
    if (typeof filename !== 'string' || !filename) return null;
    const tag = job.params.musicStudio;
    const authoredPrompt = typeof tag.authoredPrompt === 'string' ? tag.authoredPrompt : job.params.prompt;
    const authoredLyrics = typeof tag.authoredLyrics === 'string' ? tag.authoredLyrics : job.params.lyrics;
    const remotePrompt = renderFederatedMediaAudioPrompt(job.params.remoteMedia?.profile);
    return {
      filename,
      durationSec: Number.isFinite(job.result?.durationSec) ? Math.round(job.result.durationSec) : null,
      engine: typeof job.result?.engine === 'string' ? job.result.engine : null,
      modelId: typeof job.result?.modelId === 'string' ? job.result.modelId : null,
      prompt: remotePrompt || job.params.prompt,
      authoredPrompt,
      lyrics: remotePrompt ? '' : job.params.lyrics,
      authoredLyrics,
      lyricsEnabled: tag.lyricsEnabled === true,
      lyricsProvided: tag.lyricsProvided === true,
      instrumentalOnly: typeof tag.instrumentalOnly === 'boolean' ? tag.instrumentalOnly : null,
      title: tag.title,
      artistId: tag.artistId,
      artist: tag.artist,
      albumId: tag.albumId,
    };
  },
  attach: async ({ job, trackId, filename, durationSec, engine, modelId, prompt, authoredPrompt, lyrics, authoredLyrics, lyricsEnabled, lyricsProvided, instrumentalOnly, title, artistId, artist, albumId }) => {
    const current = trackId ? await tracks.getTrack(trackId) : null;
    // A deleted target is a successful render but no longer an attach target.
    if (trackId && !current) return null;
    const { renders } = tracks.buildRenderAppend(current, {
      audioFilename: filename,
      prompt,
      authoredPrompt,
      lyrics: lyricsEnabled ? lyrics : '',
      instrumentalOnly,
      engine,
      modelId,
      durationSec,
    });
    const meta = {
      audioFilename: filename,
      engine,
      modelId,
      durationSec,
      prompt: authoredPrompt,
      renders,
    };
    // Existing instrumental renders preserve the track's saved lyric draft;
    // a standalone render has no prior record, so retain its authored lyrics.
    const shouldPersistLyrics = lyricsEnabled && lyricsProvided && (instrumentalOnly !== true || !trackId);
    if (shouldPersistLyrics) meta.lyrics = authoredLyrics;
    const track = trackId
      ? await tracks.updateTrack(trackId, meta)
      : await tracks.createTrack({
        title: title || authoredPrompt.slice(0, 60),
        artistId,
        artist,
        albumId,
        ...(shouldPersistLyrics ? { lyrics: authoredLyrics } : {}),
        ...meta,
      });
    if (!trackId && track?.albumId) {
      const album = await albums.getAlbum(track.albumId).catch(() => null);
      if (album && !(album.trackIds || []).includes(track.id)) {
        await albums.updateAlbum(track.albumId, { trackIds: [...(album.trackIds || []), track.id] }).catch(() => {});
      }
    }
    await updateJobResult(job.id, { trackId: track.id });
    return track;
  },
  onAttached: ({ trackId, filename }, track) => {
    console.log(`🎵 Music Studio ${trackId || track?.id || 'new'} ← ${filename}`);
  },
});

export function initMusicStudioHook() {
  hook.init();
}

export const __testing = hook.__testing;

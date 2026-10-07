/**
 * Track import from a Suno song link — the Suno sibling of the YouTube import
 * (trackYoutubeImport.js). Reads the song page for its title, lyrics and style,
 * downloads the song's audio from Suno, lands it in the shared music library
 * (data/music/), and creates a Track carrying that metadata.
 *
 * Same job contract as the YouTube import so the client drives both through one
 * slot: kickoff returns a jobId at once, the work runs detached, and progress
 * streams over SSE. Terminal frames: `{ type: 'complete', trackId, track, source }`,
 * `{ type: 'error', error }`, or `{ type: 'canceled' }`.
 */

import { randomUUID } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { shortId } from '../lib/fileUtils.js';
import { probeVideoDuration } from '../lib/ffmpeg.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { fetchPublicBinary, fetchPublicText, resolvePublicUrl } from '../lib/safeUrlFetch.js';
import {
  isSunoSongUrl, isSunoHost, sunoSongIdFromUrl, sunoCdnAudioUrl, parseSunoSongPage, SUNO_URL_INVALID_MESSAGE,
} from '../lib/sunoSong.js';
import { importUploadedTrack, MUSIC_UPLOAD_MAX_BYTES } from './pipeline/musicLibrary.js';
import { createTrack } from './tracks/index.js';
import { RENDER_SOURCES } from './tracks/logic.js';

const PAGE_TIMEOUT_MS = 20_000;
const PAGE_MAX_BYTES = 5 * 1024 * 1024;
const AUDIO_TIMEOUT_MS = 5 * 60 * 1000;
// Suno serves its pages to browsers; a bare fetch user agent can get a challenge page instead.
const HEADERS = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' };

// Suno's CDN serves audio/mpeg; a missing type or octet-stream is still worth probing.
const isAudioResponse = (contentType) => {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return !type || type.startsWith('audio/') || type === 'video/mp4' || type === 'application/octet-stream';
};

// jobId -> { clients, lastPayload, status, canceled }
const importJobs = new Map();

export const attachSunoImportSseClient = (jobId, res) => attachSse(importJobs, jobId, res);

export const __testing = { importJobs };

/** Cancel an in-flight import; false when the job is unknown or already over. */
export function cancelSunoImport(jobId) {
  const job = importJobs.get(jobId);
  if (!job || job.canceled || job.status !== 'running') return false;
  job.canceled = true;
  return true;
}

// A share link (suno.com/s/…) redirects to the song page; follow it on Suno's own hosts only.
async function resolveSongId(url) {
  const direct = sunoSongIdFromUrl(url);
  if (direct) return direct;
  const finalUrl = await resolvePublicUrl(url, {
    timeoutMs: PAGE_TIMEOUT_MS, headers: HEADERS, allowUrl: (u) => u.protocol === 'https:' && isSunoHost(u.hostname),
  });
  const songId = sunoSongIdFromUrl(finalUrl);
  if (!songId) throw new Error('That Suno link did not lead to a song page');
  return songId;
}

/**
 * Kick off a Suno song import. Throws 400 for a URL that isn't a Suno song
 * link; everything after that runs detached and reports over SSE.
 */
export async function startSunoImport(url) {
  if (!isSunoSongUrl(url)) throw new ServerError(SUNO_URL_INVALID_MESSAGE, { status: 400, code: 'SUNO_URL_INVALID' });

  const jobId = randomUUID();
  const job = { id: jobId, status: 'running', clients: [], canceled: false };
  importJobs.set(jobId, job);
  console.log(`🎶 Suno import ${shortId(jobId)} — ${url}`);

  (async () => {
    let dir = null;
    const abortIfCanceled = () => {
      if (!job.canceled) return false;
      console.log(`🛑 Suno import ${shortId(jobId)} cancelled`);
      broadcastSse(job, { type: 'canceled' });
      return true;
    };
    try {
      broadcastSse(job, { type: 'progress', percent: 5, stage: 'reading' });
      const songId = await resolveSongId(url.trim());
      // The page only adds metadata; a page Suno won't serve still imports the audio.
      const html = await fetchPublicText(`https://suno.com/song/${songId}`, {
        timeoutMs: PAGE_TIMEOUT_MS, headers: HEADERS, maxBytes: PAGE_MAX_BYTES, throwOnUnsafe: false,
      }).catch(() => null);
      const song = parseSunoSongPage(html || '', songId);
      if (abortIfCanceled()) return;

      broadcastSse(job, { type: 'progress', percent: 20, stage: 'downloading' });
      const audio = await fetchPublicBinary(song.audioUrl || sunoCdnAudioUrl(songId), {
        timeoutMs: AUDIO_TIMEOUT_MS, headers: HEADERS, maxBytes: MUSIC_UPLOAD_MAX_BYTES, throwOnUnsafe: false,
      });
      if (abortIfCanceled()) return;
      if (!audio?.buffer?.byteLength) {
        throw new Error('Could not download the song audio from Suno (is the song public or unlisted?)');
      }
      // An error or interstitial page can come back with a 200; only audio becomes a track.
      if (!isAudioResponse(audio.contentType)) {
        throw new Error('Suno sent back something other than audio for this song (has it finished generating?)');
      }

      broadcastSse(job, { type: 'progress', percent: 90, stage: 'importing' });
      const title = song.title || 'Suno song';
      const ext = /mp4|m4a|aac/i.test(audio.contentType) ? 'm4a' : 'mp3';
      dir = await mkdtemp(join(tmpdir(), 'portos-sunoimport-'));
      const tempPath = join(dir, `song.${ext}`);
      await writeFile(tempPath, audio.buffer);
      // Probe before the library import so a file ffprobe can't read never lands there.
      const durationSec = await probeVideoDuration(tempPath).catch(() => null);
      if (!durationSec) throw new Error('The file Suno sent back is not playable audio');
      const { filename } = await importUploadedTrack(tempPath, `${title}.${ext}`);
      const track = await createTrack({
        title, lyrics: song.lyrics, prompt: song.style, audioFilename: filename, durationSec,
        renders: [{
          audioFilename: filename, durationSec, source: RENDER_SOURCES.SUNO,
          prompt: song.style, authoredPrompt: song.style, lyrics: song.lyrics,
        }],
      });

      console.log(`🎶 Suno import ${shortId(jobId)} complete — track=${shortId(track.id)} "${track.title}"`);
      broadcastSse(job, { type: 'complete', trackId: track.id, track, source: 'suno' });
    } catch (err) {
      console.error(`❌ Suno import ${shortId(jobId)} failed: ${err?.message || err}`);
      broadcastSse(job, { type: 'error', error: err?.message || String(err) });
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
      job.status = 'done';
      closeJobAfterDelay(importJobs, jobId);
    }
  })();

  return { jobId };
}

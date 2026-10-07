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
import { copyFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { shortId } from '../lib/fileUtils.js';
import { findFfmpeg, probeVideoDuration, runFfmpegProcess } from '../lib/ffmpeg.js';
import { broadcastSse, attachSseClient as attachSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { fetchPublicBinary, fetchPublicText, resolvePublicUrl } from '../lib/safeUrlFetch.js';
import {
  isSunoSongUrl, isSunoHost, sunoSongIdFromUrl, sunoCdnAudioUrl, sunoCdnVideoUrl, parseSunoSongPage, SUNO_URL_INVALID_MESSAGE,
} from '../lib/sunoSong.js';
import { importUploadedTrack, MUSIC_UPLOAD_MAX_BYTES } from './pipeline/musicLibrary.js';
import { createTrack } from './tracks/index.js';
import { RENDER_SOURCES } from './tracks/logic.js';

const PAGE_TIMEOUT_MS = 20_000;
const PAGE_MAX_BYTES = 5 * 1024 * 1024;
const AUDIO_TIMEOUT_MS = 5 * 60 * 1000;
// The song's video carries a picture track too, so it may run well past the audio cap.
const VIDEO_MAX_BYTES = 250 * 1024 * 1024;
// Suno serves its pages to browsers; a bare fetch user agent can get a challenge page instead.
const HEADERS = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' };

// Suno's CDN serves audio/mpeg; a missing type or octet-stream is still worth probing.
const isAudioResponse = (contentType) => {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return !type || type.startsWith('audio/') || type === 'video/mp4' || type === 'application/octet-stream';
};

const isVideoResponse = (contentType) => {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return !type || type === 'video/mp4' || type === 'application/octet-stream';
};

// The first source that answers with audio, or null when Suno refuses them all.
async function fetchSongAudio(urls) {
  for (const url of [...new Set(urls.filter(Boolean))]) {
    const res = await fetchPublicBinary(url, {
      timeoutMs: AUDIO_TIMEOUT_MS, headers: HEADERS, maxBytes: MUSIC_UPLOAD_MAX_BYTES, throwOnUnsafe: false,
    });
    if (res?.buffer?.byteLength && isAudioResponse(res.contentType)) return res;
  }
  return null;
}

// Copy the video's audio track out (Suno's is AAC); transcode only if a copy fails.
async function extractAudio(videoPath, outPath, signal) {
  const bin = await findFfmpeg();
  if (!bin) throw new Error('Suno only offers this song as a video, and ffmpeg is needed to take its audio out');
  for (const codec of [['-c:a', 'copy'], ['-c:a', 'aac', '-b:a', '256k']]) {
    const res = await runFfmpegProcess({ bin, signal, args: ['-y', '-i', videoPath, '-vn', '-map', '0:a:0', ...codec, outPath] });
    if (res.ok || signal?.aborted) return;
    console.warn(`⚠️ Suno audio extract (${codec[1]}) failed: ${res.reason}`);
  }
  throw new Error('Could not take the audio out of the video Suno offers for this song');
}

// The browser export's budget here. The autopilot allows 10 minutes, but a
// signed-out browser shows no usable Download menu (no sign-in redirect), so
// only a timeout ends that wait; an import should fall back long before then.
const BROWSER_EXPORT_TIMEOUT_MS = 90_000;
// The whole browser leg, including its wait in the shared browser queue
// (behind an autopilot song or a publish draft), which the export's own
// budget doesn't count. Mutable for tests.
const limits = { browserWaitMs: 2 * 60 * 1000 };

// Export the song through the signed-in PortOS Browser, the same export the
// autopilot uses, so a private or unpublished song in the user's own Suno
// library imports too. Resolves the page HTML it saw (for title and lyrics).
async function exportThroughBrowser(songId, outPath, signal) {
  const { generateSunoSong } = await import('./musicVideo/autonomousSuno.js');
  // Its own signal: a cancel or the wait budget running out stops it, and a
  // queued export sees the aborted signal when its turn comes and exits.
  const exportAbort = new AbortController();
  const stop = () => exportAbort.abort();
  if (signal.aborted) stop();
  signal.addEventListener('abort', stop, { once: true });
  let timer;
  let html = '';
  const exported = generateSunoSong({}, {
    songIds: [songId], signal: exportAbort.signal, timeoutMs: BROWSER_EXPORT_TIMEOUT_MS,
    onSongPage: (pageHtml) => { html = pageHtml; },
    // Keep the export out of the library until it passes this import's checks,
    // and never let an export that finishes after its leg gave up overwrite
    // what the next route wrote.
    importAudio: async (path) => {
      if (!exportAbort.signal.aborted) await copyFile(path, outPath);
      return { filename: null, sizeBytes: 0 };
    },
  });
  exported.catch(() => {});
  try {
    await Promise.race([exported, new Promise((_, reject) => {
      exportAbort.signal.addEventListener('abort', () => reject(new Error(signal.aborted
        ? 'cancelled'
        : `the PortOS Browser did not finish the export within ${Math.round(limits.browserWaitMs / 1000)}s`)), { once: true });
      if (exportAbort.signal.aborted) reject(new Error('cancelled'));
      timer = setTimeout(stop, limits.browserWaitMs);
    })]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
  }
  return html;
}

// Take the audio from the song's public video, which stays downloadable
// without signing in even when Suno withholds the audio file.
async function audioFromPublicVideo(songId, dir, outPath, signal, onExtracting) {
  const video = await fetchPublicBinary(sunoCdnVideoUrl(songId), {
    timeoutMs: AUDIO_TIMEOUT_MS, headers: HEADERS, maxBytes: VIDEO_MAX_BYTES, throwOnUnsafe: false,
  });
  if (signal.aborted) return;
  if (!video?.buffer?.byteLength || !isVideoResponse(video.contentType)) throw new Error('its public video was refused too');
  onExtracting();
  const videoPath = join(dir, 'song.mp4');
  await writeFile(videoPath, video.buffer);
  await extractAudio(videoPath, outPath, signal);
}

// jobId -> { clients, lastPayload, status, canceled }
const importJobs = new Map();

export const attachSunoImportSseClient = (jobId, res) => attachSse(importJobs, jobId, res);

export const __testing = { importJobs, limits };

/** Cancel an in-flight import; false when the job is unknown or already over. */
export function cancelSunoImport(jobId) {
  const job = importJobs.get(jobId);
  if (!job || job.canceled || job.status !== 'running') return false;
  job.canceled = true;
  job.abort.abort(); // stops an audio extraction in flight
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
  const job = { id: jobId, status: 'running', clients: [], canceled: false, abort: new AbortController() };
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
      if (abortIfCanceled()) return;

      broadcastSse(job, { type: 'progress', percent: 20, stage: 'downloading' });
      let song = parseSunoSongPage(html || '', songId);
      const audio = await fetchSongAudio([song.audioUrl, sunoCdnAudioUrl(songId)]);
      if (abortIfCanceled()) return;
      dir = await mkdtemp(join(tmpdir(), 'portos-sunoimport-'));
      let tempPath;
      if (audio) {
        tempPath = join(dir, `song.${/mp4|m4a|aac/i.test(audio.contentType) ? 'm4a' : 'mp3'}`);
        await writeFile(tempPath, audio.buffer);
      } else {
        // Suno withholds the audio file from anonymous requests. A public song
        // (its anonymous page names it) takes the fast public-video route first;
        // a private or unpublished one shows nothing anonymously, so the
        // signed-in browser export comes first.
        tempPath = join(dir, 'song.m4a');
        // Progress only moves forward, even when the browser leg follows a failed extraction.
        let percent = 20;
        const viaVideo = () => audioFromPublicVideo(songId, dir, tempPath, job.abort.signal, () => {
          percent = 70;
          broadcastSse(job, { type: 'progress', percent, stage: 'extracting' });
        });
        const viaBrowser = async () => {
          percent = Math.max(percent, 30);
          broadcastSse(job, { type: 'progress', percent, stage: 'exporting' });
          const signedIn = parseSunoSongPage(await exportThroughBrowser(songId, tempPath, job.abort.signal), songId);
          // Fill only what the anonymous page lacked.
          song = { ...song, title: song.title || signedIn.title, lyrics: song.lyrics || signedIn.lyrics, style: song.style || signedIn.style };
        };
        const routes = song.title ? [viaVideo, viaBrowser] : [viaBrowser, viaVideo];
        const failures = [];
        for (const route of routes) {
          const failure = await route().then(() => null, (err) => err);
          if (abortIfCanceled()) return;
          if (!failure) break;
          console.warn(`⚠️ Suno import ${shortId(jobId)}: ${failure.message}`);
          failures.push(failure.message);
        }
        if (failures.length === routes.length) {
          throw new Error(`Suno would not hand over this song's audio. For a private or unpublished song, sign in to Suno in the PortOS Browser and try again (${failures.join('; ')})`);
        }
      }

      broadcastSse(job, { type: 'progress', percent: 90, stage: 'importing' });
      const title = song.title || 'Suno song';
      const ext = tempPath.endsWith('.m4a') ? 'm4a' : 'mp3';
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

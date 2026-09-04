/**
 * YouTube → Brain ingest.
 *
 * "I watched (or want to work from) this video; pull it into PortOS as content
 * I've consumed and deliberately kept." One job, three independent switches:
 *
 *   - `captureTranscript` — pull the captions and turn them into readable prose,
 *     stored locally AND mirrored into the Obsidian vault as a note (so the
 *     transcript is greppable/linkable next to everything else the user keeps).
 *   - `downloadVideo`     — the full video, into the shared media library via
 *     the same `source: 'download'` history entry the Dev Tools downloader writes.
 *   - `ingestAudio`       — an mp3 kept alongside the transcript.
 *
 * Regardless of which are on, an ingest ALWAYS records the consumption itself:
 *   - a brain `links` record (federated — this is the "saved for future
 *     reference" artifact that peers should see), and
 *   - a `media.watch` human-activity event (machine-local, so the video shows up
 *     on the Timeline alongside passively-synced watch history).
 *
 * Finally, when the user supplies an `agentPrompt` at ingest time, a CoS task is
 * queued that points an agent at the freshly-stored transcript with that prompt
 * — "here is what I want done with this content." No prompt, no task: PortOS
 * must never queue AI work the user didn't ask for (root AGENTS.md, AI Provider
 * Usage Policy).
 *
 * Storage:
 *   data/brain/youtube/index.json          — machine-local ingest index (paths!)
 *   data/brain/youtube/<videoId>.md        — canonical transcript copy
 *   data/brain/youtube/<videoId>.mp3       — audio, when ingestAudio was on
 *   data/brain/youtube-ingest-settings.json — vault/folder + option defaults
 *
 * The index is deliberately NOT a synced brain store: every field in it is a
 * local filesystem path, an Obsidian vault id, or a local video-history id —
 * all machine-local, and federating them would poison peer reconcile the same
 * way the daily log's obsidian-locations sidecar would (see brainJournal.js).
 * The durable, federated record of "I kept this" is the links entry.
 */

import { spawn } from '../lib/childProcess.js';
import { readdir, readFile, rename, rm, stat, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { ServerError } from '../lib/errorHandler.js';
import { atomicWrite, ensureDir, PATHS, readJSONFile, shortId, tryReadFile } from '../lib/fileUtils.js';
import { findFfmpeg } from '../lib/ffmpeg.js';
import { findYtDlp } from '../lib/ytdlp.js';
import { killWithEscalation } from '../lib/killWithEscalation.js';
import { safeChildProcessOptions } from '../lib/processEnv.js';
import { attachSseClient as attachSse, broadcastSse, closeJobAfterDelay } from '../lib/sseUtils.js';
import { vttToPlainText } from '../lib/vttTranscript.js';
import { createMutex } from '../lib/asyncMutex.js';
import { downloadAudioToTempMp3 } from './ytdlpAudioImport.js';
import { downloadVideoIntoLibrary } from './videoDownload.js';
import { assertYoutubeVideoUrl, YOUTUBE_VIDEO_URL_RE } from '../lib/youtubeUrl.js';
// The pure half of the ingest — yt-dlp metadata normalization, the Obsidian
// note body, the CoS agent prompt, and the index's Obsidian-pointer rule — lives
// in lib/ so it is unit-testable without this module's spawn/store graph (#6015).
import {
  buildAgentTaskContext,
  buildIngestNote,
  formatDuration,
  parseVideoMetadata,
  resolveObsidianPointer,
  sanitizeFilename,
} from '../lib/youtubeIngestFormat.js';
import * as obsidian from './obsidian.js';
import * as brainStorage from './brainStorage.js';
import { createLinkFromUrl } from './brain.js';
import * as brainJournal from './brainJournal.js';
import { recordEvents } from './humanActivity.js';
// Straight from the task store rather than the cos.js facade — same reason
// referenceRepos.js does: it avoids pulling the whole Chief-of-Staff graph in
// behind a brain-side service. The `tasks:changed` event addTask emits is what
// cos.js listens on to spawn, so queueing behaves identically either way.
import { addTask } from './cosTaskStore.js';

// The accept rule and its validator are canonical in `lib/youtubeUrl.js` (#6014);
// these aliases keep the ingest's established names for existing importers.
export {
  YOUTUBE_VIDEO_URL_RE as YOUTUBE_INGEST_URL_RE,
  assertYoutubeVideoUrl as assertYoutubeIngestUrl,
};

// Bound resource use, same reasoning as the audio/video importers: a livestream
// archive or a 12-hour upload would otherwise download unbounded. Generous —
// conference talks and long-form podcasts are exactly what this feature is for.
export const INGEST_MAX_DURATION_SEC = 6 * 60 * 60; // 6 hours
export const INGEST_VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB
export const INGEST_AUDIO_MAX_BYTES = 512 * 1024 * 1024; // 512 MB

// `--dump-single-json` on a long video can be slow (yt-dlp negotiates formats);
// bound it so a wedged extractor can't hold a job open forever.
const METADATA_TIMEOUT_MS = 90_000;
const SUBTITLE_TIMEOUT_MS = 120_000;

const INGEST_DIR = join(PATHS.brain, 'youtube');
const INDEX_FILE = join(INGEST_DIR, 'index.json');
const SETTINGS_FILE = join(PATHS.brain, 'youtube-ingest-settings.json');

const DEFAULT_SETTINGS = {
  // null → inherit the Daily Log's vault, so a user who already pointed the
  // journal at Obsidian gets transcripts in the same vault with zero setup.
  obsidianVaultId: null,
  obsidianFolder: 'Consumed/YouTube',
  autoSync: true,
  // Quick-capture's advanced panel seeds its checkboxes from these.
  defaultCaptureTranscript: true,
  defaultDownloadVideo: false,
  defaultIngestAudio: false,
  taskPriority: 'MEDIUM',
};

// ─── Settings ──────────────────────────────────────────────────────────────

export async function getSettings() {
  await ensureDir(PATHS.brain);
  const loaded = await readJSONFile(SETTINGS_FILE, null);
  return loaded ? { ...DEFAULT_SETTINGS, ...loaded } : { ...DEFAULT_SETTINGS };
}

export async function updateSettings(partial) {
  const next = { ...(await getSettings()), ...partial };
  await atomicWrite(SETTINGS_FILE, next);
  return next;
}

/**
 * Which Obsidian vault transcripts go to: the explicit setting when present,
 * otherwise the Daily Log's vault. Returns null when neither is configured (the
 * ingest still succeeds — the local transcript copy is the canonical one).
 */
async function resolveVaultId(settings) {
  if (settings.obsidianVaultId) return settings.obsidianVaultId;
  const journalSettings = await brainJournal.getSettings().catch(() => null);
  return journalSettings?.obsidianVaultId || null;
}

// ─── Local ingest index ────────────────────────────────────────────────────

// Serialize read→modify→write of the index so two ingests finishing at once
// can't clobber each other's entry (single-user, but a "transcript only" job
// and a slow video job legitimately overlap).
const indexMutex = createMutex();

async function loadIndex() {
  await ensureDir(INGEST_DIR);
  const loaded = await readJSONFile(INDEX_FILE, {});
  return loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
}

// A first ingest only patches in the artifacts its switches produced, so seed
// the rest as explicit nulls — readers (and the client) get one record shape
// whether a video was ingested once for its transcript or three times for
// everything.
const NEW_INGEST = { transcript: null, obsidian: null, video: null, audio: null, taskId: null, agentPrompt: null, incomplete: null };

async function putIngest(videoId, patch) {
  return indexMutex(async () => {
    const index = await loadIndex();
    const existing = index[videoId] || null;
    const record = {
      ...(existing || NEW_INGEST),
      ...patch,
      videoId,
      ingestedAt: existing?.ingestedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    index[videoId] = record;
    await atomicWrite(INDEX_FILE, index);
    return record;
  });
}

/** Every ingest, newest first. */
export async function listIngests() {
  const index = await loadIndex();
  return Object.values(index).sort((a, b) => String(b.ingestedAt || '').localeCompare(String(a.ingestedAt || '')));
}

export async function getIngest(videoId) {
  const index = await loadIndex();
  return index[videoId] || null;
}

/** The stored transcript markdown, or null when this video has none. */
export async function getTranscript(videoId) {
  const record = await getIngest(videoId);
  if (!record?.transcript?.path) return null;
  return tryReadFile(record.transcript.path);
}

/**
 * Forget an ingest: removes the local transcript/audio files and the Obsidian
 * note, then drops the index entry. Deliberately leaves the links record, the
 * downloaded video, and the activity event alone — each has its own lifecycle
 * and its own UI to delete from, and silently nuking a user's media library
 * entry from a "remove this transcript" action would be a nasty surprise.
 */
export async function deleteIngest(videoId) {
  // Read the record and drop it inside ONE lock, then clean up its files:
  // reading outside the lock would unlink paths from a record a concurrent
  // re-ingest had already replaced, and would parse the whole index twice.
  const record = await indexMutex(async () => {
    const index = await loadIndex();
    const found = index[videoId] || null;
    if (!found) return null;
    delete index[videoId];
    await atomicWrite(INDEX_FILE, index);
    return found;
  });
  if (!record) return false;

  if (record.transcript?.path) await unlink(record.transcript.path).catch(() => {});
  if (record.audio?.path) await unlink(record.audio.path).catch(() => {});
  if (record.obsidian?.path && record.obsidian?.vaultId) {
    await obsidian.deleteNote(record.obsidian.vaultId, record.obsidian.path).catch(() => {});
  }
  console.log(`🧹 Removed YouTube ingest ${videoId}`);
  return true;
}

// ─── yt-dlp helpers ────────────────────────────────────────────────────────

// Run yt-dlp to completion, collecting stdout. Used for the two invocations that
// produce no progress stream (metadata dump, subtitle fetch); the long-running
// media downloads go through the shared audio/video cores instead.
function runYtDlp(ytDlp, args, { timeoutMs, registerProcess }) {
  return new Promise((resolve) => {
    const proc = spawn(ytDlp, args, safeChildProcessOptions({ stdio: ['ignore', 'pipe', 'pipe'] }));
    registerProcess?.(proc);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    // Both a user cancel and this timeout end the child with a signal, so the
    // signal alone can't tell them apart — and reporting a 90-second extractor
    // stall as "ingest cancelled" sends the user looking for a cancel they
    // never made. Record which one fired.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      registerProcess?.(null);
      resolve({ code: null, stdout, stderr, reason: `spawn failed: ${err.message}` });
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      registerProcess?.(null);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * Read the video's metadata and, when `subsDir` is given, write its English
 * caption files there — in ONE yt-dlp invocation.
 *
 * Doing them separately cost two full YouTube extractions (player-response +
 * format negotiation, several seconds each) of the same URL on the DEFAULT
 * ingest path. `--dump-single-json` normally implies `--simulate`, which would
 * skip writing the subtitle files, so `--no-simulate` is required alongside it
 * — the same yt-dlp quirk `--print` has, documented at length in
 * ytdlpAudioImport.js. Verified against a real video: the JSON lands on stdout
 * and the `.vtt` files land in `subsDir`.
 *
 * Returns the parsed metadata; the caller reads the caption files itself.
 */
async function fetchVideoInfo(ytDlp, url, registerProcess, { subsDir = null } = {}) {
  const result = await runYtDlp(
    ytDlp,
    [
      '--dump-single-json', '--no-playlist', '--no-warnings',
      ...(subsDir
        ? [
          '--no-simulate', '--skip-download',
          '--write-subs', '--write-auto-subs',
          // Prefer real English tracks; `en.*` also catches en-US/en-GB/en-orig.
          '--sub-langs', 'en.*,en',
          // yt-dlp can only *convert* subtitles with ffmpeg, but `--sub-format`
          // negotiates the download format directly — vtt is what YouTube serves
          // natively, so no conversion (and no ffmpeg dependency) is needed.
          '--sub-format', 'vtt/srt/best',
          '-o', join(subsDir, 'subs'),
        ]
        : ['--skip-download']),
      url,
    ],
    { timeoutMs: subsDir ? SUBTITLE_TIMEOUT_MS : METADATA_TIMEOUT_MS, registerProcess },
  );
  if (result.timedOut) {
    throw new Error(
      `yt-dlp timed out after ${Math.round((subsDir ? SUBTITLE_TIMEOUT_MS : METADATA_TIMEOUT_MS) / 1000)}s reading the video — YouTube may be throttling, or yt-dlp may need updating`,
    );
  }
  if (result.signal) throw new Error('canceled');
  if (result.code !== 0) {
    // yt-dlp's own stderr is the most actionable thing we have here (private
    // video, age gate, region block, extractor breakage all land differently).
    const detail = (result.stderr || result.reason || '').trim().split('\n').filter(Boolean).pop();
    throw new Error(detail || `yt-dlp exited ${result.code} while reading video metadata`);
  }
  return parseVideoMetadata(result.stdout);
}

/**
 * Read the caption files `fetchVideoInfo` wrote into `subsDir` and render them
 * as prose. Returns `{ text, language, source }` or null when the video had no
 * captions.
 *
 * yt-dlp names subtitle files `subs.<lang>.<ext>` and the language tag varies
 * (`en`, `en-US`, `en-orig`), so the produced file is discovered from disk
 * rather than assumed — the same "don't guess the filename" rule the video core
 * follows. `--sub-langs en.*,en` routinely writes MORE than one file (a real
 * upload yields both `subs.en-orig.vtt` and `subs.en.vtt`), so a plain `en`
 * track is preferred and the rest ignored, making the choice deterministic.
 *
 * `hasManualCaptions` comes from the same metadata dump — see parseVideoMetadata.
 */
async function readTranscriptFrom(subsDir, { hasManualCaptions } = {}) {
  const produced = (await readdir(subsDir).catch(() => [])).filter((n) => /\.(vtt|srt)$/i.test(n));
  const chosen = produced.find((n) => /\.en\.(vtt|srt)$/i.test(n)) || produced[0] || null;
  if (!chosen) return null;

  const raw = await readFile(join(subsDir, chosen), 'utf-8').catch(() => '');
  const text = vttToPlainText(raw);
  if (!text) return null;
  const langMatch = /\.([\w-]+)\.(vtt|srt)$/i.exec(chosen);
  return {
    text,
    language: langMatch ? langMatch[1] : 'en',
    source: hasManualCaptions ? 'captions' : 'auto-captions',
  };
}

// ─── Obsidian note ─────────────────────────────────────────────────────────

const buildNotePath = (settings, meta, capturedAt) => {
  const folder = (settings.obsidianFolder || '').replace(/^\/+|\/+$/g, '');
  const filename = `${capturedAt.slice(0, 10)} ${sanitizeFilename(meta.title)} (${meta.videoId}).md`;
  return folder ? `${folder}/${filename}` : filename;
};

// ─── Job orchestration ─────────────────────────────────────────────────────

// jobId -> { id, clients, lastPayload, process, canceled }
const ingestJobs = new Map();

export const attachIngestSseClient = (jobId, res) => attachSse(ingestJobs, jobId, res);

// Exposed for the same reason as videoDownload's — so the cancel path is
// reachable from a test instead of only from a live ingest.
export const __testing = { ingestJobs };

/**
 * Cancel an in-flight ingest. Returns false if the job is unknown or finished.
 *
 * The `canceled` flag matters independently of the child kill: an ingest is a
 * chain of steps, so cancelling between two of them (or during the non-spawn
 * persist phase) has no process to signal and is caught by the flag instead.
 */
export function cancelYoutubeIngest(jobId) {
  const job = ingestJobs.get(jobId);
  if (!job) return false;
  job.canceled = true;
  const proc = job.process;
  if (proc) {
    killWithEscalation(proc, { label: 'yt-dlp ingest', stillRunning: () => job.process === proc });
  }
  return true;
}

/**
 * Kick off an ingest. Returns `{ jobId, videoId }` immediately; the work runs
 * detached and streams progress over SSE. Terminal frames:
 * `{ type: 'complete', ingest }`, `{ type: 'error', error }`, `{ type: 'canceled' }`.
 *
 * @param {object}  opts
 * @param {string}  opts.url
 * @param {boolean} [opts.captureTranscript=true]
 * @param {boolean} [opts.downloadVideo=false]
 * @param {boolean} [opts.ingestAudio=false]
 * @param {string}  [opts.note]  Optional reason for keeping the link.
 * @param {string}  [opts.agentPrompt]  Non-empty → queue a CoS task pointed at the transcript.
 * @param {string[]} [opts.tags]
 * @param {string}  [opts.priority]     CoS task priority (defaults to the setting).
 */
export async function startYoutubeIngest({
  url,
  captureTranscript = true,
  downloadVideo = false,
  ingestAudio = false,
  note = '',
  agentPrompt = '',
  tags = [],
  priority,
} = {}) {
  const videoId = assertYoutubeVideoUrl(url);
  if (!captureTranscript && !downloadVideo && !ingestAudio) {
    throw new ServerError('Pick at least one of: transcript, video, audio', {
      status: 400,
      code: 'NOTHING_TO_INGEST',
    });
  }

  const ytDlp = await findYtDlp();
  if (!ytDlp) throw new ServerError('yt-dlp not found on PATH', { status: 500, code: 'YTDLP_MISSING' });
  // ffmpeg is only needed to merge video / transcode audio — a transcript-only
  // ingest must not fail on a machine that has yt-dlp but no ffmpeg.
  const ffmpeg = (downloadVideo || ingestAudio) ? await findFfmpeg() : null;
  if ((downloadVideo || ingestAudio) && !ffmpeg) {
    throw new ServerError('ffmpeg not found on PATH', { status: 500, code: 'FFMPEG_MISSING' });
  }

  const jobId = randomUUID();
  const job = { id: jobId, clients: [], process: null, canceled: false };
  ingestJobs.set(jobId, job);
  const cleanTags = tags.map((t) => String(t).trim()).filter(Boolean);
  const linkNote = typeof note === 'string' ? note.trim() : '';
  const prompt = String(agentPrompt || '').trim();
  console.log(`📺 YouTube ingest ${shortId(jobId)} — ${videoId} (transcript=${captureTranscript} video=${downloadVideo} audio=${ingestAudio})`);

  (async () => {
    const registerProcess = (proc) => { job.process = proc; };
    const stage = (name, percent) => broadcastSse(job, { type: 'progress', stage: name, ...(percent != null ? { percent } : {}) });
    // Non-fatal outcomes the user still needs told about (no captions, duplicate
    // task). Broadcast live AND replayed on the terminal frame — a client using
    // the generic single-slot SSE hook only reads the terminal payload, so a
    // warning-only frame would otherwise vanish.
    const warnings = [];
    const warn = (message) => {
      warnings.push(message);
      broadcastSse(job, { type: 'warning', message });
    };
    // One timestamp for the whole ingest. Taken up front so the note's
    // `captured:` frontmatter, the note's filename date, and the activity
    // event's `happenedAt` can't disagree — an ingest that downloads a 3-hour
    // video legitimately crosses midnight.
    const capturedAt = new Date().toISOString();
    // A dedicated per-job temp dir rather than a shared-prefix scan of
    // os.tmpdir() (which routinely holds thousands of entries on macOS): the
    // captions are found with a 2-entry readdir and removed with one rm.
    const subsDir = captureTranscript ? join(tmpdir(), `portos-yt-subs-${jobId}`) : null;
    // What this run actually put on disk, accumulated as each stage lands.
    // Persisted even when a LATER stage fails: a transcript written before a
    // failed audio download is a real file in a real vault, and without an index
    // record it is invisible to the list and unreachable by deleteIngest —
    // an orphan the user has no way to clean up.
    const landed = { transcript: null, obsidian: null, video: null, audio: null };
    // The prior record for this video, if any — supplies the Obsidian note path
    // and link id to reuse so a re-ingest updates rather than forks.
    let prior = null;
    // The id the artifact FILES were written under — meta.videoId once the
    // metadata call names it, the URL-derived guess before that. The catch needs
    // it to key the partial record, and  is scoped to the try.
    let resolvedVideoId = videoId;

    // Every await in this fire-and-forget coordinator must sit INSIDE the try:
    // there is no request lifecycle to bubble to, so a rejection escaping it
    // takes the whole Node process down (root AGENTS.md, no-try/catch exception).
    try {
      // Read once: the vault/folder decision and the CoS task priority both come
      // from here, and an ingest should use one settings snapshot throughout.
      const settings = await getSettings();
      await ensureDir(INGEST_DIR);
      if (subsDir) await ensureDir(subsDir);

      // Metadata AND captions come back from a single yt-dlp extraction.
      stage(captureTranscript ? 'transcript' : 'metadata');
      const meta = await fetchVideoInfo(ytDlp, url, registerProcess, { subsDir });
      // yt-dlp's own id is authoritative; ours is a URL-shape guess.
      meta.videoId = meta.videoId || videoId;
      resolvedVideoId = meta.videoId;
      prior = await getIngest(meta.videoId);
      broadcastSse(job, { type: 'metadata', title: meta.title, channel: meta.channel, durationSec: meta.durationSec });
      if (job.canceled) throw new Error('canceled');

      // ── Transcript ──
      // Written AND mirrored before the media downloads: the note doesn't depend
      // on them, and doing it here lets the caption text (up to a few hundred KB)
      // be collected before a multi-GB video download rather than being pinned in
      // this closure across it.
      let transcriptPath = null;
      if (captureTranscript) {
        const transcript = await readTranscriptFrom(subsDir, { hasManualCaptions: meta.hasManualCaptions });
        if (transcript) {
          const markdown = buildIngestNote({ meta, url, transcript, tags: cleanTags, agentPrompt: prompt, capturedAt });
          transcriptPath = join(INGEST_DIR, `${meta.videoId}.md`);
          await atomicWrite(transcriptPath, markdown);
          landed.transcript = {
            path: transcriptPath,
            language: transcript.language,
            source: transcript.source,
            chars: transcript.text.length,
          };

          if (settings.autoSync) {
            const vaultId = await resolveVaultId(settings);
            // Re-ingesting on a later day must UPDATE the note this video
            // already has, not mint a second one at today's date — the index
            // tracks a single location, so a fresh path would orphan the old
            // note where deleteIngest can never reach it.
            const notePath = vaultId
              ? (prior?.obsidian?.vaultId === vaultId && prior.obsidian.path
                ? prior.obsidian.path
                : buildNotePath(settings, meta, capturedAt))
              : null;
            // Best-effort: the transcript is already stored locally, so a vault
            // on an unplugged drive must not fail the ingest.
            const written = notePath
              ? await obsidian.upsertNote(vaultId, notePath, markdown)
                .catch((err) => { console.error(`📓 Obsidian sync failed for ${meta.videoId}: ${err.message}`); return null; })
              : null;
            landed.obsidian = resolveObsidianPointer({ written, vaultId, notePath, prior });
          }
        } else {
          // Not fatal — the user still gets the link record, the activity event,
          // and whatever media they asked for. Say so explicitly rather than
          // completing with a silently empty transcript.
          warn('No captions were available for this video');
        }
      }

      // ── Video ──
      // Cancel is checked BEFORE each download, not only after: cancelling
      // while no child is running (during the transcript write or the Obsidian
      // round-trip) only sets the flag, and without this the job would go on to
      // start a multi-gigabyte download the user just cancelled.
      if (job.canceled) throw new Error('canceled');
      if (downloadVideo) {
        stage('video', 0);
        // Same call the Dev Tools downloader makes, so the video lands in the
        // media library identically — history entry, thumbnail, index event and
        // partial-file cleanup all included.
        const result = await downloadVideoIntoLibrary({
          url,
          ytDlp,
          ffmpeg,
          maxBytes: INGEST_VIDEO_MAX_BYTES,
          maxDurationSec: INGEST_MAX_DURATION_SEC,
          onProgress: ({ percent, stage: s }) => broadcastSse(job, { type: 'progress', stage: s || 'video', percent }),
          registerProcess,
        });
        if (result.outcome === 'canceled' || job.canceled) throw new Error('canceled');
        if (result.outcome === 'failed') throw new Error(`video download failed — ${result.reason}`);
        landed.video = { historyId: result.entry.id, filename: result.entry.filename };
      }

      // ── Audio ──
      if (job.canceled) throw new Error('canceled');
      if (ingestAudio) {
        stage('audio', 0);
        const tempPrefix = `portos-yt-ingest-${jobId}`;
        const result = await downloadAudioToTempMp3({
          url,
          ytDlp,
          ffmpeg,
          tempPrefix,
          maxBytes: INGEST_AUDIO_MAX_BYTES,
          maxDurationSec: INGEST_MAX_DURATION_SEC,
          onProgress: ({ percent, stage: s }) => broadcastSse(job, { type: 'progress', stage: s || 'audio', percent }),
          registerProcess,
        });
        if (result.outcome === 'canceled' || job.canceled) throw new Error('canceled');
        if (result.outcome === 'failed') throw new Error(`audio download failed — ${result.reason}`);
        // Kept next to the transcript rather than pushed into the music library:
        // a two-hour talk is reference material, not a track.
        const audioPath = join(INGEST_DIR, `${meta.videoId}.mp3`);
        await rename(result.outPath, audioPath);
        const bytes = await stat(audioPath).then((s) => s.size).catch(() => null);
        landed.audio = { path: audioPath, bytes };
      }

      // ── Persist the "I consumed and kept this" artifacts ──
      if (job.canceled) throw new Error('canceled');
      stage('saving');

      // The federated record of "saved for future reference". Re-ingesting a
      // video reuses the existing link instead of forking a duplicate. Prefer
      // the id this VIDEO already recorded over a URL string match: the same
      // video is reachable as youtu.be/<id> and youtube.com/watch?v=<id>, and
      // getLinkByUrl compares exact strings, so the second form would otherwise
      // mint a second link for a video the index already knows.
      const priorLink = prior?.linkId ? await brainStorage.getLinkById(prior.linkId).catch(() => null) : null;
      const existingLink = priorLink || await brainStorage.getLinkByUrl(url).catch(() => null);
      const linkFields = {
        title: meta.title,
        description: [meta.channel, formatDuration(meta.durationSec)].filter(Boolean).join(' · '),
        linkType: 'reference',
        tags: ['youtube', ...cleanTags],
      };
      if (linkNote) linkFields.note = linkNote;
      // A reused link still has to pick up THIS ingest's tags and the resolved
      // title/channel — otherwise tags typed on a re-ingest are silently dropped
      // and a link first saved as a bare URL keeps its hostname title forever.
      const link = existingLink
        ? (await brainStorage.updateLink(existingLink.id, {
          ...linkFields,
          tags: [...new Set([...(existingLink.tags || []), ...linkFields.tags])],
        }).catch(() => existingLink)) || existingLink
        : await createLinkFromUrl(url, { ...linkFields, autoClone: false });

      // Machine-local consumption log, so the video shows on the Timeline next
      // to passively-synced watch history. Best-effort: a DB hiccup must not
      // fail an ingest whose files are already on disk. The `ingest:` dedupe
      // prefix keeps this distinct from youtubeSync's watch-history rows.
      await recordEvents([{
        source: 'youtube',
        kind: 'media.watch',
        happenedAt: capturedAt,
        durationS: meta.durationSec,
        title: meta.title,
        summary: meta.channel,
        url,
        dedupeKey: `ingest:${meta.videoId}`,
        metadata: { videoId: meta.videoId, channel: meta.channel, ingest: true, tags: cleanTags },
      }]).catch((err) => console.error(`🗓️  Activity event failed for ${meta.videoId}: ${err.message}`));

      // ── Follow-up agent task ──
      let taskId = null;
      if (prompt) {
        stage('queueing');
        const task = await addTask({
          description: `Review ingested YouTube content: ${meta.title} [${meta.videoId}]`,
          context: buildAgentTaskContext({
            meta, url, agentPrompt: prompt, transcriptPath, notePath: landed.obsidian?.path, tags: cleanTags,
            hasTranscript: !!transcriptPath,
          }),
          priority: priority || settings.taskPriority,
          // Analysis + issue-filing, not a code change: no worktree, no PR.
          useWorktree: false,
          openPR: false,
          simplify: false,
          reviewLoop: false,
        }, 'user').catch((err) => {
          console.error(`❌ CoS task for ingest ${meta.videoId} failed: ${err.message}`);
          return null;
        });
        if (task?.duplicate) {
          warn('A review task for this video is already queued');
        }
        taskId = task?.id || null;
      }

      // Artifact keys are written only for the switches this run actually ran.
      // putIngest merges over any prior record, so re-ingesting a video for its
      // audio alone must not null out the transcript entry whose file is still
      // sitting on disk — absent means "this run didn't touch it", not "gone".
      // Within a switch that DID run, an explicit null is meaningful (transcript
      // requested but the video had no captions), so it is written.
      const record = await putIngest(meta.videoId, {
        url,
        title: meta.title,
        channel: meta.channel,
        channelUrl: meta.channelUrl,
        durationSec: meta.durationSec,
        publishedAt: meta.publishedAt,
        ...(captureTranscript ? { transcript: landed.transcript, obsidian: landed.obsidian } : {}),
        ...(downloadVideo ? { video: landed.video } : {}),
        ...(ingestAudio ? { audio: landed.audio } : {}),
        ...(prompt ? { taskId, agentPrompt: prompt } : {}),
        linkId: link?.id || null,
        tags: cleanTags,
        // Clears the marker a previously-failed run left, so a record that has
        // since completed does not keep reporting itself as partial.
        incomplete: null,
      });

      console.log(`📺 YouTube ingest ${shortId(jobId)} complete — "${meta.title}"${taskId ? ` → task ${taskId}` : ''}`);
      broadcastSse(job, { type: 'complete', ingest: record, warnings });
    } catch (err) {
      const message = err?.message || String(err);
      // Record whatever DID land before the failure. A transcript written (and
      // mirrored into the vault) before a failed audio download is a real file
      // the user now owns; without an index entry it never shows in the list and
      // deleteIngest can never remove it — a permanent orphan. Keyed on the id
      // we actually resolved, so a failure before the metadata call (which is
      // what names the video) has nothing to write and correctly skips this.
      if (landed.transcript || landed.obsidian || landed.video || landed.audio) {
        await putIngest(resolvedVideoId, {
          url,
          ...(landed.transcript ? { transcript: landed.transcript, obsidian: landed.obsidian } : {}),
          ...(landed.video ? { video: landed.video } : {}),
          ...(landed.audio ? { audio: landed.audio } : {}),
          tags: cleanTags,
          incomplete: message === 'canceled' || job.canceled ? 'canceled' : message,
        }).catch((e) => console.error(`📺 Could not record partial ingest ${videoId}: ${e.message}`));
      }
      if (message === 'canceled' || job.canceled) {
        console.log(`🛑 YouTube ingest ${shortId(jobId)} cancelled`);
        broadcastSse(job, { type: 'canceled' });
      } else {
        console.error(`❌ YouTube ingest ${shortId(jobId)} failed: ${message}`);
        broadcastSse(job, { type: 'error', error: message });
      }
    } finally {
      // One rm regardless of outcome — the caption files are scratch, and on
      // cancel/failure yt-dlp may have written some of them.
      if (subsDir) await rm(subsDir, { recursive: true, force: true }).catch(() => {});
      closeJobAfterDelay(ingestJobs, jobId);
    }
  })();

  return { jobId, videoId };
}

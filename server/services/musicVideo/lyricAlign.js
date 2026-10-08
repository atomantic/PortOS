/**
 * Music Video word-level lyric alignment (#9074).
 *
 * Runs when the director clicks Align words (or a line's Re-align), or as a
 * step of an autopilot run the director started. ffmpeg decodes the audio to
 * 16 kHz mono PCM; a whisper runner (lyricTranscriber.js — whisper-cli with a
 * music-grade model, the voice STT endpoint, or a temporary whisper-server)
 * returns word timings, and those timings are aligned to the director's
 * spelling. With a vocal stem attached, its phrases anchor short mix windows
 * so post-silence words cannot drift back into the instrumental gap. A line
 * the singer skipped stays inside its own window
 * and does not move the lines around it. Times the director already set are
 * kept. A whole-song alignment also names the analysis sections after the
 * lyric sheet's `[Verse]`/`[Chorus]` headers (lyricMarkers.js).
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { musicVideoAudioAnalysisSchema } from '../../lib/musicVideoValidation.js';
import { getProject, updateProject } from './projects.js';
import {
  alignDirectorWords,
  lyricAlignFfmpegArgs,
  dropNonLyricWords,
  mergeTranscripts,
  detectVocalPhrases,
  phraseWindows,
  snapLineStarts,
  vocalPcm,
  wavDurationSec,
  pickAlignmentPath,
  findSilentWords,
} from './lyricAlignCore.js';
import { relabelAnalysisSections } from './lyricMarkers.js';

async function decodeSourceToWav(sourcePath) {
  const ffmpeg = await findFfmpeg();
  if (!ffmpeg) {
    throw new ServerError('ffmpeg is required to align lyrics to the vocal.', { status: 500, code: 'FFMPEG_MISSING' });
  }
  const dir = await mkdtemp(join(tmpdir(), 'lyric-align-'));
  const outPath = join(dir, 'vocal.wav');
  try {
    const result = await runFfmpegProcess({ bin: ffmpeg, args: lyricAlignFfmpegArgs(sourcePath, outPath) });
    if (!result.ok) {
      console.error(`❌ Lyric alignment could not decode audio: ${result.reason}`);
      throw new ServerError('Could not decode the song for lyric alignment.', { status: 422, code: 'LYRIC_ALIGN_DECODE_FAILED' });
    }
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Lazy: the runner pulls the download/spawn helpers only an alignment needs.
async function resolveTranscriber(onDownloadProgress) {
  const { resolveAlignmentTranscriber } = await import('./lyricTranscriber.js');
  return resolveAlignmentTranscriber({ onDownloadProgress });
}

const audioKey = (project) => `${project?.trackId ?? ''}\u0000${project?.uploadedAudioFilename ?? ''}\u0000${project?.vocalStemFilename ?? ''}`;
const textKey = (cues) => (cues || []).map((cue) => `${cue.id ?? ''}\u0000${cue.text ?? ''}`).join('\n');

function alignmentPrompt(cues) {
  return (cues || []).map((cue) => cue?.text || '').filter(Boolean).join('\n').slice(0, 800);
}

/** The analysis with its sections named after the lyric sheet, or null when nothing changes. */
function relabeledAnalysis(project, cues) {
  const analysis = project.audioAnalysis;
  if (!analysis || !Array.isArray(analysis.sections)) return null;
  const next = relabelAnalysisSections(analysis, cues, project.lyricMarkers || []);
  if (JSON.stringify(next.sections) === JSON.stringify(analysis.sections)) return null;
  const parsed = musicVideoAudioAnalysisSchema.safeParse(next);
  return parsed.success ? parsed.data : null;
}

/**
 * Align one project's lyric cues. `cueId` re-aligns that line only: a line
 * with a window is transcribed on its own slice; a line without one is placed
 * against the full vocal so a repeated chorus keeps its own occurrence.
 */
export async function alignProjectLyrics(projectId, options = {}) {
  const onProgress = options.onProgress || (() => {});
  const checkCancel = () => {
    if (options.isCancelled?.()) throw Object.assign(new Error('cancelled'), { canceled: true });
  };
  const deps = {
    getProject,
    updateProject,
    resolveAudio: pickAlignmentPath,
    decodeAudio: decodeSourceToWav,
    resolveTranscriber,
    ...options.deps,
  };
  const cueId = options.cueId || null;
  const project = await deps.getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const cues = Array.isArray(project.lyricCues) ? project.lyricCues : [];
  if (cues.length === 0) {
    throw new ServerError('Add lyric lines before aligning words.', { status: 400, code: 'NO_LYRICS' });
  }
  const cue = cueId ? cues.find((entry) => entry.id === cueId) : null;
  if (cueId && !cue) throw new ServerError('That lyric line is no longer on the project.', { status: 404, code: 'NOT_FOUND' });

  onProgress({ stage: 'decoding' });
  const { path: audioPath, source, mixPath } = await deps.resolveAudio(project);
  const wav = await deps.decodeAudio(audioPath);
  const mixWav = mixPath ? await deps.decodeAudio(mixPath) : null;
  checkCancel();
  const windowed = cue
    && typeof cue.startSec === 'number'
    && typeof cue.endSec === 'number'
    && cue.endSec > cue.startSec
    ? { startSec: cue.startSec, endSec: cue.endSec }
    : null;
  const region = windowed || { startSec: 0, endSec: null };
  const promptCues = windowed ? [cue] : cues;
  const prompt = alignmentPrompt(promptCues);
  const phrases = mixWav ? detectVocalPhrases(vocalPcm(wav)) : [];
  const windows = mixWav ? phraseWindows(phrases, wavDurationSec(mixWav)) : [];

  onProgress({ stage: 'loading-model' });
  const transcriber = await deps.resolveTranscriber((download) => onProgress({ stage: 'downloading-model', percent: download.percent }));
  let recognized;
  try {
    if (mixWav) {
      recognized = [];
      const inRegion = (window) => !windowed || (window.endSec > windowed.startSec && window.startSec < windowed.endSec);
      const total = windows.filter(inRegion).length;
      let done = 0;
      // The runner already slices and offsets each result onto the song clock.
      // Sequential calls bound memory/GPU use and release one runner per song.
      for (const [index, window] of windows.entries()) {
        if (!inRegion(window)) continue;
        checkCancel();
        onProgress({ stage: 'transcribing', current: done + 1, total, percent: Math.round((done / total) * 100) });
        done += 1;
        const startSec = Math.max(window.startSec, windowed?.startSec ?? 0);
        const endSec = Math.min(window.endSec, windowed?.endSec ?? Infinity);
        const words = await transcriber.transcribe(mixWav, { startSec, endSec, prompt });
        const previous = windows[index - 1];
        const following = windows[index + 1];
        const ownStart = Math.max(startSec, previous ? (previous.endSec + window.startSec) / 2 : startSec);
        const ownEnd = Math.min(endSec, following ? (window.endSec + following.startSec) / 2 : endSec);
        recognized.push(...words.filter((word) => {
          const midpoint = (word.startSec + word.endSec) / 2;
          return midpoint >= ownStart && midpoint < ownEnd;
        }));
      }
      recognized = dropNonLyricWords(recognized);
    } else {
      checkCancel();
      onProgress({ stage: 'transcribing', current: 1, total: 1, percent: 0 });
      recognized = mergeTranscripts(await transcriber.transcribe(wav, { ...region, prompt }), [], promptCues.map((entry) => entry.text).join('\n'));
    }
  } finally {
    await Promise.resolve(transcriber.release?.()).catch((err) => console.error(`❌ Could not stop the alignment runner: ${err.message}`));
  }
  checkCancel();
  if (!mixWav && !windowed && recognized.length === 0) {
    throw new ServerError(
      'Speech-to-text heard no words in this audio. Check the song has vocals, then try Align words again.',
      { status: 422, code: 'LYRIC_ALIGN_EMPTY' },
    );
  }

  const fresh = await deps.getProject(projectId);
  if (!fresh || audioKey(fresh) !== audioKey(project)) {
    throw new ServerError('The song changed while lyrics were aligning. Run Align words again.', { status: 409, code: 'MUSIC_VIDEO_AUDIO_CHANGED' });
  }
  const freshCues = Array.isArray(fresh.lyricCues) ? fresh.lyricCues : [];
  if (textKey(freshCues) !== textKey(cues)) {
    throw new ServerError('The lyric lines changed while they were aligning. Run Align words again.', { status: 409, code: 'LYRIC_ALIGN_TEXT_CHANGED' });
  }

  onProgress({ stage: 'saving', percent: 100 });
  const align = (entries) => {
    const aligned = alignDirectorWords(entries, recognized, { phraseAnchored: Boolean(mixWav) });
    return mixWav ? snapLineStarts(aligned, phrases.map((phrase) => phrase.startSec), entries) : aligned;
  };
  let nextCues;
  if (windowed) {
    const [aligned] = align([freshCues.find((entry) => entry.id === cue.id)]);
    nextCues = freshCues.map((entry) => (entry.id === cue.id ? { ...entry, ...aligned, id: entry.id } : entry));
  } else {
    const aligned = align(freshCues);
    nextCues = cueId ? freshCues.map((entry, index) => (entry.id === cueId ? aligned[index] : entry)) : aligned;
  }
  const matched = nextCues.reduce((sum, entry) => sum + (entry.words || []).filter((word) => word.conf === 'matched').length, 0);
  console.log(`🎤 Aligned lyric words from the ${source}${mixWav ? ' + mix' : ''} via ${transcriber.kind} (${matched} words matched)`);
  // Provenance is project-wide, so only a whole-song pass may change it; one
  // re-aligned line leaves the other lines' timings as stale as they were.
  const patch = { lyricCues: nextCues, ...(cueId ? {} : { lyricAlignSource: source }) };
  if (mixWav) {
    const silentWords = findSilentWords(nextCues, vocalPcm(wav)).length;
    patch.lyricAlignSilentWords = silentWords;
    if (silentWords > 0) console.warn(`⚠️ ${silentWords} aligned lyric words sit in silence in the vocal stem; their timing is suspect`);
  }
  if (!cueId) {
    const analysis = relabeledAnalysis(fresh, nextCues);
    if (analysis) patch.audioAnalysis = analysis;
  }
  return deps.updateProject(projectId, patch);
}

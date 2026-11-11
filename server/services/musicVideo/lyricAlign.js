/**
 * User-triggered lyric alignment. Vocal stems use known-text MMS_FA CTC;
 * legacy master-only callers retain Whisper until they consent to separation.
 * No models load at boot. Director cue boundaries and concurrent edits survive.
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
  mergeTranscripts,
  vocalPcm,
  wavDurationSec,
  pickAlignmentPath,
  findSilentWords,
} from './lyricAlignCore.js';
import { spreadVocableCues } from './lyricVocables.js';
import { relabelAnalysisSections } from '../../lib/lyricMarkers.js';

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

// Measure the aligned word span, not an authored cue boundary that may be wider.
function compressedWords(words) {
  // CTC stores milliseconds; compare there so a span of exactly 0.15 s/word
  // cannot become compressed through floating-point subtraction.
  return words.length >= 3 && Math.round((words.at(-1).endSec - words[0].startSec) * 1000) < words.length * 150;
}

/**
 * Align one project's lyric cues. `cueId` re-aligns that line only: a timed
 * line uses its own slice; an untimed line uses full-song CTC context so a
 * repeated chorus keeps its own occurrence.
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
    masterFilename: async (record) => (await import('./songAudio.js')).currentMasterFilename(record),
    decodeAudio: decodeSourceToWav,
    resolveTranscriber,
    requireCtcPlatform: async () => (await import('./lyricForcedAlign.js')).requireLyricAlignPlatform(),
    forceAlign: async (...args) => (await import('./lyricForcedAlign.js')).forceAlignLyrics(...args),
    separateVocals: async (...args) => (await import('./vocalSeparation.js')).separateProjectVocals(...args),
    stemOfOldSong: async (record) => {
      if (!record.vocalStemFilename || !record.vocalStemMasterFilename) return false;
      const { resolveMasterAudioPath } = await import('./render.js');
      const { vocalStemMasterChanged } = await import('./vocalStem.js');
      return vocalStemMasterChanged(record, await resolveMasterAudioPath(record));
    },
    ...options.deps,
  };
  const cueId = options.cueId || null;
  let project = await deps.getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const cues = Array.isArray(project.lyricCues) ? project.lyricCues : [];
  if (cues.length === 0) {
    throw new ServerError('Add lyric lines before aligning words.', { status: 400, code: 'NO_LYRICS' });
  }
  const cue = cueId ? cues.find((entry) => entry.id === cueId) : null;
  if (cueId && !cue) throw new ServerError('That lyric line is no longer on the project.', { status: 404, code: 'NOT_FOUND' });

  const expectedTextKey = textKey(cues);
  // Explicit separation commits to CTC; refuse before provisioning Demucs.
  if (options.separateVocals === true) await deps.requireCtcPlatform();
  // A stem of the song's previous file is re-separated from the current one.
  if (options.separateVocals === true && (!project.vocalStemFilename || await deps.stemOfOldSong(project))) {
    onProgress({ stage: 'separating' });
    project = await deps.separateVocals(projectId, { onProgress, isCancelled: options.isCancelled });
    checkCancel();
  }
  const expectedAudioKey = audioKey(project);
  // A take replaced in place keeps the same track link, so audioKey cannot see it (#14793).
  const expectedMaster = await deps.masterFilename(project);
  onProgress({ stage: 'decoding' });
  const { path: audioPath, source } = await deps.resolveAudio(project);
  if (source === 'vocal-stem' && options.separateVocals !== true) await deps.requireCtcPlatform();
  const wav = await deps.decodeAudio(audioPath);
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
  let forcedWords = null;
  let stemPcm = null;
  let recognized = [];
  let kind;
  if (source === 'vocal-stem') {
    onProgress({ stage: 'loading-model' });
    checkCancel();
    stemPcm = vocalPcm(wav);
    const silentCount = (words) => findSilentWords([{ words }], stemPcm).length;
    // Both explicit cue alignment and automatic repairs use the same runner,
    // decoded stem, cancellation and progress callbacks. Save only once below.
    const alignStemCues = (entries, window) => deps.forceAlign(wav, entries, {
      ...window, onProgress, isCancelled: options.isCancelled,
    });
    forcedWords = await alignStemCues(promptCues, region);
    if (!cueId) {
      const wholeSongWords = forcedWords;
      forcedWords = [...wholeSongWords];
      const quality = wholeSongWords.map((words) => ({ compressed: compressedWords(words), silent: silentCount(words) }));
      for (let first = 0; first < cues.length;) {
        if (!quality[first].compressed && quality[first].silent === 0) { first++; continue; }
        let end = first + 1;
        while (end < cues.length && (quality[end].compressed || quality[end].silent > 0)) end++;
        checkCancel();
        const startSec = cues[first - 1]?.endSec ?? wholeSongWords[first - 1]?.at(-1)?.endSec ?? 0;
        const endSec = cues[end]?.startSec ?? wholeSongWords[end]?.[0]?.startSec ?? wavDurationSec(wav);
        if (endSec > startSec) {
          const retries = await alignStemCues(cues.slice(first, end), { startSec, endSec }).catch((err) => {
            if (err.canceled || !['LYRIC_ALIGN_CTC_FAILED', 'LYRIC_ALIGN_CTC_WINDOW_TOO_SHORT'].includes(err.code)) throw err;
            console.log(`⏭️ Skipped lyric repair for lines ${first + 1}-${end}: ${err.code}`);
            return null;
          });
          checkCancel();
          if (retries) for (let index = first; index < end; index++) {
            const retry = retries[index - first];
            const original = wholeSongWords[index];
            const { compressed, silent } = quality[index];
            if (!retry || retry.length !== original.length || compressedWords(retry)) continue;
            // A retained neighbor still occupies its whole-song span.
            if (retry[0]?.startSec < forcedWords[index - 1]?.at(-1)?.endSec
              || retry.at(-1)?.endSec > forcedWords[index + 1]?.[0]?.startSec) continue;
            const retrySilent = silentCount(retry);
            if (retrySilent < silent || (compressed && retrySilent <= silent)) forcedWords[index] = retry;
          }
        }
        first = end;
      }
    }
    kind = 'MMS_FA';
  } else {
    onProgress({ stage: 'loading-model' });
    const transcriber = await deps.resolveTranscriber((download) => onProgress({ stage: 'downloading-model', percent: download.percent }));
    kind = transcriber.kind;
    try {
      checkCancel();
      onProgress({ stage: 'transcribing', current: 1, total: 1, percent: 0 });
      recognized = mergeTranscripts(await transcriber.transcribe(wav, { ...region, prompt }), [], promptCues.map((entry) => entry.text).join('\n'));
    } finally {
      await Promise.resolve(transcriber.release?.()).catch((err) => console.error(`❌ Could not stop the alignment runner: ${err.message}`));
    }
    if (!windowed && recognized.length === 0) {
      throw new ServerError('Speech-to-text heard no words in this audio. Check the song has vocals, then try Align words again.',
        { status: 422, code: 'LYRIC_ALIGN_EMPTY' });
    }
  }
  checkCancel();

  const fresh = await deps.getProject(projectId);
  if (!fresh || audioKey(fresh) !== expectedAudioKey || (await deps.masterFilename(fresh)) !== expectedMaster) {
    throw new ServerError('The song changed while lyrics were aligning. Run Align words again.', { status: 409, code: 'MUSIC_VIDEO_AUDIO_CHANGED' });
  }
  const freshCues = Array.isArray(fresh.lyricCues) ? fresh.lyricCues : [];
  if (textKey(freshCues) !== expectedTextKey) {
    throw new ServerError('The lyric lines changed while they were aligning. Run Align words again.', { status: 409, code: 'LYRIC_ALIGN_TEXT_CHANGED' });
  }

  checkCancel();
  onProgress({ stage: 'saving', percent: 100 });
  const align = (entries) => {
    if (!forcedWords) return alignDirectorWords(entries, recognized).map((entry) => ({ ...entry, suspect: false }));
    return entries.map((entry, index) => {
      const words = forcedWords[index];
      return { ...entry, words, matched: words.length ? 1 : 0, suspect: compressedWords(words),
        startSec: entry.startSec ?? words[0]?.startSec ?? null,
        endSec: entry.endSec ?? words.at(-1)?.endSec ?? null };
    });
  };
  let nextCues;
  if (windowed) {
    const [aligned] = align([freshCues.find((entry) => entry.id === cue.id)]);
    nextCues = freshCues.map((entry) => (entry.id === cue.id ? { ...entry, ...aligned, id: entry.id } : entry));
  } else {
    const aligned = align(freshCues);
    nextCues = cueId ? freshCues.map((entry, index) => (entry.id === cueId ? aligned[index] : entry)) : aligned;
  }
  // CTC cannot anchor held oohs/ahs; re-time those runs from the stem energy.
  if (stemPcm && !cueId) nextCues = spreadVocableCues(nextCues, stemPcm, wavDurationSec(wav));
  // Words placed where the vocal stem is silent are flagged on their line, not
  // refused: the director needs the timings saved to hear and fix them.
  const silentWords = stemPcm ? findSilentWords(nextCues, stemPcm) : [];
  nextCues = nextCues.map((entry) => {
    const rest = { ...entry };
    delete rest.silentWords;
    const indices = silentWords.filter((word) => word.cueId === entry.id).map((word) => word.wordIndex);
    return indices.length ? { ...rest, silentWords: indices } : rest;
  });
  const matched = nextCues.reduce((sum, entry) => sum + (entry.words || []).filter((word) => word.conf === 'matched').length, 0);
  console.log(`🎤 Aligned lyric words from the ${source} via ${kind} (${matched} words matched)`);
  // Provenance is project-wide, so only a whole-song pass may change it; one
  // re-aligned line leaves the other lines' timings as stale as they were.
  const patch = { lyricCues: nextCues, ...(cueId ? {} : { lyricAlignSource: source, ...(expectedMaster ? { lyricTimingMasterFilename: expectedMaster } : {}) }) };
  if (stemPcm) patch.lyricAlignSilentWords = silentWords.length;
  if (!cueId) {
    const analysis = relabeledAnalysis(fresh, nextCues);
    if (analysis) patch.audioAnalysis = analysis;
  }
  return deps.updateProject(projectId, patch);
}

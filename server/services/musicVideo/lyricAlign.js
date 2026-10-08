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
    decodeAudio: decodeSourceToWav,
    resolveTranscriber,
    forceAlign: async (...args) => (await import('./lyricForcedAlign.js')).forceAlignLyrics(...args),
    separateVocals: async (...args) => (await import('./vocalSeparation.js')).separateProjectVocals(...args),
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
  if (!project.vocalStemFilename && options.separateVocals === true) {
    onProgress({ stage: 'separating' });
    project = await deps.separateVocals(projectId, { onProgress, isCancelled: options.isCancelled });
    checkCancel();
  }
  const expectedAudioKey = audioKey(project);
  onProgress({ stage: 'decoding' });
  const { path: audioPath, source } = await deps.resolveAudio(project);
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
  let recognized = [];
  let kind;
  if (source === 'vocal-stem') {
    onProgress({ stage: 'loading-model' });
    checkCancel();
    forcedWords = await deps.forceAlign(wav, promptCues, {
      ...region, onProgress, isCancelled: options.isCancelled,
    });
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
  if (!fresh || audioKey(fresh) !== expectedAudioKey) {
    throw new ServerError('The song changed while lyrics were aligning. Run Align words again.', { status: 409, code: 'MUSIC_VIDEO_AUDIO_CHANGED' });
  }
  const freshCues = Array.isArray(fresh.lyricCues) ? fresh.lyricCues : [];
  if (textKey(freshCues) !== expectedTextKey) {
    throw new ServerError('The lyric lines changed while they were aligning. Run Align words again.', { status: 409, code: 'LYRIC_ALIGN_TEXT_CHANGED' });
  }

  onProgress({ stage: 'saving', percent: 100 });
  const align = (entries) => {
    if (!forcedWords) return alignDirectorWords(entries, recognized);
    return entries.map((entry, index) => {
      const words = forcedWords[index];
      return { ...entry, words, matched: words.length ? 1 : 0,
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
  const matched = nextCues.reduce((sum, entry) => sum + (entry.words || []).filter((word) => word.conf === 'matched').length, 0);
  console.log(`🎤 Aligned lyric words from the ${source} via ${kind} (${matched} words matched)`);
  // Provenance is project-wide, so only a whole-song pass may change it; one
  // re-aligned line leaves the other lines' timings as stale as they were.
  const patch = { lyricCues: nextCues, ...(cueId ? {} : { lyricAlignSource: source }) };
  if (source === 'vocal-stem') {
    const silentWords = findSilentWords(nextCues, vocalPcm(wav)).length;
    patch.lyricAlignSilentWords = silentWords;
    const checkedCues = cueId ? nextCues.filter((entry) => entry.id === cueId) : nextCues;
    if (findSilentWords(checkedCues, vocalPcm(wav)).length > 0) {
      throw new ServerError('Some lyric words aligned to silence. Check that the lyrics match the vocal, then re-align.',
        { status: 422, code: 'LYRIC_ALIGN_SILENT_WORDS' });
    }
  }
  if (!cueId) {
    const analysis = relabeledAnalysis(fresh, nextCues);
    if (analysis) patch.audioAnalysis = analysis;
  }
  return deps.updateProject(projectId, patch);
}

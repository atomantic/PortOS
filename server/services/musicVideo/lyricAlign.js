/**
 * Music Video word-level lyric alignment (#9074).
 *
 * Runs only when the director clicks Align words (or a line's Re-align).
 * The vocal stem is the audio when one is attached; otherwise the master.
 * ffmpeg decodes that file to 16 kHz mono PCM, the local whisper.cpp server
 * returns word timings, and those timings are aligned to the director's
 * spelling. A line the singer skipped stays inside its own window and does
 * not move the lines around it. Times the director already set are kept.
 */

import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ServerError } from '../../lib/errorHandler.js';
import { findFfmpeg, runFfmpegProcess } from '../../lib/ffmpeg.js';
import { transcribe } from '../voice/stt.js';
import { getProject, updateProject } from './projects.js';
import {
  alignDirectorWords,
  explainSttFailure,
  lyricAlignChunkSec,
  lyricAlignFfmpegArgs,
  mergeChunkWords,
  pickAlignmentPath,
  planAudioChunks,
  sliceWav,
  wavDurationSec,
} from './lyricAlignCore.js';

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

const audioKey = (project) => `${project?.trackId ?? ''}\u0000${project?.uploadedAudioFilename ?? ''}`;
const textKey = (cues) => (cues || []).map((cue) => `${cue.id ?? ''}\u0000${cue.text ?? ''}`).join('\n');

function alignmentPrompt(cues) {
  return (cues || []).map((cue) => cue?.text || '').filter(Boolean).join('\n').slice(0, 800);
}

async function recognizeRegion(wav, region, transcribeFn, prompt) {
  const duration = wavDurationSec(wav);
  if (!(duration > 0)) {
    throw new ServerError('Could not read the decoded vocal.', { status: 422, code: 'LYRIC_ALIGN_DECODE_FAILED' });
  }
  const regionStart = Math.max(0, region.startSec || 0);
  const regionEnd = Math.min(duration, region.endSec ?? duration);
  if (!(regionEnd > regionStart)) {
    throw new ServerError('That lyric line has no audio window to align.', { status: 422, code: 'LYRIC_ALIGN_NO_WINDOW' });
  }
  const span = regionEnd - regionStart;
  const chunks = planAudioChunks(span, { chunkSec: lyricAlignChunkSec() }).map((chunk) => ({
    startSec: regionStart + chunk.startSec,
    endSec: regionStart + chunk.endSec,
  }));
  console.log(`🎤 Aligning lyric words (${chunks.length} whisper ${chunks.length === 1 ? 'chunk' : 'chunks'})`);
  const results = [];
  for (const chunk of chunks) {
    const slice = sliceWav(wav, chunk.startSec, chunk.endSec);
    let result;
    try {
      result = await transcribeFn(slice, {
        verbose: true,
        mimeType: 'audio/wav',
        filename: 'lyric-align.wav',
        prompt,
      });
    } catch (err) {
      console.error(`❌ Lyric alignment speech-to-text failed: ${err.message}`);
      throw new ServerError(explainSttFailure(err), { status: 503, code: 'LYRIC_ALIGN_STT_UNAVAILABLE' });
    }
    results.push({
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      words: (result?.words || []).map((word) => ({
        text: word.text,
        startSec: word.startSec,
        endSec: word.endSec,
      })),
    });
  }
  return mergeChunkWords(results);
}

/**
 * Align one project's lyric cues. `cueId` re-aligns that line only: a line
 * with a window is transcribed on its own slice; a line without one is placed
 * against the full vocal so a repeated chorus keeps its own occurrence.
 */
export async function alignProjectLyrics(projectId, options = {}) {
  const deps = {
    getProject,
    updateProject,
    resolveAudio: pickAlignmentPath,
    decodeAudio: decodeSourceToWav,
    transcribe,
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

  const { path: audioPath, source } = await deps.resolveAudio(project);
  const wav = await deps.decodeAudio(audioPath);
  const duration = wavDurationSec(wav);
  const windowed = cue
    && typeof cue.startSec === 'number'
    && typeof cue.endSec === 'number'
    && cue.endSec > cue.startSec
    ? { startSec: cue.startSec, endSec: cue.endSec }
    : null;
  const region = windowed
    ? { startSec: windowed.startSec, endSec: Math.min(windowed.endSec, duration || windowed.endSec) }
    : { startSec: 0, endSec: duration };
  const recognized = await recognizeRegion(wav, region, deps.transcribe, alignmentPrompt(windowed ? [cue] : cues));
  if (!windowed && recognized.length === 0) {
    throw new ServerError(
      'Speech-to-text returned no words for this audio. Enable the local whisper server in Settings → Voice and try Align words again.',
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

  let nextCues;
  if (windowed) {
    const [aligned] = alignDirectorWords([cue], recognized);
    nextCues = freshCues.map((entry) => (entry.id === cue.id ? { ...entry, ...aligned, id: entry.id } : entry));
  } else {
    const aligned = alignDirectorWords(freshCues, recognized);
    nextCues = cueId ? freshCues.map((entry, index) => (entry.id === cueId ? aligned[index] : entry)) : aligned;
  }
  console.log(`🎤 Aligned lyric words from the ${source}`);
  return deps.updateProject(projectId, { lyricCues: nextCues });
}

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
import { STT_TIMEOUT_MS, transcribe } from '../voice/stt.js';
import { getProject, updateProject } from './projects.js';
import { lyricTokens } from './timedText.js';
import { resolveVocalStemPath } from './vocalStem.js';

export const LYRIC_ALIGN_SAMPLE_RATE = 16000;
export const LYRIC_ALIGN_CHUNK_SEC = 20;
export const LYRIC_ALIGN_OVERLAP_SEC = 2;

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Audio seconds per whisper request. The wall-clock budget is STT_TIMEOUT_MS;
 * eight seconds of that stay free for the model to start, and a chunk never
 * grows past LYRIC_ALIGN_CHUNK_SEC.
 */
export function lyricAlignChunkSec(timeoutMs = STT_TIMEOUT_MS) {
  const budgetSec = (Number(timeoutMs) || STT_TIMEOUT_MS) / 1000;
  return Math.max(8, Math.min(LYRIC_ALIGN_CHUNK_SEC, budgetSec - 8));
}

export function lyricAlignFfmpegArgs(sourcePath, outPath) {
  return ['-v', 'error', '-i', sourcePath, '-ac', '1', '-ar', String(LYRIC_ALIGN_SAMPLE_RATE), '-c:a', 'pcm_s16le', '-y', outPath];
}

export function explainSttFailure(err) {
  const msg = String(err?.message || '');
  if (/whisper inference failed:/i.test(msg)) {
    return 'Speech-to-text rejected the audio. Enable the local whisper server in Settings → Voice and try Align words again.';
  }
  if (/timed out|timeout|aborted/i.test(msg)) {
    return 'Speech-to-text did not answer in time. Enable the local whisper server in Settings → Voice and try Align words again.';
  }
  return 'Speech-to-text is not running. Enable the local whisper server in Settings → Voice, then try Align words again.';
}

/** Chunk a song so each whisper call fits the timeout, overlapping the seams. */
export function planAudioChunks(durationSec, { chunkSec = lyricAlignChunkSec(), overlapSec = LYRIC_ALIGN_OVERLAP_SEC } = {}) {
  if (!(durationSec > 0)) return [];
  const overlap = Math.min(overlapSec, chunkSec / 4);
  if (durationSec <= chunkSec + 0.05) return [{ startSec: 0, endSec: round3(durationSec) }];
  const stride = Math.max(0.5, chunkSec - overlap);
  const chunks = [];
  for (let start = 0; start < durationSec - 0.05; start += stride) {
    const end = Math.min(durationSec, start + chunkSec);
    chunks.push({ startSec: round3(start), endSec: round3(end) });
    if (end >= durationSec - 0.001) break;
  }
  return chunks;
}

/**
 * Join overlapped chunk transcripts. Each word is kept by the chunk that owns
 * its midpoint, and chunk-relative times are shifted onto the song clock.
 */
export function mergeChunkWords(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  const owned = [];
  for (let i = 0; i < list.length; i++) {
    const chunk = list[i];
    const prev = list[i - 1];
    const next = list[i + 1];
    const ownStart = prev ? (chunk.startSec + prev.endSec) / 2 : chunk.startSec;
    const ownEnd = next ? (next.startSec + chunk.endSec) / 2 : chunk.endSec;
    for (const word of chunk.words || []) {
      const startSec = Number(word.startSec) + chunk.startSec;
      const endSec = Number(word.endSec) + chunk.startSec;
      if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
      const mid = (startSec + endSec) / 2;
      if (mid < ownStart || (next && mid >= ownEnd)) continue;
      owned.push({ text: String(word.text || ''), startSec, endSec });
    }
  }
  return owned;
}

/** Glue a contraction fragment ("'s") onto the previous recognized word. */
export function glueContractions(words) {
  const out = [];
  for (const word of words || []) {
    const text = String(word?.text ?? '').trim();
    const startSec = Number(word?.startSec);
    const endSec = Number(word?.endSec);
    if (!text || !Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
    if (out.length && /^['’]/.test(text)) {
      const prev = out[out.length - 1];
      prev.text += text;
      prev.endSec = Math.max(prev.endSec, endSec);
      continue;
    }
    out.push({ text, startSec, endSec });
  }
  return out;
}

function recognizedTokens(words) {
  const out = [];
  for (const word of glueContractions(words)) {
    const tokens = lyricTokens(word.text);
    if (tokens.length === 0) continue;
    if (tokens.length === 1) {
      out.push({ key: tokens[0].key, startSec: word.startSec, endSec: word.endSec });
      continue;
    }
    const weights = tokens.map((token) => Math.max(1, token.key.length));
    const total = weights.reduce((sum, n) => sum + n, 0);
    const span = Math.max(0, word.endSec - word.startSec);
    let cursor = word.startSec;
    tokens.forEach((token, index) => {
      const dur = span * (weights[index] / total);
      const endSec = index === tokens.length - 1 ? word.endSec : cursor + dur;
      out.push({ key: token.key, startSec: cursor, endSec });
      cursor = endSec;
    });
  }
  return out;
}

// Earliest still-available equal token. Repeated choruses stay in order
// because a match consumes that recognizer word.
function alignTokenIndexes(director, recognized) {
  const matchOf = new Array(director.length).fill(-1);
  let cursor = 0;
  for (let i = 0; i < director.length; i++) {
    for (let j = cursor; j < recognized.length; j++) {
      if (recognized[j].key !== director[i].key) continue;
      matchOf[i] = j;
      cursor = j + 1;
      break;
    }
  }
  return matchOf;
}

function distribute(tokens, left, right) {
  const span = Math.max(0, right - left);
  const weights = tokens.map((token) => Math.max(1, token.w.length));
  const total = weights.reduce((sum, n) => sum + n, 0);
  let cursor = left;
  return tokens.map((token, index) => {
    const dur = total ? span * (weights[index] / total) : 0;
    const startSec = round3(cursor);
    const endSec = round3(index === tokens.length - 1 ? left + span : cursor + dur);
    cursor += dur;
    return {
      w: token.w,
      startSec,
      endSec: endSec < startSec ? startSec : endSec,
      conf: 'interpolated',
    };
  });
}

function cueWindow(cue) {
  if (typeof cue?.startSec === 'number' && typeof cue?.endSec === 'number' && cue.endSec > cue.startSec) {
    return { startSec: cue.startSec, endSec: cue.endSec };
  }
  return null;
}

function matchedWord(token) {
  const startSec = round3(token.match.startSec);
  return {
    w: token.w,
    startSec,
    endSec: round3(Math.max(token.match.startSec, token.match.endSec)),
    conf: 'matched',
  };
}

function writeSegment(placed, cue, segment, left, right) {
  const windowed = !segment.entireCue ? cueWindow(cue) : null;
  let segLeft = left;
  let segRight = right;
  if (windowed) {
    segLeft = Math.min(windowed.endSec, Math.max(windowed.startSec, segLeft));
    segRight = Math.max(segLeft, Math.min(windowed.endSec, segRight));
  }
  if (!(segRight >= segLeft)) segRight = segLeft;
  const words = distribute(segment.tokens, segLeft, segRight);
  words.forEach((word, index) => {
    const token = segment.tokens[index];
    placed[token.cueIndex][token.wordIndex] = word;
  });
}

// One pass over the whole lyric, so an unmatched run that crosses lines shares
// the gap between the matched words around it. A line the singer skipped, and
// that already has a window, takes that window instead of the gap.
function placeAll(cues, byCue, recognized) {
  const flat = [];
  byCue.forEach((tokens, cueIndex) => {
    const entireCue = tokens.length > 0 && tokens.every((token) => !token.match);
    tokens.forEach((token, wordIndex) => flat.push({ ...token, cueIndex, wordIndex, entireCue }));
  });
  const placed = byCue.map((tokens) => new Array(tokens.length));
  const timelineStart = recognized[0]?.startSec ?? 0;
  const timelineEnd = recognized.length ? recognized[recognized.length - 1].endSec : timelineStart;
  let i = 0;
  while (i < flat.length) {
    if (flat[i].match) {
      placed[flat[i].cueIndex][flat[i].wordIndex] = matchedWord(flat[i]);
      i += 1;
      continue;
    }
    let j = i;
    while (j < flat.length && !flat[j].match) j += 1;
    const prev = i > 0 ? placed[flat[i - 1].cueIndex][flat[i - 1].wordIndex] : null;
    const next = j < flat.length ? flat[j].match : null;
    const left = prev ? prev.endSec : timelineStart;
    const right = next ? next.startSec : timelineEnd;
    const segments = [];
    for (const token of flat.slice(i, j)) {
      const last = segments[segments.length - 1];
      if (!last || last.cueIndex !== token.cueIndex) {
        segments.push({ cueIndex: token.cueIndex, tokens: [token], entireCue: token.entireCue });
      } else last.tokens.push(token);
    }
    const flex = [];
    for (const segment of segments) {
      const windowed = segment.entireCue ? cueWindow(cues[segment.cueIndex]) : null;
      if (windowed) writeSegment(placed, cues[segment.cueIndex], { ...segment, entireCue: true }, windowed.startSec, windowed.endSec);
      else flex.push(segment);
    }
    if (flex.length) {
      const weights = flex.map((segment) => segment.tokens.reduce((sum, token) => sum + Math.max(1, token.w.length), 0));
      const total = weights.reduce((sum, n) => sum + n, 0);
      let cursor = left;
      const span = Math.max(0, right - left);
      flex.forEach((segment, index) => {
        const segRight = index === flex.length - 1 ? left + span : cursor + span * (weights[index] / total);
        writeSegment(placed, cues[segment.cueIndex], segment, cursor, segRight);
        cursor = segRight;
      });
    }
    i = j;
  }
  return placed;
}

function applyWordTimes(cue, words) {
  const next = { ...cue, words };
  if (next.startSec == null && words.length) next.startSec = words[0].startSec;
  if (next.endSec == null && words.length) next.endSec = words[words.length - 1].endSec;
  if (typeof next.startSec === 'number' && typeof next.endSec === 'number' && next.endSec <= next.startSec) {
    if (cue.endSec == null) next.endSec = null;
    if (cue.startSec == null) next.startSec = null;
  }
  return next;
}

/**
 * Align director cue text to recognized words.
 * Matched words take the recognizer's times. Unmatched runs are interpolated
 * by character count between their matched neighbours, and a line that has a
 * window keeps a fully unmatched run inside that window.
 * A cue's startSec/endSec is filled from its words only when that side is null.
 */
export function alignDirectorWords(cues, recognizedWords) {
  const list = Array.isArray(cues) ? cues : [];
  const director = [];
  list.forEach((cue, cueIndex) => {
    for (const token of lyricTokens(cue?.text)) director.push({ ...token, cueIndex });
  });
  const recognized = recognizedTokens(recognizedWords);
  const matchOf = alignTokenIndexes(director, recognized);
  const byCue = list.map(() => []);
  director.forEach((token, index) => {
    const recIndex = matchOf[index];
    byCue[token.cueIndex].push({
      w: token.w,
      match: recIndex >= 0 ? recognized[recIndex] : null,
    });
  });
  const placed = placeAll(list, byCue, recognized);
  return list.map((cue, cueIndex) => {
    const words = (placed[cueIndex] || []).filter(Boolean);
    if (words.length === 0) {
      const cleared = { ...cue };
      delete cleared.words;
      return cleared;
    }
    return applyWordTimes(cue, words);
  });
}

export function encodePcm16Wav(sampleCount, sampleRate = LYRIC_ALIGN_SAMPLE_RATE) {
  const count = Math.max(0, sampleCount | 0);
  const dataBytes = count * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

export function wavInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let offset = 12;
  let sampleRate = 0;
  let blockAlign = 2;
  let dataOffset = 0;
  let dataBytes = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      sampleRate = buf.readUInt32LE(body + 4);
      blockAlign = buf.readUInt16LE(body + 12) || 2;
    } else if (id === 'data') {
      dataOffset = body;
      dataBytes = Math.min(size, Math.max(0, buf.length - body));
      break;
    }
    offset = body + size + (size % 2);
    if (size < 0) break;
  }
  if (!sampleRate || !dataOffset) return null;
  return { sampleRate, blockAlign, dataOffset, dataBytes, sampleCount: Math.floor(dataBytes / blockAlign) };
}

export function wavDurationSec(buf) {
  const info = wavInfo(buf);
  if (!info?.sampleRate) return null;
  return info.sampleCount / info.sampleRate;
}

export function sliceWav(buf, startSec, endSec) {
  const info = wavInfo(buf);
  if (!info) throw new ServerError('Decoded audio was not a PCM WAV.', { status: 422, code: 'LYRIC_ALIGN_DECODE_FAILED' });
  const start = Math.max(0, Math.min(info.sampleCount, Math.round(startSec * info.sampleRate)));
  const end = Math.max(start, Math.min(info.sampleCount, Math.round(endSec * info.sampleRate)));
  const out = encodePcm16Wav(end - start, info.sampleRate);
  buf.copy(out, 44, info.dataOffset + start * info.blockAlign, info.dataOffset + end * info.blockAlign);
  return out;
}

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

export async function pickAlignmentPath(project, io = {}) {
  const resolveStem = io.resolveStem || resolveVocalStemPath;
  const resolveMaster = io.resolveMaster || (async (record) => {
    const { resolveMasterAudioPath } = await import('./render.js');
    return resolveMasterAudioPath(record);
  });
  const stem = resolveStem(project);
  if (stem) return { path: stem, source: 'vocal-stem' };
  return { path: await resolveMaster(project), source: 'master' };
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
  const chunks = planAudioChunks(span).map((chunk) => ({
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
  const windowed = cue && cueWindow(cue);
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

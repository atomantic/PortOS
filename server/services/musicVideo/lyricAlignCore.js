/**
 * Pure lyric-alignment steps (#9074): chunking, whisper-word merge, and
 * matching the director's spelling to recognized times. The service in
 * lyricAlign.js is what the route calls.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { STT_TIMEOUT_MS } from '../voice/stt.js';
import { lyricKey, lyricTokens } from './timedText.js';
import { resolveVocalStemPath } from './vocalStem.js';

const LYRIC_ALIGN_SAMPLE_RATE = 16000;
const LYRIC_ALIGN_CHUNK_SEC = 20;
const LYRIC_ALIGN_OVERLAP_SEC = 2;

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * Audio seconds per whisper request. The wall-clock budget is STT_TIMEOUT_MS;
 * eight seconds of that stay free for the model to start, and a chunk never
 * grows past LYRIC_ALIGN_CHUNK_SEC.
 */
function lyricAlignChunkSec(timeoutMs = STT_TIMEOUT_MS) {
  const budgetSec = (Number(timeoutMs) || STT_TIMEOUT_MS) / 1000;
  return Math.max(8, Math.min(LYRIC_ALIGN_CHUNK_SEC, budgetSec - 8));
}

function lyricAlignFfmpegArgs(sourcePath, outPath) {
  return ['-v', 'error', '-i', sourcePath, '-ac', '1', '-ar', String(LYRIC_ALIGN_SAMPLE_RATE), '-c:a', 'pcm_s16le', '-y', outPath];
}

function explainSttFailure(err) {
  const msg = String(err?.message || '');
  if (/whisper inference failed:/i.test(msg)) {
    return 'The whisper server rejected the audio. Try Align words again; if it keeps failing, check the whisper server log.';
  }
  if (/timed out|timeout|aborted/i.test(msg)) {
    return 'The whisper server did not answer in time. Try Align words again.';
  }
  return 'The whisper server stopped answering during alignment. Try Align words again.';
}

/** Chunk a song so each whisper call fits the timeout, overlapping the seams. */
function planAudioChunks(durationSec, { chunkSec = lyricAlignChunkSec(), overlapSec = LYRIC_ALIGN_OVERLAP_SEC } = {}) {
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
function mergeChunkWords(chunks) {
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

const SPECIAL_TOKEN = /^(?:\[_[A-Z0-9_]*\]|<\|.*?\|>)$/;

/**
 * Word timings from a whisper.cpp CLI `-ojf` (full JSON) file. Offsets are
 * milliseconds. Run with `-ml 1 -sow`, each `transcription` entry is one word
 * (" I'm" = tokens " I" + "'m"); entries holding several words are split on
 * the leading space whisper puts on a word's first token. Special tokens
 * (`[_BEG_]`, `[_TT_150]`) and empty entries are dropped.
 * @returns {Array<{ text: string, startSec: number, endSec: number }>}
 */
function parseWhisperCliWords(data) {
  const segments = Array.isArray(data?.transcription) ? data.transcription : [];
  const out = [];
  for (const segment of segments) {
    const tokens = (Array.isArray(segment?.tokens) ? segment.tokens : []).filter((token) => {
      const text = typeof token?.text === 'string' ? token.text : '';
      return text.trim() && !SPECIAL_TOKEN.test(text.trim())
        && Number.isFinite(token?.offsets?.from) && Number.isFinite(token?.offsets?.to);
    });
    if (tokens.length === 0) {
      const text = String(segment?.text || '').trim();
      const from = segment?.offsets?.from;
      const to = segment?.offsets?.to;
      if (text && !SPECIAL_TOKEN.test(text) && Number.isFinite(from) && Number.isFinite(to) && to >= from) {
        out.push({ text, startSec: from / 1000, endSec: to / 1000 });
      }
      continue;
    }
    let current = null;
    for (const token of tokens) {
      const startSec = token.offsets.from / 1000;
      const endSec = Math.max(startSec, token.offsets.to / 1000);
      const text = token.text.trim();
      if (!current || /^\s/.test(token.text)) {
        current = { text, startSec, endSec };
        out.push(current);
      } else {
        current.text += text;
        current.endSec = Math.max(current.endSec, endSec);
      }
    }
  }
  return dropNonLyricWords(out);
}

const NON_LYRIC_PAREN = /music|applause|laugh|inaudible|instrumental|singing|vocaliz|humming|silence|no speech/i;
const CLOSERS = { '*': '*', '[': ']', '(': ')' };

/**
 * Remove the recognizer's sound captions ("*sad music*", "[Music]",
 * "(upbeat music)", "♪"). A caption may span several words; an opener with no
 * closer within a few words is treated as sung text.
 */
function dropNonLyricWords(words) {
  const list = Array.isArray(words) ? words : [];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const text = String(list[i]?.text || '').trim();
    if (!text || /^[♪♫]+$/.test(text)) continue;
    const opener = CLOSERS[text[0]];
    if (opener) {
      let end = -1;
      for (let k = i; k < Math.min(list.length, i + 6); k++) {
        const t = String(list[k]?.text || '').trim();
        if ((k > i || t.length > 1) && t.endsWith(opener)) { end = k; break; }
      }
      if (end >= 0) {
        const caption = list.slice(i, end + 1).map((w) => w.text).join(' ');
        if (text[0] !== '(' || NON_LYRIC_PAREN.test(caption)) { i = end; continue; }
      }
    }
    out.push(list[i]);
  }
  return out;
}

// A recognizer stuck on one word ("no, no, no, no, no…") emits a run far
// longer than the sheet ever sings. A run is suspect at this length unless the
// lyrics themselves repeat that word as many times.
const HALLUCINATED_RUN = 4;

function longestRuns(keys) {
  const runs = new Map();
  let prev = null;
  let run = 0;
  for (const key of keys) {
    run = key === prev ? run + 1 : 1;
    prev = key;
    if (run > (runs.get(key) || 0)) runs.set(key, run);
  }
  return runs;
}

// One "word" that is a syllable looped many times ("na-na-na-na-na…"), which a
// recognizer emits across a stretch it could not follow.
function isLoopedToken(text) {
  const parts = String(text || '').toLowerCase().split(/[-\s,.!?]+/).filter(Boolean);
  return parts.length >= HALLUCINATED_RUN && new Set(parts).size <= 2;
}

function flagHallucinations(words, allowedRuns, vocab) {
  const keys = words.map((word) => lyricKey(word.text));
  const flagged = words.map((word, index) => isLoopedToken(word.text) && !vocab.has(keys[index]));
  let start = 0;
  for (let i = 1; i <= keys.length; i++) {
    if (i < keys.length && keys[i] === keys[start] && keys[i]) continue;
    const length = i - start;
    const key = keys[start];
    if (key && length >= HALLUCINATED_RUN && length > (allowedRuns.get(key) || 0) + 1) {
      for (let k = start; k < i; k++) flagged[k] = true;
    }
    start = i;
  }
  return flagged;
}

/**
 * Merge a vocal-stem transcript with a full-mix transcript. The stem is the
 * cleaner signal and is kept wherever it holds up; a recognizer can still loop
 * on an isolated vocal and emit a run of one word ("no, no, no…") or one
 * syllable repeated across a whole phrase ("na-na-na…"). Those stretches are
 * dropped and filled with the mix's words for the same time span. With no
 * stem transcript the mix is used alone, minus its own loops.
 * Returns one time-ordered word list.
 */
function mergeTranscripts(primary, secondary, lyricText = '') {
  const a = Array.isArray(primary) ? primary : [];
  const b = Array.isArray(secondary) ? secondary : [];
  const lyricKeys = lyricTokens(lyricText).map((token) => token.key);
  const vocab = new Set(lyricKeys);
  const allowed = longestRuns(lyricKeys);
  const clean = (words) => {
    const flags = flagHallucinations(words, allowed, vocab);
    return { kept: words.filter((_, index) => !flags[index]), flagged: words.filter((_, index) => flags[index]) };
  };
  const main = clean(a);
  const other = clean(b);
  if (a.length === 0) return other.kept.slice().sort((x, y) => x.startSec - y.startSec);
  // Spans the stem got wrong, merged when they touch.
  const spans = [];
  for (const word of main.flagged) {
    const last = spans[spans.length - 1];
    if (last && word.startSec <= last.endSec + 0.5) last.endSec = Math.max(last.endSec, word.endSec);
    else spans.push({ startSec: word.startSec, endSec: word.endSec });
  }
  const inSpan = (word) => {
    const mid = (Number(word.startSec) + Number(word.endSec)) / 2;
    return spans.some((span) => mid >= span.startSec && mid <= span.endSec);
  };
  return [...main.kept, ...other.kept.filter(inSpan)].sort((x, y) => x.startSec - y.startSec);
}

/** Glue a contraction fragment ("'s") onto the previous recognized word. */
function glueContractions(words) {
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

// Give an instant (from == to) recognized word the time up to the next word,
// at most MIN_LINE_SEC, so it can anchor a line.
function widenInstants(tokens) {
  return tokens.map((token, index) => {
    if (token.endSec > token.startSec) return token;
    const next = tokens[index + 1];
    const ceiling = next && next.startSec > token.startSec ? next.startSec : token.startSec + MIN_LINE_SEC;
    return { ...token, endSec: Math.min(ceiling, token.startSec + MIN_LINE_SEC) };
  });
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
  return widenInstants(out);
}

// True when a and b differ by one insertion, deletion or substitution.
function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// How strongly a sung word matches a recognized one: exact keys beat a
// one-letter slip ("gonna"/"gona"), which only counts on words long enough
// that a slip is not a different word.
function tokenScore(a, b) {
  if (a === b) return 3;
  if (a.length >= 4 && b.length >= 4 && a[0] === b[0] && withinOneEdit(a, b)) return 2;
  return 0;
}

// Past this many DP cells (~32 MB of Int32) the greedy matcher is used.
const MAX_ALIGN_DP_CELLS = 8_000_000;

// Earliest still-available equal token. Kept for inputs too large for the DP.
function greedyTokenIndexes(director, recognized) {
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

/**
 * Order-preserving best match of the sung words to the recognized ones (a
 * weighted longest common subsequence). A greedy "next equal word" matcher
 * lets one word the recognizer missed ("the") latch onto the same word a
 * verse later, and every line in between loses its timing; the DP only takes
 * a match when it does not cost more matches elsewhere. Repeated choruses
 * stay in order because a recognized word is used once.
 */
function alignTokenIndexes(director, recognized) {
  const n = director.length;
  const m = recognized.length;
  if (n === 0 || m === 0) return new Array(n).fill(-1);
  if ((n + 1) * (m + 1) > MAX_ALIGN_DP_CELLS) return greedyTokenIndexes(director, recognized);
  const width = m + 1;
  const score = new Int32Array((n + 1) * width);
  for (let i = 1; i <= n; i++) {
    const a = director[i - 1].key;
    for (let j = 1; j <= m; j++) {
      const up = score[(i - 1) * width + j];
      const left = score[i * width + j - 1];
      let best = up > left ? up : left;
      const s = tokenScore(a, recognized[j - 1].key);
      if (s > 0) {
        const diag = score[(i - 1) * width + j - 1] + s;
        if (diag > best) best = diag;
      }
      score[i * width + j] = best;
    }
  }
  const matchOf = new Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const here = score[i * width + j];
    const s = tokenScore(director[i - 1].key, recognized[j - 1].key);
    if (s > 0 && here === score[(i - 1) * width + j - 1] + s) {
      matchOf[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (score[(i - 1) * width + j] >= score[i * width + j - 1]) {
      i -= 1;
    } else {
      j -= 1;
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

// A line the recognizer timed as an instant (a one-word "Hush." whose token
// has from == to) still gets a playable span.
const MIN_LINE_SEC = 0.25;

function applyWordTimes(cue, words) {
  const next = { ...cue, words };
  if (next.startSec == null && words.length) next.startSec = words[0].startSec;
  if (next.endSec == null && words.length) {
    const end = words[words.length - 1].endSec;
    next.endSec = typeof next.startSec === 'number' && end <= next.startSec ? round3(next.startSec + MIN_LINE_SEC) : end;
  }
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
function alignDirectorWords(cues, recognizedWords) {
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

function encodePcm16Wav(sampleCount, sampleRate = LYRIC_ALIGN_SAMPLE_RATE) {
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

function wavInfo(buf) {
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

function wavDurationSec(buf) {
  const info = wavInfo(buf);
  if (!info?.sampleRate) return null;
  return info.sampleCount / info.sampleRate;
}

function sliceWav(buf, startSec, endSec) {
  const info = wavInfo(buf);
  if (!info || info.blockAlign !== 2) {
    throw new ServerError('Decoded audio was not 16-bit mono PCM.', { status: 422, code: 'LYRIC_ALIGN_DECODE_FAILED' });
  }
  const start = Math.max(0, Math.min(info.sampleCount, Math.round(startSec * info.sampleRate)));
  const end = Math.max(start, Math.min(info.sampleCount, Math.round(endSec * info.sampleRate)));
  const out = encodePcm16Wav(end - start, info.sampleRate);
  const byteStart = info.dataOffset + start * info.blockAlign;
  const byteEnd = Math.min(buf.length, info.dataOffset + end * info.blockAlign);
  buf.copy(out, 44, byteStart, byteEnd);
  return out;
}

export async function pickAlignmentPath(project, io = {}) {
  const resolveStem = io.resolveStem || resolveVocalStemPath;
  const resolveMaster = io.resolveMaster || (async (record) => {
    const { resolveMasterAudioPath } = await import('./render.js');
    return resolveMasterAudioPath(record);
  });
  const stem = resolveStem(project);
  // With a stem, the mix is transcribed too: the two transcripts are merged so
  // a recognizer that loops on the isolated vocal is outvoted (mergeTranscripts).
  if (stem) return { path: stem, source: 'vocal-stem', mixPath: await resolveMaster(project) };
  return { path: await resolveMaster(project), source: 'master', mixPath: null };
}

export {
  lyricAlignChunkSec,
  lyricAlignFfmpegArgs,
  explainSttFailure,
  planAudioChunks,
  mergeChunkWords,
  mergeTranscripts,
  parseWhisperCliWords,
  dropNonLyricWords,
  alignDirectorWords,
  encodePcm16Wav,
  wavDurationSec,
  sliceWav,
};

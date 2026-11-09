/**
 * Held non-lexical lines ("Ooh, ooh", "Ah, ah") defeat CTC: with no consonants
 * to anchor on, the aligner squeezes them into a fraction of a second beside a
 * neighbouring line (#15528). After the CTC pass, each run of vocable-only
 * cues is re-spread over the voiced stem regions between its confident
 * neighbours, and those words are marked `interpolated` (estimated).
 */

import { detectVocalPhrases } from './lyricAlignCore.js';
import { lyricTokens } from './timedText.js';

const VOCABLE = /^(?:o+h*|a+h+|a+|l+a+|w+o+a*h*|w+h+o+a+h*|m+|n+a+|h+m+|o+w+|u+h+)$/;
const MIN_VOICED_SEC = 0.15;
const round3 = (n) => Math.round(n * 1000) / 1000;

const keys = (text) => lyricTokens(text).map((token) => token.key);

/** True when every word of the line is a held vowel/hum rather than a lexical word. */
function isVocableCue(cue) {
  const words = keys(cue?.text);
  return words.length > 0 && words.every((word) => VOCABLE.test(word));
}

/** Voiced stem spans inside [lo, hi], with sub-100 ms phrase splits rejoined. */
function voicedRegions(pcm, lo, hi) {
  const merged = [];
  for (const phrase of detectVocalPhrases(pcm)) {
    const startSec = Math.max(lo, phrase.startSec);
    const endSec = Math.min(hi, phrase.endSec);
    if (endSec <= startSec) continue;
    const last = merged.at(-1);
    if (last && startSec - last.endSec < 0.05) last.endSec = endSec;
    else merged.push({ startSec, endSec });
  }
  return merged.filter((region) => region.endSec - region.startSec >= MIN_VOICED_SEC);
}

/** Split `regions` into `parts` shares by weight; each share is the voiced spans it covers. */
function shareRegions(regions, weights) {
  const total = regions.reduce((sum, region) => sum + region.endSec - region.startSec, 0);
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  const shares = [];
  let regionIndex = 0;
  let cursor = regions[0].startSec;
  let used = 0;
  weights.forEach((weight, index) => {
    const quota = index === weights.length - 1 ? total - used : (total * weight) / weightSum;
    const spans = [];
    let need = quota;
    while (need > 1e-6 && regionIndex < regions.length) {
      const region = regions[regionIndex];
      const take = Math.min(need, region.endSec - cursor);
      spans.push({ startSec: cursor, endSec: cursor + take });
      cursor += take;
      need -= take;
      if (region.endSec - cursor <= 1e-6) {
        regionIndex++;
        cursor = regions[regionIndex]?.startSec ?? cursor;
      }
    }
    used += quota;
    shares.push(spans);
  });
  return shares;
}

/** Evenly time the words of `text` across the voiced `spans` of one line. */
function wordsOverSpans(text, spans) {
  const words = lyricTokens(text);
  const total = spans.reduce((sum, span) => sum + span.endSec - span.startSec, 0);
  return words.map(({ w }, index) => {
    const at = (fraction) => {
      let remaining = fraction * total;
      for (const span of spans) {
        const length = span.endSec - span.startSec;
        if (remaining <= length + 1e-9) return span.startSec + Math.min(remaining, length);
        remaining -= length;
      }
      return spans.at(-1).endSec;
    };
    return { w, startSec: round3(at(index / words.length)), endSec: round3(at((index + 1) / words.length)), conf: 'interpolated' };
  });
}

const untimed = (cue) => {
  const rest = { ...cue, startSec: null, endSec: null, matched: 0 };
  delete rest.words;
  delete rest.suspect;
  return rest;
};

/**
 * Re-time every run of vocable-only cues from the vocal stem. A run with no
 * voiced stem between its neighbours is left untimed for hand timing rather
 * than placed in silence. Non-vocable cues are returned unchanged.
 */
export function spreadVocableCues(cues, stemPcm, durationSec, sampleRate = 16000) {
  const out = [...cues];
  const stemEndSec = Math.min(durationSec, stemPcm.length / sampleRate);
  let index = 0;
  while (index < out.length) {
    if (!isVocableCue(out[index])) { index++; continue; }
    let end = index;
    while (end + 1 < out.length && isVocableCue(out[end + 1])) end++;
    const before = out[index - 1];
    const after = out[end + 1];
    const lo = before ? (before.words?.at(-1)?.endSec ?? before.endSec ?? 0) : 0;
    const hi = after ? (after.words?.[0]?.startSec ?? after.startSec ?? stemEndSec) : stemEndSec;
    const regions = hi > lo ? voicedRegions(stemPcm, lo, hi) : [];
    const run = out.slice(index, end + 1);
    if (regions.length === 0) {
      run.forEach((cue, offset) => { out[index + offset] = untimed(cue); });
    } else {
      const shares = shareRegions(regions, run.map((cue) => keys(cue.text).length));
      run.forEach((cue, offset) => {
        const spans = shares[offset];
        if (!spans.length) { out[index + offset] = untimed(cue); return; }
        const words = wordsOverSpans(cue.text, spans);
        const next = { ...cue, words, matched: 0, startSec: words[0].startSec, endSec: words.at(-1).endSec };
        delete next.suspect;
        out[index + offset] = next;
      });
    }
    index = end + 1;
  }
  return out;
}

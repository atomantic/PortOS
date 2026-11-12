/** User-requested, transient comparison of a lyric sheet with its vocal stem. */
import { ServerError } from '../../lib/errorHandler.js';
import { decodeSourceToWav } from './lyricAlign.js';
import { compareLyricPlacement, detectVocalPhrases, extendVoicedWordEnds, findSilentWords, mergeTranscripts, vocalPcm, wavDurationSec } from './lyricAlignCore.js';
import { resolveVocalStemPath, vocalStemMasterChanged } from './vocalStem.js';
import { resolveMasterAudioPath } from './render.js';
import { lyricTokens } from './timedText.js';

const validWords = cue => (cue.words || []).filter(word => Number.isFinite(word.startSec) && Number.isFinite(word.endSec) && word.endSec > word.startSec);

function isBetterMatch(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.complete !== current.complete) return candidate.complete;
  if (candidate.isMisplaced !== current.isMisplaced) return !candidate.isMisplaced;
  if (Math.abs(candidate.offsetSec - current.offsetSec) > 0.05) {
    return Math.abs(candidate.offsetSec) < Math.abs(current.offsetSec);
  }
  if (candidate.matchedCount !== current.matchedCount) {
    return candidate.matchedCount > current.matchedCount;
  }
  return false;
}

export async function verifyPrerequisites(project, { resolveStem = resolveVocalStemPath, resolveMaster = resolveMasterAudioPath } = {}) {
  let stem;
  try { stem = resolveStem(project); } catch (err) {
    if (err.code !== 'MUSIC_VIDEO_VOCAL_STEM_MISSING') throw err;
    stem = null;
  }
  const master = stem && project.vocalStemMasterFilename ? await resolveMaster(project) : null;
  if (!stem || !master || !project.vocalStemMasterFilename || vocalStemMasterChanged(project, master)) {
    throw new ServerError('Align words with a separated vocal first.', { status: 409, code: 'LYRIC_VERIFY_NEEDS_STEM' });
  }
  if (!(project.lyricCues || []).some(cue => validWords(cue).length)) {
    throw new ServerError('Align lyric words before checking the sheet.', { status: 409, code: 'LYRIC_VERIFY_NEEDS_TIMING' });
  }
  return stem;
}

/** Independently check placement inside timed spans, plus uncovered vocals. */
export async function verifyLyricSheet(project, stemPath, { onProgress = () => {}, isCancelled = () => false, signal, deps = {} } = {}) {
  const checkCancel = () => { if (isCancelled()) throw Object.assign(new Error('cancelled'), { canceled: true }); };
  const decode = deps.decode || decodeSourceToWav;
  const resolveTranscriber = deps.resolveTranscriber || (async onDownloadProgress => (await import('./lyricTranscriber.js')).resolveAlignmentTranscriber({ onDownloadProgress, requireDtw: true }));
  onProgress({ stage: 'decoding' });
  const wav = await decode(stemPath);
  checkCancel();
  const pcm = vocalPcm(wav);
  const cues = (project.lyricCues || []).filter(cue => validWords(cue).length);
  const spans = cues.map(cue => { const words = validWords(cue); return { startSec: words[0].startSec, endSec: words.at(-1).endSec }; }).sort((a, b) => a.startSec - b.startSec);
  const union = [];
  for (const span of spans) {
    const last = union.at(-1);
    if (last && span.startSec <= last.endSec) last.endSec = Math.max(last.endSec, span.endSec);
    else union.push({ ...span });
  }
  const regions = detectVocalPhrases(pcm).reduce((out, phrase) => {
    const last = out.at(-1);
    if (last && phrase.startSec - last.endSec < 0.3) last.endSec = phrase.endSec;
    else out.push({ ...phrase });
    return out;
  }, []).flatMap(phrase => union.reduce((parts, span) => parts.flatMap(part => {
    if (span.endSec <= part.startSec || span.startSec >= part.endSec) return [part];
    return [
      ...(span.startSec > part.startSec ? [{ startSec: part.startSec, endSec: span.startSec }] : []),
      ...(span.endSec < part.endSec ? [{ startSec: span.endSec, endSec: part.endSec }] : []),
    ];
  }), [phrase])).filter(phrase => phrase.endSec - phrase.startSec >= 0.6);
  const silent = findSilentWords(cues, pcm);
  const unsungCues = cues.filter(cue => validWords(cue).length === (cue.words || []).length && cue.words.every((_, index) => silent.some(word => word.cueId === cue.id && word.wordIndex === index))).map(cue => ({ cueId: cue.id, text: cue.text }));
  const extraPhrases = [], misplacedCues = [];
  const uncheckedCues = (project.lyricCues || []).filter(cue => !validWords(cue).length).map(cue => ({ cueId: cue.id, text: cue.text }));
  // A few neighbouring lines supply context without letting a repeated chorus
  // elsewhere in the song steal this occurrence. Padding allows a shifted beat.
  const windows = [];
  for (const cue of cues) {
    const words = validWords(cue);
    const start = words[0].startSec, end = words.at(-1).endSec;
    const last = windows.at(-1);
    if (last && last.cues.length < 3 && end - last.startSec < 20 && start - last.endSec < 3) {
      last.cues.push(cue);
      last.endSec = Math.max(last.endSec, end);
    } else windows.push({ cues: [cue], startSec: start, endSec: end });
  }
  onProgress({ stage: 'loading-model' });
  const transcriber = await resolveTranscriber(download => onProgress({ stage: 'downloading-model', percent: download.percent }));
  try {
    const cueRetries = new Map();
    for (const [index, window] of windows.entries()) {
      checkCancel();
      onProgress({ stage: 'checking-placement', current: index + 1, total: windows.length });
      const heard = await transcriber.transcribe(wav, {
        startSec: Math.max(0, window.startSec - 1.5), endSec: Math.min(wavDurationSec(wav), window.endSec + 1.5),
        prompt: window.cues.map(cue => cue.text).join('\n'), isCancelled, signal,
      });
      checkCancel();
      for (const [wIdx, w] of heard.entries()) w._id = `win:${index}:${wIdx}`;
      window.heard = heard;
      const expectedWordCount = window.cues.reduce((sum, cue) => sum + lyricTokens(cue.text).length, 0);
      if (heard.length < expectedWordCount / 2) {
        for (const cue of window.cues) {
          checkCancel();
          const words = validWords(cue);
          const retryHeard = await transcriber.transcribe(wav, {
            startSec: Math.max(0, words[0].startSec - 1.5),
            endSec: Math.min(wavDurationSec(wav), words.at(-1).endSec + 1.5),
            prompt: cue.text, isCancelled, signal,
          });
          checkCancel();
          for (const [rIdx, w] of retryHeard.entries()) w._id = `retry:${cue.id}:${rIdx}`;
          cueRetries.set(cue.id, retryHeard);
        }
      }
    }
    const usedWordIds = new Set();
    const claimedSpans = [];
    const overlapsClaimed = match => (match?.words || []).some(w => w.conf === 'matched'
      && claimedSpans.some(([start, end]) => w.startSec < end - 0.05 && w.endSec > start + 0.05));
    const isAvailableMatch = match => Boolean(match && !overlapsClaimed(match) && !match.matchedWordIds.some(id => usedWordIds.has(id)));

    for (const [windowIndex, window] of windows.entries()) {
      const ownBound = { startSec: Math.max(0, window.startSec - 1.5), endSec: Math.min(wavDurationSec(wav), window.endSec + 1.5) };
      const ownPlacement = compareLyricPlacement(window.cues, window.heard || [], { timeBound: ownBound, usedOccurrences: usedWordIds });
      const leftWindow = windowIndex > 0 ? windows[windowIndex - 1] : null;
      const leftPlacement = leftWindow && leftWindow.endSec + 1.5 >= window.startSec - 1.5 && leftWindow.heard?.length
        ? compareLyricPlacement(window.cues, leftWindow.heard, { timeBound: ownBound, usedOccurrences: usedWordIds }) : null;
      const rightWindow = windowIndex < windows.length - 1 ? windows[windowIndex + 1] : null;
      const rightPlacement = rightWindow && rightWindow.startSec - 1.5 <= window.endSec + 1.5 && rightWindow.heard?.length
        ? compareLyricPlacement(window.cues, rightWindow.heard, { timeBound: ownBound, usedOccurrences: usedWordIds }) : null;

      for (const cue of window.cues) {
        const words = validWords(cue);
        const lineBound = { startSec: Math.max(0, words[0].startSec - 1.5), endSec: Math.min(wavDurationSec(wav), words.at(-1).endSec + 1.5) };
        const ownMatch = ownPlacement.checkedCues?.find(c => c.cueId === cue.id) || null;
        let bestMatch = isAvailableMatch(ownMatch) ? ownMatch : null;

        if (cueRetries.has(cue.id)) {
          const retryPlacement = compareLyricPlacement([cue], cueRetries.get(cue.id), { timeBound: lineBound, usedOccurrences: usedWordIds });
          const retryMatch = retryPlacement.checkedCues?.[0] || null;
          if (isAvailableMatch(retryMatch) && isBetterMatch(retryMatch, bestMatch)) bestMatch = retryMatch;
        }

        if (leftPlacement) {
          const leftMatch = leftPlacement.checkedCues?.find(c => c.cueId === cue.id) || null;
          if (isAvailableMatch(leftMatch) && isBetterMatch(leftMatch, bestMatch)) bestMatch = leftMatch;
        }

        if (rightPlacement) {
          const rightMatch = rightPlacement.checkedCues?.find(c => c.cueId === cue.id) || null;
          if (isAvailableMatch(rightMatch) && isBetterMatch(rightMatch, bestMatch)) bestMatch = rightMatch;
        }

        if (bestMatch) {
          for (const id of bestMatch.matchedWordIds || []) usedWordIds.add(id);
          const matchedTimes = (bestMatch.words || []).filter(w => w.conf === 'matched');
          if (matchedTimes.length) {
            claimedSpans.push([matchedTimes[0].startSec, matchedTimes.at(-1).endSec]);
          }
          if (bestMatch.isMisplaced) {
            const [voiced] = extendVoicedWordEnds([{ ...bestMatch, words: bestMatch.words }], pcm);
            misplacedCues.push({ cueId: cue.id, text: cue.text, offsetSec: bestMatch.offsetSec, words: voiced.words });
          }
        } else {
          uncheckedCues.push({ cueId: cue.id, text: cue.text });
        }
      }
    }
    for (const [index, region] of regions.entries()) {
      checkCancel();
      onProgress({ stage: 'transcribing', current: index + 1, total: regions.length });
      const words = await transcriber.transcribe(wav, { startSec: Math.max(0, region.startSec - 0.2), endSec: Math.min(wavDurationSec(wav), region.endSec + 0.2), prompt: '', isCancelled, signal });
      checkCancel();
      extraPhrases.push({ ...region, text: mergeTranscripts(words, [], '').map(word => word.text.trim()).join(' ') });
    }
  } finally {
    await transcriber.release?.();
  }
  checkCancel();
  return { extraPhrases, unsungCues, misplacedCues, uncheckedCues,
    passed: !extraPhrases.length && !unsungCues.length && !misplacedCues.length && !uncheckedCues.length,
    stemMasterFilename: project.vocalStemMasterFilename };
}

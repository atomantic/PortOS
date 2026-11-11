/** User-requested, transient comparison of a lyric sheet with its vocal stem. */
import { ServerError } from '../../lib/errorHandler.js';
import { decodeSourceToWav } from './lyricAlign.js';
import { detectVocalPhrases, findSilentWords, mergeTranscripts, vocalPcm, wavDurationSec } from './lyricAlignCore.js';
import { resolveVocalStemPath, vocalStemMasterChanged } from './vocalStem.js';
import { resolveMasterAudioPath } from './render.js';

const validWords = cue => (cue.words || []).filter(word => Number.isFinite(word.startSec) && Number.isFinite(word.endSec) && word.endSec > word.startSec);

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

/** Compare only voiced regions outside the union of timed line spans. */
export async function verifyLyricSheet(project, stemPath, { onProgress = () => {}, isCancelled = () => false, signal, deps = {} } = {}) {
  const checkCancel = () => { if (isCancelled()) throw Object.assign(new Error('cancelled'), { canceled: true }); };
  const decode = deps.decode || decodeSourceToWav;
  const resolveTranscriber = deps.resolveTranscriber || (async onDownloadProgress => (await import('./lyricTranscriber.js')).resolveAlignmentTranscriber({ onDownloadProgress }));
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
  const regions = detectVocalPhrases(pcm).filter(phrase => {
    const length = phrase.endSec - phrase.startSec;
    const overlap = union.reduce((sum, span) => sum + Math.max(0, Math.min(span.endSec, phrase.endSec) - Math.max(span.startSec, phrase.startSec)), 0);
    return length >= 0.6 && overlap / length < 0.25;
  }).reduce((out, phrase) => {
    const last = out.at(-1);
    if (last && phrase.startSec - last.endSec < 0.3) last.endSec = phrase.endSec;
    else out.push({ ...phrase });
    return out;
  }, []);
  const silent = findSilentWords(cues, pcm);
  const unsungCues = cues.filter(cue => validWords(cue).length === (cue.words || []).length && cue.words.every((_, index) => silent.some(word => word.cueId === cue.id && word.wordIndex === index))).map(cue => ({ cueId: cue.id, text: cue.text }));
  const extraPhrases = [];
  if (regions.length) {
    onProgress({ stage: 'loading-model' });
    const transcriber = await resolveTranscriber(download => onProgress({ stage: 'downloading-model', percent: download.percent }));
    try {
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
  }
  checkCancel();
  return { extraPhrases, unsungCues, stemMasterFilename: project.vocalStemMasterFilename };
}

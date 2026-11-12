import { useEffect, useRef, useState } from 'react';
import useSseJobSlot from '../../hooks/useSseJobSlot.js';
import { verifyMusicVideoLyrics, musicVideoLyricVerifyEventsUrl, cancelMusicVideoLyricVerify } from '../../services/apiMusicVideo.js';
import { formatTimecode } from '../../utils/formatters.js';

const sheetSignature = (project, cues = project.lyricCues || []) => JSON.stringify([project.id, project.trackId,
  project.uploadedAudioFilename, project.vocalStemFilename, project.vocalStemMasterFilename,
  cues.map(({ id, text, startSec, endSec, words }) => ({ id, text, startSec, endSec, words }))]);
const actionClass = 'min-h-[44px] rounded border border-port-border px-2 text-port-accent disabled:opacity-50';

export default function LyricSheetCheck({ project, audioFilename, aligning, onEditLocal, onSave }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [inserting, setInserting] = useState(false);
  const insertionPending = useRef(false);
  const cues = project.lyricCues || [];
  const signature = sheetSignature(project, cues);
  const current = useRef(signature);
  const checked = useRef(null);
  current.current = signature;
  useEffect(() => { if (checked.current && checked.current !== signature) { checked.current = null; setResult(null); } }, [signature]);
  const reason = !project.vocalStemFilename || !project.vocalStemMasterFilename || (audioFilename && project.vocalStemMasterFilename !== audioFilename)
    ? 'Align words with a separated vocal first.' : !cues.some(cue => cue.words?.length) ? 'Align lyric words first.' : '';
  const slot = useSseJobSlot({
    startRequest: () => verifyMusicVideoLyrics(project.id, { silent: true }),
    eventsUrl: musicVideoLyricVerifyEventsUrl,
    cancelRequest: cancelMusicVideoLyricVerify,
    onComplete: frame => {
      if (checked.current !== current.current) { setError('The song or lyrics changed during the check. Run it again.'); return; }
      setResult(frame.result);
      if (frame.project) onEditLocal({ lyricCues: frame.project.lyricCues, ...(frame.project.productionReview ? { productionReview: frame.project.productionReview } : {}) });
    },
    onErrorFrame: frame => { setError(frame.error || 'Could not check the sheet.'); return true; },
    onKickoffError: err => { setError(err.message); return true; },
  });
  const insert = async (phrase, index) => {
    if (insertionPending.current || !phrase.text?.trim()) return;
    insertionPending.current = true;
    setInserting(true);
    const report = result;
    const originalMarkers = project.lyricMarkers || [];
    const cue = { id: `cue-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, text: phrase.text, startSec: phrase.startSec, endSec: phrase.endSec };
    const insertion = cues.findIndex(entry => entry.startSec != null && entry.startSec > phrase.startSec);
    const at = insertion < 0 ? cues.length : insertion;
    const next = [...cues.slice(0, at), cue, ...cues.slice(at)];
    const lyricMarkers = (project.lyricMarkers || []).map(marker => marker.line >= at ? { ...marker, line: marker.line + 1 } : marker);
    const patch = { lyricCues: next, lyricMarkers };
    const insertedSignature = sheetSignature(project, next);
    checked.current = insertedSignature;
    onEditLocal(patch);
    try {
      const saved = await onSave(patch);
      if (saved === false) throw new Error('Could not save the line.');
      setResult(currentResult => currentResult === report && checked.current === insertedSignature
        ? { ...currentResult, extraPhrases: currentResult.extraPhrases.filter((_, i) => i !== index) } : currentResult);
    } catch (err) {
      if (current.current === insertedSignature || current.current === signature) {
        checked.current = signature;
        onEditLocal({ lyricCues: cues, lyricMarkers: originalMarkers });
      }
      setError(err.message || 'Could not save the line.');
    } finally {
      insertionPending.current = false;
      setInserting(false);
    }
  };
  const acceptTimes = async (reports) => {
    if (insertionPending.current || checked.current !== current.current) return;
    insertionPending.current = true;
    setInserting(true);
    setError('');
    const replacements = new Map(reports.map(report => [report.cueId, report.words]));
    const next = cues.map(cue => {
      const words = replacements.get(cue.id);
      if (!words?.length) return cue;
      const { silentWords: _silent, ...rest } = cue;
      return { ...rest, words, startSec: words[0].startSec, endSec: words.at(-1).endSec, suspect: false, matched: 1 };
    });
    const acceptedSignature = sheetSignature(project, next);
    checked.current = acceptedSignature;
    onEditLocal({ lyricCues: next });
    try {
      if (await onSave({ lyricCues: next }) === false) throw new Error('Could not save the checked times.');
      setResult(report => checked.current === acceptedSignature && report
        ? { ...report, passed: false, accepted: true, misplacedCues: (report.misplacedCues || []).filter(cue => !replacements.has(cue.cueId)) } : report);
    } catch (err) {
      if (current.current === acceptedSignature || current.current === signature) {
        checked.current = signature;
        onEditLocal({ lyricCues: cues });
      }
      setError(err.message || 'Could not save the checked times.');
    } finally {
      insertionPending.current = false;
      setInserting(false);
    }
  };
  return <div className="space-y-2 text-sm">
    <button type="button" disabled={Boolean(reason) || aligning || slot.active || inserting} onClick={() => { if (insertionPending.current) return; setError(''); setResult(null); checked.current = current.current; slot.start(); }} className="min-h-[44px] rounded border border-port-border px-2 text-port-accent disabled:opacity-50">Check sheet against vocal</button>
    {reason && <p className="text-xs text-port-text-muted">{reason}</p>}
    {slot.active && <p role="status" className="text-xs">{slot.stage || 'Preparing'} {slot.percent > 0 ? `${slot.percent}%` : ''} <button type="button" onClick={slot.cancel} className="min-h-[44px] text-port-error">Cancel</button></p>}
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {result && <div className="space-y-2">
      {!result.extraPhrases.length && !result.unsungCues.length && !result.misplacedCues?.length && !result.uncheckedCues?.length && !result.accepted && <p>No differences found among the timed lines.</p>}
      {result.accepted && <p>Checked times saved. Run the check again to verify the updated sheet.</p>}
      {result.misplacedCues?.length > 0 && <div className="space-y-2">
        <h4>Word placement needs attention</h4>
        {result.misplacedCues.length > 1 && <button type="button" className={actionClass} disabled={inserting || aligning} onClick={() => void acceptTimes(result.misplacedCues)}>Use all checked times</button>}
        {result.misplacedCues.map(cue => <div key={cue.cueId} className="flex flex-wrap items-center gap-2">
          <span>{cue.text}: checked words are {formatTimecode(Math.abs(cue.offsetSec))} {cue.offsetSec > 0 ? 'later' : 'earlier'}.</span>
          <button type="button" className={actionClass} disabled={inserting || aligning} onClick={() => void acceptTimes([cue])}>Use the checked times</button>
        </div>)}
      </div>}
      {result.uncheckedCues?.length > 0 && <div><h4>Could not verify these lines</h4><p>Not enough words were recognized to check their placement. Listen and correct them, then check again.</p><ul>{result.uncheckedCues.map(cue => <li key={cue.cueId}>{cue.text}</li>)}</ul></div>}
      {result.extraPhrases.length > 0 && <div><h4>Sung but not on the sheet</h4>{result.extraPhrases.map((phrase, index) => <div key={`${phrase.startSec}-${phrase.endSec}`}>
        <span>{formatTimecode(phrase.startSec)}–{formatTimecode(phrase.endSec)} · {phrase.text || 'vocal, no words recognised'}</span>{' '}
        <button type="button" className="min-h-[44px] text-port-accent" onClick={() => { const audio = document.querySelector('audio[aria-label="Preview track audio"]'); if (audio) { audio.currentTime = phrase.startSec; void audio.play().catch(() => {}); } }}>Play</button>{' '}
        <button type="button" className="min-h-[44px] text-port-accent disabled:opacity-50" disabled={inserting || !phrase.text?.trim()} onClick={() => void insert(phrase, index)}>Insert line here</button>
      </div>)}</div>}
      {result.unsungCues.length > 0 && <div><h4>On the sheet but not sung</h4>{result.unsungCues.map(cue => <div key={cue.cueId}>{cue.text} <button type="button" className="min-h-[44px] text-port-accent" onClick={() => document.getElementById(`mv-lyric-cue-${cue.cueId}`)?.scrollIntoView({ block: 'center' })}>Show in Lyrics</button></div>)}</div>}
    </div>}
  </div>;
}

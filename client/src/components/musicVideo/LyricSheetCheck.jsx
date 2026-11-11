import { useEffect, useRef, useState } from 'react';
import useSseJobSlot from '../../hooks/useSseJobSlot.js';
import { verifyMusicVideoLyrics, musicVideoLyricVerifyEventsUrl, cancelMusicVideoLyricVerify } from '../../services/apiMusicVideo.js';
import { formatTimecode } from '../../utils/formatters.js';

export default function LyricSheetCheck({ project, audioFilename, aligning, onEditLocal, onSave }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const cues = project.lyricCues || [];
  const signature = JSON.stringify([project.trackId, project.uploadedAudioFilename, project.vocalStemFilename, project.vocalStemMasterFilename, cues]);
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
    onComplete: frame => { if (checked.current === current.current) setResult(frame.result); else setError('The song or lyrics changed during the check. Run it again.'); },
    onErrorFrame: frame => { setError(frame.error || 'Could not check the sheet.'); return true; },
    onKickoffError: err => { setError(err.message); return true; },
  });
  const insert = async (phrase, index) => {
    const report = result;
    const originalMarkers = project.lyricMarkers || [];
    const cue = { id: `cue-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, text: phrase.text, startSec: phrase.startSec, endSec: phrase.endSec };
    const insertion = cues.findIndex(entry => entry.startSec != null && entry.startSec > phrase.startSec);
    const at = insertion < 0 ? cues.length : insertion;
    const next = [...cues.slice(0, at), cue, ...cues.slice(at)];
    const lyricMarkers = (project.lyricMarkers || []).map(marker => marker.line >= at ? { ...marker, line: marker.line + 1 } : marker);
    const patch = { lyricCues: next, lyricMarkers };
    const insertedSignature = JSON.stringify([project.trackId, project.uploadedAudioFilename, project.vocalStemFilename, project.vocalStemMasterFilename, next]);
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
    }
  };
  return <div className="space-y-2 text-sm">
    <button type="button" disabled={Boolean(reason) || aligning || slot.active} onClick={() => { setError(''); setResult(null); checked.current = current.current; slot.start(); }} className="min-h-[44px] rounded border border-port-border px-2 text-port-accent disabled:opacity-50">Check sheet against vocal</button>
    {reason && <p className="text-xs text-port-text-muted">{reason}</p>}
    {slot.active && <p role="status" className="text-xs">{slot.stage || 'Preparing'} {slot.percent > 0 ? `${slot.percent}%` : ''} <button type="button" onClick={slot.cancel} className="min-h-[44px] text-port-error">Cancel</button></p>}
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {result && <div className="space-y-2">
      {!result.extraPhrases.length && !result.unsungCues.length && <p>No differences found among the timed lines.</p>}
      {result.extraPhrases.length > 0 && <div><h4>Sung but not on the sheet</h4>{result.extraPhrases.map((phrase, index) => <div key={`${phrase.startSec}-${phrase.endSec}`}>
        <span>{formatTimecode(phrase.startSec)}–{formatTimecode(phrase.endSec)} · {phrase.text || 'vocal, no words recognised'}</span>{' '}
        <button type="button" className="min-h-[44px] text-port-accent" onClick={() => { const audio = document.querySelector('audio[aria-label="Preview track audio"]'); if (audio) { audio.currentTime = phrase.startSec; void audio.play().catch(() => {}); } }}>Play</button>{' '}
        <button type="button" className="min-h-[44px] text-port-accent" onClick={() => void insert(phrase, index)}>Insert line here</button>
      </div>)}</div>}
      {result.unsungCues.length > 0 && <div><h4>On the sheet but not sung</h4>{result.unsungCues.map(cue => <div key={cue.cueId}>{cue.text} <button type="button" className="min-h-[44px] text-port-accent" onClick={() => document.getElementById(`mv-lyric-cue-${cue.cueId}`)?.scrollIntoView({ block: 'center' })}>Show in Lyrics</button></div>)}</div>}
    </div>}
  </div>;
}

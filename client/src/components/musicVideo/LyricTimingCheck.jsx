import { useState } from 'react';
import { formatTimecode } from '../../utils/formatters.js';
import { lyricSetupState } from '../../lib/musicVideoStages.js';
import CompositionPreviewPlayer from './CompositionPreviewPlayer.jsx';

const EMPTY_DRAFT = { cast: '', environments: '', visualLanguage: '', motionLanguage: '', guideArtifactId: null,
  lyricsMode: 'vocal', timingStatus: 'provisional', timingNotes: '', storyboard: [] };
const buttonClass = 'min-h-[44px] rounded border border-port-border bg-port-bg px-3 py-1.5 text-sm disabled:opacity-50 sm:min-h-0';

/**
 * The Song step's last check: is this a vocal song whose word timings you have
 * listened to and verified, or an instrumental? It writes the same production
 * draft fields the storyboard approval reads (`lyricsMode`, `timingStatus`,
 * `timingNotes`), so the Song step is finished here rather than in a review
 * panel on another step. A stale verification (the master or the word times
 * changed) is re-verified through the server's alignment route. Notes are
 * optional. `planning` is the page's unsaved planning draft pair; its copy of these
 * fields is kept in step so a later planning save cannot undo this one.
 *
 * Timing is judged by watching, so a vocal song's check carries the lyric
 * playthrough: the aligned words drawn with the render's own type over a plain
 * frame, played with the song (`audioUrl`). `aligning` says alignment is running.
 * Lines alignment flagged (too fast, or words on vocal silence) are listed with a
 * jump into the playthrough and `onAlign(cueId)` to re-align just that line; the
 * flags advise and never block the confirmation.
 */
export default function LyricTimingCheck({ project, review, planning = null, disabled = false, audioUrl = null, aligning = false, onAlign = null }) {
  const saved = { ...EMPTY_DRAFT, ...(project.productionReview?.draft || {}) };
  const lyrics = lyricSetupState(project, review.readiness);
  const [mode, setMode] = useState(saved.lyricsMode === 'instrumental' ? 'instrumental' : 'vocal');
  const [seekRequest, setSeekRequest] = useState(null);
  const [notes, setNotes] = useState(saved.timingNotes || '');
  const [alignError, setAlignError] = useState('');
  const stale = lyrics.alignment === 'stale';
  const busy = disabled || review.busy || !review.current;
  const notesId = `mv-timing-notes-${project.id}`;

  // Keep the page's unsaved planning draft in step with what the server now holds.
  const syncPlanning = (fields) => { if (planning?.[0]) planning[1]({ ...planning[0], ...fields }); };
  const write = async (fields) => {
    if (await review.save({ ...saved, ...fields })) syncPlanning(fields);
  };
  const reverify = async () => {
    const timingNotes = notes.trim();
    // The alignment route records the verification on the draft server-side.
    if (await review.reverifyAlignment(timingNotes)) syncPlanning({ timingStatus: 'verified', timingNotes });
  };

  const verified = mode === 'vocal' ? lyrics.verified && !lyrics.instrumental : lyrics.instrumental && lyrics.verified;
  const timed = (project.lyricCues || []).some((cue) => typeof cue.startSec === 'number' && cue.text?.trim());
  const flaggedCues = (project.lyricCues || []).filter((cue) => cue.suspect || cue.silentWords?.length > 0);
  const realign = (cueId) => {
    setAlignError('');
    Promise.resolve(onAlign(cueId)).catch((err) => setAlignError(err?.message || 'Could not re-align that line. Try again.'));
  };
  const playable = mode === 'vocal' && timed && !!project.audioAnalysis && !!audioUrl && !aligning;
  return (
    <div className="space-y-2">
      <fieldset className="flex flex-wrap gap-3 text-sm">
        <legend className="sr-only">Song content</legend>
        <label className="flex min-h-[44px] items-center gap-2 sm:min-h-0">
          <input type="radio" name={`mv-song-content-${project.id}`} value="vocal" checked={mode === 'vocal'} onChange={() => setMode('vocal')} />
          Vocal song
        </label>
        <label className="flex min-h-[44px] items-center gap-2 sm:min-h-0">
          <input type="radio" name={`mv-song-content-${project.id}`} value="instrumental" checked={mode === 'instrumental'} onChange={() => setMode('instrumental')} />
          Instrumental
        </label>
      </fieldset>
      {playable && (!verified || flaggedCues.length > 0) && (
        <>
          <p className="text-sm text-port-text-muted">Play the lyrics through with the song and watch each word land on the vocal.</p>
          {flaggedCues.length > 0 && (
            <div className="space-y-1 text-sm">
              <p className="text-port-warning">Check these lines against the vocal: they may play too quickly, or their underlined words landed where the vocal is silent. Re-align a line if it sounds off.</p>
              <ul className="space-y-1">
                {flaggedCues.map((cue) => {
                  const t = cue.words?.[0]?.startSec ?? cue.startSec ?? 0;
                  const silent = new Set(cue.silentWords || []);
                  return (
                    <li key={cue.id} className="flex flex-wrap items-center gap-2">
                      <button type="button" className={`${buttonClass} text-left`}
                        onClick={() => setSeekRequest((previous) => ({ t, n: (previous?.n ?? 0) + 1, play: true }))}>
                        {formatTimecode(t)} — {silent.size > 0 && cue.words?.length
                          ? cue.words.map((word, index) => (
                            <span key={index}>{index > 0 && ' '}{silent.has(index) ? <span className="underline decoration-port-warning decoration-2">{word.w}</span> : word.w}</span>
                          ))
                          : cue.text}
                      </button>
                      {onAlign && (
                        <button type="button" className={buttonClass} disabled={disabled || aligning} onClick={() => realign(cue.id)}>
                          Re-align line
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {alignError && <p role="alert" className="text-xs text-port-error">{alignError}</p>}
            </div>
          )}
          <CompositionPreviewPlayer project={project} audioUrl={audioUrl} lyrics scrubId={`mv-lyrics-check-scrub-${project.id}`} seekRequest={seekRequest} />
        </>
      )}
      {verified ? (
        <p role="status" className="text-sm text-port-success">
          {mode === 'vocal' ? 'Word timing verified against the current master.' : 'Marked instrumental.'}
        </p>
      ) : (
        <>
          {mode === 'vocal' && !playable && (
            <p role="status" className="text-sm text-port-text-muted">
              {aligning ? 'Aligning the words to the vocal. The playthrough appears here when they are placed.'
                : !project.audioAnalysis ? 'Analyzing the song. The playthrough appears here once the words are placed.'
                  : 'Align the words to play them through with the song.'}
            </p>
          )}
          <label htmlFor={notesId} className="block text-xs text-port-text-muted">
            Notes (optional)
          </label>
          <textarea id={notesId} rows={2} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm" />
          {stale && mode === 'vocal' && (
            <p role="status" className="text-xs text-port-warning">The master or the word times changed since you verified them. Listen again, then re-verify.</p>
          )}
          {mode === 'vocal' ? (
            <button type="button" className={buttonClass}
              disabled={busy || lyrics.lines === 0 || !playable}
              onClick={() => (stale ? reverify() : write({ lyricsMode: 'vocal', timingStatus: 'verified', timingNotes: notes.trim() }))}>
              {stale ? 'Timing still looks right' : 'Timing looks right'}
            </button>
          ) : (
            <button type="button" className={buttonClass} disabled={busy}
              onClick={() => write({ lyricsMode: 'instrumental', timingNotes: notes.trim() })}>
              Confirm instrumental
            </button>
          )}
        </>
      )}
      {review.error && <p role="alert" className="text-xs text-port-error">{review.error}</p>}
    </div>
  );
}

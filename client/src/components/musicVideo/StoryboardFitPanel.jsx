import { useMemo, useState } from 'react';
import { AudioLines, Loader2 } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { fitMusicVideoToStoryboard } from '../../services/api';
import { formatCount, formatTimecode } from '../../utils/formatters';
import { fitStoryboardToSong, STORYBOARD_FIT_MIN_SHOT_SEC, storyboardFitSong } from '../../../../server/lib/storyboardFit.js';

const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const plural = (n, word) => `${formatCount(n)} ${word}${n === 1 ? '' : 's'}`;
const SNAP_LABELS = { start: 'Song start', section: 'On a section', lyric: 'On a sung line', downbeat: 'On a downbeat', picked: 'Your pick' };
const MARK_KINDS = { section: 'Section', lyric: 'Line' };

/**
 * Fit to song: the linked board's beats placed on the analyzed song, shown in
 * place (where each beat starts, its section and how its length changes) with
 * a start picker per beat, then written as one shot per panel. The preview
 * and the write run the same fit, so the shots written are the ones shown.
 * Beats marked before the song are listed first with their length; they
 * become the shots before the song and stay off its time.
 */
export default function StoryboardFitPanel({ project, board, disabled, onFitted, onBoardStale }) {
  const [open, setOpen] = useState(false);
  const [starts, setStarts] = useState({});
  const [confirming, setConfirming] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState(null);
  const song = useMemo(() => storyboardFitSong(project), [project]);
  const fit = useMemo(() => (open ? fitStoryboardToSong(board, song, { starts }) : null), [open, board, song, starts]);
  const existing = (project.scenes || []).length;
  const preludeBeats = fit ? fit.beats.filter((beat) => beat.beforeSong).length : 0;
  const preludeSec = fit ? fit.beats.reduce((sum, beat) => sum + (beat.beforeSong ? beat.durationSec : 0), 0) : 0;

  if (!song) return <p className="text-xs text-gray-400">Analyze the song on the Song step to fit this board to it.</p>;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} disabled={disabled || !board.beats.length} className={actionButton}>
        <AudioLines size={16} aria-hidden="true" /> Fit to song
      </button>
    );
  }

  const write = async () => {
    setConfirming(false);
    setWriting(true);
    setError(null);
    const res = await fitMusicVideoToStoryboard(project.id, { boardUpdatedAt: board.updatedAt, starts }, { silent: true })
      .catch((err) => {
        setError(err?.message || 'The shots could not be written.');
        // The fit above is redrawn from the board as it is now.
        if (err?.code === 'STORYBOARD_CHANGED') onBoardStale();
        return null;
      });
    setWriting(false);
    if (res?.project) {
      onFitted(res.project);
      setOpen(false);
    }
  };
  const pick = (beatId, value) => setStarts((current) => {
    const next = { ...current };
    if (value === '') delete next[beatId];
    else next[beatId] = Number(value);
    return next;
  });

  return (
    <section aria-label="Fit to song" className="space-y-2 rounded-lg border border-port-border p-2">
      <p className="text-xs text-gray-400">
        {plural(fit.beats.length, 'beat')} become {plural(fit.shots.length, 'shot')} over <span className="tabular-nums">{formatTimecode(song.durationSec)}</span>, one per panel{preludeBeats > 0 && <>, after <span className="tabular-nums">{formatTimecode(preludeSec)}</span> before the song</>}. Pick where a beat starts to move it.
      </p>
      <ol className="space-y-1.5" aria-label="Beats on the song">
        {fit.beats.map((beat, index) => (
          <li key={beat.beatId} className="space-y-1 rounded border border-port-border/60 p-1.5 text-xs text-gray-400">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm text-white">{index + 1}. {beat.title}</span>
              {beat.beforeSong ? (
                <span className="tabular-nums">Before the song · {formatTimecode(beat.durationSec)}</span>
              ) : (
                <>
                  <span className="tabular-nums">{formatTimecode(beat.startSec)}–{formatTimecode(beat.endSec)}</span>
                  {beat.sectionLabel && <span>{beat.sectionLabel}</span>}
                  <span className="tabular-nums">board {formatTimecode(beat.boardSec)} → song {formatTimecode(beat.songSec)}</span>
                </>
              )}
            </div>
            {index > preludeBeats && (
              <div className="flex items-center gap-2">
                <label htmlFor={`fit-start-${beat.beatId}`} className="shrink-0">Starts</label>
                <select id={`fit-start-${beat.beatId}`} value={starts[beat.beatId] ?? ''} onChange={(e) => pick(beat.beatId, e.target.value)}
                  className="min-h-[44px] min-w-0 flex-1 bg-port-bg border border-port-border rounded px-2 text-sm text-white">
                  <option value="">Auto: {starts[beat.beatId] === undefined ? `${SNAP_LABELS[beat.snap] || 'In proportion'}, ` : ''}{formatTimecode(beat.startSec)}</option>
                  {beat.options.map((mark) => (
                    <option key={`${mark.kind}-${mark.at}`} value={mark.at}>{formatTimecode(mark.at)} · {MARK_KINDS[mark.kind]}: {mark.label}</option>
                  ))}
                </select>
              </div>
            )}
            {beat.noPanels && <p>No panels yet; one shot from the beat's own words.</p>}
            {beat.short > 0 && <p className="text-port-warning">{plural(beat.short, 'shot')} under {formatCount(STORYBOARD_FIT_MIN_SHOT_SEC)} s; the song is short for this many panels.</p>}
          </li>
        ))}
      </ol>
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
      {confirming ? (
        <InlineConfirmRow autoFocus aria-label="Replace the shots" tone="warning" confirmText="Write shots"
          question={`Replace the ${plural(existing, 'shot')} with ${plural(fit.shots.length, 'shot')} from the board? A shot matched by panel or span keeps its frames and clips; removed shots' takes stay in the collection.`}
          onConfirm={write} onCancel={() => setConfirming(false)} />
      ) : (
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => (existing ? setConfirming(true) : write())} disabled={disabled || writing || !fit.shots.length}
            className={`${actionButton} bg-port-accent/20 border-port-accent/50`}>
            {writing ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <AudioLines size={16} aria-hidden="true" />} Write {plural(fit.shots.length, 'shot')}
          </button>
          <button type="button" onClick={() => { setOpen(false); setError(null); }} className={actionButton}>Close</button>
        </div>
      )}
    </section>
  );
}

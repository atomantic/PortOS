import { useEffect, useRef, useState } from 'react';
import { Flag, Pencil, Timer, X } from 'lucide-react';
import { formatCount, formatTimecode } from '../../utils/formatters';
import { newStoryboardEntityId, STORYBOARD_LIMITS as L } from '../../../../server/lib/storyboardVocabulary.js';
import CommitField from './CommitField';

const smallButton = 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-2 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const iconButton = 'min-h-[44px] min-w-[44px] inline-flex shrink-0 items-center justify-center rounded text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-30';
const timeButton = 'min-h-[44px] w-[4.5rem] shrink-0 rounded text-left text-xs text-gray-400 tabular-nums hover:text-white disabled:hover:text-gray-400';

const round = (t) => Math.round(t * 100) / 100;
const bySongTime = (a, b) => a.at - b.at;

/** Pasted lyrics as lines, keeping the id and stamp of every line whose text is unchanged. */
function mergeLyrics(text, lines) {
  const kept = new Map();
  for (const line of lines) kept.set(line.text, [...(kept.get(line.text) || []), line]);
  return text.split('\n').map((row) => row.trim()).filter(Boolean)
    .map((row) => kept.get(row)?.shift() || { id: newStoryboardEntityId('line'), text: row, at: null });
}

/**
 * Song marks on the temp track: sections marked at the playhead, and the
 * lyrics, each line stamped at the playhead while the song plays. A beat is
 * pinned to a mark from its details, and Play starts it there.
 *
 * Each change saves the whole track; saves run one after another from the
 * local copy, so quick taps while the song plays never drop a stamp.
 */
export default function SongMarkers({ track, time, onSeek, onChange }) {
  const [draft, setDraft] = useState(track);
  const [lyricsText, setLyricsText] = useState(null);
  const queueRef = useRef(Promise.resolve());
  const pendingRef = useRef(0);

  useEffect(() => {
    if (!pendingRef.current) setDraft(track);
  }, [track]);

  const save = (patch) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    pendingRef.current += 1;
    queueRef.current = queueRef.current
      .then(() => onChange(next))
      .catch(() => {})
      .finally(() => { pendingRef.current -= 1; });
  };

  const now = round(time);
  const sections = draft.sections || [];
  const lines = draft.lines || [];
  const nextLine = lines.find((line) => line.at === null);

  const setSections = (next) => save({ sections: [...next].sort(bySongTime) });
  const addSection = () => setSections([...sections, { id: newStoryboardEntityId('sec'), label: `Section ${sections.length + 1}`, at: now }]);
  const stampLine = (id) => save({ lines: lines.map((line) => (line.id === id ? { ...line, at: now } : line)) });

  const pasted = lyricsText === null ? null : mergeLyrics(lyricsText, lines);
  const tooLong = pasted?.find((line) => line.text.length > L.lyricLine);
  const tooMany = pasted && pasted.length > L.lyricLines;
  const saveLyrics = () => {
    save({ lines: pasted });
    setLyricsText(null);
  };

  return (
    <section aria-label="Song marks" className="space-y-3 rounded-lg border border-port-border p-2">
      <p className="text-[11px] text-gray-500">Mark the song's sections and stamp its lyric lines at the playhead, then pin beats to them in each beat's details.</p>

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-sm text-white">Sections</h2>
          <button type="button" onClick={addSection} disabled={sections.length >= L.songSections} className={smallButton}>
            <Flag size={16} aria-hidden="true" /> Mark section at <span className="tabular-nums">{formatTimecode(now)}</span>
          </button>
        </div>
        {sections.length > 0 && (
          <ol className="space-y-1" aria-label="Song sections">
            {sections.map((section) => (
              <li key={section.id} className="flex items-center gap-1">
                <button type="button" onClick={() => onSeek(section.at)} className={timeButton} aria-label={`Play from ${section.label}`}>{formatTimecode(section.at)}</button>
                <div className="min-w-0 flex-1">
                  <CommitField id={`song-section-${section.id}`} value={section.label} maxLength={L.sectionLabel} ariaLabel="Section name"
                    onCommit={(label) => setSections(sections.map((s) => (s.id === section.id ? { ...s, label } : s)))} />
                </div>
                <button type="button" onClick={() => setSections(sections.map((s) => (s.id === section.id ? { ...s, at: now } : s)))}
                  className={iconButton} aria-label={`Move ${section.label} to the playhead`}><Timer size={16} aria-hidden="true" /></button>
                <button type="button" onClick={() => setSections(sections.filter((s) => s.id !== section.id))}
                  className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${iconButton} hover:text-port-error`} aria-label={`Delete ${section.label}`}><X size={16} aria-hidden="true" /></button>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-sm text-white">Lyrics</h2>
          {pasted === null && lines.length > 0 && (
            <>
              <button type="button" onClick={() => nextLine && stampLine(nextLine.id)} disabled={!nextLine} className={`${smallButton} bg-port-accent/20 border-port-accent/50`}>
                <Timer size={16} aria-hidden="true" /> {nextLine ? 'Stamp next line' : 'Every line stamped'}
              </button>
              <button type="button" onClick={() => setLyricsText(lines.map((line) => line.text).join('\n'))} className={smallButton}>
                <Pencil size={16} aria-hidden="true" /> Edit
              </button>
            </>
          )}
        </div>
        {pasted !== null || !lines.length ? (
          <div className="space-y-1">
            <label htmlFor="song-lyrics" className="sr-only">Lyrics, one line per row</label>
            <textarea id="song-lyrics" rows={6} value={lyricsText ?? ''} onChange={(e) => setLyricsText(e.target.value)}
              placeholder="Paste the lyrics, one line per row. Lines you keep keep their stamps."
              className="w-full min-h-[8rem] bg-port-bg border border-port-border rounded p-2 text-sm text-white" />
            {(tooLong || tooMany) && (
              <p role="alert" className="text-xs text-port-error">
                {tooMany
                  ? `${formatCount(pasted.length)} lines; a track holds at most ${formatCount(L.lyricLines)}.`
                  : `A line has ${formatCount(tooLong.text.length)} characters; the most is ${formatCount(L.lyricLine)}.`}
              </p>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={saveLyrics} disabled={!pasted || tooLong || tooMany} className={`${smallButton} bg-port-accent/20 border-port-accent/50`}>Save lines</button>
              {lines.length > 0 && <button type="button" onClick={() => setLyricsText(null)} className={smallButton}>Cancel</button>}
            </div>
          </div>
        ) : (
          <ol className="max-h-72 space-y-0.5 overflow-y-auto" aria-label="Lyric lines">
            {lines.map((line) => (
              <li key={line.id} className="flex items-center gap-1">
                <button type="button" onClick={() => onSeek(line.at)} disabled={line.at === null} className={timeButton}
                  aria-label={line.at === null ? 'Not stamped yet' : `Play from "${line.text}"`}>
                  {line.at === null ? '—' : formatTimecode(line.at)}
                </button>
                <span className={`min-w-0 flex-1 truncate text-sm ${line.id === nextLine?.id ? 'text-white' : 'text-gray-300'}`}>{line.text}</span>
                <button type="button" onClick={() => stampLine(line.id)} className={iconButton} aria-label={`Stamp "${line.text}" at the playhead`}>
                  <Timer size={16} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

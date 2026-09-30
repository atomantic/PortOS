import { useRef, useState } from 'react';
import { ListMusic, Plus, Trash2, Upload } from 'lucide-react';

// Client-minted ids keep a freshly added row addressable across saves without
// waiting for the server (crypto.randomUUID is unavailable on the plain-HTTP
// tailnet origin PortOS is usually opened from).
const mintId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const toSec = (value) => (value === '' ? null : Number(value));
// Bounds mirror musicVideoPacingSchema so an out-of-range value is refused
// by the input rather than applied locally and then rejected by the server.
const PACING_FIELDS = [
  ['minShotSec', 'Shortest shot (s)', 'Floor for a planned shot; a shorter section stays one shot.', 0.5, 60],
  ['maxShotSec', 'Longest shot (s)', 'Ceiling for a planned shot, never longer than one generated clip (5s local, 6/10s Grok).', 1, 120],
  ['hookSec', 'Opening hook (s)', 'Cap on the very first shot so the video opens on a cut.', 0.5, 60],
];

const inputCls = 'bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';
const round3 = (n) => Math.round(n * 1000) / 1000;
const MIN_WORD_SEC = 0.02;

/** Move the boundary after `index` by deltaSec. The next word's start follows. */
function nudgeWordBoundary(words, index, deltaSec) {
  const next = words.map((word) => ({ ...word }));
  const word = next[index];
  if (!word || !Number.isFinite(deltaSec)) return words;
  const following = next[index + 1];
  const ceiling = following ? following.endSec - MIN_WORD_SEC : word.endSec + Math.abs(deltaSec) + 1;
  const boundary = round3(Math.min(ceiling, Math.max(word.startSec + MIN_WORD_SEC, word.endSec + deltaSec)));
  word.endSec = boundary;
  if (following) following.startSec = boundary;
  return next;
}

function WordTimingRow({ cue, onPreview, onCommit }) {
  const words = cue.words || [];
  const drag = useRef(null);
  if (words.length === 0) return null;
  const apply = (index, delta, commit) => {
    const next = nudgeWordBoundary(drag.current?.words || words, index, delta);
    if (commit) onCommit(next);
    else onPreview(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-1 pl-1">
      {words.map((word, index) => (
        <span key={`${word.w}-${index}`} className="inline-flex items-center gap-0.5">
          <span
            className={word.conf === 'interpolated' ? 'text-port-warning' : 'text-port-accent'}
            title={word.conf === 'interpolated' ? 'Interpolated — the vocal did not match this word' : 'Matched to the vocal'}
          >{word.w}</span>
          <button type="button" aria-label={`Nudge the end of ${word.w} earlier`}
            onClick={() => onCommit(nudgeWordBoundary(words, index, -0.05))}
            className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 px-1 text-port-text-muted">−</button>
          <span
            role="separator"
            aria-orientation="vertical"
            aria-label={`Drag the end of ${word.w}`}
            title="Drag this word boundary"
            className="inline-block w-1.5 h-4 cursor-ew-resize touch-none rounded bg-port-border"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { index, origin: event.clientX, words: words.map((entry) => ({ ...entry })) };
            }}
            onPointerMove={(event) => {
              if (!drag.current || drag.current.index !== index) return;
              apply(index, (event.clientX - drag.current.origin) * 0.01, false);
            }}
            onPointerUp={(event) => {
              if (!drag.current || drag.current.index !== index) return;
              const delta = (event.clientX - drag.current.origin) * 0.01;
              const base = drag.current.words;
              drag.current = null;
              onCommit(nudgeWordBoundary(base, index, delta));
            }}
            onPointerCancel={() => { drag.current = null; }}
          />
          <button type="button" aria-label={`Nudge the end of ${word.w} later`}
            onClick={() => onCommit(nudgeWordBoundary(words, index, 0.05))}
            className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 px-1 text-port-text-muted">+</button>
        </span>
      ))}
    </div>
  );
}

/**
 * Timed lyric cues, musical-phrase annotations and shot pacing for the AI
 * shot planner (#8964). Every list is editable in place: edits apply to the
 * board immediately (`onEditLocal`) and persist on blur (`onSave`, a project
 * PATCH that replaces the list whole). Import parses pasted LRC, SRT/WebVTT or
 * plain lines server-side; plain lines arrive untimed and are timed here.
 * Align words runs only from its button: matched words use the accent colour
 * and interpolated words use the warning colour. Drag or nudge a boundary to
 * correct it. Changing a line's text drops its word timings. Changing the
 * project's audio clears every timing (the text stays).
 */
// Marker chips read the sheet's structure back to the director: sections in
// the accent colour, delivery directions muted.
function MarkerChips({ markers }) {
  if (!markers?.length) return null;
  return (
    <div className="flex flex-wrap gap-1 pt-1">
      {markers.map((marker, index) => (
        <span key={`${marker.type}-${marker.label}-${index}`}
          title={marker.type === 'section' ? 'Section from the lyric sheet' : 'Delivery direction from the lyric sheet'}
          className={`rounded px-1.5 py-0.5 text-[10px] break-words ${marker.type === 'section' ? 'bg-port-accent/20 text-port-accent font-medium' : 'bg-port-border text-port-text-muted italic'}`}>
          {marker.type === 'section' ? marker.label : `[${marker.label}]`}
        </span>
      ))}
    </div>
  );
}

export default function LyricsPanel({ project, onEditLocal, onSave, onImport, importing, onImportTrack, onAlign, aligning = false }) {
  const cues = project.lyricCues || [];
  const markers = project.lyricMarkers || [];
  const markersAt = (line) => markers.filter((marker) => marker.line === line);
  const trailingMarkers = markers.filter((marker) => marker.line >= cues.length);
  const phrases = project.phrases || [];
  const pacing = project.pacing || {};
  const [importText, setImportText] = useState('');
  const [importFormat, setImportFormat] = useState('auto');
  const [importMode, setImportMode] = useState('replace');
  const [alignError, setAlignError] = useState('');
  const timedCount = cues.filter((c) => typeof c.startSec === 'number').length;
  const hasAudio = Boolean(project.trackId || project.uploadedAudioFilename);

  const editCue = (id, patch) => onEditLocal({
    lyricCues: cues.map((c) => {
      if (c.id !== id) return c;
      const next = { ...c, ...patch };
      if (Object.hasOwn(patch, 'words') && patch.words == null) delete next.words;
      return next;
    }),
  });
  const editPhrase = (id, patch) => onEditLocal({ phrases: phrases.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  const saveCues = (next = cues) => onSave({ lyricCues: next });
  const savePhrases = (next = phrases) => onSave({ phrases: next });
  const replaceCues = (next) => { onEditLocal({ lyricCues: next }); saveCues(next); };
  const replacePhrases = (next) => { onEditLocal({ phrases: next }); savePhrases(next); };

  const commitPacing = (key, raw, min, max) => {
    const value = Number(raw);
    if (raw !== '' && !(Number.isFinite(value) && value >= min && value <= max)) return false;
    const next = { ...pacing };
    if (raw === '') delete next[key];
    else next[key] = value;
    const nextPacing = Object.keys(next).length > 0 ? next : null;
    onEditLocal({ pacing: nextPacing });
    onSave({ pacing: nextPacing });
    return true;
  };

  const submitImport = () => {
    if (!importText.trim()) return;
    onImport({ text: importText, format: importFormat, mode: importMode }, () => setImportText(''));
  };

  const runAlign = (cueId) => {
    if (!onAlign || aligning) return;
    setAlignError('');
    Promise.resolve(onAlign(cueId)).catch((err) => {
      setAlignError(err?.message || 'Could not align the words to the vocal. Try Align words again.');
    });
  };
  const editWords = (id, words, save) => {
    const next = cues.map((cue) => (cue.id === id ? { ...cue, words } : cue));
    onEditLocal({ lyricCues: next });
    if (save) onSave({ lyricCues: next });
  };

  return (
    <details className="mt-2 bg-port-bg border border-port-border rounded-lg p-2 text-xs">
      <summary className="cursor-pointer select-none text-port-text-muted min-h-[44px] sm:min-h-0 flex flex-wrap items-center gap-x-1">
        Lyrics, phrases &amp; pacing — {cues.length} line{cues.length === 1 ? '' : 's'} ({timedCount} timed)
        · {phrases.length} phrase{phrases.length === 1 ? '' : 's'}
        <span className="block sm:inline sm:ml-1">— AI Plan cuts on timed lines and phrase edges; no lyrics = an instrumental plan.</span>
      </summary>

      <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section className="space-y-2 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-medium text-port-text">Import lyrics</h4>
            {onImportTrack && project.trackId && (
              <button type="button" onClick={onImportTrack} disabled={importing}
                title={cues.length ? 'Replace these lines with the linked track\'s lyric sheet' : 'Use the linked track\'s lyric sheet'}
                className="flex items-center gap-1 text-port-accent min-h-[44px] sm:min-h-0 disabled:opacity-50">
                <ListMusic size={13} /> Use track lyrics
              </button>
            )}
          </div>
          <label htmlFor="mv-lyrics-import" className="sr-only">Lyrics to import</label>
          <textarea id="mv-lyrics-import" rows={3} value={importText} onChange={(e) => setImportText(e.target.value)}
            placeholder={'Paste LRC ([00:12.50] line), SRT/WebVTT cues, or plain lines (imported untimed)'}
            className="w-full bg-port-card border border-port-border rounded px-2 py-1.5 text-xs" />
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="mv-lyrics-format" className="block text-port-text-muted mb-0.5">Format</label>
              <select id="mv-lyrics-format" value={importFormat} onChange={(e) => setImportFormat(e.target.value)} className={inputCls}>
                <option value="auto">Detect</option>
                <option value="lrc">LRC</option>
                <option value="srt">SRT / WebVTT</option>
                <option value="text">Plain lines</option>
              </select>
            </div>
            <div>
              <label htmlFor="mv-lyrics-mode" className="block text-port-text-muted mb-0.5">Existing lines</label>
              <select id="mv-lyrics-mode" value={importMode} onChange={(e) => setImportMode(e.target.value)} className={inputCls}>
                <option value="replace">Replace</option>
                <option value="append">Append after</option>
              </select>
            </div>
            <button type="button" onClick={submitImport} disabled={importing || !importText.trim()}
              className="flex items-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 min-h-[44px] sm:min-h-0 disabled:opacity-50">
              <Upload size={13} /> {importing ? 'Importing…' : 'Import lyrics'}
            </button>
          </div>

          <h4 className="font-medium text-port-text pt-1">Shot pacing</h4>
          <div className="flex flex-wrap gap-2">
            {PACING_FIELDS.map(([key, label, help, min, max]) => (
              <div key={key}>
                <label htmlFor={`mv-pacing-${key}`} className="block text-port-text-muted mb-0.5" title={help}>{label}</label>
                <input id={`mv-pacing-${key}`} type="number" min={min} max={max} step={0.5}
                  defaultValue={pacing[key] ?? ''} key={`${project.id}-${key}-${pacing[key] ?? ''}`}
                  placeholder="default" title={help}
                  onBlur={(e) => {
                    if (e.target.value === String(pacing[key] ?? '')) return;
                    // Out of range: restore the saved value instead of showing an unsaved one.
                    if (!commitPacing(key, e.target.value, min, max)) e.target.value = pacing[key] ?? '';
                  }}
                  className={`${inputCls} w-24`} />
              </div>
            ))}
          </div>
        </section>

        <section className="space-y-1 min-w-0">
          <div className="flex items-center justify-between">
            <h4 className="font-medium text-port-text">Lyric lines</h4>
            <span className="flex items-center gap-2">
              {onAlign && (
                <button type="button" onClick={() => runAlign()} disabled={aligning || cues.length === 0 || !hasAudio}
                  title={hasAudio ? 'Align each word to the vocal with local whisper.cpp (the first run downloads a 1.6 GB model)' : 'Attach a song before aligning words'}
                  className="min-h-[44px] sm:min-h-0 text-port-accent disabled:opacity-50">
                  {aligning ? 'Aligning…' : 'Align words'}
                </button>
              )}
              <button type="button" onClick={() => replaceCues([...cues, { id: mintId('lc'), text: 'New line', startSec: null, endSec: null }])}
                className="flex items-center gap-1 text-port-accent min-h-[44px] sm:min-h-0"><Plus size={13} /> Line</button>
            </span>
          </div>
          {alignError && <p role="alert" className="text-port-error">{alignError}</p>}
          {cues.length === 0 && <p className="text-port-text-muted">No lyrics — instrumental tracks plan from sections and beats alone.</p>}
          <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
            {cues.map((cue, i) => (
              <div key={cue.id} className="space-y-1 border-b border-port-border/50 pb-1">
                <MarkerChips markers={markersAt(i)} />
                <div className="flex flex-wrap items-center gap-1">
                  <input type="number" min={0} step={0.01} aria-label={`Line ${i + 1} start (s)`} placeholder="start"
                    value={cue.startSec ?? ''} onChange={(e) => editCue(cue.id, { startSec: toSec(e.target.value) })}
                    onBlur={() => saveCues()} className={`${inputCls} w-16`} />
                  <input type="number" min={0} step={0.01} aria-label={`Line ${i + 1} end (s)`} placeholder="end"
                    value={cue.endSec ?? ''} onChange={(e) => editCue(cue.id, { endSec: toSec(e.target.value) })}
                    onBlur={() => saveCues()} className={`${inputCls} w-16`} />
                  <input type="text" maxLength={500} aria-label={`Line ${i + 1} text`}
                    value={cue.text} onChange={(e) => {
                      const text = e.target.value;
                      // Omit words. null would fail the cue schema, and a whole-list
                      // save without the key drops timings that no longer match the text.
                      editCue(cue.id, cue.words && text !== cue.text ? { text, words: undefined } : { text });
                    }}
                    onBlur={() => saveCues()} className={`${inputCls} min-w-0 flex-1 basis-40`} />
                  {onAlign && (
                    <button type="button" onClick={() => runAlign(cue.id)} disabled={aligning}
                      aria-label={`Re-align line ${i + 1}`}
                      className="min-h-[44px] sm:min-h-0 text-port-accent disabled:opacity-50">Re-align</button>
                  )}
                  <button type="button" onClick={() => replaceCues(cues.filter((c) => c.id !== cue.id))}
                    aria-label={`Delete line ${i + 1}`} className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 p-1 text-port-error"><Trash2 size={12} /></button>
                </div>
                <WordTimingRow cue={cue}
                  onPreview={(words) => editWords(cue.id, words, false)}
                  onCommit={(words) => editWords(cue.id, words, true)} />
              </div>
            ))}
            {cues.length > 0 && <MarkerChips markers={trailingMarkers} />}
          </div>

          <div className="flex items-center justify-between pt-1">
            <h4 className="font-medium text-port-text">Phrases</h4>
            <button type="button" onClick={() => replacePhrases([...phrases, { id: mintId('mp'), label: '', intent: '', startSec: null, endSec: null }])}
              className="flex items-center gap-1 text-port-accent min-h-[44px] sm:min-h-0"><Plus size={13} /> Phrase</button>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1 pr-1">
            {phrases.map((phrase, i) => (
              <div key={phrase.id} className="flex flex-wrap items-center gap-1">
                <input type="number" min={0} step={0.01} aria-label={`Phrase ${i + 1} start (s)`} placeholder="start"
                  value={phrase.startSec ?? ''} onChange={(e) => editPhrase(phrase.id, { startSec: toSec(e.target.value) })}
                  onBlur={() => savePhrases()} className={`${inputCls} w-16`} />
                <input type="number" min={0} step={0.01} aria-label={`Phrase ${i + 1} end (s)`} placeholder="end"
                  value={phrase.endSec ?? ''} onChange={(e) => editPhrase(phrase.id, { endSec: toSec(e.target.value) })}
                  onBlur={() => savePhrases()} className={`${inputCls} w-16`} />
                <input type="text" maxLength={120} aria-label={`Phrase ${i + 1} label`} placeholder="label"
                  value={phrase.label || ''} onChange={(e) => editPhrase(phrase.id, { label: e.target.value })}
                  onBlur={() => savePhrases()} className={`${inputCls} w-24`} />
                <input type="text" maxLength={2000} aria-label={`Phrase ${i + 1} visual intent`} placeholder="visual intent"
                  value={phrase.intent || ''} onChange={(e) => editPhrase(phrase.id, { intent: e.target.value })}
                  onBlur={() => savePhrases()} className={`${inputCls} min-w-0 flex-1 basis-40`} />
                <button type="button" onClick={() => replacePhrases(phrases.filter((p) => p.id !== phrase.id))}
                  aria-label={`Delete phrase ${i + 1}`} className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 p-1 text-port-error"><Trash2 size={12} /></button>
              </div>
            ))}
          </div>
        </section>
      </div>
    </details>
  );
}

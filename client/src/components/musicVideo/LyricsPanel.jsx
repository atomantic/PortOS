import { useState } from 'react';
import { Plus, Trash2, Upload } from 'lucide-react';

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

const inputCls = 'bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs';

/**
 * Timed lyric cues, musical-phrase annotations and shot pacing for the AI
 * shot planner (#8964). Every list is editable in place: edits apply to the
 * board immediately (`onEditLocal`) and persist on blur (`onSave`, a project
 * PATCH that replaces the list whole). Import parses pasted LRC, SRT/WebVTT or
 * plain lines server-side; plain lines arrive untimed and are timed here.
 * Changing the project's audio clears every timing (the text stays) — those
 * rows show as untimed until they are re-timed against the new track.
 */
export default function LyricsPanel({ project, onEditLocal, onSave, onImport, importing }) {
  const cues = project.lyricCues || [];
  const phrases = project.phrases || [];
  const pacing = project.pacing || {};
  const [importText, setImportText] = useState('');
  const [importFormat, setImportFormat] = useState('auto');
  const [importMode, setImportMode] = useState('replace');
  const timedCount = cues.filter((c) => typeof c.startSec === 'number').length;

  const editCue = (id, patch) => onEditLocal({ lyricCues: cues.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
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

  return (
    <details className="mt-2 bg-port-bg border border-port-border rounded-lg p-2 text-xs">
      <summary className="cursor-pointer select-none text-port-text-muted">
        Lyrics, phrases &amp; pacing — {cues.length} line{cues.length === 1 ? '' : 's'} ({timedCount} timed)
        · {phrases.length} phrase{phrases.length === 1 ? '' : 's'}
        <span className="block sm:inline sm:ml-1">— AI Plan cuts on timed lines and phrase edges; no lyrics = an instrumental plan.</span>
      </summary>

      <div className="mt-2 grid grid-cols-1 gap-3 lg:grid-cols-2">
        <section className="space-y-2 min-w-0">
          <h4 className="font-medium text-port-text">Import lyrics</h4>
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
            <button type="button" onClick={() => replaceCues([...cues, { id: mintId('lc'), text: 'New line', startSec: null, endSec: null }])}
              className="flex items-center gap-1 text-port-accent min-h-[44px] sm:min-h-0"><Plus size={13} /> Line</button>
          </div>
          {cues.length === 0 && <p className="text-port-text-muted">No lyrics — instrumental tracks plan from sections and beats alone.</p>}
          <div className="max-h-64 overflow-y-auto space-y-1 pr-1">
            {cues.map((cue, i) => (
              <div key={cue.id} className="flex flex-wrap items-center gap-1">
                <input type="number" min={0} step={0.01} aria-label={`Line ${i + 1} start (s)`} placeholder="start"
                  value={cue.startSec ?? ''} onChange={(e) => editCue(cue.id, { startSec: toSec(e.target.value) })}
                  onBlur={() => saveCues()} className={`${inputCls} w-16`} />
                <input type="number" min={0} step={0.01} aria-label={`Line ${i + 1} end (s)`} placeholder="end"
                  value={cue.endSec ?? ''} onChange={(e) => editCue(cue.id, { endSec: toSec(e.target.value) })}
                  onBlur={() => saveCues()} className={`${inputCls} w-16`} />
                <input type="text" maxLength={500} aria-label={`Line ${i + 1} text`}
                  value={cue.text} onChange={(e) => editCue(cue.id, { text: e.target.value })}
                  onBlur={() => saveCues()} className={`${inputCls} min-w-0 flex-1 basis-40`} />
                <button type="button" onClick={() => replaceCues(cues.filter((c) => c.id !== cue.id))}
                  aria-label={`Delete line ${i + 1}`} className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 p-1 text-port-error"><Trash2 size={12} /></button>
              </div>
            ))}
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

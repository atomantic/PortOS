// Shared editor for voice exemplar / anti-exemplar passage lists (#2179 — "the
// tuning fork"). Each row is `{ passage, note }`: the passage textarea is
// required (an empty passage prunes the row server-side), the note is an
// optional one-liner (what the passage demonstrates, or what's wrong with it).
// Capped at VOICE_EXEMPLARS_MAX rows. All labels are htmlFor/id paired.
//
// Used by BOTH the series style-guide editor (PipelineSeries) and the Writers
// Room work voice drawer (WorkEditor) so a freeform work anchors its voice the
// same way a series does — one component, no drift between the two surfaces.
// Caps mirror STYLE_GUIDE_LIMITS in server/lib/styleGuide.js.

export const VOICE_EXEMPLARS_MAX = 3;
export const VOICE_EXEMPLAR_PASSAGE_MAX = 2000;
export const VOICE_EXEMPLAR_NOTE_MAX = 200;

export default function VoiceExemplarEditor({ idPrefix, title, hint, notePlaceholder, entries, onChange }) {
  const list = Array.isArray(entries) ? entries : [];
  const setEntry = (i, patch) => onChange(list.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  const removeEntry = (i) => onChange(list.filter((_, idx) => idx !== i));
  const addEntry = () => onChange([...list, { passage: '', note: '' }]);

  return (
    <div className="mt-3">
      <h4 className="text-[11px] uppercase tracking-wider text-gray-500 mb-1">{title}</h4>
      <p className="text-[11px] text-gray-500 mb-2 -mt-0.5">{hint}</p>
      <div className="space-y-2">
        {list.map((entry, i) => (
          <div key={i} className="border border-port-border rounded p-2 bg-port-bg/50">
            <label htmlFor={`${idPrefix}-passage-${i}`} className="block text-[11px] text-gray-500 mb-1">Passage {i + 1}</label>
            <textarea
              id={`${idPrefix}-passage-${i}`}
              value={entry.passage || ''}
              onChange={(e) => setEntry(i, { passage: e.target.value })}
              rows={4}
              maxLength={VOICE_EXEMPLAR_PASSAGE_MAX}
              placeholder="Paste a short prose passage that captures the voice."
              className="w-full px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm font-mono"
            />
            <div className="flex items-center gap-2 mt-1">
              <label htmlFor={`${idPrefix}-note-${i}`} className="sr-only">Note for passage {i + 1}</label>
              <input
                id={`${idPrefix}-note-${i}`}
                value={entry.note || ''}
                onChange={(e) => setEntry(i, { note: e.target.value })}
                maxLength={VOICE_EXEMPLAR_NOTE_MAX}
                placeholder={notePlaceholder}
                className="flex-1 px-2 py-1 bg-port-bg border border-port-border rounded text-white text-xs"
              />
              <button
                type="button"
                onClick={() => removeEntry(i)}
                className="px-2 py-1 text-xs text-port-error hover:bg-port-error/10 rounded"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
      {list.length < VOICE_EXEMPLARS_MAX && (
        <button
          type="button"
          onClick={addEntry}
          className="mt-2 px-2 py-1 text-xs text-port-accent hover:bg-port-accent/10 rounded border border-port-border"
        >
          + Add passage
        </button>
      )}
    </div>
  );
}

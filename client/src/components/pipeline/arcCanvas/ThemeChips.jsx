import { useRef, useState } from 'react';
import { Plus, Loader2, X } from 'lucide-react';
import toast from '../../ui/Toast';
import { updatePipelineSeries } from '../../../services/api';

const THEME_COLORS = [
  'border-sky-400/40 bg-sky-500/10 text-sky-200',
  'border-emerald-400/40 bg-emerald-500/10 text-emerald-200',
  'border-amber-400/40 bg-amber-500/10 text-amber-200',
  'border-rose-400/40 bg-rose-500/10 text-rose-200',
  'border-cyan-400/40 bg-cyan-500/10 text-cyan-200',
  'border-fuchsia-400/40 bg-fuchsia-500/10 text-fuchsia-200',
  'border-lime-400/40 bg-lime-500/10 text-lime-200',
  'border-orange-400/40 bg-orange-500/10 text-orange-200',
];

// Theme pill limits — mirror server/lib/storyArc.js ARC_LIMITS.
const THEME_MAX = 100;
const THEMES_PER_ARC_MAX = 20;

// Inline-editable theme pills. Click a pill to rename, hover for the × to
// remove, trailing dashed "+ Add theme" pill opens an inline input. Each
// commit PATCHes series.arc.themes optimistically and reconciles on the
// server response. Single-flight via `savingRef` so a blur-then-click
// sequence can't double-persist against the same base state.
export default function ThemeChips({ series, arc, onSeriesUpdate }) {
  const themes = arc.themes || [];
  const atMax = themes.length >= THEMES_PER_ARC_MAX;
  const [editingIdx, setEditingIdx] = useState(null); // number | 'new' | null
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  const persist = async (nextThemes) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    onSeriesUpdate({ ...series, arc: { ...arc, themes: nextThemes } });
    const updated = await updatePipelineSeries(series.id, { arc: { ...arc, themes: nextThemes } }, { silent: true })
      .catch((err) => {
        toast.error(err.message || 'Failed to save themes');
        return null;
      });
    savingRef.current = false;
    setSaving(false);
    if (updated) onSeriesUpdate(updated);
    else onSeriesUpdate(series); // rollback to the last known-good arc
  };

  const startEdit = (idx) => {
    if (saving) return;
    setEditingIdx(idx);
    setDraft(themes[idx]);
  };

  const startAdd = () => {
    if (saving || atMax) return;
    setEditingIdx('new');
    setDraft('');
  };

  const commit = async () => {
    const v = draft.trim().slice(0, THEME_MAX);
    const idx = editingIdx;
    setEditingIdx(null);
    setDraft('');
    if (idx === 'new') {
      if (!v || themes.includes(v)) return;
      await persist([...themes, v]);
    } else if (typeof idx === 'number') {
      if (v === themes[idx]) return;
      const next = [...themes];
      if (v) next[idx] = v;
      else next.splice(idx, 1); // clearing a rename removes the pill
      await persist(next);
    }
  };

  const cancel = () => {
    setEditingIdx(null);
    setDraft('');
  };

  const remove = (idx) => {
    if (saving) return;
    persist(themes.filter((_, i) => i !== idx));
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  return (
    <>
      {themes.map((t, i) => editingIdx === i ? (
        <input
          key={`edit-${i}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          autoFocus
          maxLength={THEME_MAX}
          aria-label={`Edit theme ${i + 1}`}
          className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-port-accent text-white outline-none"
          style={{ width: `${Math.max(draft.length + 1, 5)}ch` }}
        />
      ) : (
        <span
          key={`${i}-${t}`}
          className={`group inline-flex items-center text-[10px] uppercase tracking-wider rounded border ${THEME_COLORS[i % THEME_COLORS.length]} hover:border-white/40`}
        >
          <button
            type="button"
            onClick={() => startEdit(i)}
            disabled={saving}
            title="Click to rename"
            className="px-2 py-0.5 hover:text-white disabled:opacity-50 disabled:cursor-wait"
          >
            {t}
          </button>
          <button
            type="button"
            onClick={() => remove(i)}
            disabled={saving}
            aria-label={`Remove theme ${t}`}
            title={`Remove "${t}"`}
            className="pr-1.5 -ml-0.5 text-gray-500 hover:text-port-error opacity-40 sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100 disabled:opacity-0"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {editingIdx === 'new' ? (
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={handleKey}
          autoFocus
          maxLength={THEME_MAX}
          placeholder="new theme"
          aria-label="New theme"
          className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-port-accent text-white outline-none placeholder:text-gray-600"
          style={{ width: `${Math.max(draft.length + 1, 10)}ch` }}
        />
      ) : !atMax ? (
        <button
          type="button"
          onClick={startAdd}
          disabled={saving}
          title={`Add a theme (${themes.length}/${THEMES_PER_ARC_MAX})`}
          className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-port-bg border border-dashed border-port-border text-gray-500 hover:text-port-accent hover:border-port-accent/40 disabled:opacity-50"
        >
          <Plus size={10} /> Add theme
        </button>
      ) : null}
      {saving ? <Loader2 size={10} className="animate-spin text-gray-500 ml-1" /> : null}
    </>
  );
}

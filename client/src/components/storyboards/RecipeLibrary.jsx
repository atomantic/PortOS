import { useState } from 'react';
import { BookmarkPlus, FolderOpen, Trash2 } from 'lucide-react';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import toast from '../ui/Toast';
import { deleteStoryboardRecipe, listStoryboardRecipes, saveStoryboardRecipe } from '../../services/api';
import { RECIPE_LIMITS } from '../../../../server/lib/storyboardRecipe.js';

const actionButton = 'min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-3 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';
const fieldClass = 'min-h-[44px] w-full bg-port-bg border border-port-border rounded px-2 text-sm text-white';

/**
 * The saved recipe library on the Make tab: "Save as…" keeps a named copy of
 * this board's recipe; "Load…" copies a saved one onto the board (the saved
 * copy never changes when the board's recipe is edited afterwards).
 */
export default function RecipeLibrary({ recipe, onLoad }) {
  const [mode, setMode] = useState(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [pickedId, setPickedId] = useState('');
  const [confirm, setConfirm] = useState(null);
  const picked = saved?.find((item) => item.id === pickedId) || null;

  const close = () => { setMode(null); setConfirm(null); };

  const openLoad = () => {
    setMode('load');
    setLoadError(false);
    listStoryboardRecipes({ silent: true })
      .then((rows) => {
        const list = Array.isArray(rows) ? rows : [];
        setSaved(list);
        setPickedId((prev) => (list.some((item) => item.id === prev) ? prev : list[0]?.id || ''));
      })
      // A failed read says so; it must not look like an empty library.
      .catch(() => setLoadError(true));
  };

  const save = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSaving(true);
    const record = await saveStoryboardRecipe(trimmed, { nodes: recipe.nodes, edges: recipe.edges }).catch(() => null);
    setSaving(false);
    if (!record) return;
    setSaved((prev) => (prev ? [record, ...prev] : prev));
    setName('');
    close();
    toast.success(`Saved "${record.name}".`);
  };

  const remove = async () => {
    const target = picked;
    setConfirm(null);
    if (!target || !(await deleteStoryboardRecipe(target.id).catch(() => null))) return;
    const rest = saved.filter((item) => item.id !== target.id);
    setSaved(rest);
    setPickedId(rest[0]?.id || '');
  };

  const load = () => {
    const target = picked;
    close();
    if (target) onLoad(structuredClone(target.recipe));
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => (mode === 'save' ? close() : setMode('save'))} aria-expanded={mode === 'save'} className={actionButton}>
          <BookmarkPlus size={16} aria-hidden="true" /> Save as…
        </button>
        <button type="button" onClick={() => (mode === 'load' ? close() : openLoad())} aria-expanded={mode === 'load'} className={actionButton}>
          <FolderOpen size={16} aria-hidden="true" /> Load…
        </button>
      </div>
      {mode === 'save' && (
        <form onSubmit={save} className="flex flex-wrap items-end gap-2 rounded-lg border border-port-border p-2">
          <div className="flex-1 min-w-[12rem]">
            <label htmlFor="recipe-save-name" className="block text-[11px] text-gray-500 mb-0.5">Recipe name</label>
            <input id="recipe-save-name" autoFocus value={name} maxLength={RECIPE_LIMITS.title} onChange={(e) => setName(e.target.value)}
              placeholder="Pencil frames, two references" className={fieldClass} />
          </div>
          <button type="submit" disabled={saving || !name.trim()} className={`${actionButton} bg-port-accent/20 border-port-accent/50`}>Save</button>
          <button type="button" onClick={close} className={actionButton}>Cancel</button>
        </form>
      )}
      {mode === 'load' && (
        <div className="space-y-2 rounded-lg border border-port-border p-2">
          {loadError ? (
            <p role="status" className="text-xs text-port-warning">Saved recipes could not be read. Try Load… again.</p>
          ) : !saved ? (
            <p role="status" className="text-xs text-gray-500">Reading saved recipes…</p>
          ) : !saved.length ? (
            <p className="text-xs text-gray-500">No saved recipes yet. Save as… keeps this one.</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[12rem]">
                <label htmlFor="recipe-load-pick" className="block text-[11px] text-gray-500 mb-0.5">Saved recipe</label>
                <select id="recipe-load-pick" value={pickedId} onChange={(e) => { setPickedId(e.target.value); setConfirm(null); }} className={fieldClass}>
                  {saved.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.recipe.nodes.length} nodes)</option>)}
                </select>
              </div>
              <button type="button" onClick={() => setConfirm('load')} disabled={!picked} className={`${actionButton} bg-port-accent/20 border-port-accent/50`}>Load</button>
              <button type="button" onClick={() => setConfirm('delete')} disabled={!picked} aria-label={picked ? `Delete ${picked.name}` : 'Delete saved recipe'} className={actionButton}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          {confirm === 'load' && picked && (
            <InlineConfirmRow autoFocus aria-label={`Load ${picked.name}`} confirmText="Load" tone="warning"
              question={`Load "${picked.name}"? This board's recipe is replaced by a copy; the saved recipe stays as it is.`}
              onConfirm={load} onCancel={() => setConfirm(null)} />
          )}
          {confirm === 'delete' && picked && (
            <InlineConfirmRow autoFocus aria-label={`Delete ${picked.name}`}
              question={`Delete "${picked.name}" from saved recipes? Boards that loaded it keep their copy.`}
              onConfirm={remove} onCancel={() => setConfirm(null)} />
          )}
        </div>
      )}
    </div>
  );
}

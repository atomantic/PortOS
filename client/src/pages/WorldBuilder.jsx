/**
 * World Builder page (Media Gen → World Builder).
 *
 * Lets the user describe a universe in one starter prompt, expand it into a
 * full set of style + per-category variation prompts via the LLM of their
 * choice, edit/save the template, and kick off a batch of image renders
 * that all land in a single auto-named collection.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Globe2, Plus, Trash2, Sparkles, Wand2, Loader2, Save, FolderOpen,
  Edit3, X,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listWorlds, getWorld, createWorld, updateWorld, deleteWorld, expandWorld,
  renderWorld, listWorldRuns, getProviders, WORLD_CATEGORIES,
} from '../services/api';

const CATEGORY_LABELS = {
  landscapes: 'Landscapes',
  environments: 'Environments',
  characters: 'Characters',
  structures: 'Structures',
  vehicles: 'Vehicles',
};

// Default per-render knobs. Mirrors the Image Gen page's default chip.
const DEFAULT_RENDER_OPTS = {
  width: 1024,
  height: 1024,
  steps: 30,
  cfgScale: 7,
  batchPerVariation: 1,
};

const emptyTemplate = () => ({
  name: '',
  starterPrompt: '',
  stylePrompt: '',
  negativePrompt: '',
  categories: Object.fromEntries(WORLD_CATEGORIES.map((c) => [c, { variations: [] }])),
  llm: { provider: null, model: null },
});

export default function WorldBuilder() {
  const [worlds, setWorlds] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [expanding, setExpanding] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);

  // The draft is the editable copy of the currently-selected world. New
  // worlds start as a draft with no id; saving creates the persisted record.
  const [draft, setDraft] = useState(emptyTemplate());

  // Per-page render knobs. Persisted to localStorage so the user's
  // preferred batch size sticks across visits.
  const [renderOpts, setRenderOpts] = useState(() => {
    const saved = localStorage.getItem('worldBuilder.renderOpts');
    if (saved) {
      try { return { ...DEFAULT_RENDER_OPTS, ...JSON.parse(saved) }; } catch { /* fall through */ }
    }
    return DEFAULT_RENDER_OPTS;
  });
  useEffect(() => {
    localStorage.setItem('worldBuilder.renderOpts', JSON.stringify(renderOpts));
  }, [renderOpts]);

  const [runs, setRuns] = useState([]);

  // Two-click delete: first click flips this to the world id; a second
  // click within the live render confirms. Avoids window.confirm per
  // CLAUDE.md UI Patterns.
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  const refresh = async () => {
    setLoading(true);
    const [list, provData] = await Promise.all([
      listWorlds().catch(() => []),
      getProviders().catch(() => ({ providers: [] })),
    ]);
    setWorlds(list);
    setProviders(provData.providers || []);
    setActiveProviderId(provData.activeProvider || null);
    setLoading(false);
  };

  useEffect(() => { refresh(); }, []);

  // Whenever the selection changes, deep-load that world (for runs) and
  // hydrate the draft.
  useEffect(() => {
    setPendingDeleteId(null);
    if (!selectedId) {
      setDraft(emptyTemplate());
      setRuns([]);
      return;
    }
    let cancelled = false;
    Promise.all([
      getWorld(selectedId).catch(() => null),
      listWorldRuns(selectedId).catch(() => []),
    ]).then(([w, r]) => {
      if (cancelled) return;
      if (w) {
        setDraft({
          ...w,
          // Ensure all five categories exist in the draft so the editor
          // grid renders even if the LLM skipped one.
          categories: Object.fromEntries(WORLD_CATEGORIES.map((c) => [c, w.categories?.[c] || { variations: [] }])),
          llm: w.llm || { provider: null, model: null },
        });
      }
      setRuns(r);
    });
    return () => { cancelled = true; };
  }, [selectedId]);

  const handleNew = () => {
    setSelectedId(null);
    setDraft(emptyTemplate());
    setRuns([]);
  };

  const handleSave = async () => {
    if (!draft.name?.trim()) {
      toast.error('Name is required');
      return;
    }
    setSaving(true);
    const payload = {
      name: draft.name.trim(),
      starterPrompt: draft.starterPrompt || '',
      stylePrompt: draft.stylePrompt || '',
      negativePrompt: draft.negativePrompt || '',
      categories: draft.categories,
      llm: draft.llm || {},
    };
    const result = selectedId
      ? await updateWorld(selectedId, payload).catch((e) => { toast.error(`Save failed: ${e.message}`); return null; })
      : await createWorld(payload).catch((e) => { toast.error(`Save failed: ${e.message}`); return null; });
    setSaving(false);
    if (result) {
      toast.success(selectedId ? 'World updated' : 'World created');
      setWorlds((prev) => {
        const without = prev.filter((w) => w.id !== result.id);
        return [result, ...without];
      });
      setSelectedId(result.id);
    }
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    if (pendingDeleteId !== selectedId) {
      setPendingDeleteId(selectedId);
      toast(`Click delete again to confirm — "${draft.name}" will be removed`, { icon: '⚠️' });
      return;
    }
    const id = selectedId;
    await deleteWorld(id).catch((e) => toast.error(`Delete failed: ${e.message}`));
    setWorlds((prev) => prev.filter((w) => w.id !== id));
    setSelectedId(null);
    setDraft(emptyTemplate());
    setPendingDeleteId(null);
    toast.success('World deleted');
  };

  const handleExpand = async () => {
    if (!draft.starterPrompt?.trim()) {
      toast.error('Add a starter prompt to expand');
      return;
    }
    setExpanding(true);
    const result = await expandWorld({
      starterPrompt: draft.starterPrompt,
      providerId: draft.llm?.provider || undefined,
      model: draft.llm?.model || undefined,
    }).catch((e) => { toast.error(`Expansion failed: ${e.message}`); return null; });
    setExpanding(false);
    if (!result) return;
    setDraft((d) => ({
      ...d,
      stylePrompt: result.stylePrompt || d.stylePrompt,
      negativePrompt: result.negativePrompt || d.negativePrompt,
      categories: Object.fromEntries(WORLD_CATEGORIES.map((c) => [c, result.categories?.[c] || { variations: [] }])),
      llm: result.llm || d.llm,
    }));
    const total = WORLD_CATEGORIES.reduce((n, k) => n + (result.categories?.[k]?.variations?.length || 0), 0);
    toast.success(`Expanded into ${total} variations — review then Save`);
  };

  const handleRender = async () => {
    if (!selectedId) {
      toast.error('Save the world first');
      return;
    }
    const total = totalVariationCount(draft);
    if (!total) {
      toast.error('No variations — expand the template first');
      return;
    }
    setRendering(true);
    const result = await renderWorld(selectedId, {
      mode: renderOpts.mode || undefined,
      modelId: renderOpts.modelId || undefined,
      width: renderOpts.width,
      height: renderOpts.height,
      steps: renderOpts.steps,
      cfgScale: renderOpts.cfgScale,
      batchPerVariation: renderOpts.batchPerVariation,
    }).catch((e) => { toast.error(`Render failed: ${e.message}`); return null; });
    setRendering(false);
    if (!result) return;
    toast.success(`Queued ${result.promptCount} renders → "${result.collectionName}"`);
    const updated = await listWorldRuns(selectedId).catch(() => runs);
    setRuns(updated);
  };

  const updateDraft = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const updateCategory = (cat, variations) => setDraft((d) => ({
    ...d,
    categories: { ...d.categories, [cat]: { variations } },
  }));

  const providerLabel = (id) => providers.find((p) => p.id === id)?.name || id || '—';
  const providerModels = useMemo(() => {
    const p = providers.find((x) => x.id === draft.llm?.provider) || providers.find((x) => x.id === activeProviderId);
    return p?.models || [];
  }, [providers, activeProviderId, draft.llm?.provider]);

  const totalVariations = totalVariationCount(draft);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
      {/* Sidebar — world list */}
      <aside className="bg-port-card border border-port-border rounded p-3 flex flex-col gap-2 min-h-[60vh]">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <Globe2 size={16} className="text-port-accent" /> Worlds
          </h2>
          <button
            onClick={handleNew}
            className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 text-port-accent rounded flex items-center gap-1 min-h-[40px] sm:min-h-0"
            title="New world"
          >
            <Plus size={14} /> New
          </button>
        </div>
        {loading ? (
          <p className="text-xs text-gray-500">Loading…</p>
        ) : worlds.length === 0 ? (
          <p className="text-xs text-gray-500">No worlds yet — click <span className="text-port-accent">New</span> to start.</p>
        ) : (
          <ul className="flex flex-col gap-1 overflow-y-auto">
            {worlds.map((w) => {
              const active = w.id === selectedId;
              return (
                <li key={w.id}>
                  <button
                    onClick={() => setSelectedId(w.id)}
                    className={`w-full text-left px-2 py-2 rounded text-sm transition-colors min-h-[40px] ${
                      active
                        ? 'bg-port-accent/15 text-port-accent border border-port-accent/40'
                        : 'text-gray-300 hover:bg-port-bg border border-transparent'
                    }`}
                  >
                    <div className="font-medium truncate">{w.name}</div>
                    <div className="text-[11px] text-gray-500 truncate">{w.starterPrompt || 'No starter prompt'}</div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {/* Editor */}
      <section className="flex flex-col gap-4">
        <header className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="text"
              value={draft.name}
              onChange={(e) => updateDraft({ name: e.target.value })}
              placeholder="World name (e.g. Moebius / Scavenger sci-fi)"
              className="flex-1 min-w-[180px] bg-port-bg border border-port-border rounded px-3 py-2 text-white focus:outline-none focus:border-port-accent"
              maxLength={100}
            />
            <button
              onClick={handleSave}
              disabled={saving || !draft.name?.trim()}
              className="px-3 py-2 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded flex items-center gap-2 min-h-[40px]"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {selectedId ? 'Save' : 'Create'}
            </button>
            {selectedId && (
              <button
                onClick={handleDelete}
                className={`px-3 py-2 rounded flex items-center gap-2 min-h-[40px] ${
                  pendingDeleteId === selectedId
                    ? 'bg-red-700 hover:bg-red-600 text-white'
                    : 'bg-red-900/30 hover:bg-red-900/50 text-red-300'
                }`}
                title="Delete world"
              >
                <Trash2 size={16} /> {pendingDeleteId === selectedId ? 'Confirm delete' : 'Delete'}
              </button>
            )}
          </div>

          {/* Starter prompt + LLM picker */}
          <div className="grid grid-cols-1 md:grid-cols-[1fr_220px] gap-3">
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Starter idea</label>
              <textarea
                value={draft.starterPrompt}
                onChange={(e) => updateDraft({ starterPrompt: e.target.value })}
                placeholder="moebius and scavengers reign meets Prophet inspired sci fi universe"
                className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent"
                rows={2}
                maxLength={4000}
              />
            </div>
            <div>
              <label className="text-xs text-gray-400 mb-1 block">LLM for expansion</label>
              <select
                // Bind to `?? ''` (NOT `|| activeProviderId || ''`) — when
                // provider is null/unset, the empty value should select the
                // "Active provider" option, not silently switch the dropdown
                // to the active provider's explicit option (which would
                // misrepresent saved state as a pinned provider).
                value={draft.llm?.provider ?? ''}
                onChange={(e) => updateDraft({ llm: { ...draft.llm, provider: e.target.value || null, model: null } })}
                className="w-full bg-port-bg border border-port-border rounded px-2 py-2 text-white text-sm min-h-[40px]"
              >
                <option value="">Active provider ({providerLabel(activeProviderId)})</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              <select
                value={draft.llm?.model || ''}
                onChange={(e) => updateDraft({ llm: { ...draft.llm, model: e.target.value || null } })}
                className="mt-1 w-full bg-port-bg border border-port-border rounded px-2 py-2 text-white text-sm min-h-[40px]"
              >
                <option value="">Default model</option>
                {providerModels.map((m) => {
                  const id = typeof m === 'string' ? m : m.id;
                  const label = typeof m === 'string' ? m : (m.name || m.id);
                  return <option key={id} value={id}>{label}</option>;
                })}
              </select>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handleExpand}
              disabled={expanding || !draft.starterPrompt?.trim()}
              className="px-3 py-2 bg-purple-600/30 hover:bg-purple-600/50 disabled:opacity-50 text-purple-200 border border-purple-600/40 rounded flex items-center gap-2 min-h-[40px]"
            >
              {expanding ? <Loader2 size={16} className="animate-spin" /> : <Wand2 size={16} />}
              Expand starter → variations
            </button>
            <span className="text-xs text-gray-500">
              {totalVariations} variation{totalVariations === 1 ? '' : 's'} across {WORLD_CATEGORIES.length} categories
            </span>
          </div>
        </header>

        {/* Style template */}
        <section className="bg-port-card border border-port-border rounded p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 block flex items-center gap-1">
              <Sparkles size={12} /> Style prompt (prepended to every variation)
            </label>
            <textarea
              value={draft.stylePrompt}
              onChange={(e) => updateDraft({ stylePrompt: e.target.value })}
              placeholder="moebius linework, scavengers reign palette, oil-on-canvas grain, cinematic lighting…"
              className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent"
              rows={4}
              maxLength={2000}
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Negative prompt</label>
            <textarea
              value={draft.negativePrompt}
              onChange={(e) => updateDraft({ negativePrompt: e.target.value })}
              placeholder="blurry, lowres, watermark, extra fingers…"
              className="w-full bg-port-bg border border-port-border rounded px-3 py-2 text-white text-sm focus:outline-none focus:border-port-accent"
              rows={4}
              maxLength={2000}
            />
          </div>
        </section>

        {/* Categories */}
        <section className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {WORLD_CATEGORIES.map((cat) => (
            <CategoryEditor
              key={cat}
              category={cat}
              variations={draft.categories?.[cat]?.variations || []}
              onChange={(next) => updateCategory(cat, next)}
            />
          ))}
        </section>

        {/* Render controls */}
        <section className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-white flex items-center gap-2">
            <FolderOpen size={16} className="text-port-accent" /> Batch render
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <NumberField label="Width" value={renderOpts.width} min={64} max={2048} onChange={(v) => setRenderOpts({ ...renderOpts, width: v })} />
            <NumberField label="Height" value={renderOpts.height} min={64} max={2048} onChange={(v) => setRenderOpts({ ...renderOpts, height: v })} />
            <NumberField label="Steps" value={renderOpts.steps} min={1} max={150} onChange={(v) => setRenderOpts({ ...renderOpts, steps: v })} />
            <NumberField label="CFG" value={renderOpts.cfgScale} min={0} max={30} step={0.5} onChange={(v) => setRenderOpts({ ...renderOpts, cfgScale: v })} />
            <NumberField label="Per-variation" value={renderOpts.batchPerVariation} min={1} max={20} onChange={(v) => setRenderOpts({ ...renderOpts, batchPerVariation: v })} />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={renderOpts.mode || ''}
              onChange={(e) => setRenderOpts({ ...renderOpts, mode: e.target.value || undefined })}
              className="bg-port-bg border border-port-border rounded px-2 py-2 text-white text-sm min-h-[40px]"
            >
              <option value="">Default backend</option>
              <option value="local">Local (mflux)</option>
              <option value="codex">Codex</option>
            </select>
            <button
              onClick={handleRender}
              disabled={rendering || !selectedId || totalVariations === 0}
              className="px-4 py-2 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded flex items-center gap-2 min-h-[40px]"
            >
              {rendering ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
              Render {totalVariations * (renderOpts.batchPerVariation || 1)} image{totalVariations * (renderOpts.batchPerVariation || 1) === 1 ? '' : 's'}
            </button>
          </div>
          {!selectedId && <p className="text-xs text-gray-500">Save the world first to enable rendering.</p>}
        </section>

        {/* Run history */}
        {selectedId && runs.length > 0 && (
          <section className="bg-port-card border border-port-border rounded p-4">
            <h2 className="text-sm font-semibold text-white mb-2">Recent runs</h2>
            <ul className="flex flex-col gap-1">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center justify-between text-sm text-gray-300 border-b border-port-border/40 py-1.5">
                  <span className="truncate">
                    <span className="text-gray-500">{new Date(r.createdAt).toLocaleString()} —</span>{' '}
                    {r.promptCount} prompt{r.promptCount === 1 ? '' : 's'}
                  </span>
                  {r.collectionId && (
                    <Link
                      to={`/media/collections/${r.collectionId}`}
                      className="text-xs text-port-accent hover:underline whitespace-nowrap"
                    >
                      Open collection →
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </section>
    </div>
  );
}

function totalVariationCount(world) {
  return WORLD_CATEGORIES.reduce((n, c) => n + (world.categories?.[c]?.variations?.length || 0), 0);
}

function CategoryEditor({ category, variations, onChange }) {
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [editIdx, setEditIdx] = useState(null);
  const [editLabel, setEditLabel] = useState('');
  const [editPrompt, setEditPrompt] = useState('');

  const addVariation = () => {
    const label = newLabel.trim();
    const prompt = newPrompt.trim();
    if (!label || !prompt) return;
    onChange([...variations, { label: label.slice(0, 120), prompt: prompt.slice(0, 2000) }]);
    setNewLabel('');
    setNewPrompt('');
    setAdding(false);
  };

  const removeAt = (idx) => onChange(variations.filter((_, i) => i !== idx));

  const startEdit = (idx, v) => {
    setEditIdx(idx);
    setEditLabel(v.label);
    setEditPrompt(v.prompt);
  };

  const saveEdit = () => {
    const label = editLabel.trim();
    const prompt = editPrompt.trim();
    // Mirror addVariation()'s validation — server-side sanitize would drop
    // a blank entry on save/reload, so refuse rather than store ghost rows
    // the user can't see why they vanished.
    if (!label || !prompt) return;
    const next = [...variations];
    next[editIdx] = { label: label.slice(0, 120), prompt: prompt.slice(0, 2000) };
    onChange(next);
    setEditIdx(null);
  };

  return (
    <div className="bg-port-card border border-port-border rounded p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-white capitalize">
          {CATEGORY_LABELS[category] || category}
          <span className="ml-2 text-xs text-gray-500">{variations.length}</span>
        </h3>
        <button
          onClick={() => setAdding((v) => !v)}
          className="text-xs px-2 py-1 bg-port-accent/15 hover:bg-port-accent/25 text-port-accent rounded flex items-center gap-1 min-h-[40px] sm:min-h-0"
        >
          <Plus size={12} /> Add
        </button>
      </div>
      {adding && (
        <div className="bg-port-bg border border-port-border rounded p-2 mb-2 flex flex-col gap-2">
          <input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="Label (e.g. Crystalline canyon basin)"
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            maxLength={120}
          />
          <textarea
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder="Prompt fragment (subject only)"
            className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
            rows={2}
            maxLength={2000}
          />
          <div className="flex items-center gap-2">
            <button
              onClick={addVariation}
              disabled={!newLabel.trim() || !newPrompt.trim()}
              className="text-xs px-2 py-1 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded min-h-[40px] sm:min-h-0"
            >
              Save
            </button>
            <button
              onClick={() => { setAdding(false); setNewLabel(''); setNewPrompt(''); }}
              className="text-xs px-2 py-1 bg-port-bg hover:bg-port-border text-gray-300 rounded min-h-[40px] sm:min-h-0"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {variations.length === 0 ? (
        <p className="text-xs text-gray-500">No variations yet — expand the starter prompt or add one manually.</p>
      ) : (
        <ul className="flex flex-col gap-1.5 max-h-72 overflow-y-auto">
          {variations.map((v, idx) => (
            <li key={`${v.label}-${idx}`} className="bg-port-bg border border-port-border rounded p-2 text-sm">
              {editIdx === idx ? (
                <div className="flex flex-col gap-1">
                  <input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
                    maxLength={120}
                  />
                  <textarea
                    value={editPrompt}
                    onChange={(e) => setEditPrompt(e.target.value)}
                    rows={3}
                    className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
                    maxLength={2000}
                  />
                  <div className="flex gap-2">
                    <button onClick={saveEdit} className="text-xs px-2 py-1 bg-port-accent text-white rounded min-h-[40px] sm:min-h-0">Save</button>
                    <button onClick={() => setEditIdx(null)} className="text-xs px-2 py-1 bg-port-bg text-gray-300 rounded min-h-[40px] sm:min-h-0">Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-white font-medium truncate">{v.label}</div>
                    <div className="text-xs text-gray-400 line-clamp-2">{v.prompt}</div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => startEdit(idx, v)}
                      className="p-1 text-gray-400 hover:text-port-accent rounded"
                      title="Edit"
                    >
                      <Edit3 size={14} />
                    </button>
                    <button
                      onClick={() => removeAt(idx)}
                      className="p-1 text-gray-400 hover:text-red-400 rounded"
                      title="Remove"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NumberField({ label, value, min, max, step = 1, onChange }) {
  return (
    <label className="flex flex-col">
      <span className="text-xs text-gray-400 mb-1">{label}</span>
      <input
        type="number"
        value={value ?? ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') { onChange(undefined); return; }
          const n = Number(raw);
          if (Number.isFinite(n)) onChange(n);
        }}
        className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-sm focus:outline-none focus:border-port-accent min-h-[40px]"
      />
    </label>
  );
}

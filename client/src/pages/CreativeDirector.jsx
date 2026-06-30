import { useEffect, useState, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Plus, Film, Trash2, Play, Pause, FlaskConical, Sparkles } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listCreativeDirectorProjects,
  createCreativeDirectorProject,
  createSmokeTestCreativeDirectorProject,
  deleteCreativeDirectorProject,
  startCreativeDirectorProject,
  pauseCreativeDirectorProject,
} from '../services/apiCreativeDirector.js';
import { listCatalogIngredientsByIds } from '../services/apiCatalog.js';
import { listVideoModels } from '../services/apiImageVideo.js';
import ModelSelect from '../components/ModelSelect';
import PageHeader from '../components/PageHeader';

const ASPECT_RATIOS = ['16:9', '9:16', '1:1'];
const QUALITIES = ['draft', 'standard', 'high'];

const STATUS_COLORS = {
  draft: 'bg-port-border text-port-text',
  planning: 'bg-port-accent/30 text-port-accent',
  rendering: 'bg-port-accent/30 text-port-accent',
  stitching: 'bg-port-warning/30 text-port-warning',
  complete: 'bg-port-success/30 text-port-success',
  paused: 'bg-port-warning/30 text-port-warning',
  failed: 'bg-port-error/30 text-port-error',
};

export default function CreativeDirector() {
  const location = useLocation();
  const navigate = useNavigate();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [models, setModels] = useState([]);
  // Catalog "Remix into… → Creative Director" handoff (#1808). The ingredient
  // ids arrive in the generic `location.state.remix.ingredientIds`; we hydrate
  // them for the chip list and forward the ids on create so the server folds
  // them into the project cast + links catalog_ingredient_refs.
  const [remixIds, setRemixIds] = useState([]);
  const [remixIngredients, setRemixIngredients] = useState([]);
  const [form, setForm] = useState({
    name: '',
    aspectRatio: '16:9',
    quality: 'standard',
    modelId: '',
    targetDurationSeconds: 60,
    styleSpec: '',
    userStory: '',
    startingImageFile: '',
    disableAudio: true,
  });

  const fetchProjects = useCallback(() => {
    listCreativeDirectorProjects()
      .then((data) => { setProjects(data || []); setLoading(false); })
      .catch((err) => {
        toast.error(err?.message || 'Failed to load Creative Director projects');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchProjects();
    listVideoModels().then((m) => {
      setModels(m || []);
      // Prefer the first non-deprecated model as the default so new projects
      // don't start on a legacy backend.
      const preferred = (m || []).find((entry) => !entry.deprecated) || (m || [])[0];
      if (preferred && !form.modelId) setForm((f) => ({ ...f, modelId: preferred.id }));
    }).catch(() => {});
  }, [fetchProjects]);

  // Consume the remix handoff once at mount, then clear the history state so a
  // refresh doesn't re-seed (mirrors Story Builder's prefill-consume pattern).
  // Auto-open the create form so the seeded ingredient chips are visible.
  useEffect(() => {
    const ids = location.state?.remix?.ingredientIds;
    if (!Array.isArray(ids) || ids.length === 0) return;
    const cleanIds = ids.filter(Boolean).slice(0, 50);
    if (cleanIds.length === 0) return;
    setRemixIds(cleanIds);
    setShowForm(true);
    listCatalogIngredientsByIds(cleanIds, { silent: true })
      .then((res) => setRemixIngredients(Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : [])))
      .catch(() => {});
    // Clear the handoff state so a refresh doesn't re-seed (ids already captured).
    navigate('.', { replace: true, state: {} });
  }, []);

  // Drop any pending remix handoff so abandoned ingredient ids can't leak into
  // a later, unrelated project created from this list page (#1808 review).
  const clearRemix = () => { setRemixIds([]); setRemixIngredients([]); };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.modelId) {
      toast.error('Name and model are required');
      return;
    }
    const payload = {
      name: form.name.trim(),
      aspectRatio: form.aspectRatio,
      quality: form.quality,
      modelId: form.modelId,
      targetDurationSeconds: Number(form.targetDurationSeconds),
      styleSpec: form.styleSpec,
      userStory: form.userStory || null,
      startingImageFile: form.startingImageFile || null,
      disableAudio: form.disableAudio,
      // Catalog remix handoff (#1808): the server resolves these into the
      // project cast + catalog_ingredient_refs.
      ...(remixIds.length ? { catalogIngredientIds: remixIds } : {}),
    };
    try {
      const created = await createCreativeDirectorProject(payload);
      setProjects((prev) => [...prev, created]);
      setShowForm(false);
      setForm((f) => ({ ...f, name: '', styleSpec: '', userStory: '', startingImageFile: '' }));
      toast.success(`Created "${created.name}"`);
      // Land on the seeded project's overview when ingredients were remixed in
      // so the user sees the cast immediately; otherwise stay on the list.
      if (remixIds.length) {
        clearRemix();
        navigate(`/media/creative-director/${created.id}/overview`);
      }
    } catch (err) {
      toast.error(err.message || 'Failed to create project');
    }
  };

  // Optimistic-update the row in place rather than refetching the whole list
  // (per CLAUDE.md "Reactive UI updates"). The detail page's poll picks up the
  // server's authoritative status within 5s if anything diverges.
  const handleStart = async (id) => {
    try {
      await startCreativeDirectorProject(id);
      setProjects((prev) => prev.map((p) => p.id === id ? { ...p, status: p.treatment ? 'rendering' : 'planning' } : p));
      toast.success('Pipeline started');
    } catch (err) {
      toast.error(err.message || 'Failed to start');
    }
  };

  const handlePause = async (id) => {
    try {
      await pauseCreativeDirectorProject(id);
      setProjects((prev) => prev.map((p) => p.id === id ? { ...p, status: 'paused' } : p));
      toast.success('Paused');
    } catch (err) {
      toast.error(err.message || 'Failed to pause');
    }
  };

  const handleDelete = async (id) => {
    // No confirmation modal yet — destructive but reversible if you re-create.
    // Future: inline two-click confirm pattern.
    try {
      await deleteCreativeDirectorProject(id);
      setProjects((prev) => prev.filter((p) => p.id !== id));
      toast.success('Deleted');
    } catch (err) {
      toast.error(err.message || 'Failed to delete');
    }
  };

  if (loading) {
    return <div className="p-6 text-port-text-muted">Loading projects…</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        icon={Film}
        title="Creative Director"
        subtitle="Long-form video projects driven by an autonomous CoS agent"
        actions={
          <>
            <button
              onClick={async () => {
                const created = await createSmokeTestCreativeDirectorProject().catch((e) => {
                  toast.error(e?.message || 'Smoke test failed to start');
                  return null;
                });
                if (!created) return;
                toast.success('Smoke test project started');
                setProjects((prev) => [created, ...prev]);
              }}
              className="flex items-center gap-2 bg-port-card border border-port-border hover:bg-port-card/60 text-port-text px-3 py-2 rounded text-sm"
              title="Create + start a deterministic 3-scene colored-ball project (auto-accept, no audio)"
            >
              <FlaskConical className="w-4 h-4" />
              Run smoke test
            </button>
            <button
              onClick={() => { setShowForm((s) => !s); clearRemix(); }}
              className="flex items-center gap-2 bg-port-accent hover:bg-port-accent/80 text-white px-3 py-2 rounded text-sm"
            >
              <Plus className="w-4 h-4" />
              New project
            </button>
          </>
        }
      />

      {showForm && (
        <form onSubmit={handleCreate} className="shrink-0 p-6 border-b border-port-border bg-port-card/40 space-y-3">
          {remixIngredients.length > 0 && (
            <div className="rounded border border-port-accent/40 bg-port-accent/10 px-3 py-2">
              <div className="text-xs uppercase tracking-wide text-port-accent mb-1.5">
                Casting from {remixIngredients.length} catalog ingredient{remixIngredients.length === 1 ? '' : 's'}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {remixIngredients.map((ing) => (
                  <span
                    key={ing.id}
                    className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-port-bg border border-port-border text-gray-200"
                  >
                    <Sparkles className="w-3 h-3 text-port-accent" aria-hidden="true" />
                    {ing.name || '(untitled)'}
                  </span>
                ))}
              </div>
              <p className="text-xs text-port-text-muted mt-1.5">
                These become the project cast — the Creative Director grounds the treatment and per-scene casting on them.
              </p>
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="text-port-text-muted">Name</span>
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="My Episode"
                className="w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
                maxLength={200}
              />
            </label>
            <label className="block text-sm">
              <span className="text-port-text-muted">Model</span>
              <ModelSelect
                models={models}
                value={form.modelId}
                onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                getLabel={(m) => m.name || m.id}
                className="w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="text-port-text-muted">Aspect ratio</span>
              <select
                value={form.aspectRatio}
                onChange={(e) => setForm({ ...form, aspectRatio: e.target.value })}
                className="w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
              >
                {ASPECT_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-port-text-muted">Quality</span>
              <select
                value={form.quality}
                onChange={(e) => setForm({ ...form, quality: e.target.value })}
                className="w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
              >
                {QUALITIES.map((q) => <option key={q} value={q}>{q}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-port-text-muted">Target duration (seconds, max 600)</span>
              <input
                type="number"
                min={5}
                max={600}
                value={form.targetDurationSeconds}
                onChange={(e) => setForm({ ...form, targetDurationSeconds: e.target.value })}
                className="w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="text-port-text-muted">Starting image filename (optional)</span>
              <input
                value={form.startingImageFile}
                onChange={(e) => setForm({ ...form, startingImageFile: e.target.value })}
                placeholder="my-image.png (basename in /data/images)"
                className="w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
                maxLength={256}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={form.disableAudio}
              onChange={(e) => setForm({ ...form, disableAudio: e.target.checked })}
              className="accent-port-accent"
            />
            <span className="text-port-text-muted">Disable audio</span>
          </label>
          <label className="block text-sm">
            <span className="text-port-text-muted">Style spec</span>
            <textarea
              value={form.styleSpec}
              onChange={(e) => setForm({ ...form, styleSpec: e.target.value })}
              placeholder="Cinematic, painterly, warm color palette, slow camera dolly…"
              className="w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm h-24 font-mono"
              maxLength={5000}
            />
          </label>
          <label className="block text-sm">
            <span className="text-port-text-muted">User-supplied story (optional — leave blank to let the agent invent one)</span>
            <textarea
              value={form.userStory}
              onChange={(e) => setForm({ ...form, userStory: e.target.value })}
              placeholder="Open on a foggy mountain. A traveler descends into the valley below…"
              className="w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm h-24 font-mono"
              maxLength={10000}
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className="bg-port-accent hover:bg-port-accent/80 text-white px-3 py-1.5 rounded text-sm">
              Create
            </button>
            <button type="button" onClick={() => { setShowForm(false); clearRemix(); }} className="bg-port-card border border-port-border px-3 py-1.5 rounded text-sm">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="flex-1 overflow-auto p-6">
        {projects.length === 0 && !showForm && (
          <div className="text-port-text-muted text-sm">
            No projects yet. Click <span className="text-port-text">New project</span> to start one.
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {projects.map((p) => (
            <div key={p.id} className="bg-port-card border border-port-border rounded p-3 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <Link to={`/media/creative-director/${p.id}/overview`} className="flex-1 min-w-0">
                  <div className="font-medium truncate">{p.name}</div>
                  <div className="text-xs text-port-text-muted truncate">{p.id}</div>
                </Link>
                <span className={`text-xs px-2 py-0.5 rounded ${STATUS_COLORS[p.status] || ''}`}>{p.status}</span>
              </div>
              <div className="text-xs text-port-text-muted">
                {p.aspectRatio} • {p.quality} • {p.modelId} • {p.targetDurationSeconds}s target
              </div>
              <div className="text-xs text-port-text-muted">
                {p.treatment?.scenes?.length ? `${p.treatment.scenes.filter((s) => s.status === 'accepted').length}/${p.treatment.scenes.length} scenes accepted` : 'No treatment yet'}
              </div>
              <div className="flex gap-1 mt-1">
                {/* Pause is meaningful only when the agent could be in flight.
                    `draft` has nothing running yet, and the terminal states are
                    obviously inert — match the detail page's gating. */}
                {!['paused', 'complete', 'failed', 'draft'].includes(p.status) && (
                  <button onClick={() => handlePause(p.id)} className="flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs">
                    <Pause className="w-3 h-3" /> Pause
                  </button>
                )}
                {(p.status === 'paused' || p.status === 'draft' || p.status === 'failed') && (
                  <button onClick={() => handleStart(p.id)} className="flex items-center gap-1 px-2 py-1 bg-port-accent/30 text-port-accent rounded text-xs">
                    <Play className="w-3 h-3" /> Start
                  </button>
                )}
                <button onClick={() => handleDelete(p.id)} className="ml-auto flex items-center gap-1 px-2 py-1 bg-port-bg border border-port-border rounded text-xs hover:bg-port-error/20 hover:text-port-error">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

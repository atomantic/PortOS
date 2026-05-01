import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Film, Trash2, Play, Pause } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listCreativeDirectorProjects,
  createCreativeDirectorProject,
  deleteCreativeDirectorProject,
  startCreativeDirectorProject,
  pauseCreativeDirectorProject,
} from '../services/apiCreativeDirector.js';
import { listVideoModels } from '../services/apiImageVideo.js';

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
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [models, setModels] = useState([]);
  const [form, setForm] = useState({
    name: '',
    aspectRatio: '16:9',
    quality: 'standard',
    modelId: '',
    targetDurationSeconds: 60,
    styleSpec: '',
    userStory: '',
    startingImageFile: '',
  });

  const fetchProjects = useCallback(() => {
    listCreativeDirectorProjects()
      .then((data) => { setProjects(data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchProjects();
    listVideoModels().then((m) => {
      setModels(m || []);
      if (m?.length && !form.modelId) setForm((f) => ({ ...f, modelId: m[0].id }));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchProjects]);

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
    };
    try {
      const created = await createCreativeDirectorProject(payload);
      setProjects((prev) => [...prev, created]);
      setShowForm(false);
      setForm((f) => ({ ...f, name: '', styleSpec: '', userStory: '', startingImageFile: '' }));
      toast.success(`Created "${created.name}"`);
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
      <div className="shrink-0 px-6 pt-6 pb-4 border-b border-port-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Film className="w-6 h-6 text-port-accent" />
            <div>
              <h1 className="text-xl font-semibold">Creative Director</h1>
              <p className="text-sm text-port-text-muted">Long-form video projects driven by an autonomous CoS agent</p>
            </div>
          </div>
          <button
            onClick={() => setShowForm((s) => !s)}
            className="flex items-center gap-2 bg-port-accent hover:bg-port-accent/80 text-white px-3 py-2 rounded text-sm"
          >
            <Plus className="w-4 h-4" />
            New project
          </button>
        </div>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="shrink-0 p-6 border-b border-port-border bg-port-card/40 space-y-3">
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
              <select
                value={form.modelId}
                onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                className="w-full mt-1 bg-port-bg border border-port-border rounded px-2 py-1 text-sm"
              >
                {models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
              </select>
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
            <button type="button" onClick={() => setShowForm(false)} className="bg-port-card border border-port-border px-3 py-1.5 rounded text-sm">
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
                {p.status !== 'paused' && p.status !== 'complete' && p.status !== 'failed' && (
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

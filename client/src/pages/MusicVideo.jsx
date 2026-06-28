import { useEffect, useState, useCallback } from 'react';
import { Plus, Film, Trash2, Music, Activity, ArrowUp, ArrowDown } from 'lucide-react';
import toast from '../components/ui/Toast';
import PageHeader from '../components/PageHeader';
import {
  listMusicVideoProjects,
  createMusicVideoProject,
  deleteMusicVideoProject,
  analyzeMusicVideoProject,
  addMusicVideoScene,
  updateMusicVideoScene,
  deleteMusicVideoScene,
  reorderMusicVideoScenes,
} from '../services/apiMusicVideo.js';
import { listTracks } from '../services/apiTracks.js';
import { formatDurationSec } from '../utils/formatters.js';

const MODES = ['director', 'autonomous'];

// The two timeline-bound scene fields rendered as identical number inputs.
const SCENE_TIME_FIELDS = [['Start', 'startSec'], ['End', 'endSec']];

const STATUS_COLORS = {
  draft: 'bg-port-border text-port-text',
  analyzed: 'bg-port-accent/30 text-port-accent',
  ready: 'bg-port-accent/30 text-port-accent',
  rendering: 'bg-port-warning/30 text-port-warning',
  complete: 'bg-port-success/30 text-port-success',
  failed: 'bg-port-error/30 text-port-error',
};

export default function MusicVideo() {
  const [projects, setProjects] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [form, setForm] = useState({ name: '', mode: 'director', trackId: '' });

  const selected = projects.find((p) => p.id === selectedId) || null;
  const replaceProject = (next) => setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)));

  useEffect(() => {
    listMusicVideoProjects()
      .then((data) => { setProjects(data || []); setLoading(false); })
      .catch((err) => { toast.error(err?.message || 'Failed to load music video projects'); setLoading(false); });
    listTracks({ silent: true }).then((t) => setTracks(t || [])).catch(() => setTracks([]));
  }, []);

  const trackName = useCallback((id) => tracks.find((t) => t.id === id)?.title || id || '—', [tracks]);

  const handleCreate = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    createMusicVideoProject({ name: form.name.trim(), mode: form.mode, trackId: form.trackId || null })
      .then((proj) => {
        setProjects((prev) => [...prev, proj]);
        setSelectedId(proj.id);
        setForm({ name: '', mode: 'director', trackId: '' });
        toast.success('Project created');
      })
      .catch((err) => toast.error(err?.message || 'Failed to create project'));
  };

  const handleDelete = (id) => {
    deleteMusicVideoProject(id)
      .then(() => {
        setProjects((prev) => prev.filter((p) => p.id !== id));
        if (selectedId === id) setSelectedId(null);
      })
      .catch((err) => toast.error(err?.message || 'Failed to delete project'));
  };

  const handleAnalyze = () => {
    if (!selected) return;
    setAnalyzing(true);
    analyzeMusicVideoProject(selected.id)
      .then((proj) => { replaceProject(proj); toast.success(`Analyzed — ${proj.audioAnalysis?.bpm ? `${proj.audioAnalysis.bpm} BPM` : 'no tempo detected'}`); })
      .catch((err) => toast.error(err?.message || 'Analysis failed'))
      .finally(() => setAnalyzing(false));
  };

  const handleAddScene = () => {
    addMusicVideoScene(selected.id, { prompt: '' })
      .then((scene) => replaceProject({ ...selected, scenes: [...(selected.scenes || []), scene] }))
      .catch((err) => toast.error(err?.message || 'Failed to add scene'));
  };

  // Optimistic local edit; PATCH on blur (silent — this owns its error toast).
  const editSceneLocal = (sceneId, patch) => {
    replaceProject({ ...selected, scenes: selected.scenes.map((s) => (s.sceneId === sceneId ? { ...s, ...patch } : s)) });
  };
  const saveScene = (sceneId, patch) => {
    updateMusicVideoScene(selected.id, sceneId, patch, { silent: true })
      .catch((err) => toast.error(err?.message || 'Failed to save scene'));
  };

  const handleDeleteScene = (sceneId) => {
    deleteMusicVideoScene(selected.id, sceneId)
      .then((proj) => replaceProject(proj))
      .catch((err) => toast.error(err?.message || 'Failed to delete scene'));
  };

  const moveScene = (idx, dir) => {
    const scenes = selected.scenes || [];
    const target = idx + dir;
    if (target < 0 || target >= scenes.length) return;
    const ids = scenes.map((s) => s.sceneId);
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    reorderMusicVideoScenes(selected.id, ids)
      .then((proj) => replaceProject(proj))
      .catch((err) => toast.error(err?.message || 'Failed to reorder'));
  };

  return (
    <div className="space-y-4">
      <PageHeader icon={Film} title="Music Video" subtitle="Director-controlled, beat-aware music videos" />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Projects + create */}
        <div className="space-y-3">
          <form onSubmit={handleCreate} className="bg-port-card border border-port-border rounded-lg p-3 space-y-2">
            <label htmlFor="mv-name" className="block text-sm font-medium">New project</label>
            <input
              id="mv-name" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="Project name" className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
            />
            <label htmlFor="mv-mode" className="block text-xs text-port-text-muted">Mode</label>
            <select id="mv-mode" value={form.mode} onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm">
              {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <label htmlFor="mv-track" className="block text-xs text-port-text-muted">Track (optional)</label>
            <select id="mv-track" value={form.trackId} onChange={(e) => setForm((f) => ({ ...f, trackId: e.target.value }))}
              className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm">
              <option value="">— no track —</option>
              {tracks.map((t) => <option key={t.id} value={t.id}>{t.title || t.id}</option>)}
            </select>
            <button type="submit" className="w-full flex items-center justify-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[40px] sm:min-h-0">
              <Plus size={16} /> Create
            </button>
          </form>

          <div className="space-y-1">
            {loading && <p className="text-sm text-port-text-muted">Loading…</p>}
            {!loading && projects.length === 0 && <p className="text-sm text-port-text-muted">No projects yet.</p>}
            {projects.map((p) => (
              <button key={p.id} onClick={() => setSelectedId(p.id)}
                className={`w-full text-left px-3 py-2 rounded border ${selectedId === p.id ? 'border-port-accent bg-port-accent/10' : 'border-port-border bg-port-card'}`}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm truncate">{p.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_COLORS[p.status] || 'bg-port-border'}`}>{p.status}</span>
                </div>
                <div className="text-xs text-port-text-muted flex items-center gap-1 mt-0.5">
                  <Music size={11} /> {trackName(p.trackId)} · {p.scenes?.length || 0} scenes
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Detail / scene board */}
        <div className="md:col-span-2">
          {!selected && <p className="text-sm text-port-text-muted">Select or create a project to open its scene board.</p>}
          {selected && (
            <div className="space-y-3">
              <div className="bg-port-card border border-port-border rounded-lg p-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h2 className="text-lg font-semibold">{selected.name}</h2>
                  <div className="flex items-center gap-2">
                    <button onClick={handleAnalyze} disabled={analyzing || (!selected.trackId && !selected.uploadedAudioFilename)}
                      title={!selected.trackId && !selected.uploadedAudioFilename ? 'Link a track first' : 'Analyze beat grid'}
                      className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[40px] sm:min-h-0 disabled:opacity-50">
                      <Activity size={15} /> {analyzing ? 'Analyzing…' : 'Analyze'}
                    </button>
                    <button onClick={() => handleDelete(selected.id)} title="Delete project"
                      className="flex items-center gap-1 text-port-error border border-port-border rounded px-2 py-1.5 text-sm min-h-[40px] sm:min-h-0">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                {selected.audioAnalysis && (
                  <div className="text-xs text-port-text-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    <span>Tempo: {selected.audioAnalysis.bpm ? `${selected.audioAnalysis.bpm} BPM` : '—'}</span>
                    <span>Duration: {formatDurationSec(selected.audioAnalysis.durationSec)}</span>
                    <span>Beats: {selected.audioAnalysis.beats?.length || 0}</span>
                    <span>Sections: {selected.audioAnalysis.sections?.length || 0}</span>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Scene board</h3>
                <button onClick={handleAddScene} className="flex items-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[40px] sm:min-h-0">
                  <Plus size={15} /> Add scene
                </button>
              </div>

              {(selected.scenes || []).length === 0 && <p className="text-sm text-port-text-muted">No scenes yet — add one to start the board.</p>}
              <div className="space-y-2">
                {(selected.scenes || []).map((scene, idx) => (
                  <div key={scene.sceneId} className="bg-port-card border border-port-border rounded-lg p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-mono text-port-text-muted">#{scene.order + 1}</span>
                      <div className="flex items-center gap-1">
                        <button onClick={() => moveScene(idx, -1)} disabled={idx === 0} className="p-1 disabled:opacity-30" title="Move up"><ArrowUp size={14} /></button>
                        <button onClick={() => moveScene(idx, 1)} disabled={idx === selected.scenes.length - 1} className="p-1 disabled:opacity-30" title="Move down"><ArrowDown size={14} /></button>
                        <button onClick={() => handleDeleteScene(scene.sceneId)} className="p-1 text-port-error" title="Delete scene"><Trash2 size={14} /></button>
                      </div>
                    </div>
                    <textarea
                      value={scene.prompt || ''} rows={2}
                      onChange={(e) => editSceneLocal(scene.sceneId, { prompt: e.target.value })}
                      onBlur={(e) => saveScene(scene.sceneId, { prompt: e.target.value })}
                      placeholder="Shot prompt — what this scene's video should show"
                      className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
                    />
                    <div className="flex flex-wrap gap-2 items-center text-xs">
                      {SCENE_TIME_FIELDS.map(([labelText, key]) => {
                        const toValue = (v) => (v === '' ? null : Number(v));
                        return (
                          <label key={key} className="flex items-center gap-1">{labelText}
                            <input type="number" min="0" step="0.1" value={scene[key] ?? ''} className="w-16 bg-port-bg border border-port-border rounded px-1 py-1"
                              onChange={(e) => editSceneLocal(scene.sceneId, { [key]: toValue(e.target.value) })}
                              onBlur={(e) => saveScene(scene.sceneId, { [key]: toValue(e.target.value) })} />
                          </label>
                        );
                      })}
                      <label className="flex items-center gap-1">
                        <input type="checkbox" checked={!!scene.beatAligned}
                          onChange={(e) => { editSceneLocal(scene.sceneId, { beatAligned: e.target.checked }); saveScene(scene.sceneId, { beatAligned: e.target.checked }); }} />
                        Beat-aligned
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

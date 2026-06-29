import { useEffect, useRef, useState, useCallback } from 'react';
import { Plus, Film, Trash2, Music, Activity, ArrowUp, ArrowDown, Image as ImageIcon } from 'lucide-react';
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
import { generateImage } from '../services/apiSystem.js';
import { listTracks } from '../services/apiTracks.js';
import { getMediaJob } from '../services/apiMediaJobs.js';
import socket from '../services/socket.js';
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
  // Per-scene reference-frame generation: sceneId → true while a render is in flight.
  const [genScenes, setGenScenes] = useState({});
  // Async-render correlation: in-flight media-job id → sceneId, so a queued
  // render's terminal image-gen:completed / image-gen:failed event clears the
  // right scene's spinner. The success image lands separately via the durable
  // music-video:scene-image event, but the SPINNER is cleared on job lifecycle
  // so a render whose attach hook 404s (scene deleted mid-render) or that fails
  // outright doesn't leave the button stuck on "Rendering…" forever.
  const pendingJobsRef = useRef(new Map());
  // Terminal events that arrived BEFORE the kickoff .then registered the job id.
  // The HTTP response and the WebSocket terminal event race on separate channels,
  // so a fast-failing queued job's event can land first; without this, that event
  // finds no pending entry, gets dropped, and the spinner sticks forever. Capped
  // (jobId → failed) so the terminal events of unrelated image-gen jobs across the
  // app can't grow it unbounded; the kickoff reconciles its own entry on arrival.
  const orphanTerminalsRef = useRef(new Map());

  const selected = projects.find((p) => p.id === selectedId) || null;
  const replaceProject = (next) => setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)));
  const clearGen = (sceneId) => setGenScenes((prev) => { const next = { ...prev }; delete next[sceneId]; return next; });
  // Merge ONLY a scene's referenceImageId via a functional update so a render
  // that resolves after the user edited the board can't clobber those edits with
  // a stale project snapshot. Shared by the socket handler and the synchronous
  // external-lane attach below.
  const applyReferenceImage = (projectId, sceneId, referenceImageId) =>
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, scenes: (p.scenes || []).map((s) => (s.sceneId === sceneId ? { ...s, referenceImageId } : s)) }
      : p)));

  // Socket lifecycle for async (local/Codex) reference-frame renders (#1760
  // Phase 1b). Three events, all broadcast to every client:
  //   - music-video:scene-image — durable attach filed by musicVideoSceneImageHook;
  //     fold the new referenceImageId onto the matching scene without a refetch,
  //     even for a project that isn't selected (a render that finished after
  //     navigating away still lands). It does NOT touch the spinner: an older
  //     render's scene-image can arrive while a newer one is still in flight, so
  //     the spinner is owned solely by the job-id-correlated terminal events below.
  //   - image-gen:completed / image-gen:failed — the job's terminal events;
  //     clear the spinner by correlating generationId → sceneId. Failure toasts.
  useEffect(() => {
    const onSceneImage = ({ projectId, sceneId, referenceImageId }) => {
      applyReferenceImage(projectId, sceneId, referenceImageId);
    };
    // jobId → pending error-toast timer (running-cancel deferral; see onFailed).
    const failTimers = new Map();
    const settle = (data, failed) => {
      const jobId = data?.generationId || data?.jobId;
      if (!jobId) return;
      const sceneId = pendingJobsRef.current.get(jobId);
      if (!sceneId) {
        // Not yet correlated (the kickoff .then hasn't registered it, or it's an
        // unrelated image-gen job). Stash it so a slightly-late registration can
        // reconcile; cap so other pages' renders can't grow this unbounded.
        const orphans = orphanTerminalsRef.current;
        orphans.set(jobId, !!failed);
        if (orphans.size > 64) orphans.delete(orphans.keys().next().value);
        return;
      }
      pendingJobsRef.current.delete(jobId);
      clearGen(sceneId);
      if (failed) toast.error('Frame render failed');
    };
    const onCompleted = (data) => settle(data, false);
    // Deferred failure toast for an owned render. A render canceled WHILE RUNNING
    // reaches us as image-gen:failed (SIGTERM) just before image-gen:canceled —
    // and before the queue flips the job to 'canceled' — so neither the failed
    // event nor an immediate status fetch can tell a cancel from a real failure
    // (#1791/#1796). image-gen:canceled cancels this timer in the common case;
    // if the timer fires first it re-polls the job and only toasts on a CONFIRMED
    // terminal failure — a still-'running'/'queued' status means the cancel (or
    // the failure transition) hasn't landed yet, so it re-polls a bounded number
    // of times rather than toasting prematurely (the spinner is already cleared,
    // so giving up silently never strands the UI).
    const armFailToast = (jobId, attempt = 0) => {
      failTimers.set(jobId, setTimeout(() => {
        failTimers.delete(jobId);
        getMediaJob(jobId)
          .then((job) => {
            const status = job?.status;
            if (status === 'canceled') return; // user cancel — never a failure toast
            if (status === 'failed' || status === 'error') { toast.error('Frame render failed'); return; }
            if (attempt < 2) armFailToast(jobId, attempt + 1); // non-terminal: wait, don't toast yet
          })
          .catch(() => toast.error('Frame render failed'));
      }, 800));
    };
    const onFailed = (data) => {
      const jobId = data?.generationId || data?.jobId;
      if (!jobId) return;
      // Only THIS page's renders surface a failure toast. An OWNED job clears the
      // spinner silently (settle with failed=false) and defers the toast above so
      // a running-cancel can retract it. A not-yet-owned job is stashed as an
      // orphan WITH the failure bit so a fast-fail that raced ahead of its own
      // kickoff registration is toasted by the kickoff .then reconciliation; an
      // unrelated image-gen job is simply capped/evicted from the orphan map
      // unseen (never reconciled → never toasts here).
      const owned = pendingJobsRef.current.has(jobId);
      settle(data, !owned);
      if (owned && !failTimers.has(jobId)) armFailToast(jobId);
    };
    // Queued-cancel emits no *:failed; running-cancel emits failed then this.
    // Either way clear the spinner and cancel any pending failure toast.
    const onCanceled = (data) => {
      const jobId = data?.generationId || data?.jobId;
      if (jobId) {
        const t = failTimers.get(jobId);
        if (t) { clearTimeout(t); failTimers.delete(jobId); }
      }
      settle(data, false);
    };
    socket.on('music-video:scene-image', onSceneImage);
    socket.on('image-gen:completed', onCompleted);
    socket.on('image-gen:failed', onFailed);
    socket.on('image-gen:canceled', onCanceled);
    return () => {
      socket.off('music-video:scene-image', onSceneImage);
      socket.off('image-gen:completed', onCompleted);
      socket.off('image-gen:failed', onFailed);
      socket.off('image-gen:canceled', onCanceled);
      for (const t of failTimers.values()) clearTimeout(t);
      failTimers.clear();
    };
  }, []);

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

  // The image prompt for a scene's reference frame: its frame prompt (or the
  // shot prompt as a fallback) suffixed with the project's global concept style.
  const buildFramePrompt = (scene) => {
    const base = (scene.framePrompt?.trim() || scene.prompt?.trim() || '');
    const style = selected?.concept?.style?.trim();
    return [base, style].filter(Boolean).join(', ');
  };

  // Render a still reference frame for one scene from its frame prompt. The
  // async local/Codex lanes ride the media-job queue and are attached durably
  // server-side (musicVideoSceneImageHook → music-video:scene-image); we record
  // the job id and let the terminal image-gen:completed/failed event clear the
  // spinner (so a failed render doesn't strand the button). The synchronous
  // external SD-API lane returns a finished filename inline — attach it here.
  const handleGenerateFrame = (scene) => {
    const prompt = buildFramePrompt(scene);
    if (!prompt) { toast.error('Add a frame prompt or shot prompt first'); return; }
    setGenScenes((prev) => ({ ...prev, [scene.sceneId]: true }));
    generateImage({ prompt, musicVideo: { projectId: selected.id, sceneId: scene.sceneId } }, { silent: true })
      .then((res) => {
        const stillRunning = res?.status === 'queued' || res?.status === 'running';
        if (stillRunning) {
          // async lane: correlate the job so its terminal event clears the spinner
          // (and the durable scene-image event lands the generated frame).
          const jobId = res?.jobId || res?.generationId;
          if (!jobId) { clearGen(scene.sceneId); return; } // no id to track → don't strand the button
          // The terminal event may have raced ahead of this .then (fast fail) —
          // if so, reconcile it now instead of registering a job that's already done.
          if (orphanTerminalsRef.current.has(jobId)) {
            const failed = orphanTerminalsRef.current.get(jobId);
            orphanTerminalsRef.current.delete(jobId);
            clearGen(scene.sceneId);
            if (failed) toast.error('Frame render failed');
            return;
          }
          pendingJobsRef.current.set(jobId, scene.sceneId);
          return;
        }
        const filename = res?.filename;
        if (filename) {
          applyReferenceImage(selected.id, scene.sceneId, filename);
          updateMusicVideoScene(selected.id, scene.sceneId, { referenceImageId: filename }, { silent: true })
            .catch((err) => toast.error(err?.message || 'Failed to attach frame'));
        }
        clearGen(scene.sceneId);
      })
      .catch((err) => {
        toast.error(err?.message || 'Frame generation failed');
        clearGen(scene.sceneId);
      });
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
                    {/* Reference frame — the still image that seeds this shot (Phase 1b) */}
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                      <textarea
                        value={scene.framePrompt || ''} rows={2}
                        onChange={(e) => editSceneLocal(scene.sceneId, { framePrompt: e.target.value })}
                        onBlur={(e) => saveScene(scene.sceneId, { framePrompt: e.target.value || null })}
                        placeholder="Reference frame prompt — the still that seeds this shot (defaults to the shot prompt)"
                        className="flex-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm"
                      />
                      <div className="flex items-center gap-2">
                        {scene.referenceImageId && (
                          <img src={`/data/images/${scene.referenceImageId}`} alt="Reference frame"
                            className="w-16 h-16 object-cover rounded border border-port-border" />
                        )}
                        <button onClick={() => handleGenerateFrame(scene)} disabled={!!genScenes[scene.sceneId]}
                          className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[40px] sm:min-h-0 whitespace-nowrap"
                          title="Generate a still reference frame for this scene">
                          {genScenes[scene.sceneId] ? <Activity size={14} className="animate-spin" /> : <ImageIcon size={14} />}
                          {genScenes[scene.sceneId] ? 'Rendering…' : (scene.referenceImageId ? 'Regenerate frame' : 'Generate frame')}
                        </button>
                      </div>
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

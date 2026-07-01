import { useEffect, useState, useCallback } from 'react';
import { Plus, Film, Trash2, Music, Activity, ArrowUp, ArrowDown, Image as ImageIcon, Video, Wand2, Download } from 'lucide-react';
import toast from '../components/ui/Toast';
import PageHeader from '../components/PageHeader';
import {
  listMusicVideoProjects,
  createMusicVideoProject,
  updateMusicVideoProject,
  deleteMusicVideoProject,
  analyzeMusicVideoProject,
  planMusicVideoProject,
  addMusicVideoScene,
  updateMusicVideoScene,
  deleteMusicVideoScene,
  reorderMusicVideoScenes,
  renderMusicVideoProject,
  musicVideoRenderEventsUrl,
  cancelMusicVideoRender,
} from '../services/apiMusicVideo.js';
import { generateImage } from '../services/apiSystem.js';
import { generateVideo } from '../services/apiImageVideo.js';
import { listTracks } from '../services/apiTracks.js';
import BeatTimeline from '../components/musicVideo/BeatTimeline.jsx';
import { autoArrangeScenes } from '../lib/beatGrid.js';
import useSceneRenderLifecycle from '../hooks/useSceneRenderLifecycle.js';
import useYoutubeTrackImport from '../hooks/useYoutubeTrackImport.js';
import { useSseProgress, isTerminalSseFrame } from '../hooks/useSseProgress.js';
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

// The URL input + Import/Cancel button pairing for a useYoutubeTrackImport
// slot — shared by the create form (full-size) and the detail view's
// track-change row (compact, inline in a flex-wrap toolbar). #1945
function YoutubeImportControls({ id, url, onUrlChange, job, onStart, compact = false }) {
  const size = compact ? 12 : 13;
  const py = compact ? 'py-1' : 'py-1.5';
  const btnExtra = compact ? '' : 'text-xs whitespace-nowrap min-h-[40px] sm:min-h-0';
  return (
    <>
      <input
        id={id} type="url" value={url} onChange={onUrlChange} disabled={job.active}
        placeholder="Import audio from a YouTube URL…" aria-label="Import audio from a YouTube URL"
        className={`${compact ? 'flex-1 min-w-[160px]' : 'flex-1 min-w-0'} bg-port-bg border border-port-border rounded px-2 ${py} text-sm disabled:opacity-50`}
      />
      {job.active ? (
        <button type="button" onClick={job.cancel}
          className={`flex items-center gap-1 bg-port-warning/20 text-port-warning border border-port-border rounded px-2 ${py} ${btnExtra}`}>
          <Activity size={size} className="animate-spin" /> {job.percent}%
        </button>
      ) : (
        <button type="button" onClick={onStart} disabled={!url.trim()}
          title="Download and extract this video's audio as a track"
          className={`flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 ${py} ${btnExtra} disabled:opacity-50`}>
          <Download size={size} /> Import
        </button>
      )}
    </>
  );
}

export default function MusicVideo() {
  const [projects, setProjects] = useState([]);
  const [tracks, setTracks] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [form, setForm] = useState({ name: '', mode: 'director', trackId: '' });
  const selected = projects.find((p) => p.id === selectedId) || null;

  // YouTube audio import (#1945): paste a URL, PortOS downloads + extracts the
  // track via yt-dlp and lands it in the shared library. Two independent job
  // slots — one per surface that can kick off an import — so starting one
  // doesn't orphan the other's in-flight job (see useYoutubeTrackImport).
  const [ytUrlCreate, setYtUrlCreate] = useState('');
  const [ytUrlEdit, setYtUrlEdit] = useState('');
  const attachImportedTrack = (track) => setTracks((prev) => [...prev, track]);
  const ytImportCreate = useYoutubeTrackImport({
    onComplete: (track) => {
      attachImportedTrack(track);
      setForm((f) => ({ ...f, trackId: track.id }));
      setYtUrlCreate('');
    },
  });
  const ytImportEdit = useYoutubeTrackImport({
    onComplete: (track, projectId) => {
      attachImportedTrack(track);
      updateMusicVideoProject(projectId, { trackId: track.id }, { silent: true })
        .then((proj) => replaceProject(proj))
        .catch((err) => toast.error(err?.message || 'Imported the track but failed to attach it to the project'));
      setYtUrlEdit('');
    },
  });
  const replaceProject = (next) => setProjects((prev) => prev.map((p) => (p.id === next.id ? next : p)));
  // `ytImportEdit` is one shared job slot for the whole detail view (not
  // per-project) — switching the selected project while it has an import in
  // flight would silently orphan that job's SSE subscription (the finished
  // track would land in the library but never get attached, since the
  // completion handler's onComplete never fires for a target nobody is
  // listening for anymore) and misattribute its progress UI to whichever
  // project is now selected. Block switching until that import settles.
  const selectProject = (id) => {
    if (ytImportEdit.active && id !== selectedId) {
      toast.error('Finish or cancel the in-progress YouTube import before switching projects');
      return;
    }
    setSelectedId(id);
  };
  // Merge ONLY a scene's referenceImageId via a functional update so a render
  // that resolves after the user edited the board can't clobber those edits with
  // a stale project snapshot. Shared by the socket handler and the synchronous
  // external-lane attach below.
  const applyReferenceImage = (projectId, sceneId, referenceImageId) =>
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, scenes: (p.scenes || []).map((s) => (s.sceneId === sceneId ? { ...s, referenceImageId } : s)) }
      : p)));
  // Merge ONLY a scene's videoHistoryId via a functional update (same stale-
  // snapshot guard as applyReferenceImage above).
  const applySceneVideo = (projectId, sceneId, videoHistoryId) =>
    setProjects((prev) => prev.map((p) => (p.id === projectId
      ? { ...p, scenes: (p.scenes || []).map((s) => (s.sceneId === sceneId ? { ...s, videoHistoryId } : s)) }
      : p)));

  // Per-scene async-render lifecycle for each lane (#1798). One hook call owns a
  // lane's spinner state, job-id correlation, orphan-terminal reconcile, and
  // socket subscription — the client-side analog of the server's #1791
  // image/video hook unification. The reference-frame lane attaches the finished
  // still durably via music-video:scene-image; the i2v lane attaches the clip via
  // music-video:scene-video. Both ride the media-job queue, so the spinner is
  // cleared by the job-id-correlated *-gen:completed/failed/canceled events.
  const frameLane = useSceneRenderLifecycle({
    attachEvent: 'music-video:scene-image',
    completedEvent: 'image-gen:completed',
    failedEvent: 'image-gen:failed',
    canceledEvent: 'image-gen:canceled',
    apply: ({ projectId, sceneId, referenceImageId }) => applyReferenceImage(projectId, sceneId, referenceImageId),
    failMessage: 'Frame render failed',
  });
  const videoLane = useSceneRenderLifecycle({
    attachEvent: 'music-video:scene-video',
    completedEvent: 'video-gen:completed',
    failedEvent: 'video-gen:failed',
    canceledEvent: 'video-gen:canceled',
    apply: ({ projectId, sceneId, videoHistoryId }) => applySceneVideo(projectId, sceneId, videoHistoryId),
    failMessage: 'Scene video render failed',
  });
  const genScenes = frameLane.genScenes;
  const genVideoScenes = videoLane.genScenes;

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
        selectProject(proj.id);
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

  // Autonomous shot planner (#1855): propose one scene per analyzed audio
  // section (energy-aware durations fall out of the section boundaries
  // themselves) and seed them onto the board, optionally with a first-pass
  // framePrompt/prompt per scene. Director-first — seeded scenes are
  // ordinary, fully-editable board entries, same as a hand-added one.
  const handlePlan = () => {
    if (!selected?.audioAnalysis) return;
    setPlanning(true);
    planMusicVideoProject(selected.id, { seedPrompts: true })
      .then(({ project, scenesAdded, promptsSeeded, promptsSkippedReason }) => {
        replaceProject(project);
        const suffix = promptsSeeded
          ? ' with first-pass prompts'
          : (promptsSkippedReason && promptsSkippedReason !== 'not-requested' ? ` (prompts skipped: ${promptsSkippedReason})` : '');
        toast.success(`Planned ${scenesAdded} scene${scenesAdded === 1 ? '' : 's'}${suffix}`);
      })
      .catch((err) => toast.error(err?.message || 'Plan failed'))
      .finally(() => setPlanning(false));
  };

  // Auto-arrange (#1915): distribute every scene across the analyzed song
  // sections weighted by each section's energy, writing the same persisted
  // startSec/endSec/beatAligned fields the manual drag-snap arranger (#1854)
  // writes — a director-tunable starting point honored exactly at render time.
  // Optimistically applies the whole arrangement to the local board, then
  // persists each scene sequentially (the per-project load-modify-save can't
  // drop a write that way). Silent PATCHes — the catch owns the only error toast.
  const handleAutoArrange = () => {
    if (!selected?.audioAnalysis) return;
    const scenes = selected.scenes || [];
    const arrangement = autoArrangeScenes(scenes, selected.audioAnalysis);
    if (arrangement.length === 0) {
      toast.error('Nothing to arrange — analyze the track and add scenes first');
      return;
    }
    const byId = new Map(arrangement.map((a) => [a.sceneId, a]));
    replaceProject({
      ...selected,
      scenes: scenes.map((s) => {
        const a = byId.get(s.sceneId);
        return a ? { ...s, startSec: a.startSec, endSec: a.endSec, beatAligned: a.beatAligned } : s;
      }),
    });
    setArranging(true);
    (async () => {
      for (const a of arrangement) {
        // Sequential by design — see the comment above (avoids a load-modify-save race).
        await updateMusicVideoScene(
          selected.id, a.sceneId,
          { startSec: a.startSec, endSec: a.endSec, beatAligned: a.beatAligned },
          { silent: true },
        );
      }
    })()
      .then(() => toast.success(`Auto-arranged ${arrangement.length} scene${arrangement.length === 1 ? '' : 's'} by energy`))
      .catch((err) => toast.error(err?.message || 'Auto-arrange failed'))
      .finally(() => setArranging(false));
  };

  // --- Render (#1760, Phase 2): assemble scene clips over the master audio bed.
  // The kickoff returns a jobId; progress streams over SSE via useSseProgress.
  const [render, setRender] = useState(null); // { jobId, projectId } while in flight
  const renderSse = useSseProgress(render ? musicVideoRenderEventsUrl(render.jobId) : null);
  const renderProgress = render ? Math.round((renderSse.latest?.progress ?? 0) * 100) : 0;
  // The number of scenes that already have a generated clip — the render's inputs.
  const renderableSceneCount = (selected?.scenes || []).filter((s) => s.videoHistoryId).length;

  // React to terminal SSE frames: record the render on the project, surface the
  // outcome, and clear the in-flight job. Functional update keys on the captured
  // projectId so a project switch mid-render can't misattribute the result.
  useEffect(() => {
    const frame = renderSse.latest;
    if (!render || !frame) return;
    if (frame.type === 'complete') {
      const result = frame.result || {};
      setProjects((prev) => prev.map((p) => (p.id === render.projectId
        ? { ...p, renderHistoryId: result.id || p.renderHistoryId, status: 'complete' } : p)));
      toast.success('Music video rendered');
      setRender(null);
    } else if (frame.type === 'error') {
      toast.error(frame.error || 'Render failed');
      setProjects((prev) => prev.map((p) => (p.id === render.projectId ? { ...p, status: 'failed' } : p)));
      setRender(null);
    } else if (frame.type === 'canceled' || frame.type === 'cancelled') {
      toast.info('Render cancelled');
      setRender(null);
    }
  }, [renderSse.latest]);
  // Stream closed on a NON-terminal frame (server restart mid-render, or the job
  // was pruned before/after attach so the 404 closes the stream) — recover so the
  // spinner can't hang. Gating on `!latest` is wrong: `latest` holds the last
  // *progress* frame once any progress streamed, so it would never fire. Mirror
  // VideoTimelineEditor: recover whenever the final frame isn't terminal.
  useEffect(() => {
    if (render && renderSse.closed && !isTerminalSseFrame(renderSse.latest)) {
      setRender(null);
      toast.info('Lost connection to the render — check Media History for the result');
    }
  }, [renderSse.closed]);

  const handleRender = () => {
    if (!selected) return;
    const projectId = selected.id;
    renderMusicVideoProject(projectId, { silent: true })
      .then(({ jobId }) => setRender({ jobId, projectId }))
      .catch((err) => {
        // 409 → a render is already in flight for this project; attach to it.
        if (err?.status === 409 && err?.context?.jobId) {
          setRender({ jobId: err.context.jobId, projectId });
          return;
        }
        toast.error(err?.message || 'Failed to start render');
      });
  };

  const handleCancelRender = () => {
    if (!render) return;
    cancelMusicVideoRender(render.jobId, { silent: true }).catch(() => {});
  };

  // Re-point the selected project at a different library track (the detail
  // view's "Change track" picker — previously there was no way to relink a
  // project's audio after creation at all).
  const handleChangeTrack = (trackId) => {
    if (!selected) return;
    updateMusicVideoProject(selected.id, { trackId }, { silent: true })
      .then((proj) => replaceProject(proj))
      .catch((err) => toast.error(err?.message || 'Failed to change track'));
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
  // BeatTimeline drag commit — same optimistic-local + silent-PATCH pattern as
  // the other scene field editors (#1854).
  const commitSceneTiming = (sceneId, patch) => {
    editSceneLocal(sceneId, patch);
    saveScene(sceneId, patch);
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
    frameLane.startScene(scene.sceneId);
    generateImage({ prompt, musicVideo: { projectId: selected.id, sceneId: scene.sceneId } }, { silent: true })
      .then((res) => {
        const stillRunning = res?.status === 'queued' || res?.status === 'running';
        if (stillRunning) {
          // async lane: correlate the job so its terminal event clears the spinner
          // (and the durable scene-image event lands the generated frame). trackJob
          // reconciles a terminal event that raced ahead of this .then (fast fail).
          const jobId = res?.jobId || res?.generationId;
          if (!jobId) { frameLane.clearScene(scene.sceneId); return; } // no id to track → don't strand the button
          frameLane.trackJob(jobId, scene.sceneId);
          return;
        }
        const filename = res?.filename;
        if (filename) {
          applyReferenceImage(selected.id, scene.sceneId, filename);
          updateMusicVideoScene(selected.id, scene.sceneId, { referenceImageId: filename }, { silent: true })
            .catch((err) => toast.error(err?.message || 'Failed to attach frame'));
        }
        frameLane.clearScene(scene.sceneId);
      })
      .catch((err) => {
        toast.error(err?.message || 'Frame generation failed');
        frameLane.clearScene(scene.sceneId);
      });
  };

  // The i2v prompt for a scene's clip: its shot prompt (or the frame prompt as a
  // fallback) suffixed with the project's global concept style. The reference
  // frame already fixes the look; this prompt guides the motion.
  const buildShotPrompt = (scene) => {
    const base = (scene.prompt?.trim() || scene.framePrompt?.trim() || '');
    const style = selected?.concept?.style?.trim();
    return [base, style].filter(Boolean).join(', ');
  };

  // Generate this scene's video from its chosen reference frame via the video
  // route's image (i2v) mode. The render always rides the media-job queue, so we
  // correlate the returned job id and let the terminal video-gen:completed/failed
  // event clear the spinner; the finished clip's history id lands durably via
  // music-video:scene-video (musicVideoSceneVideoHook). generateVideo() throws on
  // a non-OK response, so the catch owns the only error toast (no double-toast).
  const handleGenerateVideo = (scene) => {
    if (!scene.referenceImageId) { toast.error('Generate a reference frame first'); return; }
    const prompt = buildShotPrompt(scene);
    if (!prompt) { toast.error('Add a shot prompt first'); return; }
    videoLane.startScene(scene.sceneId);
    generateVideo({
      prompt,
      mode: 'image',
      sourceImageFile: scene.referenceImageId,
      musicVideo: JSON.stringify({ projectId: selected.id, sceneId: scene.sceneId }),
    })
      .then((res) => {
        const jobId = res?.jobId || res?.generationId;
        if (!jobId) { videoLane.clearScene(scene.sceneId); return; } // no id to track → don't strand the button
        // trackJob reconciles a terminal event that raced ahead of this .then.
        videoLane.trackJob(jobId, scene.sceneId);
      })
      .catch((err) => {
        toast.error(err?.message || 'Scene video generation failed');
        videoLane.clearScene(scene.sceneId);
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
            <label htmlFor="mv-yt-create" className="block text-xs text-port-text-muted">…or import audio from YouTube</label>
            <div className="flex gap-1">
              <YoutubeImportControls
                id="mv-yt-create" url={ytUrlCreate} onUrlChange={(e) => setYtUrlCreate(e.target.value)}
                job={ytImportCreate} onStart={() => ytImportCreate.start(ytUrlCreate)}
              />
            </div>
            {form.trackId && !ytImportCreate.active && (
              <p className="text-xs text-port-text-muted">Track set: {trackName(form.trackId)}</p>
            )}
            <button type="submit" className="w-full flex items-center justify-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[40px] sm:min-h-0">
              <Plus size={16} /> Create
            </button>
          </form>

          <div className="space-y-1">
            {loading && <p className="text-sm text-port-text-muted">Loading…</p>}
            {!loading && projects.length === 0 && <p className="text-sm text-port-text-muted">No projects yet.</p>}
            {projects.map((p) => (
              <button key={p.id} onClick={() => selectProject(p.id)}
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
                    <button onClick={handlePlan} disabled={planning || !selected.audioAnalysis}
                      title={!selected.audioAnalysis ? 'Analyze the track first' : 'AI-propose a scene per song section'}
                      className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[40px] sm:min-h-0 disabled:opacity-50">
                      <Wand2 size={15} /> {planning ? 'Planning…' : 'AI Plan'}
                    </button>
                    <button onClick={handleAutoArrange}
                      disabled={arranging || !selected.audioAnalysis || (selected.scenes || []).length === 0}
                      title={!selected.audioAnalysis
                        ? 'Analyze the track first'
                        : (selected.scenes || []).length === 0
                          ? 'Add scenes first'
                          : 'Distribute scenes across song sections by energy'}
                      className="flex items-center gap-1 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm min-h-[40px] sm:min-h-0 disabled:opacity-50">
                      <Wand2 size={15} /> {arranging ? 'Arranging…' : 'Auto-arrange'}
                    </button>
                    {render ? (
                      <button onClick={handleCancelRender} title="Cancel render"
                        className="flex items-center gap-1 bg-port-warning/20 text-port-warning border border-port-border rounded px-2 py-1.5 text-sm min-h-[40px] sm:min-h-0">
                        <Activity size={15} className="animate-spin" /> {renderProgress}% · Cancel
                      </button>
                    ) : (
                      <button onClick={handleRender} disabled={renderableSceneCount === 0}
                        title={renderableSceneCount === 0 ? 'Generate at least one scene video first' : 'Render the music video over the track'}
                        className="flex items-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[40px] sm:min-h-0 disabled:opacity-50">
                        <Film size={15} /> Render
                      </button>
                    )}
                    <button onClick={() => handleDelete(selected.id)} title="Delete project"
                      className="flex items-center gap-1 text-port-error border border-port-border rounded px-2 py-1.5 text-sm min-h-[40px] sm:min-h-0">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
                {/* Track picker — pick an existing library track or import fresh audio
                    from YouTube. Re-selecting either PATCHes the project's trackId. */}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-port-text-muted flex items-center gap-1"><Music size={12} /> {trackName(selected.trackId)}</span>
                  <select value={selected.trackId || ''} aria-label="Change track"
                    onChange={(e) => e.target.value && handleChangeTrack(e.target.value)}
                    className="bg-port-bg border border-port-border rounded px-1.5 py-1">
                    <option value="">Change track…</option>
                    {tracks.map((t) => <option key={t.id} value={t.id}>{t.title || t.id}</option>)}
                  </select>
                  <YoutubeImportControls
                    url={ytUrlEdit} onUrlChange={(e) => setYtUrlEdit(e.target.value)}
                    job={ytImportEdit} onStart={() => ytImportEdit.start(ytUrlEdit, selected.id)}
                    compact
                  />
                </div>
                {render && (
                  <div className="mt-2">
                    <div className="h-1.5 bg-port-bg rounded overflow-hidden">
                      <div className="h-full bg-port-accent transition-all" style={{ width: `${renderProgress}%` }} />
                    </div>
                    <p className="text-xs text-port-text-muted mt-1">Rendering music video — {renderProgress}%</p>
                  </div>
                )}
                {!render && selected.renderHistoryId && (
                  <div className="mt-2 text-xs flex items-center gap-2">
                    <Film size={14} className="text-port-success" />
                    <a href={`/media/history?preview=${encodeURIComponent(`video:${selected.renderHistoryId}`)}`}
                      className="text-port-accent">View rendered music video →</a>
                  </div>
                )}
                {selected.audioAnalysis && (
                  <div className="text-xs text-port-text-muted mt-2 flex flex-wrap gap-x-4 gap-y-1">
                    <span>Tempo: {selected.audioAnalysis.bpm ? `${selected.audioAnalysis.bpm} BPM` : '—'}</span>
                    <span>Duration: {formatDurationSec(selected.audioAnalysis.durationSec)}</span>
                    <span>Beats: {selected.audioAnalysis.beats?.length || 0}</span>
                    <span>Sections: {selected.audioAnalysis.sections?.length || 0}</span>
                  </div>
                )}
              </div>

              {selected.audioAnalysis && (selected.scenes || []).length > 0 && (
                <BeatTimeline audioAnalysis={selected.audioAnalysis} scenes={selected.scenes} onCommit={commitSceneTiming} />
              )}

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
                    {/* Scene clip — i2v video generated from the reference frame (Phase 1) */}
                    <div className="flex items-center gap-2 flex-wrap">
                      {scene.videoHistoryId && (
                        <video src={`/data/videos/${scene.videoHistoryId}.mp4`}
                          className="w-28 h-16 object-cover rounded border border-port-border bg-black"
                          muted playsInline preload="metadata" controls />
                      )}
                      <button onClick={() => handleGenerateVideo(scene)}
                        disabled={!scene.referenceImageId || !!genVideoScenes[scene.sceneId]}
                        className="flex items-center gap-1 bg-port-border hover:bg-port-border/70 disabled:opacity-50 rounded px-2 py-1.5 text-xs min-h-[40px] sm:min-h-0 whitespace-nowrap"
                        title={scene.referenceImageId ? "Generate this scene's video from its reference frame (i2v)" : 'Generate a reference frame first'}>
                        {genVideoScenes[scene.sceneId] ? <Activity size={14} className="animate-spin" /> : <Video size={14} />}
                        {genVideoScenes[scene.sceneId] ? 'Rendering…' : (scene.videoHistoryId ? 'Regenerate video' : 'Generate video')}
                      </button>
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

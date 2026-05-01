import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Play, Pause, Plus, Trash2, X, Save, Film, Loader2, ArrowLeft, Volume2, VolumeX,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';

// Project-time math helpers — every clip on the track contributes its trimmed
// duration (outSec - inSec) to project-time. Map between project-time `t`
// and the (clipIndex, withinClipSec) pair that the preview <video> element
// needs. A small epsilon avoids landing exactly on the boundary where the
// next clip's first frame might not be decoded yet.
const findClipAt = (clips, t) => {
  let acc = 0;
  for (let i = 0; i < clips.length; i++) {
    const dur = Math.max(0, clips[i].outSec - clips[i].inSec);
    if (t < acc + dur || i === clips.length - 1) {
      return { index: i, within: Math.max(0, t - acc), startAtProj: acc };
    }
    acc += dur;
  }
  return { index: -1, within: 0, startAtProj: 0 };
};
// Maps project-time t to (clipIndex, withinClipSec). The strictly-less-than
// comparison falls through on exact-boundary t to the next clip naturally.

const totalDuration = (clips) => clips.reduce((s, c) => s + Math.max(0, c.outSec - c.inSec), 0);

const formatTime = (sec) => {
  if (!Number.isFinite(sec) || sec < 0) return '0:00.00';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
};

// Draggable+sortable timeline block. Snaps the trimmed duration to a width
// derived from `pxPerSec` so longer clips visibly take more horizontal space.
function TimelineBlock({ clip, clipMeta, isSelected, isMissing, pxPerSec, onSelect, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clip._key });
  const dur = Math.max(0.05, clip.outSec - clip.inSec);
  const width = Math.max(60, dur * pxPerSec);
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    width: `${width}px`,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative shrink-0 h-20 rounded-md border-2 cursor-pointer transition-colors group ${
        isMissing
          ? 'bg-port-error/20 border-port-error'
          : isSelected
            ? 'border-port-accent bg-port-accent/10'
            : 'bg-port-card border-port-border hover:border-port-accent/50'
      }`}
      onClick={() => onSelect(clip._key)}
      {...attributes}
      {...listeners}
    >
      {clipMeta?.thumbnail && (
        <img
          src={`/data/video-thumbnails/${clipMeta.thumbnail}`}
          alt=""
          draggable={false}
          className="w-full h-full object-cover rounded-md opacity-80"
        />
      )}
      <div className="absolute inset-0 rounded-md bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
      <div className="absolute bottom-1 left-1.5 right-1.5 text-[10px] text-white truncate font-medium">
        {isMissing ? '(missing)' : clipMeta?.prompt?.slice(0, 40) || 'clip'}
      </div>
      <div className="absolute top-1 left-1.5 text-[9px] text-white bg-black/60 px-1 rounded">
        {dur.toFixed(2)}s
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(clip._key); }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute top-1 right-1 p-0.5 bg-black/60 hover:bg-port-error rounded opacity-0 group-hover:opacity-100 transition-opacity text-white"
        title="Remove from timeline"
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
}

// Library tile — renders a clip from history with an "Add to timeline" button.
// Does not use DnD here; click-to-add at end is simpler and equally functional
// for v1. Reordering on the timeline itself uses sortable.
function LibraryTile({ clip, onAdd }) {
  const dur = clip.numFrames && clip.fps ? clip.numFrames / clip.fps : 0;
  return (
    <div className="bg-port-card border border-port-border rounded-md overflow-hidden hover:border-port-accent/50 transition-colors">
      <div className="aspect-video bg-port-bg relative">
        {clip.thumbnail ? (
          <img src={`/data/video-thumbnails/${clip.thumbnail}`} alt={clip.prompt} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600">
            <Film className="w-6 h-6" />
          </div>
        )}
        <span className="absolute bottom-1 right-1 text-[9px] px-1 py-0.5 bg-black/70 text-white rounded">
          {dur.toFixed(1)}s
        </span>
      </div>
      <div className="p-1.5 space-y-1">
        <p className="text-[10px] text-gray-300 line-clamp-2" title={clip.prompt}>{clip.prompt}</p>
        <button
          type="button"
          onClick={() => onAdd(clip)}
          className="w-full flex items-center justify-center gap-1 px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded"
        >
          <Plus className="w-3 h-3" /> Add to timeline
        </button>
      </div>
    </div>
  );
}

export default function VideoTimelineEditor() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Local timeline (each clip gets a stable _key for dnd-kit identity)
  const [clips, setClips] = useState([]);
  const [selectedKey, setSelectedKey] = useState(null);
  const [pxPerSec, setPxPerSec] = useState(60);
  const [t, setT] = useState(0); // project-time in seconds
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [renderJobId, setRenderJobId] = useState(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [showLibrary, setShowLibrary] = useState(true);

  const videoRef = useRef(null);
  const lastSrcRef = useRef('');
  const playClipIndexRef = useRef(-1);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [proj, hist] = await Promise.all([
      api.getTimelineProject(projectId).catch((err) => { setError(err.message); return null; }),
      api.listVideoHistory().catch(() => []),
    ]);
    if (proj) {
      setProject(proj);
      setClips((proj.clips || []).map((c, idx) => ({ ...c, _key: `${c.clipId}-${idx}-${Math.random().toString(36).slice(2, 8)}` })));
    }
    setHistory(hist);
    setLoading(false);
  }, [projectId]);

  useEffect(() => { refresh(); }, [refresh]);

  // O(1) clip metadata lookup. The video-sync effect runs on every rAF tick
  // during playback; a linear find() per frame multiplied by clip count is
  // measurable on long timelines.
  const historyMap = useMemo(() => {
    const m = new Map();
    for (const h of history) m.set(h.id, h);
    return m;
  }, [history]);
  const metaFor = useCallback((clipId) => historyMap.get(clipId), [historyMap]);

  const total = useMemo(() => totalDuration(clips), [clips]);

  // Save current timeline (debounced via the caller). Server validates and
  // returns the canonical project; we only update updatedAt and preserve
  // local _keys to avoid blowing away the dnd identity.
  const saveTimeline = useCallback(async (next) => {
    if (!project) return false;
    const cleanClips = next.map((c) => ({ clipId: c.clipId, inSec: c.inSec, outSec: c.outSec }));
    const updated = await api.updateTimelineProject(projectId, {
      clips: cleanClips,
      expectedUpdatedAt: project.updatedAt,
    }).catch((err) => {
      if (err.code === 'CONFLICT') {
        toast.error('Project was modified elsewhere — reloading');
        refresh();
        return null;
      }
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    if (!updated) return false;
    setProject((p) => ({ ...p, updatedAt: updated.updatedAt }));
    return true;
  }, [project, projectId, refresh]);

  // Debounced save: trim-input edits fire many PATCHes per drag if we don't
  // batch them. 400ms gives the user time to stop fiddling before we hit the
  // server.
  const saveTimerRef = useRef(null);
  const queueSave = useCallback((next) => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => saveTimeline(next), 400);
  }, [saveTimeline]);

  // Drop any pending debounced save when the editor unmounts so a stale
  // timeout doesn't fire after navigation.
  useEffect(() => () => clearTimeout(saveTimerRef.current), []);

  const updateClips = useCallback((updater) => {
    setClips((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      queueSave(next);
      return next;
    });
  }, [queueSave]);

  // Add a clip to the end of the timeline at its full natural duration
  const addClip = (clip) => {
    const fullDur = clip.numFrames && clip.fps ? clip.numFrames / clip.fps : 4;
    const next = {
      _key: `${clip.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      clipId: clip.id,
      inSec: 0,
      outSec: fullDur,
    };
    updateClips((prev) => [...prev, next]);
    setSelectedKey(next._key);
  };

  const removeClip = (key) => {
    updateClips((prev) => prev.filter((c) => c._key !== key));
    if (selectedKey === key) setSelectedKey(null);
  };

  // Update the inSec/outSec of the selected clip; clamp to 0..sourceDuration.
  const editSelected = (patch) => {
    updateClips((prev) => prev.map((c) => {
      if (c._key !== selectedKey) return c;
      const meta = metaFor(c.clipId);
      const sourceDur = meta?.numFrames && meta?.fps ? meta.numFrames / meta.fps : Infinity;
      let inSec = patch.inSec != null ? patch.inSec : c.inSec;
      let outSec = patch.outSec != null ? patch.outSec : c.outSec;
      inSec = Math.max(0, Math.min(inSec, sourceDur - 0.04));
      outSec = Math.max(inSec + 0.04, Math.min(outSec, sourceDur));
      return { ...c, inSec, outSec };
    }));
  };

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    updateClips((prev) => {
      const oldIdx = prev.findIndex((c) => c._key === active.id);
      const newIdx = prev.findIndex((c) => c._key === over.id);
      if (oldIdx === -1 || newIdx === -1) return prev;
      return arrayMove(prev, oldIdx, newIdx);
    });
  };

  // Preview playback: keep a single <video> element that follows project-time.
  // On every rAF tick, advance `t` by elapsed wall-time, find which clip we're
  // in, and swap the <video>.src + currentTime when crossing a boundary.
  const rafRef = useRef(null);
  const lastTickRef = useRef(0);
  useEffect(() => {
    if (!playing) return;
    lastTickRef.current = performance.now();
    const tick = (now) => {
      const dt = (now - lastTickRef.current) / 1000;
      lastTickRef.current = now;
      setT((prev) => {
        const next = prev + dt;
        if (next >= total) {
          setPlaying(false);
          return total;
        }
        return next;
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing, total]);

  // Sync the <video> element to project-time `t` whenever it changes.
  useEffect(() => {
    if (clips.length === 0) return;
    const { index, within } = findClipAt(clips, t);
    if (index < 0) return;
    const clip = clips[index];
    const meta = metaFor(clip.clipId);
    if (!meta) return;
    const src = `/data/videos/${meta.filename}`;
    const video = videoRef.current;
    if (!video) return;
    if (lastSrcRef.current !== src) {
      lastSrcRef.current = src;
      video.src = src;
      // Wait for metadata before seeking — seek-before-load silently no-ops
      // and the user sees frame 0 of the clip instead of `inSec + within`.
      video.onloadedmetadata = () => {
        video.currentTime = clip.inSec + within;
        if (playing) video.play().catch(() => {});
      };
    } else if (index !== playClipIndexRef.current) {
      // Same src is re-used by adjacent same-clip uses; just seek.
      video.currentTime = clip.inSec + within;
    }
    playClipIndexRef.current = index;
  }, [clips, t, metaFor, playing]);

  // Pause/play the underlying element in lockstep with `playing`.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) video.play().catch(() => {});
    else video.pause();
  }, [playing]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = muted;
  }, [muted]);

  const handleRender = async () => {
    if (clips.length === 0) {
      toast.error('Add at least one clip before rendering');
      return;
    }
    // Flush any pending PATCH so the server-side render reads the latest
    // layout. If the save fails (conflict, network), abort — otherwise we'd
    // render a stale server-side timeline while the UI shows fresh edits.
    clearTimeout(saveTimerRef.current);
    const saved = await saveTimeline(clips);
    if (!saved) return;
    const result = await api.renderTimelineProject(projectId).catch((err) => {
      if (err.code === 'RENDER_IN_PROGRESS') {
        const jobId = err.context?.jobId;
        if (jobId) { setRenderJobId(jobId); toast('Re-attaching to in-flight render'); return null; }
      }
      toast.error(`Render failed: ${err.message}`);
      return null;
    });
    if (result?.jobId) {
      setRenderJobId(result.jobId);
      setRenderProgress(0);
    }
  };

  // SSE progress wiring — opens an EventSource on the render jobId, updates
  // the progress bar, and on 'complete' navigates to Media History focused
  // on the new clip.
  useEffect(() => {
    if (!renderJobId) return;
    const es = new EventSource(`/api/video-timeline/${renderJobId}/events`);
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.type === 'progress') setRenderProgress(data.progress);
      else if (data.type === 'complete') {
        toast.success('Timeline rendered');
        es.close();
        setRenderJobId(null);
        navigate(`/media/history?focus=${data.result.id}`);
      } else if (data.type === 'error') {
        toast.error(data.error || 'Render failed');
        es.close();
        setRenderJobId(null);
      }
    };
    es.onerror = () => {
      es.close();
      toast.error('Lost connection to render — check Media History');
      setRenderJobId(null);
      setRenderProgress(0);
    };
    return () => es.close();
  }, [renderJobId, navigate]);

  if (loading) return <div className="text-gray-500 text-sm">Loading project…</div>;
  if (error || !project) {
    return (
      <div className="text-center py-12">
        <p className="text-port-error mb-3">{error || 'Project not found'}</p>
        <button
          type="button"
          onClick={() => navigate('/media/timeline')}
          className="px-3 py-2 bg-port-accent hover:bg-port-accent/80 text-white text-sm rounded-md"
        >
          Back to projects
        </button>
      </div>
    );
  }

  const selectedClip = clips.find((c) => c._key === selectedKey);
  const selectedMeta = selectedClip ? metaFor(selectedClip.clipId) : null;
  const selectedSourceDur = selectedMeta?.numFrames && selectedMeta?.fps ? selectedMeta.numFrames / selectedMeta.fps : null;

  // Filter the library: hide outputs of any timeline render so the rail
  // doesn't grow unbounded with the user's own renders.
  const libraryClips = history.filter((h) => !h.timelineProjectId && !h.hidden);

  const usedClipIds = new Set(clips.map((c) => c.clipId));
  const missingKeys = new Set(clips.filter((c) => !metaFor(c.clipId)).map((c) => c._key));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => navigate('/media/timeline')}
            className="p-1.5 text-gray-400 hover:text-white"
            title="Back to projects"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <input
            type="text"
            value={project.name}
            onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))}
            onBlur={async (e) => {
              const trimmed = e.target.value.trim();
              if (!trimmed || trimmed === project.name) return;
              const updated = await api.updateTimelineProject(projectId, {
                name: trimmed, expectedUpdatedAt: project.updatedAt,
              }).catch(() => null);
              if (updated) setProject((p) => ({ ...p, name: updated.name, updatedAt: updated.updatedAt }));
            }}
            className="bg-transparent text-white font-medium text-lg focus:outline-none focus:bg-port-card focus:px-2 rounded transition-all"
          />
          <span className="text-xs text-gray-500">{clips.length} clips · {formatTime(total)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowLibrary((v) => !v)}
            className="px-2 py-1.5 text-xs text-gray-400 hover:text-white border border-port-border rounded-md"
          >
            {showLibrary ? 'Hide library' : 'Show library'}
          </button>
          <button
            type="button"
            onClick={handleRender}
            disabled={clips.length === 0 || !!renderJobId}
            className="flex items-center gap-2 px-3 py-1.5 bg-port-success hover:bg-port-success/80 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm rounded-md"
          >
            {renderJobId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {renderJobId ? `Rendering ${(renderProgress * 100).toFixed(0)}%` : 'Render'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr_240px] gap-3 min-h-[400px]">
        {/* Left rail — library */}
        {showLibrary && (
          <div className="bg-port-card/50 border border-port-border rounded-lg p-2 max-h-[600px] overflow-y-auto">
            <div className="text-xs uppercase text-gray-500 tracking-wide mb-2 px-1">Clip library</div>
            {libraryClips.length === 0 ? (
              <div className="text-xs text-gray-500 px-1 py-4">No clips. Generate some on the Video page.</div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {libraryClips.map((clip) => (
                  <div key={clip.id} className={usedClipIds.has(clip.id) ? 'ring-1 ring-port-accent/40 rounded-md' : ''}>
                    <LibraryTile clip={clip} onAdd={addClip} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Center — preview + track */}
        <div className="space-y-3 min-w-0">
          <div className="bg-black rounded-lg overflow-hidden aspect-video relative">
            <video
              ref={videoRef}
              className="w-full h-full"
              playsInline
              preload="auto"
            />
            {clips.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">
                Add clips to start
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-gray-400">
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              disabled={clips.length === 0}
              className="p-2 bg-port-card border border-port-border rounded-md hover:border-port-accent disabled:opacity-40"
              title={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              className="p-2 bg-port-card border border-port-border rounded-md hover:border-port-accent"
              title={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0.01, total)}
              step={0.01}
              value={Math.min(t, total)}
              onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }}
              className="flex-1"
              disabled={clips.length === 0}
            />
            <span className="font-mono text-[11px] tabular-nums">
              {formatTime(t)} / {formatTime(total)}
            </span>
            <label className="flex items-center gap-1 ml-2">
              <span>zoom</span>
              <input
                type="range"
                min={20}
                max={200}
                value={pxPerSec}
                onChange={(e) => setPxPerSec(Number(e.target.value))}
                className="w-20"
              />
            </label>
          </div>

          <div className="bg-port-card/30 border border-port-border rounded-lg p-2 overflow-x-auto">
            {clips.length === 0 ? (
              <div className="text-xs text-gray-500 py-6 text-center">
                Drag-drop reorder once you've added clips. Add from the library on the left.
              </div>
            ) : (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                <SortableContext items={clips.map((c) => c._key)} strategy={horizontalListSortingStrategy}>
                  <div className="flex gap-1 items-stretch min-w-min py-1">
                    {clips.map((clip) => (
                      <TimelineBlock
                        key={clip._key}
                        clip={clip}
                        clipMeta={metaFor(clip.clipId)}
                        isSelected={clip._key === selectedKey}
                        isMissing={missingKeys.has(clip._key)}
                        pxPerSec={pxPerSec}
                        onSelect={setSelectedKey}
                        onRemove={removeClip}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>

        {/* Right rail — inspector */}
        <div className="bg-port-card/50 border border-port-border rounded-lg p-3 space-y-3">
          <div className="text-xs uppercase text-gray-500 tracking-wide">Inspector</div>
          {!selectedClip ? (
            <div className="text-xs text-gray-500">Select a clip on the timeline to trim it.</div>
          ) : missingKeys.has(selectedClip._key) ? (
            <div className="text-xs text-port-error space-y-2">
              <p>Source clip missing — it may have been deleted from the gallery. Remove this block from the timeline.</p>
              <button
                type="button"
                onClick={() => removeClip(selectedClip._key)}
                className="w-full px-2 py-1.5 bg-port-error/20 hover:bg-port-error/40 text-port-error text-xs rounded flex items-center justify-center gap-1"
              >
                <Trash2 className="w-3 h-3" /> Remove
              </button>
            </div>
          ) : (
            <>
              {selectedMeta?.thumbnail && (
                <img
                  src={`/data/video-thumbnails/${selectedMeta.thumbnail}`}
                  alt=""
                  className="w-full aspect-video object-cover rounded"
                />
              )}
              <div className="text-[11px] text-gray-300 line-clamp-3" title={selectedMeta?.prompt}>
                {selectedMeta?.prompt}
              </div>
              <div className="text-[10px] text-gray-500">
                source: {selectedSourceDur?.toFixed(2) ?? '?'}s · {selectedMeta?.width}×{selectedMeta?.height} · {selectedMeta?.fps}fps
              </div>
              <label className="block text-xs text-gray-400">
                In (s)
                <input
                  type="number"
                  step="0.05"
                  min={0}
                  max={selectedSourceDur || undefined}
                  value={selectedClip.inSec.toFixed(2)}
                  onChange={(e) => editSelected({ inSec: Number(e.target.value) })}
                  className="w-full mt-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent"
                />
              </label>
              <label className="block text-xs text-gray-400">
                Out (s)
                <input
                  type="number"
                  step="0.05"
                  min={selectedClip.inSec + 0.05}
                  max={selectedSourceDur || undefined}
                  value={selectedClip.outSec.toFixed(2)}
                  onChange={(e) => editSelected({ outSec: Number(e.target.value) })}
                  className="w-full mt-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent"
                />
              </label>
              <div className="text-[10px] text-gray-500">
                trimmed: {(selectedClip.outSec - selectedClip.inSec).toFixed(2)}s
              </div>
              <button
                type="button"
                onClick={() => removeClip(selectedClip._key)}
                className="w-full px-2 py-1.5 bg-port-error/20 hover:bg-port-error/40 text-port-error text-xs rounded flex items-center justify-center gap-1"
              >
                <Trash2 className="w-3 h-3" /> Remove from timeline
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

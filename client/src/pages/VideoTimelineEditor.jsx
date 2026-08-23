import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
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
import { dndTransformToCss } from '../lib/dndTransform';
import {
  Play, Pause, Plus, Trash2, X, Save, Film, Loader2, ArrowLeft, Volume2, VolumeX,
  Image as ImageIcon, Music,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import { formatTimecode } from '../utils/formatters';
import { useSseProgress, isTerminalSseFrame } from '../hooks/useSseProgress';
import { clickableProps } from '../lib/a11yKeyboard.js';
import {
  assetUrl,
  segmentDuration,
  timelineDuration,
  findSegmentAt,
  fadeMultiplier,
  overlayOpacityAt,
  audioTrackStateAt,
  timelinePatch,
  withKeys,
  laneKey,
} from '../lib/videoTimelineModel';

const EMPTY_LANES = { segments: [], overlays: [], audio: { clipVolume: 1, tracks: [] } };

// Default lengths for a newly-added still/overlay/bed. The bed length is a
// guess — the client can't probe the file — so the server clamps it down to
// the real duration at render time.
const DEFAULT_STILL_SEC = 3;
const DEFAULT_OVERLAY_SEC = 3;
const DEFAULT_BED_SEC = 10;

const num2 = (n) => (Number.isFinite(n) ? Number(n).toFixed(2) : '');

const segmentLabel = (segment, meta) => {
  if (!segment) return 'clip';
  if (segment.type === 'still') return segment.assetFile || 'still';
  return meta?.prompt?.trim().slice(0, 40) || 'clip';
};

// Draggable+sortable video-lane block. Snaps the segment's project-time length
// to a width derived from `pxPerSec` so longer segments visibly take more
// horizontal space, and marks its fades so a cut reads at a glance.
export function TimelineBlock({ clip, clipMeta, isSelected, isMissing, pxPerSec, onSelect, onRemove }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clip._key });
  const isStill = clip.type === 'still';
  const dur = Math.max(0.05, segmentDuration(clip));
  const label = segmentLabel(clip, clipMeta);
  const removeLabel = isMissing ? 'missing clip' : label;
  const width = Math.max(60, dur * pxPerSec);
  const thumbSrc = isStill
    ? assetUrl(clip.assetKind, clip.assetFile)
    : (clipMeta?.thumbnail ? `/data/video-thumbnails/${clipMeta.thumbnail}` : null);
  const style = {
    transform: dndTransformToCss(transform),
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
      {...clickableProps(() => onSelect(clip._key))}
    >
      {thumbSrc && (
        <img
          src={thumbSrc}
          alt=""
          draggable={false}
          className="w-full h-full object-cover rounded-md opacity-80"
        />
      )}
      <div className="absolute inset-0 rounded-md bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
      {/* Fade ramps read as wedges of black over the head/tail of the block. */}
      {clip.fadeInSec > 0 && (
        <div
          data-testid="fade-in-ramp"
          aria-hidden="true"
          style={{ width: `${Math.min(100, (clip.fadeInSec / dur) * 100)}%` }}
          className="absolute inset-y-0 left-0 rounded-l-md bg-gradient-to-r from-black/80 to-transparent pointer-events-none"
        />
      )}
      {clip.fadeOutSec > 0 && (
        <div
          data-testid="fade-out-ramp"
          aria-hidden="true"
          style={{ width: `${Math.min(100, (clip.fadeOutSec / dur) * 100)}%` }}
          className="absolute inset-y-0 right-0 rounded-r-md bg-gradient-to-l from-black/80 to-transparent pointer-events-none"
        />
      )}
      <div className="absolute bottom-1 left-1.5 right-1.5 text-[10px] text-white truncate font-medium">
        {isMissing ? '(missing)' : label}
      </div>
      <div className="absolute top-1 left-1.5 text-[9px] text-white bg-black/60 px-1 rounded">
        {isStill ? `still · ${dur.toFixed(2)}s` : `${dur.toFixed(2)}s`}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(clip._key); }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute top-0 right-0 inline-flex min-w-[44px] min-h-[44px] items-start justify-end p-1 rounded opacity-40 lg:opacity-0 lg:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-white group/remove"
        title="Remove from timeline"
        aria-label={`Remove ${removeLabel} from timeline`}
      >
        <span className="inline-flex items-center justify-center p-0.5 bg-black/60 group-hover/remove:bg-port-error rounded transition-colors" aria-hidden="true">
          <X className="w-3 h-3" />
        </span>
      </button>
    </div>
  );
}

// A free-floating lane block (overlay or audio bed). Unlike the video lane
// these are positioned by absolute project time, so they carry no sort order —
// the inspector's start field is what moves them.
export function LaneBlock({ entry, label, tone, isSelected, isMissing, pxPerSec, onSelect, onRemove }) {
  const dur = Math.max(0.05, entry.durationSec || 0);
  const style = {
    left: `${(entry.startSec || 0) * pxPerSec}px`,
    width: `${Math.max(28, dur * pxPerSec)}px`,
  };
  return (
    <div
      style={style}
      className={`absolute top-1 bottom-1 rounded border cursor-pointer overflow-hidden ${
        isMissing
          ? 'bg-port-error/20 border-port-error'
          : isSelected
            ? 'border-port-accent bg-port-accent/20'
            : `${tone} hover:border-port-accent/50`
      }`}
      onClick={() => onSelect(entry._key)}
      {...clickableProps(() => onSelect(entry._key))}
    >
      <span className="absolute inset-x-1 top-0.5 text-[9px] text-white truncate pointer-events-none">
        {isMissing ? '(missing)' : label}
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(entry._key); }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute bottom-0 right-0 p-0.5 text-white/70 hover:text-port-error"
        title="Remove"
        aria-label={`Remove ${label} from timeline`}
      >
        <X className="w-3 h-3" aria-hidden="true" />
      </button>
    </div>
  );
}

// Library tile — renders a clip from history with an "Add to timeline" button.
// Does not use DnD here; click-to-add at end is simpler and equally functional.
// Reordering on the timeline itself uses sortable.
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

// Gallery tile — one image, two destinations. A still joins the video lane as
// its own held segment; an overlay floats above whatever is playing at the
// current playhead.
function StillTile({ image, onAddStill, onAddOverlay }) {
  const src = assetUrl('images', image.filename);
  return (
    <div className="bg-port-card border border-port-border rounded-md overflow-hidden hover:border-port-accent/50 transition-colors">
      <div className="aspect-video bg-port-bg">
        {src && <img src={src} alt={image.filename} className="w-full h-full object-cover" loading="lazy" />}
      </div>
      <div className="p-1.5 space-y-1">
        <p className="text-[10px] text-gray-300 truncate" title={image.filename}>{image.filename}</p>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onAddStill(image)}
            className="flex-1 px-1 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded"
          >
            Still
          </button>
          <button
            type="button"
            onClick={() => onAddOverlay(image)}
            className="flex-1 px-1 py-1 bg-port-card border border-port-border hover:border-port-accent text-gray-300 text-[10px] rounded"
          >
            Overlay
          </button>
        </div>
      </div>
    </div>
  );
}

function AudioRow({ track, onAdd }) {
  return (
    <div className="flex items-center gap-2 bg-port-card border border-port-border rounded-md px-2 py-1.5 hover:border-port-accent/50 transition-colors">
      <Music className="w-3 h-3 text-gray-500 shrink-0" aria-hidden="true" />
      <span className="text-[10px] text-gray-300 truncate flex-1" title={track.filename}>{track.label || track.filename}</span>
      <button
        type="button"
        onClick={() => onAdd(track)}
        className="px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded shrink-0"
      >
        Add
      </button>
    </div>
  );
}

// Inspector number input with its own draft state. Editing the canonical value
// on every keystroke forces each stroke through toFixed(), which prevents
// typing "0." at all; committing on blur avoids that and batches the PATCH.
function NumberField({ id, label, value, step = 0.05, min, max, hint, onCommit }) {
  const [draft, setDraft] = useState(num2(value));
  useEffect(() => { setDraft(num2(value)); }, [value]);
  return (
    <label htmlFor={id} className="block text-xs text-gray-400">
      {label}
      <input
        id={id}
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onCommit(n);
          else setDraft(num2(value));
        }}
        className="w-full mt-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm focus:outline-none focus:border-port-accent"
      />
      {hint && <span className="block mt-0.5 text-[10px] text-gray-500">{hint}</span>}
    </label>
  );
}

export default function VideoTimelineEditor() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [history, setHistory] = useState([]);
  const [images, setImages] = useState([]);
  const [musicTracks, setMusicTracks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // The three lanes live in ONE state object so a save always ships a
  // consistent snapshot — three separate useStates would let a debounced PATCH
  // read a half-updated timeline.
  const [lanes, setLanes] = useState(EMPTY_LANES);
  // { lane: 'segment' | 'overlay' | 'audio', key } — null when nothing is selected.
  const [selection, setSelection] = useState(null);
  // Track the current selection by its STABLE position so a refresh — which
  // regenerates every entry's random _key — can re-derive it instead of
  // collapsing the inspector to "Select a clip". Read from a ref so refresh
  // needn't depend on lanes/selection (which would re-trigger the load-on-mount loop).
  const selectionRef = useRef({ lane: null, index: -1 });
  const [pxPerSec, setPxPerSec] = useState(60);
  const [t, setT] = useState(0); // project-time in seconds
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [renderJobId, setRenderJobId] = useState(null);
  const [renderProgress, setRenderProgress] = useState(0);
  const [showLibrary, setShowLibrary] = useState(true);
  const [libraryTab, setLibraryTab] = useState('clips');
  // Local input draft. Editing the canonical state on every keystroke makes the
  // rename onBlur-vs-canonical comparison always-equal.
  const [nameDraft, setNameDraft] = useState('');

  const videoRef = useRef(null);
  const lastSrcRef = useRef('');
  // The video.onloadedmetadata callback fires async after a src swap. Reading
  // `playing` directly inside it captures the value at swap time — if the
  // user pauses while metadata loads, the handler would still autoplay. A
  // ref we update synchronously gives the handler the live value.
  const playingRef = useRef(false);
  useEffect(() => { playingRef.current = playing; }, [playing]);
  const playSegmentIndexRef = useRef(-1);
  // One <audio> element per bed track, keyed by its client-side _key.
  const bedRefs = useRef(new Map());

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const { segments, overlays, audio } = lanes;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [proj, hist, gallery, library] = await Promise.all([
      api.getTimelineProject(projectId).catch((err) => { setError(err.message); return null; }),
      api.listVideoHistory().catch(() => []),
      api.listImageGallery().catch(() => []),
      api.listMusicLibrary().catch(() => null),
    ]);
    if (proj) {
      const nextLanes = {
        segments: withKeys(proj.segments, 'seg'),
        overlays: withKeys(proj.overlays, 'ov'),
        audio: {
          clipVolume: proj.audio?.clipVolume == null ? 1 : proj.audio.clipVolume,
          tracks: withKeys(proj.audio?.tracks, 'bed'),
        },
      };
      setProject(proj);
      setLanes(nextLanes);
      // Re-derive selection from its lane + prior position so a refresh — e.g. a
      // CONFLICT reload mid-edit — doesn't leave `selection` pointing at a
      // now-regenerated _key and collapse the inspector.
      const { lane, index } = selectionRef.current;
      const laneEntries = lane === 'overlay' ? nextLanes.overlays
        : lane === 'audio' ? nextLanes.audio.tracks
          : lane === 'segment' ? nextLanes.segments : null;
      setSelection(laneEntries?.[index] ? { lane, key: laneEntries[index]._key } : null);
    }
    setHistory(Array.isArray(hist) ? hist : []);
    setImages(Array.isArray(gallery) ? gallery : []);
    // `null` = the request failed; `[]` = a genuinely empty library. Only the
    // former should leave the previous list alone.
    if (library) setMusicTracks(Array.isArray(library.tracks) ? library.tracks : []);
    setLoading(false);
  }, [projectId]);

  // Keep the stable-position mirror of the current selection current so refresh()
  // can reattach it after it regenerates lane _keys.
  useEffect(() => {
    if (!selection) { selectionRef.current = { lane: null, index: -1 }; return; }
    const entries = selection.lane === 'overlay' ? overlays
      : selection.lane === 'audio' ? audio.tracks : segments;
    const idx = entries.findIndex((e) => e._key === selection.key);
    selectionRef.current = idx >= 0 ? { lane: selection.lane, index: idx } : { lane: null, index: -1 };
  }, [selection, segments, overlays, audio.tracks]);

  useEffect(() => { refresh(); }, [refresh]);

  // Sync the rename draft to the canonical name when the project (re)loads
  // or is renamed elsewhere. Local edits (onChange) take over until the
  // user blurs.
  useEffect(() => {
    if (project?.name) setNameDraft(project.name);
  }, [project?.id, project?.name]);

  // O(1) clip metadata lookup. The video-sync effect runs on every rAF tick
  // during playback; a linear find() per frame multiplied by segment count is
  // measurable on long timelines.
  const historyMap = useMemo(() => {
    const m = new Map();
    for (const h of history) m.set(h.id, h);
    return m;
  }, [history]);
  const metaFor = useCallback((clipId) => historyMap.get(clipId), [historyMap]);

  const imageNames = useMemo(() => new Set(images.map((i) => i.filename)), [images]);
  const musicNames = useMemo(() => new Set(musicTracks.map((m) => m.filename)), [musicTracks]);

  // A lane entry is "missing" when its source is gone from the library it came
  // from — the render would 404, so the editor flags it up front.
  const isSegmentMissing = useCallback((seg) => (seg.type === 'still'
    ? !imageNames.has(seg.assetFile)
    : !metaFor(seg.clipId)), [imageNames, metaFor]);
  const isOverlayMissing = useCallback((ov) => !imageNames.has(ov.assetFile), [imageNames]);
  const isBedMissing = useCallback((tr) => tr.assetKind === 'music' && !musicNames.has(tr.assetFile), [musicNames]);

  const total = useMemo(() => timelineDuration(segments), [segments]);

  // Clamp the playhead into [0, total] when the timeline duration shrinks
  // (segment removal, tighter trim, etc.). Without this, t can exceed total
  // and findSegmentAt returns a `within` past the last segment's end — the
  // preview seeks to black frames.
  useEffect(() => {
    if (t > total) { setT(total); setPlaying(false); }
  }, [total, t]);

  // Save the whole timeline (debounced via the caller). The server validates
  // and returns the canonical project; we only update updatedAt and preserve
  // local _keys to avoid blowing away the dnd identity.
  const saveTimeline = useCallback(async (next) => {
    if (!project) return false;
    const updated = await api.updateTimelineProject(projectId, {
      ...timelinePatch(next),
      expectedUpdatedAt: project.updatedAt,
    }, { silent: true }).catch((err) => {
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

  // Debounced save: trim/fade edits fire many PATCHes per drag if we don't
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

  const updateLanes = useCallback((updater) => {
    setLanes((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      queueSave(next);
      return next;
    });
  }, [queueSave]);

  const patchSegment = useCallback((key, patch) => {
    updateLanes((prev) => ({
      ...prev,
      segments: prev.segments.map((s) => (s._key === key ? { ...s, ...patch(s) } : s)),
    }));
  }, [updateLanes]);

  const patchOverlay = useCallback((key, patch) => {
    updateLanes((prev) => ({
      ...prev,
      overlays: prev.overlays.map((o) => (o._key === key ? { ...o, ...patch(o) } : o)),
    }));
  }, [updateLanes]);

  const patchBed = useCallback((key, patch) => {
    updateLanes((prev) => ({
      ...prev,
      audio: { ...prev.audio, tracks: prev.audio.tracks.map((tr) => (tr._key === key ? { ...tr, ...patch(tr) } : tr)) },
    }));
  }, [updateLanes]);

  // --- Add / remove -----------------------------------------------------

  const addClip = (clip) => {
    const fullDur = clip.numFrames && clip.fps ? clip.numFrames / clip.fps : 4;
    const next = {
      _key: laneKey(clip.id, segments.length),
      type: 'clip',
      clipId: clip.id,
      inSec: 0,
      outSec: fullDur,
      fadeInSec: 0,
      fadeOutSec: 0,
      volume: 1,
    };
    updateLanes((prev) => ({ ...prev, segments: [...prev.segments, next] }));
    setSelection({ lane: 'segment', key: next._key });
  };

  const addStill = (image) => {
    const next = {
      _key: laneKey('still', segments.length),
      type: 'still',
      assetKind: 'images',
      assetFile: image.filename,
      durationSec: DEFAULT_STILL_SEC,
      fadeInSec: 0,
      fadeOutSec: 0,
    };
    updateLanes((prev) => ({ ...prev, segments: [...prev.segments, next] }));
    setSelection({ lane: 'segment', key: next._key });
  };

  const addOverlay = (image) => {
    const next = {
      _key: laneKey('ov', overlays.length),
      type: 'image',
      assetKind: 'images',
      assetFile: image.filename,
      startSec: Math.min(t, Math.max(0, total - 0.1)),
      durationSec: DEFAULT_OVERLAY_SEC,
      x: 0.05,
      y: 0.05,
      width: 0.25,
      opacity: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
    };
    updateLanes((prev) => ({ ...prev, overlays: [...prev.overlays, next] }));
    setSelection({ lane: 'overlay', key: next._key });
  };

  const addBed = (track) => {
    const next = {
      _key: laneKey('bed', audio.tracks.length),
      assetKind: 'music',
      assetFile: track.filename,
      startSec: Math.min(t, Math.max(0, total - 0.1)),
      offsetSec: 0,
      // The client can't probe the file; the server clamps this down to the
      // real duration when it renders.
      durationSec: Math.max(1, Math.min(DEFAULT_BED_SEC, total || DEFAULT_BED_SEC)),
      volume: 0.6,
      fadeInSec: 0,
      fadeOutSec: 0,
    };
    updateLanes((prev) => ({ ...prev, audio: { ...prev.audio, tracks: [...prev.audio.tracks, next] } }));
    setSelection({ lane: 'audio', key: next._key });
  };

  const removeFromLane = (lane, key) => {
    updateLanes((prev) => {
      if (lane === 'overlay') return { ...prev, overlays: prev.overlays.filter((o) => o._key !== key) };
      if (lane === 'audio') return { ...prev, audio: { ...prev.audio, tracks: prev.audio.tracks.filter((tr) => tr._key !== key) } };
      return { ...prev, segments: prev.segments.filter((s) => s._key !== key) };
    });
    setSelection((sel) => (sel && sel.key === key ? null : sel));
  };

  const onDragEnd = ({ active, over }) => {
    if (!over || active.id === over.id) return;
    updateLanes((prev) => {
      const oldIdx = prev.segments.findIndex((s) => s._key === active.id);
      const newIdx = prev.segments.findIndex((s) => s._key === over.id);
      if (oldIdx === -1 || newIdx === -1) return prev;
      return { ...prev, segments: arrayMove(prev.segments, oldIdx, newIdx) };
    });
  };

  // --- Preview ----------------------------------------------------------

  // Playback: keep a single <video> element that follows project-time. On every
  // rAF tick, advance `t` by elapsed wall-time; the sync effects below drive
  // the media elements from it.
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

  const active = useMemo(() => {
    if (segments.length === 0) return null;
    const { index, within } = findSegmentAt(segments, t);
    if (index < 0) return null;
    const segment = segments[index];
    return { index, within, segment, duration: segmentDuration(segment) };
  }, [segments, t]);

  // Sync the <video> element to project-time `t` whenever it changes. A still
  // segment has no video source — the effect parks the element so the <img>
  // below can take over the frame.
  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    if (!video) return;
    if (active.segment.type === 'still') {
      lastSrcRef.current = '';
      playSegmentIndexRef.current = active.index;
      video.pause();
      return;
    }
    const meta = metaFor(active.segment.clipId);
    if (!meta) return;
    const src = `/data/videos/${meta.filename}`;
    const wantTime = active.segment.inSec + active.within;
    if (lastSrcRef.current !== src) {
      lastSrcRef.current = src;
      video.src = src;
      // Wait for metadata before seeking — seek-before-load silently no-ops
      // and the user sees frame 0 of the clip instead of `inSec + within`.
      video.onloadedmetadata = () => {
        // Rapid scrubbing across segment boundaries reassigns src (and this
        // handler) before the prior metadata load fires; bail if this src is
        // no longer the one we want so a stale load can't seek the new clip.
        if (lastSrcRef.current !== src) return;
        video.currentTime = wantTime;
        if (playingRef.current) video.play().catch(() => {});
      };
    } else if (active.index !== playSegmentIndexRef.current) {
      video.currentTime = wantTime;
    } else if (!playing && Math.abs(video.currentTime - wantTime) > 0.05) {
      // Scrubbing while paused or moving the playhead within the same segment:
      // the rAF loop only fires while playing, so we need to drive the element
      // manually. During playback the video element advances on its own —
      // re-seeking on every rAF tick would cause buffering stutter.
      video.currentTime = wantTime;
    }
    playSegmentIndexRef.current = active.index;
  }, [active, metaFor, playing]);

  // Pause/play the underlying element in lockstep with `playing`. A still
  // segment holds no video, so there is nothing to start.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing && active?.segment.type !== 'still') video.play().catch(() => {});
    else video.pause();
  }, [playing, active?.segment.type]);

  useEffect(() => {
    const video = videoRef.current;
    if (video) video.muted = muted;
  }, [muted]);

  // Drive the bed <audio> elements from the same playhead the export mixes
  // against, so what the user hears while scrubbing is what amix will produce.
  useEffect(() => {
    for (const track of audio.tracks) {
      const el = bedRefs.current.get(track._key);
      if (!el) continue;
      const state = audioTrackStateAt(track, t);
      el.muted = muted;
      // clipVolume scales the video lane's OWN audio, not the bed — the export
      // applies it inside each segment's chain, before amix.
      el.volume = Math.min(1, Math.max(0, state.volume));
      if (!state.active) {
        if (!el.paused) el.pause();
        continue;
      }
      // Re-seeking every tick causes audible stutter; only correct real drift.
      if (Math.abs(el.currentTime - state.sourceTime) > 0.25) el.currentTime = state.sourceTime;
      if (playing && el.paused) el.play().catch(() => {});
      if (!playing && !el.paused) el.pause();
    }
  }, [audio.tracks, t, playing, muted]);

  // Stop every bed when the editor unmounts — a detached <audio> that was
  // playing keeps producing sound in some browsers.
  useEffect(() => {
    const els = bedRefs.current;
    return () => { for (const el of els.values()) el?.pause(); };
  }, []);

  // --- Render -----------------------------------------------------------

  const handleRender = async () => {
    if (segments.length === 0) {
      toast.error('Add at least one clip before rendering');
      return;
    }
    // Flush any pending PATCH so the server-side render reads the latest
    // layout. If the save fails (conflict, network), abort — otherwise we'd
    // render a stale server-side timeline while the UI shows fresh edits.
    clearTimeout(saveTimerRef.current);
    const saved = await saveTimeline(lanes);
    if (!saved) return;
    const result = await api.renderTimelineProject(projectId, { silent: true }).catch((err) => {
      if (err.code === 'RENDER_IN_PROGRESS') {
        const jobId = err.context?.jobId;
        if (jobId) { setRenderJobId(jobId); toast('Re-attaching to in-flight render'); return null; }
      }
      if (err.code === 'MISSING_CLIPS') {
        const gone = [...(err.context?.missingClipIds || []), ...(err.context?.missingAssets || [])];
        toast.error(`Render failed — ${gone.length} missing source${gone.length === 1 ? '' : 's'}`);
        return null;
      }
      toast.error(`Render failed: ${err.message}`);
      return null;
    });
    if (result?.jobId) {
      setRenderJobId(result.jobId);
      setRenderProgress(0);
    }
  };

  // SSE progress wiring — subscribes to the render jobId's event stream (via
  // the shared useSseProgress lifecycle), updates the progress bar, and on
  // 'complete' navigates to Media History focused on the new clip. Frame
  // shapes come from server/services/videoTimeline/local.js
  // (progress / complete / error / canceled).
  const { latest: renderFrame, closed: renderStreamClosed } = useSseProgress(
    renderJobId ? `/api/video-timeline/${renderJobId}/events` : null,
    { enabled: !!renderJobId },
  );
  useEffect(() => {
    if (!renderJobId || !renderFrame) return;
    if (renderFrame.type === 'progress') {
      setRenderProgress(renderFrame.progress);
      return;
    }
    // A genuine terminal frame sets `latest` and `closed` in the same commit,
    // so they're visible together here. A STALE terminal frame — the hook
    // keeps `latest` across the disabled gap, so starting a second render
    // briefly re-exposes the previous job's final frame — arrives with
    // `closed === false`; without this gate it would duplicate the toast and
    // tear down the new render's UI while ffmpeg keeps running.
    if (!renderStreamClosed || !isTerminalSseFrame(renderFrame)) return;
    if (renderFrame.type === 'complete') {
      toast.success('Timeline rendered');
      setRenderJobId(null);
      navigate(`/media/history?focus=${renderFrame.result.id}`);
    } else if (renderFrame.type === 'error') {
      toast.error(renderFrame.error || 'Render failed');
      setRenderJobId(null);
    } else {
      // canceled (either spelling — the hook treats both as terminal)
      toast('Render cancelled');
      setRenderJobId(null);
      setRenderProgress(0);
    }
  }, [renderJobId, renderFrame, renderStreamClosed, navigate]);
  useEffect(() => {
    // Stream ended without a terminal frame — connection lost. Terminal frames
    // are handled (and clear renderJobId) in the frame effect above.
    if (!renderJobId || !renderStreamClosed) return;
    if (isTerminalSseFrame(renderFrame)) return;
    toast.error('Lost connection to render — check Media History');
    setRenderJobId(null);
    setRenderProgress(0);
  }, [renderJobId, renderStreamClosed, renderFrame]);

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

  const selectedSegment = selection?.lane === 'segment' ? segments.find((s) => s._key === selection.key) : null;
  const selectedOverlay = selection?.lane === 'overlay' ? overlays.find((o) => o._key === selection.key) : null;
  const selectedBed = selection?.lane === 'audio' ? audio.tracks.find((tr) => tr._key === selection.key) : null;
  const selectedMeta = selectedSegment?.type === 'clip' ? metaFor(selectedSegment.clipId) : null;
  const selectedSourceDur = selectedMeta?.numFrames && selectedMeta?.fps ? selectedMeta.numFrames / selectedMeta.fps : null;

  // Filter the library: hide outputs of any timeline render so the rail
  // doesn't grow unbounded with the user's own renders.
  const libraryClips = history.filter((h) => !h.timelineProjectId && !h.hidden);
  const usedClipIds = new Set(segments.filter((s) => s.type === 'clip').map((s) => s.clipId));

  const activeStillSrc = active?.segment.type === 'still'
    ? assetUrl(active.segment.assetKind, active.segment.assetFile)
    : null;
  // The same linear ramp ffmpeg's `fade` applies, rendered as a black scrim so
  // the preview shows the cut the export will make.
  const activeFadeScrim = active
    ? 1 - fadeMultiplier(active.segment.fadeInSec || 0, active.segment.fadeOutSec || 0, active.duration, active.within)
    : 0;

  const laneWidth = Math.max(240, total * pxPerSec);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => navigate('/media/timeline')}
            className="p-1.5 text-gray-400 hover:text-white"
            title="Back to projects" aria-label="Back to projects"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <input
            type="text"
            aria-label="Project name"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={async (e) => {
              const trimmed = e.target.value.trim();
              if (!trimmed) { setNameDraft(project.name); return; }
              if (trimmed === project.name) return;
              const updated = await api.updateTimelineProject(projectId, {
                name: trimmed, expectedUpdatedAt: project.updatedAt,
              }, { silent: true }).catch((err) => {
                toast.error(`Rename failed: ${err.message}`);
                setNameDraft(project.name);
                return null;
              });
              if (updated) {
                setProject((p) => ({ ...p, name: updated.name, updatedAt: updated.updatedAt }));
                setNameDraft(updated.name);
              }
            }}
            className="bg-transparent text-white font-medium text-lg focus:outline-none focus:bg-port-card focus:px-2 rounded transition-all"
          />
          <span className="text-xs text-gray-500">
            {segments.length} segments · {overlays.length} overlays · {audio.tracks.length} beds · {formatTimecode(total)}
          </span>
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
            disabled={segments.length === 0 || !!renderJobId}
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
            <div className="flex gap-1 mb-2" role="tablist" aria-label="Clip library">
              {[
                { id: 'clips', label: 'Clips', Icon: Film },
                { id: 'stills', label: 'Stills', Icon: ImageIcon },
                { id: 'audio', label: 'Audio', Icon: Music },
              ].map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={libraryTab === id}
                  onClick={() => setLibraryTab(id)}
                  className={`flex-1 flex items-center justify-center gap-1 px-1.5 py-1 text-[10px] rounded ${
                    libraryTab === id
                      ? 'bg-port-accent/20 text-port-accent'
                      : 'text-gray-400 hover:text-white border border-port-border'
                  }`}
                >
                  <Icon className="w-3 h-3" aria-hidden="true" /> {label}
                </button>
              ))}
            </div>

            {libraryTab === 'clips' && (libraryClips.length === 0 ? (
              <div className="text-xs text-gray-500 px-1 py-4">No clips. Generate some on the Video page.</div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {libraryClips.map((clip) => (
                  <div key={clip.id} className={usedClipIds.has(clip.id) ? 'ring-1 ring-port-accent/40 rounded-md' : ''}>
                    <LibraryTile clip={clip} onAdd={addClip} />
                  </div>
                ))}
              </div>
            ))}

            {libraryTab === 'stills' && (images.length === 0 ? (
              <div className="text-xs text-gray-500 px-1 py-4">No images. Generate some on the Image page.</div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {images.map((image) => (
                  <StillTile key={image.filename} image={image} onAddStill={addStill} onAddOverlay={addOverlay} />
                ))}
              </div>
            ))}

            {libraryTab === 'audio' && (musicTracks.length === 0 ? (
              <div className="text-xs text-gray-500 px-1 py-4">No audio in the shared music library.</div>
            ) : (
              <div className="grid grid-cols-1 gap-1.5">
                {musicTracks.map((track) => (
                  <AudioRow key={track.filename} track={track} onAdd={addBed} />
                ))}
              </div>
            ))}
          </div>
        )}

        {/* Center — preview + tracks */}
        <div className="space-y-3 min-w-0">
          <div className="bg-black rounded-lg overflow-hidden aspect-video relative">
            <video
              ref={videoRef}
              className={`w-full h-full ${activeStillSrc ? 'invisible' : ''}`}
              playsInline
              preload="auto"
            />
            {activeStillSrc && (
              <img src={activeStillSrc} alt="" className="absolute inset-0 w-full h-full object-contain" />
            )}
            {/* Overlay lane, composited exactly as ffmpeg will: normalized
                position/width against the canvas, alpha from the same ramp. */}
            {overlays.map((ov) => {
              const opacity = overlayOpacityAt(ov, t);
              if (opacity <= 0) return null;
              const src = assetUrl(ov.assetKind, ov.assetFile);
              if (!src) return null;
              return (
                <img
                  key={ov._key}
                  src={src}
                  alt=""
                  data-testid="overlay-preview"
                  style={{
                    left: `${(ov.x || 0) * 100}%`,
                    top: `${(ov.y || 0) * 100}%`,
                    width: `${(ov.width || 0.25) * 100}%`,
                    opacity,
                  }}
                  className="absolute pointer-events-none"
                />
              );
            })}
            {activeFadeScrim > 0 && (
              <div
                data-testid="fade-scrim"
                aria-hidden="true"
                style={{ opacity: activeFadeScrim }}
                className="absolute inset-0 bg-black pointer-events-none"
              />
            )}
            {segments.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">
                Add clips to start
              </div>
            )}
          </div>

          {/* Bed playback elements. Hidden — the timeline lane is the UI. */}
          {audio.tracks.map((track) => {
            const src = assetUrl(track.assetKind, track.assetFile);
            if (!src) return null;
            return (
              <audio
                key={track._key}
                ref={(el) => {
                  if (el) bedRefs.current.set(track._key, el);
                  else bedRefs.current.delete(track._key);
                }}
                src={src}
                preload="auto"
                className="hidden"
              />
            );
          })}

          <div className="flex items-center gap-2 text-xs text-gray-400">
            <button
              type="button"
              onClick={() => setPlaying((p) => !p)}
              disabled={segments.length === 0}
              className="p-2 bg-port-card border border-port-border rounded-md hover:border-port-accent disabled:opacity-40"
              title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'}
            >
              {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => setMuted((m) => !m)}
              className="p-2 bg-port-card border border-port-border rounded-md hover:border-port-accent"
              title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
            <input
              type="range"
              aria-label="Playhead position"
              min={0}
              max={Math.max(0.01, total)}
              step={0.01}
              value={Math.min(t, total)}
              onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }}
              className="flex-1"
              disabled={segments.length === 0}
            />
            <span className="font-mono text-[11px] tabular-nums">
              {formatTimecode(t)} / {formatTimecode(total)}
            </span>
            <label htmlFor="timeline-zoom" className="flex items-center gap-1 ml-2">
              <span>zoom</span>
              <input
                id="timeline-zoom"
                type="range"
                min={20}
                max={200}
                value={pxPerSec}
                onChange={(e) => setPxPerSec(Number(e.target.value))}
                className="w-20"
              />
            </label>
          </div>

          <div className="bg-port-card/30 border border-port-border rounded-lg p-2 overflow-x-auto space-y-1">
            {segments.length === 0 ? (
              <div className="text-xs text-gray-500 py-6 text-center">
                Drag-drop reorder once you've added clips. Add clips, stills, overlays and audio from the library on the left.
              </div>
            ) : (
              <>
                <div className="text-[9px] uppercase tracking-wide text-gray-600 px-0.5">Video</div>
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                  <SortableContext items={segments.map((s) => s._key)} strategy={horizontalListSortingStrategy}>
                    <div className="flex gap-1 items-stretch min-w-min py-1">
                      {segments.map((segment) => (
                        <TimelineBlock
                          key={segment._key}
                          clip={segment}
                          clipMeta={segment.type === 'clip' ? metaFor(segment.clipId) : null}
                          isSelected={selection?.lane === 'segment' && segment._key === selection.key}
                          isMissing={isSegmentMissing(segment)}
                          pxPerSec={pxPerSec}
                          onSelect={(key) => setSelection({ lane: 'segment', key })}
                          onRemove={(key) => removeFromLane('segment', key)}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>

                <div className="text-[9px] uppercase tracking-wide text-gray-600 px-0.5 pt-1">Overlays</div>
                <div className="relative h-8 bg-port-bg/40 rounded" style={{ width: `${laneWidth}px` }}>
                  {overlays.length === 0 && (
                    <span className="absolute inset-0 flex items-center pl-2 text-[10px] text-gray-600">
                      Add an overlay from the Stills tab
                    </span>
                  )}
                  {overlays.map((ov) => (
                    <LaneBlock
                      key={ov._key}
                      entry={ov}
                      label={ov.assetFile}
                      tone="bg-port-accent/15 border-port-accent/40"
                      isSelected={selection?.lane === 'overlay' && ov._key === selection.key}
                      isMissing={isOverlayMissing(ov)}
                      pxPerSec={pxPerSec}
                      onSelect={(key) => setSelection({ lane: 'overlay', key })}
                      onRemove={(key) => removeFromLane('overlay', key)}
                    />
                  ))}
                  <div
                    data-testid="lane-playhead"
                    aria-hidden="true"
                    style={{ left: `${Math.min(t, total) * pxPerSec}px` }}
                    className="absolute inset-y-0 w-px bg-port-accent pointer-events-none"
                  />
                </div>

                <div className="text-[9px] uppercase tracking-wide text-gray-600 px-0.5 pt-1">Audio</div>
                <div className="relative h-8 bg-port-bg/40 rounded" style={{ width: `${laneWidth}px` }}>
                  {audio.tracks.length === 0 && (
                    <span className="absolute inset-0 flex items-center pl-2 text-[10px] text-gray-600">
                      Add a bed from the Audio tab
                    </span>
                  )}
                  {audio.tracks.map((track) => (
                    <LaneBlock
                      key={track._key}
                      entry={track}
                      label={track.assetFile}
                      tone="bg-port-success/15 border-port-success/40"
                      isSelected={selection?.lane === 'audio' && track._key === selection.key}
                      isMissing={isBedMissing(track)}
                      pxPerSec={pxPerSec}
                      onSelect={(key) => setSelection({ lane: 'audio', key })}
                      onRemove={(key) => removeFromLane('audio', key)}
                    />
                  ))}
                  <div
                    data-testid="lane-playhead"
                    aria-hidden="true"
                    style={{ left: `${Math.min(t, total) * pxPerSec}px` }}
                    className="absolute inset-y-0 w-px bg-port-accent pointer-events-none"
                  />
                </div>

              </>
            )}
          </div>
        </div>

        {/* Right rail — inspector */}
        <div className="bg-port-card/50 border border-port-border rounded-lg p-3 space-y-3">
          <div className="text-xs uppercase text-gray-500 tracking-wide">Inspector</div>

          {!selection && (
            <div className="text-xs text-gray-500">Select a block on the timeline to edit it.</div>
          )}

          {selectedSegment && isSegmentMissing(selectedSegment) && (
            <div className="text-xs text-port-error space-y-2">
              <p>Source missing — it may have been deleted from the gallery. Remove this block from the timeline.</p>
              <button
                type="button"
                onClick={() => removeFromLane('segment', selectedSegment._key)}
                className="w-full px-2 py-1.5 bg-port-error/20 hover:bg-port-error/40 text-port-error text-xs rounded flex items-center justify-center gap-1"
              >
                <Trash2 className="w-3 h-3" /> Remove
              </button>
            </div>
          )}

          {selectedSegment && !isSegmentMissing(selectedSegment) && selectedSegment.type === 'clip' && (
            <>
              {selectedMeta?.thumbnail && (
                <img src={`/data/video-thumbnails/${selectedMeta.thumbnail}`} alt="" className="w-full aspect-video object-cover rounded" />
              )}
              <div className="text-[11px] text-gray-300 line-clamp-3" title={selectedMeta?.prompt}>{selectedMeta?.prompt}</div>
              <div className="text-[10px] text-gray-500">
                source: {selectedSourceDur?.toFixed(2) ?? '?'}s · {selectedMeta?.width}×{selectedMeta?.height} · {selectedMeta?.fps}fps
              </div>
              <NumberField
                id="segment-in" label="In (s)" value={selectedSegment.inSec} min={0} max={selectedSourceDur || undefined}
                onCommit={(n) => patchSegment(selectedSegment._key, (s) => clampTrim(s, { inSec: n }, selectedSourceDur, selectedMeta?.fps))}
              />
              <NumberField
                id="segment-out" label="Out (s)" value={selectedSegment.outSec} min={0} max={selectedSourceDur || undefined}
                onCommit={(n) => patchSegment(selectedSegment._key, (s) => clampTrim(s, { outSec: n }, selectedSourceDur, selectedMeta?.fps))}
              />
              <div className="text-[10px] text-gray-500">
                trimmed: {segmentDuration(selectedSegment).toFixed(2)}s
              </div>
              <FadeFields
                idPrefix="segment"
                entry={selectedSegment}
                duration={segmentDuration(selectedSegment)}
                onCommit={(patch) => patchSegment(selectedSegment._key, (s) => fitFadePatch(s, patch, segmentDuration(s)))}
              />
              <NumberField
                id="segment-volume" label="Volume (×)" value={selectedSegment.volume ?? 1} step={0.05} min={0} max={4}
                onCommit={(n) => patchSegment(selectedSegment._key, () => ({ volume: clamp(n, 0, 4) }))}
              />
              <RemoveButton label="Remove from timeline" onClick={() => removeFromLane('segment', selectedSegment._key)} />
            </>
          )}

          {selectedSegment && !isSegmentMissing(selectedSegment) && selectedSegment.type === 'still' && (
            <>
              <img src={assetUrl(selectedSegment.assetKind, selectedSegment.assetFile)} alt="" className="w-full aspect-video object-cover rounded" />
              <div className="text-[11px] text-gray-300 truncate" title={selectedSegment.assetFile}>{selectedSegment.assetFile}</div>
              <NumberField
                id="still-duration" label="Hold (s)" value={selectedSegment.durationSec} min={0.05} max={600}
                onCommit={(n) => patchSegment(selectedSegment._key, (s) => fitFadePatch(s, { durationSec: clamp(n, 0.05, 600) }, clamp(n, 0.05, 600)))}
              />
              <FadeFields
                idPrefix="still"
                entry={selectedSegment}
                duration={segmentDuration(selectedSegment)}
                onCommit={(patch) => patchSegment(selectedSegment._key, (s) => fitFadePatch(s, patch, segmentDuration(s)))}
              />
              <RemoveButton label="Remove from timeline" onClick={() => removeFromLane('segment', selectedSegment._key)} />
            </>
          )}

          {selectedOverlay && (
            <>
              <img src={assetUrl(selectedOverlay.assetKind, selectedOverlay.assetFile)} alt="" className="w-full aspect-video object-contain rounded bg-port-bg" />
              <div className="text-[11px] text-gray-300 truncate" title={selectedOverlay.assetFile}>{selectedOverlay.assetFile}</div>
              <NumberField id="overlay-start" label="Start (s)" value={selectedOverlay.startSec} min={0}
                onCommit={(n) => patchOverlay(selectedOverlay._key, () => ({ startSec: Math.max(0, n) }))} />
              <NumberField id="overlay-duration" label="Duration (s)" value={selectedOverlay.durationSec} min={0.05} max={600}
                onCommit={(n) => patchOverlay(selectedOverlay._key, (o) => fitFadePatch(o, { durationSec: clamp(n, 0.05, 600) }, clamp(n, 0.05, 600)))} />
              <div className="grid grid-cols-2 gap-2">
                <NumberField id="overlay-x" label="X (0–1)" value={selectedOverlay.x ?? 0} step={0.01} min={-1} max={2}
                  onCommit={(n) => patchOverlay(selectedOverlay._key, () => ({ x: clamp(n, -1, 2) }))} />
                <NumberField id="overlay-y" label="Y (0–1)" value={selectedOverlay.y ?? 0} step={0.01} min={-1} max={2}
                  onCommit={(n) => patchOverlay(selectedOverlay._key, () => ({ y: clamp(n, -1, 2) }))} />
              </div>
              <NumberField id="overlay-width" label="Width (× canvas)" value={selectedOverlay.width ?? 0.25} step={0.01} min={0.01} max={4}
                onCommit={(n) => patchOverlay(selectedOverlay._key, () => ({ width: clamp(n, 0.01, 4) }))} />
              <NumberField id="overlay-opacity" label="Opacity (0–1)" value={selectedOverlay.opacity ?? 1} step={0.05} min={0} max={1}
                onCommit={(n) => patchOverlay(selectedOverlay._key, () => ({ opacity: clamp(n, 0, 1) }))} />
              <FadeFields
                idPrefix="overlay"
                entry={selectedOverlay}
                duration={selectedOverlay.durationSec}
                onCommit={(patch) => patchOverlay(selectedOverlay._key, (o) => fitFadePatch(o, patch, o.durationSec))}
              />
              <RemoveButton label="Remove overlay" onClick={() => removeFromLane('overlay', selectedOverlay._key)} />
            </>
          )}

          {selectedBed && (
            <>
              <div className="flex items-center gap-2 text-[11px] text-gray-300">
                <Music className="w-3 h-3 text-gray-500" aria-hidden="true" />
                <span className="truncate" title={selectedBed.assetFile}>{selectedBed.assetFile}</span>
              </div>
              <NumberField id="bed-start" label="Start (s)" value={selectedBed.startSec} min={0}
                onCommit={(n) => patchBed(selectedBed._key, () => ({ startSec: Math.max(0, n) }))} />
              <NumberField id="bed-offset" label="Source offset (s)" value={selectedBed.offsetSec ?? 0} min={0}
                hint="Where playback starts inside the file"
                onCommit={(n) => patchBed(selectedBed._key, () => ({ offsetSec: Math.max(0, n) }))} />
              <NumberField id="bed-duration" label="Duration (s)" value={selectedBed.durationSec} min={0.05} max={600}
                hint="Clamped to the file's real length at render"
                onCommit={(n) => patchBed(selectedBed._key, (tr) => fitFadePatch(tr, { durationSec: clamp(n, 0.05, 600) }, clamp(n, 0.05, 600)))} />
              <NumberField id="bed-volume" label="Volume (×)" value={selectedBed.volume ?? 1} step={0.05} min={0} max={4}
                onCommit={(n) => patchBed(selectedBed._key, () => ({ volume: clamp(n, 0, 4) }))} />
              <FadeFields
                idPrefix="bed"
                entry={selectedBed}
                duration={selectedBed.durationSec}
                onCommit={(patch) => patchBed(selectedBed._key, (tr) => fitFadePatch(tr, patch, tr.durationSec))}
              />
              <RemoveButton label="Remove bed" onClick={() => removeFromLane('audio', selectedBed._key)} />
            </>
          )}

          <div className="pt-2 border-t border-port-border">
            <NumberField
              id="mix-clip-volume"
              label="Clip audio (×)"
              value={audio.clipVolume ?? 1}
              step={0.05}
              min={0}
              max={4}
              hint="Scales every video segment's own audio"
              onCommit={(n) => updateLanes((prev) => ({ ...prev, audio: { ...prev.audio, clipVolume: clamp(n, 0, 4) } }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// --- Small shared pieces ------------------------------------------------

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

// Clamp a trim edit to 0..sourceDuration, matching the server's CLIP_TOO_SHORT
// guard (1/fps). A hardcoded floor was too lenient at 24fps and let the UI
// build a project the render then rejected with 400.
export function clampTrim(segment, patch, sourceDur, fps) {
  const limit = sourceDur || Infinity;
  const minDur = fps && fps > 0 ? 1 / fps : 0.04;
  let inSec = patch.inSec != null ? patch.inSec : segment.inSec;
  let outSec = patch.outSec != null ? patch.outSec : segment.outSec;
  inSec = Math.max(0, Math.min(inSec, limit - minDur));
  outSec = Math.max(inSec + minDur, Math.min(outSec, limit));
  return fitFadePatch(segment, { inSec, outSec }, outSec - inSec);
}

// The server refuses a fade pair that outlasts its own duration, so shrink the
// OTHER fade rather than letting the PATCH 400 mid-edit.
export function fitFadePatch(entry, patch, duration) {
  const merged = { ...entry, ...patch };
  const fin = Math.max(0, merged.fadeInSec || 0);
  const fout = Math.max(0, merged.fadeOutSec || 0);
  if (fin + fout <= duration) return patch;
  const scale = fin + fout > 0 ? Math.max(0, duration) / (fin + fout) : 0;
  return { ...patch, fadeInSec: fin * scale, fadeOutSec: fout * scale };
}

function FadeFields({ idPrefix, entry, duration, onCommit }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <NumberField
        id={`${idPrefix}-fade-in`} label="Fade in (s)" value={entry.fadeInSec ?? 0} step={0.05} min={0} max={duration}
        onCommit={(n) => onCommit({ fadeInSec: clamp(n, 0, Math.max(0, duration)) })}
      />
      <NumberField
        id={`${idPrefix}-fade-out`} label="Fade out (s)" value={entry.fadeOutSec ?? 0} step={0.05} min={0} max={duration}
        onCommit={(n) => onCommit({ fadeOutSec: clamp(n, 0, Math.max(0, duration)) })}
      />
    </div>
  );
}

function RemoveButton({ label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full px-2 py-1.5 bg-port-error/20 hover:bg-port-error/40 text-port-error text-xs rounded flex items-center justify-center gap-1"
    >
      <Trash2 className="w-3 h-3" /> {label}
    </button>
  );
}

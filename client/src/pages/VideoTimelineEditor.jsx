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
} from '@dnd-kit/sortable';
import {
  Play, Pause, Save, Film, Loader2, ArrowLeft, Volume2, VolumeX,
  Image as ImageIcon, Music,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import * as api from '../services/api';
import { formatTimecode, clamp } from '../utils/formatters';
import { useSseProgress, isTerminalSseFrame } from '../hooks/useSseProgress';
import {
  TimelineBlock, FloatingLane, LibraryTile, StillTile, AudioRow, BedAudio,
} from '../components/media/VideoTimelineLanes';
import { NumberField, FadeFields, RemoveButton } from '../components/media/VideoTimelineInspector';
import PageSkeleton from '../components/ui/PageSkeleton';
import {
  assetUrl,
  segmentDuration,
  timelineDuration,
  canvasAspectRatio,
  findSegmentAt,
  fadeMultiplier,
  overlayOpacityAt,
  audioTrackStateAt,
  segmentVolumeAt,
  clampTrim,
  fitFadePatch,
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
// Mirrors MAX_STILL_SEC / MIN_MEDIA_SEC on the server.
const MIN_ENTRY_SEC = 0.05;
const MAX_ENTRY_SEC = 600;
const MAX_VOLUME = 4;
// Mirrors MAX_SEGMENTS / MAX_OVERLAYS / MAX_AUDIO_TRACKS in
// server/services/videoTimeline/segments.js.
const LANE_CAPS = {
  segment: { max: 200, label: 'Video lane' },
  overlay: { max: 50, label: 'Overlay lane' },
  audio: { max: 20, label: 'Audio lane' },
};

const LIBRARY_TABS = [
  { id: 'clips', label: 'Clips', Icon: Film },
  { id: 'stills', label: 'Stills', Icon: ImageIcon },
  { id: 'audio', label: 'Audio', Icon: Music },
];

const desktopTimelineLayout = () => (
  typeof window === 'undefined' || window.matchMedia('(min-width: 64rem)').matches
);

// One accessor per lane, so adding a lane doesn't mean a fourth branch in
// every ternary chain that needs "the entries for this lane".
const laneEntries = (lanes, lane) => {
  if (lane === 'overlay') return lanes.overlays;
  if (lane === 'audio') return lanes.audio.tracks;
  if (lane === 'segment') return lanes.segments;
  return null;
};

const withLaneEntries = (lanes, lane, next) => {
  if (lane === 'overlay') return { ...lanes, overlays: next };
  if (lane === 'audio') return { ...lanes, audio: { ...lanes.audio, tracks: next } };
  return { ...lanes, segments: next };
};

export default function VideoTimelineEditor() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [history, setHistory] = useState([]);
  const [images, setImages] = useState([]);
  const [musicTracks, setMusicTracks] = useState([]);
  // Which catalogues have actually been fetched — see knownAbsent below.
  const [loaded, setLoaded] = useState({ clips: false, images: false, music: false });
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
  // collapsing the inspector to "Select a block". Read from a ref so refresh
  // needn't depend on lanes/selection (which would re-trigger the load-on-mount loop).
  const selectionRef = useRef({ lane: null, index: -1 });
  const [pxPerSec, setPxPerSec] = useState(60);
  const [t, setT] = useState(0); // project-time in seconds
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [renderJobId, setRenderJobId] = useState(null);
  const [showLibrary, setShowLibrary] = useState(desktopTimelineLayout);
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
  // `updatedAt` is the only field the save path reads off `project`; holding it
  // in a ref keeps the whole updateLanes → patchLane callback chain stable
  // across the setProject that every successful save performs.
  const updatedAtRef = useRef(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const { segments, overlays, audio } = lanes;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    // `null` = the request FAILED; `[]` = a genuinely empty library. Collapsing
    // the two would wipe a populated list on a transient error and then mark
    // every segment, overlay and bed drawing on it as "missing" — sources the
    // server can still render perfectly well.
    const [proj, hist, gallery, library] = await Promise.all([
      api.getTimelineProject(projectId).catch((err) => { setError(err.message); return null; }),
      api.listVideoHistory({ silent: true }).catch(() => null),
      api.listImageGallery({ silent: true }).catch(() => null),
      api.listMusicLibrary({ silent: true }).catch(() => null),
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
      updatedAtRef.current = proj.updatedAt;
      setLanes(nextLanes);
      // Re-derive selection from its lane + prior position so a refresh — e.g. a
      // CONFLICT reload mid-edit — doesn't leave `selection` pointing at a
      // now-regenerated _key and collapse the inspector.
      const { lane, index } = selectionRef.current;
      const entries = laneEntries(nextLanes, lane);
      setSelection(entries?.[index] ? { lane, key: entries[index]._key } : null);
    }
    if (Array.isArray(hist)) setHistory(hist);
    if (Array.isArray(gallery)) setImages(gallery);
    if (library) setMusicTracks(Array.isArray(library.tracks) ? library.tracks : []);
    // Whether each library actually loaded, so the "missing source" badges can
    // stay silent about a lane whose catalogue we never received.
    setLoaded((prev) => ({
      clips: prev.clips || Array.isArray(hist),
      images: prev.images || Array.isArray(gallery),
      music: prev.music || !!library,
    }));
    setLoading(false);
  }, [projectId]);

  // Keep the stable-position mirror of the current selection current so refresh()
  // can reattach it after it regenerates lane _keys.
  useEffect(() => {
    const entries = selection && laneEntries(lanes, selection.lane);
    const idx = entries ? entries.findIndex((e) => e._key === selection.key) : -1;
    selectionRef.current = idx >= 0 ? { lane: selection.lane, index: idx } : { lane: null, index: -1 };
  }, [selection, lanes]);

  useEffect(() => { refresh(); }, [refresh]);

  // Sync the rename draft to the canonical name when the project (re)loads
  // or is renamed elsewhere. Local edits (onChange) take over until the
  // user blurs.
  useEffect(() => {
    if (project?.name) setNameDraft(project.name);
  }, [project?.id, project?.name]);

  // O(1) clip metadata lookup. The video-sync effect can run per frame during
  // playback; a linear find() per frame multiplied by segment count is
  // measurable on long timelines.
  const historyMap = useMemo(() => new Map(history.map((h) => [h.id, h])), [history]);
  const metaFor = useCallback((clipId) => historyMap.get(clipId), [historyMap]);

  const imageNames = useMemo(() => new Set(images.map((i) => i.filename)), [images]);
  const musicNames = useMemo(() => new Set(musicTracks.map((m) => m.filename)), [musicTracks]);

  // A lane entry is "missing" when its source is gone from the catalogue it
  // came from — the render would 404, so the editor flags it up front.
  //
  // Only `images`, `music` and the video history have a client-side catalogue.
  // For an asset kind we cannot enumerate — or a catalogue whose fetch failed —
  // "absent from the list" is NOT evidence of absence on disk, so say nothing
  // and let the render's MISSING_CLIPS report be the authority.
  const knownAbsent = useCallback((kind, file) => {
    if (kind === 'images') return loaded.images && !imageNames.has(file);
    if (kind === 'music') return loaded.music && !musicNames.has(file);
    return false; // 'video-thumbnails' / 'audio' — no catalogue to check against
  }, [loaded.images, loaded.music, imageNames, musicNames]);

  const isSegmentMissing = useCallback((seg) => (seg.type === 'still'
    ? knownAbsent(seg.assetKind, seg.assetFile)
    : loaded.clips && !historyMap.has(seg.clipId)), [knownAbsent, loaded.clips, historyMap]);
  const isOverlayMissing = useCallback((ov) => knownAbsent(ov.assetKind, ov.assetFile), [knownAbsent]);
  const isBedMissing = useCallback((tr) => knownAbsent(tr.assetKind, tr.assetFile), [knownAbsent]);

  const total = useMemo(() => timelineDuration(segments), [segments]);
  const canvasAspect = useMemo(
    () => canvasAspectRatio(segments, (clipId) => historyMap.get(clipId)),
    [segments, historyMap],
  );

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
  // Every PATCH from this editor — a lane save, a rename — chains onto one
  // tail. All of them assert `expectedUpdatedAt`, so two in flight together
  // means the second is guaranteed a 409 even though nothing outside the
  // editor changed; if the loser is a lane save, its reload discards the edit
  // the user just made. Serializing here mirrors the server's own single-tail
  // write queue and leaves 409 meaning what it should: someone ELSE wrote.
  const writeTailRef = useRef(Promise.resolve());
  const queueWrite = useCallback((fn) => {
    const next = writeTailRef.current.then(fn, fn);
    writeTailRef.current = next.catch(() => {});
    return next;
  }, []);

  const saveTimeline = useCallback((next) => queueWrite(async () => {
    if (updatedAtRef.current == null) return false;
    const updated = await api.updateTimelineProject(projectId, {
      ...timelinePatch(next),
      expectedUpdatedAt: updatedAtRef.current,
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
    updatedAtRef.current = updated.updatedAt;
    setProject((p) => ({ ...p, updatedAt: updated.updatedAt }));
    return true;
  }), [projectId, refresh, queueWrite]);

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

  // One patcher for every lane — `patch(entry)` returns the fields to merge.
  const patchLane = useCallback((lane, key, patch) => {
    updateLanes((prev) => withLaneEntries(
      prev,
      lane,
      laneEntries(prev, lane).map((e) => (e._key === key ? { ...e, ...patch(e) } : e)),
    ));
  }, [updateLanes]);

  // Refuse the add at the cap rather than letting it through: the server's Zod
  // gate 400s the whole PATCH, so one entry over the limit makes EVERY
  // subsequent debounced save fail with a message that names no lane, and the
  // user has to guess which one to trim.
  //
  // The decision reads `lanes` directly, NOT a flag set inside the setState
  // updater — React only runs an updater eagerly when the fiber has no pending
  // work, and the rAF playhead loop keeps work pending throughout playback, so
  // such a flag would still be false when read and report a spurious "limit
  // reached" on a perfectly good add.
  const addToLane = useCallback((lane, entry) => {
    if (laneEntries(lanes, lane).length >= LANE_CAPS[lane].max) {
      toast.error(`${LANE_CAPS[lane].label} limit reached (${LANE_CAPS[lane].max}) — remove one first`);
      return;
    }
    updateLanes((prev) => withLaneEntries(prev, lane, [...laneEntries(prev, lane), entry]));
    setSelection({ lane, key: entry._key });
  }, [lanes, updateLanes]);

  const removeFromLane = useCallback((lane, key) => {
    updateLanes((prev) => withLaneEntries(prev, lane, laneEntries(prev, lane).filter((e) => e._key !== key)));
    setSelection((sel) => (sel && sel.key === key ? null : sel));
  }, [updateLanes]);

  // --- Add ---------------------------------------------------------------

  const addClip = useCallback((clip) => {
    const fullDur = clip.numFrames && clip.fps ? clip.numFrames / clip.fps : 4;
    addToLane('segment', {
      _key: laneKey(clip.id, 0),
      type: 'clip',
      clipId: clip.id,
      inSec: 0,
      outSec: fullDur,
      fadeInSec: 0,
      fadeOutSec: 0,
      volume: 1,
    });
  }, [addToLane]);

  const addStill = useCallback((image) => {
    addToLane('segment', {
      _key: laneKey('still', 0),
      type: 'still',
      assetKind: 'images',
      assetFile: image.filename,
      durationSec: DEFAULT_STILL_SEC,
      fadeInSec: 0,
      fadeOutSec: 0,
    });
  }, [addToLane]);

  // Overlays and beds land at the playhead — the user has already scrubbed to
  // the moment they want them.
  const playheadRef = useRef(0);
  useEffect(() => { playheadRef.current = t; }, [t]);
  const totalRef = useRef(0);
  useEffect(() => { totalRef.current = total; }, [total]);

  const addOverlay = useCallback((image) => {
    addToLane('overlay', {
      _key: laneKey('ov', 0),
      type: 'image',
      assetKind: 'images',
      assetFile: image.filename,
      startSec: Math.min(playheadRef.current, Math.max(0, totalRef.current - 0.1)),
      durationSec: DEFAULT_OVERLAY_SEC,
      x: 0.05,
      y: 0.05,
      width: 0.25,
      opacity: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
    });
  }, [addToLane]);

  const addBed = useCallback((track) => {
    addToLane('audio', {
      _key: laneKey('bed', 0),
      assetKind: 'music',
      assetFile: track.filename,
      startSec: Math.min(playheadRef.current, Math.max(0, totalRef.current - 0.1)),
      offsetSec: 0,
      // The client can't probe the file; the server clamps this down to the
      // real duration when it renders.
      durationSec: Math.max(1, Math.min(DEFAULT_BED_SEC, totalRef.current || DEFAULT_BED_SEC)),
      volume: 0.6,
      fadeInSec: 0,
      fadeOutSec: 0,
    });
  }, [addToLane]);

  const onDragEnd = useCallback(({ active, over }) => {
    if (!over || active.id === over.id) return;
    updateLanes((prev) => {
      const oldIdx = prev.segments.findIndex((s) => s._key === active.id);
      const newIdx = prev.segments.findIndex((s) => s._key === over.id);
      if (oldIdx === -1 || newIdx === -1) return prev;
      return { ...prev, segments: arrayMove(prev.segments, oldIdx, newIdx) };
    });
  }, [updateLanes]);

  // --- Preview -----------------------------------------------------------

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

  const { index: activeIndex, within: activeWithin } = useMemo(
    () => (segments.length > 0 ? findSegmentAt(segments, t) : { index: -1, within: 0 }),
    [segments, t],
  );
  const activeSegment = activeIndex >= 0 ? segments[activeIndex] : null;
  // `within` advances every frame; the media-sync effects read it from a ref so
  // they re-run on a segment CHANGE rather than once per animation frame.
  const withinRef = useRef(0);
  useEffect(() => { withinRef.current = activeWithin; }, [activeWithin]);

  // Sync the <video> element to project-time whenever the active segment or the
  // scrub position changes. A still segment has no video source — the effect
  // parks the element so the <img> below takes over the frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !activeSegment) return;
    if (activeSegment.type === 'still') {
      lastSrcRef.current = '';
      playSegmentIndexRef.current = activeIndex;
      video.pause();
      return;
    }
    const meta = metaFor(activeSegment.clipId);
    if (!meta) return;
    const src = `/data/videos/${meta.filename}`;
    const wantTime = activeSegment.inSec + withinRef.current;
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
    } else if (activeIndex !== playSegmentIndexRef.current) {
      video.currentTime = wantTime;
    } else if (!playing && Math.abs(video.currentTime - wantTime) > 0.05) {
      // Scrubbing while paused: the rAF loop only runs while playing, so we
      // drive the element manually. During playback the element advances on its
      // own — re-seeking every frame would cause buffering stutter.
      video.currentTime = wantTime;
    }
    playSegmentIndexRef.current = activeIndex;
  }, [activeSegment, activeIndex, activeWithin, metaFor, playing]);

  // Pause/play the underlying element in lockstep with `playing`. A still
  // segment holds no video, so there is nothing to start.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (playing && activeSegment?.type !== 'still') video.play().catch(() => {});
    else video.pause();
  }, [playing, activeSegment?.type]);

  // The clip lane's own audio level — clipVolume × the segment's volume × its
  // fade ramp, the same product the export builds into each segment's chain.
  // Without this the user ducks the dialogue, hears no change while auditioning,
  // and gets a different mix out of the render.
  const clipVolume = audio.clipVolume;
  const activeClipVolume = segmentVolumeAt(activeSegment, clipVolume, activeWithin);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.muted !== muted) video.muted = muted;
    // Only correct real drift — a media property write per frame queues a
    // `volumechange` event per frame for no audible gain.
    if (Math.abs(video.volume - activeClipVolume) > 0.01) video.volume = activeClipVolume;
  }, [muted, activeClipVolume]);

  // Drive the bed <audio> elements from the same playhead the export mixes
  // against, so what the user hears while scrubbing is what amix will produce.
  useEffect(() => {
    for (const track of audio.tracks) {
      const el = bedRefs.current.get(track._key);
      if (!el) continue;
      const state = audioTrackStateAt(track, t);
      if (el.muted !== muted) el.muted = muted;
      // clipVolume scales the video lane's OWN audio, not the bed — the export
      // applies it inside each segment's chain, before amix.
      const want = clamp(state.volume, 0, 1);
      if (Math.abs(el.volume - want) > 0.01) el.volume = want;
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

  // --- Render ------------------------------------------------------------

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
    if (result?.jobId) setRenderJobId(result.jobId);
  };

  // SSE progress wiring — subscribes to the render jobId's event stream (via
  // the shared useSseProgress lifecycle) and, on 'complete', navigates to Media
  // History focused on the new clip. Frame shapes come from
  // server/services/videoTimeline/local.js (progress / complete / error / canceled).
  const { latest: renderFrame, closed: renderStreamClosed } = useSseProgress(
    renderJobId ? `/api/video-timeline/${renderJobId}/events` : null,
    { enabled: !!renderJobId },
  );
  // Derived, not stored: a terminal frame isn't type 'progress', so the reset to
  // zero on complete/error/cancel falls out for free.
  const renderProgress = renderFrame?.type === 'progress' ? renderFrame.progress : 0;
  useEffect(() => {
    if (!renderJobId || !renderFrame) return;
    if (renderFrame.type === 'progress') return;
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
    }
  }, [renderJobId, renderFrame, renderStreamClosed, navigate]);
  useEffect(() => {
    // Stream ended without a terminal frame — connection lost. Terminal frames
    // are handled (and clear renderJobId) in the frame effect above.
    if (!renderJobId || !renderStreamClosed) return;
    if (isTerminalSseFrame(renderFrame)) return;
    toast.error('Lost connection to render — check Media History');
    setRenderJobId(null);
  }, [renderJobId, renderStreamClosed, renderFrame]);

  // --- Derived view data -------------------------------------------------

  // Filter the library: hide outputs of any timeline render so the rail
  // doesn't grow unbounded with the user's own renders.
  const libraryClips = useMemo(
    () => history.filter((h) => !h.timelineProjectId && !h.hidden),
    [history],
  );
  const usedClipIds = useMemo(
    () => new Set(segments.filter((s) => s.type === 'clip').map((s) => s.clipId)),
    [segments],
  );
  const segmentKeys = useMemo(() => segments.map((s) => s._key), [segments]);
  // Everything about an overlay except its opacity is frame-invariant; only the
  // opacity is recomputed as the playhead moves.
  const overlayChrome = useMemo(() => overlays.map((ov) => ({
    key: ov._key,
    src: assetUrl(ov.assetKind, ov.assetFile),
    left: `${(ov.x || 0) * 100}%`,
    top: `${(ov.y || 0) * 100}%`,
    width: `${(ov.width || 0.25) * 100}%`,
    overlay: ov,
  })), [overlays]);

  const selectSegment = useCallback((key) => setSelection({ lane: 'segment', key }), []);
  const removeSegment = useCallback((key) => removeFromLane('segment', key), [removeFromLane]);
  const selectOverlay = useCallback((key) => setSelection({ lane: 'overlay', key }), []);
  const removeOverlay = useCallback((key) => removeFromLane('overlay', key), [removeFromLane]);
  const selectBed = useCallback((key) => setSelection({ lane: 'audio', key }), []);
  const removeBed = useCallback((key) => removeFromLane('audio', key), [removeFromLane]);
  const overlayLabel = useCallback((ov) => ov.assetFile, []);
  const bedLabel = useCallback((tr) => tr.assetFile, []);

  if (loading) {
    return (
      <PageSkeleton
        label="Loading timeline project"
        headerRowClass="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-port-border"
        titleWidthClass="w-56"
        cards={3}
        sidebar={false}
      />
    );
  }
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

  const selected = selection ? laneEntries(lanes, selection.lane)?.find((e) => e._key === selection.key) : null;
  const selectedSegment = selection?.lane === 'segment' ? selected : null;
  const selectedOverlay = selection?.lane === 'overlay' ? selected : null;
  const selectedBed = selection?.lane === 'audio' ? selected : null;
  const selectedMeta = selectedSegment?.type === 'clip' ? metaFor(selectedSegment.clipId) : null;
  const selectedSourceDur = selectedMeta?.numFrames && selectedMeta?.fps ? selectedMeta.numFrames / selectedMeta.fps : null;

  // Committing a duration also has to refit the fades that were sized against
  // the old one, so the three lanes share one commit path.
  const commitDuration = (lane, key, seconds) => patchLane(lane, key, (e) => fitFadePatch(e, { durationSec: seconds }, seconds));

  const activeStillSrc = activeSegment?.type === 'still'
    ? assetUrl(activeSegment.assetKind, activeSegment.assetFile)
    : null;
  // The same linear ramp ffmpeg's `fade` applies, rendered as a black scrim so
  // the preview shows the cut the export will make.
  const activeFadeScrim = activeSegment
    ? 1 - fadeMultiplier(
      activeSegment.fadeInSec || 0,
      activeSegment.fadeOutSec || 0,
      segmentDuration(activeSegment),
      activeWithin,
    )
    : 0;

  const laneWidth = Math.max(240, total * pxPerSec);
  const playheadSec = Math.min(t, total);
  const libraryPanel = showLibrary ? (
    <div
      id="timeline-library"
      className="order-2 lg:order-1 bg-port-card/50 border border-port-border rounded-lg p-2 max-h-[600px] overflow-y-auto"
    >
      <div className="flex gap-1 mb-2" role="tablist" aria-label="Clip library">
        {LIBRARY_TABS.map(({ id, label, Icon }) => (
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
  ) : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-port-border">
        <div className="flex items-center gap-2 flex-1 min-w-[120px]">
          <button
            type="button"
            onClick={() => navigate('/media/timeline')}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 text-gray-400 hover:text-white"
            title="Back to projects" aria-label="Back to projects"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <input
            type="text"
            aria-label="Project name"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={(e) => {
              const trimmed = e.target.value.trim();
              if (!trimmed) { setNameDraft(project.name); return; }
              if (trimmed === project.name) return;
              // Through the same tail as the lane saves — see queueWrite. The
              // expectedUpdatedAt read has to happen INSIDE the queued fn, or
              // it captures a value the preceding write has already replaced.
              queueWrite(async () => {
                const updated = await api.updateTimelineProject(projectId, {
                  name: trimmed, expectedUpdatedAt: updatedAtRef.current,
                }, { silent: true }).catch((err) => {
                  toast.error(`Rename failed: ${err.message}`);
                  setNameDraft(project.name);
                  return null;
                });
                if (updated) {
                  updatedAtRef.current = updated.updatedAt;
                  setProject((p) => ({ ...p, name: updated.name, updatedAt: updated.updatedAt }));
                  setNameDraft(updated.name);
                }
              });
            }}
            className="flex-1 min-w-0 bg-transparent text-white font-medium text-lg focus:outline-none focus:bg-port-card focus:px-2 rounded transition-all"
          />
          <span className="text-xs text-gray-500 hidden sm:inline truncate">
            {segments.length} segments · {overlays.length} overlays · {audio.tracks.length} beds · {formatTimecode(total)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowLibrary((v) => !v)}
            aria-expanded={showLibrary}
            aria-controls="timeline-library"
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

      <div className={`grid grid-cols-1 ${
        showLibrary ? 'lg:grid-cols-[260px_1fr_240px]' : 'lg:grid-cols-[1fr_240px]'
      } gap-3 min-h-[400px]`}>
        {/* Center — preview + tracks */}
        <div className="order-1 lg:order-2 space-y-3 min-w-0">
          {/* The preview adopts the CANONICAL render canvas, not a fixed 16:9
              box — overlay x/y/width are normalized against that canvas, so a
              portrait or square project would otherwise place them somewhere
              the export does not. */}
          <div className="bg-black rounded-lg overflow-hidden relative" style={{ aspectRatio: canvasAspect }}>
            <video
              ref={videoRef}
              className={`w-full h-full ${activeStillSrc ? 'invisible' : ''}`}
              playsInline
              preload="auto"
            />
            {activeStillSrc && (
              <img src={activeStillSrc} alt="" className="absolute inset-0 w-full h-full object-contain" />
            )}
            {/* The segment fade scrim sits UNDER the overlay lane, matching the
                export: ffmpeg fades each segment before concat and composites
                overlays afterwards, so a fade dims the base video and leaves
                the overlay at its own opacity. */}
            {activeFadeScrim > 0 && (
              <div
                data-testid="fade-scrim"
                aria-hidden="true"
                style={{ opacity: activeFadeScrim }}
                className="absolute inset-0 bg-black pointer-events-none"
              />
            )}
            {/* Overlay lane, composited exactly as ffmpeg will: normalized
                position/width against the canvas, alpha from the same ramp.
                Every overlay stays MOUNTED and rides its opacity to zero —
                unmounting at the window edge would re-decode the image on each
                boundary crossing while scrubbing. */}
            {overlayChrome.map(({ key, src, left, top, width, overlay }) => (src ? (
              <img
                key={key}
                src={src}
                alt=""
                data-testid="overlay-preview"
                style={{ left, top, width, opacity: overlayOpacityAt(overlay, t, total) }}
                className="absolute pointer-events-none"
              />
            ) : null))}
            {segments.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-gray-500 text-sm">
                Add clips to start
              </div>
            )}
          </div>

          {/* Bed playback elements. Hidden — the timeline lane is the UI. */}
          {audio.tracks.map((track) => (
            <BedAudio
              key={track._key}
              trackKey={track._key}
              src={assetUrl(track.assetKind, track.assetFile)}
              registry={bedRefs.current}
            />
          ))}

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
              value={playheadSec}
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
            {segments.length === 0 && overlays.length === 0 && audio.tracks.length === 0 ? (
              <div className="text-xs text-gray-500 py-6 text-center">
                Drag-drop reorder once you've added clips. Add clips, stills, overlays and audio from the library on the left.
              </div>
            ) : (
              /* Every lane renders whenever ANY lane has content. Gating the
                 free lanes on the video lane would strand an overlay or bed
                 added to an empty project — unselectable and unremovable until
                 a video segment happened to be added. */
              <>
                <div className="text-[9px] uppercase tracking-wide text-gray-600 px-0.5">Video</div>
                {segments.length === 0 ? (
                  <div className="text-[10px] text-gray-600 pl-2 py-2">Add a clip or a still from the library</div>
                ) : (
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
                    <SortableContext items={segmentKeys} strategy={horizontalListSortingStrategy}>
                      <div className="flex gap-1 items-stretch min-w-min py-1">
                        {segments.map((segment) => (
                          <TimelineBlock
                            key={segment._key}
                            clip={segment}
                            clipMeta={segment.type === 'clip' ? metaFor(segment.clipId) : null}
                            isSelected={selection?.lane === 'segment' && segment._key === selection.key}
                            isMissing={isSegmentMissing(segment)}
                            pxPerSec={pxPerSec}
                            onSelect={selectSegment}
                            onRemove={removeSegment}
                          />
                        ))}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}

                <FloatingLane
                  title="Overlays"
                  entries={overlays}
                  emptyHint="Add an overlay from the Stills tab"
                  tone="bg-port-accent/15 border-port-accent/40"
                  labelOf={overlayLabel}
                  isMissing={isOverlayMissing}
                  selectedKey={selection?.lane === 'overlay' ? selection.key : null}
                  pxPerSec={pxPerSec}
                  width={laneWidth}
                  playheadSec={playheadSec}
                  onSelect={selectOverlay}
                  onRemove={removeOverlay}
                />

                <FloatingLane
                  title="Audio"
                  entries={audio.tracks}
                  emptyHint="Add a bed from the Audio tab"
                  tone="bg-port-success/15 border-port-success/40"
                  labelOf={bedLabel}
                  isMissing={isBedMissing}
                  selectedKey={selection?.lane === 'audio' ? selection.key : null}
                  pxPerSec={pxPerSec}
                  width={laneWidth}
                  playheadSec={playheadSec}
                  onSelect={selectBed}
                  onRemove={removeBed}
                />
              </>
            )}
          </div>
        </div>

        {/* The library follows the workspace in DOM/focus order on mobile, then
            moves into the desktop grid's left rail without remounting. */}
        {libraryPanel}

        {/* Right rail — inspector */}
        <div className="order-3 bg-port-card/50 border border-port-border rounded-lg p-3 space-y-3">
          <div className="text-xs uppercase text-gray-500 tracking-wide">Inspector</div>

          {!selected && (
            <div className="text-xs text-gray-500">Select a block on the timeline to edit it.</div>
          )}

          {selectedSegment && isSegmentMissing(selectedSegment) && (
            <div className="text-xs text-port-error space-y-2">
              <p>Source missing — it may have been deleted from the gallery. Remove this block from the timeline.</p>
              <RemoveButton label="Remove" onClick={() => removeSegment(selectedSegment._key)} />
            </div>
          )}

          {selectedSegment && !isSegmentMissing(selectedSegment) && selectedSegment.type === 'clip' && (
            <>
              {selectedMeta?.thumbnail && (
                <img src={assetUrl('video-thumbnails', selectedMeta.thumbnail)} alt="" className="w-full aspect-video object-cover rounded" />
              )}
              <div className="text-[11px] text-gray-300 line-clamp-3" title={selectedMeta?.prompt}>{selectedMeta?.prompt}</div>
              <div className="text-[10px] text-gray-500">
                source: {selectedSourceDur?.toFixed(2) ?? '?'}s · {selectedMeta?.width}×{selectedMeta?.height} · {selectedMeta?.fps}fps
              </div>
              <NumberField
                id="segment-in" label="In (s)" value={selectedSegment.inSec} max={selectedSourceDur ?? undefined}
                onCommit={(n) => patchLane('segment', selectedSegment._key, (s) => clampTrim(s, { inSec: n }, selectedSourceDur, selectedMeta?.fps))}
              />
              <NumberField
                id="segment-out" label="Out (s)" value={selectedSegment.outSec} max={selectedSourceDur ?? undefined}
                onCommit={(n) => patchLane('segment', selectedSegment._key, (s) => clampTrim(s, { outSec: n }, selectedSourceDur, selectedMeta?.fps))}
              />
              <div className="text-[10px] text-gray-500">
                trimmed: {segmentDuration(selectedSegment).toFixed(2)}s
              </div>
              <FadeFields
                idPrefix="segment"
                entry={selectedSegment}
                duration={segmentDuration(selectedSegment)}
                onCommit={(patch) => patchLane('segment', selectedSegment._key, (s) => fitFadePatch(s, patch, segmentDuration(s)))}
              />
              <NumberField
                id="segment-volume" label="Volume (×)" value={selectedSegment.volume ?? 1} max={MAX_VOLUME}
                onCommit={(n) => patchLane('segment', selectedSegment._key, () => ({ volume: n }))}
              />
              <RemoveButton label="Remove from timeline" onClick={() => removeSegment(selectedSegment._key)} />
            </>
          )}

          {selectedSegment && !isSegmentMissing(selectedSegment) && selectedSegment.type === 'still' && (
            <>
              <img src={assetUrl(selectedSegment.assetKind, selectedSegment.assetFile)} alt="" className="w-full aspect-video object-cover rounded" />
              <div className="text-[11px] text-gray-300 truncate" title={selectedSegment.assetFile}>{selectedSegment.assetFile}</div>
              <NumberField
                id="still-duration" label="Hold (s)" value={selectedSegment.durationSec} min={MIN_ENTRY_SEC} max={MAX_ENTRY_SEC}
                onCommit={(n) => commitDuration('segment', selectedSegment._key, n)}
              />
              <FadeFields
                idPrefix="still"
                entry={selectedSegment}
                duration={segmentDuration(selectedSegment)}
                onCommit={(patch) => patchLane('segment', selectedSegment._key, (s) => fitFadePatch(s, patch, segmentDuration(s)))}
              />
              <RemoveButton label="Remove from timeline" onClick={() => removeSegment(selectedSegment._key)} />
            </>
          )}

          {selectedOverlay && (
            <>
              <img src={assetUrl(selectedOverlay.assetKind, selectedOverlay.assetFile)} alt="" className="w-full aspect-video object-contain rounded bg-port-bg" />
              <div className="text-[11px] text-gray-300 truncate" title={selectedOverlay.assetFile}>{selectedOverlay.assetFile}</div>
              <NumberField id="overlay-start" label="Start (s)" value={selectedOverlay.startSec}
                onCommit={(n) => patchLane('overlay', selectedOverlay._key, () => ({ startSec: n }))} />
              <NumberField id="overlay-duration" label="Duration (s)" value={selectedOverlay.durationSec} min={MIN_ENTRY_SEC} max={MAX_ENTRY_SEC}
                onCommit={(n) => commitDuration('overlay', selectedOverlay._key, n)} />
              <div className="grid grid-cols-2 gap-2">
                <NumberField id="overlay-x" label="X (0–1)" value={selectedOverlay.x ?? 0} step={0.01} min={-1} max={2}
                  onCommit={(n) => patchLane('overlay', selectedOverlay._key, () => ({ x: n }))} />
                <NumberField id="overlay-y" label="Y (0–1)" value={selectedOverlay.y ?? 0} step={0.01} min={-1} max={2}
                  onCommit={(n) => patchLane('overlay', selectedOverlay._key, () => ({ y: n }))} />
              </div>
              <NumberField id="overlay-width" label="Width (× canvas)" value={selectedOverlay.width ?? 0.25} step={0.01} min={0.01} max={4}
                onCommit={(n) => patchLane('overlay', selectedOverlay._key, () => ({ width: n }))} />
              <NumberField id="overlay-opacity" label="Opacity (0–1)" value={selectedOverlay.opacity ?? 1} max={1}
                onCommit={(n) => patchLane('overlay', selectedOverlay._key, () => ({ opacity: n }))} />
              <FadeFields
                idPrefix="overlay"
                entry={selectedOverlay}
                duration={selectedOverlay.durationSec}
                onCommit={(patch) => patchLane('overlay', selectedOverlay._key, (o) => fitFadePatch(o, patch, o.durationSec))}
              />
              <RemoveButton label="Remove overlay" onClick={() => removeOverlay(selectedOverlay._key)} />
            </>
          )}

          {selectedBed && (
            <>
              <div className="flex items-center gap-2 text-[11px] text-gray-300">
                <Music className="w-3 h-3 text-gray-500" aria-hidden="true" />
                <span className="truncate" title={selectedBed.assetFile}>{selectedBed.assetFile}</span>
              </div>
              <NumberField id="bed-start" label="Start (s)" value={selectedBed.startSec}
                onCommit={(n) => patchLane('audio', selectedBed._key, () => ({ startSec: n }))} />
              <NumberField id="bed-offset" label="Source offset (s)" value={selectedBed.offsetSec ?? 0}
                hint="Where playback starts inside the file"
                onCommit={(n) => patchLane('audio', selectedBed._key, () => ({ offsetSec: n }))} />
              <NumberField id="bed-duration" label="Duration (s)" value={selectedBed.durationSec} min={MIN_ENTRY_SEC} max={MAX_ENTRY_SEC}
                hint="Clamped to the file's real length at render"
                onCommit={(n) => commitDuration('audio', selectedBed._key, n)} />
              <NumberField id="bed-volume" label="Volume (×)" value={selectedBed.volume ?? 1} max={MAX_VOLUME}
                onCommit={(n) => patchLane('audio', selectedBed._key, () => ({ volume: n }))} />
              <FadeFields
                idPrefix="bed"
                entry={selectedBed}
                duration={selectedBed.durationSec}
                onCommit={(patch) => patchLane('audio', selectedBed._key, (tr) => fitFadePatch(tr, patch, tr.durationSec))}
              />
              <RemoveButton label="Remove bed" onClick={() => removeBed(selectedBed._key)} />
            </>
          )}

          <div className="pt-2 border-t border-port-border">
            <NumberField
              id="mix-clip-volume"
              label="Clip audio (×)"
              value={clipVolume ?? 1}
              max={MAX_VOLUME}
              hint="Scales every video segment's own audio"
              onCommit={(n) => updateLanes((prev) => ({ ...prev, audio: { ...prev.audio, clipVolume: n } }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

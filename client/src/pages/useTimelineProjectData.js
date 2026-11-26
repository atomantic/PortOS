import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from '../components/ui/Toast';
import { getTimelineProject, listVideoHistory, getGalleryImages, updateTimelineProject } from '../services/apiImageVideo.js';
import { listMusicLibrary } from '../services/apiTracks.js';
import { useGalleryPage } from '../hooks/useGalleryPage';
import useUnsavedChangesGuard from '../hooks/useUnsavedChangesGuard';
import { CLIP_CATALOG_QUERY, laneKey, timelinePatch, withKeys } from '../lib/videoTimelineModel';

const EMPTY_LANES = { segments: [], overlays: [], audio: { clipVolume: 1, tracks: [] } };
// Default lengths for a newly-added still/overlay/bed. The bed length is a
// guess — the client can't probe the file — so the server clamps it down to
// the real duration at render time.
const DEFAULT_STILL_SEC = 3;
const DEFAULT_OVERLAY_SEC = 3;
const DEFAULT_BED_SEC = 10;
// Mirrors MAX_SEGMENTS / MAX_OVERLAYS / MAX_AUDIO_TRACKS in
// server/services/videoTimeline/segments.js.
const LANE_CAPS = {
  segment: { max: 200, label: 'Video lane' },
  overlay: { max: 50, label: 'Overlay lane' },
  audio: { max: 20, label: 'Audio lane' },
};

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

const CLIPS_LOAD_ERROR = "Couldn't load your clips.";
const MUSIC_LOAD_ERROR = "Couldn't load the shared music library.";

export function useTimelineProjectData(projectId) {
  const [project, setProject] = useState(null);
  const [history, setHistory] = useState([]);
  const [images, setImages] = useState([]);
  const [checkedImageNames, setCheckedImageNames] = useState(new Set());
  const [imageQuery, setImageQuery] = useState('');
  const [musicTracks, setMusicTracks] = useState([]);
  // Which catalogues have actually been fetched — see knownAbsent below.
  const [loaded, setLoaded] = useState({ clips: false, images: false, music: false });
  // Per-catalogue load failure and in-flight retry for the clip and audio
  // libraries. A failed list keeps its last good rows; the inline error and
  // Retry replace the "No clips" / "No audio" copy that would otherwise lie.
  const [catalogStatus, setCatalogStatus] = useState({ clips: { loadFailure: null, pending: false }, music: { loadFailure: null, pending: false } });
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
  const [libraryTab, setLibraryTab] = useState('clips');
  const stills = useGalleryPage({ q: imageQuery }, { enabled: libraryTab === 'stills' });
  // Local input draft. Editing the canonical state on every keystroke makes the
  // rename onBlur-vs-canonical comparison always-equal.
  const [nameDraft, setNameDraft] = useState('');

  // `updatedAt` is the only field the save path reads off `project`; holding it
  // in a ref keeps the whole updateLanes → patchLane callback chain stable
  // across the setProject that every successful save performs.
  const updatedAtRef = useRef(null);

  // Each instance owns one project; cleanup also invalidates reads during
  // StrictMode's setup/cleanup cycle and any late conflict-triggered reload.
  const activeRef = useRef(false);
  const refreshGenerationRef = useRef(0);
  // Per-catalogue retry generations so a superseded Retry cannot overwrite a newer one.
  const catalogGenerationRef = useRef({ clips: 0, music: 0 });
  const refresh = useCallback(async () => {
    if (!activeRef.current) return;
    const generation = ++refreshGenerationRef.current;
    const isCurrent = () => activeRef.current && refreshGenerationRef.current === generation;
    setLoading(true);
    setError(null);
    // `null` = the request FAILED; `[]` = a genuinely empty library. Collapsing
    // the two would wipe a populated list on a transient error and then mark
    // every segment, overlay and bed drawing on it as "missing" — sources the
    // server can still render perfectly well.
    const [proj, hist, library] = await Promise.all([
      getTimelineProject(projectId, { silent: true }).catch((err) => {
        if (isCurrent()) setError(err.message);
        return null;
      }),
      listVideoHistory({ silent: true, query: CLIP_CATALOG_QUERY }).catch(() => null),
      listMusicLibrary({ silent: true }).catch(() => null),
    ]);
    if (!isCurrent()) return;
    const imageRefs = [...(proj?.segments || []), ...(proj?.overlays || [])].filter(item => item.assetKind === 'images').map(item => item.assetFile);
    const gallery = proj ? await getGalleryImages(imageRefs, { silent: true }).catch(() => null) : null;
    if (!isCurrent()) return;
    if (gallery) setCheckedImageNames(new Set(imageRefs));
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
    // A refresh supersedes any Retry still in flight for the same catalogue.
    catalogGenerationRef.current.clips += 1;
    catalogGenerationRef.current.music += 1;
    setCatalogStatus({
      clips: { loadFailure: Array.isArray(hist) ? null : CLIPS_LOAD_ERROR, pending: false },
      music: { loadFailure: library ? null : MUSIC_LOAD_ERROR, pending: false },
    });
    // Whether each library actually loaded, so the "missing source" badges can
    // stay silent about a lane whose catalogue we never received.
    setLoaded((prev) => ({
      clips: prev.clips || Array.isArray(hist),
      images: prev.images || Array.isArray(gallery),
      music: prev.music || !!library,
    }));
    setLoading(false);
  }, [projectId]);

  // Retries one library without reloading the project, so edits made while
  // the list was failing stay untouched.
  const retryCatalog = useCallback(async (kind) => {
    const generation = ++catalogGenerationRef.current[kind];
    setCatalogStatus((prev) => ({ ...prev, [kind]: { ...prev[kind], pending: true } }));
    const fetchCatalog = kind === 'clips' ? listVideoHistory : listMusicLibrary;
    const result = await fetchCatalog(kind === 'clips' ? { silent: true, query: CLIP_CATALOG_QUERY } : { silent: true }).catch(() => null);
    if (!activeRef.current || catalogGenerationRef.current[kind] !== generation) return;
    const ok = kind === 'clips' ? Array.isArray(result) : !!result;
    if (ok) {
      if (kind === 'clips') setHistory(result);
      else setMusicTracks(Array.isArray(result.tracks) ? result.tracks : []);
      setLoaded((prev) => ({ ...prev, [kind]: true }));
    }
    setCatalogStatus((prev) => ({
      ...prev,
      [kind]: { loadFailure: ok ? null : (kind === 'clips' ? CLIPS_LOAD_ERROR : MUSIC_LOAD_ERROR), pending: false },
    }));
  }, []);

  // Keep the stable-position mirror of the current selection current so refresh()
  // can reattach it after it regenerates lane _keys.
  useEffect(() => {
    const entries = selection && laneEntries(lanes, selection.lane);
    const idx = entries ? entries.findIndex((e) => e._key === selection.key) : -1;
    selectionRef.current = idx >= 0 ? { lane: selection.lane, index: idx } : { lane: null, index: -1 };
  }, [selection, lanes]);

  useEffect(() => {
    activeRef.current = true;
    refresh();
    return () => {
      activeRef.current = false;
      refreshGenerationRef.current += 1;
    };
  }, [refresh]);

  // Sync the rename draft to the canonical name when the project (re)loads
  // or is renamed elsewhere. Local edits (onChange) take over until the
  // user blurs.
  useEffect(() => {
    if (project?.name) setNameDraft(project.name);
  }, [project?.id, project?.name]);

  // Clip lookups are shared by the playback, lanes and inspector.
  const historyMap = useMemo(() => new Map(history.map((h) => [h.id, h])), [history]);
  const metaFor = useCallback((clipId) => historyMap.get(clipId), [historyMap]);

  const imageNames = useMemo(() => new Set([...images, ...stills.items].map((i) => i.filename)), [images, stills.items]);
  const musicNames = useMemo(() => new Set(musicTracks.map((m) => m.filename)), [musicTracks]);

  // A lane entry is "missing" when its source is gone from the catalogue it
  // came from — the render would 404, so the editor flags it up front.
  //
  // Only `images`, `music` and the video history have a client-side catalogue.
  // For an asset kind we cannot enumerate — or a catalogue whose fetch failed —
  // "absent from the list" is NOT evidence of absence on disk, so say nothing
  // and let the render's MISSING_CLIPS report be the authority.
  const knownAbsent = useCallback((kind, file) => {
    if (kind === 'images') return loaded.images && checkedImageNames.has(file) && !imageNames.has(file);
    if (kind === 'music') return loaded.music && !musicNames.has(file);
    return false; // 'video-thumbnails' / 'audio' — no catalogue to check against
  }, [loaded.images, loaded.music, imageNames, musicNames, checkedImageNames]);

  const isSegmentMissing = useCallback((seg) => (seg.type === 'still'
    ? knownAbsent(seg.assetKind, seg.assetFile)
    : loaded.clips && !historyMap.has(seg.clipId)), [knownAbsent, loaded.clips, historyMap]);
  const isOverlayMissing = useCallback((ov) => knownAbsent(ov.assetKind, ov.assetFile), [knownAbsent]);
  const isBedMissing = useCallback((tr) => knownAbsent(tr.assetKind, tr.assetFile), [knownAbsent]);

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

  const [pendingLanes, setPendingLanes] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [savePending, setSavePending] = useState(false);
  const saveTimeline = useCallback((next) => queueWrite(async () => {
    if (updatedAtRef.current == null) return false;
    setSavePending(true);
    setSaveError(null);
    const updated = await updateTimelineProject(projectId, {
      ...timelinePatch(next),
      expectedUpdatedAt: updatedAtRef.current,
    }, { silent: true }).catch((err) => {
      if (err.code === 'CONFLICT') {
        if (pendingLanesRef.current) {
          setSaveError('Project was modified elsewhere. Your edits are retained; retry after resolving the conflict, or discard to leave.');
        } else {
          toast.error('Project was modified elsewhere — reloading');
          refresh();
        }
        return null;
      }
      setSaveError(`Save failed: ${err.message}`);
      toast.error(`Save failed: ${err.message}`);
      return null;
    });
    setSavePending(false);
    if (!updated) return false;
    updatedAtRef.current = updated.updatedAt;
    setProject((p) => ({ ...p, updatedAt: updated.updatedAt }));
    return true;
  }).then((saved) => {
    if (saved && pendingLanesRef.current === next) {
      pendingLanesRef.current = null;
      setPendingLanes(null);
    }
    return saved;
  }), [projectId, refresh, queueWrite]);

  // Debounced save: trim/fade edits fire many PATCHes per drag if we don't
  // batch them. 400ms gives the user time to stop fiddling before we hit the
  // server.
  const saveTimerRef = useRef(null);
  const pendingLanesRef = useRef(null);
  const queueSave = useCallback((next) => {
    clearTimeout(saveTimerRef.current);
    pendingLanesRef.current = next;
    setPendingLanes(next);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveTimeline(next);
    }, 400);
  }, [saveTimeline]);

  // Both router navigation and tab close remain guarded until the latest
  // snapshot succeeds. A failure must not turn an in-memory edit into "saved".
  const routeGuard = useUnsavedChangesGuard(pendingLanes !== null);
  const retrySave = () => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (pendingLanesRef.current) saveTimeline(pendingLanesRef.current);
  };
  const discardAndExit = () => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    pendingLanesRef.current = null;
    setPendingLanes(null);
    routeGuard.proceed();
  };

  // Navigation can unmount the editor before the debounce fires. Flush the
  // latest lanes so the final edit is persisted instead of silently dropped.
  useEffect(() => () => {
    if (saveTimerRef.current == null) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (pendingLanesRef.current != null) saveTimeline(pendingLanesRef.current);
  }, [saveTimeline]);

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
  // React may defer the state updater, so check the current lane before
  // scheduling the addition.
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
    setImages(previous => [...previous.filter(item => item.filename !== image.filename), image]);
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

  // Free-lane entries land where the editor is currently parked.
  const addOverlay = useCallback((image, playhead, total) => {
    setImages(previous => [...previous.filter(item => item.filename !== image.filename), image]);
    addToLane('overlay', {
      _key: laneKey('ov', 0),
      type: 'image',
      assetKind: 'images',
      assetFile: image.filename,
      startSec: Math.min(playhead, Math.max(0, total - 0.1)),
      durationSec: DEFAULT_OVERLAY_SEC,
      x: 0.05,
      y: 0.05,
      width: 0.25,
      opacity: 1,
      fadeInSec: 0,
      fadeOutSec: 0,
    });
  }, [addToLane]);

  const addBed = useCallback((track, playhead, total) => {
    addToLane('audio', {
      _key: laneKey('bed', 0),
      assetKind: 'music',
      assetFile: track.filename,
      startSec: Math.min(playhead, Math.max(0, total - 0.1)),
      offsetSec: 0,
      // The client can't probe the file; the server clamps this down to the
      // real duration when it renders.
      durationSec: Math.max(1, Math.min(DEFAULT_BED_SEC, total || DEFAULT_BED_SEC)),
      volume: 0.6,
      fadeInSec: 0,
      fadeOutSec: 0,
    });
  }, [addToLane]);

  // Filter the library: hide outputs of any timeline render so the rail
  // doesn't grow unbounded with the user's own renders.
  const libraryClips = useMemo(
    () => history.filter((h) => !h.timelineProjectId && !h.hidden),
    [history],
  );
  const usedClipIds = useMemo(
    () => new Set(lanes.segments.filter((s) => s.type === 'clip').map((s) => s.clipId)),
    [lanes.segments],
  );

  const renameProject = (name) => {
      const trimmed = name.trim();
      if (!trimmed) { setNameDraft(project.name); return; }
      if (trimmed === project.name) return;
      // Through the same tail as the lane saves — see queueWrite. The
      // expectedUpdatedAt read has to happen INSIDE the queued fn, or
      // it captures a value the preceding write has already replaced.
      queueWrite(async () => {
        const updated = await updateTimelineProject(projectId, {
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
  };

  const flushForRender = () => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    return saveTimeline(lanes);
  };

  const selected = selection ? laneEntries(lanes, selection.lane)?.find((entry) => entry._key === selection.key) : null;

  return {
    project,
    loading,
    error,
    lanes,
    selection,
    selected,
    setSelection,
    updateLanes,
    patchLane,
    removeFromLane,
    nameDraft,
    setNameDraft,
    renameProject,
    metaFor,
    isSegmentMissing,
    isOverlayMissing,
    isBedMissing,
    library: {
      libraryTab, setLibraryTab, imageQuery, setImageQuery, stills,
      libraryClips, usedClipIds, musicTracks, catalogStatus, retryCatalog,
      addClip, addStill, addOverlay, addBed,
    },
    save: { saveError, savePending, routeGuard, retrySave, discardAndExit, flushForRender },
  };
}

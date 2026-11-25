import { Suspense, useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import { Plus, Film, Wand2 } from 'lucide-react';
import toast from '../components/ui/Toast';
import socket from '../services/socket';
import { useConfirmDelete } from '../hooks/useConfirmDelete';
import PageHeader from '../components/PageHeader';
import PageSkeleton from '../components/ui/PageSkeleton';
import { lazyWithReload } from '../utils/lazyWithReload.js';
import Banner from '../components/ui/Banner.jsx';
import { usePagedCollection } from '../hooks/usePagedCollection';
import {
  listMusicVideoProjectSummaries,
  listMusicVideoProjectVersions,
  createMusicVideoProject,
  cloneMusicVideoProject,
  updateMusicVideoProject,
  deleteMusicVideoProject,
  getMusicVideoProject,
} from '../services/apiMusicVideo.js';
import useListResource from '../hooks/useListResource.js';
import MidiInstallModal from '../components/install/MidiInstallModal.jsx';
import MidiGatedModal from '../components/install/MidiGatedModal.jsx';
import { listTracks } from '../services/apiTracks.js';
import CreateProjectDrawer from '../components/musicVideo/CreateProjectDrawer.jsx';
import AutonomousStartDrawer from '../components/musicVideo/AutonomousStartDrawer.jsx';
import { automationDraftFrom, automationFromDraft } from '../lib/musicVideoAutomation.js';
import { listUniverseNames } from '../services/apiUniverseBuilder.js';
import { MUSIC_VIDEO_PAGE_ID, MUSIC_VIDEO_SCROLL_ID } from '../components/musicVideo/MusicVideoLayout.jsx';
import { distinctMusicVideoLabels, groupMusicVideoProjects, musicVideoVersionLabels } from '../lib/musicVideoProjectList.js';
import ProjectIndex from '../components/musicVideo/ProjectIndex.jsx';
import useMusicVideoJobSlots from '../components/musicVideo/useMusicVideoJobSlots.js';
import useProjectSummarySync from '../components/musicVideo/useProjectSummarySync.js';
import { resolveStageParam, compareMusicVideoProjectsNewestFirst } from '../lib/musicVideoStages.js';
import { applyMusicVideoEdit } from '../lib/musicVideoEditResult.js';
import { isMusicVideoCompleted } from '../../../server/lib/musicVideo/musicVideoSummary.js';

// The open-project workspace (and, through it, every stage) is its own chunk, so
// the project list never downloads it (#16565).
const ProjectWorkspace = lazyWithReload(() => import('../components/musicVideo/ProjectWorkspace.jsx'));

// Automation first: a new project defaults to autopilot with the free tools.
const emptyCreateForm = () => ({
  name: '', mode: 'autonomous', trackId: '', characterStyleId: '', universeId: '', moodBoardId: '', automation: automationDraftFrom(null),
});

// Format project label for the header dropdown: omit trailing media type parentheticals
// like "(experimental, images)" or "(revision)" so the title remains clean.
function formatProjectPickerLabel(project, versioned) {
  if (typeof project.name !== 'string') return '';
  const name = project.name.replace(/\s*\([^)]*\)$/, '').trim();
  if (!versioned) return name;
  const version = `v${project.version || 1}`;
  // Auto-forks already have a bare version suffix; show it once in picker format.
  const title = name.endsWith(` ${version}`) ? name.slice(0, -(version.length + 1)) : name;
  return `${title} (${version})`;
}

// Stable fetcher for useListResource — the hook re-runs on identity change.
const loadTracks = () => listTracks({ silent: true });
const loadUniverses = () => listUniverseNames({ silent: true });

export default function MusicVideo() {
  // Deep-linkable project selection: the selected project lives in the URL
  // (/music-video/:projectId) rather than local state, so a project's
  // scene board is directly shareable/bookmarkable and reachable from the
  // media job-completion hooks. selectProject() navigates; the browser URL is
  // the single source of truth for "which project is open".
  // The open stage is `/music-video/:projectId/:stage` (Setup, Cast & Sets,
  // Board, Produce, Compose, Review); a missing or unknown stage opens the
  // stage the project was in. A development artifact opens from its own deep
  // link (/music-video/:projectId/:stage/dev/:artifactId, or the older
  // /music-video/:projectId/dev/:artifactId), the version from `?v=`.
  const { projectId: routeProjectId, artifactId: routeArtifactId, stage: routeStage, sceneId: routeSceneId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const newParam = searchParams.get('new');
  const createOpen = newParam === 'project';
  const autonomousOpen = newParam === 'autonomous';
  const setCreateOpen = (open) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (open) next.set('new', 'project'); else next.delete('new');
    return next;
  });
  const setAutonomousOpen = (open) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (open) next.set('new', 'autonomous'); else next.delete('new');
    return next;
  });
  const navigate = useNavigate();
  // The index and picker read bounded summaries; an open project is its own
  // single-record fetch (#10169), so neither load can fail the other.
  const [selectedProject, setSelectedProject] = useState(null);
  // The last failed/absent read of the open project, keyed by id so it never
  // outlives a navigation; it stays up during a retry and clears on success.
  const [selectedFault, setSelectedFault] = useState(null);
  const [selectedFetching, setSelectedFetching] = useState(false);
  const [selectedReload, setSelectedReload] = useState(0);
  // The id whose single-record fetch is in flight, so a patch that lands for
  // it mid-flight (a job finishing) can refetch instead of being folded into a
  // response that may predate it.
  const fetchingIdRef = useRef(null);
  // The newest saved revision of the open project this tab has applied (a read or an edit reply).
  // An edit reply is a diff against the record before it, and a read can be older than a reply that
  // landed first, so neither is applied over a newer one (#16247).
  const savedRevision = useRef({ id: null, updatedAt: null });
  const isOlderThanApplied = useCallback((projectId, updatedAt) => savedRevision.current.id === projectId
    && !!updatedAt && !!savedRevision.current.updatedAt && updatedAt < savedRevision.current.updatedAt, []);
  const noteApplied = useCallback((projectId, updatedAt) => {
    if (!updatedAt || isOlderThanApplied(projectId, updatedAt)) return;
    savedRevision.current = { id: projectId, updatedAt };
  }, [isOlderThanApplied]);
  const appliedProjectId = selectedProject?.id;
  const appliedUpdatedAt = selectedProject?.updatedAt;
  // Functional patches derive their revision from the record they actually update.
  useLayoutEffect(() => {
    if (appliedProjectId) noteApplied(appliedProjectId, appliedUpdatedAt);
  }, [appliedProjectId, appliedUpdatedAt, noteApplied]);
  // The music library the pickers read. A failed read is shown as such, with
  // Retry, never as an empty library; an import appends to it locally.
  const trackLibrary = useListResource(loadTracks);
  const { items: tracks, setItems: setTracks } = trackLibrary;
  // Imports can complete before the library read; replace that pre-import read.
  const onTrackImported = (track) => {
    if (trackLibrary.state !== 'ready') trackLibrary.retry();
    else setTracks((prev) => [...prev.filter((item) => item.id !== track.id), track]);
  };
  const universeResource = useListResource(loadUniverses);
  const universes = universeResource.items;
  // A project-less stage URL (/music-video/board, from the nav manifest) names a stage, not a project:
  // treat it as the index until the summaries resolve, then redirect to the newest project at that stage.
  const stageOnlyParam = !routeStage && !routeSceneId && !routeArtifactId ? resolveStageParam(routeProjectId) : null;
  const selectedId = stageOnlyParam ? null : (routeProjectId || null);
  // Summaries load for the index, or once the header picker is used on a deep link;
  // once wanted they stay loaded (disabling the hook would reset its items).
  const [summariesWanted, setSummariesWanted] = useState(false);
  const [statusFilter, setStatusFilter] = useState('in-progress');
  // The name query is searched server-side before paging; typing debounces so each keystroke is not a request.
  const nameQuery = searchParams.get('q') || '';
  const trimmedQuery = nameQuery.trim();
  const [serverQuery, setServerQuery] = useState(trimmedQuery);
  useEffect(() => {
    const timer = setTimeout(() => setServerQuery(trimmedQuery), 250);
    return () => clearTimeout(timer);
  }, [trimmedQuery]);
  const fetchSummariesPage = useCallback(
    ({ cursor, signal }) => listMusicVideoProjectSummaries({ cursor, limit: 30 }, { signal, silent: true }),
    [],
  );
  const summaries = usePagedCollection(fetchSummariesPage, { enabled: summariesWanted || !!stageOnlyParam });
  const fetchIndexPage = useCallback(
    ({ cursor, signal }) => listMusicVideoProjectSummaries({ cursor, limit: 30, statusFilter: statusFilter === 'all' ? undefined : statusFilter, q: serverQuery || undefined }, { signal, silent: true }),
    [statusFilter, serverQuery],
  );
  const indexSummaries = usePagedCollection(fetchIndexPage, { enabled: !selectedId && !stageOnlyParam });
  // Same stickiness for the list: the banner outlives the retry that clears `summaries.error`.
  const [listError, setListError] = useState(null);
  useEffect(() => {
    if (indexSummaries.error) setListError(indexSummaries.error.message || 'Failed to load music video projects');
    else if (indexSummaries.loaded) setListError(null);
  }, [indexSummaries.error, indexSummaries.loaded]);
  const selectedLoaded = selectedProject?.id === selectedId;
  const fault = selectedFault?.id === selectedId ? selectedFault : null;
  const loading = selectedId ? !selectedLoaded && (selectedFetching || !fault) : (stageOnlyParam ? (summaries.loading || !summaries.loaded) && !summaries.error : !indexSummaries.loaded && !indexSummaries.error);
  const projectsError = selectedId ? (fault?.notFound ? null : fault?.message) : stageOnlyParam ? summaries.error?.message
    : !indexSummaries.loaded ? (indexSummaries.error?.message || listError) : null;

  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    setSelectedFetching(true);
    fetchingIdRef.current = selectedId;
    getMusicVideoProject(selectedId, { silent: true })
      .then((project) => {
        if (cancelled) return;
        setSelectedFault(project ? null : { id: selectedId, notFound: true });
        if (project) {
          savedRevision.current = { id: project.id, updatedAt: project.updatedAt ?? null };
          setSelectedProject(project);
        }
      })
      .catch((err) => {
        if (!cancelled) setSelectedFault({ id: selectedId, notFound: err?.status === 404, message: err?.message || 'Failed to load music video project' });
      })
      .finally(() => {
        if (cancelled) return;
        fetchingIdRef.current = null;
        setSelectedFetching(false);
      });
    return () => { cancelled = true; };
  }, [selectedId, selectedReload]);

  const loadProjects = selectedId
    ? () => setSelectedReload((n) => n + 1)
    : () => { const collection = stageOnlyParam ? summaries : indexSummaries; if (!collection.loading) collection.reload(); };
  const selected = selectedLoaded ? selectedProject : null;
  const selectedRoot = selected ? selected.rootProjectId || selected.id : null;
  // Keep the request identity through the brief gap between the cached record
  // and its URL changing on a fork. Only the selected root may display results.
  const versionRequestRoot = selectedId && selectedProject ? selectedProject.rootProjectId || selectedProject.id : null;
  const loadVersions = useCallback(() => listMusicVideoProjectVersions(versionRequestRoot, { silent: true }), [versionRequestRoot]);
  const versionFamily = useListResource(loadVersions, { enabled: !!versionRequestRoot, retainOnRetry: true });

  const { retry: retryVersions, setItems: setFamilyVersions } = versionFamily;

  const [cloningId, setCloningId] = useState(null);
  const cloning = !!cloningId;
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyCreateForm);

  const handleRename = () => {
    if (!selected) return;
    setRenameDraft(selected.name || '');
    setRenamingId(selected.id);
  };
  const commitRename = () => {
    const name = renameDraft.trim();
    if (!selected || !name || name === selected.name) { setRenamingId(null); return; }
    const projectId = selected.id;
    updateMusicVideoProject(projectId, { name })
      .then((saved) => { patchProject(projectId, { name: saved?.name ?? name, updatedAt: saved?.updatedAt }); setRenamingId(null); })
      .catch(() => {});
  };
  // Holds the id being renamed so the form closes itself when another project opens.
  const [renamingId, setRenamingId] = useState(null);
  const renaming = !!selected && renamingId === selected.id;
  const [renameDraft, setRenameDraft] = useState('');
  const renameForm = renaming ? (
    <form
      onSubmit={(e) => { e.preventDefault(); commitRename(); }}
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      <label htmlFor="mv-rename-input" className="sr-only">Project title</label>
      <input
        id="mv-rename-input"
        autoFocus
        value={renameDraft}
        maxLength={120}
        onChange={(e) => setRenameDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setRenamingId(null); }}
        className="min-w-0 flex-1 basis-48 sm:max-w-md bg-port-bg border border-port-border rounded px-2 py-1.5 text-base sm:text-sm"
      />
      <button type="submit" disabled={!renameDraft.trim()} className="rounded bg-port-accent px-3 py-1.5 text-sm text-white disabled:opacity-50 min-h-[44px] pointer-fine:sm:min-h-0">Save</button>
      <button type="button" onClick={() => setRenamingId(null)} className="rounded border border-port-border px-3 py-1.5 text-sm min-h-[44px] pointer-fine:sm:min-h-0">Cancel</button>
    </form>
  ) : null;
  // A full record replaces its summary in the index list; the project card
  // derives from whichever it holds, so no summary-only field can go stale.
  // `renderSpend` is attached only when the server presents a read (#16506); a mutation or run
  // event's record without it keeps the one already held until the next read or spend event.
  const replaceProject = (next) => {
    if (next.id === savedRevision.current.id) noteApplied(next.id, next.updatedAt);
    const withSpend = (prev) => (next.renderSpend || !prev?.renderSpend ? next : { ...next, renderSpend: prev.renderSpend });
    setSelectedProject((prev) => (prev?.id === next.id ? withSpend(prev) : prev));
    summaries.setItems((prev) => prev.map((p) => (p.id === next.id ? withSpend(p) : p)));
  };
  // Open a project the page just received whole (created, forked, started).
  const openProject = (proj) => {
    summaries.setItems((prev) => [proj, ...prev.filter((p) => p.id !== proj.id)]);
    setSelectedProject(proj);
    if (selectedRoot && (proj.rootProjectId || proj.id) === selectedRoot) retryVersions();
  };
  // The open project leads; summaries fill in the rest of the picker.
  const sortedProjects = useMemo(() => {
    const pickerItems = !summaries.loaded && !stageOnlyParam ? indexSummaries.items : summaries.items;
    const byId = new Map(pickerItems.map((p) => [p.id, p]));
    for (const version of versionFamily.items) {
      if ((version.rootProjectId || version.id) === selectedRoot && !byId.has(version.id)) byId.set(version.id, version);
    }
    if (selected) byId.set(selected.id, selected);
    return [...byId.values()].sort(compareMusicVideoProjectsNewestFirst);
  }, [selected, summaries.items, summaries.loaded, indexSummaries.items, stageOnlyParam, versionFamily.items, selectedRoot]);
  const versionGroups = useMemo(() => groupMusicVideoProjects(sortedProjects), [sortedProjects]);
  const projectPickerLabels = useMemo(() => {
    const versionedRoots = new Set(versionGroups.filter(({ versions }) => versions.length > 1).map(({ rootId }) => rootId));
    return distinctMusicVideoLabels(sortedProjects, (project) =>
      formatProjectPickerLabel(project, Number.isInteger(project.version) || versionedRoots.has(project.rootProjectId || project.id)));
  }, [sortedProjects, versionGroups]);
  const selectedVersions = versionGroups.find(({ rootId }) => rootId === selectedRoot)?.versions ?? [];
  const versionLabels = musicVideoVersionLabels(selectedVersions);
  useEffect(() => {
    if (!stageOnlyParam || !summaries.loaded || summaries.error) return;
    const newest = sortedProjects[0];
    navigate(newest ? `/music-video/${encodeURIComponent(newest.id)}/${stageOnlyParam}` : "/music-video", { replace: true });
  }, [stageOnlyParam, summaries.loaded, summaries.error, sortedProjects, navigate]);
  // Functional merges keyed on the captured projectId/sceneId so an async result
  // that resolves after the user edited the board can't clobber those edits with
  // a stale project snapshot. `patch` may be a function of the current record
  // when the merge has to read a field it is also writing.
  const patchProject = (projectId, patch) => {
    const apply = (project) => ({ ...project, ...(typeof patch === 'function' ? patch(project) : patch) });
    // The picker and index show a project's name/status/recency, so keep those current.
    summaries.setItems((prev) => prev.map((p) => {
      if (p.id !== projectId) return p;
      const { name, status, updatedAt } = apply(p);
      return { ...p, name, status, updatedAt };
    }));
    setSelectedProject((prev) => (prev?.id === projectId ? apply(prev) : prev));
    // A project that isn't open (a render finished after the user navigated
    // away) reads the server's record when it is next fetched. One that is
    // being fetched right now may get a response computed before this patch
    // was persisted, so fetch it again.
    if (fetchingIdRef.current === projectId) setSelectedReload((n) => n + 1);
  };
  // `patch` may be a function of the scene as it stands, for a change built on its latest take list.
  const patchScene = (projectId, sceneId, patch) => patchProject(projectId, (project) => ({
    scenes: (project.scenes || []).map((s) => (s.sceneId === sceneId ? { ...s, ...(typeof patch === 'function' ? patch(s) : patch) } : s)),
  }));

  const {
    youtube, separation, lyricAlign, midi, renderJob, videoSettings, publishing, analyzing, prepareSong, handleAnalyze,
  } = useMusicVideoJobSlots({
    routeProjectId,
    navigate,
    selected,
    selectedId,
    onTrackImported,
    onCreateComplete: (track) => setForm((f) => ({
      ...f,
      trackId: track.id,
      ...(!f.name || tracks.some((t) => t.title === f.name) ? { name: track.title || '' } : {}),
    })),
    replaceProject,
    patchProject,
  });

  // Index: name filter lives in the URL (?q=); the picked fork version per root
  // outlives opening a project; cards patch in place from run events.
  const setNameQuery = (value) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (value) next.set('q', value); else next.delete('q');
    return next;
  }, { replace: true });
  // Once the index has rendered, a reload (new name or status filter) keeps it mounted so the search box keeps focus.
  const indexShown = useRef(false);
  useEffect(() => { if (indexSummaries.loaded) indexShown.current = true; }, [indexSummaries.loaded]);
  const nameMatches = (project) => !serverQuery || String(project.name || '').toLowerCase().includes(serverQuery.toLowerCase());
  const [pickedVersion, setPickedVersion] = useState({}); // rootId -> project id
  const indexRef = useRef(indexSummaries);
  indexRef.current = indexSummaries;
  useEffect(() => {
    const onRunEvent = (data) => {
      if (!data?.project?.id) return;
      replaceProject(data.project);
      if (selectedId || stageOnlyParam) return;
      // Run payloads omit read-time Blender state; the index reads the presented record.
      if (statusFilter !== 'all') return;
      const index = indexRef.current;
      const previous = index.items.find((p) => p.id === data.project.id);
      if (!previous) return;
      if (!nameMatches(data.project)) {
        index.setItems((items) => items.filter((p) => p.id !== data.project.id));
        index.reconcileFirst();
      }
      else index.setItems((items) => items.map((p) => p.id === data.project.id ? data.project : p));
    };
    const events = ['music-video:autonomous', 'music-video:production'];
    events.forEach((e) => socket.on(e, onRunEvent));
    // A paid render landed in a project's spend ledger, or an adjustment changed it.
    const onRenderSpend = ({ projectId, renderSpend }) => {
      if (projectId && renderSpend) setSelectedProject((prev) => (prev?.id === projectId ? { ...prev, renderSpend } : prev));
    };
    socket.on('music-video:render-spend', onRenderSpend);
    return () => {
      events.forEach((e) => socket.off(e, onRunEvent));
      socket.off('music-video:render-spend', onRenderSpend);
    };
  }, [selectedId, stageOnlyParam, statusFilter, serverQuery]);

  // Shot fields typed locally and not yet saved: a refetch after a change made elsewhere keeps these.
  const unsavedSceneFields = useRef(new Map());
  // The open workspace's take actions: a change made elsewhere is read once this tab's queued take decisions land.
  const takesRef = useRef(null);
  // A freshly read record replaces the open project; shot fields typed and not yet saved keep their text.
  // Returns true for a conflict, or null when a queued patch made the read stale.
  const mergeFetchedProject = (fresh) => {
    let conflict = false;
    let stale = false;
    flushSync(() => setSelectedProject((prev) => {
      if (prev?.id !== fresh.id) return prev;
      if (fresh.updatedAt && prev.updatedAt && fresh.updatedAt < prev.updatedAt) {
        stale = true;
        return prev;
      }
      const local = new Map((prev.scenes || []).map((s) => [s.sceneId, s]));
      const scenes = (fresh.scenes || []).map((scene) => {
        const mine = local.get(scene.sceneId);
        const keys = unsavedSceneFields.current.get(scene.sceneId);
        if (!mine || !keys?.size) return scene;
        const kept = { ...scene };
        keys.forEach((k) => { if (kept[k] !== mine[k]) { conflict = true; kept[k] = mine[k]; } });
        return kept;
      });
      return { ...fresh, scenes };
    }));
    if (stale) return null;
    noteApplied(fresh.id, fresh.updatedAt);
    summaries.setItems((prev) => prev.map((p) => (p.id === fresh.id ? fresh : p)));
    return conflict;
  };
  // The one full reload of the open project after first load: a change made elsewhere, a reconnect,
  // a refused edit, or an edit reply that cannot be applied. It reads once this tab's queued take
  // decisions land, and reads again when an edit reply newer than the read landed meanwhile (that
  // reply's diff assumed every change before it, which the stale read does not carry past it).
  const reloadOpenProject = (projectId, { onMerged = null } = {}) => {
    const read = () => getMusicVideoProject(projectId, { silent: true });
    const attempt = (left) => (takesRef.current ? takesRef.current.afterTakeWrites(read) : read()).then((fresh) => {
      if (!fresh || fresh.id !== projectId) return;
      const conflict = isOlderThanApplied(projectId, fresh.updatedAt) ? null : mergeFetchedProject(fresh);
      if (conflict === null) return left > 0 ? attempt(left - 1) : undefined;
      onMerged?.(conflict);
    });
    return attempt(2).catch(() => {});
  };
  // A board edit's reply (lib/musicVideoEditResult.js) patched into the open project; fields typed and
  // not yet saved keep their text. One that cannot be applied safely reloads instead.
  const applyEdit = (projectId, edit) => {
    if (!edit || isOlderThanApplied(projectId, edit.updatedAt)) { void reloadOpenProject(projectId); return; }
    noteApplied(projectId, edit.updatedAt);
    let refused = false;
    // Applied at once, so a reply the open record refuses (one older than a change that landed since,
    // say a rename) is known here and reloads.
    flushSync(() => setSelectedProject((prev) => {
      if (prev?.id !== projectId) return prev;
      const next = applyMusicVideoEdit(prev, edit, { keep: unsavedSceneFields.current });
      if (!next) refused = true;
      return next || prev;
    }));
    if (refused) { void reloadOpenProject(projectId); return; }
    if (edit.updatedAt) summaries.setItems((prev) => prev.map((p) => (p.id === projectId ? { ...p, updatedAt: edit.updatedAt } : p)));
  };
  // An edit made elsewhere (an agent, another tab) reaches the open project here; fields typed
  // locally and not yet saved keep their text, with a notice that the shot changed. A reconnect
  // reloads too: events sent while the socket was down are not replayed.
  useEffect(() => {
    if (!selectedId) return undefined;
    let active = true;
    let dropped = false;
    const reload = () => reloadOpenProject(selectedId, { onMerged: (conflict) => {
      if (active && conflict) toast.info('A shot changed elsewhere. Your unsaved text is kept; saving it replaces the other edit.');
    } });
    const onChanged = (data) => {
      if (data?.id !== selectedId) return;
      // This tab's own edit: its reply already updated the board.
      if (data.origin && data.origin === socket.id) return;
      void reload();
    };
    const onDisconnect = () => { dropped = true; };
    const onConnect = () => { if (!dropped) return; dropped = false; void reload(); };
    socket.on('music-video:project:changed', onChanged);
    socket.on('disconnect', onDisconnect);
    socket.on('connect', onConnect);
    return () => {
      active = false;
      socket.off('music-video:project:changed', onChanged);
      socket.off('disconnect', onDisconnect);
      socket.off('connect', onConnect);
    };
  }, [selectedId]);

  // The index and the header picker share `summaries`. The open-project listener
  // above ignores every other id, and the first page is newest-created-first, so
  // a blanket refresh cannot update an older card or drop a deleted one.
  useProjectSummarySync({ summaries, selectedId, enabled: summariesWanted });
  const catalogSync = useProjectSummarySync({ summaries: indexSummaries, selectedId, enabled: !selectedId && !stageOnlyParam, statusFilter, matches: nameMatches });

  // `youtube.editJob` is one shared job slot for the whole detail view (not
  // per-project) — switching the selected project while it has an import in
  // flight would silently orphan that job's SSE subscription (the finished
  // track would land in the library but never get attached, since the
  // completion handler's onComplete never fires for a target nobody is
  // listening for anymore) and misattribute its progress UI to whichever
  // project is now selected. Block switching until that import settles. (The
  // hook re-asserts the same invariant against URL-driven navigation.)
  const selectProject = (id, stage = null, { clearNew = false } = {}) => {
    if (youtube.editJob.active && id !== selectedId) {
      toast.error(youtube.switchBlockedMessage);
      return;
    }
    if (id && !selectedId) setSummariesWanted(true);
    const nextSearch = new URLSearchParams(searchParams);
    if (clearNew) nextSearch.delete('new');
    const path = id ? `/music-video/${id}${stage ? `/${stage}` : ''}` : '/music-video';
    // Replace the submitted drawer's entry so Back returns to the index.
    navigate({ pathname: path, search: nextSearch.toString() }, { replace: clearNew });
  };

  const trackName = useCallback((id) => tracks.find((t) => t.id === id)?.title || id || '—', [tracks]);

  const handleCreate = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    // An audio import in flight hasn't set form.trackId yet — creating now
    // would make a track-less project, and the import's later completion
    // would only fill in the (already-reset) form's trackId instead of
    // attaching to the project the user just created.
    if (youtube.createJob.active) {
      toast.error('Finish or cancel the in-progress audio import before creating the project');
      return;
    }
    if (creating) return;
    setCreating(true);
    // Only the ids go up: the server snapshots the universe/board style and track metadata into the concept.
    createMusicVideoProject({
      name: form.name.trim(),
      mediaMode: form.mediaMode || 'code-images-video',
      mode: form.mode,
      trackId: form.trackId || null,
      concept: { universeId: form.universeId || null, ...(form.characterStyleId ? { characterStyleId: form.characterStyleId } : {}) },
      ...(form.moodBoardId ? { visualSpec: { moodBoardId: form.moodBoardId } } : {}),
      ...(form.mode === 'autonomous' ? { automation: automationFromDraft(form.automation) } : {}),
    }, { silent: true })
      .then((proj) => {
        openProject(proj);
        selectProject(proj.id, null, { clearNew: true });
        setForm(emptyCreateForm());
        toast.success('Project created');
        if (proj.trackId) prepareSong(proj.id);
      })
      .catch((err) => toast.error(err?.message || 'Failed to create project'))
      .finally(() => setCreating(false));
  };

  const pendingDeletes = useRef(new Set());
  const [removingIds, setRemovingIds] = useState(() => new Set());
  const { isConfirming: isConfirmingDelete, requestDelete, cancelDelete, confirmDelete } = useConfirmDelete();

  const handleDeleteRequest = (id) => {
    if (youtube.editJob.active && id === selectedId) {
      toast.error('Finish or cancel the in-progress audio import before deleting this project');
      return;
    }
    requestDelete(id);
  };

  const handleDelete = (id) => {
    // Same hazard selectProject guards against: deleting the project an
    // in-flight edit-surface import targets would still finish server-side
    // and try to PATCH a now-deleted project.
    if (youtube.editJob.active && id === selectedId) {
      toast.error('Finish or cancel the in-progress audio import before deleting this project');
      return;
    }
    if (pendingDeletes.current.has(id)) return;
    pendingDeletes.current.add(id);
    deleteMusicVideoProject(id, { silent: true })
      .then(() => {
        // From the index the card collapses first and leaves on exit; the
        // workspace navigates away, so nothing is left to animate there.
        if (selectedId === id) finishRemoval(id);
        else setRemovingIds((prev) => new Set([...prev, id]));
      })
      .catch((err) => {
        pendingDeletes.current.delete(id);
        toast.error(err?.message || 'Failed to delete project');
      });
  };

  const finishRemoval = (id) => {
    pendingDeletes.current.delete(id);
    setRemovingIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    summaries.setItems((prev) => prev.filter((p) => p.id !== id));
    indexSummaries.setItems((prev) => prev.filter((p) => p.id !== id));
    setFamilyVersions((prev) => prev.filter((p) => p.id !== id));
    indexSummaries.reconcileFirst();
    if (selectedId === id) navigate('/music-video');
  };

  // The workspace's Project settings drawer and the index cards share one confirm flow.
  const deletion = {
    isConfirming: isConfirmingDelete,
    request: handleDeleteRequest,
    confirm: (id) => confirmDelete(() => handleDelete(id)),
    cancel: cancelDelete,
    isRemoving: (id) => removingIds.has(id),
    finishRemoval,
  };

  const handleClone = (optionsOrTarget = {}, maybeOptions = {}, songRevision = false) => {
    const isTarget = optionsOrTarget && typeof optionsOrTarget.id === 'string';
    const target = isTarget ? optionsOrTarget : selected;
    const options = isTarget ? maybeOptions : (optionsOrTarget || {});

    if (!target || cloningId) return;
    setCloningId(target.id);
    cloneMusicVideoProject(target.id, options, { silent: true })
      .then((project) => {
        openProject(project);
        navigate(`/music-video/${project.id}${songRevision === true ? "/setup" : ""}`);
        toast.success(`Created ${project.name}`);
      })
      .catch((err) => toast.error(err?.message || 'Failed to clone project'))
      .finally(() => setCloningId(null));
  };

  return (
    // Below md the whole page scrolls (title bar and project header with it), so the step gets the screen.
    <div id={MUSIC_VIDEO_PAGE_ID} className="flex h-full flex-col max-md:overflow-auto">
      <MidiInstallModal {...midi.installGate} />
      <MidiGatedModal {...midi.gatedGate} />
      <PageHeader
        icon={Film}
        title="Music Video"
        subtitle={selected ? null : 'Beat-aware music videos — autopilot or hands-on'}
        actions={(
          <>
            <label htmlFor="mv-project-picker" className="sr-only">Project</label>
            <select
              id="mv-project-picker"
              value={selectedId || ''}
              onChange={(e) => selectProject(e.target.value || null)}
              onFocus={() => setSummariesWanted(true)}
              disabled={loading || youtube.editJob.active}
              className="w-40 min-w-0 max-w-[45vw] sm:w-56 sm:max-w-none bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm disabled:opacity-50"
            >
              <option value="">{loading ? 'Loading projects…' : 'Select a project…'}</option>
              {sortedProjects.map((project) => (
                <option key={project.id} value={project.id}>{projectPickerLabels.get(project.id)}</option>
              ))}
            </select>
            {!selected && (
              <>
            <button
              type="button"
              onClick={() => setAutonomousOpen(true)}
              title="One prompt in — lyrics, a Suno song, a mood board and the video out"
              className="flex items-center gap-1 rounded border border-port-accent text-port-accent px-3 py-1.5 text-sm min-h-[44px] pointer-fine:sm:min-h-0"
            >
              <Wand2 size={15} /> Autonomous
            </button>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="flex items-center gap-1 bg-port-accent text-white rounded px-3 py-1.5 text-sm min-h-[44px] pointer-fine:sm:min-h-0"
            >
              <Plus size={15} /> New project
            </button>
              </>
            )}
          </>
        )}
      />

      <CreateProjectDrawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        form={form}
        onFormChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        tracks={tracks}
        trackLibrary={trackLibrary}
        universes={universes}
        universeResource={universeResource}
        trackName={trackName}
        youtube={youtube}
        onSubmit={handleCreate}
        submitting={creating}
      />

      <AutonomousStartDrawer
        open={autonomousOpen}
        onClose={() => setAutonomousOpen(false)}
        onStarted={(proj) => {
          openProject(proj);
          selectProject(proj.id, null, { clearNew: true });
        }}
      />

      <div id={MUSIC_VIDEO_SCROLL_ID} className="min-h-0 flex-1 p-4 max-md:flex-none md:overflow-auto md:p-6">
        {projectsError && !selected && (
          <Banner tone="error" size="md" title="Music video projects unavailable" className="mb-4" actions={(
            <button
              type="button"
              onClick={loadProjects}
              disabled={loading}
              className="min-h-[44px] rounded border border-port-error/30 px-3 py-2 text-sm disabled:opacity-50"
            >
              {loading ? 'Retrying…' : 'Retry'}
            </button>
          )}>
            <p>{projectsError}</p>
          </Banner>
        )}
        {!selected && !loading && !projectsError && routeProjectId && !stageOnlyParam && (
          <p className="text-sm text-port-text-muted">
            Project not found — it may have been deleted.{' '}
            <button onClick={() => navigate('/music-video')} className="text-port-accent underline">Back to projects</button>
          </p>
        )}
        {!selected && (loading || !routeProjectId || !!stageOnlyParam) && (
          <div className="space-y-6">
            <div role="group" aria-label="Filter projects by status" className="flex flex-wrap gap-2">
              {[['all', 'All'], ['completed', 'Completed'], ['in-progress', 'In Progress']].map(([value, label]) => (
                <button key={value} type="button" aria-pressed={statusFilter === value} onClick={() => setStatusFilter(value)}
                  className={`min-h-[44px] rounded border px-3 py-1.5 text-sm ${statusFilter === value ? 'border-port-accent bg-port-accent text-white' : 'border-port-border hover:bg-port-card'}`}>
                  {label}
                </button>
              ))}
            </div>

            {loading && (stageOnlyParam || !indexShown.current) ? (
              <div className="text-center py-8 text-sm text-port-text-muted">
                Loading projects…
              </div>
            ) : projectsError ? null : (
              <ProjectIndex
                projects={indexSummaries.items.filter((project) => statusFilter === 'all' || isMusicVideoCompleted(project) === (statusFilter === 'completed'))}
                statusFilter={statusFilter}
                nameQuery={nameQuery}
                onNameQueryChange={setNameQuery}
                summaries={indexSummaries}
                catalogSync={catalogSync}
                pickedVersion={pickedVersion}
                onPickVersion={(rootId, id) => setPickedVersion((prev) => ({ ...prev, [rootId]: id }))}
                trackName={trackName}
                onSelect={selectProject}
                onClone={handleClone}
                deletion={deletion}
                cloningId={cloningId}
                onRename={(project) => {
                  setRenameDraft(project.name || '');
                  setRenamingId(project.id);
                  selectProject(project.id);
                }}
              />
            )}
          </div>
        )}
        {selected && (
          <Suspense fallback={<PageSkeleton header="bar" label="Loading project" tabs={1} cards={3} sidebar={false} />}>
            <ProjectWorkspace
              key={selected.id}
              selected={selected}
              unsavedSceneFields={unsavedSceneFields}
              takesRef={takesRef}
              mergeFetchedProject={mergeFetchedProject}
              applyEdit={applyEdit}
              reloadOpenProject={reloadOpenProject}
              tracks={tracks}
              trackLibrary={trackLibrary}
              trackName={trackName}
              youtube={youtube}
              separation={separation}
              lyricAlign={lyricAlign}
              midi={midi}
              renderJob={renderJob}
              videoSettings={videoSettings}
              publishing={publishing}
              analyzing={analyzing}
              cloning={cloning}
              replaceProject={replaceProject}
              patchProject={patchProject}
              patchScene={patchScene}
              openProject={openProject}
              prepareSong={prepareSong}
              onAnalyze={handleAnalyze}
              onClone={handleClone}
              onTrackImported={onTrackImported}
              onRename={handleRename}
              renameForm={renameForm}
              versionPicker={selectedVersions.length > 1 ? (
                <select
                  aria-label="Project version"
                  value={selected.id}
                  disabled={youtube.editJob.active}
                  onChange={(e) => selectProject(e.target.value, resolveStageParam(routeStage))}
                  className="ml-1 min-h-[44px] max-w-[45vw] shrink-0 rounded border border-port-border bg-port-bg sm:max-w-52 px-1.5 text-xs text-port-text-muted disabled:opacity-50 pointer-fine:sm:min-h-[32px]"
                >
                  {selectedVersions.map((version) => <option key={version.id} value={version.id}>{versionLabels.get(version.id)}</option>)}
                </select>
              ) : versionFamily.state === 'error' ? (
                <button type="button" aria-label="Retry loading project versions" onClick={retryVersions}
                  className="ml-1 min-h-[44px] shrink-0 rounded border border-port-border px-1.5 text-xs text-port-warning pointer-fine:sm:min-h-[32px]">
                  v{selected.version || 1} · Retry
                </button>
              ) : null}
              deletion={deletion}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
}

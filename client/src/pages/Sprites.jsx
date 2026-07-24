import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { PersonStanding, Download, X, RefreshCw, Plus, LayoutGrid, Search, Images, Scissors } from 'lucide-react';
import toast from '../components/ui/Toast';
import Modal from '../components/ui/Modal.jsx';
import {
  listSpriteRecords, getSpriteRecord, importSprites, createSpriteRecord,
  generateSpriteWalk, generateSpriteReference, listSpriteThumbnails,
} from '../services/apiSprites.js';
import { getApps } from '../services/apiApps.js';
import { getSettings } from '../services/apiSystem.js';
import { deriveAvailableBackends } from '../lib/imageGenBackends.js';
import AppContextPicker from '../components/AppContextPicker.jsx';
import ReferenceWorkflow from '../components/sprites/ReferenceWorkflow.jsx';
import WalkWorkflow, { WALK_DURATIONS } from '../components/sprites/WalkWorkflow.jsx';
import LoopTrimmer from '../components/sprites/LoopTrimmer.jsx';
import PublishWorkflow from '../components/sprites/PublishWorkflow.jsx';
import AssetCollection from '../components/sprites/AssetCollection.jsx';
import SpriteCatalog from '../components/sprites/SpriteCatalog.jsx';
import SpriteDetailHeader from '../components/sprites/SpriteDetailHeader.jsx';
import TabPills from '../components/ui/TabPills.jsx';
import useDrawerTab from '../hooks/useDrawerTab.js';
import useClickOutside from '../hooks/useClickOutside.js';
import { useAsyncAction } from '../hooks/useAsyncAction.js';
import { useSpritePendingRenders } from '../hooks/useSpritePendingRenders.js';
import { buildCollectionActions } from '../lib/spriteCollectionActions.js';
import { filterSpriteRecords, NEW_SPRITE_KINDS } from '../lib/spriteRecordGroups.js';
import { groupIconForKind } from '../components/sprites/spriteGroupIcons.js';

// Sprite Manager: library over imported production sprites — characters
// (reference sets, walk strips, runtime atlases) and props atlas families —
// plus the source-tree importer (#2895), the phase-2 reference workflow
// (create a character, generate + freeze the main reference, derive + lock
// the 8 directional anchors — #2896), and the phase-3 walk workflow (one
// grok i2v clip per anchor, deterministic packaging, per-direction approval
// into the finalized walk set — #2897). Publish lands in phase 4.

function ImportPanel({ onImported }) {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState([]);
  const [appId, setAppId] = useState('');
  const [includeProps, setIncludeProps] = useState(true);
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState([]);

  // Sprite sources are managed apps (we import/sync from an app's checkout),
  // so the picker is the source of truth for the path — no free-text root.
  // Archived apps and apps with no repoPath can't be a source.
  useEffect(() => {
    if (!open) return;
    getApps({ silent: true })
      .then((list) => setApps((list || []).filter((a) => a.repoPath && !a.archived)))
      .catch(() => setApps([]));
  }, [open]);

  const sourceRoot = apps.find((a) => a.id === appId)?.repoPath || '';

  const runImport = async () => {
    setImporting(true);
    setImportErrors([]);
    try {
      const { results, totals } = await importSprites({ sourceRoot, includeProps });
      if (totals.errors > 0) {
        // Keep the panel open and show WHICH files failed — a count alone
        // gives the user nothing to repair.
        setImportErrors(results.flatMap((r) => r.errors.map((e) => `${r.id}: ${e}`)));
        toast.error(`Import finished with ${totals.errors} error${totals.errors === 1 ? '' : 's'} — details below`);
      } else {
        toast.success(`Imported ${totals.subjects} subjects (${totals.files} files, ${totals.verified} hash-verified)`);
        setOpen(false);
      }
      onImported();
    } catch {
      // request() already toasted the failure — keep the panel open for a retry.
    } finally {
      setImporting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-accent hover:bg-blue-600 text-white rounded text-sm"
      >
        <Download className="w-4 h-4" /> Import
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="md" ariaLabel="Import production sprites" closeOnBackdrop={false}>
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Import production sprites</h3>
        <button onClick={() => setOpen(false)} aria-label="Close import panel" className="text-gray-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>
      <p className="text-xs text-gray-400">
        Pick the managed app holding the sprite pipeline (expects <code>art-pipeline/characters/</code> and/or <code>game/assets/sprites/</code>
        in its repo). Only approved/final assets import — reference candidates and raw run intermediates stay behind.
      </p>
      <AppContextPicker
        apps={apps}
        value={appId}
        onChange={setAppId}
        label="Source app"
        placeholder="Select an app…"
        ariaLabel="Sprite source app"
        repoLabel="Source root"
        emptyRepoText="pick an app to import from"
        selectClassName="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white min-h-[44px]"
      />
      <label htmlFor="sprite-import-props" className="flex items-center gap-2 text-sm text-gray-300">
        <input
          id="sprite-import-props"
          type="checkbox"
          checked={includeProps}
          onChange={(e) => setIncludeProps(e.target.checked)}
        />
        Include props atlas families from the game tree
      </label>
      <button
        onClick={runImport}
        disabled={importing || !sourceRoot}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-sm"
      >
        {importing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        {importing ? 'Importing…' : 'Run Import'}
      </button>
      {importErrors.length > 0 && (
        <ul className="max-h-40 overflow-y-auto space-y-1 text-xs text-port-error border border-port-border rounded p-2">
          {importErrors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
        </div>
      </Modal>
    </>
  );
}

function NewSpritePanel({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [id, setId] = useState('');
  const [kind, setKind] = useState('character');

  const [create, creating] = useAsyncAction(async () => {
    const record = await createSpriteRecord({
      name: name.trim(),
      kind,
      ...(id.trim() ? { id: id.trim() } : {}),
    }, { silent: true });
    setOpen(false);
    setName('');
    setId('');
    setKind('character');
    onCreated(record);
  }, { errorMessage: 'Failed to create sprite' });

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border hover:border-port-accent text-gray-300 rounded text-sm"
      >
        <Plus className="w-4 h-4" /> New Sprite
      </button>
      <Modal open={open} onClose={() => setOpen(false)} size="sm" ariaLabel="New sprite" closeOnBackdrop={false}>
        <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">New sprite</h3>
        <button onClick={() => setOpen(false)} aria-label="Close new sprite panel" className="text-gray-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
      </div>
      <div>
        <label htmlFor="sprite-new-kind" className="block text-xs text-gray-400 mb-1">Kind</label>
        <select
          id="sprite-new-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
        >
          {NEW_SPRITE_KINDS.map((k) => (
            <option key={k.value} value={k.value}>{k.label}</option>
          ))}
        </select>
        {kind !== 'character' && (
          <p className="mt-1 text-xs text-gray-600">
            Reference, walk, and publish workflows are character-only — a {kind} holds imported/uploaded assets.
          </p>
        )}
      </div>
      <div>
        <label htmlFor="sprite-new-name" className="block text-xs text-gray-400 mb-1">Name</label>
        <input
          id="sprite-new-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) create(); }}
          placeholder="Trail Hand"
          className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
        />
      </div>
      <div>
        <label htmlFor="sprite-new-id" className="block text-xs text-gray-400 mb-1">
          Id <span className="text-gray-600">(optional — derived from the name; required for names with no a–z/0–9 characters)</span>
        </label>
        <input
          id="sprite-new-id"
          type="text"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder="trail-hand"
          className="w-full bg-port-bg border border-port-border rounded px-3 py-1.5 text-sm text-white"
        />
      </div>
      <button
        onClick={create}
        disabled={creating || !name.trim()}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-accent hover:bg-blue-600 disabled:opacity-50 text-white rounded text-sm"
      >
        {creating ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
        Create
      </button>
        </div>
      </Modal>
    </>
  );
}

// Header autocomplete (#2932, reworked): a compact combobox that filters the
// library by name/id/kind and navigates on Enter/click. It lives in the page
// header rather than a sidebar, so it renders only the search field + its
// suggestion popover — full browsing lives in the Library catalog (the bare
// `/sprites` route), which scales past a scannable sidebar list.
function SpriteSearch({ records, onSelect }) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef(null);
  const inputId = 'sprite-search';
  const listId = 'sprite-search-listbox';

  const suggestions = useMemo(() => filterSpriteRecords(records, query), [records, query]);
  const showSuggestions = query.trim().length > 0;

  // Clicking outside dismisses the suggestion popover (clearing the query is the
  // same close path as Escape) instead of leaving a stale list floating open.
  const dismiss = useCallback(() => setQuery(''), []);
  useClickOutside(wrapRef, showSuggestions, dismiss);

  // A changed query invalidates the highlighted row's index.
  useEffect(() => { setActiveIndex(-1); }, [query]);

  const commit = (record) => {
    if (!record) return;
    onSelect(record.id);
    setQuery('');
    setActiveIndex(-1);
  };

  const onKeyDown = (e) => {
    if (!showSuggestions) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(activeIndex >= 0 ? suggestions[activeIndex] : suggestions[0]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
      setActiveIndex(-1);
    }
  };

  const activeId = activeIndex >= 0 && suggestions[activeIndex]
    ? `sprite-opt-${suggestions[activeIndex].id}` : undefined;

  return (
    <div ref={wrapRef} className="relative w-full sm:w-64">
      <label htmlFor={inputId} className="sr-only">Search sprites</label>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
      <input
        id={inputId}
        type="search"
        role="combobox"
        aria-expanded={showSuggestions}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search sprites…"
        className="w-full bg-port-bg border border-port-border rounded pl-8 pr-3 py-1.5 text-sm text-white"
      />
      {showSuggestions && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Matching sprites"
          className="absolute z-30 mt-1 w-full max-h-72 overflow-y-auto bg-port-card border border-port-border rounded-lg shadow-lg"
        >
          {suggestions.length === 0 ? (
            <li className="px-3 py-2 text-xs text-gray-500">No matches</li>
          ) : suggestions.map((r, i) => {
            const Icon = groupIconForKind(r.kind);
            return (
              <li key={r.id} id={`sprite-opt-${r.id}`} role="option" aria-selected={i === activeIndex}>
                <button
                  type="button"
                  onClick={() => commit(r)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`w-full flex items-center gap-2 text-left px-3 py-2 text-sm ${i === activeIndex ? 'bg-port-accent/20 text-white' : 'text-gray-300 hover:bg-port-bg'}`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0 text-gray-500" />
                  <span className="font-medium truncate">{r.name}</span>
                  <span className="ml-auto text-xs text-gray-500 shrink-0">{r.kind}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function Sprites() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [records, setRecords] = useState(null);
  const [detail, setDetail] = useState(null);
  // 'missing' (404 — record really doesn't exist) vs 'error' (transient/server
  // failure — the record may be fine, offer a retry instead of lying).
  const [detailState, setDetailState] = useState('idle');
  const [retryTick, setRetryTick] = useState(0);
  // Catalog card thumbnails: id → record-relative locked main-reference path.
  // Only characters with a frozen main reference have one; everything else
  // falls back to its group icon.
  const [thumbs, setThumbs] = useState(() => new Map());
  const goto = useCallback((rid) => navigate(`/sprites/${rid}`), [navigate]);

  const refresh = useCallback(() => {
    // request() already toasted; settle to an empty list so the header/catalog
    // don't spin forever.
    listSpriteRecords().then(setRecords).catch(() => setRecords([]));
  }, []);

  // Catalog thumbnails are only shown on the Library view (`!id`), and
  // listSpriteThumbnails is an O(records) disk scan — so fetch them when the
  // catalog is on screen, NOT from refresh() (which rides walk/reference render
  // polling on the detail page). Best-effort: a failed fetch just falls back to
  // icon placeholders. Re-runs whenever we return to the catalog, so a main
  // reference locked (or an asset added) on a detail page shows on the way back.
  useEffect(() => {
    if (id) return undefined;
    let stale = false;
    listSpriteThumbnails({ silent: true })
      .then((thumbList) => { if (!stale) setThumbs(new Map((thumbList || []).map((t) => [t.id, t.path]))); })
      .catch(() => {});
    return () => { stale = true; };
  }, [id]);

  // `/sprites` now lands on the Library catalog (the user's ask — no more
  // auto-opening the most recent sprite). Records are reached by picking a card
  // or the header search, both of which navigate to `/sprites/:id`.

  // Reactive list updates for record CRUD from the catalog — rename patches the
  // matching row (and the open detail, if it's the same record) in place;
  // delete drops it. No full refetch (project convention). The stale thumbs
  // entry needs no pruning — a deleted record is filtered out of `records`, so
  // no card renders for it and its thumbnail is never read again.
  const onRecordRenamed = useCallback((updated) => {
    setRecords((prev) => (prev || []).map((r) => (r.id === updated.id ? { ...r, ...updated } : r)));
    setDetail((prev) => (prev?.record?.id === updated.id
      ? { ...prev, record: { ...prev.record, ...updated } }
      : prev));
  }, []);
  const onRecordDeleted = useCallback((deletedId) => {
    setRecords((prev) => (prev || []).filter((r) => r.id !== deletedId));
    toast.success('Sprite deleted');
    // Deleting the sprite you're viewing drops you back to the catalog.
    if (id === deletedId) navigate('/sprites');
  }, [id, navigate]);

  // Stable identity — ReferenceWorkflow's poll effect depends on it, and an
  // inline arrow would tear down/recreate the interval every parent render.
  const onWorkflowChanged = useCallback(() => {
    refresh();
    setRetryTick((t) => t + 1);
  }, [refresh]);

  useEffect(() => { refresh(); }, [refresh]);

  // Same-id refetches (retryTick bumps from locks/renders/imports) keep the
  // current detail rendered — nulling it would unmount ReferenceWorkflow and
  // drop its in-flight render polling. Only an actual id switch clears.
  useEffect(() => {
    if (!id) { setDetail(null); setDetailState('idle'); return undefined; }
    let stale = false; // rapid A→B clicks: a late A response must not clobber B
    setDetail((prev) => (prev?.record?.id === id ? prev : null));
    setDetailState('loading');
    getSpriteRecord(id, { silent: true })
      .then((d) => { if (!stale) { setDetail(d); setDetailState('loaded'); } })
      .catch((err) => { if (!stale) setDetailState(err?.status === 404 || err?.status === 400 ? 'missing' : 'error'); });
    return () => { stale = true; };
  }, [id, retryTick]);

  // In-flight render tracking is owned HERE rather than inside each workflow
  // (#2931): the asset collection's Regenerate buttons fire the same two
  // endpoints the workflows do, so they must share one map — two hook
  // instances would each rehydrate independently and let a Regenerate in the
  // collection leave the workflow's Generate button enabled (a second paid
  // render for the same direction). Hooks can't be conditional, so both run
  // for every record and no-op on a null/props record.
  const walkRenders = useSpritePendingRenders({
    recordId: id || null,
    kind: 'video',
    tagKey: 'spriteWalk',
    tagField: 'direction',
    onChanged: onWorkflowChanged,
    sweepDelays: () => [1500, 8000],
    failMessage: (direction, job) => `Walk render failed for ${direction}: ${job?.error || 'see media jobs'}`,
  });
  const referenceRenders = useSpritePendingRenders({
    recordId: id || null,
    kind: 'image',
    tagKey: 'spriteRef',
    tagField: 'target',
    onChanged: onWorkflowChanged,
  });

  // Workspace tab (Library / Loop Trimmer) and the run the trimmer is open for
  // live in the URL (#2933) so the active workspace is deep-linkable
  // (`?spriteTab=trimmer&run=<runId>`) — the same "URL is the source of truth
  // for what's open" rule the rest of the app follows. Switching records via
  // navigate() drops the search entirely, resetting the tab to Library.
  const [searchParams, setSearchParams] = useSearchParams();
  const [spriteTab, setSpriteTab] = useDrawerTab('spriteTab', 'library', ['library', 'trimmer']);
  const trimRunParam = searchParams.get('run');
  // Open the trimmer deep-linked to a run. `replace` keeps an in-trimmer source
  // switch out of history; the default push lets Back return to the Library.
  const openTrimmer = useCallback((runId, { replace = false } = {}) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('spriteTab', 'trimmer');
      if (runId) next.set('run', runId); else next.delete('run');
      return next;
    }, replace ? { replace: true } : undefined);
  }, [setSearchParams]);

  // Clip length lives here rather than inside WalkWorkflow so a Regenerate
  // fired from an asset card honors the length the user picked in the walk
  // panel instead of silently falling back to the server default.
  const [duration, setDuration] = useState(WALK_DURATIONS[0]);

  // Image-backend availability + the selected backend `mode` are page-owned
  // (#2938): both ReferenceWorkflow's picker and the asset collection's anchor
  // Regenerate must read ONE mode, or a card re-roll would use a different
  // backend than the one the user picked in the workflow. `null` = settings not
  // loaded yet; `[]` = loaded with no image backend configured.
  const [imageBackends, setImageBackends] = useState(null);
  const [imageMode, setImageMode] = useState('');
  useEffect(() => {
    getSettings({ silent: true })
      .then((settings) => {
        const available = deriveAvailableBackends(settings, { excludeExternal: true });
        setImageBackends(available);
        // Prefer the configured dispatcher default when it's available, else
        // the first list entry — matching ReferenceWorkflow's prior logic.
        const configured = available.find((b) => b.id === settings?.imageGen?.mode)?.id;
        setImageMode((m) => m || configured || available[0]?.id || '');
      })
      .catch(() => setImageBackends([]));
  }, []);
  const hasImageBackend = Array.isArray(imageBackends) && imageBackends.length > 0;

  // Run ids the walk selection has approved. An approved run's strip/frames
  // never move on disk (approval is recorded in the selection, not the path),
  // so the pure path classifier still reads them as `candidate` — the asset
  // collection promotes them to `approved` for their badge from this set.
  const approvedRunIds = useMemo(() => {
    const set = new Set();
    const collect = (dirs) => {
      for (const d of Object.values(dirs || {})) {
        if (d?.status === 'approved' && d.runId) set.add(d.runId);
      }
    };
    collect(detail?.walk?.selection?.directions);
    collect(detail?.walk?.walkSet?.directions);
    return set;
  }, [detail]);

  // Both generators share the reserve → submit → resolve/cancel dance; only
  // the endpoint, its args, and the fail message differ. The hook's setters
  // are stable identities, so depending on THEM (not the whole render-tracking
  // object, which is a fresh literal each render) keeps the memoized action
  // closures below from rebuilding every render.
  const { beginSubmit: walkBegin, resolveSubmit: walkResolve, cancelSubmit: walkCancel } = walkRenders;
  const { beginSubmit: refBegin, resolveSubmit: refResolve, cancelSubmit: refCancel } = referenceRenders;
  // Since the render-tracking hook is now page-owned and survives a record
  // switch (it clears its map on switch), a submit started for record A that
  // resolves AFTER navigating to B would otherwise land A's jobId in B's map
  // (a spurious "Rendering…" on a direction B isn't rendering). Capture the
  // record the submit belongs to and skip resolve/cancel if we've moved on —
  // the switch already wiped A's sentinel, so there's nothing to clean up.
  const idRef = useRef(id);
  useEffect(() => { idRef.current = id; }, [id]);
  const submitRender = useCallback(async (begin, resolve, cancel, key, call, failMessage) => {
    const startId = idRef.current;
    begin(key);
    try {
      const { jobId } = await call();
      if (idRef.current === startId) resolve(key, jobId);
    } catch (err) {
      if (idRef.current === startId) cancel(key);
      toast.error(err?.message || failMessage);
    }
  }, []);

  const generateWalk = useCallback((direction) => submitRender(
    walkBegin, walkResolve, walkCancel, direction,
    () => generateSpriteWalk(id, { direction, duration }, { silent: true }),
    `Failed to queue ${direction} walk`,
  ), [id, duration, walkBegin, walkResolve, walkCancel, submitRender]);

  // `mode` is the workflow-selected backend, threaded from the asset card via
  // buildCollectionActions (#2938) so a re-roll uses the same backend the
  // Reference workflow would, not the server default. Falls back to the
  // page-level selection when a caller omits it.
  const generateAnchor = useCallback((direction, mode) => submitRender(
    refBegin, refResolve, refCancel, direction,
    () => generateSpriteReference(id, {
      target: direction, ...((mode || imageMode) ? { mode: mode || imageMode } : {}),
    }, { silent: true }),
    `Failed to queue ${direction} render`,
  ), [id, imageMode, refBegin, refResolve, refCancel, submitRender]);

  const collectionActions = useMemo(() => {
    if (detail?.record?.kind !== 'character') return null;
    return buildCollectionActions({
      detail,
      walkPending: walkRenders.pendingJobs,
      referencePending: referenceRenders.pendingJobs,
      generateWalk,
      generateAnchor,
      hasBackend: hasImageBackend,
      mode: imageMode,
      // "Edit in Loop Trimmer" from an asset card now switches to the trimmer
      // workspace deep-linked to the run, instead of scrolling to an inline panel.
      onRequestTrim: (runId) => openTrimmer(runId),
    });
  }, [detail, walkRenders.pendingJobs, referenceRenders.pendingJobs, generateWalk, generateAnchor, hasImageBackend, imageMode, openTrimmer]);

  return (
    <div className="space-y-4">
      {/* Header owns identity (left) plus every library-wide control (right):
          a "Library" link back to the catalog (only while a sprite is open),
          search, and the create/import actions — no left sidebar, so the
          catalog/detail pane below runs full width. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3 mr-auto">
          <PersonStanding className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Sprite Manager</h1>
        </div>
        {id && (
          <button
            type="button"
            onClick={() => navigate('/sprites')}
            className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border hover:border-port-accent text-gray-300 rounded text-sm"
          >
            <LayoutGrid className="w-4 h-4" /> Library
          </button>
        )}
        {records?.length > 0 && <SpriteSearch records={records} onSelect={goto} />}
        <NewSpritePanel onCreated={(record) => { refresh(); navigate(`/sprites/${record.id}`); }} />
        {/* Re-import while a sprite is open must refresh the open detail too,
            not just the library list. */}
        <ImportPanel onImported={() => { refresh(); if (id) setRetryTick((t) => t + 1); }} />
      </div>
      <div>
        <section className="min-w-0">
          {!id ? (
            // The bare /sprites route IS the Library catalog now.
            records === null ? (
              <p className="text-sm text-gray-500">Loading…</p>
            ) : records.length === 0 ? (
              <p className="text-sm text-gray-500">
                No sprites yet. Import a production set from a sprite-pipeline checkout to get started.
              </p>
            ) : (
              <SpriteCatalog
                records={records}
                thumbs={thumbs}
                onOpen={goto}
                onRenamed={onRecordRenamed}
                onDeleted={onRecordDeleted}
              />
            )
          ) : detailState === 'missing' ? (
            <div className="text-sm text-gray-400">
              Sprite not found.{' '}
              <button onClick={() => navigate('/sprites')} className="text-port-accent hover:underline">Back to the library</button>
            </div>
          ) : detailState === 'error' ? (
            <div className="text-sm text-gray-400">
              Failed to load this sprite.{' '}
              <button onClick={() => setRetryTick((t) => t + 1)} className="text-port-accent hover:underline">Retry</button>
            </div>
          ) : !detail ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : (
            <div className="space-y-4">
              <SpriteDetailHeader
                record={detail.record}
                onRenamed={onRecordRenamed}
                onDeleted={onRecordDeleted}
              />
              {/* Assets / Loop Trimmer workspaces (#2933). The trimmer is
                  character-only (it trims packaged walk runs), so non-character
                  records skip the tab bar and always show their asset library.
                  The tab id stays 'library' so existing `?spriteTab=library`
                  deep links keep working; only its label reads "Assets" now
                  that "Library" means the top-level catalog. */}
              {detail.record.kind === 'character' && (
                <TabPills
                  variant="pills"
                  size="sm"
                  mobileDropdown
                  mobileSelectId="sprite-workspace-tab"
                  ariaLabel="Sprite workspace"
                  tabs={[
                    { id: 'library', label: 'Assets', icon: Images },
                    { id: 'trimmer', label: 'Loop Trimmer', icon: Scissors },
                  ]}
                  activeTab={spriteTab}
                  onChange={setSpriteTab}
                />
              )}
              {detail.record.kind === 'character' && spriteTab === 'trimmer' ? (
                <LoopTrimmer
                  record={detail.record}
                  walk={detail.walk}
                  assets={detail.assets}
                  runId={trimRunParam}
                  onSelectRun={(runId) => openTrimmer(runId, { replace: true })}
                  onSaved={onWorkflowChanged}
                />
              ) : (
                <>
                  {detail.record.kind === 'character' && (
                    <>
                      <ReferenceWorkflow
                        record={detail.record}
                        reference={detail.reference}
                        renders={referenceRenders}
                        backends={imageBackends}
                        mode={imageMode}
                        onModeChange={setImageMode}
                        onChanged={onWorkflowChanged}
                        onForked={(rec) => { refresh(); navigate(`/sprites/${rec.id}`); }}
                      />
                      <WalkWorkflow
                        record={detail.record}
                        reference={detail.reference}
                        walk={detail.walk}
                        renders={walkRenders}
                        duration={duration}
                        onDurationChange={setDuration}
                        onGenerate={generateWalk}
                        onOpenTrimmer={openTrimmer}
                        onChanged={onWorkflowChanged}
                      />
                      {/* Keyed by record so form state and an armed publish/overwrite
                          confirmation never survive switching characters. */}
                      <PublishWorkflow
                        key={detail.record.id}
                        record={detail.record}
                        walk={detail.walk}
                        atlas={detail.atlas}
                        onChanged={onWorkflowChanged}
                      />
                    </>
                  )}
                  {detail.assets.length === 0 ? (
                    <p className="text-sm text-gray-500">No assets on disk for this record.</p>
                  ) : (
                    <AssetCollection
                      recordId={detail.record.id}
                      assets={detail.assets}
                      actions={collectionActions}
                      approvedRunIds={approvedRunIds}
                      onDeleted={onWorkflowChanged}
                    />
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

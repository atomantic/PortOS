import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { PersonStanding, MapPin, Package, Download, X, RefreshCw, Plus, LayoutGrid, Search, Images, Scissors } from 'lucide-react';
import toast from '../components/ui/Toast';
import Modal from '../components/ui/Modal.jsx';
import {
  listSpriteRecords, getSpriteRecord, importSprites, createSpriteRecord,
  generateSpriteWalk, generateSpriteReference,
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
import TabPills from '../components/ui/TabPills.jsx';
import useDrawerTab from '../hooks/useDrawerTab.js';
import useClickOutside from '../hooks/useClickOutside.js';
import { useAsyncAction } from '../hooks/useAsyncAction.js';
import { useSpritePendingRenders } from '../hooks/useSpritePendingRenders.js';
import { buildCollectionActions } from '../lib/spriteCollectionActions.js';
import {
  groupSpriteRecords, filterSpriteRecords, groupKeyForKind, NEW_SPRITE_KINDS,
} from '../lib/spriteRecordGroups.js';
import { timeAgo } from '../utils/formatters.js';

// Per-group sidebar icons — the pure grouping lib keys each group; the page
// owns the lucide component mapping so the lib stays React-free.
const GROUP_ICONS = { characters: PersonStanding, places: MapPin, objects: Package };

// Landing on /sprites with no id auto-opens the most recently touched sprite so
// the manager is never a cold empty pane (the user's ask). Prefer characters —
// the reference/walk/publish workflows are character-only, so that's the sprite
// someone most likely wants in front of them — and only fall back to the newest
// record of any kind when the library holds no characters. `updatedAt` is bumped
// on every create/patch/import; `createdAt` is the floor for a never-patched
// record. A record missing both sorts to 0 rather than NaN-poisoning the reduce.
function pickMostRecentSprite(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const ts = (r) => Date.parse(r?.updatedAt || r?.createdAt || '') || 0;
  const characters = records.filter((r) => r.kind === 'character');
  const pool = characters.length ? characters : records;
  return pool.reduce((best, r) => (ts(r) > ts(best) ? r : best), pool[0]);
}

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
// suggestion popover — full browsing moved to the Catalog modal below, because
// the library is expected to grow well past a scannable sidebar list.
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
            const Icon = GROUP_ICONS[groupKeyForKind(r.kind)] || Package;
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

// Full-library catalog viewer. Replaces the old "Browse all" sidebar disclosure
// (which didn't scale) with a searchable, grouped grid of every sprite. Picking
// a card navigates to it and closes — this is how the user swaps the active
// sprite when they don't remember its name to type into the header search.
function CatalogModal({ open, onClose, records, selectedId, onSelect }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => filterSpriteRecords(records, query), [records, query]);
  const groups = useMemo(() => groupSpriteRecords(filtered), [filtered]);

  // The caller mounts this only while open (`{catalogOpen && <CatalogModal/>}`),
  // so a fresh mount already starts with an empty filter — no stale-query reset
  // needed, and the filter/group memos never run while the catalog is closed.
  return (
    <Modal open={open} onClose={onClose} size="3xl" ariaLabel="Sprite catalog" align="top">
      <div className="bg-port-card border border-port-border rounded-lg flex flex-col max-h-[85vh]">
        <header className="flex items-center gap-3 px-4 py-3 border-b border-port-border shrink-0">
          <LayoutGrid className="w-5 h-5 text-port-accent shrink-0" />
          <h2 className="text-base font-semibold text-white">Sprite Catalog</h2>
          <span className="text-xs text-gray-500">{records.length} total</span>
          <div className="relative ml-auto w-40 sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <label htmlFor="sprite-catalog-search" className="sr-only">Filter catalog</label>
            <input
              id="sprite-catalog-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              className="w-full bg-port-bg border border-port-border rounded pl-8 pr-3 py-1.5 text-sm text-white"
            />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close catalog"
            className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-port-border/50 shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 space-y-5">
          {filtered.length === 0 ? (
            <p className="text-sm text-gray-500">No sprites match “{query}”.</p>
          ) : groups.map((g) => {
            const Icon = GROUP_ICONS[g.key] || Package;
            return (
              <div key={g.key}>
                <h3 className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-gray-500 mb-2">
                  <Icon className="w-3.5 h-3.5" /> {g.label} ({g.records.length})
                </h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {g.records.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => { onSelect(r.id); onClose(); }}
                      aria-current={selectedId === r.id}
                      className={`text-left p-3 rounded-lg border transition-colors ${selectedId === r.id ? 'bg-port-accent/20 border-port-accent text-white' : 'bg-port-bg border-port-border text-gray-300 hover:border-gray-500'}`}
                    >
                      <span className="block font-medium truncate">{r.name}</span>
                      <span className="block text-xs text-gray-500 truncate">
                        {r.kind} · {r.status}
                        {r.chromaKey ? ` · key ${r.chromaKey}` : ''}
                      </span>
                      <span className="block text-xs text-gray-600 mt-0.5">
                        {r.updatedAt || r.createdAt ? `updated ${timeAgo(r.updatedAt || r.createdAt)}` : ''}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Modal>
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
  const [catalogOpen, setCatalogOpen] = useState(false);
  const goto = useCallback((rid) => navigate(`/sprites/${rid}`), [navigate]);

  const refresh = useCallback(() => {
    // request() already toasted; settle to an empty list so the header/catalog
    // don't spin forever.
    listSpriteRecords().then(setRecords).catch(() => setRecords([]));
  }, []);

  // Landing on the bare /sprites route auto-opens the most recent sprite so the
  // manager never presents a cold empty pane (the user's ask). Only fires when
  // there's no id AND the library is non-empty; `replace` keeps the redirect out
  // of history so Back doesn't bounce between /sprites and the sprite. An
  // invalid :id lands in the 'missing' state below, not here, so no loop.
  useEffect(() => {
    if (id || !Array.isArray(records) || records.length === 0) return;
    const recent = pickMostRecentSprite(records);
    if (recent) navigate(`/sprites/${recent.id}`, { replace: true });
  }, [id, records, navigate]);

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
          search, the Catalog viewer, and the create/import actions — no left
          sidebar, so the detail pane below runs full width. */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3 mr-auto">
          <PersonStanding className="w-6 h-6 text-port-accent" />
          <h1 className="text-2xl font-bold text-white">Sprite Manager</h1>
        </div>
        {records?.length > 0 && (
          <>
            <SpriteSearch records={records} onSelect={goto} />
            <button
              type="button"
              onClick={() => setCatalogOpen(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border hover:border-port-accent text-gray-300 rounded text-sm"
            >
              <LayoutGrid className="w-4 h-4" /> Catalog
            </button>
          </>
        )}
        <NewSpritePanel onCreated={(record) => { refresh(); navigate(`/sprites/${record.id}`); }} />
        {/* Re-import while a sprite is open must refresh the open detail too,
            not just the library list. */}
        <ImportPanel onImported={() => { refresh(); if (id) setRetryTick((t) => t + 1); }} />
      </div>
      {/* Mounted only while open so its filter/group memos never run behind a
          closed modal (and a fresh mount starts with an empty filter). */}
      {catalogOpen && (
        <CatalogModal
          open
          onClose={() => setCatalogOpen(false)}
          records={records || []}
          selectedId={id}
          onSelect={goto}
        />
      )}
      <div>
        <section className="min-w-0">
          {!id ? (
            // No id yet: loading the list, an empty library, or the one-frame
            // gap before the auto-redirect effect opens the most recent sprite.
            records === null ? (
              <p className="text-sm text-gray-500">Loading…</p>
            ) : records.length === 0 ? (
              <p className="text-sm text-gray-500">
                No sprites yet. Import a production set from a sprite-pipeline checkout to get started.
              </p>
            ) : (
              <p className="text-sm text-gray-500">Opening the most recent sprite…</p>
            )
          ) : detailState === 'missing' ? (
            <div className="text-sm text-gray-400">
              Sprite not found.{' '}
              <button onClick={() => setCatalogOpen(true)} className="text-port-accent hover:underline">Browse the catalog</button>
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
              <div>
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  {(() => {
                    const Icon = GROUP_ICONS[groupKeyForKind(detail.record.kind)] || Package;
                    return <Icon className="w-5 h-5" />;
                  })()}
                  {detail.record.name}
                </h2>
                <p className="text-xs text-gray-500">
                  {detail.record.kind} · {detail.record.status}
                  {detail.record.chromaKey && (
                    <>
                      {' · chroma key '}
                      <span className="inline-block w-3 h-3 rounded-sm align-middle border border-port-border" style={{ backgroundColor: detail.record.chromaKey }} />{' '}
                      {detail.record.chromaKey}
                    </>
                  )}
                  {detail.record.importedFrom?.importedAt && ` · imported ${timeAgo(detail.record.importedFrom.importedAt)}`}
                </p>
                {detail.record.spec?.archetype && (
                  <p className="text-xs text-gray-500">archetype: {detail.record.spec.archetype}</p>
                )}
              </div>
              {/* Library / Loop Trimmer workspaces (#2933). The trimmer is
                  character-only (it trims packaged walk runs), so non-character
                  records skip the tab bar and always show their asset library. */}
              {detail.record.kind === 'character' && (
                <TabPills
                  variant="pills"
                  size="sm"
                  mobileDropdown
                  mobileSelectId="sprite-workspace-tab"
                  ariaLabel="Sprite workspace"
                  tabs={[
                    { id: 'library', label: 'Library', icon: Images },
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

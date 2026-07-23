import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PersonStanding, Package, Download, X, RefreshCw, Plus } from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  listSpriteRecords, getSpriteRecord, importSprites, createSpriteRecord,
  generateSpriteWalk, generateSpriteReference,
} from '../services/apiSprites.js';
import { getApps } from '../services/apiApps.js';
import AppContextPicker from '../components/AppContextPicker.jsx';
import ReferenceWorkflow from '../components/sprites/ReferenceWorkflow.jsx';
import WalkWorkflow, { WALK_WORKFLOW_DOM_ID, WALK_DURATIONS } from '../components/sprites/WalkWorkflow.jsx';
import PublishWorkflow from '../components/sprites/PublishWorkflow.jsx';
import AssetCollection from '../components/sprites/AssetCollection.jsx';
import { useAsyncAction } from '../hooks/useAsyncAction.js';
import { useSpritePendingRenders } from '../hooks/useSpritePendingRenders.js';
import { buildCollectionActions } from '../lib/spriteCollectionActions.js';
import { timeAgo } from '../utils/formatters.js';

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

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-accent hover:bg-blue-600 text-white rounded text-sm"
      >
        <Download className="w-4 h-4" /> Import
      </button>
    );
  }

  return (
    <div className="w-full bg-port-card border border-port-border rounded-lg p-4 space-y-3">
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
  );
}

function NewCharacterPanel({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [id, setId] = useState('');

  const [create, creating] = useAsyncAction(async () => {
    const record = await createSpriteRecord({
      name: name.trim(),
      ...(id.trim() ? { id: id.trim() } : {}),
    }, { silent: true });
    setOpen(false);
    setName('');
    setId('');
    onCreated(record);
  }, { errorMessage: 'Failed to create character' });

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border hover:border-port-accent text-gray-300 rounded text-sm"
      >
        <Plus className="w-4 h-4" /> New Character
      </button>
    );
  }

  return (
    <div className="w-full bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">New character</h3>
        <button onClick={() => setOpen(false)} aria-label="Close new character panel" className="text-gray-400 hover:text-white">
          <X className="w-4 h-4" />
        </button>
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
  );
}

function RecordSection({ title, icon: Icon, items, selectedId, onSelect }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h3 className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-gray-500 mb-1.5">
        <Icon className="w-3.5 h-3.5" /> {title}
      </h3>
      <ul className="space-y-1">
        {items.map((r) => (
          <li key={r.id}>
            <button
              onClick={() => onSelect(r.id)}
              className={`w-full text-left px-3 py-2 rounded text-sm ${selectedId === r.id ? 'bg-port-accent/20 text-white border border-port-accent' : 'bg-port-card text-gray-300 border border-port-border hover:border-gray-500'}`}
            >
              <span className="font-medium">{r.name}</span>
              <span className="block text-xs text-gray-500">{r.status}{r.chromaKey ? ` · key ${r.chromaKey}` : ''}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RecordList({ records, selectedId, onSelect }) {
  return (
    <div className="space-y-4">
      <RecordSection title="Characters" icon={PersonStanding} items={records.filter((r) => r.kind === 'character')} selectedId={selectedId} onSelect={onSelect} />
      <RecordSection title="Props" icon={Package} items={records.filter((r) => r.kind !== 'character')} selectedId={selectedId} onSelect={onSelect} />
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

  const refresh = useCallback(() => {
    // request() already toasted; settle to an empty list so the sidebar
    // doesn't spin forever.
    listSpriteRecords().then(setRecords).catch(() => setRecords([]));
  }, []);

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

  // Which run the Loop Trimmer panel is open for. Phase 5 (#2933) turns this
  // into a `?spriteTab=trimmer&run=<id>` deep link; until then it routes the
  // collection's request into WalkWorkflow's existing inline TrimPanel so
  // there is still exactly one trim UI.
  const [trimRunId, setTrimRunId] = useState(null);
  useEffect(() => setTrimRunId(null), [id]);

  // Clip length lives here rather than inside WalkWorkflow so a Regenerate
  // fired from an asset card honors the length the user picked in the walk
  // panel instead of silently falling back to the server default.
  const [duration, setDuration] = useState(WALK_DURATIONS[0]);

  // Both generators share the reserve → submit → resolve/cancel dance; only
  // the endpoint, its args, and the fail message differ. The hook's setters
  // are stable identities, so depending on THEM (not the whole render-tracking
  // object, which is a fresh literal each render) keeps the memoized action
  // closures below from rebuilding every render.
  const { beginSubmit: walkBegin, resolveSubmit: walkResolve, cancelSubmit: walkCancel } = walkRenders;
  const { beginSubmit: refBegin, resolveSubmit: refResolve, cancelSubmit: refCancel } = referenceRenders;
  const submitRender = useCallback(async (begin, resolve, cancel, key, call, failMessage) => {
    begin(key);
    try {
      const { jobId } = await call();
      resolve(key, jobId);
    } catch (err) {
      cancel(key);
      toast.error(err?.message || failMessage);
    }
  }, []);

  const generateWalk = useCallback((direction) => submitRender(
    walkBegin, walkResolve, walkCancel, direction,
    () => generateSpriteWalk(id, { direction, duration }, { silent: true }),
    `Failed to queue ${direction} walk`,
  ), [id, duration, walkBegin, walkResolve, walkCancel, submitRender]);

  const generateAnchor = useCallback((direction) => submitRender(
    refBegin, refResolve, refCancel, direction,
    // The server falls back to the install's configured image backend — the
    // asset-card path deliberately doesn't thread ReferenceWorkflow's backend
    // picker (that state lives in the workflow); a re-roll uses the default.
    () => generateSpriteReference(id, { target: direction }, { silent: true }),
    `Failed to queue ${direction} render`,
  ), [id, refBegin, refResolve, refCancel, submitRender]);

  const collectionActions = useMemo(() => {
    if (detail?.record?.kind !== 'character') return null;
    return buildCollectionActions({
      detail,
      walkPending: walkRenders.pendingJobs,
      referencePending: referenceRenders.pendingJobs,
      generateWalk,
      generateAnchor,
      onRequestTrim: (runId) => {
        setTrimRunId(runId);
        // The trimmer lives inside WalkWorkflow further up the page; a request
        // from an asset card near the bottom must bring it into view or the
        // click looks like it did nothing.
        document.getElementById(WALK_WORKFLOW_DOM_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    });
  }, [detail, walkRenders.pendingJobs, referenceRenders.pendingJobs, generateWalk, generateAnchor]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <PersonStanding className="w-6 h-6 text-port-accent" />
        <h1 className="text-2xl font-bold text-white">Sprite Manager</h1>
      </div>
      <div className="flex flex-col md:flex-row gap-4">
        <aside className="md:w-64 shrink-0 space-y-3">
          <NewCharacterPanel onCreated={(record) => { refresh(); navigate(`/sprites/${record.id}`); }} />
          {/* Re-import while a sprite is open must refresh the open detail too,
              not just the sidebar list. */}
          <ImportPanel onImported={() => { refresh(); if (id) setRetryTick((t) => t + 1); }} />
          {records === null ? (
            <p className="text-sm text-gray-500">Loading…</p>
          ) : records.length === 0 ? (
            <p className="text-sm text-gray-500">
              No sprites yet. Import a production set from a sprite-pipeline checkout to get started.
            </p>
          ) : (
            <RecordList records={records} selectedId={id} onSelect={(rid) => navigate(`/sprites/${rid}`)} />
          )}
        </aside>
        <section className="flex-1 min-w-0">
          {!id ? (
            <p className="text-sm text-gray-500">Select a sprite to browse its reference set, animation strips, and atlases.</p>
          ) : detailState === 'missing' ? (
            <div className="text-sm text-gray-400">
              Sprite not found.{' '}
              <button onClick={() => navigate('/sprites')} className="text-port-accent hover:underline">Back to library</button>
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
                  {detail.record.kind === 'character' ? <PersonStanding className="w-5 h-5" /> : <Package className="w-5 h-5" />}
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
              {detail.record.kind === 'character' && (
                <>
                  <ReferenceWorkflow
                    record={detail.record}
                    reference={detail.reference}
                    renders={referenceRenders}
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
                    trimRunId={trimRunId}
                    onTrimClose={() => setTrimRunId(null)}
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
                />
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

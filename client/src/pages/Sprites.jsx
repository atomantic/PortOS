import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import { PersonStanding, LayoutGrid, Images, Scissors, Film } from 'lucide-react';
import PageSkeleton from '../components/ui/PageSkeleton';
import toast from '../components/ui/Toast';
import {
  listSpriteRecords, getSpriteRecord,
  generateSpriteWalk, generateSpriteTrack, generateSpriteReference, listSpriteThumbnails,
} from '../services/apiSprites.js';
import { getSettings } from '../services/apiSystem.js';
import { deriveAvailableBackends, renderPinLadder } from '../lib/imageGenBackends.js';
import ReferenceWorkflow from '../components/sprites/ReferenceWorkflow.jsx';
import WalkWorkflow from '../components/sprites/WalkWorkflow.jsx';
import TrackWorkflow from '../components/sprites/TrackWorkflow.jsx';
import AmbientWorkflow from '../components/sprites/AmbientWorkflow.jsx';
import AnimationTypesDrawer from '../components/sprites/AnimationTypesDrawer.jsx';
import { GROK_VIDEO_DEFAULT_DURATION } from '../lib/grokVideoClip.js';
import LoopTrimmer from '../components/sprites/LoopTrimmer.jsx';
import PublishWorkflow from '../components/sprites/PublishWorkflow.jsx';
import AssetCollection from '../components/sprites/AssetCollection.jsx';
import {
  correctionPromptPayload, anchorCorrectionKey, walkCorrectionKey,
  AMBIENT_REFERENCE_CORRECTION_KEY,
} from '../components/sprites/CorrectionNote.jsx';
import SpriteCatalog from '../components/sprites/SpriteCatalog.jsx';
import SpriteDetailHeader from '../components/sprites/SpriteDetailHeader.jsx';
import ImportPanel from '../components/sprites/ImportPanel.jsx';
import NewSpritePanel from '../components/sprites/NewSpritePanel.jsx';
import SpriteSearch from '../components/sprites/SpriteSearch.jsx';
import TabPills from '../components/ui/TabPills.jsx';
import useDrawerTab from '../hooks/useDrawerTab.js';
import { useSpritePendingRenders } from '../hooks/useSpritePendingRenders.js';
import { buildCollectionActions } from '../lib/spriteCollectionActions.js';

// Sprite Manager: library over imported production sprites — characters
// (reference sets, walk strips, runtime atlases) and props atlas families —
// plus the source-tree importer (#2895), the phase-2 reference workflow
// (create a character, generate + freeze the main reference, derive + lock
// the 8 directional anchors — #2896), and the phase-3 walk workflow (one
// grok i2v clip per anchor, deterministic packaging, per-direction approval
// into the finalized walk set — #2897). Publish lands in phase 4.

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

  // Correction guidance for EVERY regeneration surface is page-owned (#2964,
  // extended to the main reference and every animation track's surfaces by
  // #3134) so a workflow panel and the asset-collection Regenerate button
  // read/write ONE source: a correction typed on either surface applies to the
  // other AND rides along as `correctionPrompt` on whichever re-roll fires.
  // Keys are namespaced PER SURFACE by `lib/spriteCorrections.js` — anchors keep
  // the bare direction, everything else prefixes — so an anchor's still-image
  // note can't leak into that direction's walk video. Every key is identical
  // across characters, so reset on record switch to keep a leftover note from
  // bleeding into the next sprite (the reset ReferenceWorkflow used to own
  // before the state was lifted).
  const [corrections, setCorrections] = useState({});
  useEffect(() => { setCorrections({}); }, [id]);

  // Workspace tab (Library / Loop Trimmer) and the run the trimmer is open for
  // live in the URL (#2933) so the active workspace is deep-linkable
  // (`?spriteTab=trimmer&run=<runId>`) — the same "URL is the source of truth
  // for what's open" rule the rest of the app follows. Switching records via
  // navigate() drops the search entirely, resetting the tab to Library.
  const [searchParams, setSearchParams] = useSearchParams();
  const [spriteTab, setSpriteTab] = useDrawerTab('spriteTab', 'library', ['library', 'trimmer']);
  const trimRunParam = searchParams.get('run');
  // The animation-types drawer (#3153) is library-wide, not per-record, so its
  // open state lives in its own search param — deep-linkable per the "URL is the
  // source of truth for what's open" rule, and independent of `spriteTab`/`run`.
  const animationTypesOpen = searchParams.get('animationTypes') === '1';
  const setAnimationTypesOpen = useCallback((next) => {
    setSearchParams((prev) => {
      const params = new URLSearchParams(prev);
      if (next) params.set('animationTypes', '1');
      else params.delete('animationTypes');
      return params;
    });
  }, [setSearchParams]);
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

  // Clip length is a per-render choice (how much source footage grok gives the
  // packer) and stays page state so a Regenerate fired from an asset card honors
  // what the user picked in the walk panel. Frame count + preview fps are NOT
  // sent at all: they are pinned per walk SET on the server (#2985), and an
  // omitted geometry adopts that target. Echoing the client's copy back would
  // only add a staleness window — `detail` trails the server by one refetch, so
  // a render fired right after a target change would 409 against a value the UI
  // is no longer showing.
  const [duration, setDuration] = useState(GROK_VIDEO_DEFAULT_DURATION);

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

  // Seed the page-owned backend picker from an opened record's persisted
  // render pin (#3231 Phase 3) — but only when that backend is actually
  // available, so a pinned-but-since-disabled backend degrades to the server
  // ladder's graceful fallback instead of being sent as an explicit (and
  // erroring) body.mode. Unpinned records keep the current page mode.
  // `imageBackends || []` rather than `imageBackends`: `renderPinLadder` reads
  // `null` as "availability unknown, don't gate", but this seat is a one-way
  // seed into page state — a pin applied before the backend list lands would
  // stick even if that backend turns out to be disabled. The effect re-runs
  // once `imageBackends` loads, so gating on the loaded list loses nothing.
  const detailPinMode = detail?.record?.imageMode || '';
  const detailRecordId = detail?.record?.id || '';
  const seedPinMode = useMemo(
    () => renderPinLadder([{ imageMode: detailPinMode }], imageBackends || []).mode,
    [detailPinMode, imageBackends],
  );
  useEffect(() => {
    if (seedPinMode) setImageMode(seedPinMode);
  }, [seedPinMode, detailRecordId]);

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
    // Every non-walk track's approvals, keyed by track id (#3136) — so a
    // user-defined track's approved runs badge correctly with nothing added here.
    for (const state of Object.values(detail?.tracks || {})) {
      collect(state?.selection?.directions);
      collect(state?.set?.directions);
    }
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
  const submitRender = useCallback(async (begin, resolve, cancel, key, call, failMessage, onSuccess) => {
    const startId = idRef.current;
    begin(key);
    try {
      // Anchor renders go through the media-job queue (jobId); the walk render
      // is an observable grok-tui run (runId, no media job). Either reserves
      // the key so a double-submit can't fire two paid renders.
      const result = await call();
      if (idRef.current === startId) { resolve(key, result?.jobId || result?.runId); onSuccess?.(); }
    } catch (err) {
      if (idRef.current === startId) cancel(key);
      toast.error(err?.message || failMessage);
    }
  }, []);

  // The direction's walk-scoped correction (#3134) rides along, read from the
  // SAME page-owned map both WalkWorkflow's card and the asset-collection walk
  // card write — so a note typed on either surface applies to whichever
  // Generate the user clicks. The key is walk-namespaced, so an anchor
  // (still-image) note can never leak into the video prompt.
  const generateWalk = useCallback((direction) => submitRender(
    walkBegin, walkResolve, walkCancel, direction,
    () => generateSpriteWalk(id, {
      direction,
      duration,
      ...correctionPromptPayload(corrections, walkCorrectionKey(direction)),
    }, { silent: true }),
    `Failed to queue ${direction} walk`,
    // Refetch immediately so the server's 'rendering' run lands before the
    // media-job poll evicts the optimistic key (~4s) — otherwise the Generate
    // button briefly re-enables and a second click would 409 the in-flight
    // render. The server guard is the real backstop; this closes the UI gap.
    onWorkflowChanged,
  ), [id, duration, corrections, walkBegin, walkResolve, walkCancel, submitRender, onWorkflowChanged]);

  // ONE submit path for every non-walk track (#3136) — the track id is a
  // parameter, so a user-defined track needs no new handler here.
  //
  // Kept separate from `generateWalk` for the same reason the scanner clone was:
  // each track has its own server-side in-flight guard and its own finalized set,
  // so a track render must not occupy the walk direction's optimistic
  // reservation (both can legitimately be authored at once), and each owns its
  // short default source clip rather than inheriting the walk duration picker.
  // The immediate refetch persists the observable TUI run for polling.
  // The caller supplies both the request `direction` (present only for a
  // directional track) and the `correctionKey` for the card that was clicked —
  // TrackWorkflow already holds the definition and the facing, so deciding both
  // there keeps this handler dependency-light and therefore stable across the 4s
  // detail poll, which replaces `detail` wholesale and would otherwise churn
  // every memoized track section.
  const generateTrack = useCallback(async (trackId, { direction, correctionKey }) => {
    try {
      await generateSpriteTrack(id, trackId, {
        ...(direction ? { direction } : {}),
        ...correctionPromptPayload(corrections, correctionKey),
      }, { silent: true });
      onWorkflowChanged();
    } catch (err) {
      toast.error(err?.message || `Failed to queue the ${trackId} render`);
    }
  }, [id, corrections, onWorkflowChanged]);

  // The ambient main takes BOTH inputs: `designPrompt` replaces the design
  // outright, while the correction (#3134) keeps it and fixes one thing about
  // the last render.
  const generateAmbientReference = useCallback((designPrompt) => submitRender(
    refBegin, refResolve, refCancel, 'main',
    () => generateSpriteReference(id, {
      target: 'main', designPrompt,
      ...(imageMode ? { mode: imageMode } : {}),
      ...correctionPromptPayload(corrections, AMBIENT_REFERENCE_CORRECTION_KEY),
    }, { silent: true }),
    'Failed to queue ambient reference',
    onWorkflowChanged,
  ), [id, imageMode, corrections, refBegin, refResolve, refCancel, submitRender, onWorkflowChanged]);

  // One section per non-walk track this record's kind carries (#3136), rendered
  // in registry order from the server's keyed `tracks` payload. The list is DATA,
  // so a user-defined track appears here without a page edit — which is the
  // client-side half of "an animation type is a row, not a code path". Keyed by
  // track id so switching records can't carry one track's card state into
  // another's.
  const trackSections = useMemo(() => Object.entries(detail?.tracks || {}).map(([trackId, state]) => (
    <TrackWorkflow
      key={trackId}
      record={detail.record}
      reference={detail.reference}
      state={state}
      onGenerate={generateTrack}
      onChanged={onWorkflowChanged}
      corrections={corrections}
      onCorrectionChange={setCorrections}
    />
  )), [detail?.tracks, detail?.record, detail?.reference, generateTrack, onWorkflowChanged, corrections]);


  // `mode` is the workflow-selected backend, threaded from the asset card via
  // buildCollectionActions (#2938) so a re-roll uses the same backend the
  // Reference workflow would, not the server default. Falls back to the
  // page-level selection when a caller omits it. The direction's shared
  // correction (#2964) rides along as `correctionPrompt` via the same
  // `correctionPromptPayload` fragment the ReferenceWorkflow anchor re-roll
  // uses, so the asset-card re-roll sends byte-identical guidance.
  const generateAnchor = useCallback((direction, mode) => submitRender(
    refBegin, refResolve, refCancel, direction,
    () => generateSpriteReference(id, {
      target: direction,
      ...((mode || imageMode) ? { mode: mode || imageMode } : {}),
      ...correctionPromptPayload(corrections, anchorCorrectionKey(direction)),
    }, { silent: true }),
    `Failed to queue ${direction} render`,
  ), [id, imageMode, corrections, refBegin, refResolve, refCancel, submitRender]);

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
        {/* Library-wide, so it sits beside create/import and is reachable from
            the bare /sprites catalog as well as an open record. */}
        <button
          type="button"
          onClick={() => setAnimationTypesOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 bg-port-card border border-port-border hover:border-port-accent text-gray-300 rounded text-sm"
        >
          <Film className="w-4 h-4" /> Animation types
        </button>
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
              <PageSkeleton
                header="none"
                label="Loading sprite library"
                layout="grid"
                cards={10}
                gridColsClass="grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
              />
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
            <PageSkeleton header="none" label="Loading sprite" cards={3} sidebar={false} />
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
                        corrections={corrections}
                        onCorrectionChange={setCorrections}
                        backends={imageBackends}
                        trackDefinitions={detail.trackDefinitions}
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
                        corrections={corrections}
                        onCorrectionChange={setCorrections}
                      />
                      {trackSections}
                      {/* Keyed by record so form state and an armed publish/overwrite
                          confirmation never survive switching characters. */}
                      <PublishWorkflow
                        key={detail.record.id}
                        record={detail.record}
                        walk={detail.walk}
                        tracks={detail.tracks}
                        trackDefinitions={detail.trackDefinitions}
                        atlas={detail.atlas}
                        onChanged={onWorkflowChanged}
                      />
                    </>
                  )}
                  {detail.record.kind !== 'character' && (
                    <>
                      <AmbientWorkflow
                        record={detail.record}
                        reference={detail.reference}
                        renders={referenceRenders}
                        hasBackend={hasImageBackend}
                        mode={imageMode}
                        onGenerateReference={generateAmbientReference}
                        onChanged={onWorkflowChanged}
                        corrections={corrections}
                        onCorrectionChange={setCorrections}
                      />
                      {trackSections}
                      <PublishWorkflow
                        key={detail.record.id}
                        record={detail.record}
                        walk={detail.walk}
                        tracks={detail.tracks}
                        trackDefinitions={detail.trackDefinitions}
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
                      corrections={corrections}
                      onCorrectionChange={setCorrections}
                      onDeleted={onWorkflowChanged}
                    />
                  )}
                </>
              )}
            </div>
          )}
        </section>
      </div>
      {/* Rendered last so the slide-in panel layers over the catalog/detail pane.
          A newly-authored type only reaches an OPEN record's workflow list on the
          next detail fetch — so refetch when the drawer reports a change, and skip
          the (recursive-readdir) detail fetch entirely on a peek-and-close. */}
      <AnimationTypesDrawer
        open={animationTypesOpen}
        onClose={(changed) => {
          setAnimationTypesOpen(false);
          if (changed && id) setRetryTick((t) => t + 1);
        }}
      />
    </div>
  );
}

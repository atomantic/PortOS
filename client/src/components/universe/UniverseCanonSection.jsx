/**
 * Embeddable canon UI for a universe — Characters / Places / Objects with
 * extract-from-prose, AI differentiate, per-entry lock + refine + render.
 *
 * Lives inside UniverseBuilder (Phase 2 of Universe-as-Canon) so canon and
 * the template live on one page. Reads the universe from the parent (which
 * owns the editable draft) and writes back via `onUniverseChange(updated)` so
 * canon mutations don't clobber pending edits to logline/premise/etc.
 *
 * The series filter is URL-driven (`?series=<id>`) so deep-links restore the
 * filtered view. The dropdown only appears when ≥2 series reference this
 * universe's canon.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Library, Loader2, Users, MapPin, Package, Wand2, Filter, Lock, Unlock, ImagePlus, Sparkles, Plus,
} from 'lucide-react';
import toast from '../ui/Toast';
import IngredientPicker from '../IngredientPicker';
import VisionDescribeModal from './VisionDescribeModal';
import { linkCatalogIngredient } from '../../services/apiCatalog';
import {
  extractUniverseCanon,
  refineUniverseCharacter,
  differentiateUniverseCast,
  updateUniverse,
  getUniverseCanonUsage,
  setUniverseCanonLock,
  setUniverseCanonLockAll,
  expandUniverseCharacter,
} from '../../services/apiUniverseBuilder';
import { generateImage } from '../../services/apiSystem';
import { composeStyledPrompt, composeCanonStyledPrompt } from '../../lib/composeStyledPrompt';
import { composeCleanPlatePrompt } from '../../lib/cleanPlatePrompt';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import useMounted from '../../hooks/useMounted';
import { useCanonPatch } from '../../hooks/useCanonPatch';
import CanonCard from '../pipeline/CanonCard';
import { pipelineImageCfgToRenderOpts } from '../../lib/pipelineImageDefaults';
import { buildUniverseSectionRenderTag } from '../../lib/universeRunTag';
import { universeStylePreset } from '../../lib/universeStylePreset';
import { descriptorForCanonEntry } from '../../lib/canonPrompt';
import { applySheetPointer } from '../../lib/sheetPointers';
import { BIBLE_LIMITS, capImageRefs } from '../../lib/bibleLimits';

// A universe's canon list for a kind is sometimes absent on a freshly-created
// record; normalize to [] so callers can spread/map without a guard each time.
const getKindList = (u, kindKey) => (Array.isArray(u?.[kindKey]) ? u[kindKey] : []);

// Build an embedded canon entry from a picked catalog ingredient. The
// ingredient's `payload` already carries the same field names the universe
// canon sanitizer whitelists (name / physicalDescription / description / …),
// so we spread it and overlay the canonical name + the durable `ingredientId`
// stamp that ties this embedded entry back to its catalog row.
//
// `id` is intentionally omitted — the server's `ensureId` mints a fresh
// kind-prefixed id (`chr-`/`plc-`/`obj-`) on save. We must NOT carry the
// catalog id into `entry.id`; identity lives in `ingredientId` so the
// peer-reconciliation backfill (`migrateBibleToCatalog`) recreates the same
// catalog row id on every peer instead of minting a divergent one.
export function buildCanonEntryFromIngredient(ingredient) {
  if (!ingredient || typeof ingredient !== 'object') return null;
  const payload = (ingredient.payload && typeof ingredient.payload === 'object')
    ? ingredient.payload
    : {};
  const entry = { ...payload };
  // Strip any id/timestamps the payload may carry from its origin record so
  // the server mints fresh ones and doesn't collide with an existing entry.
  delete entry.id;
  delete entry.createdAt;
  delete entry.updatedAt;
  entry.name = String(ingredient.name || payload.name || '').trim() || 'Untitled';
  entry.ingredientId = ingredient.id;
  return entry;
}

// `descField` is the writable field bound to the inline description editor in
// `CanonCard`. `descFor` (used for the render prompt + the read-only fallback
// view) prefers the primary then the legacy/sibling field — so for characters
// the editor writes `physicalDescription` while `descFor` still surfaces any
// pre-migration `description` value until the user re-saves.
const KINDS = [
  {
    key: 'characters', apiKind: 'character', label: 'Characters', singular: 'character', icon: Users,
    descFor: (c) => descriptorForCanonEntry('characters', c),
    descField: 'physicalDescription', descFieldFallback: 'description', descFieldMax: BIBLE_LIMITS.PHYSICAL_DESCRIPTION_MAX,
  },
  {
    key: 'places', apiKind: 'place', label: 'Places', singular: 'place', icon: MapPin,
    descFor: (p) => descriptorForCanonEntry('places', p),
    descField: 'description', descFieldMax: BIBLE_LIMITS.PLACE_DESCRIPTION_MAX,
  },
  {
    key: 'objects', apiKind: 'object', label: 'Objects', singular: 'object', icon: Package,
    descFor: (o) => descriptorForCanonEntry('objects', o),
    descField: 'description', descFieldFallback: 'significance', descFieldMax: BIBLE_LIMITS.OBJECT_DESCRIPTION_MAX,
  },
];

export default function UniverseCanonSection({
  universe, universeId, onUniverseChange, imageCfg, kindFilter = null,
  // entryId → jobId head-map from the universe-page-level pending tracker.
  // Lets canon rows show a MediaJobThumb spinner when a batch `/render` queues
  // canon prompts (the batch path doesn't flow through `renderingJobs` here,
  // which is populated only by this section's own per-entry render calls).
  externalPendingByEntryId = null,
  // Fired when a batch-rendered canon job settles so the parent can shift its
  // completed jobId out of the page-level pending queue. Without this, the
  // queue accumulates completed jobIds forever and a follow-up batch render
  // would show the previous run's image instead of the new spinner.
  onExternalCanonJobSettled = null,
  // Thumbnail click handler: `(filename, { isSheet? }) => void`. The parent
  // (UniverseBuilder) owns the lightbox so every page surface shares one
  // MediaPreview instance with the full action set + sidecar-hydrated prompt.
  // When null (defensive — should always be supplied) clicks no-op.
  onPreview = null,
}) {
  const mountedRef = useMounted();
  const [searchParams, setSearchParams] = useSearchParams();
  const seriesFilter = searchParams.get('series') || '';
  const [renderingJobs, setRenderingJobs] = useState({});
  const [refiningId, setRefiningId] = useState(null);
  const [expandingId, setExpandingId] = useState(null);
  const [differentiating, setDifferentiating] = useState(false);
  const [togglingLockId, setTogglingLockId] = useState(null);
  // Ref mirrors togglingLockId for the reentrancy guard so handleToggleLock
  // keeps a stable identity across lock toggles — otherwise it would change
  // every time togglingLockId flips, re-rendering every KindSection + card.
  const togglingLockRef = useRef(null);
  const [extractText, setExtractText] = useState('');
  const [extractOpen, setExtractOpen] = useState(false);
  // Which kind's "Pick from Catalog" modal is open (a KINDS entry, or null).
  const [catalogPickerKind, setCatalogPickerKind] = useState(null);
  // `{ kind, entry }` when the vision "Describe from image(s)" modal is open.
  const [describeTarget, setDescribeTarget] = useState(null);
  const [catalogLinking, setCatalogLinking] = useState(false);
  // Ingredient ids already embedded in the open kind's canon list — passed to
  // the picker so it hides already-linked rows. Only recomputed when the open
  // kind or the universe changes (not on every render).
  const catalogExcludeIds = useMemo(
    () => (catalogPickerKind
      ? getKindList(universe, catalogPickerKind.key).map((e) => e?.ingredientId).filter(Boolean)
      : []),
    [catalogPickerKind, universe],
  );
  // Per-canon-entry usage map: `{ characters: { [entryId]: [{seriesId, seriesName, issueCount, ...}] }, ... }`.
  // Loaded lazily — usage is a derived view and shouldn't block the initial
  // paint. Refetched after mutations that change the canon shape (extract /
  // differentiate-cast) so new entries get usage.
  const [usage, setUsage] = useState(null);

  // Lazy usage fetch. Captured `requestedFor` is checked against the live
  // `currentUniverseIdRef` so a slow response from a previous universe can't
  // repopulate `usage` with stale data after fast navigation.
  const currentUniverseIdRef = useRef(universeId);
  useEffect(() => { currentUniverseIdRef.current = universeId; }, [universeId]);

  // Latest-universe ref so callbacks fired after async waits (e.g. the
  // sheet panel's HEAD-poll for the rendered file) merge against the
  // CURRENT draft instead of a snapshot captured at callback-creation
  // time. Without this, a concurrent character edit landing during the
  // poll window would be clobbered by the stale `universe` closure.
  const latestUniverseRef = useRef(universe);
  useEffect(() => { latestUniverseRef.current = universe; }, [universe]);
  const refreshUsage = useCallback(() => {
    if (!universeId) return;
    const requestedFor = universeId;
    getUniverseCanonUsage(requestedFor)
      .then((u) => {
        if (!mountedRef.current) return;
        if (currentUniverseIdRef.current !== requestedFor) return;
        setUsage(u);
      })
      .catch(() => { /* non-fatal; cards just render without usage footer */ });
  }, [universeId, mountedRef]);
  useEffect(() => { refreshUsage(); }, [refreshUsage]);

  // Series-with-usage options for the filter dropdown. Derived from the
  // usage map rather than a fresh API call so the dropdown only lists
  // series that actually reference this universe's canon.
  const seriesOptions = useMemo(() => {
    if (!usage) return [];
    const seen = new Map();
    for (const kind of KINDS) {
      const perEntry = usage[kind.key] || {};
      for (const list of Object.values(perEntry)) {
        for (const row of (list || [])) {
          if (row?.seriesId && !seen.has(row.seriesId)) {
            seen.set(row.seriesId, row.seriesName || row.seriesId);
          }
        }
      }
    }
    return [...seen.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [usage]);

  // Drop a stale `?series=` param when usage resolves and the series isn't
  // in this universe. Reset per-universe so cross-universe nav re-validates.
  const validatedRef = useRef(false);
  useEffect(() => {
    validatedRef.current = false;
    setUsage(null);
  }, [universeId]);
  useEffect(() => {
    if (!usage || validatedRef.current) return;
    validatedRef.current = true;
    if (seriesFilter && !seriesOptions.some((s) => s.id === seriesFilter)) {
      const next = new URLSearchParams(searchParams);
      next.delete('series');
      setSearchParams(next, { replace: true });
    }
  }, [usage, seriesFilter, seriesOptions, searchParams, setSearchParams]);

  const handleSeriesFilterChange = useCallback((value) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('series', value);
    else next.delete('series');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const filteredByKind = useMemo(() => {
    if (!universe) return {};
    const out = {};
    for (const kind of KINDS) {
      const all = Array.isArray(universe[kind.key]) ? universe[kind.key] : [];
      if (!seriesFilter || !usage) { out[kind.key] = all; continue; }
      const perEntry = usage[kind.key] || {};
      out[kind.key] = all.filter((entry) => {
        const rows = perEntry[entry.id] || [];
        return rows.some((r) => r.seriesId === seriesFilter);
      });
    }
    return out;
  }, [universe, usage, seriesFilter]);

  // Thumbnail click → bubbles to the parent's `onPreview(filename, opts)` so
  // the page-level MediaPreview opens the unified lightbox (full action set,
  // sidecar-hydrated prompt). `isSheet` is forwarded so the parent can route
  // reference-sheet clicks through the `/data/image-refs/` static prefix
  // instead of `/data/images/`.
  const openPreview = useCallback((filename, opts) => {
    if (!filename || typeof onPreview !== 'function') return;
    onPreview(filename, opts);
  }, [onPreview]);

  const [runExtract, extracting] = useAsyncAction(
    () => extractUniverseCanon(universeId, { corpus: extractText.trim() }, { silent: true }),
    { errorMessage: 'Extraction failed' },
  );

  // Drop late responses that arrive after the user has switched universes —
  // otherwise universe A's refine/extract result would land in universe B's
  // draft. The component stays mounted across selectedId changes (only the
  // `universe` prop swaps), so mountedRef alone isn't sufficient.
  const isStillCurrent = (capturedId) => mountedRef.current && currentUniverseIdRef.current === capturedId;

  const handleExtract = async () => {
    if (!extractText.trim()) {
      toast.error('Paste prose into the textarea first');
      return;
    }
    const capturedId = universeId;
    const result = await runExtract();
    if (!result || !isStillCurrent(capturedId)) return;
    onUniverseChange(result.universe);
    refreshUsage();
    const counts = KINDS
      .map((k) => `${result.universe[k.key]?.length ?? 0} ${k.label.toLowerCase()}`)
      .join(', ');
    toast.success(`Canon updated — ${counts}`);
    setExtractText('');
    setExtractOpen(false);
  };

  const handleDifferentiate = async () => {
    if (!universe || differentiating) return;
    setDifferentiating(true);
    const capturedId = universeId;
    const providerId = universe.llm?.provider || undefined;
    const model = universe.llm?.model || undefined;
    const result = await differentiateUniverseCast(universeId, { providerId, model }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Differentiate failed'); return null; });
    if (mountedRef.current) setDifferentiating(false);
    if (!result || !isStillCurrent(capturedId)) return;
    onUniverseChange(result.universe);
    toast.success(`Differentiated ${result.touched}/${result.touched + result.skipped} characters — ${(result.rationale || '').slice(0, 140)}`);
  };

  // Track which kind has a bulk-lock in flight so we can disable its buttons
  // and show a spinner. Keyed by `kind.key` (characters / places / objects)
  // because the action is scoped to that section.
  const [bulkLockingKindKey, setBulkLockingKindKey] = useState(null);

  const handleBulkLockKind = useCallback(async (kind, nextLocked) => {
    if (bulkLockingKindKey) return;
    setBulkLockingKindKey(kind.key);
    const capturedId = universeId;
    const result = await setUniverseCanonLockAll(universeId, kind.apiKind, nextLocked, { silent: true })
      .catch((err) => { toast.error(err.message || `Bulk ${nextLocked ? 'lock' : 'unlock'} failed`); return null; });
    if (mountedRef.current) setBulkLockingKindKey(null);
    if (!result || !mountedRef.current || currentUniverseIdRef.current !== capturedId) return;
    if (result.universe) onUniverseChange(result.universe);
    if (result.changed === 0) {
      toast.success(`All ${kind.label.toLowerCase()} already ${nextLocked ? 'locked' : 'unlocked'}`);
    } else {
      toast.success(`${nextLocked ? 'Locked' : 'Unlocked'} ${result.changed} ${kind.label.toLowerCase()}`);
    }
  }, [universeId, onUniverseChange, mountedRef, bulkLockingKindKey]);

  const handleToggleLock = useCallback(async (kind, entryId, nextLocked) => {
    if (togglingLockRef.current) return;
    togglingLockRef.current = entryId;
    setTogglingLockId(entryId);
    const capturedId = universeId;
    const result = await setUniverseCanonLock(universeId, kind.apiKind, entryId, nextLocked, { silent: true })
      .catch((err) => { toast.error(err.message || 'Lock toggle failed'); return null; });
    togglingLockRef.current = null;
    if (mountedRef.current) setTogglingLockId(null);
    if (!result || !mountedRef.current || currentUniverseIdRef.current !== capturedId) return;
    onUniverseChange(result.universe);
    toast.success(`${result.entry?.name || 'Entry'} ${nextLocked ? 'locked' : 'unlocked'}`);
  }, [universeId, onUniverseChange, mountedRef]);

  const handleRefineCharacter = async (entryId) => {
    if (!universe || refiningId) return;
    setRefiningId(entryId);
    const capturedId = universeId;
    const providerId = universe.llm?.provider || undefined;
    const model = universe.llm?.model || undefined;
    const result = await refineUniverseCharacter(universeId, entryId, { providerId, model }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Refine failed'); return null; });
    if (mountedRef.current) setRefiningId(null);
    if (!result || !isStillCurrent(capturedId)) return;
    onUniverseChange(result.universe);
    toast.success(`Refined — ${(result.rationale || result.changes?.[0] || 'description rewritten').slice(0, 140)}`);
  };

  // One LLM call fleshes out the extended character fields (motivations,
  // stats, color palette, expressions, etc.). No-clobber on populated fields.
  // Locked characters return `{ locked: true }` so the toast surfaces the
  // reason rather than a successful no-op.
  const handleExpandCharacter = async (entryId) => {
    if (!universe || expandingId) return;
    setExpandingId(entryId);
    const capturedId = universeId;
    const providerId = universe.llm?.provider || undefined;
    const model = universe.llm?.model || undefined;
    const result = await expandUniverseCharacter(universeId, entryId, { providerId, model }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Expand failed'); return null; });
    if (mountedRef.current) setExpandingId(null);
    if (!result || !isStillCurrent(capturedId)) return;
    if (result.locked) {
      toast.error(`${result.entry?.name || 'Character'} is locked — unlock before expanding`);
      return;
    }
    if (result.universe) onUniverseChange(result.universe);
    const fields = Array.isArray(result.updatedFields) ? result.updatedFields : [];
    toast.success(fields.length
      ? `Expanded ${result.entry?.name || 'character'} — filled ${fields.length} field${fields.length === 1 ? '' : 's'}`
      : `${result.entry?.name || 'Character'} already complete — nothing to fill`);
  };

  // Server already stamped the character via mediaJobEvents — merge the
  // filename into the local draft instead of refetching the whole universe.
  // Read from `latestUniverseRef` (not closed-over `universe`) so an edit
  // that landed during the panel's HEAD-poll wait isn't clobbered by an
  // older snapshot. No deps on `universe` keeps the callback stable.
  const handleSheetCompleted = useCallback((entryId, destFilename, variant) => {
    const latest = latestUniverseRef.current;
    if (!latest || !destFilename) return;
    const nextCharacters = (latest.characters || []).map((c) =>
      c.id === entryId ? applySheetPointer(c, variant, destFilename) : c,
    );
    onUniverseChange({ ...latest, characters: nextCharacters });
    const entryName = nextCharacters.find((c) => c.id === entryId)?.name || 'Character';
    toast.success(`${entryName} reference sheet ready`);
  }, [onUniverseChange]);

  const handleSheetDeleted = useCallback((entryId, variant) => {
    const latest = latestUniverseRef.current;
    if (!latest) return;
    const nextCharacters = (latest.characters || []).map((c) =>
      c.id === entryId ? applySheetPointer(c, variant, null) : c,
    );
    onUniverseChange({ ...latest, characters: nextCharacters });
  }, [onUniverseChange]);

  const handleRenderRef = async (kind, entry) => {
    const description = kind.descFor(entry);
    if (!description.trim()) {
      toast.error(`Add a description before generating a reference for ${entry.name}`);
      return;
    }
    const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
    const styled = composeCanonStyledPrompt({
      name: entry.name,
      description,
      universe,
      baseNegative: baseOpts.negativePrompt,
    });
    const universeRun = buildUniverseSectionRenderTag(universe, kind.key, entry);
    const queued = await generateImage({
      ...baseOpts,
      prompt: styled.prompt,
      negativePrompt: styled.negativePrompt || undefined,
      ...(universeRun ? { universeRun } : {}),
    }, { silent: true }).catch((err) => { toast.error(err.message || 'Render failed'); return null; });
    if (!queued?.jobId || !mountedRef.current) return;
    setRenderingJobs((prev) => ({ ...prev, [entry.id]: queued.jobId }));
    toast.success(`Rendering reference for ${entry.name}`);
  };

  // Render All — fires `handleRenderRef` for every entry in the kind that
  // (a) has a non-blank descFor() prompt and (b) doesn't already carry an
  // image ref. Already-rendered entries are intentionally skipped so the
  // button is the one-shot "fill in the holes" affordance; users can still
  // re-render an individual entry from its row.
  // Parallel kickoff is safe — `renderingJobs[entry.id]` is keyed per entry
  // and the queue handler clears each independently on completion.
  const [renderAllKindKey, setRenderAllKindKey] = useState(null);
  const handleRenderAll = async (kind) => {
    const entries = Array.isArray(universe?.[kind.key]) ? universe[kind.key] : [];
    const candidates = entries.filter((e) =>
      kind.descFor(e).trim()
      && !(Array.isArray(e.imageRefs) && e.imageRefs.length > 0)
    );
    if (candidates.length === 0) {
      toast.error(`No ${kind.label.toLowerCase()} need a reference render`);
      return;
    }
    setRenderAllKindKey(kind.key);
    try {
      // Sequential await isn't necessary for correctness, but it keeps the
      // first toast from racing the spinner-state writes for many entries
      // at once. `generateImage` returns as soon as the job is queued.
      await Promise.all(candidates.map((entry) => handleRenderRef(kind, entry)));
      toast.success(`Queued ${candidates.length} reference render${candidates.length === 1 ? '' : 's'}`);
    } finally {
      if (mountedRef.current) setRenderAllKindKey(null);
    }
  };

  const handleRenderCleanPlate = async (kind, entry) => {
    // Match CanonCard's button-enable predicate (descFor includes palette +
    // recurringDetails for places) — composeCleanPlatePrompt builds a valid
    // prompt from any of {description, palette, recurringDetails}, so gating
    // on `description` alone produces a button that fails with this toast
    // even though the composer would have succeeded.
    const hasContent = !!(entry?.description?.trim() || entry?.palette?.trim() || entry?.recurringDetails?.trim());
    if (!hasContent) {
      toast.error(`Add a description, palette, or recurring details before generating a clean plate for ${entry.name}`);
      return;
    }
    const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
    const plate = composeCleanPlatePrompt(entry, baseOpts.negativePrompt || '');
    // Layer the universe style on top of the clean-plate composition so the
    // empty-location render shares the visual language of the populated refs.
    const styled = composeStyledPrompt(
      plate.prompt,
      plate.negativePrompt,
      universe ? universeStylePreset(universe) : null,
    );
    const universeRun = buildUniverseSectionRenderTag(universe, kind.key, entry);
    const queued = await generateImage({
      ...baseOpts,
      prompt: styled.prompt,
      negativePrompt: styled.negativePrompt || undefined,
      ...(universeRun ? { universeRun } : {}),
    }, { silent: true }).catch((err) => { toast.error(err.message || 'Clean plate render failed'); return null; });
    if (!queued?.jobId || !mountedRef.current) return;
    setRenderingJobs((prev) => ({ ...prev, [entry.id]: queued.jobId }));
    toast.success(`Rendering clean plate for ${entry.name}`);
  };

  // Optimistically stamp a completed render's filename onto a canon entry's
  // `imageRefs[]` in the parent draft. Used by BOTH section-local and external
  // batch completions, because as of #1395 BOTH are persisted server-side by
  // the `appendEntryImageRef` completion hook — so the client never PATCHes
  // here; it only mirrors the durable write into the visible draft for an
  // immediate refresh. Notes:
  // (a) the server hook is the source of truth, so a client `updateUniverse`
  //     would be redundant and could clobber concurrent sibling appends with a
  //     stale full-array patch.
  // (b) `latestUniverseRef` (not the closed-over `universe` prop) is read so
  //     back-to-back sibling completions all see the freshest state and chain
  //     their appends instead of clobbering each other.
  // (c) dedupe on `includes` so a duplicate completion event (or the optimistic
  //     path racing the hook) doesn't double-stamp the same ref; `capImageRefs`
  //     mirrors the server-side last-N cap.
  const applyOptimisticCanonRef = useCallback((kindKey, entryId, filename) => {
    if (!filename) return;
    const latest = latestUniverseRef.current;
    if (!latest) return;
    const list = Array.isArray(latest[kindKey]) ? latest[kindKey] : [];
    const nextList = list.map((e) => {
      if (e?.id !== entryId) return e;
      const refs = Array.isArray(e.imageRefs) ? e.imageRefs : [];
      if (refs.includes(filename)) return e;
      return { ...e, imageRefs: capImageRefs([...refs, filename]) };
    });
    onUniverseChange({ ...latest, [kindKey]: nextList });
  }, [onUniverseChange]);

  // Section-local renders now carry a durable `universeRun.entryRef` tag
  // (buildUniverseSectionRenderTag), so the server-side `appendEntryImageRef` hook
  // persists the new filename even if this page unmounts mid-render — the
  // client just clears the spinner and mirrors the ref into the draft (no
  // PATCH). The durable hook is idempotent against this optimistic stamp.
  const handleRefCompleted = useCallback((kindKey, entryId, filename) => {
    setRenderingJobs((prev) => {
      if (!prev[entryId]) return prev;
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    applyOptimisticCanonRef(kindKey, entryId, filename);
  }, [applyOptimisticCanonRef]);

  // External (batch-render) canon completions share the same optimistic-only
  // path: the server collection hook already stamped the persisted record, so
  // the client only updates the parent draft.
  const handleExternalCanonRefCompleted = applyOptimisticCanonRef;

  const handleRefFailed = useCallback((entryId, errMsg) => {
    setRenderingJobs((prev) => {
      if (!prev[entryId]) return prev;
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    if (errMsg) toast.error(`Render failed: ${errMsg}`);
  }, []);

  // "Pick from Catalog" → copy a shared catalog ingredient into this universe
  // as a new embedded canon entry and link the ingredient back to the universe
  // via catalog_ingredient_refs (role `canon-<kind>`). The embedded entry
  // carries the catalog id as `ingredientId` so the two records stay tied and
  // peer-reconciliation preserves the same id on every peer.
  const handlePickFromCatalog = useCallback(async (kind, ingredient) => {
    const picked = Array.isArray(ingredient) ? ingredient[0] : ingredient;
    if (!picked || !universe || catalogLinking) return;
    const kindKey = kind.key;
    const list = getKindList(universe, kindKey);
    // Dedup by ingredientId — re-picking an already-linked ingredient is a
    // no-op (mirrors the server-side canon name dedup, but keyed on the
    // durable ingredient identity so renames don't slip a duplicate in).
    if (list.some((e) => e?.ingredientId && e.ingredientId === picked.id)) {
      toast.error(`${picked.name || 'Ingredient'} is already in this universe`);
      setCatalogPickerKind(null);
      return;
    }
    const entry = buildCanonEntryFromIngredient(picked);
    if (!entry) return;
    setCatalogLinking(true);
    setCatalogPickerKind(null);
    const capturedId = universeId;
    const nextList = [...list, entry];
    // Optimistic append so the new row shows immediately; the server response
    // (with the minted entry id) replaces it.
    onUniverseChange({ ...universe, [kindKey]: nextList });
    // `{ silent: true }` because the .catch below owns the error toast — without
    // it the apiCore request() helper would fire a second, duplicate toast.
    const updated = await updateUniverse(universeId, { [kindKey]: nextList }, { silent: true })
      .catch((err) => { toast.error(`Add from Catalog failed: ${err.message}`); return null; });
    if (!updated) {
      // Revert the optimistic append — the save didn't land, so the phantom
      // row must not linger. `list` is the pre-append snapshot from this
      // closure (canon edits are user-driven one-at-a-time, so it's current).
      if (mountedRef.current && currentUniverseIdRef.current === capturedId) {
        onUniverseChange({ ...universe, [kindKey]: list });
      }
      if (mountedRef.current) setCatalogLinking(false);
      return;
    }
    if (mountedRef.current && currentUniverseIdRef.current === capturedId) onUniverseChange(updated);
    // Link the catalog ingredient back to the universe so the "Appears in"
    // panel populates. Non-fatal: the embedded entry already carries the
    // ingredientId, so a failed link still keeps the records tied.
    await linkCatalogIngredient(
      picked.id,
      { refKind: 'universe', refId: universeId, role: `canon-${kind.apiKind}` },
      { silent: true },
    ).catch((err) => { toast.error(`Linked entry, but catalog ref failed: ${err.message}`); });
    if (mountedRef.current) setCatalogLinking(false);
    toast.success(`Added ${picked.name || 'ingredient'} from Catalog`);
  }, [universe, universeId, onUniverseChange, mountedRef, catalogLinking]);

  // Manual "Add" — mint a blank canon entry from a name the user types (and an
  // optional description), mirroring the optimistic-append-then-persist shape
  // of `handlePickFromCatalog`. The entry carries no `id` (the server's
  // `ensureId` mints a kind-prefixed one) and `locked: false` so the card's
  // inline editors are usable immediately without a separate unlock click —
  // the user explicitly created it to fill in, so the lock-by-default contract
  // (which guards AI-extracted/-arriving entries) doesn't apply here.
  const [creatingKindKey, setCreatingKindKey] = useState(null);
  const handleCreateEntry = useCallback(async (kind, { name, description }) => {
    const trimmedName = String(name || '').trim();
    if (!trimmedName || !universe || creatingKindKey) return false;
    const kindKey = kind.key;
    const list = getKindList(universe, kindKey);
    // Dedup by normalized name so a manual add of an existing entry is a clear
    // no-op. This client guard is the ONLY name-dedup on the wholesale-PATCH
    // path: updateUniverse re-runs sanitizeBibleList, which sanitizes per-entry
    // but does not merge by name (only the extract path's mergeExtractedBible
    // dedups), so without this two same-named entries would both persist.
    if (list.some((e) => String(e?.name || '').trim().toLowerCase() === trimmedName.toLowerCase())) {
      toast.error(`${trimmedName} is already in this universe`);
      return false;
    }
    const entry = { name: trimmedName, locked: false };
    const desc = String(description || '').trim();
    if (desc && kind.descField) entry[kind.descField] = desc;
    setCreatingKindKey(kindKey);
    const capturedId = universeId;
    const nextList = [...list, entry];
    // Optimistic append so the new card shows immediately; the server response
    // (with the minted entry id) replaces it.
    onUniverseChange({ ...universe, [kindKey]: nextList });
    // `{ silent: true }` because the .catch below owns the error toast.
    const updated = await updateUniverse(universeId, { [kindKey]: nextList }, { silent: true })
      .catch((err) => { toast.error(`Add ${kind.singular} failed: ${err.message}`); return null; });
    const stillCurrent = mountedRef.current && currentUniverseIdRef.current === capturedId;
    if (!updated) {
      // Revert the optimistic append — the save didn't land. `list` is the
      // pre-append snapshot (canon edits are user-driven one-at-a-time).
      if (stillCurrent) onUniverseChange({ ...universe, [kindKey]: list });
    } else if (stillCurrent) {
      onUniverseChange(updated);
    }
    if (mountedRef.current) setCreatingKindKey(null);
    if (updated) toast.success(`Added ${trimmedName}`);
    return !!updated;
  }, [universe, universeId, onUniverseChange, mountedRef, creatingKindKey]);

  // Inline-edit channel for canon fields the user types/picks directly
  // (setting intExt + timeOfDay chips, primaryImageRef pinning, wardrobe
  // edits). Optimistic — UI updates before the server roundtrip so chip
  // clicks feel instant.
  const { patchEntry: handlePatchEntry } = useCanonPatch({
    universe, apply: onUniverseChange, mountedRef,
  });

  if (!universe) return null;

  const charCount = (universe.characters || []).length;

  return (
    // `id="canon"` is the scroll target for `/universes/:id#canon`
    // deep-links (legacy `/canon` route redirect + PipelineSeries "Manage
    // characters, places, and objects" link). Keep this id stable.
    <section id="canon" className="bg-port-card border border-port-border rounded p-4 flex flex-col gap-3 scroll-mt-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-sm font-semibold text-white">
            {kindFilter ? (KINDS.find((k) => k.key === kindFilter)?.label || 'Canon') : 'Canon'}
          </h2>
          <p className="text-xs text-gray-500 mt-0.5">
            {kindFilter === 'characters' && 'Recurring people in this universe. Series share the same canon — issues reference these entries so a character renders consistently across crossovers.'}
            {kindFilter === 'places' && 'Recurring places in this universe. Series share the same canon — slugline-anchored entries can be referenced across issues.'}
            {kindFilter === 'objects' && 'Recurring objects/items in this universe. Series share the same canon — issues reference these entries for visual continuity.'}
            {!kindFilter && 'People, places, and things that exist in this universe. Series in this universe share the same canon — episodes/issues reference these entries so a character renders consistently across crossovers.'}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {seriesOptions.length > 1 ? (
            <label className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded bg-port-bg border border-port-border text-gray-300 text-xs">
              <Filter size={12} className="text-gray-500" />
              <span className="sr-only">Filter by series</span>
              <select
                value={seriesFilter}
                onChange={(e) => handleSeriesFilterChange(e.target.value)}
                className="bg-transparent text-xs focus:outline-none"
                aria-label="Filter canon by series"
              >
                <option value="">All series</option>
                {seriesOptions.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            type="button"
            onClick={() => setExtractOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-bg border border-port-border text-gray-300 text-xs hover:border-port-accent/50 hover:text-white"
          >
            <Library size={12} /> Extract from prose
          </button>
          {/* "AI: differentiate cast" is a character-only operation. When the
              parent passes `kindFilter` to scope this section to places or
              objects, hide the action so it doesn't look applicable to the
              current trunk. Keep it visible on the all-kinds view + on the
              characters-filtered view. */}
          {(!kindFilter || kindFilter === 'characters') ? (
            <button
              type="button"
              onClick={handleDifferentiate}
              disabled={differentiating || charCount < 2}
              title={charCount < 2 ? 'Need at least 2 characters to differentiate' : 'Rewrite every character so the cast renders visually distinct'}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-port-accent/15 hover:bg-port-accent/25 text-port-accent border border-port-accent/40 text-xs disabled:opacity-40"
            >
              {differentiating ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              AI: differentiate cast
            </button>
          ) : null}
        </div>
      </div>

      {extractOpen ? (
        <div className="rounded border border-port-border bg-port-bg p-3">
          <label htmlFor="canon-extract-textarea" className="text-xs uppercase tracking-wider text-gray-500">Paste prose</label>
          <textarea
            id="canon-extract-textarea"
            value={extractText}
            onChange={(e) => setExtractText(e.target.value)}
            rows={6}
            placeholder="Paste an issue's prose stage output, a story draft, or any prose body. The LLM extracts characters, places, and objects and merges them into this universe's canon."
            className="w-full mt-1 px-2 py-1.5 bg-port-card border border-port-border rounded text-white text-xs font-mono"
          />
          <div className="flex items-center justify-end gap-2 mt-2">
            <button
              type="button"
              onClick={() => { setExtractOpen(false); setExtractText(''); }}
              className="px-2 py-1 text-xs text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleExtract}
              disabled={extracting || !extractText.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-40"
            >
              {extracting ? <Loader2 size={12} className="animate-spin" /> : <Library size={12} />}
              Extract
            </button>
          </div>
        </div>
      ) : null}

      {seriesFilter ? (
        <p className="text-xs text-gray-500 italic">
          Showing canon used in <span className="text-gray-300">{seriesOptions.find((s) => s.id === seriesFilter)?.name || 'selected series'}</span>.{' '}
          <button
            type="button"
            onClick={() => handleSeriesFilterChange('')}
            className="text-port-accent hover:underline"
          >Clear filter</button>
        </p>
      ) : null}

      {KINDS.filter((kind) => !kindFilter || kind.key === kindFilter).map((kind) => (
        <KindSection
          key={kind.key}
          kind={kind}
          universeId={universeId}
          all={filteredByKind[kind.key] || []}
          totalCount={(universe[kind.key] || []).length}
          filtered={!!seriesFilter}
          usage={usage?.[kind.key] || null}
          renderingJobs={renderingJobs}
          onRender={(entry) => handleRenderRef(kind, entry)}
          onJobCompleted={(entryId, filename, completedJobId) => {
            // Discriminate by which pending map owns the completed jobId.
            // As of #1395 BOTH paths are persisted server-side by the
            // `appendEntryImageRef` completion hook (section-local renders now
            // carry a durable `universeRun.entryRef` tag too), so neither
            // client path PATCHes — they only mirror the ref into the draft:
            //   - section-local renders (`generateImage`) populate
            //     `renderingJobs[entryId]`; `handleRefCompleted` clears the
            //     spinner + stamps the draft optimistically.
            //   - external batch renders flow through the page-level
            //     `externalPendingByEntryId`; `handleExternalCanonRefCompleted`
            //     stamps the draft + clears the pending queue.
            const isExternal = completedJobId
              && externalPendingByEntryId?.[entryId] === completedJobId;
            if (isExternal) {
              handleExternalCanonRefCompleted(kind.key, entryId, filename);
              onExternalCanonJobSettled?.(entryId, completedJobId);
            } else {
              handleRefCompleted(kind.key, entryId, filename);
            }
          }}
          onJobFailed={(entryId, errMsg, failedJobId) => {
            const isExternal = failedJobId
              && externalPendingByEntryId?.[entryId] === failedJobId;
            if (isExternal) {
              onExternalCanonJobSettled?.(entryId, failedJobId);
              if (errMsg) toast.error(`Render failed: ${errMsg}`);
            } else {
              handleRefFailed(entryId, errMsg);
            }
          }}
          onPreview={openPreview}
          onRefine={handleRefineCharacter}
          refiningId={refiningId}
          onExpandCharacter={handleExpandCharacter}
          expandingId={expandingId}
          onSheetCompleted={handleSheetCompleted}
          onSheetDeleted={handleSheetDeleted}
          onToggleLock={(entryId, nextLocked) => handleToggleLock(kind, entryId, nextLocked)}
          togglingLockId={togglingLockId}
          onPatchEntry={(entryId, patch) => handlePatchEntry(kind, entryId, patch)}
          onRenderCleanPlate={(entry) => handleRenderCleanPlate(kind, entry)}
          onDescribeImages={(entry) => setDescribeTarget({ kind, entry })}
          seriesNameMap={usage?.seriesNameMap || null}
          onBulkLock={(nextLocked) => handleBulkLockKind(kind, nextLocked)}
          bulkLocking={bulkLockingKindKey === kind.key}
          fullList={Array.isArray(universe[kind.key]) ? universe[kind.key] : []}
          // The universe-wide character list — feeds the attachment target
          // picker in ObjectAttachmentsEditor for the objects kind (#1288).
          castList={Array.isArray(universe.characters) ? universe.characters : []}
          externalPendingByEntryId={externalPendingByEntryId}
          // Single-kind view (`?kind=places`, sidebar deep-links) — the
          // outer canon section already supplies the h2 + description + card
          // chrome, so KindSection drops its own bordered wrapper + duplicate
          // header. Multi-kind view keeps the chrome so Characters / Places /
          // Objects stay visually separated.
          compact={!!kindFilter}
          onRenderAll={() => handleRenderAll(kind)}
          renderingAll={renderAllKindKey === kind.key}
          onPickFromCatalog={() => setCatalogPickerKind(kind)}
          catalogLinking={catalogLinking}
          onAddEntry={(payload) => handleCreateEntry(kind, payload)}
          creating={creatingKindKey === kind.key}
        />
      ))}

      {/* Single shared picker — `catalogPickerKind` carries the KINDS entry
          whose "Pick from Catalog" button opened it, so the picker scopes its
          search to that ingredient type. */}
      <IngredientPicker
        open={!!catalogPickerKind}
        onClose={() => setCatalogPickerKind(null)}
        onSelect={(picked) => { if (catalogPickerKind) handlePickFromCatalog(catalogPickerKind, picked); }}
        type={catalogPickerKind?.apiKind}
        excludeIds={catalogExcludeIds}
        refKind="universe"
        refId={universeId}
      />

      {/* Vision "Describe from image(s)" — turns reference images into an
          image-gen-ready description and writes it into the entry's descriptor
          field (the same field CanonCard's inline editor binds to). */}
      {describeTarget ? (
        <VisionDescribeModal
          open
          kind={describeTarget.kind.apiKind}
          entryName={describeTarget.entry.name}
          universeId={universeId}
          entryId={describeTarget.entry.id}
          onApply={(description) => {
            if (describeTarget.kind.descField) {
              handlePatchEntry(describeTarget.kind, describeTarget.entry.id, {
                [describeTarget.kind.descField]: description,
              });
            }
          }}
          // Structured attributes from a reference image (characters): apply the
          // reviewed `{ field: value }` patch through the same entry-patch path.
          onApplyFields={(patch) => {
            handlePatchEntry(describeTarget.kind, describeTarget.entry.id, patch);
          }}
          onClose={() => setDescribeTarget(null)}
        />
      ) : null}
    </section>
  );
}

function KindSection({ kind, universeId, all, totalCount, filtered, usage, renderingJobs, onRender, onJobCompleted, onJobFailed, onPreview, onRefine, refiningId, onExpandCharacter, expandingId, onSheetCompleted, onSheetDeleted, onToggleLock, togglingLockId, onPatchEntry, onRenderCleanPlate, onDescribeImages = null, seriesNameMap, onBulkLock, bulkLocking, fullList, castList = [], externalPendingByEntryId = null, compact = false, onRenderAll = null, renderingAll = false, onPickFromCatalog = null, catalogLinking = false, onAddEntry = null, creating = false }) {
  // Universe-only character wiring — `null` for non-character kinds so
  // CanonCard's gate stays `kind === 'characters' && characterExtensions`.
  // Memoized so the BASE object is stable across re-renders that aren't
  // expansion-related (refining, lock toggle, etc). The per-card spread
  // below still allocates a fresh object every render to fold in
  // `expanding: expandingId === entry.id`; that's unavoidable without
  // per-card memoization and isn't worth the complexity at typical cast
  // sizes.
  const characterExtensions = useMemo(
    () => (kind.key === 'characters'
      // `castList` is the universe-wide character list — feeds the
      // relationship-link target picker in CharacterDetailEditor (#1287).
      ? { universeId, onExpandCharacter, onSheetCompleted, onSheetDeleted, castList: fullList }
      : null),
    [kind.key, universeId, onExpandCharacter, onSheetCompleted, onSheetDeleted, fullList],
  );
  // Universe-only object wiring (#1288) — `null` for non-object kinds so
  // CanonCard's gate stays `kind === 'objects' && objectExtensions`. `castList`
  // is the universe-wide character list (passed in directly, since `fullList`
  // for the objects kind is the objects, not the cast) feeding the attachment
  // target picker in ObjectAttachmentsEditor.
  const objectExtensions = useMemo(
    () => (kind.key === 'objects' ? { castList } : null),
    [kind.key, castList],
  );
  const Icon = kind.icon;

  // Manual-add form state — local to the section (mirrors CategoryEditor's
  // `adding`/`newLabel` bucket-add form). Persistence is the parent's job via
  // `onAddEntry`; this just collects a name + optional description and resets
  // on a successful save.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const submitAdd = async () => {
    if (!newName.trim() || !onAddEntry || creating) return;
    const ok = await onAddEntry({ name: newName, description: newDesc });
    if (ok) {
      setNewName('');
      setNewDesc('');
      setAdding(false);
    }
  };
  const cancelAdd = () => { setAdding(false); setNewName(''); setNewDesc(''); };

  // Bulk lock-state summary computed off the FULL list (not the series-filtered
  // view) so the buttons reflect the universe-wide state the bulk action will
  // change. A mixed list (some locked, some not) enables BOTH buttons so the
  // user can pick a direction without first having to inspect.
  const lockedCount = fullList.filter((e) => e?.locked === true).length;
  // "All locked" gates the toggle button's icon + action direction. A mixed
  // list (some locked, some not) falls into the same bucket as all-unlocked
  // so the next click locks the remaining holdouts.
  const allLocked = fullList.length > 0 && lockedCount === fullList.length;
  const bulkDisabled = !onBulkLock || bulkLocking || fullList.length === 0;

  // Render All — disabled when every entry already has a ref image or no entry
  // carries a renderable description. Mirrors the per-entry render button's
  // own enable predicate, just folded over the kind's full list.
  const renderableCount = fullList.filter((e) =>
    kind.descFor(e).trim()
    && !(Array.isArray(e.imageRefs) && e.imageRefs.length > 0)
  ).length;
  const renderAllDisabled = !onRenderAll || renderingAll || renderableCount === 0;

  const controls = (
    <>
      {onAddEntry ? (
        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          disabled={creating}
          title={`Add a ${kind.singular} manually`}
          aria-label={`Add ${kind.singular}`}
          aria-expanded={adding}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed border border-port-border hover:border-port-accent/50"
        >
          {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
          Add
        </button>
      ) : null}
      {onPickFromCatalog ? (
        <button
          type="button"
          onClick={onPickFromCatalog}
          disabled={catalogLinking}
          title={`Add an existing ${kind.singular} from the shared Catalog`}
          aria-label={`Pick ${kind.singular} from Catalog`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed border border-port-border hover:border-port-accent/50"
        >
          {catalogLinking ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
          Pick from Catalog
        </button>
      ) : null}
      {onRenderAll ? (
        <button
          type="button"
          onClick={onRenderAll}
          disabled={renderAllDisabled}
          title={renderableCount === 0
            ? `Every ${kind.singular} already has a reference image`
            : `Queue reference renders for ${renderableCount} ${renderableCount === 1 ? kind.singular : kind.label.toLowerCase()} without an image yet`}
          aria-label={`Render all ${kind.label}`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-gray-400 hover:text-port-accent disabled:opacity-30 disabled:cursor-not-allowed border border-port-border hover:border-port-accent/50"
        >
          {renderingAll ? <Loader2 size={11} className="animate-spin" /> : <ImagePlus size={11} />}
          Render all{renderableCount > 0 ? ` (${renderableCount})` : ''}
        </button>
      ) : null}
      {fullList.length > 0 && onBulkLock ? (
        // Single toggle button — mirrors the per-item lock-toggle visual.
        // Lock icon when every entry is already locked (click unlocks all);
        // Unlock icon for the all-unlocked + mixed cases (click locks all)
        // so "the next click locks the holdouts" is always the action.
        <button
          type="button"
          onClick={() => onBulkLock(!allLocked)}
          disabled={bulkDisabled}
          title={allLocked
            ? `Unlock all ${kind.label.toLowerCase()} — AI refine / differentiate may overwrite them`
            : `Lock all ${kind.label.toLowerCase()} — AI refine / differentiate will skip them`}
          aria-label={allLocked ? `Unlock all ${kind.label}` : `Lock all ${kind.label}`}
          aria-pressed={allLocked}
          className={`p-1 rounded disabled:opacity-30 disabled:cursor-not-allowed ${
            allLocked
              ? 'text-port-accent hover:bg-port-accent/20'
              : 'text-gray-500 hover:text-gray-300'
          }`}
        >
          {bulkLocking
            ? <Loader2 size={14} className="animate-spin" />
            : allLocked ? <Lock size={14} /> : <Unlock size={14} />}
        </button>
      ) : null}
    </>
  );

  const addForm = adding ? (
    <div className="bg-port-bg border border-port-border rounded p-2 mb-2 flex flex-col gap-2">
      <input
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submitAdd(); }}
        placeholder={`${kind.singular[0].toUpperCase()}${kind.singular.slice(1)} name`}
        className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
        maxLength={BIBLE_LIMITS.NAME_MAX}
        autoFocus
        aria-label={`New ${kind.singular} name`}
      />
      <textarea
        value={newDesc}
        onChange={(e) => setNewDesc(e.target.value)}
        placeholder={`Describe this ${kind.singular} (optional — image-gen-ready prose)`}
        className="bg-port-card border border-port-border rounded px-2 py-1 text-white text-sm"
        rows={2}
        maxLength={kind.descFieldMax}
        aria-label={`New ${kind.singular} description`}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submitAdd}
          disabled={!newName.trim() || creating}
          className="inline-flex items-center gap-1 text-xs px-2 py-1 bg-port-accent hover:bg-port-accent/90 disabled:opacity-50 text-white rounded"
        >
          {creating ? <Loader2 size={12} className="animate-spin" /> : null}
          Save
        </button>
        <button
          type="button"
          onClick={cancelAdd}
          className="text-xs px-2 py-1 bg-port-bg hover:bg-port-border text-gray-300 rounded"
        >
          Cancel
        </button>
      </div>
    </div>
  ) : null;

  const list = all.length === 0 ? (
    filtered && totalCount > 0
      ? <p className="text-xs text-gray-500 italic">No {kind.label.toLowerCase()} in the selected series. {totalCount} total in this universe — clear the filter to see them all.</p>
      : <p className="text-xs text-gray-500 italic">No {kind.label.toLowerCase()} yet. Use <em>Add</em> or <em>Extract from prose</em> above to populate this list.</p>
  ) : (
    <ul className="space-y-2">
      {all.map((entry) => (
        <CanonCard
          key={entry.id || entry.name}
          kind={kind}
          entry={entry}
          // Merge the section-local pending map (one-off renders) with
          // the universe-page-level map (batch `/render` jobs). The
          // section's own state wins because its completion handler is
          // the one that does the optimistic imageRefs[] append for
          // canon entries (`handleRefCompleted`); the external map is
          // a presentation-only fallback so the spinner shows for
          // batch-queued canon jobs too.
          inFlightJobId={renderingJobs[entry.id] || externalPendingByEntryId?.[entry.id] || null}
          onRender={() => onRender(entry)}
          onJobCompleted={onJobCompleted}
          onJobFailed={onJobFailed}
          onPreview={onPreview}
          onRefine={onRefine}
          refining={refiningId === entry.id}
          refineDisabled={!!refiningId && refiningId !== entry.id}
          usage={usage?.[entry.id] || null}
          onToggleLock={onToggleLock}
          togglingLock={togglingLockId === entry.id}
          onPatchEntry={onPatchEntry}
          onRenderCleanPlate={onRenderCleanPlate}
          onDescribeImages={onDescribeImages}
          seriesNameMap={seriesNameMap}
          characterExtensions={characterExtensions
            ? { ...characterExtensions, expanding: expandingId === entry.id }
            : null}
          objectExtensions={objectExtensions}
        />
      ))}
    </ul>
  );

  // Compact mode: the outer canon section already supplies the h2 + bordered
  // card chrome, so KindSection drops its own wrapper to avoid double-nesting.
  // The duplicate icon + label header is hidden too — only the controls strip
  // (count, Render all, bulk lock) stays as a slim toolbar above the list.
  if (compact) {
    return (
      <div>
        <div className="flex items-center justify-end gap-1.5 mb-2">
          <span className="text-[10px] text-gray-500 mr-auto">
            {filtered ? `${all.length} / ${totalCount}` : all.length} {all.length === 1 ? kind.singular : kind.label.toLowerCase()}
          </span>
          {controls}
        </div>
        {addForm}
        {list}
      </div>
    );
  }

  return (
    <section className="rounded border border-port-border bg-port-bg/60">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-port-border">
        <Icon size={14} className="text-gray-400" />
        <h3 className="text-sm font-semibold text-white">{kind.label}</h3>
        <span className="text-[10px] text-gray-500">
          {filtered ? `${all.length} / ${totalCount}` : all.length}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {controls}
        </div>
      </div>
      <div className="p-3">{addForm}{list}</div>
    </section>
  );
}

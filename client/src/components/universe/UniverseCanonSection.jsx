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
  Library, Loader2, Users, MapPin, Package, Wand2, Filter,
} from 'lucide-react';
import toast from '../ui/Toast';
import {
  extractUniverseCanon,
  refineUniverseCharacter,
  differentiateUniverseCast,
  updateUniverse,
  getUniverseCanonUsage,
  setUniverseCanonLock,
  expandUniverseCharacter,
} from '../../services/apiUniverseBuilder';
import { generateImage } from '../../services/apiSystem';
import { composeStyledPrompt } from '../../lib/composeStyledPrompt';
import { composeCleanPlatePrompt } from '../../lib/cleanPlatePrompt';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import useMounted from '../../hooks/useMounted';
import CanonCard from '../pipeline/CanonCard';
import MediaPreview from '../media/MediaPreview';
import { pipelineImageCfgToRenderOpts } from '../../lib/pipelineImageDefaults';
import { universeStylePreset } from '../../lib/universeStylePreset';
import { descriptorForCanonEntry } from '../../lib/canonPrompt';

const KINDS = [
  {
    key: 'characters', apiKind: 'character', label: 'Characters', singular: 'character', icon: Users,
    descFor: (c) => descriptorForCanonEntry('characters', c),
  },
  {
    key: 'places', apiKind: 'place', label: 'Places', singular: 'place', icon: MapPin,
    descFor: (p) => descriptorForCanonEntry('places', p),
  },
  {
    key: 'objects', apiKind: 'object', label: 'Objects', singular: 'object', icon: Package,
    descFor: (o) => descriptorForCanonEntry('objects', o),
  },
];

export default function UniverseCanonSection({ universe, universeId, onUniverseChange, imageCfg, kindFilter = null }) {
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
  const [preview, setPreview] = useState(null);
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

  const previewItems = useMemo(() => {
    if (!universe) return [];
    const out = [];
    for (const kind of KINDS) {
      const list = Array.isArray(universe[kind.key]) ? universe[kind.key] : [];
      for (const entry of list) {
        const refs = Array.isArray(entry.imageRefs) ? entry.imageRefs : [];
        for (const filename of refs) {
          out.push({
            key: `canon:${filename}`,
            kind: 'image',
            filename,
            previewUrl: `/data/images/${filename}`,
            downloadUrl: `/data/images/${filename}`,
            prompt: `${entry.name}: ${kind.descFor(entry) || ''}`.trim().replace(/:\s*$/, ''),
          });
        }
        // Reference sheets live in data/image-refs/ — different static prefix
        // than the gallery. Built into the same list so the existing
        // MediaPreview lightbox + arrow navigation work uniformly.
        if (kind.key === 'characters' && typeof entry.referenceSheetImageRef === 'string' && entry.referenceSheetImageRef) {
          const filename = entry.referenceSheetImageRef;
          out.push({
            key: `canon-sheet:${filename}`,
            kind: 'image',
            filename,
            previewUrl: `/data/image-refs/${filename}`,
            downloadUrl: `/data/image-refs/${filename}`,
            prompt: `${entry.name} — character reference sheet`,
          });
        }
      }
    }
    return out;
  }, [universe]);

  const openPreview = useCallback((filename, opts) => {
    if (!filename) return;
    // Match on the kind-tagged key when the caller indicates a sheet —
    // gallery `imageRefs[]` and `referenceSheetImageRef` can theoretically
    // collide on basename, in which case a filename-only find would route
    // the lightbox to the wrong static prefix (/data/images vs /data/image-refs).
    const targetKey = opts?.isSheet ? `canon-sheet:${filename}` : `canon:${filename}`;
    const match = previewItems.find((i) => i.key === targetKey)
      || previewItems.find((i) => i.filename === filename);
    if (match) setPreview(match);
  }, [previewItems]);

  const [runExtract, extracting] = useAsyncAction(
    () => extractUniverseCanon(universeId, { corpus: extractText.trim() }),
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
    const result = await differentiateUniverseCast(universeId, { providerId, model })
      .catch((err) => { toast.error(err.message || 'Differentiate failed'); return null; });
    if (mountedRef.current) setDifferentiating(false);
    if (!result || !isStillCurrent(capturedId)) return;
    onUniverseChange(result.universe);
    toast.success(`Differentiated ${result.touched}/${result.touched + result.skipped} characters — ${(result.rationale || '').slice(0, 140)}`);
  };

  const handleToggleLock = useCallback(async (kind, entryId, nextLocked) => {
    if (togglingLockRef.current) return;
    togglingLockRef.current = entryId;
    setTogglingLockId(entryId);
    const capturedId = universeId;
    const result = await setUniverseCanonLock(universeId, kind.apiKind, entryId, nextLocked)
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
    const result = await refineUniverseCharacter(universeId, entryId, { providerId, model })
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
    const result = await expandUniverseCharacter(universeId, entryId, { providerId, model })
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
  const handleSheetCompleted = useCallback((entryId, destFilename) => {
    const latest = latestUniverseRef.current;
    if (!latest || !destFilename) return;
    const nextCharacters = (latest.characters || []).map((c) =>
      c.id === entryId ? { ...c, referenceSheetImageRef: destFilename } : c,
    );
    onUniverseChange({ ...latest, characters: nextCharacters });
    const entryName = nextCharacters.find((c) => c.id === entryId)?.name || 'Character';
    toast.success(`${entryName} reference sheet ready`);
  }, [onUniverseChange]);

  const handleRenderRef = async (kind, entry) => {
    const description = kind.descFor(entry);
    if (!description.trim()) {
      toast.error(`Add a description before generating a reference for ${entry.name}`);
      return;
    }
    const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
    const styled = composeStyledPrompt(
      `${entry.name}: ${description}`,
      baseOpts.negativePrompt || '',
      universe ? universeStylePreset(universe) : null,
    );
    const queued = await generateImage({
      ...baseOpts,
      prompt: styled.prompt,
      negativePrompt: styled.negativePrompt || undefined,
    }).catch((err) => { toast.error(err.message || 'Render failed'); return null; });
    if (!queued?.jobId || !mountedRef.current) return;
    setRenderingJobs((prev) => ({ ...prev, [entry.id]: queued.jobId }));
    toast.success(`Rendering reference for ${entry.name}`);
  };

  const handleRenderCleanPlate = async (entry) => {
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
    const queued = await generateImage({
      ...baseOpts,
      prompt: styled.prompt,
      negativePrompt: styled.negativePrompt || undefined,
    }).catch((err) => { toast.error(err.message || 'Clean plate render failed'); return null; });
    if (!queued?.jobId || !mountedRef.current) return;
    setRenderingJobs((prev) => ({ ...prev, [entry.id]: queued.jobId }));
    toast.success(`Rendering clean plate for ${entry.name}`);
  };

  const handleRefCompleted = useCallback(async (kindKey, entryId, filename) => {
    if (!filename || !universe) return;
    setRenderingJobs((prev) => {
      if (!prev[entryId]) return prev;
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    const capturedId = universeId;
    const list = (universe[kindKey] || []).map((e) =>
      e.id === entryId ? { ...e, imageRefs: [...(e.imageRefs || []), filename] } : e
    );
    const updated = await updateUniverse(universeId, { [kindKey]: list })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    if (updated && mountedRef.current && currentUniverseIdRef.current === capturedId) onUniverseChange(updated);
  }, [universe, universeId, onUniverseChange, mountedRef]);

  const handleRefFailed = useCallback((entryId, errMsg) => {
    setRenderingJobs((prev) => {
      if (!prev[entryId]) return prev;
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    if (errMsg) toast.error(`Render failed: ${errMsg}`);
  }, []);

  // Inline-edit channel for canon fields the user types/picks directly
  // (setting intExt + timeOfDay chips, primaryImageRef pinning, wardrobe
  // edits). Optimistic — UI updates before the server roundtrip so chip
  // clicks feel instant.
  const handlePatchEntry = useCallback(async (kind, entryId, patch) => {
    if (!universe || !patch || typeof patch !== 'object') return;
    const capturedId = universeId;
    const kindKey = kind.key;
    const list = (universe[kindKey] || []).map((e) =>
      e.id === entryId ? { ...e, ...patch } : e
    );
    onUniverseChange({ ...universe, [kindKey]: list });
    const updated = await updateUniverse(universeId, { [kindKey]: list })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    if (updated && mountedRef.current && currentUniverseIdRef.current === capturedId) onUniverseChange(updated);
  }, [universe, universeId, onUniverseChange, mountedRef]);

  if (!universe) return null;

  const charCount = (universe.characters || []).length;

  return (
    // `id="canon"` is the scroll target for `/universe-builder/:id#canon`
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
          onJobCompleted={(entryId, filename) => handleRefCompleted(kind.key, entryId, filename)}
          onJobFailed={handleRefFailed}
          onPreview={openPreview}
          onRefine={handleRefineCharacter}
          refiningId={refiningId}
          onExpandCharacter={handleExpandCharacter}
          expandingId={expandingId}
          onSheetCompleted={handleSheetCompleted}
          onToggleLock={(entryId, nextLocked) => handleToggleLock(kind, entryId, nextLocked)}
          togglingLockId={togglingLockId}
          onPatchEntry={(entryId, patch) => handlePatchEntry(kind, entryId, patch)}
          onRenderCleanPlate={handleRenderCleanPlate}
          seriesNameMap={usage?.seriesNameMap || null}
        />
      ))}

      <MediaPreview preview={preview} setPreview={setPreview} items={previewItems} />
    </section>
  );
}

function KindSection({ kind, universeId, all, totalCount, filtered, usage, renderingJobs, onRender, onJobCompleted, onJobFailed, onPreview, onRefine, refiningId, onExpandCharacter, expandingId, onSheetCompleted, onToggleLock, togglingLockId, onPatchEntry, onRenderCleanPlate, seriesNameMap }) {
  const Icon = kind.icon;
  return (
    <section className="rounded border border-port-border bg-port-bg/60">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-port-border">
        <Icon size={14} className="text-gray-400" />
        <h3 className="text-sm font-semibold text-white">{kind.label}</h3>
        <span className="text-[10px] text-gray-500">
          {filtered ? `${all.length} / ${totalCount}` : all.length}
        </span>
      </div>
      <div className="p-3">
        {all.length === 0 ? (
          filtered && totalCount > 0
            ? <p className="text-xs text-gray-500 italic">No {kind.label.toLowerCase()} in the selected series. {totalCount} total in this universe — clear the filter to see them all.</p>
            : <p className="text-xs text-gray-500 italic">No {kind.label.toLowerCase()} yet. Use <em>Extract from prose</em> above to populate this list from an issue.</p>
        ) : (
          <ul className="space-y-2">
            {all.map((entry) => (
              <CanonCard
                key={entry.id || entry.name}
                kind={kind}
                entry={entry}
                inFlightJobId={renderingJobs[entry.id]}
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
                seriesNameMap={seriesNameMap}
                universeId={kind.key === 'characters' ? universeId : null}
                onExpandCharacter={kind.key === 'characters' ? onExpandCharacter : null}
                expanding={kind.key === 'characters' && expandingId === entry.id}
                onSheetCompleted={kind.key === 'characters' ? onSheetCompleted : null}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

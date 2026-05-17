/**
 * Universe Canon — manage characters, places, and objects on a universe.
 *
 * Phase A of the Universe-as-canon refactor: entity registries live on the
 * universe so multiple series can share them. Mirrors the Nouns page's
 * structure but reads/writes universe.characters[] / .settings[] / .objects[].
 * The Nouns page (per-series) keeps working until Phase B migrates series →
 * universe references.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Library, Loader2, Users, MapPin, Package, Globe2, Wand2, ArrowLeft, Filter,
} from 'lucide-react';
import toast from '../components/ui/Toast';
import {
  getUniverse,
  extractUniverseCanon,
  refineUniverseCharacter,
  differentiateUniverseCast,
  updateUniverse,
  getUniverseCanonUsage,
  setUniverseCanonLock,
} from '../services/apiUniverseBuilder';
import { generateImage, getSettings } from '../services/apiSystem';
import { composeStyledPrompt } from '../lib/composeStyledPrompt';
import { composeCleanPlatePrompt } from '../lib/cleanPlatePrompt';
import { useAsyncAction } from '../hooks/useAsyncAction';
import useMounted from '../hooks/useMounted';
import CanonCard from '../components/pipeline/CanonCard';
import MediaPreview from '../components/media/MediaPreview';
import {
  PIPELINE_IMAGE_DEFAULTS,
  readPipelineImageSettings,
  pipelineImageCfgToRenderOpts,
} from '../lib/pipelineImageDefaults';
import { joinInfluenceList } from '../lib/joinInfluenceList';

const universeStylePreset = (universe) => {
  const embrace = joinInfluenceList(universe?.influences?.embrace);
  const avoid = joinInfluenceList(universe?.influences?.avoid);
  if (!embrace && !avoid) return null;
  return { prompt: embrace, negativePrompt: avoid };
};

const KINDS = [
  {
    key: 'characters', apiKind: 'character', label: 'Characters', singular: 'character', icon: Users,
    descFor: (c) => c.physicalDescription || c.description || '',
  },
  {
    key: 'settings', apiKind: 'setting', label: 'Places', singular: 'place', icon: MapPin,
    descFor: (s) => [
      s.description,
      s.palette ? `Palette: ${s.palette}` : '',
      s.recurringDetails,
    ].filter(Boolean).join('. '),
  },
  {
    key: 'objects', apiKind: 'object', label: 'Objects', singular: 'object', icon: Package,
    descFor: (o) => o.description || o.significance || '',
  },
];

export default function UniverseCanon() {
  const { universeId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const seriesFilter = searchParams.get('series') || '';
  const mountedRef = useMounted();
  const [universe, setUniverse] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);
  const [renderingJobs, setRenderingJobs] = useState({});
  const [refiningId, setRefiningId] = useState(null);
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
  // Loaded lazily after the universe itself — usage is a derived view and
  // shouldn't block the initial render. Refetched after mutations that change
  // the canon shape (extract / differentiate-cast) so new entries get usage.
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getUniverse(universeId).catch((e) => { setLoadErr(e.message || 'Load failed'); return null; }),
      getSettings().catch(() => ({})),
    ]).then(([u, s]) => {
      if (cancelled || !mountedRef.current) return;
      setUniverse(u);
      setImageCfg(readPipelineImageSettings(s));
    });
    return () => { cancelled = true; };
  }, [universeId, mountedRef]);

  // Lazy usage fetch. Decoupled from the universe load so a slow cross-
  // reference scan doesn't gate the page paint, and so it can be refetched
  // independently after canon mutations. The captured `requestedFor` is
  // checked against the live `currentUniverseIdRef` so a slow response from
  // a previous universe (rapid navigation) can't repopulate `usage` with
  // stale data — `setUsage(null)` on universeId change would otherwise be
  // immediately undone.
  const currentUniverseIdRef = useRef(universeId);
  useEffect(() => { currentUniverseIdRef.current = universeId; }, [universeId]);
  const refreshUsage = useCallback(() => {
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
  // series that actually reference this universe's canon — a series linked
  // to the universe with zero issues has nothing to filter to.
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

  // If the URL names a series that isn't in this universe's usage map
  // (stale bookmark, deleted series), drop the param silently so the page
  // doesn't show an empty "filtered" view forever. One-shot per universe —
  // runs when usage first resolves; later URL changes are driven by the
  // dropdown (handleSeriesFilterChange) which only sets known-good ids.
  // Reset on universeId change so navigating between universes within the
  // same mount validates each universe's filter param independently. Also
  // clear `usage` so the validation effect doesn't run against the prior
  // universe's data during the transition.
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

  // Build a per-kind filtered entry list. When no filter is active the
  // raw universe arrays pass through unchanged.
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
      }
    }
    return out;
  }, [universe]);

  const openPreview = useCallback((filename) => {
    if (!filename) return;
    const match = previewItems.find((i) => i.filename === filename);
    if (match) setPreview(match);
  }, [previewItems]);

  const [runExtract, extracting] = useAsyncAction(
    () => extractUniverseCanon(universeId, { corpus: extractText.trim() }),
    { errorMessage: 'Extraction failed' },
  );

  const handleExtract = async () => {
    if (!extractText.trim()) {
      toast.error('Paste prose into the textarea first');
      return;
    }
    const result = await runExtract();
    if (!result || !mountedRef.current) return;
    setUniverse(result.universe);
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
    const providerId = universe.llm?.provider || undefined;
    const model = universe.llm?.model || undefined;
    const result = await differentiateUniverseCast(universeId, { providerId, model })
      .catch((err) => { toast.error(err.message || 'Differentiate failed'); return null; });
    if (mountedRef.current) setDifferentiating(false);
    if (!result || !mountedRef.current) return;
    setUniverse(result.universe);
    toast.success(`Differentiated ${result.touched}/${result.touched + result.skipped} characters — ${(result.rationale || '').slice(0, 140)}`);
  };

  const handleToggleLock = useCallback(async (kind, entryId, nextLocked) => {
    if (togglingLockRef.current) return;
    togglingLockRef.current = entryId;
    setTogglingLockId(entryId);
    const result = await setUniverseCanonLock(universeId, kind.apiKind, entryId, nextLocked)
      .catch((err) => { toast.error(err.message || 'Lock toggle failed'); return null; });
    togglingLockRef.current = null;
    if (mountedRef.current) setTogglingLockId(null);
    if (!result || !mountedRef.current) return;
    setUniverse(result.universe);
    toast.success(`${result.entry?.name || 'Entry'} ${nextLocked ? 'locked' : 'unlocked'}`);
  }, [universeId, mountedRef]);

  const handleRefineCharacter = async (entryId) => {
    if (!universe || refiningId) return;
    setRefiningId(entryId);
    const providerId = universe.llm?.provider || undefined;
    const model = universe.llm?.model || undefined;
    const result = await refineUniverseCharacter(universeId, entryId, { providerId, model })
      .catch((err) => { toast.error(err.message || 'Refine failed'); return null; });
    if (mountedRef.current) setRefiningId(null);
    if (!result || !mountedRef.current) return;
    setUniverse(result.universe);
    toast.success(`Refined — ${(result.rationale || result.changes?.[0] || 'description rewritten').slice(0, 140)}`);
  };

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
    if (!entry?.description?.trim()) {
      toast.error(`Add a description before generating a clean plate for ${entry.name}`);
      return;
    }
    const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
    const plate = composeCleanPlatePrompt(entry, baseOpts.negativePrompt || '');
    // Layer the universe style on top of the clean-plate composition so
    // the empty-location render shares the visual language of the
    // populated reference renders.
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
    const list = (universe[kindKey] || []).map((e) =>
      e.id === entryId ? { ...e, imageRefs: [...(e.imageRefs || []), filename] } : e
    );
    const updated = await updateUniverse(universeId, { [kindKey]: list })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    if (updated && mountedRef.current) setUniverse(updated);
  }, [universe, universeId, mountedRef]);

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
  // (today: setting intExt + timeOfDay chips). Optimistic — UI updates
  // before the server roundtrip so chip clicks feel instant.
  const handlePatchEntry = useCallback(async (kind, entryId, patch) => {
    if (!universe || !patch || typeof patch !== 'object') return;
    const kindKey = kind.key;
    const list = (universe[kindKey] || []).map((e) =>
      e.id === entryId ? { ...e, ...patch } : e
    );
    setUniverse((prev) => prev ? { ...prev, [kindKey]: list } : prev);
    const updated = await updateUniverse(universeId, { [kindKey]: list })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    if (updated && mountedRef.current) setUniverse(updated);
  }, [universe, universeId, mountedRef]);

  if (loadErr) return <div className="p-4 text-port-error">{loadErr}</div>;
  if (!universe) return <div className="p-4 text-gray-500 italic">Loading universe…</div>;

  const charCount = (universe.characters || []).length;

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-5">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link
            to={`/universe-builder/${encodeURIComponent(universeId)}`}
            className="inline-flex items-center gap-1 text-xs text-port-accent hover:underline"
          >
            <ArrowLeft size={12} /> Back to Universe Builder
          </Link>
          <h1 className="text-xl font-semibold text-white mt-1 flex items-center gap-2">
            <Globe2 size={18} className="text-port-accent" />
            Canon: {universe.name}
          </h1>
          <p className="text-xs text-gray-500 mt-1 max-w-2xl">
            People, places, and things that exist in this universe. Series within this universe
            share the same canon — once Phase B lands, episodes/issues will reference these
            entries directly so a character renders consistently across crossovers and cameos.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {seriesOptions.length > 1 ? (
            <label className="inline-flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-port-card border border-port-border text-gray-300 text-sm">
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
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-gray-300 text-sm hover:border-port-accent/50 hover:text-white"
          >
            <Library size={14} /> Extract from prose
          </button>
          <button
            type="button"
            onClick={handleDifferentiate}
            disabled={differentiating || charCount < 2}
            title={charCount < 2 ? 'Need at least 2 characters to differentiate' : 'Rewrite every character so the cast renders visually distinct'}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-40"
          >
            {differentiating ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            AI: differentiate cast
          </button>
        </div>
      </header>

      {extractOpen ? (
        <section className="rounded border border-port-border bg-port-card/40 p-3">
          <label className="text-xs uppercase tracking-wider text-gray-500">Paste prose</label>
          <textarea
            value={extractText}
            onChange={(e) => setExtractText(e.target.value)}
            rows={8}
            placeholder="Paste an issue's prose stage output, a story draft, or any prose body. The LLM extracts characters, places, and objects and merges them into this universe's canon."
            className="w-full mt-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-xs font-mono"
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
        </section>
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

      {KINDS.map((kind) => (
        <KindSection
          key={kind.key}
          kind={kind}
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
          onToggleLock={(entryId, nextLocked) => handleToggleLock(kind, entryId, nextLocked)}
          togglingLockId={togglingLockId}
          onPatchEntry={(entryId, patch) => handlePatchEntry(kind, entryId, patch)}
          onRenderCleanPlate={handleRenderCleanPlate}
        />
      ))}

      <MediaPreview preview={preview} setPreview={setPreview} items={previewItems} />
    </div>
  );
}

function KindSection({ kind, all, totalCount, filtered, usage, renderingJobs, onRender, onJobCompleted, onJobFailed, onPreview, onRefine, refiningId, onToggleLock, togglingLockId, onPatchEntry, onRenderCleanPlate }) {
  const Icon = kind.icon;
  return (
    <section className="rounded-lg border border-port-border bg-port-card/40">
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
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}


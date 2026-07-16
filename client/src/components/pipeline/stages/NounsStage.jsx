/**
 * Nouns stage — per-issue canonical-noun curation.
 *
 * Canon lives on the LINKED UNIVERSE (`series.universeId`) so a cast can be
 * shared across crossover series. This page is the per-issue filtered view
 * over universe canon — entries that "appear in this issue" are
 * prose-matched from `issue.stages.prose.output`. All mutations (extract /
 * refine / render-reference) target the universe directly.
 *
 * A series with no `universeId` gets a gate banner directing the user to
 * link a universe — orphan-series canon was removed in Phase B.4 (the
 * series schema no longer carries `characters` / `settings` / `objects`).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Library, Loader2, Users, MapPin, Package,
  Settings as SettingsIcon, ChevronDown, ChevronRight, AlertTriangle, FileSearch,
} from 'lucide-react';
import toast from '../../ui/Toast';
import {
  refineUniverseCharacter,
  getUniverseSeriesNames,
} from '../../../services/apiUniverseBuilder';
import { extractPipelineCanonFromScript, describePipelineCanonFromProse } from '../../../services/apiPipeline';
import { getProviders } from '../../../services/apiProviders';
import { getSettings, patchSettingsSlice, generateImage } from '../../../services/apiSystem';
import { listImageModels } from '../../../services/apiImageVideo';
import {
  matchCharactersInText, matchPlacesInText, matchObjectsInText,
} from '../../../lib/scenePrompt';
import { composeStyledPrompt } from '../../../lib/composeStyledPrompt';
import { composeCleanPlatePrompt } from '../../../lib/cleanPlatePrompt';
import { universeStylePreset } from '../../../lib/universeStylePreset';
import { buildUniverseSectionRenderTag } from '../../../lib/universeRunTag';
import useMounted from '../../../hooks/useMounted';
import useUniverse from '../../../hooks/useUniverse';
import { useCanonPatch } from '../../../hooks/useCanonPatch';
import usePreviewRoute from '../../../hooks/usePreviewRoute';
import CanonCard from '../CanonCard';
import MediaPreview from '../../media/MediaPreview';
import Drawer from '../../Drawer';
import ImageGenSettingsForm from '../../imageGen/ImageGenSettingsForm';
import { deriveAvailableBackends } from '../../../lib/imageGenBackends';
import {
  PIPELINE_IMAGE_DEFAULTS,
  readPipelineImageSettings,
  pipelineImageCfgToRenderOpts,
} from '../../../lib/pipelineImageDefaults';
import { BIBLE_LIMITS, capImageRefs } from '../../../lib/bibleLimits';

// Per-kind metadata. `descFor` picks the most visual field for ref-image
// generation; `descField`/`descFieldFallback`/`descFieldMax` bind CanonCard's
// inline description editor to the RIGHT stored field (characters keep their
// text in `physicalDescription`, not `description`) so the card neither shows a
// false "No description yet" nor edits the wrong field; `match` is the prose
// scanner that decides whether an entry "appears in this issue". Kept in
// lock-step with UniverseCanonSection's KIND_DEFS so the pipeline + universe
// canon views render identically.
const KINDS = [
  {
    key: 'characters', label: 'Characters', singular: 'character', icon: Users,
    descFor: (c) => c.physicalDescription || c.description || '',
    descField: 'physicalDescription', descFieldFallback: 'description', descFieldMax: BIBLE_LIMITS.PHYSICAL_DESCRIPTION_MAX,
    match: matchCharactersInText,
  },
  {
    key: 'places', label: 'Places', singular: 'place', icon: MapPin,
    descFor: (p) => [
      p.description,
      p.palette ? `Palette: ${p.palette}` : '',
      p.recurringDetails,
    ].filter(Boolean).join('. '),
    descField: 'description', descFieldMax: BIBLE_LIMITS.PLACE_DESCRIPTION_MAX,
    match: matchPlacesInText,
  },
  {
    key: 'objects', label: 'Objects', singular: 'object', icon: Package,
    descFor: (o) => o.description || o.significance || '',
    descField: 'description', descFieldFallback: 'significance', descFieldMax: BIBLE_LIMITS.OBJECT_DESCRIPTION_MAX,
    match: matchObjectsInText,
  },
];

export default function NounsStage({ issue, series, onStageUpdate }) {
  const mountedRef = useMounted();
  const prose = (issue.stages?.prose?.output || '').trim();
  const proseReady = prose.length > 0;

  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);
  const [imageModels, setImageModels] = useState([]);
  const [sysSettings, setSysSettings] = useState(null);
  // Linked universe — reference renders inherit its stylePrompt + negativePrompt
  // so ref images stay visually coherent with the comic-page renderer. `setUniverse`
  // applies optimistic updates after canon patches / refines / extracts.
  const [universe, setUniverse] = useUniverse(series?.universeId);
  // Per-entry in-flight render: { [entryId]: jobId }. NounCard subscribes to
  // job progress and surfaces MediaJobThumb until completion — the entry's
  // imageRefs[] is only PATCHed onto the series when the job actually
  // finishes, so we never render broken <img>s for files that don't exist yet.
  const [renderingJobs, setRenderingJobs] = useState({});
  // Shared lightbox state — a flat items list across every kind's imageRefs
  // powers prev/next nav so the user can page through every reference image
  // without closing/reopening. URL-driven via `usePreviewRoute(previewItems)`
  // so the modal is deep-linkable (`?preview=<filename>`); the hook is
  // declared just after the `previewItems` build below.

  // Canon lives on the linked universe. An orphan series (no universeId)
  // renders the link-required gate instead of this body, so by the time
  // we get here `universe` is loaded and authoritative.
  const previewItems = useMemo(() => {
    const items = [];
    if (!universe) return items;
    for (const kind of KINDS) {
      const list = Array.isArray(universe[kind.key]) ? universe[kind.key] : [];
      for (const entry of list) {
        const refs = Array.isArray(entry.imageRefs) ? entry.imageRefs : [];
        for (const filename of refs) {
          items.push({
            key: `noun:${filename}`,
            kind: 'image',
            filename,
            previewUrl: `/data/images/${filename}`,
            downloadUrl: `/data/images/${filename}`,
            prompt: `${entry.name}: ${kind.descFor(entry) || ''}`.trim().replace(/:\s*$/, ''),
          });
        }
      }
    }
    return items;
  }, [universe]);
  const [preview, setPreview] = usePreviewRoute(previewItems);
  const openPreview = useCallback((filename) => {
    if (!filename) return;
    const match = previewItems.find((i) => i.filename === filename);
    if (match) setPreview(match);
  }, [previewItems, setPreview]);

  const availableBackends = useMemo(
    () => deriveAvailableBackends(sysSettings, { excludeExternal: true }),
    [sysSettings],
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getSettings().catch(() => ({})),
      listImageModels().catch(() => []),
    ]).then(([s, modelList]) => {
      if (cancelled || !mountedRef.current) return;
      setSysSettings(s);
      setImageCfg(readPipelineImageSettings(s));
      setImageModels(Array.isArray(modelList) ? modelList : []);
    });
    return () => { cancelled = true; };
  }, [mountedRef]);

  // Sibling-series name lookup for the canon-card "from <series>" chip.
  // The current series is in `series.name`; everything else (including the
  // entries that surface in the "Other series canon" details panel) needs the
  // server-side lookup. Failure is non-fatal — chips just fall back to the
  // id-tooltip form. Uses the thin /series-names endpoint to skip the per-
  // issue prose scan that /canon-usage also runs.
  const [seriesNameMap, setSeriesNameMap] = useState(null);
  useEffect(() => {
    // Reset immediately so chips fall back to id-tooltip form while loading
    // rather than briefly rendering names from the previous universe.
    setSeriesNameMap(null);
    if (!series?.universeId) return;
    let cancelled = false;
    getUniverseSeriesNames(series.universeId).then((list) => {
      if (cancelled || !mountedRef.current) return;
      const map = Object.fromEntries((Array.isArray(list) ? list : []).map((s) => [s.id, s.name]));
      setSeriesNameMap(map);
    }).catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [series?.universeId, mountedRef]);

  const persistImageCfg = useCallback(async (next) => {
    setImageCfg(next);
    await patchSettingsSlice('pipeline', { imageGen: next }, { silent: true })
      .catch((err) => toast.error(`Settings save failed: ${err.message}`));
  }, []);

  const [searchParams, setSearchParams] = useSearchParams();
  const settingsOpen = searchParams.get('settings') === 'noun-image';
  const openSettings = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('settings', 'noun-image');
      return next;
    });
  }, [setSearchParams]);
  const closeSettings = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('settings');
      return next;
    });
  }, [setSearchParams]);

  const [extracting, setExtracting] = useState(false);

  // Provider/model picker for the extraction run. Seeded from the series'
  // configured LLM but overridable per attempt so the user can keep trying
  // different models until extraction succeeds (e.g. after a Codex safety
  // refusal or a malformed-JSON response). Empty string = "series default".
  const [providers, setProviders] = useState([]);
  const [activeProviderId, setActiveProviderId] = useState(null);
  const [extractProvider, setExtractProvider] = useState(series?.llm?.provider || '');
  const [extractModel, setExtractModel] = useState(series?.llm?.model || '');
  useEffect(() => {
    getProviders()
      .then((data) => {
        if (!mountedRef.current) return;
        setProviders(data?.providers || []);
        setActiveProviderId(data?.activeProvider || null);
      })
      .catch(() => { /* dropdowns fall back to the series-default label */ });
  }, [mountedRef]);

  // Persisted outcome of the last prose→canon extraction. Read straight from
  // the issue prop — it survives reload and is refreshed via `onStageUpdate`
  // after a retry (success or failure), so no local mirror/effect is needed.
  const canonExtraction = issue.stages?.prose?.canonExtraction || null;

  // Models offered for the currently-picked extraction provider (or the series
  // default when none is explicitly picked). Mirrors SeriesLlmPicker.
  const seriesDefaultProviderId = series?.llm?.provider || activeProviderId;
  const providerLabel = (pid) => providers.find((p) => p.id === pid)?.name || pid || 'Active provider';
  const extractProviderModels = useMemo(() => {
    const p = providers.find((x) => x.id === extractProvider)
      || providers.find((x) => x.id === seriesDefaultProviderId);
    return p?.models || [];
  }, [providers, extractProvider, seriesDefaultProviderId]);

  // Per-character in-flight refine. Tracking by id (not a single bool) so
  // the user can fire refines in serial without the spinner jumping cards.
  const [refiningCharacterId, setRefiningCharacterId] = useState(null);
  const handleRefineCharacter = useCallback(async (entryId) => {
    if (!universe || refiningCharacterId) return;
    setRefiningCharacterId(entryId);
    const providerId = series.llm?.provider || undefined;
    const model = series.llm?.model || undefined;
    const result = await refineUniverseCharacter(universe.id, entryId, { providerId, model }, { silent: true })
      .catch((err) => { toast.error(err.message || 'Refine failed'); return null; });
    if (mountedRef.current) setRefiningCharacterId(null);
    if (!result || !mountedRef.current) return;
    if (result.universe) setUniverse(result.universe);
    const summary = result.rationale || (result.changes?.[0] ? result.changes[0] : 'description rewritten');
    toast.success(`Refined description — ${summary.slice(0, 140)}`);
  }, [universe, setUniverse, series, refiningCharacterId, mountedRef]);

  const handleExtract = async () => {
    if (!universe || !proseReady) return;
    setExtracting(true);
    // Route through the pipeline endpoint (not the universe one) so the server
    // stamps the prose stage's canonExtraction marker — single source of truth
    // shared with the post-prose auto-extract. Pass the picker's provider/model
    // so a retry can use a different model than the one that just failed.
    const result = await extractPipelineCanonFromScript(issue.id, 'prose', {
      providerOverride: extractProvider || undefined,
      model: extractModel || undefined,
    }, { silent: true }).catch((err) => {
      // A hard failure (every kind threw) is stamped `failed` server-side
      // before the throw — mirror that onto the parent issue so the banner
      // updates without a refetch and the user sees what to retry.
      if (mountedRef.current) {
        const failedMarker = {
          status: 'failed',
          error: err.message || 'Extraction failed',
          failedKinds: KINDS.map((k) => k.singular),
          provider: extractProvider, model: extractModel,
          extracted: { characters: 0, places: 0, objects: 0 },
          at: new Date().toISOString(),
        };
        onStageUpdate?.('prose', { ...issue.stages?.prose, canonExtraction: failedMarker });
        toast.error(err.message || 'Extraction failed');
      }
      return null;
    });
    if (mountedRef.current) setExtracting(false);
    if (!result || !mountedRef.current) return;
    if (result.universe) setUniverse(result.universe);
    // Propagate the stamped prose stage (with the fresh canonExtraction marker)
    // up so the banner + retry-label update without a refetch.
    if (result.issue?.stages?.prose) onStageUpdate?.('prose', result.issue.stages.prose, result.issue);
    const e = result.extracted || {};
    const counts = `${e.characters || 0} characters, ${e.places || 0} places, ${e.objects || 0} objects`;
    if (result.canonExtraction?.status === 'partial') {
      const failed = (result.canonExtraction.failedKinds || []).join(', ') || 'some kinds';
      toast.error(`Extracted ${counts}, but ${failed} failed — pick a different model and retry`);
    } else {
      toast.success(`Bibles updated — ${counts}`);
    }
  };

  // Strictly-prose-grounded description backfill. Targets = the
  // appears-in-this-issue entries (across every kind) that lack a description
  // and aren't locked. The server re-validates and fills only from prose
  // evidence, returning a `descGaps` marker for nouns the prose can't support.
  const [describing, setDescribing] = useState(false);
  const missingTargets = useMemo(() => {
    const out = [];
    if (!universe || !proseReady) return out;
    for (const kind of KINDS) {
      const list = Array.isArray(universe[kind.key]) ? universe[kind.key] : [];
      for (const entry of kind.match(prose, list)) {
        if (entry.locked === true) continue;
        if (!kind.descFor(entry).trim()) out.push({ id: entry.id, kind: kind.singular });
      }
    }
    return out;
  }, [universe, prose, proseReady]);

  const descGaps = issue.stages?.prose?.descGaps || null;

  const handleDescribeFromProse = async () => {
    if (!universe || !proseReady || describing || missingTargets.length === 0) return;
    setDescribing(true);
    const result = await describePipelineCanonFromProse(issue.id, 'prose', {
      providerOverride: extractProvider || undefined,
      model: extractModel || undefined,
      targets: missingTargets,
    }, { silent: true }).catch((err) => {
      if (mountedRef.current) toast.error(err.message || 'Describe from prose failed');
      return null;
    });
    if (mountedRef.current) setDescribing(false);
    if (!result || !mountedRef.current) return;
    if (result.universe) setUniverse(result.universe);
    // Propagate the stamped prose stage (with the fresh descGaps marker) so the
    // red-flag banner persists across reloads without a refetch.
    if (result.issue?.stages?.prose) onStageUpdate?.('prose', result.issue.stages.prose, result.issue);
    const r = result.report || {};
    const gaps = (r.none || []).length;
    if (r.filled) {
      toast.success(gaps
        ? `Described ${r.filled} from prose · ${gaps} can't be described — the manuscript is thin on them`
        : `Described ${r.filled} noun${r.filled === 1 ? '' : 's'} from prose`);
    } else if (gaps) {
      toast.error(`The prose doesn't describe ${gaps} noun${gaps === 1 ? '' : 's'} — enrich the manuscript`);
    } else {
      toast.success('Nothing to backfill — matched nouns already have descriptions');
    }
  };

  // Queue a reference render. The filename ISN'T persisted onto the entry's
  // imageRefs[] yet — NounCard subscribes to job progress and calls
  // `handleRefCompleted` once the file actually exists. Without that defer,
  // the card would <img src> a not-yet-written /data/images/<jobId>.png and
  // show the OS broken-image icon mid-render.
  const handleRenderRef = async (kind, entry) => {
    const description = kind.descFor(entry);
    if (!description.trim()) {
      toast.error(`Add a description before generating a reference for ${entry.name}`);
      return;
    }
    const baseOpts = pipelineImageCfgToRenderOpts(imageCfg);
    // Inject the universe's stylePrompt as a prefix and merge negativePrompts so
    // ref images and comic pages share the same aesthetic (Codex doesn't
    // accept reference images, so style consistency comes from text alone).
    // `series.stylePromptOverride` prepends ahead of the universe style so
    // a single series can deviate without forking the universe — mirrors
    // server-side `applyWorldStyle` in visualStages.js.
    const userPrompt = `${entry.name}: ${description}`;
    const styled = composeStyledPrompt(
      userPrompt,
      baseOpts.negativePrompt || '',
      universeStylePreset(universe, series),
    );
    // Durable section-local render tag (#1362): the server resolves the
    // universe collection + appends the finished render to the entry's
    // `imageRefs[]` via `appendEntryImageRef`, so the client no longer PATCHes
    // on completion (see handleRefCompleted).
    const universeRun = buildUniverseSectionRenderTag(universe, kind.key, entry);
    const payload = {
      ...baseOpts,
      prompt: styled.prompt,
      negativePrompt: styled.negativePrompt || undefined,
      ...(universeRun ? { universeRun } : {}),
    };
    const queued = await generateImage(payload, { silent: true })
      .catch((err) => { toast.error(err.message || 'Render failed'); return null; });
    if (!queued?.jobId || !mountedRef.current) return;
    setRenderingJobs((prev) => ({ ...prev, [entry.id]: queued.jobId }));
    toast.success(`Rendering reference for ${entry.name}`);
  };

  const handleRenderCleanPlate = async (kind, entry) => {
    // Match CanonCard's button-enable predicate (descFor includes palette +
    // recurringDetails for settings) — composeCleanPlatePrompt builds a valid
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
    const styled = composeStyledPrompt(
      plate.prompt,
      plate.negativePrompt,
      universeStylePreset(universe, series),
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

  // Clear the spinner + optimistically mirror the completed render onto the
  // entry's `imageRefs[]`. As of #1362 the section-local render carries a
  // durable `universeRun.entryRef` tag, so the server-side
  // `appendEntryImageRef` completion hook persists the ref — the client no
  // longer PATCHes here (a full-array `updateUniverse` would be redundant and
  // could clobber a concurrent sibling append with a stale list). The optimistic
  // stamp is dedup-guarded (`includes`) and last-N capped to mirror the durable
  // write; functional `setUniverse` reads the freshest draft so back-to-back
  // sibling completions chain instead of clobbering.
  const handleRefCompleted = useCallback((kindKey, entryId, filename) => {
    setRenderingJobs((prev) => {
      if (!prev[entryId]) return prev;
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    if (!filename) return;
    setUniverse((cur) => {
      if (!cur) return cur;
      const list = Array.isArray(cur[kindKey]) ? cur[kindKey] : [];
      const nextList = list.map((e) => {
        if (e?.id !== entryId) return e;
        const refs = Array.isArray(e.imageRefs) ? e.imageRefs : [];
        if (refs.includes(filename)) return e;
        return { ...e, imageRefs: capImageRefs([...refs, filename]) };
      });
      return { ...cur, [kindKey]: nextList };
    });
  }, [setUniverse]);

  // Inline-edit channel for canon fields the user picks directly (today:
  // setting intExt + timeOfDay chips). Optimistic — UI updates before the
  // server roundtrip so chip clicks feel instant.
  const { patchEntry: handlePatchEntry } = useCanonPatch({
    universe, apply: setUniverse, mountedRef,
  });

  const handleRefFailed = useCallback((entryId, errMsg) => {
    setRenderingJobs((prev) => {
      if (!prev[entryId]) return prev;
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    if (errMsg) toast.error(`Render failed: ${errMsg}`);
  }, []);

  if (!series) {
    return <p className="text-sm text-gray-500 italic">Loading series…</p>;
  }
  if (!series.universeId) {
    return (
      <div className="rounded-lg border border-port-warning/40 bg-port-warning/5 p-4 space-y-2">
        <h2 className="text-base font-semibold text-white">Link this series to a universe</h2>
        <p className="text-xs text-gray-400">
          Canon (characters, places, objects) lives on the linked universe so it can be
          shared across crossover series. This series isn't linked yet — open the series
          page and pick or create a universe to populate canon from this issue's prose.
        </p>
      </div>
    );
  }
  if (!universe) {
    return (
      <p className="text-sm text-gray-500 italic inline-flex items-center gap-2">
        <Loader2 size={14} className="animate-spin" /> Loading universe canon…
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white">Nouns</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            People, places, and things that appear in this issue. Canon lives on the
            linked universe — extracts and edits here propagate to every series in
            that universe.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={openSettings}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-port-card border border-port-border text-gray-300 text-xs hover:border-port-accent/50 hover:text-white"
            title={`Reference image gen settings — backend: ${imageCfg.mode}`}
          >
            <SettingsIcon size={12} /> Image gen
          </button>
          {/* Per-attempt provider/model override. Empty = series default, so a
              first extract behaves exactly as before; the user only reaches for
              these when retrying after a provider failure. */}
          <select
            value={extractProvider}
            onChange={(e) => { setExtractProvider(e.target.value); setExtractModel(''); }}
            disabled={extracting}
            title="AI provider for extraction"
            aria-label="Extraction provider"
            className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs disabled:opacity-40"
          >
            <option value="">Series default ({providerLabel(seriesDefaultProviderId)})</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <select
            value={extractModel}
            onChange={(e) => setExtractModel(e.target.value)}
            disabled={extracting || extractProviderModels.length === 0}
            title="Model for extraction"
            aria-label="Extraction model"
            className="bg-port-bg border border-port-border rounded px-2 py-1.5 text-white text-xs disabled:opacity-40 max-w-[160px]"
          >
            <option value="">Default model</option>
            {extractProviderModels.map((m) => {
              const mid = typeof m === 'string' ? m : m.id;
              const label = typeof m === 'string' ? m : (m.name || m.id);
              return <option key={mid} value={mid}>{label}</option>;
            })}
          </select>
          <button
            type="button"
            onClick={handleExtract}
            disabled={extracting || !proseReady}
            title={proseReady ? 'Extract characters, settings, and objects from the prose' : 'Generate prose first'}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-40"
          >
            {extracting ? <Loader2 size={14} className="animate-spin" /> : <Library size={14} />}
            {canonExtraction && canonExtraction.status !== 'ok' ? 'Retry extraction' : 'Extract from prose'}
          </button>
          <button
            type="button"
            onClick={handleDescribeFromProse}
            disabled={describing || !proseReady || missingTargets.length === 0}
            title={missingTargets.length
              ? `Write descriptions for ${missingTargets.length} undescribed noun${missingTargets.length === 1 ? '' : 's'} using ONLY what the prose says — nouns the prose can't describe are flagged, not invented`
              : (proseReady ? 'Every noun that appears in this issue already has a description' : 'Generate prose first')}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-card border border-port-border text-gray-200 text-sm font-medium disabled:opacity-40 hover:border-port-accent/50 hover:text-white"
          >
            {describing ? <Loader2 size={14} className="animate-spin" /> : <FileSearch size={14} />}
            Describe from prose{missingTargets.length ? ` (${missingTargets.length})` : ''}
          </button>
        </div>
      </header>

      {canonExtraction && canonExtraction.status !== 'ok' ? (
        <CanonExtractionBanner extraction={canonExtraction} />
      ) : null}

      {descGaps ? <DescGapBanner gaps={descGaps} /> : null}

      {!proseReady ? (
        <p className="text-sm text-gray-400 italic">
          Generate the prose stage first, then come back here to extract and curate the nouns.
        </p>
      ) : null}

      {KINDS.map((kind) => (
        <KindSection
          key={kind.key}
          kind={kind}
          all={universe[kind.key] || []}
          prose={prose}
          renderingJobs={renderingJobs}
          onRender={(entry) => handleRenderRef(kind, entry)}
          onJobCompleted={(entryId, filename) => handleRefCompleted(kind.key, entryId, filename)}
          onJobFailed={handleRefFailed}
          onPreview={openPreview}
          onRefine={handleRefineCharacter}
          refiningCharacterId={refiningCharacterId}
          onPatchEntry={(entryId, patch) => handlePatchEntry(kind, entryId, patch)}
          onRenderCleanPlate={(entry) => handleRenderCleanPlate(kind, entry)}
          seriesNameMap={seriesNameMap}
        />
      ))}

      <Drawer open={settingsOpen} onClose={closeSettings} title="Reference image gen" size="md">
        <ImageGenSettingsForm
          value={imageCfg}
          onChange={persistImageCfg}
          models={imageModels}
          availableBackends={availableBackends}
          grouped
        />
      </Drawer>

      <MediaPreview preview={preview} setPreview={setPreview} items={previewItems} />
    </div>
  );
}

// Persisted failure/partial banner for the prose→canon extraction. `partial`
// (some kinds landed, others failed — e.g. Codex safety-refused `object`) is a
// warning; `failed` (nothing extracted) is an error. Both name the failed
// kinds + the provider/model used and tell the user to retry with a different
// model via the picker above.
function CanonExtractionBanner({ extraction }) {
  const partial = extraction.status === 'partial';
  const failed = (extraction.failedKinds || []).join(', ') || 'extraction';
  const used = [extraction.provider, extraction.model].filter(Boolean).join(' / ') || 'the configured model';
  const tone = partial
    ? 'border-port-warning/40 bg-port-warning/5 text-port-warning'
    : 'border-port-error/40 bg-port-error/5 text-port-error';
  return (
    <div className={`rounded-lg border p-3 flex items-start gap-2 ${tone}`} role="alert">
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <div className="space-y-1 min-w-0">
        <p className="text-sm font-medium">
          {partial
            ? `Some canon extracted, but ${failed} failed with ${used}.`
            : `Canon extraction failed with ${used}.`}
        </p>
        {extraction.error ? (
          <p className="text-xs text-gray-400 break-words">{extraction.error}</p>
        ) : null}
        <p className="text-xs text-gray-400">
          Pick a different provider/model above and retry — the entries that already
          landed are kept.
        </p>
      </div>
    </div>
  );
}

// Persistent manuscript-quality red flag from the last "Describe from prose"
// run. `none` = the prose names the noun but never describes it (the headline
// signal that the manuscript is thin); `thin` = only a passing detail, could
// use more. Both survive reload via the persisted `stage.descGaps` marker.
function DescGapBanner({ gaps }) {
  const none = Array.isArray(gaps.none) ? gaps.none : [];
  const thin = Array.isArray(gaps.thin) ? gaps.thin : [];
  if (none.length === 0 && thin.length === 0) return null;
  const total = none.length + thin.length;
  return (
    <div className="rounded-lg border border-port-warning/40 bg-port-warning/5 p-3 space-y-2" role="alert">
      <div className="flex items-start gap-2 text-port-warning">
        <AlertTriangle size={16} className="mt-0.5 shrink-0" />
        <p className="text-sm font-medium">
          The manuscript is thin on description for {total} noun{total === 1 ? '' : 's'}.
          Enrich the prose, then re-run “Describe from prose”.
        </p>
      </div>
      {none.length ? (
        <div className="text-xs text-gray-300">
          <span className="uppercase tracking-wider text-[10px] text-port-warning">Not described in prose</span>
          <ul className="mt-1 space-y-1">
            {none.map((g) => (
              <li key={g.id}>
                <span className="text-white">{g.name}</span>{' '}
                <span className="text-gray-500">({g.kind})</span>
                {g.note ? <span className="text-gray-400"> — {g.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {thin.length ? (
        <div className="text-xs text-gray-400">
          <span className="uppercase tracking-wider text-[10px] text-gray-500">Only thinly described</span>
          <ul className="mt-1 space-y-1">
            {thin.map((g) => (
              <li key={g.id}>
                <span className="text-gray-200">{g.name}</span>{' '}
                <span className="text-gray-600">({g.kind})</span>
                {g.note ? <span className="text-gray-500"> — {g.note}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function KindSection({ kind, all, prose, renderingJobs, onRender, onJobCompleted, onJobFailed, onPreview, onRefine, refiningCharacterId, onPatchEntry, onRenderCleanPlate, seriesNameMap }) {
  const Icon = kind.icon;
  const inIssue = useMemo(() => kind.match(prose, all), [prose, all, kind]);
  const inIssueIds = useMemo(() => new Set(inIssue.map((e) => e.id || e.name)), [inIssue]);
  const others = useMemo(
    () => all.filter((e) => !inIssueIds.has(e.id || e.name)),
    [all, inIssueIds],
  );
  const [showOthers, setShowOthers] = useState(false);

  return (
    <section className="rounded-lg border border-port-border bg-port-card/40">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-port-border">
        <Icon size={14} className="text-gray-400" />
        <h3 className="text-sm font-semibold text-white">{kind.label}</h3>
        <span className="text-[10px] text-gray-500">
          {inIssue.length} in issue · {all.length} total
        </span>
      </div>

      <div className="p-3 space-y-3">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">
            Appears in this issue
          </div>
          {inIssue.length === 0 ? (
            <p className="text-xs text-gray-500 italic">
              No matches yet. Extract from prose, or check that bible names line up with how the prose refers to them.
            </p>
          ) : (
            <ul className="space-y-2">
              {inIssue.map((entry) => (
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
                  refining={refiningCharacterId === entry.id}
                  refineDisabled={!!refiningCharacterId && refiningCharacterId !== entry.id}
                  onPatchEntry={onPatchEntry}
                  onRenderCleanPlate={onRenderCleanPlate}
                  seriesNameMap={seriesNameMap}
                />
              ))}
            </ul>
          )}
        </div>

        {others.length > 0 ? (
          <details open={showOthers} onToggle={(e) => setShowOthers(e.currentTarget.open)}>
            <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-gray-500 hover:text-white flex items-center gap-1">
              {showOthers ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
              Other series canon ({others.length})
            </summary>
            <ul className="space-y-2 mt-2">
              {others.map((entry) => (
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
                  refining={refiningCharacterId === entry.id}
                  refineDisabled={!!refiningCharacterId && refiningCharacterId !== entry.id}
                  onPatchEntry={onPatchEntry}
                  onRenderCleanPlate={onRenderCleanPlate}
                  seriesNameMap={seriesNameMap}
                />
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}


/**
 * Nouns stage — per-issue canonical-noun curation.
 *
 * UI-only pseudo-stage between Prose and Comic Pages. No server stage record;
 * data lives on the series bible (`series.characters / .settings / .objects`).
 * Two operations:
 *   1. Extract bibles from this issue's prose (wraps the existing
 *      /pipeline/series/:id/extract-bible endpoint).
 *   2. Render a canonical reference image per noun and pin the resulting
 *      filename onto the entry's `imageRefs[]` via a series PATCH.
 *
 * The renderer (server/services/pipeline/visualStages.js) reads these bibles
 * and cites the rich descriptions in every comic-page prompt — that's the
 * mechanism that keeps "Wren" and "the navy woman" looking consistent across
 * pages, since Codex can't accept reference images directly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Library, Loader2, Users, MapPin, Package,
  ImagePlus, Settings as SettingsIcon, ChevronDown, ChevronRight, WandSparkles,
} from 'lucide-react';
import toast from '../../ui/Toast';
import { extractPipelineBibles, updatePipelineSeries, refinePipelineCharacter } from '../../../services/api';
import { getUniverse } from '../../../services/apiUniverseBuilder';
import { getSettings, updateSettings, generateImage } from '../../../services/apiSystem';
import { listImageModels } from '../../../services/apiImageVideo';
import {
  matchCharactersInText, matchSettingsInText, matchObjectsInText,
} from '../../../lib/scenePrompt';
import { composeStyledPrompt } from '../../../lib/composeStyledPrompt';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import useMounted from '../../../hooks/useMounted';
import useMediaJobProgress from '../../../hooks/useMediaJobProgress';
import MediaJobThumb from '../MediaJobThumb';
import MediaPreview from '../../media/MediaPreview';
import Drawer from '../../Drawer';
import ImageGenSettingsForm from '../../imageGen/ImageGenSettingsForm';
import { deriveAvailableBackends } from '../../../lib/imageGenBackends';
import {
  PIPELINE_IMAGE_DEFAULTS,
  readPipelineImageSettings,
  pipelineImageCfgToRenderOpts,
} from '../../../lib/pipelineImageDefaults';

// Per-kind metadata. `descFor` picks the most visual field for ref-image
// generation; `match` is the prose scanner that decides whether an entry
// "appears in this issue".
const KINDS = [
  {
    key: 'characters', label: 'Characters', singular: 'character', icon: Users,
    descFor: (c) => c.physicalDescription || c.description || '',
    match: matchCharactersInText,
  },
  {
    key: 'settings', label: 'Settings', singular: 'setting', icon: MapPin,
    descFor: (s) => [
      s.description,
      s.palette ? `Palette: ${s.palette}` : '',
      s.recurringDetails,
    ].filter(Boolean).join('. '),
    match: matchSettingsInText,
  },
  {
    key: 'objects', label: 'Objects', singular: 'object', icon: Package,
    descFor: (o) => o.description || o.significance || '',
    match: matchObjectsInText,
  },
];

export default function NounsStage({ issue, series, onSeriesUpdate }) {
  const mountedRef = useMounted();
  const prose = (issue.stages?.prose?.output || '').trim();
  const proseReady = prose.length > 0;

  const [imageCfg, setImageCfg] = useState(PIPELINE_IMAGE_DEFAULTS);
  const [imageModels, setImageModels] = useState([]);
  const [sysSettings, setSysSettings] = useState(null);
  const [universe, setUniverse] = useState(null);
  // Per-entry in-flight render: { [entryId]: jobId }. NounCard subscribes to
  // job progress and surfaces MediaJobThumb until completion — the entry's
  // imageRefs[] is only PATCHed onto the series when the job actually
  // finishes, so we never render broken <img>s for files that don't exist yet.
  const [renderingJobs, setRenderingJobs] = useState({});
  // Shared lightbox state — a flat items list across every kind's imageRefs
  // powers prev/next nav so the user can page through every reference image
  // in the series without closing/reopening.
  const [preview, setPreview] = useState(null);
  const previewItems = useMemo(() => {
    const items = [];
    for (const kind of KINDS) {
      const list = Array.isArray(series?.[kind.key]) ? series[kind.key] : [];
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
  }, [series]);
  const openPreview = useCallback((filename) => {
    if (!filename) return;
    const match = previewItems.find((i) => i.filename === filename);
    if (match) setPreview(match);
  }, [previewItems]);

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

  // Fetch the linked universe so reference renders inherit the same
  // stylePrompt + negativePrompt the comic-page renderer uses. Codex can't
  // accept reference images, so a consistent aesthetic is the only knob
  // keeping ref images and comic pages visually coherent.
  useEffect(() => {
    if (!series?.universeId) { setUniverse(null); return; }
    let cancelled = false;
    getUniverse(series.universeId).then((w) => {
      if (cancelled || !mountedRef.current) return;
      setUniverse(w || null);
    }).catch(() => { if (mountedRef.current) setUniverse(null); });
    return () => { cancelled = true; };
  }, [series?.universeId, mountedRef]);

  const persistImageCfg = useCallback(async (next) => {
    setImageCfg(next);
    const current = await getSettings().catch(() => ({}));
    await updateSettings({
      ...current,
      pipeline: { ...(current.pipeline || {}), imageGen: next },
    }).catch((err) => toast.error(`Settings save failed: ${err.message}`));
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

  const [runExtract, extracting] = useAsyncAction(
    () => extractPipelineBibles(series.id, { issueId: issue.id }),
    { errorMessage: 'Extraction failed' },
  );

  // Per-character in-flight refine. Tracking by id (not a single bool) so
  // the user can fire refines in serial without the spinner jumping cards.
  const [refiningCharacterId, setRefiningCharacterId] = useState(null);
  const handleRefineCharacter = useCallback(async (entryId) => {
    if (!series || refiningCharacterId) return;
    setRefiningCharacterId(entryId);
    const providerId = series.llm?.provider || undefined;
    const model = series.llm?.model || undefined;
    const result = await refinePipelineCharacter(series.id, entryId, { providerId, model })
      .catch((err) => { toast.error(err.message || 'Refine failed'); return null; });
    if (mountedRef.current) setRefiningCharacterId(null);
    if (!result || !mountedRef.current) return;
    onSeriesUpdate?.(result.series);
    const summary = result.rationale || (result.changes?.[0] ? result.changes[0] : 'description rewritten');
    toast.success(`Refined description — ${summary.slice(0, 140)}`);
  }, [series, refiningCharacterId, onSeriesUpdate, mountedRef]);

  const handleExtract = async () => {
    if (!series || !proseReady) return;
    const result = await runExtract();
    if (!result || !mountedRef.current) return;
    onSeriesUpdate?.(result.series);
    const counts = KINDS
      .map((k) => `${result.series[k.key]?.length ?? 0} ${k.key}`)
      .join(', ');
    toast.success(`Bibles updated — ${counts}`);
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
    const userPrompt = `${entry.name}: ${description}`;
    const styled = composeStyledPrompt(
      userPrompt,
      baseOpts.negativePrompt || '',
      universe ? { prompt: universe.stylePrompt, negativePrompt: universe.negativePrompt } : null,
    );
    const payload = {
      ...baseOpts,
      prompt: styled.prompt,
      negativePrompt: styled.negativePrompt || undefined,
    };
    const queued = await generateImage(payload)
      .catch((err) => { toast.error(err.message || 'Render failed'); return null; });
    if (!queued?.jobId || !mountedRef.current) return;
    setRenderingJobs((prev) => ({ ...prev, [entry.id]: queued.jobId }));
    toast.success(`Rendering reference for ${entry.name}`);
  };

  // Pin a freshly-completed render onto the series bible. Server replaces the
  // full bible array on PATCH, so we send the kind's full list with this
  // entry mutated. Single-user app — no race here.
  const handleRefCompleted = useCallback(async (kindKey, entryId, filename) => {
    if (!filename) return;
    setRenderingJobs((prev) => {
      if (!prev[entryId]) return prev;
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    const list = (series[kindKey] || []).map((e) =>
      e.id === entryId
        ? { ...e, imageRefs: [...(e.imageRefs || []), filename] }
        : e,
    );
    const updated = await updatePipelineSeries(series.id, { [kindKey]: list })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    if (updated && mountedRef.current) onSeriesUpdate?.(updated);
  }, [series, onSeriesUpdate, mountedRef]);

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

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold text-white">Nouns</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Canonical references for the people, places, and things in this issue.
            The comic-page renderer cites these descriptions to keep characters and
            settings visually consistent page-to-page.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openSettings}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg bg-port-card border border-port-border text-gray-300 text-xs hover:border-port-accent/50 hover:text-white"
            title={`Reference image gen settings — backend: ${imageCfg.mode}`}
          >
            <SettingsIcon size={12} /> Image gen
          </button>
          <button
            type="button"
            onClick={handleExtract}
            disabled={extracting || !proseReady}
            title={proseReady ? 'Extract characters, settings, and objects from the prose' : 'Generate prose first'}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-port-accent text-white text-sm font-medium disabled:opacity-40"
          >
            {extracting ? <Loader2 size={14} className="animate-spin" /> : <Library size={14} />}
            Extract from prose
          </button>
        </div>
      </header>

      {!proseReady ? (
        <p className="text-sm text-gray-400 italic">
          Generate the prose stage first, then come back here to extract and curate the nouns.
        </p>
      ) : null}

      {KINDS.map((kind) => (
        <KindSection
          key={kind.key}
          kind={kind}
          all={series[kind.key] || []}
          prose={prose}
          renderingJobs={renderingJobs}
          onRender={(entry) => handleRenderRef(kind, entry)}
          onJobCompleted={(entryId, filename) => handleRefCompleted(kind.key, entryId, filename)}
          onJobFailed={handleRefFailed}
          onPreview={openPreview}
          onRefine={handleRefineCharacter}
          refiningCharacterId={refiningCharacterId}
        />
      ))}

      <Drawer open={settingsOpen} onClose={closeSettings} title="Reference image gen">
        <ImageGenSettingsForm
          value={imageCfg}
          onChange={persistImageCfg}
          models={imageModels}
          availableBackends={availableBackends}
        />
      </Drawer>

      <MediaPreview preview={preview} setPreview={setPreview} items={previewItems} />
    </div>
  );
}

function KindSection({ kind, all, prose, renderingJobs, onRender, onJobCompleted, onJobFailed, onPreview, onRefine, refiningCharacterId }) {
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
                <NounCard
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
                <NounCard
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
                />
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function NounCard({ kind, entry, inFlightJobId, onRender, onJobCompleted, onJobFailed, onPreview, onRefine, refining = false, refineDisabled = false }) {
  const description = kind.descFor(entry);
  const refs = Array.isArray(entry.imageRefs) ? entry.imageRefs : [];

  // Subscribe to the in-flight job so we can fire onJobCompleted exactly
  // once when the render finishes. MediaJobThumb opens its own subscription
  // for visuals; both are filtered by jobId so they coexist without
  // cross-talk. settledRef prevents duplicate completion callbacks under
  // React 18 StrictMode's mount→cleanup→mount double-fire in dev.
  const { status, filename, error } = useMediaJobProgress(inFlightJobId);
  const settledRef = useRef(null);
  useEffect(() => {
    if (!inFlightJobId) { settledRef.current = null; return; }
    if (settledRef.current === inFlightJobId) return;
    if (status === 'completed' && filename) {
      settledRef.current = inFlightJobId;
      onJobCompleted?.(entry.id, filename);
    } else if (status === 'failed' || status === 'canceled') {
      settledRef.current = inFlightJobId;
      onJobFailed?.(entry.id, error || status);
    }
  }, [inFlightJobId, status, filename, error, entry.id, onJobCompleted, onJobFailed]);

  return (
    <li className="rounded border border-port-border bg-port-bg/60 p-2">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-white font-medium truncate">{entry.name}</span>
            {entry.aliases?.length ? (
              <span className="text-[10px] text-gray-500 truncate">
                aka {entry.aliases.join(', ')}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-gray-400 mt-1 line-clamp-3 whitespace-pre-wrap">
            {description || <em className="text-gray-600">No description yet.</em>}
          </p>
        </div>
        <div className="shrink-0 flex flex-col gap-1 items-stretch">
          {kind.key === 'characters' && onRefine ? (
            <button
              type="button"
              onClick={() => onRefine(entry.id)}
              disabled={refining || refineDisabled}
              className="inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
              title={`Rewrite ${entry.name}'s description so they render distinct from every other character`}
            >
              {refining ? <Loader2 size={10} className="animate-spin" /> : <WandSparkles size={10} />}
              AI: differentiate
            </button>
          ) : null}
          <button
            type="button"
            onClick={onRender}
            disabled={!description.trim() || !!inFlightJobId}
            className="inline-flex items-center justify-center gap-1 px-2 py-1 text-[10px] rounded border border-port-border text-gray-300 hover:bg-port-border/40 hover:text-white disabled:opacity-40"
            title={description.trim() ? `Render a canonical reference image for ${entry.name}` : 'Add a description first'}
          >
            {inFlightJobId ? <Loader2 size={10} className="animate-spin" /> : <ImagePlus size={10} />}
            Render reference
          </button>
        </div>
      </div>
      {(refs.length > 0 || inFlightJobId) ? (
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {inFlightJobId ? (
            <MediaJobThumb jobId={inFlightJobId} label={`${entry.name} reference`} size="sm" />
          ) : null}
          {refs.map((ref) => (
            <button
              key={ref}
              type="button"
              onClick={() => onPreview?.(ref)}
              title={ref}
              className="w-16 h-16 bg-port-bg rounded overflow-hidden border border-port-border hover:border-port-accent/50 cursor-zoom-in p-0"
            >
              <img
                src={`/data/images/${ref}`}
                alt={`${entry.name} reference`}
                className="w-full h-full object-cover"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

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
  Settings as SettingsIcon, ChevronDown, ChevronRight,
} from 'lucide-react';
import toast from '../../ui/Toast';
import {
  getUniverse, updateUniverse,
  extractUniverseCanon, refineUniverseCharacter,
} from '../../../services/apiUniverseBuilder';
import { getSettings, updateSettings, generateImage } from '../../../services/apiSystem';
import { listImageModels } from '../../../services/apiImageVideo';
import {
  matchCharactersInText, matchSettingsInText, matchObjectsInText,
} from '../../../lib/scenePrompt';
import { composeStyledPrompt } from '../../../lib/composeStyledPrompt';
import { composeCleanPlatePrompt } from '../../../lib/cleanPlatePrompt';
import { universeStylePreset } from '../../../lib/universeStylePreset';
import useMounted from '../../../hooks/useMounted';
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

export default function NounsStage({ issue, series }) {
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
  // without closing/reopening.
  const [preview, setPreview] = useState(null);

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

  const [extracting, setExtracting] = useState(false);

  // Per-character in-flight refine. Tracking by id (not a single bool) so
  // the user can fire refines in serial without the spinner jumping cards.
  const [refiningCharacterId, setRefiningCharacterId] = useState(null);
  const handleRefineCharacter = useCallback(async (entryId) => {
    if (!universe || refiningCharacterId) return;
    setRefiningCharacterId(entryId);
    const providerId = series.llm?.provider || undefined;
    const model = series.llm?.model || undefined;
    const result = await refineUniverseCharacter(universe.id, entryId, { providerId, model })
      .catch((err) => { toast.error(err.message || 'Refine failed'); return null; });
    if (mountedRef.current) setRefiningCharacterId(null);
    if (!result || !mountedRef.current) return;
    if (result.universe) setUniverse(result.universe);
    const summary = result.rationale || (result.changes?.[0] ? result.changes[0] : 'description rewritten');
    toast.success(`Refined description — ${summary.slice(0, 140)}`);
  }, [universe, series, refiningCharacterId, mountedRef]);

  const handleExtract = async () => {
    if (!universe || !proseReady) return;
    setExtracting(true);
    const result = await extractUniverseCanon(universe.id, { corpus: prose })
      .catch((err) => { toast.error(err.message || 'Extraction failed'); return null; });
    if (mountedRef.current) setExtracting(false);
    if (!result || !mountedRef.current) return;
    if (result.universe) setUniverse(result.universe);
    const counts = KINDS
      .map((k) => `${result.universe?.[k.key]?.length ?? 0} ${k.key}`)
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
    // `series.stylePromptOverride` prepends ahead of the universe style so
    // a single series can deviate without forking the universe — mirrors
    // server-side `applyWorldStyle` in visualStages.js.
    const userPrompt = `${entry.name}: ${description}`;
    const styled = composeStyledPrompt(
      userPrompt,
      baseOpts.negativePrompt || '',
      universeStylePreset(universe, series),
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

  const handleRenderCleanPlate = async (entry) => {
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
    const queued = await generateImage({
      ...baseOpts,
      prompt: styled.prompt,
      negativePrompt: styled.negativePrompt || undefined,
    }).catch((err) => { toast.error(err.message || 'Clean plate render failed'); return null; });
    if (!queued?.jobId || !mountedRef.current) return;
    setRenderingJobs((prev) => ({ ...prev, [entry.id]: queued.jobId }));
    toast.success(`Rendering clean plate for ${entry.name}`);
  };

  // Pin a freshly-completed render onto the universe's imageRefs[]. Server
  // replaces the full kind list on PATCH, so we send the entire kind array
  // with this entry mutated. Single-user app — no race.
  const handleRefCompleted = useCallback(async (kindKey, entryId, filename) => {
    if (!filename || !universe) return;
    setRenderingJobs((prev) => {
      if (!prev[entryId]) return prev;
      const next = { ...prev };
      delete next[entryId];
      return next;
    });
    const list = (universe[kindKey] || []).map((e) =>
      e.id === entryId
        ? { ...e, imageRefs: [...(e.imageRefs || []), filename] }
        : e,
    );
    const updated = await updateUniverse(universe.id, { [kindKey]: list })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    if (updated && mountedRef.current) setUniverse(updated);
  }, [universe, mountedRef]);

  // Inline-edit channel for canon fields the user picks directly (today:
  // setting intExt + timeOfDay chips). Optimistic — UI updates before the
  // server roundtrip so chip clicks feel instant.
  const handlePatchEntry = useCallback(async (kind, entryId, patch) => {
    if (!universe || !patch || typeof patch !== 'object') return;
    const kindKey = kind.key;
    const list = (universe[kindKey] || []).map((e) =>
      e.id === entryId ? { ...e, ...patch } : e,
    );
    setUniverse((prev) => prev ? { ...prev, [kindKey]: list } : prev);
    const updated = await updateUniverse(universe.id, { [kindKey]: list })
      .catch((err) => { toast.error(`Save failed: ${err.message}`); return null; });
    if (updated && mountedRef.current) setUniverse(updated);
  }, [universe, mountedRef]);

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
          onRenderCleanPlate={handleRenderCleanPlate}
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

function KindSection({ kind, all, prose, renderingJobs, onRender, onJobCompleted, onJobFailed, onPreview, onRefine, refiningCharacterId, onPatchEntry, onRenderCleanPlate }) {
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
                />
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}


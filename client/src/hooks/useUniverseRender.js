import { useState } from 'react';
import toast from '../components/ui/Toast';
import { listWorldRuns, renderWorld } from '../services/api';
import { useLocalStoragePersisted } from './useLocalStorageBool';
import { useRenderJobQueue } from './useRenderJobQueue';
import { renderPromptCount, scopedPromptCount } from '../lib/universeBuilderCounts';
import { DEFAULT_RENDER_OPTS, TRUNK_TABS } from '../lib/universeBuilderShared';
import { pluralize } from '../lib/textUtils';

/**
 * Owns Universe Builder batch-render configuration and queue orchestration.
 * Inline tab/panel render buttons all call the same runRender contract, while
 * the per-entry queue tracks variation/canon jobs until their thumbnails land.
 */
export default function useUniverseRender({
  selectedId,
  draft,
  availableBackends,
  defaultMode,
  runs,
  setRuns,
  // Same contract as `useUniverseAction`'s `preflight`: runs after the cheap
  // guards, owns its own error toast, and a falsy return aborts the action.
  // Required here rather than optional — `/render` compiles prompts from the
  // SERVER's copy of the universe while every count/label in the scope comes
  // from the in-memory draft, so skipping the flush renders an unsaved
  // variation's stale prompt, or 400s with WORLD_BUILDER_EMPTY ("No prompts to
  // render") on one the UI is showing. A caller that forgets it should fail
  // loudly, not silently regress.
  preflight,
  // `useUniverseDraft`'s entry-id reconcile, run once per successful render.
  // Optional so a caller that only needs the render form isn't forced to wire
  // it; without it, a legacy universe's first render simply doesn't animate.
  syncEntryIdsFromServer = null,
}) {
  const [rendering, setRendering] = useState(false);
  const [renderOpts, setRenderOpts] = useLocalStoragePersisted(
    'universeBuilder.renderOpts',
    DEFAULT_RENDER_OPTS,
    { parse: (raw) => ({ ...DEFAULT_RENDER_OPTS, ...(raw || {}) }) },
  );
  const {
    pendingHeadByEntryId,
    clearPendingForEntry,
    enqueueEntryJobs,
  } = useRenderJobQueue();

  const runRender = async (scope = null) => {
    if (!selectedId) {
      toast.error('Save the world first');
      return;
    }
    const promptMode = scope?.promptMode || renderOpts.promptMode || 'variations';
    const total = scope
      ? scopedPromptCount(draft, scope)
      : renderPromptCount(draft, promptMode);
    if (!total) {
      toast.error('No prompts — expand the template first');
      return;
    }
    if (availableBackends.length === 0) {
      toast.error('Configure an image-gen backend first');
      return;
    }
    // After the cheap guards so a doomed click doesn't trigger a write.
    if (!(await preflight())) return;
    const effectiveMode = renderOpts.mode || defaultMode || undefined;
    const numericOrUndefined = (value) => {
      if (value === '' || value == null) return undefined;
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : undefined;
    };
    const needsCanonDefault = !scope && (promptMode === 'canon' || promptMode === 'all');
    const effectiveCanonSelection = scope?.canonSelection
      ?? (needsCanonDefault
        ? Object.fromEntries(TRUNK_TABS.map((trunk) => [trunk.kind, 'all']))
        : undefined);
    const seedRaw = renderOpts.seed;
    const seedNumber = seedRaw === '' || seedRaw == null ? null : Number(seedRaw);
    const seed = Number.isFinite(seedNumber) && seedNumber >= 0
      ? Math.trunc(seedNumber)
      : undefined;
    const loras = Array.isArray(renderOpts.loras) && renderOpts.loras.length
      ? renderOpts.loras
      : undefined;

    setRendering(true);
    const result = await renderWorld(selectedId, {
      mode: effectiveMode,
      modelId: renderOpts.modelId || undefined,
      width: renderOpts.width,
      height: renderOpts.height,
      steps: numericOrUndefined(renderOpts.steps),
      guidance: numericOrUndefined(renderOpts.guidance),
      cfgScale: numericOrUndefined(renderOpts.cfgScale),
      quantize: renderOpts.quantize || undefined,
      promptMode,
      batchPerVariation: renderOpts.batchPerVariation,
      selection: scope?.selection,
      sheetSelection: scope?.sheetSelection,
      canonSelection: effectiveCanonSelection,
      seed,
      negativePrompt: renderOpts.negativePrompt?.trim() || undefined,
      extraStyle: renderOpts.extraStyle?.trim() || undefined,
      stylePresetId: renderOpts.stylePreset?.id || undefined,
      loras,
    }, { silent: true }).catch((error) => { toast.error(`Render failed: ${error.message}`); return null; });
    setRendering(false);
    if (!result) return;

    // BEFORE enqueueing: `/render` migrates a universe whose entries predate
    // persisted ids, minting a real set that these jobs are keyed by — while the
    // draft still holds the transient ids its own GET produced. Reconcile first
    // so every row can match its own job the moment the spinner would start.
    await syncEntryIdsFromServer?.();
    enqueueEntryJobs(result.entryJobs);
    toast.success(`Queued ${pluralize(result.promptCount, 'render')} → "${result.collectionName}"`);
    const updatedRuns = await listWorldRuns(selectedId).catch(() => runs);
    setRuns(updatedRuns);
  };

  return {
    canRender: !!selectedId && availableBackends.length > 0 && !rendering,
    clearPendingForEntry,
    handleRender: runRender,
    pendingHeadByEntryId,
    renderOpts,
    rendering,
    runRender,
    setRenderOpts,
  };
}

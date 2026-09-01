/**
 * FableLoom render orchestration panel.
 *
 * Provides user-triggered batch production planning, DAG asset enumeration,
 * exact-input verification, and batch execution tracking. Continuity review
 * lives in its own workflow tab so a producer never has to hunt below render settings.
 */

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Cloud,
  Cpu,
  Info,
  Layers,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  StopCircle,
} from 'lucide-react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import BackendChipStrip from '../media/BackendChipStrip';
import {
  cancelLoomEpisodeProductionBatch,
  getLoomEpisodeProductionBatch,
  listImageModels,
  listVideoModels,
  planLoomEpisodeProduction,
  resumeLoomEpisodeProductionBatch,
  startLoomEpisodeProductionBatch,
  updateLoom,
} from '../../services/api';
import { fableLoomStoryReadiness } from '../../lib/fableLoomReadiness';
import {
  asFableLoomRenderPreferences,
  asFableLoomRenderSettings,
  FABLELOOM_RENDER_FORMATS,
} from '../../../../server/lib/fableLoomProduction.js';

const IMAGE_BACKENDS = [
  { id: 'auto', label: 'Auto', icon: Layers },
  { id: 'local', label: 'Local', icon: Cpu },
  { id: 'codex', label: 'Codex', icon: Cloud },
  { id: 'grok', label: 'Grok', icon: Cloud },
  { id: 'agy', label: 'Agy', icon: Sparkles },
];

const VIDEO_BACKENDS = [
  { id: 'auto', label: 'Auto', icon: Layers },
  { id: 'local', label: 'Local', icon: Cpu },
  { id: 'grok', label: 'Grok', icon: Cloud },
];

const modelOptions = (models, selected) => {
  const options = (Array.isArray(models) ? models : [])
    .filter((model) => model?.id)
    .map((model) => ({ id: model.id, label: model.name || model.id }));
  if (selected && !options.some((option) => option.id === selected)) {
    return [{ id: selected, label: `${selected} (unavailable)` }, ...options];
  }
  return options;
};

const productionAssetsForScope = (plan, scope) => {
  if (!Array.isArray(plan?.plannedAssets)) return [];
  if (scope === 'images') return plan.plannedAssets.filter((asset) => asset.type === 'image');
  return plan.plannedAssets;
};

const assetIsReady = (asset) => asset.status !== 'blocked' && asset.readiness?.ready !== false;

export default function LoomProductionPanel({ loom, episode, onSelectNode, onLoomUpdate }) {
  const [mode, setMode] = useState('current_canon');
  const [assetScope, setAssetScope] = useState('images');
  const [plan, setPlan] = useState(null);
  const [planKey, setPlanKey] = useState(null);
  const [activeBatchRun, setActiveBatchRun] = useState(null);
  const savedRender = asFableLoomRenderPreferences(loom.renderSettings);
  const [imageMode, setImageMode] = useState(savedRender.imageMode);
  const [imageModel, setImageModel] = useState(savedRender.imageModel);
  const [videoMode, setVideoMode] = useState(savedRender.videoMode);
  const [videoModel, setVideoModel] = useState(savedRender.videoModel);
  const [effort, setEffort] = useState(savedRender.effort);
  const [imageModels, setImageModels] = useState([]);
  const [videoModels, setVideoModels] = useState([]);
  const renderFormat = asFableLoomRenderSettings(loom.renderSettings);
  const productionIdentity = `${loom.id}:${episode.id}`;
  const productionIdentityRef = useRef(productionIdentity);
  productionIdentityRef.current = productionIdentity;
  const planInputKey = JSON.stringify({
    loomId: loom.id,
    episodeId: episode.id,
    formatId: renderFormat.formatId,
    mode,
    imageMode,
    imageModel,
    videoMode,
    videoModel,
    effort,
  });
  const planInputKeyRef = useRef(planInputKey);
  planInputKeyRef.current = planInputKey;
  const planRequestRef = useRef(0);

  const renderOptions = (targetMode = mode) => ({
    mode: targetMode,
    ...(imageMode ? { imageMode } : {}),
    ...(imageModel ? { imageModel } : {}),
    ...(videoMode ? { videoMode } : {}),
    ...(videoModel ? { videoModel } : {}),
    ...(effort ? { effort } : {}),
  });

  const [fetchPlan, planning] = useAsyncAction(async (targetMode = mode) => {
    const requestId = planRequestRef.current + 1;
    planRequestRef.current = requestId;
    const requestKey = JSON.stringify({
      loomId: loom.id,
      episodeId: episode.id,
      formatId: renderFormat.formatId,
      mode: targetMode,
      imageMode,
      imageModel,
      videoMode,
      videoModel,
      effort,
    });
    const res = await planLoomEpisodeProduction(
      loom.id,
      episode.id,
      renderOptions(targetMode),
      { silent: true },
    );
    if (planRequestRef.current !== requestId || planInputKeyRef.current !== requestKey) return;
    setPlan(res);
    setPlanKey(requestKey);
  }, { errorMessage: 'Production planning failed' });

  const [saveRenderFormat, savingRenderFormat] = useAsyncAction(async (formatId) => {
    const updated = await updateLoom(loom.id, { renderSettings: { formatId } }, { silent: true });
    onLoomUpdate?.(updated);
  }, { errorMessage: 'Saving output format failed' });

  useEffect(() => {
    const load = (loader) => (typeof loader === 'function'
      ? Promise.resolve().then(() => loader({ silent: true })).catch(() => [])
      : Promise.resolve([]));
    let mounted = true;
    Promise.all([load(listImageModels), load(listVideoModels)]).then(([images, videos]) => {
      if (!mounted) return;
      setImageModels(images);
      setVideoModels(videos);
    });
    return () => { mounted = false; };
  }, []);

  // Story settings are durable defaults; keep the per-run controls in sync
  // when those defaults change while this panel remains mounted. A one-off
  // panel change does not touch the loom, so it remains an intentional override.
  useEffect(() => {
    setImageMode(savedRender.imageMode);
    setImageModel(savedRender.imageModel);
    setVideoMode(savedRender.videoMode);
    setVideoModel(savedRender.videoModel);
    setEffort(savedRender.effort);
  }, [loom.id, savedRender.imageMode, savedRender.imageModel, savedRender.videoMode, savedRender.videoModel, savedRender.effort]);

  useEffect(() => {
    setPlan(null);
    setPlanKey(null);
    fetchPlan(mode);
  }, [planInputKey]);

  useEffect(() => {
    setActiveBatchRun(null);
  }, [productionIdentity]);

  // Batch run polling
  useEffect(() => {
    if (!activeBatchRun || activeBatchRun.status !== 'in_progress') return undefined;
    const interval = setInterval(() => {
      getLoomEpisodeProductionBatch(
        activeBatchRun.loomId,
        activeBatchRun.episodeId,
        activeBatchRun.id,
        { silent: true },
      )
        .then((updated) => {
          if (!updated) return;
          if (`${updated.loomId}:${updated.episodeId}` !== productionIdentityRef.current) return;
          setActiveBatchRun(updated);
          if (updated.status === 'completed' || updated.status === 'canceled' || updated.status === 'failed') {
            fetchPlan(mode);
          }
        })
        .catch(() => {
          // Polling is best-effort; the next interval can reattach to the run.
        });
    }, 2000);
    return () => clearInterval(interval);
  }, [activeBatchRun, mode]);

  const [startBatch, startingBatch] = useAsyncAction(async () => {
    const requestedIdentity = productionIdentity;
    const res = await startLoomEpisodeProductionBatch(loom.id, episode.id, {
      ...renderOptions(),
      ...(selectedAssetTypes ? { assetTypes: selectedAssetTypes } : {}),
    }, { silent: true });
    if (productionIdentityRef.current === requestedIdentity) setActiveBatchRun(res);
  }, { errorMessage: 'Starting production batch failed' });

  const [cancelBatch, cancelingBatch] = useAsyncAction(async () => {
    if (!activeBatchRun) return;
    const res = await cancelLoomEpisodeProductionBatch(
      activeBatchRun.loomId,
      activeBatchRun.episodeId,
      activeBatchRun.id,
      { silent: true },
    );
    if (`${res.loomId}:${res.episodeId}` === productionIdentityRef.current) setActiveBatchRun(res);
  }, { errorMessage: 'Canceling batch run failed' });

  const [resumeBatch, resumingBatch] = useAsyncAction(async () => {
    if (!activeBatchRun) return;
    const res = await resumeLoomEpisodeProductionBatch(
      activeBatchRun.loomId,
      activeBatchRun.episodeId,
      activeBatchRun.id,
      { silent: true },
    );
    if (`${res.loomId}:${res.episodeId}` === productionIdentityRef.current) setActiveBatchRun(res);
  }, { errorMessage: 'Resuming batch run failed' });

  const scopedAssets = productionAssetsForScope(plan, assetScope);
  const hasAssetList = Array.isArray(plan?.plannedAssets);
  const plannedCount = hasAssetList
    ? scopedAssets.length
    : assetScope === 'images' ? plan?.assetsByType?.image || 0 : plan?.totalAssets || 0;
  const readyCount = hasAssetList
    ? scopedAssets.filter(assetIsReady).length
    : assetScope === 'images' ? plan?.assetsByType?.image || 0 : plan?.readyAssetsCount || 0;
  const renderedCount = hasAssetList
    ? scopedAssets.filter((asset) => asset.status === 'already_rendered' || asset.status === 'skipped').length
    : plan?.alreadyRenderedCount || 0;
  const blockedCount = hasAssetList
    ? scopedAssets.filter((asset) => !assetIsReady(asset)).length
    : assetScope === 'images' ? 0 : plan?.blockedAssetsCount || 0;
  const selectedAssetTypes = assetScope === 'images' ? ['image'] : null;
  const storyReadiness = fableLoomStoryReadiness(loom);

  const readinessBlockers = [
    ...(episode?.nodes?.length && !storyReadiness.ready
      ? [{ message: storyReadiness.reason, nodeId: null }]
      : []),
    ...(plan?.planningIssues || []).map((message) => ({ message, nodeId: null })),
    ...scopedAssets
      .filter((asset) => !assetIsReady(asset))
      .flatMap((asset) => (asset.readiness?.reasons || []).map((message) => ({
        message,
        nodeId: asset.nodeId,
      }))),
  ].filter((item, index, items) => items.findIndex((candidate) => (
    candidate.message === item.message && candidate.nodeId === item.nodeId
  )) === index);
  const canStart = readinessBlockers.length === 0
    && (mode !== 'exact_inputs' || !plan?.exactInputIssues?.length)
    && planKey === planInputKey
    && !planning
    && !savingRenderFormat;

  return (
    <div className="space-y-6">
      {/* 1. Production Mode & Plan Summary */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Layers size={14} className="text-port-accent" />
            Episodic Production Plan
          </h3>
          <button
            type="button"
            onClick={() => fetchPlan(mode)}
            disabled={planning}
            className="text-xs text-port-text-muted hover:text-port-text flex items-center gap-1"
            title="Refresh plan"
          >
            <RotateCcw size={11} className={planning ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>

        {/* Mode selector */}
        <div className="flex items-center gap-2 mb-3">
          <label htmlFor="fableloom-production-mode" className="text-xs text-port-text-muted">Mode:</label>
          <select
            id="fableloom-production-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="text-xs bg-port-card border border-port-border rounded px-2 py-1 text-port-text focus:outline-none focus:border-port-accent"
          >
            <option value="current_canon">Regenerate with current canon</option>
            <option value="exact_inputs">Repeat exact inputs</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <label htmlFor="fableloom-production-scope" className="text-xs text-port-text-muted">Production target:</label>
          <select
            id="fableloom-production-scope"
            value={assetScope}
            onChange={(event) => setAssetScope(event.target.value)}
            className="text-xs bg-port-card border border-port-border rounded px-2 py-1 text-port-text focus:outline-none focus:border-port-accent"
          >
            <option value="images">Storyboard images only</option>
            <option value="all">Images + video assets</option>
          </select>
          <span className="text-[10px] text-port-text-muted">
            {assetScope === 'images' ? 'Video stays unqueued until you opt in.' : 'Queues the complete audiovisual plan.'}
          </span>
        </div>

        {planning && !plan && (
          <div className="flex items-center gap-2 text-xs text-port-text-muted py-2">
            <Loader2 size={12} className="animate-spin" />
            Enumerating planned assets and DAG dependencies…
          </div>
        )}

        {plan && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="p-2 rounded bg-port-card border border-port-border">
                <div className="text-port-text-muted text-[10px] uppercase font-semibold">Planned Assets</div>
                <div className="text-sm font-bold mt-0.5">{plannedCount}</div>
                <div className="text-[10px] text-port-text-muted mt-0.5">
                  {assetScope === 'images'
                    ? `${plannedCount} stills · video not queued`
                    : `${plan.assetsByType?.image || 0} stills · ${plan.assetsByType?.video || 0} clips`}
                </div>
              </div>

              <div className="p-2 rounded bg-port-card border border-port-border">
                <div className="text-port-text-muted text-[10px] uppercase font-semibold">Ready / Rendered</div>
                <div className="text-sm font-bold text-port-success mt-0.5">
                  {readyCount} / {renderedCount}
                </div>
                <div className="text-[10px] text-port-text-muted mt-0.5">
                  {blockedCount} blocked
                </div>
              </div>

              <div className="p-2 rounded bg-port-card border border-port-border">
                <div className="text-port-text-muted text-[10px] uppercase font-semibold">Reachable Scenes</div>
                <div className="text-sm font-bold mt-0.5">
                  {plan.reachableNodeCount} / {plan.totalNodes}
                </div>
                <div className="text-[10px] text-port-text-muted mt-0.5">
                  {plan.executionStages?.length || 0} batches
                </div>
              </div>
            </div>

            {plan.episodeOrderReadiness && (
              <div className={`rounded border p-2.5 text-xs ${plan.episodeOrderReadiness.ready
                ? 'border-port-success/30 bg-port-success/10'
                : 'border-port-warning/30 bg-port-warning/10'}`}>
                <div className="font-semibold flex items-center gap-1">
                  {plan.episodeOrderReadiness.ready
                    ? <CheckCircle2 size={12} className="text-port-success" />
                    : <AlertTriangle size={12} className="text-port-warning" />}
                  Ordered storyboard sequence
                </div>
                <div className="text-[11px] text-port-text-muted mt-1">
                  {plan.episodeOrderReadiness.reason}
                </div>
                {!plan.episodeOrderReadiness.ready && plan.episodeOrderReadiness.missingScenes?.length > 0 && (
                  <div className="text-[11px] text-port-text-muted mt-1">
                    {plan.episodeOrderReadiness.missingScenes.length} prior scene image(s) still need to be rendered.
                  </div>
                )}
              </div>
            )}

            <div className="rounded bg-port-card border border-port-border p-2.5 space-y-2">
              <div className="text-[10px] uppercase font-semibold text-port-text-muted">Render settings</div>
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor="fableloom-render-format" className="text-[11px] text-port-text-muted w-14">Output</label>
                  <select
                    id="fableloom-render-format"
                    value={renderFormat.formatId}
                    onChange={(event) => saveRenderFormat(event.target.value)}
                    disabled={savingRenderFormat}
                    className="text-[11px] bg-port-bg border border-port-border rounded px-1.5 py-1 text-port-text disabled:opacity-50"
                  >
                    {FABLELOOM_RENDER_FORMATS.map((format) => (
                      <option key={format.formatId} value={format.formatId}>
                        {format.label} · {format.width}×{format.height}
                      </option>
                    ))}
                  </select>
                  {savingRenderFormat && <Loader2 size={11} className="animate-spin text-port-text-muted" aria-label="Saving output format" />}
                  <span className="text-[10px] text-port-text-muted">
                    {mode === 'exact_inputs'
                      ? 'Exact-input mode preserves each asset’s recorded dimensions.'
                      : 'Shared by storyboard images and video clips; 16:9 landscape is the default.'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-port-text-muted w-14">Images</span>
                  <BackendChipStrip
                    availableBackends={IMAGE_BACKENDS}
                    value={imageMode || 'auto'}
                    onChange={(value) => {
                      const nextMode = value === 'auto' ? null : value;
                      setImageMode(nextMode);
                      if (nextMode && nextMode !== 'local') setImageModel(null);
                    }}
                    size="sm"
                    ariaLabel="Image provider"
                  />
                  {(imageMode === 'local' || !imageMode) && (
                    <label htmlFor="fableloom-image-model" className="sr-only">Image model</label>
                  )}
                  {(imageMode === 'local' || !imageMode) && (
                    <select
                      id="fableloom-image-model"
                      value={imageModel || ''}
                      onChange={(event) => setImageModel(event.target.value || null)}
                      className="text-[11px] bg-port-bg border border-port-border rounded px-1.5 py-1 text-port-text"
                    >
                      <option value="">Saved image model</option>
                      {modelOptions(imageModels, imageModel).map((modelOption) => (
                        <option key={modelOption.id} value={modelOption.id}>{modelOption.label}</option>
                      ))}
                    </select>
                  )}
                </div>
                {assetScope === 'all' && (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-port-text-muted w-14">Video</span>
                    <BackendChipStrip
                      availableBackends={VIDEO_BACKENDS}
                      value={videoMode || 'auto'}
                      onChange={(value) => {
                        const nextMode = value === 'auto' ? null : value;
                        setVideoMode(nextMode);
                        if (nextMode && nextMode !== 'local') setVideoModel(null);
                      }}
                      size="sm"
                      ariaLabel="Video provider"
                    />
                    {(videoMode === 'local' || !videoMode) && (
                      <label htmlFor="fableloom-video-model" className="sr-only">Video model</label>
                    )}
                    {(videoMode === 'local' || !videoMode) && (
                      <select
                        id="fableloom-video-model"
                        value={videoModel || ''}
                        onChange={(event) => setVideoModel(event.target.value || null)}
                        className="text-[11px] bg-port-bg border border-port-border rounded px-1.5 py-1 text-port-text"
                      >
                        <option value="">Saved video model</option>
                        {modelOptions(videoModels, videoModel).map((modelOption) => (
                          <option key={modelOption.id} value={modelOption.id}>{modelOption.label}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <label htmlFor="fableloom-render-effort" className="text-[11px] text-port-text-muted w-14">Effort</label>
                  <select
                    id="fableloom-render-effort"
                    value={effort || ''}
                    onChange={(event) => setEffort(event.target.value || null)}
                    className="text-[11px] bg-port-bg border border-port-border rounded px-1.5 py-1 text-port-text"
                  >
                    <option value="">Provider default</option>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                  <span className="text-[10px] text-port-text-muted">Used when the selected provider supports it.</span>
                </div>
              </div>
            </div>

            {plan.formatMismatches?.length > 0 && (
              <div className="p-2.5 rounded bg-port-warning/10 border border-port-warning/30 text-xs space-y-1">
                <div className="font-semibold flex items-center gap-1 text-port-warning">
                  <AlertTriangle size={12} />
                  Existing media uses another aspect ratio
                </div>
                <p className="text-[11px] text-port-text-muted pl-4">
                  {plan.formatMismatches.length} media asset(s) will be regenerated at{' '}
                  {renderFormat.aspectRatio} ({renderFormat.width}×{renderFormat.height}).
                </p>
                {plan.formatMismatches.map((mismatch) => (
                  <button
                    key={mismatch.assetId || `${mismatch.nodeId}-${mismatch.assetType || 'media'}`}
                    type="button"
                    onClick={() => onSelectNode?.(mismatch.nodeId)}
                    className="block w-full text-left text-[11px] text-port-text-muted pl-4 hover:text-port-text"
                  >
                    {mismatch.nodeTitle || mismatch.nodeId} · {(mismatch.assetType || 'media').replaceAll('_', ' ')}: {mismatch.actualWidth}×{mismatch.actualHeight} → {mismatch.expectedAspectRatio}
                  </button>
                ))}
              </div>
            )}

            {readinessBlockers.length > 0 && (
              <div className="p-2.5 rounded bg-port-warning/10 border border-port-warning/30 text-xs space-y-1">
                <div className="font-semibold flex items-center gap-1 text-port-warning">
                  <AlertTriangle size={12} />
                  Resolve readiness blockers before starting
                </div>
                {readinessBlockers.map((blocker, index) => (
                  <button
                    key={`${blocker.nodeId || 'plan'}-${index}`}
                    type="button"
                    onClick={() => blocker.nodeId && onSelectNode && onSelectNode(blocker.nodeId)}
                    disabled={!blocker.nodeId}
                    className={`block w-full text-left text-[11px] text-port-text-muted pl-4 ${blocker.nodeId ? 'hover:text-port-text' : ''}`}
                  >
                    {blocker.message}{blocker.nodeId ? ` · scene [${blocker.nodeId}]` : ''}
                  </button>
                ))}
              </div>
            )}

            {/* Exact Input Issues */}
            {plan.exactInputIssues?.length > 0 && (
              <div className="p-2.5 rounded bg-port-error/10 border border-port-error/30 text-xs text-port-error space-y-1">
                <div className="font-semibold flex items-center gap-1">
                  <CircleAlert size={12} />
                  Exact-input reproduction refused ({plan.exactInputIssues.length} issue(s))
                </div>
                {plan.exactInputIssues.map((issue, idx) => (
                  <div key={idx} className="text-[11px] text-port-text-muted pl-4">
                    Scene [{issue.nodeId}]: {issue.errors.join('; ')}
                  </div>
                ))}
              </div>
            )}

            {/* Convergence details */}
            {plan.convergenceIssues?.length > 0 && (
              <div className="p-2 rounded bg-port-card border border-port-border text-xs space-y-1">
                <div className="font-semibold text-port-text-muted flex items-center gap-1 text-[11px]">
                  <Info size={12} />
                  Graph Convergence ({plan.convergenceIssues.length} scene(s))
                </div>
                {plan.convergenceIssues.map((c, i) => (
                  <div key={i} className="text-[11px] text-port-text-muted">
                    "{c.nodeTitle}" ({c.predecessorCount} inputs) → {c.selectedPredecessorId
                      ? `using predecessor [${c.selectedPredecessorId}]`
                      : 'no predecessor inherited; set an explicit continuity source'}
                  </div>
                ))}
              </div>
            )}

            {scopedAssets.length > 0 && (
              <div className="rounded bg-port-card border border-port-border p-2.5 space-y-2">
                <div className="text-[10px] uppercase font-semibold text-port-text-muted">
                  {assetScope === 'images' ? 'Storyboard image execution order' : 'Asset execution order'}
                </div>
                <div className="max-h-52 overflow-y-auto space-y-1">
                  {scopedAssets.map((asset) => (
                    <div key={asset.id} className="flex items-center gap-2 text-[11px] py-1 border-b border-port-border/50 last:border-0">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${asset.status === 'blocked' ? 'bg-port-error' : asset.status === 'already_rendered' || asset.status === 'skipped' ? 'bg-port-success' : 'bg-port-accent'}`} />
                      <button
                        type="button"
                        onClick={() => onSelectNode && onSelectNode(asset.nodeId)}
                        className="truncate text-left text-port-text hover:text-port-accent"
                        title={`Open scene ${asset.nodeId}`}
                      >
                        {asset.nodeTitle || asset.nodeId}
                      </button>
                      <span className="text-port-text-muted shrink-0">{asset.type.replaceAll('_', ' ')}</span>
                      <span className="text-port-text-muted ml-auto shrink-0">stage {asset.stageIndex + 1}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Batch execution controls */}
            <div className="pt-1 flex items-center gap-2">
              {activeBatchRun && ['failed', 'canceled'].includes(activeBatchRun.status) ? (
                <button
                  type="button"
                  onClick={resumeBatch}
                  disabled={resumingBatch}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
                >
                  {resumingBatch ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                  Resume Batch Production
                </button>
              ) : !activeBatchRun || activeBatchRun.status !== 'in_progress' ? (
                <button
                  type="button"
                  onClick={startBatch}
                  disabled={startingBatch || savingRenderFormat || !canStart}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
                >
                  {startingBatch ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  {assetScope === 'images' ? 'Generate Storyboard Images' : 'Start Batch Production'}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={cancelBatch}
                  disabled={cancelingBatch}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded bg-port-error text-white hover:bg-port-error/90 disabled:opacity-50"
                >
                  {cancelingBatch ? <Loader2 size={12} className="animate-spin" /> : <StopCircle size={12} />}
                  Cancel Production Batch
                </button>
              )}

              {activeBatchRun && (
                <span className="text-xs text-port-text-muted">
                  Status: <strong className="capitalize">{activeBatchRun.status}</strong> ({activeBatchRun.summary?.completed || 0}/{activeBatchRun.summary?.total || 0} done)
                  {activeBatchRun.error ? ` — ${activeBatchRun.error}` : ''}
                </span>
              )}
            </div>

            {activeBatchRun?.assets?.length > 0 && (
              <div className="rounded bg-port-card border border-port-border p-2.5 space-y-2">
                <div className="text-[10px] uppercase font-semibold text-port-text-muted">Recorded asset provenance</div>
                <div className="max-h-64 overflow-y-auto space-y-1">
                  {activeBatchRun.assets.map((asset) => {
                    const manifest = asset.visualConditioning;
                    const capability = manifest?.capability || {};
                    const render = manifest?.render || {};
                    const params = render.parameters || asset.effectiveParameters || {};
                    return (
                      <details key={asset.id} className="rounded border border-port-border/70 px-2 py-1 text-[11px]">
                        <summary className="cursor-pointer flex items-center gap-2">
                          <span className="font-medium text-port-text truncate">{asset.nodeTitle || asset.nodeId}</span>
                          <span className="text-port-text-muted">{asset.type.replaceAll('_', ' ')}</span>
                          <span className="ml-auto capitalize text-port-text-muted">{asset.status}</span>
                        </summary>
                        {manifest ? (
                          <div className="pt-1.5 pl-1 space-y-0.5 text-port-text-muted">
                            <div>Provider: {render.provider || capability.backend || 'unknown'} · Model: {render.modelId || capability.modelId || 'unknown'}{render.modelRevision || capability.modelRevision ? ` · revision ${render.modelRevision || capability.modelRevision}` : ''}</div>
                            <div>Canon refs: {manifest.assets?.length || 0} · adapters: {manifest.adapters?.length || 0} · temporal source: {manifest.temporalSourceNodeId || 'none'}</div>
                            <div>Omitted: {manifest.omitted?.length || 0} · warnings: {manifest.warnings?.length || 0}</div>
                            {Object.keys(params).length > 0 && <div>Effective parameters: {Object.entries(params).map(([key, value]) => `${key}=${String(value)}`).join(', ')}</div>}
                          </div>
                        ) : (
                          <div className="pt-1.5 pl-1 text-port-text-muted">No visual conditioning manifest was produced for this asset.</div>
                        )}
                      </details>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}

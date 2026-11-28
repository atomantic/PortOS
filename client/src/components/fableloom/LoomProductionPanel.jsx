import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, Info, Layers, Loader2, Play, RotateCcw, StopCircle } from 'lucide-react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import { useFableLoomRun } from '../../hooks/useFableLoomRun';
import useListResource from '../../hooks/useListResource';
import ListLoadError from '../ui/ListLoadError';
import {
  cancelLoomEpisodeProductionBatch,
  getLoomEpisodeProductionBatchStatus,
  planLoomEpisodeProduction,
  resumeLoomEpisodeProductionBatch,
  startLoomEpisodeProductionBatch,
  updateLoom,
} from '../../services/apiFableLoom.js';
import { listImageModels, listVideoModels } from '../../services/apiImageVideo.js';
import { fableLoomStoryReadiness } from '../../lib/fableLoomReadiness';
import { asFableLoomRenderPreferences, asFableLoomRenderSettings } from '../../../../server/lib/fableLoomProduction.js';
import LoomRenderFormatControls from './LoomRenderFormatControls';
import { LoomAssetProgressList, LoomAssetProvenanceList } from './LoomAssetProgressList';

/**
 * FableLoom render orchestration panel.
 *
 * Provides user-triggered batch production planning, DAG asset enumeration,
 * exact-input verification, and batch execution tracking. Continuity review
 * lives in its own workflow tab so a producer never has to hunt below render settings.
 */

const fetchImageModels = () => listImageModels({ silent: true });
const fetchVideoModels = () => listVideoModels({ silent: true });

const productionAssetsForScope = (plan, scope) => {
  if (!Array.isArray(plan?.plannedAssets)) return [];
  if (scope === 'images') return plan.plannedAssets.filter((asset) => asset.type === 'image');
  return plan.plannedAssets;
};

const assetIsReady = (asset) => asset.status !== 'blocked' && asset.readiness?.ready !== false;


function summarizeProductionAssets(plan, scopedAssets, assetScope) {
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
  return { plannedCount, readyCount, renderedCount, blockedCount };
}

export default function LoomProductionPanel({ loom, episode, onSelectNode, onLoomUpdate }) {
  const [mode, setMode] = useState('current_canon');
  const [assetScope, setAssetScope] = useState('images');
  const [plan, setPlan] = useState(null);
  const [planKey, setPlanKey] = useState(null);
  const savedRender = asFableLoomRenderPreferences(loom.renderSettings);
  const [imageMode, setImageMode] = useState(savedRender.imageMode);
  const [imageModel, setImageModel] = useState(savedRender.imageModel);
  const [videoMode, setVideoMode] = useState(savedRender.videoMode);
  const [videoModel, setVideoModel] = useState(savedRender.videoModel);
  const [effort, setEffort] = useState(savedRender.effort);
  const imageModelList = useListResource(fetchImageModels);
  const videoModelList = useListResource(fetchVideoModels);
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

  const { run: activeBatchRun, applyRun: setActiveBatchRun, readState, readError, retry } = useFableLoomRun({
    loomId: loom.id,
    episodeId: episode.id,
    event: 'fableloom:production:run',
    loadRun: () => getLoomEpisodeProductionBatchStatus(loom.id, episode.id, { silent: true }).then(response => response.run),
    onTerminal: () => fetchPlan(mode),
  });

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
  const { plannedCount, readyCount, renderedCount, blockedCount } = summarizeProductionAssets(plan, scopedAssets, assetScope);
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
  const canStart = readState === 'ready'
    && readinessBlockers.length === 0
    && (mode !== 'exact_inputs' || !plan?.exactInputIssues?.length)
    && planKey === planInputKey
    && !planning
    && !savingRenderFormat;

  return (
    <div className="space-y-6">
      {readError && <ListLoadError what="production batch status" error={readError} onRetry={retry} retrying={readState === 'loading'} />}
      {readState === 'loading' && !readError && !activeBatchRun && (
        <p role="status" className="text-xs text-port-text-muted">Checking production batch status…</p>
      )}
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
            <ProductionPlanSummary
              assetScope={assetScope}
              plan={plan}
              plannedCount={plannedCount}
              readyCount={readyCount}
              renderedCount={renderedCount}
              blockedCount={blockedCount}
            />
            <LoomRenderFormatControls
              mode={mode}
              assetScope={assetScope}
              image={{ mode: imageMode, setMode: setImageMode, model: imageModel, setModel: setImageModel, modelList: imageModelList }}
              video={{ mode: videoMode, setMode: setVideoMode, model: videoModel, setModel: setVideoModel, modelList: videoModelList }}
              effort={effort}
              setEffort={setEffort}
              renderFormat={renderFormat}
              saveRenderFormat={saveRenderFormat}
              savingRenderFormat={savingRenderFormat}
            />
            <ProductionPlanIssues
              plan={plan}
              renderFormat={renderFormat}
              readinessBlockers={readinessBlockers}
              onSelectNode={onSelectNode}
            />
            <LoomAssetProgressList
              assetScope={assetScope}
              scopedAssets={scopedAssets}
              onSelectNode={onSelectNode}
            />
          </div>
        )}

        {(plan || activeBatchRun) && (
          <div className="mt-3 space-y-3">
            <ProductionBatchControls
              assetScope={assetScope}
              savingRenderFormat={savingRenderFormat}
              activeBatchRun={activeBatchRun}
              cancelBatch={cancelBatch}
              cancelingBatch={cancelingBatch}
              startBatch={startBatch}
              startingBatch={startingBatch}
              resumeBatch={resumeBatch}
              resumingBatch={resumingBatch}
              canStart={canStart}
            />
            <LoomAssetProvenanceList activeBatchRun={activeBatchRun} />
          </div>
        )}
      </div>

    </div>
  );
}

function ProductionPlanSummary({ assetScope, plan, plannedCount, readyCount, renderedCount, blockedCount }) {
  return (
    <>
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
    </>
  );
}

function ProductionPlanIssues({ plan, renderFormat, readinessBlockers, onSelectNode }) {
  return (
    <>
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
    </>
  );
}

function ProductionBatchControls({
  assetScope, savingRenderFormat, activeBatchRun, cancelBatch, cancelingBatch, startBatch,
  startingBatch, resumeBatch, resumingBatch, canStart,
}) {
  return (
    <div className="pt-1 flex items-center gap-2">
      {activeBatchRun?.status === 'in_progress' ? (
        <button
          type="button"
          onClick={cancelBatch}
          disabled={cancelingBatch}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded bg-port-error text-white hover:bg-port-error/90 disabled:opacity-50"
        >
          {cancelingBatch ? <Loader2 size={12} className="animate-spin" /> : <StopCircle size={12} />}
          Cancel Production Batch
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={startBatch}
            disabled={startingBatch || resumingBatch || savingRenderFormat || !canStart}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
          >
            {startingBatch ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            {assetScope === 'images' ? 'Generate Storyboard Images' : 'Start Batch Production'}
          </button>
          {/* Resume replays the failed run's recorded settings verbatim; Start above uses the current controls. */}
          {activeBatchRun && ['failed', 'canceled'].includes(activeBatchRun.status) && (
            <button
              type="button"
              onClick={resumeBatch}
              disabled={resumingBatch || startingBatch || savingRenderFormat || !canStart}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded border border-port-border text-port-text hover:bg-port-card disabled:opacity-50"
            >
              {resumingBatch ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
              Resume Batch Production
            </button>
          )}
        </>
      )}

      {activeBatchRun && (
        <span className="text-xs text-port-text-muted">
          Status: <strong className="capitalize">{activeBatchRun.status}</strong> ({activeBatchRun.summary?.completed || 0}/{activeBatchRun.summary?.total || 0} done)
          {activeBatchRun.error ? ` — ${activeBatchRun.error}` : ''}
        </span>
      )}
    </div>
  );
}

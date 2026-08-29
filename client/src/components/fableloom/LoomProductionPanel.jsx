/**
 * FableLoom production orchestration and episodic continuity review panel.
 *
 * Provides user-triggered batch production planning, DAG asset enumeration,
 * exact-input verification, batch execution tracking, and episodic continuity review.
 */

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Cloud,
  Cpu,
  Film,
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
  reviewLoomEpisodeContinuity,
  resumeLoomEpisodeProductionBatch,
  startLoomEpisodeProductionBatch,
} from '../../services/api';

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

const modelOptions = (models) => (Array.isArray(models) ? models : [])
  .filter((model) => model?.id)
  .map((model) => ({ id: model.id, label: model.name || model.id }));

const severityIcon = (severity) => {
  if (severity === 'error' || severity === 'high') {
    return <CircleAlert size={14} className="text-port-error shrink-0 mt-0.5" />;
  }
  if (severity === 'warning') {
    return <AlertTriangle size={14} className="text-port-warning shrink-0 mt-0.5" />;
  }
  return <Info size={14} className="text-port-accent shrink-0 mt-0.5" />;
};

export default function LoomProductionPanel({ loom, episode, onSelectNode }) {
  const [mode, setMode] = useState('current_canon');
  const [plan, setPlan] = useState(null);
  const [activeBatchRun, setActiveBatchRun] = useState(null);
  const [continuityReview, setContinuityReview] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [imageMode, setImageMode] = useState(null);
  const [imageModel, setImageModel] = useState(null);
  const [videoMode, setVideoMode] = useState(null);
  const [videoModel, setVideoModel] = useState(null);
  const [effort, setEffort] = useState(null);
  const [imageModels, setImageModels] = useState([]);
  const [videoModels, setVideoModels] = useState([]);

  const renderOptions = (targetMode = mode) => ({
    mode: targetMode,
    ...(imageMode ? { imageMode } : {}),
    ...(imageModel ? { imageModel } : {}),
    ...(videoMode ? { videoMode } : {}),
    ...(videoModel ? { videoModel } : {}),
    ...(effort ? { effort } : {}),
  });

  const [fetchPlan, planning] = useAsyncAction(async (targetMode = mode) => {
    const res = await planLoomEpisodeProduction(loom.id, episode.id, renderOptions(targetMode), { silent: true });
    setPlan(res);
  }, { errorMessage: 'Production planning failed' });

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

  useEffect(() => {
    fetchPlan(mode);
  }, [loom.id, episode.id, mode, imageMode, imageModel, videoMode, videoModel, effort]);

  // Batch run polling
  useEffect(() => {
    if (!activeBatchRun || activeBatchRun.status !== 'in_progress') return undefined;
    const interval = setInterval(() => {
      getLoomEpisodeProductionBatch(loom.id, episode.id, activeBatchRun.id, { silent: true })
        .then((updated) => {
          if (!updated) return;
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
  }, [activeBatchRun, loom.id, episode.id, mode]);

  const [startBatch, startingBatch] = useAsyncAction(async () => {
    const res = await startLoomEpisodeProductionBatch(loom.id, episode.id, renderOptions(), { silent: true });
    setActiveBatchRun(res);
  }, { errorMessage: 'Starting production batch failed' });

  const [cancelBatch, cancelingBatch] = useAsyncAction(async () => {
    if (!activeBatchRun) return;
    const res = await cancelLoomEpisodeProductionBatch(loom.id, episode.id, activeBatchRun.id, { silent: true });
    setActiveBatchRun(res);
  }, { errorMessage: 'Canceling batch run failed' });

  const [resumeBatch, resumingBatch] = useAsyncAction(async () => {
    if (!activeBatchRun) return;
    const res = await resumeLoomEpisodeProductionBatch(loom.id, episode.id, activeBatchRun.id, { silent: true });
    setActiveBatchRun(res);
  }, { errorMessage: 'Resuming batch run failed' });

  const [runContinuityReview, reviewingContinuity] = useAsyncAction(async () => {
    const res = await reviewLoomEpisodeContinuity(loom.id, episode.id, {}, { silent: true });
    setContinuityReview(res);
  }, { errorMessage: 'Continuity review failed' });

  const filteredFindings = (continuityReview?.findings || []).filter((f) => {
    if (categoryFilter === 'all') return true;
    return f.category === categoryFilter;
  });

  const readinessBlockers = [
    ...(plan?.planningIssues || []).map((message) => ({ message, nodeId: null })),
    ...(plan?.plannedAssets || [])
      .filter((asset) => asset.status === 'blocked' || asset.readiness?.ready === false)
      .flatMap((asset) => (asset.readiness?.reasons || []).map((message) => ({
        message,
        nodeId: asset.nodeId,
      }))),
  ].filter((item, index, items) => items.findIndex((candidate) => (
    candidate.message === item.message && candidate.nodeId === item.nodeId
  )) === index);

  return (
    <div className="p-4 space-y-6">
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
                <div className="text-sm font-bold mt-0.5">{plan.totalAssets}</div>
                <div className="text-[10px] text-port-text-muted mt-0.5">
                  {plan.assetsByType?.image || 0} stills · {plan.assetsByType?.video || 0} clips
                </div>
              </div>

              <div className="p-2 rounded bg-port-card border border-port-border">
                <div className="text-port-text-muted text-[10px] uppercase font-semibold">Ready / Rendered</div>
                <div className="text-sm font-bold text-port-success mt-0.5">
                  {plan.readyAssetsCount} / {plan.alreadyRenderedCount}
                </div>
                <div className="text-[10px] text-port-text-muted mt-0.5">
                  {plan.blockedAssetsCount} blocked
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

            <div className="rounded bg-port-card border border-port-border p-2.5 space-y-2">
              <div className="text-[10px] uppercase font-semibold text-port-text-muted">Render settings</div>
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-port-text-muted w-14">Images</span>
                  <BackendChipStrip
                    availableBackends={IMAGE_BACKENDS}
                    value={imageMode || 'auto'}
                    onChange={(value) => setImageMode(value === 'auto' ? null : value)}
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
                      {modelOptions(imageModels).map((modelOption) => (
                        <option key={modelOption.id} value={modelOption.id}>{modelOption.label}</option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[11px] text-port-text-muted w-14">Video</span>
                  <BackendChipStrip
                    availableBackends={VIDEO_BACKENDS}
                    value={videoMode || 'auto'}
                    onChange={(value) => setVideoMode(value === 'auto' ? null : value)}
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
                      {modelOptions(videoModels).map((modelOption) => (
                        <option key={modelOption.id} value={modelOption.id}>{modelOption.label}</option>
                      ))}
                    </select>
                  )}
                </div>
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

            {plan.plannedAssets?.length > 0 && (
              <div className="rounded bg-port-card border border-port-border p-2.5 space-y-2">
                <div className="text-[10px] uppercase font-semibold text-port-text-muted">Asset execution order</div>
                <div className="max-h-52 overflow-y-auto space-y-1">
                  {plan.plannedAssets.map((asset) => (
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
                  disabled={startingBatch || plan.isFullyReady === false}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50"
                >
                  {startingBatch ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                  Start Batch Production
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

      {/* 2. Episodic Continuity Review */}
      <div className="border-t border-port-border pt-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <Film size={14} className="text-port-accent" />
            Continuity Review
          </h3>
          <button
            type="button"
            onClick={runContinuityReview}
            disabled={reviewingContinuity}
            className="flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-50 font-medium"
          >
            {reviewingContinuity ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            Run Continuity Review
          </button>
        </div>

        {continuityReview ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className={continuityReview.passed ? 'text-port-success font-medium flex items-center gap-1' : 'text-port-error font-medium flex items-center gap-1'}>
                {continuityReview.passed ? <CheckCircle2 size={13} /> : <CircleAlert size={13} />}
                {continuityReview.passed ? 'All continuity checks passed' : `${continuityReview.summary?.errors || 0} error(s), ${continuityReview.summary?.warnings || 0} warning(s)`}
              </span>
              <span className="text-port-text-muted text-[11px]">
                {continuityReview.nodesEvaluated} scenes evaluated
              </span>
            </div>

            {/* Category filter pills */}
            <div className="flex gap-1 overflow-x-auto pb-1 text-[11px]">
              {['all', 'visual', 'voice', 'playback', 'graph'].map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-2 py-0.5 rounded capitalize ${
                    categoryFilter === cat
                      ? 'bg-port-accent text-white font-medium'
                      : 'bg-port-card border border-port-border text-port-text-muted hover:text-port-text'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Findings list */}
            {filteredFindings.length > 0 ? (
              <div className="space-y-1.5">
                {filteredFindings.map((finding) => (
                  <button
                    key={finding.id}
                    type="button"
                    onClick={() => finding.nodeId && onSelectNode && onSelectNode(finding.nodeId)}
                    disabled={!finding.nodeId}
                    className={`w-full text-left flex items-start gap-2 text-xs rounded p-2 border border-port-border ${
                      finding.nodeId ? 'hover:border-port-accent cursor-pointer' : 'cursor-default'
                    }`}
                  >
                    {severityIcon(finding.severity)}
                    <div className="flex-1">
                      <div className="font-medium text-port-text">{finding.message}</div>
                      {finding.remediation && (
                        <div className="text-[11px] text-port-text-muted mt-0.5">
                          Remediation: {finding.remediation}
                        </div>
                      )}
                      {finding.nodeId && (
                        <div className="text-[10px] text-port-accent mt-1">
                          Jump to scene [{finding.nodeId}]
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-port-text-muted">
                No {categoryFilter === 'all' ? '' : categoryFilter} continuity issues found.
              </p>
            )}
          </div>
        ) : (
          <p className="text-xs text-port-text-muted">
            Inspect character visual bindings, wardrobe continuity, voice profile drift, pronunciation anchors, and live hold loops.
          </p>
        )}
      </div>
    </div>
  );
}

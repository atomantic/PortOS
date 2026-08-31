/**
 * FableLoom validation panel — the deterministic graph checks plus the
 * optional episode-level AI story review. Structural checks run instantly
 * server-side (no LLM); the series-level "Review full teleplay" action lives
 * in the series plan. Clicking a scene-anchored finding selects that node on
 * the canvas.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  AlertTriangle, CircleAlert, Film, Layers, ListChecks, Loader2, Sparkles, Waypoints,
} from 'lucide-react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import {
  reviewLoomEpisode, reviewLoomEpisodeContinuity, validateLoomEpisode,
} from '../../services/api';
import TabPills from '../ui/TabPills';
import LoomContinuityPanel from './LoomContinuityPanel';
import LoomProductionPanel from './LoomProductionPanel';
import LoomWorkflowPanel from './LoomWorkflowPanel';


const severityIcon = (severity) => (severity === 'error' || severity === 'high'
  ? <CircleAlert size={13} className="text-port-error shrink-0 mt-0.5" />
  : <AlertTriangle size={13} className="text-port-warning shrink-0 mt-0.5" />);

const PRODUCTION_TABS = new Set(['workflow', 'story', 'continuity', 'render']);

export default function LoomValidationPanel({
  loom,
  episode,
  onSelectNode,
  onOpenSettings,
  onOpenSeriesPlan,
  onOpenEpisodeSetup,
  onOpenPlay,
  onLoomUpdate,
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('production');
  const activeTab = PRODUCTION_TABS.has(requestedTab) ? requestedTab : 'workflow';
  const [structuralByEpisode, setStructuralByEpisode] = useState({});
  const [reviewByEpisode, setReviewByEpisode] = useState({});
  const [continuityByEpisode, setContinuityByEpisode] = useState({});
  const structural = structuralByEpisode[episode.id] || null;
  const review = reviewByEpisode[episode.id] || null;
  const continuityReview = continuityByEpisode[episode.id] || null;

  const setActiveTab = (tab) => setSearchParams((previous) => {
    const next = new URLSearchParams(previous);
    if (tab === 'workflow') next.delete('production');
    else next.set('production', tab);
    return next;
  }, { replace: true });


  // Re-validate only when the graph STRUCTURE changes — a prose edit or a
  // node drag bumps episode.updatedAt but can't change reachability, so
  // keying on updatedAt would re-run the full-loom server analysis on every
  // blur-save.
  const structureKey = useMemo(
    () => (loom.episodes || []).map((item) => [
      item.id,
      item.startNodeId,
      ...(item.nodes || []).map((node) =>
        `${node.id}|${node.isEnding ? 1 : 0}|${node.playbackMode || 'decision'}|${(node.transitions || []).map((transition) => `${transition.targetNodeId}:${transition.intent}`).join(',')}`),
    ].join(';')).join('||'),
    [loom.episodes],
  );

  useEffect(() => {
    let active = true;
    Promise.all((loom.episodes || []).map(async (item) => [
      item.id,
      await validateLoomEpisode(loom.id, item.id, { silent: true }).catch(() => null),
    ])).then((entries) => {
      if (active) setStructuralByEpisode(Object.fromEntries(entries));
    });
    return () => { active = false; };
  }, [loom.id, loom.episodes, structureKey]);

  useEffect(() => {
    let active = true;
    Promise.all((loom.episodes || []).map(async (item) => [
      item.id,
      await reviewLoomEpisodeContinuity(loom.id, item.id, {}, { silent: true }).catch(() => null),
    ])).then((entries) => {
      if (active) setContinuityByEpisode(Object.fromEntries(entries));
    });
    return () => { active = false; };
  }, [loom.id, loom.updatedAt]);

  const handleWorkflowAction = (action) => {
    if (action === 'settings') onOpenSettings?.();
    if (action === 'series-arc') onOpenSeriesPlan?.('arc');
    if (action === 'challenges') onOpenSeriesPlan?.('challenges');
    if (action === 'editorial') onOpenSeriesPlan?.('editorial');
    if (action === 'handoffs') onOpenSeriesPlan?.('handoffs');
    if (action === 'episode-setup') onOpenEpisodeSetup?.();
    if (action === 'story-review') setActiveTab('story');
    if (action === 'continuity') setActiveTab('continuity');
    if (action === 'render') setActiveTab('render');
    if (action === 'play') onOpenPlay?.();
  };

  const [runReview, reviewing] = useAsyncAction(async () => {
    const requestedEpisodeId = episode.id;
    const result = await reviewLoomEpisode(loom.id, requestedEpisodeId, {}, { silent: true });
    setReviewByEpisode((current) => ({ ...current, [requestedEpisodeId]: result.review }));
    setStructuralByEpisode((current) => ({ ...current, [requestedEpisodeId]: result.structural }));
  }, { errorMessage: 'Story review failed' });

  const findingRow = (item, key, nodeId) => (
    <button
      key={key}
      type="button"
      onClick={() => nodeId && onSelectNode(nodeId)}
      disabled={!nodeId}
      className={`w-full text-left flex items-start gap-2 text-xs rounded px-2 py-1.5 border border-port-border ${
        nodeId ? 'hover:border-port-accent cursor-pointer' : 'cursor-default'
      }`}
    >
      {severityIcon(item.severity)}
      <span>
        {item.message || item.problem}
        {item.suggestion ? <span className="block text-port-text-muted mt-0.5">{item.suggestion}</span> : null}
      </span>
    </button>
  );

  return (
    <div className="p-3 sm:p-4 space-y-3 sm:space-y-4">
      <TabPills
        tabs={[
          { id: 'workflow', label: 'Workflow', icon: ListChecks },
          { id: 'story', label: 'Story', icon: Waypoints },
          { id: 'continuity', label: 'Continuity', icon: Film },
          { id: 'render', label: 'Render', icon: Layers },
        ]}
        activeTab={activeTab}
        onChange={setActiveTab}
        variant="underline"
        size="xs"
        stretch
        mobileDropdown
        mobileSelectId="fableloom-workflow-section"
        ariaLabel="Episode production sections"
      />

      {activeTab === 'workflow' ? (
        <LoomWorkflowPanel
          loom={loom}
          episode={episode}
          structural={structural}
          structuralByEpisode={structuralByEpisode}
          continuityReview={continuityReview}
          continuityByEpisode={continuityByEpisode}
          onAction={handleWorkflowAction}
          onLoomUpdate={onLoomUpdate}
        />
      ) : activeTab === 'render' ? (
        <LoomProductionPanel
          loom={loom}
          episode={episode}
          onSelectNode={onSelectNode}
          onLoomUpdate={onLoomUpdate}
        />
      ) : activeTab === 'continuity' ? (
        <LoomContinuityPanel
          loom={loom}
          episode={episode}
          review={continuityReview}
          onReviewChange={(reviewEpisodeId, result) => setContinuityByEpisode((current) => ({
            ...current,
            [reviewEpisodeId]: result,
          }))}
          onSelectNode={onSelectNode}
        />
      ) : (
        <>
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 mb-2">
              <h3 className="text-sm font-semibold">Structure</h3>
              {structural?.stats && (
                <span className="text-xs text-port-text-muted">
                  {structural.stats.automaticCutCount} cuts · {structural.stats.decisionCount} decisions ·{' '}
                  {structural.stats.reachableEndingCount}/{structural.stats.endingCount} endings reachable
                  · depth {structural.stats.maxDepth}
                </span>
              )}
            </div>
            {structural?.issues?.length ? (
              <div className="space-y-1.5">
                {structural.issues.map((issue, i) => findingRow(issue, `s-${i}`, issue.nodeId))}
              </div>
            ) : structural ? (
              <p className="text-xs text-port-success">Graph is sound — every path reaches an ending.</p>
            ) : (
              <p className="text-xs text-port-text-muted">Validating…</p>
            )}
          </div>

          {structural?.productionReadiness && (
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 mb-2">
                <h3 className="text-sm font-semibold">Production readiness</h3>
                <span className="text-xs text-port-text-muted">
                  {structural.productionReadiness.ready ? 'Ready for live voice' : `${structural.productionReadiness.totalErrors} blocking error(s)`}
                </span>
              </div>
              {structural.productionReadiness.findings?.length ? (
                <div className="space-y-1.5">
                  {structural.productionReadiness.findings.map((f, i) => findingRow(f, `pr-${i}`, f.nodeId))}
                </div>
              ) : (
                <p className="text-xs text-port-success">All scenes meet audio occupancy and off-screen voice standards.</p>
              )}
            </div>
          )}

          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 mb-2">
              <h3 className="text-sm font-semibold">Story review</h3>
              <button
                type="button"
                onClick={runReview}
                disabled={reviewing}
                className="flex items-center gap-1 text-xs text-port-accent hover:underline disabled:opacity-50"
              >
                {reviewing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                Review episode teleplay with AI
              </button>
            </div>
            {review ? (
              <div className="space-y-2">
                {review.summary && <p className="text-xs text-port-text-muted">{review.summary}</p>}
                {review.findings.length ? (
                  <div className="space-y-1.5">
                    {review.findings.map((finding, i) => findingRow(finding, `r-${i}`, finding.nodeId))}
                  </div>
                ) : (
                  <p className="text-xs text-port-success">No narrative issues found.</p>
                )}
              </div>
            ) : (
              <p className="text-xs text-port-text-muted">
                Ask the AI story editor to critique this episode's intents, branches, scene craft, and endings.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

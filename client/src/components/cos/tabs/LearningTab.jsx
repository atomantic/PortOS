import { useState, useEffect, useCallback } from 'react';
import { Brain, RefreshCw, TrendingUp, Clock, SkipForward, Target, Database } from 'lucide-react';
import toast from '../../ui/Toast';
import {
  getCosLearningDashboard,
  dismissCosRecommendation,
  restoreCosRecommendation,
  clearDismissedCosRecommendations,
  backfillCosLearning,
  resetCosTaskTypeLearning,
} from '../../../services/apiAgents.js';
import { getReviewerVerdictStats } from '../../../services/apiCodeReview.js';
import socket from '../../../services/socket';
import BrailleSpinner from '../../BrailleSpinner';
import useLatestRequest from '../../../hooks/useLatestRequest';
import { useSocketSubscription } from '../../../hooks/useSocketSubscription';
import ListLoadError from '../../ui/ListLoadError';
import LoadFailedState from '../../ui/LoadFailedState';
import ReviewerVerdictSummary from './ReviewerVerdictSummary';
import { formatDateTime } from '../../../utils/formatters';
import LearningRecommendations from './learning/LearningRecommendations';
import LearningConfidenceSection from './learning/LearningConfidenceSection';
import LearningTaskTypesSection from './learning/LearningTaskTypesSection';
import LearningLowSuccessSection from './learning/LearningLowSuccessSection';
import LearningDurationsSection from './learning/LearningDurationsSection';
import LearningModelsSection from './learning/LearningModelsSection';
import LearningRoutingSection from './learning/LearningRoutingSection';
import LearningErrorsSection from './learning/LearningErrorsSection';
import LearningStandingSection from './learning/LearningStandingSection';
import FeedbackSummary from './learning/FeedbackSummary';
import { getSuccessRateColor, getSuccessRateBg } from './learning/learningPresentation';

export default function LearningTab() {
  const [dashboard, setDashboard] = useState(null);
  const [reviewerVerdicts, setReviewerVerdicts] = useState(null);
  const [verdictsFailed, setVerdictsFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [learningFailed, setLearningFailed] = useState(false);
  const { learning, performance, skipped, durations, routing, confidence, feedback, dismissed } = dashboard ?? {};
  const [backfilling, setBackfilling] = useState(false);
  const [resettingType, setResettingType] = useState(null);
  const [expandedSections, setExpandedSections] = useState({
    confidence: true,
    taskTypes: true,
    skipped: true,
    durations: false,
    models: true,
    routing: true,
    errors: false,
    standing: true
  });

  // Refresh, Retry and the post-mutation reloads can overlap; only the newest
  // batch may write, or an older failure replaces a newer successful read.
  const beginLoad = useLatestRequest();
  // The verdict panel also re-reads on its own socket event, so it keeps a
  // separate latest-wins guard that the full load takes too.
  const beginVerdictLoad = useLatestRequest();

  const loadData = useCallback(async () => {
    const isCurrent = beginLoad();
    const verdictsCurrent = beginVerdictLoad();
    setLoading(true);
    const snapshot = await getCosLearningDashboard({ silent: true }).catch(() => null);
    if (!isCurrent()) return;
    setLearningFailed(snapshot === null);
    if (snapshot) {
      setDashboard(snapshot);
      // An event can finish while the dashboard request is in flight.
      if (verdictsCurrent()) {
        setVerdictsFailed(snapshot.reviewerVerdicts === null);
        if (snapshot.reviewerVerdicts) setReviewerVerdicts(snapshot.reviewerVerdicts);
      }
    }
    setLoading(false);
  }, [beginLoad, beginVerdictLoad]);

  // A run that records a verdict while this tab is open, or a reconnect that may
  // have missed one, re-reads the panel. A failed re-read keeps the last good
  // aggregate and shows the section as not loaded, with the page's Retry.
  const refreshVerdicts = useCallback(() => {
    const isCurrent = beginVerdictLoad();
    return getReviewerVerdictStats({ silent: true }).then(
      (stats) => {
        if (!isCurrent()) return;
        setReviewerVerdicts(stats);
        setVerdictsFailed(false);
      },
      () => {
        if (!isCurrent()) return;
        setVerdictsFailed(true);
      },
    );
  }, [beginVerdictLoad]);
  useSocketSubscription('cos', { onResubscribe: refreshVerdicts });
  useEffect(() => {
    socket.on('cos:reviewer-verdict:recorded', refreshVerdicts);
    socket.on('cos:agents:changed', refreshVerdicts);
    return () => {
      socket.off('cos:reviewer-verdict:recorded', refreshVerdicts);
      socket.off('cos:agents:changed', refreshVerdicts);
    };
  }, [refreshVerdicts]);

  const handleDismissRec = useCallback(async (rec) => {
    const result = await dismissCosRecommendation(rec.id, rec.snapshot ?? null).catch(() => null);
    if (!result?.dismissed) {
      toast.error('Failed to dismiss recommendation');
      await loadData();
      return;
    }
    setDashboard(prev => prev && ({
      ...prev,
      learning: {
        ...prev.learning,
        recommendations: (prev.learning.recommendations || []).filter(r => r.id !== rec.id),
      },
      dismissed: [{ id: rec.id, dismissedAt: new Date().toISOString(), snapshot: rec.snapshot ?? null },
        ...prev.dismissed.filter(item => item.id !== rec.id)],
    }));
    toast.success('Dismissed — won\'t alert again unless the situation worsens');
  }, [loadData]);

  const handleRestoreRec = useCallback(async (id) => {
    const result = await restoreCosRecommendation(id).catch(() => null);
    if (!result?.restored) {
      toast.error('Failed to restore recommendation');
    } else {
      setDashboard(prev => prev && ({ ...prev, dismissed: prev.dismissed.filter(item => item.id !== id) }));
    }
    await loadData();
  }, [loadData]);

  const handleClearDismissed = useCallback(async () => {
    const result = await clearDismissedCosRecommendations().catch(() => null);
    if (!result?.cleared) {
      toast.error('Failed to clear dismissed list');
    } else {
      setDashboard(prev => prev && ({ ...prev, dismissed: [] }));
    }
    await loadData();
  }, [loadData]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleBackfill = useCallback(async () => {
    setBackfilling(true);
    const result = await backfillCosLearning().catch(() => null);
    if (result?.success) {
      await loadData();
    }
    setBackfilling(false);
  }, [loadData]);

  const [resettingAll, setResettingAll] = useState(false);

  const handleResetTaskType = useCallback(async (taskType) => {
    setResettingType(taskType);
    const result = await resetCosTaskTypeLearning(taskType).catch(() => null);
    if (result?.reset) {
      toast.success(`Reset learning data for ${taskType} — auto-approval re-enabled`);
      await loadData();
    } else {
      toast.error(`Failed to reset learning data for ${taskType}`);
    }
    setResettingType(null);
  }, [loadData]);

  const handleResetAllLowConfidence = useCallback(async () => {
    const lowItems = confidence?.levels?.low || [];
    if (lowItems.length === 0) return;
    setResettingAll(true);
    let successCount = 0;
    for (const item of lowItems) {
      const result = await resetCosTaskTypeLearning(item.taskType).catch(() => null);
      if (result?.reset) successCount++;
    }
    if (successCount > 0) {
      toast.success(`Marked ${successCount} task type${successCount > 1 ? 's' : ''} resolved — auto-approval re-enabled`);
      await loadData();
    } else {
      toast.error('Failed to reset task types');
    }
    setResettingAll(false);
  }, [confidence, loadData]);

  const toggleSection = useCallback((section) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  }, []);

  const hasData = learning?.totals?.completed > 0;
  const skippedCount = skipped?.skippedCount ?? 0;
  const sectionFailures = [
    confidence === null && 'confidence',
    feedback === null && 'feedback',
    verdictsFailed && 'reviewer verdicts',
  ].filter(Boolean);
  // Verdicts come from agent records, not task-learning totals, so the panel
  // also shows when learning has no completed tasks yet.
  const verdictPanel = <ReviewerVerdictSummary stats={reviewerVerdicts} />;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Brain className="w-5 h-5 text-port-accent-2" />
          <h3 className="text-lg font-semibold text-white">Learning Analytics</h3>
        </div>
        <div className="flex gap-2">
          {!hasData && !loading && !learningFailed && (
            <button
              onClick={handleBackfill}
              disabled={backfilling}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-accent-2/20 hover:bg-port-accent-2/30 text-port-accent-2 rounded-lg transition-colors disabled:opacity-50"
            >
              <Database size={14} />
              {backfilling ? 'Backfilling...' : 'Backfill History'}
            </button>
          )}
          <button
            onClick={loadData}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-port-border hover:bg-port-border/80 text-white rounded-lg transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {dashboard && learningFailed && (
        <ListLoadError what="learning analytics" onRetry={loadData} retrying={loading} />
      )}
      {dashboard && !learningFailed && sectionFailures.length > 0 && (
        <ListLoadError what={`some learning sections (${sectionFailures.join(', ')})`} onRetry={loadData} retrying={loading} />
      )}

      {!dashboard && loading ? (
        <div className="flex items-center justify-center py-12">
          <BrailleSpinner text="Loading" />
        </div>
      ) : !dashboard ? (
        <LoadFailedState title="Could not load learning analytics" hint="Your learning history was not read, so nothing is shown here." onRetry={loadData} />
      ) : !hasData ? (
        <>
          <div className="bg-port-card border border-port-border rounded-lg p-8 text-center">
            <Brain className="w-12 h-12 text-gray-600 mx-auto mb-3" />
            <p className="text-gray-400">No learning data available yet.</p>
            <p className="text-gray-500 text-sm mt-1">
              Complete some tasks to see performance analytics, or click &quot;Backfill History&quot; to import existing data.
            </p>
          </div>
          {verdictPanel}
        </>
      ) : (
        <>
          {/* Overview Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <Target size={14} className="text-port-accent" />
                <span className="text-xs text-gray-500">Tasks Analyzed</span>
              </div>
              <div className="text-2xl font-bold text-white">{learning.totals.completed}</div>
              <div className="text-xs text-gray-500">
                {learning.totals.succeeded} success / {learning.totals.failed} failed
              </div>
            </div>

            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp size={14} className={getSuccessRateColor(learning.totals.successRate)} />
                <span className="text-xs text-gray-500">Success Rate</span>
              </div>
              <div className={`text-2xl font-bold ${getSuccessRateColor(learning.totals.successRate)}`}>
                {learning.totals.successRate}%
              </div>
              <div className="w-full bg-port-border rounded-full h-1.5 mt-2">
                <div
                  className={`h-1.5 rounded-full ${getSuccessRateBg(learning.totals.successRate)}`}
                  style={{ width: `${learning.totals.successRate}%` }}
                />
              </div>
            </div>

            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <Clock size={14} className="text-port-accent" />
                <span className="text-xs text-gray-500">Avg Duration</span>
              </div>
              <div className="text-2xl font-bold text-port-accent">{learning.totals.avgDurationMin}m</div>
              <div className="text-xs text-gray-500">per task</div>
            </div>

            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-1">
                <SkipForward size={14} className={skippedCount > 0 ? 'text-port-warning' : 'text-gray-500'} />
                <span className="text-xs text-gray-500">Low-Success Types</span>
              </div>
              <div className={`text-2xl font-bold ${skippedCount > 0 ? 'text-port-warning' : 'text-gray-500'}`}>
                {skippedCount}
              </div>
              <div className="text-xs text-gray-500">due to low success</div>
            </div>
          </div>

          <FeedbackSummary feedback={feedback} />

          {verdictPanel}

          <LearningRecommendations
            recommendations={learning.recommendations}
            dismissed={dismissed}
            onDismiss={handleDismissRec}
            onRestore={handleRestoreRec}
            onClearDismissed={handleClearDismissed}
          />

          <LearningConfidenceSection
            confidence={confidence}
            expanded={expandedSections.confidence}
            onToggle={() => toggleSection('confidence')}
            resettingType={resettingType}
            resettingAll={resettingAll}
            onResetTaskType={handleResetTaskType}
            onResetAll={handleResetAllLowConfidence}
          />

          <LearningTaskTypesSection
            performance={performance}
            expanded={expandedSections.taskTypes}
            onToggle={() => toggleSection('taskTypes')}
            resettingType={resettingType}
            onResetTaskType={handleResetTaskType}
          />

          <LearningLowSuccessSection
            skipped={skipped}
            expanded={expandedSections.skipped}
            onToggle={() => toggleSection('skipped')}
            resettingType={resettingType}
            onResetTaskType={handleResetTaskType}
          />

          <LearningDurationsSection
            durations={durations}
            expanded={expandedSections.durations}
            onToggle={() => toggleSection('durations')}
          />

          <LearningModelsSection
            models={learning.insights?.modelEffectiveness}
            expanded={expandedSections.models}
            onToggle={() => toggleSection('models')}
          />

          <LearningRoutingSection
            routing={routing}
            expanded={expandedSections.routing}
            onToggle={() => toggleSection('routing')}
          />

          <LearningErrorsSection
            insights={learning.insights}
            expanded={expandedSections.errors}
            onToggle={() => toggleSection('errors')}
          />

          <LearningStandingSection
            notes={learning.standingLearnings}
            expanded={expandedSections.standing}
            onToggle={() => toggleSection('standing')}
          />

          {/* Last Updated */}
          {learning.lastUpdated && (
            <div className="text-xs text-gray-600 text-center pt-4 border-t border-port-border">
              Learning data last updated: {formatDateTime(learning.lastUpdated)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

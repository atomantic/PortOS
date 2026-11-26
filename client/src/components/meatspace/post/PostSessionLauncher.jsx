import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { Target, Zap } from 'lucide-react';
import { getPostReviewReps, getPostBenchmarkProtocol, updatePostConfig } from '../../../services/apiMeatspace.js';
import ListLoadError from '../../ui/ListLoadError';
import toast from '../../ui/Toast';
import { DOMAINS, DRILL_TO_DOMAIN } from './constants';
import { otherPostSections, TOPIC_SURFACE_SECTIONS } from './practiceCatalog';
import { postIcon } from './postIcons';
import { CognitiveDrillTutorialPreview } from './CognitiveDrillTutorial';
import useUserTimezone from '../../../hooks/useUserTimezone.js';
import { todayKeyInTimezone } from '../../../utils/timezone.js';
import { normalizeQuickDurationMinutes } from '../../../lib/postQuickSession.js';
import PostStartCard from './PostStartCard';
import PostAnalyticsSection from './PostAnalyticsSection';
import PostDrillsSidebar from './PostDrillsSidebar';
import usePostLauncherData from './usePostLauncherData';
import {
  buildCleanConditions, collectLauncherDrills, buildFullSessionDrills,
  buildLauncherQuickPlan, buildQuickSessionDrills, buildFocusDrillConfig,
} from './postLauncherBuilders';

export { INTERLEAVE_DOMAIN_ORDER, interleaveByDomain, buildCleanConditions } from './postLauncherBuilders';
export { cognitiveSummary } from './postLauncherScores';
export { SLEEP_QUALITY_OPTIONS, CAFFEINE_OPTIONS, STRESS_OPTIONS } from './postLauncherConditions';

// The launcher header's links to the rest of POST. These used to be four
// `onView*` callback props, so the launcher could only offer whatever PostTab
// happened to wire up — Practice Plan, Progress, and the Practice Library had no
// link here at all. Now they're DERIVED: the section rows come from the shared
// `POST_SECTIONS` (minus the launcher itself) and the per-topic shortcuts from
// the catalog's topic groups, so a new POST page or topic tab gets a header link
// without editing this file. Explore leads, styled as the primary action.
const LAUNCHER_LINKS = [
  ...otherPostSections('launcher').filter(s => s.id === 'explore').map(s => ({ ...s, primary: true })),
  ...TOPIC_SURFACE_SECTIONS,
  ...otherPostSections('launcher').filter(s => s.id !== 'explore'),
];

function AutoStartRecommendation({ action, onConsumed, onNavigate }) {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    onConsumed();
    if (action?.to) onNavigate(action.to);
    else action?.onClick?.();
  }, [action, onConsumed, onNavigate]);

  return <div className="text-center text-gray-400 py-12">Starting your next lesson...</div>;
}

export default function PostSessionLauncher({
  config,
  recentSessions,
  stats,
  statsWeek,
  onStart,
  autoStartRecommendationId,
  onAutoStartConsumed,
  onNavigate,
}) {
  // Resolve "today" in the user's CONFIGURED timezone so client-side day matching
  // (completed-today, today's minutes) agrees with the server, which stamps and
  // windows POST records on the configured local day (issue #2681). Deriving it
  // from `new Date().toISOString()` (UTC) would disagree near local/UTC midnight.
  const timezone = useUserTimezone();
  const [conditions, setConditions] = useState({ sleepQuality: '', caffeine: '', stress: '', note: '' });
  // Conditions is optional metadata, so it starts collapsed and the start
  // buttons stay above the fold (issue #3249). Purely presentational —
  // `conditions` lives above it, so collapsing never discards typed values.
  const [showConditions, setShowConditions] = useState(false);
  const [mode, setMode] = useState('test'); // 'test' | 'train'
  const [quickDurationSaveState, setQuickDurationSaveState] = useState('idle');
  const [benchmarkState, setBenchmarkState] = useState('idle');
  const [benchmarkError, setBenchmarkError] = useState(null);
  // Drill TYPE whose how-to card is open, or null (issue #4732) — same shape as
  // PostDrillConfig, with the payload derived at render so the card can never
  // show a config snapshot that has since moved. Nothing mounts a runner, so no
  // drill timer is affected.
  const [howItWorksType, setHowItWorksType] = useState(null);
  const {
    quickDurationMin, setQuickDurationMin, providers, reviewReps, reviewRepsError, loadReviewReps,
    recommendations, recommendationsLoaded, recentPractice, morseWpm, todayMinutesTotal,
    memoryItemsState, cognitiveProgress,
  } = usePostLauncherData(config, timezone);

  if (!config) {
    return <div className="text-gray-500">Loading configuration...</div>;
  }

  const today = todayKeyInTimezone(timezone);

  const drillCatalog = collectLauncherDrills(config, reviewReps, memoryItemsState);
  const {
    topicAllowed, allowedReviewReps, allEnabledDrills, enabledDomains, sessionEnabledDomains,
    domainCount, hasSessionDrills, compositionExcludesAll,
  } = drillCatalog;
  const quickPlan = buildLauncherQuickPlan(drillCatalog, { recommendations, quickDurationMin, recentSessions, recentPractice });

  function handleStart() {
    const drillConfigs = buildFullSessionDrills(drillCatalog);
    onStart({ drills: drillConfigs, conditions: buildCleanConditions(conditions), training: mode === 'train' });
  }

  function handleQuickDurationChange(event) {
    const next = normalizeQuickDurationMinutes(event.target.value);
    const previous = quickDurationMin;
    setQuickDurationMin(next);
    setQuickDurationSaveState('saving');
    updatePostConfig({ quickDurationMin: next }, { silent: true })
      .then(() => setQuickDurationSaveState('saved'))
      .catch(() => {
        setQuickDurationMin(previous);
        setQuickDurationSaveState('error');
      });
  }

  function handleQuickSession() {
    const drillConfigs = buildQuickSessionDrills(quickPlan, drillCatalog);
    if (!drillConfigs.length) return;
    onStart({
      drills: drillConfigs,
      conditions: buildCleanConditions(conditions),
      training: mode === 'train',
      plan: {
        targetDurationSec: quickPlan.targetDurationSec,
        estimatedDurationSec: quickPlan.estimatedDurationSec,
        toleranceSec: quickPlan.toleranceSec,
        omittedDomains: quickPlan.omittedDomains,
        omittedReviews: quickPlan.omittedReviews,
        selectedTypes: quickPlan.selected.map(candidate => candidate.type),
      },
    });
  }

  function handleBenchmarkSession() {
    setBenchmarkState('loading');
    setBenchmarkError(null);
    getPostBenchmarkProtocol({ silent: true })
      .then((protocol) => {
        const form = protocol?.forms?.find(candidate => candidate.formId === protocol.nextFormId);
        if (!form) throw new Error('No benchmark form is available');
        const drillConfigs = form.tasks.map(task => ({
          type: task.type,
          domain: task.domain,
          config: { ...task.config },
          timeLimitSec: task.timeLimitSec,
        }));
        onStart({
          drills: drillConfigs,
          conditions: buildCleanConditions(conditions),
          benchmark: {
            protocolId: protocol.protocolId,
            protocolVersion: protocol.protocolVersion,
            scorerVersion: protocol.scorerVersion,
            formId: form.formId,
          },
        });
      })
      .catch(error => setBenchmarkError(error.message || 'Benchmark could not be loaded'))
      .finally(() => setBenchmarkState('idle'));
  }

  // Focused practice on a single domain: run every enabled drill in that domain
  // (not one random pick, unlike the balanced quick session) so the weakest
  // domain gets a substantive workout.
  function handleFocusDomain(domainKey) {
    const drills = enabledDomains[domainKey];
    if (!drills || drills.length === 0) return;
    onStart({ drills: drills.map(d => buildFocusDrillConfig(d, drillCatalog, domainKey)), conditions: buildCleanConditions(conditions), training: mode === 'train' });
  }

  // Start a session with exactly ONE recommended drill (issue #2100): an Up next
  // rec that names a specific drill takes the user into THAT drill, not every
  // drill in its domain. No-op if the drill isn't currently enabled.
  function startDrillByType(type) {
    const entry = allEnabledDrills.find(d => d.type === type);
    if (!entry) return;
    onStart({ drills: [buildFocusDrillConfig(entry, drillCatalog)], conditions: buildCleanConditions(conditions), training: mode === 'train' });
  }

  // Launch a single due maintenance-review rep from an "Up next" skill-review
  // recommendation (issue #2100). The rep carries the `review`/`reviewSkillId`
  // markers the server needs to record the re-verification — a plain focus/Full
  // session would NOT resolve the scheduled review, so we NEVER fall back to one.
  // If the matching rep isn't in the preloaded set (still pending, or beyond the
  // first page), fetch fresh on demand; if it still can't be found there's no
  // runnable rep, so do nothing rather than start an unrelated session.
  async function startReviewRep(rec) {
    const skillId = rec.id.replace(/^skill-review:/, '');
    let rep = allowedReviewReps.find(r => r.skillId === skillId);
    if (!rep) {
      const fresh = await getPostReviewReps(5, { silent: true }).then(r => r?.reps || []).catch(err => {
        toast.error(`Could not load the review rep: ${err.message}`);
        return null;
      });
      if (!fresh) return;
      rep = fresh.filter(r => topicAllowed(r.type)).find(r => r.skillId === skillId);
    }
    if (!rep) return;
    const drillConfig = {
      type: rep.type,
      domain: DRILL_TO_DOMAIN[rep.type],
      config: rep.config,
      timeLimitSec: DOMAINS[DRILL_TO_DOMAIN[rep.type]]?.timeBudgetSec,
      isReview: true,
      reviewLabel: rep.label,
      ...(rep.providerId && { providerId: rep.providerId }),
    };
    onStart({ drills: [drillConfig], conditions: buildCleanConditions(conditions), training: mode === 'train' });
  }

  // How the launcher acts on a recommendation: either an in-page session start
  // (`onClick`) or a navigation (`to`). A rec that targets the launcher should DO
  // the practice, not navigate to the page the user is already on (issue #2100
  // review); routed recs (/post/memory/…, /post/morse/copy) stay links. Shared by
  // the primary Start CTA and the "Up next" rows so the two can never diverge
  // (issue #3249). Returns null when the rec isn't actionable right now.
  function recAction(rec) {
    if (!rec) return null;
    if (rec.deepLink && rec.deepLink !== '/post/launcher') return { to: rec.deepLink };
    // Launch the actual review rep (with its markers), not plain practice.
    if (rec.kind === 'skill-review') return { onClick: () => startReviewRep(rec) };
    // Start the EXACT recommended drill when it's enabled and in an allowed
    // module; else (no specific drill) start a Full POST.
    const domainKey = rec.drillType ? DRILL_TO_DOMAIN[rec.drillType] : null;
    const drillRunnable = domainKey && sessionEnabledDomains[domainKey]
      && sessionEnabledDomains[domainKey].some(d => d.type === rec.drillType);
    if (drillRunnable) return { onClick: () => startDrillByType(rec.drillType) };
    return hasSessionDrills ? { onClick: handleStart } : null;
  }

  // The Start card's primary CTA. Normally the top recommendation; when the
  // recommendations fetch failed (the panel is empty) it degrades to a plain
  // Full POST so the card always leads with a runnable action.
  // The label is prefixed rather than echoing the rec title verbatim: the same
  // title also renders in the "Up next" row below, and two identical labels on
  // one screen read as a duplicate rather than as "this is the recommended one."
  const topRec = recommendations[0] || null;
  const topRecAction = recAction(topRec);
  const primaryAction = topRecAction
    // Once everything in the rotation has been practiced today the top rec is
    // one of those (they're demoted, not dropped) — say so on the CTA, matching
    // the "Done today" badge the same rec carries in Up next (#3563).
    ? {
      ...topRecAction,
      label: `Start: ${topRec.title}`,
      detail: [topRec.detail, topRec.practicedToday ? 'Already done today' : null].filter(Boolean).join(' · ') || null,
    }
    : (hasSessionDrills
      ? { onClick: handleStart, label: `Start: ${mode === 'train' ? 'Full Training' : 'Full POST'}`, detail: null }
      : null);

  // A default/full recommendation may include memory drills, so wait until the
  // item pool is known before deciding whether its session is runnable.
  if (autoStartRecommendationId && recommendationsLoaded && memoryItemsState.status !== 'loading') {
    const recommendation = recommendations.find(rec => rec.id === autoStartRecommendationId);
    return (
      <AutoStartRecommendation
        action={recAction(recommendation)}
        onConsumed={onAutoStartConsumed}
        onNavigate={onNavigate}
      />
    );
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Zap size={24} className="text-port-accent" />
          <h2 className="text-xl font-bold text-white">Power On Self Test</h2>
        </div>
        <nav aria-label="POST sections" className="flex flex-wrap gap-2">
          {LAUNCHER_LINKS.map(({ to, label, icon, primary }) => {
            const Icon = postIcon(icon);
            return (
            <Link
              key={to}
              to={to}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                primary
                  ? 'text-port-accent bg-port-accent/10 border-port-accent/40 hover:bg-port-accent/20'
                  : 'text-gray-400 hover:text-white bg-port-card border-port-border'
              }`}
            >
              <Icon size={14} />
              {label}
            </Link>
            );
          })}
        </nav>
      </div>

      {reviewRepsError && (
        <ListLoadError what="due skill reviews" error={reviewRepsError} onRetry={loadReviewReps} />
      )}

      {/* Main + sidebar: primary session flow on the left, drill summaries + history on the right */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-6 items-start">
        {/* Primary flow — kept above the fold */}
        <div className="space-y-6 min-w-0">
          {/* Start — the first thing on the page, so a daily-habit user never has
              to scroll past status/goals/analytics to begin (issue #3249). Holds
              the recommended next action, both session starts, and the mode
              toggle; the optional Conditions form is collapsed behind a
              disclosure so it can't push the buttons below the fold. */}
          <PostStartCard
            primaryAction={primaryAction}
            compositionExcludesAll={compositionExcludesAll}
            domainCount={domainCount}
            quickPlan={quickPlan}
            quickDurationMin={quickDurationMin}
            quickDurationSaveState={quickDurationSaveState}
            handleQuickDurationChange={handleQuickDurationChange}
            handleQuickSession={handleQuickSession}
            hasSessionDrills={hasSessionDrills}
            handleStart={handleStart}
            mode={mode}
            setMode={setMode}
            benchmarkState={benchmarkState}
            benchmarkError={benchmarkError}
            handleBenchmarkSession={handleBenchmarkSession}
            conditions={conditions}
            setConditions={setConditions}
            showConditions={showConditions}
            setShowConditions={setShowConditions}
          />
          <PostAnalyticsSection
            today={today}
            recentSessions={recentSessions}
            stats={stats}
            statsWeek={statsWeek}
            goals={config.goals}
            morseWpm={morseWpm}
            todayMinutesTotal={todayMinutesTotal}
            enabledDomains={enabledDomains}
            handleFocusDomain={handleFocusDomain}
            recommendations={recommendations}
            recAction={recAction}
          />

          {/* Maintenance-review nudge (issue #2096) — mastered skills due for a
              refresh, mixed into the next Quick session as labeled review reps. */}
          {allowedReviewReps.length > 0 && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-port-warning/10 border border-port-warning/30 text-sm text-port-warning">
              <Target size={16} className="mt-0.5 shrink-0" />
              <span>
                {allowedReviewReps.length} skill{allowedReviewReps.length > 1 ? 's' : ''} due for a maintenance rep
                {' '}— a Quick session will mix {allowedReviewReps.length > 1 ? 'them' : 'it'} in: {allowedReviewReps.slice(0, 2).map(r => r.label).join(', ')}
              </span>
            </div>
          )}
        </div>

        {/* Sidebar — drill summaries + recent sessions flow alongside on desktop */}
        <PostDrillsSidebar
          drillCatalog={drillCatalog}
          providers={providers}
          recentSessions={recentSessions}
          setHowItWorksType={setHowItWorksType}
        />
      </div>

      <CognitiveDrillTutorialPreview
        type={howItWorksType}
        drillConfig={howItWorksType ? config.cognitive?.drillTypes?.[howItWorksType] : null}
        cognitiveProgress={cognitiveProgress}
        onClose={() => setHowItWorksType(null)}
      />
    </div>
  );
}

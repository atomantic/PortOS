import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Zap, History, Settings, Play, Brain, BookOpen, Dumbbell, Timer, Radio, Target, TrendingUp, TrendingDown, Minus, Compass, ArrowRight, Layers } from 'lucide-react';
import { getProviders, getPostReviewReps, getPostRecommendations, getMorseProgress } from '../../../services/api';
import { FormField } from '../../ui/FormField';
import { isApiProvider } from '../../../utils/providers';
import { DOMAINS, DRILL_TO_DOMAIN, DRILL_LABELS, computeDomainAverages, computeGoalProgress } from './constants';
import { streakGlyph } from '../../../lib/streakGlyph.js';

// Canonical domain visiting order for interleaved "Full POST" composition
// (issue #2100): alternate domains — math → cognitive → memory → verbal — so a
// session is spaced/varied rather than blocked (all math, then all cognitive).
// Domains not listed here interleave after, in first-seen order.
export const INTERLEAVE_DOMAIN_ORDER = ['math', 'cognitive', 'memory', 'verbal', 'wordplay', 'imagination'];

/**
 * Round-robin interleave drill configs by their `domain` tag: one drill from
 * each domain per round, in INTERLEAVE_DOMAIN_ORDER, until every drill is
 * placed. Preserves per-domain input order. Pure — exported for unit tests.
 */
export function interleaveByDomain(drills, order = INTERLEAVE_DOMAIN_ORDER) {
  const groups = new Map();
  for (const d of drills || []) {
    const key = d.domain || 'other';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const domainOrder = [
    ...order.filter(k => groups.has(k)),
    ...[...groups.keys()].filter(k => !order.includes(k)),
  ];
  const lengths = [...groups.values()].map(g => g.length);
  const maxLen = lengths.length ? Math.max(...lengths) : 0;
  const result = [];
  for (let round = 0; round < maxLen; round++) {
    for (const key of domainOrder) {
      const list = groups.get(key);
      if (round < list.length) result.push(list[round]);
    }
  }
  return result;
}

const scoreColorClass = (score) =>
  score >= 80 ? 'text-port-success' : score >= 50 ? 'text-port-warning' : 'text-port-error';

// Short "at a glance" summary chip per cognitive drill type, shown next to
// its label in the launcher sidebar. Pure — no closures over component state.
export function cognitiveSummary(type, cfg) {
  if (type === 'n-back') return `${cfg.n ?? 2}-back`;
  if (type === 'digit-span') return `${cfg.startLength ?? 3}–${cfg.maxLength ?? 8}`;
  if (type === 'schulte-table') return `${cfg.size ?? 5}×${cfg.size ?? 5}`;
  if (type === 'reaction-time') return `${cfg.count ?? 15} trials (${cfg.mode ?? 'simple'})`;
  return cfg.count ? `${cfg.count} trials` : '';
}

// Pure: sanitizes the optional condition-tags map before submit — drops
// empty/whitespace-only values so a session with no conditions filled in
// doesn't persist `{ sleep: '', caffeine: '', stress: '' }` to history.
// `tags` is passed explicitly (lifted from the component's `tags` state).
export function buildCleanTags(tags) {
  const cleanTags = {};
  for (const [k, v] of Object.entries(tags)) {
    if (v.trim()) cleanTags[k] = v.trim();
  }
  return cleanTags;
}

export default function PostSessionLauncher({ config, recentSessions, stats, statsWeek, onStart, onViewHistory, onViewConfig, onViewMemory, onViewMorse }) {
  const [tags, setTags] = useState({ sleep: '', caffeine: '', stress: '' });
  const [mode, setMode] = useState('test'); // 'test' | 'train'
  const [providers, setProviders] = useState([]);
  // Mastered-but-inactive skills due for a maintenance review (issue #2096) —
  // the Quick session mixes up to 2 of these in as labeled review reps. Empty
  // until a skill is mastered and its review interval elapses; a load failure
  // silently degrades to a plain Quick session.
  const [reviewReps, setReviewReps] = useState([]);
  // Ordered "what to practice next" recommendations (issue #2100). A load
  // failure silently degrades to an empty list (the panel hides). The top
  // recommendation also biases the Quick session's drill picks.
  const [recommendations, setRecommendations] = useState([]);
  // Current effective Morse WPM — fetched only when a Morse WPM goal is set, so
  // that goal can render progress (issue #2100). null when unset/unavailable.
  const [morseWpm, setMorseWpm] = useState(null);

  useEffect(() => {
    getProviders().then(p => setProviders((p || []).filter(pr => pr.enabled && isApiProvider(pr)))).catch(err => console.warn('⚠️ Failed to load providers: ' + err.message));
    getPostReviewReps(2).then(r => setReviewReps(r?.reps || [])).catch(() => setReviewReps([]));
    getPostRecommendations().then(r => setRecommendations(r?.recommendations || [])).catch(() => setRecommendations([]));
  }, []);

  // Only fetch Morse progress when a Morse WPM goal exists — avoids an extra
  // request on the common path. Effective WPM prefers the Farnsworth setting.
  useEffect(() => {
    if (!config?.goals?.morseWpmTarget) { setMorseWpm(null); return; }
    let cancelled = false;
    getMorseProgress(30, { silent: true })
      .then(m => {
        if (cancelled) return;
        const wpm = m?.settings?.farnsworthWpm ?? m?.settings?.wpm ?? null;
        setMorseWpm(typeof wpm === 'number' ? wpm : null);
      })
      .catch(() => { if (!cancelled) setMorseWpm(null); });
    return () => { cancelled = true; };
  }, [config?.goals?.morseWpmTarget]);

  if (!config) {
    return <div className="text-gray-500">Loading configuration...</div>;
  }

  const today = new Date().toISOString().split('T')[0];
  const todaySession = recentSessions?.find(s => s.date === today);
  const lastThree = (recentSessions || []).slice(-3).reverse();

  const enabledMathDrills = Object.entries(config.mentalMath?.drillTypes || {})
    .filter(([, cfg]) => cfg.enabled);

  const enabledLlmDrills = config.llmDrills?.enabled !== false
    ? Object.entries(config.llmDrills?.drillTypes || {}).filter(([, cfg]) => cfg.enabled !== false)
    : [];

  const llmProviderId = config.llmDrills?.providerId || null;
  const llmModel = config.llmDrills?.model || null;

  // Deterministic cognitive drills (n-back / digit-span / stroop). No provider.
  const enabledCognitiveDrills = config.cognitive?.enabled !== false
    ? Object.entries(config.cognitive?.drillTypes || {}).filter(([, cfg]) => cfg.enabled !== false)
    : [];

  // Only the fields each cognitive generator reads; extras are harmless.
  // stimulusMs (n-back) / showMs (digit-span) are forwarded so that manual mode
  // (Progressive off) actually uses the presentation-speed values the user set
  // in PostDrillConfig.jsx (issue #2095) — under the progressive ladder the
  // server overrides them per rung anyway, so forwarding is safe in both modes.
  const cognitiveDrillConfig = (cfg) => ({
    n: cfg.n,
    length: cfg.length,
    stimulusMs: cfg.stimulusMs,
    direction: cfg.direction,
    startLength: cfg.startLength,
    maxLength: cfg.maxLength,
    showMs: cfg.showMs,
    count: cfg.count,
    size: cfg.size,
    mode: cfg.mode,
    minDelayMs: cfg.minDelayMs,
    maxDelayMs: cfg.maxDelayMs,
    choices: cfg.choices,
  });

  // Composed sessions (Full POST / Quick) honor `sessionModules` (issue #2100):
  // a module's drills are only added when it's listed. The default
  // (mental-math + cognitive + memory) excludes LLM drills, so wit/verbal work
  // is never auto-added to a default session — provider-cost consent stays
  // opt-in (CLAUDE.md AI-provider policy). An empty/absent list means "all
  // enabled" (back-compat). Focus-practice on a specific weak domain bypasses
  // this filter (it's an explicit user choice, not a default composition).
  // `null` = no sessionModules set (legacy/absent) → include all enabled
  // (back-compat). An explicit array — INCLUDING an empty one — is honored as-is:
  // unchecking every module in Config is a deliberate "no composed sessions"
  // choice, not the same as never having set it (issue #2100 review).
  const sessionModules = Array.isArray(config.sessionModules) ? config.sessionModules : null;
  const SOURCE_TO_MODULE = { math: 'mental-math', llm: 'llm-drills', cognitive: 'cognitive' };
  const moduleAllowed = (source) => sessionModules === null || sessionModules.includes(SOURCE_TO_MODULE[source]);

  function handleStart() {
    const mathConfigs = (moduleAllowed('math') ? enabledMathDrills : []).map(([type, cfg]) => ({
      type,
      domain: DRILL_TO_DOMAIN[type],
      config: {
        steps: cfg.steps,
        count: cfg.count,
        maxDigits: cfg.maxDigits,
        subtrahend: cfg.subtrahend,
        startRange: cfg.startRange,
        bases: cfg.bases,
        maxExponent: cfg.maxExponent,
        tolerancePct: cfg.tolerancePct
      },
      timeLimitSec: cfg.timeLimitSec || 120
    }));

    const llmConfigs = (moduleAllowed('llm') ? enabledLlmDrills : []).map(([type, cfg]) => ({
      type,
      domain: DRILL_TO_DOMAIN[type],
      config: { count: cfg.count || 5 },
      timeLimitSec: cfg.timeLimitSec || 120,
      providerId: cfg.providerId || llmProviderId,
      model: cfg.model || llmModel
    }));

    const cognitiveConfigs = (moduleAllowed('cognitive') ? enabledCognitiveDrills : []).map(([type, cfg]) => ({
      type,
      domain: DRILL_TO_DOMAIN[type],
      config: cognitiveDrillConfig(cfg)
      // No timeLimitSec — cognitive drills are self-paced/stimulus-driven and
      // never enforce a countdown (see PostCognitiveDrillRunner.jsx).
    }));

    // Interleave across domains (math → cognitive → memory → verbal …) rather
    // than running each module blocked, so a full session spaces varied work
    // for better retention (issue #2100). Full coverage is preserved — every
    // enabled drill still runs, just reordered.
    const drillConfigs = interleaveByDomain([...mathConfigs, ...llmConfigs, ...cognitiveConfigs]);
    onStart(drillConfigs, buildCleanTags(tags), mode === 'train');
  }

  // Build domain → enabled drills map for quick session
  const allEnabledDrills = [
    ...enabledMathDrills.map(([type, cfg]) => ({ type, cfg, source: 'math' })),
    ...enabledLlmDrills.map(([type, cfg]) => ({ type, cfg, source: 'llm' })),
    ...enabledCognitiveDrills.map(([type, cfg]) => ({ type, cfg, source: 'cognitive' })),
  ];

  const enabledDomains = {};
  for (const { type, cfg, source } of allEnabledDrills) {
    const domain = DRILL_TO_DOMAIN[type];
    if (!domain) continue;
    if (!enabledDomains[domain]) enabledDomains[domain] = [];
    enabledDomains[domain].push({ type, cfg, source });
  }

  // Domains eligible for a COMPOSED (Full/Quick) session, after the
  // sessionModules filter — so a default Quick session never silently pulls in
  // an opt-out module's drills (issue #2100).
  const sessionEnabledDomains = {};
  for (const [domainKey, drills] of Object.entries(enabledDomains)) {
    const allowed = drills.filter(d => moduleAllowed(d.source));
    if (allowed.length) sessionEnabledDomains[domainKey] = allowed;
  }

  function handleQuickSession() {
    // Bias toward the top recommendation instead of pure random (issue #2100):
    // if it names a drill type in an enabled domain, run that domain first and
    // pick that exact drill; every other domain still gets a random pick.
    const topRec = recommendations[0] || null;
    const recDrill = topRec?.drillType || null;
    const recDomain = recDrill ? DRILL_TO_DOMAIN[recDrill] : null;
    const domainKeys = Object.keys(sessionEnabledDomains);
    const orderedKeys = recDomain && sessionEnabledDomains[recDomain]
      ? [recDomain, ...domainKeys.filter(k => k !== recDomain)]
      : domainKeys;

    const drillConfigs = [];
    for (const domainKey of orderedKeys) {
      const drills = sessionEnabledDomains[domainKey];
      const domain = DOMAINS[domainKey];
      // Prefer the recommended drill in its domain; otherwise pick at random.
      const recommendedPick = domainKey === recDomain
        ? drills.find(d => d.type === recDrill)
        : null;
      const pick = recommendedPick || drills[Math.floor(Math.random() * drills.length)];
      const cfg = pick.cfg;

      let quickConfig;
      if (pick.source === 'math') {
        quickConfig = {
          steps: cfg.steps,
          count: cfg.count ? Math.min(cfg.count, 5) : undefined,
          maxDigits: cfg.maxDigits,
          subtrahend: cfg.subtrahend,
          startRange: cfg.startRange,
          bases: cfg.bases,
          maxExponent: cfg.maxExponent,
          tolerancePct: cfg.tolerancePct,
        };
      } else if (pick.source === 'cognitive') {
        // Keep the drill short for a balanced 5-minute session.
        quickConfig = { ...cognitiveDrillConfig(cfg), count: cfg.count ? Math.min(cfg.count, 10) : undefined };
      } else {
        quickConfig = { count: Math.min(cfg.count || 5, 3) }; // Fewer prompts for quick session
      }

      const drillConfig = {
        type: pick.type,
        domain: domainKey,
        config: quickConfig,
        timeLimitSec: domain.timeBudgetSec,
      };

      if (pick.source === 'llm') {
        drillConfig.providerId = cfg.providerId || llmProviderId;
        drillConfig.model = cfg.model || llmModel;
      }

      drillConfigs.push(drillConfig);
    }

    // Mix in up to 2 maintenance reps for mastered-but-inactive skills that are
    // due for re-verification (issue #2096). Each carries the review markers so
    // the server re-verifies the specific rung and records the pass/fail.
    for (const rep of reviewReps.slice(0, 2)) {
      drillConfigs.push({
        type: rep.type,
        domain: DRILL_TO_DOMAIN[rep.type],
        config: rep.config,
        timeLimitSec: DOMAINS[DRILL_TO_DOMAIN[rep.type]]?.timeBudgetSec,
        isReview: true,
        reviewLabel: rep.label,
        ...(rep.providerId && { providerId: rep.providerId }),
      });
    }

    onStart(drillConfigs, buildCleanTags(tags), mode === 'train');
  }

  // Focused practice on a single domain: run every enabled drill in that domain
  // (not one random pick, unlike the balanced quick session) so the weakest
  // domain gets a substantive workout.
  function handleFocusDomain(domainKey) {
    const drills = enabledDomains[domainKey];
    if (!drills || drills.length === 0) return;
    const domain = DOMAINS[domainKey];
    const drillConfigs = drills.map(({ type, cfg, source }) => {
      let focusConfig;
      if (source === 'math') {
        focusConfig = {
          steps: cfg.steps,
          count: cfg.count,
          maxDigits: cfg.maxDigits,
          subtrahend: cfg.subtrahend,
          startRange: cfg.startRange,
          bases: cfg.bases,
          maxExponent: cfg.maxExponent,
          tolerancePct: cfg.tolerancePct,
        };
      } else if (source === 'cognitive') {
        focusConfig = cognitiveDrillConfig(cfg);
      } else {
        focusConfig = { count: cfg.count || 5 };
      }
      const drillConfig = {
        type,
        domain: domainKey,
        config: focusConfig,
        timeLimitSec: cfg.timeLimitSec || domain?.timeBudgetSec || 120,
      };
      if (source === 'llm') {
        drillConfig.providerId = cfg.providerId || llmProviderId;
        drillConfig.model = cfg.model || llmModel;
      }
      return drillConfig;
    });
    onStart(drillConfigs, buildCleanTags(tags), mode === 'train');
  }

  const hasAnyDrills = enabledMathDrills.length > 0 || enabledLlmDrills.length > 0 || enabledCognitiveDrills.length > 0;
  // Quick-session domain count reflects the sessionModules-filtered set, so the
  // "Quick 5 Min (N domains)" button matches what it will actually run.
  const domainCount = Object.keys(sessionEnabledDomains).length;
  // A COMPOSED session (Full/Quick) only has drills to run if the
  // sessionModules-filtered set is non-empty — the buttons gate on this, not on
  // the unfiltered `hasAnyDrills`, so selecting only empty modules disables them
  // instead of failing with "No drills configured" (issue #2100 review).
  const hasSessionDrills = domainCount > 0;
  // Drills are configured/enabled but the Session Composition filter excludes
  // them all — surface why the start buttons are disabled.
  const compositionExcludesAll = hasAnyDrills && !hasSessionDrills;

  // Analytics derived from the 30-day stats window. Streaks span all history.
  const hasStats = stats && stats.sessionCount > 0;
  const currentStreak = stats?.currentStreak ?? 0;
  const longestStreak = stats?.longestStreak ?? 0;
  const overall30 = stats?.overall ?? null;
  const overall7 = statsWeek?.overall ?? null;
  // Trend: 7-day average relative to the 30-day average. Needs both to exist.
  const trendDelta = overall7 != null && overall30 != null ? overall7 - overall30 : null;

  // Weakest domain = lowest-scoring domain that ALSO has enabled drills, so the
  // one-click focus button always targets something the user can actually run.
  const domainAverages = hasStats ? computeDomainAverages(stats.byDrill) : [];
  const weakestDomain = domainAverages
    .filter(d => enabledDomains[d.key])
    .reduce((weakest, d) => (!weakest || d.score < weakest.score ? d : weakest), null);

  // Goal progress (issue #2100). Metrics come from data already on hand — no
  // extra fetch: today's minutes from today's sessions, week sessions from the
  // 7-day stats window, streak from the unified streak. Morse WPM has no metric
  // here (would need a Morse fetch), so a morseWpmTarget goal is simply omitted
  // — computeGoalProgress skips goals whose metric is unavailable.
  const todaysSessions = (recentSessions || []).filter(s => s.date === today);
  const todayMinutes = Math.round(todaysSessions.reduce((sum, s) => sum + (s.durationMs || 0), 0) / 60000);
  const weekSessions = statsWeek?.sessionCount ?? 0;
  const goalRows = computeGoalProgress(config.goals, { todayMinutes, weekSessions, currentStreak, morseWpm });

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Zap size={24} className="text-port-accent" />
          <h2 className="text-xl font-bold text-white">Power On Self Test</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onViewMemory}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors"
          >
            <BookOpen size={14} />
            Memory
          </button>
          <button
            onClick={onViewMorse}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors"
          >
            <Radio size={14} />
            Morse
          </button>
          <button
            onClick={onViewHistory}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors"
          >
            <History size={14} />
            History
          </button>
          <button
            onClick={onViewConfig}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors"
          >
            <Settings size={14} />
            Config
          </button>
        </div>
      </div>

      {/* Main + sidebar: primary session flow on the left, drill summaries + history on the right */}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_22rem] gap-6 items-start">
        {/* Primary flow — kept above the fold */}
        <div className="space-y-6 min-w-0">
          {/* Today's Status */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <div className="flex items-center justify-between">
              <span className="text-gray-400 text-sm">Today's Status</span>
              {todaySession ? (
                <span className="text-port-success text-sm font-medium">
                  Completed — Score: {todaySession.score}
                </span>
              ) : (
                <span className="text-port-warning text-sm font-medium">Not yet completed</span>
              )}
            </div>
          </div>

          {/* Goals — progress vs the user's configured targets (issue #2100).
              Hidden entirely until at least one goal is set. */}
          {goalRows.length > 0 && (
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-3">Goals</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {goalRows.map(g => (
                  <div key={g.key}>
                    <div className="flex items-baseline justify-between gap-1">
                      <span className="text-xs text-gray-500 truncate">{g.label}</span>
                      {g.met && <span className="text-xs text-port-success" aria-hidden="true">✓</span>}
                    </div>
                    <div className={`text-sm font-mono ${g.met ? 'text-port-success' : 'text-white'}`}>
                      {g.current}/{g.target}{g.unit ? ` ${g.unit}` : ''}
                    </div>
                    <div className="h-1.5 mt-1 rounded-full bg-port-bg overflow-hidden">
                      <div
                        className={`h-full rounded-full ${g.met ? 'bg-port-success' : 'bg-port-accent'}`}
                        style={{ width: `${g.pct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* "Up next" — prioritized recommendations with deep links into the
              exact drill/mode (issue #2100). Hidden if none loaded. */}
          {recommendations.length > 0 && (
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Compass size={16} className="text-port-accent" />
                <h3 className="text-sm font-medium text-gray-300">Up next</h3>
              </div>
              <div className="space-y-2">
                {recommendations.map(rec => (
                  <Link
                    key={rec.id}
                    to={rec.deepLink}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg bg-port-bg border border-port-border hover:border-port-accent/60 transition-colors group"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm text-white truncate">{rec.title}</div>
                      {rec.detail && <div className="text-xs text-gray-500 truncate">{rec.detail}</div>}
                    </div>
                    <ArrowRight size={14} className="text-gray-600 group-hover:text-port-accent shrink-0" />
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Progress analytics — streak, 7-vs-30-day trend, weakest-domain focus.
              Degrades to nothing until there's scored history to summarize. */}
          {hasStats && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {/* Streak */}
                <div className="bg-port-card border border-port-border rounded-lg p-4 flex items-center gap-3">
                  <div className="text-2xl" aria-hidden="true">{streakGlyph(currentStreak)}</div>
                  <div className="min-w-0">
                    <div className="text-xl font-bold text-white leading-tight">
                      {currentStreak} day{currentStreak !== 1 ? 's' : ''}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {currentStreak > 0 ? 'Current streak' : 'No streak yet'}
                      {longestStreak > 0 && ` · best ${longestStreak}`}
                    </div>
                  </div>
                </div>
                {/* 7-day trend vs 30-day baseline */}
                <div className="bg-port-card border border-port-border rounded-lg p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className={`text-xl font-bold leading-tight ${overall7 != null ? scoreColorClass(overall7) : 'text-gray-500'}`}>
                        {overall7 != null ? overall7 : '—'}
                      </div>
                      <div className="text-xs text-gray-500">7-day avg</div>
                    </div>
                    {trendDelta != null && (
                      <div className={`flex items-center gap-0.5 text-sm font-medium shrink-0 ${
                        trendDelta > 0 ? 'text-port-success' : trendDelta < 0 ? 'text-port-error' : 'text-gray-400'
                      }`}>
                        {trendDelta > 0 ? <TrendingUp size={16} /> : trendDelta < 0 ? <TrendingDown size={16} /> : <Minus size={16} />}
                        {trendDelta > 0 ? '+' : ''}{trendDelta}
                      </div>
                    )}
                  </div>
                  {overall30 != null && (
                    <div className="text-xs text-gray-600 mt-1">vs {overall30} over 30 days</div>
                  )}
                </div>
              </div>

              {/* Weakest-domain callout + one-click focused practice */}
              {weakestDomain && (
                <div className="bg-port-card border border-port-border rounded-lg p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    <Target size={18} className={`mt-0.5 shrink-0 ${DOMAINS[weakestDomain.key]?.color || 'text-port-warning'}`} />
                    <div className="min-w-0">
                      <div className="text-sm text-white">
                        Lowest domain this month:{' '}
                        <span className={`font-semibold ${DOMAINS[weakestDomain.key]?.color || 'text-white'}`}>{weakestDomain.label}</span>
                        {' — '}
                        <span className={`font-mono ${scoreColorClass(weakestDomain.score)}`}>{weakestDomain.score} avg</span>
                      </div>
                      <div className="text-xs text-gray-500">Focus a short session here to bring it up.</div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleFocusDomain(weakestDomain.key)}
                    className="shrink-0 flex items-center justify-center gap-2 px-4 py-2 bg-port-warning/20 hover:bg-port-warning/30 text-port-warning border border-port-warning/40 rounded-lg text-sm font-medium transition-colors"
                  >
                    <Target size={14} />
                    Practice {weakestDomain.label}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Mode Toggle */}
          <div className="bg-port-card border border-port-border rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Session Mode</h3>
            <div className="flex gap-2">
              <button
                onClick={() => setMode('test')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  mode === 'test'
                    ? 'bg-port-accent text-white'
                    : 'bg-port-bg border border-port-border text-gray-400 hover:text-white'
                }`}
              >
                <Zap size={14} />
                Test
              </button>
              <button
                onClick={() => setMode('train')}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  mode === 'train'
                    ? 'bg-port-accent-2 text-port-on-accent-2'
                    : 'bg-port-bg border border-port-border text-gray-400 hover:text-white'
                }`}
              >
                <Dumbbell size={14} />
                Train
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {mode === 'train'
                ? 'Training mode: immediate feedback, hints on wrong answers. Not scored.'
                : 'Test mode: timed drills with scoring. Saved to history.'}
            </p>
          </div>

          {/* Condition Tags */}
          {mode === 'test' && <div className="bg-port-card border border-port-border rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">Conditions (optional)</h3>
            <div className="grid grid-cols-3 gap-3">
              {Object.entries(tags).map(([key, value]) => (
                <FormField key={key} labelClassName="text-xs text-gray-500 mb-1 block capitalize" label={key}>
                  <input
                    type="text"
                    value={value}
                    onChange={e => setTags(prev => ({ ...prev, [key]: e.target.value }))}
                    placeholder={key === 'sleep' ? 'good/poor' : key === 'caffeine' ? '1 cup' : 'low/high'}
                    className="w-full bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm text-white placeholder-gray-600 focus:border-port-accent focus:outline-none"
                  />
                </FormField>
              ))}
            </div>
          </div>}

          {/* Maintenance-review nudge (issue #2096) — mastered skills due for a
              refresh, mixed into the next Quick session as labeled review reps. */}
          {reviewReps.length > 0 && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-port-warning/10 border border-port-warning/30 text-sm text-port-warning">
              <Target size={16} className="mt-0.5 shrink-0" />
              <span>
                {reviewReps.length} skill{reviewReps.length > 1 ? 's' : ''} due for a maintenance rep
                {' '}— a Quick session will mix {reviewReps.length > 1 ? 'them' : 'it'} in: {reviewReps.slice(0, 2).map(r => r.label).join(', ')}
              </span>
            </div>
          )}

          {/* Composition-excludes-everything notice — the start buttons below are
              disabled because Session Composition filtered out all enabled drills. */}
          {compositionExcludesAll && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-port-warning/10 border border-port-warning/30 text-sm text-port-warning">
              <Layers size={16} className="mt-0.5 shrink-0" />
              <span>Your Session Composition excludes every enabled drill — adjust it under Config → Session Composition to run a session.</span>
            </div>
          )}

          {/* Start Buttons */}
          <div className="flex flex-col sm:flex-row gap-3">
            {domainCount >= 2 && (
              <button
                onClick={handleQuickSession}
                disabled={!hasSessionDrills}
                className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 ${
                  mode === 'train'
                    ? 'bg-port-accent-2 hover:bg-port-accent-2/80 text-port-on-accent-2'
                    : 'bg-port-success hover:bg-port-success/80 text-white'
                } disabled:opacity-50 disabled:cursor-not-allowed font-medium rounded-lg transition-colors`}
              >
                <Timer size={18} />
                Quick 5 Min ({domainCount} domains)
              </button>
            )}
            <button
              onClick={handleStart}
              disabled={!hasSessionDrills}
              className={`flex-1 flex items-center justify-center gap-2 px-6 py-3 ${
                mode === 'train'
                  ? 'bg-port-accent-2/70 hover:bg-port-accent-2/80 text-port-on-accent-2'
                  : 'bg-port-accent hover:bg-port-accent/80 text-white'
              } disabled:opacity-50 disabled:cursor-not-allowed font-medium rounded-lg transition-colors`}
            >
              {mode === 'train' ? <Dumbbell size={18} /> : <Play size={18} />}
              {mode === 'train' ? 'Full Training' : 'Full POST'}
            </button>
          </div>
        </div>

        {/* Sidebar — drill summaries + recent sessions flow alongside on desktop */}
        <div className="space-y-6 min-w-0">
          {/* Mental Math Drills */}
          {enabledMathDrills.length > 0 && (
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-3">Mental Math</h3>
              <div className="space-y-2">
                {enabledMathDrills.map(([type, cfg]) => (
                  <div key={type} className="flex items-center justify-between text-sm">
                    <span className="text-white">{DRILL_LABELS[type] || type}</span>
                    <span className="text-gray-500">
                      {cfg.steps ? `${cfg.steps} steps` : cfg.count ? `${cfg.count} questions` : ''}
                      {cfg.timeLimitSec ? ` · ${cfg.timeLimitSec}s` : ''}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* LLM Drills */}
          {enabledLlmDrills.length > 0 && (
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Brain size={14} className="text-port-accent-2" />
                <h3 className="text-sm font-medium text-gray-400">Wit & Memory</h3>
                {(llmProviderId || providers.length > 0) && (
                  <span className="text-xs text-gray-600 ml-auto">
                    {llmProviderId || 'system default'}
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {enabledLlmDrills.map(([type, cfg]) => (
                  <div key={type} className="flex items-center justify-between text-sm">
                    <span className="text-white">{DRILL_LABELS[type] || type}</span>
                    <span className="text-gray-500">
                      {cfg.count ? `${cfg.count} prompts` : ''}
                      {cfg.timeLimitSec ? ` · ${cfg.timeLimitSec}s` : ''}
                    </span>
                  </div>
                ))}
              </div>
              {/* These are enabled but not in a default composed session — LLM
                  drills stay opt-in for provider-cost consent (issue #2100). */}
              {!moduleAllowed('llm') && (
                <p className="mt-3 text-xs text-gray-500">
                  Not in Full POST / Quick sessions. Add “Wit &amp; Memory (AI)” under Config → Session Composition to include them.
                </p>
              )}
            </div>
          )}

          {/* Cognitive Drills (deterministic — no provider) */}
          {enabledCognitiveDrills.length > 0 && (
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <Brain size={14} className="text-rose-400" />
                <h3 className="text-sm font-medium text-gray-400">Cognitive</h3>
              </div>
              <div className="space-y-2">
                {enabledCognitiveDrills.map(([type, cfg]) => (
                  <div key={type} className="flex items-center justify-between text-sm">
                    <span className="text-white">{DRILL_LABELS[type] || type}</span>
                    <span className="text-gray-500">
                      {cognitiveSummary(type, cfg)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!hasAnyDrills && (
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <p className="text-gray-500 text-sm">No drills enabled. Configure drills to get started.</p>
            </div>
          )}

          {/* Recent Scores */}
          {lastThree.length > 0 && (
            <div className="bg-port-card border border-port-border rounded-lg p-4">
              <h3 className="text-sm font-medium text-gray-400 mb-3">Recent Sessions</h3>
              <div className="space-y-2">
                {lastThree.map(s => (
                  <div key={s.id} className="flex items-center justify-between text-sm">
                    <span className="text-gray-400">{s.date}</span>
                    <span className={`font-mono font-medium ${
                      s.score >= 80 ? 'text-port-success' :
                      s.score >= 50 ? 'text-port-warning' :
                      'text-port-error'
                    }`}>
                      {s.score}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

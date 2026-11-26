import { useCallback, useEffect, useState } from 'react';
import {
  getPostReviewReps,
  getPostRecommendations,
  getMorseProgress,
  getPostProgress,
  getMemoryItems,
  getPostCognitiveProgress,
} from '../../../services/apiMeatspace.js';
import { enabledApiProviderFilter } from '../../../utils/providers';
import useProviderModels from '../../../hooks/useProviderModels.js';
import { todayKeyInTimezone } from '../../../utils/timezone.js';
import { normalizeQuickDurationMinutes } from '../../../lib/postQuickSession.js';
import { COGNITIVE_LADDER_TYPES } from './constants';

export default function usePostLauncherData(config, timezone) {
  const [quickDurationMin, setQuickDurationMin] = useState(() => normalizeQuickDurationMinutes(config?.quickDurationMin));
  const [cognitiveProgress, setCognitiveProgress] = useState(null);

  useEffect(() => {
    setQuickDurationMin(normalizeQuickDurationMinutes(config?.quickDurationMin));
  }, [config?.quickDurationMin]);
  // `getProviders()` resolves `{ activeProvider, providers }`, not a bare array.
  // Unwrapping it by hand here read the object as the list and threw on every
  // mount, so the panel below never learned which provider a run would use — go
  // through the shared hook that owns the unwrap instead of a fourth copy of it.
  // `allowDefault` keeps it from auto-selecting a provider; this is a read-only
  // "is anything configured" signal, not a picker.
  const { providers } = useProviderModels({
    filter: enabledApiProviderFilter,
    allowDefault: true,
    silent: true,
  });
  // Mastered-but-inactive skills due for a maintenance review (issue #2096) —
  // the Quick session mixes up to 2 of these in as labeled review reps. Empty
  // until a skill is mastered and its review interval elapses; a load failure
  // silently degrades to a plain Quick session.
  const [reviewReps, setReviewReps] = useState([]);
  // A failed read must not look like "no reviews due": the Quick session and the
  // skill-review rows both depend on it.
  const [reviewRepsError, setReviewRepsError] = useState(null);
  // Ordered "what to practice next" recommendations (issue #2100). A load
  // failure silently degrades to an empty list (the panel hides). The top
  // recommendation also biases the Quick session's drill picks.
  const [recommendations, setRecommendations] = useState([]);
  const [recommendationsLoaded, setRecommendationsLoaded] = useState(false);
  // Compact multi-day practice window from the same endpoint (issue #5319), so
  // the Quick session rotates its per-domain picks off exactly the signal the
  // server used to order the recommendations. null = not loaded / load failed,
  // which composeQuickSession degrades to its previous fixed ordering.
  const [recentPractice, setRecentPractice] = useState(null);
  // Current effective Morse WPM — fetched only when a Morse WPM goal is set, so
  // that goal can render progress (issue #2100). null when unset/unavailable.
  const [morseWpm, setMorseWpm] = useState(null);
  // Today's TOTAL training minutes (scored sessions + training-log practice —
  // Training mode, Morse, memory) for the daily-minutes goal. Fetched only when
  // that goal is set; null falls back to the scored-session-only estimate.
  const [todayMinutesTotal, setTodayMinutesTotal] = useState(null);
  // Memory is opt-in for composed sessions, but its generator cannot run
  // without an enabled item. Keep loading/error distinct from a confirmed-empty
  // list and fail closed until the item pool is known (issue #3254).
  const [memoryItemsState, setMemoryItemsState] = useState({ status: 'loading', items: [] });

  const loadReviewReps = useCallback(() => {
    setReviewRepsError(null);
    getPostReviewReps(5, { silent: true })
      .then(r => setReviewReps(r?.reps || []))
      .catch(err => setReviewRepsError(err instanceof Error ? err : new Error('Request failed')));
  }, []);

  useEffect(() => {
    let active = true;
    loadReviewReps();
    getPostRecommendations()
      .then(r => {
        if (!active) return;
        setRecommendations(r?.recommendations || []);
        setRecentPractice(r?.recentPractice || null);
      })
      .catch(() => {
        if (!active) return;
        setRecommendations([]);
        setRecentPractice(null);
      })
      .finally(() => { if (active) setRecommendationsLoaded(true); });
    getMemoryItems({ silent: true })
      .then(items => { if (active) setMemoryItemsState({ status: 'ready', items: Array.isArray(items) ? items : [] }); })
      .catch(() => { if (active) setMemoryItemsState({ status: 'error', items: [] }); });
    return () => { active = false; };
  }, [loadReviewReps]);

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

  // Cognitive ladder rungs. Needed only so the "How it works" card describes the
  // drill that will ACTUALLY run: while a laddered drill is progressive (the
  // shipped default) the server overrides the stored knobs with the rung's
  // config, so the card would otherwise teach the wrong lag / recall direction.
  // Conditional-fetch like the goal-scoped effects above — nothing is requested
  // on an install with no progressive cognitive drill enabled.
  const needsCognitiveProgress = config?.cognitive?.enabled !== false
    && COGNITIVE_LADDER_TYPES.some(type => {
      const cfg = config?.cognitive?.drillTypes?.[type];
      return cfg && cfg.enabled !== false && cfg.progressive !== false;
    });
  useEffect(() => {
    if (!needsCognitiveProgress) { setCognitiveProgress(null); return; }
    let cancelled = false;
    getPostCognitiveProgress({ silent: true })
      .then(p => { if (!cancelled) setCognitiveProgress(p || {}); })
      // `{}` on failure, not null: null means "not fetched yet" and would leave
      // the preview waiting forever on a rung that is never coming.
      .catch(err => {
        console.warn('⚠️ Failed to load cognitive progress: ' + err.message);
        if (!cancelled) setCognitiveProgress({});
      });
    return () => { cancelled = true; };
  }, [needsCognitiveProgress]);

  // Today's total training minutes (incl. training-log practice) — fetched only
  // when a daily-minutes goal is set, so that goal counts Training/Morse/memory
  // time, not just scored sessions (issue #2100 review).
  useEffect(() => {
    if (!config?.goals?.dailyMinutes) { setTodayMinutesTotal(null); return; }
    let cancelled = false;
    getPostProgress(1, { silent: true })
      .then(p => {
        if (cancelled) return;
        const t = todayKeyInTimezone(timezone);
        const todayBucket = (p?.series?.byDay || []).find(d => d.date === t);
        setTodayMinutesTotal(todayBucket ? todayBucket.minutes : 0);
      })
      .catch(() => { if (!cancelled) setTodayMinutesTotal(null); });
    return () => { cancelled = true; };
  }, [config?.goals?.dailyMinutes, timezone]);

  return {
    quickDurationMin, setQuickDurationMin, providers, reviewReps, reviewRepsError, loadReviewReps,
    recommendations, recommendationsLoaded, recentPractice, morseWpm, todayMinutesTotal,
    memoryItemsState, cognitiveProgress,
  };
}

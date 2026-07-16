import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  Compass, ArrowRight, X, CheckCircle2, Target, Sparkles,
  Brain, HeartPulse, PenLine, Globe, Clapperboard, Users,
  BookOpen, Package, Share2, ListTree, BrainCircuit,
} from 'lucide-react';
import * as api from '../../../services/api';
import { getGoalFeatureAreas } from '../../../lib/goalFeatureMap.js';

// Resolve a feature-area icon NAME (kept as a string in goalFeatureMap so that
// module stays React-free and server-mirrorable) to a lucide component.
const AREA_ICONS = {
  Brain, HeartPulse, PenLine, Globe, Clapperboard, Users,
  BookOpen, Package, Share2, ListTree, BrainCircuit, Target,
};

// Daily Driver (issue #2666): a self-dismissing card that, on the first visit
// of the day, sequences the user through their daily POST → per-goal
// next-actions → (no goals) a "define your goals" nudge. It COMPOSES existing
// signals (POST stats/recommendations, goals + the deterministic
// goal→feature map) — it makes ZERO LLM calls on render (AI Provider Usage
// Policy); the goal check-in remains an explicit action on the Goals page.
//
// Visibility is gated in the registry on `dashboardState.dailyDriver` +
// `!handledToday`, so a handled day removes the card (no reserved empty cell).
// "Dismiss" / "all done" marks the day handled and refetches so the gate hides it.
export default function DailyDriverWidget({ dashboardState }) {
  const [post, setPost] = useState(null);
  const [topRec, setTopRec] = useState(null);
  const [goals, setGoals] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  const refetchDashboard = dashboardState?.refetch;

  const fetchData = useCallback(async () => {
    const [stats, recs, goalsData] = await Promise.all([
      api.getPostStats().catch(() => null),
      api.getPostRecommendations(1).catch(() => null),
      api.getGoals({ silent: true }).catch(() => null),
    ]);
    setPost(stats);
    setTopRec(recs?.recommendations?.[0] || null);
    setGoals((goalsData?.goals || []).filter((g) => g.status === 'active'));
    setLoaded(true);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Mark the day handled, then refetch dashboard state so the registry gate
  // drops the card. Optimistically hides immediately.
  const handleDismiss = useCallback(async () => {
    setDismissing(true);
    await api.markDailyDriverHandled().catch(() => null);
    if (refetchDashboard) await refetchDashboard();
  }, [refetchDashboard]);

  if (!loaded) return null;

  const completedToday = !!post?.completedToday;
  const streak = post?.currentStreak ?? 0;

  return (
    <div className="bg-port-card border border-port-accent/40 rounded-xl p-4 h-full flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={16} className="text-port-accent" />
        <h3 className="text-sm font-semibold text-white">Daily Driver</h3>
        <button
          type="button"
          onClick={handleDismiss}
          disabled={dismissing}
          aria-label="Dismiss for today"
          title="Dismiss for today"
          className="ml-auto p-1 rounded text-gray-500 hover:text-white hover:bg-port-border/60 disabled:opacity-50"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-3">
        {/* ① Daily POST */}
        <Link
          to="/post/launcher"
          className="flex items-center gap-2 p-2 rounded-lg border border-port-border hover:border-gray-600 transition-colors"
        >
          <Brain size={16} className="text-port-accent shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white">Daily POST</div>
            <div className="text-xs text-gray-500 truncate">
              {completedToday
                ? `Done today · ${streak} day streak`
                : topRec
                  ? `Up next: ${topRec.title}`
                  : 'Start your cognitive session'}
            </div>
          </div>
          {completedToday ? (
            <CheckCircle2 size={16} className="text-port-success shrink-0" />
          ) : (
            <span className="flex items-center gap-1 text-xs text-port-accent shrink-0">
              Start <ArrowRight size={12} />
            </span>
          )}
        </Link>

        {/* ② Goal next-actions, or empty-state nudge */}
        {goals.length === 0 ? (
          <Link
            to="/goals/list"
            className="flex items-center gap-2 p-2 rounded-lg border border-dashed border-port-border hover:border-port-accent transition-colors"
          >
            <Target size={16} className="text-port-accent shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-white">Define your goals</div>
              <div className="text-xs text-gray-500 truncate">
                Set the goals the Daily Driver will steer you toward.
              </div>
            </div>
            <ArrowRight size={12} className="text-port-accent shrink-0" />
          </Link>
        ) : (
          <>
            <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">Next actions</div>
            {goals.map((goal) => {
              const areas = getGoalFeatureAreas(goal);
              const latestRec = goal.checkIns?.[goal.checkIns.length - 1]?.recommendations?.[0];
              return (
                <div key={goal.id} className="p-2 rounded-lg border border-port-border">
                  <div className="text-sm font-medium text-white truncate">{goal.title}</div>
                  {latestRec && (
                    <div className="text-xs text-gray-500 truncate mt-0.5">{latestRec}</div>
                  )}
                  {areas.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {areas.map((a) => {
                        const Icon = AREA_ICONS[a.icon] || Target;
                        return (
                          <Link
                            key={a.area}
                            to={a.to}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-port-accent/15 text-port-accent text-xs hover:bg-port-accent/25 transition-colors"
                          >
                            <Icon size={11} />
                            {a.label}
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            <Link
              to="/goals/list"
              className="flex items-center justify-center gap-1 p-2 rounded-lg bg-port-accent/10 text-port-accent text-sm hover:bg-port-accent/20 transition-colors"
            >
              <Compass size={14} /> Check in on all goals
            </Link>
          </>
        )}
      </div>
    </div>
  );
}

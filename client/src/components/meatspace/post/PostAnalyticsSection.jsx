import { Link } from 'react-router';
import { ArrowRight, Compass, Minus, Target, TrendingDown, TrendingUp } from 'lucide-react';
import Pill from '../../ui/Pill';
import { streakGlyph } from '../../../lib/streakGlyph.js';
import { DOMAINS, computeDomainAverages, computeGoalProgress } from './constants';
import { scoreColorClass } from './postLauncherScores';

export default function PostAnalyticsSection({
  today, recentSessions, stats, statsWeek, goals, morseWpm, todayMinutesTotal,
  enabledDomains, handleFocusDomain, recommendations, recAction,
}) {
  const todaySession = recentSessions?.find(s => s.date === today);
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
  // Prefer the training-log-inclusive total (fetched when a daily goal is set);
  // fall back to the scored-session-only estimate otherwise.
  const todayMinutes = todayMinutesTotal != null
    ? todayMinutesTotal
    : Math.round(todaysSessions.reduce((sum, s) => sum + (s.durationMs || 0), 0) / 60000);
  // A stats read that failed (or never loaded) leaves these undefined so
  // computeGoalProgress skips the row instead of showing a false 0/target; a
  // successful payload with a real zero still renders as 0.
  const weekSessions = statsWeek ? (statsWeek.sessionCount ?? 0) : undefined;
  const goalStreak = stats ? currentStreak : undefined;
  const goalRows = computeGoalProgress(goals, { todayMinutes, weekSessions, currentStreak: goalStreak, morseWpm });

  return (
    <>
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
            {recommendations.map(rec => {
              const rowClass = 'flex items-center gap-3 px-3 py-2 rounded-lg bg-port-bg border border-port-border hover:border-port-accent/60 transition-colors group w-full text-left';
              const inner = (
                <>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white truncate">{rec.title}</div>
                    {rec.detail && <div className="text-xs text-gray-500 truncate">{rec.detail}</div>}
                  </div>
                  {/* The server sinks these to the bottom, so the badge
                      explains the reorder. Still clickable — a second rep is
                      allowed, just not what the routine hands you (#3563). */}
                  {rec.practicedToday && <Pill tone="context" size="xs" className="shrink-0">Done today</Pill>}
                  <ArrowRight size={14} className="text-gray-600 group-hover:text-port-accent shrink-0" />
                </>
              );
              // Resolved by the shared `recAction` helper, so an Up next row
              // and the Start card's CTA always do the same thing for the
              // same rec (issue #3249).
              const action = recAction(rec);
              if (action?.to) {
                return (
                  <Link key={rec.id} to={action.to} className={rowClass}>
                    {inner}
                  </Link>
                );
              }
              return (
                <button key={rec.id} type="button" onClick={action?.onClick} disabled={!action} className={`${rowClass} disabled:opacity-50 disabled:cursor-not-allowed`}>
                  {inner}
                </button>
              );
            })}
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
    </>
  );
}

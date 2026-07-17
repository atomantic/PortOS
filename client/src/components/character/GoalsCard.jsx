import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Target, ArrowRight } from 'lucide-react';
import { getGoalsTree } from '../../services/api';
import BrailleSpinner from '../BrailleSpinner';

// The human's real life-goals, surfaced read-only on the Character sheet (#2675) so the sheet
// reflects what the person is actually working toward. Surface, don't duplicate: the goals
// feature at /goals owns every mutation and this card only mirrors the existing service, so
// goal data keeps living in exactly one place.
//
// Like SkillsCard/MetricsCard on the same page this is deliberately a plain read-only card —
// Slice 5 (#2677) owns the page's framing/redesign, so it stays easy to restyle or relocate
// wholesale.

// Goals has no routed per-goal detail today (GoalsListView selects into a local `selectedGoal`
// panel), so every row links to the list rather than inventing a deep link the router cannot
// honor. See PLAN.md — routing that selection through the URL is the goals feature's job.
export const GOALS_PATH = '/goals/list';

const TOP_N = 4;

// `urgency` is null whenever the goals service has nothing to rank against — no birth date
// (the horizon math has no denominator without one), or a goal carrying no horizon. That is
// NOT the same as urgency 0 ("plenty of time"), so nulls sort last instead of being coerced
// to a number they don't have: a user with no birth date still gets their goals listed in
// service order rather than a bogus ranking. Ties keep the service's order because Array#sort
// is stable. Real urgencies are clamped to [0,1] server-side, so -1 can never collide.
const urgencyRank = (urgency) => (Number.isFinite(urgency) ? urgency : -1);

// A missing `status` counts as active, matching server/services/voice/tools/goals.js. Goals
// synced in from MortalLoom are only run through `normalizeGoal` (server/services/identity/
// store.js), whose PORTOS_GOAL_DEFAULTS backfills every field EXCEPT status — so a
// status-less goal is a real, reachable shape, and dropping it here would render a
// user's populated goal list as "No active goals yet". Erring toward showing a goal is the
// safe direction: the cost is at worst one stale row, versus a card that lies about the
// user having no goals at all.
const isActive = (goal) => Boolean(goal) && (goal.status === 'active' || !goal.status);

export function selectTopGoals(goals, limit = TOP_N) {
  return goals
    .filter(isActive)
    .sort((a, b) => urgencyRank(b.urgency) - urgencyRank(a.urgency))
    .slice(0, limit);
}

// A goal that has never been progressed is legitimately 0%; a malformed/absent progress value
// also floors to 0 rather than rendering a NaN-width bar.
export function progressPct(goal) {
  const value = Number(goal?.progress);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
}

function GoalRow({ goal }) {
  const pct = progressPct(goal);

  return (
    <Link
      to={GOALS_PATH}
      // Named explicitly: the row's own text nodes would otherwise concatenate into a
      // redundant "Example Goal 25%" that never says where the link goes. The bar itself is
      // decorative — the percentage text is its accessible representation, matching how the
      // sheet's existing HP/XP bars are built.
      aria-label={`${goal.title} — ${pct}% complete. Open in Goals`}
      className="block bg-port-bg border border-port-border rounded-lg px-3 py-2 hover:border-port-accent transition-colors"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm text-gray-300 truncate" title={goal.title}>{goal.title}</span>
        <span className="text-xs font-semibold text-port-accent shrink-0">{pct}%</span>
      </div>
      <div className="h-1.5 mt-1.5 bg-port-border rounded-full overflow-hidden" aria-hidden="true">
        <div className="h-full bg-port-accent rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </Link>
  );
}

export default function GoalsCard() {
  // THREE states, never two — mirroring the sentinel discipline the rest of the sheet uses:
  //   - loading → we don't know yet
  //   - error   → we could not read the goals. Must NOT render as "you have no goals".
  //   - ready   → the real list, INCLUDING a real empty one.
  const [state, setState] = useState({ status: 'loading', goals: [] });

  useEffect(() => {
    let cancelled = false;
    // The TREE endpoint, not the flat one: `urgency` is only *persisted* when a goal is
    // written or a birth date is set, so `getGoals()` hands back whatever was last stored.
    // `getGoalsTree().flat` re-derives urgency from the longevity horizons the goals feature
    // maintains, and is the exact source /goals ranks by — so the sheet can never disagree
    // with the page it links to. (Enriching the flat endpoint instead would change a shared
    // API's semantics.)
    //
    // Those horizons are themselves only as fresh as the last deriveLongevity() run — every
    // consumer shares that, and re-deriving from this read-only card would both write on a
    // read path and make the sheet disagree with /goals. Tracked in PLAN.md as the goals
    // feature's own fix.
    //
    // silent: this card owns its own error UI (the message below), so letting request() toast
    // as well would surface the same failure twice.
    getGoalsTree({ silent: true })
      .then((data) => {
        if (cancelled) return;
        // Array.isArray, not truthiness: a genuinely zero-goal install must reach the empty
        // state, while a malformed payload must reach the error state.
        if (Array.isArray(data?.flat)) setState({ status: 'ready', goals: data.flat });
        else setState({ status: 'error', goals: [] });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', goals: [] });
      });
    return () => { cancelled = true; };
  }, []);

  const top = selectTopGoals(state.goals);

  return (
    <section aria-labelledby="character-goals-heading" className="bg-port-card border border-port-border rounded-xl p-4">
      <div className="flex items-center gap-1.5 mb-3">
        <Target className="w-4 h-4 text-port-accent" />
        <h2 id="character-goals-heading" className="text-sm font-medium text-gray-300">Life Goals</h2>
        <span className="text-xs text-gray-500">— what you're actually working toward</span>
        {state.status === 'ready' && top.length > 0 && (
          <Link to={GOALS_PATH} className="ml-auto text-xs text-port-accent hover:underline shrink-0">
            View all
          </Link>
        )}
      </div>

      {state.status === 'loading' && <BrailleSpinner text="Loading goals" />}

      {state.status === 'error' && (
        <p className="text-sm text-gray-500">
          Your goals could not be loaded right now.{' '}
          <Link to={GOALS_PATH} className="text-port-accent hover:underline">Open Goals</Link>
        </p>
      )}

      {state.status === 'ready' && top.length === 0 && (
        <div className="text-center py-4">
          <p className="text-sm text-gray-400">No active goals yet.</p>
          <p className="text-xs text-gray-500 mt-1">
            Your sheet reflects what you're working toward — set a goal to fill it in.
          </p>
          <Link
            to={GOALS_PATH}
            className="inline-flex items-center gap-1.5 mt-3 px-3 py-1.5 rounded-lg text-sm font-medium bg-port-accent/20 text-port-accent hover:bg-port-accent/30 transition-colors"
          >
            Set your goals <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      )}

      {state.status === 'ready' && top.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {top.map((goal) => <GoalRow key={goal.id} goal={goal} />)}
        </div>
      )}
    </section>
  );
}

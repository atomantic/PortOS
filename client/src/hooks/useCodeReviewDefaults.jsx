import { createContext, useContext, useEffect, useState } from 'react';
import * as api from '../services/api';
import { DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, EFFORT_SELECTABLE_REVIEWERS, MODEL_SELECTABLE_REVIEWERS } from '../components/cos/constants';

// The per-reviewer scalars, generated from the same rosters the picker renders
// Model and Effort cells for. Generated rather than hand-listed because a
// reviewer missing from this context silently blanks its configured pin on every
// consumer — with nothing failing to say so.
const pinScalars = (source) => Object.fromEntries([
  ...MODEL_SELECTABLE_REVIEWERS.map((reviewer) => [`${reviewer}Model`, source?.[`${reviewer}Model`] || null]),
  ...EFFORT_SELECTABLE_REVIEWERS.map((reviewer) => [`${reviewer}Effort`, source?.[`${reviewer}Effort`] || null]),
]);

// Resolved "Code Review Defaults" (Models → Code Reviewers) — used by TaskAddForm
// and ScheduleTab's per-task-type config to seed the picker's fallback state
// instead of the hardcoded `['copilot']`. Returned shape mirrors the server's
// `getCodeReviewDefaults()` so a consumer can rely on the same field names
// regardless of whether it reads context or calls the API directly.
// Mirrors the server's `pickCodeReviewDefaults` shape, including every
// `<reviewer>Model` / `<reviewer>Effort` scalar — the reviewer table's Model and
// Effort columns read them via `reviewerModelsFromDefaults` /
// `reviewerEffortsFromDefaults`, so omitting one here would silently blank a
// configured pin on every consumer of this context.
const FALLBACK = Object.freeze({
  reviewers: DEFAULT_REVIEWERS,
  usernames: [],
  optionalReviewers: [],
  reviewerMaxRounds: {},
  stopMode: DEFAULT_REVIEW_STOP_MODE,
  reviewerApplies: false,
  ...pinScalars(null),
  // Per-CLI-reviewer install probe (#3606) — absent/empty means "not fetched
  // yet", not "nothing installed"; ReviewerPicker only warns on an explicit
  // `false`.
  installed: {},
});

const CodeReviewDefaultsContext = createContext(FALLBACK);

// Provider — wrap once at the page/section boundary that hosts the pickers.
// Fetches the defaults once on mount; cancellation guards against unmount mid-
// request. Re-fetch only happens on remount, so save flows that update the
// panel and the same-page consumer aren't auto-synced — that's fine because
// the panel and consumers live on different pages in practice.
export function CodeReviewDefaultsProvider({ children }) {
  const [value, setValue] = useState(FALLBACK);
  useEffect(() => {
    let cancelled = false;
    api.getCodeReviewDefaults({ silent: true })
      .then((d) => {
        if (cancelled || !d) return;
        setValue({
          reviewers: Array.isArray(d.reviewers) && d.reviewers.length ? d.reviewers : DEFAULT_REVIEWERS,
          usernames: Array.isArray(d.usernames) ? d.usernames : [],
          optionalReviewers: Array.isArray(d.optionalReviewers) ? d.optionalReviewers : [],
          reviewerMaxRounds: d.reviewerMaxRounds && typeof d.reviewerMaxRounds === 'object' && !Array.isArray(d.reviewerMaxRounds)
            ? d.reviewerMaxRounds
            : {},
          stopMode: d.stopMode || DEFAULT_REVIEW_STOP_MODE,
          reviewerApplies: d.reviewerApplies === true,
          ...pinScalars(d),
          installed: d.installed && typeof d.installed === 'object' && !Array.isArray(d.installed) ? d.installed : {},
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return <CodeReviewDefaultsContext.Provider value={value}>{children}</CodeReviewDefaultsContext.Provider>;
}

// Hook — reads the resolved defaults. Falls back to the frozen hardcoded
// shape when no Provider is mounted, so consumers can render outside the
// Provider (e.g. dashboard widgets) without crashing.
export function useCodeReviewDefaults() {
  return useContext(CodeReviewDefaultsContext);
}

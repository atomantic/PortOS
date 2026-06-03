/**
 * Writers Room — Phase 5 live Creative Director feedback.
 *
 * On an explicit, throttled client request (NOT on every keystroke — the
 * editor debounces and only asks while live-mode is opted in), take the prose
 * window around the writer's cursor and propose a few short continuation
 * options. Stateless: nothing is persisted except the per-work daily budget
 * counter (`recordLiveModeUsage`), so a suggestion the writer ignores leaves
 * no trace. This is the spine the later live-render-preview and Creative
 * Director beat/scene bridge build on.
 *
 * Budget + opt-in are enforced server-side here, not just in the UI — a client
 * that ignores the toggle or the debounce still can't run unbounded LLM calls.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { runStagedLLM } from '../../lib/stageRunner.js';
import { getWork, resolveLiveMode, recordLiveModeUsage, utcDayKey } from './local.js';
import { badRequest } from './_shared.js';

const STAGE = 'writers-room-continue';
const MAX_OPTIONS = 4;

// Surface the two soft-failure modes as typed codes so the route can map them
// to the right HTTP status (live-mode off → 409 conflict; budget spent → 429).
export const ERR_LIVE_MODE_OFF = 'LIVE_MODE_OFF';
export const ERR_BUDGET_EXCEEDED = 'LIVE_BUDGET_EXCEEDED';

function shapeOptions(parsed) {
  const raw = Array.isArray(parsed?.options) ? parsed.options : [];
  return raw
    .filter((o) => o && typeof o === 'object')
    .map((o) => ({
      kind: ['beat', 'prose', 'dialogue'].includes(o.kind) ? o.kind : 'beat',
      label: typeof o.label === 'string' ? o.label.trim() : '',
      text: typeof o.text === 'string' ? o.text.trim() : '',
      rationale: typeof o.rationale === 'string' ? o.rationale.trim() : '',
    }))
    .filter((o) => o.text)
    .slice(0, MAX_OPTIONS);
}

/**
 * Generate live continuation suggestions from the cursor context.
 * Throws a coded ServerError when live mode is off or the daily budget is
 * spent (the route translates the code to a status). On success returns
 * `{ options, usage, budget }` so the client can render remaining budget.
 */
export async function suggestContinuation(workId, { before = '', after = '', selection = '' } = {}) {
  const manifest = await getWork(workId); // 404s if the work is missing
  const live = resolveLiveMode(manifest);

  if (!live.enabled) {
    throw new ServerError('Live mode is off for this work', { status: 409, code: ERR_LIVE_MODE_OFF });
  }

  // Daily budget gate. 0 means unlimited. The counter rolls over per UTC day
  // inside recordLiveModeUsage; here we just compare today's count against the
  // cap before spending an LLM call. Reading the resolved usage (which is not
  // date-normalized) would let yesterday's count block today, so treat a
  // stale-date counter as 0 spent-today. Same utcDayKey as the writer so the
  // boundaries can't drift.
  const today = utcDayKey();
  const spentToday = live.usage.date === today ? live.usage.count : 0;
  if (live.dailyCallBudget > 0 && spentToday >= live.dailyCallBudget) {
    throw new ServerError(
      `Live suggestion budget reached (${live.dailyCallBudget}/day) — resets at UTC midnight`,
      { status: 429, code: ERR_BUDGET_EXCEEDED },
    );
  }

  if (!before.trim() && !after.trim() && !selection.trim()) {
    throw badRequest('Need some prose around the cursor to suggest a continuation');
  }

  const variables = {
    work: { title: manifest.title, kind: manifest.kind, status: manifest.status },
    before, after, selection,
    returnsJson: true,
  };
  const { content } = await runStagedLLM(STAGE, variables, {
    source: 'writers-room-continue',
    returnsJson: true,
  });
  const options = shapeOptions(content);

  // Charge the budget for every call that reached the LLM — the provider cost
  // is incurred whether or not the response parsed into usable options. Only
  // sparing a zero-option call would let a model that reliably returns garbage
  // (or a prompt that always parses empty) run unbounded calls and never hit
  // the 429 cap. recordLiveModeUsage returns the full resolved config; we
  // surface just the usage sub-object.
  const usage = (await recordLiveModeUsage(workId)).usage;

  return {
    options,
    usage,
    budget: live.dailyCallBudget,
  };
}

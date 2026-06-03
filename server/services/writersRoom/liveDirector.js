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
import {
  getWork, resolveLiveMode, recordLiveModeUsage, recordLiveModeRenderUsage, utcDayKey,
} from './local.js';
import { badRequest } from './_shared.js';

const STAGE = 'writers-room-continue';
const MAX_OPTIONS = 4;

// Surface the two soft-failure modes as typed codes so the route can map them
// to the right HTTP status (live-mode off → 409 conflict; budget spent → 429).
export const ERR_LIVE_MODE_OFF = 'LIVE_MODE_OFF';
export const ERR_BUDGET_EXCEEDED = 'LIVE_BUDGET_EXCEEDED';

// Shared opt-in + daily-budget gate for the live paths. Throws the coded
// 409 (live mode off) / 429 (budget spent) ServerErrors the route maps to a
// status. `usage` is the relevant per-day counter, `budget` its cap (0 =
// unlimited), `label` names the budget in the 429 message. A counter whose
// stored date isn't today counts as 0 spent-today (it rolls over on write), so
// yesterday's count can't block today. utcDayKey() is the same boundary the
// recordLiveMode*Usage writers roll over on, so the check can't drift.
function assertLiveBudget(live, { usage, budget, label }) {
  if (!live.enabled) {
    throw new ServerError('Live mode is off for this work', { status: 409, code: ERR_LIVE_MODE_OFF });
  }
  const today = utcDayKey();
  const spentToday = usage.date === today ? usage.count : 0;
  if (budget > 0 && spentToday >= budget) {
    throw new ServerError(
      `Live ${label} budget reached (${budget}/day) — resets at UTC midnight`,
      { status: 429, code: ERR_BUDGET_EXCEEDED },
    );
  }
}

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
  assertLiveBudget(live, { usage: live.usage, budget: live.dailyCallBudget, label: 'suggestion' });

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

/**
 * Reserve one live render preview against the per-work render budget. The
 * actual image render reuses the existing image-gen route + media job queue on
 * the client — this is purely the server-side opt-in + budget gate so a client
 * that ignores the toggle still can't run unbounded renders. Throws the same
 * coded errors as suggestContinuation (live-mode off → 409, budget spent → 429)
 * and bumps the distinct daily render counter on success. Returns
 * `{ renderUsage, renderBudget }` so the client can render remaining budget.
 *
 * Budget is charged at reservation time (before the render kicks off) rather
 * than on completion: the GPU/provider cost is incurred the moment the job is
 * enqueued, and a client that fires-and-forgets must still hit the cap.
 */
export async function reserveRenderPreview(workId) {
  const manifest = await getWork(workId); // 404s if the work is missing
  const live = resolveLiveMode(manifest);
  assertLiveBudget(live, { usage: live.renderUsage, budget: live.dailyRenderBudget, label: 'render' });

  const renderUsage = (await recordLiveModeRenderUsage(workId)).renderUsage;
  return { renderUsage, renderBudget: live.dailyRenderBudget };
}

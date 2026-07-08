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
  linkToCreativeDirector,
} from './local.js';
import { createProject, setTreatment, deleteProject, updateProject } from '../creativeDirector/local.js';
import { deleteCollection } from '../mediaCollections.js';
import { defaultVideoModelId } from '../videoGen/local.js';
import { badRequest } from './_shared.js';

const STAGE = 'writers-room-continue';
// Exported so other conductors that mint a CD project from prose — the
// pipeline→CD "produce video from issue" bridge (CDO Phase 3, #2185) — reuse the
// SAME stage + proposal shaper rather than duplicating the treatment-from-prose
// contract.
export const CD_BRIDGE_STAGE = 'writers-room-cd-bridge';
const MAX_OPTIONS = 4;
// CD-bridge proposal bounds. The prompt asks for 2–6 filmable scenes; we clamp
// to that range (and the LLM may overshoot, so MAX is a hard cap) — well under
// creativeDirectorTreatmentSchema's 1..120, so a sent proposal always validates.
const MIN_BRIDGE_SCENES = 2;
const MAX_BRIDGE_SCENES = 6;

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

// Coerce one raw LLM scene into the shape the CD-bridge proposal carries.
// Returns null for an unusable scene (no intent/prompt) so the caller can drop
// it before clamping to the 2–6 range.
function shapeBridgeScene(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const intent = typeof raw.intent === 'string' ? raw.intent.trim() : '';
  const prompt = typeof raw.prompt === 'string' ? raw.prompt.trim() : '';
  if (!intent || !prompt) return null;
  // durationSeconds: round into the CD scene's 1..10 integer range; default to
  // a mid 5s when the model omits or fumbles it.
  const rawDur = Number(raw.durationSeconds);
  const durationSeconds = Number.isFinite(rawDur)
    ? Math.min(10, Math.max(1, Math.round(rawDur)))
    : 5;
  return { intent: intent.slice(0, 1000), prompt: prompt.slice(0, 8000), durationSeconds };
}

// Shape a raw LLM response into a CD treatment proposal. Trims the text fields
// to the CD treatment schema caps and clamps scenes to the 2–6 prompt range.
// Returns null when the response can't yield at least MIN_BRIDGE_SCENES usable
// scenes — the route surfaces that as an empty proposal, not a crash.
export function shapeProposal(parsed) {
  const scenes = (Array.isArray(parsed?.scenes) ? parsed.scenes : [])
    .map(shapeBridgeScene)
    .filter(Boolean)
    .slice(0, MAX_BRIDGE_SCENES);
  if (scenes.length < MIN_BRIDGE_SCENES) return null;
  const logline = typeof parsed?.logline === 'string' ? parsed.logline.trim().slice(0, 500) : '';
  const synopsis = typeof parsed?.synopsis === 'string' ? parsed.synopsis.trim().slice(0, 5000) : '';
  // logline + synopsis are REQUIRED by the send schema (and CD's treatment
  // schema) with min(1). Returning a proposal missing either would render a
  // live "Send" button that then 400s — so treat a missing-headline response
  // as "no usable treatment" (null), the same as too-few scenes.
  if (!logline || !synopsis) return null;
  return {
    logline,
    synopsis,
    styleSpec: typeof parsed?.styleSpec === 'string' ? parsed.styleSpec.trim().slice(0, 5000) : '',
    scenes,
  };
}

/**
 * Generate a Creative Director treatment proposal from the cursor context.
 * Unlike suggestContinuation (which returns inline prose options), this returns
 * a reviewable mini-treatment — logline, synopsis, visual treatment (styleSpec),
 * and 2–6 filmable scenes — that the writer can send into a new CD project.
 *
 * Reuses the SAME daily call budget + opt-in gate as the text-suggest path
 * (both are text LLM calls). Throws the coded 409 (live mode off) / 429 (budget
 * spent) ServerErrors the route maps to a status. On success returns
 * `{ proposal, usage, budget }`; `proposal` is null when the model couldn't
 * produce a usable treatment.
 */
export async function suggestCdBridge(workId, { before = '', after = '', selection = '' } = {}) {
  const manifest = await getWork(workId); // 404s if the work is missing
  const live = resolveLiveMode(manifest);
  assertLiveBudget(live, { usage: live.usage, budget: live.dailyCallBudget, label: 'suggestion' });

  if (!before.trim() && !after.trim() && !selection.trim()) {
    throw badRequest('Need some prose around the cursor to propose a treatment');
  }

  const variables = {
    work: { title: manifest.title, kind: manifest.kind, status: manifest.status },
    before, after, selection,
    returnsJson: true,
  };
  const { content } = await runStagedLLM(CD_BRIDGE_STAGE, variables, {
    source: 'writers-room-cd-bridge',
    returnsJson: true,
  });
  const proposal = shapeProposal(content);

  // Charge the shared text-suggest budget for every call that reached the LLM —
  // same rationale as suggestContinuation: the provider cost is incurred whether
  // or not the response parsed into a usable proposal.
  const usage = (await recordLiveModeUsage(workId)).usage;

  return { proposal, usage, budget: live.dailyCallBudget };
}

/**
 * Assign the CD scene runtime fields the treatment schema requires but a raw
 * CD-bridge LLM proposal doesn't carry: a stable sceneId, render order, and the
 * continuation flag (every scene after the first continues from its prior).
 * Exported so the pipeline→CD bridge (CDO Phase 3, #2185) maps proposal scenes
 * into a treatment identically to the writers-room send path.
 */
export function bridgeScenesToTreatmentScenes(scenes) {
  return (Array.isArray(scenes) ? scenes : []).map((s, i) => ({
    sceneId: `sc-${i + 1}`,
    order: i,
    intent: s.intent,
    prompt: s.prompt,
    durationSeconds: s.durationSeconds,
    useContinuationFromPrior: i > 0,
  }));
}

/**
 * Send a reviewed CD-bridge proposal into a NEW Creative Director project.
 * Non-destructive (never clobbers an existing project's treatment): it mints a
 * fresh CD project seeded with the work's title + the proposal's styleSpec, then
 * writes the treatment (logline/synopsis/scenes), then records the bridge link
 * on the WR manifest so the editor can show an "Open in Creative Director" CTA.
 *
 * No LLM, no budget — the proposal was already generated + charged by
 * suggestCdBridge; this is the cheap commit half. createProject + setTreatment
 * are wrapped so a setTreatment/link failure rolls back the orphaned project
 * (mirrors promoteToPipeline's orphan-cleanup rationale — multi-step write that
 * re-throws the original error after best-effort cleanup). Returns `{ project }`.
 */
export async function sendToCreativeDirector(workId, { proposal } = {}) {
  const manifest = await getWork(workId); // 404s if the work is missing

  // Assign the CD scene runtime fields the schema requires but the LLM proposal
  // doesn't carry: a stable sceneId, render order, and the continuation flag.
  const scenes = bridgeScenesToTreatmentScenes(proposal.scenes);

  // CD render defaults — match the client New-Project form (16:9 / standard /
  // 60s) and resolve the default video model server-side so a bridged project
  // doesn't start on a legacy backend.
  const project = await createProject({
    name: manifest.title,
    aspectRatio: '16:9',
    quality: 'standard',
    modelId: defaultVideoModelId(),
    targetDurationSeconds: 60,
    styleSpec: proposal.styleSpec || '',
  });

  // setTreatment returns the full project with the treatment applied — capture
  // it so the route can return the seeded project without a re-read.
  let withTreatment;
  try {
    await setTreatment(project.id, {
      logline: proposal.logline,
      synopsis: proposal.synopsis,
      scenes,
    });
    // setTreatment flips a fresh project to 'rendering', but nothing here
    // enqueues a render — the orchestrator only runs on an explicit
    // POST /:id/start. A 'rendering' project also hides the detail page's
    // "Start" button (it shows only for 'draft'/'failed'), which would strand
    // the bridged project as "active" with no way to kick it off. Reset to
    // 'draft' so the user reviews it in Creative Director and starts rendering
    // deliberately (no surprise GPU/provider spend from the bridge itself).
    withTreatment = await updateProject(project.id, { status: 'draft' });
    await linkToCreativeDirector(workId, { projectId: project.id });
  } catch (err) {
    // Roll back the orphaned project AND its auto-created media collection so a
    // setTreatment/link failure doesn't leave a treatment-less project or a
    // dangling empty collection behind with no manifest link. Best-effort —
    // swallow cleanup errors so the original cause reaches the caller.
    await deleteProject(project.id).catch(() => {});
    if (project.collectionId) await deleteCollection(project.collectionId).catch(() => {});
    throw err;
  }

  return { project: withTreatment };
}

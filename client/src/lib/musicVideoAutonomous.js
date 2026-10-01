// Fully-autonomous Music Video — client half. Re-exports the server's stage
// vocabulary and brief normalizer (a dependency-light leaf) and owns the start
// form's draft ↔ wire mapping and the run's display helpers.

import {
  AUTONOMOUS_DEFAULT_LIMITS, AUTONOMOUS_DEFAULT_TOOLS, AUTONOMOUS_LIVE_STATUSES, AUTONOMOUS_STAGES,
} from '../../../server/lib/musicVideoAutonomous.js';

export { AUTONOMOUS_CHECKPOINT_IDS, autonomousMedium } from '../../../server/lib/musicVideoAutonomous.js';

export const AUTONOMOUS_CHECKPOINT_LABELS = Object.freeze({
  ...Object.fromEntries(AUTONOMOUS_STAGES.map((stage) => [stage.id, stage.label])),
  cast: 'Cast & Sets',
});

export const AUTONOMOUS_STATUS_LABELS = Object.freeze({
  running: 'Running', 'awaiting-approval': 'Waiting for your approval', 'needs-human': 'Needs you', stopped: 'Paused',
  completed: 'Finished', failed: 'Failed', canceled: 'Cancelled',
});

export const emptyAutonomousDraft = () => ({
  prompt: '',
  instrumental: false,
  tools: [...AUTONOMOUS_DEFAULT_TOOLS],
  models: {},
  guidance: '',
  budget: '',
  maxGenerations: String(AUTONOMOUS_DEFAULT_LIMITS.maxGenerations),
  checkpoints: [],
});

const optionalInt = (raw) => {
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) ? n : undefined;
};

/** The start request for a draft: blank optional fields are omitted so the server defaults apply. */
export function autonomousRequestFromDraft(draft, { providerId, model } = {}) {
  const budget = Number.parseFloat(draft.budget);
  const maxGenerations = optionalInt(draft.maxGenerations);
  const models = Object.fromEntries(Object.entries(draft.models || {})
    .filter(([id, value]) => draft.tools.includes(id) && typeof value === 'string' && value.trim())
    .map(([id, value]) => [id, value.trim()]));
  return {
    prompt: draft.prompt.trim(),
    instrumental: draft.instrumental === true,
    tools: draft.tools,
    ...(Object.keys(models).length ? { models } : {}),
    ...(draft.guidance.trim() ? { guidance: draft.guidance.trim() } : {}),
    budgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : null,
    ...(maxGenerations ? { limits: { maxGenerations } } : {}),
    checkpoints: draft.checkpoints,
    ...(providerId ? { providerId, ...(model ? { model } : {}) } : {}),
  };
}

/** One display row per stage of a run: its label, state and (when failed) the error. */
export function autonomousStageRows(run) {
  if (!run) return [];
  return AUTONOMOUS_STAGES.map((stage) => {
    const state = run.stages?.[stage.id] || {};
    const current = run.stage === stage.id;
    return { id: stage.id, label: stage.label, status: state.status || 'pending', current, error: state.error || null };
  });
}

/** True while the run can still move (or be nudged): the project page keeps its panel prominent. */
export const isAutonomousLive = (run) => !!run && AUTONOMOUS_LIVE_STATUSES.includes(run.status);

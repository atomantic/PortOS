/**
 * Unified Story Builder — shared step definitions.
 *
 * Single source of truth for the linear wizard's ordered steps, consumed by
 * both the server (state machine + gating in `services/storyBuilder.js`) and
 * the client (stepper UI, echoed via the API). The Story Builder is a thin
 * *conductor* over the existing universe / series / issue records — these
 * steps describe the review-and-lock gates, not new content models.
 *
 * Ordering IS the dependency graph: each step's "upstream" is every step
 * before it. Unlocking step K flags every locked step after K as stale
 * (see `storyBuilderIntegrity.js`).
 */

export const STEP_STATUSES = Object.freeze(['pending', 'in-progress', 'ready', 'locked']);

export const STEPS = Object.freeze([
  {
    id: 'idea',
    label: 'Idea',
    description: 'Name the universe and capture a starter idea — type a seed or import a finished work.',
  },
  {
    id: 'universeAesthetic',
    label: 'Universe Aesthetic',
    description: 'Lock the world’s look and feel: logline, premise, style notes, and visual influences.',
  },
  {
    id: 'plotArc',
    label: 'Plot Arc',
    description: 'Expand the idea into a multi-season arc and pick its emotional shape.',
  },
  {
    id: 'readerMap',
    label: 'Reader Map',
    description: 'Plan the reader’s experience — hooks, payoffs, emotional beats, and cliffhangers.',
  },
  {
    id: 'characters',
    label: 'Characters',
    description: 'Review and lock the cast that recurs across the series.',
  },
  {
    id: 'issues',
    label: 'Issues',
    description: 'Break the arc into issues/episodes and complete them one at a time.',
  },
  {
    id: 'production',
    label: 'Production',
    description: 'Render each completed issue to comic pages and video.',
  },
]);

export const STEP_IDS = Object.freeze(STEPS.map((s) => s.id));

export const isValidStepId = (id) => STEP_IDS.includes(id);

export const stepIndex = (id) => STEP_IDS.indexOf(id);

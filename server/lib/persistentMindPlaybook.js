/**
 * First-class Persistent Mind operating modes / playbooks.
 *
 * Distinct from the free-form identity+instructions prompt: a playbook is a
 * product-supported loop (e.g. continuous play → explore → interact → reflect
 * → invent) that every mind can opt into. Saving a playbook never starts
 * inference; wake assembly merges the active template into operating
 * instructions when the mode is not `default`.
 */

import { z } from 'zod';

export const PERSISTENT_MIND_PLAYBOOK_SCHEMA_VERSION = 1;

export const PERSISTENT_MIND_PLAYBOOK_MODES = Object.freeze([
  'default',
  'continuous-play',
]);

export const PERSISTENT_MIND_PLAYBOOK_LIMITS = Object.freeze({
  customInstructionsChars: 6_000,
});

/** Product template for continuous Eidoverse play + reflection + invention. */
export const CONTINUOUS_PLAY_PLAYBOOK_INSTRUCTIONS = `PLAYBOOK MODE — Continuous play / explore & invent

Each wake, prefer this loop over idle chatter:

1) EXPLORE — Stay present in the Eidoverse. Check eidoverse.status; reconnect presence if needed. Move, inspect places, peers, projections, and affordances. Prefer many small concrete interactions over one abstract plan.

2) INTERACT — Speak (eidoverse.say), augment/project when useful, visit federated peers when granted, and use PortOS semantic tools to notice what is thin, broken, or delightful. Enrich Commons with places, labels, structures, resource projection, and gentle affordances. Prefer PortOS-side work; do not fork the Eidoverse runtime.

3) REFLECT — End with a short user-visible working note: what you did, what you noticed, and 1–3 improvement ideas ranked smallest-first. Useful directions include visualization of installed models, creative works via PortOS Create (stories, music), clearer federated-peer visualization, denser Commons districts, and mind/tool UX that supports continuous play.

4) INVENT / IMPROVE — Propose or start the smallest safe improvement via eidoverse tools, a typed CoS task, a Create-suite idea, or a precise product note. File-changing / consequential work only via typed CoS tasks; never claim side effects that did not happen.

Self-directed wakes must produce a concrete observation, question, or next step — not filler.`;

export const persistentMindPlaybookSchema = z.object({
  schemaVersion: z.literal(PERSISTENT_MIND_PLAYBOOK_SCHEMA_VERSION).optional(),
  mode: z.enum(PERSISTENT_MIND_PLAYBOOK_MODES).optional(),
  /** Optional extra instructions appended after the mode template. */
  customInstructions: z.string().max(PERSISTENT_MIND_PLAYBOOK_LIMITS.customInstructionsChars).optional(),
}).strict();

export function createDefaultPersistentMindPlaybook() {
  return {
    schemaVersion: PERSISTENT_MIND_PLAYBOOK_SCHEMA_VERSION,
    mode: 'default',
    customInstructions: '',
  };
}

const boundedText = (value, fallback, max) => (
  typeof value === 'string' ? value.trim().slice(0, max) : fallback
);

export function normalizePersistentMindPlaybook(raw) {
  const defaults = createDefaultPersistentMindPlaybook();
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const mode = PERSISTENT_MIND_PLAYBOOK_MODES.includes(source.mode) ? source.mode : defaults.mode;
  return {
    schemaVersion: PERSISTENT_MIND_PLAYBOOK_SCHEMA_VERSION,
    mode,
    customInstructions: boundedText(
      source.customInstructions,
      defaults.customInstructions,
      PERSISTENT_MIND_PLAYBOOK_LIMITS.customInstructionsChars,
    ),
  };
}

export function mergePersistentMindPlaybook(previous, update) {
  const prior = normalizePersistentMindPlaybook(previous);
  const patch = update && typeof update === 'object' && !Array.isArray(update) ? update : {};
  return normalizePersistentMindPlaybook({ ...prior, ...patch });
}

/**
 * Resolve the instruction block for the active playbook mode.
 * `default` contributes nothing (operator prompt alone drives the mind).
 */
export function playbookInstructionBlock(playbook) {
  const normalized = normalizePersistentMindPlaybook(playbook);
  const parts = [];
  if (normalized.mode === 'continuous-play') {
    parts.push(CONTINUOUS_PLAY_PLAYBOOK_INSTRUCTIONS);
  }
  if (normalized.customInstructions) {
    parts.push(normalized.customInstructions);
  }
  return parts.join('\n\n').trim();
}

/**
 * Merge operator instructions with the active playbook template.
 * Playbook text is appended so the operator prompt remains primary voice.
 */
export function composePersistentMindInstructions(operatorInstructions, playbook) {
  const base = typeof operatorInstructions === 'string' ? operatorInstructions.trim() : '';
  const block = playbookInstructionBlock(playbook);
  if (!block) return base;
  if (!base) return block;
  return `${base}\n\n${block}`;
}

export const PERSISTENT_MIND_PLAYBOOK_CATALOG = Object.freeze([
  Object.freeze({
    id: 'default',
    label: 'Default',
    summary: 'Operator identity + instructions only; no product playbook loop.',
  }),
  Object.freeze({
    id: 'continuous-play',
    label: 'Continuous play / explore & invent',
    summary: 'Explore and interact in the Eidoverse, then reflect and propose PortOS-side improvements each wake.',
  }),
]);

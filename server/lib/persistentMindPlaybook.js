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
import { COS_TOOL_CALL_LIMITS } from './cosToolContracts.js';
import { PERSISTENT_MIND_PLAYBOOK_PHASES } from './persistentMindPlaybookPhase.js';

export const PERSISTENT_MIND_PLAYBOOK_SCHEMA_VERSION = 1;

export const PERSISTENT_MIND_PLAYBOOK_MODES = Object.freeze([
  'default',
  'continuous-play',
]);

export const PERSISTENT_MIND_PLAYBOOK_LIMITS = Object.freeze({
  customInstructionsChars: 6_000,
});

/**
 * One orientation call per wake, shared by every template below. A wake has
 * `COS_TOOL_CALL_LIMITS.maxCallsPerTurn` semantic calls in total, and the
 * templates used to open with "check eidoverse.status, then run
 * eidoverse.observe" — then the mind added eidoverse.destinations before a
 * visit. That preamble spent three of five calls re-reading what the wake
 * prompt already carries (the environment snapshot reports the runtime and
 * connection; observe's `peers` carry the same peer ids eidoverse.visit
 * takes), so a visit (visit → visit-chat → leave) never fit, and every wake
 * ended by announcing the visit as its next curiosity instead of making it.
 */
const ORIENTATION_STEP = 'Run eidoverse.observe once: it lists places, peers (each peerId is what eidoverse.visit takes, travelAvailable says whether it admits a visit now), foundations, controllers needing attention, and what changed since your last look. Your environment snapshot already reports the Eidoverse runtime and connection, so call eidoverse.status only for library asset paths before a spawn or when that snapshot shows the world disconnected, and eidoverse.destinations only when observe could not list peers.';

const CALL_BUDGET = `You have ${COS_TOOL_CALL_LIMITS.maxCallsPerTurn} semantic tool calls per wake, shared by every tool including tools.activate. Spend at most one on orientation and the rest on action; calls listed together in one response run in order, so batch independent calls instead of spending a round on each. If an ACTIVE visit is listed under "Open Eidoverse guest visits", finish it before anything else: eidoverse.visit-chat to read and reply, then eidoverse.leave.`;

/** Product template for continuous Eidoverse play + reflection + invention. */
export const CONTINUOUS_PLAY_PLAYBOOK_INSTRUCTIONS = `PLAYBOOK MODE — Continuous play / explore & invent

${CALL_BUDGET}

Each wake, prefer this loop over idle chatter:

1) OBSERVE — ${ORIENTATION_STEP} Look before you speak — most of what is worth reusing is already in the world, and asking about it in chat is slower than walking to it.

2) INTERACT — Act on what you just observed. Speak (eidoverse.say), augment/project when useful, visit federated peers when granted, and use PortOS semantic tools to notice what is thin, broken, or delightful. Enrich Commons with places, labels, structures, resource projection, and gentle affordances. Prefer PortOS-side work; do not fork the Eidoverse runtime.

3) REFLECT — End with a short user-visible working note: what you did, what you noticed, and 1–3 improvement ideas ranked smallest-first. Useful directions include visualization of installed models, creative works via PortOS Create (stories, music), clearer federated-peer visualization, denser Commons districts, and mind/tool UX that supports continuous play.

4) INVENT / IMPROVE — Propose or start the smallest safe improvement via eidoverse tools, a typed CoS task, a Create-suite idea, or a precise product note. File-changing / consequential work only via typed CoS tasks; never claim side effects that did not happen.

Self-directed wakes must produce a concrete observation, question, or next step — not filler.`;

/**
 * Maturity-aware phase templates (issue #7458). Chosen each wake from world
 * signals by `resolvePersistentMindPlaybookPhase()` (see
 * `server/services/persistentMindPlaybookSignals.js`) rather than a fixed
 * cron personality — an empty Commons and a dense one need different wakes.
 * Each block ends by naming its own phase so the mind states it in the
 * working note, making the current phase visible to Helm and other minds.
 */
export const PERSISTENT_MIND_PLAYBOOK_PHASE_INSTRUCTIONS = Object.freeze({
  explore: `PLAYBOOK PHASE — Explore (sparse Commons)

The Commons is still mostly empty. ${CALL_BUDGET} Each wake, prefer this loop:

1) ${ORIENTATION_STEP} Map what already exists before asking anyone about it.
2) Prefer many small concrete interactions (eidoverse.say, eidoverse.augment) over one abstract plan.

End with a short user-visible working note starting "Phase: Explore" — what you found, and 1–3 smallest-first ideas for what to build next.`,

  construct: `PLAYBOOK PHASE — Construct (Commons taking shape)

The Commons has some structure but is not yet dense. ${CALL_BUDGET} Each wake, prefer this loop:

1) ${ORIENTATION_STEP} Find where the world is thinnest — a district reporting few signals, or one whose sources you have never built against. Densify there: add places, labels, structures, resource projection, and gentle affordances where the world is thin.
2) Favor PortOS-side work; do not fork the Eidoverse runtime.
3) File a typed CoS task for anything file-changing or consequential; never claim side effects that did not happen.

End with a short user-visible working note starting "Phase: Construct" — what you built, what is still thin, and 1–3 smallest-first next steps.`,

  // Selected for TWO reasons (see selectPersistentMindPlaybookPhase): a high
  // failure rate, OR a mature Commons with nothing unread from a peer. The
  // second is the steady state of every established install, so the opening
  // must not claim something is broken — that fabricated claim (#7630's
  // defect class) sent a healthy mind to re-project, re-test and re-list
  // inventory every wake instead of building or visiting.
  maintain: `PLAYBOOK PHASE — Maintain (established Commons)

The Commons is established: either recent work has been failing, or the world is mature and nothing new arrived from a peer. Upkeep comes first only when something is actually wrong. ${CALL_BUDGET} Each wake, prefer this loop:

1) ${ORIENTATION_STEP} Its controllers.needsAttention and per-place attentionSignals name what actually broke, rather than making you re-derive it.
2) If something is broken or failing, repair or retire it before adding anything new, and re-test only what you changed. File a typed CoS task for anything file-changing or consequential.
3) If nothing needs repair, do not spend the wake re-projecting, re-testing, or re-listing what is already healthy. Use the remaining calls for one new build where the world is thinnest, or a friendly visit to a peer whose travelAvailable is true (eidoverse.visit, eidoverse.visit-chat, then eidoverse.leave — or leave on a later wake).

End with a short user-visible working note starting "Phase: Maintain" — what you repaired, built, or visited, and what still needs attention.`,

  coordinate: `PLAYBOOK PHASE — Coordinate (new peer contributions since your last look)

Since this mind last observed, foundations arrived from a federated peer, or a new peer joined. Nobody asked you to come — the signal is what changed in the ledger, not a message. ${CALL_BUDGET} Each wake, prefer this loop:

1) ${ORIENTATION_STEP} Its peers section already shows which peers this install inherited foundations through, and foundations.inherited names those contributions. Read what a peer built before you go ask about it. Then, when visitEidoversePeers is granted, visit a peer with new activity whose travelAvailable is true (eidoverse.visit, eidoverse.visit-chat, then eidoverse.leave).
2) Favor stewarding the shared baseline over solo construction this wake — build on what a peer contributed, respond, and note anything worth bringing home. An inherited foundation keeps working without its author narrating it; chat is for what observation could not answer.
3) Package the smallest safe follow-up as a typed CoS task rather than acting outside your granted tools.

End with a short user-visible working note starting "Phase: Coordinate" — who or what you coordinated with, and 1–3 smallest-first follow-ups.`,
});

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
 *
 * `phase` (one of `PERSISTENT_MIND_PLAYBOOK_PHASES`, e.g. from
 * `resolvePersistentMindPlaybookPhase()`) selects the maturity-aware
 * template for `continuous-play`. Omitting it (a preview with no live world
 * signals, or an unrecognized value) falls back to the general
 * explore→interact→reflect→invent loop.
 */
export function playbookInstructionBlock(playbook, phase) {
  const normalized = normalizePersistentMindPlaybook(playbook);
  const parts = [];
  if (normalized.mode === 'continuous-play') {
    parts.push(PERSISTENT_MIND_PLAYBOOK_PHASES.includes(phase)
      ? PERSISTENT_MIND_PLAYBOOK_PHASE_INSTRUCTIONS[phase]
      : CONTINUOUS_PLAY_PLAYBOOK_INSTRUCTIONS);
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
export function composePersistentMindInstructions(operatorInstructions, playbook, phase) {
  const base = typeof operatorInstructions === 'string' ? operatorInstructions.trim() : '';
  const block = playbookInstructionBlock(playbook, phase);
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

/**
 * Prompt-version machinery for the cross-install auto-upgrade contract.
 * See the barrel (../taskPromptDefaults.js) header and AGENTS.md
 * "Distribution model" before editing.
 *
 * The version numbers are not authored here: integrity.snapshot.json owns them
 * and `node scripts/regen-prompt-integrity-snapshot.js` raises a key's version
 * whenever its body changes. Each version's rationale lives in the commit that
 * raised it.
 */
import { readPromptIntegritySnapshot } from './integrityHash.js';

// A SCHEDULE task type absent from this map is silently exempt from
// auto-upgrade forever: taskScheduleStore's upgrade block is gated on
// `PROMPT_VERSIONS[taskType] && …`, so a body change ships and no install ever
// receives it. Every PERSISTED prompt therefore carries an entry (the regen
// gives a new body v1), and taskPromptDefaults.test.js enforces the parity
// against UNPERSISTED_PROMPT_KEYS below. Copied, because the snapshot is the
// shared require cache that callers must never mutate.
export const PROMPT_VERSIONS = { ...readPromptIntegritySnapshot().PROMPT_VERSIONS };

// Default bodies that are never stored on a schedule, so they carry no version:
// an unlisted body that merely is not a schedule key yet is the regression the
// parity test guards, and a new unversioned prompt must be justified here.
export const UNPERSISTED_PROMPT_KEYS = [
  // Pipeline stage bodies: getStagePrompt reads them live from the catalog and
  // never persists them, so an edit reaches every install on the next dispatch
  // (their pipeline's SCHEDULE key carries the version instead).
  'pr-reviewer-security',
  'pr-reviewer-eligibility',
  'pr-reviewer-review',
  'code-reviewer-review',
  'code-reviewer-implement',
  'branch-cleanup',
  // The manual /do:next PLAN claim's default body: taskPromptService reads it
  // only as a claimFlow fallback when the STORED 'plan-task' prompt is a
  // shipped default (see getTaskPrompt) — it is never itself persisted to a
  // schedule, so it carries no PROMPT_VERSIONS entry of its own (issue #6479).
  'plan-task-claim',
];

// Audit anchor for reference-watch's read/write coupling. The schedule default
// (`taskMetadata.readOnly` in DEFAULT_TASK_INTERVALS) is derived from what the
// active prompt version does: it files proposals via PLAN.md commits or
// gh/glab, which needs a writable agent, so the default stays `readOnly: false`.
// This records the PROMPT_VERSIONS['reference-watch'] value that default was
// last audited against; a guard test in taskSchedule.test.js fails when the
// version moves past it, forcing whoever changes the prompt to re-confirm the
// default and advance this anchor in the same change (issue #734).
export const REFERENCE_WATCH_AUDITED_VERSION = 5;

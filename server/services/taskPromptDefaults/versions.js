/**
 * Prompt-version machinery for the cross-install auto-upgrade contract. See the
 * barrel (../taskPromptDefaults.js) header and AGENTS.md "Distribution model".
 * integrity.snapshot.json owns the version numbers; regen raises them.
 */
import { readPromptIntegritySnapshot } from './integrityHash.js';

// A SCHEDULE task type absent here never auto-upgrades (taskScheduleStore gates
// on `PROMPT_VERSIONS[taskType]`), so every PERSISTED prompt needs an entry; a
// test enforces parity. Copied: the snapshot is a shared require cache.
export const PROMPT_VERSIONS = { ...readPromptIntegritySnapshot().PROMPT_VERSIONS };

// Default bodies never stored on a schedule, so they carry no version.
export const UNPERSISTED_PROMPT_KEYS = [
  'pr-reviewer-security',
  'pr-reviewer-eligibility',
  'pr-reviewer-review',
  'code-reviewer-review',
  'code-reviewer-implement',
  'branch-cleanup',
  // Only a claimFlow fallback in taskPromptService (see getTaskPrompt) (#6479).
  'plan-task-claim',
];

// The PROMPT_VERSIONS['reference-watch'] value the `readOnly: false` schedule
// default was audited against; a taskSchedule.test.js guard fails past it (#734).
export const REFERENCE_WATCH_AUDITED_VERSION = 5;

/**
 * Prompt-version machinery for the cross-install auto-upgrade contract.
 * See the barrel (../taskPromptDefaults.js) header and CLAUDE.md
 * "Distribution model" before editing.
 */

// Prompt versions — bump when a default prompt changes so existing instances auto-upgrade.
// Only non-customized prompts (promptCustomized !== true) are upgraded.
export const PROMPT_VERSIONS = {
  'feature-ideas': 9,  // v9: drop DONE.md reads — use `.changelog/` + `git log` (last 50) as the completed-work signal
  'plan-task': 8,      // v8: Phase-6 merge fallback prefers --merge over --squash (after --auto), matching the /do:pr + review-loop default and PortOS's merge-only policy
  'claim-issue': 2,    // v2: stop treating the bare `plan` label as a skip — `plan` is the claimable-queue label (do-replan --issues labels every migrated backlog item `plan`), so v1's exclusion emptied the whole actionable queue; now skip only true epics (`epic` label or "(epic)" title)
  'pr-reviewer': 3,    // v3: multi-stage pipeline (security scan → code review + merge)
  'code-reviewer-a': 1, // v1: 2-stage pipeline (codebase review → triage & implement)
  'code-reviewer-b': 1, // v1: 2-stage pipeline (codebase review → triage & implement)
  'reference-watch': 2, // v2: append slug-tagged checklist items to PLAN.md (Adopt + Maybe) instead of writing REFERENCE_REVIEW.md; security-flagged commits get no PLAN entry (mentioned only in final summary)
  'pr-watcher': 1,      // v1: review-and-comment default for newly-opened PRs on the app's default branch
  'refresh-local-llm-catalog': 1 // v1: research current local models, refresh LOCAL_LLM_CATALOG + EDITORIAL_FAMILY_RANK, PR (PortOS repo only)
};

// Audit anchor for reference-watch's read/write coupling.
// The reference-watch schedule default (`taskMetadata.readOnly` in DEFAULT_TASK_INTERVALS)
// is derived from what the active prompt VERSION does: v2's prompt APPENDS slug-tagged
// `[ref-watch-…]` items to PLAN.md and commits them, so the default must be `readOnly: false`.
// A future v3 that returns to a propose-only flow would need `readOnly: true` again.
// `REFERENCE_WATCH_AUDITED_VERSION` records the PROMPT_VERSIONS['reference-watch'] value
// the current `readOnly` default was last audited against. A guard test in
// taskSchedule.test.js fails when PROMPT_VERSIONS['reference-watch'] moves past this anchor —
// forcing whoever bumps the prompt to re-confirm the default still matches the prompt's
// behavior and then advance this anchor in the same change. See issue #734.
export const REFERENCE_WATCH_AUDITED_VERSION = 2;

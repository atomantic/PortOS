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
  'claim-issue': 3,    // v3: Phase 3 tags an ambiguous/too-large issue `needs-input` (not just a comment) so it's excluded from future autonomous claims — required for `perpetual` (drain-until-done) mode to converge instead of re-picking the same un-actionable issue. v2: stop treating the bare `plan` label as a skip — `plan` is the claimable-queue label (do-replan --issues labels every migrated backlog item `plan`), so v1's exclusion emptied the whole actionable queue; now skip only true epics (`epic` label or "(epic)" title)
  'claim-issue-gitlab': 2, // v2: Phase 3 tags an ambiguous/too-large issue `needs-input` (mirrors claim-issue v3) so it's excluded from future autonomous claims — required for `perpetual` (drain-until-done) mode to converge. v1: GitLab sibling of claim-issue — same 7-phase /claim --issues flow over `glab` issues + merge requests. Reached via the claim-work router when an app's resolved workTracker is 'gitlab'.
  'claim-issue-jira': 1, // v1: JIRA sibling of claim-issue — claim ONE ready sprint ticket, move it To Do→In Progress→In Review around a self-managed worktree + MR/PR. Reached via the claim-work router when an app's resolved workTracker is 'jira' (replaces the prior jira→jira-sprint-manager route).
  'pr-reviewer': 3,    // v3: multi-stage pipeline (security scan → code review + merge)
  'code-reviewer-a': 1, // v1: 2-stage pipeline (codebase review → triage & implement)
  'code-reviewer-b': 1, // v1: 2-stage pipeline (codebase review → triage & implement)
  'reference-watch': 3, // v3: record proposals in the app's RESOLVED work tracker (PLAN.md / GitHub / GitLab / JIRA) via the {trackerInstructions} block — no longer hardcodes PLAN.md, so an app configured for GitHub issues gets `gh issue create` proposals. v2: append slug-tagged checklist items to PLAN.md (Adopt + Maybe) instead of writing REFERENCE_REVIEW.md; security-flagged commits get no PLAN entry (mentioned only in final summary)
  'pr-watcher': 1,      // v1: review-and-comment default for newly-opened PRs on the app's default branch
  'branch-reconcile': 1, // v1: per-app coordinator that finishes in-flight LOCAL branches (open PR / resolve conflicts / drive review / auto-merge) after the deterministic merged-branch cleanup pass. Peer-safe (local refs only). Replaced the PortOS-only branchReconcileScheduler.
  'refresh-local-llm-catalog': 1, // v1: research current local models, refresh LOCAL_LLM_CATALOG + EDITORIAL_FAMILY_RANK, PR (PortOS repo only)

  // Basic self-improvement tasks — versioned so installs created before the
  // Jan→Feb 2026 genericization (which still have the app-name-hardcoded "PortOS"
  // default persisted, sometimes mis-flagged promptCustomized) auto-upgrade to the
  // current {appName} body. See PREVIOUS_DEFAULT_PROMPTS + the self-heal in
  // taskSchedule.js loadSchedule().
  'security': 2, // v2: generic {appName} body (older default hardcoded "PortOS"/"server/routes" paths)
  'code-quality': 2, // v2: generic {appName} body (older default hardcoded "PortOS")
  'test-coverage': 2, // v2: generic {appName} body (older default hardcoded "PortOS")
  'performance': 2, // v2: generic {appName} body (older default hardcoded "PortOS")
  'accessibility': 2, // v2: generic {appName} + the app UI (older default hardcoded "PortOS" + http://localhost:5555)
  'dependency-updates': 2, // v2: generic {appName} body (older default hardcoded "PortOS")
  'documentation': 4, // v4: generic {appName} body (v1 hardcoded "PortOS"; v2/v3 retired DONE.md wording)
  'ui-bugs': 2, // v2: generic {appName} + the app UI (older default hardcoded "PortOS" + http://localhost:5555)
  'mobile-responsive': 2, // v2: generic {appName} app-UI body (older default hardcoded "PortOS" + http://localhost:5555)
  'release-check': 6, // v6: generic {appName} body (older defaults hardcoded "PortOS")
};

// Audit anchor for reference-watch's read/write coupling.
// The reference-watch schedule default (`taskMetadata.readOnly` in DEFAULT_TASK_INTERVALS)
// is derived from what the active prompt VERSION does: v3's prompt records proposals in the
// app's resolved work tracker — the PLAN.md path appends + commits `[ref-watch-…]` items, and
// the forge paths (GitHub/GitLab) shell out to `gh`/`glab issue create`. Both need a writable
// agent (a read-only agent gets the "do not modify or commit files" guard and refuses), so the
// default stays `readOnly: false`. A future version that returns to a propose-only flow would
// need `readOnly: true` again. `REFERENCE_WATCH_AUDITED_VERSION` records the
// PROMPT_VERSIONS['reference-watch'] value the current `readOnly` default was last audited
// against. A guard test in taskSchedule.test.js fails when PROMPT_VERSIONS['reference-watch']
// moves past this anchor — forcing whoever bumps the prompt to re-confirm the default still
// matches the prompt's behavior and then advance this anchor in the same change. See issue #734.
export const REFERENCE_WATCH_AUDITED_VERSION = 3;

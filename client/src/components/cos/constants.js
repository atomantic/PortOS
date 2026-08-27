import {
  FileText,
  Cpu,
  Brain,
  Activity,
  Settings,
  Calendar,
  Clock,
  Compass,
  GraduationCap,
  Bot,
  Flame,
  Newspaper,
  ChartGantt,
  Play,
  ScrollText,
  MessageCircle
} from 'lucide-react';
import { normalizeReviewerSlug } from '../../lib/reviewerPins';
import { inPlaceClipName } from '../../utils/animationClips';

export const TABS = [
  { id: 'briefing', label: 'Briefing', icon: Newspaper },
  { id: 'tasks', label: 'Tasks', icon: FileText },
  { id: 'agents', label: 'Agents', icon: Cpu },
  { id: 'jobs', label: 'System Tasks', icon: Bot },
  { id: 'runs', label: 'Runs', icon: Play },
  { id: 'run-events', label: 'Run Events', icon: ScrollText },
  { id: 'schedule', label: 'Schedule', icon: Clock },
  { id: 'workflow', label: 'Timeline', icon: ChartGantt },
  { id: 'digest', label: 'Digest', icon: Calendar },
  { id: 'gsd', label: 'GSD', icon: Compass },
  { id: 'productivity', label: 'Streaks', icon: Flame },
  { id: 'learning', label: 'Learning', icon: GraduationCap },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'mind', label: 'Mind', icon: MessageCircle },
  { id: 'health', label: 'Health', icon: Activity },
  { id: 'config', label: 'Config', icon: Settings }
];

// Intentional category-color enum (#1909/#1924 caution), NOT off-token theme
// inconsistency: 9 files (CoSCharacter, CyberCoSAvatar, EsotericCoSAvatar,
// MiniCharacterCoSAvatar, MuseCoSAvatar, NexusCoSAvatar, SigilCoSAvatar,
// StateLabel, TerminalCoSPanel) key their glow/fill/border color off `color`
// so all 7 agent states stay visually distinguishable at a glance. The app
// only has ~4-5 semantic tokens (accent/accent-2/success/warning/error) —
// collapsing 7 states onto them would make at least 2-3 states render
// identically, destroying the thing this enum exists for. Left as raw hex.
//
// Known issue (flagged on #1909 by codex review of PR #1935): `thinking`'s
// amber (#f59e0b) has poor contrast (~2.1:1) against light day-theme surfaces
// (e.g. Classic Noon) in the 2 consumers whose background is theme-aware
// (StateLabel's border, TerminalCoSPanel's ASCII art over --port-terminal-bg);
// against near-black surfaces (the default theme, and the fixed-dark 3D/SVG
// canvases the other 7 consumers render on) it's ~9.8:1, so the bug is
// day-theme-specific. A full per-theme-mode color swap was evaluated and
// deferred: 6 of the 9 consumers feed this value straight into three.js
// `<meshStandardMaterial color={...}>` props, which cannot resolve CSS custom
// properties (`var(--port-mood-thinking)`) — parity would need a resolved-hex
// lookup (via `getComputedStyle`) threaded through every 3D avatar, not just a
// CSS variable swap. See the follow-up discussion on #1909 for the scoped fix.
export const AGENT_STATES = {
  sleeping: { label: 'Sleeping', color: '#6366f1', icon: '💤' },
  thinking: { label: 'Thinking', color: '#f59e0b', icon: '🧠' },
  coding: { label: 'Coding', color: '#10b981', icon: '⚡' },
  investigating: { label: 'Investigating', color: '#ec4899', icon: '🔍' },
  reviewing: { label: 'Reviewing', color: '#8b5cf6', icon: '📋' },
  planning: { label: 'Planning', color: '#06b6d4', icon: '📐' },
  ideating: { label: 'Ideating', color: '#f97316', icon: '💡' },
};

// Cyber Muse (3D) avatar motion map. The bundled default model
// (data.reference/avatar/model.glb) is three.js's RobotExpressive (CC0), which
// ships 14 clips: Idle, Walking, Running, Dance, Death, Sitting, Standing,
// Jump, Yes, No, Wave, Punch, ThumbsUp, WalkJump.
//
// ONE map drives every state: `state → [{ clip, timeScale, loop }]`, an ordered
// list of steps. `loop` is
//   'infinite'   — loop the clip forever (never fires the mixer's `finished`)
//   'once'       — a single LoopOnce clamped on its final frame (a pose or
//                  transition clip like `Sitting`, held instead of looping)
//   { reps: N }  — a finite LoopRepeat of N cycles; `finished` then advances to
//                  the next step, wrapping around
//
// A length-1 list is a plain base loop. A longer list is a montage — `coding`
// cycles jab → sprint → leap → approve → stride → celebrate so a working agent
// reads as energetic and varied rather than one clip on repeat. THE FIRST STEP
// IS ALSO THE STATE'S FALLBACK: when the loaded GLB resolves fewer than two
// steps, `resolveMuseMotion` collapses the list to its first resolvable step and
// loops that — so "the montage degrades to its base clip" is structural, not a
// convention two maps had to agree on.
//
// Steps name real GLB clips. Walking / Running / WalkJump carry root
// translation (they move the model forward) and would drift a fixed-frame
// avatar out of view, so `resolveMuseMotion` auto-routes them to the
// neutralized in-place variants the avatar synthesizes at load time. A step's
// FIRST entry must still be an in-place clip (it is the fallback loop, played
// as named); the constants test asserts that.
//
// Consumed by MuseCoSAvatar's AnimationMixer (via drei useAnimations). Clip
// names are matched case-sensitively against the loaded GLB: unresolvable steps
// are dropped, a state with none left falls back to MUSE_ANIMATION_FALLBACK,
// and a GLB with NO clips at all falls back to the fully-procedural
// rotation/glow behavior so static models and other variants keep working.
//
// The emote clips (Yes/No/Wave/Punch/ThumbsUp) start and end near a neutral
// pose, so looping them reads as a repeated, deliberate gesture (nodding,
// scanning, jabbing) rather than snapping — that's what lets us give each state
// its own body language instead of collapsing everything onto Idle. The read
// for each: sleeping = seated rest; thinking = calm contemplation (Idle);
// coding = an energetic work montage; investigating = slow side-to-side scan
// (No); reviewing = approving nod (Yes); planning = confident "locked in"
// thumbs-up (ThumbsUp); ideating = creative celebration (Dance).
//
// The `speaking` boolean fires a one-shot gesture overlay
// (MUSE_SPEAKING_GESTURE) that hands control back to the current step when it
// finishes.
export const MUSE_STATE_MOTIONS = {
  sleeping:      [{ clip: 'Sitting',  timeScale: 0.8,  loop: 'once' }],
  thinking:      [{ clip: 'Idle',     timeScale: 0.85, loop: 'infinite' }],
  coding: [
    { clip: 'Punch',    timeScale: 1.2,  loop: { reps: 2 } },
    { clip: 'Running',  timeScale: 1.1,  loop: { reps: 4 } },
    { clip: 'Jump',     timeScale: 1.0,  loop: { reps: 1 } },
    { clip: 'ThumbsUp', timeScale: 0.95, loop: { reps: 1 } },
    { clip: 'Walking',  timeScale: 1.2,  loop: { reps: 4 } },
    { clip: 'Dance',    timeScale: 1.0,  loop: { reps: 1 } },
  ],
  investigating: [{ clip: 'No',       timeScale: 0.7,  loop: 'infinite' }],
  reviewing:     [{ clip: 'Yes',      timeScale: 0.8,  loop: 'infinite' }],
  planning:      [{ clip: 'ThumbsUp', timeScale: 0.85, loop: 'infinite' }],
  ideating:      [{ clip: 'Dance',    timeScale: 1.0,  loop: 'infinite' }],
};

// Naming suffix for the neutralized "run/walk in place" clip variants that
// MuseCoSAvatar synthesizes at load time (see `withInPlaceClips` in
// client/src/utils/animationClips.js). This is an INTERNAL implementation
// detail — the motion map above references real GLB clip names (`Running`) and
// `resolveMuseMotion` routes any root-motion clip to its stripped variant.
// Exported only so the avatar and the clip util agree on the suffix.
export const MUSE_IN_PLACE_SUFFIX = ' (in place)';

// Clip used when none of a state's mapped clips is in the loaded GLB.
export const MUSE_ANIMATION_FALLBACK = 'Idle';

// One-shot gesture played on the rising edge of `speaking`, then the avatar
// returns to the motion step it was on.
export const MUSE_SPEAKING_GESTURE = 'Wave';

// RobotExpressive clips that carry root translation (they walk the model
// forward). Never played as-is by the fixed-frame avatar: `resolveMuseMotion`
// routes a step naming one of these to its neutralized in-place variant, and
// the "GLB has clips but none are mapped" fallback skips them so a custom GLB
// whose first clip happens to be a walk cycle can't drift out of view.
export const MUSE_ROOT_MOTION_CLIPS = ['Walking', 'Running', 'WalkJump'];

// Last-resort clip for a GLB that has clips but none the state maps: prefer the
// canonical fallback, else the first in-place clip so a leading walk cycle can't
// drift the fixed-frame avatar, else whatever the GLB leads with.
const fallbackClip = (names) => (
  names.includes(MUSE_ANIMATION_FALLBACK)
    ? MUSE_ANIMATION_FALLBACK
    : names.find((n) => !MUSE_ROOT_MOTION_CLIPS.includes(n)) || names[0]
);

// Resolve a state's motion steps against `names`, the clip roster of the loaded
// GLB (which already includes the synthesized in-place variants). Root-motion
// steps are routed to their in-place variant, then any step the GLB can't
// supply is dropped. Returns the playable step list:
//   ≥2 steps → the montage, cycled by the avatar's `finished` listener
//    1 step  → a base loop; a finite `{ reps }` degrades to 'infinite' because
//              there is no next step to advance to, while an explicit 'once'
//              pose keeps clamping
//    0 steps → the state's first step re-pointed at a fallback clip, looped
// An empty/absent roster yields `[]` (the caller runs procedural-only).
export function resolveMuseMotion(state, names) {
  if (!Array.isArray(names) || names.length === 0) return [];
  const declared = MUSE_STATE_MOTIONS[state] || [];
  const resolved = declared
    .map((step) => ({ ...step, clip: inPlaceClipName(step.clip, MUSE_ROOT_MOTION_CLIPS, MUSE_IN_PLACE_SUFFIX) }))
    .filter((step) => names.includes(step.clip));
  if (resolved.length >= 2) return resolved;
  const step = resolved[0] || { ...declared[0], clip: fallbackClip(names) };
  return [{ ...step, loop: step.loop === 'once' ? 'once' : 'infinite' }];
}

// Default messages shown when no specific event message is available
export const STATE_MESSAGES = {
  sleeping: "Idle - waiting for tasks...",
  thinking: "Processing...",
  coding: "Working on task...",
  investigating: "Investigating issue...",
  reviewing: "Reviewing results...",
  planning: "Planning next steps...",
  ideating: "Analyzing options...",
};

// A health issue is the ONLY thing that flips an idle-but-running CoS into
// `investigating`, so the status bubble has to say *which* issue. Falling back
// to the generic STATE_MESSAGES line left the avatar parked on "Investigating
// issue..." with zero agents running and the detail reachable only by guessing
// at the Health tab. Returns null when there is nothing to report so callers
// can fall back to their own default. Issue shape mirrors the server's
// `runHealthCheck` (`{ type, category, message }` — server/services/cosHealthMonitor.js).
export const summarizeHealthIssues = (issues) => {
  if (!Array.isArray(issues) || issues.length === 0) return null;
  const messages = issues.map((issue) => issue?.message).filter(Boolean);
  // Counts come from `issues`, never from `messages` — a mixed list like
  // [{message:'A'}, {}] has two problems and one description, and counting the
  // descriptions would under-report it as a single issue.
  const plural = issues.length > 1 ? 's' : '';
  // A message-less issue still has to read as an issue — `null` means "nothing
  // to report", so callers that already know the list is non-empty never need a
  // fallback of their own.
  if (messages.length === 0) return `${issues.length} health issue${plural} detected`;
  if (issues.length === 1) return messages[0];
  return `${issues.length} health issues: ${messages.join(' · ')}`;
};

// Which of two health snapshots to keep. `getCosHealth` reads the *pre-check*
// persisted health while the same fetch batch triggers a fresh server-side check
// whose `cos:health:check` socket event can land first — so the slow read must
// not clobber the fresher socket result. Keep whichever check is newer by
// `lastCheck` (Date.parse normalizes the ISO timestamps so the compare never
// goes lexicographic), keep `prev` when the incoming read has no comparable
// timestamp but `prev` does, and treat a failed read (null) as "keep prev".
export const fresherHealth = (prev, next) => {
  if (!next) return prev ?? null;
  const prevT = Date.parse(prev?.lastCheck ?? '');
  const nextT = Date.parse(next.lastCheck ?? '');
  if (!Number.isNaN(prevT) && (Number.isNaN(nextT) || nextT < prevT)) return prev;
  return next;
};

// StatCard tone for the Issues tile. `error`-type issues mean something is
// broken; a warning-only check (e.g. a memory-hungry process) stays amber
// rather than screaming red — the same severity split HealthTab draws when it
// renders the list. 'default' (not null) so a zero-issue tile keeps its gray icon.
export const healthIssueTone = (issues) => {
  if (!Array.isArray(issues) || issues.length === 0) return 'default';
  return issues.some((issue) => issue?.type === 'error') ? 'critical' : 'warning';
};

// Agent option toggles for task metadata (useWorktree, openPR, simplify, requireApproval).
export const AGENT_OPTIONS = [
  { field: 'requireApproval', label: 'Require approval', shortLabel: 'Apr', description: 'Queue as awaiting-approve and do not auto-run — including Run Now — until you approve. Off (default): Run Now starts immediately; scheduled runs still follow the confidence and safety gates.' },
  { field: 'useWorktree', label: 'Worktree', shortLabel: 'WT', description: 'Work in an isolated git worktree on a feature branch. If unchecked, commits directly to the default branch.' },
  { field: 'openPR', label: 'Open PR', shortLabel: 'PR', description: 'Open a pull request to the default branch (implies worktree). Choose whether PortOS reviews and merges it, merges on green CI, or leaves it open. If unchecked with worktree enabled, auto-merges to the default branch on completion.' },
  { field: 'simplify', label: 'Run /simplify', shortLabel: '/s', description: 'Review code for reuse and quality before committing' }
];

export const PR_COMPLETION_OPTIONS = [
  { value: 'review-then-merge', label: 'Review then merge', description: 'Run the configured reviewer chain, then merge when it is clean.' },
  { value: 'merge-on-green', label: 'Merge on green CI', description: 'Skip external review and merge after required checks pass.' },
  { value: 'leave-open', label: 'Leave PR open', description: 'Open the PR and stop so you can inspect and merge it yourself.' }
];

export const prCompletionOption = (value) => PR_COMPLETION_OPTIONS.find(option => option.value === value);

export const DEFAULT_PR_COMPLETION = 'review-then-merge';

// The policy a task falls back to when nothing pins `prCompletion` — mirrors the
// `resolvePrCompletion` fallback in server/lib/prDisposition.js (legacy
// `reviewLoop` records aside). Scheduled tasks inherit their app's
// `defaultPrCompletion` first, so this is only the floor.
export const IMPLICIT_PR_COMPLETION = 'merge-on-green';

// Which option a stored taskMetadata pins, or '' when nothing does (inherit).
// Legacy `reviewLoop` records are the pre-`prCompletion` spelling of
// review-then-merge, so a control seeded from this shows what will actually
// happen rather than claiming to be unpinned. Client mirror of
// `resolvePrCompletion` in server/lib/prDisposition.js, minus its
// IMPLICIT_PR_COMPLETION floor — that floor is what "inherit" resolves to.
export function pinnedPrCompletion(metadata) {
  if (prCompletionOption(metadata?.prCompletion)) return metadata.prCompletion;
  return metadata?.reviewLoop === true || metadata?.reviewLoop === 'true' ? 'review-then-merge' : '';
}

// Reviewer choices for the Review Loop. `copilot` requests a GitHub Copilot
// review via the native reviewer API; CLI reviewers (claude/antigravity/codex/grok/cursor)
// instruct the follow-up agent to invoke the named CLI; local-LLM reviewers
// (lmstudio/ollama) route the diff through PortOS's `POST /api/code-review/local`
// endpoint, which runs the model configured on the Settings → Code Reviewers
// page. Keep in sync with the `REVIEWER_VALUES` enum in
// `server/lib/validation.js`.
export const REVIEWER_OPTIONS = [
  { value: 'copilot', label: 'Copilot', description: 'GitHub Copilot (GitHub-only)' },
  { value: 'claude', label: 'Claude', description: 'Claude CLI reviews the PR diff (optional model on Settings → Code Reviewers; supports an Ollama-backed Claude for local-only setups)' },
  { value: 'antigravity', label: 'Antigravity', description: 'Antigravity CLI (agy) reviews the PR diff' },
  { value: 'codex', label: 'Codex', description: 'Codex CLI reviews the PR diff (optional model tier on Settings → Code Reviewers)' },
  { value: 'grok', label: 'Grok', description: 'Grok Build CLI (grok) reviews the PR diff' },
  { value: 'cursor', label: 'Cursor Agent', description: 'Cursor Agent CLI (cursor-agent) reviews the PR diff' },
  { value: 'lmstudio', label: 'LM Studio', description: 'Local LM Studio model reviews the diff (set model on AI Providers)' },
  { value: 'ollama', label: 'Ollama', description: 'Local Ollama model reviews the diff (set model on AI Providers)' }
];
// The display label for a reviewer token — the one place UI copy turns a
// reviewer slug into prose, so a roster addition renders everywhere without a
// literal edit. Resolves the `gemini` alias; an `@username` (or any token with no
// option row) falls through to itself.
export const reviewerLabel = (value) =>
  REVIEWER_OPTIONS.find(o => o.value === normalizeReviewerSlug(value))?.label || value;

// The per-reviewer PIN vocabularies (which reviewers take a model or an effort,
// and the values each accepts) live in `client/src/lib/reviewerPins.js` and are
// re-exported here so existing imports keep working. They are NOT defined in this
// file because the server suite pins them against the server's own ladders, and
// this module's `lucide-react` icon import isn't installed in that workspace —
// see the leaf module's header for the full rationale.
export {
  MODEL_CAPABLE_CLI_REVIEWERS,
  LOCAL_LLM_REVIEWERS,
  MODEL_SELECTABLE_REVIEWERS,
  MAX_REVIEWER_MODEL_LENGTH,
  LOCAL_LLM_EFFORT_LEVELS,
  REVIEWER_EFFORT_LEVELS,
  EFFORT_SELECTABLE_REVIEWERS,
  reviewerEffortLevels,
  sanitizeReviewerModelInput
} from '../../lib/reviewerPins';

// pr-watcher author gate (taskMetadata.prAuthorFilter). Mirrors
// PR_AUTHOR_FILTERS in server/lib/validation.js. 'self' = PRs opened by the
// gh-authenticated operator (or their automation); 'others' = external
// contributors; 'any' = react to every opened PR.
export const PR_AUTHOR_FILTER_OPTIONS = [
  { value: 'any', label: 'Any author', description: 'React to every PR opened on the default branch' },
  { value: 'self', label: 'Opened by me', description: 'Only PRs opened by the gh-authenticated user (or their automation)' },
  { value: 'others', label: 'Opened by others', description: 'Only PRs opened by someone other than the gh-authenticated user' }
];

// claim-issue author gate (taskMetadata.issueAuthorFilter). Mirrors
// ISSUE_AUTHOR_FILTERS in server/lib/validation.js. 'self' = only claim issues
// YOU filed (the slashdo /do:next --self security boundary; the default);
// 'collaborators' = you plus everyone with repo/project access; 'owner' = only
// claim issues the repo owner filed; 'any' = claim any open issue. Listed
// narrowest-first so the dropdown reads as a widening scale.
export const ISSUE_AUTHOR_FILTER_OPTIONS = [
  { value: 'self', label: 'Filed by me only', description: 'Only claim open issues you filed (the /do:next --self security boundary — avoids acting on work embedded in a third party\'s issue)' },
  { value: 'collaborators', label: 'Me + collaborators', description: 'Claim open issues filed by you or by any account with access to the repo (GitHub collaborators / GitLab project members, including group-inherited access)' },
  { value: 'owner', label: 'Owner-filed only', description: 'Only claim open issues filed by the repository owner/creator' },
  { value: 'any', label: 'Any author', description: 'Claim the next eligible open issue regardless of who filed it' }
];

// Task types that claim from a forge issue tracker and therefore expose the
// issueAuthorFilter control. `claim-work` resolves to a concrete claim flow
// (github/gitlab) at dispatch but configures the filter here too. Add any new
// issue-claiming task type here rather than OR-ing literals across components.
export const ISSUE_AUTHOR_FILTER_TASK_TYPES = new Set(['claim-issue', 'claim-work']);

// Swarm fan-out (taskMetadata.swarmCount). Mirrors slashdo `/do:next --swarm=<N>`
// (clamped 1..6; bare --swarm = 3). 0 = off (single issue per run, the default);
// 2..6 = claim & ship that many independent issues in parallel. Server-side
// SWARM_COUNT_MIN/MAX (cosValidation.js) enforce the same 2..6 range. Exposed on
// the same forge-issue task types as the author filter.
export const SWARM_TASK_TYPES = ISSUE_AUTHOR_FILTER_TASK_TYPES;
export const SWARM_COUNT_OPTIONS = [
  { value: 0, label: 'Off (one issue per run)', description: 'Claim and ship a single issue per scheduled run (default)' },
  { value: 2, label: '2 in parallel', description: 'Claim and ship up to 2 independent issues per run, merges serialized' },
  { value: 3, label: '3 in parallel', description: 'Claim and ship up to 3 independent issues per run, merges serialized' },
  { value: 4, label: '4 in parallel', description: 'Claim and ship up to 4 independent issues per run, merges serialized' },
  { value: 5, label: '5 in parallel', description: 'Claim and ship up to 5 independent issues per run, merges serialized' },
  { value: 6, label: '6 in parallel', description: 'Claim and ship up to 6 independent issues per run, merges serialized' }
];

// branch-reconcile coordinator batch size (taskMetadata.branchesPerAgent).
// Keep this separate from claim-issue's swarm controls: one coordinator gets a
// prioritized branch batch, while issue claiming fans out one agent per issue.
export const BRANCHES_PER_AGENT_DEFAULT = 3;
export const BRANCHES_PER_AGENT_TASK_TYPES = new Set(['branch-reconcile']);
export const BRANCHES_PER_AGENT_OPTIONS = [1, 2, 3, 4, 5, 6].map((value) => ({
  value,
  label: `${value} branch${value === 1 ? '' : 'es'} per agent`,
  description: `Give each branch-reconcile coordinator up to ${value} prioritized branch${value === 1 ? '' : 'es'} per run`
}));

export const DEFAULT_REVIEWER = 'copilot';
export const DEFAULT_REVIEWERS = ['copilot'];

// Arbitrary GitHub reviewer usernames (e.g. `@CodeReviewbot`) requested as PR
// reviewers to gate merging, appended to slashdo's `--review-with` after the
// keyed reviewers. Client mirror of server/lib/cosValidation.js
// `normalizeReviewUsernames` + MAX_REVIEW_USERNAMES — keep the pattern/cap in
// sync so the picker rejects the same tokens the server would drop. Stored
// WITHOUT the leading `@` (added back only for display / the flag string).
export const MAX_REVIEW_USERNAMES = 20;
const REVIEW_USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9._-]{1,100})?$/;

// Validate a single raw username entry (strip `@`, trim). Returns the clean
// token or null if it isn't a shell-safe GitHub username/team slug.
export function cleanReviewUsername(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^@+/, '');
  return trimmed && REVIEW_USERNAME_RE.test(trimmed) ? trimmed : null;
}

// Normalize a raw list: drop invalid tokens, case-insensitively dedupe while
// preserving order, cap at MAX_REVIEW_USERNAMES. Returns clean usernames sans `@`.
export function normalizeReviewUsernames(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const clean = cleanReviewUsername(raw);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_REVIEW_USERNAMES) break;
  }
  return out;
}

// Upper bound on a per-reviewer `~max=<n>` round cap. Client mirror of
// MAX_REVIEWER_MAX_ROUNDS in `server/lib/cosValidation.js` — a value above it is
// dropped server-side, so the input must not offer one. `0` is valid and means
// "loop until clean" (slashdo's unlimited mode, bounded by its own guardrail);
// blank/absent means "no cap requested" and keeps slashdo's built-in default.
export const MAX_REVIEWER_MAX_ROUNDS = 10;

// Stop-mode for the multi-reviewer loop (slashdo `--review-stop-on-*`).
// Keep in sync with REVIEW_STOP_MODES in `server/lib/validation.js`.
export const REVIEW_STOP_MODES = [
  { value: 'all', label: 'Run all', description: 'Run every reviewer in order before merging (default)' },
  { value: 'on-findings', label: 'Stop on first fix', description: 'Stop after the first reviewer that landed a fix' },
  { value: 'on-clean', label: 'Stop on first clean', description: 'Stop after the first reviewer that reports zero findings' }
];
export const DEFAULT_REVIEW_STOP_MODE = 'all';

// Resolve metadata to an ordered, deduped reviewer list (client mirror of the
// server's normalizeReviewers): prefers `reviewers`, falls back to legacy
// single `reviewer`, defaults to `['copilot']`.
const REVIEWER_VALUES = REVIEWER_OPTIONS.map(o => o.value);
const REVIEWER_ALIASES = { gemini: 'antigravity', 'cursor-agent': 'cursor' };
export function normalizeReviewers(meta) {
  const raw = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  const source = Array.isArray(raw.reviewers)
    ? raw.reviewers
    : (typeof raw.reviewer === 'string' && raw.reviewer ? [raw.reviewer] : []);
  const seen = new Set();
  const out = [];
  for (const r of source) {
    const normalized = REVIEWER_ALIASES[r] || r;
    if (REVIEWER_VALUES.includes(normalized) && !seen.has(normalized)) { seen.add(normalized); out.push(normalized); }
  }
  return out.length ? out : [...DEFAULT_REVIEWERS];
}

// Returns the Tailwind className string for an agent option toggle button.
// effective: whether the option is on (global + override resolved)
// hasOverride: whether there's an explicit per-app override set
export function agentOptionButtonClass(effective, hasOverride) {
  if (effective) {
    return hasOverride
      ? 'bg-port-accent text-white border-port-accent font-semibold'
      : 'bg-port-accent/40 text-port-accent border-port-accent/50 font-semibold';
  }
  return hasOverride
    ? 'bg-gray-700 text-gray-400 border-gray-500'
    : 'bg-transparent text-gray-600 border-gray-700/50';
}

// Normalize a per-app provider/model pin (`taskTypeOverrides[<taskType>].providerId`
// / `.model`) to the ONE shape every write site sends. '' and null both mean
// "inherit" — the route deletes the key for either — but three surfaces used to
// clear with three different values ('', null, and '' → null), so the same user
// action read as three different intents in the diff. Emitting null from all of
// them is what makes the stored result identical (#4783).
export function providerPinPatch(providerId, model) {
  return { providerId: providerId || null, model: model || null };
}

// Whether an app has pinned anything of its own for a task type (as opposed to
// inheriting the task's Schedule pin).
export function hasProviderPin(override) {
  return !!(override?.providerId || override?.model);
}

// Compute new taskMetadata after toggling a field in a per-app override.
// Returns null when all overrides are cleared (inherit everything).
// Enforces invariant: openPR implies useWorktree (turning on openPR forces
// useWorktree on; turning off useWorktree forces openPR off).
export function toggleAppMetadataOverride(overrideMetadata, globalMetadata, field) {
  const current = overrideMetadata || {};
  const newMeta = { ...current };
  if (newMeta[field] !== undefined) {
    delete newMeta[field];
  } else {
    const effective = overrideMetadata?.[field] ?? globalMetadata?.[field] ?? false;
    newMeta[field] = !effective;
  }

  const resolve = (f) => newMeta[f] ?? globalMetadata?.[f] ?? false;

  // Enforce invariant: openPR implies useWorktree
  if (!resolve('useWorktree') && resolve('openPR')) {
    // useWorktree is effectively off but openPR is on — force openPR off
    newMeta.openPR = false;
  }
  if (resolve('openPR') && !resolve('useWorktree')) {
    // openPR on requires useWorktree — force useWorktree on
    newMeta.useWorktree = true;
  }

  // Clean entries that match the global value (revert to inherit)
  for (const key of Object.keys(newMeta)) {
    if (newMeta[key] === (globalMetadata?.[key] ?? false)) {
      delete newMeta[key];
    }
  }
  return Object.keys(newMeta).length ? newMeta : null;
}

export const MEMORY_TYPES = ['fact', 'learning', 'observation', 'decision', 'preference', 'context'];

// Intentional category-color enum (#1909/#1924 caution): a fixed 6-hue palette
// so each memory type reads as a distinct badge at a glance (fact vs learning
// vs observation etc.). Left as raw Tailwind hues rather than port-* tokens —
// the app only has ~4-5 semantic tokens (accent/accent-2/success/warning/error),
// which isn't enough to keep 6 categories visually distinct without collisions.
export const MEMORY_TYPE_COLORS = {
  fact: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  learning: 'bg-green-500/20 text-green-400 border-green-500/30',
  observation: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  decision: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  preference: 'bg-pink-500/20 text-pink-400 border-pink-500/30',
  context: 'bg-gray-500/20 text-gray-400 border-gray-500/30'
};

// Per-domain autonomy guardrails (#711). Mirrors server/lib/domainAutonomy.js —
// each domain is independently set to off | dry-run | execute. Default is
// `execute` (historical behavior). Keep this list in sync with the server.
export const AUTONOMY_DOMAINS = [
  { id: 'brain', label: 'Brain auto-classify', description: 'Auto-classify captured thoughts and file them.' },
  { id: 'memory', label: 'Memory auto-extract', description: 'Auto-store high-confidence memories from agent runs.' },
  { id: 'cos', label: 'CoS auto-run', description: 'Auto-spawn autonomous (non-user) tasks without approval.' },
  { id: 'messages', label: 'Messages auto-send', description: 'Auto-forward notifications to outbound channels (Telegram).' }
];

export const DOMAIN_AUTONOMY_MODES = [
  { id: 'off', label: 'Off', description: 'Never act automatically — leave it for manual action.' },
  { id: 'dry-run', label: 'Dry-run', description: 'Plan the action and surface it, but don\'t commit the side effect.' },
  { id: 'execute', label: 'Execute', description: 'Act automatically (default).' }
];

export const DEFAULT_DOMAIN_MODE = 'execute';

// Resolve a domain's mode from config, tolerating absent/partial config.
export const getDomainMode = (config, domainId) => {
  const candidate = config?.domainAutonomy?.[domainId];
  return DOMAIN_AUTONOMY_MODES.some(m => m.id === candidate) ? candidate : DEFAULT_DOMAIN_MODE;
};

// Per-domain daily autonomy budgets (#711). Mirrors server/lib/domainBudgets.js.
// Each domain caps autonomous work on two measurable dimensions; an empty/0 cap
// means unlimited. (No token/$ caps — CLI subscription providers expose no
// per-run metering, so a money/token cap couldn't be enforced honestly.)
export const DOMAIN_BUDGET_FIELDS = [
  { id: 'maxActionsPerDay', label: 'Actions/day', usageKey: 'actions' },
  { id: 'maxMinutesPerDay', label: 'Minutes/day', usageKey: 'minutes' }
];

// Coerce a cap to a positive integer or null (unlimited) — mirrors the server's
// normalizeBudgetLimit so the UI's "is a cap set?" view matches enforcement.
export const normalizeBudgetLimit = (value) => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
};

// Resolve a domain's budget from config, tolerating absent/partial config.
export const getDomainBudget = (config, domainId) => {
  const b = config?.domainBudgets?.[domainId] || {};
  return {
    maxActionsPerDay: normalizeBudgetLimit(b.maxActionsPerDay),
    maxMinutesPerDay: normalizeBudgetLimit(b.maxMinutesPerDay)
  };
};

// Autonomy level presets for CoS behavior
export const AUTONOMY_LEVELS = [
  {
    id: 'standby',
    label: 'Standby',
    color: 'green',
    description: 'Only processes user-defined tasks from TASKS.md',
    params: {
      maxConcurrentAgents: 1,
      maxConcurrentAgentsPerProject: 1,
      improvementEnabled: false,
      proactiveMode: false,
      idleReviewEnabled: false,
      immediateExecution: false
    }
  },
  {
    id: 'assistant',
    label: 'Assistant',
    color: 'blue',
    description: 'Processes user tasks plus improvement tasks on schedule',
    params: {
      maxConcurrentAgents: 2,
      maxConcurrentAgentsPerProject: 1,
      improvementEnabled: true,
      proactiveMode: false,
      idleReviewEnabled: false,
      immediateExecution: true
    }
  },
  {
    id: 'manager',
    label: 'Manager',
    color: 'yellow',
    description: 'Full task processing with app improvements, no proactive mode',
    params: {
      maxConcurrentAgents: 3,
      maxConcurrentAgentsPerProject: 2,
      improvementEnabled: true,
      proactiveMode: false,
      idleReviewEnabled: true,
      immediateExecution: true
    }
  },
  {
    id: 'yolo',
    label: 'YOLO',
    color: 'red',
    description: 'Maximum autonomy with proactive task creation',
    params: {
      maxConcurrentAgents: 5,
      maxConcurrentAgentsPerProject: 3,
      improvementEnabled: true,
      proactiveMode: true,
      idleReviewEnabled: true,
      immediateExecution: true
    }
  }
];

// Get params for a specific autonomy level
export const computeAutonomyParams = (levelId) => {
  const level = AUTONOMY_LEVELS.find(l => l.id === levelId);
  return level ? level.params : null;
};

// Detect which autonomy level matches the current config (or null for custom)
export const detectAutonomyLevel = (config) => {
  if (!config) return null;

  for (const level of AUTONOMY_LEVELS) {
    const matches = Object.entries(level.params).every(([key, value]) => {
      return config[key] === value;
    });
    if (matches) return level.id;
  }
  return null; // Custom configuration
};

// Avatar style labels for display
export const AVATAR_STYLE_LABELS = {
  svg: 'Digital (SVG)',
  cyber: 'Cyberpunk (3D)',
  sigil: 'Arcane Sigil (3D)',
  esoteric: 'Esoteric (3D)',
  nexus: 'Neural Nexus (3D)',
  muse: 'Cyber Muse (3D)',
  // Bundled CC0 Kenney Mini Characters — animated rigged GLB avatars.
  miniMaleC: 'Mini Character — Male (3D)',
  miniFemaleD: 'Mini Character — Female (3D)',
  ascii: 'Minimalist (ASCII)'
};

// Dynamic avatar rules - maps task context to avatar styles
// Priority order: provider > analysisType > taskType > priority > fallback
const DYNAMIC_AVATAR_RULES = {
  // Provider-based: different providers get distinct visual identities
  provider: {
    codex: 'esoteric',        // OpenAI Codex → mystical/ancient aesthetic
    'lm-studio': 'sigil',    // Local LM Studio → arcane/occult aesthetic
    'antigravity-cli': 'sigil', // Antigravity → arcane aesthetic
    'gemini-cli': 'sigil',      // Legacy Gemini configs → arcane aesthetic
  },
  // Improvement task analysis types → cyberpunk (system working on itself)
  analysisType: {
    security: 'cyber',
    'code-quality': 'cyber',
    'test-coverage': 'cyber',
    performance: 'cyber',
    'console-errors': 'cyber',
  },
  // Task analysis types
  taskType: {
    internal: 'sigil',        // Internal CoS tasks → arcane
  },
  // Priority-based: critical tasks get a distinctive look
  priority: {
    CRITICAL: 'esoteric',
  }
};

/**
 * Resolve which avatar style to display based on active agent metadata.
 * Returns null if no rule matches (caller should use configured default).
 */
export const resolveDynamicAvatar = (agentMetadata) => {
  if (!agentMetadata) return null;

  // Check provider rules first
  const providerId = agentMetadata.providerId || agentMetadata.provider;
  if (providerId && DYNAMIC_AVATAR_RULES.provider[providerId]) {
    return DYNAMIC_AVATAR_RULES.provider[providerId];
  }

  // Check analysis type (improvement tasks)
  const analysisType = agentMetadata.analysisType || agentMetadata.selfImprovementType;
  if (analysisType && DYNAMIC_AVATAR_RULES.analysisType[analysisType]) {
    return DYNAMIC_AVATAR_RULES.analysisType[analysisType];
  }

  // Check task type
  if (agentMetadata.taskType && DYNAMIC_AVATAR_RULES.taskType[agentMetadata.taskType]) {
    return DYNAMIC_AVATAR_RULES.taskType[agentMetadata.taskType];
  }

  // Check priority
  if (agentMetadata.priority && DYNAMIC_AVATAR_RULES.priority[agentMetadata.priority]) {
    return DYNAMIC_AVATAR_RULES.priority[agentMetadata.priority];
  }

  return null;
};

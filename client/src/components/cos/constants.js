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
  ChartGantt
} from 'lucide-react';

export const TABS = [
  { id: 'briefing', label: 'Briefing', icon: Newspaper },
  { id: 'tasks', label: 'Tasks', icon: FileText },
  { id: 'agents', label: 'Agents', icon: Cpu },
  { id: 'jobs', label: 'System Tasks', icon: Bot },
  { id: 'schedule', label: 'Schedule', icon: Clock },
  { id: 'workflow', label: 'Timeline', icon: ChartGantt },
  { id: 'digest', label: 'Digest', icon: Calendar },
  { id: 'gsd', label: 'GSD', icon: Compass },
  { id: 'productivity', label: 'Streaks', icon: Flame },
  { id: 'learning', label: 'Learning', icon: GraduationCap },
  { id: 'memory', label: 'Memory', icon: Brain },
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

// Cyber Muse (3D) avatar animation triggers. The bundled default model
// (data.reference/avatar/model.glb) is three.js's RobotExpressive (CC0), which
// ships 14 clips: Idle, Walking, Running, Dance, Death, Sitting, Standing,
// Jump, Yes, No, Wave, Punch, ThumbsUp, WalkJump.
//
// Each of the 7 AGENT_STATES maps to an IN-PLACE base loop. Walking / Running /
// WalkJump carry root translation (they move the model forward) and are
// intentionally excluded so a fixed-frame avatar can't drift out of view. The
// `speaking` boolean fires a one-shot gesture overlay (MUSE_SPEAKING_GESTURE)
// that hands control back to the base loop when it finishes.
//
// Consumed by MuseCoSAvatar's AnimationMixer (via drei useAnimations). Clip
// names are matched case-sensitively against the loaded GLB and guarded: a GLB
// missing a mapped clip falls back to MUSE_ANIMATION_FALLBACK, and a GLB with
// NO clips at all falls back to the fully-procedural rotation/glow behavior so
// static models and other variants keep working. `once: true` clamps a
// pose/transition clip (Sitting) on its final frame instead of looping it.
// The emote clips (Yes/No/Wave/Punch/ThumbsUp) start and end near a neutral
// pose, so looping them reads as a repeated, deliberate gesture (nodding,
// scanning, jabbing) rather than snapping — that's what lets us give each
// state its own body language instead of collapsing everything onto Idle. The
// read for each: sleeping = seated rest; thinking = calm contemplation (Idle);
// coding = jabbing away at the work (Punch); investigating = slow side-to-side
// scan (No); reviewing = approving nod (Yes); planning = confident "locked in"
// thumbs-up (ThumbsUp); ideating = creative celebration (Dance).
//
// This map is the single-clip base loop for each state — also the graceful
// fallback for any state that ALSO has a MUSE_STATE_SEQUENCES entry (below) but
// whose GLB is missing the sequence clips. Keep every entry mapped to an
// in-place clip; the constants test asserts none is a MUSE_ROOT_MOTION_CLIPS.
export const MUSE_STATE_ANIMATIONS = {
  sleeping:      { clip: 'Sitting',  timeScale: 0.8, once: true },
  thinking:      { clip: 'Idle',     timeScale: 0.85 },
  coding:        { clip: 'Punch',    timeScale: 1.1 },
  investigating: { clip: 'No',       timeScale: 0.7 },
  reviewing:     { clip: 'Yes',      timeScale: 0.8 },
  planning:      { clip: 'ThumbsUp', timeScale: 0.85 },
  ideating:      { clip: 'Dance',    timeScale: 1.0 },
};

// Naming suffix for the neutralized "run/walk in place" clip variants that
// MuseCoSAvatar synthesizes at load time (see `withInPlaceClips` in
// client/src/utils/animationClips.js). This is an INTERNAL implementation
// detail — sequences below reference real GLB clip names (`Running`) and the
// avatar auto-routes any root-motion clip to its stripped variant. Exported
// only so the avatar and the clip util agree on the suffix.
export const MUSE_IN_PLACE_SUFFIX = ' (in place)';

// Multi-clip montages: a state can cycle through an ordered list of clips
// instead of looping one. Each step plays for `reps` repetitions (finite
// LoopRepeat), then the AnimationMixer's `finished` event advances to the next
// step, wrapping around — so `coding` reads as an energetic, varied work
// montage (jab, sprint, leap, approve, stride, celebrate) rather than a single
// clip on infinite repeat. Steps name real GLB clips; root-motion clips
// (`Running`/`Walking`) are automatically routed to their neutralized in-place
// variant by the avatar, so they can't drift the fixed frame. Steps are
// resolved against the loaded GLB at runtime; unresolvable clips are dropped,
// and a state whose GLB yields fewer than 2 resolvable steps falls back to its
// MUSE_STATE_ANIMATIONS base loop.
export const MUSE_STATE_SEQUENCES = {
  coding: [
    { clip: 'Punch',    timeScale: 1.2,  reps: 2 },
    { clip: 'Running',  timeScale: 1.1,  reps: 4 },
    { clip: 'Jump',     timeScale: 1.0,  reps: 1 },
    { clip: 'ThumbsUp', timeScale: 0.95, reps: 1 },
    { clip: 'Walking',  timeScale: 1.2,  reps: 4 },
    { clip: 'Dance',    timeScale: 1.0,  reps: 1 },
  ],
};

// Clip used when a mapped state clip is absent from the loaded GLB.
export const MUSE_ANIMATION_FALLBACK = 'Idle';

// One-shot gesture played on the rising edge of `speaking`, then the avatar
// returns to its base state loop (or resumes its montage).
export const MUSE_SPEAKING_GESTURE = 'Wave';

// RobotExpressive clips that carry root translation (they walk the model
// forward). Never used as a base loop for the fixed-frame avatar — the state
// map above avoids them, the constants test asserts it, and MuseCoSAvatar's
// "GLB has clips but none are mapped" fallback skips them so a custom GLB
// whose first clip happens to be a walk cycle can't drift out of view. When a
// montage step names one of these, the avatar auto-routes it to its neutralized
// in-place variant (root-translation stripped) so it no longer drifts.
export const MUSE_ROOT_MOTION_CLIPS = ['Walking', 'Running', 'WalkJump'];

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

// Agent option toggles for task metadata (useWorktree, openPR, simplify, reviewLoop)
export const AGENT_OPTIONS = [
  { field: 'useWorktree', label: 'Worktree', shortLabel: 'WT', description: 'Work in an isolated git worktree on a feature branch. If unchecked, commits directly to the default branch.' },
  { field: 'openPR', label: 'Open PR', shortLabel: 'PR', description: 'Open a pull request to the default branch (implies worktree). If unchecked with worktree enabled, auto-merges to the default branch on completion.' },
  { field: 'simplify', label: 'Run /simplify', shortLabel: '/s', description: 'Review code for reuse and quality before committing' },
  { field: 'reviewLoop', label: 'Review Loop', shortLabel: 'RL', description: 'After the agent opens a PR during its run, keep iterating on review feedback until checks pass. Only applies when Open PR is not enabled (manual PR creation by agent).' }
];

// Reviewer choices for the Review Loop. `copilot` requests a GitHub Copilot
// review via the native reviewer API; CLI reviewers (claude/antigravity/codex/grok)
// instruct the follow-up agent to invoke the named CLI; local-LLM reviewers
// (lmstudio/ollama) route the diff through PortOS's `POST /api/code-review/local`
// endpoint, which runs the model configured on the AI Providers → Code Review
// Defaults panel. Keep in sync with the `REVIEWER_VALUES` enum in
// `server/lib/validation.js`.
export const REVIEWER_OPTIONS = [
  { value: 'copilot', label: 'Copilot', description: 'GitHub Copilot (GitHub-only)' },
  { value: 'claude', label: 'Claude', description: 'Claude CLI reviews the PR diff (optional model on AI Providers → Code Review Defaults; supports an Ollama-backed Claude for local-only setups)' },
  { value: 'antigravity', label: 'Antigravity', description: 'Antigravity CLI (agy) reviews the PR diff' },
  { value: 'codex', label: 'Codex', description: 'Codex CLI reviews the PR diff (optional model tier on AI Providers → Code Review Defaults)' },
  { value: 'grok', label: 'Grok', description: 'Grok Build CLI (grok) reviews the PR diff' },
  { value: 'lmstudio', label: 'LM Studio', description: 'Local LM Studio model reviews the diff (set model on AI Providers)' },
  { value: 'ollama', label: 'Ollama', description: 'Local Ollama model reviews the diff (set model on AI Providers)' }
];
export const LOCAL_LLM_REVIEWERS = ['lmstudio', 'ollama'];

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
// 'owner' = only claim issues the repo owner filed; 'any' = claim any open issue.
export const ISSUE_AUTHOR_FILTER_OPTIONS = [
  { value: 'self', label: 'Filed by me only', description: 'Only claim open issues you filed (the /do:next --self security boundary — avoids acting on work embedded in a third party\'s issue)' },
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
const REVIEWER_ALIASES = { gemini: 'antigravity' };
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

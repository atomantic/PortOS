/**
 * Agent Prompt Builder
 *
 * Builds the full agent prompt including memory context, CLAUDE.md instructions,
 * digital twin, worktree/pipeline/JIRA sections, skill templates, and tools summary.
 * Also handles JIRA ticket creation and app workspace resolution.
 */

import { join, basename } from 'path';
import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { getMemorySection } from './memoryRetriever.js';
import { getDigitalTwinForPrompt } from './digital-twin.js';
import { buildPrompt } from './promptService.js';
import { getToolsSummaryForPrompt } from './tools.js';
import { getActiveProvider } from './providers.js';
import { runPromptThroughProvider } from '../lib/promptRunner.js';
import { readJSONFile, PATHS, tryReadFile, expandHome } from '../lib/fileUtils.js';
import { loadSlashdoFile, loadSlashdoLib, writeResolvedSlashdoBody } from '../lib/slashdoLoader.js';
import { DEFAULT_REVIEWER, DEFAULT_REVIEWERS, DEFAULT_REVIEW_STOP_MODE, LOCAL_LLM_REVIEWERS, MODEL_CAPABLE_CLI_REVIEWERS, describeReviewerCli, isCliReviewer, reviewerCliBinary, normalizeReviewUsernames, normalizeOptionalReviewers, normalizeReviewerMaxRounds, resolveReviewerConfig, reviewerEffortArgs, buildReviewerEffortNote, resolveKeyedReviewers, buildReviewWithArgs, buildReviewersCsv } from '../lib/validation.js';
import { PROVIDER_TYPES } from '../lib/aiToolkit/constants.js';
import { canTypeSlashCommands, resolveSlashdoInvocation, buildSlashdoSection, unreachableReviewerIncludes, SLASHDO_INLINE_BUDGET_CHARS } from '../lib/slashdoInvocation.js';
import { shellQuote } from '../lib/shellQuote.js';
import { detectForgeCli } from '../lib/gitForge.js';
import { PR_COMPLETIONS, leavesPrForHuman, resolvePrCompletion } from '../lib/prDisposition.js';
import * as jiraService from './jira.js';
import { emitLog } from './cosEvents.js';
import { PORTOS_APP_ID } from './apps.js';
import { getCodeReviewDefaults } from './codeReview.js';

const ROOT_DIR = PATHS.root;
const AGENTS_DIR = PATHS.cosAgents;
const SKILLS_DIR = join(ROOT_DIR, 'data/prompts/skills');

// Appended to every agent briefing. PortOS shares ONE pm2 daemon across many
// apps; an agent restarting "the server" once ran `pm2 kill` and took the whole
// machine (incl. PortOS) down. A PATH shim (server/lib/agentGuard) hard-blocks
// the destructive subcommands, but the prompt rule keeps a well-behaved agent
// from even attempting them.
export const PM2_SAFETY_RULE = `## ⚠️ PM2 Safety (shared server)
PortOS runs MANY apps under one shared pm2 daemon. To restart an app, use a SCOPED command — \`pm2 restart <that-app's-process-name>\`. NEVER run \`pm2 kill\`, \`pm2 stop\`, \`pm2 delete\`, \`pm2 startup\`/\`unstartup\`, or any \`pm2 <verb> all\` form: they take down EVERY app on this machine, including PortOS itself, and are blocked (they will fail).`;

// Also appended to every agent briefing. A CoS agent runs headless: the TUI has
// no human attached, so an interactive selector or approval gate is a dead end —
// the session repaints it until the idle reaper kills the run and the work is
// discarded. Nothing in the briefing used to SAY that, so a `/do:plan-task` run
// (whose skill shows its drafted issue for approval before filing) parked on a
// scope question for its whole life and was retried into the same gate three
// times, filing nothing. The rule names the escape hatch too: slash commands
// that gate on approval take a flag to skip it.
export const UNATTENDED_RUN_RULE = `## ⚠️ Unattended Run (no human is present)
PortOS launched you autonomously. Nobody is watching this session and nothing can answer you — if you present an interactive choice (a multiple-choice question, an approval gate, a "which option?" selector, a confirmation), the session sits there until the idle reaper kills it and **your work is thrown away**.
- **Never ask the user to choose or approve.** Make the call yourself, state the assumption in your summary, and proceed.
- **Invoke commands and skills in their non-interactive form.** If one drafts something and gates on approval before acting, pass the flag that skips that gate (\`--yes\` for the slashdo commands that have one).
- **Ambiguous task?** Pick the most reasonable reading, do the work, and note the alternatives you rejected in your completion summary.
- **Genuinely blocked** (missing credential, contradictory requirements)? Write why to the completion sentinel and stop. Do NOT wait for a reply.`;

/**
 * Skill template keyword matchers.
 * Each entry maps a skill template filename to its trigger keywords.
 * Order matters — first match wins, so more specific patterns come first.
 */
const SKILL_MATCHERS = [
  {
    skill: 'security-audit',
    keywords: ['security', 'audit', 'vulnerability', 'xss', 'injection', 'owasp', 'cve', 'penetration', 'hardening', 'sanitize', 'authorization']
  },
  {
    skill: 'mobile-responsive',
    keywords: ['mobile', 'responsive', 'tablet', 'breakpoint', 'viewport', 'touch', 'swipe', 'small screen', 'media query', 'mobile-friendly', 'adaptive']
  },
  {
    skill: 'bug-fix',
    keywords: ['fix', 'bug', 'broken', 'error', 'crash', 'issue', 'not working', 'fails', 'regression', 'defect']
  },
  {
    skill: 'refactor',
    keywords: ['refactor', 'reorganize', 'restructure', 'clean up', 'simplify', 'extract', 'consolidate', 'decouple', 'modularize']
  },
  {
    skill: 'documentation',
    keywords: ['document', 'documentation', 'docs', 'readme', 'jsdoc', 'api docs', 'guide', 'tutorial', 'changelog']
  },
  {
    skill: 'feature',
    keywords: ['add', 'create', 'implement', 'build', 'new', 'feature', 'support', 'enable', 'integrate', 'endpoint', 'page', 'component']
  }
];

/**
 * Detect the best matching skill template for a task based on description keywords.
 * @param {Object} task - Task object with description
 * @returns {string|null} Skill template name or null if no match
 */
export function detectSkillTemplate(task) {
  const desc = (task?.description || '').toLowerCase();
  for (const matcher of SKILL_MATCHERS) {
    if (matcher.keywords.some(kw => desc.includes(kw))) {
      return matcher.skill;
    }
  }
  return null;
}

/**
 * Load a skill template from disk if it exists.
 * @param {string} skillName - Name of the skill template file (without .md)
 * @returns {Promise<string|null>} Template content or null
 */
export async function loadSkillTemplate(skillName) {
  const content = await tryReadFile(join(SKILLS_DIR, `${skillName}.md`));
  if (content) console.log(`🎯 Loaded skill template: ${skillName}`);
  return content;
}

// Nested-CLAUDE.md discovery bounds (#3866). On-demand nested memory files are a
// Claude Code feature — an API-provider agent reads nothing natively, so PortOS
// has to splice them in itself or a subtree rule (including a data-loss guard)
// never reaches that class of agent. The walk is bounded on three axes so a repo
// that grows nested files can't silently balloon every agent prompt or turn one
// prompt build into a full-tree crawl.
const NESTED_CLAUDE_MD_MAX_DEPTH = 5;
const NESTED_CLAUDE_MD_MAX_FILES = 10;
const NESTED_CLAUDE_MD_MAX_DIRS = 2000;
// Dot-directories are skipped wholesale (covers `.git`), so these are the
// non-dot trees that are either vendored, generated, or runtime state. The list
// is deliberately polyglot: an agent workspace is any app PortOS manages, not
// just this repo, so a Rust `target/` or a Go `vendor/` would otherwise burn the
// directory budget on generated files.
const NESTED_CLAUDE_MD_SKIP_DIRS = new Set([
  'node_modules', 'data', 'data.reference', 'dist', 'build', 'coverage',
  'out', 'obj', 'bin', 'target', 'vendor', 'tmp', 'venv', 'Pods', '__pycache__',
]);

/**
 * Collect workspace-relative paths of nested `CLAUDE.md` files (the root one is
 * excluded — its caller reads it separately and must keep it first). Depth-first
 * in lexicographic order, so the result is deterministic and prompt caching stays
 * stable across builds.
 * @param {string} workspaceDir
 * @returns {Promise<string[]>} repo-relative paths, e.g. `['server/CLAUDE.md']`
 */
async function findNestedClaudeMdFiles(workspaceDir) {
  const found = [];
  let dirsVisited = 0;

  const walk = async (dir, relDir, depth) => {
    if (found.length >= NESTED_CLAUDE_MD_MAX_FILES) return;
    if (depth > NESTED_CLAUDE_MD_MAX_DEPTH) return;
    if (dirsVisited >= NESTED_CLAUDE_MD_MAX_DIRS) return;
    dirsVisited += 1;

    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    // A nested directory carrying its own `.git` is a submodule or vendored
    // checkout (`lib/slashdo` here) — its CLAUDE.md is that project's
    // instructions, not this workspace's. Detected structurally rather than by
    // an allowlist of paths, which would silently stop matching the moment the
    // workspace root is something other than this repo's root.
    if (depth > 0 && entries.some((entry) => entry.name === '.git')) return;
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const subdirs = [];
    for (const entry of sorted) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue;
        if (NESTED_CLAUDE_MD_SKIP_DIRS.has(entry.name)) continue;
        subdirs.push({ path: join(dir, entry.name), rel });
        // Symlinked directories are deliberately NOT followed — a link back up
        // the tree would loop, and the depth cap alone wouldn't make the result
        // meaningful. A symlinked CLAUDE.md *file* is still read (below).
      } else if (entry.name === 'CLAUDE.md' && relDir) {
        found.push(rel);
        if (found.length >= NESTED_CLAUDE_MD_MAX_FILES) return;
      }
    }

    for (const sub of subdirs) {
      if (found.length >= NESTED_CLAUDE_MD_MAX_FILES) return;
      await walk(sub.path, sub.rel, depth + 1);
    }
  };

  await walk(workspaceDir, '', 0);
  return found;
}

/**
 * Read CLAUDE.md files for agent context.
 * Reads the global (`~/.claude/CLAUDE.md`), the workspace-root `CLAUDE.md`, and
 * every nested `CLAUDE.md` under the workspace (#3866) — nested last, each as its
 * own labeled section, so precedence still reads root-then-specific.
 */
export async function getClaudeMdContext(workspaceDir) {
  const contexts = [];

  // Try to read global CLAUDE.md from ~/.claude/CLAUDE.md
  const globalPath = join(homedir(), '.claude', 'CLAUDE.md');
  const globalContent = await tryReadFile(globalPath);
  if (globalContent?.trim()) {
    contexts.push({ type: 'Global Instructions', path: globalPath, content: globalContent.trim() });
  }

  // Try to read project-specific CLAUDE.md from workspace directory
  const projectPath = join(workspaceDir, 'CLAUDE.md');
  const projectContent = await tryReadFile(projectPath);
  if (projectContent?.trim()) {
    contexts.push({ type: 'Project Instructions', path: projectPath, content: projectContent.trim() });
  }

  // Nested per-directory instructions, appended after the root file.
  for (const rel of await findNestedClaudeMdFiles(workspaceDir)) {
    const nestedPath = join(workspaceDir, rel);
    const nestedContent = await tryReadFile(nestedPath);
    if (nestedContent?.trim()) {
      contexts.push({ type: `Project Instructions (${rel})`, path: nestedPath, content: nestedContent.trim() });
    }
  }

  if (contexts.length === 0) {
    return null;
  }

  let section = '## CLAUDE.md Instructions\n\n';
  section += 'The following instructions must be followed when working on this task:\n\n';

  for (const ctx of contexts) {
    section += `### ${ctx.type}\n`;
    section += `Source: \`${ctx.path}\`\n\n`;
    section += ctx.content + '\n\n';
  }

  return section;
}

/**
 * Build a compaction instruction section for retries after context-limit failures.
 * Provides explicit guidance to the agent on reducing output verbosity.
 */
export function buildCompactionSection(task) {
  const compaction = task.metadata?.compaction;
  if (!compaction?.needed) return '';

  const hints = compaction.retryHints || [];
  const reason = compaction.reason === 'output-limit' ? 'output length limit' : 'context window limit';
  const prevOutputKB = compaction.outputSize ? Math.round(compaction.outputSize / 1024) : 'unknown';

  return `
## Context Compaction Required

**WARNING**: A previous attempt at this task failed because the agent exceeded the ${reason}.
Previous output size: ~${prevOutputKB} KB. You MUST keep your output compact to avoid the same failure.

**Mandatory output constraints**:
${hints.map(h => `- ${h}`).join('\n')}
- Do NOT reproduce entire file contents in your output
- Reference files by path and line number instead of quoting them
- Limit exploratory reads — plan your approach first, then make targeted changes
`;
}

/**
 * Provider types that get the **light** prompt: agentic CLIs with native
 * filesystem tools and CLAUDE.md loading (Claude Code, Codex, Antigravity —
 * whether running interactively as `tui` or one-shot as `cli`). Everything
 * else (`api`: LM Studio, raw OpenAI/Anthropic) needs the full pasted-in
 * context because it has no native filesystem access.
 */
const LIGHT_CONTEXT_PROVIDER_TYPES = new Set([PROVIDER_TYPES.TUI, PROVIDER_TYPES.CLI]);

// Inline reuse/quality/efficiency self-review wording for agents that can't run
// the Claude Code `/simplify` built-in (API providers + codex/antigravity CLIs).
// Shared by both prompt paths so the two phrasings can't drift apart.
const SIMPLIFY_INLINE_REVIEW = 'review your changed code for reuse, quality, and efficiency (DRY, dead code, naming, simpler equivalents, missed edge cases)';

/**
 * Render a file-list task field (screenshots, attachments, …) either as a
 * `### Header` + bulleted-path list (light path) or a single inline
 * `**Header**: a, b` line (full path). Shared by every file-list field in
 * `buildTaskBlock` so a wording tweak or a new field can't drift between them.
 *
 * @param {string} header - Section heading / inline label (e.g. "Screenshots").
 * @param {Array} items - Task-metadata array; anything else renders as ''.
 * @param {(item: any) => string} formatItem - Renders one item for the bulleted list.
 * @param {(item: any) => string} formatInline - Renders one item for the inline join.
 * @param {boolean} asList - Bulleted-list style vs. inline style.
 * @returns {string}
 */
function renderFileListField(header, items, formatItem, formatInline, asList) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return asList
    ? `### ${header}\nUse your filesystem tools to inspect each path:\n` +
      items.map(i => `- ${formatItem(i)}`).join('\n')
    : `**${header}**: ${items.map(formatInline).join(', ')}`;
}

/**
 * Build the shared task block — the description plus optional `**Target App**`,
 * `**Screenshots**`, and `**Attachments**` fields. Used by BOTH the light and
 * full prompt paths so a new task-metadata field gets surfaced in both without
 * drift.
 *
 * Returns pre-rendered slots (`description`, `targetApp`, `screenshots`,
 * `attachments`). Absent fields come back as empty strings so the full path's
 * template literal can interpolate them in fixed positions and preserve
 * byte-identical line spacing. The light path filters out the empty strings
 * and joins what remains.
 *
 * @param {Object} task
 * @param {Object} [opts]
 * @param {boolean} [opts.screenshotsAsList=false] - When true, render screenshots
 *   and attachments as a header followed by a bulleted list of paths (light
 *   path style). When false, render as a single inline `**Field**: a, b`
 *   line (full path style).
 * @returns {{ description: string, targetApp: string, screenshots: string, attachments: string }}
 */
export function buildTaskBlock(task, { screenshotsAsList = false } = {}) {
  const description = task.description;
  // Only surface **Target App** for MANAGED apps — it scopes cross-repo work the
  // agent's cwd wouldn't otherwise reveal. For the PortOS default app the agent
  // already runs in the PortOS directory, so the line is redundant noise.
  const app = task.metadata?.app;
  const targetApp = app && app !== PORTOS_APP_ID ? `**Target App**: ${app}` : '';
  const screenshots = renderFileListField(
    'Screenshots', task.metadata?.screenshots,
    (s) => `\`${resolveTaskFileRef(s)}\``, (s) => resolveTaskFileRef(s), screenshotsAsList
  );
  const label = (f) => (f?.originalName || f?.filename || f?.path || '').toString();
  const path = (f) => resolveTaskFileRef((f?.path || '').toString());
  const attachments = renderFileListField(
    'Attachments', task.metadata?.attachments,
    (f) => `\`${path(f)}\` (${label(f)})`, (f) => `${label(f)} (${path(f)})`, screenshotsAsList
  );
  return { description, targetApp, screenshots, attachments };
}

// Map for API-relative upload URLs → the on-disk root the agent should read.
const TASK_REF_ROOTS = {
  '/api/screenshots/': PATHS.screenshots,
  '/api/attachments/': PATHS.cosAttachments,
  '/api/uploads/': PATHS.uploads,
};

/**
 * Resolve a stored screenshot/attachment reference to an absolute filesystem
 * path the CoS agent can open with its filesystem tools.
 *
 * Uploads now return API-relative URLs (`/api/screenshots/<file>`) instead of
 * absolute paths (issue #2518 — absolute paths leaked the install layout in the
 * HTTP response), so tasks created after that change store the relative URL.
 * Convert those back to an absolute path here, at prompt-build time, where the
 * absolute path is local-only and never persisted or published. Legacy tasks
 * that stored an absolute path (or any non-`/api/` value) are passed through
 * unchanged so existing queues keep rendering the same path.
 */
function resolveTaskFileRef(ref) {
  if (typeof ref !== 'string' || !ref) return ref;
  for (const [prefix, root] of Object.entries(TASK_REF_ROOTS)) {
    if (ref.startsWith(prefix)) {
      return join(root, basename(decodeURIComponent(ref)));
    }
  }
  return ref;
}

/**
 * Undo the COS-TASKS.md round-trip split before rendering. The queue path in
 * `cosTaskGenerator.js` persists a generated multi-line prompt by moving the
 * full body into `metadata.context` and keeping only its first line as
 * `description`, so the markdown stays one-line-per-task. Coming back out,
 * `context` therefore *leads with a verbatim copy* of `description` — and every
 * render path emits both (the task block, then the full body again under a
 * `### Context` header). For a swarm task that surfaces as the reported
 * double `# ⚡ SWARM MODE …` header; the same duplication hits any other
 * generated/scheduled/system task that round-trips through the queue.
 *
 * When the split signature is present (`context` is a string whose first
 * non-empty line equals `description`), fold `context` back into `description`
 * and drop the redundant `metadata.context` so the prompt renders once, as one
 * clean body with no spurious header. A genuinely-separate user-supplied
 * `context` (first line differs from `description`) is left untouched.
 *
 * Pure and idempotent: returns the same task when nothing matched, otherwise a
 * shallow clone (never mutates the caller's task, so the stored task keeps its
 * one-line `description` for the task-list UI).
 */
export function reconcileSplitContext(task) {
  const context = task?.metadata?.context;
  if (typeof context !== 'string' || typeof task.description !== 'string') return task;
  // Mirror firstLine() in cosTaskStore.js: first non-empty, trimmed line.
  const firstNonEmpty = context.split('\n').map(l => l.trim()).find(Boolean) || '';
  if (firstNonEmpty !== task.description.trim()) return task;
  const { context: _dropped, ...restMeta } = task.metadata;
  return { ...task, description: context, metadata: restMeta };
}

/**
 * Fold a slashdo-backed task's invocation + procedure into its description (#3089).
 *
 * A task that names a bundled workflow persists only the BARE command
 * (`metadata.slashdoCommand`) because the form's provider select defaults to
 * "Auto" — the concrete shape (`/do:x`, `/do-x`, or an Agent Skill selected by
 * name) is only knowable here, once the scheduler has picked a provider.
 *
 * The command body travels with the prompt for every provider, not just the
 * skill-style ones: PortOS ships slashdo as a submodule and only surfaces it as
 * slash commands via the repo-local `.claude/commands/do/` symlinks, which don't
 * exist in the managed-app workspaces most CoS tasks run in.
 *
 * **Size control (#3110).** Expanded bodies run 38KB–317KB. Two independent
 * reductions apply, in this order:
 *
 * 1. **Prune unreachable reviewer variants.** `review`/`better`/`pr` each paste
 *    all five of slashdo's reviewer loops though one run drives one of them.
 *    Pruning to a single CLI reviewer measured -23% on `review` (258,260 →
 *    198,997 chars), -27% on `pr`, and -28% on `depfree`. (slashdo's
 *    orchestration wrapper is never pruned — it dispatches even a single-entry
 *    reviewer list — which is ~37KB of the theoretical ceiling.)
 * 2. **Point at a resolved copy on disk when still over budget** — but only for a
 *    host with file tools (`cli`/`tui`; an HTTP `api` provider has none and
 *    inlines with a warning). On its own this is roughly token-NEUTRAL for an
 *    agent that reads the whole procedure; it pays off when the host can invoke
 *    slashdo natively or needs only part of the body.
 *
 * Pruning is only sound if the run then uses the reviewers we pruned FOR, so the
 * section emits an explicit `--review-with` pin alongside a pruned body —
 * otherwise the agent could resolve a different reviewer from slashdo's own saved
 * defaults and find that loop missing. No explicit pin ⇒ no prune.
 *
 * The reviewers, usernames, and optional-reviewers are resolved through the SAME
 * three helpers as the inline `/do:pr` completion path further down
 * (`normalizeReviewers` / `resolveReviewUsernames` / `resolveOptionalReviewers`),
 * so what we prune for is exactly what the rest of the prompt resolves — legacy
 * single-`reviewer` tasks and defaults-inherited `optionalReviewers` included.
 *
 * The one case that does NOT authorize pruning is a resolved lone `copilot` that
 * nothing named explicitly (no task pin, no username reviewers, not marked
 * optional): `pickCodeReviewDefaults` and `normalizeReviewers` both fall back to
 * `['copilot']`, so that value can't be told apart from an unconfigured install —
 * and pinning `--review-with copilot` where Copilot review isn't enabled is the
 * #2507 stall. This mirrors `buildReviewWithArgs`'s lone-default suppression,
 * including its exemption for an explicitly-optional copilot.
 *
 * Applied to the description (on a COPY — the stored task is untouched) rather
 * than emitted as its own template slot, because the briefing template renders
 * `{{task.description}}`: a new `{{slashdoSection}}` placeholder would be
 * silently dropped by every install whose customized template predates it.
 *
 * @returns {Promise<Object>} the task, or a copy carrying the invocation
 */
async function applySlashdoInvocation(task, {
  providerId = null, providerCommand = null, leanMode = false, hasFileTools = false,
  defaultReviewers = null, codeReviewDefaults = null,
} = {}) {
  const command = task.metadata?.slashdoCommand;
  const resolved = resolveSlashdoInvocation({
    command,
    args: task.metadata?.slashdoArgs || '',
    providerId,
    providerCommand,
    leanMode,
  });
  if (!resolved) return task;

  // Resolved through the SAME three helpers the inline `/do:pr` completion path
  // uses below (`taskReviewers` / `taskReviewerUsernames` / `taskOptionalReviewers`),
  // so the reviewers we prune for are exactly the ones the rest of the prompt
  // resolves. Hand-rolling `metadata.reviewers` here instead dropped the legacy
  // single `reviewer` string and the defaults' `optionalReviewers` — pruning for
  // one reviewer while the run resolved another, and pinning an optional reviewer
  // as blocking.
  const {
    reviewers: resolvedReviewers,
    usernames: resolvedUsernames,
    optionalReviewers: resolvedOptional,
    reviewerMaxRounds: resolvedMaxRounds,
    reviewerModels: resolvedModels,
    reviewerEfforts: resolvedEfforts
  } = resolveReviewerConfig(task.metadata, codeReviewDefaults, defaultReviewers);

  // A resolved lone `copilot` with no usernames is ambiguous: it's what an
  // unconfigured install produces (`pickCodeReviewDefaults` and
  // `normalizeReviewers` both fall back to `['copilot']`), so it can't be told
  // apart from a real choice UNLESS something names it explicitly. Absent that,
  // treat it as unconfigured and prune nothing — pinning `--review-with copilot`
  // where Copilot review isn't enabled is the #2507 stall.
  //
  // Marking copilot OPTIONAL — or giving it a `~max=<n>` round cap — is such an
  // explicit naming: nothing defaults to either suffix, so both are deliberate
  // choices, and dropping one would silently turn a non-blocking review blocking
  // or spend an unbudgeted number of rounds. `buildReviewWithArgs` makes the same
  // exemption for its lone-default suppression — keep the two in step.
  const taskPinnedReviewer = (Array.isArray(task.metadata?.reviewers) && task.metadata.reviewers.length > 0)
    || (typeof task.metadata?.reviewer === 'string' && !!task.metadata.reviewer);
  const optionalDefaultReviewer = resolvedOptional.some(t => t.toLowerCase() === DEFAULT_REVIEWER);
  const cappedDefaultReviewer = Object.keys(resolvedMaxRounds)
    .some(t => t.toLowerCase() === DEFAULT_REVIEWER);
  const isBareDefault = resolvedReviewers.length === 1
    && resolvedReviewers[0] === DEFAULT_REVIEWER
    && !resolvedUsernames.length
    && !taskPinnedReviewer
    && !optionalDefaultReviewer
    && !cappedDefaultReviewer;
  const skipIncludes = isBareDefault
    ? []
    : unreachableReviewerIncludes({ reviewers: resolvedReviewers, usernames: resolvedUsernames });

  const body = await loadSlashdoFile(command, { stripFrontmatter: true, skipIncludes }).catch(() => null);
  if (!body) console.log(`⚠️ Slashdo command body unavailable, sending invocation only: ${command}`);
  const overBudget = !!body && body.length > SLASHDO_INLINE_BUDGET_CHARS;
  // An HTTP `api` provider can't read a file, so an over-budget body is pasted
  // whole. Surface the cost rather than paying it silently.
  if (overBudget && !hasFileTools) {
    console.warn(`⚠️ Inlining ${Math.round(body.length / 1000)}KB slashdo body for API provider (no file tools): ${command}`);
  }
  // Only spend the write when the pointer will actually be used.
  const bodyPath = (overBudget && hasFileTools)
    ? await writeResolvedSlashdoBody(command, body, { skipIncludes }).catch((err) => {
        console.warn(`⚠️ Could not stage slashdo body for ${command}, inlining instead: ${err.message}`);
        return null;
      })
    : null;

  const reviewWith = skipIncludes.length
    ? buildReviewersCsv(resolvedReviewers, resolvedUsernames, resolvedOptional, resolvedMaxRounds, resolvedModels)
    : '';
  // Unlike `reviewWith` this is NOT gated on pruning: the workflow drives its own
  // review loop, so a pinned effort has no other route to the reviewer CLI it
  // spawns — the `/do:pr` completion step further down the prompt is a different
  // invocation entirely, and for a slashdo-backed task usually isn't reached.
  const reviewerEffortNote = buildReviewerEffortNote(resolvedReviewers, resolvedEfforts);
  const section = buildSlashdoSection(resolved, body, { bodyPath, reviewWith, reviewerEffortNote });
  return { ...task, description: `${task.description}\n\n${section}` };
}

/**
 * True when a follow-up task is a **merge-only** run: it has a PR to land but no
 * reviewer to run (Review Loop off, or every configured reviewer was stripped —
 * e.g. copilot on a GitLab MR). Tolerates the string `'true'` because task
 * metadata round-trips through JSON/forms like every other CoS flag.
 *
 * Used both to pick the prompt section and to skip preloading the reviewer-only
 * slashdo bodies (`/do:rpr`, the local-agent review loop) that section ignores.
 */
function isMergeOnlyFollowUp(metadata = {}) {
  return metadata?.reviewLoopMergeOnly === true || metadata?.reviewLoopMergeOnly === 'true';
}

/**
 * Build the **review-loop follow-up** section — the instructions for the
 * agent spawned by `spawnReviewLoopFollowUp` to drive Copilot's review-and-fix
 * loop until the PR merges. Same 7-step procedure, same merge command, same
 * MERGED-state verification, same 10-iteration cap in BOTH the light and full
 * paths — extracted so the two can't drift independently.
 *
 * I/O (the slashdo `/do:rpr` body) is intentionally pulled outside this helper
 * and threaded in via `rprBody` so the function stays pure and synchronous.
 *
 * @param {Object} metadata - task.metadata (reviewLoopPR* fields, sourceTaskId)
 * @param {Object} [opts]
 * @param {boolean} [opts.verbose=false] - When true, emit the verbose prose
 *   variant the full (api) path uses, with PR Details list and an inlined
 *   `/do:rpr` reference. When false, emit the compact list the light path uses.
 * @param {string|null} [opts.rprBody=null] - The loaded `/do:rpr` slashdo body.
 *   Only appended in verbose mode; ignored in compact mode.
 * @param {string|null} [opts.localAgentLoopBody=null] - The loaded slashdo
 *   `lib/local-agent-review-loop.md` body (conditionals resolved to the
 *   subprocess/`else` branch). Inlined when a spawnable CLI reviewer
 *   (codex/antigravity/claude/grok) is in the list so the agent gets the exact
 *   headless invocation and review-only contract instead of improvising it.
 * @returns {string}
 */
export function buildReviewLoopFollowUpSection(metadata = {}, { verbose = false, rprBody = null, localAgentLoopBody = null } = {}) {
  const prUrl = metadata.reviewLoopPRUrl || '';
  const prBranch = metadata.reviewLoopPRBranch || '';
  const prNumber = metadata.reviewLoopPRNumber ?? '';
  const prOwner = metadata.reviewLoopPROwner ?? '';
  const prRepo = metadata.reviewLoopPRRepo ?? '';
  const sourceTaskId = metadata.sourceTaskId || 'unknown';
  // Merge-only follow-up (Review Loop off): no reviewer to wait on or invoke —
  // the whole job is CI-gate → fix → merge. Branch before any reviewer defaulting
  // below, which would otherwise resolve the empty list back to `[copilot]`.
  if (isMergeOnlyFollowUp(metadata)) {
    return buildMergeFollowUpSection({
      prUrl, prBranch, prNumber, prOwner, prRepo, sourceTaskId, verbose,
      prHost: metadata.reviewLoopPRHost ?? '',
    });
  }
  // Arbitrary GitHub reviewer usernames (gate-only PR reviewers), appended to
  // the review flow after the keyed reviewers.
  const usernames = normalizeReviewUsernames(metadata.reviewLoopReviewerUsernames);
  // Ordered keyed reviewer list (back-compat: legacy single `reviewLoopReviewer`).
  // `reviewLoopReviewers` from spawnReviewLoopFollowUp is authoritative (copilot
  // already stripped on non-GitHub forges); resolveKeyedReviewers keeps an
  // explicit empty list empty when usernames carry the review (username-only).
  const reviewerSource = Array.isArray(metadata.reviewLoopReviewers)
    ? metadata.reviewLoopReviewers
    : (metadata.reviewLoopReviewer ? [metadata.reviewLoopReviewer] : undefined);
  const reviewers = resolveKeyedReviewers(reviewerSource, usernames.length > 0);
  // Reviewer identities marked non-blocking — emitted with slashdo's `~opt`.
  const optionalReviewers = normalizeOptionalReviewers(metadata.reviewLoopOptionalReviewers) || [];
  // Per-reviewer `~max=<n>` iteration caps, keyed by emitted token. An absent key
  // leaves slashdo's built-in per-loop default; `0` means "loop until clean".
  const reviewerMaxRounds = normalizeReviewerMaxRounds(metadata.reviewLoopReviewerMaxRounds) || {};
  const stopMode = metadata.reviewLoopStopMode || DEFAULT_REVIEW_STOP_MODE;
  const reviewerApplies = metadata.reviewLoopReviewerApplies === true;
  const hasCopilot = reviewers.includes(DEFAULT_REVIEWER);
  const hasLocalLlm = reviewers.some(r => LOCAL_LLM_REVIEWERS.includes(r));
  // Spawnable-CLI reviewers, in configured order.
  const cliReviewers = reviewers.filter(isCliReviewer);
  const hasCli = cliReviewers.length > 0;
  const hasGithubUser = usernames.length > 0;
  // Optional per-reviewer model pins (Code Review Defaults panel, or the task's own
  // ReviewerPicker row), threaded as a reviewer-keyed map. A model-capable CLI
  // reviewer in this loop's list gets a `<reviewer> --model <id>` note; a local-LLM
  // reviewer's pin goes into its `/api/code-review/local` request body instead
  // (below). Absent = let that reviewer use its own default. For an Ollama-backed
  // `claude` reviewer the id is the local Ollama model. Falls back to the legacy
  // codex-scalar metadata key so a follow-up task persisted by an older install
  // still threads its codex model.
  const reviewerModelMap = (metadata.reviewLoopReviewerModels && typeof metadata.reviewLoopReviewerModels === 'object')
    ? metadata.reviewLoopReviewerModels
    : (typeof metadata.reviewLoopCodexModel === 'string' && metadata.reviewLoopCodexModel
        ? { codex: metadata.reviewLoopCodexModel }
        : {});
  // Optional per-reviewer reasoning-effort pins, same two sources as the models.
  // A CLI reviewer's effort becomes a flag on the command line the agent runs
  // (`--effort high` for claude/agy, `-c model_reasoning_effort=high` for codex —
  // `reviewerEffortArgs` owns that shape); a local-LLM reviewer's becomes the
  // `reasoning_effort` field of its `/api/code-review/local` body (below). There is
  // no slashdo `--review-with` suffix for effort, which is why it rides the
  // invocation rather than `equivArgs`.
  const reviewerEffortMap = (metadata.reviewLoopReviewerEfforts && typeof metadata.reviewLoopReviewerEfforts === 'object')
    ? metadata.reviewLoopReviewerEfforts
    : {};
  // One entry per CLI reviewer carrying a pinned model and/or effort, rendered as
  // the literal command line the agent must run. Reviewers are listed rather than
  // filtered to MODEL_CAPABLE_CLI_REVIEWERS up front because a CLI reviewer may
  // carry only one of the two pins (and `grok` carries neither). The per-flag
  // gates below decide what each entry renders; an entry with no flags drops out.
  const reviewerPinEntries = cliReviewers
    .map((r) => {
      const flags = [];
      // Thread each configured model id VERBATIM. We deliberately don't env-map it
      // here (e.g. bare Claude tier → Bedrock form): this is a text-template layer
      // with only a providerId, not the merged spawn env (process.env + settings.json
      // + provider.envVars) the CLI argv builder normalizes against — and the nested
      // reviewer CLI is spawned by the agent, not PortOS, so the argv chokepoint never
      // runs. The Code Review Defaults model field is free-text for exactly this
      // reason: the user configures the id their environment needs (a Bedrock-form id
      // on a Bedrock box, an installed Ollama model for an Ollama-backed `claude`).
      if (MODEL_CAPABLE_CLI_REVIEWERS.includes(r) && typeof reviewerModelMap[r] === 'string' && reviewerModelMap[r]) {
        flags.push(`--model ${reviewerModelMap[r]}`);
      }
      const effortArgs = reviewerEffortArgs(r, reviewerEffortMap[r]);
      if (effortArgs.length) flags.push(effortArgs.join(' '));
      // Binary, not slug: this renders a literal command line, and the
      // `antigravity` slug names no executable.
      return flags.length ? `\`${reviewerCliBinary(r) || r} ${flags.join(' ')} …\`` : null;
    })
    .filter(Boolean);
  const reviewerPinNote = reviewerPinEntries.length
    ? ` When invoking a reviewer with a pinned model or reasoning effort, pass it: ${reviewerPinEntries.join(', ')}.`
    : '';
  // When the slashdo local-agent review loop is inlined below (a spawnable CLI
  // reviewer is in the list), point the invocation step at it so the agent runs
  // the exact headless recipe instead of probing the CLI's flags / hand-rolling
  // an invocation — the failure mode that had a codex CoS agent burn a dozen
  // exploratory `claude --help` / `claude -p 'hello'` / `--tools ''` probes
  // before it stumbled into a working review call.
  const cliProcedurePointer = (hasCli && localAgentLoopBody)
    ? ' Follow the **CLI Reviewer Procedure** section below for the exact headless invocation and review-only contract — do NOT probe the CLI or guess flags.'
    : '';
  // Each configured CLI reviewer paired with the command the agent must actually
  // run. Resolved ONCE — the slug-vs-binary distinction is the whole point of
  // this block, so every string below reads it from here rather than restating
  // the `|| slug` fallback. Unmapped slug ⇒ falls back to itself.
  const cliBinaries = cliReviewers.map(slug => ({ slug, binary: reviewerCliBinary(slug) || slug }));
  // `**codex / agy / claude**` — the CLI reviewers THIS loop configured, named by
  // the binary. Previously a fixed "codex / antigravity / claude / grok" string,
  // which both listed reviewers that weren't configured and named `antigravity`,
  // a command that exists on no PATH.
  const cliReviewerHeading = cliBinaries.map(c => c.binary).join(' / ');
  // Spell out slug → binary for any reviewer whose command differs from its
  // slug, so the agent can reconcile the configured list / `--review-with` token
  // with the executable named in the invocation table.
  const cliBinaryAliases = cliBinaries
    .filter(c => c.binary !== c.slug)
    .map(c => `the \`${c.slug}\` reviewer runs the \`${c.binary}\` binary (there is no \`${c.slug}\` command)`);
  const cliBinaryNote = cliBinaryAliases.length
    ? ` Reviewer slug → command: ${cliBinaryAliases.join('; ')}.`
    : '';
  // A configured reviewer that cannot run is NOT a clean review. Without this,
  // an agent whose reviewer binary was missing self-reviewed and merged anyway
  // — the exact regression this note blocks.
  const missingCliNote = hasCli
    ? `**Missing reviewer CLI:** verify each reviewer's binary is on PATH (${cliBinaries.map(c => `\`command -v ${c.binary}\``).join(' / ')}) before concluding it is unavailable. If a configured reviewer's binary genuinely is not installed, that reviewer is UNSATISFIED — do NOT substitute your own self-review and do NOT merge. Post a PR comment naming the missing command and exit.`
    : '';
  // "multi" reflects the TOTAL number of review sources (keyed reviewers +
  // username reviewers) so the ordered per-reviewer loop wording kicks in as
  // soon as there's more than one thing to satisfy.
  const multi = (reviewers.length + usernames.length) > 1;
  // The system pre-requests the initial Copilot review only when copilot LEADS the
  // order; otherwise the agent must request it at copilot's turn (so Copilot reviews
  // the post-CLI-fix state, not a stale diff).
  const copilotIsFirst = reviewers[0] === DEFAULT_REVIEWER;
  const reviewerLabel = [
    ...reviewers.map(r => `\`${r}\``),
    ...usernames.map(u => `\`@${u}\``),
  ].join(' → ');
  const equivArgs = buildReviewWithArgs(reviewers, { stopMode, reviewerApplies, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels: reviewerModelMap });
  const equiv = equivArgs ? ` (equivalent to \`/do:pr ${equivArgs}\`)` : '';

  // First step: how to obtain a review. For a single copilot/CLI reviewer keep the
  // focused wording; for a list, dispatch each reviewer in order. Only emit the
  // per-reviewer-kind bullet that actually applies to the configured list.
  // `lmstudio`/`ollama` don't have CLIs the agent can spawn — PortOS exposes
  // `POST /api/code-review/local` which runs the configured local model against
  // the diff and returns findings text. The agent always reaches it via
  // `http://localhost:5555` (the canonical loopback API port).
  // A pinned local-LLM model can't ride the endpoint's server-side default: that
  // reads the GLOBAL settings scalar and has never seen this task. So when the
  // user pinned one on the reviewer's row, name it in the request body — `model`
  // in the POST body overrides the configured default (see routes/codeReview.js).
  // Absent pin ⇒ omit the key entirely rather than sending `""`, which would be a
  // model id the backend can't resolve.
  // The pinned reasoning effort rides the same body as `effort` — the endpoint
  // forwards it as the backend's OpenAI-compatible `reasoning_effort`. Same
  // absent-vs-empty contract as the model: no pin ⇒ the key is omitted, not blank.
  // Which body keys this run actually pins, accumulated across the local-LLM
  // reviewers in the list. The jq example below is built from THIS set rather than
  // naming both keys unconditionally: an effort-only run that was shown a
  // `model: "…"` placeholder would have the agent send the literal ellipsis, and
  // the route's `body.model || configured` prefers that truthy junk over the
  // install default — turning a pinned-effort review into a model-not-found error.
  const pinnedString = (map, r) => (typeof map[r] === 'string' && map[r] ? map[r] : null);
  const localLlmPins = LOCAL_LLM_REVIEWERS
    .filter(r => reviewers.includes(r))
    .map(r => ({ reviewer: r, model: pinnedString(reviewerModelMap, r), effort: pinnedString(reviewerEffortMap, r) }))
    .filter(p => p.model || p.effort);
  const localLlmPinNote = localLlmPins.map(({ reviewer, model, effort }) => {
    const keys = [
      ...(model ? [`"model": "${model}"`] : []),
      ...(effort ? [`"effort": "${effort}"`] : [])
    ];
    return `\`${reviewer}\` → \`${keys.join(', ')}\``;
  });
  // Both strings derive from the same `localLlmPins` array rather than the jq line
  // reading a Set the note's `.map` filled as a side effect — that coupling meant
  // hoisting one line above the other silently emptied the key list.
  const localLlmPinJq = [
    'backend: "…"',
    ...(localLlmPins.some(p => p.model) ? ['model: "…"'] : []),
    ...(localLlmPins.some(p => p.effort) ? ['effort: "…"'] : []),
    'diff: .'
  ].join(', ');
  const localLlmInvocation = `POST the diff to PortOS's local reviewer endpoint and extract its review text before evaluating it. Substitute the active reviewer name for \`<lmstudio|ollama>\`:
\`\`\`bash
REVIEW_RESPONSE=$(mktemp)
gh pr diff ${prNumber || '<PR_NUMBER>'} | jq -Rs '{ backend: "<lmstudio|ollama>", diff: . }' | curl -sS -X POST http://localhost:5555/api/code-review/local -H 'Content-Type: application/json' -d @- > "$REVIEW_RESPONSE"
if ! jq -er '.findings | select(type == "string" and length > 0)' "$REVIEW_RESPONSE" > "\${REVIEW_RESPONSE}.findings"; then
  echo "Local reviewer failed: $(jq -r '.error // "missing .findings in reviewer response"' "$REVIEW_RESPONSE")" >&2
  STATUS=cli-error # Never treat an absent or malformed response as clean.
  exit 1
else
  cat "\${REVIEW_RESPONSE}.findings"
fi
\`\`\`
Only a successfully extracted \`.findings\` value is the review text; treat it like any other reviewer's findings.${localLlmPinNote.length
  ? ` This run pins settings for ${localLlmPinNote.join(', ')} — add those keys to the JSON body (\`jq -Rs '{ ${localLlmPinJq} }'\`) so the review runs with them instead of the install defaults. Send ONLY the keys named above; a key with no pinned value overrides the install default with junk.`
  : ''}`;
  // Instruct the agent to request each username reviewer as a PR reviewer and
  // gate the merge on their approval. `gh pr edit --add-reviewer` takes the bare
  // login, so strip the `@`.
  const githubUsersInvocation = `request ${usernames.map(u => `\`@${u}\``).join(', ')} as PR reviewer${usernames.length > 1 ? 's' : ''} (\`gh pr edit ${prNumber || '<PR_NUMBER>'} --add-reviewer <user>\`, drop the \`@\`), then wait for their review (poll every 5–15s) and address any findings; their approval gates the merge.`;
  const multiBullets = [
    hasCopilot ? `**copilot**: ${copilotIsFirst
      ? 'wait for the initial Copilot review the system already pre-requested (Copilot leads the list)'
      : 'request a Copilot review when you reach its turn'} (poll every 5–15s, max 5 min/round), then re-request on later rounds.` : null,
    hasCli ? `**${cliReviewerHeading}**: invoke that CLI to review this branch's diff against its base (use the CLI's own base-diff mode or \`git diff <base-branch>...HEAD\`; on GitHub \`gh pr diff ${prNumber || ''}\` also works).${cliBinaryNote}${reviewerPinNote}${cliProcedurePointer}` : null,
    hasLocalLlm ? `**lmstudio / ollama**: ${localLlmInvocation}` : null,
    hasGithubUser ? `**@github reviewers**: ${githubUsersInvocation}` : null,
  ].filter(Boolean).join(' ');
  // Name the BINARY, not the slug: `Invoke the \`antigravity\` CLI` sent a
  // follow-up agent hunting for a command that does not exist.
  const singleCliInvocation = `Invoke ${describeReviewerCli(cliReviewers[0])} to review this branch's diff against its base (use the CLI's own base-diff mode or \`git diff <base-branch>...HEAD\`; on GitHub \`gh pr diff ${prNumber || ''}\` also works). Capture its findings as concrete issues to address.${reviewerPinNote}${cliProcedurePointer}`;
  // Resolved sequentially so a future reviewer kind only adds one branch
  // instead of deepening the nested ternary.
  let waitOrInvokeStep;
  if (multi) waitOrInvokeStep = `For EACH reviewer in order — ${reviewerLabel} — run a full review-and-fix sub-loop before advancing to the next. ${multiBullets}`;
  else if (hasCopilot) waitOrInvokeStep = 'Wait for the latest Copilot review to complete (poll every 5–15s, max 5 minutes per round); the system already requested the initial review.';
  else if (hasLocalLlm) waitOrInvokeStep = localLlmInvocation;
  else if (hasCli) waitOrInvokeStep = singleCliInvocation;
  else waitOrInvokeStep = `To obtain a review, ${githubUsersInvocation}`;

  const stopModeNote = stopMode === 'on-findings'
    ? '**Stop mode (on-findings):** stop after the FIRST reviewer whose findings you actually fixed and committed; skip the remaining reviewers.'
    : stopMode === 'on-clean'
      ? '**Stop mode (on-clean):** stop after the FIRST reviewer that reports zero findings; skip the remaining reviewers.'
      : (multi ? '**Stop mode (all):** run every reviewer in the list, in order, before merging.' : '');

  const applyNote = hasCli
    ? (reviewerApplies
        ? '**Reviewer applies:** let each CLI reviewer apply its own fixes to the working tree, then verify, run tests, and push.'
        : "**Reviewer applies (off):** read each CLI reviewer's findings and apply the fixes yourself (default).")
    : '';

  const initialReviewState = (hasCopilot && copilotIsFirst)
    ? 'The system has already requested the initial Copilot code review (Copilot leads the order).'
    : hasCopilot
      ? 'Copilot is configured after another reviewer, so the system did NOT pre-request it — request the Copilot review yourself when you reach its turn (after the earlier reviewers’ fixes are pushed), and invoke the other reviewers yourself.'
      : 'The system did NOT pre-request a reviewer because no Copilot review leads the order — you must request/invoke each configured reviewer yourself against the PR diff.';
  const repeatedCommentsNote = '**Repeated comments:** If a fresh review round only re-raises feedback you intentionally rejected (with a reply explaining why), treat that round as clean and move on.';
  // Challenge protocol (#2471): auto-invoke the bounded worker↔reviewer dispute
  // from the review loop. When a reviewer's BLOCKING finding is a false positive,
  // the agent disputes it once via POST /challenge instead of silently complying
  // or accepting a false block, then RE-CHECKS (re-run reviewer) to overturn or
  // escalate. One challenge per task, also bounded by the task's retry budget —
  // a second dispute or an out-of-retries task returns 409.
  const challengeProtocolNote = [
    '**Challenge protocol (dispute a wrong rejection — use sparingly):** If a reviewer raises a BLOCKING finding you have strong, specific evidence is a false positive (it misread the diff, flagged intended behavior, or contradicts a documented repo convention), do NOT silently "fix" it or accept a false block — dispute it **exactly once** for this task:',
    '```bash',
    `curl -sS -X POST http://localhost:5555/api/cos/tasks/${sourceTaskId}/challenge -H 'Content-Type: application/json' -d '{"reason":"<why the finding is wrong>","evidence":"<file:line or diff quote>","reviewer":"<disputed reviewer>"}'`,
    '```',
    'A `409` (`CHALLENGE_EXHAUSTED` = the one challenge is spent, or `CHALLENGE_BUDGET_EXHAUSTED` = the task is out of retry budget) means you can\'t dispute — then fix the finding or, if genuinely blocked, post a PR comment and stop. After filing, RE-CHECK: re-run the disputed reviewer (or another configured reviewer) against the current diff, then resolve — overturned → `POST .../challenge/resolve` with `{"outcome":"upheld"}` and continue to merge; confirmed → fix it, or send `{"outcome":"escalated"}` to hand the dispute to the user.' + (hasLocalLlm ? ' For a local reviewer you may instead POST `{"recheck":{"backend":"<lmstudio|ollama>","diff":"<unified diff>"}}` and let the server re-run it and auto-derive the outcome.' : ''),
  ].join('\n');
  // Per-reviewer round caps. This prompt drives the loop in PROSE (it isn't
  // slashdo parsing a `~max=<n>` suffix), so a configured cap only binds if it's
  // spelled out here — the `equiv` flag string alone documents intent without
  // constraining the agent. `0` is slashdo's "loop until clean", so it's rendered
  // as such rather than as a zero-round budget.
  const maxRoundsEntries = Object.entries(reviewerMaxRounds)
    .filter(([token]) => reviewers.includes(token) || usernames.some(u => `@${u}`.toLowerCase() === token.toLowerCase()))
    .map(([token, max]) => `\`${token}\` → ${max === 0 ? 'loop until clean (no cap)' : `${max} round${max === 1 ? '' : 's'}`}`);
  const maxRoundsNote = maxRoundsEntries.length
    ? `**Round caps (~max):** stop these reviewers after their budget even if findings remain, then advance: ${maxRoundsEntries.join(', ')}. Spending a configured budget is a SUCCESS, not a failure — do not block the merge on it. Reviewers not listed keep the default cap below.`
    : '';

  const extraNotes = [stopModeNote, applyNote, maxRoundsNote, missingCliNote].filter(Boolean);

  // Inline slashdo's local-agent review loop verbatim when a spawnable CLI
  // reviewer is configured. This is the maintained, precise recipe — exact
  // per-CLI headless invocation (`claude -p "$LOCAL_PROMPT" --dangerously-skip-permissions`,
  // `codex --sandbox read-only review --base …`, etc.), the review-only /
  // no-sub-agent-fan-out `$LOCAL_PROMPT` contract, and the parse-and-apply
  // handling. Without it the agent only sees "invoke that CLI" and reverse-
  // engineers the invocation, wasting calls. The inlined body AGREES with
  // cliBinaryNote rather than contradicting the "follow it verbatim" order —
  // slashdo's per-CLI invocation table names `agy` and normalizes the
  // `gemini`/`antigravity` slugs onto it, so the note is a pointer into that
  // table, not a correction layered over it. Conditionals were resolved to the
  // subprocess (`else`) branch by loadSlashdoLib, so no in-process-Agent-tool
  // branch leaks in to confuse a non-Claude-Code host.
  const cliReviewerProcedure = (hasCli && localAgentLoopBody)
    ? `\n### CLI Reviewer Procedure (${cliReviewerHeading})\n\nDrive each spawnable CLI reviewer EXACTLY as the slashdo local-agent review loop below specifies — use its per-CLI invocation and review-only prompt contract verbatim; do NOT probe the CLI's \`--help\`, test it with throwaway prompts, or hand-roll flags. Run the reviewer once per round, capture its findings, and (unless reviewer-applies is set) apply the fixes yourself.\n\n${localAgentLoopBody}\n`
    : '';

  // A JIRA-tracked PR is a human's to land (its ticket is already "In Review" and
  // nothing here can transition it), so this follow-up reviews and stops. Emitted
  // as the same steps 4-6 so the loop body above stays identical either way.
  const leaveOpen = metadata.reviewLoopLeaveOpen === true || metadata.reviewLoopLeaveOpen === 'true';
  const objective = leaveOpen
    ? '**Your job is to drive the review-and-fix loop to completion. Do NOT merge — this PR is tracked in JIRA and a human lands it.**'
    : '**Your job is to drive the review-and-fix loop to completion and merge the PR.**';
  const closingSteps = leaveOpen
    ? [
      '4. When the reviewer list is exhausted (or the stop mode triggers), **leave the PR open** — do NOT merge it, and do NOT delete the branch. Its JIRA ticket is sitting in review and a human lands both together; merging here would leave the work merged and the ticket stuck in review.',
      // Forge-aware: `gh pr comment` fails outright on a GitLab MR URL.
      `5. Post a short comment on the ${detectForgeCli(metadata.reviewLoopPRHost) === 'glab' ? 'MR' : 'PR'} summarising what the reviewers raised and what you fixed, so the human landing it knows the state: ${detectForgeCli(metadata.reviewLoopPRHost) === 'glab' ? `\`glab mr note ${prNumber !== '' ? prNumber : '<MR_NUMBER>'} --message "<summary>"\`` : `\`gh pr comment "${prUrl}" --body "<summary>"\``}.`,
      '6. Exit. Do **not** run `/do:push` or open a new PR. The system will clean up your worktree on exit.',
    ]
    : [
      `4. When the reviewer list is exhausted (or the stop mode triggers), merge the PR **immediately** with this exact command (flags: \`--merge --delete-branch\`, nothing else — a true merge commit keeps the branch tip in main's history so automated worktree cleanup can prove the branch is merged):`,
      '   ```bash',
      `   gh pr merge "${prUrl}" --merge --delete-branch`,
      '   ```',
      prOwner && prRepo && prNumber ? `   (Equivalent: \`gh pr merge ${prNumber} --repo ${prOwner}/${prRepo} --merge --delete-branch\`.)` : null,
      '   You have already verified the review is clean, so force the immediate merge. Adding any merge-deferral flag would leave the PR open after you exit.',
      `5. Confirm the PR is actually merged before exiting: \`gh pr view "${prUrl}" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (a check is failing, a thread is still unresolved, or branch protection is blocking) — fix and retry the merge. Do NOT exit until state is \`MERGED\`.`,
      '6. Exit. Do **not** run `/do:push` or open a new PR — the merge handles everything. The system will clean up your worktree on exit.',
    ].filter(Boolean);

  if (verbose) {
    return `
## Review-Loop Follow-up (PRIMARY OBJECTIVE)
A previous agent finished implementing the work for source task **${sourceTaskId}** and opened **PR ${prUrl}** on branch \`${prBranch}\`. ${initialReviewState} ${objective}

**Reviewers (in order)**: ${reviewerLabel}${equiv}.
${extraNotes.length ? '\n' + extraNotes.join('\n') + '\n' : ''}
**Run this loop UNTIL all configured reviewers are satisfied (or the stop mode triggers), capped at 10 iterations per reviewer:**

1. ${waitOrInvokeStep}
2. If there are unresolved review findings, fix them in this worktree, run the project's tests, commit (\`feat:\`/\`fix:\` prefix, no Co-Authored-By), push, and (for Copilot) resolve the addressed threads.
3. Re-review with the same reviewer until it reports clean, then advance to the next reviewer in the list.
${closingSteps.join('\n')}

**Hard stop:** if a reviewer's loop hasn't converged after 10 iterations, post a PR comment summarising the unresolved blockers and exit. Do not loop indefinitely.

${repeatedCommentsNote}

${challengeProtocolNote}

PR Details:
- **URL**: ${prUrl}
- **Branch**: \`${prBranch}\`
${prNumber !== '' ? `- **Number**: ${prNumber}` : ''}
${prOwner && prRepo ? `- **Repo**: ${prOwner}/${prRepo}` : ''}
- **Source task**: ${sourceTaskId}
- **Reviewers**: ${reviewerLabel}
${cliReviewerProcedure}${(rprBody && (hasCopilot || hasGithubUser)) ? `\n### /do:rpr Reference — Copilot / @github reviewers (full procedure)\n\nThis is the PR-comment review loop for the **copilot** and **@github** reviewers only (request a review on the PR, poll for comments, resolve threads).${cliReviewerProcedure ? ' It does NOT apply to the local CLI reviewers — for those, follow the **CLI Reviewer Procedure** above instead.' : ''}\n\n${rprBody}\n` : ''}`;
  }

  // Compact light-path variant.
  return [
    '## Review-Loop Follow-up (PRIMARY OBJECTIVE)',
    `A previous agent finished task **${sourceTaskId}** and opened **PR ${prUrl}** on \`${prBranch}\`. ${initialReviewState} ${leaveOpen ? 'Drive the review-and-fix loop to completion — do NOT merge (JIRA-tracked; a human lands it).' : 'Drive the review-and-fix loop to completion and merge.'}`,
    `**Reviewers (in order)**: ${reviewerLabel}${equiv}.`,
    ...extraNotes,
    '',
    '**Loop UNTIL all reviewers are satisfied (or the stop mode triggers), capped at 10 iterations per reviewer:**',
    `1. ${waitOrInvokeStep}`,
    '2. If unresolved findings: fix in this worktree, run tests, commit (`feat:`/`fix:` prefix, no Co-Authored-By), push' + (hasCopilot ? ', and (for Copilot) resolve the addressed threads.' : '.'),
    '3. Re-review with the same reviewer until clean, then advance to the next reviewer in the list.',
    ...closingSteps,
    '',
    '**Hard stop:** if a reviewer is not converged after 10 rounds, post a PR comment summarising blockers and exit.',
    repeatedCommentsNote,
    '',
    challengeProtocolNote,
    cliReviewerProcedure
  ].filter(Boolean).join('\n');
}

/**
 * The step that replaces the merge steps when a PR is a human's to land — a
 * JIRA-tracked task whose ticket is already "In Review" (see
 * `lib/prDisposition.js`). Merging would land the work while the board still
 * shows it in review, and no completion path here can transition the ticket.
 */
const LEAVE_PR_OPEN_STEP = (step, jiraTracked = false) => `${step}. **Leave the PR open — do NOT merge it.** ${jiraTracked
  ? 'This task is tracked in JIRA: its ticket is in review and a human lands the PR and the ticket together.'
  : 'This task is configured to stop after opening the PR so a human can inspect and land it.'} Report the PR URL in your summary and stop.`;

/**
 * The CI-gated merge procedure, in numbered steps starting at `startStep`.
 *
 * This is the single definition of "no reviewer is configured, so CI is the
 * merge gate" — shared by every flow that reaches it: the agent's own completion
 * workflow (slashdo TUI + Claude Code CLI via `buildPostPRMergeSteps`) and the
 * merge follow-up agent PortOS spawns when it opened the PR itself. They differ
 * only in how the PR is addressed and whether GitLab commands are offered, so
 * those are parameters rather than hand-written copies that drift.
 *
 * Ends on the same merge command + MERGED verification as the review-loop
 * contract (`buildReviewLoopFollowUpSection`): a true merge commit keeps the
 * branch tip in the base branch's history, which is what lets automated worktree
 * cleanup prove the branch landed.
 *
 * @param {number} startStep - number of the first emitted step.
 * @param {Object} opts
 * @param {string} opts.prRef - how to address the PR in `gh` commands, already
 *   quoted: the `"<PR_URL>"` placeholder before the PR exists, or the real URL.
 * @param {string} [opts.mrRef] - how to address the MR in `glab` commands.
 *   **`glab mr merge` selects by MR IID or source branch — NOT by URL**, so this
 *   is the number (or a `<MR_NUMBER>` placeholder), never `prRef`.
 * @param {'github'|'gitlab'|'unknown'} [opts.forge] - which CLI to name. PortOS
 *   opens GitLab MRs too (`git.createPR` falls back to `glab`), so a follow-up
 *   whose PR host is a GitLab instance must not be handed `gh` commands it can't
 *   run. Callers derive this with `detectForgeCli` — a GitHub Enterprise host is
 *   `github`, not "not github.com". `unknown` (the agent's own completion
 *   workflow, which runs before the PR exists) emits both, commented.
 * @returns {{lines: string[], nextStep: number}}
 */
function buildCiMergeGateSteps(startStep, { prRef, mrRef = '<MR_NUMBER>', forge = 'github' }) {
  const gh = forge !== 'gitlab';
  const glab = forge !== 'github';
  const both = gh && glab;
  const checksCmd = gh
    ? `\`gh pr checks ${prRef} --watch --fail-fast --interval 30\`${glab ? ' (GitLab: `glab ci status`)' : ''}`
    : '`glab ci status`';
  const mergeableCmd = gh
    ? `\`gh pr view ${prRef} --json mergeable -q .mergeable\` reports \`CONFLICTING\`${glab ? ' (GitLab: `glab mr view ' + mrRef + '` shows a conflict)' : ''}`
    : `\`glab mr view ${mrRef}\` shows a conflict with the target branch`;
  const stateCmd = gh
    ? `\`gh pr view ${prRef} --json state -q .state\` must return \`MERGED\`${glab ? ' (GitLab: `glab mr view ' + mrRef + '` must show it merged)' : ''}`
    : `\`glab mr view ${mrRef}\` must show it merged`;
  const lines = [
    `${startStep}. **Wait for CI to finish**: ${checksCmd}. "No checks reported" is AMBIGUOUS — a just-opened PR reports it while checks are still attaching, and merging on it races the CI this gate exists to wait for. Treat it as green ONLY when the repo genuinely has no CI (${gh ? '`gh workflow list` is empty / nothing in `.github/workflows` triggers on pull_request, and no external status check is configured' : 'no `.gitlab-ci.yml` and no pipeline is configured'}). If CI IS expected, wait 30s and re-check for up to 5 minutes — and if it still hasn't attached, **leave the PR open and say so**; never merge on checks that were expected but never appeared.`,
    `${startStep + 1}. **Clear whatever blocks the merge, then re-check.** If a check failed, read the failing job's log (${gh ? `\`gh run view --log-failed\`${glab ? ' on GitHub, `glab ci trace` on GitLab' : ''}` : '`glab ci trace`'}), fix the cause here, run the project's tests, commit (\`fix:\` prefix, no Co-Authored-By), push, and go back to the previous step — cap this at 5 rounds. If ${mergeableCmd}, \`git fetch origin\`, rebase onto the base branch, resolve the conflicts keeping BOTH sides' intent, re-run the tests, \`git push --force-with-lease\`, and re-check.`,
    `${startStep + 2}. **Merge** with exactly these flags, nothing else — a true merge commit keeps the branch tip in the base branch's history so automated worktree cleanup can prove the branch is merged, and any merge-deferral flag leaves the PR open after you exit. If it is already merged (a saved \`/do:pr\` default can merge it for you), skip to the next step:`,
    '   ```bash',
    gh ? `   ${both ? '# GitHub:  ' : ''}gh pr merge ${prRef} --merge --delete-branch` : null,
    // `glab mr merge` takes an MR IID or source branch — a URL is not accepted.
    glab ? `   ${both ? '# GitLab:  ' : ''}glab mr merge ${mrRef} --yes --remove-source-branch` : null,
    '   ```',
    // Not every repo allows merge commits; a repo restricted to squash/rebase
    // rejects `--merge` outright, which would leave the PR open forever.
    gh ? `   If that is rejected because this repo disallows merge commits, re-check what it allows (\`gh repo view --json mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed\`) and merge with an allowed method instead — \`--squash\` first, else \`--rebase\` — keeping \`--delete-branch\`.` : null,
    `${startStep + 3}. **Confirm the merge before exiting**: ${stateCmd}. If it is still open or was closed unmerged, investigate (failing check, merge conflict, branch protection), fix, and retry. Leave it open — saying so explicitly in your completion summary — if CI stays red after a genuine fix attempt, a conflict needs a human decision, expected checks never attached, or a branch protection you cannot satisfy blocks the merge (a required approving review, a required check only a human can trigger). Hand those to a human rather than retrying until you time out.`,
  ].filter(Boolean);
  return { lines, nextStep: startStep + 4 };
}

/**
 * Build the **merge follow-up** section — the instructions for the agent
 * `spawnReviewLoopFollowUp` spawns when no reviewer survived resolution (Review
 * Loop off, or copilot-only on a non-GitHub forge). Nothing else will touch the
 * PR, so the merge gate is CI alone (`buildCiMergeGateSteps`).
 *
 * @param {Object} opts - PR coordinates + `verbose` (full/api path) vs compact.
 * @returns {string}
 */
function buildMergeFollowUpSection({ prUrl, prBranch, prNumber = '', prOwner = '', prRepo = '', prHost = '', sourceTaskId = 'unknown', verbose = false }) {
  // PortOS opens GitLab MRs via `glab` too, so a GitLab host must not be handed
  // `gh` commands (the host is persisted by spawnReviewLoopFollowUp). Classify
  // with the shared detector — a GitHub Enterprise host is still `gh`, which a
  // bare `host !== 'github.com'` test would get wrong.
  const gate = buildCiMergeGateSteps(1, {
    prRef: `"${prUrl}"`,
    mrRef: prNumber !== '' ? `${prNumber}` : '<MR_NUMBER>',
    forge: detectForgeCli(prHost) === 'glab' ? 'gitlab' : 'github',
  });
  const steps = [
    ...gate.lines,
    `${gate.nextStep}. Exit. Do NOT run \`/do:push\`, do NOT open a new PR, and do NOT start a code review — landing this PR is the whole job.`,
  ];
  const prDetails = verbose ? [
    '',
    'PR Details:',
    `- **URL**: ${prUrl}`,
    `- **Branch**: \`${prBranch}\``,
    prNumber !== '' ? `- **Number**: ${prNumber}` : null,
    prOwner && prRepo ? `- **Repo**: ${prOwner}/${prRepo}` : null,
    `- **Source task**: ${sourceTaskId}`,
  ].filter(Boolean) : [];

  return [
    '## Merge Follow-up (PRIMARY OBJECTIVE)',
    `A previous agent finished the work for source task **${sourceTaskId}** and opened **PR ${prUrl}** on \`${prBranch}\`. **No code review was requested for this task, so nothing else will merge this PR — your job is to land it once CI is green.**`,
    '',
    ...steps,
    '',
    '**Hard stop:** if CI is still red after 5 fix rounds, or a conflict needs a product decision you can\'t make, post a PR comment summarising exactly what is blocking the merge and exit with the PR left open. Do not force a merge over red CI.',
    ...prDetails,
  ].join('\n');
}

/**
 * Build the single "## Guidelines" completion-handoff bullet for the full
 * (api) prompt path. Mirrors the helper pattern the light path already uses
 * (`worktreeCommitGuidance`, `buildTuiCompletionSection`) — same 4-branch
 * decision tree (read-only / TUI / worktree+PR / worktree-only / default) but
 * flattened into a function so reading is linear instead of a nested ternary.
 *
 * Returns the bullet body WITHOUT the leading `- ` marker (caller prepends),
 * or `null` when the branch produces no text (the legacy empty-string tail).
 *
 * @param {Object} opts
 * @param {boolean} opts.isReadOnly
 * @param {boolean} opts.isTui
 * @param {string} opts.tuiCompletionCommand - `/do:pr` or `/do:push`
 * @param {boolean} [opts.slashdoFree] - TUI without slashdo: the bullet points
 *   at the manual commit + system-handoff workflow instead of a `/do:*` command.
 * @param {Object|null} opts.worktreeInfo
 * @param {boolean} opts.willOpenPR
 * @param {'review-then-merge'|'merge-on-green'|'leave-open'} opts.prCompletion
 * @returns {string|null}
 */
export function buildCompletionGuidelineBullet({
  isReadOnly, isTui, tuiCompletionCommand, slashdoFree = false,
  worktreeInfo, willOpenPR, prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN, discardWorktree = false, noCodeOutput = false,
  leavePrOpen = false, isPrFollowUp = false,
}) {
  // A PR follow-up (review-loop or merge-only) already carries its own PRIMARY
  // OBJECTIVE section with the full procedure, and its cleanup runs with
  // `skipMerge`. The generic "your branch is merged back automatically" bullet
  // would contradict both — and a merge-only run legitimately makes no commit.
  if (isPrFollowUp && !discardWorktree && !noCodeOutput && !isReadOnly) {
    return 'Follow the follow-up section above — it is the whole task. Commit and push only fixes you actually make; the deliverable is the PR\'s final state, not a commit. Do NOT open a new PR, and do NOT expect this branch to be merged back for you.';
  }
  // `noCodeOutput` is checked FIRST because the two flags answer different
  // questions: `discardWorktree` decides what happens to the checkout, while
  // `noCodeOutput` decides where the deliverable goes. A task that sets both —
  // "do your work through an API/CLI action during the run, and never land
  // code" — must be told its output channel is that action, NOT the sentinel.
  // Telling it "write your result to the sentinel" is how a run files nothing
  // and reports its findings into a file that gets thrown away (PLAN.md records
  // this exact hazard from the 2026-07-16 codex review). No pre-existing task
  // sets both, so this ordering changes nothing that shipped before it.
  if (noCodeOutput) {
    return '**This task produces no code output.** Its result is the API request or command your instructions describe (a PortOS endpoint call, a filed tracker issue, …) — do NOT run `/do:push`, `/do:pr`, `/simplify`, `git commit`, `git push`, or open a PR. Write the completion sentinel (see the Completion section) and stop.';
  }
  if (discardWorktree) {
    return '**This is a reasoning-only task.** The worktree is discarded on exit — do NOT commit, push, merge, or open a PR. Write your result to the completion sentinel (see the Completion section) and stop.';
  }
  if (isReadOnly) {
    return '**This is a read-only task.** Do NOT commit, push, or modify any files in the repository. Only read data and generate reports.';
  }
  if (isTui) {
    // NOTE: in production this branch is only reachable from the full/api prompt
    // path, where `isTui` is currently always false (TUI providers route through
    // buildLightContextPrompt, which emits the live TUI completion via
    // buildTuiCompletionSection — not this bullet). It's kept provider-aware and
    // directly unit-tested so the guideline stays correct if that routing changes.
    const howTo = slashdoFree
      ? 'the Completion Workflow above (plain `git` commit + PortOS handoff — this provider has no slashdo commands)'
      : `the Completion Workflow above (\`${tuiCompletionCommand}\`)`;
    return `On successful completion, YOU run ${howTo}, then write the sentinel and stop — PortOS closes the session once it sees the sentinel; do NOT run \`/quit\`.`;
  }
  if (worktreeInfo && willOpenPR) {
    const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
    const runsReviewLoop = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
    const reviewSuffix = policyLeavesOpen
      ? ' This task is configured to leave the PR OPEN for you to inspect — no follow-up agent will review or merge it automatically.'
      : leavePrOpen
        ? ' This task is tracked in JIRA, so the PR is left OPEN for a human to land alongside the ticket — nothing merges it automatically.' + (runsReviewLoop ? ' A follow-up agent still runs the configured reviewers against it.' : '')
      : runsReviewLoop
        ? ' For GitHub PRs, a Copilot code review will also be requested automatically (skipped on GitLab and other non-GitHub forges) — do NOT run `/do:rpr` or attempt to address review comments yourself; you will have already exited.'
        : ' No review was requested for this task, so a follow-up agent merges the PR once CI is green — do NOT try to merge it yourself; you will have already exited.';
    return `On successful completion, the system will push your branch and open a pull request — do NOT open a PR manually. (If the task fails, no PR is opened; the worktree is then cleaned up unless a safety check preserves it for manual recovery.)${reviewSuffix}`;
  }
  if (worktreeInfo) {
    return 'Your worktree branch will be automatically merged back to the source branch when your task completes — do NOT open a PR.';
  }
  return null;
}

// One-line worktree note for a discard (reasoning-only) task, replacing the
// "commit / push / auto-merge" guidance the normal worktree section emits. The
// worktree exists only so the reasoner can make scratch edits without touching
// the real tree — cleanup discards it with no commit/merge/PR (see
// `discardWorktree` in agentWorktreeCleanup.js).
const DISCARD_WORKTREE_NOTE = 'Do NOT commit, push, or open a PR — this worktree is discarded on exit. Make any scratch edits that help you reason; only the completion sentinel is kept.';

/**
 * Is this worktree attached to a branch a PR already points at — i.e. the
 * review-loop follow-up, whose guidance is "push review fixes here, the PR
 * points at this branch"?
 *
 * Identified POSITIVELY, off the follow-up's own `reviewLoopFollowUp` marker,
 * rather than as "any `existingBranch` worktree". `existingBranch` means only
 * "attach to this branch" and now has two producers: the follow-up, and a retry
 * resuming a dead agent's branch (`resumedFromAgentId`), which follows the task's
 * ordinary push/PR flow and may have no PR at all. Keying on the marker means a
 * THIRD producer defaults to the ordinary flow instead of silently inheriting
 * review-fix instructions for a PR that doesn't exist.
 */
function isPrBranchWorktree(task, worktreeInfo) {
  return worktreeInfo?.existingBranch === true && !!task?.metadata?.reviewLoopFollowUp;
}

/**
 * Is this worktree a RESUME of a previous failed agent's branch? Keyed on
 * `resumedFromAgentId`, which only the resume path stamps (see
 * agentCompletionCleanup.js).
 */
function isResumedWorktree(task, worktreeInfo) {
  return worktreeInfo?.existingBranch === true && !!task?.metadata?.resumedFromAgentId;
}

/**
 * Resume banner for a retry picking up what a PREVIOUS unfinished agent left
 * behind (`metadata.existingBranch` + `resumedFromAgentId`, stamped by
 * `recordTaskResumePointer` when a dead run's branch — or whole worktree —
 * survived cleanup).
 *
 * Without this the retry sees an ordinary worktree that just happens to have
 * work in it and redoes what is already done — the failure mode the
 * agent-d2ae0352 incident exposed (reaped 30s after its PR merged; the
 * replacement agent started the shipped work over). Telling it to read the log
 * FIRST is the whole point: the prior run may have gone as far as opening or even
 * merging a PR, in which case there is nothing left to build.
 *
 * An ADOPTED worktree (`worktreeInfo.adopted` — the shape a server restart leaves,
 * killed mid-edit before committing) additionally carries the dead run's
 * uncommitted edits and untracked files, so the banner points at `git status`
 * as the primary record rather than the commit log.
 *
 * Returns '' when this isn't a resume, so callers can interpolate unconditionally.
 */
export function buildResumeSection(task, worktreeInfo) {
  if (!isResumedWorktree(task, worktreeInfo)) return '';
  const priorAgentId = task.metadata.resumedFromAgentId;
  const carriedWork = worktreeInfo.adopted
    ? `**You are in its actual working directory** — its commits are on your branch \`${worktreeInfo.branchName}\`
AND any edits it had not committed yet are still in your working tree, exactly as it left them.`
    : `**Its commits are already on your branch** \`${worktreeInfo.branchName}\` — you are
continuing its run, not starting over.`;
  return `
## Resuming Unfinished Work — Read This First
A previous agent (\`${priorAgentId}\`) worked this same task and did NOT finish cleanly
(it hung, timed out, or was terminated — a server restart kills runs mid-edit).
${carriedWork}

Before you write any code, establish what is already done:
1. \`git status\` — anything it left uncommitted. Treat these as YOUR in-progress
   changes: review them, finish them, and commit them. Do not discard them wholesale.
2. \`git log --oneline ${worktreeInfo.baseBranch || 'origin/HEAD'}..HEAD\` — the commits it already made.
3. Check whether it already shipped: look for an open or merged PR for this branch
   — \`gh pr list --head ${worktreeInfo.branchName} --state all\` on GitHub,
   \`glab mr list --source-branch ${worktreeInfo.branchName}\` on GitLab.

Then do only what remains. If a PR is already **merged**, the work is done — go
straight to your completion step and report that. If a PR is already **open**,
finish/land that PR rather than opening a second one. Do NOT redo completed work,
and do NOT revert its commits unless they are actually wrong.
`;
}

/**
 * Completion block for a **programmatic-output** (throwaway-worktree) task: the
 * agent reasons in a worktree that is discarded on exit, so it must NOT commit,
 * push, merge, or open a PR. Its only channel out is the `.agent-done` sentinel,
 * whose exact payload shape is specified by the task instructions (a task-type
 * output hook — see `taskTypeHooks.js` / `layeredIntelligenceHooks.js`). This
 * replaces the normal `/do:push`+markdown-sentinel completion workflow, which
 * would tell the agent to push code (defeating the discard guarantee) and write
 * a markdown summary (breaking the hook's structured-JSON sentinel contract).
 */
export function buildProgrammaticOutputCompletionSection(sentinelPath) {
  return [
    '## Completion (Reasoning-Only Task)',
    'This is a reasoning task, not a code change. The worktree you are in is **discarded on exit** — any commits, pushes, or PRs are thrown away and have no effect. Do NOT run `/do:push`, `/do:pr`, `git commit`, `git push`, or open a pull request.',
    '',
    `When you have finished reasoning, write your result to \`${sentinelPath}\` in the exact payload format described in your task instructions, then stop. PortOS polls this sentinel every 2s, finalizes the run, and closes the session for you — do NOT run \`/quit\` and do NOT wait for anything after writing the sentinel.`
  ].join('\n');
}

/**
 * Completion block for a **read-only** task (e.g. reference-watch, pr-reviewer's
 * scan stage). The agent must NOT commit/push/modify source; its real output is
 * recorded elsewhere DURING the run (a tracker issue, PLAN.md, a report).
 *
 * A TUI agent still needs a `.agent-done` sentinel to signal completion — the 2s
 * sentinel poll in `spawnTuiAgent` is the primary finalize path and the channel
 * that ingests the run summary. Without it a read-only TUI run only finalizes via
 * the idle reaper / shell-exit fallback, so the resolution summary is never
 * captured cleanly (the bug this repairs). CLI/API read-only agents complete on
 * process exit and never poll a sentinel, so they get the bare notice only.
 */
export function buildReadOnlyCompletionSection({ isTui = false, sentinelPath = null } = {}) {
  const notice = '## Read-Only Task\nDo NOT commit, push, or modify any files. Read data and report findings only.';
  if (!isTui || !sentinelPath) return notice;
  return [
    notice,
    '',
    `When you have finished, write a short markdown summary of what you found (and where you recorded it) to \`${sentinelPath}\`, then stop. PortOS polls this sentinel every 2s, finalizes the run, and closes the session for you — do NOT run \`/quit\` and do NOT wait for anything after writing the sentinel.`
  ].join('\n');
}

/**
 * Completion block for a **no-code / API-action** task (e.g. a Creative Director
 * plan/treatment/evaluate agent). The agent's deliverable is the HTTP request its
 * task instructions already describe (a PATCH to a PortOS endpoint), NOT a code
 * change — so the normal `/do:push`+PR completion workflow is wrong: there is
 * nothing to commit or push, and telling the agent to run `/do:push` just makes it
 * load that skill for no reason (and can contradict the task prompt's own
 * "on a 200 your task is complete"). A TUI agent still writes a `.agent-done`
 * sentinel so the 2s poll finalizes it promptly instead of waiting on the idle
 * reaper.
 */
export function buildActionOutputCompletionSection({ isTui = false, sentinelPath = null } = {}) {
  const notice = '## Completion (No Code Output)\nThis task produces **no code change** — its result is delivered DURING the run by the API request or command your instructions describe (a PATCH to a PortOS endpoint, a filed tracker issue, …), not by a commit and not by this sentinel. Do NOT run `/do:push`, `/do:pr`, `/simplify`, `git commit`, `git push`, or open a pull request; there is nothing to push.';
  if (!isTui || !sentinelPath) return notice;
  return [
    notice,
    '',
    `Your task is complete once that request succeeds. Then write a one-line summary to \`${sentinelPath}\` and stop — PortOS polls this sentinel every 2s, finalizes the run, and closes the session for you. Do NOT run \`/quit\` and do NOT wait for anything after writing the sentinel.`
  ].join('\n');
}

/**
 * Build the agent prompt.
 *
 * Two context modes, selected by `options.providerType`:
 *
 * - **Light** (`tui` / `cli`): minimal prompt — task description, attached
 *   context, screenshot paths, worktree/jira/pipeline coordinates, and the
 *   completion-workflow contract. Memory, CLAUDE.md, digital twin, tools
 *   summary, planning context, skill templates, and compaction warnings are
 *   deliberately omitted because the agent can fetch them itself.
 * - **Full** (`api`): kitchen-sink prompt with memory + CLAUDE.md + digital
 *   twin + tools + skills + planning + git hygiene. The leading
 *   "# Chief of Staff Agent Briefing" header is dropped from both modes.
 *
 * @param {Object} task - Task object
 * @param {Object} config - CoS configuration
 * @param {string} workspaceDir - Working directory (may be a worktree)
 * @param {Object|null} worktreeInfo - Worktree details if using a worktree
 * @param {Function} isTruthyMetaFn - isTruthyMeta function (passed to avoid circular dep)
 * @param {Object} options
 * @param {string} [options.providerType='api'] - `'tui' | 'cli' | 'api'`
 * `providerId` + `providerCommand` + `leanMode` together decide whether the
 * session can TYPE a Claude Code slash command (`canTypeSlashCommands`, #3114):
 * a capable session is instructed to drive its own `/simplify` + `/do:pr` /
 * `/do:push`, and everything else gets plain `git`/`gh` (TUI) or PortOS's
 * post-exit push+PR (CLI). `agentCompletionCleanup.js` derives the same predicate
 * from the agent record so it passes `openPR: false` and avoids double-firing.
 *
 * @param {string} [options.providerId] - Provider id (e.g. `'claude-code'`). Not an
 *   allowlist: it only matters when `providerCommand` is blank, where the
 *   spawners' `inferTuiCommand` fallback resolves the command from it.
 * @param {string} [options.providerCommand] - Provider launch command (e.g.
 *   `'claude'`, `'codex'`, `'opencode'`) — the primary signal, so a
 *   path-configured or renamed binary is recognised.
 * @param {boolean} [options.leanMode] - Ollama-backed Claude session launched with
 *   `--bare` (see `applyLeanClaudeArgs`): the completion workflow drops slashdo
 *   commands (bare mode skips command discovery) in favor of plain `git`/`gh`.
 * @param {boolean} [options.split] - Light path only: return
 *   `{ userPrompt, systemPrompt }` (see `buildLightContextPromptParts`) instead
 *   of a single string, for providers spawned with `--append-system-prompt-file`.
 *   Ignored on the full/api path, which always returns a string.
 */
export async function buildAgentPrompt(task, config, workspaceDir, worktreeInfo = null, isTruthyMetaFn = (v) => v === true || v === 'true', options = {}) {
  // Undo the queue-path description/context split so a round-tripped generated
  // prompt (swarm, scheduled claim-work, other system tasks) renders once
  // instead of double-printing its first line under a `### Context` header.
  // Feeds both the briefing template (via the reconciled `task` object) and the
  // full-path fallback below.
  task = reconcileSplitContext(task);
  const providerType = options.providerType || PROVIDER_TYPES.API;
  const providerId = options.providerId || null;
  const providerCommand = options.providerCommand || null;
  const isTui = providerType === PROVIDER_TYPES.TUI;
  const leanMode = options.leanMode === true;

  // Install-wide default reviewer list (Code Review Defaults panel →
  // `settings.codeReview.reviewers`). Threaded as the `normalizeReviewers`
  // fallback so a task that pins no `reviewers` (e.g. every app-improve /
  // self-improvement scheduled task) resolves to the configured default
  // instead of the hardcoded `copilot` — which stalls the review loop on
  // installs without GitHub Copilot review enabled (issue #2507). Unset →
  // `['copilot']` (getCodeReviewDefaults returns the copilot fallback), so
  // behavior is unchanged when nothing is configured. A settings read error
  // degrades to the hardcoded default inside normalizeReviewers.
  //
  // Resolved BEFORE the slashdo section below, which prunes the reviewer
  // variants a run can't reach out of the command body (#3110).
  const codeReviewDefaults = await getCodeReviewDefaults().catch(() => null);
  const defaultReviewers = codeReviewDefaults?.reviewers;

  // Render a slashdo-backed task's invocation now that the provider is known —
  // before the light-path branch below, so both paths carry it. `hasFileTools`
  // is the light/`api` split itself: `cli`/`tui` hosts are agentic CLIs with
  // native file tools (so an over-budget procedure can live on disk), while an
  // HTTP `api` provider has none and must have it pasted (#3110).
  task = await applySlashdoInvocation(task, {
    providerId, providerCommand, leanMode,
    hasFileTools: LIGHT_CONTEXT_PROVIDER_TYPES.has(providerType),
    defaultReviewers, codeReviewDefaults,
  });

  // Preload slashdo's local-agent review-loop recipe once for review-loop
  // follow-up tasks; both the light/TUI path (via lightOptions) and the full
  // path (the verbose builder below) reuse this single value to inline the exact
  // CLI-reviewer invocation. Cheap + cached; only read for follow-ups — and not
  // for a merge-only follow-up, which has no reviewer to invoke and renders a
  // section that ignores this body entirely.
  const needsReviewerRecipes = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp)
    && !isMergeOnlyFollowUp(task.metadata || {});
  const localAgentLoopBody = needsReviewerRecipes
    ? await loadSlashdoLib('local-agent-review-loop').catch(() => null)
    : null;

  if (LIGHT_CONTEXT_PROVIDER_TYPES.has(providerType)) {
    const lightOptions = { isTui, providerId, providerCommand, leanMode, defaultReviewers, codeReviewDefaults, localAgentLoopBody };
    return options.split === true
      ? buildLightContextPromptParts(task, workspaceDir, worktreeInfo, isTruthyMetaFn, lightOptions)
      : buildLightContextPrompt(task, workspaceDir, worktreeInfo, isTruthyMetaFn, lightOptions);
  }

  // Full path: API providers don't read CLAUDE.md natively, so always include it.
  const skipClaudeMd = false;
  // Fetch independent context sections in parallel
  const [memorySection, claudeMdSection, digitalTwinSection] = await Promise.all([
    getMemorySection(task, { maxTokens: config.memory?.maxContextTokens || 2000 })
      .catch(err => { console.log(`⚠️ Memory retrieval failed: ${err.message}`); return null; }),
    skipClaudeMd
      ? Promise.resolve(null)
      : getClaudeMdContext(workspaceDir)
          .catch(err => { console.log(`⚠️ CLAUDE.md retrieval failed: ${err.message}`); return null; }),
    getDigitalTwinForPrompt({ maxTokens: config.digitalTwin?.maxContextTokens || config.soul?.maxContextTokens || 2000, personaId: 'active' })
      .catch(err => { console.log(`⚠️ Digital twin context retrieval failed: ${err.message}`); return null; })
  ]);

  // Build context compaction section if task is retrying after a context-limit failure
  const compactionSection = task.metadata?.compaction?.needed ? buildCompactionSection(task) : '';

  // Build worktree context section if applicable
  const willOpenPR = isTruthyMetaFn(task.metadata?.openPR);
  const prCompletion = resolvePrCompletion(task.metadata);
  // A discard (reasoning-only) worktree: the agent reasons in it but it's thrown
  // away on exit with no commit/merge/PR (see agentWorktreeCleanup.js). Suppresses
  // all commit/push/PR completion guidance in favor of the sentinel-only contract.
  const discardWorktree = isTruthyMetaFn(task.metadata?.discardWorktree);
  // No-code / API-action task (e.g. Creative Director agents): deliverable is an
  // HTTP PATCH, not a commit — suppress the /do:push completion workflow. Also
  // derive from a CD task's own `creativeDirector` marker so tasks queued as
  // `pending` BEFORE this flag existed (persisted across an upgrade) are still
  // recognized without a metadata migration.
  const noCodeOutput = isTruthyMetaFn(task.metadata?.noCodeOutput) || !!task.metadata?.creativeDirector;
  const isWorktreeOnExistingBranch = isPrBranchWorktree(task, worktreeInfo);
  const worktreeSection = worktreeInfo ? `
## Git Worktree Context
You are working in an **isolated git worktree** to avoid conflicts with other agents working concurrently.
- **Branch**: \`${worktreeInfo.branchName}\`${isWorktreeOnExistingBranch ? ' *(pre-existing PR branch)*' : ''}
- **Worktree Path**: \`${worktreeInfo.worktreePath}\`
${worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\` (latest from origin)` : ''}

**Important**: ${discardWorktree
    ? DISCARD_WORKTREE_NOTE
    : isTui
      ? 'Commit your changes to this branch — see the **Completion Workflow** section below for the full push/PR/exit sequence.'
      : isWorktreeOnExistingBranch
        ? 'Commit and **push** any review-fix commits to this branch — the PR points at it, so pushed commits are how Copilot sees your fixes. Use `git pull --rebase` before pushing if needed.'
        : `Commit your changes to this branch.${willOpenPR ? ' When your task completes, the system will push this branch and open a pull request against the default branch — do NOT push or open a PR yourself.' : ' Your commits will be automatically merged back to the main development branch when your task completes.'}`} Do NOT manually switch branches or modify the worktree configuration.
${buildResumeSection(task, worktreeInfo)}` : '';

  // Build pipeline context section if this is a pipeline stage
  const pipelineCtx = task.metadata?.pipeline;
  const pipelineSection = pipelineCtx?.previousStageAgentId ? `
## Pipeline Context
This is stage ${pipelineCtx.currentStage + 1} of ${pipelineCtx.stages.length}: "${pipelineCtx.stages[pipelineCtx.currentStage]?.name}"
Previous stage: "${pipelineCtx.stages[pipelineCtx.currentStage - 1]?.name}"

Read the previous stage's output from:
\`${join(AGENTS_DIR, pipelineCtx.previousStageAgentId, 'output.txt')}\`

Use the findings from the previous stage to inform your work. If the previous stage produced a JSON results block, parse it to determine which items to process.
` : '';

  // Build simplify section if enabled. In the worktree-with-openPR flow the
  // system pushes and opens the PR after the agent exits, so the agent must
  // only commit (not push) — keep this wording aligned with the worktree
  // section above. TUI agents own the full simplify+push+PR sequence in the
  // Completion Workflow section below, so this section is suppressed for TUI.
  const simplifyEnabled = isTruthyMetaFn(task.metadata?.simplify);
  // `/simplify` is a Claude Code built-in slash command — only a Claude session
  // that loaded its commands can run it. Everyone else (API/CLI) gets the inline
  // equivalent describing the same reuse/quality/efficiency self-review so the
  // pass still happens. Same predicate as the `/do:pr` gates (#3114) — a
  // path-configured `claude` binary qualifies; a lean `--bare` session doesn't.
  // `assumeClaudeWhenUnknown: false` because only HTTP-API providers reach this
  // path (tui/cli return early above): an unidentified API provider is not a
  // latent local `claude` the way a blank CLI/TUI provider is.
  const canRunSlashCommands = canTypeSlashCommands({
    providerId, providerCommand, leanMode, assumeClaudeWhenUnknown: false,
  });
  const simplifyInstruction = canRunSlashCommands
    ? 'run `/simplify` to review the changed code for reuse, quality, and efficiency'
    : SIMPLIFY_INLINE_REVIEW;
  // Discard tasks don't commit, so the simplify-before-commit step is moot.
  const simplifySection = simplifyEnabled && !isTui && !discardWorktree ? `
## Simplify Step
After completing your work and before committing, ${simplifyInstruction}. Fix any issues found, then ${worktreeInfo && willOpenPR ? 'commit your changes (do NOT push — on a successful run the system will push and open the PR after you exit; if the run fails, no push or PR happens)' : 'commit and push using `/do:push`'}.
` : '';

  // Resolve the user's ordered reviewer list + flags (task metadata wins; else the
  // install's configured Code Review Defaults; else `[copilot]`). Declared up here
  // so the TUI completion block can thread `--review-with …` into `/do:pr`.
  // Thread the install's Code Review Defaults as the fallback for ALL five
  // reviewer fields (not just `reviewers`) with task-over-default precedence —
  // mirroring `resolveReviewLoopOptions` in codeReview.js. #2507 made only the
  // reviewer LIST default-aware on this inline `/do:pr` path (TUI + claude-code
  // agents that own the PR); its four companions (usernames, optionalReviewers,
  // stopMode, reviewerApplies) were still resolved from task metadata alone, so
  // a task pinning no reviewer config would silently drop the configured gating
  // reviewers / stop-mode / reviewer-applies here while the non-PR-owning CLI
  // follow-up path honored them — same defaults, different gating by provider.
  const {
    reviewers: taskReviewers,
    usernames: taskReviewerUsernames,
    optionalReviewers: taskOptionalReviewers,
    reviewerMaxRounds: taskReviewerMaxRounds,
    reviewerModels: taskReviewerModels,
    reviewerEfforts: taskReviewerEfforts
  } = resolveReviewerConfig(task.metadata, codeReviewDefaults, defaultReviewers);
  const taskReviewStopMode = task.metadata?.reviewStopMode || codeReviewDefaults?.stopMode || DEFAULT_REVIEW_STOP_MODE;
  const taskReviewerApplies = task.metadata?.reviewerApplies !== undefined
    ? isTruthyMetaFn(task.metadata?.reviewerApplies)
    : (codeReviewDefaults?.reviewerApplies === true);

  // TUI completion section — delegate to the shared light-path builder so
  // both prompt paths emit byte-identical workflows. (Background: TUI owns
  // its own `/simplify` → `/do:pr|/do:push` → sentinel sequence because the
  // slashdo submodule mounts those commands at project level. Writing the
  // sentinel is the done signal — PortOS finalizes via the 2s poll and kills
  // the session, so the prompt does NOT ask the agent to `/quit` (it's a UI
  // command the agent can't invoke). See `buildTuiCompletionSection` below.)
  const tuiCompletionCommand = willOpenPR ? '/do:pr' : '/do:push';
  const sentinelPath = `${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`;
  // A discard task's completion is the sentinel-only contract (no push/PR/merge),
  // and this applies to every provider type — so it wins over the isTui fork and
  // over the fallback template's commit/push instructions below.
  // Same precedence as buildCompletionGuidelineBullet: where the deliverable
  // goes (`noCodeOutput`) decides the completion contract, and only then does
  // worktree disposal (`discardWorktree`) pick the reasoning-payload contract.
  // A task doing external work during the run must not be told the sentinel is
  // its output channel.
  const tuiCompletionSection = noCodeOutput
    ? buildActionOutputCompletionSection({ isTui, sentinelPath })
    : discardWorktree
      ? buildProgrammaticOutputCompletionSection(sentinelPath)
      : isTui
        ? buildTuiCompletionSection({
            willOpenPR, prCompletion, simplifyEnabled,
            // Unreachable today — every `tui`/`cli` provider returns early at the
            // LIGHT_CONTEXT gate above, so `isTui` is always false on this path
            // (same situation as buildCompletionGuidelineBullet's `isTui` arm).
            // Kept provider-aware anyway so it can't be the ONE call site that
            // silently promises `/do:pr` to a host that can't type it if the
            // routing ever changes — this arm previously passed no slashdoFree at
            // all, which is how gates like this drift (#3114).
            slashdoFree: !canRunSlashCommands,
            branchName: worktreeInfo?.branchName || null,
            baseBranch: worktreeInfo?.baseBranch || null,
            sentinelPath,
            leavePrOpen: leavesPrForHuman(task),
            reviewers: taskReviewers,
            usernames: taskReviewerUsernames,
            optionalReviewers: taskOptionalReviewers,
            reviewerMaxRounds: taskReviewerMaxRounds,
            reviewerModels: taskReviewerModels,
            reviewerEfforts: taskReviewerEfforts,
            reviewStopMode: taskReviewStopMode,
            reviewerApplies: taskReviewerApplies
          })
        : '';

  // Build review loop section if enabled. The agent itself does NOT open the PR
  // or run /do:rpr — by the time the PR exists, the agent has already exited.
  // The system requests Copilot review automatically after PR creation on GitHub
  // PRs. On non-GitHub forges (e.g. GitLab MRs) this step is skipped because the
  // Copilot reviewer is GitHub-only. Only meaningful when a PR will actually be
  // created (willOpenPR), since the Copilot review request is a no-op without a
  // PR URL. Suppressed for TUI agents because TUI agents open the PR themselves
  // and the Completion Workflow above instructs them to request the Copilot
  // review inline — the system-side post-exit handler never fires for TUI.
  const reviewLoopSection = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE && willOpenPR && !isTui ? `
## Code Review
After your task completes, the system will spawn a follow-up agent that runs the review-and-fix loop until all configured reviewers are satisfied, then merges the PR. The follow-up uses **${taskReviewers.join(' → ')}** (in order). ${taskReviewers[0] === DEFAULT_REVIEWER
    ? 'Copilot leads the list, so for GitHub PRs the system pre-requests its initial review automatically (skipped on GitLab MRs and other non-GitHub forges); the follow-up then drives the rest of the chain.'
    : taskReviewers.includes(DEFAULT_REVIEWER)
      ? 'The follow-up invokes the CLI reviewers itself and requests Copilot at its turn (Copilot is GitHub-only, so it is skipped on non-GitHub forges).'
      : 'The follow-up agent will invoke the configured CLI reviewers directly to critique the PR diff, then iterate on their feedback.'} You do not need to open the PR, trigger the review, or address feedback yourself — focus on producing high-quality, well-tested code so the review passes go cleanly.
` : '';

  // Build review-loop follow-up section. This is the agent that addresses Copilot's
  // feedback iteratively and merges the PR — spawned by the previous agent's cleanup
  // hook (see spawnReviewLoopFollowUp in agentLifecycle.js). It needs the full /do:rpr
  // procedure inlined because the agent runs in a one-shot session and won't trigger
  // a slash command itself.
  const isReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
  let reviewLoopFollowUpSection = '';
  if (isReviewLoopFollowUp) {
    // `/do:rpr` is the Copilot/@github comment-resolution procedure — a merge-only
    // follow-up has no review to resolve, so skip the ~35KB read for it.
    const rprBody = needsReviewerRecipes ? await loadSlashdoFile('rpr').catch(() => null) : null;
    // localAgentLoopBody (the CLI-reviewer recipe) was already preloaded at the
    // top of buildAgentPrompt under the same reviewLoopFollowUp guard — reuse it
    // rather than re-reading the lib a second time.
    reviewLoopFollowUpSection = buildReviewLoopFollowUpSection(task.metadata || {}, { verbose: true, rprBody, localAgentLoopBody });
  }

  // Build JIRA context section if applicable
  const jiraSection = task.metadata?.jiraTicketId ? `
## JIRA Integration
This task is tracked by JIRA ticket **${task.metadata.jiraTicketId}**.
- **Ticket URL**: ${task.metadata.jiraTicketUrl}
${task.metadata.jiraBranch ? `- **Branch**: \`${task.metadata.jiraBranch}\`` : ''}

Include the ticket ID (${task.metadata.jiraTicketId}) in your commit messages, e.g. \`${task.metadata.jiraTicketId}: description of change\`.
${task.metadata.jiraBranch ? 'Commit your changes to this branch. Do NOT switch branches.' : ''}
` : '';

  // Detect and load task-type-specific skill template (only when matched)
  const matchedSkill = detectSkillTemplate(task);
  const skillSection = matchedSkill
    ? await loadSkillTemplate(matchedSkill).catch(err => {
        console.log(`⚠️ Skill template load failed for ${matchedSkill}: ${err.message}`);
        return null;
      })
    : null;

  // Build onboard tools section for agent awareness
  const toolsSection = await getToolsSummaryForPrompt().catch(err => {
    console.log(`⚠️ Tools summary retrieval failed: ${err.message}`);
    return '';
  });

  // Build .planning/ context section for GSD-enabled apps
  let planningContextSection = '';
  if (task.metadata?.app) {
    const planningPath = join(workspaceDir, '.planning');
    const hasPlanningDir = await stat(planningPath).then(s => s.isDirectory()).catch(() => false);
    if (hasPlanningDir) {
      const planningParts = [];
      const [stateContent, concernsContent, roadmapContent] = await Promise.all([
        tryReadFile(join(planningPath, 'STATE.md')),
        tryReadFile(join(planningPath, 'CONCERNS.md')),
        tryReadFile(join(planningPath, 'ROADMAP.md'))
      ]);
      if (stateContent) planningParts.push(`### Current State\n\`\`\`\n${stateContent.slice(0, 1000)}\n\`\`\``);
      if (concernsContent) planningParts.push(`### Known Concerns\n\`\`\`\n${concernsContent.slice(0, 1500)}\n\`\`\``);
      if (roadmapContent) planningParts.push(`### Roadmap\n\`\`\`\n${roadmapContent.slice(0, 1000)}\n\`\`\``);
      if (planningParts.length > 0) {
        planningContextSection = `\n## Project Planning Context (.planning/)\nThis project has GSD planning documents. Use this context to understand priorities and known issues.\n\n${planningParts.join('\n\n')}\n`;
      }
    }
  }

  // Try to use the prompt template system. Skip the template path for
  // review-loop follow-up agents because the user-side template usually
  // predates the {{reviewLoopFollowUpSection}} placeholder; the built-in
  // fallback is the source of truth for that section, and silently dropping
  // it would leave the agent with no instructions and the loop would not run.
  // Precomputed display label for the stock "Target Application" heading in the
  // cos-agent-briefing template. Mirrors buildTaskBlock's predicate: suppress
  // the redundant heading for the PortOS default app (empty string → the
  // template section is falsy and renders nothing), surface the app id for
  // managed apps. `task.metadata.app` stays in the context for any custom
  // template references — only the stock heading gates on this.
  const briefingApp = task.metadata?.app;
  const targetAppLabel = briefingApp && briefingApp !== PORTOS_APP_ID ? briefingApp : '';
  const promptData = isReviewLoopFollowUp ? null : await buildPrompt('cos-agent-briefing', {
    task,
    targetAppLabel,
    config,
    memorySection,
    claudeMdSection,
    digitalTwinSection,
    worktreeSection,
    pipelineSection,
    jiraSection,
    simplifySection,
    tuiCompletionSection,
    reviewLoopSection,
    reviewLoopFollowUpSection,
    compactionSection,
    skillSection,
    planningContextSection,
    toolsSection,
    soulSection: digitalTwinSection, // Backwards compatibility for prompt templates
    timestamp: new Date().toISOString()
  }).catch(() => null);

  if (promptData?.prompt) {
    return `${promptData.prompt}\n\n${UNATTENDED_RUN_RULE}\n\n${PM2_SAFETY_RULE}`;
  }

  const taskBlock = buildTaskBlock(task, { screenshotsAsList: false });

  // Fallback to built-in template
  return `${claudeMdSection || ''}

${memorySection || ''}

${taskBlock.description}
${task.metadata?.context ? (task.metadata.context.includes('\n') ? `\n### Task Context\n\n${task.metadata.context.trimEnd()}\n` : `\n### Task Context\n\n${task.metadata.context}\n`) : ''}
${taskBlock.targetApp}
${taskBlock.screenshots}
${taskBlock.attachments}
${worktreeSection}
${pipelineSection}
${jiraSection}
${simplifySection}
${tuiCompletionSection}
${reviewLoopSection}
${reviewLoopFollowUpSection}
${compactionSection}
${skillSection ? `## Task-Type Skill Guidelines\n\n${skillSection}\n` : ''}${toolsSection ? `\n${toolsSection}\n` : ''}${planningContextSection}
## Instructions
1. Analyze the task requirements carefully
2. Make necessary changes to complete the task
3. Test your changes when possible
4. ${noCodeOutput
  ? 'Deliver your result the way the task describes (the API call or command it names) — do NOT commit, push, or open a PR; this task changes no code'
  : discardWorktree
  ? 'Write your result to the completion sentinel (see the Completion section above) — do NOT commit, push, or open a PR; this worktree is discarded on exit'
  : isReviewLoopFollowUp
    ? 'Follow the follow-up section above — push any fixes you make to the PR branch; a run that needed no fix makes no commit and that is a success, not a miss'
    : isTui
    ? `Commit, push, and ${willOpenPR ? 'open the PR (see Completion Workflow above)' : 'push the branch (see Completion Workflow above)'}`
    : worktreeInfo && willOpenPR
      ? 'Commit your changes (see Git Hygiene below) — do NOT push, the system handles that on exit'
      : 'Commit and push your changes (see Git Hygiene below)'}
5. Provide a summary of what was done

## Guidelines
- Focus only on the assigned task
- Make minimal, targeted changes
- Follow existing code patterns and conventions
- Do not make unrelated changes
- If blocked, explain clearly why
- Never update the PortOS changelog (\`.changelog/\`) for work on managed apps — the PortOS changelog tracks PortOS core changes only
${(() => {
  const bullet = buildCompletionGuidelineBullet({
    isReadOnly: isTruthyMetaFn(task.metadata?.readOnly),
    isTui, tuiCompletionCommand, slashdoFree: isTui && !canRunSlashCommands,
    worktreeInfo, willOpenPR, prCompletion, discardWorktree, noCodeOutput,
    leavePrOpen: leavesPrForHuman(task),
    isPrFollowUp: isReviewLoopFollowUp,
  });
  return bullet ? `- ${bullet}` : '';
})()}

## Git Hygiene (CRITICAL)
- **Before starting work**, run \`git status\` to verify a clean working tree. Do NOT stash or discard uncommitted changes — other agents may be working concurrently and expecting those changes to be present. If the tree is dirty, only commit files YOU changed for this task.
- **NEVER use \`git stash\`** in any form (\`git stash push\`, \`git stash pop\`, etc.). This is a multi-agent system — stashing can silently destroy or corrupt another agent's or the user's in-progress work. Work around uncommitted changes instead. (Note: the backend may use \`--autostash\` in user-triggered pull operations — that is safe because those are single-user UI actions, not concurrent agent operations.)
- **Only commit files YOU changed** for this task. Never use \`git add -A\` or \`git add .\` — always stage specific files by name.
${noCodeOutput
  ? `- **Do NOT commit, push, or open a PR.** This task changes no code — its result is delivered by the API call or command described above. Without this, a no-worktree task of this shape was told to \`/do:push\` **directly to the branch it is standing on**, which for a task running in the app's live checkout is its default branch.`
  : discardWorktree
  ? `- **Do NOT commit, push, or open a PR.** This worktree is discarded on exit — your only output is the completion sentinel (see the Completion section above).`
  : isReviewLoopFollowUp
    ? `- **Push fixes straight to the PR branch you are on** (the follow-up section above is the procedure). Stage specific files, use a \`fix:\` prefix, no Co-Authored-By annotations. Do NOT open a new PR.`
    : isTui && tuiSlashdoFree
    ? `- **Commit only — do NOT push.** Stage specific files, use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations, then write the completion sentinel. PortOS will handle the branch after it closes the session.`
    : isTui
    ? `- **Use \`${tuiCompletionCommand}\` to ${willOpenPR ? 'commit, push, and open the PR' : 'commit and push the branch'}** — see the Completion Workflow section above. Stage specific files (no \`git add -A\`), use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations.`
    : worktreeInfo && willOpenPR
      ? `- **Commit only — do NOT push.** Stage specific files, use \`feat:\`/\`fix:\`/\`breaking:\` prefix in the commit message, no Co-Authored-By annotations. The system will push your branch and open the PR after you exit, so do NOT run \`git push\` or \`/do:push\` yourself.`
      : `- **Commit and push using \`/do:push\`** — this handles changelog updates, staging specific files, writing a conventional commit message, and pushing safely. If \`/do:push\` is unavailable, follow its conventions manually: stage specific files, use \`feat:\`/\`fix:\`/\`breaking:\` prefix, no Co-Authored-By annotations, and push with \`git pull --rebase && git push\`.`}
${discardWorktree || noCodeOutput ? '' : worktreeInfo ? `- **Your PR should contain only your task's commits.** If you see unrelated commits in your branch history, something is wrong — do not open a PR with other agents' work.` : `- **Commit directly to the current branch.** Do NOT create feature branches or PRs unless explicitly instructed.`}

## Working Directory
${task.metadata?.app ? `You are working in the target app directory: \`${workspaceDir}\`. All code changes, research, plans, and docs for this task belong in this directory — NOT in the PortOS repo.` : 'You are working in the project directory.'} Use the available tools to explore, modify, and test code.

${UNATTENDED_RUN_RULE}

${PM2_SAFETY_RULE}

Begin working on the task now.`;
}

/**
 * Build the **light-context** prompt for agents that have native filesystem
 * tools and CLAUDE.md loading (Claude Code, Codex, Antigravity — `tui` or `cli`).
 *
 * The agent already has direct access to the project, so we don't paste in:
 *   memory dumps, CLAUDE.md contents, digital twin, tools summary,
 *   `.planning/` snippets, auto-matched skill templates, or compaction
 *   warnings. We just hand it the task, any user-attached context/screenshots/attachments,
 *   and the PortOS-specific contract bits it can't infer (worktree branch,
 *   JIRA ticket, pipeline predecessors, completion-sentinel protocol,
 *   review-loop follow-up procedure).
 *
 * Falls back gracefully when worktree/jira/pipeline metadata is absent — only
 * the present sections render.
 */
export function buildLightContextPrompt(task, workspaceDir, worktreeInfo, isTruthyMetaFn, options = {}) {
  const { taskSections, contractSections } = buildLightContextSections(task, workspaceDir, worktreeInfo, isTruthyMetaFn, options);
  return [...taskSections, ...contractSections, BEGIN_WORKING_LINE].join('\n\n') + '\n';
}

/**
 * Split variant of `buildLightContextPrompt` for providers with a real system
 * channel (Claude Code's `--append-system-prompt-file`): the task-specific
 * content (description, context, screenshots, attachments) becomes the user
 * prompt, and the PortOS operating contract (worktree/pipeline/JIRA
 * coordinates + completion workflow) rides in the system prompt where models
 * weight it as instructions rather than conversation. Section content is
 * byte-identical to the combined prompt — only the placement differs.
 *
 * @returns {{ userPrompt: string, systemPrompt: string|null }}
 */
export function buildLightContextPromptParts(task, workspaceDir, worktreeInfo, isTruthyMetaFn, options = {}) {
  const { taskSections, contractSections } = buildLightContextSections(task, workspaceDir, worktreeInfo, isTruthyMetaFn, options);
  return {
    userPrompt: [...taskSections, BEGIN_WORKING_LINE].join('\n\n') + '\n',
    systemPrompt: contractSections.length ? contractSections.join('\n\n') + '\n' : null,
  };
}

const BEGIN_WORKING_LINE = 'Begin working on the task now.';

function buildLightContextSections(task, workspaceDir, worktreeInfo, isTruthyMetaFn, { isTui = true, providerId = null, providerCommand = null, leanMode = false, defaultReviewers, codeReviewDefaults, localAgentLoopBody = null } = {}) {
  // Idempotent with the reconcile in buildAgentPrompt; also protects the
  // directly-exported buildLightContextPrompt/Parts entry points.
  task = reconcileSplitContext(task);
  const willOpenPR = isTruthyMetaFn(task.metadata?.openPR);
  const prCompletion = resolvePrCompletion(task.metadata);
  const simplifyEnabled = isTruthyMetaFn(task.metadata?.simplify);
  const isReadOnly = isTruthyMetaFn(task.metadata?.readOnly);
  const discardWorktree = isTruthyMetaFn(task.metadata?.discardWorktree);
  // A no-code / API-action task (e.g. a Creative Director plan/treatment/evaluate
  // agent): its deliverable is an HTTP PATCH, not a commit — suppress the
  // /do:push completion workflow (see buildActionOutputCompletionSection). Also
  // derive from a CD task's `creativeDirector` marker so pre-upgrade `pending`
  // tasks (queued before this flag existed) are recognized without a migration.
  const noCodeOutput = isTruthyMetaFn(task.metadata?.noCodeOutput) || !!task.metadata?.creativeDirector;
  const isReviewLoopFollowUp = isTruthyMetaFn(task.metadata?.reviewLoopFollowUp);
  const isWorktreeOnExistingBranch = isPrBranchWorktree(task, worktreeInfo);
  // Ordered reviewer list + flags for the Review Loop (task metadata wins; else
  // the install's configured Code Review Defaults threaded from buildAgentPrompt;
  // else `[copilot]`). Flows as `/do:pr --review-with a,b,c [--review-stop-on-*]
  // [--reviewer-applies]`. All five fields fall back to the defaults with
  // task-over-default precedence (see the matching block in buildAgentPrompt and
  // resolveReviewLoopOptions) — not just the reviewer list.
  const {
    reviewers: lightReviewers,
    usernames: lightReviewerUsernames,
    optionalReviewers: lightOptionalReviewers,
    reviewerMaxRounds: lightReviewerMaxRounds,
    reviewerModels: lightReviewerModels,
    reviewerEfforts: lightReviewerEfforts
  } = resolveReviewerConfig(task.metadata, codeReviewDefaults, defaultReviewers);
  const lightReviewStopMode = task.metadata?.reviewStopMode || codeReviewDefaults?.stopMode || DEFAULT_REVIEW_STOP_MODE;
  const lightReviewerApplies = task.metadata?.reviewerApplies !== undefined
    ? isTruthyMetaFn(task.metadata?.reviewerApplies)
    : (codeReviewDefaults?.reviewerApplies === true);
  // Can this session TYPE a Claude Code slash command (`/do:pr`, `/do:push`,
  // `/simplify`)? One predicate, both prompt paths (#3114): `canTypeSlashCommands`
  // derives from `resolveSlashdoStyle` with the spawners' blank-command posture,
  // replacing three inline provider-id allowlists that had already drifted apart
  // (a codex TUI used to be told to run `/do:pr`, which it cannot; a
  // path-configured `claude` binary under a custom provider id used to be denied
  // the slashdo workflow).
  const canTypeSlash = canTypeSlashCommands({ providerId, providerCommand, leanMode });
  // CLI (non-TUI): a Claude Code session drives `/simplify` + `/do:pr` itself
  // (the slashdo submodule mounts those as project-level slash commands). Other
  // CLI providers (codex, antigravity, grok, opencode) get the legacy commit-only
  // block where PortOS handles push+PR on exit.
  const hasSlashdo = !isTui && canTypeSlash;
  // TUI: a session that does NOT load Claude Code slash commands can't run
  // `/do:pr` / `/do:push`, so its completion workflow uses plain git and hands
  // the post-exit push / PR lifecycle back to PortOS
  // — an OpenCode TUI, a codex/antigravity/grok TUI, or a lean-mode Claude
  // session (`--bare` skips project command discovery, and the small local models
  // lean mode targets fumble multi-step slashdo flows anyway).
  const tuiSlashdoFree = isTui && !canTypeSlash;

  const taskSections = [];
  const contractSections = [];
  // Alias preserving the original single-list flow below: task-block pushes go
  // to `taskSections`, then `sections` is repointed at `contractSections` for
  // the operating-contract blocks.
  let sections = taskSections;

  // --- Task block --------------------------------------------------------
  // cwd is set by the spawner and the agent knows its own id from the
  // runner, so the prompt skips that metadata. Target app is kept only for
  // MANAGED apps because it scopes cross-repo work; the PortOS default app is
  // suppressed in buildTaskBlock since cwd already reveals it. Shared with the
  // full path via buildTaskBlock.
  const taskBlock = buildTaskBlock(task, { screenshotsAsList: true });
  sections.push(taskBlock.description);
  if (taskBlock.targetApp) sections.push(taskBlock.targetApp);

  const context = task.metadata?.context;
  if (context) {
    sections.push(context.includes('\n')
      ? `### Context\n\n${context.trimEnd()}`
      : `### Context\n${context}`);
  }

  if (taskBlock.screenshots) sections.push(taskBlock.screenshots);
  if (taskBlock.attachments) sections.push(taskBlock.attachments);

  // Everything below is the PortOS operating contract (not task content) —
  // route it to `contractSections` so the split path can lift it into the
  // system prompt.
  sections = contractSections;

  // --- Unattended run ----------------------------------------------------
  // First contract section, and unconditional: the light path is the one that
  // actually stalled on an approval gate, and "no human will answer you" is not
  // something the agent can infer from CLAUDE.md or its cwd.
  sections.push(UNATTENDED_RUN_RULE);

  // --- Worktree ----------------------------------------------------------
  if (worktreeInfo) {
    sections.push([
      '## Git Worktree',
      `- **Branch**: \`${worktreeInfo.branchName}\`${isWorktreeOnExistingBranch ? ' *(pre-existing PR branch)*' : ''}`,
      `- **Path**: \`${worktreeInfo.worktreePath}\``,
      worktreeInfo.baseBranch ? `- **Based on**: \`${worktreeInfo.baseBranch}\`` : null,
      '',
      worktreeCommitGuidance({ isTui, hasSlashdo, isWorktreeOnExistingBranch, willOpenPR, discardWorktree }),
      'Do NOT manually switch branches or modify the worktree configuration.',
      // Resuming a previous failed agent's branch: establish what's already done
      // before writing code (see buildResumeSection). '' when not a resume.
      buildResumeSection(task, worktreeInfo) || null
    ].filter(Boolean).join('\n'));
  }

  // --- Pipeline ----------------------------------------------------------
  const pipelineCtx = task.metadata?.pipeline;
  if (pipelineCtx?.previousStageAgentId) {
    const prevOutput = join(AGENTS_DIR, pipelineCtx.previousStageAgentId, 'output.txt');
    sections.push([
      '## Pipeline Context',
      `Stage ${pipelineCtx.currentStage + 1} of ${pipelineCtx.stages.length}: "${pipelineCtx.stages[pipelineCtx.currentStage]?.name}"`,
      `Previous stage: "${pipelineCtx.stages[pipelineCtx.currentStage - 1]?.name}"`,
      '',
      `Read the previous stage's output from: \`${prevOutput}\``,
      'If it produced a JSON results block, parse it to determine which items to process.'
    ].join('\n'));
  }

  // --- JIRA --------------------------------------------------------------
  if (task.metadata?.jiraTicketId) {
    sections.push([
      '## JIRA',
      `- **Ticket**: ${task.metadata.jiraTicketId} (${task.metadata.jiraTicketUrl})`,
      task.metadata.jiraBranch ? `- **Branch**: \`${task.metadata.jiraBranch}\` — commit here; do NOT switch branches.` : null,
      `Include the ticket ID in commit messages, e.g. \`${task.metadata.jiraTicketId}: description\`.`
    ].filter(Boolean).join('\n'));
  }

  // --- Completion / review-loop ------------------------------------------
  // Ordering matches the full path's (buildCompletionGuidelineBullet and the
  // tuiCompletionSection ternary): the deliverable's destination
  // (`noCodeOutput`) decides the contract, and only then does worktree disposal
  // (`discardWorktree`) pick the reasoning-payload one. THIS is the branch that
  // matters in production — every `tui`/`cli` provider returns from the light
  // path above and never reaches the other two, so a fix applied only there is
  // no fix at all for anything a subscription-quota job can run.
  if (noCodeOutput) {
    sections.push(buildActionOutputCompletionSection({
      isTui,
      sentinelPath: `${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`,
    }));
  } else if (discardWorktree) {
    // Reasoning-only task: the sentinel payload (shape set by the task-type
    // output hook) is the sole output; the worktree is discarded on exit. Wins
    // over the isTui / CLI push-and-PR completion workflows below.
    sections.push(buildProgrammaticOutputCompletionSection(`${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`));
  } else if (isReadOnly) {
    sections.push(buildReadOnlyCompletionSection({
      isTui,
      sentinelPath: `${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`,
    }));
  } else if (isReviewLoopFollowUp) {
    sections.push(buildReviewLoopFollowUpSection(task.metadata || {}, { verbose: false, localAgentLoopBody }));
  } else if (isTui) {
    sections.push(buildTuiCompletionSection({
      willOpenPR, prCompletion, simplifyEnabled, slashdoFree: tuiSlashdoFree,
      sentinelPath: `${worktreeInfo?.worktreePath || workspaceDir}/.agent-done`,
      branchName: worktreeInfo?.branchName || null,
      baseBranch: worktreeInfo?.baseBranch || null,
      leavePrOpen: leavesPrForHuman(task),
      reviewers: lightReviewers, usernames: lightReviewerUsernames, optionalReviewers: lightOptionalReviewers, reviewerMaxRounds: lightReviewerMaxRounds, reviewerModels: lightReviewerModels, reviewerEfforts: lightReviewerEfforts, reviewStopMode: lightReviewStopMode, reviewerApplies: lightReviewerApplies
    }));
  } else {
    sections.push(buildCliCompletionSection({ worktreeInfo, willOpenPR, prCompletion, hasSlashdo, simplifyEnabled, leavePrOpen: leavesPrForHuman(task), reviewers: lightReviewers, usernames: lightReviewerUsernames, optionalReviewers: lightOptionalReviewers, reviewerMaxRounds: lightReviewerMaxRounds, reviewerModels: lightReviewerModels, reviewerEfforts: lightReviewerEfforts, reviewStopMode: lightReviewStopMode, reviewerApplies: lightReviewerApplies }));
  }

  return { taskSections, contractSections };
}

/**
 * Worktree commit-guidance helper for the light prompt. Picks the right
 * single-sentence instruction based on whether the agent will run its own
 * push workflow (TUI or Claude Code CLI with slashdo), reuse an existing PR
 * branch (review fixes), or hand off to PortOS's post-exit push.
 */
function worktreeCommitGuidance({ isTui, hasSlashdo, isWorktreeOnExistingBranch, willOpenPR, discardWorktree }) {
  if (discardWorktree) return DISCARD_WORKTREE_NOTE;
  if (isTui) return 'Commit your changes to this branch — see **Completion Workflow** below.';
  if (isWorktreeOnExistingBranch) {
    return 'Commit and **push** any review-fix commits to this branch (the PR points at it). Use `git pull --rebase` before pushing if needed.';
  }
  if (hasSlashdo && willOpenPR) {
    return 'Commit your changes here — the **Completion** section below drives the push and PR.';
  }
  if (hasSlashdo) {
    return 'Commit your changes here — the **Completion** section below drives the push.';
  }
  if (willOpenPR) {
    return 'Commit your changes here. The system will push and open a PR after you exit — do NOT push or open a PR yourself.';
  }
  return 'Commit your changes here. Your branch will be merged back automatically when the task completes.';
}

/**
 * Build the merge-and-verify steps that follow `/do:pr` in completion blocks.
 * Returns `{ lines, nextStep }` — append `lines` to the workflow array and
 * assign `nextStep` back to the caller's step counter so any subsequent
 * numbered steps stay continuous.
 *
 * The agent must drive the merge itself — `/do:pr` runs the review loop but
 * exits without merging, so without this step the PR sits open and the branch
 * leaks. Mirrors the merge contract in the review-loop follow-up section so
 * both agent flows converge on the same final state. `reviewers` only colors
 * the wording — the merge step itself is reviewer-agnostic.
 *
 * `prCompletion` selects the review gate or CI-only merge gate. Leave-open
 * callers do not invoke this helper.
 */
function buildPostPRMergeSteps(startStep, { prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE, reviewers = DEFAULT_REVIEWERS, usernames = [], reviewStopMode = DEFAULT_REVIEW_STOP_MODE } = {}) {
  // No review loop → CI is the whole gate, so emit the shared CI procedure that
  // the manual-TUI workflow and the merge follow-up agent also use. The PR URL
  // isn't known when this prompt is written, hence the placeholder.
  if (prCompletion === PR_COMPLETIONS.MERGE_ON_GREEN) {
    const gate = buildCiMergeGateSteps(startStep, { prRef: '"<PR_URL>"', forge: 'unknown' });
    return {
      lines: [
        '   **No review loop is configured for this task, so nothing and nobody else will merge this PR** — `/do:pr` opens it and exits. Capture the PR URL it printed, then:',
        ...gate.lines,
      ],
      nextStep: gate.nextStep
    };
  }
  // Trailing space when present so the sentence reads "the Copilot review loop"
  // (lone copilot, no usernames) or "the review loop" (multi/CLI/username) —
  // never "the the review loop".
  const reviewerLabel = (reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && usernames.length === 0) ? 'Copilot ' : '';
  // Under an explicit stop-mode, the multi-reviewer loop can exit `partial` (later
  // reviewers intentionally skipped after the short-circuit) — that's a successful
  // outcome the user opted into, so merge on it too. Match the known stop-modes
  // explicitly so an unknown/invalid value falls through to the safe default
  // (only `clean`/`too-large` mergeable).
  const explicitStopMode = reviewStopMode === 'on-findings' || reviewStopMode === 'on-clean';
  const mergeStatuses = explicitStopMode
    ? '`clean`, `partial` (a stop-mode short-circuit you opted into), or `too-large`'
    : '`clean` (or `too-large`)';
  const lines = [
    `${startStep}. **Merge the PR immediately when the ${reviewerLabel}review loop reports ${mergeStatuses}** — \`/do:pr\` opens the PR and runs the review loop but does NOT merge. Capture the PR URL printed by \`/do:pr\` and run the exact command below (flags: \`--merge --delete-branch\`, nothing else — a true merge commit keeps the branch tip in main's history so automated worktree cleanup can prove the branch is merged; any merge-deferral flag leaves the PR open after you exit). Skip the merge if the loop ended \`timeout\`, \`error\`, \`inconclusive\`, or \`guardrail\`; leave the PR open for human follow-up.`,
    '   ```bash',
    '   gh pr merge "<PR_URL>" --merge --delete-branch',
    '   ```',
    `${startStep + 1}. Confirm the merge before exiting: \`gh pr view "<PR_URL>" --json state -q .state\` must return \`MERGED\`. If it returns \`OPEN\` or \`CLOSED\`, investigate (failing check, unresolved thread, branch protection), fix, and retry. Do NOT exit until state is \`MERGED\` (or you have explicitly decided not to merge per the rule above).`
  ];
  return { lines, nextStep: startStep + 2 };
}

/**
 * Resolve the review-loop invocation shared by buildTuiCompletionSection and
 * buildCliCompletionSection: the normalized reviewer usernames, the
 * `--review-with ...` argument text, and the effort-pin note. Both callers
 * used to re-derive this identical trio from the same 8-field reviewer-config
 * bundle independently.
 */
function resolveReviewInvocation({ willOpenPR, runsReviewLoop, reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewStopMode, reviewerApplies }) {
  const reviewUsernames = normalizeReviewUsernames(usernames);
  const reviewArgs = willOpenPR
    ? (runsReviewLoop ? buildReviewWithArgs(reviewers, { stopMode: reviewStopMode, reviewerApplies, usernames: reviewUsernames, optionalReviewers, reviewerMaxRounds, reviewerModels }) : '--review-with none')
    : '';
  // Effort pins can't ride `--review-with` (no suffix for them in slashdo's
  // grammar), so they're stated as an instruction on the invocation instead.
  const effortNote = willOpenPR && runsReviewLoop ? buildReviewerEffortNote(reviewers, reviewerEfforts) : '';
  return { reviewUsernames, reviewArgs, effortNote };
}

/**
 * The `.agent-done` sentinel-write instruction block shared by
 * buildTuiCompletionSection and buildManualTuiCompletionSection: the "write a
 * short summary, then stop" instruction plus the fenced heredoc template.
 * Returns the lines to splice into the caller's own line array — output must
 * stay byte-identical since this is agent-facing prompt text.
 */
function buildSentinelWriteSteps(stepNumber, sentinelPath, sentinelTail) {
  return [
    `${stepNumber}. Write a short markdown summary (~5–15 lines) to the completion sentinel, then stop — this sentinel is the done signal. PortOS polls it every 2s, finalizes the run, and closes the session for you. Do NOT run \`/quit\` (it's a UI command, not something you can invoke) and do NOT wait for anything after writing the sentinel.`,
    '',
    '   ```bash',
    `   cat > "${sentinelPath}" <<'EOF'`,
    '   ## Summary',
    '   <one-sentence statement of what was accomplished>',
    '',
    '   ## Changes',
    '   - <key file or area>: <what changed and why>',
    '',
    sentinelTail,
    '   EOF',
    '   ```'
  ];
}

/**
 * TUI completion-workflow block. The TUI owns its own commit → push → PR
 * pipeline via slashdo commands and signals "done" with a sentinel file.
 *
 * When `slashdoFree` is set — any TUI that does NOT load Claude Code slash
 * commands: OpenCode, codex/antigravity/grok/kimi, or a lean `--bare` Claude
 * session — the agent can't run `/do:pr` / `/do:push`, so it delegates to the
 * plain-git/`gh` variant below (same sentinel handshake, no slashdo). The caller
 * resolves that flag once via `canTypeSlashCommands` (#3114); past the early
 * return this IS a Claude session, so `/simplify` and `/do:pr` are both safe to
 * emit without a second provider check.
 */
function buildTuiCompletionSection({ willOpenPR, prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN, simplifyEnabled, sentinelPath, slashdoFree = false, branchName = null, baseBranch = null, leavePrOpen = false, reviewers = DEFAULT_REVIEWERS, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewerModels = {}, reviewerEfforts = {}, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false }) {
  const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
  const runsReviewLoop = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
  if (slashdoFree) {
    // The manual path can't drive the reviewer CLIs, so with a review loop
    // configured it opens the PR and stops. Without one, no reviewer and no
    // follow-up is coming — it merges on green CI like every other flow.
    return buildManualTuiCompletionSection({ willOpenPR, prCompletion, simplifyEnabled, sentinelPath, branchName, baseBranch, leavePrOpen });
  }
  const cmd = willOpenPR ? '/do:pr' : '/do:push';
  // `/do:pr` may inherit a saved `review-with` default. Explicitly opt out
  // when the task's Review Loop control is off so that default cannot start a
  // Copilot (or other external) review unexpectedly.
  const { reviewUsernames, reviewArgs, effortNote } = resolveReviewInvocation({ willOpenPR, runsReviewLoop, reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewStopMode, reviewerApplies });
  // A saved slashdo `merge: true` default would otherwise merge a PR that must
  // stay open — dropping our own merge steps isn't enough, `/do:pr` has to be
  // told not to merge (see lib/prDisposition.js).
  const mergeArg = (willOpenPR && (leavePrOpen || policyLeavesOpen)) ? ' --no-merge' : '';
  const reviewerArg = (reviewArgs ? ` ${reviewArgs}` : '') + mergeArg;
  const copilotOnly = reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && reviewUsernames.length === 0;
  const reviewerListLabel = [...reviewers, ...reviewUsernames.map(u => `@${u}`)].join(', ');
  const reviewSuffix = willOpenPR && runsReviewLoop
    ? (copilotOnly
        ? ' — `/do:pr` runs the Copilot review loop after the PR opens.'
        : ` — \`/do:pr\` runs the review loop for ${reviewerListLabel} in order after the PR opens.`)
    : (willOpenPR ? ' — external review is disabled for this task.' : '');
  // Reached only for a Claude TUI (a non-Claude one took the slashdoFree branch
  // above), so `/simplify` — a Claude Code built-in — is invokable here.
  const simplifyStep = simplifyEnabled ? '1. `/simplify`' : '1. (simplify disabled — skip)';
  const sentinelTail = willOpenPR ? '   ## PR\n   <PR URL>' : '   ## Branch\n   <branch name>';
  // A PR gets merge steps — gated on the review verdict when a loop runs, on CI
  // alone when it doesn't (nothing else merges a no-review-loop PR). The one
  // exception is a PR a human lands (JIRA-tracked; see lib/prDisposition.js).
  const merge = (willOpenPR && !leavePrOpen && !policyLeavesOpen)
    ? buildPostPRMergeSteps(3, { prCompletion, reviewers, usernames: reviewUsernames, reviewStopMode })
    : { lines: (leavePrOpen || policyLeavesOpen) && willOpenPR ? [LEAVE_PR_OPEN_STEP(3, leavePrOpen)] : [], nextStep: (leavePrOpen || policyLeavesOpen) && willOpenPR ? 4 : 3 };
  const sentinelStep = merge.nextStep;

  return [
    '## Completion Workflow',
    'When the task is complete, run these in order:',
    '',
    simplifyStep,
    `2. \`${cmd}${reviewerArg}\`${reviewSuffix}`,
    ...(effortNote ? [`   ${effortNote}`] : []),
    ...merge.lines,
    ...buildSentinelWriteSteps(sentinelStep, sentinelPath, sentinelTail)
  ].join('\n');
}

/**
 * Manual (slashdo-free) TUI completion-workflow block — for an OpenCode TUI that
 * does NOT load Claude Code slash commands and so can't run `/do:pr` / `/do:push`.
 * Drives a plain `git` commit → sentinel handshake. PortOS owns the post-exit
 * push / PR / review / merge lifecycle, just as it does for non-TUI providers
 * that cannot invoke project slash commands.
 *
 * Keeping PR creation system-owned also guarantees a real generated body rather
 * than `gh pr create --fill` producing an empty description from a one-line
 * commit, and lets the existing follow-up machinery run configured reviewers.
 */
function buildManualTuiCompletionSection({ willOpenPR, prCompletion = PR_COMPLETIONS.REVIEW_THEN_MERGE, simplifyEnabled, sentinelPath, leavePrOpen = false }) {
  const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
  const runsReviewLoop = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
  const simplifyStep = simplifyEnabled
    ? `1. Before committing, ${SIMPLIFY_INLINE_REVIEW} and fix any findings.`
    : '1. (simplify disabled — skip)';
  const sentinelTail = '   ## Branch\n   <branch name>';

  const lines = [
    '## Completion Workflow',
    'This provider does NOT have slashdo (`/do:*`) commands, so finish the handoff with plain `git`. Run these in order:',
    '',
    simplifyStep,
    '2. Stage only the files you changed (never `git add -A` / `git add .`) and commit with a conventional message (`feat:`/`fix:`/`breaking:` prefix, no Co-Authored-By annotations):',
    '',
    '   ```bash',
    '   git add <file> [<file> ...]',
    '   git commit -m "feat: <description>"',
    '   ```',
  ];

  let step = 3;
  if (willOpenPR) {
    const handoff = policyLeavesOpen
      ? 'PortOS will push the branch, create a pull request with your completion summary as its description, and leave it open for inspection.'
      : leavePrOpen
      ? 'PortOS will push the branch and create a pull request for the JIRA-linked human handoff.'
      : runsReviewLoop
        ? 'PortOS will push the branch, create a pull request with your completion summary as its description, run the configured reviewer follow-up, and merge only after review and CI pass.'
        : 'PortOS will push the branch, create a pull request with your completion summary as its description, and merge it once CI is green.';
    lines.push(`${step++}. Do NOT push, open, or merge a pull request yourself. ${handoff}`);
  } else {
    lines.push(`${step++}. Do NOT push this worktree branch yourself. PortOS will merge it back after completion.`);
  }

  lines.push(...buildSentinelWriteSteps(step, sentinelPath, sentinelTail));

  return lines.join('\n');
}

/**
 * CLI (non-TUI) completion block.
 *
 * Claude Code CLI agents have slashdo commands available (the submodule
 * mounts them as project-level slash commands), so when `hasSlashdo` is
 * true and a PR is expected, the agent owns the full `/simplify` → `/do:pr`
 * sequence and PortOS skips its post-exit push+PR. Codex/Antigravity and other
 * CLI providers fall through to the legacy commit-only block where PortOS
 * handles push+PR on exit.
 */
function buildCliCompletionSection({ worktreeInfo, willOpenPR, prCompletion = PR_COMPLETIONS.MERGE_ON_GREEN, hasSlashdo = false, simplifyEnabled = false, leavePrOpen = false, reviewers = DEFAULT_REVIEWERS, usernames = [], optionalReviewers = [], reviewerMaxRounds = {}, reviewerModels = {}, reviewerEfforts = {}, reviewStopMode = DEFAULT_REVIEW_STOP_MODE, reviewerApplies = false }) {
  const policyLeavesOpen = prCompletion === PR_COMPLETIONS.LEAVE_OPEN;
  const runsReviewLoop = prCompletion === PR_COMPLETIONS.REVIEW_THEN_MERGE;
  if (hasSlashdo && worktreeInfo && willOpenPR) {
    const lines = ['## Completion', 'When finished, run these in order:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    const { reviewUsernames, reviewArgs, effortNote } = resolveReviewInvocation({ willOpenPR, runsReviewLoop, reviewers, usernames, optionalReviewers, reviewerMaxRounds, reviewerModels, reviewerEfforts, reviewStopMode, reviewerApplies });
    // `--no-merge` overrides a saved slashdo `merge: true` default, which would
    // otherwise merge a PR this task must leave open (see lib/prDisposition.js).
    const reviewerArg = (reviewArgs ? ` ${reviewArgs}` : '') + ((leavePrOpen || policyLeavesOpen) ? ' --no-merge' : '');
    const completionNote = runsReviewLoop
      ? ((reviewers.length === 1 && reviewers[0] === DEFAULT_REVIEWER && reviewUsernames.length === 0)
          ? 'and drives the Copilot review loop until clean.'
          : `and drives the review loop for ${[...reviewers, ...reviewUsernames.map(u => `@${u}`)].join(', ')} in order until clean.`)
      : 'with external review disabled.';
    lines.push(`${step++}. \`/do:pr${reviewerArg}\` — commits your changes, pushes the branch, and opens a pull request against the default branch ${completionNote}`);
    // Effort pins have no `--review-with` suffix to ride, so they're stated as an
    // instruction on the invocation instead (see buildReviewerEffortNote).
    if (effortNote) lines.push(`   ${effortNote}`);
    // Merge steps follow — review-gated with a loop, CI-gated without one — unless
    // this PR is a human's to land (JIRA-tracked; see lib/prDisposition.js).
    if (leavePrOpen || policyLeavesOpen) {
      lines.push(LEAVE_PR_OPEN_STEP(step, leavePrOpen));
    } else {
      const merge = buildPostPRMergeSteps(step, { prCompletion, reviewers, usernames: reviewUsernames, reviewStopMode });
      lines.push(...merge.lines);
    }
    return lines.join('\n');
  }
  if (hasSlashdo && worktreeInfo) {
    const lines = ['## Completion', 'When finished, run these in order:'];
    let step = 1;
    if (simplifyEnabled) {
      lines.push(`${step++}. \`/simplify\` — review the changed code for reuse, quality, and efficiency, and fix any findings.`);
    }
    lines.push(`${step++}. \`/do:push\` — commits your changes and pushes the branch.`);
    return lines.join('\n');
  }
  let body;
  if (worktreeInfo && willOpenPR) {
    body = 'Commit your changes (stage specific files, `feat:`/`fix:` prefix, no Co-Authored-By). Do NOT push — PortOS will push and open the PR after you exit.';
  } else if (worktreeInfo) {
    body = 'Commit your changes to this branch. PortOS will merge it back when the task completes.';
  } else {
    body = 'Commit and push your changes (`git pull --rebase && git push`, conventional commit prefix, no `git add -A`).';
  }
  // Non-slashdo CLIs (codex/antigravity) have no `/simplify` command; when the task
  // enabled simplify, inline the equivalent self-review so the quality pass still
  // runs before they commit.
  const simplifyLine = simplifyEnabled
    ? `Before committing, ${SIMPLIFY_INLINE_REVIEW} and fix any findings. `
    : '';
  return `## Completion\n${simplifyLine}${body}`;
}

/**
 * Get the workspace path for an app, or `null` when it can't be resolved.
 *
 * This used to substitute the PortOS repo root for every failure — registry
 * missing, app not found, app carrying no `repoPath` — which made an
 * unresolvable app indistinguishable from a working one: the agent quietly
 * wrote its files into the PortOS checkout and nothing said otherwise
 * (issue #3180). A downstream existence check can't recover that case either,
 * because the substituted root is a real directory.
 *
 * So this returns an explicit `null` sentinel and lets each caller decide
 * whether "no workspace" is legal for it (per the sentinel-and-validate rule in
 * CLAUDE.md — absent must not collapse into a valid-looking value). The reason
 * is logged here, where it's known.
 *
 * @returns {Promise<string|null>} the app's repoPath, or null if unresolvable
 */
export async function getAppWorkspace(appName) {
  const appsFile = join(ROOT_DIR, 'data/apps.json');
  const unresolved = (why) => { console.warn(`⚠️ ${why} — no agent workspace resolved`); return null; };

  const data = await readJSONFile(appsFile, null);
  if (!data) return unresolved(`No apps registry at ${appsFile}`);

  // Handle both object format { apps: { id: {...} } } and array format [...]
  const apps = data.apps || data;

  const app = Array.isArray(apps)
    ? apps.find(a => a.name === appName || a.id === appName)
    // Object format - keys are app IDs
    : (apps[appName] || Object.values(apps).find(a => a.name === appName));

  if (!app) return unresolved(`App '${appName}' not found in apps registry`);
  if (!app.repoPath) return unresolved(`App '${appName}' has no repoPath`);
  // Expand here, not just at the spawn boundary. Callers do more with this than
  // spawn into it: agentLifecycle persists it as an agent's `sourceWorkspace`,
  // and the worktree cleanup/merge paths later hand that value to a child
  // process as its cwd. Node never shell-expands `~`, so returning the raw
  // tilde form would let a task start (the spawn path expands) and then strand
  // its worktree and branch when cleanup runs against a path that doesn't exist.
  return expandHome(app.repoPath);
}

/**
 * Get full app data for a task (including jira config).
 * Returns the app object or null if not found.
 */
export async function getAppDataForTask(task) {
  const appName = task?.metadata?.app;
  if (!appName) return null;

  const appsFile = join(ROOT_DIR, 'data/apps.json');
  const data = await readJSONFile(appsFile, null);
  if (!data) return null;

  const apps = data.apps || data;

  if (Array.isArray(apps)) {
    return apps.find(a => a.name === appName || a.id === appName) || null;
  }

  return apps[appName] || Object.values(apps).find(a => a.name === appName) || null;
}

/**
 * Generate a concise JIRA ticket title from a task description using AI.
 * Falls back to truncated description on failure.
 */
export async function generateJiraTitle(description) {
  const fallback = `[CoS] ${(description || 'Automated task').substring(0, 120)}`;

  const provider = await getActiveProvider().catch(() => null);
  if (!provider) return fallback;

  const model = provider.defaultModel || provider.models?.[0];
  if (!model) return fallback;

  const prompt = `Generate a concise JIRA ticket title (max 80 chars) for this task. Output ONLY the title text, nothing else.\n\nTask: ${description}`;

  // Best-effort title — failures are non-fatal (the task still gets the
  // truncated-description fallback). 30s is the legacy cap; titles should
  // be near-instant, and a slow model shouldn't block task creation.
  const result = await runPromptThroughProvider({
    provider, prompt, source: 'jira-title', model, timeout: 30000,
  }).catch(err => {
    console.warn(`⚠️ JIRA title generation failed: ${err.message}`);
    return null;
  });
  if (!result) return fallback;

  const title = (result.text || '').trim().replace(/^["']|["']$/g, '');
  return title || fallback;
}

/**
 * Create a JIRA ticket for a task if the app has JIRA integration enabled.
 * Non-blocking — returns null on failure.
 * @returns {Promise<{ticketId: string, ticketUrl: string, summary: string}|null>}
 */
export async function createJiraTicketForTask(task, app) {
  const jira = app?.jira;
  if (!jira?.enabled || !jira.instanceId || !jira.projectKey) return null;

  const summary = await generateJiraTitle(task.description);
  const description = [
    `Automated task created by PortOS Chief of Staff.`,
    ``,
    `*Task ID:* ${task.id}`,
    `*Priority:* ${task.priority || 'MEDIUM'}`,
    `*App:* ${app.name || task.metadata?.app || 'unknown'}`,
    ``,
    `{quote}`,
    task.description || '',
    `{quote}`
  ].join('\n');

  const result = await jiraService.createTicket(jira.instanceId, {
    projectKey: jira.projectKey,
    summary,
    description,
    issueType: jira.issueType || 'Task',
    labels: jira.labels || [],
    assignee: jira.assignee,
    epicKey: jira.epicKey
  }).catch(err => {
    emitLog('warn', `Failed to create JIRA ticket: ${err.message}`, { taskId: task.id, app: app.name });
    return null;
  });

  if (!result?.ticketId) return null;

  emitLog('success', `Created JIRA ticket ${result.ticketId}`, {
    taskId: task.id,
    ticketId: result.ticketId,
    ticketUrl: result.url
  });

  return { ticketId: result.ticketId, ticketUrl: result.url, summary };
}

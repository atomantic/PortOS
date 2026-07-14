/**
 * Tests for the dry-run eligibility helpers in cosTaskGenerator.js.
 *
 * `selectDryRunAutoApproved` is the shared, non-mutating pass both spawn
 * engines (`dequeueNextTask` in cos.js and `evaluateTasks` here) use to log
 * exactly the auto-approved system tasks execute mode WOULD spawn — applying
 * the same global-slot / max-spawns / cooldown / per-project gates against
 * virtual capacity, without blocking, persisting, or emitting anything. The
 * pre-fix dry-run logged every auto-approved task regardless of eligibility
 * (over-report) and, in dequeue, stopped once user tasks filled the slots
 * (under-report). These tests pin both behaviors.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// buildJiraTicketTask resolves the claim-issue-jira prompt body (dynamic import)
// and the Code Review Defaults (static import). Mock both leaf services so the
// behavioral test below drives the assembly without touching disk/settings.
vi.mock('./taskPromptService.js', async (importActual) => ({
  ...(await importActual()),
  getTaskPrompt: vi.fn(async (key) => `# ${key}\nApp {appName} at {repoPath} (id {appId})\nReviewers: {reviewers}`),
}));
vi.mock('./codeReview.js', async (importActual) => ({
  ...(await importActual()),
  getCodeReviewDefaults: vi.fn(async () => ({ reviewers: ['copilot'], usernames: ['alice'], optionalReviewers: [] })),
}));

import { selectDryRunAutoApproved, exceedsMaxSpawns, resolveIssueAuthorFilterBlock, resolveSwarmBlock, isCooldownExemptTask, emitOnDemandEmpty, buildJiraTicketTask } from './cosTaskGenerator.js';
import { cosEvents } from './cosEvents.js';
import { MAX_TOTAL_SPAWNS } from '../lib/validation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GEN_SRC = readFileSync(join(__dirname, 'cosTaskGenerator.js'), 'utf-8');
const COS_SRC = readFileSync(join(__dirname, 'cos.js'), 'utf-8');

const task = (id, metadata = {}) => ({ id, metadata });
const noCooldown = () => Promise.resolve(false);

// The unit tests above exercise selectDryRunAutoApproved with synthetic hooks;
// these source-level guards pin that each ENGINE wires the hook set matching
// its own execute path — so a future edit can't silently swap or drop a hook.
// Both engines now share the `isCooldownExemptTask` predicate (pipeline
// continuations AND perpetual drains bypass the cooldown), so a dry-run plan
// matches its execute path; the only remaining asymmetry is `extraSkip`
// (dequeue's disabled-analysis-type gate), which evaluateTasks does not have.
describe('dry-run hook wiring matches each engine execute path', () => {
  // Isolate each engine's selectDryRunAutoApproved call site.
  const callSite = (src) => {
    // Anchor on the CALL (`await selectDryRunAutoApproved(`), not the function
    // definition (`export async function selectDryRunAutoApproved(`).
    const start = src.indexOf('await selectDryRunAutoApproved(');
    expect(start, 'selectDryRunAutoApproved must be called').toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('});', start) + 3);
  };

  it('dequeueNextTask (cos.js) passes the shared cooldownExempt AND extraSkip (disabled-analysis-type)', () => {
    const site = callSite(COS_SRC);
    expect(site).toContain('extraSkip: isDisabledAnalysisType');
    // dequeue must exempt perpetual/pipeline tasks from cooldown in its dry-run
    // plan too, mirroring its execute gate — otherwise the plan over-reports a
    // perpetual drain as "would skip (cooldown)" that execute actually spawns.
    expect(site).toContain('cooldownExempt: isCooldownExemptTask');
  });

  it('evaluateTasks (cosTaskGenerator.js) passes the shared cooldownExempt but NOT extraSkip', () => {
    const site = callSite(GEN_SRC);
    expect(site).toContain('cooldownExempt: isCooldownExemptTask');
    expect(site).not.toContain('extraSkip');
  });

  it('both engines gate their EXECUTE cooldown check on isCooldownExemptTask', () => {
    // The spawn gate (not just the dry-run planner) must consult the shared
    // predicate, or a perpetual task the refill queued is skipped at spawn time
    // until the 30-min window expires — the manually-triggered-drain stall.
    expect(COS_SRC).toMatch(/if\s*\(appId\s*&&\s*!isCooldownExemptTask\(task\)\)/);
    expect(GEN_SRC).toMatch(/if\s*\(appId\s*&&\s*!isCooldownExemptTask\(task\)\)/);
  });
});

// #1650: once a peer's claim/lease is visible via task-record federation, a
// task whose live lease belongs to ANOTHER instance must be skipped during
// candidate selection — BEFORE the engine emits `task:ready` + trackSpawn.
// Otherwise that peer-claimed task (often the highest-priority pick) consumes
// this instance's spawn slot every cycle (the spawn guard then returns null,
// spawning nothing) and starves later unclaimed tasks. Both spawn engines
// (dequeueNextTask in cos.js, evaluateTasks here) must apply it, in both their
// execute loops AND their dry-run plan.
describe('peer-claim skip during candidate selection (#1650)', () => {
  it('both engines import isHeldByOther from the shared claim module', () => {
    expect(COS_SRC).toContain("from './cosTaskClaim.js'");
    expect(COS_SRC).toMatch(/import\s*\{[^}]*isHeldByOther[^}]*\}\s*from\s*'\.\/cosTaskClaim\.js'/);
    expect(GEN_SRC).toMatch(/import\s*\{[^}]*isHeldByOther[^}]*\}\s*from\s*'\.\/cosTaskClaim\.js'/);
  });

  it('both engines resolve this instance id once per cycle via ensureInstanceId', () => {
    expect(COS_SRC).toContain('const instanceId = await ensureInstanceId();');
    expect(GEN_SRC).toContain('const instanceId = await ensureInstanceId();');
  });

  it('both engines skip peer-held tasks in their EXECUTE candidate loops', () => {
    // Each engine must have the live-lease skip in BOTH the user-task and the
    // auto-approved tiers — at least two execute-path skip sites per engine.
    const cosSkips = COS_SRC.match(/if\s*\(isHeldByOther\(task\.metadata,\s*instanceId\)\)/g) || [];
    const genSkips = GEN_SRC.match(/if\s*\(isHeldByOther\(task\.metadata,\s*instanceId\)\)/g) || [];
    expect(cosSkips.length).toBeGreaterThanOrEqual(2);
    expect(genSkips.length).toBeGreaterThanOrEqual(2);
  });

  it('both engines pass heldByOther into their dry-run plan so it matches execute', () => {
    expect(COS_SRC).toContain('heldByOther: (task) => isHeldByOther(task.metadata, instanceId)');
    expect(GEN_SRC).toContain('heldByOther: (task) => isHeldByOther(task.metadata, instanceId)');
  });
});

// isCooldownExemptTask is the single source of truth for "this task bypasses the
// per-app review cooldown." The perpetual-string case is the subtle one: a
// perpetual task is queued with `metadata.perpetual === true`, but that bare
// boolean round-trips through COS-TASKS.md as the STRING "true" (taskParser
// serializes non-object metadata via String()), and the spawn gate reads the
// re-parsed task — so a `=== true`-only check would miss exactly the task the
// gate sees.
describe('isCooldownExemptTask', () => {
  it('exempts pipeline continuations (currentStage > 0)', () => {
    expect(isCooldownExemptTask({ metadata: { pipeline: { currentStage: 2 } } })).toBe(true);
  });
  it('does NOT exempt a pipeline task still at stage 0', () => {
    expect(isCooldownExemptTask({ metadata: { pipeline: { currentStage: 0 } } })).toBe(false);
  });
  it('exempts a perpetual task as an in-memory boolean true', () => {
    expect(isCooldownExemptTask({ metadata: { perpetual: true } })).toBe(true);
  });
  it('exempts a perpetual task as the re-parsed string "true" (COS-TASKS.md round-trip)', () => {
    expect(isCooldownExemptTask({ metadata: { perpetual: 'true' } })).toBe(true);
  });
  it('does NOT exempt an ordinary app task', () => {
    expect(isCooldownExemptTask({ metadata: { app: 'app-1', analysisType: 'security-audit' } })).toBe(false);
  });
  it('is null-safe for a task with no metadata', () => {
    expect(isCooldownExemptTask(null)).toBe(false);
    expect(isCooldownExemptTask({})).toBe(false);
  });
});

// The `{reviewers}` prompt token is what tasks like claim-issue use to tell the
// agent which reviewers to run (the prompt drives the review loop directly, so
// this IS the operative reviewer list, not just display). It must fall back to
// the user's PortOS Code Review Defaults when the task didn't pin reviewers —
// not the bare `normalizeReviewers(metadata)` call, which silently reverts to
// hardcoded copilot. This guard pins the wiring against that regression.
describe('{reviewers} interpolation honors Code Review Defaults', () => {
  it('resolves getCodeReviewDefaults and passes them as the normalizeReviewers fallback', () => {
    expect(GEN_SRC).toContain("import { getCodeReviewDefaults } from './codeReview.js'");
    expect(GEN_SRC).toContain('normalizeReviewers(metadata, codeReviewDefaults?.reviewers)');
    // The bare two-arg-less form (which silently reverts to hardcoded copilot)
    // is the bug we are guarding against. `(?!,)` lets the legitimate two-arg
    // call through while still catching a regression to `normalizeReviewers(metadata)`.
    expect(GEN_SRC).not.toMatch(/normalizeReviewers\(metadata\)(?!,)/);
  });

  it('filters local-LLM reviewers out of the prompt token (no invocation instructions in claim/plan prompts)', () => {
    // lmstudio/ollama defaults must not reach {reviewers}: the claim/plan
    // prompts can't drive them, so the loop would stall. The filtered list flows
    // into buildReviewersCsv, which owns the fallback to the hardcoded copilot
    // default when the filter empties the list (unit-tested in validation.test.js).
    expect(GEN_SRC).toContain('.filter((r) => !LOCAL_LLM_REVIEWERS.includes(r))');
    expect(GEN_SRC).toContain('buildReviewersCsv(promptReviewers, promptUsernames, promptOptionalReviewers)');
  });
});

// claim-work is the single-source router: one toggle that resolves the app's
// workTracker (default 'auto' → git origin host) and delegates to the matching
// claim prompt body — plan→plan-task, github→claim-issue, gitlab→claim-issue-gitlab,
// jira→claim-issue-jira. These source-level guards pin that wiring so a
// future edit can't silently drop the resolution, the delegated prompt
// selection, the PLAN gate routing, or the GitLab forge directive.
describe('claim-work single-source routing', () => {
  it('resolves the app work tracker and maps it to a concrete claim task type', () => {
    expect(GEN_SRC).toContain("taskType === 'claim-work'");
    expect(GEN_SRC).toContain('resolveAppWorkTracker, trackerToClaimTaskType');
    // Pin the call shape without coupling to the local variable name.
    expect(GEN_SRC).toMatch(/trackerToClaimTaskType\(\w+\.resolved\)/);
  });

  it('selects the delegated prompt body (promptTaskType), honoring a direct claim-work customization', () => {
    expect(GEN_SRC).toContain('promptKeyForBody');
    expect(GEN_SRC).toContain('await getTaskPrompt(promptKeyForBody)');
    // A claim-work customization (interval.prompt) wins; otherwise delegate.
    expect(GEN_SRC).toMatch(/promptKeyForBody\s*=\s*\(taskType === 'claim-work' && !interval\.prompt\)\s*\?\s*promptTaskType\s*:\s*taskType/);
  });

  it('gates PLAN.md on the RESOLVED type so a claim-work→plan run still skips an empty queue', () => {
    expect(GEN_SRC).toContain('applyPlanIdMetadata(promptTaskType,');
    // The only other occurrence is the function definition's parameter list;
    // the CALL must route the resolved type, never the raw 'claim-work' type.
    expect(GEN_SRC).not.toContain('await applyPlanIdMetadata(taskType,');
  });

  it('emits a GitLab (glab) author-filter directive for the claim-issue-gitlab body', () => {
    expect(GEN_SRC).toContain("promptTaskType === 'claim-issue-gitlab' ? 'glab'");
    expect(GEN_SRC).toContain('glab issue list');
  });

  it('pulls the delegated flow isolation posture from DEFAULT_TASK_INTERVALS metadata', () => {
    // claim-work forces useWorktree/openPR=false, correct for all four
    // self-managing claim prompts (plan/github/gitlab/jira). The hook stays so a
    // future delegated type that DOES need CoS-managed isolation would have its
    // DEFAULT_TASK_INTERVALS metadata applied here.
    expect(GEN_SRC).toContain('taskSchedule.DEFAULT_TASK_INTERVALS[promptTaskType]?.taskMetadata');
    expect(GEN_SRC).toContain("'useWorktree' in delegatedMeta");
    expect(GEN_SRC).toContain("'openPR' in delegatedMeta");
  });

  it('exposes buildClaimWorkTask so the manual /do:next button reuses the same router', () => {
    expect(GEN_SRC).toContain('export async function buildClaimWorkTask(');
    // Same tracker resolution + delegated isolation posture as the scheduler.
    expect(GEN_SRC).toMatch(/buildClaimWorkTask[\s\S]*resolveAppWorkTracker, trackerToClaimTaskType/);
    expect(GEN_SRC).toMatch(/buildClaimWorkTask[\s\S]*resolveIssueAuthorFilterBlock\(promptTaskType/);
  });

  it('buildClaimWorkTask resolves issueAuthorFilter + reviewers from configured claim-work metadata (parity with scheduler)', () => {
    // The manual button must honor the app's configured Work Tracker behavior
    // (issueAuthorFilter:'any', non-Copilot reviewers), not force owner+copilot.
    const fn = GEN_SRC.slice(GEN_SRC.indexOf('export async function buildClaimWorkTask('));
    // Merges global schedule metadata then per-app overrides, same as the scheduler.
    expect(fn).toMatch(/getTaskInterval\('claim-work'\)/);
    expect(fn).toMatch(/getAppTaskTypeOverrides\(app\.id\)/);
    expect(fn).toMatch(/stripManagedAgentOptionsFromOverride\(\s*'claim-work'/);
    // issueAuthorFilter: explicit option > configured metadata > 'self'
    // (the slashdo /do:next --self security boundary).
    expect(fn).toMatch(/issueAuthorFilter \?\? metadata\.issueAuthorFilter \?\? 'self'/);
    // reviewers fall back to Code Review Defaults via normalizeReviewers, dropping local-LLM reviewers.
    expect(fn).toMatch(/normalizeReviewers\(metadata, codeReviewDefaults\?\.reviewers\)/);
    expect(fn).toMatch(/LOCAL_LLM_REVIEWERS\.includes/);
    // A direct claim-work prompt customization overrides the tracker body, same
    // as the scheduled router's promptKeyForBody selection.
    expect(fn).toMatch(/getTaskPrompt\(interval\.prompt \? 'claim-work' : promptTaskType\)/);
  });
});

// buildJiraTicketTask is the per-card "play" button's prompt assembly, extracted
// out of cosTaskRoutes.js so the route stays thin (validate → gate → assemble →
// queue) and the claim-reviewer + target-ticket logic lives next to
// buildClaimWorkTask. Exercised directly with mocked leaf services.
describe('buildJiraTicketTask', () => {
  const app = { id: 'acme', name: 'Acme App', repoPath: '/repos/acme' };

  it('substitutes app placeholders + reviewers and appends the target-ticket constraint', async () => {
    const { ticketKey, prompt, taskMetadata } = await buildJiraTicketTask(app, 'proj-1234');
    // Placeholders resolved from the app object.
    expect(prompt).toContain('App Acme App at /repos/acme (id acme)');
    // {reviewers} substituted (no literal placeholder left) with the Code Review
    // Defaults reviewer + @username token.
    expect(prompt).not.toContain('{reviewers}');
    expect(prompt).toContain('copilot');
    expect(prompt).toContain('@alice');
    // Target-ticket constraint pins the uppercased key.
    expect(prompt).toContain('## Target Ticket Constraint');
    expect(prompt).toContain('PROJ-1234');
    // Ticket key normalized to upper-case.
    expect(ticketKey).toBe('PROJ-1234');
    // claim-issue-jira self-manages worktree + PR.
    expect(taskMetadata).toEqual({ useWorktree: false, openPR: false });
  });

  it('is exported so the /tasks/jira-ticket route reuses the shared assembly', () => {
    expect(GEN_SRC).toContain('export async function buildJiraTicketTask(');
    // Routes the JIRA flow directly, not via buildClaimWorkTask.
    expect(GEN_SRC).toMatch(/buildJiraTicketTask[\s\S]*getTaskPrompt\('claim-issue-jira'\)/);
    expect(GEN_SRC).toMatch(/buildJiraTicketTask[\s\S]*buildTargetTicketBlock\(key\)/);
  });
});

// The {issueAuthorFilter} directive is shared by the scheduled claim-work router
// AND the manual /do:next button (buildClaimWorkTask), so it is a standalone
// pure helper. These exercise it directly rather than via source string.
describe('resolveIssueAuthorFilterBlock', () => {
  it('returns the gh forge directive for the github claim body', () => {
    expect(resolveIssueAuthorFilterBlock('claim-issue', 'owner')).toContain('gh issue list');
    expect(resolveIssueAuthorFilterBlock('claim-issue', 'any')).toContain('regardless of who filed it');
    // 'self' = the --self security boundary: --author "@me", refuse third-party issues.
    expect(resolveIssueAuthorFilterBlock('claim-issue', 'self')).toContain('--author "@me"');
  });

  it('returns the glab forge directive for the gitlab claim body', () => {
    expect(resolveIssueAuthorFilterBlock('claim-issue-gitlab', 'owner')).toContain('glab issue list');
    expect(resolveIssueAuthorFilterBlock('claim-issue-gitlab', 'any')).toContain('regardless of who opened it');
    // 'self' resolves the authenticated glab username (no @me token on GitLab).
    expect(resolveIssueAuthorFilterBlock('claim-issue-gitlab', 'self')).toContain('glab api user');
  });

  it('defaults to the gh block (harmless no-op) for plan/jira bodies and to self mode', () => {
    expect(resolveIssueAuthorFilterBlock('plan-task')).toContain('gh issue list');
    // Default (no mode) is the --self security boundary.
    expect(resolveIssueAuthorFilterBlock('claim-issue')).toContain('--author "@me"');
    // Unknown mode collapses to self, not owner/any.
    expect(resolveIssueAuthorFilterBlock('claim-issue', 'bogus')).toContain('--author "@me"');
  });
});

// resolveSwarmBlock is prepended to the claim-issue prompt when swarmCount turns
// on `/do:next --swarm` mode. Like the author filter, it's a standalone pure
// helper shared by the scheduled router and the manual /do:next button.
describe('resolveSwarmBlock', () => {
  it('returns empty (off) below the swarm minimum', () => {
    expect(resolveSwarmBlock('claim-issue', 0)).toBe('');
    expect(resolveSwarmBlock('claim-issue', 1)).toBe('');
    expect(resolveSwarmBlock('claim-issue', undefined)).toBe('');
    expect(resolveSwarmBlock('claim-issue', 3.5)).toBe('');
  });

  it('returns a gh swarm directive for the github claim body', () => {
    const block = resolveSwarmBlock('claim-issue', 3);
    expect(block).toContain('SWARM MODE');
    expect(block).toContain('--swarm=3');
    expect(block).toContain('3 independent issues');
    expect(block).toContain('gh pr merge');
    // Ends with a separator so the single-issue body reads as the per-agent flow.
    expect(block.trimEnd().endsWith('---')).toBe(true);
  });

  it('instructs the orchestrator to still write the completion sentinel after a swarm run', () => {
    // Swarm work ships via PRs with no working-tree change, so without an
    // explicit instruction the orchestrator skips the completion sentinel and
    // the CoS task hangs as if it never finished. Phase C must name the sentinel.
    const block = resolveSwarmBlock('claim-issue', 3);
    expect(block).toContain('.agent-done');
    expect(block).toContain('Completion Workflow');
  });

  it('returns a glab/MR swarm directive for the gitlab claim body', () => {
    const block = resolveSwarmBlock('claim-issue-gitlab', 4);
    expect(block).toContain('--swarm=4');
    expect(block).toContain('glab mr merge');
    expect(block).toContain('open the MR');
  });

  it('is a no-op for non-forge claim types (plan-task / jira have no swarm flow)', () => {
    expect(resolveSwarmBlock('plan-task', 6)).toBe('');
    expect(resolveSwarmBlock('claim-issue-jira', 6)).toBe('');
  });
});

// Source-level guard: the swarm block must be PREPENDED at both render sites
// (the scheduled dispatch and the manual buildClaimWorkTask), not gated behind
// an in-template placeholder — that's what keeps it an opt-in wrapper with no
// prompt-default version bump.
describe('swarm block wiring', () => {
  it('prepends resolveSwarmBlock(...) to the rendered prompt at both render sites', () => {
    const occurrences = GEN_SRC.match(/resolveSwarmBlock\(promptTaskType, metadata\.swarmCount\)/g) || [];
    expect(occurrences.length).toBe(2);
    expect(GEN_SRC).toContain('`${swarmBlock}${template}`');
    expect(GEN_SRC).toContain('`${swarmBlock}${promptTemplate}`');
  });
});

// A scheduled/self-improvement task with no configured model must NOT pin a
// hardcoded model literal — it must leave metadata.model unset so
// selectModelForTask resolves the ACTIVE provider's tier/default model at spawn
// time. A stale literal here once pinned `claude-opus-4-5-20251101`, which had
// dropped out of the claude-code-tui provider config, so the scheduler spawned
// `claude --model claude-opus-4-5-20251101` — a model the provider no longer
// listed. The only assignment to metadata.model in either generator must come
// from `interval.model`.
describe('improvement-task model is never a hardcoded literal', () => {
  it('does not assign a hardcoded claude-* model literal to metadata.model', () => {
    expect(GEN_SRC).not.toMatch(/metadata\.model\s*=\s*['"]claude-/);
  });

  it('sets metadata.model only from config-driven fields, never a string literal', () => {
    const assignments = GEN_SRC.match(/metadata\.model\s*=\s*[^;]+/g) || [];
    expect(assignments.length).toBeGreaterThan(0);
    for (const line of assignments) {
      // Every assignment must read from schedule/stage config (interval.model,
      // stage0.model, …) — never a bare quoted model id.
      expect(line).not.toMatch(/metadata\.model\s*=\s*['"]/);
      expect(line).toMatch(/metadata\.model\s*=\s*\w+\.model/);
    }
  });
});

describe('exceedsMaxSpawns', () => {
  it('is false below the ceiling and true at/above it — no mutation', () => {
    expect(exceedsMaxSpawns(task('a', { totalSpawnCount: 0 }))).toBe(false);
    expect(exceedsMaxSpawns(task('b', { totalSpawnCount: MAX_TOTAL_SPAWNS - 1 }))).toBe(false);
    expect(exceedsMaxSpawns(task('c', { totalSpawnCount: MAX_TOTAL_SPAWNS }))).toBe(true);
    expect(exceedsMaxSpawns(task('d', { totalSpawnCount: MAX_TOTAL_SPAWNS + 3 }))).toBe(true);
  });

  it('treats a missing/NaN totalSpawnCount as zero', () => {
    expect(exceedsMaxSpawns(task('a'))).toBe(false);
    expect(exceedsMaxSpawns(task('b', { totalSpawnCount: 'nope' }))).toBe(false);
  });
});

describe('selectDryRunAutoApproved', () => {
  const baseCtx = {
    availableSlots: 5,
    alreadySpawned: 0,
    perProjectLimit: 5,
    spawnProjectCounts: {},
    isOnCooldown: noCooldown
  };

  it('returns all tasks when nothing gates them out', async () => {
    const tasks = [task('1'), task('2'), task('3')];
    const out = await selectDryRunAutoApproved(tasks, baseCtx);
    expect(out.map(t => t.id)).toEqual(['1', '2', '3']);
  });

  it('stops at the global slot cap (does not over-report)', async () => {
    const tasks = [task('1'), task('2'), task('3'), task('4')];
    const out = await selectDryRunAutoApproved(tasks, { ...baseCtx, availableSlots: 2 });
    expect(out.map(t => t.id)).toEqual(['1', '2']);
  });

  it('honors slots already consumed by higher-priority picks (under-report fix)', async () => {
    // Two of three slots already taken by on-demand/user tasks → only one auto-approved fits.
    const tasks = [task('1'), task('2'), task('3')];
    const out = await selectDryRunAutoApproved(tasks, { ...baseCtx, availableSlots: 3, alreadySpawned: 2 });
    expect(out.map(t => t.id)).toEqual(['1']);
  });

  it('skips tasks that have hit the max-spawns ceiling', async () => {
    const tasks = [
      task('1', { totalSpawnCount: MAX_TOTAL_SPAWNS }),
      task('2', { totalSpawnCount: 1 }),
      task('3', { totalSpawnCount: MAX_TOTAL_SPAWNS + 1 })
    ];
    const out = await selectDryRunAutoApproved(tasks, baseCtx);
    expect(out.map(t => t.id)).toEqual(['2']);
  });

  it('skips tasks whose app is on cooldown', async () => {
    const tasks = [task('1', { app: 'appA' }), task('2', { app: 'appB' }), task('3')];
    const isOnCooldown = (appId) => Promise.resolve(appId === 'appA');
    const out = await selectDryRunAutoApproved(tasks, { ...baseCtx, isOnCooldown });
    expect(out.map(t => t.id)).toEqual(['2', '3']);
  });

  it('exempts cooldown when cooldownExempt returns true (pipeline continuation)', async () => {
    const tasks = [task('1', { app: 'appA', pipeline: { currentStage: 2 } })];
    const out = await selectDryRunAutoApproved(tasks, {
      ...baseCtx,
      isOnCooldown: () => Promise.resolve(true),
      cooldownExempt: (t) => t.metadata?.pipeline?.currentStage > 0
    });
    expect(out.map(t => t.id)).toEqual(['1']);
  });

  it('enforces the per-project cap including running agents', async () => {
    // appA already has 1 running; per-project limit is 2 → only one more appA task fits.
    const tasks = [task('1', { app: 'appA' }), task('2', { app: 'appA' }), task('3', { app: 'appB' })];
    const out = await selectDryRunAutoApproved(tasks, {
      ...baseCtx,
      perProjectLimit: 2,
      spawnProjectCounts: { appA: 1 }
    });
    expect(out.map(t => t.id)).toEqual(['1', '3']);
  });

  it('applies the engine-specific extraSkip gate (disabled analysis type)', async () => {
    const tasks = [task('1', { analysisType: 'security' }), task('2', { analysisType: 'perf' })];
    const out = await selectDryRunAutoApproved(tasks, {
      ...baseCtx,
      extraSkip: (t) => t.metadata?.analysisType === 'security'
    });
    expect(out.map(t => t.id)).toEqual(['2']);
  });

  it('skips tasks a federated peer holds a live lease on (#1650)', async () => {
    const tasks = [task('1', { claimedBy: 'peer' }), task('2'), task('3', { claimedBy: 'peer' })];
    const out = await selectDryRunAutoApproved(tasks, {
      ...baseCtx,
      heldByOther: (t) => t.metadata?.claimedBy === 'peer'
    });
    expect(out.map(t => t.id)).toEqual(['2']);
  });

  it('a peer-held task does not consume virtual project capacity (#1650 skip-before-increment)', async () => {
    // Both tasks on appX, per-project limit 1. Task 1 is peer-held → it must not
    // burn appX's only slot, so task 2 (claimable here) still fits.
    const tasks = [task('1', { app: 'appX', claimedBy: 'peer' }), task('2', { app: 'appX' })];
    const out = await selectDryRunAutoApproved(tasks, {
      ...baseCtx,
      perProjectLimit: 1,
      heldByOther: (t) => t.metadata?.claimedBy === 'peer'
    });
    expect(out.map(t => t.id)).toEqual(['2']);
  });

  it('does not mutate the passed-in spawnProjectCounts', async () => {
    const counts = { appA: 1 };
    await selectDryRunAutoApproved([task('1', { app: 'appA' })], { ...baseCtx, spawnProjectCounts: counts });
    expect(counts).toEqual({ appA: 1 });
  });

  it('returns nothing when no slots remain', async () => {
    const out = await selectDryRunAutoApproved([task('1')], { ...baseCtx, availableSlots: 3, alreadySpawned: 3 });
    expect(out).toEqual([]);
  });

  it('a skipped task does not consume virtual project capacity (skip-before-increment)', async () => {
    // Both tasks are on appX with a per-project limit of 1. Task 1 is gated out
    // (extraSkip) → it must NOT consume appX's only slot, so task 2 still fits.
    // If a skipped task counted toward capacity, task 2 would be wrongly dropped.
    const tasks = [task('1', { app: 'appX' }), task('2', { app: 'appX' })];
    const out = await selectDryRunAutoApproved(tasks, {
      ...baseCtx,
      perProjectLimit: 1,
      extraSkip: (t) => t.id === '1'
    });
    expect(out.map(t => t.id)).toEqual(['2']);
  });
});

// Layered Intelligence's on-demand feedback bridge (emitHandlerBackedOnDemand) was
// removed when LI migrated off the handler-backed path onto a normal agent task
// (see taskTypeHooks.js + layeredIntelligenceHooks.js). A "Run now" now generates a
// visible agent task (or the shared emitOnDemandEmpty no-dispatch feedback when the
// buildTaskInput hook skips), and the filing outcome surfaces via the agent + the
// app's lastRun bookkeeping — so the bespoke bridge is no longer needed.

describe('emitOnDemandEmpty', () => {
  // Minimal taskScheduleMod stub: no park (→ 'idle' for a non-perpetual type),
  // and the INTERVAL_TYPES enum the perpetual check reads.
  const stubMod = {
    getPerpetualParkInfo: async () => null,
    INTERVAL_TYPES: { PERPETUAL: 'perpetual' }
  };

  it("emits an 'idle' event with reason null for a non-LI task type", async () => {
    const events = [];
    const handler = (d) => events.push(d);
    cosEvents.on('schedule:on-demand-empty', handler);
    try {
      await emitOnDemandEmpty({
        taskScheduleMod: stubMod,
        request: { id: 'req-1', taskType: 'pr-watcher' },
        targetApp: { id: 'app-1', name: 'App One' },
        taskConfig: { type: 'custom' }
      });
    } finally {
      cosEvents.off('schedule:on-demand-empty', handler);
    }
    expect(events).toHaveLength(1);
    // A non-LI task type never reads a last-run reason (that read is LI-only).
    expect(events[0]).toMatchObject({ taskType: 'pr-watcher', outcome: 'idle', reason: null });
  });

  it('reads the LI last-run reason only for the layered-intelligence task type', () => {
    // Source-pinned (the behavioral read dynamic-imports the live app store):
    // the reason surfacing is gated on the LI task type + the 'idle' outcome and
    // reads the app's recorded lastRunReason.
    const idx = GEN_SRC.indexOf('export async function emitOnDemandEmpty');
    const body = GEN_SRC.slice(idx, idx + 1600);
    expect(body).toMatch(/request\.taskType === 'layered-intelligence'/);
    expect(body).toMatch(/layeredIntelligence\?\.lastRunReason/);
  });
});

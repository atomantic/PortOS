import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the heavy dependency graph so the hooks can be driven without a live LLM,
// forge, or app store. Each helper is a controllable spy set up per-test.
vi.mock('../apps.js', () => ({
  PORTOS_APP_ID: 'portos-default',
  getAppById: vi.fn(),
  updateAppLayeredIntelligence: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../../lib/workTracker.js', () => ({
  resolveAppWorkTracker: vi.fn().mockResolvedValue({ resolved: 'github', forge: 'gh' })
}));

vi.mock('../../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null)
}));

// The provider-type guard in buildTaskInput looks the pinned provider up to
// reject an api-only (harnessless) provider. Default to a CLI provider so the
// happy path passes; the dedicated test overrides it to an api provider.
vi.mock('../providers.js', () => ({
  getProviderById: vi.fn(async (id) => ({ id, type: 'cli' }))
}));

// When no per-app provider is pinned, the guard falls back to the global LI
// schedule provider via getTaskInterval. Default to no global pin so the
// no-provider path stays inert.
vi.mock('../taskSchedule.js', () => ({
  getTaskInterval: vi.fn(async () => ({ providerId: null, model: null }))
}));

vi.mock('../layeredIntelligence.js', () => ({
  getEffectiveConfig: vi.fn(() => ({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: {} })),
  buildPrompt: vi.fn(() => 'REASONING PROMPT'),
  gatherSources: vi.fn().mockResolvedValue({ goals: 'be great' }),
  listForgeIssues: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
  listBlockingIssues: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
  isAppParked: vi.fn(() => false),
  validateReasonerResponse: vi.fn(() => ({ proposal: null, pause: null })),
  isScopeAllowed: vi.fn(() => true),
  isProposalDuplicate: vi.fn(() => false),
  checkSemanticDuplicate: vi.fn().mockResolvedValue({ available: false, duplicate: false }),
  isHandoffEligible: vi.fn(() => false),
  buildHandoffTask: vi.fn(() => ({ description: 'handoff' })),
  filerForTracker: vi.fn((resolved) => (resolved === 'github' || resolved === 'gitlab') ? 'forge' : (resolved === 'jira' ? 'jira' : 'plan')),
  trackerSupportsPause: vi.fn((resolved) => resolved !== 'plan'),
  resolveBlockOnIssue: vi.fn(() => null),
  fileProposalToForge: vi.fn().mockResolvedValue({ success: true, number: 77 }),
  applyBlockingLabel: vi.fn().mockResolvedValue({ success: true }),
  appendProposalToPlan: vi.fn().mockResolvedValue({ success: true }),
  extractPlanSlugs: vi.fn(() => []),
  listJiraIssues: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
  listJiraBlockingIssues: vi.fn().mockResolvedValue({ ok: true, issues: [] }),
  fileProposalToJira: vi.fn().mockResolvedValue({ success: true, key: 'PROJ-1' }),
  resolveJiraBlockKey: vi.fn(() => null),
  applyJiraBlockingLabel: vi.fn().mockResolvedValue({ success: true }),
  computeOutcomesReport: vi.fn(() => ''),
  // selfEval (#2700). The summary's own semantics (signal sentinels, confidence,
  // degraded guidance) are unit-tested in layeredIntelligence.test.js; these are
  // spies so the hook's WIRING can be asserted — which inputs it feeds in.
  computeSelfEvalSummary: vi.fn(() => 'LI self-evaluation:\n- Reasoning confidence: low'),
  // Per-proposal-domain execution awareness (#2765). Semantics are unit-tested in
  // layeredIntelligence.test.js; a spy here so the hook's WIRING (computed from the
  // loaded outcomes and passed to buildPrompt) can be asserted.
  computeProposalExecutionAwareness: vi.fn(() => ''),
  // Cross-reference analysis (#2764 §3). Semantics are unit-tested in
  // layeredIntelligence.test.js; a spy here so the hook's WIRING (computed from the
  // loaded outcomes and passed to buildPrompt) can be asserted.
  computeCrossReferenceAnalysis: vi.fn(() => ''),
  // Hand-off routing gate (#2764 §4). Semantics are unit-tested in
  // layeredIntelligence.test.js; here it's a spy so the hook's WIRING (consulted
  // before enqueuing, suppressing on handoff:false) can be asserted. Defaults to
  // "allow the hand-off" so the existing hand-off path is unaffected.
  computeHandoffRouting: vi.fn(() => ({ handoff: true, reason: null })),
  readLiTaskMetrics: vi.fn().mockResolvedValue({ read: true, metrics: null }),
  // The predicate's own semantics (listing vs. either sentinel) are unit-tested in
  // layeredIntelligence.test.js; here it's a spy so the hook's WIRING can be
  // asserted — that the gathered plannedWork string is what gets classified.
  hasPlannedWorkListing: vi.fn((s) => typeof s === 'string' && !!s.trim())
}));

// Outcome-store I/O (#2428) — spies so the hook's feedback-loop wiring can be
// asserted without touching the real collection store on disk.
vi.mock('../layeredIntelligenceOutcomes.js', () => ({
  recordFiledProposal: vi.fn().mockResolvedValue(true),
  listOutcomesResult: vi.fn().mockResolvedValue({ read: true, outcomes: [] }),
  reconcileOutcomes: vi.fn().mockResolvedValue(0),
  // The routing gate (#2764 §4) reads the app's history lazily on the hand-off path.
  listOutcomes: vi.fn().mockResolvedValue([])
}));

import { buildTaskInput, processTaskOutput } from './layeredIntelligenceHooks.js';
import * as li from '../layeredIntelligence.js';
import { recordFiledProposal, listOutcomesResult, reconcileOutcomes, listOutcomes } from '../layeredIntelligenceOutcomes.js';
import * as apps from '../apps.js';
import { resolveAppWorkTracker } from '../../lib/workTracker.js';
import { tryReadFile } from '../../lib/fileUtils.js';
import { getProviderById } from '../providers.js';
import { getTaskInterval } from '../taskSchedule.js';

const APP = { id: 'app-1', name: 'App One', repoPath: '/repo', taskTypeOverrides: {} };

beforeEach(() => {
  vi.clearAllMocks();
  resolveAppWorkTracker.mockResolvedValue({ resolved: 'github', forge: 'gh' });
  getProviderById.mockImplementation(async (id) => ({ id, type: 'cli' }));
  getTaskInterval.mockResolvedValue({ providerId: null, model: null });
  li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: {} });
  li.filerForTracker.mockImplementation((r) => (r === 'github' || r === 'gitlab') ? 'forge' : (r === 'jira' ? 'jira' : 'plan'));
  li.trackerSupportsPause.mockImplementation((r) => r !== 'plan');
  li.listBlockingIssues.mockResolvedValue({ ok: true, issues: [] });
  li.listForgeIssues.mockResolvedValue({ ok: true, issues: [] });
  li.isAppParked.mockReturnValue(false);
});

describe('buildTaskInput', () => {
  it('skips with no-app when app is missing', async () => {
    expect(await buildTaskInput({})).toEqual({ skip: { reason: 'no-app' } });
  });

  it('skips a parked app before building a prompt', async () => {
    li.listBlockingIssues.mockResolvedValue({ ok: true, issues: [{ number: 5 }] });
    li.isAppParked.mockReturnValue(true);
    const res = await buildTaskInput({ app: APP });
    expect(res).toEqual({ skip: { reason: 'blocking-open' } });
    expect(li.gatherSources).not.toHaveBeenCalled();
  });

  it('skips when a failed blocking read could resume parked work', async () => {
    li.listBlockingIssues.mockResolvedValue({ ok: false, issues: [] });
    expect(await buildTaskInput({ app: APP })).toEqual({ skip: { reason: 'blocking-read-failed' } });
  });

  it('skips when the pinned provider is an api-only (harnessless) provider', async () => {
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api' });
    const res = await buildTaskInput({ app: APP });
    expect(res).toEqual({ skip: { reason: 'provider-not-agent-capable' } });
    // Short-circuits before any tracker/source I/O — nothing doomed is built.
    expect(li.gatherSources).not.toHaveBeenCalled();
    expect(li.listBlockingIssues).not.toHaveBeenCalled();
  });

  it('proceeds when neither a per-app nor a global provider is pinned (inherits the default coding agent)', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: null, model: null, allowedScopes: ['app-improvement'], sources: {} });
    const res = await buildTaskInput({ app: APP });
    expect(res.skip).toBeUndefined();
    // Falls back to the global schedule pin (none here), so no provider lookup.
    expect(getProviderById).not.toHaveBeenCalled();
    expect(res.prompt).toContain('REASONING PROMPT');
  });

  it('skips on an api-only GLOBAL schedule provider when no per-app provider is pinned', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: null, model: null, allowedScopes: ['app-improvement'], sources: {} });
    getTaskInterval.mockResolvedValue({ providerId: 'ollama', model: null });
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api' });
    const res = await buildTaskInput({ app: APP });
    expect(res).toEqual({ skip: { reason: 'provider-not-agent-capable' } });
    expect(getProviderById).toHaveBeenCalledWith('ollama');
  });

  it('self-heals a stale api per-app provider by adopting a CLI/TUI schedule pin (migration-184 residue)', async () => {
    // Per-app override carries an api provider (what migration 184 copied from the
    // pre-#2322 layeredIntelligence.providerId); the global Schedule page pins a
    // real CLI/TUI provider + its matched model. LI must run on the pin, not wedge.
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: {} });
    getTaskInterval.mockResolvedValue({ providerId: 'claude-ollama-tui', model: 'qwen3:35b' });
    getProviderById.mockImplementation(async (id) => ({ id, type: id === 'claude-ollama-tui' ? 'tui' : 'api' }));
    const res = await buildTaskInput({ app: APP });
    expect(res.skip).toBeUndefined();
    expect(res.prompt).toContain('REASONING PROMPT');
    // Healed to the pin's provider + its matched model (not the stale api pair).
    expect(res.providerId).toBe('claude-ollama-tui');
    expect(res.model).toBe('qwen3:35b');
  });

  it('skips (does not adopt) when the schedule pin references an unresolvable provider id', async () => {
    // Stale api per-app override + a schedule pin pointing at a provider that no
    // longer resolves (deleted/renamed). providerTypeOf(pin) → null; adopting it
    // would re-wedge on a doomed id, so the heal must fall through to the skip.
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: {} });
    getTaskInterval.mockResolvedValue({ providerId: 'ghost-provider', model: null });
    getProviderById.mockImplementation(async (id) => (id === 'ghost-provider' ? null : { id, type: 'api' }));
    const res = await buildTaskInput({ app: APP });
    expect(res).toEqual({ skip: { reason: 'provider-not-agent-capable' } });
    expect(li.gatherSources).not.toHaveBeenCalled();
  });

  it('still skips when the per-app AND the schedule pin are both api-only (no CLI/TUI anywhere)', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: {} });
    getTaskInterval.mockResolvedValue({ providerId: 'lmstudio', model: null });
    getProviderById.mockResolvedValue({ id: 'any', type: 'api' });
    const res = await buildTaskInput({ app: APP });
    expect(res).toEqual({ skip: { reason: 'provider-not-agent-capable' } });
    expect(li.gatherSources).not.toHaveBeenCalled();
  });

  it('keeps an explicit per-app model when the provider is absent but a non-api schedule pin resolves', async () => {
    // No per-app PROVIDER, but a per-app MODEL is set, and the global schedule pins
    // a real CLI provider. The resolved provider is the pin; the model must stay the
    // per-app model (matching the pre-refactor net spawn behavior), not the pin's.
    li.getEffectiveConfig.mockReturnValue({ providerId: null, model: 'my-model', allowedScopes: ['app-improvement'], sources: {} });
    getTaskInterval.mockResolvedValue({ providerId: 'claude-cli', model: 'pin-model' });
    getProviderById.mockImplementation(async (id) => ({ id, type: 'cli' }));
    const res = await buildTaskInput({ app: APP });
    expect(res.skip).toBeUndefined();
    expect(res.providerId).toBe('claude-cli');
    expect(res.model).toBe('my-model');
  });

  it('adopts the schedule pin provider + model when neither a per-app provider nor model is set', async () => {
    // No per-app provider AND no per-app model → the resolved provider/model are
    // both the pin's, so the hook fully owns the resolution (not delegated to the
    // generator's interval.providerId/model).
    li.getEffectiveConfig.mockReturnValue({ providerId: null, model: null, allowedScopes: ['app-improvement'], sources: {} });
    getTaskInterval.mockResolvedValue({ providerId: 'claude-cli', model: 'pin-model' });
    getProviderById.mockImplementation(async (id) => ({ id, type: 'cli' }));
    const res = await buildTaskInput({ app: APP });
    expect(res.skip).toBeUndefined();
    expect(res.providerId).toBe('claude-cli');
    expect(res.model).toBe('pin-model');
  });

  it('skips a jira-tracked app with no usable jira config', async () => {
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'jira', forge: null });
    const res = await buildTaskInput({ app: { ...APP, jira: { enabled: false } } });
    expect(res).toEqual({ skip: { reason: 'jira-not-configured' } });
  });

  it('returns the reasoning prompt + the app-chosen provider/model on the happy path', async () => {
    const res = await buildTaskInput({ app: APP });
    expect(res.skip).toBeUndefined();
    expect(res.prompt).toContain('REASONING PROMPT');
    // The completion contract instructing the agent to write .agent-done is appended.
    expect(res.prompt).toContain('.agent-done');
    expect(res.providerId).toBe('ollama');
    expect(res.model).toBe('qwen');
  });

  it('threads the resolved tracker coords into gatherSources so plannedWork can read the backlog (#2698)', async () => {
    // gatherSources has no way to know WHERE the app's work lives — the hook is
    // the only place the tracker is resolved, so it must hand it over or the
    // plannedWork source silently no-ops.
    await buildTaskInput({ app: APP });
    expect(li.gatherSources).toHaveBeenCalledWith(
      APP,
      expect.anything(),
      { tracker: { filer: 'forge', forgeCli: 'gh', cwd: '/repo', jira: null }, isPortos: expect.any(Boolean) }
    );
  });

  it('threads jira coords into gatherSources for a jira-tracked app (#2698)', async () => {
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'jira', forge: null });
    const jiraApp = { ...APP, jira: { enabled: true, instanceId: 'i1', projectKey: 'PROJ' } };
    await buildTaskInput({ app: jiraApp });
    expect(li.gatherSources).toHaveBeenCalledWith(
      jiraApp,
      expect.anything(),
      { tracker: expect.objectContaining({ filer: 'jira', jira: expect.objectContaining({ instanceId: 'i1', projectKey: 'PROJ' }) }), isPortos: expect.any(Boolean) }
    );
  });

  it('passes the gathered plannedWork source through to buildPrompt (#2698)', async () => {
    li.gatherSources.mockResolvedValue({ goals: 'be great', plannedWork: '2 item(s):\n- #3 Ship X' });
    await buildTaskInput({ app: APP });
    expect(li.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      sources: expect.objectContaining({ plannedWork: expect.stringContaining('#3 Ship X') })
    }));
  });

  it('classifies the gathered plannedWork string and tells computeOutcomesReport (#2698)', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { outcomes: true } });
    li.gatherSources.mockResolvedValue({ goals: 'g', plannedWork: '1 item(s):\n- #3 Ship X' });
    li.hasPlannedWorkListing.mockReturnValue(true);
    await buildTaskInput({ app: APP });
    // The gathered string — not some other value — is what gets classified.
    expect(li.hasPlannedWorkListing).toHaveBeenCalledWith('1 item(s):\n- #3 Ship X');
    expect(li.computeOutcomesReport).toHaveBeenCalledWith(expect.objectContaining({ hasPlannedWork: true }));

    // A sentinel (empty/unreadable tracker) or an absent source is NOT a listing:
    // the warning must not tell the reasoner to go review a backlog that isn't there.
    li.computeOutcomesReport.mockClear();
    li.hasPlannedWorkListing.mockReturnValue(false);
    await buildTaskInput({ app: APP });
    expect(li.computeOutcomesReport).toHaveBeenCalledWith(expect.objectContaining({ hasPlannedWork: false }));
  });

  it('skips the outcomes feedback loop when the source toggle is off', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: {} });
    await buildTaskInput({ app: APP });
    expect(reconcileOutcomes).not.toHaveBeenCalled();
    expect(listOutcomesResult).not.toHaveBeenCalled();
    expect(li.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({ outcomesReport: '' }));
  });

  it('reconciles + folds the outcomes report into the prompt when enabled', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { outcomes: true } });
    listOutcomesResult.mockResolvedValue({ read: true, outcomes: [{ slug: 's', outcome: 'merged', scope: 'app-improvement' }] });
    li.computeOutcomesReport.mockReturnValue('Recent LI proposals:\n- Total filed: 1');
    await buildTaskInput({ app: APP });
    expect(reconcileOutcomes).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-1' }));
    expect(listOutcomesResult).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-1' }));
    expect(li.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({ outcomesReport: expect.stringContaining('Total filed: 1') }));
  });

  it('skips selfEval when the source toggle is off (#2700)', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: {} });
    await buildTaskInput({ app: APP });
    expect(li.computeSelfEvalSummary).not.toHaveBeenCalled();
    expect(li.readLiTaskMetrics).not.toHaveBeenCalled();
    expect(li.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({ selfEvalReport: '' }));
  });

  it('folds the selfEval summary into the prompt when enabled (#2700)', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { selfEval: true } });
    li.computeSelfEvalSummary.mockReturnValue('LI self-evaluation:\n- Reasoning confidence: high');
    await buildTaskInput({ app: APP });
    expect(li.readLiTaskMetrics).toHaveBeenCalled();
    expect(li.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({
      selfEvalReport: expect.stringContaining('Reasoning confidence: high')
    }));
  });

  it('passes outcomes to selfEval as null (not []) when the outcomes source is off (#2700)', async () => {
    // The sentinel that keeps "we never gathered outcomes" from reaching the
    // reasoner as "this app has never had a proposal merged".
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { selfEval: true } });
    await buildTaskInput({ app: APP });
    expect(li.computeSelfEvalSummary).toHaveBeenCalledWith(expect.objectContaining({ outcomes: null }));
  });

  it('passes the gathered outcomes to selfEval when both sources are on (#2700)', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { outcomes: true, selfEval: true } });
    listOutcomesResult.mockResolvedValue({ read: true, outcomes: [{ slug: 's', outcome: 'merged', scope: 'app-improvement' }] });
    await buildTaskInput({ app: APP });
    expect(li.computeSelfEvalSummary).toHaveBeenCalledWith(expect.objectContaining({
      outcomes: [{ slug: 's', outcome: 'merged', scope: 'app-improvement' }]
    }));
  });

  it('passes outcomes to selfEval as null when the outcome STORE could not be read (#2700)', async () => {
    // An unreadable store must not reach the reasoner as "you have never filed a
    // proposal" — that invites it to re-file work it already filed.
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { outcomes: true, selfEval: true } });
    listOutcomesResult.mockResolvedValue({ read: false, outcomes: [] });
    await buildTaskInput({ app: APP });
    expect(li.computeSelfEvalSummary).toHaveBeenCalledWith(expect.objectContaining({ outcomes: null }));
  });

  it('distinguishes a read-but-empty outcome store from an unreadable one (#2700)', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { outcomes: true, selfEval: true } });
    listOutcomesResult.mockResolvedValue({ read: true, outcomes: [] });
    await buildTaskInput({ app: APP });
    // Read fine, nothing filed → `[]`, NOT the null "unavailable" sentinel.
    expect(li.computeSelfEvalSummary).toHaveBeenCalledWith(expect.objectContaining({ outcomes: [] }));
  });

  it('passes existingIssues to selfEval, and null when the tracker read failed (#2700)', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { selfEval: true } });
    li.listForgeIssues.mockResolvedValue({ ok: true, issues: [{ slug: 'a', state: 'open' }] });
    await buildTaskInput({ app: APP });
    expect(li.computeSelfEvalSummary).toHaveBeenCalledWith(expect.objectContaining({
      existingIssues: [{ slug: 'a', state: 'open' }]
    }));

    // A blown read yields `[]` from readIssues — which must NOT reach selfEval as
    // "you have filed nothing", or it licenses a duplicate re-file off a blind read.
    li.computeSelfEvalSummary.mockClear();
    li.listForgeIssues.mockResolvedValue({ ok: false, issues: [] });
    await buildTaskInput({ app: APP });
    expect(li.computeSelfEvalSummary).toHaveBeenCalledWith(expect.objectContaining({ existingIssues: null }));
  });

  it('runs the feedback loop on a plan tracker when outcomes is enabled (#2435)', async () => {
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'plan', forge: null });
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { outcomes: true } });
    // The plan branch reads PLAN.md → a checked item reconciles like a forge issue.
    tryReadFile.mockResolvedValue('- [x] [lil-add-metrics] done');
    li.extractPlanSlugs.mockReturnValue([{ slug: 'add-metrics', state: 'closed' }]);
    listOutcomesResult.mockResolvedValue({ read: true, outcomes: [{ slug: 'add-metrics', outcome: 'merged', scope: 'app-improvement' }] });
    li.computeOutcomesReport.mockReturnValue('Recent LI proposals:\n- Total filed: 1');
    await buildTaskInput({ app: APP });
    expect(reconcileOutcomes).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'app-1',
      existingIssues: [{ slug: 'add-metrics', state: 'closed' }]
    }));
    expect(listOutcomesResult).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-1' }));
    expect(li.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({ outcomesReport: expect.stringContaining('Total filed: 1') }));
  });
});

describe('processTaskOutput', () => {
  beforeEach(() => {
    apps.getAppById.mockResolvedValue(APP);
  });

  it('records a no-op when the agent failed', async () => {
    const out = await processTaskOutput({ appId: 'app-1', success: false, payload: { proposal: {} } });
    expect(out).toMatchObject({ action: 'no-op', reason: 'agent-failed' });
    expect(apps.updateAppLayeredIntelligence).toHaveBeenCalledWith('app-1', expect.objectContaining({ lastRunAction: 'no-op' }));
    expect(li.fileProposalToForge).not.toHaveBeenCalled();
  });

  it('records unparseable-response when the payload is null', async () => {
    li.validateReasonerResponse.mockReturnValue({ proposal: null, pause: null });
    const out = await processTaskOutput({ appId: 'app-1', success: true, payload: null });
    expect(out).toMatchObject({ action: 'no-op', reason: 'unparseable-response' });
  });

  it('records unparseable-response when the payload parsed but is not a reasoner envelope (#2727)', async () => {
    // Garbage that still parses as JSON: a bare scalar/array, or an object carrying
    // none of the documented keys. All of it used to land on `no-proposal` — the
    // SAME reason a well-formed "nothing to propose" response gets — so garbage was
    // indistinguishable from a correct empty answer and got recorded as a
    // successful run. `{}` is reachable: the sentinel envelope only requires
    // `payload` to be an object.
    li.validateReasonerResponse.mockReturnValue({ proposal: null, pause: null });
    for (const payload of ['just some prose', 42, ['a', 'b'], true, {}, { foo: 1 }]) {
      const out = await processTaskOutput({ appId: 'app-1', success: true, payload });
      expect(out).toMatchObject({ action: 'no-op', reason: 'unparseable-response' });
    }
  });

  it('still records no-proposal for a well-formed envelope that proposes nothing (#2727)', async () => {
    // The other side of the sentinel: the reasoner answered correctly and simply
    // had nothing to file. That is a successful run, not malformed output. Any ONE
    // documented key makes it a real answer.
    li.validateReasonerResponse.mockReturnValue({ proposal: null, pause: null });
    for (const payload of [{ analysis: 'nothing worth proposing', proposal: null }, { proposal: null }, { analysis: '' }]) {
      const out = await processTaskOutput({ appId: 'app-1', success: true, payload });
      expect(out).toMatchObject({ action: 'no-op', reason: 'no-proposal' });
    }
  });

  it('records unparseable-response when a supplied proposal failed validation (#2727)', async () => {
    // The reasoner ATTEMPTED a proposal and emitted the wrong shape (no scope/title,
    // bad slug). That is malformed output, not "I looked and found nothing" — both
    // used to land on `no-proposal` and count as a successful run.
    li.validateReasonerResponse.mockReturnValue({ proposal: null, pause: null });
    const out = await processTaskOutput({ appId: 'app-1', success: true, payload: { analysis: 'x', proposal: { title: '' } } });
    expect(out).toMatchObject({ action: 'no-op', reason: 'unparseable-response' });
  });

  it('treats an explicit proposal:null as a legitimate empty answer, not malformed (#2727)', async () => {
    li.validateReasonerResponse.mockReturnValue({ proposal: null, pause: null });
    const out = await processTaskOutput({ appId: 'app-1', success: true, payload: { analysis: 'nothing to propose', proposal: null } });
    expect(out).toMatchObject({ action: 'no-op', reason: 'no-proposal' });
  });

  it('does not touch the tracker when there is no proposal to dedup (#2727)', async () => {
    // readIssues is an unbounded forge call and only the has-a-proposal branch
    // consumes it. Since the #2727 hoist the hook runs while the agent still holds
    // a CoS concurrency slot, so the common no-op path must not shell out to `gh`.
    li.validateReasonerResponse.mockReturnValue({ proposal: null, pause: null });
    li.listForgeIssues.mockClear();
    await processTaskOutput({ appId: 'app-1', success: true, payload: { analysis: 'nothing to do', proposal: null } });
    expect(li.listForgeIssues).not.toHaveBeenCalled();
    expect(li.fileProposalToForge).not.toHaveBeenCalled();
  });

  it('still reads the tracker to dedup when there IS a proposal (#2727)', async () => {
    // The other side of the scoping: the dedup read must still happen on the path
    // that consumes it, against FRESH tracker state.
    li.validateReasonerResponse.mockReturnValue({
      proposal: { scope: 'app-improvement', slug: 'fresh-idea', title: 'Fresh idea', body: 'x' },
      pause: null
    });
    li.listForgeIssues.mockClear();
    li.fileProposalToForge.mockResolvedValue({ success: true, number: 12 });
    await processTaskOutput({ appId: 'app-1', success: true, payload: { proposal: { slug: 'fresh-idea' } } });
    expect(li.listForgeIssues).toHaveBeenCalled();
  });

  it('files a fresh, in-scope proposal and records the ref', async () => {
    li.validateReasonerResponse.mockReturnValue({
      proposal: { scope: 'app-improvement', slug: 'add-telemetry', title: 'Add telemetry', body: 'do it' },
      pause: null
    });
    li.fileProposalToForge.mockResolvedValue({ success: true, number: 77 });
    const out = await processTaskOutput({ appId: 'app-1', success: true, payload: { proposal: {} } });
    expect(li.fileProposalToForge).toHaveBeenCalled();
    expect(out).toMatchObject({ action: 'filed', filedNumber: 77, reason: null });
    expect(apps.updateAppLayeredIntelligence).toHaveBeenCalledWith('app-1', expect.objectContaining({ lastRunAction: 'filed', lastRunRef: '#77' }));
  });

  it('records the filed proposal for the feedback loop only when outcomes is enabled', async () => {
    li.validateReasonerResponse.mockReturnValue({
      proposal: { scope: 'app-improvement', slug: 'add-telemetry', title: 'Add telemetry', body: 'do it' },
      pause: null
    });
    li.fileProposalToForge.mockResolvedValue({ success: true, number: 77 });

    // Off: no outcome record written.
    li.getEffectiveConfig.mockReturnValue({ allowedScopes: ['app-improvement'], sources: {} });
    await processTaskOutput({ appId: 'app-1', success: true, payload: { proposal: {} } });
    expect(recordFiledProposal).not.toHaveBeenCalled();

    // On: the filed proposal is recorded with its ref, scope, and tracker.
    li.getEffectiveConfig.mockReturnValue({ allowedScopes: ['app-improvement'], sources: { outcomes: true } });
    await processTaskOutput({ appId: 'app-1', success: true, payload: { proposal: {} } });
    expect(recordFiledProposal).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'app-1', slug: 'add-telemetry', issueRef: '#77', scope: 'app-improvement', tracker: 'github'
    }));
  });

  it('records a plan-filed proposal for the feedback loop (#2435)', async () => {
    // A `plan` tracker now reconciles outcomes too — a proposal appended to
    // PLAN.md is recorded so a later run can read back its checked/unchecked fate.
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'plan', forge: null });
    li.validateReasonerResponse.mockReturnValue({
      proposal: { scope: 'app-improvement', slug: 'add-metrics', title: 'Add metrics', body: 'do it' },
      pause: null
    });
    li.appendProposalToPlan.mockResolvedValue({ success: true });
    li.getEffectiveConfig.mockReturnValue({ allowedScopes: ['app-improvement'], sources: { outcomes: true } });
    const out = await processTaskOutput({ appId: 'app-1', success: true, payload: { proposal: {} } });
    expect(li.appendProposalToPlan).toHaveBeenCalled();
    expect(out).toMatchObject({ action: 'filed', reason: null });
    expect(recordFiledProposal).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'app-1', slug: 'add-metrics', scope: 'app-improvement', tracker: 'plan'
    }));
  });

  it('hands off a trivial+safe proposal in a healthy domain (routing allows) (#2764 §4)', async () => {
    li.validateReasonerResponse.mockReturnValue({
      proposal: { scope: 'app-improvement', slug: 'quick-fix', title: 'Quick fix', body: 'x', complexity: 'trivial', safe: true },
      pause: null
    });
    li.fileProposalToForge.mockResolvedValue({ success: true, number: 88 });
    li.isHandoffEligible.mockReturnValue(true);
    li.computeHandoffRouting.mockReturnValue({ handoff: true, reason: null });
    li.getEffectiveConfig.mockReturnValue({ allowedScopes: ['app-improvement'], sources: { outcomes: true }, handoff: { enabled: true } });
    const enqueueHandoff = vi.fn().mockResolvedValue({ id: 't-1', duplicate: false });
    const out = await processTaskOutput({ appId: 'app-1', success: true, payload: { proposal: {} } }, { enqueueHandoff });
    // The routing gate was consulted with the loaded history, then allowed the enqueue.
    expect(listOutcomes).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-1' }));
    expect(li.computeHandoffRouting).toHaveBeenCalled();
    expect(enqueueHandoff).toHaveBeenCalled();
    expect(out).toMatchObject({ action: 'filed', reason: null, handedOff: true, handoffRouted: false });
  });

  it('files but does NOT auto-hand-off a trivial+safe proposal in a chronically-failing domain (#2764 §4)', async () => {
    li.validateReasonerResponse.mockReturnValue({
      proposal: { scope: 'app-improvement', slug: 'risky-here', title: 'Risky here', body: 'x', complexity: 'trivial', safe: true },
      pause: null
    });
    li.fileProposalToForge.mockResolvedValue({ success: true, number: 89 });
    li.isHandoffEligible.mockReturnValue(true);
    // The domain's own hand-offs chronically fail → route to a human instead.
    li.computeHandoffRouting.mockReturnValue({
      handoff: false,
      domain: 'app-improvement',
      rate: 33,
      n: 3,
      cause: 'failing mostly on planning (2)',
      reason: 'app-improvement hand-offs succeed 33% over 3 executed — filing for human review instead of auto-hand-off (failing mostly on planning (2))'
    });
    li.getEffectiveConfig.mockReturnValue({ allowedScopes: ['app-improvement'], sources: { outcomes: true }, handoff: { enabled: true } });
    const enqueueHandoff = vi.fn().mockResolvedValue({ id: 't-2', duplicate: false });
    const out = await processTaskOutput({ appId: 'app-1', success: true, payload: { proposal: {} } }, { enqueueHandoff });
    // Filed for a human, but the coding agent was NOT enqueued.
    expect(li.fileProposalToForge).toHaveBeenCalled();
    expect(enqueueHandoff).not.toHaveBeenCalled();
    // The proposal WAS filed successfully — filing-for-human is the good outcome, not a failure.
    expect(out).toMatchObject({
      action: 'filed',
      reason: null,
      handedOff: false,
      handoffRouted: true,
      handoffRoutingReason: expect.stringContaining('filing for human review instead of auto-hand-off')
    });
  });

  it('reports a re-proposed already-tracked PLAN slug as duplicate without resetting its outcome (#2435)', async () => {
    // Since #2620 a checked `- [x]` item stays within the dedup window, so this
    // path normally never reaches the append. Belt-and-suspenders: should the
    // dedup guard ever miss, appendProposalToPlan writes nothing (tag already
    // present) and returns duplicate — the hook must NOT report `filed` or
    // record a fresh outcome.
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'plan', forge: null });
    li.validateReasonerResponse.mockReturnValue({
      proposal: { scope: 'app-improvement', slug: 'add-metrics', title: 'Add metrics', body: 'do it' },
      pause: null
    });
    li.isProposalDuplicate.mockReturnValue(false); // simulate a dedup-guard miss
    li.appendProposalToPlan.mockResolvedValue({ success: true, duplicate: true });
    li.getEffectiveConfig.mockReturnValue({ allowedScopes: ['app-improvement'], sources: { outcomes: true } });
    const out = await processTaskOutput({ appId: 'app-1', success: true, payload: { proposal: {} } });
    expect(out).toMatchObject({ action: 'duplicate', reason: 'duplicate' });
    expect(recordFiledProposal).not.toHaveBeenCalled();
  });

  it('suppresses an exact-duplicate proposal without filing', async () => {
    li.validateReasonerResponse.mockReturnValue({
      proposal: { scope: 'app-improvement', slug: 'dup', title: 'Dup', body: 'x' },
      pause: null
    });
    li.isProposalDuplicate.mockReturnValue(true);
    const out = await processTaskOutput({ appId: 'app-1', success: true, payload: { proposal: {} } });
    expect(li.fileProposalToForge).not.toHaveBeenCalled();
    expect(out).toMatchObject({ action: 'duplicate', reason: 'duplicate' });
  });

  it('suppresses filing when the tracker read failed (avoids a blind duplicate)', async () => {
    li.validateReasonerResponse.mockReturnValue({
      proposal: { scope: 'app-improvement', slug: 's', title: 'T', body: 'b' },
      pause: null
    });
    li.listForgeIssues.mockResolvedValue({ ok: false, issues: [] });
    const out = await processTaskOutput({ appId: 'app-1', success: true, payload: { proposal: {} } });
    expect(li.fileProposalToForge).not.toHaveBeenCalled();
    expect(out).toMatchObject({ action: 'tracker-read-failed', reason: 'tracker-read-failed' });
  });

  it('no-ops when the app cannot be loaded', async () => {
    apps.getAppById.mockResolvedValue(null);
    const out = await processTaskOutput({ appId: 'missing', success: true, payload: {} });
    expect(out).toEqual({ action: 'no-op', reason: 'app-not-found' });
  });
});

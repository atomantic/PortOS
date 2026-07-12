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
// schedule provider. Default to no global pin so the no-provider path stays inert.
vi.mock('../taskSchedule.js', () => ({
  loadSchedule: vi.fn(async () => ({ tasks: { 'layered-intelligence': {} } }))
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
  computeOutcomesReport: vi.fn(() => '')
}));

// Outcome-store I/O (#2428) — spies so the hook's feedback-loop wiring can be
// asserted without touching the real collection store on disk.
vi.mock('../layeredIntelligenceOutcomes.js', () => ({
  recordFiledProposal: vi.fn().mockResolvedValue(true),
  listOutcomes: vi.fn().mockResolvedValue([]),
  reconcileOutcomes: vi.fn().mockResolvedValue(0)
}));

import { buildTaskInput, processTaskOutput } from './layeredIntelligenceHooks.js';
import * as li from '../layeredIntelligence.js';
import { recordFiledProposal, listOutcomes, reconcileOutcomes } from '../layeredIntelligenceOutcomes.js';
import * as apps from '../apps.js';
import { resolveAppWorkTracker } from '../../lib/workTracker.js';
import { tryReadFile } from '../../lib/fileUtils.js';
import { getProviderById } from '../providers.js';
import { loadSchedule } from '../taskSchedule.js';

const APP = { id: 'app-1', name: 'App One', repoPath: '/repo', taskTypeOverrides: {} };

beforeEach(() => {
  vi.clearAllMocks();
  resolveAppWorkTracker.mockResolvedValue({ resolved: 'github', forge: 'gh' });
  getProviderById.mockImplementation(async (id) => ({ id, type: 'cli' }));
  loadSchedule.mockResolvedValue({ tasks: { 'layered-intelligence': {} } });
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
    loadSchedule.mockResolvedValue({ tasks: { 'layered-intelligence': { providerId: 'ollama' } } });
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api' });
    const res = await buildTaskInput({ app: APP });
    expect(res).toEqual({ skip: { reason: 'provider-not-agent-capable' } });
    expect(getProviderById).toHaveBeenCalledWith('ollama');
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

  it('skips the outcomes feedback loop when the source toggle is off', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: {} });
    await buildTaskInput({ app: APP });
    expect(reconcileOutcomes).not.toHaveBeenCalled();
    expect(listOutcomes).not.toHaveBeenCalled();
    expect(li.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({ outcomesReport: '' }));
  });

  it('reconciles + folds the outcomes report into the prompt when enabled', async () => {
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { outcomes: true } });
    listOutcomes.mockResolvedValue([{ slug: 's', outcome: 'merged', scope: 'app-improvement' }]);
    li.computeOutcomesReport.mockReturnValue('Recent LI proposals:\n- Total filed: 1');
    await buildTaskInput({ app: APP });
    expect(reconcileOutcomes).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-1' }));
    expect(listOutcomes).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-1' }));
    expect(li.buildPrompt).toHaveBeenCalledWith(expect.objectContaining({ outcomesReport: expect.stringContaining('Total filed: 1') }));
  });

  it('runs the feedback loop on a plan tracker when outcomes is enabled (#2435)', async () => {
    resolveAppWorkTracker.mockResolvedValue({ resolved: 'plan', forge: null });
    li.getEffectiveConfig.mockReturnValue({ providerId: 'ollama', model: 'qwen', allowedScopes: ['app-improvement'], sources: { outcomes: true } });
    // The plan branch reads PLAN.md → a checked item reconciles like a forge issue.
    tryReadFile.mockResolvedValue('- [x] [lil-add-metrics] done');
    li.extractPlanSlugs.mockReturnValue([{ slug: 'add-metrics', state: 'closed' }]);
    listOutcomes.mockResolvedValue([{ slug: 'add-metrics', outcome: 'merged', scope: 'app-improvement' }]);
    li.computeOutcomesReport.mockReturnValue('Recent LI proposals:\n- Total filed: 1');
    await buildTaskInput({ app: APP });
    expect(reconcileOutcomes).toHaveBeenCalledWith(expect.objectContaining({
      appId: 'app-1',
      existingIssues: [{ slug: 'add-metrics', state: 'closed' }]
    }));
    expect(listOutcomes).toHaveBeenCalledWith(expect.objectContaining({ appId: 'app-1' }));
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

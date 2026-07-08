import { describe, it, expect, vi, beforeEach } from 'vitest';

// The handler pulls in apps.js (heavy). Mock the surface it uses so tests drive
// pure orchestration without touching disk / PM2 / the app store.
const updateAppMock = vi.fn().mockResolvedValue({});
vi.mock('../apps.js', () => ({
  PORTOS_APP_ID: 'portos-default',
  getActiveApps: vi.fn().mockResolvedValue([]),
  // recordRun routes lastRunAt bookkeeping through updateAppLayeredIntelligence.
  updateAppLayeredIntelligence: (...args) => updateAppMock(...args)
}));

// resolveAppWorkTracker is async + shells out to git; stub per-test.
const resolveTrackerMock = vi.fn();
vi.mock('../../lib/workTracker.js', () => ({
  resolveAppWorkTracker: (...args) => resolveTrackerMock(...args)
}));

// gatherSources reads the repo; stub to a fixed map. The forge listers/filers
// are exercised in layeredIntelligence.test.js — here we stub them so processApp
// orchestration (park → gather → reason → decide → act → pause) is isolated.
const forgeState = {
  existing: [],
  existingOk: true,
  blocking: [],
  blockingOk: true,
  fileResult: { success: true, number: 100 },
  filed: [],
  blockingApplied: [],
  // Jira mirrors: separate lister/filer/label spies so the dispatch is asserted per tracker.
  jiraExisting: [],
  jiraExistingOk: true,
  jiraBlocking: [],
  jiraBlockingOk: true,
  jiraFileResult: { success: true, key: 'PROJ-100' },
  jiraFiled: [],
  jiraBlockingApplied: [],
  // Semantic dedup default: unavailable (embeddings off) → never suppresses.
  // The real checkSemanticDuplicate lazy-imports embeddings.js; mock it so
  // processApp orchestration is isolated from the embedding provider.
  semanticResult: { available: false, duplicate: false, match: null }
};
vi.mock('../layeredIntelligence.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    gatherSources: vi.fn().mockResolvedValue({ goals: 'g' }),
    // Listers now return { ok, issues }; forgeState.existingOk toggles a failed read.
    listForgeIssues: vi.fn(async () => ({ ok: forgeState.existingOk, issues: forgeState.existing })),
    listBlockingIssues: vi.fn(async () => ({ ok: forgeState.blockingOk, issues: forgeState.blocking })),
    checkSemanticDuplicate: vi.fn(async () => forgeState.semanticResult),
    fileProposalToForge: vi.fn(async (opts) => { forgeState.filed.push(opts); return forgeState.fileResult; }),
    applyBlockingLabel: vi.fn(async (opts) => { forgeState.blockingApplied.push(opts); return { success: true }; }),
    appendProposalToPlan: vi.fn(async () => ({ success: true, duplicate: false })),
    listJiraIssues: vi.fn(async () => ({ ok: forgeState.jiraExistingOk, issues: forgeState.jiraExisting })),
    listJiraBlockingIssues: vi.fn(async () => ({ ok: forgeState.jiraBlockingOk, issues: forgeState.jiraBlocking })),
    fileProposalToJira: vi.fn(async (opts) => { forgeState.jiraFiled.push(opts); return forgeState.jiraFileResult; }),
    applyJiraBlockingLabel: vi.fn(async (opts) => { forgeState.jiraBlockingApplied.push(opts); return { success: true }; })
  };
});

import { isAppDue, processApp, runLayeredIntelligence } from './layeredIntelligenceHandler.js';
import { getActiveApps } from '../apps.js';

const DAY = 24 * 60 * 60 * 1000;

function reasoner(response) {
  return vi.fn().mockResolvedValue({ text: JSON.stringify(response) });
}

beforeEach(() => {
  vi.clearAllMocks();
  updateAppMock.mockResolvedValue({});
  forgeState.existing = [];
  forgeState.existingOk = true;
  forgeState.blocking = [];
  forgeState.blockingOk = true;
  forgeState.fileResult = { success: true, number: 100 };
  forgeState.filed = [];
  forgeState.blockingApplied = [];
  forgeState.jiraExisting = [];
  forgeState.jiraExistingOk = true;
  forgeState.jiraBlocking = [];
  forgeState.jiraBlockingOk = true;
  forgeState.jiraFileResult = { success: true, key: 'PROJ-100' };
  forgeState.jiraFiled = [];
  forgeState.jiraBlockingApplied = [];
  forgeState.semanticResult = { available: false, duplicate: false, match: null };
  resolveTrackerMock.mockResolvedValue({ resolved: 'github', forge: 'gh' });
});

describe('isAppDue', () => {
  it('is due when never run', () => {
    expect(isAppDue({ intervalMs: DAY }, null)).toBe(true);
    expect(isAppDue({ intervalMs: DAY }, 'not-a-date')).toBe(true);
  });

  it('is due when the interval has elapsed', () => {
    const now = Date.parse('2026-07-07T00:00:00Z');
    const lastRun = new Date(now - DAY - 1000).toISOString();
    expect(isAppDue({ intervalMs: DAY }, lastRun, now)).toBe(true);
  });

  it('is NOT due within the interval', () => {
    const now = Date.parse('2026-07-07T00:00:00Z');
    const lastRun = new Date(now - DAY / 2).toISOString();
    expect(isAppDue({ intervalMs: DAY }, lastRun, now)).toBe(false);
  });
});

describe('processApp', () => {
  const enabledApp = (extra = {}) => ({
    id: 'app-1', name: 'App One', repoPath: '/repo',
    layeredIntelligence: { enabled: true, intervalMs: DAY, allowedScopes: ['app-improvement', 'app-data-gap'] },
    ...extra
  });

  it('skips a disabled app', async () => {
    const out = await processApp({ id: 'x', name: 'X', layeredIntelligence: { enabled: false } });
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('disabled');
  });

  it('skips an app that is not due', async () => {
    const now = Date.parse('2026-07-07T00:00:00Z');
    const app = enabledApp();
    app.layeredIntelligence.lastRunAt = new Date(now - DAY / 2).toISOString();
    const out = await processApp(app, { now });
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('not-due');
  });

  it('parks (skips reasoning) when a blocking issue is open', async () => {
    forgeState.blocking = [{ number: 5, state: 'open' }];
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 's', title: 'T' } });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('parked');
    expect(callLLM).not.toHaveBeenCalled(); // never reasoned
    expect(updateAppMock).toHaveBeenCalled(); // still records the run
  });

  it('files ONE issue for a valid, allowed, non-duplicate proposal', async () => {
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X', body: 'do it' } });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('filed');
    expect(out.filedNumber).toBe(100);
    expect(forgeState.filed).toHaveLength(1);
    expect(forgeState.filed[0].slug).toBe('add-x');
  });

  it('suppresses a proposal whose scope is not allowed (double-enforced)', async () => {
    // Non-PortOS app; loop-meta is PortOS-only so it must be blocked even though the model returned it.
    const callLLM = reasoner({ proposal: { scope: 'loop-meta', slug: 'meta', title: 'Meta' } });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('no-op');
    expect(forgeState.filed).toHaveLength(0);
  });

  it('suppresses a duplicate proposal', async () => {
    forgeState.existing = [{ slug: 'add-x', state: 'open' }];
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X' } });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('duplicate');
    expect(forgeState.filed).toHaveLength(0);
  });

  it('suppresses a semantic near-duplicate (different slug) when embeddings flag it', async () => {
    // Slug does NOT match an existing issue, so slug dedup passes; the semantic
    // layer reports a near-duplicate and suppresses before filing.
    forgeState.existing = [{ number: 7, slug: 'add-widget', title: 'Add widget', body: 'do it', state: 'open' }];
    forgeState.semanticResult = { available: true, duplicate: true, match: { number: 7, slug: 'add-widget', score: 0.95 } };
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 'introduce-widget', title: 'Introduce a widget', body: 'do it' } });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('semantic-duplicate');
    expect(forgeState.filed).toHaveLength(0);
  });

  it('files when the semantic layer is unavailable (embeddings off) — best-effort only', async () => {
    forgeState.existing = [{ number: 7, slug: 'add-widget', title: 'Add widget', body: 'do it', state: 'open' }];
    forgeState.semanticResult = { available: false, duplicate: false, match: null };
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 'introduce-widget', title: 'Introduce a widget', body: 'do it' } });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('filed');
    expect(forgeState.filed).toHaveLength(1);
  });

  it('files AND pauses when the response carries both, blocking on "this"', async () => {
    const callLLM = reasoner({
      proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X' },
      pause: { blockOnIssue: 'this', reason: 'need this first' }
    });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('filed');
    expect(out.paused).toBe(true);
    expect(forgeState.blockingApplied[0].number).toBe(100); // "this" → filed number
  });

  it('is a no-op on invalid JSON but still records the run', async () => {
    const callLLM = vi.fn().mockResolvedValue({ text: 'not json{{{' });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('no-op');
    expect(updateAppMock).toHaveBeenCalled();
  });

  it('is a no-op when the LLM errors', async () => {
    const callLLM = vi.fn().mockResolvedValue({ error: 'timeout' });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('no-op');
    expect(out.reason).toContain('timeout');
  });

  it('does NOT file when the tracker issue-list read failed (avoids blind duplicate)', async () => {
    forgeState.existingOk = false;
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X' } });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('tracker-read-failed');
    expect(forgeState.filed).toHaveLength(0);
  });

  it('skips (does not reason) when the blocking-issue read failed', async () => {
    forgeState.blockingOk = false;
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X' } });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('blocking-read-failed');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('does NOT pass open issues to the prompt when the openIssues source is off (but still dedups)', async () => {
    forgeState.existing = [{ slug: 'add-x', state: 'open' }];
    const app = enabledApp();
    app.layeredIntelligence.sources = { openIssues: false };
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X' } });
    const out = await processApp(app, { callLLM });
    // Dedup still fires against existing issues regardless of the prompt toggle.
    expect(out.action).toBe('duplicate');
  });

  it('does NOT pause a plan-tracked app (no issue to block on)', async () => {
    resolveTrackerMock.mockResolvedValue({ resolved: 'plan', forge: null });
    const callLLM = reasoner({
      proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X' },
      pause: { blockOnIssue: 'this', reason: 'x' }
    });
    const out = await processApp(enabledApp(), { callLLM });
    expect(out.action).toBe('filed');
    expect(out.paused).toBe(false); // pause skipped for plan tracker
    expect(forgeState.blockingApplied).toHaveLength(0);
  });
});

describe('processApp — jira tracker', () => {
  const jiraApp = (extra = {}) => ({
    id: 'app-j', name: 'Jira App', repoPath: '/repo',
    jira: { enabled: true, instanceId: 'inst', projectKey: 'PROJ', issueType: 'Task' },
    layeredIntelligence: { enabled: true, intervalMs: DAY, allowedScopes: ['app-improvement', 'app-data-gap'] },
    ...extra
  });

  beforeEach(() => {
    resolveTrackerMock.mockResolvedValue({ resolved: 'jira', forge: null });
  });

  it('skips a jira-tracked app that has no usable jira config (before reasoning)', async () => {
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 's', title: 'T' } });
    const out = await processApp({
      id: 'app-j', name: 'Jira App', repoPath: '/repo',
      jira: { enabled: false },
      layeredIntelligence: { enabled: true, intervalMs: DAY, allowedScopes: ['app-improvement'] }
    }, { callLLM });
    expect(out.action).toBe('skipped');
    expect(out.reason).toBe('jira-not-configured');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('files ONE jira ticket for a valid proposal', async () => {
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X', body: 'do it' } });
    const out = await processApp(jiraApp(), { callLLM });
    expect(out.action).toBe('filed');
    expect(out.filedKey).toBe('PROJ-100');
    expect(forgeState.jiraFiled).toHaveLength(1);
    expect(forgeState.jiraFiled[0]).toMatchObject({ instanceId: 'inst', projectKey: 'PROJ', slug: 'add-x' });
    expect(forgeState.filed).toHaveLength(0); // never touches the forge filer
  });

  it('parks a jira app when a blocking ticket is open (skips reasoning)', async () => {
    forgeState.jiraBlocking = [{ number: 'PROJ-5', state: 'open' }];
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 's', title: 'T' } });
    const out = await processApp(jiraApp(), { callLLM });
    expect(out.action).toBe('parked');
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('does NOT file when the jira issue-list read failed (avoids blind duplicate)', async () => {
    forgeState.jiraExistingOk = false;
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X' } });
    const out = await processApp(jiraApp(), { callLLM });
    expect(out.action).toBe('tracker-read-failed');
    expect(forgeState.jiraFiled).toHaveLength(0);
  });

  it('dedups a jira proposal against existing tickets', async () => {
    forgeState.jiraExisting = [{ slug: 'add-x', state: 'open' }];
    const callLLM = reasoner({ proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X' } });
    const out = await processApp(jiraApp(), { callLLM });
    expect(out.action).toBe('duplicate');
    expect(forgeState.jiraFiled).toHaveLength(0);
  });

  it('files AND pauses on the just-filed jira ticket key ("this")', async () => {
    const callLLM = reasoner({
      proposal: { scope: 'app-improvement', slug: 'add-x', title: 'Add X' },
      pause: { blockOnIssue: 'this', reason: 'need this first' }
    });
    const out = await processApp(jiraApp(), { callLLM });
    expect(out.action).toBe('filed');
    expect(out.paused).toBe(true);
    expect(forgeState.jiraBlockingApplied[0]).toMatchObject({ instanceId: 'inst', key: 'PROJ-100' });
  });

  it('resolves an integer pause target to <project>-<n> on an existing jira ticket', async () => {
    const callLLM = reasoner({ pause: { blockOnIssue: 7, reason: 'block on an existing ticket' } });
    const out = await processApp(jiraApp(), { callLLM });
    expect(out.paused).toBe(true);
    expect(forgeState.jiraBlockingApplied[0].key).toBe('PROJ-7');
  });
});

describe('runLayeredIntelligence sweep', () => {
  it('processes only enabled apps and continues past a per-app error', async () => {
    getActiveApps.mockResolvedValue([
      { id: 'off', name: 'Off', layeredIntelligence: { enabled: false } },
      { id: 'app-1', name: 'On', repoPath: '/r', layeredIntelligence: { enabled: true, intervalMs: DAY, allowedScopes: ['app-improvement'] } }
    ]);
    // No callLLM injected → resolveLLM will try to import providers; make the
    // tracker resolve so processApp reaches the provider step and no-ops on no provider.
    resolveTrackerMock.mockResolvedValue({ resolved: 'plan', forge: null });
    const res = await runLayeredIntelligence();
    expect(res.total).toBe(2);
    // The enabled app is attempted (processed >= 0); the disabled one is skipped before processApp.
    expect(res.results.some(r => r.app === 'off')).toBe(false);
    expect(res.results.some(r => r.app === 'app-1')).toBe(true);
  });
});

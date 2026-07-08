import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
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
  resolveBlockOnIssue,
  filerForTracker,
  trackerSupportsPause,
  buildPrompt,
  extractPlanSlugs,
  appendProposalToPlan,
  gatherSources,
  customSourceKey,
  fetchHttpSource,
  runShellCommand,
  normalizeIssueState,
  listForgeIssues,
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
  summarizeLoopStatus
} from './layeredIntelligence.js';

describe('defaultLayeredIntelligenceConfig', () => {
  it('is off by default with all sources on', () => {
    const c = defaultLayeredIntelligenceConfig(false);
    expect(c.enabled).toBe(false);
    expect(c.sources.goals).toBe(true);
    expect(c.sources.cosMetrics).toBe(true);
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
});

describe('getEffectiveConfig', () => {
  it('returns defaults for an app with no stored config', () => {
    expect(getEffectiveConfig({ name: 'X' })).toEqual(defaultLayeredIntelligenceConfig(false));
  });

  it('merges sources one level deep (partial toggle does not wipe others)', () => {
    const c = getEffectiveConfig({ layeredIntelligence: { sources: { goals: false } } });
    expect(c.sources.goals).toBe(false);
    expect(c.sources.cosMetrics).toBe(true); // untouched default preserved
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
});

describe('summarizeLoopStatus (overview page shape)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.parse('2026-07-07T12:00:00Z');

  it('summarizes a never-run enabled app as due with no lastRun/nextDue', () => {
    const s = summarizeLoopStatus({
      app: { id: 'a1', name: 'App One', layeredIntelligence: { enabled: true, intervalMs: DAY } },
      now: NOW
    });
    expect(s).toMatchObject({ id: 'a1', name: 'App One', enabled: true, due: true, lastRunAt: null, nextDueAt: null });
    expect(s.sources).toMatchObject({ goals: true, customCount: 0 });
    expect(s.hasRules).toBe(false);
  });

  it('computes nextDueAt = lastRunAt + intervalMs and due=false before the interval elapses', () => {
    const lastRunAt = new Date(NOW - DAY / 2).toISOString();
    const s = summarizeLoopStatus({
      app: { id: 'a2', name: 'App Two', layeredIntelligence: { enabled: true, intervalMs: DAY, lastRunAt } },
      now: NOW
    });
    expect(s.lastRunAt).toBe(lastRunAt);
    expect(s.nextDueAt).toBe(new Date(Date.parse(lastRunAt) + DAY).toISOString());
    expect(s.due).toBe(false);
  });

  it('due is always false when the app is disabled, even past the interval', () => {
    const lastRunAt = new Date(NOW - 2 * DAY).toISOString();
    const s = summarizeLoopStatus({
      app: { id: 'a3', name: 'Off', layeredIntelligence: { enabled: false, intervalMs: DAY, lastRunAt } },
      now: NOW
    });
    expect(s.enabled).toBe(false);
    expect(s.due).toBe(false);
  });

  it('reduces rules to a boolean and never leaks the free text', () => {
    const s = summarizeLoopStatus({
      app: { id: 'a4', name: 'Ruled', layeredIntelligence: { enabled: true, rules: 'never add deps' } },
      now: NOW
    });
    expect(s.hasRules).toBe(true);
    expect(JSON.stringify(s)).not.toContain('never add deps');
  });

  it('surfaces PortOS scopes + custom source count', () => {
    const s = summarizeLoopStatus({
      app: { id: 'portos-default', name: 'PortOS', layeredIntelligence: { enabled: true, sources: { custom: [{ type: 'file', ref: 'x.md' }] } } },
      isPortos: true,
      now: NOW
    });
    expect(s.isPortos).toBe(true);
    expect(s.allowedScopes).toContain('portos-self');
    expect(s.sources.customCount).toBe(1);
  });

  it('falls back to the app id when name is missing', () => {
    expect(summarizeLoopStatus({ app: { id: 'no-name' }, now: NOW }).name).toBe('no-name');
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
});

describe('extractPlanSlugs', () => {
  it('collects lil-tagged slugs from PLAN.md content', () => {
    const plan = `## Next Up\n- [ ] [lil-add-metrics] Add metrics\n- [ ] [lil-fix-thing] Fix\n- [ ] [ref-watch-other] not ours`;
    expect(extractPlanSlugs(plan)).toEqual(['add-metrics', 'fix-thing']);
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
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: async () => 'remote body' });
    expect(await fetchHttpSource('https://example.com/x', { fetchImpl })).toBe('remote body');
  });
  it('rejects a non-http scheme without calling fetch', async () => {
    const fetchImpl = vi.fn();
    expect(await fetchHttpSource('file:///etc/hosts', { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('returns null on a non-ok response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, text: async () => 'nope' });
    expect(await fetchHttpSource('https://example.com/x', { fetchImpl })).toBeNull();
  });
  it('returns null when fetch throws (dead URL / timeout)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('boom'));
    expect(await fetchHttpSource('https://example.com/x', { fetchImpl })).toBeNull();
  });
});

describe('runShellCommand', () => {
  it('returns trimmed stdout on exit 0, running through the shell in cwd', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: '  out\n', stderr: '' });
    expect(await runShellCommand('echo out', { cwd: '/x', exec })).toBe('out');
    // bufferedSpawn signature: (cmd, args, { cwd, timeoutMs, shell })
    expect(exec).toHaveBeenCalledWith('echo out', [], expect.objectContaining({ cwd: '/x', shell: true }));
  });
  it('returns null on non-zero exit', async () => {
    const exec = vi.fn().mockResolvedValue({ code: 1, stdout: 'partial', stderr: 'err' });
    expect(await runShellCommand('false', { cwd: '/x', exec })).toBeNull();
  });
  it('returns null on a timed-out command (code -1)', async () => {
    const exec = vi.fn().mockResolvedValue({ code: -1, stdout: '', stderr: '', timedOut: true });
    expect(await runShellCommand('sleep 999', { cwd: '/x', exec })).toBeNull();
  });
  it('returns null on empty command without invoking exec', async () => {
    const exec = vi.fn();
    expect(await runShellCommand('   ', { cwd: '/x', exec })).toBeNull();
    expect(exec).not.toHaveBeenCalled();
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
    it('closed with unknown close time falls out of window', () => {
      expect(isIssueWithinDedupWindow({ state: 'closed' }, NOW)).toBe(false);
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

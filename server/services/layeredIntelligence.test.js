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
  isAppParked,
  validateReasonerResponse,
  resolveBlockOnIssue,
  filerForTracker,
  trackerSupportsPause,
  buildPrompt,
  extractPlanSlugs,
  appendProposalToPlan,
  gatherSources,
  fetchHttpSource,
  customSourceKey,
  normalizeIssueState,
  listForgeIssues,
  listBlockingIssues,
  fileProposalToForge,
  ensureForgeLabels,
  applyBlockingLabel,
  CLOSED_SUPPRESSION_MS,
  LI_LABEL,
  LI_BLOCKING_LABEL
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

  it('keys a file source by its label when one is set', async () => {
    await writeFile(join(dir, 'METRICS.md'), 'labeled content');
    const out = await gatherSources(
      { repoPath: dir },
      { sources: { custom: [{ type: 'file', ref: 'METRICS.md', label: 'Weekly Metrics' }] } }
    );
    expect(out['custom:Weekly Metrics']).toBe('labeled content');
    expect(out['custom:METRICS.md']).toBeUndefined();
  });
});

describe('customSourceKey', () => {
  it('keys each type by its identifying field', () => {
    expect(customSourceKey({ type: 'file', ref: 'a.md' })).toBe('custom:a.md');
    expect(customSourceKey({ type: 'http', url: 'https://x/y' })).toBe('custom:https://x/y');
    expect(customSourceKey({ type: 'cmd', cmd: 'git log' })).toBe('custom:git log');
  });

  it('prefers a non-blank label over the identifying field', () => {
    expect(customSourceKey({ type: 'http', url: 'https://x', label: 'Status' })).toBe('custom:Status');
    expect(customSourceKey({ type: 'cmd', cmd: 'x', label: '   ' })).toBe('custom:x');
  });

  it('returns null for unrecognized or empty sources', () => {
    expect(customSourceKey(null)).toBeNull();
    expect(customSourceKey({ type: 'file' })).toBeNull();
    expect(customSourceKey({ type: 'nope', ref: 'a' })).toBeNull();
  });
});

describe('fetchHttpSource', () => {
  it('returns response text on a 2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('body text') });
    expect(await fetchHttpSource('https://x', { fetchImpl })).toBe('body text');
    expect(fetchImpl).toHaveBeenCalledWith('https://x', expect.objectContaining({ redirect: 'follow' }));
  });

  it('returns null on a non-2xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('nope') });
    expect(await fetchHttpSource('https://x', { fetchImpl })).toBeNull();
  });

  it('returns null when fetch rejects (dead endpoint)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await fetchHttpSource('https://x', { fetchImpl })).toBeNull();
  });

  it('returns null when no fetch implementation is available', async () => {
    expect(await fetchHttpSource('https://x', { fetchImpl: undefined })).toBeNull();
  });
});

describe('gatherSources http/cmd custom sources', () => {
  it('includes an http source body under its key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve('coverage 91%') });
    const out = await gatherSources(
      { repoPath: '/repo' },
      { sources: { custom: [{ type: 'http', url: 'https://ci/metrics', label: 'CI' }] } },
      { fetchImpl }
    );
    expect(out['custom:CI']).toBe('coverage 91%');
  });

  it('omits an http source that returns no data', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('') });
    const out = await gatherSources(
      { repoPath: '/repo' },
      { sources: { custom: [{ type: 'http', url: 'https://ci/down' }] } },
      { fetchImpl }
    );
    expect(Object.keys(out).some(k => k.startsWith('custom:'))).toBe(false);
  });

  it('includes a cmd source stdout, running it in the repo dir', async () => {
    const runCommand = vi.fn().mockResolvedValue({ code: 0, stdout: 'a1b2c3 fix\n', stderr: '' });
    const out = await gatherSources(
      { repoPath: '/repo' },
      { sources: { custom: [{ type: 'cmd', cmd: 'git log --oneline -1' }] } },
      { runCommand }
    );
    expect(out['custom:git log --oneline -1']).toBe('a1b2c3 fix\n');
    expect(runCommand).toHaveBeenCalledWith('git log --oneline -1', { cwd: '/repo' });
  });

  it('omits a cmd source that exits non-zero', async () => {
    const runCommand = vi.fn().mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' });
    const out = await gatherSources(
      { repoPath: '/repo' },
      { sources: { custom: [{ type: 'cmd', cmd: 'false' }] } },
      { runCommand }
    );
    expect(Object.keys(out).some(k => k.startsWith('custom:'))).toBe(false);
  });

  it('clamps oversized http/cmd output to 8000 chars', async () => {
    const big = 'x'.repeat(9000);
    const out = await gatherSources(
      { repoPath: '/repo' },
      { sources: { custom: [
        { type: 'http', url: 'https://big', label: 'H' },
        { type: 'cmd', cmd: 'dump', label: 'C' }
      ] } },
      {
        fetchImpl: vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(big) }),
        runCommand: vi.fn().mockResolvedValue({ code: 0, stdout: big, stderr: '' })
      }
    );
    expect(out['custom:H']).toHaveLength(8000);
    expect(out['custom:C']).toHaveLength(8000);
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

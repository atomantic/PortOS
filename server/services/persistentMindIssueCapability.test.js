import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'os';

const mocks = vi.hoisted(() => ({
  root: {},
  apps: [],
  resolveAppForgeTarget: vi.fn(),
  listAppIssues: vi.fn(),
  execGh: vi.fn(),
  execGlab: vi.fn(),
  ensureForgeReachable: vi.fn(),
}));

vi.mock('./cosState.js', () => ({ loadState: vi.fn(async () => mocks.root) }));
vi.mock('./apps.js', () => ({ getActiveApps: vi.fn(async () => mocks.apps) }));
vi.mock('./appIssues.js', () => ({ listAppIssues: (...args) => mocks.listAppIssues(...args) }));
vi.mock('../lib/workTracker.js', () => ({
  resolveAppForgeTarget: (...args) => mocks.resolveAppForgeTarget(...args),
}));
vi.mock('./github.js', () => ({
  execGh: (...args) => mocks.execGh(...args),
  ensureForgeReachable: (...args) => mocks.ensureForgeReachable(...args),
}));
vi.mock('./gitlab.js', () => ({ execGlab: (...args) => mocks.execGlab(...args) }));

const managedApps = await import('./persistentMindManagedApps.js');
const {
  buildPersistentMindIssueCapabilityPrompt,
  filePersistentMindIssue,
  listPersistentMindIssues,
  readPersistentMindIssueCatalog,
} = await import('./persistentMindIssueCapability.js');

const GITHUB_APP = { id: 'demo-app', name: 'Demo App', repoPath: '/repos/demo' };
const PLAN_APP = { id: 'plan-app', name: 'Plan App', repoPath: '/repos/plan' };
const githubTarget = { forge: 'github', repoSpec: 'github.com/example/demo', apiHost: 'github.com', fullName: 'example/demo' };

const setCapabilities = (capabilities) => {
  mocks.root = {
    config: {
      persistentMindCapabilities: { schemaVersion: 10, ...capabilities },
      persistentMindProfile: { enabled: true, providerId: 'ollama', model: 'claude-opus-5' },
    },
  };
};

const openIssue = (overrides = {}) => ({
  number: 7,
  title: 'Existing tracked work',
  body: 'Already filed.',
  url: 'https://github.com/example/demo/issues/7',
  labels: [{ name: 'plan' }],
  assignees: [],
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

const okList = (issues) => ({ issues, reason: 'ok', transient: false, fullName: 'example/demo' });

const fileRequest = (overrides = {}) => ({
  appId: 'demo-app', title: 'Add a retry to the sync poller', body: 'Body prose.',
  model: 'medium', effort: 'high', ...overrides,
});

const ghArgsFor = (verb) => mocks.execGh.mock.calls.map(([args]) => args).filter((args) => args[0] === verb);

beforeEach(() => {
  vi.clearAllMocks();
  managedApps.__testing.resolveCache.clear();
  setCapabilities({ fileIssues: true });
  mocks.apps = [GITHUB_APP, PLAN_APP];
  mocks.resolveAppForgeTarget.mockImplementation(async (app) => (app.id === 'demo-app'
    ? { tracker: 'github', target: githubTarget }
    : { tracker: 'plan', target: null }));
  mocks.listAppIssues.mockResolvedValue(okList([]));
  mocks.ensureForgeReachable.mockResolvedValue({ ok: true });
  mocks.execGh.mockResolvedValue('https://github.com/example/demo/issues/42\n');
});

describe('persistent mind issue capability', () => {
  it('offers only granted, forge-tracked apps to the model', async () => {
    expect((await readPersistentMindIssueCatalog()).apps).toEqual([
      { id: 'demo-app', name: 'Demo App', forge: 'github', fullName: 'example/demo' },
    ]);
    expect((await readPersistentMindIssueCatalog({ allowedAppIds: ['plan-app'] })).apps).toEqual([]);
  });

  it('names the grant state and the authorized ids in the prompt', () => {
    expect(buildPersistentMindIssueCapabilityPrompt({ enabled: false })).toContain('OFF');
    const on = buildPersistentMindIssueCapabilityPrompt({ enabled: true, catalog: { apps: [{ id: 'demo-app', forge: 'github' }] } });
    expect(on).toContain('demo-app');
    expect(on).toMatch(/PREFERRED/);
    // The dispatch vocabulary is interpolated from the label registry, so a new
    // tier cannot leave the mind describing the old set.
    expect(on).toContain('light, medium, heavy, ultra');
    expect(on).toContain('low, medium, high, xhigh, max');
    expect(buildPersistentMindIssueCapabilityPrompt({ enabled: true, catalog: { apps: [] } }))
      .toMatch(/no authorized managed app/i);
  });

  it('refuses every request when the grant is off or the app is out of scope', async () => {
    setCapabilities({ fileIssues: false });
    expect(await filePersistentMindIssue(fileRequest())).toMatchObject({ ok: false, error: expect.stringMatching(/disabled/i) });
    expect(await listPersistentMindIssues({ appId: 'demo-app' })).toMatchObject({ ok: false });

    setCapabilities({ fileIssues: true, allowedAppIds: ['other-app'] });
    expect(await filePersistentMindIssue(fileRequest())).toMatchObject({ ok: false, error: expect.stringMatching(/not authorized/i) });

    setCapabilities({ fileIssues: true });
    expect(await filePersistentMindIssue(fileRequest({ appId: 'plan-app' })))
      .toMatchObject({ ok: false, error: expect.stringMatching(/no GitHub or GitLab issue list/i) });
    expect(mocks.execGh).not.toHaveBeenCalled();
  });

  it('files with both dispatch axes, the attribution labels, and the chosen category', async () => {
    const result = await filePersistentMindIssue(fileRequest({ labels: ['plan'] }));

    expect(result).toMatchObject({ ok: true, duplicate: false, number: 42, url: 'https://github.com/example/demo/issues/42', forge: 'github' });
    expect(ghArgsFor('issue')).toEqual([[
      'issue', 'create', '--repo', 'github.com/example/demo',
      '--title', 'Add a retry to the sync poller', '--body', 'Body prose.',
      '--label', 'persistent-mind',
      '--label', 'model:medium',
      '--label', 'effort:high',
      // The planner axis records the model that WROTE the plan, independently
      // of the model:/effort: hints about how to RUN it.
      '--label', 'planner:opus-5',
      '--label', 'plan',
    ]]);
    // Both CLIs 422 the whole create on an undefined label, so every label is
    // created first.
    expect(ghArgsFor('label').map((args) => args[2])).toEqual(
      expect.arrayContaining(['persistent-mind', 'model:medium', 'effort:high', 'planner:opus-5', 'plan']),
    );
  });

  it('reuses an existing issue with the same title instead of filing a duplicate', async () => {
    mocks.listAppIssues.mockResolvedValue(okList([openIssue({ title: 'Add a Retry to the SYNC poller!' })]));

    expect(await filePersistentMindIssue(fileRequest())).toMatchObject({ ok: true, duplicate: true, number: 7 });
    expect(ghArgsFor('issue')).toEqual([]);
  });

  it('does not let two punctuation-only titles read as the same issue', async () => {
    // Both normalize to the empty title key, which must not count as a match.
    mocks.listAppIssues.mockResolvedValue(okList([openIssue({ title: '???' })]));

    expect(await filePersistentMindIssue(fileRequest({ title: '!!!' }))).toMatchObject({ ok: true, duplicate: false });
    expect(ghArgsFor('issue')).toHaveLength(1);
  });

  it('refuses to file when the tracker could not be read, rather than risking a duplicate', async () => {
    mocks.listAppIssues.mockResolvedValue({ issues: [], reason: 'fetch-failed', transient: true, remedy: 'check gh auth' });

    expect(await filePersistentMindIssue(fileRequest())).toMatchObject({ ok: false, error: expect.stringMatching(/nothing was filed/) });
    expect(ghArgsFor('issue')).toEqual([]);
  });

  it('stops at the reachability probe before spawning any label or issue call', async () => {
    mocks.ensureForgeReachable.mockResolvedValue({ ok: false, status: 'unauthenticated', remedy: 'run `gh auth login`' });

    expect(await filePersistentMindIssue(fileRequest())).toMatchObject({ ok: false, error: expect.stringContaining('gh auth login') });
    expect(mocks.execGh).not.toHaveBeenCalled();
    expect(mocks.listAppIssues).not.toHaveBeenCalled();
  });

  it('reports a forge create failure instead of claiming the issue exists', async () => {
    mocks.execGh.mockImplementation(async (args) => {
      if (args[0] === 'issue') throw new Error('GraphQL: Resource not accessible');
      return '';
    });

    expect(await filePersistentMindIssue(fileRequest())).toMatchObject({ ok: false, error: expect.stringContaining('Resource not accessible') });
  });

  it('lists open issues with a truncation signal and a working local filter', async () => {
    mocks.listAppIssues.mockResolvedValue(okList([
      openIssue({ number: 1, title: 'Sync poller retry', labels: [{ name: 'plan' }] }),
      openIssue({ number: 2, title: 'Unrelated', labels: [{ name: 'bug' }] }),
    ]));

    const all = await listPersistentMindIssues({ appId: 'demo-app' });
    expect(all).toMatchObject({ ok: true, forge: 'github', repository: 'example/demo', totalOpen: 2, truncated: false });
    expect(all.issues.map((issue) => issue.number)).toEqual([1, 2]);

    expect((await listPersistentMindIssues({ appId: 'demo-app', label: 'bug' })).issues.map((i) => i.number)).toEqual([2]);
    expect((await listPersistentMindIssues({ appId: 'demo-app', search: 'POLLER' })).issues.map((i) => i.number)).toEqual([1]);
    // A page cut short must say so — otherwise a partial read reads as the
    // whole backlog when the mind checks for an existing item.
    expect(await listPersistentMindIssues({ appId: 'demo-app', limit: 1 })).toMatchObject({ truncated: true, totalOpen: 2 });
  });

  it('surfaces an unreadable tracker as a failed read, never as an empty backlog', async () => {
    mocks.listAppIssues.mockResolvedValue({ issues: [], reason: 'gh-unauthenticated', transient: true, remedy: 'run `gh auth login`' });

    expect(await listPersistentMindIssues({ appId: 'demo-app' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('gh auth login') });
  });

  // #7366 — the Settings guardrail asserted that no repository paths or
  // credentials ride along, while title and body reached `gh issue create`
  // untouched. A filed issue is world-readable, so the assertion has to be
  // ENFORCED, not merely stated. `homedir()` is read at runtime rather than
  // written down: the value is the developer's own private data.
  describe('scrubs what the Settings guardrail promises', () => {
    const argValue = (args, flag) => args[args.indexOf(flag) + 1];

    it('strips the home-directory prefix and credential-shaped tokens before filing', async () => {
      const home = homedir();
      const result = await filePersistentMindIssue(fileRequest({
        title: `Sync fails under ${home}/work/demo`,
        body: `The poller retries with ghp_${'A'.repeat(36)} and dies.\nSee ${home}/logs/sync.log.`,
      }));
      expect(result.ok).toBe(true);

      const [args] = ghArgsFor('issue')[0] ? [ghArgsFor('issue')[0]] : [[]];
      const title = argValue(args, '--title');
      const body = argValue(args, '--body');
      expect(title).toBe('Sync fails under ~/work/demo');
      expect(title).not.toContain(home);
      expect(body).toContain('[REDACTED]');
      expect(body).not.toContain('ghp_');
      expect(body).not.toContain(home);
      expect(body).toContain('~/logs/sync.log');
    });

    it('dedupes on the SCRUBBED title, so a leaky title cannot re-file every wake', async () => {
      const home = homedir();
      mocks.listAppIssues.mockResolvedValue(okList([
        openIssue({ number: 12, title: 'Sync fails under ~/work/demo' }),
      ]));

      expect(await filePersistentMindIssue(fileRequest({
        title: `Sync fails under ${home}/work/demo`,
      }))).toMatchObject({ ok: true, duplicate: true, number: 12 });
      expect(ghArgsFor('issue')).toHaveLength(0);
    });

    it('leaves ordinary prose, repo-relative paths and short ids untouched', async () => {
      const body = 'server/services/sync.js drops job 4f2a on retry — see PR #118.';
      await filePersistentMindIssue(fileRequest({ title: 'Sync drops a job on retry', body }));
      expect(argValue(ghArgsFor('issue')[0], '--body')).toBe(body);
    });

    it('tells the model to keep private records out, since no filter can', () => {
      // The scrub is mechanical; "private record" is not decidable by regex, so
      // that half has to reach the model as an instruction or it is untrue.
      const prompt = buildPersistentMindIssueCapabilityPrompt({
        enabled: true, catalog: { apps: [{ id: 'demo-app', forge: 'github' }] },
      });
      expect(prompt).toContain('world-readable');
      expect(prompt).toContain('private record');
    });
  });

  it('files through glab for a GitLab-tracked app', async () => {
    mocks.resolveAppForgeTarget.mockResolvedValue({ tracker: 'gitlab', target: { forge: 'gitlab', fullName: 'example/demo' } });
    mocks.execGlab.mockResolvedValue('https://gitlab.com/example/demo/-/issues/11');

    expect(await filePersistentMindIssue(fileRequest())).toMatchObject({ ok: true, number: 11, forge: 'gitlab' });
    const create = mocks.execGlab.mock.calls.map(([args]) => args).find((args) => args[0] === 'issue');
    expect(create).toEqual(expect.arrayContaining(['--label', 'persistent-mind,model:medium,effort:high,planner:opus-5']));
    expect(mocks.execGh).not.toHaveBeenCalled();
  });
});

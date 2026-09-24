import { describe, it, expect, vi, beforeEach } from 'vitest';

const execGit = vi.fn();
const readdir = vi.fn();
const query = vi.fn();
const getAppTaskTypeOverrides = vi.fn();
const updateAppTaskTypeOverrides = vi.fn();
const loadSchedule = vi.fn();
const getAppById = vi.fn();

vi.mock('fs/promises', () => ({ readdir: (...args) => readdir(...args) }));
vi.mock('../lib/execGit.js', () => ({ execGit: (...args) => execGit(...args) }));
vi.mock('../lib/db.js', () => ({ query: (...args) => query(...args) }));
vi.mock('./apps.js', () => ({
  getAppById: (...args) => getAppById(...args),
  getAppTaskTypeOverrides: (...args) => getAppTaskTypeOverrides(...args),
  updateAppTaskTypeOverrides: (...args) => updateAppTaskTypeOverrides(...args),
}));
vi.mock('./taskScheduleStore.js', () => ({ loadSchedule: (...args) => loadSchedule(...args) }));

const {
  applyQualitySchedulePlan,
  buildQualitySchedulePlan,
  collectBusyOccupancies,
  detectRepoCapabilities,
  inapplicableAuditReason,
  resolveAuditApplicability,
  resolveQualityChecks,
} = await import('./appQualitySchedule.js');

// Each app gets its own repoPath so the module's capability cache — keyed by
// path — never carries one test's repository shape into the next.
let repoCounter = 0;
const appWith = (files, extra = {}) => {
  repoCounter += 1;
  execGit.mockResolvedValue({ exitCode: 0, stdout: files.join('\n'), stderr: '' });
  return { id: `app-${repoCounter}`, name: `App ${repoCounter}`, repoPath: `/repos/app-${repoCounter}`, ...extra };
};

const NODE_SERVICE = ['package.json', 'server/routes/things.js', 'server/services/things.js', 'server/services/things.test.js'];

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
  getAppTaskTypeOverrides.mockResolvedValue({});
  updateAppTaskTypeOverrides.mockResolvedValue({});
  loadSchedule.mockResolvedValue({ tasks: {} });
  readdir.mockResolvedValue([]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('audit applicability gate', () => {
  it('bails out of a UI audit for a pure API repository, keeps the service lenses', async () => {
    const app = appWith(NODE_SERVICE);
    expect(await resolveAuditApplicability(app, 'mobile-responsive')).toEqual({ applicable: false, reason: expect.stringMatching(/no user interface/) });
    expect(await resolveAuditApplicability(app, 'reliability')).toEqual({ applicable: true, reason: null });
    // Infrastructure needs deployment config, which this service lacks.
    expect((await resolveAuditApplicability(app, 'infrastructure')).applicable).toBe(false);
  });

  it('recognizes deployment configuration as infrastructure', async () => {
    for (const file of ['infra/main.tf', 'Dockerfile', 'deploy/values.yaml', '.github/workflows/ci.yml', 'ecosystem.config.cjs', 'charts/api/Chart.yaml']) {
      const { capabilities } = await detectRepoCapabilities(appWith(['package.json', file]));
      expect(capabilities.infrastructure, file).toBe(true);
    }
  });

  it('never gates non-audit work or an app without a checkout', async () => {
    expect(await resolveAuditApplicability(appWith(NODE_SERVICE), 'claim-issue')).toEqual({ applicable: true, reason: null });
    expect(await resolveAuditApplicability({ id: 'x', name: 'X' }, 'accessibility')).toEqual({ applicable: true, reason: null });
    expect(execGit).not.toHaveBeenCalled();
  });

  it('answers by app id for the sequencing lanes, and fails open when the app is unreadable', async () => {
    const app = appWith(NODE_SERVICE);
    getAppById.mockResolvedValueOnce(app);
    expect(await inapplicableAuditReason(app.id, 'accessibility')).toMatch(/no user interface/);
    getAppById.mockRejectedValueOnce(new Error('boom'));
    expect(await inapplicableAuditReason(app.id, 'accessibility')).toBeNull();
    expect(await inapplicableAuditReason(null, 'accessibility')).toBeNull();
  });
});

describe('resolveQualityChecks', () => {
  it('skips the UI audits for a repository that ships no interface', async () => {
    const { checks, capabilities } = await resolveQualityChecks(appWith(NODE_SERVICE));
    expect(capabilities.ui).toBe(false);
    const byType = Object.fromEntries(checks.map(check => [check.taskType, check]));
    expect(byType.accessibility.applicable).toBe(false);
    expect(byType.accessibility.reason).toMatch(/no user interface/);
    expect(byType['mobile-responsive'].applicable).toBe(false);
    // A server audit with no repo-shape requirement still applies.
    expect(byType.security.applicable).toBe(true);
    expect(byType['api-contract'].applicable).toBe(true);
  });

  it('serves only the fields the form renders', async () => {
    const { checks } = await resolveQualityChecks(appWith(NODE_SERVICE));
    expect(Object.keys(checks[0]).sort()).toEqual(['applicable', 'label', 'reason', 'taskType']);
  });

  it('keeps the UI audits when the app serves a UI port but compiles its front end away', async () => {
    const { checks } = await resolveQualityChecks(appWith(NODE_SERVICE, { uiPort: 5555 }));
    expect(checks.find(check => check.taskType === 'accessibility').applicable).toBe(true);
  });

  it('separates the two test lenses: coverage always applies, quality needs tests to assess', async () => {
    const { checks } = await resolveQualityChecks(appWith(['package.json', 'src/index.js']));
    const byType = Object.fromEntries(checks.map(check => [check.taskType, check]));
    expect(byType['test-coverage'].applicable).toBe(true);
    expect(byType['better-test-quality'].applicable).toBe(false);
  });

  it('lets an auditing agent that reported not-applicable overrule the path heuristics', async () => {
    query.mockResolvedValue({ rows: [{ category: 'security', assessed_at: new Date().toISOString(), report: { coverage: 'not-applicable' } }] });
    const { checks } = await resolveQualityChecks(appWith(NODE_SERVICE));
    const security = checks.find(check => check.taskType === 'security');
    expect(security.applicable).toBe(false);
    expect(security.reason).toMatch(/previous audit/);
  });

  // A repository that gained a UI (or a deployment manifest) since the ruling
  // must get the audit back once the ruling ages out.
  it('stops honoring a not-applicable ruling once it is older than the freshness window', async () => {
    query.mockResolvedValue({ rows: [{ category: 'security', assessed_at: new Date(Date.now() - 31 * 86400000).toISOString(), report: { coverage: 'not-applicable' } }] });
    const { checks } = await resolveQualityChecks(appWith(NODE_SERVICE));
    expect(checks.find(check => check.taskType === 'security').applicable).toBe(true);
  });

  it('recognizes a retired lifecycle category in stored applicability results', async () => {
    query.mockResolvedValue({ rows: [{ category: 'react-lifecycle', assessed_at: new Date().toISOString(), report: { coverage: 'not-applicable' } }] });
    const { checks } = await resolveQualityChecks(appWith(['package.json', 'src/App.jsx']));
    expect(checks.find(check => check.taskType === 'ui-lifecycle')).toMatchObject({
      applicable: false,
      reason: 'a previous audit reported this category as not applicable here',
    });
  });

  it('treats a repository it could only skim as unknown, not as empty', async () => {
    // `git ls-files` unavailable (not a checkout, git missing, timeout) falls
    // back to a two-level listing, which cannot see src/components/App.jsx.
    // Reading that miss as "no UI" would deselect seven audits for an app that
    // has one.
    execGit.mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'not a git repository' });
    readdir.mockResolvedValue([]);
    const { checks, complete } = await resolveQualityChecks({ id: 'skim', name: 'Skim', repoPath: '/repos/skim' });
    expect(complete).toBe(false);
    expect(checks.every(check => check.applicable)).toBe(true);
  });

  it('does not let one app’s uiPort decide a sibling app sharing the checkout', async () => {
    // The capability cache is keyed by repoPath; uiPort is a property of the
    // APP. Baking it into the cached value made a headless sibling read ui:true
    // for a minute and pre-select seven audits that can only answer N/A.
    execGit.mockResolvedValue({ exitCode: 0, stdout: NODE_SERVICE.join('\n'), stderr: '' });
    const shared = '/repos/shared-monorepo';
    const withUi = await detectRepoCapabilities({ id: 'a', repoPath: shared, uiPort: 5555 });
    const headless = await detectRepoCapabilities({ id: 'b', repoPath: shared });
    expect(withUi.capabilities.ui).toBe(true);
    expect(headless.capabilities.ui).toBe(false);
  });

});

describe('collectBusyOccupancies', () => {
  it('collects the global cadence and the perpetual recheck of types enabled here', async () => {
    loadSchedule.mockResolvedValue({
      tasks: {
        'release-check': { type: 'cron', enabled: true, cronExpression: '30 3 * * *' },
        'branch-reconcile': { type: 'on-demand', enabled: true, perpetual: true, recheckCron: '0 3 * * *' },
        'pr-reviewer': { type: 'cron', enabled: true, cronExpression: '0 8 * * *' },
      },
    });
    getAppTaskTypeOverrides.mockResolvedValue({
      'release-check': { enabled: true },
      'branch-reconcile': { enabled: true },
      // Enabled for the install but not for this app — its window is somebody
      // else's problem, so it must not cost this app an hour.
      'pr-reviewer': { enabled: false },
    });
    const sources = await collectBusyOccupancies({ id: 'a' });
    expect(sources.map(source => source.cron).sort()).toEqual(['0 3 * * *', '30 3 * * *']);
  });

  it('lets a per-app cadence REPLACE the global one, the way the scheduler reads it', async () => {
    loadSchedule.mockResolvedValue({ tasks: { 'release-check': { type: 'cron', enabled: true, cronExpression: '30 3 * * *' } } });
    getAppTaskTypeOverrides.mockResolvedValue({ 'release-check': { enabled: true, interval: '0 20 * * 1' } });
    const sources = await collectBusyOccupancies({ id: 'a' });
    // Blocking 03:00 as well would cost the plan four hours a day that this app
    // never runs anything in.
    expect(sources.map(source => source.cron)).toEqual(['0 20 * * 1']);
    expect(sources[0].origin).toBe('app');
  });

  it('decodes a retired named cadence rather than reading it as no cadence', async () => {
    loadSchedule.mockResolvedValue({ tasks: { 'release-check': { type: 'cron', enabled: true, cronExpression: '30 3 * * *' } } });
    getAppTaskTypeOverrides.mockResolvedValue({ 'release-check': { enabled: true, interval: 'weekly' } });
    const sources = await collectBusyOccupancies({ id: 'a' });
    // An override written by an older install still occupies its hour; treating
    // it as unparseable would schedule an audit straight over the release.
    expect(sources).toHaveLength(1);
    expect(sources[0].hours).toEqual([7]);
  });

  it('ignores the task types the plan is about to rewrite', async () => {
    loadSchedule.mockResolvedValue({ tasks: { security: { type: 'cron', enabled: true, cronExpression: '0 9 * * 1' } } });
    getAppTaskTypeOverrides.mockResolvedValue({ security: { enabled: true, interval: '0 9 * * 1' } });
    expect(await collectBusyOccupancies({ id: 'a' }, { ignoreTaskTypes: ['security'] })).toEqual([]);
  });
});

describe('buildQualitySchedulePlan', () => {
  it('plans only the applicable checks and works around the app release window', async () => {
    loadSchedule.mockResolvedValue({ tasks: { 'release-check': { type: 'cron', enabled: true, cronExpression: '30 3 * * *' } } });
    getAppTaskTypeOverrides.mockResolvedValue({ 'release-check': { enabled: true } });
    const app = appWith(NODE_SERVICE);
    const built = await buildQualitySchedulePlan(app);
    expect(built.plan.slots.map(slot => slot.taskType)).not.toContain('accessibility');
    expect(built.plan.slots.map(slot => slot.taskType)).toContain('security');
    for (const slot of built.plan.slots) expect([2, 3, 4, 5]).not.toContain(slot.hour);
    // The service owns the whole endpoint payload, so the route adds nothing.
    expect(built).toMatchObject({ appId: app.id, appName: app.name, claimTaskTypes: expect.arrayContaining(['claim-work']) });
    expect(built.busySources).toEqual([{ taskType: 'release-check', cron: '30 3 * * *', origin: 'global' }]);
  });

  it('plans exactly the checks the caller named, applicable or not', async () => {
    const { plan } = await buildQualitySchedulePlan(appWith(NODE_SERVICE), { taskTypes: ['accessibility', 'security'] });
    expect(plan.slots.map(slot => slot.taskType).sort()).toEqual(['accessibility', 'security']);
  });
});

describe('applyQualitySchedulePlan', () => {
  it('retires a claim drain an earlier plan planted when the drain is switched off', async () => {
    getAppTaskTypeOverrides.mockResolvedValue({ 'claim-work': { enabled: true, interval: '0 6,14 * * *' } });
    const app = appWith(NODE_SERVICE);
    await applyQualitySchedulePlan(app, { taskTypes: ['security'], claimBetween: false });
    const [, patches] = updateAppTaskTypeOverrides.mock.calls[0];
    // Without this the drain the form created keeps firing daily forever and
    // the form offers no way to undo it.
    expect(patches['claim-work']).toEqual({ enabled: false, interval: null });
  });

  it('retires the previous drain when the drain TYPE is switched', async () => {
    getAppTaskTypeOverrides.mockResolvedValue({ 'claim-work': { enabled: true, interval: '0 6,14 * * *' } });
    const app = appWith(NODE_SERVICE);
    await applyQualitySchedulePlan(app, { taskTypes: ['security'], fileIssues: true, claimTaskType: 'claim-issue' });
    const [, patches] = updateAppTaskTypeOverrides.mock.calls[0];
    expect(patches['claim-issue'].enabled).toBe(true);
    expect(patches['claim-work']).toEqual({ enabled: false, interval: null });
  });

  it('leaves a claim cadence a human set by hand alone', async () => {
    // A weekly cron is not a shape this planner emits, so it was not ours to
    // retire — clearing it would silently delete the user's own schedule.
    getAppTaskTypeOverrides.mockResolvedValue({ 'claim-work': { enabled: true, interval: '0 9 * * 1' } });
    const app = appWith(NODE_SERVICE);
    await applyQualitySchedulePlan(app, { taskTypes: ['security'], claimBetween: false });
    const [, patches] = updateAppTaskTypeOverrides.mock.calls[0];
    expect(patches['claim-work']).toBeUndefined();
  });


  it('writes the whole cadence in one patch: planned checks on, unplanned ones off', async () => {
    const app = appWith(NODE_SERVICE);
    const result = await applyQualitySchedulePlan(app, { taskTypes: ['security'], fileIssues: true });

    expect(updateAppTaskTypeOverrides).toHaveBeenCalledTimes(1);
    const [appId, patches] = updateAppTaskTypeOverrides.mock.calls[0];
    expect(appId).toBe(app.id);
    expect(patches.security).toEqual({ enabled: true, interval: expect.stringMatching(/^0 \d+ \* \* \d$/), taskMetadata: { fileIssues: true } });
    // A check dropped from the selection must stop running, and its stale cron
    // must not survive to revive on a later manual enable.
    expect(patches.ux).toEqual({ enabled: false, interval: null });
    expect(patches['claim-work'].enabled).toBe(true);
    expect(result.applied).toBe(2);
  });

  it('writes each audit\u2019s catalog delivery default when the form states no preference', async () => {
    const app = appWith(NODE_SERVICE);
    await applyQualitySchedulePlan(app, { taskTypes: ['security', 'ux'] });
    const [, patches] = updateAppTaskTypeOverrides.mock.calls[0];
    // security ships defaultFileIssues:false, ux ships true — a form-wide
    // default would have flattened both.
    expect(patches.security.taskMetadata).toEqual({ fileIssues: false });
    expect(patches.ux.taskMetadata).toEqual({ fileIssues: true });
  });

  it('keeps metadata the user set elsewhere and only overwrites the delivery mode', async () => {
    getAppTaskTypeOverrides.mockResolvedValue({ security: { enabled: true, taskMetadata: { fileIssues: true, reviewLoop: true } } });
    const app = appWith(NODE_SERVICE);
    await applyQualitySchedulePlan(app, { taskTypes: ['security'], fileIssuesByType: { security: false } });
    const [, patches] = updateAppTaskTypeOverrides.mock.calls[0];
    expect(patches.security.taskMetadata).toEqual({ fileIssues: false, reviewLoop: true });
  });

  it('writes no claim drain when every selected check implements its own fixes', async () => {
    const app = appWith(NODE_SERVICE);
    await applyQualitySchedulePlan(app, { taskTypes: ['security'], fileIssues: false });
    const [, patches] = updateAppTaskTypeOverrides.mock.calls[0];
    expect(patches['claim-work']).toBeUndefined();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

const execGit = vi.fn();
const query = vi.fn();
const getAppTaskTypeOverrides = vi.fn();
const updateAppTaskTypeOverrides = vi.fn();
const loadSchedule = vi.fn();

vi.mock('../lib/execGit.js', () => ({ execGit: (...args) => execGit(...args) }));
vi.mock('../lib/db.js', () => ({ query: (...args) => query(...args) }));
vi.mock('./apps.js', () => ({
  getAppTaskTypeOverrides: (...args) => getAppTaskTypeOverrides(...args),
  updateAppTaskTypeOverrides: (...args) => updateAppTaskTypeOverrides(...args),
}));
vi.mock('./taskScheduleStore.js', () => ({ loadSchedule: (...args) => loadSchedule(...args) }));

const {
  applyQualitySchedulePlan,
  buildQualitySchedulePlan,
  collectBusyOccupancies,
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
  vi.spyOn(console, 'log').mockImplementation(() => {});
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
    query.mockResolvedValue({ rows: [{ category: 'security', report: { coverage: 'not-applicable' } }] });
    const { checks } = await resolveQualityChecks(appWith(NODE_SERVICE));
    const security = checks.find(check => check.taskType === 'security');
    expect(security.applicable).toBe(false);
    expect(security.reason).toMatch(/previous audit/);
  });

  it('offers every check when the repository could not be scanned at all', async () => {
    execGit.mockResolvedValue({ exitCode: 128, stdout: '', stderr: 'not a git repository' });
    const { checks, scanned } = await resolveQualityChecks({ id: 'ghost', name: 'Ghost', repoPath: '/repos/missing' });
    expect(scanned).toBe(0);
    // Absent evidence must not read as "this repo has no UI" — that would
    // silently deselect most of the catalog over an unreadable path.
    expect(checks.every(check => check.applicable)).toBe(true);
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
  it('writes the whole cadence in one patch: planned checks on, unplanned ones off', async () => {
    const app = appWith(NODE_SERVICE);
    const result = await applyQualitySchedulePlan(app, { taskTypes: ['security'] });

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

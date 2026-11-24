import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'jira-reports-test-'));
const REPORTS_DIR = join(TEST_DATA_ROOT, 'jira-reports');
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

const search = vi.hoisted(() => vi.fn());
const getActiveApps = vi.hoisted(() => vi.fn());
vi.mock('./jira.js', () => ({
  getInstances: vi.fn(async () => ({ instances: { jira: { baseUrl: 'https://jira.example.com' } } })),
  createJiraClient: () => ({ search }),
  resolveCustomFieldIds: () => ({ storyPoints: 'customfield_1' }),
}));
vi.mock('./apps.js', () => ({ getActiveApps }));
vi.mock('./aiProvider.js', () => ({ callProviderAISimple: vi.fn() }));
vi.mock('./provider/providers.js', () => ({ getActiveProvider: vi.fn(async () => null), getAllProviders: vi.fn(async () => ({ providers: [] })) }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: vi.fn(async () => 'America/Los_Angeles') }));

const { generateAllReports, generateReport, getLatestReport, listReports } = await import('./jiraReports.js');

const app = (id) => ({ id, name: `App ${id}`, jira: { enabled: true, instanceId: 'jira', projectKey: 'EX' } });
const storeReport = (appId, date) => {
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, `${appId}-${date}.json`), JSON.stringify({ appId, date, appName: appId, summary: {} }));
};

beforeEach(() => {
  rmSync(REPORTS_DIR, { recursive: true, force: true });
  vi.useRealTimers();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  search.mockReset().mockResolvedValue({ data: { issues: [] } });
});
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('report dates', () => {
  it('files an evening report under the user\'s local day, not the next UTC day', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-03-18T01:30:00Z') });
    const report = await generateReport('one', app('one'));
    expect(report.date).toBe('2026-03-17');
    expect((await getLatestReport('one')).date).toBe('2026-03-17');
  });
});

describe('generateAllReports', () => {
  it('keeps the reports that worked and logs the app that failed', async () => {
    getActiveApps.mockResolvedValue([app('one'), app('two')]);
    search.mockRejectedValueOnce(new Error('JIRA 503'));
    const reports = await generateAllReports();
    expect(reports.map(r => r.appId)).toEqual(['two']);
    expect(console.error).toHaveBeenCalledWith('❌ JIRA status report failed for App one: JIRA 503');
  });

  it('reports the failure when no app succeeded instead of returning an empty success', async () => {
    getActiveApps.mockResolvedValue([app('one')]);
    search.mockRejectedValue(new Error('JIRA 503'));
    await expect(generateAllReports()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('JIRA 503') });
  });
});

describe('stored reports', () => {
  it('does not match another app whose id extends the requested one', async () => {
    storeReport('site', '2026-03-01');
    storeReport('site-admin', '2026-03-09');
    expect((await listReports('site')).map(r => r.appId)).toEqual(['site']);
    expect(await getLatestReport('site')).toMatchObject({ appId: 'site', date: '2026-03-01' });
    expect((await listReports()).map(r => r.appId)).toEqual(['site-admin', 'site']);
  });
});

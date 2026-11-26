import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { callRoute, hostControlApp, REMOTE_ADDRESS } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

const auth = vi.hoisted(() => ({ enabled: false }));
const peer = vi.hoisted(() => ({
  id: 'example-peer',
  instanceId: 'example-instance',
  syncSecret: 'example-pair-secret-0123456789-abcdef',
}));
const reads = vi.hoisted(() => ({
  listSubjects: vi.fn(async () => []),
  getSubject: vi.fn(async () => ({})),
  assertSubject: vi.fn(async () => ({})),
  listSubjectConsents: vi.fn(async () => []),
  getVaultStatus: vi.fn(async () => ({})),
  listVaultRecords: vi.fn(async () => []),
  getVaultRecord: vi.fn(async () => ({})),
  listWebsiteLogins: vi.fn(async () => []),
  listOrgs: vi.fn(async () => []),
  getOrgsBySocialAccounts: vi.fn(async () => []),
  getOrg: vi.fn(async () => ({})),
  getHoldingsForOrg: vi.fn(async () => []),
  listChangeEvents: vi.fn(async () => []),
  getChange: vi.fn(async () => ({})),
  listBrokerCases: vi.fn(async () => []),
  getScanStatus: vi.fn(async () => ({})),

  revealCaseEvidence: vi.fn(async () => ({ evidence: { matched_name: 'Example Person' } })),
  getOptOutDigest: vi.fn(async () => ({ items: [{ searchUrl: 'https://example.com/search' }] })),
  getAgentRecordingDownload: vi.fn(),
}));

const dataRoot = () => lazyTempDataRoot('portos-private-read-authority-');
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async (password) => password === 'example-password'),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [peer] })),
}));
vi.mock('../services/privacyBrokers.js', () => ({
  listBrokerCases: reads.listBrokerCases,
  getScanStatus: reads.getScanStatus,
  revealCaseEvidence: reads.revealCaseEvidence,
}));
vi.mock('../services/privacyOptOut.js', () => ({ getOptOutDigest: reads.getOptOutDigest }));
vi.mock('../services/cos/cosAgentStorage.js', () => ({ getAgentRecordingDownload: reads.getAgentRecordingDownload }));
vi.mock('../services/privacySubjects.js', () => ({
  listSubjects: reads.listSubjects,
  getSubject: reads.getSubject,
  assertSubject: reads.assertSubject,
  listSubjectConsents: reads.listSubjectConsents,
}));
vi.mock('../services/privacyVault.js', () => ({
  getVaultStatus: reads.getVaultStatus,
  listVaultRecords: reads.listVaultRecords,
  getVaultRecord: reads.getVaultRecord,
}));
vi.mock('../services/privacyWebsiteLogins.js', () => ({
  listWebsiteLogins: reads.listWebsiteLogins,
}));
vi.mock('../services/privacyOrgs.js', () => ({
  listOrgs: reads.listOrgs,
  getOrgsBySocialAccounts: reads.getOrgsBySocialAccounts,
  getOrg: reads.getOrg,
  getHoldingsForOrg: reads.getHoldingsForOrg,
}));
vi.mock('../services/privacyScan.js', () => ({}));
vi.mock('../services/privacyRecheckScheduler.js', () => ({}));
vi.mock('../services/privacyChanges.js', () => ({
  listChangeEvents: reads.listChangeEvents,
  getChange: reads.getChange,
}));
vi.mock('../services/dataManager.js', () => ({}));

vi.mock('../services/browserService.js', () => ({}));
vi.mock('../services/browserStatus.js', () => ({}));

const mounts = [
  ['/api/browser', (await import('./browser.js')).default],
  ['/api/privacy', (await import('./privacy.js')).default],
  ['/api/data', (await import('./dataManager.js')).default],
];
const recordId = 'c0ffee00-0000-4000-8000-000000000001';
const routes = [
  ['/api/browser/vault/logins', reads.listWebsiteLogins],
  ['/api/privacy/subjects', reads.listSubjects],
  [`/api/privacy/subjects/${recordId}`, reads.getSubject],
  [`/api/privacy/subjects/${recordId}/consents`, reads.listSubjectConsents],
  ['/api/privacy/status', reads.getVaultStatus],
  ['/api/privacy/vault', reads.listVaultRecords],
  [`/api/privacy/vault/${recordId}`, reads.getVaultRecord],
  ['/api/privacy/logins', reads.listWebsiteLogins],
  ['/api/privacy/orgs', reads.listOrgs],
  ['/api/privacy/social-account-links', reads.getOrgsBySocialAccounts],
  [`/api/privacy/orgs/${recordId}`, reads.getOrg],
  [`/api/privacy/orgs/${recordId}/holdings`, reads.getHoldingsForOrg],
  ['/api/privacy/changes', reads.listChangeEvents],
  [`/api/privacy/changes/${recordId}`, reads.getChange],
  ['/api/privacy/broker-cases', reads.listBrokerCases],
  ['/api/privacy/scan/status', reads.getScanStatus],
  [`/api/privacy/broker-cases/${recordId}/evidence`, reads.revealCaseEvidence],
  ['/api/privacy/optout/digest', reads.getOptOutDigest],
  ['/api/data/cos/storage/recording/2020-01-02/example-agent', reads.getAgentRecordingDownload],
];

beforeAll(async () => {
  const path = join(dataRoot(), 'raw.txt');
  await writeFile(path, 'Example terminal recording\n');
  reads.getAgentRecordingDownload.mockResolvedValue({ path, name: 'raw.txt' });
});
beforeEach(() => vi.clearAllMocks());
afterAll(cleanupTempDataRoots);

describe('host control for private records and raw recordings', () => {
  it.each([
    { caller: 'remote password-free', enabled: false, headers: {}, code: 'HOST_CONTROL_FORBIDDEN' },
    { caller: 'legacy Basic peer', enabled: true, headers: { Authorization: `Basic ${Buffer.from(':example-password').toString('base64')}` }, code: 'HOST_CONTROL_FORBIDDEN' },
    {
      caller: 'scoped peer', enabled: true, code: 'PEER_SCOPE_FORBIDDEN',
      headers: {
        [PEER_INSTANCE_HEADER]: peer.instanceId,
        [PEER_AUTH_HEADER]: derivePeerAuthToken(peer.syncSecret, peer.instanceId),
      },
    },
  ])('refuses GET and HEAD for $caller before reading private data', async ({ enabled, headers, code }) => {
    auth.enabled = enabled;
    const app = await hostControlApp(REMOTE_ADDRESS, mounts);
    for (const [path, read] of routes) {
      const get = await callRoute(app, ['get', path], headers);
      expect([get.status, get.body.code], path).toEqual([403, code]);
      // HEAD has no response body, but advertises the same error representation.
      const head = await callRoute(app, ['head', path], headers);
      expect(head.status, path).toBe(403);
      expect(head.headers['content-length'], path).toBe(get.headers['content-length']);
      expect(read, path).not.toHaveBeenCalled();
    }
  });

  it.each(['loopback', 'human session', 'agent session'])('allows GET and HEAD for %s', async (caller) => {
    const { buildSessionCookie, createSession } = await import('../services/auth.js');
    auth.enabled = caller !== 'loopback';
    const headers = {};
    if (caller === 'human session') {
      const { token } = await createSession();
      headers.Cookie = buildSessionCookie(token);
    } else if (caller === 'agent session') {
      const { token } = await createSession({ label: 'agent' });
      headers.Authorization = `Bearer ${token}`;
    }
    const app = await hostControlApp(auth.enabled ? REMOTE_ADDRESS : '127.0.0.1', mounts);
    for (const [path, read] of routes) {
      const before = read.mock.calls.length;
      for (const method of ['get', 'head']) {
        const response = await callRoute(app, [method, path], headers);
        expect(response.status, `${method} ${path}`).toBe(200);
      }
      expect(read, path).toHaveBeenCalledTimes(before + 2);
    }
  });
});

/**
 * Privacy route tests (issue #2140) — service mocked; verifies routing, Zod
 * validation (schema-parity: POST full / PUT partial), the sensitive-type
 * useForScans rejection at the API edge, and that responses pass through the
 * masked service shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/privacyVault.js', () => ({
  createVaultRecord: vi.fn(async (input) => ({ id: 'c0ffee00-0000-4000-8000-000000000001', type: input.type, label: input.label, maskedValue: '••••' })),
  listVaultRecords: vi.fn(async () => [{ id: 'r1', type: 'email', maskedValue: 'a•••@b.com' }]),
  getVaultRecord: vi.fn(async () => null),
  updateVaultRecord: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteVaultRecord: vi.fn(async () => ({ ok: true })),
  revealValue: vi.fn(async (id) => ({ id, type: 'email', value: 'plain@example.com' })),
  getVaultStatus: vi.fn(async () => ({ keyConfigured: true, recordCounts: { email: 1 } })),
}));

vi.mock('../services/privacyOrgs.js', () => ({
  createOrg: vi.fn(async (input) => ({ id: 'c0ffee00-0000-4000-8000-000000000002', name: input.name, trust: input.trust ?? 'trusted' })),
  listOrgs: vi.fn(async () => [{ id: 'o1', name: 'Acme Bank', trust: 'trusted' }]),
  getOrg: vi.fn(async () => null),
  updateOrg: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteOrg: vi.fn(async () => ({ ok: true })),
  setOrgHoldings: vi.fn(async (id, holdings) => holdings.map((h) => ({ orgId: id, ...h }))),
  getHoldingsForOrg: vi.fn(async () => [{ orgId: 'o1', vaultRecordId: 'v1', vaultMaskedValue: 'a•••@b.com' }]),
}));

vi.mock('../services/privacyBrokers.js', () => ({
  listBrokers: vi.fn(async () => [{ id: 'spokeo', name: 'Spokeo', enabled: true }]),
  refreshBrokers: vi.fn(async () => ({ fetched: 3, added: 2, sources: { badbool: 2, caRegistry: 1 } })),
  listBrokerCases: vi.fn(async () => [{ id: 'case-1', brokerId: 'spokeo', state: 'found' }]),
  getScanStatus: vi.fn(async () => ({ enabledBrokers: 20, caseCounts: { found: 1 }, dueForRecheck: 3 })),
}));

vi.mock('../services/privacyScan.js', () => ({
  runScanPass: vi.fn(async (opts) => ({ scanned: 2, verdicts: { found: 1, not_found: 1 }, skipped: 0, brokers: 20, _opts: opts })),
}));

const privacyRoutes = (await import('./privacy.js')).default;
const service = await import('../services/privacyVault.js');
const orgService = await import('../services/privacyOrgs.js');
const brokerService = await import('../services/privacyBrokers.js');
const scanService = await import('../services/privacyScan.js');

const VALID_UUID = 'c0ffee00-0000-4000-8000-000000000001';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/privacy', privacyRoutes);
  app.use(errorMiddleware);
  return app;
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/privacy/status', () => {
  it('returns the vault status readout', async () => {
    const res = await request(makeApp()).get('/api/privacy/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ keyConfigured: true, recordCounts: { email: 1 } });
  });
});

describe('GET /api/privacy/vault', () => {
  it('lists records (masked shape passes through)', async () => {
    const res = await request(makeApp()).get('/api/privacy/vault');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'r1', type: 'email', maskedValue: 'a•••@b.com' }]);
  });

  it('accepts a valid type filter and rejects an unknown one', async () => {
    expect((await request(makeApp()).get('/api/privacy/vault?type=email')).status).toBe(200);
    expect(service.listVaultRecords).toHaveBeenCalledWith({ type: 'email' });
    expect((await request(makeApp()).get('/api/privacy/vault?type=bogus')).status).toBe(400);
  });
});

describe('POST /api/privacy/vault', () => {
  it('creates a record from a valid body', async () => {
    const res = await request(makeApp()).post('/api/privacy/vault')
      .send({ type: 'email', label: 'Main', value: 'a@b.com' });
    expect(res.status).toBe(201);
    expect(service.createVaultRecord).toHaveBeenCalledWith({ type: 'email', label: 'Main', value: 'a@b.com' });
  });

  it('rejects a missing value, an unknown type, and unknown keys', async () => {
    expect((await request(makeApp()).post('/api/privacy/vault').send({ type: 'email', label: 'x' })).status).toBe(400);
    expect((await request(makeApp()).post('/api/privacy/vault').send({ type: 'nope', label: 'x', value: 'v' })).status).toBe(400);
    expect((await request(makeApp()).post('/api/privacy/vault').send({ type: 'email', label: 'x', value: 'v', extra: 1 })).status).toBe(400);
  });

  it('rejects useForScans=true for sensitive types at the schema edge', async () => {
    for (const type of ['ssn', 'passport', 'drivers_license', 'financial_account']) {
      const res = await request(makeApp()).post('/api/privacy/vault')
        .send({ type, label: 'doc', value: 'x', useForScans: true });
      expect(res.status).toBe(400);
    }
    expect(service.createVaultRecord).not.toHaveBeenCalled();
  });
});

describe('PUT /api/privacy/vault/:id', () => {
  it('applies a partial patch', async () => {
    const res = await request(makeApp()).put(`/api/privacy/vault/${VALID_UUID}`).send({ label: 'renamed' });
    expect(res.status).toBe(200);
    expect(service.updateVaultRecord).toHaveBeenCalledWith(VALID_UUID, { label: 'renamed' });
  });

  it('rejects a type change (immutable) and a non-uuid id', async () => {
    expect((await request(makeApp()).put(`/api/privacy/vault/${VALID_UUID}`).send({ type: 'email' })).status).toBe(400);
    expect((await request(makeApp()).put('/api/privacy/vault/not-a-uuid').send({ label: 'x' })).status).toBe(400);
  });
});

describe('DELETE /api/privacy/vault/:id', () => {
  it('deletes by id and validates the uuid', async () => {
    expect((await request(makeApp()).delete(`/api/privacy/vault/${VALID_UUID}`)).status).toBe(200);
    expect(service.deleteVaultRecord).toHaveBeenCalledWith(VALID_UUID);
    expect((await request(makeApp()).delete('/api/privacy/vault/nope')).status).toBe(400);
  });
});

describe('POST /api/privacy/vault/:id/reveal', () => {
  it('returns the decrypted value from the ONE reveal path', async () => {
    const res = await request(makeApp()).post(`/api/privacy/vault/${VALID_UUID}/reveal`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: VALID_UUID, type: 'email', value: 'plain@example.com' });
  });
});

describe('GET /api/privacy/vault/:id', () => {
  it('404s a missing record', async () => {
    const res = await request(makeApp()).get(`/api/privacy/vault/${VALID_UUID}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/privacy/orgs', () => {
  it('lists orgs and accepts trust/status/category filters', async () => {
    const res = await request(makeApp()).get('/api/privacy/orgs');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'o1', name: 'Acme Bank', trust: 'trusted' }]);

    expect((await request(makeApp()).get('/api/privacy/orgs?trust=unwanted')).status).toBe(200);
    expect(orgService.listOrgs).toHaveBeenCalledWith({ trust: 'unwanted' });
    expect((await request(makeApp()).get('/api/privacy/orgs?trust=bogus')).status).toBe(400);
  });
});

describe('POST /api/privacy/orgs', () => {
  it('creates an org from a valid body', async () => {
    const res = await request(makeApp()).post('/api/privacy/orgs').send({ name: 'Acme Bank', category: 'bank' });
    expect(res.status).toBe(201);
    expect(orgService.createOrg).toHaveBeenCalledWith({ name: 'Acme Bank', category: 'bank' });
  });

  it('rejects a missing name, an unknown category/trust, and unknown keys', async () => {
    expect((await request(makeApp()).post('/api/privacy/orgs').send({})).status).toBe(400);
    expect((await request(makeApp()).post('/api/privacy/orgs').send({ name: 'X', category: 'nope' })).status).toBe(400);
    expect((await request(makeApp()).post('/api/privacy/orgs').send({ name: 'X', trust: 'nope' })).status).toBe(400);
    expect((await request(makeApp()).post('/api/privacy/orgs').send({ name: 'X', extra: 1 })).status).toBe(400);
  });
});

describe('GET /api/privacy/orgs/:id', () => {
  it('404s a missing org', async () => {
    const res = await request(makeApp()).get(`/api/privacy/orgs/${VALID_UUID}`);
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/privacy/orgs/:id', () => {
  it('applies a partial patch', async () => {
    const res = await request(makeApp()).put(`/api/privacy/orgs/${VALID_UUID}`).send({ trust: 'unwanted' });
    expect(res.status).toBe(200);
    expect(orgService.updateOrg).toHaveBeenCalledWith(VALID_UUID, { trust: 'unwanted' });
  });

  it('rejects a non-uuid id and an unknown enum value', async () => {
    expect((await request(makeApp()).put('/api/privacy/orgs/not-a-uuid').send({ name: 'x' })).status).toBe(400);
    expect((await request(makeApp()).put(`/api/privacy/orgs/${VALID_UUID}`).send({ status: 'nope' })).status).toBe(400);
  });
});

describe('DELETE /api/privacy/orgs/:id', () => {
  it('deletes by id and validates the uuid', async () => {
    expect((await request(makeApp()).delete(`/api/privacy/orgs/${VALID_UUID}`)).status).toBe(200);
    expect(orgService.deleteOrg).toHaveBeenCalledWith(VALID_UUID);
    expect((await request(makeApp()).delete('/api/privacy/orgs/nope')).status).toBe(400);
  });
});

describe('GET /api/privacy/orgs/:id/holdings', () => {
  it('returns the joined masked holdings for the org', async () => {
    orgService.getOrg.mockResolvedValueOnce({ id: VALID_UUID, name: 'Acme Bank' });
    const res = await request(makeApp()).get(`/api/privacy/orgs/${VALID_UUID}/holdings`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ orgId: 'o1', vaultRecordId: 'v1', vaultMaskedValue: 'a•••@b.com' }]);
  });

  it('404s a missing org before ever querying holdings', async () => {
    const res = await request(makeApp()).get(`/api/privacy/orgs/${VALID_UUID}/holdings`);
    expect(res.status).toBe(404);
    expect(orgService.getHoldingsForOrg).not.toHaveBeenCalled();
  });
});

describe('PUT /api/privacy/orgs/:id/holdings', () => {
  it('replace-sets holdings from a valid body', async () => {
    const res = await request(makeApp()).put(`/api/privacy/orgs/${VALID_UUID}/holdings`)
      .send({ holdings: [{ vaultRecordId: VALID_UUID, status: 'current' }] });
    expect(res.status).toBe(200);
    expect(orgService.setOrgHoldings).toHaveBeenCalledWith(
      VALID_UUID, [{ vaultRecordId: VALID_UUID, status: 'current' }],
    );
  });

  it('accepts an empty list (clears all holdings) and rejects an unknown status', async () => {
    expect((await request(makeApp()).put(`/api/privacy/orgs/${VALID_UUID}/holdings`).send({ holdings: [] })).status).toBe(200);
    expect((await request(makeApp()).put(`/api/privacy/orgs/${VALID_UUID}/holdings`)
      .send({ holdings: [{ vaultRecordId: VALID_UUID, status: 'nope' }] })).status).toBe(400);
  });
});

// ─── Data-broker database + scan + case ledger (issue #2144) ────────────────

describe('GET /api/privacy/brokers', () => {
  it('lists brokers and coerces the enabled query flag to a boolean', async () => {
    const res = await request(makeApp()).get('/api/privacy/brokers?enabled=true');
    expect(res.status).toBe(200);
    expect(brokerService.listBrokers).toHaveBeenCalledWith({ enabled: true });
    expect(res.body[0].id).toBe('spokeo');
  });

  it('lists all brokers when no filter is given', async () => {
    const res = await request(makeApp()).get('/api/privacy/brokers');
    expect(res.status).toBe(200);
    expect(brokerService.listBrokers).toHaveBeenCalledWith({ enabled: undefined });
  });
});

describe('POST /api/privacy/brokers/refresh', () => {
  it('runs the user-triggered refresh', async () => {
    const res = await request(makeApp()).post('/api/privacy/brokers/refresh').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 2 });
    expect(brokerService.refreshBrokers).toHaveBeenCalled();
  });
});

describe('GET /api/privacy/broker-cases', () => {
  it('lists cases and filters by state', async () => {
    const res = await request(makeApp()).get('/api/privacy/broker-cases?state=found');
    expect(res.status).toBe(200);
    expect(brokerService.listBrokerCases).toHaveBeenCalledWith({ state: 'found' });
  });

  it('rejects an unknown case state', async () => {
    expect((await request(makeApp()).get('/api/privacy/broker-cases?state=bogus')).status).toBe(400);
  });
});

describe('GET /api/privacy/scan/status', () => {
  it('returns the scan status readout', async () => {
    const res = await request(makeApp()).get('/api/privacy/scan/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabledBrokers: 20, dueForRecheck: 3 });
  });
});

describe('POST /api/privacy/scan', () => {
  it('starts a scan pass and returns the summary', async () => {
    const res = await request(makeApp()).post('/api/privacy/scan').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scanned: 2, verdicts: { found: 1, not_found: 1 } });
    expect(scanService.runScanPass).toHaveBeenCalled();
  });

  it('passes a valid concurrency knob through and rejects an out-of-range one', async () => {
    await request(makeApp()).post('/api/privacy/scan').send({ concurrency: 4 });
    expect(scanService.runScanPass).toHaveBeenCalledWith({ concurrency: 4 });
    expect((await request(makeApp()).post('/api/privacy/scan').send({ concurrency: 99 })).status).toBe(400);
  });
});

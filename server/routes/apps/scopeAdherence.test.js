import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../../lib/testHelper.js';
import scopeAdherenceRoutes from './scopeAdherence.js';

vi.mock('../../services/apps.js', () => ({ getAppById: vi.fn() }));
vi.mock('../../services/scopeAdherence.js', () => ({ scoreAdherence: vi.fn() }));

import * as appsService from '../../services/apps.js';
import { scoreAdherence } from '../../services/scopeAdherence.js';

const ADVISORY = {
  ok: true,
  verdict: 'contradicts',
  clauseId: 'PRD.md#out-of-scope:abc12345',
  clause: { id: 'PRD.md#out-of-scope:abc12345', sourceFile: 'PRD.md', headingPath: 'Out of Scope', citation: 'PRD.md § Out of Scope', text: '…', line: 12 },
  margin: 0.41,
  scored: 3,
};

describe('POST /api/apps/:id/scope-adherence', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/apps', scopeAdherenceRoutes);
    vi.clearAllMocks();
    appsService.getAppById.mockResolvedValue({ id: 'app-001', name: 'Widget', repoPath: '/repo' });
    scoreAdherence.mockResolvedValue(ADVISORY);
  });

  const post = (body) => request(app).post('/api/apps/app-001/scope-adherence').send(body);

  it('scores against the loaded app\'s own checkout and returns the advisory verbatim', async () => {
    const response = await post({ kind: 'pr', title: 'Expose the dashboard publicly', body: 'Opens :5555 to the internet.' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(ADVISORY);
    expect(scoreAdherence).toHaveBeenCalledWith({
      kind: 'pr',
      title: 'Expose the dashboard publicly',
      body: 'Opens :5555 to the internet.',
      diffSummary: undefined,
      repoPath: '/repo',
    });
  });

  it('refuses a client-supplied repository path', async () => {
    // The endpoint reads PRD.md out of a checkout. A caller-controlled path
    // would make it an arbitrary-file reader, so the schema is `.strict()`.
    const response = await post({ kind: 'pr', title: 'Anything', repoPath: '/etc' });

    expect(response.status).toBe(400);
    expect(scoreAdherence).not.toHaveBeenCalled();
  });

  it('forwards an app\'s missing repository as-is rather than inventing one', async () => {
    appsService.getAppById.mockResolvedValue({ id: 'app-002', name: 'Docs only' });

    await request(app).post('/api/apps/app-002/scope-adherence').send({ kind: 'issue', title: 'Something' });

    // `scoreAdherence` requires `repoPath` and has no default, so an app with
    // no checkout answers `scope-adherence-corpus-missing` instead of being
    // graded against PortOS's own PRD.
    expect(scoreAdherence).toHaveBeenCalledWith(expect.objectContaining({ repoPath: undefined }));
  });

  it('404s for an unknown app without scoring anything', async () => {
    appsService.getAppById.mockResolvedValue(null);

    const response = await post({ kind: 'issue', title: 'Something' });

    expect(response.status).toBe(404);
    expect(scoreAdherence).not.toHaveBeenCalled();
  });

  it('rejects an unknown change kind', async () => {
    const response = await post({ kind: 'discussion', title: 'Something' });

    expect(response.status).toBe(400);
    expect(scoreAdherence).not.toHaveBeenCalled();
  });
});

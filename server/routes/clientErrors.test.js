import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real aggregation service writing to the real Review Hub store over a temp data root; the
// assertions read the stored alerts back through review.getItems instead of a recorded call.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-client-errors-') }));
afterAll(cleanupTempDataRoots);

const review = await import('../services/review.js');
const { _resetForTests } = await import('../services/clientErrors.js');
const { default: routes } = await import('./clientErrors.js');

const app = express();
app.use(express.json());
app.use('/api/client-errors', routes);
app.use(errorMiddleware);

const post = (body) => request(app).post('/api/client-errors').send(body);
const storedAlerts = async () => (await review.getItems({ type: 'alert' }))
  .filter((i) => i.metadata?.category === 'client-error');

// Resets the in-memory throttle/dedup window. Stored alerts persist across tests (client-error
// alerts are source-owned, so deleteItem refuses them); tests use distinct messages and compare counts.
beforeEach(() => _resetForTests());

describe('POST /api/client-errors', () => {
  it('accepts a well-formed error payload and stores it as a Review Hub alert', async () => {
    const before = (await storedAlerts()).length;
    const res = await post({
      type: 'error',
      message: 'boom',
      stack: 'Error: boom\n    at foo (foo.js:1:1)',
      url: 'https://portos/dash',
    });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    const alerts = await storedAlerts();
    expect(alerts).toHaveLength(before + 1);
    expect(alerts.find((i) => i.id === res.body.itemId).metadata).toMatchObject({ kind: 'error', url: 'https://portos/dash' });
  });

  it('accepts an unhandledrejection payload', async () => {
    const res = await post({ type: 'unhandledrejection', message: 'rejected' });
    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(true);
    const stored = (await storedAlerts()).find((i) => i.id === res.body.itemId);
    expect(stored.metadata.kind).toBe('unhandledrejection');
  });

  it('suppresses a repeat of the same error and stores no second alert', async () => {
    const first = await post({ type: 'error', message: 'repeat-me' });
    expect(first.body.accepted).toBe(true);
    const count = (await storedAlerts()).length;

    const second = await post({ type: 'error', message: 'repeat-me' });
    expect(second.status).toBe(202);
    expect(second.body.accepted).toBe(false);
    expect(['duplicate', 'rate-limited']).toContain(second.body.reason);
    expect(await storedAlerts()).toHaveLength(count);
  });

  it('rejects an unknown type with 400 and stores nothing', async () => {
    const before = (await storedAlerts()).length;
    const res = await post({ type: 'panic', message: 'boom' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(await storedAlerts()).toHaveLength(before);
  });

  it('rejects a payload with a message that exceeds the cap', async () => {
    const before = (await storedAlerts()).length;
    const res = await post({ type: 'error', message: 'x'.repeat(2001) });
    expect(res.status).toBe(400);
    expect(await storedAlerts()).toHaveLength(before);
  });

  it('rejects a payload missing the message field', async () => {
    const before = (await storedAlerts()).length;
    const res = await post({ type: 'error' });
    expect(res.status).toBe(400);
    expect(await storedAlerts()).toHaveLength(before);
  });
});

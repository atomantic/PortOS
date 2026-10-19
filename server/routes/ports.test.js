import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const state = vi.hoisted(() => ({ listening: [], reserved: [] }));

// Feed the real port-discovery parsers: one line per supported platform format,
// so the assertion holds on darwin (lsof), linux (ss) and win32 (netstat) runners.
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...await importOriginal(),
  exec: vi.fn((_command, ...rest) => {
    const callback = rest.at(-1);
    const stdout = state.listening
      .map((p) => `LISTEN 0 511 0.0.0.0:${p} 0.0.0.0:*\nnode 1 u IPv4 TCP *:${p} (LISTEN)\n  TCP    0.0.0.0:${p}    0.0.0.0:0    LISTENING`)
      .join('\n');
    callback(null, { stdout });
  }),
}));
vi.mock('../services/apps.js', () => ({
  getReservedPorts: vi.fn(async () => state.reserved),
}));

import portsRoutes from './ports.js';
import { isBrowserUnsafePort } from '../lib/browserUnsafePorts.js';

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('POST /api/ports/allocate', () => {
  let app;
  beforeEach(() => {
    state.listening = [];
    state.reserved = [];
    app = express();
    app.use(express.json());
    app.use('/api/ports', portsRoutes);
    app.use(errorMiddleware);
  });

  it('hands out the first free ports of the documented managed band, skipping listeners and reserved ports', async () => {
    state.listening = [5570, 5571];
    state.reserved = [5572];

    const res = await request(app).post('/api/ports/allocate').send({ count: 2 });

    expect(res.status).toBe(200);
    expect(res.body.allocated).toEqual([5573, 5574]);
  });

  it('overflows past the band without ever returning a browser-blocked port', async () => {
    state.listening = range(5570, 5599);

    const res = await request(app).post('/api/ports/allocate').send({ count: 3 });

    expect(res.status).toBe(200);
    expect(res.body.allocated).toEqual([5600, 5601, 5602]);
    expect(res.body.allocated.some(isBrowserUnsafePort)).toBe(false);
  });
});

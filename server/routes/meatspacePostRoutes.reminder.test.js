import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// PUT /post/config no longer wires the reminder reschedule itself (#2015) —
// that now lives centrally inside meatspacePost.js's updatePostConfig(), via
// its postConfigEvents emitter, so any current or future caller of
// updatePostConfig gets the reschedule for free. See:
//   - server/services/meatspacePost.test.js for updatePostConfig emitting
//     postConfigEvents on every save.
//   - server/services/meatspacePostReminder.test.js for the subscription
//     that reschedules when the `reminder` slice is part of the patch.
// This file is now a lean smoke test for the route itself: it validates the
// body, delegates to postService.updatePostConfig, and returns the result.
vi.mock('../services/meatspacePost.js', () => ({
  getPostConfig: vi.fn(),
  updatePostConfig: vi.fn(),
}));

import * as postService from '../services/meatspacePost.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import meatspacePostRoutes from './meatspacePostRoutes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/meatspace', meatspacePostRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('PUT /api/meatspace/post/config', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
    postService.updatePostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
  });

  it('delegates to postService.updatePostConfig and returns the saved config', async () => {
    const r = await request(app)
      .put('/api/meatspace/post/config')
      .send({ reminder: { enabled: true, time: '09:00' } });
    expect(r.status).toBe(200);
    expect(postService.updatePostConfig).toHaveBeenCalledWith({ reminder: { enabled: true, time: '09:00' } });
    expect(r.body).toEqual({ reminder: { enabled: true, time: '09:00' } });
  });

  it('accepts a payload with no reminder key', async () => {
    const r = await request(app)
      .put('/api/meatspace/post/config')
      .send({ adaptive: { enabled: true } });
    expect(r.status).toBe(200);
    expect(postService.updatePostConfig).toHaveBeenCalledWith({ adaptive: { enabled: true } });
  });
});

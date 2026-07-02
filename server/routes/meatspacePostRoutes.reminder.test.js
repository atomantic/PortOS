import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// Scoped to PUT /post/config's reminder-rescheduling wiring — only the two
// services that route touches (postService.updatePostConfig and
// meatspacePostReminder.registerPostReminderSchedule) are mocked. Mirrors the
// scoping rationale in meatspacePostRoutes.drillCache.test.js.
vi.mock('../services/meatspacePost.js', () => ({
  getPostConfig: vi.fn(),
  updatePostConfig: vi.fn(),
}));

vi.mock('../services/meatspacePostReminder.js', () => ({
  registerPostReminderSchedule: vi.fn(),
}));

import * as postService from '../services/meatspacePost.js';
import { registerPostReminderSchedule } from '../services/meatspacePostReminder.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import meatspacePostRoutes from './meatspacePostRoutes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/meatspace', meatspacePostRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('PUT /api/meatspace/post/config — reminder rescheduling', () => {
  let app;
  beforeEach(() => {
    app = makeApp();
    vi.clearAllMocks();
    postService.updatePostConfig.mockResolvedValue({ reminder: { enabled: true, time: '09:00' } });
  });

  it('reschedules the reminder when the payload includes a reminder block', async () => {
    const r = await request(app)
      .put('/api/meatspace/post/config')
      .send({ reminder: { enabled: true, time: '09:00' } });
    expect(r.status).toBe(200);
    expect(registerPostReminderSchedule).toHaveBeenCalledTimes(1);
  });

  it('does not touch the reminder schedule when the payload has no reminder key', async () => {
    const r = await request(app)
      .put('/api/meatspace/post/config')
      .send({ adaptive: { enabled: true } });
    expect(r.status).toBe(200);
    expect(registerPostReminderSchedule).not.toHaveBeenCalled();
  });
});

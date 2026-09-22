import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

const activity = vi.hoisted(() => ({
  getSystemActivity: vi.fn(),
  getGpuTelemetry: vi.fn(),
}));
vi.mock('../services/activeProcessing.js', () => activity);

const { default: routes } = await import('./systemActivity.js');

const app = express();
app.use('/api/system', routes);

describe('system activity routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves the bounded activity snapshot without GPU telemetry', async () => {
    activity.getSystemActivity.mockResolvedValue({ activity: { idle: true } });
    const response = await request(app).get('/api/system/activity');
    expect(response.status).toBe(200);
    expect(response.body.activity.idle).toBe(true);
    expect(activity.getGpuTelemetry).not.toHaveBeenCalled();
  });

  it('serves GPU samples from their own route', async () => {
    activity.getGpuTelemetry.mockResolvedValue({ gpu: { status: 'available', laneBusy: false, gpus: [] } });
    const response = await request(app).get('/api/system/gpu-telemetry');
    expect(response.status).toBe(200);
    expect(response.body.gpu.status).toBe('available');
    expect(activity.getSystemActivity).not.toHaveBeenCalled();
  });
});

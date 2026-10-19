import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/autobiography.js', async (importOriginal) => ({
  ...await importOriginal(),
  updateConfig: vi.fn(),
  getNextPrompt: vi.fn(),
  getPromptById: vi.fn(),
  getStories: vi.fn(),
  saveStory: vi.fn(),
  updateStory: vi.fn(),
}));

import * as autobiography from '../services/autobiography.js';
import autobiographyRoutes from './autobiography.js';

const app = express();
app.use(express.json());
app.use('/api/digital-twin/autobiography', autobiographyRoutes);
app.use(errorMiddleware);
const BASE = '/api/digital-twin/autobiography';

beforeEach(() => vi.clearAllMocks());

describe('/api/digital-twin/autobiography', () => {
  it('saves a story to a custom question only when the question text is present', async () => {
    autobiography.saveStory.mockResolvedValue({ id: 's1' });
    const missing = await request(app).post(`${BASE}/stories`).send({ promptId: 'custom', content: 'Once' });
    expect(missing.status).toBe(400);
    expect(autobiography.saveStory).not.toHaveBeenCalled();

    const ok = await request(app).post(`${BASE}/stories`).send({ promptId: 'custom', content: 'Once', customPromptText: 'What was your first job?' });
    expect(ok.status).toBe(200);
    expect(autobiography.saveStory).toHaveBeenCalledWith({
      promptId: 'custom', content: 'Once', parentStoryId: undefined, customPromptText: 'What was your first job?',
    });
  });

  it('refuses a reminder time the scheduler could not register', async () => {
    const res = await request(app).put(`${BASE}/config`).send({ reminder: { enabled: true, time: '9am' } });
    expect(res.status).toBe(400);
    expect(autobiography.updateConfig).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown prompt or story', async () => {
    autobiography.getPromptById.mockReturnValue(null);
    autobiography.updateStory.mockResolvedValue(null);
    expect((await request(app).get(`${BASE}/prompt/nope`)).status).toBe(404);
    expect((await request(app).put(`${BASE}/stories/nope`).send({ content: 'x' })).status).toBe(404);
  });

  it('passes the theme filter and the excluded prompt from the query string', async () => {
    autobiography.getStories.mockResolvedValue([]);
    autobiography.getNextPrompt.mockResolvedValue({ id: 'p2' });
    await request(app).get(`${BASE}/stories?theme=childhood`);
    expect(autobiography.getStories).toHaveBeenCalledWith('childhood');
    await request(app).get(`${BASE}/stories`);
    expect(autobiography.getStories).toHaveBeenLastCalledWith(null);
    await request(app).get(`${BASE}/prompt?exclude=p1`);
    expect(autobiography.getNextPrompt).toHaveBeenCalledWith('p1');
    expect((await request(app).get(`${BASE}/stories?theme=a&theme=b`)).status).toBe(400);
  });
});

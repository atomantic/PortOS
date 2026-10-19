import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/search.js', () => ({ fanOutSearch: vi.fn() }));

import { fanOutSearch } from '../services/search.js';
import searchRoutes from './search.js';

const app = express();
app.use('/api/search', searchRoutes);
app.use(errorMiddleware);

beforeEach(() => vi.clearAllMocks());

describe('GET /api/search', () => {
  it('searches with the trimmed query and echoes it beside the grouped sources', async () => {
    fanOutSearch.mockResolvedValue([{ id: 'brain', results: [] }]);
    const res = await request(app).get('/api/search?q=%20%20garden%20%20');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ query: 'garden', sources: [{ id: 'brain', results: [] }] });
    expect(fanOutSearch).toHaveBeenCalledWith('garden');
  });

  it('refuses a missing or one-character query without fanning out', async () => {
    expect((await request(app).get('/api/search')).status).toBe(400);
    expect((await request(app).get('/api/search?q=a')).status).toBe(400);
    expect(fanOutSearch).not.toHaveBeenCalled();
  });
});

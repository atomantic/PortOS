import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  catalog: vi.fn(),
  format: vi.fn(),
  readRecipes: vi.fn(),
}));

vi.mock('../services/cos/cosState.js', () => ({
  loadState: vi.fn(async () => ({ config: { persistentMindCapabilities: { readPortos: true } } })),
}));
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ agentContext: { actions: { readPortos: false, writePortos: true } } })),
}));
vi.mock('../services/cos/cosToolRegistry.js', () => ({
  getCosToolCatalog: (...args) => mocks.catalog(...args),
  formatCosToolCatalog: (...args) => mocks.format(...args),
  readCosToolRecipeCatalog: (...args) => mocks.readRecipes(...args),
}));

import routes from './cosToolRoutes.js';

const buildApp = () => {
  const app = express();
  app.use('/api/cos', routes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.mockReturnValue({ type: 'portos_tool_catalog', schemaVersion: 1, tools: [] });
  mocks.format.mockImplementation((catalog) => catalog);
  mocks.readRecipes.mockResolvedValue([]);
});

describe('CoS tool routes', () => {
  it('serves filtered/provider-formatted catalogs with a conditional ETag', async () => {
    const first = await request(buildApp()).get('/api/cos/tools?scope=mind&format=openai');
    expect(first.status).toBe(200);
    expect(first.headers.etag).toBeTruthy();
    expect(mocks.catalog).toHaveBeenCalledWith(expect.objectContaining({ scope: 'mind' }));
    expect(mocks.format).toHaveBeenCalledWith(expect.any(Object), 'openai');
    const second = await request(buildApp()).get('/api/cos/tools?scope=mind&format=openai').set('If-None-Match', first.headers.etag);
    expect(second.status).toBe(304);
  });

  it('uses CoS-agent MCP grants for the agent catalog scope', async () => {
    const response = await request(buildApp()).get('/api/cos/tools?scope=agent');
    expect(response.status).toBe(200);
    expect(mocks.catalog).toHaveBeenCalledWith(expect.objectContaining({
      scope: 'agent',
      capabilities: { readPortos: false, writePortos: true },
    }));
  });

  it('changes the catalog ETag when a saved recipe revision changes', async () => {
    mocks.readRecipes.mockResolvedValueOnce([{ name: 'recipe.check', recipe: { revision: 1 } }])
      .mockResolvedValueOnce([{ name: 'recipe.check', recipe: { revision: 2 } }]);
    mocks.catalog.mockImplementation(({ recipes }) => ({ type: 'portos_tool_catalog', schemaVersion: 1, tools: recipes }));
    const first = await request(buildApp()).get('/api/cos/tools?scope=agent');
    const second = await request(buildApp()).get('/api/cos/tools?scope=agent');
    expect(first.headers.etag).not.toBe(second.headers.etag);
    expect(mocks.readRecipes).toHaveBeenCalledWith({ scope: 'agent' });
  });


});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/dashboardLayouts.js', () => ({
  ERR_NOT_FOUND: 'NOT_FOUND',
  ERR_BUILTIN_PROTECTED: 'BUILTIN_PROTECTED',
  ID_PATTERN: /^[a-z0-9]+(-[a-z0-9]+)*$/,
  ID_MAX_LENGTH: 60,
  NAME_MAX_LENGTH: 80,
  WIDGETS_MAX: 50,
  WIDGET_ID_MAX_LENGTH: 80,
  GRID_COLS: 12,
  GRID_ROW_MAX: 200,
  GRID_ITEM_H_MAX: 50,
  getState: vi.fn(),
  setActiveLayout: vi.fn(),
  saveLayout: vi.fn(),
  deleteLayout: vi.fn(),
}));

const svc = await import('../services/dashboardLayouts.js');
const { default: routes } = await import('./dashboardLayouts.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/dashboard/layouts', routes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/dashboard/layouts', () => {
  it('returns active layout id + layouts list', async () => {
    svc.getState.mockResolvedValue({
      activeLayoutId: 'default',
      layouts: [{ id: 'default', name: 'Everything', builtIn: true, widgets: ['apps'] }],
    });
    const res = await request(makeApp()).get('/api/dashboard/layouts');
    expect(res.status).toBe(200);
    expect(res.body.activeLayoutId).toBe('default');
    expect(res.body.layouts).toHaveLength(1);
  });
});

describe('PUT /api/dashboard/layouts/active', () => {
  it('switches the active layout', async () => {
    svc.setActiveLayout.mockResolvedValue({ activeLayoutId: 'focus', layouts: [] });
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/active')
      .send({ id: 'focus' });
    expect(res.status).toBe(200);
    expect(svc.setActiveLayout).toHaveBeenCalledWith('focus');
  });

  it('404s on unknown layout', async () => {
    svc.setActiveLayout.mockRejectedValue(Object.assign(new Error('Unknown layout id: nope'), { code: 'NOT_FOUND' }));
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/active')
      .send({ id: 'nope' });
    expect(res.status).toBe(404);
  });

  it('500s (bubbles) on unexpected service errors — does not collapse to 404', async () => {
    svc.setActiveLayout.mockRejectedValue(new Error('disk full'));
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/active')
      .send({ id: 'default' });
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/dashboard/layouts/:id', () => {
  it('saves a layout', async () => {
    svc.saveLayout.mockResolvedValue({ activeLayoutId: 'default', layouts: [] });
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/my-custom')
      .send({ name: 'Custom', widgets: ['apps', 'cos'] });
    expect(res.status).toBe(200);
    expect(svc.saveLayout).toHaveBeenCalledWith({
      id: 'my-custom',
      name: 'Custom',
      widgets: ['apps', 'cos'],
      grid: [],
    });
  });

  it('rejects invalid layout ids', async () => {
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/NotKebab')
      .send({ name: 'x', widgets: [] });
    expect(res.status).toBe(400);
    expect(svc.saveLayout).not.toHaveBeenCalled();
  });

  it('rejects duplicate widget ids', async () => {
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/my-custom')
      .send({ name: 'Custom', widgets: ['apps', 'cos', 'apps'] });
    expect(res.status).toBe(400);
    expect(svc.saveLayout).not.toHaveBeenCalled();
  });

  it('saves a layout with a grid', async () => {
    svc.saveLayout.mockResolvedValue({ activeLayoutId: 'default', layouts: [] });
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/my-custom')
      .send({
        name: 'Custom',
        widgets: ['apps', 'cos'],
        grid: [
          { id: 'apps', x: 0, y: 0, w: 12, h: 4 },
          { id: 'cos', x: 0, y: 4, w: 6, h: 3 },
        ],
      });
    expect(res.status).toBe(200);
    expect(svc.saveLayout).toHaveBeenCalledWith({
      id: 'my-custom',
      name: 'Custom',
      widgets: ['apps', 'cos'],
      grid: [
        { id: 'apps', x: 0, y: 0, w: 12, h: 4 },
        { id: 'cos', x: 0, y: 4, w: 6, h: 3 },
      ],
    });
  });

  it('rejects grid items that reference unknown widgets', async () => {
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/my-custom')
      .send({
        name: 'Custom',
        widgets: ['apps'],
        grid: [{ id: 'apps', x: 0, y: 0, w: 4, h: 4 }, { id: 'ghost', x: 4, y: 0, w: 4, h: 4 }],
      });
    expect(res.status).toBe(400);
    expect(svc.saveLayout).not.toHaveBeenCalled();
  });

  it('rejects grid items where x+w exceeds the column count', async () => {
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/my-custom')
      .send({
        name: 'Custom',
        widgets: ['apps'],
        grid: [{ id: 'apps', x: 6, y: 0, w: 8, h: 4 }],
      });
    expect(res.status).toBe(400);
    expect(svc.saveLayout).not.toHaveBeenCalled();
  });

  it('rejects duplicate grid ids', async () => {
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/my-custom')
      .send({
        name: 'Custom',
        widgets: ['apps'],
        grid: [
          { id: 'apps', x: 0, y: 0, w: 4, h: 4 },
          { id: 'apps', x: 4, y: 0, w: 4, h: 4 },
        ],
      });
    expect(res.status).toBe(400);
    expect(svc.saveLayout).not.toHaveBeenCalled();
  });

  it('accepts a layout with no grid (back-compat for unmigrated clients)', async () => {
    svc.saveLayout.mockResolvedValue({ activeLayoutId: 'default', layouts: [] });
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/my-custom')
      .send({ name: 'Custom', widgets: ['apps'] });
    expect(res.status).toBe(200);
    // Default-applied grid is an empty array — defaults inside .refine() chain.
    expect(svc.saveLayout).toHaveBeenCalledWith({
      id: 'my-custom',
      name: 'Custom',
      widgets: ['apps'],
      grid: [],
    });
  });
});

describe('PUT /api/dashboard/layouts/active — id validation', () => {
  it('rejects non-kebab ids with 400 (not 404)', async () => {
    const res = await request(makeApp())
      .put('/api/dashboard/layouts/active')
      .send({ id: 'Not_Kebab' });
    expect(res.status).toBe(400);
    expect(svc.setActiveLayout).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/dashboard/layouts/:id', () => {
  it('deletes a user layout', async () => {
    svc.deleteLayout.mockResolvedValue({ activeLayoutId: 'default', layouts: [] });
    const res = await request(makeApp()).delete('/api/dashboard/layouts/my-custom');
    expect(res.status).toBe(200);
    expect(svc.deleteLayout).toHaveBeenCalledWith('my-custom');
  });

  it('400s when trying to delete a built-in layout', async () => {
    svc.deleteLayout.mockRejectedValue(Object.assign(new Error('Cannot delete built-in layout: default'), { code: 'BUILTIN_PROTECTED' }));
    const res = await request(makeApp()).delete('/api/dashboard/layouts/default');
    expect(res.status).toBe(400);
  });

  it('404s when deleting an unknown layout', async () => {
    svc.deleteLayout.mockRejectedValue(Object.assign(new Error('Unknown layout id: nope'), { code: 'NOT_FOUND' }));
    const res = await request(makeApp()).delete('/api/dashboard/layouts/nope');
    expect(res.status).toBe(404);
  });
});

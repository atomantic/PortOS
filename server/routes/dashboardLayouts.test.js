import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real dashboardLayouts service (JSON file) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-dashboard-layouts-') }));
afterAll(cleanupTempDataRoots);

const { PATHS } = await import('../lib/fileUtils.js');
const { default: routes } = await import('./dashboardLayouts.js');

const stateFile = () => join(PATHS.data, 'dashboard-layouts.json');

const app = express();
app.use(express.json());
app.use('/api/dashboard/layouts', routes);
app.use(errorMiddleware);

const BASE = '/api/dashboard/layouts';
const getState = async () => (await request(app).get(BASE)).body;
const findLayout = (state, id) => state.layouts.find((l) => l.id === id);
const put = (id, body) => request(app).put(`${BASE}/${id}`).send(body);
const expectRejectedAndUnsaved = async (res, id) => {
  expect(res.status).toBe(400);
  expect(findLayout(await getState(), id)).toBeUndefined();
};

beforeEach(async () => {
  await rm(stateFile(), { force: true });
});

describe('GET /api/dashboard/layouts', () => {
  it('seeds the built-in layouts with the default active and the shared limits', async () => {
    const res = await request(app).get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.activeLayoutId).toBe('default');
    expect(findLayout(res.body, 'default')).toMatchObject({ name: 'Everything', builtIn: true });
    expect(res.body.limits).toMatchObject({ gridCols: 12, widgetsMax: 50 });
  });
});

describe('PUT /api/dashboard/layouts/active', () => {
  it('switches the active layout and persists it', async () => {
    await put('focus-custom', { name: 'Focus', widgets: ['apps'] });
    const res = await request(app).put(`${BASE}/active`).send({ id: 'focus-custom' });
    expect(res.status).toBe(200);
    expect((await getState()).activeLayoutId).toBe('focus-custom');
  });

  it('404s on an unknown layout and leaves the active layout alone', async () => {
    expect((await request(app).put(`${BASE}/active`).send({ id: 'nope' })).status).toBe(404);
    expect((await getState()).activeLayoutId).toBe('default');
  });

  it('rejects non-kebab ids with 400 (not 404)', async () => {
    expect((await request(app).put(`${BASE}/active`).send({ id: 'Not_Kebab' })).status).toBe(400);
  });

  it('500s (bubbles) when the state file is unreadable — does not collapse to 404', async () => {
    await mkdir(PATHS.data, { recursive: true });
    await writeFile(stateFile(), '{ not json');
    const res = await request(app).put(`${BASE}/active`).send({ id: 'default' });
    expect(res.status).toBe(500);
  });
});

describe('PUT /api/dashboard/layouts/:id', () => {
  it('saves a layout that reads back, defaulting grid to empty', async () => {
    const res = await put('my-custom', { name: 'Custom', widgets: ['apps', 'cos'] });
    expect(res.status).toBe(200);
    expect(findLayout(await getState(), 'my-custom')).toMatchObject({
      name: 'Custom', builtIn: false, widgets: ['apps', 'cos'], grid: [], activateWindow: null,
    });
  });

  it('replaces an existing layout in place on a second save', async () => {
    await put('my-custom', { name: 'Custom', widgets: ['apps'] });
    await put('my-custom', { name: 'Renamed', widgets: ['apps', 'cos'] });
    const state = await getState();
    expect(state.layouts.filter((l) => l.id === 'my-custom')).toHaveLength(1);
    expect(findLayout(state, 'my-custom')).toMatchObject({ name: 'Renamed', widgets: ['apps', 'cos'] });
  });

  it('saves a layout with a grid and reads it back densely ordered', async () => {
    const res = await put('my-custom', {
      name: 'Custom',
      widgets: ['apps', 'cos'],
      grid: [
        { id: 'apps', x: 0, w: 12, order: 0, h: 4 },
        { id: 'cos', x: 0, w: 6, order: 1, h: 3 },
      ],
    });
    expect(res.status).toBe(200);
    expect(findLayout(await getState(), 'my-custom').grid).toEqual([
      { id: 'apps', x: 0, w: 12, order: 0, h: 4 },
      { id: 'cos', x: 0, w: 6, order: 1, h: 3 },
    ]);
  });

  // A stale client bundle still posts the pre-#4133 `{ x, y, w, h }` shape;
  // the route has to let it through so the service can convert it rather than
  // 400-ing the user's save.
  it('accepts a legacy grid item that carries `y` and converts it to an order', async () => {
    const res = await put('my-custom', {
      name: 'Custom',
      widgets: ['apps', 'cos'],
      grid: [
        { id: 'cos', x: 0, y: 8, w: 6, h: 3 },
        { id: 'apps', x: 0, y: 4, w: 12, h: 4 },
      ],
    });
    expect(res.status).toBe(200);
    expect(findLayout(await getState(), 'my-custom').grid.map(({ id, order }) => [id, order]))
      .toEqual([['apps', 0], ['cos', 1]]);
  });

  it('rejects invalid layout ids', async () => {
    const res = await put('NotKebab', { name: 'x', widgets: [] });
    expect(res.status).toBe(400);
    expect((await getState()).layouts.map((l) => l.id)).not.toContain('NotKebab');
  });

  it('rejects duplicate widget ids', async () => {
    await expectRejectedAndUnsaved(await put('my-custom', { name: 'Custom', widgets: ['apps', 'cos', 'apps'] }), 'my-custom');
  });

  it('rejects grid items that reference unknown widgets', async () => {
    await expectRejectedAndUnsaved(await put('my-custom', {
      name: 'Custom',
      widgets: ['apps'],
      grid: [{ id: 'apps', x: 0, w: 4, order: 0, h: 4 }, { id: 'ghost', x: 4, w: 4, order: 1, h: 4 }],
    }), 'my-custom');
  });

  it('rejects grid items where x+w exceeds the column count', async () => {
    await expectRejectedAndUnsaved(await put('my-custom', {
      name: 'Custom',
      widgets: ['apps'],
      grid: [{ id: 'apps', x: 6, w: 8, order: 0, h: 4 }],
    }), 'my-custom');
  });

  it('rejects duplicate grid ids', async () => {
    await expectRejectedAndUnsaved(await put('my-custom', {
      name: 'Custom',
      widgets: ['apps'],
      grid: [
        { id: 'apps', x: 0, w: 4, order: 0, h: 4 },
        { id: 'apps', x: 4, w: 4, order: 1, h: 4 },
      ],
    }), 'my-custom');
  });

  describe('activateWindow', () => {
    it('saves a valid window', async () => {
      const res = await put('morning', { name: 'Morning', widgets: ['upcoming-tasks'], activateWindow: { start: '06:00', end: '11:00' } });
      expect(res.status).toBe(200);
      expect(findLayout(await getState(), 'morning').activateWindow).toEqual({ start: '06:00', end: '11:00' });
    });

    it('preserves the window when a later save omits the key, and clears it on null', async () => {
      await put('morning', { name: 'Morning', widgets: ['upcoming-tasks'], activateWindow: { start: '06:00', end: '11:00' } });
      await put('morning', { name: 'Morning', widgets: ['upcoming-tasks', 'apps'] });
      expect(findLayout(await getState(), 'morning').activateWindow).toEqual({ start: '06:00', end: '11:00' });

      const cleared = await put('morning', { name: 'Morning', widgets: ['upcoming-tasks'], activateWindow: null });
      expect(cleared.status).toBe(200);
      expect(findLayout(await getState(), 'morning').activateWindow).toBeNull();
    });

    it('rejects off-format time strings', async () => {
      await expectRejectedAndUnsaved(await put('morning', {
        name: 'Morning', widgets: ['upcoming-tasks'], activateWindow: { start: '25:99', end: '11:00' },
      }), 'morning');
    });

    it('rejects start === end', async () => {
      await expectRejectedAndUnsaved(await put('morning', {
        name: 'Morning', widgets: ['upcoming-tasks'], activateWindow: { start: '06:00', end: '06:00' },
      }), 'morning');
    });
  });
});

describe('DELETE /api/dashboard/layouts/:id', () => {
  it('deletes a user layout and resets the active layout when it was active', async () => {
    await put('my-custom', { name: 'Custom', widgets: ['apps'] });
    await request(app).put(`${BASE}/active`).send({ id: 'my-custom' });

    const res = await request(app).delete(`${BASE}/my-custom`);
    expect(res.status).toBe(200);
    const state = await getState();
    expect(findLayout(state, 'my-custom')).toBeUndefined();
    expect(state.activeLayoutId).toBe('default');
  });

  it('400s when trying to delete a built-in layout and keeps it', async () => {
    expect((await request(app).delete(`${BASE}/default`)).status).toBe(400);
    expect(findLayout(await getState(), 'default')).toBeDefined();
  });

  it('404s when deleting an unknown layout', async () => {
    expect((await request(app).delete(`${BASE}/nope`)).status).toBe(404);
  });
});

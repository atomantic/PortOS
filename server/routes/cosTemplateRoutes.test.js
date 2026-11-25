import { afterAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// Real task-templates service (cos/task-templates.json) over a temp data root.
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-cos-templates-routes-') }));
afterAll(cleanupTempDataRoots);

const { default: templateRoutes } = await import('./cosTemplateRoutes.js');

const app = express();
app.use(express.json());
app.use('/api/cos', templateRoutes);
app.use(errorMiddleware);

const api = (method, path, body) => request(app)[method](`/api/cos/templates${path}`).send(body);
const listed = async () => (await api('get', '')).body.templates;
const userTemplates = async () => (await listed()).filter((t) => !t.isBuiltin);

describe('CoS template routes', () => {
  it('creates a user template that lists with the built-ins, then updates, records usage on and deletes it', async () => {
    const builtinCount = (await listed()).filter((t) => t.isBuiltin).length;
    expect(builtinCount).toBeGreaterThan(0);

    const created = await api('post', '', { name: 'Fix Bug', description: 'Fix a bug in the app', category: 'bugs' });
    expect(created.status).toBe(200);
    const { id } = created.body.template;
    expect(created.body.template).toMatchObject({ name: 'Fix Bug', isBuiltin: false, category: 'bugs' });
    expect(await listed()).toContainEqual(expect.objectContaining({ id, name: 'Fix Bug', useCount: 0 }));

    const updated = await api('put', `/${id}`, { name: 'Fix Bugs' });
    expect(updated.status).toBe(200);
    // An absent field leaves the stored value alone.
    expect((await userTemplates()).find((t) => t.id === id)).toMatchObject({ name: 'Fix Bugs', description: 'Fix a bug in the app', category: 'bugs' });

    expect((await api('post', `/${id}/use`)).body.useCount).toBe(1);
    expect((await api('post', `/${id}/use`)).body.useCount).toBe(2);
    expect((await listed()).find((t) => t.id === id).useCount).toBe(2);
    expect((await api('get', '/popular?limit=1')).body.templates.map((t) => t.id)).toEqual([id]);

    const deleted = await api('delete', `/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.success).toBe(true);
    expect((await listed()).map((t) => t.id)).not.toContain(id);
    expect((await listed()).filter((t) => t.isBuiltin)).toHaveLength(builtinCount);
  });

  it('serves the default popular limit of five', async () => {
    expect((await api('get', '/popular')).body.templates).toHaveLength(5);
  });

  it('persists a valid slashdo binding on a user template', async () => {
    const settings = { useWorktree: false, openPR: false, simplify: false };
    const { body } = await api('post', '', { name: 'Plan', description: 'Plan a task', slashdoCommand: 'plan-task', settings });
    expect((await userTemplates()).find((t) => t.id === body.template.id)).toMatchObject({ slashdoCommand: 'plan-task', settings });
  });

  it('refuses invalid create bodies without persisting anything', async () => {
    const before = await userTemplates();
    expect((await api('post', '', { description: 'No name' })).status).toBe(400);
    expect((await api('post', '', { name: 'No description' })).status).toBe(400);
    // The bare command name is joined into a commands/do/<name>.md path, so the schema keeps it inert (#3089).
    expect((await api('post', '', { name: 'Escape', description: 'nope', slashdoCommand: '../../etc/passwd' })).status).toBe(400);
    expect((await api('post', '', { name: 'Odd', description: 'nope', settings: { autoMerge: true } })).status).toBe(400);
    expect(await userTemplates()).toEqual(before);
  });

  it('answers 400 when updating or deleting an unknown template and when deleting a built-in', async () => {
    expect((await api('put', '/user-missing', { name: 'Fail' })).status).toBe(400);
    expect((await api('delete', '/user-missing')).status).toBe(400);
    const builtin = (await listed()).find((t) => t.isBuiltin);
    expect((await api('delete', `/${builtin.id}`)).status).toBe(400);
    expect((await listed()).map((t) => t.id)).toContain(builtin.id);
  });
});

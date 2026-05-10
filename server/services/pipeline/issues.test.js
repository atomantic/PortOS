import { describe, it, expect, vi, beforeEach } from 'vitest';

const fileStore = new Map();

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

const svc = await import('./issues.js');

describe('pipeline issues service', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it('createIssue assigns iss- id and auto-numbers within a series', async () => {
    const a = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    const b = await svc.createIssue({ seriesId: 'ser-1', title: 'Second' });
    const c = await svc.createIssue({ seriesId: 'ser-2', title: 'Other series first' });
    expect(a.id).toMatch(/^iss-/);
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(c.number).toBe(1); // independent counter per series
  });

  it('createIssue requires seriesId and title', async () => {
    await expect(svc.createIssue({ title: 'x' })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
    await expect(svc.createIssue({ seriesId: 'ser-1' })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('every stage is initialized to "empty"', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    for (const id of svc.STAGE_IDS) {
      expect(i.stages[id].status).toBe('empty');
      expect(i.stages[id].output).toBe('');
    }
  });

  it('updateStage patches only the named stage', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    const { issue, stage } = await svc.updateStage(i.id, 'idea', {
      status: 'ready',
      output: '# Beat sheet ...',
      lastRunId: 'run-123',
    });
    expect(stage.status).toBe('ready');
    expect(stage.output).toBe('# Beat sheet ...');
    expect(stage.lastRunId).toBe('run-123');
    expect(stage.updatedAt).toBeTruthy();
    // Prose should still be empty.
    expect(issue.stages.prose.status).toBe('empty');
    expect(issue.stages.prose.output).toBe('');
  });

  it('updateStage rejects unknown stage ids', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    await expect(svc.updateStage(i.id, 'bogus', { status: 'ready' })).rejects.toMatchObject({ code: svc.ERR_VALIDATION });
  });

  it('updateStage on a visual stage preserves arrays', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    const { stage } = await svc.updateStage(i.id, 'comicPages', {
      status: 'ready',
      pages: [{ panels: [{ imageJobId: 'j1' }] }],
    });
    expect(stage.pages).toHaveLength(1);
    expect(stage.pages[0].panels[0].imageJobId).toBe('j1');
  });

  it('listIssues filters by seriesId and orders by number', async () => {
    await svc.createIssue({ seriesId: 'ser-1', title: 'Issue 1' });
    await svc.createIssue({ seriesId: 'ser-2', title: 'Other 1' });
    await svc.createIssue({ seriesId: 'ser-1', title: 'Issue 2' });
    const list1 = await svc.listIssues({ seriesId: 'ser-1' });
    expect(list1.map((i) => i.number)).toEqual([1, 2]);
    expect(list1.every((i) => i.seriesId === 'ser-1')).toBe(true);
  });

  it('updateIssue partial patch preserves other fields', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    await svc.updateStage(i.id, 'idea', { status: 'ready', output: 'Beats here' });
    const updated = await svc.updateIssue(i.id, { status: 'shipped' });
    expect(updated.status).toBe('shipped');
    expect(updated.title).toBe('First');
    expect(updated.stages.idea.output).toBe('Beats here');
  });

  it('deleteIssue 404s on second call', async () => {
    const i = await svc.createIssue({ seriesId: 'ser-1', title: 'First' });
    await svc.deleteIssue(i.id);
    await expect(svc.deleteIssue(i.id)).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });
});

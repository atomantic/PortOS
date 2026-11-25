/**
 * GSD routes over the real GSD service and a real git checkout. `gsd.test.js`
 * mocks both, so a planning-document save that commits the wrong files, or a
 * parser that no longer reads `.planning/`, passes there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { mkdir, realpath, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { errorMiddleware } from '../lib/errorHandler.js';
import { execGit } from '../lib/execGit.js';
import { destroyGitSandbox, makeGitSandbox } from '../lib/gitTestRepo.js';
import { request } from '../lib/testHelper.js';

const state = vi.hoisted(() => ({ apps: [], addTask: vi.fn() }));
vi.mock('../services/apps.js', () => ({ getActiveApps: async () => state.apps }));
vi.mock('../services/cos/cosTaskStore.js', () => ({ addTask: state.addTask }));

import gsdRoutes from './gsd.js';

const CONCERNS = `# Concerns

## Security Considerations
- Token is logged

## Scaling Limits
- One worker
`;

describe('GSD planning workflow', () => {
  let scratch;
  let repo;
  let base;
  let app;

  const git = async (...args) => (await execGit(args, repo)).stdout.trim();
  const plan = async (path, content) => {
    const file = join(repo, '.planning', path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  };

  beforeEach(async () => {
    ({ scratch, repo } = await makeGitSandbox());
    repo = await realpath(repo);
    // The project cache is keyed by app id, so each sandbox gets its own.
    const id = basename(dirname(repo));
    state.apps = [{ id, name: 'Example App', repoPath: repo }];
    state.addTask.mockImplementation(async task => ({ ...task }));
    await plan('CONCERNS.md', CONCERNS);
    await git('add', '.planning');
    await git('commit', '-m', 'planning');
    base = `/api/cos/gsd/projects/${id}`;
    app = express();
    app.use(express.json());
    app.use('/api/cos/gsd', gsdRoutes);
    app.use(errorMiddleware);
  });

  afterEach(async () => {
    await destroyGitSandbox(scratch);
  });

  it('commits only the saved document and leaves unrelated staged work staged', async () => {
    await writeFile(join(repo, 'wip.txt'), 'unfinished');
    await git('add', 'wip.txt');

    const response = await request(app).put(`${base}/documents/STATE.md`).send({ content: '# State\n' });

    expect(response.status).toBe(200);
    expect(await git('show', '--name-only', '--format=', 'HEAD')).toBe('.planning/STATE.md');
    expect(await git('diff', '--cached', '--name-only')).toBe('wip.txt');
  });

  it('reports no change for an unchanged document in a dirty checkout', async () => {
    const head = await git('rev-parse', 'HEAD');
    await writeFile(join(repo, 'wip.txt'), 'unfinished');

    const response = await request(app).put(`${base}/documents/CONCERNS.md`).send({ content: CONCERNS });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, noChanges: true });
    expect(await git('rev-parse', 'HEAD')).toBe(head);
  });

  it('turns parsed concerns into app-scoped tasks, reading a just-saved document', async () => {
    const before = await request(app).get(base);
    expect(before.body.concerns.sections.map(s => [s.title, s.severity])).toEqual([
      ['Security Considerations', 'CRITICAL'], ['Scaling Limits', 'LOW'],
    ]);

    await request(app).put(`${base}/documents/CONCERNS.md`)
      .send({ content: `${CONCERNS}\n## Known Bugs\n- Save drops a row\n` });
    const response = await request(app).post(`${base}/concerns/tasks`).send({ all: true });

    expect(response.body.created).toBe(3);
    expect(state.addTask.mock.calls.map(([task]) => [task.description, task.priority, task.metadata.app])).toEqual([
      ['[GSD:Concern] Security Considerations: Token is logged', 'HIGH', state.apps[0].id],
      ['[GSD:Concern] Scaling Limits: One worker', 'LOW', state.apps[0].id],
      ['[GSD:Concern] Known Bugs: Save drops a row', 'HIGH', state.apps[0].id],
    ]);
  });

  it('offers the next action each phase is ready for', async () => {
    await mkdir(join(repo, '.planning', 'phases', '1'), { recursive: true });
    await plan('phases/2/02-01-PLAN.md', '---\nphase: 2\n---\n- [x] done\n- [ ] open\n');
    await plan('phases/3/03-01-PLAN.md', '- [x] done\n');
    await plan('phases/4/04-01-PLAN.md', '- [x] done\n');
    await plan('phases/4/04-VERIFICATION.md', 'status: gaps_found\n');
    await plan('phases/10/10-01-PLAN.md', '- [X] done\n');
    await plan('phases/10/10-VERIFICATION.md', 'status: passed\nscore: 9.5\n');

    const response = await request(app).get(`${base}/phases`);

    expect(response.body.phases.map(p => [p.id, p.completedTasks, p.totalTasks])).toEqual([
      ['1', 0, 0], ['2', 1, 2], ['3', 1, 1], ['4', 1, 1], ['10', 1, 1],
    ]);
    expect(response.body.pendingActions.map(a => [a.phaseId, a.nextAction])).toEqual([
      ['1', 'plan'], ['2', 'execute'], ['3', 'verify'], ['4', 'verify'],
    ]);
  });

  it('lists a project whose optional planning documents are missing', async () => {
    const response = await request(app).get('/api/cos/gsd/projects');

    expect(response.body.projects).toEqual([expect.objectContaining({
      appName: 'Example App', hasRoadmap: false, hasState: false, hasConcerns: true,
    })]);
  });
});

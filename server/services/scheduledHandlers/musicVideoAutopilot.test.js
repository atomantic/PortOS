import { describe, it, expect, vi, beforeEach } from 'vitest';

const ideas = [];
const projects = [];
const startAutonomousVideo = vi.fn();
vi.mock('../brainStorage.js', () => ({ getIdeas: async () => ideas }));
vi.mock('../musicVideo/projects.js', () => ({ listProjects: async () => projects }));
vi.mock('../musicVideo/autonomousService.js', () => ({ startAutonomousVideo }));

const { countPending, run } = await import('./musicVideoAutopilot.js');

const idea = (id, createdAt, extra = {}) => ({ id, title: `Idea ${id}`, oneLiner: `about ${id}`, status: 'active', createdAt, tags: [], ...extra });
const project = (name, status, ideaId, kind = 'schedule') => ({ name, autonomousRun: { status, brief: { origin: { kind, ideaId } } } });

beforeEach(() => {
  ideas.length = 0;
  projects.length = 0;
  startAutonomousVideo.mockReset();
  startAutonomousVideo.mockImplementation(async () => ({ project: { name: 'Made' } }));
});

describe('music-video-autopilot scheduled handler', () => {
  it('starts one run from the oldest unused idea, carrying the task settings and the idea as origin', async () => {
    ideas.push(idea('new', '2026-02-01T00:00:00.000Z'), idea('old', '2026-01-01T00:00:00.000Z'));
    const out = await run({ params: { musicVideoAutopilot: { tools: ['code:render'], checkpoints: ['lyrics'], providerId: 'prov', model: 'm' } } });
    expect(out).toMatchObject({ dispatched: true });
    expect(startAutonomousVideo).toHaveBeenCalledTimes(1);
    expect(startAutonomousVideo.mock.calls[0][0]).toMatchObject({
      tools: ['code:render'], checkpoints: ['lyrics'], providerId: 'prov', model: 'm',
      prompt: expect.stringContaining('Idea old'), origin: { kind: 'schedule', ideaId: 'old', ideaTitle: 'Idea old' },
    });
  });

  it('skips ideas an earlier run is using or finished, but not ones whose run failed or was canceled', async () => {
    ideas.push(idea('a', '2026-01-01T00:00:00.000Z'), idea('b', '2026-01-02T00:00:00.000Z'), idea('c', '2026-01-03T00:00:00.000Z'));
    projects.push(project('A', 'completed', 'a'), project('B', 'failed', 'b'));
    await run({ params: {} });
    expect(startAutonomousVideo.mock.calls[0][0].origin.ideaId).toBe('b');
  });

  it('declines while a scheduled run is still live, so videos never pile up', async () => {
    ideas.push(idea('a', '2026-01-01T00:00:00.000Z'));
    projects.push(project('In flight', 'needs-human', 'zzz'));
    expect(await run({ params: {} })).toMatchObject({ dispatched: false, reason: expect.stringContaining('In flight') });
    expect(await countPending({ params: {} })).toMatchObject({ count: 0 });
    expect(startAutonomousVideo).not.toHaveBeenCalled();
  });

  it('declines with a reason when no idea is eligible, honoring the tag filter', async () => {
    ideas.push(idea('a', '2026-01-01T00:00:00.000Z', { tags: ['poem'] }));
    expect(await run({ params: { musicVideoAutopilot: { ideaTags: ['song'] } } })).toMatchObject({ dispatched: false });
    expect(await countPending({ params: { musicVideoAutopilot: { ideaTags: ['poem'] } } })).toMatchObject({ count: 1 });
    expect(startAutonomousVideo).not.toHaveBeenCalled();
  });
});

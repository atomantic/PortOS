import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./taskSchedule.js', () => ({
  getScheduleStatus: vi.fn()
}));

vi.mock('./autonomousJobs.js', () => ({
  getAllJobs: vi.fn()
}));

vi.mock('./jobGates.js', () => ({
  checkJobGate: vi.fn(),
  hasGate: vi.fn(),
  getRegisteredGates: vi.fn()
}));

const { getScheduleStatus } = await import('./taskSchedule.js');
const { getAllJobs } = await import('./autonomousJobs.js');
const { checkJobGate, hasGate, getRegisteredGates } = await import('./jobGates.js');
const { getWorkflowGraph, projectWorkflowTimeline, WORKFLOW_STAGES } = await import('./workflow.js');

const STAGE_IDS = WORKFLOW_STAGES.map(s => s.id);

beforeEach(() => {
  vi.clearAllMocks();
  getRegisteredGates.mockReturnValue([]);
  hasGate.mockReturnValue(false);
});

describe('WORKFLOW_STAGES contract', () => {
  it('canonical stages exist in expected order', () => {
    expect(STAGE_IDS).toEqual(['hygiene', 'review', 'plan', 'audit', 'build', 'report', 'ambient']);
  });

  it('places do-replan in the plan stage and feature-ideas in build', () => {
    const planStage = WORKFLOW_STAGES.find(s => s.id === 'plan');
    const buildStage = WORKFLOW_STAGES.find(s => s.id === 'build');
    expect(planStage.taskTypes).toContain('do-replan');
    expect(buildStage.taskTypes).toContain('feature-ideas');
  });

  it('places branch-cleanup in the hygiene stage and pr-reviewer in review', () => {
    const hygiene = WORKFLOW_STAGES.find(s => s.id === 'hygiene');
    const review = WORKFLOW_STAGES.find(s => s.id === 'review');
    expect(hygiene.taskTypes).toContain('branch-cleanup');
    expect(review.taskTypes).toContain('pr-reviewer');
  });

  it('does not place the same task type in two stages', () => {
    const seen = new Set();
    for (const stage of WORKFLOW_STAGES) {
      for (const t of stage.taskTypes) {
        expect(seen.has(t), `task type ${t} appears in multiple stages`).toBe(false);
        seen.add(t);
      }
    }
  });

  it('does not place the same job id in two stages', () => {
    const seen = new Set();
    for (const stage of WORKFLOW_STAGES) {
      for (const j of stage.jobIds) {
        expect(seen.has(j), `job id ${j} appears in multiple stages`).toBe(false);
        seen.add(j);
      }
    }
  });
});

describe('getWorkflowGraph', () => {
  it('returns nodes for tasks with their stage classification', async () => {
    getScheduleStatus.mockResolvedValue({
      tasks: {
        'do-replan': { type: 'weekly', enabled: true, runAfter: ['pr-reviewer'], lastRun: null, runCount: 0, status: { shouldRun: true, reason: 'weekly-due' } },
        'feature-ideas': { type: 'daily', enabled: true, runAfter: ['do-replan'], lastRun: null, runCount: 0, status: { shouldRun: false, reason: 'waiting-on-dependencies', pendingDeps: ['do-replan'] } }
      }
    });
    getAllJobs.mockResolvedValue([]);

    const graph = await getWorkflowGraph();

    const replan = graph.nodes.find(n => n.id === 'task:do-replan');
    expect(replan).toBeDefined();
    expect(replan.stage).toBe('plan');
    expect(replan.kind).toBe('task');
    expect(replan.runAfter).toEqual(['pr-reviewer']);
    expect(replan.shouldRun).toBe(true);

    const featureIdeas = graph.nodes.find(n => n.id === 'task:feature-ideas');
    expect(featureIdeas.stage).toBe('build');
    expect(featureIdeas.blocked).toBe('waiting-on-dependencies');
    expect(featureIdeas.pendingDeps).toEqual(['do-replan']);
  });

  it('emits a depends-on edge for every runAfter entry', async () => {
    getScheduleStatus.mockResolvedValue({
      tasks: {
        'feature-ideas': { type: 'daily', enabled: true, runAfter: ['do-replan'], lastRun: null, runCount: 0, status: { shouldRun: true } }
      }
    });
    getAllJobs.mockResolvedValue([]);

    const graph = await getWorkflowGraph();
    const dep = graph.edges.find(e => e.kind === 'depends-on' && e.to === 'task:feature-ideas');
    expect(dep).toEqual({ from: 'task:do-replan', to: 'task:feature-ideas', kind: 'depends-on' });
  });

  it('classifies known job IDs into their canonical stage', async () => {
    getScheduleStatus.mockResolvedValue({ tasks: {} });
    getAllJobs.mockResolvedValue([
      { id: 'job-daily-briefing', name: 'Daily Briefing', enabled: true, interval: 'daily', lastRun: null, runCount: 0 },
      { id: 'job-system-health-check', name: 'System Health Check', enabled: true, interval: 'custom', intervalMs: 900000, lastRun: null, runCount: 0 }
    ]);

    const graph = await getWorkflowGraph();
    const briefing = graph.nodes.find(n => n.id === 'job:job-daily-briefing');
    const health = graph.nodes.find(n => n.id === 'job:job-system-health-check');
    expect(briefing.stage).toBe('report');
    expect(health.stage).toBe('ambient');
  });

  it('falls back to ambient stage for unknown task types and jobs', async () => {
    getScheduleStatus.mockResolvedValue({
      tasks: {
        'custom-thing': { type: 'daily', enabled: true, runAfter: [], lastRun: null, runCount: 0, status: { shouldRun: true } }
      }
    });
    getAllJobs.mockResolvedValue([
      { id: 'job-custom', name: 'Custom', enabled: false, interval: 'daily', lastRun: null, runCount: 0 }
    ]);

    const graph = await getWorkflowGraph();
    expect(graph.nodes.find(n => n.id === 'task:custom-thing').stage).toBe('ambient');
    expect(graph.nodes.find(n => n.id === 'job:job-custom').stage).toBe('ambient');
  });

  it('emits stage-flow edges only between populated stages', async () => {
    // Only plan and build populated — flow edge should connect plan → build directly
    getScheduleStatus.mockResolvedValue({
      tasks: {
        'do-replan': { type: 'weekly', enabled: true, runAfter: [], lastRun: null, runCount: 0, status: { shouldRun: true } },
        'feature-ideas': { type: 'daily', enabled: true, runAfter: [], lastRun: null, runCount: 0, status: { shouldRun: true } }
      }
    });
    getAllJobs.mockResolvedValue([]);

    const graph = await getWorkflowGraph();
    const stageEdges = graph.edges.filter(e => e.kind === 'stage-flow');
    expect(stageEdges).toEqual([{ from: 'plan', to: 'build', kind: 'stage-flow' }]);
  });

  it('includes gate state for jobs that have a registered gate', async () => {
    getScheduleStatus.mockResolvedValue({ tasks: {} });
    getAllJobs.mockResolvedValue([
      { id: 'job-brain-review', name: 'Brain Review', enabled: true, interval: 'daily', lastRun: null, runCount: 0 }
    ]);
    getRegisteredGates.mockReturnValue(['job-brain-review']);
    hasGate.mockImplementation(id => id === 'job-brain-review');
    checkJobGate.mockResolvedValue({ shouldRun: false, reason: 'No inbox items need review' });

    const graph = await getWorkflowGraph();
    const node = graph.nodes.find(n => n.id === 'job:job-brain-review');
    expect(node.gate).toEqual({ shouldRun: false, reason: 'No inbox items need review' });
    expect(node.blocked).toBe('No inbox items need review');
    expect(node.shouldRun).toBe(false);
  });

  it('treats gate errors as fail-open', async () => {
    getScheduleStatus.mockResolvedValue({ tasks: {} });
    getAllJobs.mockResolvedValue([
      { id: 'job-brain-review', name: 'Brain Review', enabled: true, interval: 'daily', lastRun: null, runCount: 0 }
    ]);
    getRegisteredGates.mockReturnValue(['job-brain-review']);
    hasGate.mockImplementation(id => id === 'job-brain-review');
    checkJobGate.mockRejectedValue(new Error('boom'));

    const graph = await getWorkflowGraph();
    const node = graph.nodes.find(n => n.id === 'job:job-brain-review');
    expect(node.gate.shouldRun).toBe(true);
    expect(node.gate.error).toBe(true);
  });

  it('reports per-stage enabled/total counts', async () => {
    getScheduleStatus.mockResolvedValue({
      tasks: {
        'do-replan': { type: 'weekly', enabled: true, runAfter: [], lastRun: null, runCount: 0, status: { shouldRun: true } },
        'feature-ideas': { type: 'daily', enabled: false, runAfter: [], lastRun: null, runCount: 0, status: { shouldRun: false, reason: 'disabled' } }
      }
    });
    getAllJobs.mockResolvedValue([]);

    const graph = await getWorkflowGraph();
    const planStage = graph.stages.find(s => s.id === 'plan');
    const buildStage = graph.stages.find(s => s.id === 'build');
    expect(planStage).toMatchObject({ nodeCount: 1, enabledCount: 1 });
    expect(buildStage).toMatchObject({ nodeCount: 1, enabledCount: 0 });
  });
});

describe('projectWorkflowTimeline', () => {
  const range = {
    start: new Date('2026-07-09T00:00:00.000Z'),
    end: new Date('2026-07-10T00:00:00.000Z'),
    timezone: 'America/Los_Angeles'
  };

  it('projects pinned cron tasks onto the shared clock', () => {
    const timeline = projectWorkflowTimeline([{
      id: 'task:morning', kind: 'task', enabled: true, schedule: { type: 'cron', cronExpression: '30 9 * * *' }
    }], range);

    expect(timeline.occurrences).toEqual([
      expect.objectContaining({ nodeId: 'task:morning', at: '2026-07-09T16:30:00.000Z', kind: 'launch' })
    ]);
  });

  it('renders an active perpetual task as an open-ended drain window and its reset', () => {
    const timeline = projectWorkflowTimeline([{
      id: 'task:drain', kind: 'task', enabled: true, shouldRun: true,
      schedule: { type: 'perpetual', recheckCron: '0 9 * * *' }
    }], range);

    expect(timeline.windows[0]).toMatchObject({ nodeId: 'task:drain', state: 'draining' });
    expect(timeline.occurrences[0]).toMatchObject({ nodeId: 'task:drain', at: '2026-07-09T16:00:00.000Z', kind: 'recheck' });
  });

  it('does not show an app-scoped perpetual task draining when every tracked app is parked', () => {
    const timeline = projectWorkflowTimeline([{
      id: 'task:drain', kind: 'task', enabled: true, shouldRun: true,
      perpetual: { globalParked: false, trackedAppCount: 2, parkedAppCount: 2 },
      schedule: { type: 'perpetual', recheckCron: '0 9 * * *' }
    }], range);

    expect(timeline.windows).toEqual([]);
    expect(timeline.occurrences[0]).toMatchObject({ nodeId: 'task:drain', kind: 'recheck' });
  });

  it('places an already-due interval task at the start of the timeline', () => {
    const timeline = projectWorkflowTimeline([{
      id: 'task:due', kind: 'task', enabled: true, shouldRun: true,
      lastRun: '2026-07-07T00:00:00.000Z',
      schedule: { type: 'daily', effectiveIntervalMs: 86_400_000 }
    }], range);

    expect(timeline.occurrences[0]).toMatchObject({ nodeId: 'task:due', at: range.start.toISOString(), kind: 'launch' });
  });

  it('omits weekend occurrences for weekday-only interval tasks', () => {
    const timeline = projectWorkflowTimeline([{
      id: 'task:weekdays', kind: 'task', enabled: true, shouldRun: false,
      lastRun: '2026-07-10T09:00:00.000Z',
      nextRunAt: '2026-07-11T09:00:00.000Z',
      schedule: { type: 'daily', effectiveIntervalMs: 86_400_000, weekdaysOnly: true }
    }], {
      start: new Date('2026-07-10T10:00:00.000Z'),
      end: new Date('2026-07-13T10:00:00.000Z'),
      timezone: 'Etc/UTC'
    });

    // Sat 7/11 and Sun 7/12 slots are skipped — shouldRunTask refuses
    // weekday-only tasks on weekends regardless of schedule type.
    expect(timeline.occurrences).toEqual([
      expect.objectContaining({ nodeId: 'task:weekdays', at: '2026-07-13T09:00:00.000Z' })
    ]);
  });

  it('omits weekend slots for weekday-only cron tasks', () => {
    const timeline = projectWorkflowTimeline([{
      id: 'task:cron-weekdays', kind: 'task', enabled: true, shouldRun: false,
      schedule: { type: 'cron', cronExpression: '0 9 * * *', weekdaysOnly: true }
    }], {
      start: new Date('2026-07-10T10:00:00.000Z'),
      end: new Date('2026-07-13T10:00:00.000Z'),
      timezone: 'Etc/UTC'
    });

    expect(timeline.occurrences).toEqual([
      expect.objectContaining({ nodeId: 'task:cron-weekdays', at: '2026-07-13T09:00:00.000Z', kind: 'launch' })
    ]);
  });

  it('does not duplicate the due-now marker when a cron slot lands exactly on the window start', () => {
    const timeline = projectWorkflowTimeline([{
      id: 'task:now', kind: 'task', enabled: true, shouldRun: true,
      schedule: { type: 'cron', cronExpression: '0 0 * * *' }
    }], {
      start: new Date('2026-07-09T00:00:00.000Z'),
      end: new Date('2026-07-10T00:00:00.000Z'),
      timezone: 'Etc/UTC'
    });

    expect(timeline.occurrences).toEqual([
      expect.objectContaining({ nodeId: 'task:now', at: '2026-07-09T00:00:00.000Z', kind: 'launch' })
    ]);
    const ids = timeline.occurrences.map(item => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('omits weekend occurrences for weekday-only interval jobs', () => {
    const timeline = projectWorkflowTimeline([{
      id: 'job:weekdays', kind: 'job', enabled: true,
      lastRun: '2026-07-10T09:00:00.000Z',
      schedule: { type: 'daily', intervalMs: 86_400_000, weekdaysOnly: true }
    }], {
      start: new Date('2026-07-10T10:00:00.000Z'),
      end: new Date('2026-07-13T10:00:00.000Z'),
      timezone: 'UTC'
    });

    expect(timeline.occurrences).toEqual([
      expect.objectContaining({ nodeId: 'job:weekdays', at: '2026-07-13T09:00:00.000Z' })
    ]);
  });

  it('flags launches from different nodes within fifteen minutes', () => {
    const timeline = projectWorkflowTimeline([
      { id: 'task:a', kind: 'task', enabled: true, schedule: { type: 'cron', cronExpression: '0 9 * * *' } },
      { id: 'job:b', kind: 'job', enabled: true, schedule: { type: 'cron', cronExpression: '10 9 * * *' } }
    ], range);

    expect(timeline.occurrences).toHaveLength(2);
    expect(timeline.occurrences.every(item => item.collision)).toBe(true);
  });

  it('leaves rotation and on-demand tasks unpinned', () => {
    const timeline = projectWorkflowTimeline([
      { id: 'task:rotation', kind: 'task', enabled: true, schedule: { type: 'rotation' } },
      { id: 'task:demand', kind: 'task', enabled: true, schedule: { type: 'on-demand' } }
    ], range);

    expect(timeline.occurrences).toEqual([]);
    expect(timeline.windows).toEqual([]);
  });
});

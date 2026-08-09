import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { existsSync, rmSync } from 'fs';
import path from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

// Mock cosEvents before import
vi.mock('./cos.js', () => ({
  cosEvents: {
    emit: vi.fn()
  }
}));

// This suite exercises the REAL file-backed mission store — createMission writes
// `PATHS.missions/<id>.json` and loadMissions enumerates that dir with a real
// readdir. Without a PATHS redirect that dir is the checkout's own
// `data/cos/missions`, so the suite both read the developer's live missions (one
// with no `subTasks` crashed getStats) and wrote its own fixtures into it — the
// same leak class as #3683. `PATHS.missions` is anchored on the install root
// rather than derived from `PATHS.data`, so it needs an override of its own.
const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({
  prefix: 'portos-missions-',
  extraOverrides: (root) => ({ missions: path.join(root, 'cos', 'missions') }),
});
vi.mock('../lib/fileUtils.js', async (importOriginal) => makeProxy(await importOriginal()));

afterAll(cleanup);

// Dynamic import, not a static one: `missions.js` reads `PATHS.missions` into a
// module-level const at load time, and a static import would run that load
// BEFORE the `mockPathsDataRoot()` line above — the hoisted mock factory would
// then close over an uninitialized `makeProxy`. Top-level await defers the load
// until after it exists.
//
// So the static imports at the top of this file must never transitively reach
// `../lib/fileUtils.js`, or the factory runs during their evaluation and throws
// `Cannot access 'makeProxy' before initialization`. `vi.hoisted()` does NOT fix
// that — it hoists above the imports too, putting `mockPathsDataRoot` itself in
// TDZ (verified: `Cannot access '__vi_import_0__' before initialization`). Keep
// new static imports here dependency-free, or make them dynamic as well.
const {
  createMission,
  getMission,
  getMissionsForApp,
  getActiveMissions,
  updateMission,
  addSubTask,
  completeSubTask,
  generateMissionTask,
  generateProactiveTasks,
  recordMissionReview,
  getStats,
  deleteMission,
  archiveCompletedMissions,
  invalidateCache
} = await import('./missions.js');

const DATA_DIR = path.join(tempRoot, 'cos', 'missions');

describe('Missions Service', () => {
  beforeEach(() => {
    invalidateCache();
    // The temp root is this suite's alone, so wiping the whole missions dir is
    // both simpler and stricter than unlinking `test-`-prefixed files.
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    invalidateCache();
  });

  describe('createMission', () => {
    it('should create a new mission with defaults', async () => {
      const mission = await createMission({
        id: 'test-mission-1',
        appId: 'test-app',
        name: 'Test Mission'
      });

      expect(mission.id).toBe('test-mission-1');
      expect(mission.appId).toBe('test-app');
      expect(mission.name).toBe('Test Mission');
      expect(mission.status).toBe('active');
      expect(mission.progress).toBe(0);
      expect(mission.autonomyLevel).toBe('full');

      await deleteMission('test-mission-1');
    });

    it('should set custom fields', async () => {
      const mission = await createMission({
        id: 'test-mission-2',
        appId: 'test-app',
        name: 'Test Mission',
        description: 'Test description',
        goals: ['Goal 1', 'Goal 2'],
        priority: 'high',
        autonomyLevel: 'approval-required'
      });

      expect(mission.description).toBe('Test description');
      expect(mission.goals).toEqual(['Goal 1', 'Goal 2']);
      expect(mission.priority).toBe('high');
      expect(mission.autonomyLevel).toBe('approval-required');

      await deleteMission('test-mission-2');
    });
  });

  describe('getMission', () => {
    it('should retrieve a mission by ID', async () => {
      const created = await createMission({
        id: 'test-get-mission',
        appId: 'test-app',
        name: 'Get Test'
      });

      const retrieved = await getMission('test-get-mission');
      expect(retrieved).not.toBeNull();
      expect(retrieved.id).toBe('test-get-mission');

      await deleteMission('test-get-mission');
    });

    it('should return null for non-existent mission', async () => {
      const result = await getMission('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getMissionsForApp', () => {
    it('should get missions for a specific app', async () => {
      await createMission({
        id: 'test-app-mission-1',
        appId: 'specific-app',
        name: 'Mission 1'
      });
      await createMission({
        id: 'test-app-mission-2',
        appId: 'specific-app',
        name: 'Mission 2'
      });
      await createMission({
        id: 'test-app-mission-3',
        appId: 'other-app',
        name: 'Mission 3'
      });

      const missions = await getMissionsForApp('specific-app');
      expect(missions.length).toBe(2);
      expect(missions.every(m => m.appId === 'specific-app')).toBe(true);

      await deleteMission('test-app-mission-1');
      await deleteMission('test-app-mission-2');
      await deleteMission('test-app-mission-3');
    });
  });

  describe('updateMission', () => {
    it('should update mission fields', async () => {
      await createMission({
        id: 'test-update-mission',
        appId: 'test-app',
        name: 'Update Test'
      });

      const updated = await updateMission('test-update-mission', {
        progress: 50,
        status: 'paused'
      });

      expect(updated.progress).toBe(50);
      expect(updated.status).toBe('paused');

      await deleteMission('test-update-mission');
    });

    it('should return null for non-existent mission', async () => {
      const result = await updateMission('nonexistent', { progress: 50 });
      expect(result).toBeNull();
    });
  });

  describe('addSubTask', () => {
    it('should add a sub-task to a mission', async () => {
      await createMission({
        id: 'test-subtask-mission',
        appId: 'test-app',
        name: 'SubTask Test'
      });

      const updated = await addSubTask('test-subtask-mission', {
        description: 'Sub-task 1',
        priority: 'high'
      });

      expect(updated.subTasks.length).toBe(1);
      expect(updated.subTasks[0].description).toBe('Sub-task 1');
      expect(updated.subTasks[0].status).toBe('pending');
      expect(updated.metrics.tasksGenerated).toBe(1);

      await deleteMission('test-subtask-mission');
    });
  });

  describe('completeSubTask', () => {
    it('should mark sub-task as completed', async () => {
      await createMission({
        id: 'test-complete-mission',
        appId: 'test-app',
        name: 'Complete Test'
      });

      const withTask = await addSubTask('test-complete-mission', {
        description: 'Task to complete'
      });

      const subTaskId = withTask.subTasks[0].id;
      const updated = await completeSubTask('test-complete-mission', subTaskId, {
        success: true,
        output: 'Task completed'
      });

      expect(updated.subTasks[0].status).toBe('completed');
      expect(updated.metrics.tasksCompleted).toBe(1);
      expect(updated.progress).toBe(100);

      await deleteMission('test-complete-mission');
    });

    it('should mark sub-task as failed', async () => {
      await createMission({
        id: 'test-fail-mission',
        appId: 'test-app',
        name: 'Fail Test'
      });

      const withTask = await addSubTask('test-fail-mission', {
        description: 'Task to fail'
      });

      const subTaskId = withTask.subTasks[0].id;
      const updated = await completeSubTask('test-fail-mission', subTaskId, {
        success: false,
        error: 'Task failed'
      });

      expect(updated.subTasks[0].status).toBe('failed');
      expect(updated.metrics.tasksCompleted).toBe(0);

      await deleteMission('test-fail-mission');
    });
  });

  describe('generateMissionTask', () => {
    it('should generate task from pending sub-task', async () => {
      await createMission({
        id: 'test-generate-mission',
        appId: 'test-app',
        name: 'Generate Test'
      });

      await addSubTask('test-generate-mission', {
        description: 'Pending task',
        priority: 'high'
      });

      const task = await generateMissionTask('test-generate-mission');

      expect(task).not.toBeNull();
      expect(task.description).toBe('Pending task');
      expect(task.metadata.missionId).toBe('test-generate-mission');
      expect(task.metadata.isMissionTask).toBe(true);

      await deleteMission('test-generate-mission');
    });

    it('should return null for mission with no pending tasks', async () => {
      await createMission({
        id: 'test-no-pending-mission',
        appId: 'test-app',
        name: 'No Pending Test'
      });

      const task = await generateMissionTask('test-no-pending-mission');
      expect(task).toBeNull();

      await deleteMission('test-no-pending-mission');
    });
  });

  describe('generateProactiveTasks', () => {
    it('should generate tasks from active missions', async () => {
      await createMission({
        id: 'test-proactive-1',
        appId: 'test-app',
        name: 'Proactive 1'
      });

      await addSubTask('test-proactive-1', {
        description: 'Proactive task 1'
      });

      const tasks = await generateProactiveTasks({ maxTasks: 5 });
      expect(tasks.length).toBeGreaterThanOrEqual(1);

      await deleteMission('test-proactive-1');
    });

    it('should respect maxTasks limit', async () => {
      await createMission({
        id: 'test-proactive-limit',
        appId: 'test-app',
        name: 'Limit Test'
      });

      await addSubTask('test-proactive-limit', { description: 'Task 1' });
      await addSubTask('test-proactive-limit', { description: 'Task 2' });
      await addSubTask('test-proactive-limit', { description: 'Task 3' });

      const tasks = await generateProactiveTasks({ maxTasks: 1 });
      expect(tasks.length).toBeLessThanOrEqual(1);

      await deleteMission('test-proactive-limit');
    });
  });

  describe('recordMissionReview', () => {
    it('should update lastReviewedAt', async () => {
      await createMission({
        id: 'test-review-mission',
        appId: 'test-app',
        name: 'Review Test'
      });

      const updated = await recordMissionReview('test-review-mission');
      expect(updated.lastReviewedAt).not.toBeNull();

      await deleteMission('test-review-mission');
    });
  });

  describe('getStats', () => {
    it('should return mission statistics', async () => {
      await createMission({
        id: 'test-stats-mission',
        appId: 'test-app',
        name: 'Stats Test'
      });

      const stats = await getStats();
      expect(stats).toHaveProperty('totalMissions');
      expect(stats).toHaveProperty('byStatus');
      expect(stats).toHaveProperty('averageProgress');

      await deleteMission('test-stats-mission');
    });
  });

  describe('deleteMission', () => {
    it('should delete a mission', async () => {
      await createMission({
        id: 'test-delete-mission',
        appId: 'test-app',
        name: 'Delete Test'
      });

      const deleted = await deleteMission('test-delete-mission');
      expect(deleted).toBe(true);

      const retrieved = await getMission('test-delete-mission');
      expect(retrieved).toBeNull();
    });
  });

  describe('archiveCompletedMissions', () => {
    it('should archive old completed missions', async () => {
      // Create a mission and mark it completed
      await createMission({
        id: 'test-archive-mission',
        appId: 'test-app',
        name: 'Archive Test'
      });

      await updateMission('test-archive-mission', {
        status: 'completed',
        completedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() // 8 days ago
      });

      const archived = await archiveCompletedMissions();
      expect(archived).toBeGreaterThanOrEqual(0);

      const mission = await getMission('test-archive-mission');
      if (mission) {
        expect(mission.status).toBe('archived');
        await deleteMission('test-archive-mission');
      }
    });
  });
});

// Isolation probe for #3687 — these fail the same way if the PATHS redirect at
// the top of the file is ever dropped, so the leak can't come back silently.
describe('Missions Service — the suite is isolated from the checkout\'s real data/', () => {
  it('resolves PATHS.missions to a temp dir outside the repo', async () => {
    const { PATHS } = await import('../lib/fileUtils.js');
    expect(PATHS.missions).toBe(DATA_DIR);
  });

  // Asserts WHERE the record landed, not just how many came back. A count alone
  // would pass on a fresh checkout with the redirect removed — real
  // `data/cos/missions` is empty there, so writing one and reading one back still
  // gives 1. Only the path assertion fails in that case.
  it('writes its missions under the temp root, and reads back only its own', async () => {
    await createMission({ id: 'test-isolation-probe', appId: 'test-app', name: 'Isolation Probe' });
    expect(existsSync(path.join(DATA_DIR, 'test-isolation-probe.json'))).toBe(true);
    const stats = await getStats();
    expect(stats.totalMissions).toBe(1);
  });
});

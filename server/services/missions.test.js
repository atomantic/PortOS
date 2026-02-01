import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';

// Mock cosEvents before import
vi.mock('./cos.js', () => ({
  cosEvents: {
    emit: vi.fn()
  }
}));

import {
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
} from './missions.js';

const DATA_DIR = path.join(process.cwd(), 'data', 'cos', 'missions');

describe('Missions Service', () => {
  beforeEach(async () => {
    invalidateCache();
    // Clean up test missions
    const files = await fs.readdir(DATA_DIR).catch(() => []);
    for (const file of files) {
      if (file.startsWith('test-')) {
        await fs.unlink(path.join(DATA_DIR, file)).catch(() => {});
      }
    }
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

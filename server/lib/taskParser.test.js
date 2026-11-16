import { describe, it, expect } from 'vitest';
import {
  getAutoApprovedTasks,
  getAwaitingApprovalTasks,
  groupTasksByStatus,
  TASK_PRIORITY_VALUES,
  TASK_STATUS_VALUES,
} from './taskParser.js';

describe('taskParser', () => {
  it('owns the closed status and priority vocabularies', () => {
    expect([...TASK_STATUS_VALUES].sort())
      .toEqual(['blocked', 'challenged', 'completed', 'in_progress', 'pending']);
    expect([...TASK_PRIORITY_VALUES].sort())
      .toEqual(['CRITICAL', 'HIGH', 'LOW', 'MEDIUM']);
  });

  describe('groupTasksByStatus', () => {
    it('should group tasks by status', () => {
      const tasks = [
        { id: 'task-001', status: 'pending' },
        { id: 'task-002', status: 'pending' },
        { id: 'task-003', status: 'in_progress' },
        { id: 'task-004', status: 'completed' },
        { id: 'task-005', status: 'blocked' }
      ];

      const grouped = groupTasksByStatus(tasks);

      expect(grouped.pending).toHaveLength(2);
      expect(grouped.in_progress).toHaveLength(1);
      expect(grouped.completed).toHaveLength(1);
      expect(grouped.blocked).toHaveLength(1);
    });

    it('should return empty arrays for missing statuses', () => {
      const tasks = [{ id: 'task-001', status: 'pending' }];
      const grouped = groupTasksByStatus(tasks);

      expect(grouped.in_progress).toHaveLength(0);
      expect(grouped.completed).toHaveLength(0);
      expect(grouped.blocked).toHaveLength(0);
    });

    it('should handle empty array', () => {
      const grouped = groupTasksByStatus([]);

      expect(grouped.pending).toHaveLength(0);
      expect(grouped.in_progress).toHaveLength(0);
      expect(grouped.completed).toHaveLength(0);
      expect(grouped.blocked).toHaveLength(0);
    });
  });

  describe('getAutoApprovedTasks', () => {
    it('should return only auto-approved pending tasks', () => {
      const tasks = [
        { id: 'sys-001', status: 'pending', autoApproved: true, approvalRequired: false },
        { id: 'sys-002', status: 'pending', autoApproved: false, approvalRequired: true },
        { id: 'sys-003', status: 'completed', autoApproved: true, approvalRequired: false }
      ];

      const autoApproved = getAutoApprovedTasks(tasks);

      expect(autoApproved).toHaveLength(1);
      expect(autoApproved[0].id).toBe('sys-001');
    });
  });

  describe('getAwaitingApprovalTasks', () => {
    it('should return only tasks awaiting approval', () => {
      const tasks = [
        { id: 'sys-001', status: 'pending', autoApproved: true, approvalRequired: false },
        { id: 'sys-002', status: 'pending', autoApproved: false, approvalRequired: true },
        { id: 'sys-003', status: 'pending', autoApproved: false, approvalRequired: true }
      ];

      const awaiting = getAwaitingApprovalTasks(tasks);

      expect(awaiting).toHaveLength(2);
    });
  });

});

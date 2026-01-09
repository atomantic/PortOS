import { describe, it, expect } from 'vitest';
import {
  parseTasksMarkdown,
  groupTasksByStatus,
  sortByPriority,
  generateTasksMarkdown,
  getAutoApprovedTasks,
  getAwaitingApprovalTasks,
  updateTaskStatus,
  addTask,
  removeTask,
  getNextTask,
  validateTask
} from './taskParser.js';

describe('Task Parser', () => {
  describe('parseTasksMarkdown', () => {
    it('should parse a simple pending task', () => {
      const markdown = `# Tasks

## Pending
- [ ] #task-001 | HIGH | Fix the login bug`;

      const tasks = parseTasksMarkdown(markdown);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].id).toBe('task-001');
      expect(tasks[0].status).toBe('pending');
      expect(tasks[0].priority).toBe('HIGH');
      expect(tasks[0].priorityValue).toBe(3);
      expect(tasks[0].description).toBe('Fix the login bug');
    });

    it('should parse all priority levels', () => {
      const markdown = `# Tasks

## Pending
- [ ] #task-001 | CRITICAL | Critical task
- [ ] #task-002 | HIGH | High task
- [ ] #task-003 | MEDIUM | Medium task
- [ ] #task-004 | LOW | Low task`;

      const tasks = parseTasksMarkdown(markdown);

      expect(tasks).toHaveLength(4);
      expect(tasks[0].priority).toBe('CRITICAL');
      expect(tasks[0].priorityValue).toBe(4);
      expect(tasks[1].priority).toBe('HIGH');
      expect(tasks[1].priorityValue).toBe(3);
      expect(tasks[2].priority).toBe('MEDIUM');
      expect(tasks[2].priorityValue).toBe(2);
      expect(tasks[3].priority).toBe('LOW');
      expect(tasks[3].priorityValue).toBe(1);
    });

    it('should parse all status types', () => {
      const markdown = `# Tasks

## Pending
- [ ] #task-001 | MEDIUM | Pending task

## In Progress
- [~] #task-002 | MEDIUM | In progress task

## Blocked
- [!] #task-003 | MEDIUM | Blocked task

## Completed
- [x] #task-004 | MEDIUM | Completed task`;

      const tasks = parseTasksMarkdown(markdown);

      expect(tasks).toHaveLength(4);
      expect(tasks[0].status).toBe('pending');
      expect(tasks[1].status).toBe('in_progress');
      expect(tasks[2].status).toBe('blocked');
      expect(tasks[3].status).toBe('completed');
    });

    it('should parse tasks with approval flags', () => {
      const markdown = `# Tasks

## Pending
- [ ] #sys-001 | HIGH | AUTO | Auto-approved task
- [ ] #sys-002 | MEDIUM | APPROVAL | Needs approval task`;

      const tasks = parseTasksMarkdown(markdown);

      expect(tasks).toHaveLength(2);
      expect(tasks[0].autoApproved).toBe(true);
      expect(tasks[0].approvalRequired).toBe(false);
      expect(tasks[1].autoApproved).toBe(false);
      expect(tasks[1].approvalRequired).toBe(true);
    });

    it('should parse metadata under tasks', () => {
      const markdown = `# Tasks

## Pending
- [ ] #task-001 | HIGH | Fix the bug
  - Context: User reported issue
  - App: my-app
  - Model: claude-sonnet`;

      const tasks = parseTasksMarkdown(markdown);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].metadata.context).toBe('User reported issue');
      expect(tasks[0].metadata.app).toBe('my-app');
      expect(tasks[0].metadata.model).toBe('claude-sonnet');
    });

    it('should handle empty content', () => {
      const tasks = parseTasksMarkdown('');
      expect(tasks).toHaveLength(0);
    });

    it('should handle content with only headers', () => {
      const markdown = `# Tasks

## Pending

## Completed`;

      const tasks = parseTasksMarkdown(markdown);
      expect(tasks).toHaveLength(0);
    });

    it('should preserve section information', () => {
      const markdown = `# Tasks

## Pending
- [ ] #task-001 | MEDIUM | Pending task

## In Progress
- [~] #task-002 | MEDIUM | In progress task`;

      const tasks = parseTasksMarkdown(markdown);

      expect(tasks[0].section).toBe('pending');
      expect(tasks[1].section).toBe('in_progress');
    });

    it('should add task- prefix if not present', () => {
      const markdown = `# Tasks

## Pending
- [ ] #001 | MEDIUM | Task without prefix`;

      const tasks = parseTasksMarkdown(markdown);
      expect(tasks[0].id).toBe('task-001');
    });

    it('should not double-prefix sys- tasks', () => {
      const markdown = `# Tasks

## Pending
- [ ] #sys-001 | MEDIUM | System task`;

      const tasks = parseTasksMarkdown(markdown);
      expect(tasks[0].id).toBe('sys-001');
    });
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

  describe('sortByPriority', () => {
    it('should sort tasks by priority (highest first)', () => {
      const tasks = [
        { id: 'task-001', priorityValue: 1 },
        { id: 'task-002', priorityValue: 4 },
        { id: 'task-003', priorityValue: 2 },
        { id: 'task-004', priorityValue: 3 }
      ];

      const sorted = sortByPriority(tasks);

      expect(sorted[0].priorityValue).toBe(4);
      expect(sorted[1].priorityValue).toBe(3);
      expect(sorted[2].priorityValue).toBe(2);
      expect(sorted[3].priorityValue).toBe(1);
    });

    it('should not mutate original array', () => {
      const tasks = [
        { id: 'task-001', priorityValue: 1 },
        { id: 'task-002', priorityValue: 4 }
      ];
      const original = [...tasks];

      sortByPriority(tasks);

      expect(tasks[0].id).toBe(original[0].id);
    });
  });

  describe('generateTasksMarkdown', () => {
    it('should generate markdown from tasks', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', priority: 'HIGH', priorityValue: 3, description: 'Test task', metadata: {} }
      ];

      const markdown = generateTasksMarkdown(tasks);

      expect(markdown).toContain('# Tasks');
      expect(markdown).toContain('## Pending');
      expect(markdown).toContain('- [ ] #task-001 | HIGH | Test task');
    });

    it('should include approval flags when requested', () => {
      const tasks = [
        { id: 'sys-001', status: 'pending', priority: 'HIGH', priorityValue: 3, description: 'Auto task', metadata: {}, autoApproved: true },
        { id: 'sys-002', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Approval task', metadata: {}, approvalRequired: true }
      ];

      const markdown = generateTasksMarkdown(tasks, true);

      expect(markdown).toContain('| AUTO |');
      expect(markdown).toContain('| APPROVAL |');
    });

    it('should include metadata in output', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Test', metadata: { context: 'Some context', app: 'my-app' } }
      ];

      const markdown = generateTasksMarkdown(tasks);

      expect(markdown).toContain('- Context: Some context');
      expect(markdown).toContain('- App: my-app');
    });

    it('should sort tasks by priority within sections', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', priority: 'LOW', priorityValue: 1, description: 'Low', metadata: {} },
        { id: 'task-002', status: 'pending', priority: 'HIGH', priorityValue: 3, description: 'High', metadata: {} }
      ];

      const markdown = generateTasksMarkdown(tasks);
      const highIndex = markdown.indexOf('High');
      const lowIndex = markdown.indexOf('Low');

      expect(highIndex).toBeLessThan(lowIndex);
    });

    it('should skip empty sections', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Test', metadata: {} }
      ];

      const markdown = generateTasksMarkdown(tasks);

      expect(markdown).toContain('## Pending');
      expect(markdown).not.toContain('## In Progress');
      expect(markdown).not.toContain('## Completed');
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

  describe('updateTaskStatus', () => {
    it('should update task status', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', metadata: {} },
        { id: 'task-002', status: 'pending', metadata: {} }
      ];

      const updated = updateTaskStatus(tasks, 'task-001', 'in_progress');

      expect(updated[0].status).toBe('in_progress');
      expect(updated[1].status).toBe('pending');
    });

    it('should merge metadata when updating', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', metadata: { context: 'old' } }
      ];

      const updated = updateTaskStatus(tasks, 'task-001', 'in_progress', { agent: 'agent-123' });

      expect(updated[0].metadata.context).toBe('old');
      expect(updated[0].metadata.agent).toBe('agent-123');
    });

    it('should not mutate original array', () => {
      const tasks = [{ id: 'task-001', status: 'pending', metadata: {} }];
      const updated = updateTaskStatus(tasks, 'task-001', 'completed');

      expect(tasks[0].status).toBe('pending');
      expect(updated[0].status).toBe('completed');
    });
  });

  describe('addTask', () => {
    it('should add a new task', () => {
      const tasks = [];
      const newTasks = addTask(tasks, {
        id: 'new-task',
        priority: 'HIGH',
        description: 'New task'
      });

      expect(newTasks).toHaveLength(1);
      expect(newTasks[0].id).toBe('task-new-task');
      expect(newTasks[0].status).toBe('pending');
      expect(newTasks[0].priority).toBe('HIGH');
    });

    it('should not double-prefix task- ids', () => {
      const tasks = [];
      const newTasks = addTask(tasks, {
        id: 'task-001',
        description: 'Test'
      });

      expect(newTasks[0].id).toBe('task-001');
    });

    it('should default to MEDIUM priority', () => {
      const tasks = [];
      const newTasks = addTask(tasks, {
        id: '001',
        description: 'Test'
      });

      expect(newTasks[0].priority).toBe('MEDIUM');
      expect(newTasks[0].priorityValue).toBe(2);
    });
  });

  describe('removeTask', () => {
    it('should remove task by ID', () => {
      const tasks = [
        { id: 'task-001' },
        { id: 'task-002' },
        { id: 'task-003' }
      ];

      const remaining = removeTask(tasks, 'task-002');

      expect(remaining).toHaveLength(2);
      expect(remaining.find(t => t.id === 'task-002')).toBeUndefined();
    });

    it('should return same array if task not found', () => {
      const tasks = [{ id: 'task-001' }];
      const remaining = removeTask(tasks, 'task-999');

      expect(remaining).toHaveLength(1);
    });
  });

  describe('getNextTask', () => {
    it('should return highest priority pending task', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', priorityValue: 1 },
        { id: 'task-002', status: 'pending', priorityValue: 4 },
        { id: 'task-003', status: 'pending', priorityValue: 2 }
      ];

      const next = getNextTask(tasks);

      expect(next.id).toBe('task-002');
    });

    it('should return null if no pending tasks', () => {
      const tasks = [
        { id: 'task-001', status: 'completed', priorityValue: 4 }
      ];

      const next = getNextTask(tasks);

      expect(next).toBeNull();
    });

    it('should return null for empty array', () => {
      const next = getNextTask([]);
      expect(next).toBeNull();
    });
  });

  describe('validateTask', () => {
    it('should validate a correct task', () => {
      const task = {
        id: 'task-001',
        description: 'Test task',
        status: 'pending',
        priority: 'HIGH'
      };

      const result = validateTask(task);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject task without id', () => {
      const task = {
        description: 'Test',
        status: 'pending',
        priority: 'HIGH'
      };

      const result = validateTask(task);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Task must have a valid id');
    });

    it('should reject task without description', () => {
      const task = {
        id: 'task-001',
        status: 'pending',
        priority: 'HIGH'
      };

      const result = validateTask(task);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Task must have a description');
    });

    it('should reject task with invalid status', () => {
      const task = {
        id: 'task-001',
        description: 'Test',
        status: 'invalid',
        priority: 'HIGH'
      };

      const result = validateTask(task);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid task status');
    });

    it('should reject task with invalid priority', () => {
      const task = {
        id: 'task-001',
        description: 'Test',
        status: 'pending',
        priority: 'INVALID'
      };

      const result = validateTask(task);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid priority (must be CRITICAL, HIGH, MEDIUM, or LOW)');
    });

    it('should collect multiple errors', () => {
      const task = {
        status: 'invalid',
        priority: 'INVALID'
      };

      const result = validateTask(task);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(2);
    });
  });
});

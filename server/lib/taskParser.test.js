import { describe, it, expect, vi } from 'vitest';
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
  validateTask,
  TASK_STATUS_VALUES,
  TASK_PRIORITY_VALUES,
  UNKNOWN_STATUS_BLOCKED_CATEGORY
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
      // Legacy Title-Case keys are normalized to camelCase (Context→context)
      expect(tasks[0].metadata.context).toBe('User reported issue');
      expect(tasks[0].metadata.app).toBe('my-app');
      expect(tasks[0].metadata.model).toBe('claude-sonnet');
    });

    it('should preserve camelCase metadata keys', () => {
      const markdown = `# Tasks

## Pending
- [ ] #task-001 | HIGH | Fix the bug
  - openPR: true
  - useWorktree: true
  - reviewLoop: false`;

      const tasks = parseTasksMarkdown(markdown);

      expect(tasks).toHaveLength(1);
      expect(tasks[0].metadata.openPR).toBe('true');
      expect(tasks[0].metadata.useWorktree).toBe('true');
      expect(tasks[0].metadata.reviewLoop).toBe('false');
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

    it('should preserve every task when ids collide, suffixing duplicates', () => {
      const markdown = `# Tasks

## Pending
- [ ] #task-001 | HIGH | First task
- [ ] #task-001 | LOW | Second task with same id
- [ ] #task-001 | MEDIUM | Third task with same id`;

      const tasks = parseTasksMarkdown(markdown);

      // All three survive (the bug being fixed silently lost 2 of 3 on reorder)
      expect(tasks).toHaveLength(3);
      expect(tasks.map(t => t.id)).toEqual(['task-001', 'task-001-dup2', 'task-001-dup3']);
      // Descriptions stay paired with their suffixed ids — no data loss
      expect(tasks[1].description).toBe('Second task with same id');
      expect(tasks[2].description).toBe('Third task with same id');
    });

    it('should produce ids unique enough for a keyed Map (the reorderTasks contract)', () => {
      const markdown = `# Tasks

## Pending
- [ ] #task-001 | HIGH | A
- [ ] #task-001 | LOW | B
- [ ] #task-002 | MEDIUM | C`;

      const tasks = parseTasksMarkdown(markdown);
      const byId = new Map(tasks.map(t => [t.id, t]));

      // Map size must equal task count — no silent collapse
      expect(byId.size).toBe(tasks.length);
      expect(byId.size).toBe(3);
    });

    it('should rename the duplicate, never a distinct task that looks like a suffix', () => {
      const markdown = `# Tasks

## Pending
- [ ] #task-001 | HIGH | A
- [ ] #task-001 | LOW | B
- [ ] #task-001-dup2 | MEDIUM | C already named like a suffix`;

      const tasks = parseTasksMarkdown(markdown);

      // The duplicate of task-001 skips `-dup2` (a real id elsewhere in the file)
      // and takes `-dup3`; the user-authored `task-001-dup2` keeps its stable id.
      expect(tasks.map(t => t.id)).toEqual(['task-001', 'task-001-dup3', 'task-001-dup2']);
      expect(tasks.map(t => t.description)).toEqual(['A', 'B', 'C already named like a suffix']);
      // Still no re-collision.
      expect(new Set(tasks.map(t => t.id)).size).toBe(tasks.length);
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

      expect(markdown).toContain('- context: Some context');
      expect(markdown).toContain('- app: my-app');
    });

    // #7240 — a newline in `description` is not a cosmetic problem: the lines
    // after the break re-parse as FILE STRUCTURE. Callers normalize first
    // (cosTaskStore re-homes the body into metadata); this is the write-side
    // backstop that stops a future writer from reintroducing the corruption.
    it('flattens a newline in description so the row can never become file structure', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const description = 'Fix the login flow\nAlso update:\n  - app: other-app\n- [ ] #task-999 | HIGH | phantom task';
      const markdown = generateTasksMarkdown([
        { id: 'task-001', status: 'pending', priority: 'HIGH', priorityValue: 3, description, metadata: { context: 'note', app: 'my-app' } }
      ]);
      const warnCalls = warn.mock.calls;
      warn.mockRestore(); // before the assertions, so a failure can't leave console.warn mocked

      // One warn per flattened description, and no row carrying a line break.
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0][0]).toContain('task-001');
      expect(markdown.split('\n').filter(l => l.startsWith('- ['))).toHaveLength(1);

      // The file still holds exactly one task, with its own metadata intact and
      // no phantom task minted out of the pasted checklist row.
      const parsed = parseTasksMarkdown(markdown);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].metadata.app).toBe('my-app');
      expect(parsed[0].metadata.context).toBe('note');
    });

    it('should escape newlines in metadata values for round-trip preservation', () => {
      const multiLineContext = '## Additional Instructions\nFix the bug\n\n## Previous Context\nAgent ID: agent-123';
      const tasks = [
        { id: 'task-001', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Resume task', metadata: { context: multiLineContext } }
      ];

      const markdown = generateTasksMarkdown(tasks);

      // Should contain escaped newlines
      expect(markdown).toContain('\\n');
      expect(markdown).not.toContain('\n## Additional');

      // Round-trip test: parse it back and verify context is preserved
      const parsed = parseTasksMarkdown(markdown);
      expect(parsed[0].metadata.context).toBe(multiLineContext);
    });

    // #4153 — the agent-facing payload moved from `metadata.context` to
    // `metadata.prompt`. Round-trip safety is the whole reason it lives in
    // metadata rather than `description`, so pin it for the new key too.
    it('should round-trip a multi-line metadata.prompt alongside a one-line metadata.context', () => {
      const prompt = 'Ship the thing\n\n## Phase 1\n- Read PLAN.md\n- [ ] not a task line';
      const markdown = generateTasksMarkdown([
        { id: 'task-001', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Ship the thing', metadata: { prompt, context: 'a short note' } }
      ]);
      // The embedded `- [ ]` and `##` lines must NOT become a task/section.
      const parsed = parseTasksMarkdown(markdown);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].metadata.prompt).toBe(prompt);
      expect(parsed[0].metadata.context).toBe('a short note');
    });

    it('should round-trip array and object metadata values (screenshots, attachments, reviewers)', () => {
      const tasks = [
        {
          id: 'task-001', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Test',
          metadata: {
            screenshots: ['/data/screenshots/a.png', '/data/screenshots/b.png'],
            attachments: [{ filename: 'a.png', originalName: 'photo.png', path: '/data/cos/attachments/a.png' }],
            reviewers: ['codex', 'claude'],
          }
        }
      ];

      const markdown = generateTasksMarkdown(tasks);
      // Pre-stringifying before escapeNewlines would flatten the array to a
      // bare comma-joined string ("a.png,b.png") or "[object Object]" — assert
      // the JSON sentinel is present so a regression here fails loudly.
      expect(markdown).toMatch(/- screenshots: __json__:\[/);
      expect(markdown).toMatch(/- attachments: __json__:\[/);

      const parsed = parseTasksMarkdown(markdown);
      expect(parsed[0].metadata.screenshots).toEqual(['/data/screenshots/a.png', '/data/screenshots/b.png']);
      expect(parsed[0].metadata.attachments).toEqual([
        { filename: 'a.png', originalName: 'photo.png', path: '/data/cos/attachments/a.png' }
      ]);
      expect(parsed[0].metadata.reviewers).toEqual(['codex', 'claude']);
    });

    it('should drop nullish metadata instead of persisting the word "null"', () => {
      // Producers build metadata with explicit `?? null` placeholders
      // (spawnReviewLoopFollowUp's `app`, `reviewLoopPRNumber`, …). Writing
      // `app: null` made every reader see the TRUTHY string 'null', which
      // blocked the follow-up with `app-unresolved` and orphaned its PR.
      const tasks = [
        {
          id: 'sys-rl-001', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Follow-up',
          metadata: { app: null, reviewLoopReviewerEfforts: undefined, existingBranch: 'cos/task-001/agent-abc' }
        }
      ];

      const markdown = generateTasksMarkdown(tasks);
      expect(markdown).not.toMatch(/- app:/);
      expect(markdown).not.toMatch(/- reviewLoopReviewerEfforts:/);
      expect(markdown).toMatch(/- existingBranch: cos\/task-001\/agent-abc/);

      const parsed = parseTasksMarkdown(markdown);
      expect(parsed[0].metadata.app).toBeUndefined();
      expect(parsed[0].metadata.existingBranch).toBe('cos/task-001/agent-abc');
    });

    it('should read a legacy bare "null" metadata value back as null, not the string', () => {
      // Self-heals task files a pre-fix install already wrote. Without this the
      // corrupt `app: null` survives every save/load cycle forever.
      const parsed = parseTasksMarkdown([
        '# Tasks',
        '',
        '## Pending',
        '- [ ] #sys-rl-001 | MEDIUM | AUTO | Follow-up',
        '  - app: null',
        '  - reviewLoopCodexModel: undefined',
        '  - reviewLoopPRBranch: cos/task-001/agent-abc',
        ''
      ].join('\n'));

      expect(parsed[0].metadata.app).toBeNull();
      expect(parsed[0].metadata.reviewLoopCodexModel).toBeUndefined();
      expect(parsed[0].metadata.reviewLoopPRBranch).toBe('cos/task-001/agent-abc');
    });

    it('should round-trip a metadata value that is genuinely the string "null"', () => {
      // The read-side coercion above must not eat a real value — a legitimate
      // "null" is written through the JSON sentinel so it stays a string.
      const tasks = [
        {
          id: 'task-001', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Test',
          metadata: { app: 'null', context: 'undefined' }
        }
      ];

      const markdown = generateTasksMarkdown(tasks);
      expect(markdown).toMatch(/- app: __json__:"null"/);

      const parsed = parseTasksMarkdown(markdown);
      expect(parsed[0].metadata.app).toBe('null');
      expect(parsed[0].metadata.context).toBe('undefined');
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
    it('should return first pending task in queue order', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', priority: 'LOW', priorityValue: 1 },
        { id: 'task-002', status: 'pending', priority: 'HIGH', priorityValue: 4 },
        { id: 'task-003', status: 'pending', priority: 'MEDIUM', priorityValue: 2 }
      ];

      const next = getNextTask(tasks);

      // Should return first in queue, not highest priority
      expect(next.id).toBe('task-001');
    });

    it('should prioritize critical auto-fix tasks over queue order', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', priority: 'LOW', priorityValue: 1 },
        { id: 'sys-002', status: 'pending', priority: 'HIGH', priorityValue: 3, description: 'Fix critical error: something broke' },
        { id: 'task-003', status: 'pending', priority: 'MEDIUM', priorityValue: 2 }
      ];

      const next = getNextTask(tasks);

      // Should return the critical auto-fix task even though it's not first
      expect(next.id).toBe('sys-002');
    });

    it('should prioritize CRITICAL priority system tasks', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', priority: 'HIGH', priorityValue: 3 },
        { id: 'sys-002', status: 'pending', priority: 'CRITICAL', priorityValue: 4, description: 'System issue' },
        { id: 'task-003', status: 'pending', priority: 'MEDIUM', priorityValue: 2 }
      ];

      const next = getNextTask(tasks);

      expect(next.id).toBe('sys-002');
    });

    it('should not prioritize regular system tasks without critical indicators', () => {
      const tasks = [
        { id: 'task-001', status: 'pending', priority: 'LOW', priorityValue: 1 },
        { id: 'sys-002', status: 'pending', priority: 'MEDIUM', priorityValue: 2, description: 'Regular system task' },
        { id: 'task-003', status: 'pending', priority: 'HIGH', priorityValue: 3 }
      ];

      const next = getNextTask(tasks);

      // Should return first in queue since sys-002 is not a critical auto-fix
      expect(next.id).toBe('task-001');
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

describe('Task Parser — challenged status (#2441)', () => {
  it('parses a [?] challenged task line', () => {
    const tasks = parseTasksMarkdown(`# Tasks

## Challenged
- [?] #task-900 | HIGH | Disputed rejection task`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].status).toBe('challenged');
    expect(tasks[0].id).toBe('task-900');
  });

  it('round-trips a challenged task (parse → generate → parse) with its metadata', () => {
    const tasks = [{
      id: 'task-901',
      status: 'challenged',
      priority: 'HIGH',
      priorityValue: 3,
      description: 'Dispute',
      metadata: {
        challengeCount: 1,
        challenge: { reason: 'reviewer misread the diff', reviewer: 'ollama' },
      },
    }];
    const md = generateTasksMarkdown(tasks);
    expect(md).toContain('## Challenged');
    expect(md).toContain('- [?] #task-901');
    const reparsed = parseTasksMarkdown(md);
    expect(reparsed[0].status).toBe('challenged');
    // challengeCount survives as a string after the markdown round-trip.
    expect(String(reparsed[0].metadata.challengeCount)).toBe('1');
    expect(reparsed[0].metadata.challenge.reason).toBe('reviewer misread the diff');
  });

  it('groups challenged tasks into their own bucket', () => {
    const grouped = groupTasksByStatus([
      { id: 'a', status: 'challenged' },
      { id: 'b', status: 'pending' },
    ]);
    expect(grouped.challenged.map((t) => t.id)).toEqual(['a']);
  });

  it('validates challenged as a legal status', () => {
    const result = validateTask({ id: 'task-902', description: 'x', status: 'challenged', priority: 'HIGH' });
    expect(result.valid).toBe(true);
  });
});

describe('unrepresentable status/priority never drops a task (#7239)', () => {
  // TASKS.md is the ONLY store for a queued task and every write is a full-file
  // rewrite, so a value the format cannot represent used to delete the task and
  // its `metadata.prompt` outright: an unknown status fell out of every bucket in
  // `groupTasksByStatus` and was written nowhere; an unknown priority reached the
  // file and then failed `parseTaskLine`'s regex on the next read.
  const tasks = [
    { id: 'task-A', status: 'pending', priority: 'HIGH', priorityValue: 3, description: 'keep me', metadata: { context: 'a' } },
    { id: 'task-B', status: 'archived', priority: 'HIGH', priorityValue: 3, description: 'unknown status', metadata: { prompt: 'the agent-facing payload' } },
    { id: 'task-C', status: 'pending', priority: 'URGENT', priorityValue: 2, description: 'unknown priority', metadata: { context: 'c' } },
  ];

  it('survives a generate -> parse round trip with its metadata intact', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reparsed = parseTasksMarkdown(generateTasksMarkdown(tasks));
    warn.mockRestore();

    expect(reparsed.map(t => t.id).sort()).toEqual(['task-A', 'task-B', 'task-C']);
    // The whole point: the prompt payload is not lost with the row.
    expect(reparsed.find(t => t.id === 'task-B').metadata.prompt).toBe('the agent-facing payload');
  });

  it('parks the unknown status as blocked and records what it was', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repaired = parseTasksMarkdown(generateTasksMarkdown(tasks)).find(t => t.id === 'task-B');
    warn.mockRestore();

    expect(repaired.status).toBe('blocked');
    expect(repaired.metadata.blockedCategory).toBe(UNKNOWN_STATUS_BLOCKED_CATEGORY);
    expect(repaired.metadata.unrepresentableStatus).toBe('archived');
  });

  it('recovers a row an older install already wrote to disk, with its prompt payload', () => {
    // The write-side repair cannot help a row that is ALREADY on disk: an unknown
    // priority fails parseTaskLine's regex, so the task and every indented
    // metadata line under it were dropped on read and deleted by the next write.
    // PortOS is distributed software — installs that predate the fix hold these.
    const onDisk = [
      '# Tasks',
      '',
      '## Pending',
      '- [ ] #task-A | HIGH | representable',
      '- [ ] #task-C | URGENT | written before the fix',
      '  - prompt: the agent-facing payload',
      '- [a] #task-D | HIGH | hand-edited checkbox',
      '  - prompt: also worth keeping',
      ''
    ].join('\n');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseTasksMarkdown(onDisk);
    warn.mockRestore();

    expect(parsed.map(t => t.id)).toEqual(['task-A', 'task-C', 'task-D']);
    expect(parsed.find(t => t.id === 'task-C').priority).toBe('MEDIUM');
    expect(parsed.find(t => t.id === 'task-C').metadata.prompt).toBe('the agent-facing payload');
    // An unrecognized checkbox already defaults to pending, so only the row itself
    // was at risk there.
    expect(parsed.find(t => t.id === 'task-D').metadata.prompt).toBe('also worth keeping');
  });

  it('repairs a recovered row once per parse, not once per scan pass', () => {
    // parseTasksMarkdown walks the lines twice (an id pre-scan, then the real
    // parse); only the second pass may repair, or every read doubles the log.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseTasksMarkdown('# Tasks\n\n## Pending\n- [ ] #task-C | URGENT | one row\n');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('recovers every priority the old boundary could write, not just single words', () => {
    // `priority: z.string()` accepted anything and updateTask wrote it verbatim:
    // 'VERY HIGH', '123' and 'URGENT!' are all rows a pre-fix install can hold.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseTasksMarkdown([
      '# Tasks', '', '## Pending',
      '- [ ] #task-B | VERY HIGH | multiword',
      '  - prompt: payload B',
      '- [ ] #task-C | 123 | numeric',
      '  - prompt: payload C',
      '- [ ] #task-E | URGENT! | punctuated',
      ''
    ].join('\n'));
    warn.mockRestore();

    expect(parsed.map(t => t.id)).toEqual(['task-B', 'task-C', 'task-E']);
    expect(parsed.every(t => t.priority === 'MEDIUM')).toBe(true);
    expect(parsed[0].metadata.prompt).toBe('payload B');
  });

  it.each([
    ['a pipe before the flag', '- [ ] #sys-1 | UR|GENT | APPROVAL | work'],
    ['a pipe that looks like a flag', '- [ ] #sys-2 | UR|AUTO | APPROVAL | work'],
  ])('recovers an internal row with %s into the approval queue, and keeps it there', (_label, line) => {
    // A recovered row is an ambiguous split: the priority field itself could have
    // held a pipe, so which segment was the approval flag is a guess. For an
    // INTERNAL task that flag gates an agent spawn, so recovery must not make the
    // row more permissive — and the hold has to survive the write that heals the
    // file, or the next read releases it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recovered = parseTasksMarkdown('# Tasks\n\n## Pending\n' + line + '\n  - prompt: payload\n');
    warn.mockRestore();

    expect(recovered[0].approvalRequired).toBe(true);
    expect(getAutoApprovedTasks(recovered)).toEqual([]);
    expect(getAwaitingApprovalTasks(recovered)).toHaveLength(1);
    expect(recovered[0].metadata.prompt).toBe('payload');

    // Internal files are written WITH approval flags, so the healed row re-reads
    // as approval-required rather than silently returning to the dequeue.
    const reread = parseTasksMarkdown(generateTasksMarkdown(recovered, true));
    expect(reread[0].approvalRequired).toBe(true);
    expect(getAutoApprovedTasks(reread)).toEqual([]);
  });

  it('restores a recovered USER row to the ordinary queue', () => {
    // A user task carries no approval flag in the format at all — every one is
    // auto-approved by construction — so holding one would be a claim the next
    // write erases. The row goes back to being exactly what it was.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [recovered] = parseTasksMarkdown('# Tasks\n\n## Pending\n- [ ] #task-C | URGENT | plain user row\n  - prompt: payload\n');
    warn.mockRestore();

    expect(recovered.autoApproved).toBe(true);
    expect(recovered.approvalRequired).toBe(false);
    expect(recovered.metadata.prompt).toBe('payload');
  });

  it("leaves a STRICT row's approval semantics exactly as they were", () => {
    // The recovery rule must not touch the format as written — a description that
    // happens to contain '| AUTO |' is still an ordinary auto-approved user row.
    const wellFormed = parseTasksMarkdown([
      '# Tasks', '', '## Pending',
      '- [ ] #task-1 | HIGH | Explain | AUTO | behavior',
      '- [ ] #sys-3 | HIGH | AUTO | normal internal',
      ''
    ].join('\n'));
    expect(wellFormed.map(t => t.autoApproved)).toEqual([true, true]);
    expect(wellFormed.map(t => t.approvalRequired)).toEqual([false, false]);
    expect(getAutoApprovedTasks(wellFormed)).toHaveLength(2);
  });

  it('parks an unrecognized checkbox instead of making it a runnable pending task', () => {
    // Defaulting an unknown marker to 'pending' would recover the row straight
    // into the dequeue — a hand-edited line would spawn an agent. It has to land
    // on the unknown-status hold, which is blocked and therefore never dequeued.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [parked] = parseTasksMarkdown('# Tasks\n\n## Pending\n- [a] #task-D | HIGH | AUTO | work\n  - prompt: payload D\n');
    warn.mockRestore();

    expect(parked.status).toBe('blocked');
    expect(parked.metadata.blockedCategory).toBe(UNKNOWN_STATUS_BLOCKED_CATEGORY);
    expect(parked.metadata.unrepresentableStatus).toBe('[a]');
    expect(parked.metadata.prompt).toBe('payload D');
    expect(getAutoApprovedTasks([parked])).toEqual([]);
  });

  it('is not overwritten by a blockedCategory line further down the same row', () => {
    // The row's indented metadata is attached AFTER the line is matched, so a
    // stale category from an earlier block would clobber the unknown-status hold
    // if the repair ran at match time — putting the rescued task back into the
    // 14-day auto-expiry it is exempt from.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [parked] = parseTasksMarkdown([
      '# Tasks', '', '## Pending',
      '- [a] #task-D | HIGH | work',
      '  - blockedCategory: worktree-failed',
      '  - prompt: preserved payload',
      ''
    ].join('\n'));
    warn.mockRestore();

    expect(parked.metadata.blockedCategory).toBe(UNKNOWN_STATUS_BLOCKED_CATEGORY);
    expect(parked.metadata.priorBlockedCategory).toBe('worktree-failed');
    expect(parked.metadata.prompt).toBe('preserved payload');
  });

  it('reads a hand-written [X] as completed rather than an unknown marker', () => {
    // The patterns are case-insensitive, so [X] always matched — it just fell
    // through STATUS_MAP and silently resurrected a finished task as pending.
    expect(parseTasksMarkdown('# Tasks\n\n## Completed\n- [X] #task-E | HIGH | done\n')[0].status).toBe('completed');
  });

  it('still refuses a line that is not a task row at all', () => {
    expect(parseTasksMarkdown('# Tasks\n\n## Pending\n- [ ] no-hash-id | HIGH | desc\n')).toEqual([]);
    expect(parseTasksMarkdown('# Tasks\n\n## Pending\n- [ ] #task-X | only two fields\n')).toEqual([]);
  });

  it('overrides a block category the task already carried, keeping the old one beside it', () => {
    // A category left over from an earlier block says nothing about THIS repair,
    // and a reapable one (worktree-failed) would let the 14-day auto-expiry flip
    // the rescued task to completed — the loss the exemption exists to prevent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const md = generateTasksMarkdown([{
      id: 'task-D', status: 'archived', priority: 'HIGH', priorityValue: 3,
      description: 'stale category', metadata: { blockedCategory: 'worktree-failed' },
    }]);
    warn.mockRestore();

    const repaired = parseTasksMarkdown(md)[0];
    expect(repaired.metadata.blockedCategory).toBe(UNKNOWN_STATUS_BLOCKED_CATEGORY);
    expect(repaired.metadata.priorBlockedCategory).toBe('worktree-failed');
  });

  it('coerces the unknown priority to MEDIUM without touching its status', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const repaired = parseTasksMarkdown(generateTasksMarkdown(tasks)).find(t => t.id === 'task-C');
    warn.mockRestore();

    expect(repaired.status).toBe('pending');
    expect(repaired.priority).toBe('MEDIUM');
    // A priority-only repair must not park the task or stamp a block category.
    expect(repaired.metadata.blockedCategory).toBeUndefined();
  });

  it('warns once per repaired task and stays silent when every task is representable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    generateTasksMarkdown(tasks);
    expect(warn.mock.calls.map(([line]) => line)).toEqual([
      expect.stringContaining('task-B'),
      expect.stringContaining('task-C'),
    ]);

    warn.mockClear();
    generateTasksMarkdown([tasks[0]]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('derives the vocabularies from the format itself', () => {
    expect([...TASK_STATUS_VALUES].sort())
      .toEqual(['blocked', 'challenged', 'completed', 'in_progress', 'pending']);
    expect([...TASK_PRIORITY_VALUES].sort())
      .toEqual(['CRITICAL', 'HIGH', 'LOW', 'MEDIUM']);
  });
});

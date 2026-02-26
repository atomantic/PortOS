import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module
vi.mock('fs/promises', () => ({
  readFile: vi.fn()
}));

vi.mock('../lib/fileUtils.js', () => ({
  readJSONFile: vi.fn(),
  PATHS: {
    root: '/mock',
    data: '/mock/data',
    cos: '/mock/data/cos'
  }
}));

import { readFile } from 'fs/promises';
import { readJSONFile } from '../lib/fileUtils.js';
import {
  getGoalProgress,
  getGoalProgressSummary,
  parseGoalsFile,
  GOAL_MAPPINGS
} from './goalProgress.js';

describe('goalProgress.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GOAL_MAPPINGS', () => {
    it('should define mappings for standard goals', () => {
      expect(GOAL_MAPPINGS['Codebase Quality']).toBeDefined();
      expect(GOAL_MAPPINGS['Self-Improvement']).toBeDefined();
      expect(GOAL_MAPPINGS['Documentation']).toBeDefined();
      expect(GOAL_MAPPINGS['User Engagement']).toBeDefined();
      expect(GOAL_MAPPINGS['System Health']).toBeDefined();
    });

    it('should have icons and colors for each mapping', () => {
      for (const mapping of Object.values(GOAL_MAPPINGS)) {
        expect(mapping.icon).toBeDefined();
        expect(mapping.color).toBeDefined();
        expect(mapping.keywords).toBeDefined();
        expect(mapping.taskTypes).toBeDefined();
      }
    });
  });

  describe('parseGoalsFile', () => {
    it('should parse goals from markdown', async () => {
      const goalsMarkdown = `
# COS Goals

## Active Goals

### Goal 1: Codebase Quality
- Improve test coverage
- Fix security issues

### Goal 2: Documentation
- Update README
- Add API docs

## Completed Goals
### Goal 3: Old Goal
- This should not be parsed
`;
      readFile.mockResolvedValue(goalsMarkdown);

      const result = await parseGoalsFile();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Codebase Quality');
      expect(result[0].items).toEqual(['Improve test coverage', 'Fix security issues']);
      expect(result[1].name).toBe('Documentation');
      expect(result[1].items).toEqual(['Update README', 'Add API docs']);
    });

    it('should return empty array when file does not exist', async () => {
      readFile.mockRejectedValue(new Error('ENOENT'));

      const result = await parseGoalsFile();

      expect(result).toEqual([]);
    });

    it('should assign correct mappings to known goals', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: Codebase Quality
- Test item
`;
      readFile.mockResolvedValue(goalsMarkdown);

      const result = await parseGoalsFile();

      expect(result[0].mapping.icon).toBe(GOAL_MAPPINGS['Codebase Quality'].icon);
      expect(result[0].mapping.color).toBe(GOAL_MAPPINGS['Codebase Quality'].color);
    });

    it('should use default mapping for unknown goals', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: Unknown Goal Type
- Test item
`;
      readFile.mockResolvedValue(goalsMarkdown);

      const result = await parseGoalsFile();

      expect(result[0].mapping.icon).toBe('🎯');
      expect(result[0].mapping.color).toBe('gray');
    });

    it('should handle empty Active Goals section', async () => {
      const goalsMarkdown = `
## Active Goals

## Other Section
### Goal 1: Other
- Item
`;
      readFile.mockResolvedValue(goalsMarkdown);

      const result = await parseGoalsFile();

      expect(result).toEqual([]);
    });
  });

  describe('getGoalProgress', () => {
    it('should calculate progress from task stats', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: User Engagement
- Respond to feedback
`;
      readFile.mockResolvedValue(goalsMarkdown);

      const learningData = {
        byTaskType: {
          'user-task': {
            completed: 20,
            succeeded: 15,
            failed: 5
          }
        }
      };
      readJSONFile.mockResolvedValue(learningData);

      const result = await getGoalProgress();

      expect(result.goals).toHaveLength(1);
      expect(result.goals[0].metrics.totalTasks).toBe(20);
      expect(result.goals[0].metrics.succeededTasks).toBe(15);
      expect(result.goals[0].metrics.successRate).toBe(75);
    });

    it('should determine engagement level based on task count', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: User Engagement
- Item
`;
      readFile.mockResolvedValue(goalsMarkdown);

      // Test low engagement (< 5 tasks)
      readJSONFile.mockResolvedValue({
        byTaskType: { 'user-task': { completed: 2, succeeded: 2 } }
      });
      let result = await getGoalProgress();
      expect(result.goals[0].metrics.engagement).toBe('low');

      // Test medium engagement (5-19 tasks)
      readJSONFile.mockResolvedValue({
        byTaskType: { 'user-task': { completed: 10, succeeded: 8 } }
      });
      result = await getGoalProgress();
      expect(result.goals[0].metrics.engagement).toBe('medium');

      // Test high engagement (>= 20 tasks)
      readJSONFile.mockResolvedValue({
        byTaskType: { 'user-task': { completed: 25, succeeded: 20 } }
      });
      result = await getGoalProgress();
      expect(result.goals[0].metrics.engagement).toBe('high');
    });

    it('should match tasks by keywords', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: Codebase Quality
- Fix security issues
`;
      readFile.mockResolvedValue(goalsMarkdown);

      const learningData = {
        byTaskType: {
          // This should match by keyword 'security'
          'custom-security-check': {
            completed: 5,
            succeeded: 4
          }
        }
      };
      readJSONFile.mockResolvedValue(learningData);

      const result = await getGoalProgress();

      expect(result.goals[0].metrics.totalTasks).toBe(5);
    });

    it('should calculate summary statistics', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: User Engagement
- Item

### Goal 2: Documentation
- Item
`;
      readFile.mockResolvedValue(goalsMarkdown);

      readJSONFile.mockResolvedValue({
        byTaskType: {
          'user-task': { completed: 30, succeeded: 25 },
          'self-improve:documentation': { completed: 10, succeeded: 8 }
        }
      });

      const result = await getGoalProgress();

      expect(result.summary.totalGoals).toBe(2);
      expect(result.summary.totalTasks).toBe(40);
      expect(result.summary.totalSucceeded).toBe(33);
      expect(result.summary.overallSuccessRate).toBe(83);
    });

    it('should identify most and least active goals', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: User Engagement
- Item

### Goal 2: Documentation
- Item
`;
      readFile.mockResolvedValue(goalsMarkdown);

      readJSONFile.mockResolvedValue({
        byTaskType: {
          'user-task': { completed: 50, succeeded: 40 },
          'self-improve:documentation': { completed: 5, succeeded: 4 }
        }
      });

      const result = await getGoalProgress();

      expect(result.summary.mostActive).toBe('User Engagement');
      expect(result.summary.leastActive).toBe('Documentation');
    });

    it('should handle null for leastActive when same as mostActive', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: User Engagement
- Item
`;
      readFile.mockResolvedValue(goalsMarkdown);

      readJSONFile.mockResolvedValue({
        byTaskType: { 'user-task': { completed: 10, succeeded: 8 } }
      });

      const result = await getGoalProgress();

      expect(result.summary.leastActive).toBeNull();
    });

    it('should return null successRate when no tasks', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: Unknown Goal
- Item
`;
      readFile.mockResolvedValue(goalsMarkdown);
      readJSONFile.mockResolvedValue({ byTaskType: {} });

      const result = await getGoalProgress();

      expect(result.goals[0].metrics.successRate).toBeNull();
    });

    it('should include updatedAt timestamp', async () => {
      readFile.mockResolvedValue('## Active Goals');
      readJSONFile.mockResolvedValue({});

      const result = await getGoalProgress();

      expect(result.updatedAt).toBeDefined();
      expect(new Date(result.updatedAt)).toBeInstanceOf(Date);
    });
  });

  describe('getGoalProgressSummary', () => {
    it('should return top 5 goals', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: Codebase Quality
- Item

### Goal 2: Self-Improvement
- Item

### Goal 3: Documentation
- Item

### Goal 4: User Engagement
- Item

### Goal 5: System Health
- Item

### Goal 6: Extra Goal
- Item
`;
      readFile.mockResolvedValue(goalsMarkdown);

      readJSONFile.mockResolvedValue({
        byTaskType: {
          'self-improve:security-audit': { completed: 50, succeeded: 45 },
          'self-improve:general': { completed: 40, succeeded: 35 },
          'self-improve:documentation': { completed: 30, succeeded: 25 },
          'user-task': { completed: 20, succeeded: 15 },
          'auto-fix': { completed: 10, succeeded: 8 }
        }
      });

      const result = await getGoalProgressSummary();

      expect(result.goals.length).toBeLessThanOrEqual(5);
    });

    it('should return compact goal format', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: User Engagement
- Item
`;
      readFile.mockResolvedValue(goalsMarkdown);

      readJSONFile.mockResolvedValue({
        byTaskType: { 'user-task': { completed: 10, succeeded: 8 } }
      });

      const result = await getGoalProgressSummary();

      expect(result.goals[0]).toHaveProperty('name');
      expect(result.goals[0]).toHaveProperty('icon');
      expect(result.goals[0]).toHaveProperty('color');
      expect(result.goals[0]).toHaveProperty('tasks');
      expect(result.goals[0]).toHaveProperty('successRate');
      expect(result.goals[0]).toHaveProperty('engagement');
      // Should not have full metrics object
      expect(result.goals[0]).not.toHaveProperty('metrics');
    });

    it('should sort goals by task count descending', async () => {
      const goalsMarkdown = `
## Active Goals

### Goal 1: Documentation
- Item

### Goal 2: User Engagement
- Item
`;
      readFile.mockResolvedValue(goalsMarkdown);

      readJSONFile.mockResolvedValue({
        byTaskType: {
          'user-task': { completed: 100, succeeded: 90 },
          'self-improve:documentation': { completed: 10, succeeded: 8 }
        }
      });

      const result = await getGoalProgressSummary();

      expect(result.goals[0].name).toBe('User Engagement');
      expect(result.goals[0].tasks).toBe(100);
    });

    it('should include summary in response', async () => {
      readFile.mockResolvedValue('## Active Goals');
      readJSONFile.mockResolvedValue({});

      const result = await getGoalProgressSummary();

      expect(result.summary).toBeDefined();
      expect(result.updatedAt).toBeDefined();
    });
  });
});

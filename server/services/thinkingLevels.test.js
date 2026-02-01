import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  THINKING_LEVELS,
  AUTO_THRESHOLDS,
  TASK_TYPE_LEVELS,
  resolveThinkingLevel,
  suggestLevel,
  suggestLevelFromContext,
  getModelForLevel,
  isLocalPreferred,
  upgradeLevel,
  downgradeLevel,
  getStats,
  resetStats,
  getLevels
} from './thinkingLevels.js';

// Mock the cosEvents
vi.mock('./cos.js', () => ({
  cosEvents: {
    emit: vi.fn()
  }
}));

describe('Thinking Levels Service', () => {
  beforeEach(() => {
    resetStats();
  });

  describe('THINKING_LEVELS', () => {
    it('should have all required levels', () => {
      expect(THINKING_LEVELS.off).toBeDefined();
      expect(THINKING_LEVELS.minimal).toBeDefined();
      expect(THINKING_LEVELS.low).toBeDefined();
      expect(THINKING_LEVELS.medium).toBeDefined();
      expect(THINKING_LEVELS.high).toBeDefined();
      expect(THINKING_LEVELS.xhigh).toBeDefined();
    });

    it('should have increasing maxTokens as level increases', () => {
      expect(THINKING_LEVELS.minimal.maxTokens).toBeLessThan(THINKING_LEVELS.low.maxTokens);
      expect(THINKING_LEVELS.low.maxTokens).toBeLessThan(THINKING_LEVELS.medium.maxTokens);
      expect(THINKING_LEVELS.medium.maxTokens).toBeLessThan(THINKING_LEVELS.high.maxTokens);
      expect(THINKING_LEVELS.high.maxTokens).toBeLessThan(THINKING_LEVELS.xhigh.maxTokens);
    });

    it('should mark minimal and low as localPreferred', () => {
      expect(THINKING_LEVELS.minimal.localPreferred).toBe(true);
      expect(THINKING_LEVELS.low.localPreferred).toBe(true);
      expect(THINKING_LEVELS.medium.localPreferred).toBe(false);
    });
  });

  describe('AUTO_THRESHOLDS', () => {
    it('should have contextLength thresholds', () => {
      expect(AUTO_THRESHOLDS.contextLength).toBeDefined();
      expect(AUTO_THRESHOLDS.contextLength.minimal).toBeDefined();
      expect(AUTO_THRESHOLDS.contextLength.xhigh).toBeDefined();
    });

    it('should have complexity thresholds', () => {
      expect(AUTO_THRESHOLDS.complexity).toBeDefined();
      expect(AUTO_THRESHOLDS.complexity.minimal).toBeLessThan(AUTO_THRESHOLDS.complexity.xhigh);
    });
  });

  describe('TASK_TYPE_LEVELS', () => {
    it('should map simple tasks to low levels', () => {
      expect(TASK_TYPE_LEVELS.format).toBe('minimal');
      expect(TASK_TYPE_LEVELS.typo).toBe('minimal');
    });

    it('should map complex tasks to high levels', () => {
      expect(TASK_TYPE_LEVELS.architect).toBe('xhigh');
      expect(TASK_TYPE_LEVELS.audit).toBe('xhigh');
    });
  });

  describe('resolveThinkingLevel', () => {
    it('should use task metadata thinkingLevel if present', () => {
      const task = { id: 'task-1', metadata: { thinkingLevel: 'high' } };
      const result = resolveThinkingLevel(task);

      expect(result.level).toBe('high');
      expect(result.resolvedFrom).toBe('task');
    });

    it('should use priority for CRITICAL/URGENT tasks', () => {
      const task = { id: 'task-1', priority: 'CRITICAL' };
      const result = resolveThinkingLevel(task);

      expect(result.level).toBe('high');
      expect(result.resolvedFrom).toBe('priority');
    });

    it('should use priority for LOW tasks', () => {
      const task = { id: 'task-1', priority: 'LOW' };
      const result = resolveThinkingLevel(task);

      expect(result.level).toBe('low');
    });

    it('should use taskType mapping', () => {
      const task = { id: 'task-1', metadata: { taskType: 'architect' } };
      const result = resolveThinkingLevel(task);

      expect(result.level).toBe('xhigh');
    });

    it('should use agent default if no task-level config', () => {
      const task = { id: 'task-1' };
      const agent = { defaultThinkingLevel: 'low' };
      const result = resolveThinkingLevel(task, agent);

      expect(result.level).toBe('low');
      expect(result.resolvedFrom).toBe('agent');
    });

    it('should use provider default as fallback', () => {
      const task = { id: 'task-1' };
      const provider = { defaultThinkingLevel: 'minimal' };
      const result = resolveThinkingLevel(task, {}, provider);

      expect(result.level).toBe('minimal');
      expect(result.resolvedFrom).toBe('provider');
    });

    it('should default to medium if nothing specified', () => {
      const task = { id: 'task-1' };
      const result = resolveThinkingLevel(task);

      expect(result.level).toBe('medium');
      expect(result.resolvedFrom).toBe('default');
    });

    it('should fallback to medium for invalid levels', () => {
      const task = { id: 'task-1', metadata: { thinkingLevel: 'invalid-level' } };
      const result = resolveThinkingLevel(task);

      expect(result.level).toBe('medium');
    });

    it('should include level configuration in result', () => {
      const task = { id: 'task-1', metadata: { thinkingLevel: 'high' } };
      const result = resolveThinkingLevel(task);

      expect(result.model).toBe('provider-heavy');
      expect(result.maxTokens).toBe(8192);
    });
  });

  describe('suggestLevel', () => {
    it('should suggest higher levels for higher complexity', () => {
      const lowComplexity = suggestLevel({ complexity: 0.2 });
      const highComplexity = suggestLevel({ complexity: 0.9 });

      expect(['minimal', 'low'].includes(lowComplexity)).toBe(true);
      expect(['high', 'xhigh'].includes(highComplexity)).toBe(true);
    });

    it('should return minimal for very low complexity', () => {
      const result = suggestLevel({ complexity: 0.1 });
      expect(result).toBe('minimal');
    });

    it('should handle missing complexity', () => {
      const result = suggestLevel({});
      expect(result).toBeDefined();
    });
  });

  describe('suggestLevelFromContext', () => {
    it('should suggest minimal for short context', () => {
      const result = suggestLevelFromContext(100);
      expect(result).toBe('minimal');
    });

    it('should suggest higher levels for longer context', () => {
      const short = suggestLevelFromContext(500);
      const long = suggestLevelFromContext(10000);

      expect(['minimal', 'low'].includes(short)).toBe(true);
      expect(long).toBe('xhigh');
    });
  });

  describe('getModelForLevel', () => {
    it('should return lmstudio for local levels', () => {
      expect(getModelForLevel('minimal')).toBe('lmstudio');
      expect(getModelForLevel('low')).toBe('lmstudio');
    });

    it('should return provider default for medium', () => {
      const provider = { defaultModel: 'custom-model' };
      expect(getModelForLevel('medium', provider)).toBe('custom-model');
    });

    it('should return provider heavy for high', () => {
      const provider = { heavyModel: 'heavy-model' };
      expect(getModelForLevel('high', provider)).toBe('heavy-model');
    });

    it('should return opus for xhigh', () => {
      expect(getModelForLevel('xhigh')).toBe('claude-opus-4-20250514');
    });

    it('should return null for invalid level', () => {
      expect(getModelForLevel('invalid')).toBeNull();
    });

    it('should return provider default when level is off', () => {
      const provider = { defaultModel: 'default' };
      expect(getModelForLevel('off', provider)).toBe('default');
    });
  });

  describe('isLocalPreferred', () => {
    it('should return true for minimal and low', () => {
      expect(isLocalPreferred('minimal')).toBe(true);
      expect(isLocalPreferred('low')).toBe(true);
    });

    it('should return false for medium and above', () => {
      expect(isLocalPreferred('medium')).toBe(false);
      expect(isLocalPreferred('high')).toBe(false);
      expect(isLocalPreferred('xhigh')).toBe(false);
    });

    it('should return false for invalid level', () => {
      expect(isLocalPreferred('invalid')).toBe(false);
    });
  });

  describe('upgradeLevel', () => {
    it('should upgrade to next level', () => {
      expect(upgradeLevel('minimal')).toBe('low');
      expect(upgradeLevel('low')).toBe('medium');
      expect(upgradeLevel('medium')).toBe('high');
      expect(upgradeLevel('high')).toBe('xhigh');
    });

    it('should not upgrade beyond xhigh', () => {
      expect(upgradeLevel('xhigh')).toBe('xhigh');
    });

    it('should return medium for invalid level', () => {
      expect(upgradeLevel('invalid')).toBe('medium');
    });
  });

  describe('downgradeLevel', () => {
    it('should downgrade to previous level', () => {
      expect(downgradeLevel('xhigh')).toBe('high');
      expect(downgradeLevel('high')).toBe('medium');
      expect(downgradeLevel('medium')).toBe('low');
      expect(downgradeLevel('low')).toBe('minimal');
    });

    it('should not downgrade below off', () => {
      expect(downgradeLevel('off')).toBe('off');
    });

    it('should return medium for invalid level', () => {
      expect(downgradeLevel('invalid')).toBe('medium');
    });
  });

  describe('getStats', () => {
    it('should return usage statistics', () => {
      resolveThinkingLevel({ id: 't1', metadata: { thinkingLevel: 'high' } });
      resolveThinkingLevel({ id: 't2', metadata: { thinkingLevel: 'high' } });
      resolveThinkingLevel({ id: 't3', metadata: { thinkingLevel: 'low' } });

      const stats = getStats();

      expect(stats.usage.high).toBe(2);
      expect(stats.usage.low).toBe(1);
      expect(stats.total).toBe(3);
    });

    it('should calculate distribution percentages', () => {
      resolveThinkingLevel({ id: 't1', metadata: { thinkingLevel: 'medium' } });
      resolveThinkingLevel({ id: 't2', metadata: { thinkingLevel: 'medium' } });

      const stats = getStats();

      expect(stats.distribution.medium).toBe('100.0%');
    });

    it('should return all levels', () => {
      const stats = getStats();
      expect(stats.levels).toContain('off');
      expect(stats.levels).toContain('xhigh');
    });
  });

  describe('resetStats', () => {
    it('should reset all usage counters to 0', () => {
      resolveThinkingLevel({ id: 't1', metadata: { thinkingLevel: 'high' } });
      resetStats();

      const stats = getStats();
      expect(stats.total).toBe(0);
      expect(stats.usage.high).toBe(0);
    });
  });

  describe('getLevels', () => {
    it('should return all level configurations', () => {
      const levels = getLevels();

      expect(levels.off).toBeDefined();
      expect(levels.xhigh).toBeDefined();
      expect(Object.keys(levels).length).toBe(6);
    });

    it('should return all level configurations', () => {
      const levels = getLevels();

      // Verify it returns a new object (shallow copy)
      const levels2 = getLevels();
      expect(levels).not.toBe(levels2); // Different object references
      expect(levels.off).toEqual(levels2.off); // Same content
    });
  });
});

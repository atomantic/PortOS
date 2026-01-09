import { describe, it, expect } from 'vitest';
import {
  classifyTask,
  classifyReviewFindings,
  getClassificationRules,
  isIdleReviewTask,
  estimateTaskComplexity
} from './taskClassifier.js';

describe('Task Classifier Service', () => {
  describe('classifyTask', () => {
    const defaultConfig = {
      autoFixThresholds: {
        maxLinesChanged: 50,
        allowedCategories: ['formatting', 'dry-violations', 'dead-code', 'typo-fix', 'import-cleanup', 'documentation']
      }
    };

    describe('auto-approve patterns', () => {
      it('should auto-approve formatting tasks within line limit', () => {
        const task = { description: 'Format code with prettier' };
        const analysis = { linesChanged: 30 };

        const result = classifyTask(task, analysis, defaultConfig);

        expect(result.autoApprove).toBe(true);
        expect(result.category).toBe('formatting');
        expect(result.confidence).toBe('high');
      });

      it('should auto-approve lint fixes', () => {
        const task = { description: 'Fix ESLint errors' };
        const analysis = { linesChanged: 20 };

        const result = classifyTask(task, analysis, defaultConfig);

        expect(result.autoApprove).toBe(true);
        expect(result.category).toBe('formatting');
      });

      it('should auto-approve DRY violation fixes', () => {
        const task = { description: 'Remove duplicate code in helpers' };
        const analysis = { linesChanged: 25 };

        const result = classifyTask(task, analysis, defaultConfig);

        expect(result.autoApprove).toBe(true);
        expect(result.category).toBe('dry-violations');
      });

      it('should auto-approve dead code removal', () => {
        const task = { description: 'Remove unused functions' };
        const analysis = { linesChanged: 15 };

        const result = classifyTask(task, analysis, defaultConfig);

        expect(result.autoApprove).toBe(true);
        expect(result.category).toBe('dead-code');
      });

      it('should auto-approve typo fixes', () => {
        const task = { description: 'Fix typo in error message' };
        const analysis = { linesChanged: 5 };

        const result = classifyTask(task, analysis, defaultConfig);

        expect(result.autoApprove).toBe(true);
        expect(result.category).toBe('typo-fix');
      });

      it('should auto-approve import cleanup', () => {
        // "import" keyword triggers import-cleanup pattern
        const task = { description: 'Fix broken import statements' };
        const analysis = { linesChanged: 20 };

        const result = classifyTask(task, analysis, defaultConfig);

        expect(result.autoApprove).toBe(true);
        expect(result.category).toBe('import-cleanup');
      });

      it('should auto-approve documentation updates', () => {
        // "doc" keyword triggers documentation pattern (not "comment" which triggers typo-fix)
        const task = { description: 'Update the documentation' };
        const analysis = { linesChanged: 50 };

        const result = classifyTask(task, analysis, defaultConfig);

        expect(result.autoApprove).toBe(true);
        expect(result.category).toBe('documentation');
      });
    });

    describe('line limit enforcement', () => {
      it('should reject auto-approve when exceeding category line limit', () => {
        const task = { description: 'Fix typo in comments' };
        const analysis = { linesChanged: 25 }; // typo-fix limit is 20

        const result = classifyTask(task, analysis, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('typo-fix');
        expect(result.reason).toContain('exceed auto-approve limit');
      });

      it('should reject auto-approve when exceeding global max lines', () => {
        const configWithLowLimit = {
          autoFixThresholds: {
            maxLinesChanged: 10,
            allowedCategories: ['formatting']
          }
        };
        const task = { description: 'Format all files' };
        const analysis = { linesChanged: 15 };

        const result = classifyTask(task, analysis, configWithLowLimit);

        expect(result.autoApprove).toBe(false);
        expect(result.reason).toContain('exceed');
      });

      it('should use category line limit if lower than global', () => {
        const task = { description: 'Remove dead code' };
        const analysis = { linesChanged: 40 }; // dead-code limit is 30

        const result = classifyTask(task, analysis, defaultConfig);

        expect(result.autoApprove).toBe(false);
      });
    });

    describe('category allowlist enforcement', () => {
      it('should reject categories not in allowlist', () => {
        const restrictedConfig = {
          autoFixThresholds: {
            maxLinesChanged: 100,
            allowedCategories: ['typo-fix'] // Only typo-fix allowed
          }
        };
        const task = { description: 'Format code' };
        const analysis = { linesChanged: 10 };

        const result = classifyTask(task, analysis, restrictedConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.reason).toContain('not in auto-approve list');
      });
    });

    describe('require-approval patterns (high priority)', () => {
      it('should require approval for security-related tasks', () => {
        const task = { description: 'Update authentication logic' };

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('security');
        expect(result.confidence).toBe('high');
      });

      it('should require approval for password handling', () => {
        const task = { description: 'Change password validation' };

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('security');
      });

      it('should require approval for database changes', () => {
        const task = { description: 'Update database schema' };

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('database');
      });

      it('should require approval for migrations', () => {
        const task = { description: 'Create prisma migration' };

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('database');
      });

      it('should require approval for API changes', () => {
        const task = { description: 'Make breaking change to API' };

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('api-change');
      });

      it('should require approval for dependency updates', () => {
        const task = { description: 'Update package.json dependencies' };

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('dependency');
      });

      it('should require approval for architecture changes', () => {
        const task = { description: 'Restructure the entire module' };

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('architecture');
      });

      it('should require approval for config changes', () => {
        const task = { description: 'Modify ecosystem.config settings' };

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('config');
      });

      it('should require approval for deployment tasks', () => {
        const task = { description: 'Deploy to production' };

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('deployment');
      });
    });

    describe('priority of require-approval over auto-approve', () => {
      it('should require approval even if description also matches auto-approve', () => {
        // Task mentions both security (require) and typo (auto)
        const task = { description: 'Fix typo in security token' };

        const result = classifyTask(task, { linesChanged: 1 }, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('security');
      });
    });

    describe('unknown category handling', () => {
      it('should default to require approval for unknown patterns', () => {
        const task = { description: 'Do something completely unrelated' };

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('unknown');
        expect(result.confidence).toBe('low');
      });
    });

    describe('empty/null handling', () => {
      it('should handle task with no description', () => {
        const task = {};

        const result = classifyTask(task, null, defaultConfig);

        expect(result.autoApprove).toBe(false);
        expect(result.category).toBe('unknown');
      });

      it('should handle null analysis result', () => {
        const task = { description: 'Format code' };

        const result = classifyTask(task, null, defaultConfig);

        // Should still work without analysis (line count = 0)
        expect(result.category).toBe('formatting');
      });

      it('should handle null config', () => {
        const task = { description: 'Format code' };
        const analysis = { linesChanged: 10 };

        // Should use defaults
        const result = classifyTask(task, analysis, null);

        expect(result.category).toBe('formatting');
        expect(result.autoApprove).toBe(false); // No allowed categories in null config
      });
    });
  });

  describe('classifyReviewFindings', () => {
    const defaultConfig = {
      autoFixThresholds: {
        maxLinesChanged: 50,
        allowedCategories: ['typo-fix', 'dead-code']
      }
    };

    it('should classify array of findings', () => {
      const findings = [
        { title: 'Fix typo', estimatedLines: 5 },
        { title: 'Security issue', estimatedLines: 10 }
      ];

      const results = classifyReviewFindings(findings, defaultConfig);

      expect(results).toHaveLength(2);
      expect(results[0].autoApprove).toBe(true);
      expect(results[0].category).toBe('typo-fix');
      expect(results[1].autoApprove).toBe(false);
      expect(results[1].category).toBe('security');
    });

    it('should preserve original finding data', () => {
      const findings = [
        { title: 'Fix typo', estimatedLines: 5, file: 'test.js', line: 42 }
      ];

      const results = classifyReviewFindings(findings, defaultConfig);

      expect(results[0].file).toBe('test.js');
      expect(results[0].line).toBe(42);
    });

    it('should handle findings with description instead of title', () => {
      const findings = [
        { description: 'Remove dead code', estimatedLines: 10 }
      ];

      const results = classifyReviewFindings(findings, defaultConfig);

      expect(results[0].category).toBe('dead-code');
    });
  });

  describe('getClassificationRules', () => {
    it('should return both auto-approve and require-approval rules', () => {
      const rules = getClassificationRules();

      expect(rules).toHaveProperty('autoApprove');
      expect(rules).toHaveProperty('requireApproval');
      expect(Array.isArray(rules.autoApprove)).toBe(true);
      expect(Array.isArray(rules.requireApproval)).toBe(true);
    });

    it('should include all auto-approve categories', () => {
      const rules = getClassificationRules();
      const categories = rules.autoApprove.map(r => r.category);

      expect(categories).toContain('formatting');
      expect(categories).toContain('dry-violations');
      expect(categories).toContain('dead-code');
      expect(categories).toContain('typo-fix');
      expect(categories).toContain('import-cleanup');
      expect(categories).toContain('documentation');
    });

    it('should include all require-approval categories', () => {
      const rules = getClassificationRules();
      const categories = rules.requireApproval.map(r => r.category);

      expect(categories).toContain('security');
      expect(categories).toContain('database');
      expect(categories).toContain('api-change');
      expect(categories).toContain('dependency');
      expect(categories).toContain('architecture');
      expect(categories).toContain('config');
      expect(categories).toContain('deployment');
    });

    it('should include max lines for auto-approve rules', () => {
      const rules = getClassificationRules();

      rules.autoApprove.forEach(rule => {
        expect(rule.maxLines).toBeDefined();
        expect(typeof rule.maxLines).toBe('number');
      });
    });

    it('should include reason for require-approval rules', () => {
      const rules = getClassificationRules();

      rules.requireApproval.forEach(rule => {
        expect(rule.reason).toBeDefined();
        expect(typeof rule.reason).toBe('string');
      });
    });
  });

  describe('isIdleReviewTask', () => {
    it('should identify tasks with [Idle Review] in description', () => {
      const task = { description: '[Idle Review] Check codebase' };

      expect(isIdleReviewTask(task)).toBe(true);
    });

    it('should identify tasks with autonomous code review in description', () => {
      const task = { description: 'Autonomous code review of the project' };

      expect(isIdleReviewTask(task)).toBe(true);
    });

    it('should identify tasks with reviewType: idle metadata', () => {
      const task = {
        description: 'Review something',
        metadata: { reviewType: 'idle' }
      };

      expect(isIdleReviewTask(task)).toBe(true);
    });

    it('should identify tasks with autoGenerated: true metadata', () => {
      const task = {
        description: 'Some generated task',
        metadata: { autoGenerated: true }
      };

      expect(isIdleReviewTask(task)).toBe(true);
    });

    it('should return false for regular user tasks', () => {
      const task = {
        description: 'Fix the login bug',
        metadata: {}
      };

      expect(isIdleReviewTask(task)).toBe(false);
    });

    it('should handle task with no description', () => {
      const task = { metadata: {} };

      expect(isIdleReviewTask(task)).toBe(false);
    });
  });

  describe('estimateTaskComplexity', () => {
    describe('high complexity detection', () => {
      it('should detect multi-file tasks', () => {
        const task = { description: 'Update multiple files across codebase' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('high');
      });

      it('should detect codebase-wide tasks', () => {
        const task = { description: 'Refactor pattern across codebase' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('high');
      });

      it('should detect restructuring tasks', () => {
        const task = { description: 'Restructure the component hierarchy' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('high');
      });

      it('should detect migration tasks', () => {
        const task = { description: 'Migration to new API version' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('high');
      });

      it('should detect integration tasks', () => {
        const task = { description: 'Integration with external service' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('high');
      });
    });

    describe('low complexity detection', () => {
      it('should detect single-file tasks', () => {
        const task = { description: 'Update single file' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('low');
      });

      it('should detect one-line changes', () => {
        const task = { description: 'Change one line in config' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('low');
      });

      it('should detect simple tasks', () => {
        const task = { description: 'Simple fix for button' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('low');
      });

      it('should detect typo tasks', () => {
        const task = { description: 'Fix typo in message' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('low');
      });

      it('should detect comment tasks', () => {
        const task = { description: 'Add comment to function' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('low');
      });

      it('should detect rename tasks', () => {
        const task = { description: 'Rename variable foo to bar' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('low');
      });
    });

    describe('medium complexity (default)', () => {
      it('should return medium for standard tasks', () => {
        const task = { description: 'Implement user authentication' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('medium');
      });

      it('should return medium for tasks without complexity indicators', () => {
        const task = { description: 'Add new feature to dashboard' };

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('medium');
      });
    });

    describe('empty/null handling', () => {
      it('should handle task with no description', () => {
        const task = {};

        const result = estimateTaskComplexity(task);

        expect(result.level).toBe('medium');
      });
    });
  });
});

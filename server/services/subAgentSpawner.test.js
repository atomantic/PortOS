import { describe, it, expect } from 'vitest';

/**
 * Tests for the subAgentSpawner service
 *
 * Note: We test the pure functions directly by extracting their logic.
 * The spawner has complex dependencies (process spawning, file system, etc.)
 * so we focus on the decision-making logic that can be unit tested.
 */

// Test model selection logic
describe('Model Selection Logic', () => {
  // Simulate selectModelForTask function logic
  function selectModelForTask(task, provider) {
    const desc = (task.description || '').toLowerCase();
    const context = task.metadata?.context || '';
    const contextLen = context.length;
    const priority = task.priority || 'MEDIUM';

    // Check for user-specified model preference
    const userModel = task.metadata?.model;
    const userProvider = task.metadata?.provider;

    if (userModel) {
      return {
        model: userModel,
        tier: 'user-specified',
        reason: 'user-preference',
        userProvider: userProvider || null
      };
    }

    // Image/visual analysis
    if (/image|screenshot|visual|photo|picture/.test(desc)) {
      return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'visual-analysis' };
    }

    // Critical priority
    if (priority === 'CRITICAL') {
      return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'critical-priority' };
    }

    // Complex reasoning tasks
    if (/architect|refactor|design|complex|optimize|security|audit|review.*code|performance/.test(desc)) {
      return { model: provider.heavyModel || provider.defaultModel, tier: 'heavy', reason: 'complex-task' };
    }

    // Long context
    if (contextLen > 500) {
      return { model: provider.heavyModel || provider.mediumModel || provider.defaultModel, tier: 'heavy', reason: 'long-context' };
    }

    // Detect coding/development tasks
    const isCodingTask = /\b(fix|bug|implement|develop|code|refactor|test|feature|function|class|module|api|endpoint|component|service|route|schema|migration|script|build|deploy|debug|error|exception|crash|issue|patch)\b/.test(desc);

    // Simple/quick tasks (non-coding)
    if (!isCodingTask && /fix typo|update text|update docs|edit readme|update readme|write docs|documentation only|format text/.test(desc)) {
      return { model: provider.lightModel || provider.defaultModel, tier: 'light', reason: 'documentation-task' };
    }

    // Standard tasks
    return { model: provider.mediumModel || provider.defaultModel, tier: 'medium', reason: 'standard-task' };
  }

  const mockProvider = {
    id: 'anthropic',
    name: 'Anthropic',
    defaultModel: 'claude-3-sonnet',
    lightModel: 'claude-3-haiku',
    mediumModel: 'claude-3-sonnet',
    heavyModel: 'claude-3-opus'
  };

  describe('User-specified model', () => {
    it('should use user-specified model when provided', () => {
      const task = {
        description: 'Simple task',
        metadata: { model: 'custom-model' }
      };

      const result = selectModelForTask(task, mockProvider);

      expect(result.model).toBe('custom-model');
      expect(result.tier).toBe('user-specified');
      expect(result.reason).toBe('user-preference');
    });

    it('should include user provider if specified', () => {
      const task = {
        description: 'Simple task',
        metadata: { model: 'gpt-4', provider: 'openai' }
      };

      const result = selectModelForTask(task, mockProvider);

      expect(result.userProvider).toBe('openai');
    });
  });

  describe('Visual analysis tasks', () => {
    it('should select heavy model for image analysis', () => {
      const task = { description: 'Analyze this image for errors' };
      const result = selectModelForTask(task, mockProvider);

      expect(result.model).toBe('claude-3-opus');
      expect(result.tier).toBe('heavy');
      expect(result.reason).toBe('visual-analysis');
    });

    it('should select heavy model for screenshot review', () => {
      const task = { description: 'Review the screenshot' };
      const result = selectModelForTask(task, mockProvider);

      expect(result.reason).toBe('visual-analysis');
    });
  });

  describe('Priority-based selection', () => {
    it('should select heavy model for CRITICAL priority', () => {
      const task = { description: 'Fix something', priority: 'CRITICAL' };
      const result = selectModelForTask(task, mockProvider);

      expect(result.model).toBe('claude-3-opus');
      expect(result.reason).toBe('critical-priority');
    });

    it('should not use heavy for HIGH priority alone', () => {
      const task = { description: 'Update a setting', priority: 'HIGH' };
      const result = selectModelForTask(task, mockProvider);

      expect(result.reason).not.toBe('critical-priority');
    });
  });

  describe('Complex task detection', () => {
    it.each([
      ['architect the new module', 'complex-task'],
      ['refactor the auth system', 'complex-task'],
      ['design a new API', 'complex-task'],
      ['optimize performance', 'complex-task'],
      ['security audit', 'complex-task'],
      ['review code for issues', 'complex-task']
    ])('should select heavy model for: %s', (description, expectedReason) => {
      const task = { description };
      const result = selectModelForTask(task, mockProvider);

      expect(result.tier).toBe('heavy');
      expect(result.reason).toBe(expectedReason);
    });
  });

  describe('Context length handling', () => {
    it('should select heavy model for long context', () => {
      const task = {
        description: 'Simple task',
        metadata: { context: 'x'.repeat(501) }
      };

      const result = selectModelForTask(task, mockProvider);

      expect(result.tier).toBe('heavy');
      expect(result.reason).toBe('long-context');
    });

    it('should not use heavy model for short context', () => {
      const task = {
        description: 'Simple update',
        metadata: { context: 'Short context' }
      };

      const result = selectModelForTask(task, mockProvider);

      expect(result.reason).not.toBe('long-context');
    });
  });

  describe('Documentation tasks', () => {
    // Note: The model selection logic checks for coding keywords first,
    // so we use phrases that don't contain words like 'fix', 'bug', etc.
    // which would be detected as coding tasks
    it.each([
      'update text in guide',
      'edit readme with new info',
      'format text only'
    ])('should select light model for: %s', (description) => {
      const task = { description };
      const result = selectModelForTask(task, mockProvider);

      expect(result.model).toBe('claude-3-haiku');
      expect(result.tier).toBe('light');
      expect(result.reason).toBe('documentation-task');
    });

    // These phrases contain coding keywords so they get medium model
    // Note: 'fix' is a coding keyword so 'fix typo' routes to medium tier
    it.each([
      'fix typo in manual',
      'fix typo in README',
      'update docs for feature',
      'write docs for API'
    ])('should NOT select light model when coding keyword present: %s', (description) => {
      const task = { description };
      const result = selectModelForTask(task, mockProvider);

      // These contain words like 'fix', 'docs', 'API' which are coding keywords
      expect(result.tier).not.toBe('light');
    });
  });

  describe('Coding tasks detection', () => {
    it.each([
      'fix bug in login',
      'implement new feature',
      'develop API endpoint',
      'refactor the component',
      'test the function',
      'debug the error',
      'patch the issue'
    ])('should NOT select light model for coding task: %s', (description) => {
      const task = { description };
      const result = selectModelForTask(task, mockProvider);

      expect(result.tier).not.toBe('light');
    });

    it('should use medium model for standard coding tasks', () => {
      const task = { description: 'Add a new helper function' };
      const result = selectModelForTask(task, mockProvider);

      expect(result.model).toBe('claude-3-sonnet');
      expect(result.tier).toBe('medium');
      expect(result.reason).toBe('standard-task');
    });
  });

  describe('Default fallbacks', () => {
    it('should fall back to defaultModel if lightModel not available', () => {
      const providerNoLight = { ...mockProvider, lightModel: null };
      const task = { description: 'update readme' };

      const result = selectModelForTask(task, providerNoLight);

      expect(result.model).toBe('claude-3-sonnet');
    });

    it('should fall back to defaultModel if heavyModel not available', () => {
      const providerNoHeavy = { ...mockProvider, heavyModel: null };
      const task = { description: 'analyze this image' };

      const result = selectModelForTask(task, providerNoHeavy);

      expect(result.model).toBe('claude-3-sonnet');
    });
  });
});

// Test error pattern analysis
describe('Error Analysis Logic', () => {
  const ERROR_PATTERNS = [
    {
      pattern: /API Error: 404.*model:\s*(\S+)/i,
      category: 'model-not-found',
      actionable: true
    },
    {
      pattern: /API Error: 401|authentication|unauthorized/i,
      category: 'auth-error',
      actionable: true
    },
    {
      pattern: /API Error: 429|rate.?limit|too many requests/i,
      category: 'rate-limit',
      actionable: false
    },
    {
      pattern: /API Error: 5\d{2}|server error|internal error/i,
      category: 'server-error',
      actionable: false
    },
    {
      pattern: /ECONNREFUSED|ETIMEDOUT|network error/i,
      category: 'network-error',
      actionable: false
    },
    {
      pattern: /not_found_error.*model/i,
      category: 'model-not-found',
      actionable: true
    }
  ];

  function categorizeError(output) {
    for (const errorDef of ERROR_PATTERNS) {
      if (errorDef.pattern.test(output)) {
        return {
          category: errorDef.category,
          actionable: errorDef.actionable
        };
      }
    }
    return { category: 'unknown', actionable: false };
  }

  describe('Model not found errors', () => {
    it('should detect 404 model error', () => {
      const output = 'API Error: 404 - model: claude-4-ultra not found';
      const result = categorizeError(output);

      expect(result.category).toBe('model-not-found');
      expect(result.actionable).toBe(true);
    });

    it('should detect not_found_error for model', () => {
      const output = 'Response: not_found_error - The specified model does not exist';
      const result = categorizeError(output);

      expect(result.category).toBe('model-not-found');
      expect(result.actionable).toBe(true);
    });
  });

  describe('Authentication errors', () => {
    it('should detect 401 error', () => {
      const output = 'API Error: 401 Unauthorized';
      const result = categorizeError(output);

      expect(result.category).toBe('auth-error');
      expect(result.actionable).toBe(true);
    });

    it('should detect authentication failure', () => {
      const output = 'Authentication failed: invalid API key';
      const result = categorizeError(output);

      expect(result.category).toBe('auth-error');
      expect(result.actionable).toBe(true);
    });
  });

  describe('Rate limit errors', () => {
    it('should detect 429 error', () => {
      const output = 'API Error: 429 Too Many Requests';
      const result = categorizeError(output);

      expect(result.category).toBe('rate-limit');
      expect(result.actionable).toBe(false);
    });

    it('should detect rate limit message', () => {
      const output = 'Error: Rate limit exceeded, please try again later';
      const result = categorizeError(output);

      expect(result.category).toBe('rate-limit');
      expect(result.actionable).toBe(false);
    });
  });

  describe('Server errors', () => {
    it('should detect 500 error', () => {
      const output = 'API Error: 500 Internal Server Error';
      const result = categorizeError(output);

      expect(result.category).toBe('server-error');
      expect(result.actionable).toBe(false);
    });

    it('should detect 502 error', () => {
      const output = 'API Error: 502 Bad Gateway';
      const result = categorizeError(output);

      expect(result.category).toBe('server-error');
      expect(result.actionable).toBe(false);
    });
  });

  describe('Network errors', () => {
    it('should detect connection refused', () => {
      const output = 'Error: connect ECONNREFUSED 127.0.0.1:443';
      const result = categorizeError(output);

      expect(result.category).toBe('network-error');
      expect(result.actionable).toBe(false);
    });

    it('should detect timeout', () => {
      const output = 'Error: ETIMEDOUT - connection timed out';
      const result = categorizeError(output);

      expect(result.category).toBe('network-error');
      expect(result.actionable).toBe(false);
    });
  });

  describe('Unknown errors', () => {
    it('should return unknown for unmatched patterns', () => {
      const output = 'Some random error message';
      const result = categorizeError(output);

      expect(result.category).toBe('unknown');
      expect(result.actionable).toBe(false);
    });
  });
});

// Test exit code message mapping
describe('Exit Code Analysis', () => {
  const exitCodeMessages = {
    1: 'General error',
    2: 'Misuse of shell command',
    126: 'Command invoked cannot execute (permission or not executable)',
    127: 'Command not found',
    128: 'Invalid exit argument',
    130: 'Script terminated by Ctrl+C',
    137: 'Process killed (SIGKILL)',
    143: 'Process terminated (SIGTERM - likely timeout)',
    255: 'Exit status out of range'
  };

  function getExitCodeMessage(exitCode) {
    return exitCodeMessages[exitCode] || 'Unknown error';
  }

  it.each([
    [1, 'General error'],
    [2, 'Misuse of shell command'],
    [126, 'Command invoked cannot execute (permission or not executable)'],
    [127, 'Command not found'],
    [130, 'Script terminated by Ctrl+C'],
    [137, 'Process killed (SIGKILL)'],
    [143, 'Process terminated (SIGTERM - likely timeout)']
  ])('exit code %i should map to: %s', (code, message) => {
    expect(getExitCodeMessage(code)).toBe(message);
  });

  it('should return Unknown error for unmapped codes', () => {
    expect(getExitCodeMessage(99)).toBe('Unknown error');
  });
});

// Test spawn args building
describe('Spawn Arguments Building', () => {
  function buildSpawnArgs(config, model) {
    const args = [
      '--dangerously-skip-permissions',
      '--print',
    ];

    if (model) {
      args.push('--model', model);
    }

    return args;
  }

  it('should include base flags', () => {
    const args = buildSpawnArgs({}, null);

    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--print');
  });

  it('should include model when specified', () => {
    const args = buildSpawnArgs({}, 'claude-3-sonnet');

    expect(args).toContain('--model');
    expect(args).toContain('claude-3-sonnet');
  });

  it('should not include model flag when model is null', () => {
    const args = buildSpawnArgs({}, null);

    expect(args).not.toContain('--model');
  });
});

// Test failure retry logic
describe('Task Failure Retry Logic', () => {
  const MAX_TASK_RETRIES = 3;

  /**
   * Inline copy of resolveFailedTaskUpdate decision logic (sans async I/O).
   * Returns { status, metadata, shouldCreateInvestigation }
   */
  function resolveFailedTaskStatus(task, errorAnalysis) {
    // Actionable errors get blocked immediately
    if (errorAnalysis?.actionable) {
      return {
        status: 'blocked',
        metadata: {
          ...task.metadata,
          blockedReason: errorAnalysis.message,
          blockedCategory: errorAnalysis.category,
          blockedAt: 'test-timestamp'
        },
        shouldCreateInvestigation: true
      };
    }

    // Non-actionable: track failure count
    const failureCount = (task.metadata?.failureCount || 0) + 1;
    const lastErrorCategory = errorAnalysis?.category || 'unknown';

    if (failureCount >= MAX_TASK_RETRIES) {
      return {
        status: 'blocked',
        metadata: {
          ...task.metadata,
          failureCount,
          lastFailureAt: 'test-timestamp',
          lastErrorCategory,
          blockedReason: `Max retries exceeded (${failureCount}/${MAX_TASK_RETRIES}): ${lastErrorCategory}`,
          blockedCategory: lastErrorCategory,
          blockedAt: 'test-timestamp'
        },
        shouldCreateInvestigation: true
      };
    }

    return {
      status: 'pending',
      metadata: {
        ...task.metadata,
        failureCount,
        lastFailureAt: 'test-timestamp',
        lastErrorCategory
      },
      shouldCreateInvestigation: false
    };
  }

  describe('Actionable errors', () => {
    it('should block immediately on actionable error (first failure)', () => {
      const task = { id: 'task-1', description: 'test', metadata: {} };
      const errorAnalysis = { actionable: true, category: 'auth-error', message: 'Auth failed' };

      const result = resolveFailedTaskStatus(task, errorAnalysis);

      expect(result.status).toBe('blocked');
      expect(result.metadata.blockedCategory).toBe('auth-error');
      expect(result.shouldCreateInvestigation).toBe(true);
    });

    it('should block immediately regardless of failure count', () => {
      const task = { id: 'task-1', description: 'test', metadata: { failureCount: 0 } };
      const errorAnalysis = { actionable: true, category: 'model-not-found', message: 'Model not found' };

      const result = resolveFailedTaskStatus(task, errorAnalysis);

      expect(result.status).toBe('blocked');
      expect(result.shouldCreateInvestigation).toBe(true);
    });
  });

  describe('Non-actionable errors with retry tracking', () => {
    it('should retry on first failure (failureCount goes to 1)', () => {
      const task = { id: 'task-1', description: 'test', metadata: {} };
      const errorAnalysis = { actionable: false, category: 'rate-limit', message: 'Rate limited' };

      const result = resolveFailedTaskStatus(task, errorAnalysis);

      expect(result.status).toBe('pending');
      expect(result.metadata.failureCount).toBe(1);
      expect(result.metadata.lastErrorCategory).toBe('rate-limit');
      expect(result.shouldCreateInvestigation).toBe(false);
    });

    it('should retry on second failure (failureCount goes to 2)', () => {
      const task = { id: 'task-1', description: 'test', metadata: { failureCount: 1 } };
      const errorAnalysis = { actionable: false, category: 'server-error', message: 'Server error' };

      const result = resolveFailedTaskStatus(task, errorAnalysis);

      expect(result.status).toBe('pending');
      expect(result.metadata.failureCount).toBe(2);
      expect(result.metadata.lastErrorCategory).toBe('server-error');
      expect(result.shouldCreateInvestigation).toBe(false);
    });

    it('should block after MAX_TASK_RETRIES failures', () => {
      const task = { id: 'task-1', description: 'test', metadata: { failureCount: 2 } };
      const errorAnalysis = { actionable: false, category: 'network-error', message: 'Network failed' };

      const result = resolveFailedTaskStatus(task, errorAnalysis);

      expect(result.status).toBe('blocked');
      expect(result.metadata.failureCount).toBe(3);
      expect(result.metadata.blockedReason).toContain('Max retries exceeded');
      expect(result.metadata.blockedCategory).toBe('network-error');
      expect(result.shouldCreateInvestigation).toBe(true);
    });

    it('should block when already past max retries', () => {
      const task = { id: 'task-1', description: 'test', metadata: { failureCount: 5 } };
      const errorAnalysis = { actionable: false, category: 'unknown', message: 'Unknown error' };

      const result = resolveFailedTaskStatus(task, errorAnalysis);

      expect(result.status).toBe('blocked');
      expect(result.metadata.failureCount).toBe(6);
      expect(result.shouldCreateInvestigation).toBe(true);
    });
  });

  describe('Unknown errors (no errorAnalysis)', () => {
    it('should treat null errorAnalysis as non-actionable unknown', () => {
      const task = { id: 'task-1', description: 'test', metadata: {} };

      const result = resolveFailedTaskStatus(task, null);

      expect(result.status).toBe('pending');
      expect(result.metadata.failureCount).toBe(1);
      expect(result.metadata.lastErrorCategory).toBe('unknown');
    });

    it('should still block after max retries with null errorAnalysis', () => {
      const task = { id: 'task-1', description: 'test', metadata: { failureCount: 2 } };

      const result = resolveFailedTaskStatus(task, null);

      expect(result.status).toBe('blocked');
      expect(result.metadata.failureCount).toBe(3);
      expect(result.shouldCreateInvestigation).toBe(true);
    });
  });

  describe('Metadata preservation', () => {
    it('should preserve existing metadata fields on retry', () => {
      const task = {
        id: 'task-1',
        description: 'test',
        metadata: { app: 'my-app', context: 'some context', failureCount: 1 }
      };
      const errorAnalysis = { actionable: false, category: 'rate-limit', message: 'Rate limited' };

      const result = resolveFailedTaskStatus(task, errorAnalysis);

      expect(result.metadata.app).toBe('my-app');
      expect(result.metadata.context).toBe('some context');
      expect(result.metadata.failureCount).toBe(2);
    });

    it('should preserve existing metadata fields when blocked', () => {
      const task = {
        id: 'task-1',
        description: 'test',
        metadata: { app: 'my-app', failureCount: 2 }
      };
      const errorAnalysis = { actionable: false, category: 'server-error', message: 'Server error' };

      const result = resolveFailedTaskStatus(task, errorAnalysis);

      expect(result.metadata.app).toBe('my-app');
      expect(result.metadata.failureCount).toBe(3);
      expect(result.status).toBe('blocked');
    });
  });
});

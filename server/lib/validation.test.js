import { describe, it, expect } from 'vitest';
import {
  processSchema,
  appSchema,
  appUpdateSchema,
  providerSchema,
  runSchema,
  featureAgentSchema,
  featureAgentUpdateSchema,
  validate,
  sanitizeTaskMetadata,
  stageConfigUpdateSchema,
  normalizeReviewers,
  normalizeReviewUsernames,
  resolveReviewUsernames,
  normalizeOptionalReviewers,
  resolveOptionalReviewers,
  resolveKeyedReviewers,
  buildReviewersCsv,
  buildReviewWithArgs,
  createCosTaskSchema,
  featureProviderConfigSchema,
  codeReviewSettingsSchema,
  locationSettingsSchema,
  writersRoomCharacterUpdateSchema,
  writersRoomObjectUpdateSchema,
  editorialCustomCheckUpdateSchema,
  pipelineEditorialChecksSettingsSchema,
  storyboardShotSchema,
  storyboardSceneSchema,
  restoreRequestSchema,
  subdirFilterSchema,
  isPaginationRequested,
  paginateArray,
  seriesAutopilotSettingsSchema,
} from './validation.js';

describe('validation.js', () => {
  describe('isPaginationRequested', () => {
    it('is false when neither limit nor offset is present', () => {
      expect(isPaginationRequested({})).toBe(false);
      expect(isPaginationRequested({ status: 'active' })).toBe(false);
      expect(isPaginationRequested(undefined)).toBe(false);
    });

    it('is true when limit or offset is present (even at zero / empty string)', () => {
      expect(isPaginationRequested({ limit: '10' })).toBe(true);
      expect(isPaginationRequested({ offset: '0' })).toBe(true);
      expect(isPaginationRequested({ limit: '0' })).toBe(true);
      expect(isPaginationRequested({ offset: '' })).toBe(true);
    });
  });

  describe('paginateArray', () => {
    const items = [1, 2, 3, 4, 5];

    it('windows the array and reports the full total', () => {
      expect(paginateArray(items, { limit: '2', offset: '1' })).toEqual({
        items: [2, 3],
        total: 5,
        limit: 2,
        offset: 1
      });
    });

    it('clamps limit to maxLimit and falls back to defaultLimit when invalid', () => {
      expect(paginateArray(items, { limit: '999' }, { defaultLimit: 50, maxLimit: 3 })).toMatchObject({
        items: [1, 2, 3],
        limit: 3
      });
      expect(paginateArray(items, { limit: '-1' }, { defaultLimit: 4, maxLimit: 100 })).toMatchObject({
        items: [1, 2, 3, 4],
        limit: 4
      });
    });

    it('tolerates a non-array input by treating it as empty', () => {
      expect(paginateArray(null, { limit: '5' })).toEqual({ items: [], total: 0, limit: 5, offset: 0 });
    });
  });

  describe('featureProviderConfigSchema', () => {
    it('accepts a providerId + model', () => {
      const result = featureProviderConfigSchema.safeParse({ providerId: 'codex', model: 'gpt-5' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ providerId: 'codex', model: 'gpt-5' });
    });

    it('coerces the empty-string "unset" sentinel to undefined', () => {
      const result = featureProviderConfigSchema.safeParse({ providerId: '', model: '' });
      expect(result.success).toBe(true);
      expect(result.data.providerId).toBeUndefined();
      expect(result.data.model).toBeUndefined();
    });

    it('accepts an empty object (use defaults)', () => {
      expect(featureProviderConfigSchema.safeParse({}).success).toBe(true);
    });

    it('rejects a non-string providerId', () => {
      expect(featureProviderConfigSchema.safeParse({ providerId: 42 }).success).toBe(false);
    });
  });

  describe('codeReviewSettingsSchema', () => {
    it('accepts a valid full payload', () => {
      const r = codeReviewSettingsSchema.safeParse({
        reviewers: ['copilot', 'lmstudio'],
        stopMode: 'on-clean',
        reviewerApplies: true,
        lmstudioModel: 'qwen2.5-coder:7b',
        ollamaModel: 'codellama',
        codexModel: 'gpt-5.6-sol',
        claudeModel: 'qwen2.5:7b',
      })
      expect(r.success).toBe(true)
    })

    it('coerces an empty codexModel to undefined', () => {
      const r = codeReviewSettingsSchema.safeParse({ reviewers: ['codex'], codexModel: '' })
      expect(r.success).toBe(true)
      expect(r.data.codexModel).toBeUndefined()
    })

    it('accepts a claudeModel and coerces an empty one to undefined', () => {
      const ok = codeReviewSettingsSchema.safeParse({ reviewers: ['claude'], claudeModel: 'qwen2.5:7b' })
      expect(ok.success).toBe(true)
      expect(ok.data.claudeModel).toBe('qwen2.5:7b')
      const empty = codeReviewSettingsSchema.safeParse({ reviewers: ['claude'], claudeModel: '' })
      expect(empty.success).toBe(true)
      expect(empty.data.claudeModel).toBeUndefined()
    })

    it('accepts an empty object (all fields optional)', () => {
      expect(codeReviewSettingsSchema.safeParse({}).success).toBe(true)
    })

    it('rejects unknown keys (strict mode)', () => {
      const r = codeReviewSettingsSchema.safeParse({
        reviewers: ['copilot'],
        unknownField: 'oops',
      })
      expect(r.success).toBe(false)
    })

    it('rejects an unknown reviewer enum value', () => {
      expect(codeReviewSettingsSchema.safeParse({ reviewers: ['bogus'] }).success).toBe(false)
    })

    it('rejects an unknown stopMode', () => {
      expect(codeReviewSettingsSchema.safeParse({ stopMode: 'nope' }).success).toBe(false)
    })

    it('normalizes reviewer usernames (strips @, drops unsafe, dedupes)', () => {
      const r = codeReviewSettingsSchema.safeParse({
        usernames: ['@CodeReviewbot', 'codereviewbot', 'bad token', 'my-org/reviewers'],
      })
      expect(r.success).toBe(true)
      expect(r.data.usernames).toEqual(['CodeReviewbot', 'my-org/reviewers'])
    })

    it('leaves usernames undefined when absent', () => {
      const r = codeReviewSettingsSchema.safeParse({ reviewers: ['copilot'] })
      expect(r.success).toBe(true)
      expect(r.data.usernames).toBeUndefined()
    })
  })

  describe('processSchema', () => {
    it('should validate a complete process object', () => {
      const process = {
        name: 'test-process',
        port: 3000,
        description: 'A test process'
      };
      const result = processSchema.safeParse(process);
      expect(result.success).toBe(true);
      expect(result.data).toEqual(process);
    });

    it('should allow port to be null', () => {
      const process = { name: 'test-process', port: null };
      const result = processSchema.safeParse(process);
      expect(result.success).toBe(true);
    });

    it('should allow port to be omitted', () => {
      const process = { name: 'test-process' };
      const result = processSchema.safeParse(process);
      expect(result.success).toBe(true);
    });

    it('should reject empty name', () => {
      const process = { name: '' };
      const result = processSchema.safeParse(process);
      expect(result.success).toBe(false);
    });

    it('should reject invalid port (below 1)', () => {
      const process = { name: 'test', port: 0 };
      const result = processSchema.safeParse(process);
      expect(result.success).toBe(false);
    });

    it('should reject invalid port (above 65535)', () => {
      const process = { name: 'test', port: 70000 };
      const result = processSchema.safeParse(process);
      expect(result.success).toBe(false);
    });

    it('should reject non-integer port', () => {
      const process = { name: 'test', port: 3000.5 };
      const result = processSchema.safeParse(process);
      expect(result.success).toBe(false);
    });
  });

  describe('appSchema', () => {
    it('should validate a minimal app', () => {
      const app = {
        name: 'Test App',
        repoPath: '/path/to/repo'
      };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(true);
      expect(result.data.type).toBe('express'); // default
    });

    it('should validate a full app object', () => {
      const app = {
        name: 'Full App',
        repoPath: '/path/to/repo',
        type: 'react',
        uiPort: 3000,
        apiPort: 4000,
        uiUrl: 'http://localhost:3000',
        startCommands: ['npm run dev'],
        pm2ProcessNames: ['app-ui', 'app-api'],
        processes: [{ name: 'api', port: 4000 }],
        envFile: '.env',
        icon: 'icon.png',
        editorCommand: 'cursor',
        description: 'A full test app'
      };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(true);
    });

    it('should reject empty name', () => {
      const app = { name: '', repoPath: '/path' };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(false);
    });

    it('should reject name over 100 characters', () => {
      const app = { name: 'a'.repeat(101), repoPath: '/path' };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(false);
    });

    it('should reject empty repoPath', () => {
      const app = { name: 'Test', repoPath: '' };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(false);
    });

    it('should reject invalid uiUrl', () => {
      const app = { name: 'Test', repoPath: '/path', uiUrl: 'not-a-url' };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(false);
    });

    it('should allow icon to be null', () => {
      const app = { name: 'Test', repoPath: '/path', icon: null };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(true);
    });

    it('should allow ports to be null', () => {
      const app = { name: 'Test', repoPath: '/path', uiPort: null, apiPort: null };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(true);
    });

    it('should accept valid devUiPort', () => {
      const app = { name: 'Test', repoPath: '/path', devUiPort: 5554 };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(true);
      expect(result.data.devUiPort).toBe(5554);
    });

    it('should allow devUiPort to be null', () => {
      const app = { name: 'Test', repoPath: '/path', devUiPort: null };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(true);
    });

    it('should reject invalid devUiPort', () => {
      const app = { name: 'Test', repoPath: '/path', devUiPort: 70000 };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(false);
    });

    it('should accept valid buildCommand', () => {
      const app = { name: 'Test', repoPath: '/path', buildCommand: 'npm run build' };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(true);
      expect(result.data.buildCommand).toBe('npm run build');
    });

    it('should reject buildCommand over 200 characters', () => {
      const app = { name: 'Test', repoPath: '/path', buildCommand: 'a'.repeat(201) };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(false);
    });

    it('should reject non-string buildCommand', () => {
      const app = { name: 'Test', repoPath: '/path', buildCommand: 123 };
      const result = appSchema.safeParse(app);
      expect(result.success).toBe(false);
    });
  });

  describe('appUpdateSchema', () => {
    it('should allow partial updates', () => {
      const update = { name: 'New Name' };
      const result = appUpdateSchema.safeParse(update);
      expect(result.success).toBe(true);
    });

    it('should allow empty object', () => {
      const update = {};
      const result = appUpdateSchema.safeParse(update);
      expect(result.success).toBe(true);
    });

    it('should still validate provided fields', () => {
      const update = { name: '' }; // empty name is invalid
      const result = appUpdateSchema.safeParse(update);
      expect(result.success).toBe(false);
    });

    it('should validate port ranges in updates', () => {
      const update = { uiPort: 70000 };
      const result = appUpdateSchema.safeParse(update);
      expect(result.success).toBe(false);
    });

    it('should not inject default values for omitted boolean fields', () => {
      const update = { name: 'Updated Name' };
      const result = appUpdateSchema.safeParse(update);
      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty('archived');
      expect(result.data).not.toHaveProperty('defaultUseWorktree');
      expect(result.data).not.toHaveProperty('defaultOpenPR');
    });

    it('preserves per-app taskTypeOverrides scheduling fields (intervalMs/providerId/model/taskMetadata)', () => {
      // These are persisted by updateAppTaskTypeOverride for handler-backed tasks
      // (layered-intelligence). Zod strips unknown keys, so a generic PUT would
      // silently drop them if the schema didn't declare them.
      const update = {
        taskTypeOverrides: {
          'layered-intelligence': {
            enabled: true,
            interval: '6h',
            intervalMs: 21600000,
            providerId: 'ollama',
            model: 'qwen2.5-coder:32b',
            taskMetadata: { discardWorktree: true }
          }
        }
      };
      const result = appUpdateSchema.safeParse(update);
      expect(result.success).toBe(true);
      expect(result.data.taskTypeOverrides['layered-intelligence']).toEqual(
        update.taskTypeOverrides['layered-intelligence']
      );
    });

    it('accepts null taskTypeOverrides scheduling fields (clear-to-inherit)', () => {
      const update = {
        taskTypeOverrides: {
          'layered-intelligence': { intervalMs: null, providerId: null, model: null }
        }
      };
      const result = appUpdateSchema.safeParse(update);
      expect(result.success).toBe(true);
    });
  });

  describe('providerSchema', () => {
    it('should validate a CLI provider', () => {
      const provider = {
        name: 'Claude CLI',
        type: 'cli',
        command: 'claude',
        args: ['--model', 'opus']
      };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(true);
    });

    it('should validate an API provider', () => {
      const provider = {
        name: 'OpenAI',
        type: 'api',
        endpoint: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        models: ['gpt-4', 'gpt-3.5-turbo'],
        defaultModel: 'gpt-4'
      };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(true);
    });

    it('should validate a TUI provider', () => {
      const provider = {
        name: 'Codex TUI',
        type: 'tui',
        command: 'codex',
        tuiPromptDelayMs: 2500,
        tuiIdleTimeoutMs: 180000
      };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(true);
    });

    it('should reject invalid type', () => {
      const provider = { name: 'Test', type: 'invalid' };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(false);
    });

    it('should reject empty name', () => {
      const provider = { name: '', type: 'cli' };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(false);
    });

    it('should reject name over 100 characters', () => {
      const provider = { name: 'a'.repeat(101), type: 'cli' };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(false);
    });

    it('should reject invalid endpoint URL', () => {
      const provider = { name: 'Test', type: 'api', endpoint: 'not-a-url' };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(false);
    });

    it('should validate timeout within range', () => {
      const provider = { name: 'Test', type: 'cli', timeout: 60000 };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(true);
    });

    it('should reject timeout below 1000', () => {
      const provider = { name: 'Test', type: 'cli', timeout: 500 };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(false);
    });

    it('should reject timeout above 600000', () => {
      const provider = { name: 'Test', type: 'cli', timeout: 700000 };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(false);
    });

    it('should allow envVars as record', () => {
      const provider = {
        name: 'Test',
        type: 'cli',
        envVars: { API_KEY: 'test', DEBUG: 'true' }
      };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(true);
    });

    it('should allow defaultModel to be null', () => {
      const provider = { name: 'Test', type: 'cli', defaultModel: null };
      const result = providerSchema.safeParse(provider);
      expect(result.success).toBe(true);
    });
  });

  describe('runSchema', () => {
    it('should validate an AI run', () => {
      const run = {
        type: 'ai',
        providerId: 'provider-001',
        model: 'opus',
        workspaceId: 'workspace-001',
        prompt: 'Test prompt'
      };
      const result = runSchema.safeParse(run);
      expect(result.success).toBe(true);
    });

    it('should validate a command run', () => {
      const run = {
        type: 'command',
        workspaceId: 'workspace-001',
        command: 'npm test'
      };
      const result = runSchema.safeParse(run);
      expect(result.success).toBe(true);
    });

    it('should reject invalid type', () => {
      const run = { type: 'invalid', workspaceId: 'test' };
      const result = runSchema.safeParse(run);
      expect(result.success).toBe(false);
    });

    it('should require workspaceId', () => {
      const run = { type: 'ai' };
      const result = runSchema.safeParse(run);
      expect(result.success).toBe(false);
    });

    it('should validate timeout within range', () => {
      const run = { type: 'ai', workspaceId: 'test', timeout: 300000 };
      const result = runSchema.safeParse(run);
      expect(result.success).toBe(true);
    });

    it('should reject timeout below 1000', () => {
      const run = { type: 'ai', workspaceId: 'test', timeout: 100 };
      const result = runSchema.safeParse(run);
      expect(result.success).toBe(false);
    });
  });

  describe('featureAgentSchema', () => {
    const validAgent = {
      name: 'UI Polish Agent',
      description: 'Iterates on UI improvements',
      appId: 'app-001'
    };

    it('should validate a minimal feature agent', () => {
      const result = featureAgentSchema.safeParse(validAgent);
      expect(result.success).toBe(true);
      expect(result.data.status).toBeUndefined(); // status is not in create schema
      expect(result.data.priority).toBe('MEDIUM'); // default
    });

    it('should require name', () => {
      const result = featureAgentSchema.safeParse({ ...validAgent, name: '' });
      expect(result.success).toBe(false);
    });

    it('should require description', () => {
      const result = featureAgentSchema.safeParse({ ...validAgent, description: '' });
      expect(result.success).toBe(false);
    });

    it('should require appId', () => {
      const result = featureAgentSchema.safeParse({ ...validAgent, appId: '' });
      expect(result.success).toBe(false);
    });

    it('should apply defaults for nested objects', () => {
      const result = featureAgentSchema.safeParse(validAgent);
      expect(result.success).toBe(true);
      expect(result.data.schedule.mode).toBe('continuous');
      expect(result.data.autonomyLevel).toBe('assistant');
    });

    it('should validate priority enum', () => {
      const result = featureAgentSchema.safeParse({ ...validAgent, priority: 'INVALID' });
      expect(result.success).toBe(false);
    });
  });

  describe('featureAgentUpdateSchema (deepPartial)', () => {
    it('should allow partial top-level fields', () => {
      const result = featureAgentUpdateSchema.safeParse({ name: 'New Name' });
      expect(result.success).toBe(true);
    });

    it('should allow partial nested schedule fields', () => {
      const result = featureAgentUpdateSchema.safeParse({ schedule: { mode: 'interval' } });
      expect(result.success).toBe(true);
    });

    it('should allow empty update', () => {
      const result = featureAgentUpdateSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should still validate field values when provided', () => {
      const result = featureAgentUpdateSchema.safeParse({ name: '' });
      expect(result.success).toBe(false);
    });
  });

  describe('validate function', () => {
    it('should return success:true with data for valid input', () => {
      const data = { name: 'Test', repoPath: '/path' };
      const result = validate(appSchema, data);
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data.name).toBe('Test');
    });

    it('should return success:false with errors for invalid input', () => {
      const data = { name: '', repoPath: '' };
      const result = validate(appSchema, data);
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(Array.isArray(result.errors)).toBe(true);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should format error paths correctly', () => {
      const data = { name: 'Test', repoPath: '/path', processes: [{ name: '' }] };
      const result = validate(appSchema, data);
      expect(result.success).toBe(false);
      expect(result.errors.some(e => e.path.includes('processes'))).toBe(true);
    });

    it('should include error messages', () => {
      const data = { name: 'Test' }; // missing repoPath
      const result = validate(appSchema, data);
      expect(result.success).toBe(false);
      expect(result.errors[0].message).toBeDefined();
    });

    it('should apply default values', () => {
      const data = { name: 'Test', repoPath: '/path' };
      const result = validate(appSchema, data);
      expect(result.success).toBe(true);
      expect(result.data.type).toBe('express'); // default value
    });
  });

  describe('sanitizeTaskMetadata', () => {
    it('should return null for null/undefined/non-object input', () => {
      expect(sanitizeTaskMetadata(null)).toBeNull();
      expect(sanitizeTaskMetadata(undefined)).toBeNull();
      expect(sanitizeTaskMetadata('string')).toBeNull();
      expect(sanitizeTaskMetadata(42)).toBeNull();
      expect(sanitizeTaskMetadata(true)).toBeNull();
    });

    it('should return null for arrays', () => {
      expect(sanitizeTaskMetadata([1, 2, 3])).toBeNull();
      expect(sanitizeTaskMetadata([])).toBeNull();
    });

    it('should return null for empty objects', () => {
      expect(sanitizeTaskMetadata({})).toBeNull();
    });

    it('should accept allowed keys with boolean values', () => {
      expect(sanitizeTaskMetadata({ useWorktree: true })).toEqual({ useWorktree: true });
      expect(sanitizeTaskMetadata({ simplify: false })).toEqual({ simplify: false });
      expect(sanitizeTaskMetadata({ useWorktree: true, simplify: false })).toEqual({ useWorktree: true, simplify: false });
    });

    it('should accept openPR as an allowed metadata key', () => {
      expect(sanitizeTaskMetadata({ openPR: true })).toEqual({ openPR: true });
      expect(sanitizeTaskMetadata({ openPR: false })).toEqual({ openPR: false });
      expect(sanitizeTaskMetadata({ useWorktree: true, openPR: true })).toEqual({ useWorktree: true, openPR: true });
      expect(sanitizeTaskMetadata({ useWorktree: true, openPR: true, simplify: true, reviewLoop: false }))
        .toEqual({ useWorktree: true, openPR: true, simplify: true, reviewLoop: false });
    });

    it('should drop non-boolean values for allowed keys', () => {
      expect(sanitizeTaskMetadata({ useWorktree: 'yes' })).toBeNull();
      expect(sanitizeTaskMetadata({ simplify: 1 })).toBeNull();
      expect(sanitizeTaskMetadata({ useWorktree: null })).toBeNull();
    });

    it('should drop unknown keys', () => {
      expect(sanitizeTaskMetadata({ unknownKey: true })).toBeNull();
      expect(sanitizeTaskMetadata({ useWorktree: true, foo: 'bar' })).toEqual({ useWorktree: true });
    });

    it('should accept a valid reviewer string', () => {
      expect(sanitizeTaskMetadata({ reviewer: 'copilot' })).toEqual({ reviewer: 'copilot' });
      expect(sanitizeTaskMetadata({ reviewer: 'claude' })).toEqual({ reviewer: 'claude' });
      expect(sanitizeTaskMetadata({ reviewer: 'antigravity' })).toEqual({ reviewer: 'antigravity' });
      expect(sanitizeTaskMetadata({ reviewer: 'gemini' })).toEqual({ reviewer: 'antigravity' });
      expect(sanitizeTaskMetadata({ reviewer: 'codex' })).toEqual({ reviewer: 'codex' });
      expect(sanitizeTaskMetadata({ reviewer: 'grok' })).toEqual({ reviewer: 'grok' });
      expect(sanitizeTaskMetadata({ reviewLoop: true, reviewer: 'claude' }))
        .toEqual({ reviewLoop: true, reviewer: 'claude' });
    });

    it('should drop unknown reviewer values', () => {
      expect(sanitizeTaskMetadata({ reviewer: 'unknown' })).toBeNull();
      expect(sanitizeTaskMetadata({ reviewer: '' })).toBeNull();
      expect(sanitizeTaskMetadata({ reviewer: 42 })).toBeNull();
      expect(sanitizeTaskMetadata({ useWorktree: true, reviewer: 'bogus' }))
        .toEqual({ useWorktree: true });
    });

    it('should accept a valid issueAuthorFilter and drop invalid ones', () => {
      expect(sanitizeTaskMetadata({ issueAuthorFilter: 'self' })).toEqual({ issueAuthorFilter: 'self' });
      expect(sanitizeTaskMetadata({ issueAuthorFilter: 'owner' })).toEqual({ issueAuthorFilter: 'owner' });
      expect(sanitizeTaskMetadata({ issueAuthorFilter: 'any' })).toEqual({ issueAuthorFilter: 'any' });
      // Arbitrary strings must not slip through (would silently read as the default).
      expect(sanitizeTaskMetadata({ issueAuthorFilter: 'somebody-else' })).toBeNull();
      expect(sanitizeTaskMetadata({ issueAuthorFilter: 42 })).toBeNull();
      expect(sanitizeTaskMetadata({ useWorktree: true, issueAuthorFilter: 'bogus' }))
        .toEqual({ useWorktree: true });
    });

    it('should accept swarmCount 0 + 2..6 and drop 1/out-of-range/non-integer', () => {
      // 0 is an explicit "off" (kept so a per-app override can disable swarm).
      expect(sanitizeTaskMetadata({ swarmCount: 0 })).toEqual({ swarmCount: 0 });
      expect(sanitizeTaskMetadata({ swarmCount: 2 })).toEqual({ swarmCount: 2 });
      expect(sanitizeTaskMetadata({ swarmCount: 6 })).toEqual({ swarmCount: 6 });
      // 1 (a one-agent swarm is just the single-issue flow) and out-of-range are dropped.
      expect(sanitizeTaskMetadata({ swarmCount: 1 })).toBeNull();
      expect(sanitizeTaskMetadata({ swarmCount: 7 })).toBeNull();
      expect(sanitizeTaskMetadata({ swarmCount: -1 })).toBeNull();
      // Non-integers can't smuggle an unbounded swarm size.
      expect(sanitizeTaskMetadata({ swarmCount: 3.5 })).toBeNull();
      expect(sanitizeTaskMetadata({ swarmCount: '3' })).toBeNull();
      // Drops the bad value but keeps a valid sibling key.
      expect(sanitizeTaskMetadata({ useWorktree: true, swarmCount: 99 }))
        .toEqual({ useWorktree: true });
      expect(sanitizeTaskMetadata({ issueAuthorFilter: 'any', swarmCount: 3 }))
        .toEqual({ issueAuthorFilter: 'any', swarmCount: 3 });
    });

    it('should accept an ordered reviewers list, dedupe, and drop unknowns', () => {
      expect(sanitizeTaskMetadata({ reviewers: ['codex', 'antigravity', 'copilot'] }))
        .toEqual({ reviewers: ['codex', 'antigravity', 'copilot'] });
      expect(sanitizeTaskMetadata({ reviewers: ['codex', 'codex', 'bogus', 'gemini'] }))
        .toEqual({ reviewers: ['codex', 'antigravity'] });
      expect(sanitizeTaskMetadata({ reviewers: ['nope'] })).toBeNull();
    });

    it('should normalize reviewer usernames and keep an explicit empty override', () => {
      expect(sanitizeTaskMetadata({ usernames: ['@CodeReviewbot', 'codereviewbot', 'bad token'] }))
        .toEqual({ usernames: ['CodeReviewbot'] });
      // An explicit array is KEPT even when it normalizes to empty — `[]` is a
      // meaningful "no external gate" override of the Code Review Defaults.
      expect(sanitizeTaskMetadata({ usernames: ['bad token', '$(x)'] })).toEqual({ usernames: [] });
      expect(sanitizeTaskMetadata({ usernames: [] })).toEqual({ usernames: [] });
      // A non-array usernames value contributes no keys (→ null with no siblings).
      expect(sanitizeTaskMetadata({ usernames: 'nope' })).toBeNull();
      expect(sanitizeTaskMetadata({ reviewLoop: true, usernames: ['@Bot'] }))
        .toEqual({ reviewLoop: true, usernames: ['Bot'] });
    });

    it('should accept reviewStopMode and reviewerApplies', () => {
      expect(sanitizeTaskMetadata({ reviewStopMode: 'on-clean' })).toEqual({ reviewStopMode: 'on-clean' });
      expect(sanitizeTaskMetadata({ reviewStopMode: 'bogus' })).toBeNull();
      expect(sanitizeTaskMetadata({ reviewerApplies: true })).toEqual({ reviewerApplies: true });
      expect(sanitizeTaskMetadata({ reviewerApplies: 'yes' })).toBeNull();
    });
  });

  describe('normalizeReviewers', () => {
    it('defaults to [copilot] when absent/empty', () => {
      expect(normalizeReviewers(undefined)).toEqual(['copilot']);
      expect(normalizeReviewers({})).toEqual(['copilot']);
      expect(normalizeReviewers({ reviewers: [] })).toEqual(['copilot']);
      expect(normalizeReviewers({ reviewers: ['bogus'] })).toEqual(['copilot']);
    });

    it('prefers reviewers, falls back to legacy reviewer, preserves order + dedupes', () => {
      expect(normalizeReviewers({ reviewer: 'codex' })).toEqual(['codex']);
      expect(normalizeReviewers({ reviewers: ['antigravity', 'codex', 'antigravity'] })).toEqual(['antigravity', 'codex']);
      expect(normalizeReviewers({ reviewers: ['gemini', 'codex', 'gemini'] })).toEqual(['antigravity', 'codex']);
      // `reviewers` wins over legacy `reviewer`.
      expect(normalizeReviewers({ reviewers: ['claude'], reviewer: 'codex' })).toEqual(['claude']);
    });

    it('accepts local-LLM reviewer kinds (lmstudio / ollama)', () => {
      expect(normalizeReviewers({ reviewers: ['lmstudio', 'ollama'] })).toEqual(['lmstudio', 'ollama']);
      expect(normalizeReviewers({ reviewer: 'lmstudio' })).toEqual(['lmstudio']);
    });

    it('uses the fallback when metadata is empty and falls back to copilot when the fallback is invalid', () => {
      // Settings-derived defaults flow through when the task didn't pin reviewers.
      expect(normalizeReviewers({}, ['antigravity', 'codex'])).toEqual(['antigravity', 'codex']);
      expect(normalizeReviewers({}, ['gemini', 'codex'])).toEqual(['antigravity', 'codex']);
      // An all-bogus fallback collapses to the hardcoded copilot, never an empty list.
      expect(normalizeReviewers({}, ['bogus', null])).toEqual(['copilot']);
      // Explicit task metadata still wins over the fallback.
      expect(normalizeReviewers({ reviewers: ['claude'] }, ['antigravity'])).toEqual(['claude']);
    });
  });

  describe('normalizeReviewUsernames', () => {
    it('strips a leading @, trims, and preserves order', () => {
      expect(normalizeReviewUsernames(['@CodeReviewbot', ' reviewer-two '])).toEqual(['CodeReviewbot', 'reviewer-two']);
    });

    it('case-insensitively dedupes while keeping first occurrence', () => {
      expect(normalizeReviewUsernames(['@Bot', 'bot', 'BOT', 'other'])).toEqual(['Bot', 'other']);
    });

    it('drops shell-unsafe / non-username tokens', () => {
      expect(normalizeReviewUsernames(['ok', 'bad token', 'semi;rm', '$(x)', 'a`b', 42, null, '', '   ']))
        .toEqual(['ok']);
    });

    it('accepts org/team slugs', () => {
      expect(normalizeReviewUsernames(['my-org/reviewers'])).toEqual(['my-org/reviewers']);
    });

    it('caps the list at MAX_REVIEW_USERNAMES (20)', () => {
      const many = Array.from({ length: 30 }, (_, i) => `user${i}`);
      expect(normalizeReviewUsernames(many)).toHaveLength(20);
    });

    it('returns [] for non-array input', () => {
      expect(normalizeReviewUsernames(undefined)).toEqual([]);
      expect(normalizeReviewUsernames('nope')).toEqual([]);
    });
  });

  describe('resolveKeyedReviewers', () => {
    it('keeps an explicitly empty list empty only when usernames carry the review', () => {
      expect(resolveKeyedReviewers([], true)).toEqual([]);
      // No usernames → falls back to the copilot default (can never be empty).
      expect(resolveKeyedReviewers([], false)).toEqual(['copilot']);
    });

    it('normalizes a populated list and defaults absent/legacy input to copilot', () => {
      expect(resolveKeyedReviewers(['codex', 'gemini'], true)).toEqual(['codex', 'antigravity']);
      expect(resolveKeyedReviewers(undefined, true)).toEqual(['copilot']);
    });
  });

  describe('resolveReviewUsernames', () => {
    it('lets a task-level list (even empty) override the defaults', () => {
      expect(resolveReviewUsernames(['@Bot'], ['Default'])).toEqual(['Bot']);
      // Explicit empty task list wins over the defaults (username-only override).
      expect(resolveReviewUsernames([], ['Default'])).toEqual([]);
    });

    it('falls back to the defaults when the task did not pin its own', () => {
      expect(resolveReviewUsernames(undefined, ['@Default', 'bad token'])).toEqual(['Default']);
    });
  });

  describe('buildReviewersCsv', () => {
    it('joins keyed reviewers then @user tokens', () => {
      expect(buildReviewersCsv(['copilot', 'codex'], ['@Bot'])).toBe('copilot,codex,@Bot');
    });

    it('falls back to the copilot default when the keyed list is empty', () => {
      expect(buildReviewersCsv([], [])).toBe('copilot');
      expect(buildReviewersCsv([], ['Bot'])).toBe('copilot,@Bot');
    });

    it('normalizes/strips bogus usernames', () => {
      expect(buildReviewersCsv(['codex'], ['@Bot', 'bad token', 'bot'])).toBe('codex,@Bot');
    });
  });

  describe('buildReviewWithArgs', () => {
    it('emits nothing for the lone default copilot', () => {
      expect(buildReviewWithArgs(['copilot'])).toBe('');
      expect(buildReviewWithArgs([])).toBe('');
    });

    it('emits the ordered comma list when not lone-default', () => {
      expect(buildReviewWithArgs(['codex'])).toBe('--review-with codex');
      expect(buildReviewWithArgs(['codex', 'antigravity', 'copilot'])).toBe('--review-with codex,antigravity,copilot');
    });

    it('adds stop-mode only for 2+ reviewers and reviewer-applies only with a CLI reviewer', () => {
      expect(buildReviewWithArgs(['codex', 'copilot'], 'on-findings', true))
        .toBe('--review-with codex,copilot --review-stop-on-findings --reviewer-applies');
      // single reviewer → no stop-mode flag
      expect(buildReviewWithArgs(['codex'], 'on-clean', true))
        .toBe('--review-with codex --reviewer-applies');
      // copilot-only → reviewer-applies suppressed (no-op on copilot)
      expect(buildReviewWithArgs(['copilot'], 'all', true)).toBe('');
    });

    it('appends username reviewers as @user tokens after the keyed reviewers', () => {
      // copilot + a username is no longer "lone default" → the flag is emitted.
      expect(buildReviewWithArgs(['copilot'], 'all', false, ['CodeReviewbot']))
        .toBe('--review-with copilot,@CodeReviewbot');
      expect(buildReviewWithArgs(['codex', 'copilot'], 'all', false, ['@Bot']))
        .toBe('--review-with codex,copilot,@Bot');
    });

    it('counts usernames toward the 2+ stop-mode gate', () => {
      // one keyed reviewer + one username = two review sources → stop-mode applies.
      expect(buildReviewWithArgs(['copilot'], 'on-clean', false, ['Bot']))
        .toBe('--review-with copilot,@Bot --review-stop-on-clean');
    });

    it('does not enable reviewer-applies for username-only additions', () => {
      // usernames are external PR reviewers, not CLIs that apply fixes.
      expect(buildReviewWithArgs(['copilot'], 'all', true, ['Bot']))
        .toBe('--review-with copilot,@Bot');
    });

    it('normalizes/strips bogus usernames before emitting', () => {
      expect(buildReviewWithArgs(['copilot'], 'all', false, ['@Bot', 'bad token', 'bot']))
        .toBe('--review-with copilot,@Bot');
    });

    it('appends ~opt to the tokens named in optionalReviewers (keyed + @user)', () => {
      // ollama marked optional → its token carries ~opt; codex stays blocking.
      expect(buildReviewWithArgs(['claude', 'ollama', 'codex'], 'all', false, [], ['ollama']))
        .toBe('--review-with claude,ollama~opt,codex');
      // a username can be optional too — matched by its @-form.
      expect(buildReviewWithArgs(['codex'], 'all', false, ['Bot'], ['@Bot']))
        .toBe('--review-with codex,@Bot~opt');
      // aliases resolve before matching: gemini→antigravity.
      expect(buildReviewWithArgs(['antigravity', 'codex'], 'all', false, [], ['gemini']))
        .toBe('--review-with antigravity~opt,codex');
    });

    it('forces the flag on for a lone default copilot marked optional (so ~opt is not lost)', () => {
      // Without the marker this is the suppressed lone-default case ('').
      expect(buildReviewWithArgs(['copilot'], 'all', false, [], ['copilot']))
        .toBe('--review-with copilot~opt');
    });

    it('ignores optionalReviewers entries not present in the emitted list', () => {
      expect(buildReviewWithArgs(['codex', 'copilot'], 'all', false, [], ['ollama', 'bad token']))
        .toBe('--review-with codex,copilot');
    });
  });

  describe('normalizeOptionalReviewers', () => {
    it('keeps known keyed slugs and @usernames, aliases gemini→antigravity', () => {
      expect(normalizeOptionalReviewers(['ollama', '@Bot', 'gemini', 'lmstudio']))
        .toEqual(['ollama', '@Bot', 'antigravity', 'lmstudio']);
    });

    it('drops unknown slugs, unsafe usernames, non-strings, and dedupes case-insensitively', () => {
      expect(normalizeOptionalReviewers(['ollama', 'OLLAMA', 'nope', '@bad token', 42, null, '@Bot', '@bot']))
        .toEqual(['ollama', '@Bot']);
    });

    it('returns undefined for non-array input (an omitted field is not an empty override)', () => {
      expect(normalizeOptionalReviewers(undefined)).toBeUndefined();
      expect(normalizeOptionalReviewers('ollama')).toBeUndefined();
    });
  });

  describe('resolveOptionalReviewers', () => {
    it('lets a task-level list (even empty) override the defaults', () => {
      expect(resolveOptionalReviewers(['ollama'], ['codex'])).toEqual(['ollama']);
      expect(resolveOptionalReviewers([], ['codex'])).toEqual([]);
    });

    it('falls back to the defaults when the task did not pin its own', () => {
      expect(resolveOptionalReviewers(undefined, ['ollama', 'nope'])).toEqual(['ollama']);
      expect(resolveOptionalReviewers(undefined, undefined)).toEqual([]);
    });
  });

  describe('buildReviewersCsv — optional markers', () => {
    it('appends ~opt to the CSV tokens named optional', () => {
      expect(buildReviewersCsv(['claude', 'ollama'], ['@Bot'], ['ollama', '@Bot']))
        .toBe('claude,ollama~opt,@Bot~opt');
    });
  });

  describe('createCosTaskSchema reviewers fields', () => {
    it('accepts reviewers/reviewStopMode/reviewerApplies', () => {
      const parsed = createCosTaskSchema.safeParse({
        description: 'do a thing',
        reviewers: ['codex', 'antigravity', 'copilot'],
        reviewStopMode: 'on-clean',
        reviewerApplies: true
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data.reviewers).toEqual(['codex', 'antigravity', 'copilot']);
      expect(parsed.data.reviewStopMode).toBe('on-clean');
      expect(parsed.data.reviewerApplies).toBe(true);
    });

    it('rejects an unknown reviewer or stop-mode', () => {
      expect(createCosTaskSchema.safeParse({ description: 'x', reviewers: ['bogus'] }).success).toBe(false);
      expect(createCosTaskSchema.safeParse({ description: 'x', reviewStopMode: 'nope' }).success).toBe(false);
    });

    it('normalizes reviewer usernames and leaves the field undefined when absent', () => {
      const withUsers = createCosTaskSchema.safeParse({
        description: 'x',
        usernames: ['@CodeReviewbot', 'bad token', 'codereviewbot'],
      });
      expect(withUsers.success).toBe(true);
      expect(withUsers.data.usernames).toEqual(['CodeReviewbot']);
      // Absent → undefined (not coerced to []), so it isn't persisted as an override.
      const withoutUsers = createCosTaskSchema.safeParse({ description: 'x' });
      expect(withoutUsers.success).toBe(true);
      expect(withoutUsers.data.usernames).toBeUndefined();
    });

    it('accepts multiple image screenshots and attachment objects', () => {
      const parsed = createCosTaskSchema.safeParse({
        description: 'do a thing',
        screenshots: ['/data/screenshots/a.png', '/data/screenshots/b.png'],
        attachments: [
          { filename: 'a-123.png', originalName: 'photo-one.png', path: '/data/cos/attachments/a-123.png', size: 100, mimeType: 'image/png' },
          { filename: 'b-456.png', originalName: 'photo-two.png', path: '/data/cos/attachments/b-456.png', size: 200, mimeType: 'image/png' },
        ],
      });
      expect(parsed.success).toBe(true);
      expect(parsed.data.screenshots).toHaveLength(2);
      expect(parsed.data.attachments).toHaveLength(2);
      expect(parsed.data.attachments[1].originalName).toBe('photo-two.png');
    });

    it('rejects a legacy attachments-as-strings shape', () => {
      expect(createCosTaskSchema.safeParse({ description: 'x', attachments: ['a.png'] }).success).toBe(false);
    });

    it('should reject prototype pollution keys', () => {
      expect(sanitizeTaskMetadata({ __proto__: { malicious: true } })).toBeNull();
      expect(sanitizeTaskMetadata({ constructor: true })).toBeNull();
      expect(sanitizeTaskMetadata({ prototype: true })).toBeNull();
    });

    it('should not accept inherited properties', () => {
      const proto = { useWorktree: true };
      const obj = Object.create(proto);
      expect(sanitizeTaskMetadata(obj)).toBeNull();
    });
  });

  // The stage-config schema is the only validator standing between an
  // unvalidated client PUT and disk, and its `timeout` preprocess + .strip()
  // behaviors are explicitly engineered to mirror parseTimeoutMs on the
  // client and to block prototype-pollution / config-key squatting. These
  // tests pin the contract; a drift here would let one side accept shapes
  // the other rejects, or quietly persist garbage to stage-config.json.
  describe('stageConfigUpdateSchema', () => {
    it('accepts a complete update', () => {
      const out = stageConfigUpdateSchema.parse({
        name: 'Adapt', description: 'd', model: 'heavy', provider: 'codex',
        timeout: 900000, returnsJson: true, variables: ['schemaSnippet'],
      });
      expect(out.timeout).toBe(900000);
    });

    it('coerces a digit-only numeric string to a number', () => {
      expect(stageConfigUpdateSchema.parse({ timeout: '900000' }).timeout).toBe(900000);
    });

    it('accepts a numeric value unchanged', () => {
      expect(stageConfigUpdateSchema.parse({ timeout: 60000 }).timeout).toBe(60000);
    });

    it('treats empty string and null as a clear (timeout: null)', () => {
      expect(stageConfigUpdateSchema.parse({ timeout: '' }).timeout).toBeNull();
      expect(stageConfigUpdateSchema.parse({ timeout: null }).timeout).toBeNull();
    });

    it('leaves timeout untouched when absent', () => {
      const out = stageConfigUpdateSchema.parse({ name: 'x' });
      expect('timeout' in out).toBe(false);
    });

    it('preserves the writer/judge split fields (#2167) instead of stripping them', () => {
      const out = stageConfigUpdateSchema.parse({ judgeProvider: 'codex', judgeModel: 'heavy' });
      expect(out.judgeProvider).toBe('codex');
      expect(out.judgeModel).toBe('heavy');
    });

    it('accepts null judgeProvider/judgeModel as a cleared pin', () => {
      const out = stageConfigUpdateSchema.parse({ judgeProvider: null, judgeModel: null });
      expect(out.judgeProvider).toBeNull();
      expect(out.judgeModel).toBeNull();
    });

    it('rejects non-digit numeric strings (1e3 / 1.5 / 0x10) to mirror client parseTimeoutMs', () => {
      // The client's digit-only regex rejects these; the server preprocess
      // also leaves non-digit strings as-is so the inner z.number() fails.
      expect(stageConfigUpdateSchema.safeParse({ timeout: '1e3' }).success).toBe(false);
      expect(stageConfigUpdateSchema.safeParse({ timeout: '1000.5' }).success).toBe(false);
      expect(stageConfigUpdateSchema.safeParse({ timeout: '0x10' }).success).toBe(false);
      expect(stageConfigUpdateSchema.safeParse({ timeout: 'abc' }).success).toBe(false);
    });

    it('rejects non-integer numbers', () => {
      expect(stageConfigUpdateSchema.safeParse({ timeout: 1000.5 }).success).toBe(false);
    });

    it('enforces the 1s lower bound', () => {
      expect(stageConfigUpdateSchema.safeParse({ timeout: 999 }).success).toBe(false);
      expect(stageConfigUpdateSchema.parse({ timeout: 1000 }).timeout).toBe(1000);
    });

    it('enforces the 30-minute upper bound', () => {
      expect(stageConfigUpdateSchema.parse({ timeout: 1800000 }).timeout).toBe(1800000);
      expect(stageConfigUpdateSchema.safeParse({ timeout: 1800001 }).success).toBe(false);
    });

    it('strips unknown keys (no prototype-pollution leak via spread merge)', () => {
      const out = stageConfigUpdateSchema.parse({
        name: 'x',
        constructor: 'evil',
        prototype: 'nope',
        typoField: 'oops',
      });
      // `name` is the only schema-known key; constructor / prototype / typoField
      // must be stripped so updateStageConfig's `{...existing, ...updated}`
      // spread can never see them.
      expect(out).toEqual({ name: 'x' });
    });
  });

  describe('locationSettingsSchema', () => {
    it('accepts a valid lat/lon pair', () => {
      const r = locationSettingsSchema.safeParse({ lat: 37.7749, lon: -122.4194 });
      expect(r.success).toBe(true);
      expect(r.data).toEqual({ lat: 37.7749, lon: -122.4194 });
    });

    it('accepts an empty object (no location set)', () => {
      expect(locationSettingsSchema.safeParse({}).success).toBe(true);
    });

    it('accepts both fields null (cleared location)', () => {
      expect(locationSettingsSchema.safeParse({ lat: null, lon: null }).success).toBe(true);
    });

    it('rejects only one coordinate set (both-or-neither)', () => {
      expect(locationSettingsSchema.safeParse({ lat: 37.7749 }).success).toBe(false);
      expect(locationSettingsSchema.safeParse({ lat: 37.7749, lon: null }).success).toBe(false);
      expect(locationSettingsSchema.safeParse({ lon: -122.4194 }).success).toBe(false);
    });

    it('rejects out-of-range coordinates', () => {
      expect(locationSettingsSchema.safeParse({ lat: 91, lon: 0 }).success).toBe(false);
      expect(locationSettingsSchema.safeParse({ lat: 0, lon: 181 }).success).toBe(false);
      expect(locationSettingsSchema.safeParse({ lat: -91, lon: 0 }).success).toBe(false);
    });

    it('rejects non-number coordinates', () => {
      expect(locationSettingsSchema.safeParse({ lat: '37.7', lon: '-122.4' }).success).toBe(false);
    });

    it('rejects unknown keys (strict)', () => {
      expect(locationSettingsSchema.safeParse({ lat: 1, lon: 1, alt: 100 }).success).toBe(false);
    });
  });

  describe('writersRoomCharacterUpdateSchema — relationshipLinks (#1287)', () => {
    it('accepts a well-formed relationship link with opposition', () => {
      const result = writersRoomCharacterUpdateSchema.safeParse({
        relationshipLinks: [{
          targetCharacterId: 'chr-bob',
          type: 'antagonist',
          description: 'mortal enemies',
          opposition: { axis: 'hunter/prey', thisRole: 'hunter', targetRole: 'prey', note: 'will it flip?' },
        }],
      });
      expect(result.success).toBe(true);
    });

    it('accepts a link with no id (server mints it) and a custom type', () => {
      const result = writersRoomCharacterUpdateSchema.safeParse({
        relationshipLinks: [{ targetCharacterId: 'chr-bob', type: 'frenemy' }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects a link missing targetCharacterId', () => {
      const result = writersRoomCharacterUpdateSchema.safeParse({
        relationshipLinks: [{ type: 'ally' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unknown key inside a link (strict)', () => {
      const result = writersRoomCharacterUpdateSchema.safeParse({
        relationshipLinks: [{ targetCharacterId: 'chr-bob', bogus: true }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('writersRoomObjectUpdateSchema — attachments (#1288)', () => {
    it('accepts a well-formed attachment', () => {
      const result = writersRoomObjectUpdateSchema.safeParse({
        attachments: [{
          characterId: 'chr-mara',
          emotion: 'grief',
          significance: 'her father gave it to her',
          origin: 'inherited at his funeral',
          role: 'memento',
        }],
      });
      expect(result.success).toBe(true);
    });

    it('accepts an attachment with no id (server mints it) and a custom role', () => {
      const result = writersRoomObjectUpdateSchema.safeParse({
        attachments: [{ characterId: 'chr-mara', role: 'heirloom' }],
      });
      expect(result.success).toBe(true);
    });

    it('rejects an attachment missing characterId', () => {
      const result = writersRoomObjectUpdateSchema.safeParse({
        attachments: [{ emotion: 'grief' }],
      });
      expect(result.success).toBe(false);
    });

    it('rejects an unknown key inside an attachment (strict)', () => {
      const result = writersRoomObjectUpdateSchema.safeParse({
        attachments: [{ characterId: 'chr-mara', bogus: true }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe('editorial custom checks (#1346)', () => {
    it('the update schema applies NO defaults (omitted field stays absent)', () => {
      const parsed = editorialCustomCheckUpdateSchema.parse({ label: 'Renamed' });
      // A defaulted optional would inject scope/category/description here and
      // silently reset the stored values on a field-specific PATCH.
      expect(parsed).toEqual({ label: 'Renamed' });
    });

    it('the update schema still rejects bad enum values and unknown keys', () => {
      expect(editorialCustomCheckUpdateSchema.safeParse({ scope: 'bogus' }).success).toBe(false);
      expect(editorialCustomCheckUpdateSchema.safeParse({ nope: 1 }).success).toBe(false);
    });

    it('accepts a non-negative integer checkFindingsPauseThreshold and rejects bad shapes (#1613)', () => {
      expect(pipelineEditorialChecksSettingsSchema.safeParse({ checkFindingsPauseThreshold: 0 }).success).toBe(true);
      expect(pipelineEditorialChecksSettingsSchema.safeParse({ checkFindingsPauseThreshold: 25 }).success).toBe(true);
      // additive + optional: omitting it is fine
      expect(pipelineEditorialChecksSettingsSchema.safeParse({}).success).toBe(true);
      // negative / non-integer are rejected
      expect(pipelineEditorialChecksSettingsSchema.safeParse({ checkFindingsPauseThreshold: -1 }).success).toBe(false);
      expect(pipelineEditorialChecksSettingsSchema.safeParse({ checkFindingsPauseThreshold: 2.5 }).success).toBe(false);
    });

    it('the settings slice accepts forward/older-peer custom-check shapes (lenient)', () => {
      // A def carrying a future field (or a not-yet-known scope) must not 400 an
      // unrelated settings save — runtime buildCustomCheck decides runnability.
      const result = pipelineEditorialChecksSettingsSchema.safeParse({
        customChecks: [{ id: 'custom.x', label: 'Future', prompt: 'p', scope: 'galaxy', futureField: { nested: true } }],
      });
      expect(result.success).toBe(true);
      expect(result.data.customChecks[0].futureField).toEqual({ nested: true }); // unknown keys preserved
    });
  });

  describe('storyboardShotSchema / storyboardSceneSchema (#1315)', () => {
    it('accepts valid shot-grammar enums', () => {
      const r = storyboardShotSchema.safeParse({ id: 'shot-01', description: 'x', shotType: 'wide', screenDirection: 'left' });
      expect(r.success).toBe(true);
      expect(r.data).toMatchObject({ shotType: 'wide', screenDirection: 'left' });
    });

    it('rejects an unknown shotType / screenDirection', () => {
      expect(storyboardShotSchema.safeParse({ id: 's', shotType: 'banana' }).success).toBe(false);
      expect(storyboardShotSchema.safeParse({ id: 's', screenDirection: 'sideways' }).success).toBe(false);
    });

    it('tolerates the UI sentinels: null and empty-string clear', () => {
      expect(storyboardShotSchema.safeParse({ id: 's', shotType: null, screenDirection: null }).success).toBe(true);
      const r = storyboardShotSchema.safeParse({ id: 's', shotType: '', screenDirection: '' });
      expect(r.success).toBe(true);
      expect(r.data.shotType).toBeNull();      // '' → null (treated as "not captured")
      expect(r.data.screenDirection).toBeNull();
    });

    it('accepts a long description (2001–4000) the UI permits — the sanitizer truncates, the route must not 400', () => {
      // Regression: the route cap must match the UI textarea (maxLength=4000),
      // NOT the sanitizer's 2000 — rejecting a UI-allowed edit would turn the
      // previously-passthrough scenes PATCH into a 400.
      const r = storyboardShotSchema.safeParse({ id: 's', description: 'x'.repeat(3500) });
      expect(r.success).toBe(true);
      expect(storyboardShotSchema.safeParse({ id: 's', description: 'x'.repeat(4001) }).success).toBe(false);
    });

    it('passes through render-time fields stamped onto a shot (startFrameJobId)', () => {
      const r = storyboardShotSchema.safeParse({ id: 's', description: 'x', startFrameJobId: 'job-9' });
      expect(r.success).toBe(true);
      expect(r.data.startFrameJobId).toBe('job-9');
    });

    it('scene schema validates shots[] but passes the rest of the scene through', () => {
      const r = storyboardSceneSchema.safeParse({
        heading: 'INT. ROOM', slugline: 'INT. ROOM — DAY', sceneVideoJobId: 'v1',
        shots: [{ id: 'shot-01', description: 'x', shotType: 'medium', screenDirection: 'right' }],
      });
      expect(r.success).toBe(true);
      expect(r.data.heading).toBe('INT. ROOM');
      expect(r.data.sceneVideoJobId).toBe('v1');
      // A bad enum inside shots[] fails the whole scene.
      expect(storyboardSceneSchema.safeParse({ shots: [{ id: 's', shotType: 'nope' }] }).success).toBe(false);
    });
  });

  describe('subdirFilter validation (#1822)', () => {
    it('accepts a plain relative subdir', () => {
      expect(subdirFilterSchema.safeParse('data').success).toBe(true);
      expect(subdirFilterSchema.safeParse('brain/notes').success).toBe(true);
      expect(subdirFilterSchema.safeParse('cos.worktrees').success).toBe(true);
    });

    it('rejects wildcard characters that would override the rsync filter chain', () => {
      expect(subdirFilterSchema.safeParse('*').success).toBe(false);
      expect(subdirFilterSchema.safeParse('data/*').success).toBe(false);
    });

    it('rejects ".." traversal segments and absolute paths', () => {
      expect(subdirFilterSchema.safeParse('../other-dir').success).toBe(false);
      expect(subdirFilterSchema.safeParse('data/../../etc').success).toBe(false);
      expect(subdirFilterSchema.safeParse('/etc/passwd').success).toBe(false);
    });

    it('allows the field to be omitted or null on the restore request', () => {
      expect(restoreRequestSchema.safeParse({ snapshotId: 's1' }).success).toBe(true);
      expect(restoreRequestSchema.safeParse({ snapshotId: 's1', subdirFilter: null }).success).toBe(true);
      expect(restoreRequestSchema.safeParse({ snapshotId: 's1', subdirFilter: '*' }).success).toBe(false);
    });
  });
});

describe('seriesAutopilotSettingsSchema (#2174)', () => {
  const rejects = (cron) => expect(seriesAutopilotSettingsSchema.safeParse({
    schedules: [{ seriesId: 's1', cron }],
  }).success).toBe(false);
  const accepts = (cron) => expect(seriesAutopilotSettingsSchema.safeParse({
    schedules: [{ seriesId: 's1', cron }],
  }).success).toBe(true);

  it('rejects out-of-range / malformed crons so an enabled schedule cannot silently never fire', () => {
    rejects('99 99 * * *'); // minute/hour out of range
    rejects('0 3 * *');     // only 4 fields
    rejects('0 3 * * * *'); // 6 fields
    rejects('not a cron');
    rejects('60 * * * *');  // minute 60 (max 59)
  });

  it('accepts common valid crons (ranges, lists, steps)', () => {
    accepts('0 3 * * *');
    accepts('*/15 * * * *');
    accepts('0 9 * * 1-5');
    accepts('0 0,12 1 */2 *');
  });

  it('defaults enabled to false and coerces blank provider/model to undefined', () => {
    const parsed = seriesAutopilotSettingsSchema.parse({
      schedules: [{ seriesId: 's1', cron: '0 3 * * *', provider: '', model: '' }],
    });
    expect(parsed.schedules[0]).toEqual({ seriesId: 's1', cron: '0 3 * * *', enabled: false });
  });
});

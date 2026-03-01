import { describe, it, expect } from 'vitest';
import {
  processSchema,
  appSchema,
  appUpdateSchema,
  providerSchema,
  runSchema,
  validate
} from './validation.js';

describe('validation.js', () => {
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
});

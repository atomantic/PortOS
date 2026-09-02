import { describe, expect, it } from 'vitest';
import { PUBLIC_REVIEW_EXECUTION_PROFILE } from './agentExecutionProfiles.js';
import {
  buildVendorSpawnConfig,
  supportsPublicReviewProvider,
} from './providerVendors.js';

const localClaude = {
  id: 'claude-ollama',
  type: 'cli',
  command: 'claude',
  ollamaBacked: true,
  args: ['--dangerously-skip-permissions', '--tools', 'Bash'],
  envVars: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
    ANTHROPIC_AUTH_TOKEN: 'local-only',
  },
};

describe('public-review provider profile', () => {
  it('supports only the maintained local non-interactive Claude wrapper', () => {
    expect(supportsPublicReviewProvider(localClaude)).toBe(true);
    expect(supportsPublicReviewProvider({ ...localClaude, type: 'tui' })).toBe(false);
    expect(supportsPublicReviewProvider({ ...localClaude, ollamaBacked: false })).toBe(false);
    expect(supportsPublicReviewProvider({
      ...localClaude,
      envVars: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    })).toBe(false);
    expect(supportsPublicReviewProvider({
      ...localClaude,
      command: 'claude',
      type: 'api',
    })).toBe(false);
  });

  it('builds a fresh no-tool argv and ignores dangerous saved provider args', () => {
    const config = buildVendorSpawnConfig(localClaude, {
      effectiveModel: 'qwen3.8:27b',
      effort: 'max',
      safetyProfile: PUBLIC_REVIEW_EXECUTION_PROFILE,
    });

    expect(config.command).toBe('claude');
    expect(config.stdinMode).toBe('prompt');
    expect(config.args).toContain('--permission-mode');
    expect(config.args).toContain('plan');
    expect(config.args).toContain('--restricted');
    expect(config.args).toContain('--tools');
    expect(config.args[config.args.indexOf('--tools') + 1]).toBe('');
    expect(config.args).toContain('--strict-mcp-config');
    expect(config.args).toContain('--bare');
    expect(config.args).toContain('--model');
    expect(config.args).toContain('qwen3.8:27b');
    expect(config.args).toContain('--effort');
    expect(config.args).not.toContain('--dangerously-skip-permissions');
    expect(config.args).not.toContain('Bash');
    expect(config.args).not.toContain('--disallowedTools');
  });

  it('fails closed instead of assigning the profile to cloud or unknown providers', () => {
    expect(() => buildVendorSpawnConfig({
      id: 'claude-cloud',
      type: 'cli',
      command: 'claude',
      envVars: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
    }, {
      effectiveModel: 'cloud-model',
      safetyProfile: PUBLIC_REVIEW_EXECUTION_PROFILE,
    })).toThrow(/no enforced public-review posture/);

    expect(() => buildVendorSpawnConfig({
      id: 'custom-agent',
      type: 'cli',
      command: 'custom-agent',
    }, {
      effectiveModel: 'model',
      safetyProfile: PUBLIC_REVIEW_EXECUTION_PROFILE,
    })).toThrow(/no enforced public-review posture/);
  });
});

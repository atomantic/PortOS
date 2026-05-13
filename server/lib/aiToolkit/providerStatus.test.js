import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createProviderStatusService } from './providerStatus.js';

const TEST_DATA_DIR = join(process.cwd(), 'test-data-status');

describe('Provider Status Service', () => {
  let statusService;

  beforeEach(async () => {
    // Create test data directory
    if (!existsSync(TEST_DATA_DIR)) {
      await mkdir(TEST_DATA_DIR, { recursive: true });
    }

    statusService = createProviderStatusService({
      dataDir: TEST_DATA_DIR,
      statusFile: 'provider-status.json',
      defaultFallbackPriority: ['fallback-provider-1', 'fallback-provider-2'],
      defaultUsageLimitWait: 1000, // 1 second for testing
      defaultRateLimitWait: 500 // 0.5 seconds for testing
    });

    await statusService.init();
  });

  afterEach(async () => {
    // Clean up test data
    if (existsSync(TEST_DATA_DIR)) {
      await rm(TEST_DATA_DIR, { recursive: true });
    }
  });

  describe('getStatus', () => {
    it('should return available status for unknown provider', () => {
      const status = statusService.getStatus('unknown-provider');
      expect(status.available).toBe(true);
      expect(status.reason).toBe('ok');
    });
  });

  describe('isAvailable', () => {
    it('should return true for available provider', () => {
      expect(statusService.isAvailable('any-provider')).toBe(true);
    });

    it('should return false after marking usage limit', async () => {
      await statusService.markUsageLimit('test-provider', {
        message: 'Usage limit exceeded'
      });
      expect(statusService.isAvailable('test-provider')).toBe(false);
    });
  });

  describe('markUsageLimit', () => {
    it('should mark provider as unavailable', async () => {
      const status = await statusService.markUsageLimit('test-provider', {
        message: 'Usage limit exceeded',
        waitTime: '1 hour'
      });

      expect(status.available).toBe(false);
      expect(status.reason).toBe('usage-limit');
      expect(status.message).toBe('Usage limit exceeded');
      expect(status.waitTime).toBe('1 hour');
      expect(status.failureCount).toBe(1);
    });

    it('should increment failure count on repeated failures', async () => {
      await statusService.markUsageLimit('test-provider', { message: 'First failure' });
      const status = await statusService.markUsageLimit('test-provider', { message: 'Second failure' });

      expect(status.failureCount).toBe(2);
    });

    it('should set estimated recovery time', async () => {
      const status = await statusService.markUsageLimit('test-provider', {
        message: 'Usage limit exceeded'
      });

      expect(status.estimatedRecovery).toBeTruthy();
      const recoveryTime = new Date(status.estimatedRecovery).getTime();
      const now = Date.now();
      expect(recoveryTime).toBeGreaterThan(now);
    });
  });

  describe('markRateLimited', () => {
    it('should mark provider as rate limited', async () => {
      const status = await statusService.markRateLimited('test-provider');

      expect(status.available).toBe(false);
      expect(status.reason).toBe('rate-limit');
      expect(status.message).toBe('Rate limit exceeded - temporary');
    });
  });

  describe('markAvailable', () => {
    it('should mark provider as available', async () => {
      await statusService.markUsageLimit('test-provider', { message: 'Test' });
      const status = await statusService.markAvailable('test-provider');

      expect(status.available).toBe(true);
      expect(status.reason).toBe('ok');
      expect(status.failureCount).toBe(0);
    });
  });

  describe('getFallbackProvider', () => {
    const mockProviders = {
      'primary-provider': {
        id: 'primary-provider',
        enabled: true,
        fallbackProvider: 'configured-fallback'
      },
      'configured-fallback': {
        id: 'configured-fallback',
        enabled: true
      },
      'fallback-provider-1': {
        id: 'fallback-provider-1',
        enabled: true
      },
      'fallback-provider-2': {
        id: 'fallback-provider-2',
        enabled: true
      },
      'disabled-provider': {
        id: 'disabled-provider',
        enabled: false
      }
    };

    it('should return task-level fallback first', () => {
      const result = statusService.getFallbackProvider(
        'primary-provider',
        mockProviders,
        'fallback-provider-1'
      );

      expect(result).toBeTruthy();
      expect(result.provider.id).toBe('fallback-provider-1');
      expect(result.source).toBe('task');
    });

    it('should return provider-level fallback second', () => {
      const result = statusService.getFallbackProvider(
        'primary-provider',
        mockProviders
      );

      expect(result).toBeTruthy();
      expect(result.provider.id).toBe('configured-fallback');
      expect(result.source).toBe('provider');
    });

    it('should return system fallback if no configured fallback', () => {
      const providersWithoutConfigured = {
        'primary-provider': {
          id: 'primary-provider',
          enabled: true
        },
        'fallback-provider-1': {
          id: 'fallback-provider-1',
          enabled: true
        }
      };

      const result = statusService.getFallbackProvider(
        'primary-provider',
        providersWithoutConfigured
      );

      expect(result).toBeTruthy();
      expect(result.provider.id).toBe('fallback-provider-1');
      expect(result.source).toBe('system');
    });

    it('should skip disabled providers', () => {
      const result = statusService.getFallbackProvider(
        'primary-provider',
        mockProviders,
        'disabled-provider'
      );

      // Should fall through to provider-level fallback
      expect(result.provider.id).toBe('configured-fallback');
    });

    it('should skip unavailable providers', async () => {
      await statusService.markUsageLimit('configured-fallback', { message: 'Limit hit' });

      const result = statusService.getFallbackProvider(
        'primary-provider',
        mockProviders
      );

      // Should fall through to system fallback
      expect(result.provider.id).toBe('fallback-provider-1');
      expect(result.source).toBe('system');
    });

    it('should return null if no fallback available', async () => {
      await statusService.markUsageLimit('configured-fallback', { message: 'Limit hit' });
      await statusService.markUsageLimit('fallback-provider-1', { message: 'Limit hit' });
      await statusService.markUsageLimit('fallback-provider-2', { message: 'Limit hit' });

      const result = statusService.getFallbackProvider(
        'primary-provider',
        mockProviders
      );

      expect(result).toBeNull();
    });
  });

  describe('getTimeUntilRecovery', () => {
    it('should return null for available provider', () => {
      const time = statusService.getTimeUntilRecovery('test-provider');
      expect(time).toBeNull();
    });

    it('should return human-readable time for unavailable provider', async () => {
      await statusService.markUsageLimit('test-provider', {
        message: 'Limit hit',
        waitTime: '2 hours'
      });

      const time = statusService.getTimeUntilRecovery('test-provider');
      expect(time).toBeTruthy();
      // Should contain time units
      expect(time).toMatch(/\d+(d|h|m|< 1m|any moment)/);
    });
  });

  describe('parseWaitTime', () => {
    it('should parse days, hours, minutes', () => {
      const ms = statusService.parseWaitTime('1 day 2 hours 30 minutes');
      expect(ms).toBe(
        1 * 24 * 60 * 60 * 1000 + // 1 day
        2 * 60 * 60 * 1000 +      // 2 hours
        30 * 60 * 1000            // 30 minutes
      );
    });

    it('should parse hours only', () => {
      const ms = statusService.parseWaitTime('3 hours');
      expect(ms).toBe(3 * 60 * 60 * 1000);
    });

    it('should parse minutes only', () => {
      const ms = statusService.parseWaitTime('45 minutes');
      expect(ms).toBe(45 * 60 * 1000);
    });

    it('should return null for invalid input', () => {
      const ms = statusService.parseWaitTime('no time here');
      expect(ms).toBeNull();
    });

    it('should return null for null input', () => {
      const ms = statusService.parseWaitTime(null);
      expect(ms).toBeNull();
    });
  });

  describe('formatTimeRemaining', () => {
    it('should format days, hours, minutes', () => {
      const ms = 1 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000 + 30 * 60 * 1000;
      const result = statusService.formatTimeRemaining(ms);
      expect(result).toBe('1d 2h 30m');
    });

    it('should format hours and minutes', () => {
      const ms = 2 * 60 * 60 * 1000 + 15 * 60 * 1000;
      const result = statusService.formatTimeRemaining(ms);
      expect(result).toBe('2h 15m');
    });

    it('should return "any moment" for 0 or negative', () => {
      expect(statusService.formatTimeRemaining(0)).toBe('any moment');
      expect(statusService.formatTimeRemaining(-1000)).toBe('any moment');
    });

    it('should return "< 1m" for less than a minute', () => {
      const result = statusService.formatTimeRemaining(30 * 1000);
      expect(result).toBe('< 1m');
    });
  });

  describe('events', () => {
    it('should emit status:changed on markUsageLimit', async () => {
      const handler = vi.fn();
      statusService.events.on('status:changed', handler);

      await statusService.markUsageLimit('test-provider', { message: 'Test' });

      expect(handler).toHaveBeenCalledWith({
        providerId: 'test-provider',
        status: expect.objectContaining({
          available: false,
          reason: 'usage-limit'
        }),
        type: 'usage-limit'
      });
    });

    it('should emit status:changed on markRateLimited', async () => {
      const handler = vi.fn();
      statusService.events.on('status:changed', handler);

      await statusService.markRateLimited('test-provider');

      expect(handler).toHaveBeenCalledWith({
        providerId: 'test-provider',
        status: expect.objectContaining({
          available: false,
          reason: 'rate-limit'
        }),
        type: 'rate-limit'
      });
    });

    it('should emit status:changed on markAvailable', async () => {
      await statusService.markUsageLimit('test-provider', { message: 'Test' });

      const handler = vi.fn();
      statusService.events.on('status:changed', handler);

      await statusService.markAvailable('test-provider');

      expect(handler).toHaveBeenCalledWith({
        providerId: 'test-provider',
        status: expect.objectContaining({
          available: true,
          reason: 'ok'
        }),
        type: 'recovered'
      });
    });
  });

  describe('init', () => {
    it('should clean up expired statuses on init', async () => {
      // Mark provider unavailable with very short wait time
      await statusService.markUsageLimit('test-provider', {
        message: 'Test'
      });

      // Wait for recovery time to pass
      await new Promise(resolve => setTimeout(resolve, 1100));

      // Create new service and init (should clean up expired status)
      const newService = createProviderStatusService({
        dataDir: TEST_DATA_DIR,
        statusFile: 'provider-status.json',
        defaultUsageLimitWait: 1000
      });

      await newService.init();

      // Provider should now be available
      expect(newService.isAvailable('test-provider')).toBe(true);
    });
  });
});

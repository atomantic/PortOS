import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createProviderStatusService, usableFallbackModel } from './providerStatus.js';

// Temp dir, NOT a cwd-rooted one — a fixture dir built from `process.cwd()` lands inside
// the checkout, and the afterEach cleanup only runs when the worker survives the
// file. A killed/timed-out worker left `server/test-data-status/` behind as
// untracked cruft, which was once swept into an unrelated commit (#3823).
let TEST_DATA_DIR;

describe('Provider Status Service', () => {
  let statusService;

  beforeEach(async () => {
    TEST_DATA_DIR = await mkdtemp(join(tmpdir(), 'portos-provider-status-'));

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
    if (TEST_DATA_DIR) await rm(TEST_DATA_DIR, { recursive: true, force: true });
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

  describe('markUsageLimit — bench cap (tight retry, never > reset window)', () => {
    const benchMs = (status) => new Date(status.estimatedRecovery).getTime() - new Date(status.unavailableSince).getTime();

    it('benches the tight default (not the stated 21h) for an over-long reset, and never past the 5h cap', async () => {
      const svc = createProviderStatusService({
        dataDir: TEST_DATA_DIR, statusFile: 'ps-cap.json',
        defaultUsageLimitWait: 10 * 60 * 1000, maxUsageLimitWait: 5 * 60 * 60 * 1000,
      });
      await svc.init();
      const status = await svc.markUsageLimit('p', { message: 'limit', waitTime: '21 hours 52 minutes' });
      // A 21h stated reset must NOT bench 21h — it falls back to the tight 10m default.
      expect(benchMs(status)).toBe(10 * 60 * 1000);
      expect(benchMs(status)).toBeLessThanOrEqual(5 * 60 * 60 * 1000);
      // The stated reset is still surfaced for display.
      expect(status.waitTime).toBe('21 hours 52 minutes');
    });

    it('respects a genuinely short stated reset', async () => {
      const svc = createProviderStatusService({
        dataDir: TEST_DATA_DIR, statusFile: 'ps-cap2.json',
        defaultUsageLimitWait: 10 * 60 * 1000, maxUsageLimitWait: 5 * 60 * 60 * 1000,
      });
      await svc.init();
      const status = await svc.markUsageLimit('p', { message: 'limit', waitTime: '2 minutes' });
      expect(benchMs(status)).toBe(2 * 60 * 1000);
    });

    it('hard-caps even an over-long configured default at maxUsageLimitWait', async () => {
      const svc = createProviderStatusService({
        dataDir: TEST_DATA_DIR, statusFile: 'ps-cap3.json',
        defaultUsageLimitWait: 10 * 60 * 60 * 1000, // 10h default (misconfigured)
        maxUsageLimitWait: 5 * 60 * 60 * 1000,
      });
      await svc.init();
      const status = await svc.markUsageLimit('p', { message: 'limit' });
      expect(benchMs(status)).toBe(5 * 60 * 60 * 1000); // capped to 5h
    });
  });

  describe('markUnavailable (generic)', () => {
    it('marks a provider unavailable with an arbitrary reason and explicit waitTimeMs', async () => {
      const status = await statusService.markUnavailable('test-provider', {
        reason: 'network-error',
        message: 'ECONNREFUSED to upstream',
        waitTimeMs: 120000,
      });

      expect(status.available).toBe(false);
      expect(status.reason).toBe('network-error');
      expect(status.message).toBe('ECONNREFUSED to upstream');
      const recoveryMs = new Date(status.estimatedRecovery).getTime() - Date.now();
      // Cooldown ~= 120s (allow a small jitter for clock drift in CI).
      expect(recoveryMs).toBeGreaterThan(110000);
      expect(recoveryMs).toBeLessThanOrEqual(120000);
    });

    it('uses defaultRateLimitWait when no cooldown is supplied', async () => {
      const status = await statusService.markUnavailable('test-provider', {
        reason: 'unknown',
        message: 'mystery failure',
      });

      const recoveryMs = new Date(status.estimatedRecovery).getTime() - Date.now();
      // Test setup configures defaultRateLimitWait=500ms — within tolerance.
      expect(recoveryMs).toBeGreaterThan(0);
      expect(recoveryMs).toBeLessThanOrEqual(500);
    });

    it('emits status:changed with the reason as the event type', async () => {
      const handler = vi.fn();
      statusService.events.on('status:changed', handler);
      await statusService.markUnavailable('test-provider', {
        reason: 'network-error',
        message: 'down',
        waitTimeMs: 30000,
      });
      expect(handler).toHaveBeenCalledWith({
        providerId: 'test-provider',
        status: expect.objectContaining({ available: false, reason: 'network-error' }),
        type: 'network-error',
      });
    });
  });

  describe('markUsageLimit — single emit with extras', () => {
    it('includes waitTime in the status:changed event payload on the first emit', async () => {
      // Regression: previously markUsageLimit did a second saveStatus after
      // markUnavailable to stamp waitTime, so status:changed fired without
      // the waitTime field — leaving Socket.IO clients with an incomplete
      // usage-limit record until the second write landed.
      const handler = vi.fn();
      statusService.events.on('status:changed', handler);

      await statusService.markUsageLimit('test-provider', {
        message: 'Usage limit exceeded',
        waitTime: '5 hours'
      });

      // Exactly one status:changed for the markUsageLimit call, and it
      // already carries waitTime — no second emit needed.
      const usageLimitCalls = handler.mock.calls.filter(c => c[0].type === 'usage-limit');
      expect(usageLimitCalls).toHaveLength(1);
      expect(usageLimitCalls[0][0].status).toMatchObject({
        available: false,
        reason: 'usage-limit',
        waitTime: '5 hours',
      });
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
        fallbackProvider: 'configured-fallback',
        fallbackModel: 'configured-fallback-model'
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
      // No task-level model passed → null (let the fallback resolve its own).
      expect(result.model).toBeNull();
    });

    it('should carry the task-level fallback model when provided', () => {
      const result = statusService.getFallbackProvider(
        'primary-provider',
        mockProviders,
        'fallback-provider-1',
        'task-chosen-model'
      );

      expect(result.provider.id).toBe('fallback-provider-1');
      expect(result.source).toBe('task');
      expect(result.model).toBe('task-chosen-model');
    });

    it('should return provider-level fallback second, with its configured fallbackModel', () => {
      const result = statusService.getFallbackProvider(
        'primary-provider',
        mockProviders
      );

      expect(result).toBeTruthy();
      expect(result.provider.id).toBe('configured-fallback');
      expect(result.source).toBe('provider');
      // The primary's fallbackModel must ride along — NOT the primary's model.
      expect(result.model).toBe('configured-fallback-model');
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
      // System-priority picks have no configured model — the fallback resolves
      // its own default rather than inheriting the primary's model.
      expect(result.model).toBeNull();
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

    it('should NOT loop back to the same provider when fallbackProvider points at self (misconfig guard)', () => {
      const selfFallback = {
        'self-pointer': { id: 'self-pointer', enabled: true, fallbackProvider: 'self-pointer' },
        'fallback-provider-1': { id: 'fallback-provider-1', enabled: true },
      };

      const result = statusService.getFallbackProvider('self-pointer', selfFallback);

      // Must fall through to the system priority list (which excludes the
      // primary by id) rather than returning self.
      expect(result?.provider.id).toBe('fallback-provider-1');
      expect(result?.source).toBe('system');
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

  describe('getFallbackProvider — host prerequisite gate', () => {
    const providers = {
      'primary-provider': { id: 'primary-provider', enabled: true, fallbackProvider: 'configured-fallback' },
      'configured-fallback': { id: 'configured-fallback', enabled: true },
      'fallback-provider-1': { id: 'fallback-provider-1', enabled: true },
      'fallback-provider-2': { id: 'fallback-provider-2', enabled: true },
    };

    const withGate = async (prerequisitesMet) => {
      const svc = createProviderStatusService({
        dataDir: TEST_DATA_DIR,
        statusFile: 'gated-status.json',
        defaultFallbackPriority: ['fallback-provider-1', 'fallback-provider-2'],
        prerequisitesMet,
      });
      await svc.init();
      return svc;
    };

    it('skips a CONFIGURED fallback whose prerequisites are unmet', async () => {
      const svc = await withGate((provider) => provider.id !== 'configured-fallback');

      const result = svc.getFallbackProvider('primary-provider', providers);

      expect(result.provider.id).toBe('fallback-provider-1');
      expect(result.source).toBe('system');
    });

    it('skips a TASK-level fallback whose prerequisites are unmet', async () => {
      const svc = await withGate((provider) => provider.id !== 'fallback-provider-2');

      const result = svc.getFallbackProvider('primary-provider', providers, 'fallback-provider-2');

      expect(result.provider.id).toBe('configured-fallback');
      expect(result.source).toBe('provider');
    });

    it('skips SYSTEM-priority candidates whose prerequisites are unmet', async () => {
      const svc = await withGate((provider) => provider.id === 'fallback-provider-2');

      const result = svc.getFallbackProvider('primary-provider', providers);

      expect(result.provider.id).toBe('fallback-provider-2');
      expect(result.source).toBe('system');
    });

    it('returns null when every candidate fails the gate', async () => {
      const svc = await withGate(() => false);

      expect(svc.getFallbackProvider('primary-provider', providers)).toBeNull();
    });

    it('passes the whole provider collection so an inherited-key check can see siblings', async () => {
      const seen = [];
      const svc = await withGate((provider, all) => { seen.push([provider.id, all]); return true; });

      svc.getFallbackProvider('primary-provider', providers);

      expect(seen[0][0]).toBe('configured-fallback');
      expect(seen[0][1]).toBe(providers);
    });

    it('routes exactly as before when the gate is absent or answers non-boolean', async () => {
      const noGate = await withGate(null);
      expect(noGate.getFallbackProvider('primary-provider', providers).provider.id).toBe('configured-fallback');

      // Only an explicit `false` may exclude a provider — "unknown" must never
      // empty the chain (see the sentinel discipline in providerPrerequisites).
      const vague = await withGate(() => undefined);
      expect(vague.getFallbackProvider('primary-provider', providers).provider.id).toBe('configured-fallback');
    });

    it('treats a THROWING gate as "yes" rather than emptying the chain', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const svc = await withGate(() => { throw new Error('probe exploded'); });

      expect(svc.getFallbackProvider('primary-provider', providers).provider.id).toBe('configured-fallback');
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });
  });

  describe('getFallbackProvider — stale model pins', () => {
    // A `fallbackModel` is set on the PRIMARY but resolved against the
    // fallback, so a model bump on the fallback leaves the pin naming an id
    // that provider no longer serves. Spending that pin sends the cascade's
    // last retry at a model that isn't there.
    const providersWithModels = (fallbackModel) => ({
      'primary-provider': {
        id: 'primary-provider',
        enabled: true,
        fallbackProvider: 'configured-fallback',
        fallbackModel,
      },
      'configured-fallback': {
        id: 'configured-fallback',
        enabled: true,
        models: ['claude-sonnet-5', 'claude-opus-5'],
      },
    });

    it('drops a pin the fallback provider no longer lists', () => {
      const result = statusService.getFallbackProvider(
        'primary-provider',
        providersWithModels('claude-opus-4-8')
      );

      expect(result.provider.id).toBe('configured-fallback');
      // null ⇒ "let the fallback resolve its own default" — strictly better
      // than baking a known-absent id into the spawned --model flag.
      expect(result.model).toBeNull();
    });

    it('keeps a pin the fallback provider still lists', () => {
      const result = statusService.getFallbackProvider(
        'primary-provider',
        providersWithModels('claude-opus-5')
      );

      expect(result.model).toBe('claude-opus-5');
    });

    it('drops a stale task-level pin too', () => {
      const providers = {
        'primary-provider': { id: 'primary-provider', enabled: true },
        'task-fallback': {
          id: 'task-fallback',
          enabled: true,
          models: ['claude-opus-5'],
        },
      };

      const result = statusService.getFallbackProvider(
        'primary-provider',
        providers,
        'task-fallback',
        'claude-opus-4-8'
      );

      expect(result.source).toBe('task');
      expect(result.model).toBeNull();
    });
  });

  describe('usableFallbackModel', () => {
    it('returns null for an empty pin', () => {
      expect(usableFallbackModel({ id: 'p', models: ['a'] }, null)).toBeNull();
      expect(usableFallbackModel({ id: 'p', models: ['a'] }, '')).toBeNull();
    });

    it('passes the pin through when the provider lists no models', () => {
      // Local backends discover their models at runtime, and the UI offers a
      // free-text pin when there is no list — nothing to validate against.
      expect(usableFallbackModel({ id: 'ollama', models: [] }, 'llama3')).toBe('llama3');
      expect(usableFallbackModel({ id: 'ollama' }, 'llama3')).toBe('llama3');
    });

    it('passes a listed pin through', () => {
      expect(usableFallbackModel({ id: 'p', models: ['a', 'b'] }, 'b')).toBe('b');
    });

    it('drops an unlisted pin', () => {
      expect(usableFallbackModel({ id: 'p', models: ['a', 'b'] }, 'c')).toBeNull();
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

  describe('stale recovery on read', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('getStatus returns available:false while estimatedRecovery is in the future', async () => {
      const now = Date.now();
      vi.setSystemTime(now);
      // defaultUsageLimitWait is 1000ms in our test setup — recovery 60s out
      // means the 1000ms window is irrelevant; we control estimatedRecovery
      // directly via fake timers.
      await statusService.markUsageLimit('prov-a', { message: 'limit hit' });
      // markUsageLimit uses Date.now() internally — with fake timers it lands
      // exactly at `now`. The service sets estimatedRecovery = now + 1000ms.
      // We are still AT `now`, so recovery is 1000ms in the future.
      const status = statusService.getStatus('prov-a');
      expect(status.available).toBe(false);
    });

    it('getStatus and getAllStatuses both flip to available:true after recovery deadline', async () => {
      const now = Date.now();
      vi.setSystemTime(now);
      await statusService.markUsageLimit('prov-b', { message: 'limit hit' });
      // Advance past the 1000ms defaultUsageLimitWait used in test setup
      vi.setSystemTime(now + 1001);
      const single = statusService.getStatus('prov-b');
      expect(single.available).toBe(true);
      const all = statusService.getAllStatuses();
      expect(all.providers['prov-b'].available).toBe(true);
    });

    it('isAvailable returns true after the recovery deadline lapses', async () => {
      const now = Date.now();
      vi.setSystemTime(now);
      await statusService.markUsageLimit('prov-c', { message: 'limit hit' });
      // Still unavailable right now
      expect(statusService.isAvailable('prov-c')).toBe(false);
      // Advance time past deadline
      vi.setSystemTime(now + 1001);
      expect(statusService.isAvailable('prov-c')).toBe(true);
    });
  });
});

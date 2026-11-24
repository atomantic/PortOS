import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { scheduleModuleWarmup } from './moduleWarmup.js';
import { SMOKE_BOOT_ENV } from './runtimeEnv.js';

afterEach(() => vi.unstubAllEnvs());

it.each([
  { smoke: '1', nodeEnv: 'production', vitest: undefined },
  { smoke: undefined, nodeEnv: 'production', vitest: 'true' },
  { smoke: undefined, nodeEnv: 'test', vitest: undefined },
])('skips warmup in smoke boots and test runners (%o)', ({ smoke, nodeEnv, vitest }) => {
  vi.stubEnv(SMOKE_BOOT_ENV, smoke);
  vi.stubEnv('NODE_ENV', nodeEnv);
  vi.stubEnv('VITEST', vitest);
  const server = new EventEmitter();
  const warm = vi.fn();

  scheduleModuleWarmup(server, warm);

  expect(server.listenerCount('listening')).toBe(0);
  expect(warm).not.toHaveBeenCalled();
});

it('starts warmup once when the server starts listening', () => {
  vi.stubEnv(SMOKE_BOOT_ENV, undefined);
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('VITEST', undefined);
  const server = new EventEmitter();
  const warm = vi.fn().mockResolvedValue(undefined);

  scheduleModuleWarmup(server, warm);

  expect(warm).not.toHaveBeenCalled();
  server.emit('listening');
  server.emit('listening');
  expect(warm).toHaveBeenCalledOnce();
});

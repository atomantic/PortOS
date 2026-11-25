// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const getShellBootstrap = vi.fn();

beforeEach(() => {
  vi.resetModules();
  getShellBootstrap.mockReset();
});

it('shares settings for simultaneous readers and uses live reads after startup', async () => {
  getShellBootstrap.mockResolvedValue({ settings: { theme: 'classic-midnight', timezone: 'UTC' } });
  const { startShellBootstrap, readShellBootstrap } = await import('./shellBootstrap.js');
  const live = vi.fn(() => Promise.resolve({ timezone: 'Europe/Oslo' }));

  startShellBootstrap(getShellBootstrap);
  startShellBootstrap(getShellBootstrap);
  const [theme, timezone] = await Promise.all([readShellBootstrap('settings', live), readShellBootstrap('settings', live)]);
  expect(theme.theme).toBe('classic-midnight');
  expect(timezone.timezone).toBe('UTC');
  expect(getShellBootstrap).toHaveBeenCalledTimes(1);
  expect(live).not.toHaveBeenCalled();
  await expect(readShellBootstrap('settings', live)).resolves.toEqual({ timezone: 'Europe/Oslo' });
});

it('uses the individual read only for a missing slice', async () => {
  getShellBootstrap.mockResolvedValue({ maintenance: { state: 'normal' } });
  const { startShellBootstrap, readShellBootstrap } = await import('./shellBootstrap.js');
  const live = vi.fn(() => Promise.resolve({ enabled: false, revision: 'unprotected' }));

  startShellBootstrap(getShellBootstrap);
  await expect(readShellBootstrap('passwordRisk', live)).resolves.toEqual({ enabled: false, revision: 'unprotected' });
  await expect(readShellBootstrap('maintenance', live)).resolves.toEqual({ state: 'normal' });
  expect(live).toHaveBeenCalledTimes(1);
});

it('defers to the login redirect when bootstrap authentication is required', async () => {
  const error = Object.assign(new Error('Authentication required'), { code: 'AUTH_REQUIRED' });
  getShellBootstrap.mockRejectedValue(error);
  const { startShellBootstrap, readShellBootstrap } = await import('./shellBootstrap.js');
  const live = vi.fn();

  startShellBootstrap(getShellBootstrap);
  await expect(readShellBootstrap('passwordRisk', live)).rejects.toBe(error);
  expect(live).not.toHaveBeenCalled();
});

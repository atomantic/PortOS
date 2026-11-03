import { afterEach, expect, it, vi } from 'vitest';
import { settleAdmissionEventually } from './maintenanceSettlementRetry.js';

afterEach(() => vi.useRealTimers());

it('retries a completed operation whose journal settlement temporarily fails', async () => {
  vi.useFakeTimers();
  const permit = { finish: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true) };
  await expect(settleAdmissionEventually(permit, 'Test')).resolves.toBe(false);
  await vi.advanceTimersByTimeAsync(30000);
  expect(permit.finish).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60000);
  expect(permit.finish).toHaveBeenCalledTimes(2);
});

it('stops retrying once a permit was retired or superseded', async () => {
  vi.useFakeTimers();
  const permit = { finish: vi.fn().mockResolvedValue(false), isCurrent: vi.fn().mockReturnValue(false) };
  await expect(settleAdmissionEventually(permit, 'Test')).resolves.toBe(true);
  await vi.advanceTimersByTimeAsync(60000);
  expect(permit.finish).toHaveBeenCalledOnce();
});

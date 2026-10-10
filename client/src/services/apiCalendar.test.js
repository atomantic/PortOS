import { describe, expect, it, vi } from 'vitest';
import { runGoogleAutoConfig } from './apiCalendar';
import { request } from './apiCore';
vi.mock('./apiCore', () => ({ request: vi.fn().mockResolvedValue({ status: 'success' }) }));

describe('Google automation request payload', () => {
  it('sends correlation in the body while preserving request options and legacy payloads', async () => {
    await runGoogleAutoConfig('example@example.com', { requestId: 'invented-run-1', silent: true });
    expect(request).toHaveBeenLastCalledWith('/calendar/google/auto-configure/run', {
      method: 'POST', body: JSON.stringify({ email: 'example@example.com', requestId: 'invented-run-1' }), silent: true,
    });
    await runGoogleAutoConfig('example@example.com');
    expect(request).toHaveBeenLastCalledWith('/calendar/google/auto-configure/run', {
      method: 'POST', body: JSON.stringify({ email: 'example@example.com' }),
    });
  });
});

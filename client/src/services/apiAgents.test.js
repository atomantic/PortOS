import { afterEach, expect, it, vi } from 'vitest';
import { startMaintenanceRun } from './apiAgents';

// Exercise the real API wrapper through HTTP serialization: mocking the wrapper
// in the form test cannot catch a selected mode being dropped before POST.
afterEach(() => vi.unstubAllGlobals());
it.each([
  { mode: 'fix', claimBetweenAudits: true, claimHandler: { providerId: 'claude', model: 'sonnet', effort: 'low' } },
  { mode: 'file-issues', claimBetweenAudits: false },
])('sends maintenance choices to the server: %j', async choices => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ run: { id: 'example' } }) });
  vi.stubGlobal('fetch', fetchMock);
  await startMaintenanceRun({ appId: 'example', providerId: 'codex', model: 'example-model', ...choices });
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toContain('/cos/schedule/maintenance-runs');
  expect(options.method).toBe('POST');
  expect(JSON.parse(options.body)).toEqual({ appId: 'example', providerId: 'codex', model: 'example-model', effort: null, ...choices });
});

import { afterEach, expect, it, vi } from 'vitest';
import { startMaintenanceRun, getCosAgentDates, hydrateCosAgentDescription, triggerCosJob } from './apiAgents';

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

// Listing responses bound `metadata.taskDescription` (server/lib/cosAgentListProjection.js).
// Anything that REUSES that text — Resume, Relaunch — has to get the whole thing.
const okJson = (body) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body });

it('hydrates a clipped description from the agent record, clearing the flag', async () => {
  const fetchMock = okJson({ id: 'agent-1', metadata: { taskDescription: 'the whole thing' } });
  vi.stubGlobal('fetch', fetchMock);

  const hydrated = await hydrateCosAgentDescription({
    id: 'agent-1',
    metadata: { taskDescription: 'the whol', taskDescriptionTruncated: true, model: 'opus' },
  });

  // `lines=1`: the default hydrates a 1000-line transcript tail this read has no
  // use for, which would cost more than the description it came for.
  expect(fetchMock.mock.calls[0][0]).toContain('/cos/agents/agent-1?lines=1');
  expect(hydrated.metadata.taskDescription).toBe('the whole thing');
  expect(hydrated.metadata.taskDescriptionTruncated).toBe(false);
  expect(hydrated.metadata.model).toBe('opus');
});

it('never fetches for a description the listing carried whole', async () => {
  const fetchMock = okJson({});
  vi.stubGlobal('fetch', fetchMock);

  const agent = { id: 'agent-1', metadata: { taskDescription: 'short' } };
  expect(await hydrateCosAgentDescription(agent)).toBe(agent);
  expect(fetchMock).not.toHaveBeenCalled();
});

// A blip must not block the action — the caller gets the preview it already had
// rather than an exception in a click handler.
it('falls back to the clipped record when the hydration read fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

  const agent = { id: 'agent-1', metadata: { taskDescription: 'preview', taskDescriptionTruncated: true } };
  expect(await hydrateCosAgentDescription(agent)).toBe(agent);
});

it('asks for the newest bucket alongside the bucket list when hydrating', async () => {
  const fetchMock = okJson({ dates: [], latest: null });
  vi.stubGlobal('fetch', fetchMock);

  await getCosAgentDates({ hydrate: true });
  expect(fetchMock.mock.calls[0][0]).toContain('/cos/agents/history?hydrate=1');

  await getCosAgentDates();
  expect(fetchMock.mock.calls[1][0]).not.toContain('hydrate');
});

// The one place a card's ad-hoc values become a request body. Every component
// suite mocks this module, so a regression that let `formValues` fall through
// into the fetch init instead of the body would leave all of those green while
// no run was ever actually re-aimed.
it('puts a one-off run configuration in the trigger body, and sends none without one', async () => {
  const fetchMock = okJson({ success: true });
  vi.stubGlobal('fetch', fetchMock);

  await triggerCosJob('job-1', { formValues: { subject: 'x' } });
  const [url, withValues] = fetchMock.mock.calls[0];
  expect(url).toContain('/cos/jobs/job-1/trigger');
  expect(withValues.method).toBe('POST');
  expect(JSON.parse(withValues.body)).toEqual({ formValues: { subject: 'x' } });

  await triggerCosJob('job-1', { silent: true });
  const [, asSaved] = fetchMock.mock.calls[1];
  expect(asSaved.body).toBeUndefined();
});

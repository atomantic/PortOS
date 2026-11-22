import { describe, it, expect, vi, beforeEach } from 'vitest';

let disk = null;
vi.mock('../../lib/fileUtils.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readJSONFile: vi.fn(async (_file, fallback) => (disk ? structuredClone(disk) : fallback)),
  atomicWrite: vi.fn(async (_file, data) => { disk = structuredClone(data); }),
  ensureDir: vi.fn(async () => {}),
}));
const addNotification = vi.fn().mockResolvedValue({});
vi.mock('../notifications.js', () => ({
  addNotification: (...a) => addNotification(...a),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { MEDIUM: 'medium' },
}));
vi.mock('../cos/cosEvents.js', () => ({ cosEvents: { emit: vi.fn() } }));

const { recordJobFailureIncident, resolveJobIncidents, acknowledgeJobIncident, listJobIncidents } = await import('./incidents.js');

const HOUR = 3_600_000;
const t0 = Date.parse('2026-11-22T00:00:00Z');

beforeEach(() => {
  disk = null;
  addNotification.mockClear();
});

describe('autonomous job incident ledger', () => {
  it('notifies once for a repeating failure, reminds after the cooldown, and persists the count', async () => {
    await recordJobFailureIncident('job-a', 'boom after 3s', { job: { name: 'Briefing' }, now: t0 });
    await recordJobFailureIncident('job-a', 'boom after 8s', { now: t0 + HOUR });
    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification.mock.calls[0][0].title).toContain('Briefing');

    await recordJobFailureIncident('job-a', 'boom after 1s', { now: t0 + 7 * HOUR });
    expect(addNotification).toHaveBeenCalledTimes(2);

    const [incident] = await listJobIncidents();
    expect(incident).toMatchObject({ jobId: 'job-a', occurrenceCount: 3, state: 'alerted' });
  });

  it('a new signature alerts immediately and a green run resolves the open incidents', async () => {
    await recordJobFailureIncident('job-a', 'first problem', { now: t0 });
    await recordJobFailureIncident('job-a', 'second problem', { now: t0 + 1 });
    expect(addNotification).toHaveBeenCalledTimes(2);

    const resolved = await resolveJobIncidents('job-a', t0 + 2);
    expect(resolved).toHaveLength(2);
    expect(await listJobIncidents({ openOnly: true })).toEqual([]);
  });

  it('acknowledge keeps the incident open but silent, and stores only a redacted excerpt', async () => {
    const { incident } = await recordJobFailureIncident('job-a', `auth failed ghp_${'b'.repeat(30)}`, { now: t0 });
    expect(incident.sampleError).toContain('[REDACTED]');
    expect(JSON.stringify(disk)).not.toContain('bbbbbbbbbb');

    const acked = await acknowledgeJobIncident(incident.id, t0 + 1);
    expect(acked.state).toBe('acknowledged');
    await recordJobFailureIncident('job-a', `auth failed ghp_${'c'.repeat(30)}`, { now: t0 + 20 * HOUR });
    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(await acknowledgeJobIncident('missing')).toBeNull();
  });

  it('a notification failure never fails the recording', async () => {
    addNotification.mockRejectedValueOnce(new Error('disk full'));
    const result = await recordJobFailureIncident('job-a', 'boom', { now: t0 });
    expect(result.alerted).toBe(true);
    expect(await listJobIncidents()).toHaveLength(1);
  });
});

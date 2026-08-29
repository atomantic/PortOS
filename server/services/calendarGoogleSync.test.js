import { describe, it, expect, vi, beforeEach } from 'vitest';

// The CLI exit-status contract (#5302): runCliProviderPrompt hands back stdout
// even when the child exited non-zero, flagged `partial`. These tests pin the
// service boundary's obligation NOT to let a possibly-truncated payload drive a
// destructive prune — the failure mode is silently deleting real calendar
// events from the local cache and then recording the sync as a success.
vi.mock('../lib/cliProviderRun.js', () => ({
  pickCliProvider: vi.fn(() => ({ provider: { id: 'claude-code', type: 'cli', command: 'claude' }, model: null })),
  runCliProviderPrompt: vi.fn(),
}));

vi.mock('./calendarAccounts.js', () => ({
  getAccount: vi.fn(),
  updateSyncStatus: vi.fn(async () => ({})),
  updateSubcalendars: vi.fn(async () => ({})),
  mergeDiscoveredSubcalendars: vi.fn((existing, discovered) => discovered),
}));

vi.mock('./calendarSync.js', () => ({
  loadCache: vi.fn(),
  saveCache: vi.fn(async () => {}),
  logCalendarTouchpoints: vi.fn(async () => {}),
  recordCalendarActivity: vi.fn(async () => {}),
}));

vi.mock('./providers.js', () => ({ getAllProviders: vi.fn(async () => ({ providers: {} })) }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

import { mcpSyncAccount, mcpDiscoverCalendars } from './calendarGoogleSync.js';
import { runCliProviderPrompt } from '../lib/cliProviderRun.js';
import { getAccount, updateSyncStatus, updateSubcalendars } from './calendarAccounts.js';
import { loadCache, saveCache } from './calendarSync.js';

const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const CAL_ID = 'work@example.com';

const account = () => ({
  id: ACCOUNT_ID,
  name: 'Example Account',
  type: 'google-calendar',
  subcalendars: [{ calendarId: CAL_ID, name: 'Work', enabled: true, dormant: false }],
});

// One event already cached that the (truncated) response will NOT mention —
// the exact record a prune would destroy.
const cachedEvents = () => [
  {
    id: 'cached-1',
    externalId: 'gcal-deadbeef0001',
    apiId: 'upstream-1',
    title: 'Standing 1:1',
    subcalendarId: CAL_ID,
  },
];

const rawEvent = (id, summary) => ({
  id,
  summary,
  start: { dateTime: '2026-03-02T10:00:00Z' },
  end: { dateTime: '2026-03-02T11:00:00Z' },
});

const savedCache = () => saveCache.mock.calls.at(-1)[1];

describe('mcpSyncAccount CLI exit-status agreement (#5302)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue(account());
    loadCache.mockResolvedValue({ events: cachedEvents() });
  });

  it('prunes cache-only events on a clean exit 0 and records success', async () => {
    runCliProviderPrompt.mockResolvedValue({
      text: JSON.stringify({ calendars: [{ calendarId: CAL_ID, calendarName: 'Work', events: [rawEvent('upstream-2', 'Design review')] }] }),
      exitCode: 0,
      partial: false,
      stderrTail: '',
    });

    const result = await mcpSyncAccount(ACCOUNT_ID, null);

    expect(result.status).toBe('success');
    expect(result.pruned).toBe(1);
    expect(updateSyncStatus).toHaveBeenCalledWith(ACCOUNT_ID, 'success');
    // The stale cached event is gone; only the incoming one survives.
    expect(savedCache().events.map((e) => e.title)).toEqual(['Design review']);
  });

  it('upserts but NEVER prunes when the CLI exited non-zero with usable stdout', async () => {
    runCliProviderPrompt.mockResolvedValue({
      text: JSON.stringify({ calendars: [{ calendarId: CAL_ID, calendarName: 'Work', events: [rawEvent('upstream-2', 'Design review')] }] }),
      exitCode: 1,
      partial: true,
      stderrTail: 'rate limit reached, stream aborted',
    });

    const result = await mcpSyncAccount(ACCOUNT_ID, null);

    expect(result.status).toBe('partial');
    expect(result.newEvents).toBe(1);
    expect(result.pruned).toBe(0);
    expect(result.reason).toContain('rate limit reached');
    expect(updateSyncStatus).toHaveBeenCalledWith(ACCOUNT_ID, 'partial');
    // Both the pre-existing event and the newly-seen one remain — a truncated
    // payload must never read as "these events were deleted upstream".
    expect(savedCache().events.map((e) => e.title).sort()).toEqual(['Design review', 'Standing 1:1']);
  });

  it('surfaces the partial status over the socket so the UI can warn', async () => {
    runCliProviderPrompt.mockResolvedValue({
      text: JSON.stringify({ calendars: [{ calendarId: CAL_ID, calendarName: 'Work', events: [] }] }),
      exitCode: 143,
      partial: true,
      stderrTail: 'killed mid-stream',
    });
    const io = { emit: vi.fn() };

    await mcpSyncAccount(ACCOUNT_ID, io);

    expect(io.emit).toHaveBeenCalledWith(
      'calendar:sync:completed',
      expect.objectContaining({ accountId: ACCOUNT_ID, status: 'partial', reason: 'killed mid-stream' }),
    );
  });

  it('carries the stderr tail into the parse failure instead of a bare message', async () => {
    runCliProviderPrompt.mockResolvedValue({
      text: 'I could not reach the calendar API.',
      exitCode: 1,
      partial: true,
      stderrTail: 'MCP server not connected',
    });

    await expect(mcpSyncAccount(ACCOUNT_ID, null)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('MCP server not connected'),
    });
    expect(saveCache).not.toHaveBeenCalled();
    expect(updateSyncStatus).toHaveBeenCalledWith(ACCOUNT_ID, 'error');
  });
});

describe('mcpDiscoverCalendars CLI exit-status agreement (#5302)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue(account());
  });

  it('merges the discovered list on a clean exit 0', async () => {
    runCliProviderPrompt.mockResolvedValue({
      text: JSON.stringify([{ id: CAL_ID, name: 'Work', color: '#123456' }]),
      exitCode: 0,
      partial: false,
      stderrTail: '',
    });

    const result = await mcpDiscoverCalendars(ACCOUNT_ID, null);

    expect(result.status).toBe('success');
    expect(updateSubcalendars).toHaveBeenCalled();
  });

  it('refuses to merge a partial list — a truncated array would drop calendars', async () => {
    runCliProviderPrompt.mockResolvedValue({
      // Well-formed enough to parse, but the process died: the array may be short.
      text: JSON.stringify([{ id: CAL_ID, name: 'Work' }]),
      exitCode: 1,
      partial: true,
      stderrTail: 'context window exceeded',
    });

    await expect(mcpDiscoverCalendars(ACCOUNT_ID, null)).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining('context window exceeded'),
    });
    expect(updateSubcalendars).not.toHaveBeenCalled();
  });
});

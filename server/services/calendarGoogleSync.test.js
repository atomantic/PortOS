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
  mutateCache: vi.fn(async (id, mutate) => {
    const cache = await loadCache(id);
    const result = await mutate(cache, await getAccount(id));
    await saveCache(id, cache);
    return result;
  }),
  logCalendarTouchpoints: vi.fn(async () => {}),
  recordCalendarActivity: vi.fn(async () => {}),
}));

vi.mock('./providers.js', () => ({ getAllProviders: vi.fn(async () => ({ providers: {} })) }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

import { mcpSyncAccount, mcpDiscoverCalendars, pushSyncEvents } from './calendarGoogleSync.js';
import { runCliProviderPrompt } from '../lib/cliProviderRun.js';
import { getAccount, updateSyncStatus, updateSubcalendars } from './calendarAccounts.js';
import { loadCache, saveCache, logCalendarTouchpoints } from './calendarSync.js';

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

// The completion contract (#10869): a zero-exit reply only licenses a prune for a
// calendar that echoes the requested window, carries `complete: true` and has no
// remaining page token. The window is read back out of the prompt the service
// actually sent, so these fixtures cannot drift from what it asked for.
const windowFromPrompt = (prompt) => {
  const [, timeMin, timeMax] = prompt.match(/date range (\d{4}-[\w:.-]+Z) to (\d{4}-[\w:.-]+Z)/);
  return { timeMin, timeMax };
};
// `undefined` overrides drop a field from the JSON, simulating a legacy envelope.
const completeCalendar = (prompt, cal) => ({ calendarName: 'Work', complete: true, nextPageToken: null, ...windowFromPrompt(prompt), ...cal });
const cliReply = (calendars, cli = {}) => async ({ prompt }) => ({
  text: JSON.stringify({ calendars: calendars.map((cal) => completeCalendar(prompt, cal)) }),
  exitCode: 0, partial: false, stderrTail: '', ...cli,
});

describe('mcpSyncAccount CLI exit-status agreement (#5302)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue(account());
    loadCache.mockResolvedValue({ events: cachedEvents() });
  });

  it('prunes cache-only events on a clean exit 0 and records success', async () => {
    runCliProviderPrompt.mockImplementation(cliReply([{ calendarId: CAL_ID, events: [rawEvent('upstream-2', 'Design review')] }]));

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

// #9926: exercise extraction at the service boundary before any destructive write.
describe('MCP transcript extraction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue(account());
    loadCache.mockResolvedValue({ events: cachedEvents() });
  });

  it('skips metadata and every echoed prompt, preserving fenced event string content', async () => {
    const event = rawEvent('new-event', 'Review [draft] {v2}');
    event.description = 'Keep ```json {"example":[]} ``` in the notes.';
    runCliProviderPrompt.mockImplementation(async ({ prompt }) => ({
      text: `${prompt}\nMetadata: {"request":"complete"}\n${prompt}\nActual: \`\`\`json\n${JSON.stringify({ calendars: [completeCalendar(prompt, { calendarId: CAL_ID, events: [event] })] })}\n\`\`\``,
      exitCode: 0, partial: false,
    }));

    const result = await mcpSyncAccount(ACCOUNT_ID, null);

    expect(result.status).toBe('success');
    expect(savedCache().events).toEqual([expect.objectContaining({ title: event.summary, description: event.description })]);
  });

  it('accepts an empty event snapshot and an empty calendar response', async () => {
    runCliProviderPrompt.mockImplementation(cliReply([{ calendarId: CAL_ID, events: [] }]));
    expect((await mcpSyncAccount(ACCOUNT_ID, null)).pruned).toBe(1);
    expect(savedCache().events).toEqual([]);
    saveCache.mockClear();
    runCliProviderPrompt.mockResolvedValue({ text: '{"calendars":[]}', exitCode: 0 });
    // Nothing was described, so nothing was reconciled: not a success.
    expect(await mcpSyncAccount(ACCOUNT_ID, null)).toMatchObject({ calendars: [], status: 'partial' });
    expect(saveCache).not.toHaveBeenCalled();
  });

  it.each(['{"calendars":{}}', '{"calendars":[{"calendarId":"example","events":[null]}]}', 'not JSON', 'prompt only'])('rejects invalid sync payload %s before touching events', async text => {
    runCliProviderPrompt.mockImplementation(async ({ prompt }) => ({ text: text === 'prompt only' ? `${prompt}\n${prompt}` : text, exitCode: 0 }));
    await expect(mcpSyncAccount(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 502 });
    expect(saveCache).not.toHaveBeenCalled();
    expect(updateSyncStatus).toHaveBeenCalledWith(ACCOUNT_ID, 'error');
  });

  it('skips discovery banners and repeated schema echoes before merging the actual list', async () => {
    const discovered = [{ id: CAL_ID, name: 'Work [draft] {v2}', color: '#123456' }];
    runCliProviderPrompt.mockImplementation(async ({ prompt }) => ({
      text: `${prompt}\n[workdir, example]\n${prompt}\n\`\`\`json\n${JSON.stringify(discovered)}\n\`\`\``, exitCode: 0,
    }));
    expect((await mcpDiscoverCalendars(ACCOUNT_ID, null)).calendars).toEqual(discovered);
    expect(updateSubcalendars).toHaveBeenCalledWith(ACCOUNT_ID, discovered);
  });

  it('preserves a valid empty discovered list', async () => {
    runCliProviderPrompt.mockResolvedValue({ text: '```json\n[]\n```', exitCode: 0 });
    expect((await mcpDiscoverCalendars(ACCOUNT_ID, null)).calendars).toEqual([]);
    expect(updateSubcalendars).toHaveBeenCalledWith(ACCOUNT_ID, []);
  });

  it.each(['[{"name":"Missing identity"}]', '["not a calendar"]', 'not JSON', 'prompt only'])('refuses invalid discovery %s without replacing subcalendars', async text => {
    runCliProviderPrompt.mockImplementation(async ({ prompt }) => ({ text: text === 'prompt only' ? `${prompt}\n${prompt}` : text, exitCode: 0 }));
    await expect(mcpDiscoverCalendars(ACCOUNT_ID, null)).rejects.toMatchObject({ status: 502 });
    expect(updateSubcalendars).not.toHaveBeenCalled();
  });
});

// #10869: a zero CLI exit proves the process finished, not that the source
// handed over every page. These pin the per-calendar completion contract at the
// service boundary, where a wrong answer silently deletes real cached events and
// reports the sync as a success.
describe('Google MCP page completeness (#10869)', () => {
  const OLD_ROOM = 'https://meet.example.com/old-room';
  const TWO_CALENDARS = 'team@example.com';

  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue(account());
    loadCache.mockResolvedValue({ events: cachedEvents() });
  });

  it('asks the model to drain every page and echo the window and completion state', async () => {
    runCliProviderPrompt.mockImplementation(cliReply([{ calendarId: CAL_ID, events: [] }]));
    await mcpSyncAccount(ACCOUNT_ID, null);
    const { prompt } = runCliProviderPrompt.mock.calls.at(-1)[0];
    expect(prompt).toMatch(/maxResults=250/);
    expect(prompt).toMatch(/pageToken set to that token/);
    expect(prompt).toMatch(/"complete":true,"nextPageToken":null/);
  });

  it('reconciles a fully drained multi-page calendar: upserts every page and prunes only the genuine deletion', async () => {
    const firstPage = Array.from({ length: 3 }, (_, i) => rawEvent(`page1-${i}`, `Page one ${i}`));
    const secondPage = [rawEvent('page2-0', 'Page two 0')];
    runCliProviderPrompt.mockImplementation(cliReply([{ calendarId: CAL_ID, events: [...firstPage, ...secondPage] }]));

    const result = await mcpSyncAccount(ACCOUNT_ID, null);

    expect(result).toMatchObject({ status: 'success', newEvents: 4, pruned: 1 });
    expect(result.reason).toBeUndefined();
    expect(savedCache().events.map((e) => e.title).sort()).toEqual(['Page one 0', 'Page one 1', 'Page one 2', 'Page two 0']);
  });

  // The synthetic reproduction from the issue: one received event, a token that
  // says more exist, a different event already cached in the window.
  it.each([
    ['a remaining nextPageToken', { nextPageToken: 'synthetic-next-page' }, 'more event pages'],
    ['a legacy envelope with no completion fields', { complete: undefined, nextPageToken: undefined, timeMin: undefined, timeMax: undefined }, 'no completion marker'],
    ['an explicit complete:false', { complete: false }, 'incomplete'],
    ['complete:true but no window echo', { timeMin: undefined, timeMax: undefined }, 'window metadata'],
    ['a window that contradicts the request', { timeMax: '2000-01-01T00:00:00.000Z' }, 'window metadata'],
    ['a calendar that was never requested', { calendarId: 'stranger@example.com' }, 'not requested'],
  ])('upserts but never prunes on %s, and reports a partial result', async (_name, override, reasonFragment) => {
    runCliProviderPrompt.mockImplementation(cliReply([{ calendarId: CAL_ID, events: [rawEvent('upstream-2', 'Design review')], ...override }]));
    const io = { emit: vi.fn() };

    const result = await mcpSyncAccount(ACCOUNT_ID, io);

    expect(result).toMatchObject({ status: 'partial', pruned: 0, reason: expect.stringContaining(reasonFragment) });
    expect(updateSyncStatus).toHaveBeenLastCalledWith(ACCOUNT_ID, 'partial');
    expect(io.emit).toHaveBeenCalledWith('calendar:sync:completed', expect.objectContaining({
      status: 'partial', pruned: 0, reason: expect.stringContaining(reasonFragment),
    }));
    // The cached event the response never mentioned survives alongside the new one.
    expect(savedCache().events.map((e) => e.title).sort()).toEqual(['Design review', 'Standing 1:1']);
  });

  it('keeps cached conference and participant metadata that an incomplete page omits', async () => {
    const full = {
      ...rawEvent('upstream-move', 'Weekly sync'),
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: OLD_ROOM }] },
      organizer: { email: 'alice@example.com' },
      attendees: [{ email: 'alice@example.com', self: true, responseStatus: 'declined' }],
    };
    runCliProviderPrompt.mockImplementation(cliReply([{ calendarId: CAL_ID, events: [full] }]));
    await mcpSyncAccount(ACCOUNT_ID, null);
    loadCache.mockResolvedValue({ events: [savedCache().events.at(-1)] });

    runCliProviderPrompt.mockImplementation(cliReply([{ calendarId: CAL_ID, nextPageToken: 'synthetic-next-page', events: [rawEvent('upstream-move', 'Weekly sync')] }]));
    const result = await mcpSyncAccount(ACCOUNT_ID, null);

    expect(result.status).toBe('partial');
    expect(savedCache().events[0]).toMatchObject({
      meetingUrl: OLD_ROOM, organizer: { email: 'alice@example.com' }, myStatus: 'declined',
    });
  });

  it('treats a calendar returned twice as contradictory instead of trusting either copy', async () => {
    runCliProviderPrompt.mockImplementation(cliReply([
      { calendarId: CAL_ID, events: [rawEvent('upstream-2', 'Design review')] },
      { calendarId: CAL_ID, events: [rawEvent('upstream-3', 'Retro')] },
    ]));

    const result = await mcpSyncAccount(ACCOUNT_ID, null);

    expect(result).toMatchObject({ status: 'partial', pruned: 0, reason: expect.stringContaining('more than once') });
    expect(savedCache().events.map((e) => e.title)).toContain('Standing 1:1');
  });

  it('judges each calendar on its own: the complete one prunes, the one the reply never described is reported', async () => {
    getAccount.mockResolvedValue({
      ...account(),
      subcalendars: [...account().subcalendars, { calendarId: TWO_CALENDARS, name: 'Team', enabled: true, dormant: false }],
    });
    runCliProviderPrompt.mockImplementation(cliReply([{ calendarId: CAL_ID, events: [rawEvent('upstream-2', 'Design review')] }]));

    const result = await mcpSyncAccount(ACCOUNT_ID, null);

    expect(result).toMatchObject({ status: 'partial', pruned: 1, reason: expect.stringContaining('"Team": missing from the response') });
    expect(result.calendars).toEqual([expect.objectContaining({ calendarId: CAL_ID, complete: true, pruned: 1 })]);
    expect(savedCache().events.map((e) => e.title)).toEqual(['Design review']);
  });

  it('a non-zero CLI exit stays partial even when the envelope claims completeness', async () => {
    runCliProviderPrompt.mockImplementation(cliReply(
      [{ calendarId: CAL_ID, events: [rawEvent('upstream-2', 'Design review')] }],
      { exitCode: 1, partial: true, stderrTail: 'stream aborted' },
    ));

    const result = await mcpSyncAccount(ACCOUNT_ID, null);

    expect(result).toMatchObject({ status: 'partial', pruned: 0, reason: 'stream aborted' });
  });
});

// #6289: a Google event's join link is projected into a single cached
// `meetingUrl`. The regressions these pin are (a) caching something that is not
// a usable video link, and (b) an older producer that omits the conference
// fields silently wiping a working Join action off an already-cached event.
describe('meetingUrl projection (#6289)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue(account());
    loadCache.mockResolvedValue({ events: [] });
  });

  const resync = async (raw) => {
    runCliProviderPrompt.mockImplementation(cliReply([{ calendarId: CAL_ID, events: [raw] }]));
    return mcpSyncAccount(ACCOUNT_ID, null);
  };

  const syncOne = async (raw) => {
    await resync(raw);
    return savedCache().events.at(-1);
  };

  it('prefers a structured video entry point over the legacy hangoutLink', async () => {
    const event = await syncOne({
      ...rawEvent('upstream-video', 'Design review'),
      hangoutLink: 'https://meet.example.com/legacy-abc',
      conferenceData: {
        entryPoints: [
          { entryPointType: 'phone', uri: 'tel:+15550100,,987654#' },
          { entryPointType: 'video', uri: 'https://meet.example.com/video-xyz' },
          { entryPointType: 'more', uri: 'https://meet.example.com/more-xyz' },
        ],
      },
    });

    expect(event.meetingUrl).toBe('https://meet.example.com/video-xyz');
  });

  it('matches the video entry type leniently rather than falling back to a DIFFERENT meeting', async () => {
    // An exact-match test would skip a ` video ` entry and silently serve the
    // legacy link instead — the wrong meeting, not merely a missing one. It also
    // keeps the ingress paths agreeing, since the push route trims its strings.
    const event = await syncOne({
      ...rawEvent('upstream-padded-type', 'Padded entry type'),
      hangoutLink: 'https://meet.example.com/legacy-abc',
      conferenceData: { entryPoints: [{ entryPointType: ' Video ', uri: 'https://meet.example.com/video-xyz' }] },
    });

    expect(event.meetingUrl).toBe('https://meet.example.com/video-xyz');
  });

  it('falls back to hangoutLink when no usable video entry point exists', async () => {
    const event = await syncOne({
      ...rawEvent('upstream-legacy', 'Legacy sync'),
      hangoutLink: 'https://meet.example.com/legacy-abc',
      conferenceData: { entryPoints: [{ entryPointType: 'phone', uri: 'tel:+15550100' }] },
    });

    expect(event.meetingUrl).toBe('https://meet.example.com/legacy-abc');
  });

  it('caches only the chosen URL — never passwords, PINs or the raw conference object', async () => {
    const event = await syncOne({
      ...rawEvent('upstream-secrets', 'Sensitive'),
      conferenceData: {
        conferenceId: 'abc-defg-hij',
        entryPoints: [
          { entryPointType: 'video', uri: 'https://meet.example.com/video-xyz', password: 'hunter2' },
          { entryPointType: 'phone', uri: 'tel:+15550100', pin: '987654' },
        ],
      },
    });

    expect(event.meetingUrl).toBe('https://meet.example.com/video-xyz');
    expect(event.conferenceData).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain('hunter2');
    expect(JSON.stringify(event)).not.toContain('987654');
  });

  it('caches a normalized URL the client-side render check will accept', async () => {
    // `isSafeHref` (new URL) accepts scheme-relative forms that the drawer's
    // `^https?://` re-check rejects, so storing the raw string would cache a
    // link and then hide it. Normalizing on write keeps the two sides agreeing.
    const event = await syncOne({
      ...rawEvent('upstream-relative', 'Odd but resolvable'),
      hangoutLink: 'https:meet.example.com/room-abc',
    });

    expect(event.meetingUrl).toBe('https://meet.example.com/room-abc');
    expect(/^https?:\/\//i.test(event.meetingUrl)).toBe(true);
  });

  it('rejects a non-http(s) candidate rather than caching a script URL', async () => {
    const event = await syncOne({
      ...rawEvent('upstream-xss', 'Hostile'),
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'javascript:alert(1)' }] },
    });

    expect(event.meetingUrl).toBeNull();
  });

  it('rejects an over-long candidate rather than caching an unbounded string', async () => {
    const event = await syncOne({
      ...rawEvent('upstream-long', 'Too long'),
      hangoutLink: `https://meet.example.com/${'a'.repeat(1300)}`,
    });

    expect(event.meetingUrl).toBeNull();
  });

  it('never treats htmlLink or a URL in the description as a join link', async () => {
    const event = await syncOne({
      ...rawEvent('upstream-html', 'No conference'),
      htmlLink: 'https://calendar.example.com/event?eid=abc',
      description: 'Dial in at https://meet.example.com/from-description',
      location: 'https://meet.example.com/from-location',
    });

    expect(event.meetingUrl).toBeNull();
  });

  // Seed the cache the honest way: run one sync and keep what it wrote, so the
  // externalId derivation stays production's business rather than the test's.
  const seedCached = async (raw) => {
    await syncOne(raw);
    const seeded = savedCache().events.at(-1);
    vi.clearAllMocks();
    getAccount.mockResolvedValue(account());
    loadCache.mockResolvedValue({ events: [seeded] });
    return seeded;
  };

  const withOldRoom = () => ({
    ...rawEvent('upstream-move', 'Weekly sync'),
    conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.example.com/old-room' }] },
  });

  it('replaces an existing link, keeping the cached event id stable', async () => {
    const seeded = await seedCached(withOldRoom());

    const result = await resync({
      ...rawEvent('upstream-move', 'Weekly sync'),
      conferenceData: { entryPoints: [{ entryPointType: 'video', uri: 'https://meet.example.com/new-room' }] },
    });

    expect(result.updated).toBe(1);
    const events = savedCache().events;
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe(seeded.id);
    expect(events[0].meetingUrl).toBe('https://meet.example.com/new-room');
  });

  it('clears the link when the producer says the meeting no longer has one', async () => {
    await seedCached(withOldRoom());

    const result = await resync({ ...rawEvent('upstream-move', 'Weekly sync'), hangoutLink: null, conferenceData: null });

    expect(result.updated).toBe(1);
    expect(savedCache().events[0].meetingUrl).toBeNull();
  });

  it('CLEARS the link when a complete MCP sync stops mentioning the conference', async () => {
    await seedCached(withOldRoom());

    // Google OMITS both fields on an event that has no conference, and the MCP
    // prompt relays its events verbatim — so on a complete payload, omission
    // means "the organizer removed the video call", not "unknown". Without the
    // authoritative stamp the dead Join button could never be cleared by any
    // sync.
    const result = await resync(rawEvent('upstream-move', 'Weekly sync'));

    expect(result.updated).toBe(1);
    expect(savedCache().events[0].meetingUrl).toBeNull();
  });

  it('PRESERVES the link when a PARTIAL MCP payload stops mentioning the conference', async () => {
    await seedCached(withOldRoom());

    // The CLI died mid-stream, so a missing field may just be truncation.
    // Clearing a link is destructive, and the same rule that stops a partial
    // payload from pruning stops it from clearing.
    runCliProviderPrompt.mockResolvedValue({
      text: JSON.stringify({
        calendars: [{ calendarId: CAL_ID, calendarName: 'Work', events: [rawEvent('upstream-move', 'Weekly sync')] }],
      }),
      exitCode: 1,
      partial: true,
      stderrTail: 'stream aborted',
    });

    const result = await mcpSyncAccount(ACCOUNT_ID, null);

    expect(result.status).toBe('partial');
    expect(savedCache().events[0].meetingUrl).toBe('https://meet.example.com/old-room');
  });

  it('PRESERVES the link when a legacy PUSH client omits both conference fields', async () => {
    // The HTTP push route is the one ingress whose omission is genuinely
    // ambiguous — an older client simply doesn't know the fields exist — so it
    // reaches pushSyncEvents unstamped and must not read as "link removed".
    const seeded = await seedCached(withOldRoom());
    loadCache.mockResolvedValue({ events: [seeded] });

    const result = await pushSyncEvents(
      ACCOUNT_ID, CAL_ID, 'Work', [rawEvent('upstream-move', 'Weekly sync')], null,
    );

    expect(result.updated).toBe(1);
    expect(savedCache().events[0].meetingUrl).toBe('https://meet.example.com/old-room');
  });

  it('writes an explicit null key on a newly cached event that named no link', async () => {
    // The selector returns `undefined` here (this producer described no
    // conferencing at all); the insert path pins it to null so a fresh record
    // never carries the sentinel into the cache.
    const event = await syncOne(rawEvent('upstream-plain', 'No conference'));
    expect('meetingUrl' in event).toBe(true);
    expect(event.meetingUrl).toBeNull();
  });
});

describe('Google batch identity reconciliation (#8635)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue(account());
    loadCache.mockResolvedValue({ events: [] });
  });

  it('adds one row for duplicate deliveries and retains the last mutable fields', async () => {
    const result = await pushSyncEvents(ACCOUNT_ID, CAL_ID, 'Work', [
      rawEvent('a', 'Earlier'), rawEvent('a', 'Latest'),
    ]);
    expect(result).toMatchObject({ newEvents: 1, total: 1 });
    expect(savedCache().events).toEqual([expect.objectContaining({ title: 'Latest' })]);
  });

  it('heals old duplicates with a stable id while preserving other calendars and partial omissions', async () => {
    await pushSyncEvents(ACCOUNT_ID, CAL_ID, 'Work', [rawEvent('a', 'Earlier')]);
    const retained = savedCache().events[0];
    const otherCalendar = { ...retained, id: 'other-calendar', subcalendarId: 'other@example.com' };
    const omitted = { ...retained, id: 'omitted', externalId: 'omitted' };
    loadCache.mockResolvedValue({ events: [
      retained, { ...retained, id: 'old-duplicate' }, otherCalendar, omitted,
    ] });
    const result = await pushSyncEvents(ACCOUNT_ID, CAL_ID, 'Work', [
      rawEvent('a', 'Current'),
    ], null, { prune: false });
    expect(result).toMatchObject({ newEvents: 0, total: 3, pruned: 0 });
    expect(savedCache().events).toEqual([
      expect.objectContaining({ id: retained.id, title: 'Current' }), otherCalendar, omitted,
    ]);
  });
});


describe('Google participant snapshot reconciliation (#8838)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccount.mockResolvedValue(account());
    loadCache.mockResolvedValue({ events: [] });
  });

  it('retains declined identity on legacy updates and clears it on explicit snapshots', async () => {
    await pushSyncEvents(ACCOUNT_ID, CAL_ID, 'Work', [{
      ...rawEvent('identity', 'Meeting'),
      organizer: { email: 'alice@example.com', displayName: 'Example Organizer' },
      attendees: [{ email: 'alice@example.com', self: true, responseStatus: 'declined' }],
    }]);
    const retained = savedCache().events[0];
    expect(retained.myStatus).toBe('declined');
    expect(logCalendarTouchpoints.mock.calls.at(-1)[1][0]).toMatchObject({
      organizer: { name: 'Example Organizer', email: 'alice@example.com' },
      attendees: [{ email: 'alice@example.com', status: 'declined' }], myStatus: 'declined',
    });
    loadCache.mockResolvedValue({ events: [retained] });
    await pushSyncEvents(ACCOUNT_ID, CAL_ID, 'Work', [rawEvent('identity', 'Updated')]);
    expect(savedCache().events[0]).toMatchObject({ organizer: retained.organizer, attendees: retained.attendees, myStatus: 'declined' });
    await pushSyncEvents(ACCOUNT_ID, CAL_ID, 'Work', [{ ...rawEvent('identity', 'Cleared'), organizer: null, attendees: [] }]);
    expect(savedCache().events[0]).toMatchObject({ organizer: null, attendees: [] });
    expect(savedCache().events[0].myStatus).toBeUndefined();
  });

  it('complete MCP snapshots clear omitted identities but partial snapshots preserve them', async () => {
    await pushSyncEvents(ACCOUNT_ID, CAL_ID, 'Work', [{
      ...rawEvent('identity', 'Meeting'), organizer: { email: 'alice@example.com' },
      attendees: [{ email: 'alice@example.com', self: true, responseStatus: 'declined' }],
    }]);
    loadCache.mockResolvedValue(savedCache());
    const reply = cliReply([{ calendarId: CAL_ID, events: [rawEvent('identity', 'Updated')] }]);
    runCliProviderPrompt.mockImplementation(reply);
    runCliProviderPrompt.mockImplementationOnce(async (args) => ({ ...(await reply(args)), exitCode: 1, partial: true }));
    await mcpSyncAccount(ACCOUNT_ID, null);
    expect(savedCache().events[0].myStatus).toBe('declined');
    await mcpSyncAccount(ACCOUNT_ID, null);
    expect(savedCache().events[0]).toMatchObject({ organizer: null, attendees: [] });
    expect(savedCache().events[0].myStatus).toBeUndefined();
  });
  it('with a dateRange, prunes only in-window deletions and retains events outside the window', async () => {
    const day = 86400000;
    const now = Date.now();
    const iso = (offset) => new Date(now + offset * day).toISOString();
    const mk = (id, off) => ({ id, externalId: id, title: id, subcalendarId: CAL_ID, startTime: iso(off), endTime: iso(off) });
    const dateRange = { pastDate: new Date(now - 7 * day), futureDate: new Date(now + 30 * day) };
    await pushSyncEvents(ACCOUNT_ID, CAL_ID, 'Work', [rawEvent('kept-in-window', 'Kept')]);
    const kept = { ...savedCache().events[0], id: 'kept-in-window', startTime: iso(5), endTime: iso(5) };
    loadCache.mockResolvedValue({ events: [mk('old', -60), mk('far', 90), { ...mk('ends-at-start', 0), endTime: dateRange.pastDate.toISOString(), startTime: iso(-8) }, { ...mk('starts-at-end', 0), startTime: dateRange.futureDate.toISOString(), endTime: iso(31) }, mk('deleted-in-window', 3), kept] });
    const result = await pushSyncEvents(ACCOUNT_ID, CAL_ID, 'Work', [rawEvent('kept-in-window', 'Kept')], null, { dateRange });
    expect(result.pruned).toBe(1);
    expect(savedCache().events.map(e => e.id).sort()).toEqual(['ends-at-start', 'far', 'kept-in-window', 'old', 'starts-at-end']);
  });
});

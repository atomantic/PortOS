import { describe, it, expect, vi } from 'vitest';

// Stub every external side-effect before importing tools.js so the unit test
// exercises pure validation/dispatch logic without hitting the filesystem.
vi.mock('../brain.js', () => ({
  captureThought: vi.fn(async () => ({ inboxLog: { id: 'inbox-1' }, message: 'ok' })),
  getInboxLog: vi.fn(async () => []),
}));
vi.mock('../meatspaceAlcohol.js', () => ({
  logDrink: vi.fn(async () => ({ standardDrinks: 1, dayTotal: 1 })),
  getAlcoholSummary: vi.fn(async () => ({ today: 0 })),
}));
vi.mock('../meatspaceNicotine.js', () => ({
  logNicotine: vi.fn(async () => ({ totalMg: 1, dayTotal: 1 })),
  getNicotineSummary: vi.fn(async () => ({ today: 0 })),
}));
const addWorkoutMock = vi.fn(async ({ date, type, durationMinutes, intensity, notes }) => ({
  date: date || '2026-04-17',
  type,
  durationMinutes: durationMinutes ?? null,
  intensity: intensity ?? null,
  notes: notes ?? null,
}));
vi.mock('../meatspaceHealth.js', () => ({
  addBodyEntry: vi.fn(async () => ({ date: '2026-04-17' })),
  addWorkout: (...args) => addWorkoutMock(...args),
}));
// Calendar events — controllable per-test via calendarEventsRef.
const calendarEventsRef = { value: [] };
vi.mock('../calendarSync.js', () => ({
  getEvents: vi.fn(async () => ({ events: calendarEventsRef.value, total: calendarEventsRef.value.length })),
}));
const addNotificationMock = vi.fn(async () => ({ id: 'notif-1' }));
vi.mock('../notifications.js', () => ({
  addNotification: (...args) => addNotificationMock(...args),
  NOTIFICATION_TYPES: { AGENT_WARNING: 'agent_warning' },
  PRIORITY_LEVELS: { HIGH: 'high' },
}));
// Open-Meteo fetch — controllable per-test via weatherFetchRef.
const weatherFetchRef = { value: { ok: true, json: async () => ({ current: { temperature_2m: 64, weather_code: 3 } }) } };
vi.mock('../../lib/fetchWithTimeout.js', () => ({
  fetchWithTimeout: vi.fn(async () => weatherFetchRef.value),
}));
// Timezone — pin to deterministic values so calendar/time tests don't depend
// on the host TZ or settings file.
vi.mock('../../lib/timezone.js', () => ({
  getUserTimezone: vi.fn(async () => 'America/Los_Angeles'),
  todayInTimezone: vi.fn(() => '2026-04-17'),
  getLocalParts: vi.fn(() => ({ year: 2026, month: 4, day: 17 })),
  getUtcOffsetMs: vi.fn(() => -7 * 3600 * 1000), // PDT
}));
vi.mock('../identity.js', () => ({
  getGoals: vi.fn(async () => ({ goals: [] })),
  updateGoalProgress: vi.fn(async () => {}),
  addProgressEntry: vi.fn(async () => {}),
}));
vi.mock('../pm2.js', () => ({
  listProcesses: vi.fn(async () => []),
  restartApp: vi.fn(async () => {}),
}));
vi.mock('../feeds.js', () => ({
  getItems: vi.fn(async () => []),
  getFeeds: vi.fn(async () => []),
  markItemRead: vi.fn(async () => ({ updated: true })),
  markAllRead: vi.fn(async () => ({ marked: 0 })),
}));
// imageGen dispatcher — tests pin the dispatch and let us assert what mode
// the voice tool forwards. The settings mock controls the codex-enabled gate.
// For async modes (local/codex) the mock also simulates the per-provider
// 'completed' event the real providers emit on imageGenEvents — without
// that, the tool's await would hang for 5 minutes.
const codexEnabledRef = { value: false };

// Hoisting note: vi.mock factories run before the module under test loads,
// so we can't import imageGenEvents up here. Instead, do the import lazily
// inside the mock factory using vi.importActual.
let _imageGenEvents = null;
const getEvents = async () => {
  if (!_imageGenEvents) _imageGenEvents = (await vi.importActual('../imageGenEvents.js')).imageGenEvents;
  return _imageGenEvents;
};

const generateImageMock = vi.fn(async (params) => {
  const mode = params?.mode || 'external';
  const generationId = `mock-${Math.random().toString(36).slice(2, 10)}`;
  const result = { generationId, filename: 'mock.png', path: '/data/images/mock.png', mode };
  if (mode === 'local' || mode === 'codex') {
    // Fire the completion event after generateImage resolves so the tool
    // has time to register its listener with the captured generationId.
    setImmediate(async () => {
      const events = await getEvents();
      events.emit('completed', { generationId, path: result.path, filename: result.filename });
    });
  }
  return result;
});
vi.mock('../imageGen/index.js', () => ({
  generateImage: (...args) => generateImageMock(...args),
  IMAGE_GEN_MODE: { EXTERNAL: 'external', LOCAL: 'local', CODEX: 'codex' },
  IMAGE_GEN_MODES: ['external', 'local', 'codex'],
}));
vi.mock('../settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { codex: { enabled: codexEnabledRef.value } } })),
}));

// askService.runAsk is an async generator. Default mock yields a small
// synthetic stream so ui_ask tests don't need to spin up real providers.
vi.mock('../askService.js', () => ({
  VALID_MODES: new Set(['ask', 'advise', 'draft']),
  runAsk: vi.fn(async function* () {
    yield { type: 'sources', sources: [{ kind: 'memory', title: 'A note' }] };
    yield { type: 'delta', text: 'Hello ' };
    yield { type: 'delta', text: 'world.' };
    yield {
      type: 'done',
      answer: 'Hello world.',
      sources: [{ kind: 'memory', title: 'A note' }],
      providerId: 'p1',
      model: 'm1',
    };
  }),
}));

const { dispatchTool, getToolSpecs, getToolSpecsForIntent, classifyIntent, anchorLocalMidnightUtc } = await import('./tools.js');
const { getUtcOffsetMs: mockedGetUtcOffsetMs } = await import('../../lib/timezone.js');

describe('getToolSpecs', () => {
  it('returns OpenAI-format function specs', () => {
    const specs = getToolSpecs();
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      expect(s.type).toBe('function');
      expect(typeof s.function.name).toBe('string');
      expect(s.function.parameters?.type).toBe('object');
    }
  });
});

describe('dispatchTool unknown tool', () => {
  it('throws when tool name is unknown', async () => {
    await expect(dispatchTool('nope_tool', {})).rejects.toThrow(/Unknown tool/);
  });
});

describe('brain_capture validation', () => {
  it('rejects missing text', async () => {
    await expect(dispatchTool('brain_capture', {})).rejects.toThrow(/text is required/);
  });
  it('rejects whitespace-only text', async () => {
    await expect(dispatchTool('brain_capture', { text: '   ' })).rejects.toThrow(/text must not be empty/);
  });
  it('returns inboxLog id on success', async () => {
    const r = await dispatchTool('brain_capture', { text: 'remember milk' });
    expect(r.ok).toBe(true);
    expect(r.id).toBe('inbox-1');
  });
});

describe('brain_search validation', () => {
  it('rejects missing query', async () => {
    await expect(dispatchTool('brain_search', {})).rejects.toThrow(/query is required/);
  });
  it('rejects whitespace-only query (would match everything)', async () => {
    await expect(dispatchTool('brain_search', { query: '  ' })).rejects.toThrow(/query must not be empty/);
  });
});

describe('meatspace_log_drink validation', () => {
  it('rejects missing name', async () => {
    await expect(dispatchTool('meatspace_log_drink', {})).rejects.toThrow(/name is required/);
  });
  it('rejects negative count', async () => {
    await expect(dispatchTool('meatspace_log_drink', { name: 'beer', count: -1 }))
      .rejects.toThrow(/count must be a positive number/);
  });
  it('rejects abv over 100', async () => {
    await expect(dispatchTool('meatspace_log_drink', { name: 'beer', abv: 500 }))
      .rejects.toThrow(/abv must be between 0 and 100/);
  });
  it('rejects oz over 128', async () => {
    await expect(dispatchTool('meatspace_log_drink', { name: 'beer', oz: 999 }))
      .rejects.toThrow(/oz must be a positive number/);
  });
});

describe('meatspace_log_nicotine validation', () => {
  it('rejects empty product', async () => {
    await expect(dispatchTool('meatspace_log_nicotine', { product: '   ' }))
      .rejects.toThrow(/product must not be empty/);
  });
  it('rejects negative count', async () => {
    await expect(dispatchTool('meatspace_log_nicotine', { product: 'cigarette', count: -2 }))
      .rejects.toThrow(/count must be a positive number/);
  });
  it('rejects mgPerUnit over 200', async () => {
    await expect(dispatchTool('meatspace_log_nicotine', { product: 'cigarette', mgPerUnit: 9999 }))
      .rejects.toThrow(/mgPerUnit must be between 0 and 200/);
  });
});

describe('goal_update_progress type guard', () => {
  it('rejects non-string goalQuery', async () => {
    await expect(dispatchTool('goal_update_progress', { goalQuery: 42, progress: 50 }))
      .rejects.toThrow(/goalQuery is required/);
  });
  it('rejects out-of-range progress', async () => {
    await expect(dispatchTool('goal_update_progress', { goalQuery: 'jacket', progress: 150 }))
      .rejects.toThrow(/progress must be a number between 0 and 100/);
  });
});

describe('goal_log_note type guard', () => {
  it('rejects non-string goalQuery', async () => {
    await expect(dispatchTool('goal_log_note', { goalQuery: {}, note: 'hi' }))
      .rejects.toThrow(/goalQuery is required/);
  });
  it('rejects missing note', async () => {
    await expect(dispatchTool('goal_log_note', { goalQuery: 'jacket' }))
      .rejects.toThrow(/note is required/);
  });
});

describe('pm2_restart type guard', () => {
  it('rejects non-string name', async () => {
    await expect(dispatchTool('pm2_restart', { name: 12345 })).rejects.toThrow(/name is required/);
  });
  it('rejects empty string name', async () => {
    await expect(dispatchTool('pm2_restart', { name: '  ' })).rejects.toThrow(/name is required/);
  });
});

// Bug: "Instead of entering what I asked into the description form field,
// it created a brain entry." Form-fill utterances were seeing brain_capture
// in the tool list because brain_capture used to be always-on; the LLM
// picked it over ui_fill because the tool description emphasizes
// note/save/remember/jot, words that overlap with field content.
describe('getToolSpecsForIntent — form fill suppresses capture', () => {
  const names = (specs) => specs.map((s) => s.function.name);

  it('drops brain_capture for "fill description with X"', () => {
    const { specs } = getToolSpecsForIntent('fill the description with remember to buy milk');
    expect(names(specs)).toContain('ui_fill');
    expect(names(specs)).not.toContain('brain_capture');
    expect(names(specs)).not.toContain('daily_log_append');
  });

  it('drops brain_capture for "type X into the name field"', () => {
    const { specs } = getToolSpecsForIntent('type my new idea into the name field');
    expect(names(specs)).toContain('ui_fill');
    expect(names(specs)).not.toContain('brain_capture');
  });

  it('drops brain_capture for "put X in the body"', () => {
    const { specs } = getToolSpecsForIntent('put save this for later in the body');
    expect(names(specs)).toContain('ui_fill');
    expect(names(specs)).not.toContain('brain_capture');
  });

  it('drops brain_capture for "enter X into title"', () => {
    const { specs } = getToolSpecsForIntent('enter a note about yesterday into the title');
    expect(names(specs)).toContain('ui_fill');
    expect(names(specs)).not.toContain('brain_capture');
  });

  it('keeps brain_capture for "remember to buy milk"', () => {
    const { specs } = getToolSpecsForIntent('remember to buy milk on the way home');
    expect(names(specs)).toContain('brain_capture');
  });

  it('keeps brain_capture for "add this to my brain inbox"', () => {
    const { specs } = getToolSpecsForIntent('add this to my brain inbox: finish the review');
    expect(names(specs)).toContain('brain_capture');
  });

  it('drops brain_capture for UI-only turns (no capture verbs)', () => {
    const { specs } = getToolSpecsForIntent('click the new task button');
    expect(names(specs)).not.toContain('brain_capture');
    expect(names(specs)).toContain('ui_click');
  });
});

describe('classifyIntent — brain regex expansions', () => {
  it('matches "remember"', () => {
    expect(classifyIntent('remember to call mom').has('brain')).toBe(true);
  });
  it('matches "jot down"', () => {
    expect(classifyIntent('jot down an idea for dinner').has('brain')).toBe(true);
  });
  it('does not match plain UI turns', () => {
    expect(classifyIntent('click the save button').has('brain')).toBe(false);
  });
});

describe('classifyIntent — feeds regex covers mark-read phrasings', () => {
  it('matches "what\'s in my feeds"', () => {
    expect(classifyIntent("what's in my feeds today").has('feeds')).toBe(true);
  });
  it('matches "mark that one read"', () => {
    expect(classifyIntent('mark that one read').has('feeds')).toBe(true);
  });
  it('matches "mark them all as read"', () => {
    expect(classifyIntent('mark them all as read').has('feeds')).toBe(true);
  });
  it('does NOT match "read my daily log" (read alone is too broad)', () => {
    expect(classifyIntent('read my daily log').has('feeds')).toBe(false);
  });
});

describe('feeds_mark_read', () => {
  it('returns ok:false when neither query nor all is provided', async () => {
    const r = await dispatchTool('feeds_mark_read', {});
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/which item|mark all/i);
  });

  it('marks all unread when all=true', async () => {
    const feeds = await import('../feeds.js');
    feeds.markAllRead.mockResolvedValueOnce({ marked: 7 });
    const r = await dispatchTool('feeds_mark_read', { all: true });
    expect(r.ok).toBe(true);
    expect(r.marked).toBe(7);
    expect(r.summary).toMatch(/Marked 7 items? as read/);
    expect(feeds.markAllRead).toHaveBeenLastCalledWith(undefined);
  });

  it('reports nothing-unread when markAll returns 0', async () => {
    const feeds = await import('../feeds.js');
    feeds.markAllRead.mockResolvedValueOnce({ marked: 0 });
    const r = await dispatchTool('feeds_mark_read', { all: true });
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/Nothing unread/);
  });

  it('scopes all=true to a feed when feedQuery matches', async () => {
    const feeds = await import('../feeds.js');
    feeds.getFeeds.mockResolvedValueOnce([
      { id: 'f1', title: 'Hacker News' },
      { id: 'f2', title: 'Daring Fireball' },
    ]);
    feeds.markAllRead.mockResolvedValueOnce({ marked: 3 });
    const r = await dispatchTool('feeds_mark_read', { all: true, feedQuery: 'hacker' });
    expect(r.ok).toBe(true);
    expect(r.marked).toBe(3);
    expect(feeds.markAllRead).toHaveBeenLastCalledWith('f1');
    expect(r.summary).toMatch(/from Hacker News/);
  });

  it('returns ok:false when feedQuery does not match any feed', async () => {
    const feeds = await import('../feeds.js');
    feeds.getFeeds.mockResolvedValueOnce([{ id: 'f1', title: 'Hacker News' }]);
    const r = await dispatchTool('feeds_mark_read', { all: true, feedQuery: 'nothing-like-that' });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/No feed matched/);
  });

  it('fuzzy-matches an unread item by title substring and marks it read', async () => {
    const feeds = await import('../feeds.js');
    feeds.getItems.mockResolvedValueOnce([
      { id: 'i1', title: 'Why React is fast', read: false },
      { id: 'i2', title: 'Tailwind v5 ships', read: false },
    ]);
    const r = await dispatchTool('feeds_mark_read', { query: 'tailwind' });
    expect(r.ok).toBe(true);
    expect(r.title).toBe('Tailwind v5 ships');
    expect(feeds.markItemRead).toHaveBeenLastCalledWith('i2');
  });

  it('returns ok:false when no unread item matches query', async () => {
    const feeds = await import('../feeds.js');
    feeds.getItems.mockResolvedValueOnce([{ id: 'i1', title: 'Something else', read: false }]);
    const r = await dispatchTool('feeds_mark_read', { query: 'nothing-like-that' });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/No unread item matched/);
  });

  it('rejects whitespace-only query without all', async () => {
    const r = await dispatchTool('feeds_mark_read', { query: '   ' });
    expect(r.ok).toBe(false);
  });
});

describe('ui_ask', () => {
  it('rejects missing question', async () => {
    await expect(dispatchTool('ui_ask', {})).rejects.toThrow(/question is required/);
  });

  it('rejects whitespace-only question', async () => {
    await expect(dispatchTool('ui_ask', { question: '   ' })).rejects.toThrow(/question is required/);
  });

  it('streams runAsk events into a content + sources result', async () => {
    const r = await dispatchTool('ui_ask', { question: 'what did I decide about exercise?' });
    expect(r.ok).toBe(true);
    expect(r.content).toBe('Hello world.');
    expect(r.sourceCount).toBe(1);
    expect(r.sources[0]).toEqual({ kind: 'memory', title: 'A note' });
    expect(r.providerId).toBe('p1');
    expect(r.model).toBe('m1');
    expect(r.summary).toMatch(/Answered "what did I decide about exercise/);
  });

  it('passes mode + signal through to runAsk', async () => {
    const askService = await import('../askService.js');
    const ctrl = new AbortController();
    await dispatchTool('ui_ask', { question: 'draft a status update', mode: 'draft' }, { signal: ctrl.signal });
    expect(askService.runAsk).toHaveBeenLastCalledWith(
      expect.objectContaining({
        question: 'draft a status update',
        mode: 'draft',
        signal: ctrl.signal,
      }),
    );
  });

  it('falls back to "ask" mode when given an invalid mode', async () => {
    const askService = await import('../askService.js');
    await dispatchTool('ui_ask', { question: 'hello', mode: 'rant' });
    expect(askService.runAsk).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'ask' }),
    );
  });

  it('returns ok:false when runAsk yields an error event', async () => {
    const askService = await import('../askService.js');
    askService.runAsk.mockImplementationOnce(async function* () {
      yield { type: 'error', error: 'No AI provider available' };
    });
    const r = await dispatchTool('ui_ask', { question: 'hello' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('No AI provider available');
    expect(r.summary).toMatch(/No AI provider available/);
  });

  it('returns ok:false when the stream produces no answer text', async () => {
    const askService = await import('../askService.js');
    askService.runAsk.mockImplementationOnce(async function* () {
      yield { type: 'sources', sources: [] };
      yield { type: 'done', answer: '', sources: [], providerId: 'p1', model: 'm1' };
    });
    const r = await dispatchTool('ui_ask', { question: 'silent' });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/empty/i);
  });

  it('returns ok:false on barge-in abort even with partial deltas', async () => {
    const askService = await import('../askService.js');
    askService.runAsk.mockImplementationOnce(async function* () {
      yield { type: 'delta', text: 'partial answer' };
      // runAsk exits early on abort without emitting `done`
    });
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await dispatchTool('ui_ask', { question: 'cancel mid-stream' }, { signal: ctrl.signal });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('aborted');
    expect(r.summary).toMatch(/cancelled/i);
  });
});

describe('classifyIntent — ask group', () => {
  it('matches "advise me" phrasings', () => {
    expect(classifyIntent('advise me on the next step').has('ask')).toBe(true);
  });
  it('matches "what did I decide" phrasings', () => {
    expect(classifyIntent('what did I decide about my exercise routine').has('ask')).toBe(true);
  });
  it('matches "draft a Slack message"', () => {
    expect(classifyIntent('draft a slack message to my team as me').has('ask')).toBe(true);
  });
  it('does NOT match plain UI turns', () => {
    expect(classifyIntent('click the save button').has('ask')).toBe(false);
  });
  it('does NOT match plain capture turns', () => {
    expect(classifyIntent('remember to buy milk').has('ask')).toBe(false);
  });
});

describe('getToolSpecsForIntent — ui_ask gating', () => {
  const names = (specs) => specs.map((s) => s.function.name);

  it('exposes ui_ask on RAG-style turns', () => {
    const { specs } = getToolSpecsForIntent('what did I decide about my exercise routine?');
    expect(names(specs)).toContain('ui_ask');
  });

  it('hides ui_ask on plain UI-driving turns', () => {
    const { specs } = getToolSpecsForIntent('click the save button');
    expect(names(specs)).not.toContain('ui_ask');
  });

  it('hides ui_ask on plain capture turns', () => {
    const { specs } = getToolSpecsForIntent('remember to buy milk');
    expect(names(specs)).not.toContain('ui_ask');
  });
});

describe('ui_read', () => {
  it('returns ok:false when no UI index is loaded', async () => {
    const r = await dispatchTool('ui_read', {}, { state: { ui: null } });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/can't see/i);
  });

  it('returns ok:false when UI index has empty/missing text', async () => {
    const r = await dispatchTool('ui_read', {}, { state: { ui: { text: '' } } });
    expect(r.ok).toBe(false);
  });

  it('returns the page text content verbatim', async () => {
    const text = 'Welcome to Tasks. Three tasks pending. Click to add another.';
    const ctx = { state: { ui: { text, path: '/tasks', title: 'Tasks' } } };
    const r = await dispatchTool('ui_read', {}, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toBe(text);
    expect(r.path).toBe('/tasks');
    expect(r.title).toBe('Tasks');
    expect(r.chars).toBe(text.length);
    expect(r.summary).toMatch(/Read page "Tasks"/);
  });

  it('honors summarize=true flag without altering content', async () => {
    const text = 'long content here';
    const ctx = { state: { ui: { text } } };
    const r = await dispatchTool('ui_read', { summarize: true }, ctx);
    expect(r.ok).toBe(true);
    expect(r.summarize).toBe(true);
    expect(r.content).toBe(text);
  });

  it('is gated on UI intent (read this page → ui_read present)', async () => {
    const { specs } = getToolSpecsForIntent('read me what does this page say');
    const names = specs.map((s) => s.function.name);
    expect(names).toContain('ui_read');
  });

  // Lazy text path: the client no longer ships `text` on every index; it sets
  // textOnDemand and ui_read pulls the blob via ctx.requestUiText().
  it('lazily fetches text via ctx.requestUiText when index omits text', async () => {
    const text = 'Lazily fetched page body.';
    let requested = 0;
    const ctx = {
      state: { ui: { textOnDemand: true, path: '/tasks', title: 'Tasks' } },
      requestUiText: async () => { requested += 1; return text; },
    };
    const r = await dispatchTool('ui_read', {}, ctx);
    expect(requested).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.content).toBe(text);
    expect(r.title).toBe('Tasks');
    expect(r.chars).toBe(text.length);
  });

  it('does not request lazily when text is already present (eager/legacy)', async () => {
    let requested = 0;
    const ctx = {
      state: { ui: { text: 'already here', textOnDemand: true } },
      requestUiText: async () => { requested += 1; return 'should-not-be-used'; },
    };
    const r = await dispatchTool('ui_read', {}, ctx);
    expect(requested).toBe(0);
    expect(r.content).toBe('already here');
  });

  it('returns ok:false when lazy fetch times out / returns null', async () => {
    const ctx = {
      state: { ui: { textOnDemand: true } },
      requestUiText: async () => null,
    };
    const r = await dispatchTool('ui_read', {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/can't see/i);
  });

  it('returns ok:false when client neither ships text nor advertises textOnDemand', async () => {
    // Very old client / no widget — no eager text, no lazy capability.
    const ctx = { state: { ui: { path: '/tasks' } }, requestUiText: async () => 'x' };
    const r = await dispatchTool('ui_read', {}, ctx);
    expect(r.ok).toBe(false);
  });
});

describe('ui_click — destructive confirmation gate', () => {
  const makeState = () => ({
    ui: {
      elements: [
        { ref: 1, kind: 'button', label: 'Save' },
        { ref: 2, kind: 'button', label: 'Delete account' },
        { ref: 3, kind: 'button', label: 'Reset filters' },
      ],
    },
  });

  it('clicks non-destructive labels immediately', async () => {
    const state = makeState();
    const sideEffects = [];
    const r = await dispatchTool('ui_click', { label: 'Save' }, { state, sideEffects });
    expect(r.ok).toBe(true);
    expect(r.confirmation_required).toBeUndefined();
    expect(sideEffects).toHaveLength(1);
    expect(sideEffects[0].type).toBe('ui:click');
    expect(state.pendingDestructive).toBeUndefined();
  });

  it('stashes pending and asks for confirmation on destructive label', async () => {
    const state = makeState();
    const sideEffects = [];
    const r = await dispatchTool('ui_click', { label: 'Delete account' }, { state, sideEffects });
    expect(r.ok).toBe(true);
    expect(r.confirmation_required).toBe(true);
    expect(sideEffects).toHaveLength(0);
    expect(state.pendingDestructive).toBeTruthy();
    expect(state.pendingDestructive.tool).toBe('ui_click');
    expect(state.pendingDestructive.target.label).toBe('Delete account');
  });

  it('also gates "Reset filters"', async () => {
    const state = makeState();
    const r = await dispatchTool('ui_click', { label: 'Reset' }, { state, sideEffects: [] });
    expect(r.confirmation_required).toBe(true);
  });

  it('skips the gate when ctx.confirmed flag is set (re-issue path)', async () => {
    const state = makeState();
    const sideEffects = [];
    const r = await dispatchTool(
      'ui_click',
      { label: 'Delete account' },
      { state, sideEffects, confirmed: true },
    );
    expect(r.ok).toBe(true);
    expect(r.confirmation_required).toBeUndefined();
    expect(sideEffects).toHaveLength(1);
    expect(state.pendingDestructive).toBeUndefined();
  });
});

// image_generate uses imageGen.generateImage under the hood; mocked
// above. The codexEnabledRef toggle drives the disabled-gate test.
describe("image_generate", () => {
  it("rejects empty prompt", async () => {
    const r = await dispatchTool("image_generate", { prompt: "  " });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/prompt is required/);
  });

  it("forwards prompt to dispatcher with no mode by default (auto)", async () => {
    generateImageMock.mockClear();
    const r = await dispatchTool("image_generate", { prompt: "a fox" });
    expect(r.ok).toBe(true);
    expect(generateImageMock).toHaveBeenCalledTimes(1);
    const args = generateImageMock.mock.calls[0][0];
    expect(args.prompt).toBe("a fox");
    expect(args.mode).toBeUndefined();
  });

  it("treats provider=auto the same as no provider", async () => {
    generateImageMock.mockClear();
    await dispatchTool("image_generate", { prompt: "a fox", provider: "auto" });
    expect(generateImageMock.mock.calls[0][0].mode).toBeUndefined();
  });

  it("forwards provider=local as mode=local", async () => {
    generateImageMock.mockClear();
    await dispatchTool("image_generate", { prompt: "a fox", provider: "local" });
    expect(generateImageMock.mock.calls[0][0].mode).toBe("local");
  });

  it("rejects provider=codex when codex is disabled in settings", async () => {
    codexEnabledRef.value = false;
    generateImageMock.mockClear();
    const r = await dispatchTool("image_generate", { prompt: "a fox", provider: "codex" });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/Codex Imagegen is disabled/);
    expect(generateImageMock).not.toHaveBeenCalled();
  });

  it("forwards provider=codex when codex is enabled", async () => {
    codexEnabledRef.value = true;
    generateImageMock.mockClear();
    const r = await dispatchTool("image_generate", { prompt: "a fox", provider: "codex" });
    expect(r.ok).toBe(true);
    expect(generateImageMock.mock.calls[0][0].mode).toBe("codex");
    codexEnabledRef.value = false;
  });

  it("includes the saved file path in summary", async () => {
    const r = await dispatchTool("image_generate", { prompt: "a fox" });
    expect(r.path).toBe("/data/images/mock.png");
    expect(r.filename).toBe("mock.png");
  });

  it("coerces stringified width/height to numbers before forwarding", async () => {
    generateImageMock.mockClear();
    const r = await dispatchTool("image_generate", { prompt: "a fox", width: "512", height: "768" });
    expect(r.ok).toBe(true);
    const args = generateImageMock.mock.calls[0][0];
    expect(args.width).toBe(512);
    expect(args.height).toBe(768);
  });

  it("rejects prompt longer than 2000 characters (matches route schema)", async () => {
    generateImageMock.mockClear();
    const r = await dispatchTool("image_generate", { prompt: "x".repeat(2001) });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/prompt must be 2000 characters or fewer/);
    expect(generateImageMock).not.toHaveBeenCalled();
  });

  it("accepts prompt at exactly 2000 characters", async () => {
    generateImageMock.mockClear();
    const r = await dispatchTool("image_generate", { prompt: "x".repeat(2000) });
    expect(r.ok).toBe(true);
  });

  it("rejects out-of-bounds width", async () => {
    generateImageMock.mockClear();
    const r = await dispatchTool("image_generate", { prompt: "a fox", width: 50000 });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/width must be an integer between 64 and 2048/);
    expect(generateImageMock).not.toHaveBeenCalled();
  });

  it("rejects non-integer height (e.g. floats)", async () => {
    generateImageMock.mockClear();
    const r = await dispatchTool("image_generate", { prompt: "a fox", height: "768.5" });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/height must be an integer between 64 and 2048/);
  });

  // The tool returns synchronously for external (file is already on disk)
  // but for local/codex it must await the imageGenEvents 'completed' event
  // — otherwise the palette toast says "image generated" before the file
  // actually exists.
  it("waits for imageGenEvents 'completed' on async modes (local) before resolving", async () => {
    generateImageMock.mockClear();
    const r = await dispatchTool("image_generate", { prompt: "a fox", provider: "local" });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe("local");
    expect(r.summary).toMatch(/^Generated image \(local\)/);
  });

  it("returns ok:false when imageGenEvents emits 'failed' for async modes", async () => {
    codexEnabledRef.value = true;
    generateImageMock.mockClear();
    // Override the default mock to emit 'failed' instead of 'completed'.
    generateImageMock.mockImplementationOnce(async (params) => {
      const generationId = `mockfail-${Math.random().toString(36).slice(2, 8)}`;
      setImmediate(async () => {
        const events = await getEvents();
        events.emit('failed', { generationId, error: 'mock provider failure' });
      });
      return { generationId, filename: 'mock.png', path: '/data/images/mock.png', mode: params.mode };
    });
    const r = await dispatchTool("image_generate", { prompt: "a fox", provider: "codex" });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/mock provider failure/);
    codexEnabledRef.value = false;
  });
});

// Pipeline stage navigation tools — parsePipelineIssuePath, pipeline_next_stage,
// pipeline_prev_stage, pipeline_open_stage, plus the GROUP_INTENT.pipeline regex.
describe('pipeline stage navigation tools', () => {
  // Each dispatch needs a ctx with `state.ui.path` (current page) and a
  // `sideEffects` array (where navigate intents land). The helper builds
  // a fresh ctx so per-test mutations don't bleed.
  const makeCtx = (path) => ({
    state: { ui: path === undefined ? undefined : { path } },
    sideEffects: [],
  });

  describe('pipeline_next_stage', () => {
    it('advances from idea → prose', async () => {
      const ctx = makeCtx('/pipeline/issues/iss-abc/idea');
      const r = await dispatchTool('pipeline_next_stage', {}, ctx);
      expect(r.ok).toBe(true);
      expect(r.stage).toBe('prose');
      expect(ctx.sideEffects).toEqual([{ type: 'navigate', path: '/pipeline/issues/iss-abc/prose' }]);
    });

    it('refuses to advance past audio (last navigable stage)', async () => {
      const r = await dispatchTool('pipeline_next_stage', {}, makeCtx('/pipeline/issues/x/audio'));
      expect(r.ok).toBe(false);
      expect(r.summary).toMatch(/last stage/);
    });

    it('refuses when not on a pipeline issue page', async () => {
      const r = await dispatchTool('pipeline_next_stage', {}, makeCtx('/brain/inbox'));
      expect(r.ok).toBe(false);
      expect(r.summary).toMatch(/\/pipeline\/issues\//);
    });

    it('defaults the parsed stage to idea when the path omits the stage segment', async () => {
      const ctx = makeCtx('/pipeline/issues/iss-zzz');
      const r = await dispatchTool('pipeline_next_stage', {}, ctx);
      expect(r.ok).toBe(true);
      expect(r.stage).toBe('prose');
    });
  });

  describe('pipeline_prev_stage', () => {
    it('rewinds from prose → idea', async () => {
      const ctx = makeCtx('/pipeline/issues/iss-abc/prose');
      const r = await dispatchTool('pipeline_prev_stage', {}, ctx);
      expect(r.ok).toBe(true);
      expect(r.stage).toBe('idea');
      expect(ctx.sideEffects).toEqual([{ type: 'navigate', path: '/pipeline/issues/iss-abc/idea' }]);
    });

    it('refuses to rewind past idea (first stage)', async () => {
      const r = await dispatchTool('pipeline_prev_stage', {}, makeCtx('/pipeline/issues/x/idea'));
      expect(r.ok).toBe(false);
      expect(r.summary).toMatch(/first stage/);
    });
  });

  describe('pipeline_open_stage', () => {
    it('opens a canonical stage id directly', async () => {
      const ctx = makeCtx('/pipeline/issues/iss-x/idea');
      const r = await dispatchTool('pipeline_open_stage', { stage: 'storyboards' }, ctx);
      expect(r.ok).toBe(true);
      expect(r.stage).toBe('storyboards');
      expect(ctx.sideEffects).toEqual([{ type: 'navigate', path: '/pipeline/issues/iss-x/storyboards' }]);
    });

    it('resolves spoken aliases (teleplay → teleplay, pages → comicPages, video → episodeVideo)', async () => {
      const ctx = makeCtx('/pipeline/issues/iss-x/idea');
      const r1 = await dispatchTool('pipeline_open_stage', { stage: 'teleplay' }, ctx);
      expect(r1.stage).toBe('teleplay');
      const r2 = await dispatchTool('pipeline_open_stage', { stage: 'pages' }, ctx);
      expect(r2.stage).toBe('comicPages');
      const r3 = await dispatchTool('pipeline_open_stage', { stage: 'video' }, ctx);
      expect(r3.stage).toBe('episodeVideo');
    });

    it('resolves canonical ids case-insensitively (e.g. "Prose" → prose, "ComicScript" → comicScript)', async () => {
      const ctx = makeCtx('/pipeline/issues/iss-x/idea');
      const r1 = await dispatchTool('pipeline_open_stage', { stage: 'Prose' }, ctx);
      expect(r1.stage).toBe('prose');
      const r2 = await dispatchTool('pipeline_open_stage', { stage: 'COMICSCRIPT' }, ctx);
      // 'COMICSCRIPT' lowercased ('comicscript') hits the alias table.
      expect(r2.stage).toBe('comicScript');
    });

    it('resolves singular "comic page" / "page" so the regex and alias table agree', async () => {
      // The regex matches `comic ?pages?` (singular OR plural). The alias
      // table now mirrors that so a matched utterance never bottoms out
      // at "Unknown stage" with the user staring at a working group.
      const ctx = makeCtx('/pipeline/issues/iss-x/idea');
      const r1 = await dispatchTool('pipeline_open_stage', { stage: 'comic page' }, ctx);
      expect(r1.stage).toBe('comicPages');
      const r2 = await dispatchTool('pipeline_open_stage', { stage: 'page' }, ctx);
      expect(r2.stage).toBe('comicPages');
    });

    it('rejects an unknown stage with a suggestion list', async () => {
      const ctx = makeCtx('/pipeline/issues/iss-x/idea');
      const r = await dispatchTool('pipeline_open_stage', { stage: 'whatever' }, ctx);
      expect(r.ok).toBe(false);
      expect(r.summary).toMatch(/storyboards/);
    });
  });

  describe('parsePipelineIssuePath (via dispatch)', () => {
    // The parser isn't exported directly — exercise it through the public
    // tools so regressions show up where users would actually feel them.
    it('strips a query string from the path before parsing the id', async () => {
      const ctx = makeCtx('/pipeline/issues/iss-abc/prose?foo=bar');
      const r = await dispatchTool('pipeline_next_stage', {}, ctx);
      expect(r.ok).toBe(true);
      // If the query bled into the issueId or stage, the navigate path
      // would carry "?foo=bar" or fall back to 'idea' as the current stage.
      expect(ctx.sideEffects[0].path).toBe('/pipeline/issues/iss-abc/comicScript');
    });

    it('strips a hash anchor from the path before parsing the id', async () => {
      const ctx = makeCtx('/pipeline/issues/iss-abc/prose#anchor');
      const r = await dispatchTool('pipeline_next_stage', {}, ctx);
      expect(r.ok).toBe(true);
      expect(ctx.sideEffects[0].path).toBe('/pipeline/issues/iss-abc/comicScript');
    });

    it('tolerates a missing UI state', async () => {
      const r = await dispatchTool('pipeline_next_stage', {}, makeCtx(undefined));
      expect(r.ok).toBe(false);
    });
  });

  describe('classifyIntent — pipeline group', () => {
    it('matches explicit stage-advance phrasings', () => {
      expect(classifyIntent('next stage').has('pipeline')).toBe(true);
      expect(classifyIntent('previous stage').has('pipeline')).toBe(true);
      expect(classifyIntent('stage forward').has('pipeline')).toBe(true);
    });

    it('matches "open <stage>" without requiring the trailing word "stage"', () => {
      expect(classifyIntent('open prose').has('pipeline')).toBe(true);
      expect(classifyIntent('open the storyboards').has('pipeline')).toBe(true);
      expect(classifyIntent('back to prose').has('pipeline')).toBe(true);
      expect(classifyIntent('go to storyboards').has('pipeline')).toBe(true);
    });

    it('does not steal generic "open pipeline" / "take me to pipeline" — those belong to ui_navigate', () => {
      expect(classifyIntent('take me to the pipeline').has('pipeline')).toBe(false);
    });

    it('matches spoken aliases so PIPELINE_STAGE_ALIASES resolution actually runs', () => {
      // Aliases that were dropped from the original narrow regex — without
      // these the alias table below was unreachable for these utterances.
      expect(classifyIntent('open teleplay').has('pipeline')).toBe(true);
      expect(classifyIntent('open comics').has('pipeline')).toBe(true);
      expect(classifyIntent('open the pages').has('pipeline')).toBe(true);
      expect(classifyIntent('open page').has('pipeline')).toBe(true);
      expect(classifyIntent('go to scenes').has('pipeline')).toBe(true);
      expect(classifyIntent('open episode').has('pipeline')).toBe(true);
      expect(classifyIntent('open video').has('pipeline')).toBe(true);
      expect(classifyIntent('back to story').has('pipeline')).toBe(true);
    });
  });
});

describe('calendar_today', () => {
  it('summarizes today\'s events', async () => {
    calendarEventsRef.value = [
      { title: 'Standup', startTime: '2026-04-17T17:00:00Z', location: 'Zoom', isAllDay: false },
      { title: 'All-hands', startTime: '2026-04-17T20:00:00Z', isAllDay: false },
    ];
    const r = await dispatchTool('calendar_today', {});
    expect(r.ok).toBe(true);
    expect(r.count).toBe(2);
    expect(r.date).toBe('2026-04-17');
    expect(r.events[0].title).toBe('Standup');
    expect(r.summary).toMatch(/2 events today/);
  });

  it('reports an empty day cleanly', async () => {
    calendarEventsRef.value = [];
    const r = await dispatchTool('calendar_today', {});
    expect(r.ok).toBe(true);
    expect(r.count).toBe(0);
    expect(r.summary).toMatch(/Nothing on your calendar today/);
  });
});

describe('calendar_next', () => {
  it('returns the soonest future event', async () => {
    const soon = new Date(Date.now() + 3600_000).toISOString();
    calendarEventsRef.value = [{ title: 'Dentist', startTime: soon, isAllDay: false }];
    const r = await dispatchTool('calendar_next', {});
    expect(r.ok).toBe(true);
    expect(r.found).toBe(true);
    expect(r.title).toBe('Dentist');
    expect(r.summary).toMatch(/Next up: Dentist/);
  });

  it('reports nothing upcoming when the list is empty', async () => {
    calendarEventsRef.value = [];
    const r = await dispatchTool('calendar_next', {});
    expect(r.ok).toBe(true);
    expect(r.found).toBe(false);
    expect(r.summary).toMatch(/Nothing coming up/);
  });

  it('returns an in-progress meeting (started before now, ends after) as "next"', async () => {
    // A meeting that's currently happening must count — startTime is in the
    // past but endTime is in the future, matching calendarSync's range.
    const startedAgo = new Date(Date.now() - 1800_000).toISOString();
    const endsSoon = new Date(Date.now() + 1800_000).toISOString();
    calendarEventsRef.value = [{ title: 'Standup (in progress)', startTime: startedAgo, endTime: endsSoon, isAllDay: false }];
    const r = await dispatchTool('calendar_next', {});
    expect(r.found).toBe(true);
    expect(r.title).toBe('Standup (in progress)');
  });

  it('returns an all-day event occurring today (start at past midnight, end later today)', async () => {
    // All-day events begin at local midnight (already past mid-day), but with an
    // endTime later today they must still surface as "next".
    const pastMidnight = new Date(Date.now() - 8 * 3600_000).toISOString();
    const endOfDay = new Date(Date.now() + 8 * 3600_000).toISOString();
    calendarEventsRef.value = [{ title: 'Conference Day', startTime: pastMidnight, endTime: endOfDay, isAllDay: true }];
    const r = await dispatchTool('calendar_next', {});
    expect(r.found).toBe(true);
    expect(r.title).toBe('Conference Day');
    expect(r.allDay).toBe(true);
  });
});

describe('anchorLocalMidnightUtc (DST-safe local-midnight anchor)', () => {
  it('subtracts the constant offset off the naive UTC parse', () => {
    // Both passes see the mocked -7h (PDT) offset → local midnight is +7h of the
    // naive UTC parse of the day string (PDT midnight = 07:00 UTC).
    const naive = Date.parse('2026-04-17T00:00:00Z');
    expect(anchorLocalMidnightUtc('2026-04-17', 'America/Los_Angeles'))
      .toBe(naive + 7 * 3600 * 1000);
  });

  it('uses the offset evaluated AT the target midnight, not the first guess', () => {
    // Simulate a DST boundary: the offset at the naive-parse instant differs
    // from the offset at the refined candidate instant. The returned anchor must
    // use the SECOND (refined) offset, proving the two-pass convergence.
    const naive = Date.parse('2026-03-08T00:00:00Z');
    mockedGetUtcOffsetMs
      .mockImplementationOnce(() => -8 * 3600 * 1000)  // first pass: PST
      .mockImplementationOnce(() => -7 * 3600 * 1000); // refined: PDT
    expect(anchorLocalMidnightUtc('2026-03-08', 'America/Los_Angeles'))
      .toBe(naive + 7 * 3600 * 1000); // refined offset wins
    mockedGetUtcOffsetMs.mockReturnValue(-7 * 3600 * 1000); // restore default
  });
});

describe('meatspace_log_workout', () => {
  it('rejects missing type', async () => {
    await expect(dispatchTool('meatspace_log_workout', {})).rejects.toThrow(/type is required/);
  });
  it('rejects absurd duration', async () => {
    await expect(dispatchTool('meatspace_log_workout', { type: 'run', durationMinutes: 5000 }))
      .rejects.toThrow(/durationMinutes must be a positive number/);
  });
  it('rejects invalid intensity', async () => {
    await expect(dispatchTool('meatspace_log_workout', { type: 'run', intensity: 'extreme' }))
      .rejects.toThrow(/intensity must be/);
  });
  it('logs a workout via addWorkout', async () => {
    addWorkoutMock.mockClear();
    const r = await dispatchTool('meatspace_log_workout', { type: 'yoga', durationMinutes: 30, intensity: 'moderate' });
    expect(r.ok).toBe(true);
    expect(r.type).toBe('yoga');
    expect(addWorkoutMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'yoga', durationMinutes: 30, intensity: 'moderate' }));
    expect(r.summary).toMatch(/Logged yoga \(30 min\)/);
  });
});

describe('weather_now', () => {
  it('returns temperature + mapped conditions', async () => {
    weatherFetchRef.value = { ok: true, json: async () => ({ current: { temperature_2m: 71.4, weather_code: 3 } }) };
    const r = await dispatchTool('weather_now', { lat: 40, lon: -74 });
    expect(r.ok).toBe(true);
    expect(r.temperatureF).toBe(71);
    expect(r.conditions).toBe('overcast');
    expect(r.summary).toMatch(/71°F and overcast/);
  });
  it('rejects out-of-range coordinates', async () => {
    const r = await dispatchTool('weather_now', { lat: 200, lon: 0 });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/Latitude must be/);
  });
  it('handles an unreachable weather service', async () => {
    weatherFetchRef.value = { ok: false };
    const r = await dispatchTool('weather_now', { lat: 1, lon: 1 });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/Couldn't reach the weather service/);
  });
});

describe('timer_set', () => {
  it('rejects a missing/zero duration', async () => {
    const r = await dispatchTool('timer_set', { label: 'tea' });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/Tell me how long/);
  });
  it('rejects durations over 24 hours', async () => {
    const r = await dispatchTool('timer_set', { minutes: 2000 });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/capped at 24 hours/);
  });
  it('sets a timer and schedules a notification', async () => {
    vi.useFakeTimers();
    addNotificationMock.mockClear();
    const r = await dispatchTool('timer_set', { minutes: 10, label: 'call mom' });
    expect(r.ok).toBe(true);
    expect(r.durationMs).toBe(600000);
    expect(r.summary).toMatch(/Timer set for 10 minutes/);
    await vi.advanceTimersByTimeAsync(600000);
    expect(addNotificationMock).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringMatching(/call mom/) }));
    vi.useRealTimers();
  });
});

describe('ui_describe_visually', () => {
  it('fails gracefully without a screenshot channel', async () => {
    const r = await dispatchTool('ui_describe_visually', { question: 'what is this?' }, { sideEffects: [] });
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/can't capture the screen/);
  });
  it('returns null-capture as a friendly failure', async () => {
    const ctx = { sideEffects: [], captureScreenshot: async () => null, describeImage: async () => 'x' };
    const r = await dispatchTool('ui_describe_visually', {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/couldn't capture the screen/i);
  });
  it('captures + describes the screen and returns the description', async () => {
    const ctx = {
      sideEffects: [],
      state: { ui: { path: '/cybercity' } },
      captureScreenshot: async () => 'data:image/jpeg;base64,abc',
      describeImage: async (dataUrl, prompt) => {
        expect(dataUrl).toBe('data:image/jpeg;base64,abc');
        expect(prompt).toMatch(/chart/i);
        return 'A neon skyline with three towers.';
      },
    };
    const r = await dispatchTool('ui_describe_visually', { question: 'what is on this chart?' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.content).toBe('A neon skyline with three towers.');
    expect(r.path).toBe('/cybercity');
  });
  it('surfaces a vision-model error', async () => {
    const ctx = {
      sideEffects: [],
      captureScreenshot: async () => 'data:image/jpeg;base64,abc',
      describeImage: async () => { throw new Error('model offline'); },
    };
    const r = await dispatchTool('ui_describe_visually', {}, ctx);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/model offline/);
  });
});

describe('new tool intent routing', () => {
  it('routes calendar utterances to the calendar group', () => {
    expect(classifyIntent("what's on my calendar today?").has('calendar')).toBe(true);
    expect(classifyIntent("what's my next meeting?").has('calendar')).toBe(true);
    expect(classifyIntent('any appointments today').has('calendar')).toBe(true);
  });
  it('routes weather utterances to the weather group', () => {
    expect(classifyIntent("what's the weather?").has('weather')).toBe(true);
    expect(classifyIntent('is it raining outside').has('weather')).toBe(true);
  });
  it('routes timer utterances to the timer group', () => {
    expect(classifyIntent('set a timer for 10 minutes').has('timer')).toBe(true);
    expect(classifyIntent('remind me in 30 minutes to call mom').has('timer')).toBe(true);
  });
  it('routes workout utterances to the meatspace group', () => {
    expect(classifyIntent('log a workout').has('meatspace')).toBe(true);
    expect(classifyIntent('I went for a run').has('meatspace')).toBe(true);
    expect(classifyIntent('went for a 30 minute run').has('meatspace')).toBe(true);
    expect(classifyIntent('I ran a 5k this morning').has('meatspace')).toBe(true);
    expect(classifyIntent('ran 3 miles before work').has('meatspace')).toBe(true);
    expect(classifyIntent('ran a marathon yesterday').has('meatspace')).toBe(true);
    expect(classifyIntent('ran my usual route').has('meatspace')).toBe(true);
    expect(classifyIntent('ran for 30 minutes').has('meatspace')).toBe(true);
    expect(classifyIntent('ran for an hour').has('meatspace')).toBe(true);
    expect(classifyIntent('did some cardio at the gym').has('meatspace')).toBe(true);
  });
  it('does NOT route command phrasings of run/ran to the meatspace group', () => {
    // Bare run/ran collide with common commands — must not expose the workout tool.
    // The "ran …" branch requires a fitness object (distance/route/duration), so
    // these non-fitness "ran a/an/my X" phrasings must NOT match.
    expect(classifyIntent('run the pipeline render').has('meatspace')).toBe(false);
    expect(classifyIntent('I ran the report again').has('meatspace')).toBe(false);
    expect(classifyIntent('run it one more time').has('meatspace')).toBe(false);
    expect(classifyIntent('I ran a report').has('meatspace')).toBe(false);
    expect(classifyIntent('ran an errand').has('meatspace')).toBe(false);
    expect(classifyIntent('ran my mouth').has('meatspace')).toBe(false);
    expect(classifyIntent('ran for office').has('meatspace')).toBe(false);
    // The duration branch requires a real time unit — "for a/the X" without a
    // minute/hour/second unit must NOT route to the workout tool.
    expect(classifyIntent('ran for a report').has('meatspace')).toBe(false);
    expect(classifyIntent('ran for president').has('meatspace')).toBe(false);
  });
  it('routes visual-description utterances to the vision group', () => {
    expect(classifyIntent("what's on this chart?").has('vision')).toBe(true);
    expect(classifyIntent('describe the cybercity').has('vision')).toBe(true);
  });
});

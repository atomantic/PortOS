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
vi.mock('../meatspaceHealth.js', () => ({
  addBodyEntry: vi.fn(async () => ({ date: '2026-04-17' })),
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
const generateImageMock = vi.fn(async (params) => ({
  filename: 'mock.png', path: '/data/images/mock.png', mode: params?.mode || 'external',
}));
const codexEnabledRef = { value: false };
vi.mock('../imageGen/index.js', () => ({
  generateImage: (...args) => generateImageMock(...args),
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

const { dispatchTool, getToolSpecs, getToolSpecsForIntent, classifyIntent } = await import('./tools.js');

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
});

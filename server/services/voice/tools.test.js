import { describe, it, expect, vi, beforeEach } from 'vitest';

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
}));

const { dispatchTool, getToolSpecs } = await import('./tools.js');

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

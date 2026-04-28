import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub voice tool side-effects — the palette dispatches them, but we only
// want to verify routing and whitelisting here.
vi.mock('../services/brain.js', () => ({
  captureThought: vi.fn(async () => ({ inboxLog: { id: 'inbox-1' }, message: 'ok' })),
  getInboxLog: vi.fn(async () => []),
}));
vi.mock('../services/meatspaceAlcohol.js', () => ({
  logDrink: vi.fn(async () => ({ standardDrinks: 1, dayTotal: 1 })),
  getAlcoholSummary: vi.fn(async () => ({ today: 0 })),
}));
vi.mock('../services/meatspaceNicotine.js', () => ({
  logNicotine: vi.fn(async () => ({ totalMg: 1, dayTotal: 1 })),
  getNicotineSummary: vi.fn(async () => ({ today: 0 })),
}));
vi.mock('../services/meatspaceHealth.js', () => ({
  addBodyEntry: vi.fn(async () => ({ date: '2026-04-24' })),
}));
vi.mock('../services/identity.js', () => ({
  getGoals: vi.fn(async () => ({ goals: [] })),
  updateGoalProgress: vi.fn(async () => {}),
  addProgressEntry: vi.fn(async () => {}),
}));
vi.mock('../services/pm2.js', () => ({
  listProcesses: vi.fn(async () => [{ name: 'api', status: 'online', restarts: 0 }]),
  restartApp: vi.fn(async () => {}),
}));
vi.mock('../services/feeds.js', () => ({
  getItems: vi.fn(async () => []),
  getFeeds: vi.fn(async () => []),
}));
vi.mock('../services/askService.js', () => ({
  VALID_MODES: new Set(['ask', 'advise', 'draft']),
  runAsk: vi.fn(async function* () {
    yield { type: 'sources', sources: [{ kind: 'memory', title: 'A note' }] };
    yield {
      type: 'done',
      answer: 'Here is the answer.',
      sources: [{ kind: 'memory', title: 'A note' }],
      providerId: 'p1',
      model: 'm1',
    };
  }),
}));

const { default: paletteRoutes } = await import('./palette.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/palette', paletteRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('GET /api/palette/manifest', () => {
  it('returns nav commands and palette-safe actions', async () => {
    const res = await request(makeApp()).get('/api/palette/manifest');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.nav)).toBe(true);
    expect(Array.isArray(res.body.actions)).toBe(true);
    expect(res.body.nav.length).toBeGreaterThan(50);

    // Every nav entry is fully formed — the client fuzzy-matches on these.
    for (const cmd of res.body.nav) {
      expect(cmd.id).toBeTruthy();
      expect(cmd.path).toMatch(/^\//);
      expect(cmd.label).toBeTruthy();
      expect(cmd.section).toBeTruthy();
    }

    // Action descriptions hydrate from the voice tool registry, proving the
    // DRY link between voice schema and palette metadata.
    const brainCapture = res.body.actions.find((a) => a.id === 'brain_capture');
    expect(brainCapture).toBeTruthy();
    expect(brainCapture.description).toMatch(/capture/i);
    expect(brainCapture.parameters?.properties?.text).toBeTruthy();
  });

  it('excludes ui_* tools (only runnable inside voice DOM context)', async () => {
    const res = await request(makeApp()).get('/api/palette/manifest');
    const ids = res.body.actions.map((a) => a.id);
    expect(ids).not.toContain('ui_click');
    expect(ids).not.toContain('ui_fill');
    expect(ids).not.toContain('ui_navigate');
  });
});

describe('POST /api/palette/action/:id', () => {
  it('dispatches a whitelisted action and returns its result', async () => {
    const res = await request(makeApp())
      .post('/api/palette/action/brain_capture')
      .send({ args: { text: 'remember to drink water' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.id).toBe('inbox-1');
    expect(res.body.result.summary).toMatch(/Captured/);
  });

  it('rejects unknown action ids', async () => {
    const res = await request(makeApp())
      .post('/api/palette/action/unknown_tool')
      .send({ args: {} });
    expect(res.status).toBe(404);
  });

  it('rejects non-whitelisted voice tools even if they exist', async () => {
    // ui_click is a real voice tool but intentionally not in the palette
    // whitelist — the palette has no DOM context to drive.
    const res = await request(makeApp())
      .post('/api/palette/action/ui_click')
      .send({ args: { label: 'Save' } });
    expect(res.status).toBe(404);
  });

  it('exposes ui_ask in the manifest with description hydrated from voice tools', async () => {
    const res = await request(makeApp()).get('/api/palette/manifest');
    const askAction = res.body.actions.find((a) => a.id === 'ui_ask');
    expect(askAction).toBeTruthy();
    expect(askAction.label).toBe('Ask Yourself');
    expect(askAction.section).toBe('Ask');
    expect(askAction.description).toMatch(/digital twin|retrieval/i);
    expect(askAction.parameters?.properties?.question).toBeTruthy();
  });

  it('dispatches ui_ask through the palette and returns the answer + sources', async () => {
    const res = await request(makeApp())
      .post('/api/palette/action/ui_ask')
      .send({ args: { question: 'what did I decide about exercise?' } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.content).toBe('Here is the answer.');
    expect(res.body.result.sourceCount).toBe(1);
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-deck-chiptune-authority-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());

// Mount the production Decks and Tracks routers behind the real gates. Only
// persistence, provider, queue and app-file effects are doubled (#10893).
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));

const deckId = '00000000-0000-4000-8000-000000000001';
const cardId = '00000000-0000-4000-8000-000000000002';
vi.mock('../services/decks.js', () => ({
  listDecks: vi.fn(async () => []),
  getDeck: vi.fn(async () => ({
    id: '00000000-0000-4000-8000-000000000001',
    cards: [{ id: '00000000-0000-4000-8000-000000000002', key: 'example-card', prompt: '' }],
  })),
  applyCardGenerations: vi.fn(async () => 1),
}));
vi.mock('../services/deckStyleAnalysis.js', () => ({
  analyzeDeckSample: vi.fn(async () => ({ proposal: {} })),
}));
vi.mock('../services/deckPrompts.js', () => ({
  PROMPTS_PER_CALL: 16,
  castDeckFromUniverse: vi.fn(async () => ({ assignments: [] })),
  generateDeckCardPrompts: vi.fn(async () => ({ llm: {} })),
}));
vi.mock('../services/deckRender.js', () => ({
  renderDeckCards: vi.fn(async () => ({ queued: 1 })),
}));
vi.mock('../services/deckPromptProgress.js', () => ({
  attachClient: vi.fn(),
  beginPromptProgress: vi.fn(() => true),
  emitPromptProgress: vi.fn(),
  finishPromptProgress: vi.fn(),
}));
vi.mock('./universeBuilder/shared.js', () => ({
  resolveGalleryImageOrThrow: vi.fn((name) => ({ imageFilename: name, imagePath: `/example/${name}` })),
}));

vi.mock('../services/tracks/index.js', async () => ({
  ...await import('../services/tracks/logic.js'),
  getTrack: vi.fn(async (id) => ({ id })),
}));
vi.mock('../services/pipeline/musicLibrary.js', () => ({ MUSIC_UPLOAD_MAX_BYTES: 1024 }));
vi.mock('../services/trackAudioAttach.js', () => ({}));
vi.mock('../services/trackAlbumMembership.js', () => ({}));
vi.mock('../services/trackYoutubeImport.js', () => ({}));
vi.mock('../services/trackSunoImport.js', () => ({}));
vi.mock('../services/musicWaveform.js', () => ({}));
vi.mock('../services/musicCode.js', () => ({}));
vi.mock('../services/chiptune.js', () => ({
  generateChiptuneScore: vi.fn(async () => ({ track: {} })),
  renderChiptuneTrack: vi.fn(async () => ({ track: {} })),
  publishChiptuneTrack: vi.fn(async () => ({ published: true })),
}));

import decksRoutes from './decks.js';
import tracksRoutes from './tracks.js';
import { analyzeDeckSample } from '../services/deckStyleAnalysis.js';
import { generateDeckCardPrompts } from '../services/deckPrompts.js';
import { renderDeckCards } from '../services/deckRender.js';
import { generateChiptuneScore, renderChiptuneTrack, publishChiptuneTrack } from '../services/chiptune.js';

// The refusal/principal matrix lives in services/authGate.test.js and
// hostControlCoverage.test.js; backend choice never changes authority, so each
// route keeps one refusal-or-allow case, not one per provider or render mode.
const mounts = [['/api/decks', decksRoutes], ['/api/tracks', tracksRoutes]];
const cliPick = { providerId: 'example-cli-provider', model: 'example-model' };
const workflows = [
  ['post', `/api/decks/${deckId}/analyze-sample`, { image: 'example.png', ...cliPick }, analyzeDeckSample, 200],
  ['post', `/api/decks/${deckId}/generate-prompts`, { ...cliPick }, generateDeckCardPrompts, 200],
  ['post', `/api/decks/${deckId}/render`, { mode: 'grok' }, renderDeckCards, 200],
  ['post', `/api/decks/${deckId}/cards/${cardId}/render`, { mode: 'codex' }, renderDeckCards, 200],
  ['post', `/api/tracks/${deckId}/chiptune/generate`, { prompt: 'Example tune', ...cliPick }, generateChiptuneScore, 200],
  ['post', `/api/tracks/${deckId}/chiptune/render`, {}, renderChiptuneTrack, 200],
  ['post', `/api/tracks/${deckId}/chiptune/publish`, { appId: 'example-app' }, publishChiptuneTrack, 200],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Deck and chiptune writes behind the default-deny gate (#10893, #16114)', () => {
  it('refuses a remote caller before body validation and any provider, store or app-file effect', async () => {
    const [method, path, body, effect] = workflows[0];
    await expectRemoteRefusal(mounts, [method, path, { ...body, unexpected: true }, effect]);
  });

  it('still runs every deck and chiptune write for a local operator and an agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    expect(analyzeDeckSample.mock.calls.map(([args]) => args.providerId)).toEqual(Array(2).fill(cliPick.providerId));
    expect(renderDeckCards.mock.calls.map(([, options]) => options.mode)).toEqual(['grok', 'codex', 'grok', 'codex']);
  });
});

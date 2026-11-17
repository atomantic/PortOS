import { EventEmitter } from 'node:events';
import { afterAll, beforeEach, describe, it as vitestIt, vi } from 'vitest';
import { expectAuthorizedWorkflows, expectRemoteRefusal } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy, ownTestBodies } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-telegram-authority-') }));
const owned = ownTestBodies(vitestIt);
const it = owned.it;
afterAll(async () => {
  try { await owned.drain(); } finally { cleanupTempDataRoots(); }
});

const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));

let currentSettings = {
  telegram: { method: 'manual', chatId: '12345678', forwardTypes: ['health_issue'] },
  secrets: { telegram: { token: 'existing-secret-token' } },
};

vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => currentSettings),
  updateSettingsWith: vi.fn(async (updater) => {
    currentSettings = updater(currentSettings);
    return currentSettings;
  }),
}));

const telegramEffects = vi.hoisted(() => ({
  init: vi.fn(async () => {}),
  getStatus: vi.fn(() => ({ connected: true, botUsername: 'PortOS_bot' })),
  cleanup: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => ({ success: true })),
  updateCachedForwardTypes: vi.fn(),
}));
vi.mock('../services/telegram.js', () => telegramEffects);

const bridgeEffects = vi.hoisted(() => ({
  init: vi.fn(async () => true),
  getStatus: vi.fn(() => ({ connected: true, hasBotToken: true, hasChatId: true, bridgeStatus: 'connected' })),
  cleanup: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => ({ success: true })),
  updateCachedForwardTypes: vi.fn(),
}));
vi.mock('../services/telegramBridge.js', () => bridgeEffects);

import telegramRoutes from './telegram.js';

// Telegram writes are plain writes under the default-deny gate (#16018, #11431);
// the principal matrix lives in services/authGate.test.js. This suite keeps one
// remote refusal for the message-sending route and one authorized workflow per
// route for a local operator and a delegated agent session.
const mounts = [['/api/telegram', telegramRoutes]];

describe('Telegram bot and bridge operator authority', () => {
  beforeEach(async () => {
    await owned.drain();
    vi.clearAllMocks();
    auth.enabled = false;
    currentSettings = {
      telegram: { method: 'manual', chatId: '12345678', forwardTypes: ['health_issue'] },
      secrets: { telegram: { token: 'existing-secret-token' } },
    };
  });

  it('refuses a remote caller before the bot sends', async () => {
    await expectRemoteRefusal(mounts, ['post', '/api/telegram/test', { message: 'Test message' }, telegramEffects.sendMessage]);
  });

  it('preserves local and delegated-agent Telegram operations', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['put', '/api/telegram/config', { token: 'new-token', chatId: '87654321' }, telegramEffects.init, 200],
      ['post', '/api/telegram/test', { message: 'Hello from test' }, telegramEffects.sendMessage, 200],
      ['put', '/api/telegram/method', { method: 'mcp-bridge' }, bridgeEffects.init, 200],
      ['delete', '/api/telegram/config', {}, bridgeEffects.cleanup, 200],
    ] });
  });
});

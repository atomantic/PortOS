import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getPersistentMind: vi.fn(),
  sendPersistentMindMessage: vi.fn(),
  uploadPersistentMindAttachment: vi.fn(),
  deletePersistentMindAttachment: vi.fn(),
  addPersistentMindAnnotation: vi.fn(),
  startPersistentMind: vi.fn(),
  pausePersistentMind: vi.fn(),
  resumePersistentMind: vi.fn(),
  stopPersistentMind: vi.fn(),
  acknowledgePersistentMindEvent: vi.fn(),
  promotePersistentMindEvent: vi.fn(),
  getProviders: vi.fn(),
  updateCosConfig: vi.fn(),
  getPersistentMindContext: vi.fn(),
  getPersistentMindTools: vi.fn(),
  getPersistentMindRuntime: vi.fn(),
  getPersistentMindVisibility: vi.fn(),
  createPersistentMindMemory: vi.fn(),
  updatePersistentMindMemory: vi.fn(),
  cleanupPersistentMind: vi.fn(),
}));

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    off: vi.fn((event) => handlers.delete(event)),
    emit: vi.fn(),
    reset: () => handlers.clear(),
  };
});
const localLlm = vi.hoisted(() => ({
  getLocalLlmStatus: vi.fn(),
  getToolUseModels: vi.fn(),
}));

vi.mock('../../../services/api', () => api);
vi.mock('../../../services/apiLocalLlm', () => localLlm);
vi.mock('../../../hooks/useSocket', () => ({ useSocket: () => socket }));

import MindTab from './MindTab';

const DEEP_PRESET = {
  id: 'deep-think',
  label: 'Deep think',
  providerId: 'example-cloud',
  model: 'example-large',
  effort: 'high',
};

const runtime = {
  observedAt: '2026-09-01T12:00:00.000Z',
  inference: { active: false, providerId: 'local-llm', model: 'example-small', residency: { status: 'provider-managed', backend: null, loaded: null, memoryBytes: null } },
  context: { chars: 19, maxChars: 32_000, approximateTokens: 5, summaryState: 'empty', memoryCount: 0 },
  system: {
    memory: { total: 8 * 1024 ** 3, used: 4 * 1024 ** 3, free: 4 * 1024 ** 3, usagePercent: 50 },
    process: { rss: 1, heapUsed: 1, heapTotal: 2 },
    cpu: { cores: 8, loadAvg1m: 1 },
  },
};

const response = (overrides = {}) => ({
  events: [],
  cursor: null,
  gap: false,
  hasMore: false,
  truncated: false,
  turnExecutions: [],
  state: {
    enabled: true,
    started: true,
    status: 'waiting',
    pauseReason: null,
    queuedMessageCount: 0,
    queuedTemporaryMessageCount: 0,
    activeTurnId: null,
    activeRoute: null,
    activeThinkingSession: null,
  },
  profile: { enabled: true, providerId: 'local-llm', model: 'example-small', effort: '', thinkingInterface: 'text', wakeIntervalMinutes: 30 },
  thinkingPresets: { schemaVersion: 1, presets: [DEEP_PRESET] },
  capabilities: { schemaVersion: 3, createTasks: false, manageMind: false, readPortos: false, writePortos: false },
  imageCapability: { status: 'supported', guidance: null },
  autonomyMode: 'execute',
  ...overrides,
});

const renderTab = (path = '/cos/mind') => render(
  <MemoryRouter initialEntries={[path]}>
    <MindTab />
  </MemoryRouter>
);

const composerLoaded = async () => {
  await waitFor(() => expect(screen.getByLabelText('Send with another model')).toBeTruthy());
};

describe('MindTab temporary thinking sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socket.reset();
    api.getPersistentMind.mockResolvedValue(response());
    api.sendPersistentMindMessage.mockResolvedValue({ success: true, duplicate: false });
    api.pausePersistentMind.mockResolvedValue({ success: true });
    api.getPersistentMindRuntime.mockResolvedValue(runtime);
    api.getPersistentMindVisibility.mockResolvedValue({
      schemaVersion: 1, capturedAt: '2026-09-01T12:00:00.000Z',
      freshness: { state: 'fresh', ageMs: 0, ttlMs: 30_000 }, readiness: 'ready', truncated: false, workspaces: [],
    });
    api.getProviders.mockResolvedValue({
      activeProvider: 'local-llm',
      providers: [
        { id: 'local-llm', name: 'Local LLM', enabled: true, type: 'api', endpoint: 'http://127.0.0.1:11434', models: ['example-small'] },
        { id: 'example-cloud', name: 'Example Cloud', enabled: true, type: 'api', hasApiKey: true, models: ['example-large'] },
      ],
    });
    api.updateCosConfig.mockResolvedValue({ success: true });
    localLlm.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    localLlm.getToolUseModels.mockResolvedValue({ models: [] });
  });

  it('previews the exact borrowed route without making any execution call', async () => {
    const user = userEvent.setup();
    renderTab();
    await composerLoaded();

    await user.selectOptions(screen.getByLabelText('Send with another model'), 'deep-think');

    await waitFor(() => expect(screen.getByText('This one message runs on Deep think')).toBeTruthy());
    expect(screen.getAllByText('Example Cloud / example-large · high').length).toBeGreaterThan(0);
    // Account-backed routing is named, and nothing has run.
    expect(screen.getAllByText('Account-backed').length).toBeGreaterThan(0);
    expect(api.sendPersistentMindMessage).not.toHaveBeenCalled();
    expect(api.startPersistentMind).not.toHaveBeenCalled();
    expect(api.resumePersistentMind).not.toHaveBeenCalled();
  });

  it('keeps a paused mind paused while previewing, and says the message will queue', async () => {
    const user = userEvent.setup();
    api.getPersistentMind.mockResolvedValue(response({
      state: { ...response().state, status: 'paused', pauseReason: 'Paused by user' },
    }));
    renderTab();
    await composerLoaded();

    await user.selectOptions(screen.getByLabelText('Send with another model'), 'deep-think');

    await waitFor(() => expect(screen.getByText(/The mind is paused\./)).toBeTruthy());
    expect(api.resumePersistentMind).not.toHaveBeenCalled();
    expect(api.startPersistentMind).not.toHaveBeenCalled();
    expect(api.sendPersistentMindMessage).not.toHaveBeenCalled();
  });

  it('submits the displayed selection for one message and then returns to the default', async () => {
    const user = userEvent.setup();
    renderTab();
    await composerLoaded();

    await user.selectOptions(screen.getByLabelText('Send with another model'), 'deep-think');
    await user.type(screen.getByLabelText('Message'), 'Reason carefully.');
    await user.click(screen.getByRole('button', { name: 'Send with Deep think' }));

    await waitFor(() => expect(api.sendPersistentMindMessage).toHaveBeenCalledTimes(1));
    const [body] = api.sendPersistentMindMessage.mock.calls[0];
    expect(body.thinkingPresetId).toBe('deep-think');
    expect(body.thinkingPreset).toEqual(DEEP_PRESET);

    // Acceptance clears the composer: the very next message is an ordinary one.
    await waitFor(() => expect(screen.getByLabelText('Send message')).toBeTruthy());
    await user.type(screen.getByLabelText('Message'), 'And now normally.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(api.sendPersistentMindMessage).toHaveBeenCalledTimes(2));
    const [second] = api.sendPersistentMindMessage.mock.calls[1];
    expect(second.thinkingPresetId).toBeUndefined();
    expect(second.thinkingPreset).toBeUndefined();
  });

  it('refuses to send a selection the saved list no longer contains', async () => {
    const user = userEvent.setup();
    renderTab('/cos/mind?preset=removed-preset');
    await composerLoaded();

    await waitFor(() => expect(screen.getByText(/no longer saved/)).toBeTruthy());
    await user.type(screen.getByLabelText('Message'), 'Should not be sent on a substitute.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(screen.getByText(/That thinking preset is no longer saved/)).toBeTruthy());
    expect(api.sendPersistentMindMessage).not.toHaveBeenCalled();
  });

  it('retries a failed send with the same id and the same route', async () => {
    const user = userEvent.setup();
    api.sendPersistentMindMessage.mockRejectedValueOnce(new Error('Network unavailable'));
    renderTab();
    await composerLoaded();

    await user.selectOptions(screen.getByLabelText('Send with another model'), 'deep-think');
    await user.type(screen.getByLabelText('Message'), 'Reason carefully.');
    await user.click(screen.getByRole('button', { name: 'Send with Deep think' }));

    await waitFor(() => expect(screen.getByText(/Network unavailable/)).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(api.sendPersistentMindMessage).toHaveBeenCalledTimes(2));
    const [first] = api.sendPersistentMindMessage.mock.calls[0];
    const [second] = api.sendPersistentMindMessage.mock.calls[1];
    expect(second.id).toBe(first.id);
    expect(second.thinkingPreset).toEqual(first.thinkingPreset);
  });

  it('retires the frozen route when Return to default is used after a failed send', async () => {
    const user = userEvent.setup();
    api.sendPersistentMindMessage.mockRejectedValueOnce(new Error('Network unavailable'));
    renderTab();
    await composerLoaded();

    await user.selectOptions(screen.getByLabelText('Send with another model'), 'deep-think');
    await user.type(screen.getByLabelText('Message'), 'Reason carefully.');
    await user.click(screen.getByRole('button', { name: 'Send with Deep think' }));
    await waitFor(() => expect(screen.getByText(/Network unavailable/)).toBeTruthy());

    // The route panel's Return to default must retire the frozen draft route,
    // not merely drop the URL param — otherwise the retry below re-submits the
    // paid route the user just stepped away from, under the reused id.
    const panel = screen.getByRole('region', { name: 'Thinking route' });
    await user.click(within(panel).getByRole('button', { name: /Return to default/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(api.sendPersistentMindMessage).toHaveBeenCalledTimes(2));
    const [first] = api.sendPersistentMindMessage.mock.calls[0];
    const [second] = api.sendPersistentMindMessage.mock.calls[1];
    expect(second.thinkingPresetId).toBeUndefined();
    expect(second.thinkingPreset).toBeUndefined();
    // A different route is a different request, so it cannot wear the same key.
    expect(second.id).not.toBe(first.id);
  });

  it('warns that an in-flight session will be refused once its preset is deleted', async () => {
    api.getPersistentMind.mockResolvedValue(response({
      thinkingPresets: { schemaVersion: 1, presets: [] },
      state: {
        ...response().state,
        status: 'thinking',
        activeTurnId: 'turn-1',
        activeRoute: { providerId: 'example-cloud', model: 'example-large', effort: 'high' },
        activeThinkingSession: {
          presetId: 'deep-think', label: 'Deep think', providerId: 'example-cloud', model: 'example-large', effort: 'high', resolvable: true,
        },
      },
    }));
    renderTab();

    const panel = await screen.findByRole('region', { name: 'Thinking route' });
    await waitFor(() => expect(within(panel).getByText(/has been removed since this message was accepted/)).toBeTruthy());
  });

  it('shows the actual running route beside the default and cancels through the lifecycle API', async () => {
    const user = userEvent.setup();
    api.getPersistentMind.mockResolvedValue(response({
      state: {
        ...response().state,
        status: 'thinking',
        activeTurnId: 'turn-1',
        activeRoute: { providerId: 'example-cloud', model: 'example-large', effort: 'high' },
        activeThinkingSession: {
          presetId: 'deep-think', label: 'Deep think', providerId: 'example-cloud', model: 'example-large', effort: 'high', resolvable: true,
        },
      },
    }));
    renderTab();

    const panel = await screen.findByRole('region', { name: 'Thinking route' });
    await waitFor(() => expect(within(panel).getByText('Local LLM / example-small')).toBeTruthy());
    expect(within(panel).getByText('Example Cloud / example-large · high')).toBeTruthy();
    expect(within(panel).getByText(/Borrowing/)).toBeTruthy();

    await user.click(within(panel).getByRole('button', { name: /Cancel this session/ }));
    await waitFor(() => expect(api.pausePersistentMind).toHaveBeenCalledTimes(1));
  });

  it('saves a new preset as a whole-list replacement without running anything', async () => {
    const user = userEvent.setup();
    renderTab('/cos/mind?panel=models&presetEdit=new');

    await waitFor(() => expect(screen.getByLabelText('Preset name')).toBeTruthy());
    await user.type(screen.getByLabelText('Preset name'), 'Fast local');
    await user.selectOptions(screen.getByLabelText('AI provider'), 'local-llm');
    await user.selectOptions(screen.getByLabelText('Model'), 'example-small');
    await user.click(screen.getByRole('button', { name: /Add preset/ }));

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledTimes(1));
    const [config] = api.updateCosConfig.mock.calls[0];
    expect(config.persistentMindThinkingPresets.presets).toEqual([
      DEEP_PRESET,
      { id: 'fast-local', label: 'Fast local', providerId: 'local-llm', model: 'example-small', effort: '' },
    ]);
    // Saving a route is inert: it never wakes, resumes, or sends anything.
    expect(api.startPersistentMind).not.toHaveBeenCalled();
    expect(api.resumePersistentMind).not.toHaveBeenCalled();
    expect(api.sendPersistentMindMessage).not.toHaveBeenCalled();
  });

  it('removes a preset by replacing the list, never by merging a deletion', async () => {
    const user = userEvent.setup();
    renderTab('/cos/mind?panel=models');

    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Deep think' })).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Remove Deep think' }));

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledTimes(1));
    expect(api.updateCosConfig.mock.calls[0][0].persistentMindThinkingPresets.presets).toEqual([]);
  });

  it('deep-links one session receipt and reports unreported usage as unknown', async () => {
    api.getPersistentMind.mockResolvedValue(response({
      turnExecutions: [{
        turnId: 'turn-1',
        status: 'completed',
        startedAt: '2026-09-01T12:00:00.000Z',
        completedAt: '2026-09-01T12:00:03.000Z',
        providerId: 'example-cloud',
        model: 'example-large',
        effort: 'high',
        thinkingPresetId: 'deep-think',
        calls: [{
          eventId: 'call-1',
          at: '2026-09-01T12:00:00.000Z',
          purpose: 'turn',
          round: 0,
          runId: 'run-1',
          providerId: 'example-cloud',
          model: 'example-large',
          effort: 'high',
          thinkingPresetId: 'deep-think',
          thinkingPresetLabel: 'Deep think',
          temporaryRoute: true,
          elapsedMs: 3_000,
          outcome: 'completed',
          reason: null,
          usage: { state: 'unknown', source: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
        }],
      }],
    }));
    renderTab('/cos/mind?panel=models&turn=turn-1');

    await waitFor(() => expect(screen.getByText('Session provenance')).toBeTruthy());
    expect(screen.getByText('Run run-1')).toBeTruthy();
    expect(screen.getByText(/Usage unknown/)).toBeTruthy();
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
  });
});

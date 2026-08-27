import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getPersistentMind: vi.fn(),
  sendPersistentMindMessage: vi.fn(),
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
  getPersistentMindRuntime: vi.fn(),
  createPersistentMindMemory: vi.fn(),
  updatePersistentMindMemory: vi.fn(),
}));

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: vi.fn((event, handler) => handlers.set(event, handler)),
    off: vi.fn((event) => handlers.delete(event)),
    emitServer: (event, data) => handlers.get(event)?.(data),
    reset: () => handlers.clear(),
  };
});

vi.mock('../../../services/api', () => api);
vi.mock('../../../hooks/useSocket', () => ({ useSocket: () => socket }));

import MindTab from './MindTab';

const event = (overrides = {}) => ({
  eventId: 'mind-message:message-1',
  kind: 'mind.message.accepted',
  mindId: 'cos-persistent-mind',
  turnId: null,
  sequence: 1,
  at: '2026-08-26T12:00:00.000Z',
  data: { displayText: 'Review the next bounded slice.' },
  ...overrides,
});

const response = (overrides = {}) => ({
  events: [event()],
  cursor: '1:mind-message:message-1',
  gap: false,
  hasMore: false,
  truncated: false,
  snapshot: {},
  state: { enabled: true, started: true, status: 'waiting', pauseReason: null },
  profile: { enabled: true, providerId: 'demo', model: 'demo-model', effort: 'high', thinkingInterface: 'text' },
  capabilities: { schemaVersion: 1, createTasks: false },
  autonomyMode: 'execute',
  ...overrides,
});

const renderTab = (path = '/cos/mind') => render(
  <MemoryRouter initialEntries={[path]}>
    <MindTab />
  </MemoryRouter>
);

describe('MindTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socket.reset();
    api.getPersistentMind.mockResolvedValue(response());
    api.sendPersistentMindMessage.mockResolvedValue({ success: true, duplicate: false });
    api.addPersistentMindAnnotation.mockResolvedValue({ success: true, duplicate: false });
    api.startPersistentMind.mockResolvedValue({ success: true });
    api.pausePersistentMind.mockResolvedValue({ success: true });
    api.resumePersistentMind.mockResolvedValue({ success: true });
    api.stopPersistentMind.mockResolvedValue({ success: true });
    api.acknowledgePersistentMindEvent.mockResolvedValue({ success: true });
    api.promotePersistentMindEvent.mockResolvedValue({ success: true });
    api.getProviders.mockResolvedValue({
      activeProvider: 'codex',
      providers: [{
        id: 'codex',
        name: 'Codex',
        enabled: true,
        type: 'cli',
        command: 'codex',
        defaultModel: 'gpt-5',
        models: ['gpt-5', 'gpt-5-mini'],
      }],
    });
    api.updateCosConfig.mockResolvedValue({ success: true });
    api.getPersistentMindContext.mockResolvedValue({
      prompt: { schemaVersion: 1, identity: 'Resident mind', instructions: 'Stay grounded.' },
      preview: { text: '# Effective context', chars: 19, approximateTokens: 5, summaryState: 'empty' },
      memories: [],
      rollups: [],
      harness: { type: 'api', label: 'Direct API', recommendation: 'recommended', detail: 'Structured and reliable.' },
    });
    api.getPersistentMindRuntime.mockResolvedValue({
      observedAt: '2026-08-27T12:00:00.000Z',
      inference: {
        active: false,
        providerId: 'demo',
        model: 'demo-model',
        residency: { status: 'provider-managed', backend: null, loaded: null, memoryBytes: null },
      },
      context: { chars: 19, maxChars: 32000, approximateTokens: 5, summaryState: 'empty', memoryCount: 0 },
      system: {
        memory: { total: 8 * 1024 ** 3, used: 4 * 1024 ** 3, free: 4 * 1024 ** 3, usagePercent: 50 },
        process: { rss: 256 * 1024 ** 2, heapUsed: 64 * 1024 ** 2, heapTotal: 128 * 1024 ** 2 },
        cpu: { cores: 8, loadAvg1m: 1.25 },
      },
    });
    api.createPersistentMindMemory.mockResolvedValue({ success: true });
    api.updatePersistentMindMemory.mockResolvedValue({ success: true });
  });

  it('restores event details from the URL and keeps the chat composer single-purpose', async () => {
    renderTab('/cos/mind?event=mind-message%3Amessage-1');

    expect(await screen.findByRole('button', { name: /user input/i })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('mind-chat')).toHaveClass('flex');
    expect(screen.getByRole('dialog', { name: 'User input' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Input type')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('mind-chat')).getByLabelText('Message')).toBeInTheDocument();
  });

  it('keeps annotations in message details instead of the primary composer', async () => {
    const user = userEvent.setup();
    renderTab('/cos/mind?event=mind-message%3Amessage-1');

    await user.type(await screen.findByLabelText('Add a note'), 'Keep this linked context.');
    await user.click(screen.getByRole('button', { name: 'Add note' }));

    await waitFor(() => expect(api.addPersistentMindAnnotation).toHaveBeenCalledWith({
      id: expect.stringMatching(/^annotation-/),
      text: 'Keep this linked context.',
      targetEventId: 'mind-message:message-1',
    }, { silent: true }));
  });

  it('never renders a fetch failure as an empty conversation', async () => {
    api.getPersistentMind.mockRejectedValue(new Error('Server unreachable'));
    renderTab();

    expect(await screen.findByText('Conversation unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/No conversation yet/)).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument();
  });

  it('deduplicates a socket-triggered cursor backfill', async () => {
    renderTab();
    expect(await screen.findByText('Review the next bounded slice.')).toBeInTheDocument();

    api.getPersistentMind.mockResolvedValue(response({ events: [event()], hasMore: false }));
    await act(async () => { socket.emitServer('cos:mind:event', event()); });

    await waitFor(() => expect(api.getPersistentMind).toHaveBeenCalledTimes(2));
    expect(screen.getAllByText('Review the next bounded slice.')).toHaveLength(1);
  });

  it('shows an explicit reload state when reconnect backfill reports a gap', async () => {
    api.getPersistentMind.mockResolvedValue(response({ gap: true }));
    renderTab();

    expect(await screen.findByText('History gap detected')).toBeInTheDocument();
    expect(screen.getByText(/reloaded from the newest bounded snapshot/i)).toBeInTheDocument();
  });

  it('adopts a null server cursor after a fully pruned gap', async () => {
    renderTab();
    await screen.findByText('Review the next bounded slice.');
    api.getPersistentMind.mockResolvedValueOnce(response({ events: [], cursor: null, gap: true }));
    await act(async () => { socket.emitServer('connect'); });
    await waitFor(() => expect(api.getPersistentMind).toHaveBeenCalledTimes(2));

    api.getPersistentMind.mockResolvedValueOnce(response());
    await act(async () => { socket.emitServer('cos:mind:status'); });
    await waitFor(() => expect(api.getPersistentMind).toHaveBeenCalledTimes(3));
    expect(api.getPersistentMind.mock.calls[2][0].cursor).toBeNull();
  });

  it('labels a bounded initial snapshot as truncated', async () => {
    api.getPersistentMind.mockResolvedValue(response({ truncated: true }));
    renderTab();
    expect(await screen.findByText('Showing recent history')).toBeInTheDocument();
  });

  it('puts the AI profile controls before start and starts only after the profile save finishes', async () => {
    const user = userEvent.setup();
    let finishSave;
    api.getPersistentMind.mockResolvedValue(response({
      state: { enabled: true, started: false, status: 'idle', pauseReason: null },
      profile: { enabled: true, providerId: 'codex', model: 'gpt-5', effort: 'high', thinkingInterface: 'text' },
    }));
    api.updateCosConfig.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    renderTab('/cos/mind?view=setup');

    expect(await screen.findByRole('heading', { name: 'AI profile' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('AI provider')).toHaveValue('codex'));
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-5');
    expect(screen.getByLabelText('Thinking effort')).toHaveValue('high');
    const start = screen.getByRole('button', { name: 'Start persistent mind' });

    await user.selectOptions(screen.getByLabelText('Model'), 'gpt-5-mini');
    expect(start).toBeDisabled();
    expect(api.startPersistentMind).not.toHaveBeenCalled();
    expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindProfile: expect.objectContaining({ providerId: 'codex', model: 'gpt-5-mini', effort: 'high' }) },
      { silent: true },
    );

    await user.click(screen.getByRole('button', { name: 'Reload' }));
    await waitFor(() => expect(api.getPersistentMind).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-5-mini');
    expect(start).toBeDisabled();

    finishSave({ success: true });
    await waitFor(() => expect(start).toBeEnabled());
    await user.click(start);
    await waitFor(() => expect(api.startPersistentMind).toHaveBeenCalledTimes(1));
  });

  it('persists the separate opt-in task-creation grant', async () => {
    const user = userEvent.setup();
    renderTab('/cos/mind?view=setup');

    const taskAccess = await screen.findByRole('checkbox', { name: 'Allow mind to queue CoS agent tasks' });
    expect(taskAccess).not.toBeChecked();
    await user.click(taskAccess);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindCapabilities: { schemaVersion: 1, createTasks: true } },
      { silent: true },
    ));
    expect(screen.getByText(/code review then merge/i)).toBeInTheDocument();
    expect(screen.getByText(/merge when CI is green/i)).toBeInTheDocument();
    expect(screen.getByText(/leave open for human review/i)).toBeInTheDocument();
  });

  it('keeps a failed message for a visible idempotent retry', async () => {
    const user = userEvent.setup();
    api.sendPersistentMindMessage.mockRejectedValueOnce(new Error('Provider unavailable'));
    renderTab();
    await screen.findByText('Review the next bounded slice.');

    await user.type(screen.getByLabelText('Message'), 'Keep this queued.');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Retry uses the same id/);
    expect(screen.getByLabelText('Message')).toHaveValue('Keep this queued.');

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.sendPersistentMindMessage).toHaveBeenCalledTimes(2));
    const firstId = api.sendPersistentMindMessage.mock.calls[0][0].id;
    expect(api.sendPersistentMindMessage.mock.calls[1][0].id).toBe(firstId);
  });

  it('mints a new id when failed text is edited into a different submission', async () => {
    const user = userEvent.setup();
    api.sendPersistentMindMessage.mockRejectedValueOnce(new Error('Connection lost'));
    renderTab();
    await screen.findByText('Review the next bounded slice.');
    await user.type(screen.getByLabelText('Message'), 'Original text');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByRole('alert');
    const firstId = api.sendPersistentMindMessage.mock.calls[0][0].id;

    await user.type(screen.getByLabelText('Message'), ' updated');
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api.sendPersistentMindMessage).toHaveBeenCalledTimes(2));
    expect(api.sendPersistentMindMessage.mock.calls[1][0].id).not.toBe(firstId);
  });

  it('renders only redacted display fields, never hidden prompt payloads', async () => {
    api.getPersistentMind.mockResolvedValue(response({ events: [event({
      kind: 'mind.model.result',
      data: { summaryText: 'A synthesized summary.', prompt: { redacted: 'content', chars: 5000 }, apiKey: 'not-rendered' },
    })] }));
    renderTab();

    await userEvent.setup().click(await screen.findByRole('checkbox', { name: 'Activity' }));
    expect(await screen.findByText('A synthesized summary.')).toBeInTheDocument();
    expect(screen.queryByText(/not-rendered|5000|prompt/i)).not.toBeInTheDocument();
  });

  it('renders user-visible working notes and replies in the conversation', async () => {
    api.getPersistentMind.mockResolvedValue(response({ events: [
      event({ eventId: 'thought-1', kind: 'mind.thought', turnId: 'mind-turn-1', sequence: 2, data: { displayText: 'I connected this with the prior decision.' } }),
      event({ eventId: 'reply-1', kind: 'mind.reply', turnId: 'mind-turn-1', sequence: 3, data: { displayText: 'Here is the recommendation.' } }),
    ] }));
    renderTab();
    expect(await screen.findByText('I connected this with the prior decision.')).toBeInTheDocument();
    expect(screen.getByText('Here is the recommendation.')).toBeInTheDocument();
    expect(screen.getByText('1 thought').closest('details')).not.toHaveAttribute('open');
    expect(screen.getAllByRole('button', { name: /chief of staff/i })).toHaveLength(1);
  });

  it('animates active thought status and shows context, system, and loaded-model telemetry', async () => {
    api.getPersistentMind.mockResolvedValue(response({
      state: { enabled: true, started: true, status: 'thinking', pauseReason: null, activeTurnId: 'mind-turn-1' },
    }));
    api.getPersistentMindRuntime.mockResolvedValue({
      observedAt: '2026-08-27T12:00:00.000Z',
      inference: {
        active: true,
        turnId: 'mind-turn-1',
        providerId: 'ollama',
        model: 'demo-model',
        residency: { status: 'loaded', backend: 'ollama', loaded: true, memoryBytes: 2 * 1024 ** 3 },
      },
      context: { chars: 12000, maxChars: 32000, approximateTokens: 3000, summaryState: 'ready', memoryCount: 4 },
      system: {
        memory: { total: 8 * 1024 ** 3, used: 4 * 1024 ** 3, free: 4 * 1024 ** 3, usagePercent: 50 },
        process: { rss: 256 * 1024 ** 2, heapUsed: 64 * 1024 ** 2, heapTotal: 128 * 1024 ** 2 },
        cpu: { cores: 8, loadAvg1m: 1.25 },
      },
    });
    renderTab('/cos/mind?view=setup');

    const thoughtStatus = await screen.findByRole('status');
    expect(thoughtStatus).toHaveTextContent('Thinking with demo-model');
    expect(thoughtStatus).toHaveAttribute('aria-busy', 'true');
    expect(thoughtStatus.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.getByText('~3,000 tokens')).toBeInTheDocument();
    expect(screen.getByText('4 GB / 8 GB')).toBeInTheDocument();
    expect(screen.getByText('Running now')).toBeInTheDocument();
    expect(screen.getByText(/ollama · 2 GB/)).toBeInTheDocument();
  });

  it('loads the editable effective context from the URL-backed context view', async () => {
    renderTab('/cos/mind?view=context');
    expect(await screen.findByRole('heading', { name: 'Identity and operating prompt' })).toBeInTheDocument();
    expect(screen.getByLabelText('Identity')).toHaveValue('Resident mind');
    expect(screen.getByText('# Effective context')).toBeInTheDocument();
    expect(api.getPersistentMindContext).toHaveBeenCalledWith({ silent: true });
  });
});

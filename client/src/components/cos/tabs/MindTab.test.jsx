import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    emitServer: (event, data) => handlers.get(event)?.(data),
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
  profile: { enabled: true, providerId: 'demo', model: 'demo-model', effort: 'high', thinkingInterface: 'text', wakeIntervalMinutes: 30 },
  capabilities: { schemaVersion: 3, createTasks: false, manageMind: false, readPortos: false, writePortos: false },
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
    api.uploadPersistentMindAttachment.mockResolvedValue({
      attachmentId: 'attachment-1', filename: 'mind-attachment-1.png', path: '/api/screenshots/mind-attachment-1.png', originalName: 'diagram.png', mimeType: 'image/png', size: 4,
    });
    api.deletePersistentMindAttachment.mockResolvedValue({ success: true });
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
    localLlm.getLocalLlmStatus.mockResolvedValue({ ollama: { models: [] }, lmstudio: { models: [] } });
    localLlm.getToolUseModels.mockResolvedValue({ models: [] });
    api.getPersistentMindContext.mockResolvedValue({
      prompt: { schemaVersion: 1, identity: 'Resident mind', instructions: 'Stay grounded.' },
      preview: { text: '# Effective context', chars: 19, approximateTokens: 5, summaryState: 'empty' },
      memories: [],
      rollups: [],
      harness: { type: 'api', label: 'Direct API', recommendation: 'recommended', detail: 'Structured and reliable.' },
    });
    api.getPersistentMindTools.mockResolvedValue({
      capabilities: { schemaVersion: 3, createTasks: false, manageMind: false, readPortos: false, writePortos: false },
      tools: [{
        id: 'cos.create-task',
        name: 'Create CoS task',
        description: 'Queue a supervised coding task.',
        capability: 'createTasks',
        granted: false,
        guardrails: ['Code review then merge', 'Merge when CI is green', 'Leave open for human review'],
      }],
      boundaries: ['Shell access'],
      taskCatalog: null,
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
    api.getPersistentMindVisibility.mockResolvedValue({
      schemaVersion: 1,
      capturedAt: '2026-08-27T12:00:00.000Z',
      freshness: { state: 'fresh', ageMs: 0, ttlMs: 30_000 },
      readiness: 'ready',
      truncated: false,
      workspaces: [{ appId: 'demo-app', appName: 'Demo App', readiness: 'ready', preflight: {
        workspaces: [{ dependencies: { status: 'installed' }, engines: { node: { status: 'compatible' }, packageManager: null } }],
        submodules: { status: 'not-configured' },
        forge: { status: 'ready' },
        reviewers: { required: { status: 'ready' } },
        warnings: [],
      } }],
    });
    api.createPersistentMindMemory.mockResolvedValue({ success: true });
    api.updatePersistentMindMemory.mockResolvedValue({ success: true });
    api.cleanupPersistentMind.mockResolvedValue({
      success: true,
      memoriesArchived: 0,
      historyEventsCleared: 5,
      historyEventsPreserved: 0,
      rollupsCleared: 2,
      runtimeResidueCleared: true,
      state: { enabled: true, started: false, status: 'idle', pauseReason: null },
    });
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
    expect(screen.getByRole('button', { name: /Settings/i })).toBeInTheDocument();
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

  it('keeps a bounded initial snapshot free of a history banner', async () => {
    api.getPersistentMind.mockResolvedValue(response({ truncated: true }));
    renderTab();
    await screen.findByText('Review the next bounded slice.');
    expect(screen.queryByText('Showing recent history')).not.toBeInTheDocument();
  });

  it('puts the AI profile controls before start and starts only after the profile save finishes', async () => {
    const user = userEvent.setup();
    let finishSave;
    api.getPersistentMind.mockResolvedValue(response({
      state: { enabled: true, started: false, status: 'idle', pauseReason: null },
      profile: { enabled: true, providerId: 'codex', model: 'gpt-5', effort: 'high', thinkingInterface: 'text' },
    }));
    api.updateCosConfig.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    renderTab('/cos/mind?panel=settings');

    expect(await screen.findByRole('heading', { name: 'AI profile' })).toBeInTheDocument();
    expect(api.getPersistentMindContext).not.toHaveBeenCalled();
    expect(api.getPersistentMindTools).not.toHaveBeenCalled();
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

  it('shows the next wake and persists a discoverable wake cadence', async () => {
    const nextWakeAt = new Date(Date.now() + 30 * 60_000).toISOString();
    api.getPersistentMind.mockResolvedValue(response({
      state: {
        enabled: true,
        started: true,
        status: 'waiting',
        pauseReason: null,
        nextWakeAt,
      },
    }));
    renderTab('/cos/mind?panel=settings');

    expect(await screen.findByText(/Waiting · next wake in/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Configure wake cadence' })).toBeInTheDocument();
    expect(document.querySelector(`time[datetime="${nextWakeAt}"]`)).toBeInTheDocument();
    const cadence = screen.getByLabelText('Wake cadence');
    expect(cadence).toHaveValue('30');
    await waitFor(() => expect(screen.getByLabelText('Wake cadence')).toBeEnabled());

    fireEvent.change(cadence, { target: { value: '60' } });

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindProfile: expect.objectContaining({ wakeIntervalMinutes: 60 }) },
      { silent: true },
    ));
  });

  it('starts a ready persistent mind directly from the dashboard header', async () => {
    const user = userEvent.setup();
    api.getPersistentMind.mockResolvedValue(response({
      state: { enabled: true, started: false, status: 'idle', pauseReason: null },
    }));
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Start' }));

    await waitFor(() => expect(api.startPersistentMind).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog', { name: 'Mind workspace' })).not.toBeInTheDocument();
  });

  it('persists the separate opt-in task-creation grant', async () => {
    const user = userEvent.setup();
    renderTab('/cos/mind?panel=tools');

    const taskAccess = await screen.findByRole('checkbox', { name: 'Allow mind to queue CoS agent tasks' });
    expect(taskAccess).not.toBeChecked();
    await user.click(taskAccess);

    await waitFor(() => expect(api.updateCosConfig).toHaveBeenCalledWith(
      { persistentMindCapabilities: { schemaVersion: 3, createTasks: true, manageMind: false, readPortos: false, writePortos: false, taskModelAllowlist: [] } },
      { silent: true },
    ));
    expect(screen.getAllByText(/code review then merge/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/merge when CI is green/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/leave open for human review/i).length).toBeGreaterThan(0);
  });

  it('reports every enabled typed-tool grant in the dashboard status', async () => {
    api.getPersistentMind.mockResolvedValue(response({
      capabilities: { schemaVersion: 3, createTasks: false, manageMind: false, readPortos: true, writePortos: true },
    }));
    renderTab();

    expect(await screen.findByText('2 grants enabled')).toBeInTheDocument();
  });

  it('cleans selected mindspace through an inline confirmation and refreshes the stopped state', async () => {
    const user = userEvent.setup();
    renderTab('/cos/mind?panel=maintenance');

    expect(await screen.findByRole('heading', { name: 'Clean mindspace' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Cleanup' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('Rebuild derived context')).toBeChecked();
    expect(screen.getByLabelText('Clear conversation history')).not.toBeChecked();
    await user.click(screen.getByLabelText('Clear conversation history'));
    await user.type(screen.getByLabelText('Type CLEAR to run the selected cleanup'), 'CLEAR');
    await user.click(screen.getByRole('button', { name: 'Clean selected mindspace' }));

    await waitFor(() => expect(api.cleanupPersistentMind).toHaveBeenCalledWith({
      scopes: ['context', 'history'],
      confirmation: 'CLEAR',
    }, { silent: true }));
    expect(await screen.findByText('Mindspace cleaned')).toBeInTheDocument();
    await waitFor(() => expect(api.getPersistentMind).toHaveBeenCalledTimes(2));
  });

  it('keeps Start gated until a capability save finishes', async () => {
    const user = userEvent.setup();
    let finishSave;
    api.getPersistentMind.mockResolvedValue(response({
      state: { enabled: true, started: false, status: 'idle', pauseReason: null },
    }));
    api.updateCosConfig.mockImplementation(() => new Promise((resolve) => { finishSave = resolve; }));
    renderTab('/cos/mind?panel=tools');

    const start = await screen.findByRole('button', { name: 'Start' });
    await user.click(await screen.findByRole('checkbox', { name: 'Allow bounded PortOS reads' }));
    expect(start).toBeDisabled();
    expect(api.startPersistentMind).not.toHaveBeenCalled();

    finishSave({ success: true });
    await waitFor(() => expect(start).toBeEnabled());
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

  it('sends on Enter while preserving a newline for Option+Enter', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Review the next bounded slice.');
    const message = screen.getByLabelText('Message');

    await user.type(message, 'First line');
    const optionEnter = createEvent.keyDown(message, { key: 'Enter', altKey: true });
    fireEvent(message, optionEnter);
    expect(optionEnter.defaultPrevented).toBe(false);
    expect(api.sendPersistentMindMessage).not.toHaveBeenCalled();

    await user.clear(message);
    await user.type(message, 'First line\nSecond line');
    expect(message).toHaveValue('First line\nSecond line');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(api.sendPersistentMindMessage).toHaveBeenCalledWith(
      { id: expect.stringMatching(/^message-/), text: 'First line\nSecond line' },
      { silent: true },
    ));
  });

  it('uploads supported images, permits an image-only message, and deletes a removed upload', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Review the next bounded slice.');

    const picker = screen.getByLabelText('Attach images');
    await user.upload(picker, new File(['png'], 'diagram.png', { type: 'image/png' }));
    await waitFor(() => expect(api.uploadPersistentMindAttachment).toHaveBeenCalledWith(
      { filename: 'diagram.png', data: expect.any(String) }, { silent: true },
    ));
    expect(screen.getByRole('button', { name: 'Remove diagram.png' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api.sendPersistentMindMessage).toHaveBeenCalledWith(
      { id: expect.stringMatching(/^message-/), text: '', images: ['attachment-1'] }, { silent: true },
    ));

    await user.upload(picker, new File(['png'], 'diagram.png', { type: 'image/png' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove diagram.png' })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Remove diagram.png' }));
    await waitFor(() => expect(api.deletePersistentMindAttachment).toHaveBeenCalledWith('attachment-1', { silent: true }));
  });

  it('renders safe accepted image metadata and disables the image picker when unsupported', async () => {
    api.getPersistentMind.mockResolvedValue(response({
      imageCapability: { status: 'unsupported', guidance: 'Select a vision-capable model in Settings.' },
      events: [event({ data: {
        displayText: 'Please inspect this.',
        images: [{ attachmentId: 'attachment-1', path: '/api/screenshots/mind-attachment-1.png', originalName: 'diagram.png', mimeType: 'image/png', size: 4 }],
      } })],
    }));
    renderTab('/cos/mind?event=mind-message%3Amessage-1');

    expect((await screen.findAllByAltText('diagram.png')).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Attach images')).toBeDisabled();
    expect(screen.getByText(/Image attachments are unavailable/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings?tab=providers');
  });

  it('does not submit an IME composition commit key', async () => {
    const user = userEvent.setup();
    renderTab();
    await screen.findByText('Review the next bounded slice.');
    const message = screen.getByLabelText('Message');

    await user.type(message, 'Composing text');
    fireEvent(message, createEvent.keyDown(message, { key: 'Enter', keyCode: 229 }));

    expect(api.sendPersistentMindMessage).not.toHaveBeenCalled();
    expect(message).toHaveValue('Composing text');
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

  it('shows a typing indicator in the chat header while the mind is thinking', async () => {
    api.getPersistentMind.mockResolvedValue(response({
      state: { enabled: true, started: true, status: 'thinking', pauseReason: null, activeTurnId: 'mind-turn-1' },
    }));
    renderTab();

    const typingIndicator = await screen.findByRole('status', { name: 'Chief of Staff is typing' });
    expect(typingIndicator).toHaveAttribute('data-testid', 'mind-typing-indicator');
    expect(typingIndicator.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
    expect(within(screen.getByTestId('mind-chat')).queryByText('Thinking…')).not.toBeInTheDocument();
  });

  it('animates active thought status and shows context, system, and loaded-model telemetry', async () => {
    const user = userEvent.setup();
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
    renderTab();

    const thoughtStatus = await screen.findByRole('status');
    expect(thoughtStatus).toHaveTextContent('Thinking with demo-model');
    expect(thoughtStatus).toHaveAttribute('aria-busy', 'true');
    expect(thoughtStatus.querySelector('.animate-pulse')).toBeInTheDocument();
    expect(screen.getByText('~3,000 tokens')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Context/i }));
    expect(screen.getByText('4 GB / 8 GB')).toBeInTheDocument();
    expect(screen.getAllByText('Running now').length).toBeGreaterThan(0);
    expect(screen.getByText(/ollama · 2 GB/)).toBeInTheDocument();
  });

  it('loads the editable effective context from the URL-backed context view', async () => {
    renderTab('/cos/mind?view=context');
    expect(screen.getByRole('tab', { name: 'Context' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Memory' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Identity and operating prompt' })).toBeInTheDocument();
    expect(screen.getByLabelText('Identity')).toHaveValue('Resident mind');
    expect(screen.getByText('# Effective context')).toBeInTheDocument();
    expect(api.getPersistentMindContext).toHaveBeenCalledWith({ silent: true });
  });

  it('keeps conversation central while exposing created and accessible memories', async () => {
    api.getPersistentMindContext.mockResolvedValue({
      prompt: { schemaVersion: 1, identity: 'Resident mind', instructions: 'Stay grounded.' },
      preview: { text: '# Effective context', chars: 19, approximateTokens: 5, summaryState: 'ready' },
      memories: [{ id: 'memory-1', content: 'Prefer bounded delivery.', summary: 'Delivery preference', type: 'preference', category: 'workflow', tags: [], importance: 0.8 }],
      rollups: [],
      harness: null,
    });
    renderTab('/cos/mind?panel=memories');

    expect(screen.getByTestId('mind-chat')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Memories' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('heading', { name: 'Curated memories' })).toBeInTheDocument();
    expect(screen.getByText('Delivery preference')).toBeInTheDocument();
  });

  it('retains unsaved context drafts across workspace panels and ignores accidental dismissal', async () => {
    const user = userEvent.setup();
    renderTab('/cos/mind?panel=context');

    const identity = await screen.findByLabelText('Identity');
    await user.clear(identity);
    await user.type(identity, 'Unsaved operating identity');
    await user.click(screen.getByRole('tab', { name: 'Memories' }));
    await user.click(screen.getByRole('tab', { name: 'Context' }));
    expect(screen.getByLabelText('Identity')).toHaveValue('Unsaved operating identity');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Identity and operating prompt' })).toBeInTheDocument();
  });

  it('refreshes the effective context after a memory is created', async () => {
    const user = userEvent.setup();
    api.getPersistentMindContext.mockImplementation(() => Promise.resolve({
      prompt: { schemaVersion: 1, identity: 'Resident mind', instructions: 'Stay grounded.' },
      preview: {
        text: api.getPersistentMindContext.mock.calls.length > 2 ? '# Context with new memory' : '# Original context',
        chars: 24,
        approximateTokens: 6,
        summaryState: 'ready',
      },
      memories: [],
      rollups: [],
      harness: null,
    }));
    renderTab('/cos/mind?panel=memories');

    await user.type(await screen.findByLabelText('Add a durable memory'), 'A newly curated fact');
    await user.click(screen.getByRole('button', { name: 'Add memory' }));
    await waitFor(() => expect(api.getPersistentMindContext.mock.calls.length).toBeGreaterThanOrEqual(2));
    await user.click(screen.getByRole('tab', { name: 'Context' }));

    expect(await screen.findByText('# Context with new memory')).toBeInTheDocument();
  });
});

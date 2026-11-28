import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MESSAGE_COMPOSE_PATTERN_DEFAULTS } from '../../../../server/lib/messageSelectorDefaults.js';
import { findEnabledByRole } from '../../test/enabledBarrier.js';

const api = vi.hoisted(() => ({
  getMessageSelectors: vi.fn(),
  updateMessageSelectors: vi.fn(),
  syncMessageAccount: vi.fn(),
  testMessageSelectors: vi.fn(),
  addCosTask: vi.fn(),
  getMessageTokenStatus: vi.fn(),
  testMessageToken: vi.fn(),
  clearMessageToken: vi.fn(),
}));
const toast = vi.hoisted(() => Object.assign(vi.fn(), {
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn(), emit: vi.fn() }));

vi.mock('../../services/apiMessages.js', () => ({
  getMessageSelectors: api.getMessageSelectors,
  updateMessageSelectors: api.updateMessageSelectors,
  syncMessageAccount: api.syncMessageAccount,
  testMessageSelectors: api.testMessageSelectors,
  getMessageTokenStatus: api.getMessageTokenStatus,
  testMessageToken: api.testMessageToken,
  clearMessageToken: api.clearMessageToken,
}));
vi.mock('../../services/apiAgents.js', () => ({ addCosTask: api.addCosTask }));
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../../services/socket', () => ({ default: socket }));

const SyncTab = (await import('./SyncTab')).default;

const renderTab = () => render(<SyncTab accounts={[]} onRefresh={vi.fn()} />);

beforeEach(() => {
  vi.clearAllMocks();
  api.getMessageSelectors.mockResolvedValue({});
  api.getMessageTokenStatus.mockResolvedValue({ providers: [] });
});

describe('SyncTab DOM selector test', () => {
  it('reports success with no investigate button when every selector matches', async () => {
    api.testMessageSelectors.mockResolvedValue({
      provider: 'teams',
      status: 'ok',
      results: { messageItem: { selector: "[role='listitem']", matches: 8 } },
    });
    renderTab();

    expect(screen.getByText("[role='listitem']")).toBeVisible();
    fireEvent.click(screen.getAllByText('Test')[1]); // teams card

    expect(api.testMessageSelectors).toHaveBeenCalledWith('teams');
    await waitFor(() => expect(screen.getByText(/all selectors matched/i)).toBeTruthy());
    expect(toast.success).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /queue agent to investigate/i })).toBeNull();
  });

  it('reports failure and offers to queue an investigation agent', async () => {
    api.testMessageSelectors.mockResolvedValue({
      provider: 'outlook',
      status: 'no-browser',
      results: {},
      error: 'Failed to open a browser tab — is portos-browser running?',
    });
    renderTab();

    fireEvent.click(screen.getAllByText('Test')[0]); // outlook card

    await waitFor(() => expect(screen.getByText(/no browser tab available/i)).toBeTruthy());
    expect(toast.error).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /queue agent to investigate/i })).toBeTruthy();
  });

  it('queues a CoS investigation task naming the failing provider and status', async () => {
    api.testMessageSelectors.mockResolvedValue({
      provider: 'outlook',
      status: 'partial',
      results: { messageRow: { selector: "[role='listbox'] [role='option']", matches: 0 } },
    });
    api.addCosTask.mockResolvedValue({ id: 'task-1' });
    renderTab();

    fireEvent.click(screen.getAllByText('Test')[0]);
    await waitFor(() => expect(screen.getByText(/some selectors matched zero elements/i)).toBeTruthy());
    expect(screen.getByText(/messageRow: 0 matches/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /queue agent to investigate/i }));

    await waitFor(() => expect(api.addCosTask).toHaveBeenCalledTimes(1));
    const [task, options] = api.addCosTask.mock.calls[0];
    expect(task.isInvestigation).toBe(true);
    expect(task.description).toMatch(/outlook/i);
    expect(task.prompt).toContain('partial');
    expect(options).toEqual({ silent: true });
    await waitFor(() => expect(screen.getByRole('button', { name: /agent queued/i })).toBeTruthy());
  });
});


describe('Messages sync lifecycle', () => {
  const account = { id: 'message-1', name: 'Inbox', enabled: true, provider: 'playwright' };
  const emit = (event, payload = {}) => act(() => {
    const handler = socket.on.mock.calls.find(([name]) => name === `messages:sync:${event}`)?.[1];
    handler?.({ accountId: account.id, ...payload });
  });

  it('releases provider failures without a dedicated event and preserves login guidance', async () => {
    render(<SyncTab accounts={[account]} onRefresh={vi.fn()} />);
    for (const status of ['no-browser', 'extraction-failed', 'unexpected-status']) {
      emit('started');
      expect(screen.queryByRole('button', { name: 'Sync Unread' })).toBeNull();
      emit('completed', { status });
      expect(screen.getByRole('button', { name: 'Sync Unread' })).toBeEnabled();
    }
    expect(toast.error).toHaveBeenCalledTimes(3);
    expect(toast.success).not.toHaveBeenCalled();
    emit('started');
    emit('auth-required');
    emit('completed', { status: 'auth-required' });
    expect(screen.getByText('Auth required')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Launch' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Sync Unread' })).toBeEnabled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('open Browser page'));
    await waitFor(() => expect(api.getMessageSelectors).toHaveBeenCalled());
  });

  it('reports a socket-first success once and a later manual rejection once', async () => {
    let resolve;
    api.syncMessageAccount.mockImplementation(() => new Promise(done => { resolve = done; }));
    const onRefresh = vi.fn();
    render(<SyncTab accounts={[account]} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full Sync' }));
    expect(api.syncMessageAccount).toHaveBeenCalledWith(account.id, 'full', { silent: true });
    emit('started');
    emit('completed', { status: 'success', newMessages: 5 });
    await act(async () => resolve({ status: 'success', newMessages: 5 }));
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Sync complete: 5 new messages');
    expect(onRefresh).toHaveBeenCalledTimes(1);

    api.syncMessageAccount.mockRejectedValue(new Error('Connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Sync Unread' }));
    emit('started');
    emit('failed', { error: 'Connection lost' });
    await findEnabledByRole('button', { name: 'Sync Unread' });
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('Sync failed: Connection lost');
  });
});

describe('Messages sync actions by provider capability (#9968)', () => {
  const gmail = { id: 'gmail-1', name: 'Gmail', enabled: true, provider: 'api', syncModes: ['unread', 'full'] };
  const teams = { id: 'teams-1', name: 'Chat', enabled: true, provider: 'playwright', syncModes: ['full'] };
  const legacy = { id: 'legacy-1', name: 'Legacy', enabled: true, provider: 'api' }; // older server: no syncModes

  it('offers no unread-only sync for Teams but keeps Full Sync working', async () => {
    api.syncMessageAccount.mockResolvedValue({ status: 'success', newMessages: 0 });
    render(<SyncTab accounts={[teams]} onRefresh={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Sync Unread' })).toBeNull();
    expect(screen.getByText(/unread-only sync isn.t available/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Full Sync' }));
    expect(api.syncMessageAccount).toHaveBeenCalledWith(teams.id, 'full', { silent: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('keeps Sync Unread for accounts that support it, including payloads without syncModes', async () => {
    render(<SyncTab accounts={[gmail, teams, legacy]} onRefresh={vi.fn()} />);
    await waitFor(() => expect(api.getMessageSelectors).toHaveBeenCalled());
    await act(async () => {});

    expect(screen.getAllByRole('button', { name: 'Sync Unread' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Full Sync' })).toHaveLength(3);
  });
});

describe('SyncTab compose selectors', () => {
  it.each([
    ['outlook', 'composeBody', '[role="textbox"][aria-label="Message body"]'],
    ['teams', 'recipientInput', 'input[aria-label^="To"]'],
  ])('displays and saves a %s compose override without persisting untouched defaults', async (provider, key, defaultValue) => {
    const saved = { composeSend: '.saved-send' };
    const updated = { ...saved, [key]: '.updated-control' };
    api.getMessageSelectors.mockResolvedValueOnce({ [provider]: saved }).mockResolvedValue({ [provider]: updated });
    api.updateMessageSelectors.mockResolvedValue(updated);
    renderTab();

    const card = screen.getByRole('heading', { name: provider }).closest('.bg-port-card');
    const controls = within(card);
    await waitFor(() => expect(controls.getByRole('button', { name: 'Edit selectors' })).toBeEnabled());

    const summary = controls.getByText('Browser compose selectors');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(controls.getByText(defaultValue)).toBeVisible();

    fireEvent.click(controls.getByRole('button', { name: 'Edit selectors' }));
    const input = controls.getByRole('textbox', { name: key });
    expect(input).toHaveValue(defaultValue);
    expect(controls.getByRole('textbox', { name: 'composeSend' })).toHaveValue('.saved-send');
    fireEvent.change(input, { target: { value: '.updated-control' } });
    expect(controls.getByRole('button', { name: 'Test' })).toBeDisabled();
    fireEvent.click(controls.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateMessageSelectors).toHaveBeenCalledExactlyOnceWith(provider, updated));
    expect(await controls.findByText('.updated-control')).toBeVisible();
  });
});

describe('SyncTab send confirmation patterns', () => {
  it('saves, reloads and clears both Outlook overrides without treating them as selectors', async () => {
    let saved = {};
    api.getMessageSelectors.mockImplementation(async () => ({ outlook: saved }));
    api.updateMessageSelectors.mockImplementation(async (_provider, selectors) => {
      saved = selectors;
      return saved;
    });

    const openEditor = async () => {
      const card = within(screen.getByRole('heading', { name: 'outlook' }).closest('.bg-port-card'));
      const edit = card.getByRole('button', { name: 'Edit selectors' });
      await waitFor(() => expect(edit).toBeEnabled());
      fireEvent.click(card.getByText('Browser compose selectors'));
      fireEvent.click(edit);
      const ack = card.getByRole('textbox', { name: 'Send acknowledgement pattern' });
      const refusal = card.getByRole('textbox', { name: 'Send refusal pattern' });
      expect(ack).toHaveAccessibleDescription(`Default ${MESSAGE_COMPOSE_PATTERN_DEFAULTS.sendAckPattern}`);
      expect(refusal).toHaveAccessibleDescription(`Default ${MESSAGE_COMPOSE_PATTERN_DEFAULTS.sendRefusalPattern}`);
      expect(card.queryByRole('textbox', { name: 'sendAckPattern' })).toBeNull();
      return { card, ack, refusal };
    };

    const first = renderTab();
    const { card, ack, refusal } = await openEditor();
    expect(ack).toHaveValue('');
    expect(refusal).toHaveValue('');

    fireEvent.change(ack, { target: { value: '(unclosed' } });
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    expect(toast.error).toHaveBeenCalledWith('Send acknowledgement pattern must be a valid regular expression.');
    expect(api.updateMessageSelectors).not.toHaveBeenCalled();

    const overrides = { sendAckPattern: '^Nachricht gesendet$', sendRefusalPattern: '^Nachricht nicht gesendet$' };
    fireEvent.change(ack, { target: { value: overrides.sendAckPattern } });
    fireEvent.change(refusal, { target: { value: overrides.sendRefusalPattern } });
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    expect(await card.findByText(overrides.sendRefusalPattern)).toBeVisible();
    expect(api.updateMessageSelectors).toHaveBeenCalledExactlyOnceWith('outlook', overrides);
    first.unmount();

    renderTab();
    const reloaded = await openEditor();
    expect(reloaded.ack).toHaveValue(overrides.sendAckPattern);
    expect(reloaded.refusal).toHaveValue(overrides.sendRefusalPattern);
    fireEvent.change(reloaded.ack, { target: { value: '' } });
    fireEvent.change(reloaded.refusal, { target: { value: '  ' } });
    fireEvent.click(reloaded.card.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateMessageSelectors).toHaveBeenLastCalledWith('outlook', {}));
    await waitFor(() => expect(reloaded.card.queryByRole('button', { name: 'Save' })).toBeNull());
    expect(reloaded.card.queryByText(overrides.sendAckPattern)).toBeNull();
    expect(reloaded.card.queryByText(overrides.sendRefusalPattern)).toBeNull();
  });
});

describe('SyncTab saved selectors read', () => {
  it('disables selector editing after a failed read, then re-enables it on Retry', async () => {
    api.getMessageSelectors.mockRejectedValueOnce(new Error('Synthetic selectors failure'));
    renderTab();

    expect(await screen.findByText(/Failed to load saved selectors/)).toBeTruthy();
    for (const edit of screen.getAllByRole('button', { name: 'Edit selectors' })) expect(edit).toBeDisabled();

    api.getMessageSelectors.mockResolvedValueOnce({ outlook: { inbox: '.saved-inbox' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Failed to load saved selectors/)).toBeNull());
    for (const edit of screen.getAllByRole('button', { name: 'Edit selectors' })) expect(edit).not.toBeDisabled();
    expect(api.getMessageSelectors).toHaveBeenLastCalledWith({ silent: true });
  });
});

describe('SyncTab selector save followed by a failed refresh', () => {
  it('keeps the saved values and editing after the post-save reload fails', async () => {
    api.getMessageSelectors.mockResolvedValueOnce({ outlook: { inbox: '.old-inbox' } });
    api.updateMessageSelectors.mockResolvedValue({ inbox: '.new-inbox' });
    renderTab();
    expect(await screen.findByText('.old-inbox')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit selectors' })[0]);
    fireEvent.change(screen.getByDisplayValue('.old-inbox'), { target: { value: '.new-inbox' } });
    api.getMessageSelectors.mockRejectedValueOnce(new Error('Synthetic reload failure'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('.new-inbox')).toBeTruthy();
    await waitFor(() => expect(api.getMessageSelectors).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Failed to load saved selectors/)).toBeNull();
    for (const edit of screen.getAllByRole('button', { name: 'Edit selectors' })) expect(edit).not.toBeDisabled();
  });
});

describe('Messages sync live progress', () => {
  const account = { id: 'gmail-progress', name: 'Gmail', enabled: true, provider: 'api', syncModes: ['unread', 'full'] };
  const handlerFor = (event) => socket.on.mock.calls.find(([name]) => name === event)?.[1];
  const emit = (event, payload = {}) => act(() => {
    handlerFor(`messages:sync:${event}`)?.({ accountId: account.id, ...payload });
  });
  const emitProgress = (payload) => act(() => handlerFor('messages:sync:progress')?.({ accountId: account.id, ...payload }));

  it('shows per-account progress beside the spinner and clears it on start and settle', async () => {
    render(<SyncTab accounts={[account]} onRefresh={vi.fn()} />);
    await waitFor(() => expect(api.getMessageSelectors).toHaveBeenCalled());
    await act(async () => {});
    emit('started');
    expect(screen.queryByText(/^Syncing/)).toBeNull();

    emitProgress({ current: 3, total: 200 });
    expect(screen.getByText('Syncing 3/200…')).toBeTruthy();
    emitProgress({ current: 0, total: 0 });
    expect(screen.getByText('Syncing…')).toBeTruthy();

    emitProgress({ current: 12, total: 200 });
    emit('completed', { status: 'success', newMessages: 12 });
    expect(screen.queryByText(/^Syncing/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Sync Unread' })).toBeEnabled();

    emit('started');
    expect(screen.queryByText(/^Syncing/)).toBeNull();
  });

  it('removes the progress listener on unmount', () => {
    const { unmount } = render(<SyncTab accounts={[account]} onRefresh={vi.fn()} />);
    const onProgress = handlerFor('messages:sync:progress');
    expect(onProgress).toBeTypeOf('function');
    unmount();
    expect(socket.off).toHaveBeenCalledWith('messages:sync:progress', onProgress);
  });
});

describe('SyncTab token debug', () => {
  const statuses = {
    providers: [
      { provider: 'outlook', cached: true, valid: true, expires: '2026-11-21T12:00:00.000Z' },
      { provider: 'teams', cached: false },
    ],
  };

  it('renders token status for outlook and teams', async () => {
    api.getMessageTokenStatus.mockResolvedValue(statuses);
    renderTab();

    expect(await screen.findByText('Token present')).toBeTruthy();
    expect(screen.getByText('No token')).toBeTruthy();
    expect(screen.getByText(/Expires:/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test teams token' })).toBeTruthy();
    // Only providers holding a token offer Clear
    expect(screen.getAllByRole('button', { name: /^Clear .* token$/ })).toHaveLength(1);
  });

  it('offers Clear for an expired token with unknown expiry', async () => {
    api.getMessageTokenStatus.mockResolvedValue({
      providers: [{ provider: 'teams', cached: true, valid: false, expires: 'unknown' }],
    });
    renderTab();

    expect(await screen.findByText('Token expired')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear teams token' })).toBeTruthy();
    expect(screen.queryByText(/Expires:/)).toBeNull();
  });

  it('tests a token and refreshes status', async () => {
    api.getMessageTokenStatus.mockResolvedValue(statuses);
    api.testMessageToken.mockResolvedValue({ token: { provider: 'teams' }, api: { success: true } });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Test teams token' }));

    await waitFor(() => expect(api.testMessageToken).toHaveBeenCalledWith('teams'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('teams token is valid'));
    expect(api.getMessageTokenStatus).toHaveBeenCalledTimes(2);
  });

  it('reports API rejection even when the probe returns token metadata', async () => {
    api.getMessageTokenStatus.mockResolvedValue(statuses);
    api.testMessageToken.mockResolvedValue({
      token: { provider: 'outlook' },
      api: { success: false, status: 401, error: 'InvalidAuthenticationToken' },
    });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Test outlook token' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'outlook token test failed: HTTP 401 — InvalidAuthenticationToken',
    ));
    expect(toast.success).not.toHaveBeenCalled();
    expect(api.getMessageTokenStatus).toHaveBeenCalledTimes(2);
  });

  it('clears a cached token', async () => {
    api.getMessageTokenStatus.mockResolvedValue(statuses);
    api.clearMessageToken.mockResolvedValue({ cleared: true, provider: 'outlook' });
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Clear outlook token' }));

    await waitFor(() => expect(api.clearMessageToken).toHaveBeenCalledWith('outlook'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('outlook token cleared'));
    expect(api.getMessageTokenStatus).toHaveBeenCalledTimes(2);
  });
});

it('only shows the empty account copy after a successful empty read', async () => {
  const onRefresh = vi.fn();
  const { rerender } = render(<SyncTab accounts={[]} accountsUnavailable onRefresh={onRefresh} />);
  await act(async () => {});
  expect(screen.queryByText(/No accounts configured/)).not.toBeInTheDocument();

  rerender(<SyncTab accounts={[]} onRefresh={onRefresh} />);
  expect(screen.getByText(/No accounts configured/)).toBeInTheDocument();

  rerender(<SyncTab accounts={[{ id: 'example', name: 'Example account' }]} onRefresh={onRefresh} />);
  expect(screen.getByText('Example account')).toBeInTheDocument();
  expect(screen.queryByText(/No accounts configured/)).not.toBeInTheDocument();
});

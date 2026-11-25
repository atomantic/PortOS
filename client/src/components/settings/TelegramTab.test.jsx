import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import TelegramTab from './TelegramTab';
import {
  deleteTelegramConfig,
  getSettings,
  testTelegram,
  updateTelegramConfig,
  updateTelegramForwardTypes,
  getTelegramStatus,
  updateTelegramMethod,
} from '../../services/apiSystem.js';

vi.mock('../../services/apiSystem.js', () => ({
  getSettings: vi.fn(),
  getTelegramStatus: vi.fn(),
  updateTelegramConfig: vi.fn(),
  deleteTelegramConfig: vi.fn(),
  testTelegram: vi.fn(),
  updateTelegramForwardTypes: vi.fn(),
  updateTelegramMethod: vi.fn(),
}));
vi.mock('../ui/Toast');

const choices = [
  { key: 'health_issue', label: 'Health Issues' },
  { key: 'autopilot_paused', label: 'Autopilot Paused' }
];
beforeEach(() => {
  vi.resetAllMocks();
  getSettings.mockResolvedValue({ telegram: { forwardTypes: ['unknown_saved_type'] } });
  updateTelegramForwardTypes.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe('Telegram forwarding settings', () => {
  it('shows an inline retry instead of the configuration form when settings fail to load', async () => {
    getSettings.mockRejectedValueOnce(new Error('Network unavailable'));
    getTelegramStatus.mockResolvedValue({ connected: false });
    render(<TelegramTab />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Telegram settings — Network unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText('Integration Method')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Integration Method')).toBeInTheDocument();
  });

  it('selects returned choices while retaining unknown saved keys across method switches', async () => {
    getTelegramStatus.mockResolvedValue({
      connected: true, forwardTypes: ['unknown_saved_type'], availableForwardTypes: choices
    });
    updateTelegramMethod.mockResolvedValue({ connected: true, method: 'mcp-bridge' });
    render(<TelegramTab />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Health Issues' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Autopilot Paused' })).toBeEnabled());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Autopilot Paused' }));
    expect(updateTelegramForwardTypes).toHaveBeenLastCalledWith(
      ['unknown_saved_type', 'health_issue', 'autopilot_paused'], { silent: true }
    );
    fireEvent.click(screen.getByRole('button', { name: /Claude MCP Bridge/ }));
    await waitFor(() => expect(updateTelegramMethod).toHaveBeenCalledWith('mcp-bridge', { silent: true }));
    expect(screen.getByRole('checkbox', { name: 'Autopilot Paused' })).toBeChecked();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Health Issues' })).toBeEnabled());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Health Issues' }));
    expect(updateTelegramForwardTypes).toHaveBeenLastCalledWith(
      ['unknown_saved_type', 'autopilot_paused'], { silent: true }
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Health Issues' })).toBeEnabled());
  });

  it.each(['missing', 'failed'])('shows unavailable choices without saving when status is %s', async mode => {
    if (mode === 'failed') getTelegramStatus.mockRejectedValue(new Error('Unavailable'));
    else getTelegramStatus.mockResolvedValue({ connected: true, forwardTypes: ['unknown_saved_type'] });
    render(<TelegramTab />);
    expect(await screen.findByText(/Notification choices unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(updateTelegramForwardTypes).not.toHaveBeenCalled();
  });

  it('distinguishes an empty catalog from unavailable choices', async () => {
    getTelegramStatus.mockResolvedValue({ connected: true, availableForwardTypes: [] });
    render(<TelegramTab />);
    expect(await screen.findByText('When all are unchecked, all types are forwarded')).toBeInTheDocument();
    expect(screen.queryByText(/Notification choices unavailable/)).not.toBeInTheDocument();
    expect(updateTelegramForwardTypes).not.toHaveBeenCalled();
  });
});

describe('Telegram mutations', () => {
  const connectedStatus = {
    connected: true, hasToken: true, hasChatId: true, availableForwardTypes: choices,
  };

  beforeEach(() => {
    getTelegramStatus.mockResolvedValue(connectedStatus);
    getSettings.mockResolvedValue({ telegram: { chatId: '123' } });
  });

  it('serializes forwarding changes and rolls back a rejected update', async () => {
    const request = Promise.withResolvers();
    updateTelegramForwardTypes.mockReturnValueOnce(request.promise);
    render(<TelegramTab />);
    const health = await screen.findByRole('checkbox', { name: 'Health Issues' });
    const autopilot = screen.getByRole('checkbox', { name: 'Autopilot Paused' });

    fireEvent.click(health);
    expect(health).toBeChecked();
    expect(health).toBeDisabled();
    expect(autopilot).toBeDisabled();
    fireEvent.click(autopilot);
    expect(updateTelegramForwardTypes).toHaveBeenCalledTimes(1);

    request.reject(new Error('Network unavailable'));
    await waitFor(() => expect(health).toBeEnabled());
    expect(health).not.toBeChecked();
    expect(autopilot).not.toBeChecked();
    fireEvent.click(autopilot);
    expect(updateTelegramForwardTypes).toHaveBeenLastCalledWith(['autopilot_paused'], { silent: true });
    await waitFor(() => expect(autopilot).toBeEnabled());
  });

  it('uses saved credentials for Send Test and preserves a newer edit during a save', async () => {
    const request = Promise.withResolvers();
    updateTelegramConfig.mockReturnValueOnce(request.promise);
    testTelegram.mockResolvedValue({});
    render(<TelegramTab />);
    const sendTest = await screen.findByRole('button', { name: 'Send Test' });
    const token = screen.getByLabelText('Bot Token');
    const chatId = screen.getByLabelText('Chat ID');

    expect(sendTest).toBeEnabled();
    fireEvent.change(token, { target: { value: 'new-token' } });
    expect(sendTest).toBeDisabled();
    expect(sendTest).toHaveAccessibleDescription('Save your Telegram changes before sending a test message.');
    fireEvent.change(token, { target: { value: '' } });
    expect(sendTest).toBeEnabled();

    fireEvent.change(chatId, { target: { value: '456' } });
    expect(sendTest).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save & Test' }));
    fireEvent.change(chatId, { target: { value: '123' } });
    expect(sendTest).toBeDisabled();
    expect(updateTelegramConfig).toHaveBeenCalledWith({ token: '', chatId: '456' }, { silent: true });

    request.resolve(connectedStatus);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save & Test' })).toBeEnabled());
    expect(chatId).toHaveValue('123');
    expect(sendTest).toBeDisabled();
    fireEvent.change(chatId, { target: { value: '456' } });
    expect(sendTest).toBeEnabled();
    fireEvent.click(sendTest);
    expect(testTelegram).toHaveBeenCalledWith(undefined, { silent: true });
    await waitFor(() => expect(sendTest).toBeEnabled());
  });

  it('lets the user cancel disconnect and waits for confirmed deletion', async () => {
    const request = Promise.withResolvers();
    deleteTelegramConfig.mockReturnValueOnce(request.promise);
    render(<TelegramTab />);
    const sendTest = await screen.findByRole('button', { name: 'Send Test' });
    const openConfirmation = () => fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));

    openConfirmation();
    expect(screen.getByText('Disconnect Telegram?')).toBeInTheDocument();
    expect(deleteTelegramConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Disconnect Telegram?')).not.toBeInTheDocument();
    expect(deleteTelegramConfig).not.toHaveBeenCalled();

    openConfirmation();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(deleteTelegramConfig).toHaveBeenCalledWith({ silent: true });
    expect(sendTest).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    request.resolve({});
    await waitFor(() => expect(sendTest).not.toBeInTheDocument());
    expect(screen.getByLabelText('Chat ID')).toHaveValue('');
  });
});

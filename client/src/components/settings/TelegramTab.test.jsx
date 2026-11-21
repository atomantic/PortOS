import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import TelegramTab from './TelegramTab';
import {
  getSettings,
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
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

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
    fireEvent.click(screen.getByRole('checkbox', { name: 'Autopilot Paused' }));
    expect(updateTelegramForwardTypes).toHaveBeenLastCalledWith(
      ['unknown_saved_type', 'health_issue', 'autopilot_paused'], { silent: true }
    );
    fireEvent.click(screen.getByRole('button', { name: /Claude MCP Bridge/ }));
    await waitFor(() => expect(updateTelegramMethod).toHaveBeenCalledWith('mcp-bridge', { silent: true }));
    expect(screen.getByRole('checkbox', { name: 'Autopilot Paused' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Health Issues' }));
    expect(updateTelegramForwardTypes).toHaveBeenLastCalledWith(
      ['unknown_saved_type', 'autopilot_paused'], { silent: true }
    );
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

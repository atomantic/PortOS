import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import TelegramTab from './TelegramTab';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  getSettings: vi.fn(), getTelegramStatus: vi.fn(), updateTelegramConfig: vi.fn(),
  deleteTelegramConfig: vi.fn(), testTelegram: vi.fn(),
  updateTelegramForwardTypes: vi.fn(), updateTelegramMethod: vi.fn()
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const choices = [
  { key: 'health_issue', label: 'Health Issues' },
  { key: 'autopilot_paused', label: 'Autopilot Paused' }
];
beforeEach(() => {
  vi.resetAllMocks();
  api.getSettings.mockResolvedValue({ telegram: { forwardTypes: ['unknown_saved_type'] } });
  api.updateTelegramForwardTypes.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe('Telegram forwarding settings', () => {
  it('selects returned choices while retaining unknown saved keys across method switches', async () => {
    api.getTelegramStatus.mockResolvedValue({
      connected: true, forwardTypes: ['unknown_saved_type'], availableForwardTypes: choices
    });
    api.updateTelegramMethod.mockResolvedValue({ connected: true, method: 'mcp-bridge' });
    render(<TelegramTab />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Health Issues' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Autopilot Paused' }));
    expect(api.updateTelegramForwardTypes).toHaveBeenLastCalledWith(
      ['unknown_saved_type', 'health_issue', 'autopilot_paused'], { silent: true }
    );
    fireEvent.click(screen.getByRole('button', { name: /Claude MCP Bridge/ }));
    await waitFor(() => expect(api.updateTelegramMethod).toHaveBeenCalledWith('mcp-bridge', { silent: true }));
    expect(screen.getByRole('checkbox', { name: 'Autopilot Paused' })).toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Health Issues' }));
    expect(api.updateTelegramForwardTypes).toHaveBeenLastCalledWith(
      ['unknown_saved_type', 'autopilot_paused'], { silent: true }
    );
  });

  it.each(['missing', 'failed'])('shows unavailable choices without saving when status is %s', async mode => {
    if (mode === 'failed') api.getTelegramStatus.mockRejectedValue(new Error('Unavailable'));
    else api.getTelegramStatus.mockResolvedValue({ connected: true, forwardTypes: ['unknown_saved_type'] });
    render(<TelegramTab />);
    expect(await screen.findByText(/Notification choices unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(api.updateTelegramForwardTypes).not.toHaveBeenCalled();
  });

  it('distinguishes an empty catalog from unavailable choices', async () => {
    api.getTelegramStatus.mockResolvedValue({ connected: true, availableForwardTypes: [] });
    render(<TelegramTab />);
    expect(await screen.findByText('When all are unchecked, all types are forwarded')).toBeInTheDocument();
    expect(screen.queryByText(/Notification choices unavailable/)).not.toBeInTheDocument();
    expect(api.updateTelegramForwardTypes).not.toHaveBeenCalled();
  });
});

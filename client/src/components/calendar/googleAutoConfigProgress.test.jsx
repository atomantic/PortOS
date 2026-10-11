import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CalendarConfig from './ConfigTab';
import MessagesConfig from '../messages/ConfigTab';

const api = vi.hoisted(() => ({
  getGoogleAuthStatus: vi.fn(), startGoogleAutoConfig: vi.fn(), getSettings: vi.fn(), getGoogleAuthUrl: vi.fn(),
}));
const runGoogleAutoConfig = vi.hoisted(() => vi.fn());
const socket = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock('../../services/api', () => api);
vi.mock('../../services/apiCalendar', () => ({ runGoogleAutoConfig }));
vi.mock('../../services/socket', () => ({ default: socket }));
vi.mock('../ui/Toast', () => ({ default: toast }));
vi.mock('../FeatureProviderPicker', () => ({ default: () => null }));
vi.mock('../ProviderModelSelector', () => ({ default: () => null }));
vi.mock('../../hooks/useProviderModels', () => ({ default: () => ({ providers: [], availableModels: [] }) }));

const EVENT = 'calendar:google:autoconfig';
let listeners;
let settle;
beforeEach(() => {
  vi.clearAllMocks();
  listeners = new Set();
  socket.on.mockImplementation((event, listener) => { if (event === EVENT) listeners.add(listener); });
  socket.off.mockImplementation((event, listener) => { if (event === EVENT) listeners.delete(listener); });
  api.getGoogleAuthStatus.mockResolvedValue({ hasCredentials: false, hasTokens: false });
  api.getSettings.mockResolvedValue({ messages: {} });
  api.getGoogleAuthUrl.mockResolvedValue({ url: null });
  api.startGoogleAutoConfig.mockResolvedValue({ status: 'login' });
  runGoogleAutoConfig.mockImplementation(() => {
    expect(listeners.size).toBe(1); // Listener must exist before HTTP dispatch.
    return new Promise(resolve => { settle = resolve; });
  });
});

for (const [name, Component, type] of [['Calendar', CalendarConfig, 'google-calendar'], ['Messages', MessagesConfig, 'gmail']]) {
  describe(`${name} automated Google setup progress`, () => {
    async function start() {
      const view = render(<MemoryRouter><Component accounts={[{ id: 'example', name: 'Example', type, syncMethod: 'google-api' }]} setAccounts={vi.fn()} /></MemoryRouter>);
      if (name === 'Calendar') fireEvent.click(screen.getByRole('button', { name: 'Expand calendars for Example' }));
      fireEvent.click(await screen.findByRole('button', { name: /(?:Setup with|Set up with) PortOS Browser/ }));
      fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
      return view;
    }
    const emit = (requestId, step, message) => act(() => {
      for (const listener of listeners) listener({ requestId, step, message });
    });

    it('renders correlated stages while HTTP is pending and ignores duplicates, foreign and settled frames', async () => {
      const view = await start();
      const requestId = runGoogleAutoConfig.mock.calls[0][1].requestId;
      const staleListener = [...listeners][0];
      emit(requestId, 'enable-api', 'Enabling Calendar API...');
      expect(screen.getByRole('status')).toHaveTextContent('Enabling Calendar API...');
      emit('other-request', 'consent', 'Unrelated progress');
      expect(screen.queryByText('Unrelated progress')).not.toBeInTheDocument();
      emit(requestId, 'consent', 'Configuring OAuth consent...');
      emit(requestId, 'enable-api', 'Enabling Calendar API...'); // An old duplicate cannot regress the stage.
      expect(screen.getByRole('status')).toHaveTextContent('Configuring OAuth consent...');
      emit(requestId, 'capturing', 'Extracting credentials...');
      expect(screen.getByRole('status')).toHaveTextContent('Extracting credentials...');
      emit(requestId, 'done', 'Credentials captured and saved!');
      expect(screen.getByRole('status')).toHaveTextContent('Credentials captured and saved!');
      expect(toast.success).not.toHaveBeenCalledWith(name === 'Calendar' ? 'Google OAuth setup complete!' : 'Google OAuth setup complete');
      expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
      await act(async () => settle({ status: 'success' }));
      expect(toast.success).toHaveBeenCalledWith(name === 'Calendar' ? 'Google OAuth setup complete!' : 'Google OAuth setup complete');
      expect(listeners.size).toBe(0);
      act(() => staleListener({ requestId, step: 'consent', message: 'Late progress' }));
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
      view.unmount();
    });

    it('retries HTTP failures with a fresh ID and cleans up an unmounted pending run', async () => {
      const view = await start();
      const oldId = runGoogleAutoConfig.mock.calls[0][1].requestId;
      await act(async () => settle({ error: 'Synthetic setup failure' }));
      expect(toast.error).toHaveBeenCalledWith('Synthetic setup failure');
      expect(listeners.size).toBe(0);
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      const newId = runGoogleAutoConfig.mock.calls[1][1].requestId;
      expect(newId).not.toBe(oldId);
      expect(listeners.size).toBe(1);
      emit(oldId, 'capturing', 'Previous run');
      expect(screen.queryByText('Previous run')).not.toBeInTheDocument();
      const staleListener = [...listeners][0];
      view.unmount();
      expect(listeners.size).toBe(0);
      act(() => staleListener({ requestId: newId, step: 'done', message: 'Unmounted run' }));
      await act(async () => settle({ status: 'success' }));
      expect(toast.success).not.toHaveBeenCalledWith(name === 'Calendar' ? 'Google OAuth setup complete!' : 'Google OAuth setup complete');
    });
  });
}

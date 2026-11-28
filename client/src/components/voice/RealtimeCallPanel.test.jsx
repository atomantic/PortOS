import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ getVoiceRealtimeStatus: vi.fn(), updateVoiceConfig: vi.fn(), startRealtimeCall: vi.fn() }));
vi.mock('../../services/apiVoice', () => ({ getVoiceRealtimeStatus: mocks.getVoiceRealtimeStatus, updateVoiceConfig: mocks.updateVoiceConfig }));
vi.mock('../../services/voiceRealtime', () => ({ startRealtimeCall: mocks.startRealtimeCall }));

import RealtimeCallPanel, { SOPHON_INSTALL_COMMAND } from './RealtimeCallPanel';

const installed = { enabled: true, installed: true, size: '32B', home: '/models/sophon', parts: { python: true, engine: true, weights: true } };

describe('RealtimeCallPanel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows what is missing and the install command when the model is not installed', async () => {
    mocks.getVoiceRealtimeStatus.mockResolvedValue({ ...installed, installed: false, parts: { python: true, engine: false, weights: false } });
    render(<RealtimeCallPanel />);
    expect(await screen.findByText(/missing engine, weights/)).toBeInTheDocument();
    expect(screen.getByText(SOPHON_INSTALL_COMMAND)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start realtime call' })).toBeNull();
  });

  it('saves the enable switch and the model size', async () => {
    mocks.getVoiceRealtimeStatus.mockResolvedValue({ ...installed, enabled: false });
    mocks.updateVoiceConfig.mockResolvedValue({});
    render(<RealtimeCallPanel />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable realtime calls' }));
    await waitFor(() => expect(mocks.updateVoiceConfig).toHaveBeenCalledWith({ realtime: { enabled: true } }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '4B' } });
    await waitFor(() => expect(mocks.updateVoiceConfig).toHaveBeenCalledWith({ realtime: { size: '4B' } }));
  });

  it('starts a call, shows live captions for replies and delegated tasks, and hangs up', async () => {
    mocks.getVoiceRealtimeStatus.mockResolvedValue(installed);
    const stop = vi.fn();
    let handlers;
    mocks.startRealtimeCall.mockImplementation(async (h) => { handlers = h; return { stop }; });
    render(<RealtimeCallPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start realtime call' }));
    await waitFor(() => expect(handlers).toBeTruthy());
    await act(async () => {});
    act(() => {
      handlers.onState({ active: true });
      handlers.onDelegate({ task: 'What time is it?' });
      handlers.onResult({ text: 'It is 9 PM.' });
      handlers.onReply({ text: "It's 9 PM.", cancelled: false });
    });
    expect(await screen.findByText('Realtime call live')).toBeInTheDocument();
    expect(screen.getByText('Looking up: What time is it?')).toBeInTheDocument();
    expect(screen.getByText('Result: It is 9 PM.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hang up' }));
    expect(stop).toHaveBeenCalled();
  });

  it('shows a start failure from the server and ends the call', async () => {
    mocks.getVoiceRealtimeStatus.mockResolvedValue(installed);
    const stop = vi.fn();
    let handlers;
    mocks.startRealtimeCall.mockImplementation(async (h) => { handlers = h; return { stop }; });
    render(<RealtimeCallPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start realtime call' }));
    await waitFor(() => expect(handlers).toBeTruthy());
    await act(async () => {});
    act(() => handlers.onState({ active: false, error: 'Realtime voice did not finish loading.' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('did not finish loading');
    expect(stop).toHaveBeenCalled();
  });
  it('stops a call that finishes starting after the user hung up', async () => {
    mocks.getVoiceRealtimeStatus.mockResolvedValue(installed);
    const stop = vi.fn();
    let resolveStart;
    mocks.startRealtimeCall.mockImplementation(() => new Promise((resolve) => { resolveStart = resolve; }));
    render(<RealtimeCallPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start realtime call' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Hang up' }));
    await act(async () => resolveStart({ stop }));
    expect(stop).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Start realtime call' })).toBeInTheDocument();
  });
});

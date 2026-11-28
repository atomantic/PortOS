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

  it('allows switching to 4B and changing install path even when the default 32B weights are missing', async () => {
    mocks.getVoiceRealtimeStatus
      .mockResolvedValueOnce({ ...installed, installed: false, size: '32B', parts: { python: true, engine: true, weights: false } })
      .mockResolvedValueOnce({ ...installed, installed: true, size: '4B', enabled: false })
      .mockResolvedValueOnce({ ...installed, installed: true, size: '4B', home: '/custom/sophon', enabled: false });
    mocks.updateVoiceConfig.mockResolvedValue({});
    render(<RealtimeCallPanel />);
    expect(await screen.findByText(/missing weights/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Enable realtime calls' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '4B' } });
    await waitFor(() => expect(mocks.updateVoiceConfig).toHaveBeenCalledWith({ realtime: { size: '4B' } }, { silent: true }));
    expect(await screen.findByRole('checkbox', { name: 'Enable realtime calls' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Install path'), { target: { value: '/custom/sophon' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save path' }));
    await waitFor(() => expect(mocks.updateVoiceConfig).toHaveBeenCalledWith({ realtime: { home: '/custom/sophon' } }, { silent: true }));
  });

  it('preserves an unsaved install-path draft when model size or refresh updates status', async () => {
    mocks.getVoiceRealtimeStatus
      .mockResolvedValueOnce({ ...installed, enabled: false, size: '32B' })
      .mockResolvedValueOnce({ ...installed, enabled: false, size: '4B' });
    mocks.updateVoiceConfig.mockResolvedValue({});
    render(<RealtimeCallPanel />);
    const input = await screen.findByLabelText('Install path');
    fireEvent.change(input, { target: { value: '/unsaved/custom/path' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '4B' } });
    await waitFor(() => expect(mocks.updateVoiceConfig).toHaveBeenCalledWith({ realtime: { size: '4B' } }, { silent: true }));
    expect(screen.getByLabelText('Install path')).toHaveValue('/unsaved/custom/path');
  });

  it('saves the enable switch and the model size', async () => {
    mocks.getVoiceRealtimeStatus.mockResolvedValue({ ...installed, enabled: false });
    mocks.updateVoiceConfig.mockResolvedValue({});
    render(<RealtimeCallPanel />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Enable realtime calls' }));
    await waitFor(() => expect(mocks.updateVoiceConfig).toHaveBeenCalledWith({ realtime: { enabled: true } }, { silent: true }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '4B' } });
    await waitFor(() => expect(mocks.updateVoiceConfig).toHaveBeenCalledWith({ realtime: { size: '4B' } }, { silent: true }));
  });

  it('starts a call, shows live captions, interrupts on demand, and hangs up', async () => {
    mocks.getVoiceRealtimeStatus.mockResolvedValue(installed);
    const stop = vi.fn();
    const interrupt = vi.fn();
    let handlers;
    mocks.startRealtimeCall.mockImplementation(async (h) => { handlers = h; return { stop, interrupt }; });
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
    const captionLog = screen.getByRole('log', { name: 'Realtime captions' });
    expect(captionLog).toHaveAttribute('aria-live', 'polite');
    expect(captionLog).toHaveTextContent('Looking up: What time is it?');
    expect(captionLog).toHaveTextContent('Result: It is 9 PM.');
    expect(screen.getByRole('heading', { level: 2, name: 'Realtime call live' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(interrupt).toHaveBeenCalled();
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

  it('hides the start button and explains why when Voice mode is turned off', async () => {
    mocks.getVoiceRealtimeStatus.mockResolvedValue({ ...installed, voiceEnabled: false });
    render(<RealtimeCallPanel />);
    expect(await screen.findByText(/Turn on Voice mode in Voice settings/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start realtime call' })).toBeNull();
  });
});

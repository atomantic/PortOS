import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getDigitalTwinStatus: vi.fn(),
  getDigitalTwinSettings: vi.fn(),
}));
vi.mock('../services/api', () => api);
vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});
vi.mock('../components/digital-twin/tabs/OverviewTab', () => ({
  default: ({ settings, onRefresh, onSettingsChange }) => <div>
    <span>Context: {settings?.maxContextTokens}</span>
    <button onClick={onRefresh}>Refresh snapshot</button>
    <button onClick={() => onSettingsChange({ maxContextTokens: 9000 })}>Apply saved settings</button>
  </div>,
}));
import socket from '../services/socket';
import DigitalTwin from './DigitalTwin';

beforeEach(() => {
  vi.clearAllMocks();
  api.getDigitalTwinStatus.mockResolvedValue({ healthScore: 10, documentCount: 2, enabledDocuments: 1 });
  api.getDigitalTwinSettings.mockResolvedValue({ maxContextTokens: 4000 });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const mount = async () => {
  const result = render(<MemoryRouter><DigitalTwin /></MemoryRouter>);
  await screen.findByText('Context: 4000');
  return result;
};
const reads = count => {
  expect(api.getDigitalTwinStatus).toHaveBeenCalledTimes(count);
  expect(api.getDigitalTwinSettings).toHaveBeenCalledTimes(count);
};

describe('Digital Twin snapshot lifecycle', () => {
  it('reads on events, reconnect and reshow without recurring reads; removes listeners on unmount', async () => {
    const view = await mount();
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    reads(1);
    api.getDigitalTwinStatus.mockResolvedValue({ healthScore: 70, documentCount: 4, enabledDocuments: 3 });
    api.getDigitalTwinSettings.mockResolvedValue({ maxContextTokens: 8000 });
    await act(async () => { socket.emit('digital-twin:changed', {}); });
    expect(screen.getByText('3/4 docs')).toBeInTheDocument();
    expect(screen.getByText('Context: 8000')).toBeInTheDocument();
    reads(2);
    await act(async () => { socket.emit('connect'); });
    reads(3);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      socket.emit('digital-twin:changed', {});
    });
    reads(3);
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    reads(4);
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    reads(4);
    view.unmount();
    await act(async () => { socket.emit('digital-twin:changed', {}); socket.emit('connect'); });
    reads(4);
  });

  it('retains last good data on errors and protects immediate mutation updates from an older read', async () => {
    await mount();
    api.getDigitalTwinSettings.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { socket.emit('digital-twin:changed', {}); });
    expect(screen.getByText('Context: 4000')).toBeInTheDocument();
    expect(screen.getByText('1/2 docs')).toBeInTheDocument();
    let finish;
    api.getDigitalTwinSettings.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await act(async () => { fireEvent.click(screen.getByText('Refresh snapshot')); });
    fireEvent.click(screen.getByText('Apply saved settings'));
    expect(screen.getByText('Context: 9000')).toBeInTheDocument();
    await act(async () => { finish({ maxContextTokens: 4000 }); });
    expect(screen.getByText('Context: 9000')).toBeInTheDocument();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import JevIntegrations from './JevIntegrations';
import { getJevPolicy, updateJevPolicy, updateInstanceFeature } from '../../services/api';
import { publishInstanceFeatures } from '../../hooks/useInstanceFeatures';

vi.mock('../../services/api', () => ({ getJevPolicy: vi.fn(), updateJevPolicy: vi.fn(), updateInstanceFeature: vi.fn() }));
vi.mock('../../hooks/useInstanceFeatures', () => ({
  useInstanceFeatures: () => ({ features: [{ id: 'jev', enabled: false }], error: null }),
  publishInstanceFeatures: vi.fn(),
}));
vi.mock('../../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});
import socket from '../../services/socket';
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const policy = { scopeAdherenceEnabled: true, sources: {
  'github-issue': { jevMode: 'off', jevMinMargin: null },
  email: { jevMode: 'prefer', jevMinMargin: 0.3 },
  'stacker-news': { jevMode: 'only', jevMinMargin: null },
} };
beforeEach(() => {
  vi.clearAllMocks();
  getJevPolicy.mockResolvedValue(policy);
});

describe('Jev integration management', () => {
  it('distinguishes enablement from residency, displays definitions, and saves explicit disabling', async () => {
    let finishSave;
    updateJevPolicy.mockImplementation(() => new Promise(resolve => { finishSave = resolve; }));
    render(<JevIntegrations status={{ ready: true, resident: false }} registry={{ example: {
      label: 'Example question', minMargin: 0.2, options: [{ value: 'yes', hypothesis: 'Example hypothesis.' }],
    } }} />);
    const control = await screen.findByLabelText('Issue replies and forge maintenance');
    await waitFor(() => expect(control).toBeEnabled());
    expect(screen.getByRole('status')).toHaveTextContent('Integrations: disabled. Runtime: installed, idle.');
    expect(control).toHaveValue('off');
    expect(screen.getByText(/Example hypothesis/)).toBeInTheDocument();
    fireEvent.change(control, { target: { value: 'disabled' } });
    expect(updateJevPolicy).toHaveBeenCalledWith({ sources: { 'github-issue': { jevMode: 'disabled' } } }, { silent: true });
    expect(control).toBeDisabled();
    getJevPolicy.mockResolvedValue({ ...policy, sources: { ...policy.sources, 'github-issue': { jevMode: 'disabled' } } });
    finishSave(await getJevPolicy());
    await waitFor(() => expect(control).toHaveValue('disabled'));
    updateInstanceFeature.mockResolvedValue({ features: [{ id: 'jev', enabled: true }] });
    fireEvent.click(screen.getByRole('button', { name: 'Enable Jev integrations' }));
    await waitFor(() => expect(publishInstanceFeatures).toHaveBeenCalledWith([{ id: 'jev', enabled: true }], { groups: undefined }));
  });

  it('keeps the saved setting and reports failed writes', async () => {
    updateJevPolicy.mockRejectedValue(new Error('offline'));
    render(<JevIntegrations />);
    const control = await screen.findByLabelText('Issue / PR scope adherence');
    await waitFor(() => expect(control).toBeEnabled());
    fireEvent.change(control, { target: { value: 'disabled' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save');
    expect(control).toHaveValue('enabled');
  });
});

it('updates policy from events without polling and reconciles once on reconnect and tab show', async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const view = render(<JevIntegrations />);
  await act(async () => {});
  const control = screen.getByLabelText('Issue / PR scope adherence');
  expect(control).toHaveValue('enabled');
  expect(getJevPolicy).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(90000); });
  expect(getJevPolicy).toHaveBeenCalledTimes(1);
  getJevPolicy.mockResolvedValue({ ...policy, scopeAdherenceEnabled: false });
  await act(async () => { socket.emit('jev:policy', {}); });
  expect(control).toHaveValue('disabled');
  expect(getJevPolicy).toHaveBeenCalledTimes(2);
  await act(async () => { socket.emit('connect'); });
  expect(getJevPolicy).toHaveBeenCalledTimes(3);
  visibility.mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { socket.emit('jev:policy', {}); socket.emit('connect'); });
  expect(getJevPolicy).toHaveBeenCalledTimes(3);
  visibility.mockReturnValue('visible');
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(getJevPolicy).toHaveBeenCalledTimes(4);
  await act(async () => document.dispatchEvent(new Event('visibilitychange')));
  expect(getJevPolicy).toHaveBeenCalledTimes(4);
  getJevPolicy.mockRejectedValue(new Error('Settings unavailable'));
  await act(async () => { socket.emit('jev:policy', {}); });
  expect(screen.getByRole('alert')).toHaveTextContent('Could not refresh');
  expect(control).toBeDisabled();
  getJevPolicy.mockResolvedValue(policy);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
  expect(control).toBeEnabled();
  expect(control).toHaveValue('enabled');
  view.unmount();
  const reads = getJevPolicy.mock.calls.length;
  await act(async () => { socket.emit('jev:policy', {}); socket.emit('connect'); });
  expect(getJevPolicy).toHaveBeenCalledTimes(reads);
});

it('keeps the saved response when an older event read finishes later', async () => {
  render(<JevIntegrations />);
  const control = screen.getByLabelText('Issue / PR scope adherence');
  await waitFor(() => expect(control).toBeEnabled());
  let finishRead;
  getJevPolicy.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  await act(async () => { socket.emit('jev:policy', {}); });
  updateJevPolicy.mockResolvedValue({ ...policy, scopeAdherenceEnabled: false });
  await act(async () => { fireEvent.change(control, { target: { value: 'disabled' } }); });
  expect(control).toHaveValue('disabled');
  await act(async () => { finishRead(policy); });
  expect(control).toHaveValue('disabled');
});

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import LoraDatasetDetail from './LoraDatasetDetail';
import { cancelLoraCaptionRun, getLoraDataset, startLoraCaptionRun } from '../services/api';
import socket from '../services/socket';

vi.mock('../services/api', () => ({
  getLoraDataset: vi.fn(), getUniverse: vi.fn(), startLoraCaptionRun: vi.fn(), cancelLoraCaptionRun: vi.fn(),
}));
vi.mock('../components/ui/Toast', () => ({
  default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));
vi.mock('../services/socket', () => {
  const handlers = new Map();
  return { default: {
    on: (event, handler) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(handler); },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: (event, payload) => handlers.get(event)?.forEach(handler => handler(payload)),
  } };
});
// Controllable SSE stream: the test pushes frames; the page reads them through
// the real useSseJobSlot, so adoption/cancel/settlement are exercised end to end.
const sse = vi.hoisted(() => {
  const listeners = new Set();
  let value = { latest: null, closed: false, isOpen: true, frames: [] };
  return {
    urls: [],
    get: () => value,
    push: (frame) => { value = { latest: frame, closed: true, isOpen: false, frames: [frame] }; listeners.forEach(fn => fn()); },
    reset: () => { value = { latest: null, closed: false, isOpen: true, frames: [] }; sse.urls.length = 0; },
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  };
});
vi.mock('../hooks/useSseProgress', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    isTerminalSseFrame: frame => ['complete', 'error', 'canceled'].includes(frame?.type),
    useSseProgress: (url) => {
      const value = useSyncExternalStore(sse.subscribe, sse.get);
      if (url) sse.urls.push(url);
      return url ? { ...value, latestUrl: url } : { latest: null, closed: false, isOpen: false, frames: [] };
    },
  };
});
vi.mock('../components/loraTraining/TrainingPanel', () => ({ default: () => null }));
vi.mock('../components/loraTraining/CaptionModelPicker', () => ({ default: () => null }));
vi.mock('../components/loraTraining/DatasetImageGrid', () => ({
  default: ({ dataset }) => <div>{dataset.images.map(image => <span key={image.id}>{image.status}</span>)}</div>,
}));
const dataset = (id, status = 'rendering') => ({
  id, character: { name: id, entryKind: 'characters' }, triggerWord: 'example',
  images: [{ id: 'image-1', status, file: 'example.png', caption: '' }], training: {},
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); sse.reset(); });
it('updates on scoped persistence events, reconnect and tab show without polling', async () => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  getLoraDataset.mockResolvedValue(dataset('example-a'));
  render(<MemoryRouter><LoraDatasetDetail recordId="example-a" /></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByText('rendering')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(16000); });
  expect(getLoraDataset).toHaveBeenCalledTimes(1);
  await act(async () => { socket.emit('training:dataset:changed', { datasetId: 'other' }); });
  expect(getLoraDataset).toHaveBeenCalledTimes(1);
  getLoraDataset.mockResolvedValue(dataset('example-a', 'ready'));
  await act(async () => { socket.emit('training:dataset:changed', { datasetId: 'example-a' }); });
  expect(screen.getByText('ready')).toBeTruthy();
  expect(getLoraDataset).toHaveBeenCalledTimes(2);
  await act(async () => { socket.emit('connect'); });
  expect(getLoraDataset).toHaveBeenCalledTimes(3);
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    socket.emit('training:dataset:changed', { datasetId: 'example-a' });
  });
  expect(getLoraDataset).toHaveBeenCalledTimes(3);
  getLoraDataset.mockResolvedValue(dataset('example-a', 'failed'));
  await act(async () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(screen.getByText('failed')).toBeTruthy();
  expect(getLoraDataset).toHaveBeenCalledTimes(4);
});
it('reads a changed route and ignores the previous response and events', async () => {
  let resolveOld;
  getLoraDataset.mockImplementation(id => id === 'example-a'
    ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve(dataset(id, 'ready')));
  const view = render(<MemoryRouter><LoraDatasetDetail recordId="example-a" /></MemoryRouter>);
  await act(async () => {});
  view.rerender(<MemoryRouter><LoraDatasetDetail recordId="example-b" /></MemoryRouter>);
  await act(async () => {});
  await act(async () => { resolveOld(dataset('example-a')); });
  expect(screen.getByText('example-b')).toBeTruthy();
  expect(screen.queryByText('rendering')).toBeNull();
  await act(async () => { socket.emit('training:dataset:changed', { datasetId: 'example-a' }); });
  expect(getLoraDataset).toHaveBeenCalledTimes(2);
});

const readyDataset = (captionRun = null) => ({
  ...dataset('example-a', 'ready'),
  images: [{ id: 'image-1', status: 'ready', file: 'example.png', caption: '' }],
  readiness: {}, captionRun,
});
const activeRun = { runId: 'run-1', datasetId: 'example-a', status: 'running', provider: 'p', model: 'm', total: 3, done: 1, failed: 0 };

it('re-attaches to the server caption run after a remount and cancels it from there', async () => {
  getLoraDataset.mockResolvedValue(readyDataset(activeRun));
  cancelLoraCaptionRun.mockResolvedValue({ canceled: true });
  const first = render(<MemoryRouter><LoraDatasetDetail recordId="example-a" /></MemoryRouter>);
  await act(async () => {});
  expect(screen.getByRole('button', { name: /Cancel/ })).toBeTruthy();
  first.unmount();
  // Reload / second tab: a fresh mount adopts the same run from the dataset read.
  render(<MemoryRouter><LoraDatasetDetail recordId="example-a" /></MemoryRouter>);
  await act(async () => {});
  expect(screen.getAllByText(/Captioning 1\/3/).length).toBeGreaterThan(0);
  expect(sse.urls.at(-1)).toBe('/api/lora-datasets/example-a/caption-runs/run-1/events');
  expect(screen.getByRole('button', { name: /^Captioning 1\/3/ }).disabled).toBe(true);
  expect(startLoraCaptionRun).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /^Cancel/ }));
  expect(cancelLoraCaptionRun).toHaveBeenCalledWith('example-a', 'run-1', { silent: true });
  // The server's terminal canceled frame settles the UI and refetches the dataset.
  getLoraDataset.mockResolvedValue(readyDataset(null));
  await act(async () => { sse.push({ type: 'canceled', runId: 'run-1', done: 1, total: 3 }); });
  expect(screen.queryByRole('button', { name: /^Cancel/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Caption all/ }).disabled).toBe(false);
  expect(getLoraDataset).toHaveBeenCalledTimes(3);
  expect(startLoraCaptionRun).not.toHaveBeenCalled();
});

it('attaches to the holder when a start reports a conflicting active run', async () => {
  getLoraDataset.mockResolvedValue(readyDataset(null));
  startLoraCaptionRun.mockResolvedValue({ runId: 'run-9', alreadyRunning: true, conflict: true, total: 3 });
  render(<MemoryRouter><LoraDatasetDetail recordId="example-a" /></MemoryRouter>);
  await act(async () => {});
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Caption all/ })); });
  expect(sse.urls.at(-1)).toBe('/api/lora-datasets/example-a/caption-runs/run-9/events');
  expect(screen.getByRole('button', { name: /^Cancel/ })).toBeTruthy();
});

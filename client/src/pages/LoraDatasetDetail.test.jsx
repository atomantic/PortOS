import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import LoraDatasetDetail from './LoraDatasetDetail';
import { getLoraDataset } from '../services/api';
import socket from '../services/socket';

vi.mock('../services/api', () => ({ getLoraDataset: vi.fn(), getUniverse: vi.fn() }));
vi.mock('../services/socket', () => {
  const handlers = new Map();
  return { default: {
    on: (event, handler) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(handler); },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: (event, payload) => handlers.get(event)?.forEach(handler => handler(payload)),
  } };
});
vi.mock('../hooks/useSseProgress', () => ({ useSseProgress: () => ({}) }));
vi.mock('../components/loraTraining/TrainingPanel', () => ({ default: () => null }));
vi.mock('../components/loraTraining/CaptionModelPicker', () => ({ default: () => null }));
vi.mock('../components/loraTraining/DatasetImageGrid', () => ({
  default: ({ dataset }) => <div>{dataset.images.map(image => <span key={image.id}>{image.status}</span>)}</div>,
}));
const dataset = (id, status = 'rendering') => ({
  id, character: { name: id, entryKind: 'characters' }, triggerWord: 'example',
  images: [{ id: 'image-1', status, file: 'example.png', caption: '' }], training: {},
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });
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

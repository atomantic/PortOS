import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getReviewQueue: vi.fn(), handlers: new Map() }));
vi.mock('../services/apiReview.js', () => ({ getReviewQueue: mocks.getReviewQueue }));
vi.mock('../services/socket', () => ({ default: {
  on: (event, handler) => mocks.handlers.set(event, handler),
  off: (event) => mocks.handlers.delete(event),
} }));
import { __resetActionQueue, useActionQueue } from './useActionQueue';
function Consumer({ name }) {
  const { data } = useActionQueue();
  return <div data-testid={name}>{data?.items[0]?.title || 'Loading'}</div>;
}
const snapshot = (title) => ({ items: [{ id: 'example', title }], partial: false });
const settle = async (callback = () => {}) => act(async () => { callback(); });
/** Emit a socket event and wait out the burst window. */
const emit = (event, payload) => settle(() => { mocks.handlers.get(event)(payload); vi.advanceTimersByTime(150); });
beforeEach(() => {
  vi.useFakeTimers();
  mocks.getReviewQueue.mockReset().mockResolvedValue(snapshot('Initial'));
});
afterEach(() => {
  cleanup();
  __resetActionQueue();
  mocks.handlers.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it('shares event-driven reads, reconciles reconnect/re-show, and stops on unmount without polling', async () => {
  const view = render(<><Consumer name="first" /><Consumer name="second" /></>);
  await settle();
  expect(screen.getByTestId('first')).toHaveTextContent('Initial');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(1);
  await settle(() => vi.advanceTimersByTime(240_000));
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(1);
  mocks.getReviewQueue.mockResolvedValue(snapshot('Changed'));
  await emit('review:item:updated');
  expect(screen.getByTestId('second')).toHaveTextContent('Changed');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(2);
  await emit('connect');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(3);
  mocks.getReviewQueue.mockResolvedValue(snapshot('GitHub changed'));
  await emit('github:notifications:changed');
  expect(screen.getByTestId('first')).toHaveTextContent('GitHub changed');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(4);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(4);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(5);
  view.unmount();
  expect(mocks.handlers.size).toBe(0);
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(5);
});
it('refetches the shared Actions snapshot when X or Stacker News review state changes', async () => {
  const view = render(<Consumer name="first" />);
  await settle();
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(1);
  mocks.getReviewQueue.mockResolvedValue(snapshot('X draft submitted'));
  await emit('x:changed', { accountId: 'example' });
  expect(screen.getByTestId('first')).toHaveTextContent('X draft submitted');
  mocks.getReviewQueue.mockResolvedValue(snapshot('Stacker action created'));
  await emit('stacker-news:changed', { accountId: 'example' });
  expect(screen.getByTestId('first')).toHaveTextContent('Stacker action created');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(3);
  view.unmount();
});
it('reads once for a burst of events and waits for the tab to be shown', async () => {
  render(<Consumer name="first" />);
  await settle();
  mocks.getReviewQueue.mockResolvedValue(snapshot('After burst'));
  await settle(() => {
    mocks.handlers.get('cos:tasks:changed')();
    mocks.handlers.get('review:queue:changed')();
    vi.advanceTimersByTime(150);
  });
  expect(screen.getByTestId('first')).toHaveTextContent('After burst');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(2);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await emit('review:queue:changed');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(2);
  mocks.getReviewQueue.mockResolvedValue(snapshot('Shown again'));
  visibility.mockReturnValue('visible');
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(screen.getByTestId('first')).toHaveTextContent('Shown again');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(3);
});
it('reconciles invalidation during a pending shared read instead of publishing stale data', async () => {
  let resolve;
  mocks.getReviewQueue.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<Consumer name="first" />);
  await emit('review:item:updated');
  mocks.getReviewQueue.mockResolvedValue(snapshot('Fresh'));
  await settle(() => resolve(snapshot('Stale')));
  expect(screen.getByTestId('first')).toHaveTextContent('Fresh');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(2);
});

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getReviewQueue: vi.fn(), handlers: new Map() }));
vi.mock('../services/api', () => ({ getReviewQueue: mocks.getReviewQueue }));
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
  await settle(() => mocks.handlers.get('review:item:updated')());
  expect(screen.getByTestId('second')).toHaveTextContent('Changed');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(2);
  await settle(() => mocks.handlers.get('connect')());
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(3);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(3);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(4);
  view.unmount();
  expect(mocks.handlers.size).toBe(0);
  await settle(() => document.dispatchEvent(new Event('visibilitychange')));
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(4);
});
it('reconciles invalidation during a pending shared read instead of publishing stale data', async () => {
  let resolve;
  mocks.getReviewQueue.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  render(<Consumer name="first" />);
  await settle(() => mocks.handlers.get('review:item:updated')());
  mocks.getReviewQueue.mockResolvedValue(snapshot('Fresh'));
  await settle(() => resolve(snapshot('Stale')));
  expect(screen.getByTestId('first')).toHaveTextContent('Fresh');
  expect(mocks.getReviewQueue).toHaveBeenCalledTimes(2);
});

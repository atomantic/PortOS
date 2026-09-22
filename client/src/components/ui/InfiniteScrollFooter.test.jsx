import { useCallback } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { usePagedCollection } from '../../hooks/usePagedCollection';
import InfiniteScrollFooter from './InfiniteScrollFooter';

function Collection({ query, fetchPage }) {
  const readPage = useCallback(args => fetchPage(query, args), [query, fetchPage]);
  const page = usePagedCollection(readPage);
  return <><button onClick={page.refreshFirst}>Refresh</button><ul>{page.items.map(item => <li key={item.id}>{item.id}</li>)}</ul>
    <InfiniteScrollFooter {...page} onLoadMore={page.loadMore} /></>;
}
afterEach(() => vi.unstubAllGlobals());

it('coalesces intersections, rejects obsolete query results, and retries the same cursor', async () => {
  let intersect;
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback) { intersect = callback; }
    observe() {}
    disconnect() {}
  });
  let resolveOld, resolveNext;
  const fetchPage = vi.fn()
    .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ items: [{ id: 'current' }], nextCursor: 'page-two' })
    .mockRejectedValueOnce(new Error('Offline'))
    .mockImplementationOnce(() => new Promise(resolve => { resolveNext = resolve; }));
  const view = render(<Collection query="old" fetchPage={fetchPage} />);
  view.rerender(<Collection query="current" fetchPage={fetchPage} />);
  await screen.findByText('current');
  await act(async () => resolveOld({ items: [{ id: 'obsolete' }], nextCursor: null }));
  expect(screen.queryByText('obsolete')).toBeNull();
  await act(async () => { intersect([{ isIntersecting: true }]); intersect([{ isIntersecting: true }]); });
  expect(fetchPage).toHaveBeenCalledTimes(3);
  expect(await screen.findByRole('alert')).toHaveTextContent('Offline');
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
  expect(fetchPage.mock.calls.at(-1)[1].cursor).toBe('page-two');
  await act(async () => resolveNext({ items: [{ id: 'current' }, { id: 'older' }], nextCursor: null }));
  await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
  expect(screen.getByRole('status')).toHaveTextContent('All results loaded');
});


it('backfills the gap after reconnect when new records fill an entire first page', async () => {
  const fetchPage = vi.fn()
    .mockResolvedValueOnce({ items: [{ id: 'old' }], nextCursor: 'older' })
    .mockResolvedValueOnce({ items: [{ id: 'new' }], nextCursor: 'gap' })
    .mockResolvedValueOnce({ items: [{ id: 'between' }, { id: 'old' }], nextCursor: 'older' });
  render(<Collection query="history" fetchPage={fetchPage} />);
  await screen.findByText('old');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByText('new');
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('between');
  expect(fetchPage.mock.calls.at(-1)[1].cursor).toBe('gap');
  expect(screen.getAllByText('old')).toHaveLength(1);
});


it('retries a failed head refresh rather than skipping to an older page', async () => {
  const fetchPage = vi.fn()
    .mockResolvedValueOnce({ items: [{ id: 'old' }], nextCursor: 'older' })
    .mockRejectedValueOnce(new Error('Refresh failed'))
    .mockResolvedValueOnce({ items: [{ id: 'new' }, { id: 'old' }], nextCursor: 'older' });
  render(<Collection query="history" fetchPage={fetchPage} />);
  await screen.findByText('old');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
  await screen.findByText('new');
  expect(fetchPage.mock.calls.at(-1)[1].cursor).toBeNull();
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MediaHistoryGrid from './MediaHistoryGrid';

let columns;
let width;
let observers;
const items = Array.from({ length: 1200 }, (_, n) => ({ key: `image:${n}` }));
const rect = (top, height, rectWidth) => ({ top, bottom: top + height, left: 0, right: rectWidth, width: rectWidth, height, x: 0, y: top });
beforeEach(() => {
  columns = 5; width = 1000; observers = [];
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(element => element.hasAttribute('data-media-history-grid')
    ? { gridTemplateColumns: Array(columns).fill(`${width / columns}px`).join(' ') } : computed(element));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this.hasAttribute('data-media-history-grid')) return rect(100 - this.parentElement.scrollTop, 10000, width);
    if (this.hasAttribute('data-media-row')) return rect(0, 200, width);
    return rect(0, 600, width);
  });
  vi.stubGlobal('ResizeObserver', vi.fn(function (callback) {
    const targets = new Set();
    this.observe = element => targets.add(element);
    this.disconnect = () => targets.clear();
    observers.push(() => callback([...targets].map(target => ({ target }))));
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const notify = () => act(() => { for (const observer of [...observers]) observer(); });
const card = item => <><button type="button">{item.key}</button><input aria-label={`Draft ${item.key}`} /></>;

it('bounds mounted rows across a long scroll, pins keyboard focus, and returns to the first row', async () => {
  const { container } = render(<main style={{ overflowY: 'auto' }}><MediaHistoryGrid items={items}>{card}</MediaHistoryGrid></main>);
  const main = container.firstChild;
  Object.defineProperty(main, 'clientHeight', { configurable: true, value: 600 });
  notify();
  expect(screen.getAllByRole('button').length).toBeLessThanOrEqual(60);
  act(() => screen.getByText('image:0').focus());
  main.scrollTop = 50000;
  fireEvent.scroll(main);
  await waitFor(() => expect(container.querySelector('[data-media-row="0"]')).toBeInTheDocument());
  await waitFor(() => expect(Number(container.querySelector('[data-media-history-grid]').dataset.windowStart)).toBeGreaterThan(50));
  expect(document.activeElement).toHaveTextContent('image:0');
  expect(screen.getAllByRole('button').length).toBeLessThanOrEqual(60);
  act(() => document.activeElement.blur());
  await waitFor(() => expect(screen.queryByText('image:0')).toBeNull());
  main.scrollTop = 0;
  fireEvent.scroll(main);
  await screen.findByText('image:0');
  expect(screen.getAllByRole('button').length).toBeLessThanOrEqual(60);
});

it('keeps the visible anchor through responsive regrouping and earlier-record deletion', async () => {
  const view = rows => <main style={{ overflowY: 'auto' }}><MediaHistoryGrid items={rows}>{card}</MediaHistoryGrid></main>;
  const { container, rerender } = render(view(items));
  const main = container.firstChild;
  Object.defineProperty(main, 'clientHeight', { configurable: true, value: 600 });
  notify();
  main.scrollTop = 10000;
  fireEvent.scroll(main);
  await waitFor(() => expect(Number(container.querySelector('[data-media-history-grid]').dataset.windowStart)).toBeGreaterThan(10));
  const before = Number(container.querySelector('[data-media-history-grid]').dataset.windowStart) * 5;
  columns = 2; width = 500;
  fireEvent(window, new Event('resize'));
  await waitFor(() => expect(container.querySelector('[data-media-history-grid]').dataset.columns).toBe('2'));
  await waitFor(() => expect(container.querySelector(`[data-media-key="image:${before}"]`)).toBeInTheDocument());
  expect(screen.getAllByRole('button').length).toBeLessThanOrEqual(24);
  rerender(view(items.slice(1)));
  await waitFor(() => expect(container.querySelector(`[data-media-key="image:${before}"]`)).toBeInTheDocument());
});

it('retains a focused boundary card across a prepend and does not reclaim deliberately moved focus', () => {
  const view = rows => <><MediaHistoryGrid items={rows}>{card}</MediaHistoryGrid><button type="button">Outside</button></>;
  const { rerender } = render(view(items));
  fireEvent.change(screen.getByLabelText('Draft image:4'), { target: { value: 'Unsaved collection' } });
  act(() => screen.getByText('image:4').focus());
  rerender(view([{ key: 'image:new' }, ...items]));
  expect(document.activeElement).toHaveTextContent('image:4');
  expect(screen.getByLabelText('Draft image:4')).toHaveValue('Unsaved collection');
  act(() => screen.getByText('Outside').focus());
  rerender(view(items));
  expect(document.activeElement).toHaveTextContent('Outside');
});

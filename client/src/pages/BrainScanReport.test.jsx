import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router';

vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});
import socket from '../services/socket';

vi.mock('../services/api', () => ({
  getBrainLink: vi.fn(),
  getBrainScanReport: vi.fn(),
}));

vi.mock('../components/cos/MarkdownOutput', () => ({
  default: ({ content }) => <div data-testid="markdown">{content}</div>,
}));

import * as api from '../services/api';
import BrainScanReport from './BrainScanReport';

const mountPage = () => render(
  <MemoryRouter initialEntries={['/brain/links/abc/scan-report']}>
    <Routes>
      <Route path="/brain/links/:id/scan-report" element={<BrainScanReport />} />
    </Routes>
  </MemoryRouter>
);

const renderPage = async () => {
  const result = mountPage();
  await act(async () => {});
  return result;
};

function NavigateToSecondLink() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/brain/links/def/scan-report')}>Second link</button>;
}

// `/brain*` is in Layout's isFullWidth list, so <main> is `overflow-hidden` and
// this page must supply its own scroll container — otherwise a long report is
// clipped with no way to reach the rest of it.
const expectOwnScrollContainer = (container) => {
  const scroller = container.querySelector('.overflow-y-auto');
  expect(scroller).not.toBeNull();
  expect(scroller.className).toContain('h-full');
};

describe('BrainScanReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scrolls its own content in the loaded state', async () => {
    api.getBrainLink.mockResolvedValue({ title: 'Example Link', url: 'https://example.com', malwareScan: { verdict: 'CLEAN' } });
    api.getBrainScanReport.mockResolvedValue('# Report\n\nlong body');

    const { container } = await renderPage();
    await waitFor(() => expect(screen.getByText('Example Link')).toBeInTheDocument());

    expectOwnScrollContainer(container);
    expect(screen.getByTestId('markdown')).toHaveTextContent('long body');
  });

  it('scrolls its own content in the loading state', async () => {
    api.getBrainLink.mockReturnValue(new Promise(() => {}));
    api.getBrainScanReport.mockReturnValue(new Promise(() => {}));

    const { container } = mountPage();
    expectOwnScrollContainer(container);
    // Preserve the intentionally pending state, but close the mount's act scope
    // before the test ends so no resolved child work can leak into another case.
    await act(async () => {});
  });

  it('scrolls its own content in the unavailable state', async () => {
    api.getBrainLink.mockRejectedValue(new Error('nope'));
    api.getBrainScanReport.mockRejectedValue(new Error('nope'));

    const { container } = await renderPage();
    await waitFor(() => expect(screen.getByText('This scan report is unavailable.')).toBeInTheDocument());
    expectOwnScrollContainer(container);
  });

  it('fetches the new link immediately and ignores a late response from the previous link', async () => {
    let resolveFirstReport;
    let resolveSecondReport;
    api.getBrainLink.mockImplementation((id) => Promise.resolve({
      title: id === 'abc' ? 'First link' : 'Second link',
      url: `https://example.com/${id}`,
    }));
    api.getBrainScanReport.mockImplementation((id) => new Promise((resolve) => {
      if (id === 'abc') resolveFirstReport = resolve;
      else resolveSecondReport = resolve;
    }));

    render(
      <MemoryRouter initialEntries={['/brain/links/abc/scan-report']}>
        <NavigateToSecondLink />
        <Routes>
          <Route path="/brain/links/:id/scan-report" element={<BrainScanReport />} />
        </Routes>
      </MemoryRouter>
    );
    await waitFor(() => expect(api.getBrainScanReport).toHaveBeenCalledWith('abc', { silent: true }));

    await act(async () => { screen.getByRole('button', { name: 'Second link' }).click(); });
    await waitFor(() => expect(api.getBrainScanReport).toHaveBeenCalledWith('def', { silent: true }));
    expect(screen.getByRole('status', { name: 'Loading scan report' })).toBeInTheDocument();
    expect(screen.queryByText('First link')).not.toBeInTheDocument();

    await act(async () => { resolveSecondReport('Second report'); });
    expect(await screen.findByText('Second link', { selector: 'h1' })).toBeInTheDocument();
    await act(async () => { resolveFirstReport('First report'); });
    expect(screen.getByTestId('markdown')).toHaveTextContent('Second report');
    expect(screen.queryByText('First link')).not.toBeInTheDocument();
  });
});

it('filters scan events, coalesces mid-read changes, and reconciles without polling', async () => {
  api.getBrainLink.mockResolvedValue({ title: 'Example Link', url: 'https://example.com' });
  api.getBrainScanReport.mockResolvedValue('Initial report');
  await renderPage();
  vi.useFakeTimers();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(api.getBrainScanReport).toHaveBeenCalledTimes(1);
    await act(async () => { socket.emit('brain:links:changed', { id: 'other' }); });
    expect(api.getBrainScanReport).toHaveBeenCalledTimes(1);
    let resolveRead;
    api.getBrainScanReport.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
    await act(async () => { socket.emit('brain:links:changed', { id: 'abc' }); });
    api.getBrainScanReport.mockResolvedValue('Completed report');
    await act(async () => {
      socket.emit('brain:links:changed', { id: 'abc' });
      socket.emit('brain:links:changed', { id: 'abc' });
    });
    expect(api.getBrainScanReport).toHaveBeenCalledTimes(2);
    await act(async () => { resolveRead('Earlier report'); });
    expect(api.getBrainScanReport).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('markdown')).toHaveTextContent('Completed report');
    api.getBrainScanReport.mockRejectedValueOnce(new Error('Unavailable'));
    await act(async () => { socket.emit('connect'); });
    expect(api.getBrainScanReport).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('markdown')).toHaveTextContent('Completed report');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(api.getBrainScanReport).toHaveBeenCalledTimes(5);
    visibility.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router';

vi.mock('../services/socket', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: new EventEmitter() };
});
import socket from '../services/socket';

vi.mock('../services/apiBrain.js', () => ({
  getBrainLink: vi.fn(),
  getBrainScanReport: vi.fn(),
}));

vi.mock('../components/cos/MarkdownOutput', () => ({
  default: ({ content }) => <div data-testid="markdown">{content}</div>,
}));

import { getBrainLink, getBrainScanReport } from '../services/apiBrain.js';
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
    getBrainLink.mockResolvedValue({ title: 'Example Link', url: 'https://example.com', malwareScan: { verdict: 'CLEAN' } });
    getBrainScanReport.mockResolvedValue('# Report\n\nlong body');

    const { container } = await renderPage();
    await waitFor(() => expect(screen.getByText('Example Link')).toBeInTheDocument());

    expectOwnScrollContainer(container);
    expect(screen.getByTestId('markdown')).toHaveTextContent('long body');
  });

  it('scrolls its own content in the loading state', async () => {
    getBrainLink.mockReturnValue(new Promise(() => {}));
    getBrainScanReport.mockReturnValue(new Promise(() => {}));

    const { container } = mountPage();
    expectOwnScrollContainer(container);
    // Preserve the intentionally pending state, but close the mount's act scope
    // before the test ends so no resolved child work can leak into another case.
    await act(async () => {});
  });

  it('shows the read error and retries both resources without a toast', async () => {
    getBrainLink.mockRejectedValueOnce(new Error('link read failed'));
    getBrainScanReport.mockRejectedValueOnce(new Error('report read failed'));
    getBrainLink.mockResolvedValue({ title: 'Example Link', url: 'https://example.com', malwareScan: { verdict: 'CLEAN' } });
    getBrainScanReport.mockResolvedValue('# Recovered report');

    const { container } = await renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('link read failed');
    expect(alert).toHaveTextContent('Retry');
    expect(screen.queryByText('This scan report is unavailable.')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to links' })).toBeInTheDocument();
    expectOwnScrollContainer(container);

    await act(async () => { screen.getByRole('button', { name: 'Retry' }).click(); });
    expect(await screen.findByText('Example Link', { selector: 'h1' })).toBeInTheDocument();
    expect(screen.getByText('CLEAN')).toBeInTheDocument();
    expect(screen.getByTestId('markdown')).toHaveTextContent('Recovered report');
    expect(getBrainLink).toHaveBeenCalledTimes(2);
    expect(getBrainScanReport).toHaveBeenCalledTimes(2);
    expect(getBrainLink).toHaveBeenLastCalledWith('abc', { silent: true });
    expect(getBrainScanReport).toHaveBeenLastCalledWith('abc', { silent: true });
  });

  it('reserves unavailable copy for a successful response without a report body', async () => {
    getBrainLink.mockResolvedValue({ title: 'Example Link', url: 'https://example.com' });
    getBrainScanReport.mockResolvedValue(null);

    await renderPage();
    expect(await screen.findByText('This scan report is unavailable.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a report read failure even when the link read succeeds', async () => {
    getBrainLink.mockResolvedValue({ title: 'Example Link', url: 'https://example.com' });
    getBrainScanReport.mockRejectedValue(new Error('report read failed'));

    await renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('report read failed');
    expect(screen.queryByText('This scan report is unavailable.')).not.toBeInTheDocument();
  });

  it('fetches the new link immediately and ignores a late response from the previous link', async () => {
    let resolveFirstReport;
    let resolveSecondReport;
    getBrainLink.mockImplementation((id) => Promise.resolve({
      title: id === 'abc' ? 'First link' : 'Second link',
      url: `https://example.com/${id}`,
    }));
    getBrainScanReport.mockImplementation((id) => new Promise((resolve) => {
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
    await waitFor(() => expect(getBrainScanReport).toHaveBeenCalledWith('abc', { silent: true }));

    await act(async () => { screen.getByRole('button', { name: 'Second link' }).click(); });
    await waitFor(() => expect(getBrainScanReport).toHaveBeenCalledWith('def', { silent: true }));
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
  getBrainLink.mockResolvedValue({ title: 'Example Link', url: 'https://example.com' });
  getBrainScanReport.mockResolvedValue('Initial report');
  await renderPage();
  vi.useFakeTimers();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(getBrainScanReport).toHaveBeenCalledTimes(1);
    await act(async () => { socket.emit('brain:links:changed', { id: 'other' }); });
    expect(getBrainScanReport).toHaveBeenCalledTimes(1);
    let resolveRead;
    getBrainScanReport.mockReturnValueOnce(new Promise(resolve => { resolveRead = resolve; }));
    await act(async () => { socket.emit('brain:links:changed', { id: 'abc' }); });
    getBrainScanReport.mockResolvedValue('Completed report');
    await act(async () => {
      socket.emit('brain:links:changed', { id: 'abc' });
      socket.emit('brain:links:changed', { id: 'abc' });
    });
    expect(getBrainScanReport).toHaveBeenCalledTimes(2);
    await act(async () => { resolveRead('Earlier report'); });
    expect(getBrainScanReport).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('markdown')).toHaveTextContent('Completed report');
    getBrainScanReport.mockRejectedValueOnce(new Error('Unavailable'));
    await act(async () => { socket.emit('connect'); });
    expect(getBrainScanReport).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('markdown')).toHaveTextContent('Completed report');
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    visibility.mockReturnValue('visible');
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(getBrainScanReport).toHaveBeenCalledTimes(5);
    visibility.mockRestore();
  } finally {
    vi.useRealTimers();
  }
});

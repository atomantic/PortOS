import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

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
});

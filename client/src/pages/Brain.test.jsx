import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// Brain's 14 tabs are past the compact threshold, so the bar collapses on a
// phone. It collapses to TabPills' ICON ROW, not the `<select>` #7283 briefly
// made universal — the preferred treatment for any bar whose tabs have icons.
const api = vi.hoisted(() => ({
  getBrainSummary: vi.fn(),
  getBrainSettings: vi.fn(),
}));

vi.mock('../services/api', () => api);

// Keep this suite scoped to the tab bar itself — each lazy tab body has its
// own real dependencies (sockets, forms, three.js for the graph) that have no
// stake in this regression.
vi.mock('../components/brain/tabs/InboxTab', () => ({ default: () => <div data-testid="inbox-tab" /> }));
vi.mock('../components/brain/tabs/LinksTab', () => ({ default: () => <div data-testid="links-tab" /> }));
vi.mock('../components/brain/tabs/MemoryTab', () => ({ default: () => <div data-testid="memory-tab" /> }));
vi.mock('../components/brain/tabs/IdeasTab', () => ({ default: () => <div data-testid="ideas-tab" /> }));
vi.mock('../components/brain/tabs/DigestTab', () => ({ default: () => <div data-testid="digest-tab" /> }));
vi.mock('../components/brain/tabs/FeedsTab', () => ({ default: () => <div data-testid="feeds-tab" /> }));
vi.mock('../components/brain/tabs/TrustTab', () => ({ default: () => <div data-testid="trust-tab" /> }));
vi.mock('../components/brain/tabs/NotesTab', () => ({ default: () => <div data-testid="notes-tab" /> }));
vi.mock('../components/brain/tabs/DailyLogTab', () => ({ default: () => <div data-testid="daily-log-tab" /> }));
vi.mock('../components/brain/tabs/ConfigTab', () => ({ default: () => <div data-testid="config-tab" /> }));
vi.mock('../components/brain/tabs/ImportTab', () => ({ default: () => <div data-testid="import-tab" /> }));
vi.mock('../components/brain/tabs/BrainGraph', () => ({ default: () => <div data-testid="graph-tab" /> }));
vi.mock('../components/brain/tabs/SpotifyTab', () => ({ default: () => <div data-testid="spotify-tab" /> }));
vi.mock('../components/brain/tabs/YoutubeTab', () => ({ default: () => <div data-testid="youtube-tab" /> }));

const { default: Brain } = await import('./Brain');

beforeEach(() => {
  vi.clearAllMocks();
  api.getBrainSummary.mockResolvedValue({ counts: {}, needsReview: 0 });
  api.getBrainSettings.mockResolvedValue({});
});

const renderPageAt = (tab) => render(
  <MemoryRouter initialEntries={[`/brain/${tab}`]}>
    <Routes>
      <Route path="/brain/:tab" element={<Brain />} />
    </Routes>
  </MemoryRouter>,
);

const renderSettledAt = async (tab) => {
  const result = await renderPageAt(tab);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  await act(async () => {});
  return result;
};

describe('Brain mobile tab navigation', () => {
  it('collapses to named icon links on the phone, not a select', async () => {
    await renderSettledAt('links');

    expect(screen.queryByRole('combobox', { name: 'Brain sections' })).toBeNull();
    const linksTab = screen.getByRole('tab', { name: 'Links' });
    expect(linksTab).toHaveAttribute('aria-selected', 'true');
    expect(linksTab.querySelector('svg')).toBeTruthy();
    expect(linksTab.querySelector('.max-sm\\:sr-only')).toBeTruthy();
  });

  it('navigates to the tab route when an icon is clicked', async () => {
    await renderSettledAt('inbox');
    expect(await screen.findByTestId('inbox-tab')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Memory' }));

    expect(await screen.findByTestId('memory-tab')).toBeInTheDocument();
  });
});

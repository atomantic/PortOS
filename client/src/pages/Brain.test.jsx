import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// Regression coverage for #7283 — past MOBILE_DROPDOWN_THRESHOLD tabs, Brain
// used to pass `hideLabelOnMobile` (an icon-only phone row) instead of the
// `mobileDropdown` `<select>` every other many-tab section uses.
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
  const result = renderPageAt(tab);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  return result;
};

describe('Brain mobile tab navigation (#7283)', () => {
  it('renders a labelled mobile select naming the current tab instead of unlabelled icons', async () => {
    await renderSettledAt('links');

    const select = screen.getByRole('combobox', { name: 'Brain sections' });
    expect(select).toHaveAttribute('id', 'brain-sections-select');
    expect(select.value).toBe('links');
  });

  it('navigates to the selected tab route when an option is chosen', async () => {
    await renderSettledAt('inbox');
    expect(await screen.findByTestId('inbox-tab')).toBeInTheDocument();

    const select = screen.getByRole('combobox', { name: 'Brain sections' });
    fireEvent.change(select, { target: { value: 'memory' } });

    expect(await screen.findByTestId('memory-tab')).toBeInTheDocument();
  });
});

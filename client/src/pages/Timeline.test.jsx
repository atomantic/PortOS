import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  getTimelineDay: vi.fn(() => Promise.resolve({
    date: '2026-01-02',
    today: '2026-01-02',
    events: [],
    counts: { total: 0, bySource: {}, byKind: {} },
    histogram: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
  })),
  importSpotifyHistory: vi.fn(),
  importTakeoutLocationHistory: vi.fn(),
  importDiscordHistory: vi.fn(),
  importWhatsappHistory: vi.fn(),
  importBrowserHistory: vi.fn(),
  importYoutubeHistory: vi.fn(),
  importGmailMbox: vi.fn(),
}));

import Timeline from './Timeline';
import { IMPORT_SOURCE_COUNT } from '../components/timeline/TimelineImportPanels';

const renderPage = () => render(<MemoryRouter><Timeline /></MemoryRouter>);

const panelRegion = () => document.getElementById('timeline-import-panels');

describe('Timeline import-history disclosure (#3789)', () => {
  it('keeps the backfill importers collapsed so the day view stays above the fold', async () => {
    renderPage();
    await screen.findByText('No recorded activity on this day.');
    const toggle = screen.getByRole('button', { name: `Import history (${IMPORT_SOURCE_COUNT})` });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(panelRegion().hidden).toBe(true);
    // Hidden, but still MOUNTED — collapsing mid-upload must not discard a
    // picked file or an in-flight import.
    expect(screen.getByText('Import Spotify history')).toBeTruthy();
    // The day's own content still renders without expanding anything.
    expect(screen.getByLabelText('Hourly activity histogram')).toBeTruthy();
  });

  it('reveals every source panel when the disclosure is opened', async () => {
    renderPage();
    await screen.findByText('No recorded activity on this day.');
    fireEvent.click(screen.getByRole('button', { name: `Import history (${IMPORT_SOURCE_COUNT})` }));
    expect(panelRegion().hidden).toBe(false);
    // Every registered connector renders one collapsed panel header.
    expect(screen.getAllByText('Backfill')).toHaveLength(IMPORT_SOURCE_COUNT);
  });

  it('offers the backfill affordance from the empty-day state and scrolls the panels into view', async () => {
    const scrollIntoView = vi.fn();
    renderPage();
    const backfill = await screen.findByRole('button', { name: 'Backfill from an export' });
    panelRegion().scrollIntoView = scrollIntoView;
    fireEvent.click(backfill);
    expect(panelRegion().hidden).toBe(false);
    expect(scrollIntoView).toHaveBeenCalled();
    // The shortcut stays put (it must not vanish under the cursor) and keeps
    // scrolling to the already-open panels.
    fireEvent.click(screen.getByRole('button', { name: 'Backfill from an export' }));
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});

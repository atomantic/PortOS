import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../services/api', () => ({
  getTimelineDay: vi.fn(() => Promise.resolve({
    date: '2026-01-02',
    today: '2026-01-02',
    events: [],
    counts: { total: 0, bySource: {}, byKind: {} },
    histogram: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
  })),
  getTimelineSources: vi.fn(() => Promise.resolve({ sources: [] })),
  eraseTimelineSource: vi.fn(),
  importSpotifyHistory: vi.fn(),
  importTakeoutLocationHistory: vi.fn(),
  importDiscordHistory: vi.fn(),
  importWhatsappHistory: vi.fn(),
  importBrowserHistory: vi.fn(),
  importYoutubeHistory: vi.fn(),
  importGmailMbox: vi.fn(),
}));

import * as api from '../services/api';
import Timeline from './Timeline';
import { IMPORT_SOURCE_COUNT } from '../components/timeline/TimelineImportPanels';

const renderPage = async () => {
  const result = render(<MemoryRouter><Timeline /></MemoryRouter>);
  await act(async () => {});
  return result;
};

const panelRegion = () => document.getElementById('timeline-import-panels');

describe('Timeline import-history disclosure (#3789)', () => {
  it('keeps the backfill importers collapsed so the day view stays above the fold', async () => {
    await renderPage();
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
    await renderPage();
    await screen.findByText('No recorded activity on this day.');
    fireEvent.click(screen.getByRole('button', { name: `Import history (${IMPORT_SOURCE_COUNT})` }));
    expect(panelRegion().hidden).toBe(false);
    // Every registered connector renders one collapsed panel header.
    expect(screen.getAllByText('Backfill')).toHaveLength(IMPORT_SOURCE_COUNT);
  });

  it('offers the backfill affordance from the empty-day state and scrolls the panels into view', async () => {
    const scrollIntoView = vi.fn();
    await renderPage();
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

describe('Timeline bounded event page (#11151)', () => {
  it('retains the populated day while a confirmed source deletion refreshes its counts', async () => {
    const empty = {
      date: '2026-01-02', today: '2026-01-02', events: [],
      counts: { total: 0, bySource: {}, byKind: {} }, histogram: [],
    };
    let finishRefresh;
    api.getTimelineDay.mockResolvedValueOnce({
      ...empty,
      events: [{ id: 'imported', source: 'browser', kind: 'web.visit', happenedAt: '2026-01-02T12:00:00Z', title: 'Imported event' }],
      counts: { total: 1, bySource: { browser: 1 }, byKind: { 'web.visit': 1 } },
    }).mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
    api.getTimelineSources.mockResolvedValueOnce({ sources: [{ source: 'browser', eventCount: 1 }] });
    api.eraseTimelineSource.mockResolvedValueOnce({ deleted: 1 });
    await renderPage();
    await screen.findByText('Imported event');
    fireEvent.click(screen.getByRole('button', { name: `Import history (${IMPORT_SOURCE_COUNT})` }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'browser' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }));
    await waitFor(() => expect(finishRefresh).toBeTypeOf('function'));
    expect(screen.getByText('Imported event')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading timeline')).not.toBeInTheDocument();
    await act(async () => { finishRefresh(empty); });
    expect(await screen.findByText('No recorded activity on this day.')).toBeInTheDocument();
  });

  it('labels the listed rows as a page while totals stay full-day', async () => {
    api.getTimelineDay.mockResolvedValueOnce({
      date: '2026-01-02',
      today: '2026-01-02',
      timezone: 'UTC',
      events: [{ id: 'e1', source: 's', kind: 'message.received', happenedAt: '2026-01-02T12:00:00Z', title: 'Hi' }],
      eventPage: { total: 2001, returned: 1, limit: 2000, hasMore: true },
      counts: { total: 2001, bySource: { s: 2001 }, byKind: { 'message.received': 2001 } },
      histogram: Array.from({ length: 24 }, (_, hour) => ({ hour, count: hour === 8 ? 1 : 0 })),
    });
    await renderPage();
    expect(await screen.findByText('2,001 events')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Showing the latest 1 of 2,001 events/);
  });

  it('shows no page notice when every event is listed', async () => {
    await renderPage();
    expect(screen.queryByRole('status')).toBeNull();
  });
});

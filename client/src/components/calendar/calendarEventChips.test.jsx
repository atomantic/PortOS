import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// One suite for the three views because the thing under test is one contract
// shared across them: a subcalendar color is external Google Calendar data, so
// every chip that paints it as TEXT has to run it through `chipContrast` for the
// ACTIVE theme mode. Per-view files would triple the socket/api/theme scaffold
// to assert the same two lines.

const { socketMock } = vi.hoisted(() => ({
  socketMock: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));
vi.mock('../../services/socket', () => ({ default: socketMock }));

const { themeMode } = vi.hoisted(() => ({ themeMode: { current: 'night' } }));
vi.mock('../ThemeContext', () => ({
  useThemeContext: () => ({ theme: { mode: themeMode.current } }),
}));

vi.mock('../../services/api', () => ({
  getCalendarEvents: vi.fn(),
  getChronotypeEnergySchedule: vi.fn(),
}));

import * as api from '../../services/api';
import { chipColors, parseColor } from '../../lib/chipContrast';
import MonthView from './MonthView';
import WeekView from './WeekView';
import DayView from './DayView';
import ChronotypeOverlay from './ChronotypeOverlay';

// A pale entry from Google's own subcalendar palette — the class of color that
// rendered near-invisible on the day themes.
const SUBCALENDAR_COLOR = '#fbd75b';
const ACCOUNTS = [{ subcalendars: [{ calendarId: 'cal-1', color: SUBCALENDAR_COLOR }] }];

const at = (hour, minute = 0, dayOffset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const ALL_DAY = {
  id: 'e1', accountId: 'acct-1', subcalendarId: 'cal-1',
  title: 'Quarter Close', isAllDay: true, startTime: at(0), endTime: at(23),
};
const TIMED = {
  id: 'e2', accountId: 'acct-1', subcalendarId: 'cal-1',
  title: 'Design Review', isAllDay: false, startTime: at(10), endTime: at(11),
};

const renderView = async (ui) => {
  render(<MemoryRouter>{ui}</MemoryRouter>);
  // Settle the mount-effect fetch inside act (see src/test/setup.js).
  await act(async () => {});
};

const chipFor = (title) => screen.getByRole('button', { name: new RegExp(title) });

/** The graded color for the ACTIVE mode, and for the other one. */
const expectGradedForActiveMode = (element, rawColor) => {
  const other = themeMode.current === 'day' ? 'night' : 'day';
  // parseColor on both sides: jsdom normalizes an inline `#rrggbb` into
  // `rgb(…)`, so comparing the raw strings would pass no matter which mode was
  // used to grade it.
  expect(parseColor(element.style.color))
    .toEqual(parseColor(chipColors(rawColor, themeMode.current).color));
  expect(parseColor(element.style.color))
    .not.toEqual(parseColor(chipColors(rawColor, other).color));
};

// `index.css` remaps these with `!important`, and author `!important` beats an
// inline declaration — so a chip that carries both renders in theme neutrals
// with its graded color silently dead. Day mode's remap covers `text-white`
// too, which is what made the timed-event titles ignore the block's color.
const IMPORTANT_UTILITIES = /(^|\s)(bg-port-bg|border-port-border|text-white|text-gray-\d00)(\s|$)/;
const IMPORTANT_TEXT_UTILITIES = /(^|\s)(text-white|text-gray-\d00)(\s|$)/;

const expectNoImportantUtilityUnderGrading = (container) => {
  for (const el of container.querySelectorAll('[style]')) {
    if (!el.style.color && !el.style.backgroundColor) continue;
    expect(el.className, `${el.tagName} carries a graded style AND an !important theme utility`)
      .not.toMatch(IMPORTANT_UTILITIES);
  }
};

/**
 * The graded color lives on the chip; the title is often a child that inherits
 * it. A child carrying `text-white`/`text-gray-*` overrides that inheritance
 * with `!important` on day mode — so assert every element that owns the title
 * text node is free of them.
 */
const expectTitleInheritsGrading = (chip, title) => {
  const owners = [chip, ...chip.querySelectorAll('*')].filter((el) => Array.from(el.childNodes)
    .some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.includes(title)));
  expect(owners.length, `no element renders "${title}"`).toBeGreaterThan(0);
  for (const el of owners) {
    expect(el.className, `"${title}" is painted by an !important theme utility, not the graded color`)
      .not.toMatch(IMPORTANT_TEXT_UTILITIES);
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  themeMode.current = 'night';
  api.getCalendarEvents.mockResolvedValue({ events: [ALL_DAY, TIMED] });
  api.getChronotypeEnergySchedule.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe.each([
  ['MonthView', (accounts) => <MonthView accounts={accounts} />, ['Quarter Close']],
  ['WeekView', (accounts) => <WeekView accounts={accounts} />, ['Quarter Close', 'Design Review']],
  ['DayView', (accounts) => <DayView accounts={accounts} />, ['Quarter Close', 'Design Review']],
])('%s event chips', (_name, renderTarget, titles) => {
  it.each(['day', 'night'])('grades the subcalendar color for the %s theme mode', async (mode) => {
    themeMode.current = mode;
    await renderView(renderTarget(ACCOUNTS));

    for (const title of titles) expectGradedForActiveMode(chipFor(title), SUBCALENDAR_COLOR);
  });

  it('falls back to the accent chip when the subcalendar has no color', async () => {
    await renderView(renderTarget([]));

    for (const title of titles) {
      // `var(--port-accent, #3b82f6)` was the old fallback and is not a color —
      // `--port-accent` is a bare RGB triple, so it has to be wrapped in `rgb()`.
      expect(chipFor(title).style.color).toMatch(/^rgb\(var\(--port-accent/);
    }
  });

  it('never ships a graded inline style alongside an !important theme utility', async () => {
    themeMode.current = 'day';
    const { container } = render(<MemoryRouter>{renderTarget(ACCOUNTS)}</MemoryRouter>);
    await act(async () => {});
    expectNoImportantUtilityUnderGrading(container);
    for (const title of titles) expectTitleInheritsGrading(chipFor(title), title);
  });
});

describe.each([
  ['DayView', DayView],
  ['WeekView', WeekView],
])('%s full-day event placement', (name, View) => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 8, 12));
  });

  const event = (id, startTime, endTime) => ({ ...TIMED, id, title: id, startTime, endTime });
  const positions = (title) => screen.queryAllByRole('button', { name: title }).map(chip => ({
    top: Number.parseFloat(chip.style.top), height: Number.parseFloat(chip.style.height),
  }));
  const expectFullDayGrid = () => {
    const firstRow = screen.getByText('12 AM').closest('[style]');
    const hourRows = [...firstRow.parentElement.children].filter(row => row.style.height === '80px');
    expect(hourRows).toHaveLength(24);
    expect(screen.getByText('11 PM')).toBeInTheDocument();
  };

  it('keeps all 24 hours when the only event is during ordinary hours', async () => {
    api.getCalendarEvents.mockResolvedValue({ events: [event('Ordinary meeting', at(10), at(11))] });
    await renderView(<View accounts={ACCOUNTS} />);
    expectFullDayGrid();
    expect(positions('Ordinary meeting')).toEqual([{ top: 800, height: 80 }]);
  });

  it('positions early and late events inside the grid and opens their details', async () => {
    api.getCalendarEvents.mockResolvedValue({ events: [
      event('Early meeting', at(5), at(5, 30)),
      event('Late meeting', at(23, 30), at(23, 45)),
      event('Midnight finish', at(22), at(0, 0, 1)),
    ] });
    await renderView(<View accounts={ACCOUNTS} />);
    expectFullDayGrid();
    expect(positions('Early meeting')).toEqual([{ top: 400, height: 40 }]);
    expect(positions('Late meeting')).toEqual([{ top: 1880, height: 20 }]);
    expect(positions('Midnight finish')).toEqual([{ top: 1760, height: 160 }]);

    for (const title of ['Early meeting', 'Late meeting', 'Midnight finish']) {
      fireEvent.click(chipFor(title));
      const detail = await screen.findByRole('dialog', { name: title });
      fireEvent.click(within(detail).getByRole('button', { name: 'Close' }));
    }
  });

  it('clips overnight portions to each intersecting day and treats midnight as exclusive', async () => {
    api.getCalendarEvents.mockResolvedValue({ events: [
      event('Overnight arrival', at(22, 0, -1), at(1)),
      event('Overnight departure', at(23), at(2, 0, 1)),
      event('Already ended', at(23, 0, -1), at(0)),
    ] });
    await renderView(<View accounts={ACCOUNTS} />);
    if (name === 'DayView') {
      expect(positions('Overnight arrival')).toEqual([{ top: 0, height: 80 }]);
      expect(positions('Overnight departure')).toEqual([{ top: 1840, height: 80 }]);
      expect(positions('Already ended')).toEqual([]);
    } else {
      expect(positions('Overnight arrival')).toEqual([{ top: 1760, height: 160 }, { top: 0, height: 80 }]);
      expect(positions('Overnight departure')).toEqual([{ top: 1840, height: 80 }, { top: 0, height: 160 }]);
      expect(positions('Already ended')).toEqual([{ top: 1840, height: 80 }]);
    }
  });
});

it('requests the next local midnight on a daylight-saving transition day', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 2, 8, 12));
  api.getCalendarEvents.mockResolvedValue({ events: [] });
  await renderView(<DayView accounts={ACCOUNTS} />);
  expect(api.getCalendarEvents).toHaveBeenCalledWith({
    startDate: new Date(2026, 2, 8).toISOString(),
    endDate: new Date(2026, 2, 9).toISOString(),
    limit: 200,
  });
});

describe('ChronotypeOverlay zone labels', () => {
  const ZONES = {
    zones: [
      { id: 'z1', label: 'Peak Focus', color: '#f59e0b', startMin: 9 * 60, endMin: 11 * 60, opacity: 0.12 },
      { id: 'z2', label: 'Caffeine Cutoff', color: '#f59e0b', startMin: 14 * 60, marker: true },
    ],
  };

  it.each(['day', 'night'])('grades the label ink for the %s theme mode', async (mode) => {
    themeMode.current = mode;
    api.getChronotypeEnergySchedule.mockResolvedValue(ZONES);
    await renderView(<ChronotypeOverlay startHour={6} pxPerHour={60} />);

    // The amber zone is ~2.1:1 on a day card — the live AA failure this fixes.
    for (const label of ['Peak Focus', 'Caffeine Cutoff']) {
      expectGradedForActiveMode(screen.getByText(label), '#f59e0b');
    }
  });

  it('keeps the band fill on the zone\'s own raw color', async () => {
    api.getChronotypeEnergySchedule.mockResolvedValue(ZONES);
    const { container } = render(<ChronotypeOverlay startHour={6} pxPerHour={60} />);
    await act(async () => {});
    // The band is a large tint, not text — grading it would shift the wash the
    // zone is recognized by, and it carries no ink of its own.
    const band = container.querySelector('div[style*="opacity"]');
    expect(parseColor(band.style.backgroundColor)).toEqual(parseColor('#f59e0b'));
  });
});

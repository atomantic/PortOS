import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';

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
import { formatDateFull } from '../../utils/formatters';

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

const calendarPage = events => ({ events, total: events.length });

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

it('keeps all-day membership consistent across Day, Week, and Month views', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 23, 12));
  const allDay = (id, title, start, end) => ({
    ...ALL_DAY, id, title,
    startTime: new Date(2026, 8, start).toISOString(),
    endTime: new Date(2026, 8, end).toISOString(),
  });
  api.getCalendarEvents.mockResolvedValue(calendarPage([
    allDay('previous', 'Previous day only', 22, 23),
    allDay('spanning', 'Spanning days', 21, 25),
    allDay('tomorrow', 'Tomorrow only', 24, 25),
    { ...TIMED, id: 'overnight', title: 'Example overnight appointment', startTime: new Date(2026, 8, 22, 23).toISOString(), endTime: new Date(2026, 8, 23, 1).toISOString() },
  ]));
  const checkDayList = async name => {
    fireEvent.click(screen.getByRole('button', { name: name === 'Day' ? 'View day events' : `View day events for ${formatDateFull(new Date(2026, 8, 23))}` }));
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByRole('button', { name: /Spanning days/ })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /Example overnight appointment/ })).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: /Previous day only|Tomorrow only/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close day events' }));
  };

  const mounted = render(<MemoryRouter><DayView accounts={ACCOUNTS} /></MemoryRouter>);
  await act(async () => {});
  expect(screen.getAllByRole('button', { name: 'Spanning days' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Previous day only' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Tomorrow only' })).not.toBeInTheDocument();
  await checkDayList('Day');
  mounted.unmount();

  const week = render(<MemoryRouter><WeekView accounts={ACCOUNTS} /></MemoryRouter>);
  await act(async () => {});
  expect(screen.getAllByRole('button', { name: 'Spanning days' })).toHaveLength(4);
  await checkDayList('Week');
  week.unmount();

  render(<MemoryRouter><MonthView accounts={ACCOUNTS} /></MemoryRouter>);
  await act(async () => {});
  expect(screen.getAllByRole('button', { name: 'Spanning days' })).toHaveLength(4);
  await checkDayList('Month');
});

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
  api.getCalendarEvents.mockReset();
  themeMode.current = 'night';
  api.getCalendarEvents.mockResolvedValue(calendarPage([ALL_DAY, TIMED]));
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
    await renderView(renderTarget([{ subcalendars: [] }]));

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
  ['MonthView', (accounts) => <MonthView accounts={accounts} />],
  ['WeekView', (accounts) => <WeekView accounts={accounts} />],
  ['DayView', (accounts) => <DayView accounts={accounts} />],
])('%s zero-account empty state', (_name, renderTarget) => {
  it('renders a connect-calendar empty state instead of an empty grid when there are 0 accounts', async () => {
    await renderView(renderTarget([]));

    expect(screen.getByText('No calendar connected')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Add a calendar account' });
    expect(link.getAttribute('href')).toBe('/calendar/config');
    expect(screen.queryByText('12 AM')).not.toBeInTheDocument();
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
    api.getCalendarEvents.mockResolvedValue(calendarPage([event('Ordinary meeting', at(10), at(11))]));
    await renderView(<View accounts={ACCOUNTS} />);
    expectFullDayGrid();
    expect(positions('Ordinary meeting')).toEqual([{ top: 800, height: 80 }]);
  });

  it('positions early and late events inside the grid and opens their details', async () => {
    api.getCalendarEvents.mockResolvedValue(calendarPage([
      event('Early meeting', at(5), at(5, 30)),
      event('Late meeting', at(23, 30), at(23, 45)),
      event('Midnight finish', at(22), at(0, 0, 1)),
    ]));
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
    api.getCalendarEvents.mockResolvedValue(calendarPage([
      event('Overnight arrival', at(22, 0, -1), at(1)),
      event('Overnight departure', at(23), at(2, 0, 1)),
      event('Already ended', at(23, 0, -1), at(0)),
    ]));
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

describe.each([
  ['DayView', DayView, 'Next day'],
  ['WeekView', WeekView, 'Next week'],
])('%s event request ordering', (_name, View, nextLabel) => {
  let requests;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 8, 12));
    requests = [];
    api.getCalendarEvents.mockImplementation(params => new Promise(resolve => {
      requests.push({ params, resolve });
    }));
  });

  const resolveEvents = async (request, title) => {
    const start = new Date(request.params.startDate);
    start.setHours(10);
    const end = new Date(start);
    end.setHours(11);
    await act(async () => request.resolve(calendarPage([{
      ...TIMED, id: title, title, startTime: start.toISOString(), endTime: end.toISOString(),
    }])));
  };

  it('keeps the new date heading and events when the previous window resolves last', async () => {
    await renderView(<View accounts={ACCOUNTS} />);
    const oldHeading = screen.getByRole('heading', { level: 2 }).textContent;
    fireEvent.click(screen.getByRole('button', { name: nextLabel }));
    expect(requests).toHaveLength(2);
    const newHeading = screen.getByRole('heading', { level: 2 }).textContent;
    expect(newHeading).not.toBe(oldHeading);

    await resolveEvents(requests[1], 'Example current event');
    expect(chipFor('Example current event')).toBeInTheDocument();
    await resolveEvents(requests[0], 'Example previous event');

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe(newHeading);
    expect(chipFor('Example current event')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Example previous event/ })).not.toBeInTheDocument();
  });

  it('keeps the new window loading when an obsolete request finishes first', async () => {
    await renderView(<View accounts={ACCOUNTS} />);
    fireEvent.click(screen.getByRole('button', { name: nextLabel }));
    await resolveEvents(requests[0], 'Example previous event');
    expect(screen.getByText('Loading')).toBeInTheDocument();

    await resolveEvents(requests[1], 'Example current event');
    expect(screen.queryByText('Loading')).not.toBeInTheDocument();
    expect(chipFor('Example current event')).toBeInTheDocument();
  });

  it('keeps Today usable when already showing the current window', async () => {
    await renderView(<View accounts={ACCOUNTS} />);
    await resolveEvents(requests[0], 'Example current event');
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    if (requests.length > 1) await resolveEvents(requests[1], 'Example current event');
    expect(screen.queryByText('Loading')).not.toBeInTheDocument();
    expect(chipFor('Example current event')).toBeInTheDocument();
  });

  it('keeps the latest socket refresh and disposes its listener with pending work', async () => {
    const mounted = render(<MemoryRouter><View accounts={ACCOUNTS} /></MemoryRouter>);
    await resolveEvents(requests[0], 'Example initial event');
    const refresh = socketMock.on.mock.calls.find(([event]) => event === 'calendar:sync:completed')[1];
    act(() => { refresh(); refresh(); });
    expect(requests).toHaveLength(3);

    await resolveEvents(requests[2], 'Example refreshed event');
    await resolveEvents(requests[1], 'Example superseded refresh');
    expect(chipFor('Example refreshed event')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Example superseded refresh/ })).not.toBeInTheDocument();

    act(() => { refresh(); });
    mounted.unmount();
    expect(socketMock.off).toHaveBeenCalledWith('calendar:sync:completed', refresh);
    await resolveEvents(requests[3], 'Example late event');
    expect(screen.queryByRole('button', { name: /Example late event/ })).not.toBeInTheDocument();
  });
});

it('requests the next local midnight on a daylight-saving transition day', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 2, 8, 12));
  api.getCalendarEvents.mockResolvedValue(calendarPage([]));
  await renderView(<DayView accounts={ACCOUNTS} />);
  expect(api.getCalendarEvents).toHaveBeenCalledWith({
    startDate: new Date(2026, 2, 8).toISOString(),
    endDate: new Date(2026, 2, 9).toISOString(),
    limit: 200, offset: 0,
  }, { signal: expect.any(AbortSignal), silent: true });
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

function MonthHistory() {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <button onClick={() => navigate(-1)}>Browser Back</button>
    <output data-testid="month-url">{location.search}</output>
    <MonthView accounts={ACCOUNTS} />
  </>;
}

describe('MonthView overflow navigation', () => {
  beforeEach(() => {
    api.getCalendarEvents.mockResolvedValue(calendarPage([
      { ...TIMED, id: 'late', title: 'Example late appointment', startTime: new Date(2027, 0, 12, 18).toISOString(), endTime: new Date(2027, 0, 12, 19).toISOString() },
      { ...ALL_DAY, id: 'day', title: 'Example all-day entry', startTime: new Date(2027, 0, 12).toISOString(), endTime: new Date(2027, 0, 13).toISOString() },
      { ...TIMED, id: 'early', title: 'Example early appointment', startTime: new Date(2027, 0, 12, 8).toISOString(), endTime: new Date(2027, 0, 12, 9).toISOString() },
      { ...TIMED, id: 'hidden', title: 'Example hidden appointment', startTime: new Date(2027, 0, 12, 12).toISOString(), endTime: new Date(2027, 0, 12, 13).toISOString() },
    ]));
  });

  it('opens overflow, reloads details, returns to the day, and restores month/day history', async () => {
    const mounted = render(<MemoryRouter initialEntries={['/calendar/month?month=2027-01']}><MonthHistory /></MemoryRouter>);
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Example hidden appointment/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /View all 4 events/ }));
    const day = screen.getByRole('dialog');
    expect(within(day).getByText('4 events')).toBeInTheDocument();
    expect(within(day).getAllByRole('button').slice(1).map(button => button.textContent)).toEqual([
      expect.stringContaining('Example all-day entry'),
      expect.stringContaining('Example early appointment'),
      expect.stringContaining('Example hidden appointment'),
      expect.stringContaining('Example late appointment'),
    ]);
    fireEvent.click(within(day).getByRole('button', { name: /Example hidden appointment/ }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog', { name: 'Example hidden appointment' })).toBeInTheDocument();
    const reloadUrl = screen.getByTestId('month-url').textContent;
    mounted.unmount();
    render(<MemoryRouter initialEntries={['/calendar/month' + reloadUrl]}><MonthHistory /></MemoryRouter>);
    await act(async () => {});
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    for (const title of ['Example all-day entry', 'Example early appointment', 'Example late appointment']) {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: new RegExp(title) }));
      expect(screen.getByRole('dialog', { name: title })).toBeInTheDocument();
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    }
    fireEvent.click(screen.getByRole('button', { name: 'Close day events' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close day events' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'February 2027' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    await act(async () => {});
    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeInTheDocument();
  });

  it('restores keyboard focus to overflow after the nested detail journey', async () => {
    render(<MemoryRouter initialEntries={['/calendar/month?month=2027-01']}><MonthView accounts={ACCOUNTS} /></MemoryRouter>);
    await act(async () => {});
    const trigger = screen.getByRole('button', { name: /View all 4 events/ });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Example hidden appointment/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Close day events' }));
    expect(trigger).toHaveFocus();
  });

  it('waits for bookmarked event data before exposing a dismissible drawer', async () => {
    let finish;
    api.getCalendarEvents.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    render(<MemoryRouter initialEntries={['/calendar/month?month=2027-01&day=2027-01-12&event=acct-1:hidden']}><MonthView accounts={ACCOUNTS} /></MemoryRouter>);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => finish(calendarPage([{ ...TIMED, id: 'hidden', title: 'Example hidden appointment', startTime: new Date(2027, 0, 12, 12).toISOString(), endTime: new Date(2027, 0, 12, 13).toISOString() }])));
    expect(screen.getByRole('dialog', { name: 'Example hidden appointment' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    expect(screen.getByRole('button', { name: 'Close day events' })).toBeInTheDocument();
  });

  it.each(['2027-02-30', '2020-01-01', 'garbage'])('ignores malformed or off-grid day %s', async day => {
    render(<MemoryRouter initialEntries={['/calendar/month?month=2027-01&day=' + day]}><MonthView accounts={ACCOUNTS} /></MemoryRouter>);
    await act(async () => {});
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /View all 4 events/ })).toBeInTheDocument();
  });

  it('falls back from an invalid month and keeps a short day directly actionable', async () => {
    api.getCalendarEvents.mockResolvedValue(calendarPage([ALL_DAY, TIMED]));
    render(<MemoryRouter initialEntries={['/calendar/month?month=2027-99']}><MonthView accounts={ACCOUNTS} /></MemoryRouter>);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /View all/ })).not.toBeInTheDocument();
    fireEvent.click(chipFor('Quarter Close'));
    expect(screen.getByRole('dialog', { name: 'Quarter Close' })).toBeInTheDocument();
  });
});

// These regressions exercise the rendered grids rather than duplicating the
// collection hook's unit tests: a loaded row must become selectable in each UI.
describe('Calendar window completeness', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 23, 12));
  });

  const exampleEvent = (id, title = id, date = new Date(2026, 8, 23)) => {
    const end = new Date(date);
    end.setDate(end.getDate() + 1);
    return { ...ALL_DAY, id, title, startTime: date.toISOString(), endTime: end.toISOString() };
  };
  const firstPage = () => Array.from({ length: 200 }, (_, i) => exampleEvent(`example-${i}`));
  const mount = async View => renderView(<View accounts={ACCOUNTS} />);
  const openDay = () => fireEvent.click(screen.getByRole('button', { name: /View all .* events/ }));

  it.each([['Day', DayView], ['Week', WeekView], ['Month', MonthView]])(
    '%s loads the 201st event with capped requests and opens its details', async (name, View) => {
      const rows = [...firstPage(), exampleEvent('last', 'Example last event')];
      api.getCalendarEvents.mockImplementation(({ offset }) => Promise.resolve({ events: rows.slice(offset, offset + 200), total: rows.length }));
      await mount(View);
      expect(api.getCalendarEvents.mock.calls.map(([params]) => [params.limit, params.offset])).toEqual([[200, 0], [200, 200]]);
      expect(screen.queryByText(/Empty times may still be busy/)).not.toBeInTheDocument();
      if (name === 'Month') {
        openDay();
        expect(within(screen.getByRole('dialog')).getByText('201 events')).toBeInTheDocument();
      }
      fireEvent.click(screen.getByRole('button', { name: /Example last event/ }));
      expect(screen.getByRole('dialog', { name: 'Example last event' })).toBeInTheDocument();
    }
  );

  it.each([['Day', DayView], ['Week', WeekView], ['Month', MonthView]])('%s day list preserves partial events, retries the failed offset and deduplicates within each account', async (name, View) => {
    const first = firstPage();
    let finishRetry;
    api.getCalendarEvents
      .mockResolvedValueOnce({ events: first, total: 203 })
      .mockRejectedValueOnce(new Error('Example page failure'))
      .mockImplementationOnce(() => new Promise(resolve => { finishRetry = resolve; }));
    await mount(View);
    expect(screen.getByRole('alert')).toHaveTextContent(/incomplete.*empty times may still be busy/);
    expect(api.getCalendarEvents).toHaveBeenCalledTimes(2);
    if (name === 'Month') openDay();
    else fireEvent.click(screen.getByRole('button', { name: name === 'Day' ? 'View day events' : `View day events for ${formatDateFull(new Date(2026, 8, 23))}` }));
    let drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('200 events loaded')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /example-199$/ })).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Retry' }));
    expect(within(drawer).getByRole('button', { name: /example-199$/ })).toBeInTheDocument();
    expect(within(drawer).getByRole('status')).toHaveTextContent(/Loading calendar events/);
    await act(async () => finishRetry({ events: [
      first[199], // duplicate provider row must not become another event
      { ...first[0], accountId: 'acct-2', title: 'Example other account' },
      exampleEvent('last', 'Example recovered event'),
    ], total: 203 }));
    drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('202 events')).toBeInTheDocument();
    expect(within(drawer).getAllByRole('button', { name: /example-199$/ })).toHaveLength(1);
    expect(within(drawer).getByRole('button', { name: /Example other account$/ })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /Example recovered event$/ })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.getCalendarEvents.mock.calls.map(([params]) => params.offset)).toEqual([0, 200, 200]);
  });

  it.each([['day', DayView], ['week', WeekView], ['month', MonthView]])(
    'discards a pending page after rapid %s navigation', async (name, View) => {
      let finishOld;
      api.getCalendarEvents
        .mockResolvedValueOnce({ events: firstPage(), total: 201 })
        .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
        .mockImplementation(({ startDate }) => Promise.resolve(calendarPage([exampleEvent('current', 'Example current window', new Date(startDate))])));
      await mount(View);
      const oldSignal = api.getCalendarEvents.mock.calls[1][1].signal;
      fireEvent.click(screen.getByRole('button', { name: `Next ${name}` }));
      fireEvent.click(screen.getByRole('button', { name: `Next ${name}` }));
      await act(async () => {});
      expect(oldSignal.aborted).toBe(true);
      expect(screen.getByRole('button', { name: /Example current window/ })).toBeInTheDocument();
      await act(async () => finishOld({ events: [exampleEvent('obsolete', 'Example obsolete page')], total: 201 }));
      expect(screen.queryByRole('button', { name: /Example obsolete page/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /example-0$/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Example current window/ })).toBeInTheDocument();
    }
  );

  it('resets the same window on sync and ignores its obsolete later page', async () => {
    let finishOld;
    api.getCalendarEvents
      .mockResolvedValueOnce({ events: firstPage(), total: 201 })
      .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValueOnce(calendarPage([exampleEvent('synced', 'Example synced event')]));
    await mount(MonthView);
    const syncHandler = socketMock.on.mock.calls.find(([event]) => event === 'calendar:sync:completed')[1];
    await act(async () => syncHandler());
    await act(async () => finishOld({ events: [exampleEvent('obsolete', 'Example obsolete page')], total: 201 }));
    expect(screen.getByRole('button', { name: /Example synced event/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Example obsolete page/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View all/ })).not.toBeInTheDocument();
    expect(api.getCalendarEvents.mock.calls.map(([params]) => params.offset)).toEqual([0, 200, 0]);
  });

  it('shows Retry for an empty page before the advertised total instead of claiming completion or looping', async () => {
    api.getCalendarEvents.mockResolvedValue({ events: [], total: 201 });
    await mount(DayView);
    expect(screen.getByRole('alert')).toHaveTextContent(/incomplete/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(api.getCalendarEvents).toHaveBeenCalledTimes(1);
  });
});

function CalendarHistory({ View }) {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <button onClick={() => navigate(-1)}>Browser Back</button>
    <output data-testid="calendar-url">{location.search}</output>
    <View accounts={ACCOUNTS} />
  </>;
}

// Uniquely catches short overlapping events being reachable only through tiny
// blocks, plus loss of a non-current calendar window on detail/reload/Back.
describe.each([
  ['month', MonthView, 'month=2027-01', 'January 2027'],
  ['week', WeekView, 'week=2027-01-10', null],
  ['day', DayView, 'date=2027-01-12', formatDateFull(new Date(2027, 0, 12))],
])('%s contextual event selection', (name, View, context, heading) => {
  const events = Array.from({ length: 3 }, (_, i) => ({
    ...TIMED, id: `short-${i}`, title: `Example simultaneous appointment ${i} with a long wrapped title`,
    startTime: new Date(2027, 0, 12, 10).toISOString(),
    endTime: new Date(2027, 0, 12, 10, 15).toISOString(),
  }));
  const openDay = () => fireEvent.click(screen.getByRole('button', {
    name: name === 'day' ? 'View day events' : `View day events for ${formatDateFull(new Date(2027, 0, 12))}`,
  }));

  it('opens every short overlapping appointment and retains day and calendar context through reload and Back', async () => {
    api.getCalendarEvents.mockResolvedValue(calendarPage(events));
    const mounted = render(<MemoryRouter initialEntries={[`/calendar/${name}?${context}`]}><CalendarHistory View={View} /></MemoryRouter>);
    await act(async () => {});
    if (heading) expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
    openDay();
    expect(within(screen.getByRole('dialog')).getByText('3 events')).toBeInTheDocument();
    for (const event of events) {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: new RegExp(event.title) }));
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(screen.getByRole('dialog', { name: event.title })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
      expect(within(screen.getByRole('dialog')).getByText('3 events')).toBeInTheDocument();
    }
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: new RegExp(events[2].title) }));
    const reloadUrl = screen.getByTestId('calendar-url').textContent;
    expect(reloadUrl).toContain(context);
    expect(reloadUrl).toContain('day=2027-01-12');
    mounted.unmount();
    render(<MemoryRouter initialEntries={[`/calendar/${name}${reloadUrl}`]}><CalendarHistory View={View} /></MemoryRouter>);
    await act(async () => {});
    expect(screen.getByRole('dialog', { name: events[2].title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close', exact: true }));
    expect(within(screen.getByRole('dialog')).getByText('3 events')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close day events' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: `Next ${name}` }));
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Browser Back' }));
    await act(async () => {});
    expect(screen.getByTestId('calendar-url')).toHaveTextContent(context);
    if (heading) expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
  });
});

it('exposes a sparse Month date separately while preserving direct chip activation', async () => {
  api.getCalendarEvents.mockResolvedValue(calendarPage([{
    ...TIMED, startTime: new Date(2027, 0, 12, 10).toISOString(), endTime: new Date(2027, 0, 12, 10, 15).toISOString(),
  }]));
  await act(async () => render(<MemoryRouter initialEntries={['/calendar/month?month=2027-01']}><MonthView accounts={ACCOUNTS} /></MemoryRouter>));
  fireEvent.click(screen.getByRole('button', { name: `View day events for ${formatDateFull(new Date(2027, 0, 12))}` }));
  expect(within(screen.getByRole('dialog')).getByText('1 events')).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Design Review/ }));
  expect(screen.getByRole('dialog', { name: 'Design Review' })).toBeInTheDocument();
});

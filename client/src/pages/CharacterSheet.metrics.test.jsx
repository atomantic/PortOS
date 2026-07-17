import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Coverage for the Character sheet's metrics grid (#2676). The load-bearing behavior is the
// THREE-state rendering: the server distinguishes a real value (0 included) from a stat it
// could not read from a ratio with no denominator, and the UI must not collapse any of them
// into a fake 0.

const get = vi.fn();

vi.mock('../services/api', () => ({
  default: { get: (...a) => get(...a), post: vi.fn(), put: vi.fn() },
  generateAvatar: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../services/socket', () => ({
  default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock('../components/ui/Toast', () => ({
  default: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import CharacterSheet, { formatMetricValue } from './CharacterSheet';

const BASE_CHAR = {
  name: 'Aragorn',
  class: 'Ranger',
  level: 5,
  hp: 40,
  maxHp: 40,
  xp: 6500,
  avatarPath: null,
  events: [],
};

const metric = (overrides) => ({
  id: 'memoryCount',
  label: 'Memories',
  unit: 'count',
  hint: 'Captured in Brain',
  value: 42,
  unavailable: false,
  notApplicable: false,
  ...overrides,
});

// Assertions are scoped to the metrics region rather than the whole page: the sheet renders
// other numbers (HP, XP, the birthday-progress "0%") that would otherwise satisfy a
// page-wide query and let a broken tile pass.
const renderWithMetrics = async (metrics) => {
  get.mockResolvedValue({ ...BASE_CHAR, metrics });
  render(
    <MemoryRouter>
      <CharacterSheet />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('Aragorn')).toBeInTheDocument());
  const region = screen.queryByRole('region', { name: 'Metrics' });
  return region ? within(region) : null;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('formatMetricValue', () => {
  it('renders each unit in its own shape', () => {
    expect(formatMetricValue({ unit: 'count', value: 42 })).toBe('42');
    expect(formatMetricValue({ unit: 'days', value: 12 })).toBe('12d');
    expect(formatMetricValue({ unit: 'percent', value: 75 })).toBe('75%');
  });

  it('abbreviates a large count through the shared formatter rather than overflowing the tile', () => {
    expect(formatMetricValue({ unit: 'count', value: 12400 })).toBe('12.4K');
    expect(formatMetricValue({ unit: 'count', value: 3400000 })).toBe('3.4M');
  });

  it('renders a real 0 as "0", never as a dash', () => {
    // The dash is reserved for the two null states; a genuine zero is a real answer.
    expect(formatMetricValue({ unit: 'count', value: 0 })).toBe('0');
    expect(formatMetricValue({ unit: 'percent', value: 0 })).toBe('0%');
    expect(formatMetricValue({ unit: 'days', value: 0 })).toBe('0d');
  });
});

describe('MetricsCard rendering', () => {
  it('renders a tile per metric with its value, label and hint', async () => {
    const grid = await renderWithMetrics([
      metric(),
      metric({ id: 'postStreakDays', label: 'POST Streak', unit: 'days', value: 4, hint: 'Consecutive days of POST practice' }),
    ]);

    expect(grid.getByText('42')).toBeInTheDocument();
    expect(grid.getByText('Memories')).toBeInTheDocument();
    expect(grid.getByText('Captured in Brain')).toBeInTheDocument();
    expect(grid.getByText('4d')).toBeInTheDocument();
    expect(grid.getByText('POST Streak')).toBeInTheDocument();
  });

  it('renders a real 0 as 0 — NOT as unavailable', async () => {
    const grid = await renderWithMetrics([metric({ value: 0 })]);
    expect(grid.getByText('0')).toBeInTheDocument();
    expect(grid.queryByText('Unavailable')).not.toBeInTheDocument();
    expect(grid.queryByText('—')).not.toBeInTheDocument();
  });

  it('renders an unavailable stat as an explicit unavailable state, never a fake 0', async () => {
    // The whole point of the server's sentinel: "we could not read this" must not read as
    // "you have never done this".
    const grid = await renderWithMetrics([metric({ value: null, unavailable: true })]);

    expect(grid.getByText('Unavailable')).toBeInTheDocument();
    expect(grid.getByText('—')).toBeInTheDocument();
    expect(grid.queryByText('0')).not.toBeInTheDocument();
    // The tile still names the metric, so the user knows WHAT is unavailable.
    expect(grid.getByText('Memories')).toBeInTheDocument();
  });

  it('renders a not-applicable ratio with its own emptyLabel, not 0% and not "Unavailable"', async () => {
    const grid = await renderWithMetrics([
      metric({
        id: 'goalCompletionRate', label: 'Goal Follow-Through', unit: 'percent',
        value: null, notApplicable: true, emptyLabel: 'No goals resolved yet',
      }),
    ]);

    expect(grid.getByText('No goals resolved yet')).toBeInTheDocument();
    expect(grid.getByText('—')).toBeInTheDocument();
    expect(grid.queryByText('0%')).not.toBeInTheDocument();
    // Distinct from the unavailable state — the two say different things.
    expect(grid.queryByText('Unavailable')).not.toBeInTheDocument();
  });

  it('falls back to a generic label when a not-applicable metric ships no emptyLabel', async () => {
    const grid = await renderWithMetrics([metric({ value: null, notApplicable: true, emptyLabel: null })]);
    expect(grid.getByText('Not applicable yet')).toBeInTheDocument();
  });

  it('renders the healthy tiles when only SOME stats are unavailable', async () => {
    // One unreachable domain must not take the grid down with it.
    const grid = await renderWithMetrics([
      metric({ value: null, unavailable: true }),
      metric({ id: 'mediaRendered', label: 'Media Rendered', value: 31, hint: 'Images & videos in the media index' }),
    ]);

    expect(grid.getByText('Unavailable')).toBeInTheDocument();
    expect(grid.getByText('31')).toBeInTheDocument();
  });

  it('hides the card entirely when the server omitted metrics (?metrics=0)', async () => {
    // Absent means "not computed" — rendering an empty grid would imply it was computed and
    // came back empty.
    expect(await renderWithMetrics(undefined)).toBeNull();
  });

  it('hides the card when the server returned an empty metrics array', async () => {
    expect(await renderWithMetrics([])).toBeNull();
  });
});

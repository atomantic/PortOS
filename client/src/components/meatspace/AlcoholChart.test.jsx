import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/api', () => ({ getDailyAlcohol: vi.fn() }));
vi.mock('../../hooks/useChartColors.js', () => ({ default: () => ({ grid: '#000', axis: '#000' }) }));
// Recharts needs layout; a marker stands in for "a chart was drawn".
vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: ({ children }) => <div data-testid="chart">{children}</div>,
    BarChart: Pass, Bar: () => null, XAxis: () => null, YAxis: () => null,
    CartesianGrid: () => null, Tooltip: () => null, ReferenceLine: () => null
  };
});
import AlcoholChart from './AlcoholChart';
import * as api from '../../services/api';

afterEach(cleanup);

describe('AlcoholChart load failure vs empty', () => {
  it('hides the chart (no zero-filled days) when the read rejects, and redraws on retry', async () => {
    api.getDailyAlcohol.mockRejectedValueOnce(new Error('boom'));
    render(<AlcoholChart />);
    expect(await screen.findByText(/Could not load daily alcohol\./)).toBeInTheDocument();
    expect(screen.queryByTestId('chart')).not.toBeInTheDocument();
    expect(api.getDailyAlcohol.mock.calls.at(-1)[2]).toEqual({ silent: true });
    api.getDailyAlcohol.mockResolvedValueOnce([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('chart')).toBeInTheDocument();
  });

  it('draws the chart for a successful empty payload', async () => {
    api.getDailyAlcohol.mockResolvedValueOnce([]);
    render(<AlcoholChart />);
    expect(await screen.findByTestId('chart')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load daily alcohol/)).not.toBeInTheDocument();
  });
});

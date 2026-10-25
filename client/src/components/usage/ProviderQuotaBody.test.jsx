import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ProviderQuotaBody from './ProviderQuotaBody';

describe('ProviderQuotaBody', () => {
  const periodQuota = (period, keys = ['24h', '7d', '30d']) => {
    const periods = {
      '24h': { value: '1 render · 24h', detail: 'daily usage' },
      '7d': { value: '5 renders · week', detail: 'weekly usage' },
      '30d': { value: '14 renders · month', detail: 'monthly usage' },
    };
    return { supported: true, period, metrics: [{ key: 'renders', label: 'Renders', value: periods[period].value,
      periods: Object.fromEntries(keys.map(key => [key, periods[key]])) }] };
  };

  it('uses the loaded quota period when the first render has no quota', () => {
    const { rerender } = render(<ProviderQuotaBody quota={null} />);
    rerender(<ProviderQuotaBody quota={periodQuota('7d')} />);
    expect(screen.getByText('5 renders · week')).toBeInTheDocument();
    expect(screen.getByText('weekly usage')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Week', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '24h', pressed: false })).toBeInTheDocument();
  });

  it('preserves a valid user period across refreshed quota defaults', () => {
    const { rerender } = render(<ProviderQuotaBody quota={periodQuota('24h')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    rerender(<ProviderQuotaBody quota={periodQuota('7d')} />);
    expect(screen.getByText('14 renders · month')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Month', pressed: true })).toBeInTheDocument();
  });

  it('selects the current quota period when a previously chosen period disappears', () => {
    const { rerender } = render(<ProviderQuotaBody quota={periodQuota('24h')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    rerender(<ProviderQuotaBody quota={periodQuota('7d', ['24h', '7d'])} />);
    expect(screen.getByText('5 renders · week')).toBeInTheDocument();
    expect(screen.getByText('weekly usage')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Week', pressed: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Month' })).not.toBeInTheDocument();
  });

  it('uses the first available period when the quota default is unavailable', () => {
    render(<ProviderQuotaBody quota={periodQuota('7d', ['24h', '30d'])} />);
    expect(screen.getByText('1 render · 24h')).toBeInTheDocument();
    expect(screen.getByText('daily usage')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '24h', pressed: true })).toBeInTheDocument();
  });

  it('renders unsupported message when supported is false', () => {
    render(<ProviderQuotaBody quota={{ supported: false, note: 'Not supported' }} />);
    expect(screen.getByText('Not supported')).toBeInTheDocument();
  });

  it('renders pending state when pending is true without readings', () => {
    render(<ProviderQuotaBody quota={{ supported: true, pending: true, limits: [], metrics: [] }} />);
    expect(screen.getByText('Reading quota…')).toBeInTheDocument();
  });

  it('renders error state when error is present', () => {
    render(<ProviderQuotaBody quota={{ supported: true, error: 'Network error', limits: [], metrics: [] }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Network error');
  });

  it('renders metric without periods in single grid', () => {
    const quota = {
      supported: true,
      limits: [],
      metrics: [
        { key: 'm1', label: 'Codex · image_gen', value: '3 renders · 24h', detail: 'quota not reported' },
      ],
    };
    render(<ProviderQuotaBody quota={quota} />);
    expect(screen.getByText('Codex · image_gen')).toBeInTheDocument();
    expect(screen.getByText('3 renders · 24h')).toBeInTheDocument();
    expect(screen.getByText('quota not reported')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Usage period' })).not.toBeInTheDocument();
  });

  it('renders period toggle and updates metric tiles when toggling periods', () => {
    const quota = {
      supported: true,
      limits: [],
      period: '24h',
      metrics: [
        {
          key: 'imagegen-agy',
          label: 'Agy · generate_image',
          value: '1 render · 24h',
          detail: 'quota not reported by this CLI',
          periods: {
            '24h': { key: '24h', label: '24h', count: 1, failed: 0, value: '1 render · 24h', detail: 'quota not reported by this CLI' },
            '7d': { key: '7d', label: 'Week', count: 5, failed: 1, value: '5 renders · week', detail: '1 failed' },
            '30d': { key: '30d', label: 'Month', count: 14, failed: 2, value: '14 renders · month', detail: '2 failed' },
            reset: { key: 'reset', label: 'Reset', count: 3, failed: 0, value: '3 renders · reset', detail: 'since last reset' },
          },
        },
      ],
    };

    render(<ProviderQuotaBody quota={quota} />);

    // Period buttons should be present
    const group = screen.getByRole('group', { name: 'Usage period' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '24h' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Week' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Month' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();

    // Default 24h view
    expect(screen.getByText('1 render · 24h')).toBeInTheDocument();

    // Switch to Week
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    expect(screen.getByText('5 renders · week')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();

    // Switch to Month
    fireEvent.click(screen.getByRole('button', { name: 'Month' }));
    expect(screen.getByText('14 renders · month')).toBeInTheDocument();
    expect(screen.getByText('2 failed')).toBeInTheDocument();

    // Switch to Reset
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByText('3 renders · reset')).toBeInTheDocument();
    expect(screen.getByText('since last reset')).toBeInTheDocument();

    // Switch back to 24h
    fireEvent.click(screen.getByRole('button', { name: '24h' }));
    expect(screen.getByText('1 render · 24h')).toBeInTheDocument();
  });
});

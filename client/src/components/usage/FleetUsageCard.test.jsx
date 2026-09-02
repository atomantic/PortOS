import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import FleetUsageCard, { applyFleetBilling } from './FleetUsageCard';

const api = vi.hoisted(() => ({ updateUsageFleetBilling: vi.fn() }));
vi.mock('../../services/api', () => api);

const row = (overrides = {}) => ({
  instanceId: 'inst-a',
  name: 'Workshop',
  self: false,
  capturedAt: '2026-08-30T09:00:00.000Z',
  usesSubscriptions: true,
  totals: { sessions: 4, messages: 12, tokensIn: 1000, tokensOut: 2000, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 3.5 },
  ...overrides,
});

const fleet = {
  instances: [
    row({ instanceId: 'inst-self', name: 'Workshop', self: true, capturedAt: null }),
    row({ instanceId: 'inst-peer', name: 'Studio' }),
  ],
  totals: { sessions: 8, messages: 24, tokensIn: 2000, tokensOut: 4000, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 7 },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.updateUsageFleetBilling.mockResolvedValue({ instanceId: 'inst-peer', usesSubscriptions: false, apiBilledInstanceIds: ['inst-peer'] });
});

describe('applyFleetBilling', () => {
  it('drops an overridden API-billed row from the combined total but keeps it listed', () => {
    const view = applyFleetBilling(fleet, { 'inst-peer': false });
    expect(view.instances).toHaveLength(2);
    expect(view.includedCount).toBe(1);
    expect(view.totals.estimatedCost).toBe(3.5);
    expect(view.totals.sessions).toBe(4);
  });

  // An older payload that predates the field must still count every row —
  // missing is "on subscriptions", never "API billed".
  it('treats a missing usesSubscriptions flag as included', () => {
    const legacy = {
      instances: [row({ usesSubscriptions: undefined }), row({ instanceId: 'inst-peer', name: 'Studio', usesSubscriptions: undefined })],
    };
    const view = applyFleetBilling(legacy);
    expect(view.includedCount).toBe(2);
    expect(view.totals.estimatedCost).toBe(7);
  });
});

describe('FleetUsageCard', () => {
  it('renders a row per instance plus the combined total', () => {
    render(<FleetUsageCard fleet={fleet} />);
    // Mobile cards and the desktop table both render every row, so each label
    // legitimately appears twice.
    expect(screen.getAllByText('Studio')).toHaveLength(2);
    expect(screen.getAllByText('This machine')).toHaveLength(2);
    expect(screen.getAllByText('Fleet total')).toHaveLength(2);
    expect(screen.getByText('2 instances combined')).toBeInTheDocument();
  });

  // A single-machine install has nothing to compare against — the section is
  // noise there, so the server sends an empty list and the card must stay out
  // of the page entirely rather than rendering a one-row "fleet".
  it('renders nothing below two instances', () => {
    const { container: empty } = render(<FleetUsageCard fleet={{ instances: [], totals: null }} />);
    expect(empty).toBeEmptyDOMElement();
    const { container: single } = render(<FleetUsageCard fleet={{ instances: [row()], totals: row().totals }} />);
    expect(single).toBeEmptyDOMElement();
    const { container: absent } = render(<FleetUsageCard fleet={undefined} />);
    expect(absent).toBeEmptyDOMElement();
  });

  it('excludes an instance from the combined total when Subscriptions is turned off', async () => {
    const onSaved = vi.fn().mockResolvedValue({});
    render(<FleetUsageCard fleet={fleet} onSaved={onSaved} />);

    fireEvent.click(screen.getAllByRole('switch', { name: 'Count Studio toward subscription totals' })[0]);

    await waitFor(() => {
      expect(api.updateUsageFleetBilling).toHaveBeenCalledWith(
        { instanceId: 'inst-peer', usesSubscriptions: false },
        { silent: true },
      );
    });
    expect(screen.getByText('1 of 2 instances on subscriptions')).toBeInTheDocument();
    expect(screen.getAllByText('API billed').length).toBeGreaterThan(0);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

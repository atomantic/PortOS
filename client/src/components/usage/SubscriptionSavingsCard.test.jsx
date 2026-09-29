import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({ updateSubscriptionCosts: vi.fn() }));
vi.mock('../../services/api', () => api);

const { default: SubscriptionSavingsCard, buildCostPatch, parseCostInput } =
  await import('./SubscriptionSavingsCard');

const savings = {
  range: { start: '2026-02-01', end: '2026-02-07', days: 7 },
  configured: true,
  unmatchedApiCost: 12.5,
  families: [
    {
      family: 'claude', label: 'Claude Code', enabled: true, monthlyCost: 200, configured: true,
      periodCost: 46.0, apiCost: 812.44, savings: 766.44, multiplier: 17.7
    },
    {
      family: 'codex', label: 'Codex', enabled: true, monthlyCost: 0, configured: false,
      periodCost: 0, apiCost: 40, savings: 0, multiplier: null
    }
  ],
  totals: { monthlyCost: 200, periodCost: 46.0, apiCost: 812.44, savings: 766.44, savingsPercent: 94, multiplier: 17.7 }
};

beforeEach(() => {
  vi.clearAllMocks();
  api.updateSubscriptionCosts.mockResolvedValue({ costs: { claude: 200 } });
});

describe('parseCostInput', () => {
  it('reads a price, tolerating a typed dollar sign', () => {
    expect(parseCostInput('200')).toBe(200);
    expect(parseCostInput('$19.99')).toBe(19.99);
  });

  // Empty and 0 must be SENT as a clear, not omitted — omitting them would
  // leave the cancelled plan's old price in place.
  it('maps an emptied or zeroed field to an explicit clear', () => {
    expect(parseCostInput('')).toBeNull();
    expect(parseCostInput('0')).toBeNull();
  });

  it('skips unparseable input rather than clearing a fat-fingered price', () => {
    expect(parseCostInput('abc')).toBeUndefined();
    expect(parseCostInput('-5')).toBeUndefined();
  });
});

describe('buildCostPatch', () => {
  it('sends only the rows whose price actually changed', () => {
    expect(buildCostPatch({ claude: '200', codex: '20' }, savings.families)).toEqual({ codex: 20 });
  });

  it('sends a null for a cleared plan', () => {
    expect(buildCostPatch({ claude: '' }, savings.families)).toEqual({ claude: null });
  });

  it('ignores an unknown family', () => {
    expect(buildCostPatch({ nope: '5' }, savings.families)).toEqual({});
  });
});

describe('SubscriptionSavingsCard', () => {
  it('renders nothing until the server sends a savings block', () => {
    const { container } = render(<SubscriptionSavingsCard savings={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the total saved and each plan row', () => {
    render(<SubscriptionSavingsCard savings={savings} />);
    expect(screen.getAllByText('$766.44').length).toBeGreaterThan(0);
    expect(screen.getAllByLabelText('Monthly cost for Claude Code')[0]).toHaveValue(200);
    expect(screen.getAllByText('not priced').length).toBeGreaterThan(0);
  });

  // An estimated plan usually UNDERSTATES its API cost, so a low number must
  // not read as a plan that was not worth its price.
  it('badges a plan whose API cost is not fully measured', () => {
    const rows = savings.families.map((f) => (f.family === 'codex' ? { ...f, source: 'estimate' } : { ...f, source: 'measured' }));
    render(<SubscriptionSavingsCard savings={{ ...savings, families: rows }} />);
    expect(screen.getAllByText('estimated').length).toBeGreaterThan(0);
    expect(screen.queryByText('partly estimated')).toBeNull();
  });

  // The mobile layout used to omit the totals entirely, so a phone user could
  // price their plans and never see what they saved.
  it('renders the totals in both the mobile and desktop layouts', () => {
    render(<SubscriptionSavingsCard savings={savings} />);
    expect(screen.getAllByText('Total')).toHaveLength(2);
    expect(screen.getAllByText('$200/mo')).toHaveLength(2);
  });

  it('reports API cost no subscription covers', () => {
    render(<SubscriptionSavingsCard savings={savings} />);
    expect(screen.getByText(/of estimated API cost came from/)).toBeInTheDocument();
  });

  it('saves only the edited price and asks the parent to refetch', async () => {
    const onSaved = vi.fn();
    render(<SubscriptionSavingsCard savings={savings} onSaved={onSaved} />);

    expect(screen.queryByRole('button', { name: /Save costs/ })).toBeNull();
    fireEvent.change(screen.getAllByLabelText('Monthly cost for Codex')[0], { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: /Save costs/ }));

    await waitFor(() => expect(api.updateSubscriptionCosts).toHaveBeenCalledWith({ codex: 20 }, { silent: true }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('offers a price field for a plan whose provider is disabled', () => {
    const withDisabled = {
      ...savings,
      families: [{ ...savings.families[0], family: 'grok', label: 'Grok', enabled: false }]
    };
    render(<SubscriptionSavingsCard savings={withDisabled} />);
    expect(screen.getAllByLabelText('Monthly cost for Grok').length).toBeGreaterThan(0);
    expect(screen.getAllByText('disabled').length).toBeGreaterThan(0);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getSubscriptions: vi.fn(),
  getUsage: vi.fn(),
  getProviderUsage: vi.fn(),
  updateSubscriptionCosts: vi.fn(),
  updateSubscriptionPlanTiers: vi.fn(),
  setSubscriptionEnabled: vi.fn(),
}));
vi.mock('../../services/api', () => api);

const { default: SubscriptionsTab, buildRowPatch, parseTierInput } = await import('./SubscriptionsTab');

const claudeRow = {
  family: 'claude',
  label: 'Claude Code',
  enabled: true,
  monthlyCost: 200,
  planTier: 'Max 5x',
  providers: [{ id: 'claude-code', name: 'Claude Code', enabled: true }],
};

const codexRow = {
  family: 'codex',
  label: 'Codex',
  enabled: false,
  monthlyCost: 20,
  planTier: null,
  providers: [{ id: 'codex-cli', name: 'Codex', enabled: false }],
};

const renderTab = () => render(<MemoryRouter><SubscriptionsTab /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  api.getSubscriptions.mockResolvedValue({ families: [claudeRow, codexRow], costs: {}, tiers: {} });
  api.getUsage.mockResolvedValue({
    subscriptionSavings: {
      families: [
        { family: 'claude', configured: true, periodCost: 46, apiCost: 812.44, savings: 766.44 },
        { family: 'codex', configured: true, periodCost: 4.6, apiCost: 2, savings: -2.6 },
      ],
    },
  });
  api.getProviderUsage.mockResolvedValue({
    providers: [{
      family: 'claude', label: 'Claude Code', supported: true, pending: false,
      limits: [{ key: 'week', label: 'Weekly', percentUsed: 40, percentRemaining: 60 }],
    }],
  });
  api.updateSubscriptionCosts.mockResolvedValue({ costs: {} });
  api.updateSubscriptionPlanTiers.mockResolvedValue({ tiers: {} });
  api.setSubscriptionEnabled.mockResolvedValue({ family: 'codex', enabled: true, applied: true, changed: ['codex-cli'] });
});

describe('parseTierInput', () => {
  it('trims a label and maps an emptied field to an explicit clear', () => {
    expect(parseTierInput('  Max 20x ')).toBe('Max 20x');
    // Empty must be SENT as null, not omitted — omitting it would leave the
    // old tier on a plan the user is no longer on.
    expect(parseTierInput('')).toBeNull();
    expect(parseTierInput('   ')).toBeNull();
  });
});

describe('buildRowPatch', () => {
  it('returns null when nothing the user typed differs from what is stored', () => {
    expect(buildRowPatch(claudeRow, undefined)).toBeNull();
    expect(buildRowPatch(claudeRow, { cost: '200', tier: 'Max 5x' })).toBeNull();
  });

  it('patches only the field that changed', () => {
    expect(buildRowPatch(claudeRow, { cost: '200', tier: 'Max 20x' })).toEqual({ tier: 'Max 20x' });
    expect(buildRowPatch(claudeRow, { cost: '100' })).toEqual({ cost: 100 });
  });

  it('carries an emptied field through as a clear', () => {
    expect(buildRowPatch(claudeRow, { cost: '', tier: '' })).toEqual({ cost: null, tier: null });
  });

  it('skips an unparseable price rather than clearing a fat-fingered one', () => {
    expect(buildRowPatch(claudeRow, { cost: 'abc' })).toBeNull();
  });
});

describe('SubscriptionsTab', () => {
  it('renders one row per plan with its tier, price, spend and quota', async () => {
    renderTab();
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Max 5x')).toBeInTheDocument();
    expect(screen.getByDisplayValue('200')).toBeInTheDocument();
    // Spend figures come from the savings block, quota meters from the scrape.
    expect(screen.getByText('$812.44')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Weekly')).toBeInTheDocument());
  });

  // The whole point of the page: it manages PortOS-side tracking, not billing.
  it('states that it never touches provider billing', async () => {
    renderTab();
    await screen.findByText('Claude Code');
    expect(screen.getByText(/does not change, pause or cancel anything with the provider/i)).toBeInTheDocument();
  });

  it('toggles a subscription through the family endpoint and re-reads the rows', async () => {
    renderTab();
    await screen.findByText('Codex');
    fireEvent.click(screen.getByLabelText('Enable the Codex subscription'));
    await waitFor(() => expect(api.setSubscriptionEnabled).toHaveBeenCalledWith(
      { family: 'codex', enabled: true },
      expect.anything(),
    ));
    // Enablement is derived from the provider records, so the server's answer
    // is re-read rather than patched into local state.
    await waitFor(() => expect(api.getSubscriptions).toHaveBeenCalledTimes(2));
  });

  // A disabled plan keeps its price: the row and its stored cost must survive a
  // toggle, or cancelling a plan for a week would silently lose what it costs.
  it('keeps a disabled plan listed with its price intact', async () => {
    api.getSubscriptions.mockResolvedValue({
      families: [{ ...claudeRow, enabled: false, providers: [{ id: 'claude-code', name: 'Claude Code', enabled: false }] }],
      costs: { claude: 200 },
      tiers: { claude: 'Max 5x' },
    });
    renderTab();
    expect(await screen.findByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByDisplayValue('200')).toBeInTheDocument();
    expect(screen.getByLabelText('Enable the Claude Code subscription')).toHaveAttribute('aria-checked', 'false');
  });

  it('saves a changed tier and price through their own endpoints', async () => {
    renderTab();
    await screen.findByText('Claude Code');
    fireEvent.change(screen.getByLabelText('Plan tier for Claude Code'), { target: { value: 'Max 20x' } });
    fireEvent.change(screen.getByLabelText('Monthly cost for Claude Code'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save the Claude Code plan' }));
    await waitFor(() => expect(api.updateSubscriptionPlanTiers).toHaveBeenCalledWith(
      { claude: 'Max 20x' },
      expect.anything(),
    ));
    expect(api.updateSubscriptionCosts).toHaveBeenCalledWith({ claude: 100 }, expect.anything());
  });

  it('offers no toggle for a priced plan with no provider configured', async () => {
    api.getSubscriptions.mockResolvedValue({
      families: [{ family: 'grok', label: 'Grok', enabled: false, monthlyCost: 30, planTier: null, providers: [] }],
      costs: { grok: 30 },
      tiers: {},
    });
    renderTab();
    expect(await screen.findByText(/No provider configured/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Enable the Grok subscription')).toBeDisabled();
  });

  it('says so when there is nothing to manage', async () => {
    api.getSubscriptions.mockResolvedValue({ families: [], costs: {}, tiers: {} });
    renderTab();
    expect(await screen.findByText(/No subscriptions to manage/i)).toBeInTheDocument();
  });
});

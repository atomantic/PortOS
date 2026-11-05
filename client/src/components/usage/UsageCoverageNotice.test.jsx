import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import UsageCoverageNotice from './UsageCoverageNotice';

const gap = { instanceId: 'studio', instanceName: 'Studio', providerId: 'shared-cli', providerName: 'CLI', self: false,
  tokens: 1234567, sessions: 12, models: ['example-model'], from: '2026-10-03', to: '2026-10-29', resolution: 'day',
  capturedAt: '2026-11-01T00:00:00Z', reason: 'classification-not-reported' };

const show = (props) => render(<MemoryRouter><UsageCoverageNotice {...props} /></MemoryRouter>);

describe('chart coverage recovery', () => {
  it('identifies affected instance, provider, counts and observed dates without inventing a price', () => {
    show({ coverage: { pricingIncomplete: true, classificationGaps: [gap], range: { from: '2026-10-01', to: '2026-10-31' } } });
    expect(screen.getByText('Partial chart: unpriced ledger usage from Studio.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('What’s missing and how to fix it'));
    expect(screen.getByText('Studio · CLI')).toBeVisible();
    expect(screen.getByText(/Provider ID: shared-cli/)).toHaveTextContent('1,234,567 recorded tokens · 12 sessions. Cost unknown.');
    expect(screen.getByText(/Observed 2026-10-03 to 2026-10-29 UTC/)).toBeVisible();
    expect(screen.getByText('Models: example-model.')).toBeVisible();
    expect(screen.getByText(/older peer version/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open instance sync' })).toHaveAttribute('href', '/instances');
    expect(screen.getByText(/Local reconciliation does not repair another machine/)).toBeVisible();
  });

  it('distinguishes absent data from recorded zero and keeps sync opt-outs quiet', () => {
    const view = show({ coverage: { notSyncingInstances: ['Offline archive'], missingInstances: [], pricingIncomplete: false } });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    view.rerender(<MemoryRouter><UsageCoverageNotice coverage={{ missingInstances: ['Laptop'], transcriptUnreported: ['Studio'], incompleteMonths: ['2026-01'] }} /></MemoryRouter>);
    expect(screen.getByText(/No usage snapshot from Laptop/)).toHaveTextContent('Claude transcript history not reported by Studio.');
    expect(screen.getByText(/missing providers, dates, tokens and cost are unknown/)).toBeInTheDocument();
    expect(screen.getByText(/Select full calendar months/)).toBeInTheDocument();
  });

  it('does not invent monthly buckets when dated legacy usage also has undated residuals', () => {
    show({ coverage: { pricingIncomplete: true, classificationGaps: [{ ...gap, reason: 'legacy-unattributed', resolution: 'mixed', hasUndatedUsage: true }] } });
    expect(screen.getByText(/mixed-resolution history/)).toHaveTextContent('also includes undated history');
    expect(screen.queryByText(/daily and monthly buckets/)).not.toBeInTheDocument();
  });

  it('makes local repair explicit, gates repeated starts, and describes its limits', () => {
    const onReconcile = vi.fn();
    const view = show({ coverage: { pricingIncomplete: true, classificationGaps: [{ ...gap, self: true, reason: 'provider-not-configured', from: null, to: null }] }, onReconcile });
    fireEvent.click(screen.getByText('What’s missing and how to fix it'));
    expect(screen.getByText('Dates unavailable (undated history).')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Review local providers' })).toHaveAttribute('href', '/ai/presets');
    expect(screen.getByText(/It changes recorded history, but cannot restore/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Reconcile local history' }));
    expect(onReconcile).toHaveBeenCalledTimes(1);
    view.rerender(<MemoryRouter><UsageCoverageNotice coverage={{ pricingIncomplete: true }} onReconcile={onReconcile} reconciling /></MemoryRouter>);
    expect(screen.getByRole('button', { name: 'Reconciling local history…' })).toBeDisabled();
  });
});

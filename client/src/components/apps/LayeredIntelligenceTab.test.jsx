import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LayeredIntelligenceTab, { buildLayeredIntelligenceUpdate } from './LayeredIntelligenceTab';

const baseline = {
  enabled: false,
  intervalMs: 86400000,
  providerId: null,
  model: null,
  rules: '',
  sources: { goals: true, cosMetrics: true, healthReport: true, planMd: true, openIssues: true, custom: [] },
  allowedScopes: ['app-improvement', 'app-data-gap']
};

describe('buildLayeredIntelligenceUpdate', () => {
  it('returns null when nothing changed (avoids persisting the effective config to disk)', () => {
    expect(buildLayeredIntelligenceUpdate(baseline, { ...baseline })).toBeNull();
  });

  it('returns null on missing baseline or current', () => {
    expect(buildLayeredIntelligenceUpdate(null, baseline)).toBeNull();
    expect(buildLayeredIntelligenceUpdate(baseline, null)).toBeNull();
  });

  it('emits only the changed enabled flag', () => {
    const update = buildLayeredIntelligenceUpdate(baseline, { ...baseline, enabled: true });
    expect(update).toEqual({ enabled: true });
  });

  it('emits intervalMs when it changes', () => {
    const update = buildLayeredIntelligenceUpdate(baseline, { ...baseline, intervalMs: 3600000 });
    expect(update).toEqual({ intervalMs: 3600000 });
  });

  it('normalizes empty provider/model to null and only emits when changed', () => {
    // '' provider equals the null baseline → no change
    expect(buildLayeredIntelligenceUpdate(baseline, { ...baseline, providerId: '', model: '' })).toBeNull();
    const update = buildLayeredIntelligenceUpdate(baseline, { ...baseline, providerId: 'claude-code', model: 'sonnet' });
    expect(update).toEqual({ providerId: 'claude-code', model: 'sonnet' });
  });

  it('emits the full source object (toggles + sanitized custom) when a toggle flips', () => {
    const update = buildLayeredIntelligenceUpdate(baseline, {
      ...baseline,
      sources: { ...baseline.sources, goals: false }
    });
    expect(update.sources.goals).toBe(false);
    expect(update.sources.cosMetrics).toBe(true);
    expect(update.sources.custom).toEqual([]);
  });

  it('sanitizes custom sources — trims refs and drops blanks', () => {
    const update = buildLayeredIntelligenceUpdate(baseline, {
      ...baseline,
      sources: { ...baseline.sources, custom: [{ type: 'file', ref: '  docs/x.md  ' }, { type: 'file', ref: '' }] }
    });
    expect(update.sources.custom).toEqual([{ type: 'file', ref: 'docs/x.md' }]);
  });

  it('ignores a blank custom-source row that sanitizes back to the baseline (no over-persist)', () => {
    const withCustom = { ...baseline, sources: { ...baseline.sources, custom: [{ type: 'file', ref: 'docs/x.md' }] } };
    // User clicks "Add file" but leaves the new row blank → sanitizes away → no change.
    const update = buildLayeredIntelligenceUpdate(withCustom, {
      ...withCustom,
      sources: { ...withCustom.sources, custom: [{ type: 'file', ref: 'docs/x.md' }, { type: 'file', ref: '' }] }
    });
    expect(update).toBeNull();
  });

  it('detects allowedScopes changes regardless of order', () => {
    // reordered = no change
    expect(buildLayeredIntelligenceUpdate(baseline, { ...baseline, allowedScopes: ['app-data-gap', 'app-improvement'] })).toBeNull();
    const update = buildLayeredIntelligenceUpdate(baseline, { ...baseline, allowedScopes: ['app-improvement'] });
    expect(update).toEqual({ allowedScopes: ['app-improvement'] });
  });

  it('emits rules changes including an intentional clear', () => {
    const withRules = { ...baseline, rules: 'be careful' };
    const update = buildLayeredIntelligenceUpdate(withRules, { ...withRules, rules: '' });
    expect(update).toEqual({ rules: '' });
  });
});

describe('LayeredIntelligenceTab (render)', () => {
  const props = { li: baseline, onChange: () => {}, providers: [], loaded: true };

  it('shows a loading state until loaded', () => {
    render(<LayeredIntelligenceTab {...props} loaded={false} />);
    expect(screen.getByText(/Loading Layered Intelligence config/i)).toBeInTheDocument();
  });

  it('hides PortOS-only scopes for a regular app', () => {
    render(<LayeredIntelligenceTab {...props} isPortos={false} />);
    expect(screen.getByText('App improvement')).toBeInTheDocument();
    expect(screen.queryByText('Loop meta')).not.toBeInTheDocument();
    expect(screen.getByText(/only available on the PortOS baseline/i)).toBeInTheDocument();
  });

  it('shows PortOS-only scopes for the PortOS baseline app', () => {
    render(<LayeredIntelligenceTab {...props} isPortos={true} />);
    expect(screen.getByText('Loop meta')).toBeInTheDocument();
    expect(screen.getByText('PortOS self')).toBeInTheDocument();
  });

  it('shows an error + retry when the config failed to load', () => {
    const onRetry = vi.fn();
    render(<LayeredIntelligenceTab {...props} loaded={true} error={true} onRetry={onRetry} />);
    expect(screen.getByText(/Couldn.t load the Layered Intelligence config/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalled();
  });

  it('treats an empty config as an error (no fields to render)', () => {
    render(<LayeredIntelligenceTab {...props} li={{}} loaded={true} />);
    expect(screen.getByText(/Couldn.t load the Layered Intelligence config/i)).toBeInTheDocument();
  });

  it('calls onChange when a source toggle flips', () => {
    const onChange = vi.fn();
    render(<LayeredIntelligenceTab {...props} onChange={onChange} isPortos={false} />);
    fireEvent.click(screen.getByLabelText(/Enable the self-improvement loop/i));
    expect(onChange).toHaveBeenCalledWith({ enabled: true });
  });
});

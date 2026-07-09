import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LayeredIntelligenceTab, { buildLayeredIntelligenceUpdate, buildLayeredIntelligenceScheduleUpdate, intervalFieldsFromMs, describeLastRun } from './LayeredIntelligenceTab';

const baseline = {
  enabled: false,
  intervalMs: 86400000,
  providerId: null,
  model: null,
  rules: '',
  sources: { goals: true, cosMetrics: true, healthReport: true, planMd: true, openIssues: true, custom: [] },
  allowedScopes: ['app-improvement', 'app-data-gap']
};

describe('describeLastRun', () => {
  const at = '2026-07-09T20:29:05.000Z';

  it('returns null when the loop has never run', () => {
    expect(describeLastRun({})).toBeNull();
    expect(describeLastRun({ lastRunAction: 'no-op' })).toBeNull(); // no lastRunAt ⇒ never ran
  });

  it('reports a filed run with its ref as success', () => {
    const r = describeLastRun({ lastRunAt: at, lastRunAction: 'filed', lastRunReason: null, lastRunRef: '#123' });
    expect(r.tone).toBe('success');
    expect(r.text).toContain('#123');
  });

  it('surfaces an unparseable reasoning response as a warning with actionable prose', () => {
    const r = describeLastRun({ lastRunAt: at, lastRunAction: 'no-op', lastRunReason: 'unparseable-response' });
    expect(r.tone).toBe('warn');
    expect(r.text).toMatch(/no usable JSON/i);
  });

  it('treats a genuine no-proposal run as neutral (not an error)', () => {
    const r = describeLastRun({ lastRunAt: at, lastRunAction: 'no-op', lastRunReason: 'no-proposal' });
    expect(r.tone).toBe('neutral');
  });

  it('renders an llm-error reason as an error with the provider message', () => {
    const r = describeLastRun({ lastRunAt: at, lastRunAction: 'no-op', lastRunReason: 'llm-error: provider timeout' });
    expect(r.tone).toBe('error');
    expect(r.text).toContain('provider timeout');
  });

  it('shows a duplicate suppression as neutral', () => {
    const r = describeLastRun({ lastRunAt: at, lastRunAction: 'duplicate', lastRunReason: 'duplicate' });
    expect(r.tone).toBe('neutral');
    expect(r.text).toMatch(/existing/i);
  });
});

describe('LayeredIntelligenceTab last-run status', () => {
  const li = (extra) => ({ ...baseline, ...extra });
  const noop = () => {};

  it('renders the durable last-run line when the config carries a run outcome', () => {
    render(<LayeredIntelligenceTab li={li({ lastRunAt: '2026-07-09T20:29:05.000Z', lastRunAction: 'no-op', lastRunReason: 'unparseable-response' })} onChange={noop} providers={[]} isPortos loaded />);
    expect(screen.getByText(/Last run/i)).toBeInTheDocument();
    expect(screen.getByText(/no usable JSON/i)).toBeInTheDocument();
  });

  it('omits the last-run line before the loop has ever run', () => {
    render(<LayeredIntelligenceTab li={li()} onChange={noop} providers={[]} isPortos loaded />);
    expect(screen.queryByText(/Last run/i)).not.toBeInTheDocument();
  });
});

describe('buildLayeredIntelligenceUpdate', () => {
  it('returns null when nothing changed (avoids persisting the effective config to disk)', () => {
    expect(buildLayeredIntelligenceUpdate(baseline, { ...baseline })).toBeNull();
  });

  it('returns null on missing baseline or current', () => {
    expect(buildLayeredIntelligenceUpdate(null, baseline)).toBeNull();
    expect(buildLayeredIntelligenceUpdate(baseline, null)).toBeNull();
  });

  it('does NOT emit scheduling fields (they go to the task override, #2322)', () => {
    // enabled / intervalMs / providerId / model are handled by
    // buildLayeredIntelligenceScheduleUpdate, so the behavior PATCH ignores them.
    expect(buildLayeredIntelligenceUpdate(baseline, { ...baseline, enabled: true })).toBeNull();
    expect(buildLayeredIntelligenceUpdate(baseline, { ...baseline, intervalMs: 3600000 })).toBeNull();
    expect(buildLayeredIntelligenceUpdate(baseline, { ...baseline, providerId: 'claude-code', model: 'sonnet' })).toBeNull();
  });

  it('emits the hand-off toggle only when it changes', () => {
    const withHandoff = { ...baseline, handoff: { enabled: false } };
    expect(buildLayeredIntelligenceUpdate(withHandoff, { ...withHandoff })).toBeNull();
    const update = buildLayeredIntelligenceUpdate(withHandoff, { ...withHandoff, handoff: { enabled: true } });
    expect(update).toEqual({ handoff: { enabled: true } });
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

  it('sanitizes http + cmd sources with optional labels', () => {
    const update = buildLayeredIntelligenceUpdate(baseline, {
      ...baseline,
      sources: { ...baseline.sources, custom: [
        { type: 'http', url: ' https://x.com/s ', label: '  status  ' },
        { type: 'cmd', cmd: ' git log ' },
        { type: 'http', url: '' } // blank → dropped
      ] }
    });
    expect(update.sources.custom).toEqual([
      { type: 'http', url: 'https://x.com/s', label: 'status' },
      { type: 'cmd', cmd: 'git log' }
    ]);
  });

  it('detects a label-only change on an existing custom source', () => {
    const withHttp = { ...baseline, sources: { ...baseline.sources, custom: [{ type: 'http', url: 'https://x.com/s' }] } };
    const update = buildLayeredIntelligenceUpdate(withHttp, {
      ...withHttp,
      sources: { ...withHttp.sources, custom: [{ type: 'http', url: 'https://x.com/s', label: 'status' }] }
    });
    expect(update.sources.custom).toEqual([{ type: 'http', url: 'https://x.com/s', label: 'status' }]);
  });

  it('detects a type change on a custom source (file → cmd)', () => {
    const withFile = { ...baseline, sources: { ...baseline.sources, custom: [{ type: 'file', ref: 'docs/x.md' }] } };
    const update = buildLayeredIntelligenceUpdate(withFile, {
      ...withFile,
      sources: { ...withFile.sources, custom: [{ type: 'cmd', cmd: 'git log' }] }
    });
    expect(update.sources.custom).toEqual([{ type: 'cmd', cmd: 'git log' }]);
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

describe('buildLayeredIntelligenceScheduleUpdate (per-app task override, #2322)', () => {
  it('returns null when no scheduling field changed', () => {
    expect(buildLayeredIntelligenceScheduleUpdate(baseline, { ...baseline })).toBeNull();
    expect(buildLayeredIntelligenceScheduleUpdate(null, baseline)).toBeNull();
  });

  it('emits the enabled flag when it changes', () => {
    expect(buildLayeredIntelligenceScheduleUpdate(baseline, { ...baseline, enabled: true })).toEqual({ enabled: true });
  });

  it('emits interval + intervalMs together, mapping to daily/weekly/custom', () => {
    expect(buildLayeredIntelligenceScheduleUpdate(baseline, { ...baseline, intervalMs: 3600000 }))
      .toEqual({ interval: 'custom', intervalMs: 3600000 });
    expect(buildLayeredIntelligenceScheduleUpdate({ ...baseline, intervalMs: 3600000 }, { ...baseline, intervalMs: 7 * 86400000 }))
      .toEqual({ interval: 'weekly', intervalMs: 7 * 86400000 });
  });

  it('normalizes empty provider/model to null and only emits when changed', () => {
    expect(buildLayeredIntelligenceScheduleUpdate(baseline, { ...baseline, providerId: '', model: '' })).toBeNull();
    expect(buildLayeredIntelligenceScheduleUpdate(baseline, { ...baseline, providerId: 'claude-code', model: 'sonnet' }))
      .toEqual({ providerId: 'claude-code', model: 'sonnet' });
  });

  it('intervalFieldsFromMs maps standard cadences + falls back to daily', () => {
    expect(intervalFieldsFromMs(86400000)).toEqual({ interval: 'daily', intervalMs: 86400000 });
    expect(intervalFieldsFromMs(7 * 86400000)).toEqual({ interval: 'weekly', intervalMs: 7 * 86400000 });
    expect(intervalFieldsFromMs(6 * 3600000)).toEqual({ interval: 'custom', intervalMs: 6 * 3600000 });
    expect(intervalFieldsFromMs(0)).toEqual({ interval: 'daily', intervalMs: 86400000 });
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

  it('adds a custom source (defaulting to file) via "Add source"', () => {
    const onChange = vi.fn();
    render(<LayeredIntelligenceTab {...props} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Add source/i }));
    expect(onChange).toHaveBeenCalledWith({ sources: expect.objectContaining({ custom: [{ type: 'file', ref: '' }] }) });
  });

  it('renders the type selector and type-appropriate value field for each custom source', () => {
    const li = {
      ...baseline,
      sources: { ...baseline.sources, custom: [
        { type: 'file', ref: 'docs/x.md' },
        { type: 'http', url: 'https://x.com/s' },
        { type: 'cmd', cmd: 'git log' }
      ] }
    };
    render(<LayeredIntelligenceTab {...props} li={li} />);
    // One type selector per row.
    expect(screen.getByLabelText(/Custom source 1 type/i)).toHaveValue('file');
    expect(screen.getByLabelText(/Custom source 2 type/i)).toHaveValue('http');
    expect(screen.getByLabelText(/Custom source 3 type/i)).toHaveValue('cmd');
    // Type-appropriate value field is populated.
    expect(screen.getByLabelText(/Custom source 1 file/i)).toHaveValue('docs/x.md');
    expect(screen.getByLabelText(/Custom source 2 url/i)).toHaveValue('https://x.com/s');
    expect(screen.getByLabelText(/Custom source 3 command/i)).toHaveValue('git log');
  });

  it('switches a row type, clearing the old value field but keeping the label', () => {
    const onChange = vi.fn();
    const li = { ...baseline, sources: { ...baseline.sources, custom: [{ type: 'file', ref: 'docs/x.md', label: 'notes' }] } };
    render(<LayeredIntelligenceTab {...props} li={li} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText(/Custom source 1 type/i), { target: { value: 'http' } });
    expect(onChange).toHaveBeenCalledWith({ sources: expect.objectContaining({ custom: [{ type: 'http', url: '', label: 'notes' }] }) });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SeriesSeverityConfig from './SeriesSeverityConfig';

const series = (over = {}) => ({ id: 'ser-1', name: 'S', ...over });
const weightInput = (sev) => document.getElementById(`sev-weight-${sev}`);

describe('SeriesSeverityConfig (#1616)', () => {
  let onSaveField;
  beforeEach(() => { onSaveField = vi.fn(); });

  it('shows the frozen defaults for an unset series', () => {
    render(<SeriesSeverityConfig series={series()} onSaveField={onSaveField} />);
    expect(weightInput('high')).toHaveValue(12);
    expect(weightInput('medium')).toHaveValue(5);
    expect(weightInput('low')).toHaveValue(1);
    // arc default = high + medium checked, low unchecked.
    expect(screen.getByText('Arc verification')).toBeTruthy();
    expect(document.getElementById('block-arc-high').checked).toBe(true);
    expect(document.getElementById('block-arc-medium').checked).toBe(true);
    expect(document.getElementById('block-arc-low').checked).toBe(false);
    // editorial default = high only.
    expect(document.getElementById('block-editorial-high').checked).toBe(true);
    expect(document.getElementById('block-editorial-medium').checked).toBe(false);
  });

  it('reflects a stored override (effective values)', () => {
    render(<SeriesSeverityConfig
      series={series({ severityWeights: { high: 30 }, blockingSeverities: { arc: ['high'], editorial: [] } })}
      onSaveField={onSaveField}
    />);
    // overridden high, default medium/low.
    expect(weightInput('high')).toHaveValue(30);
    expect(weightInput('medium')).toHaveValue(5);
    // arc override = high only (medium now unchecked).
    expect(document.getElementById('block-arc-medium').checked).toBe(false);
    // editorial explicit [] → nothing checked.
    expect(document.getElementById('block-editorial-high').checked).toBe(false);
  });

  // onSaveField is called with (field, updater); the updater composes the next
  // STORED override against the freshest stored value at save time. Pull it out
  // and apply it to the stored override the parent would hold.
  const lastUpdater = (field) => {
    const call = [...onSaveField.mock.calls].reverse().find(([f]) => f === field);
    return call ? call[1] : null;
  };

  it('saves a single weight key by composing onto the stored override on blur', () => {
    render(<SeriesSeverityConfig series={series({ severityWeights: { low: 2 } })} onSaveField={onSaveField} />);
    const high = weightInput('high');
    fireEvent.change(high, { target: { value: '20' } });
    fireEvent.blur(high);
    // Composes onto the stored override (keeps low:2) rather than sending merged defaults.
    expect(lastUpdater('severityWeights')({ low: 2 })).toEqual({ low: 2, high: 20 });
  });

  it('clears a weight key when the input is emptied', () => {
    render(<SeriesSeverityConfig series={series({ severityWeights: { high: 20, low: 2 } })} onSaveField={onSaveField} />);
    const high = weightInput('high');
    fireEvent.change(high, { target: { value: '' } });
    fireEvent.blur(high);
    expect(lastUpdater('severityWeights')({ high: 20, low: 2 })).toEqual({ low: 2 });
  });

  it('does not save when the committed weight matches the stored value (no-op guard)', () => {
    render(<SeriesSeverityConfig series={series({ severityWeights: { high: 20 } })} onSaveField={onSaveField} />);
    const high = weightInput('high');
    fireEvent.change(high, { target: { value: '20' } });
    fireEvent.blur(high);
    expect(onSaveField).not.toHaveBeenCalled();
  });

  it('toggles a blocking severity, composing an ordered array onto the freshest stored set', () => {
    render(<SeriesSeverityConfig series={series()} onSaveField={onSaveField} />);
    // uncheck arc medium → flip medium against the gate's default [high,medium] → [high].
    fireEvent.click(document.getElementById('block-arc-medium'));
    expect(lastUpdater('blockingSeverities')({})).toEqual({ arc: ['high'] });
  });

  it('composes a toggle against the freshest stored set, not the rendered props', () => {
    render(<SeriesSeverityConfig series={series()} onSaveField={onSaveField} />);
    // The user checks arc low; by save time another save has landed making arc [high].
    fireEvent.click(document.getElementById('block-arc-low'));
    // Flipping low onto the freshest stored arc:[high] yields [high, low] (ordered).
    expect(lastUpdater('blockingSeverities')({ arc: ['high'] })).toEqual({ arc: ['high', 'low'] });
  });

  it('unchecking the last box persists an explicit empty array (nothing blocks)', () => {
    render(<SeriesSeverityConfig series={series({ blockingSeverities: { editorial: ['high'] } })} onSaveField={onSaveField} />);
    fireEvent.click(document.getElementById('block-editorial-high'));
    expect(lastUpdater('blockingSeverities')({ editorial: ['high'] })).toEqual({ editorial: [] });
  });

  it('re-seeds the weight drafts when resetNonce bumps (failed-save revert)', () => {
    const s = series({ severityWeights: { high: 20 } });
    const { rerender } = render(<SeriesSeverityConfig series={s} onSaveField={onSaveField} resetNonce={0} />);
    const high = weightInput('high');
    fireEvent.change(high, { target: { value: '99' } });
    expect(high).toHaveValue(99);
    // Parent leaves the series untouched on failure and bumps the nonce.
    rerender(<SeriesSeverityConfig series={s} onSaveField={onSaveField} resetNonce={1} />);
    expect(high).toHaveValue(20);
  });

  it('renders nothing without a series', () => {
    const { container } = render(<SeriesSeverityConfig series={null} onSaveField={onSaveField} />);
    expect(container.firstChild).toBeNull();
  });
});

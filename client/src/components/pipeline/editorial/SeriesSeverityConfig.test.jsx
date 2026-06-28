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

  it('saves a single weight key onto the stored override on blur', () => {
    render(<SeriesSeverityConfig series={series({ severityWeights: { low: 2 } })} onSaveField={onSaveField} />);
    const high = weightInput('high');
    fireEvent.change(high, { target: { value: '20' } });
    fireEvent.blur(high);
    // merges onto the stored override (keeps low:2), doesn't send the merged defaults.
    expect(onSaveField).toHaveBeenCalledWith('severityWeights', { low: 2, high: 20 });
  });

  it('clears a weight key when the input is emptied', () => {
    render(<SeriesSeverityConfig series={series({ severityWeights: { high: 20, low: 2 } })} onSaveField={onSaveField} />);
    const high = weightInput('high');
    fireEvent.change(high, { target: { value: '' } });
    fireEvent.blur(high);
    expect(onSaveField).toHaveBeenCalledWith('severityWeights', { low: 2 });
  });

  it('toggles a blocking severity, persisting an ordered array onto the stored override', () => {
    render(<SeriesSeverityConfig series={series()} onSaveField={onSaveField} />);
    // uncheck arc medium → arc becomes [high].
    fireEvent.click(document.getElementById('block-arc-medium'));
    expect(onSaveField).toHaveBeenCalledWith('blockingSeverities', { arc: ['high'] });
  });

  it('unchecking the last box persists an explicit empty array (nothing blocks)', () => {
    render(<SeriesSeverityConfig series={series({ blockingSeverities: { editorial: ['high'] } })} onSaveField={onSaveField} />);
    fireEvent.click(document.getElementById('block-editorial-high'));
    expect(onSaveField).toHaveBeenCalledWith('blockingSeverities', { editorial: [] });
  });

  it('renders nothing without a series', () => {
    const { container } = render(<SeriesSeverityConfig series={null} onSaveField={onSaveField} />);
    expect(container.firstChild).toBeNull();
  });
});

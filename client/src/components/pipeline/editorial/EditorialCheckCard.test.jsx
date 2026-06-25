import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import EditorialCheckCard from './EditorialCheckCard';

const check = {
  id: 'naming.dissimilar-names',
  label: 'Character name dissimilarity',
  description: 'Flags confusable names.',
  scope: 'series',
  kind: 'deterministic',
  severityDefault: 'low',
  enabled: true,
  config: { minSharedSignals: 2 },
  configFields: [
    { key: 'minSharedSignals', label: 'Minimum shared signals to flag', type: 'number', min: 1, max: 5, step: 1 },
  ],
};

describe('EditorialCheckCard', () => {
  it('toggles enable through onToggle with the negated value', () => {
    const onToggle = vi.fn();
    render(<EditorialCheckCard check={check} onToggle={onToggle} onConfigSave={vi.fn()} />);
    fireEvent.click(screen.getByRole('switch', { name: /disable character name/i }));
    expect(onToggle).toHaveBeenCalledWith('naming.dissimilar-names', false);
  });

  it('commits a clamped config value on blur, merged onto the existing config', () => {
    const onConfigSave = vi.fn();
    render(<EditorialCheckCard check={check} onToggle={vi.fn()} onConfigSave={onConfigSave} />);
    fireEvent.click(screen.getByRole('button', { name: /configure/i }));
    const input = screen.getByLabelText('Minimum shared signals to flag');
    fireEvent.change(input, { target: { value: '9' } }); // above max 5
    fireEvent.blur(input);
    expect(onConfigSave).toHaveBeenCalledWith('naming.dissimilar-names', { minSharedSignals: 5 });
  });

  it('does not save when the committed value is unchanged', () => {
    const onConfigSave = vi.fn();
    render(<EditorialCheckCard check={check} onToggle={vi.fn()} onConfigSave={onConfigSave} />);
    fireEvent.click(screen.getByRole('button', { name: /configure/i }));
    const input = screen.getByLabelText('Minimum shared signals to flag');
    fireEvent.blur(input); // still 2
    expect(onConfigSave).not.toHaveBeenCalled();
  });

  describe('per-series override (#1591)', () => {
    it('hides the override panel when no series is selected', () => {
      render(<EditorialCheckCard check={check} onToggle={vi.fn()} onConfigSave={vi.fn()} onSeriesConfigSave={vi.fn()} />);
      expect(screen.queryByRole('button', { name: /override for this series/i })).toBeNull();
    });

    it('commits a per-series override, falling back to the global value, via onSeriesConfigSave', () => {
      const onSeriesConfigSave = vi.fn();
      render(
        <EditorialCheckCard
          check={check}
          seriesId="ser-1"
          seriesConfig={null}
          onToggle={vi.fn()}
          onConfigSave={vi.fn()}
          onSeriesConfigSave={onSeriesConfigSave}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /override for this series/i }));
      const input = screen.getByLabelText('Minimum shared signals to flag');
      expect(input.value).toBe('2'); // seeded from the global config
      fireEvent.change(input, { target: { value: '4' } });
      fireEvent.blur(input);
      expect(onSeriesConfigSave).toHaveBeenCalledWith('naming.dissimilar-names', { minSharedSignals: 4 });
    });

    it('shows an active badge and clears the override via Reset to global', () => {
      const onSeriesConfigSave = vi.fn();
      render(
        <EditorialCheckCard
          check={check}
          seriesId="ser-1"
          seriesConfig={{ minSharedSignals: 4 }}
          onToggle={vi.fn()}
          onConfigSave={vi.fn()}
          onSeriesConfigSave={onSeriesConfigSave}
        />,
      );
      const overrideBtn = screen.getByRole('button', { name: /override for this series/i });
      expect(overrideBtn.textContent).toMatch(/active/i);
      fireEvent.click(overrideBtn);
      fireEvent.click(screen.getByRole('button', { name: /reset to global/i }));
      expect(onSeriesConfigSave).toHaveBeenCalledWith('naming.dissimilar-names', null);
    });
  });
});

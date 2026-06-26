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

  it('scopes its DOM ids by idScope so a fanned dual-scope check stays unique (#1628)', () => {
    const onSeveritySave = vi.fn();
    const { container } = render(
      <EditorialCheckCard check={check} idScope="issue" onToggle={vi.fn()} onConfigSave={vi.fn()} onSeveritySave={onSeveritySave} />,
    );
    // The severity control's id folds in the section scope; the label still pairs.
    const select = screen.getByRole('combobox', { name: /severity for/i });
    expect(select.id).toBe('sev-issue-naming.dissimilar-names');
    expect(container.querySelector('label[for="sev-issue-naming.dissimilar-names"]')).not.toBeNull();
    // The config input id is scoped too.
    fireEvent.click(screen.getByRole('button', { name: /configure/i }));
    expect(screen.getByLabelText('Minimum shared signals to flag').id)
      .toBe('cfg-issue-naming.dissimilar-names-minSharedSignals');
    // The API callback still uses the bare check id, not the scoped DOM id.
    fireEvent.change(select, { target: { value: 'high' } });
    expect(onSeveritySave).toHaveBeenCalledWith('naming.dissimilar-names', 'high');
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

  describe('per-check severity override (#1596)', () => {
    it('does not render the severity selector when onSeveritySave is absent', () => {
      render(<EditorialCheckCard check={check} onToggle={vi.fn()} onConfigSave={vi.fn()} />);
      expect(screen.queryByRole('combobox', { name: /severity for/i })).toBeNull();
    });

    it('defaults the selector to "Default" and commits a chosen level via onSeveritySave', () => {
      const onSeveritySave = vi.fn();
      render(<EditorialCheckCard check={check} onToggle={vi.fn()} onConfigSave={vi.fn()} onSeveritySave={onSeveritySave} />);
      const select = screen.getByRole('combobox', { name: /severity for/i });
      expect(select.value).toBe(''); // no stored override → "Default"
      fireEvent.change(select, { target: { value: 'high' } });
      expect(onSeveritySave).toHaveBeenCalledWith('naming.dissimilar-names', 'high');
    });

    it('seeds from a stored override and clears it (null) when "Default" is chosen', () => {
      const onSeveritySave = vi.fn();
      const overridden = { ...check, severity: 'high', severityOverride: 'high' };
      render(<EditorialCheckCard check={overridden} onToggle={vi.fn()} onConfigSave={vi.fn()} onSeveritySave={onSeveritySave} />);
      const select = screen.getByRole('combobox', { name: /severity for/i });
      expect(select.value).toBe('high'); // seeded from the override
      fireEvent.change(select, { target: { value: '' } });
      expect(onSeveritySave).toHaveBeenCalledWith('naming.dissimilar-names', null);
    });
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

    it('reverts the draft to the persisted value when seriesResetNonce bumps (failed save)', () => {
      const { rerender } = render(
        <EditorialCheckCard
          check={check}
          seriesId="ser-1"
          seriesConfig={null}
          seriesResetNonce={0}
          onToggle={vi.fn()}
          onConfigSave={vi.fn()}
          onSeriesConfigSave={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /override for this series/i }));
      const input = screen.getByLabelText('Minimum shared signals to flag');
      fireEvent.change(input, { target: { value: '4' } }); // typed, not yet persisted
      expect(input.value).toBe('4');
      // A failed save bumps the nonce; the draft must revert to the persisted (global) value.
      rerender(
        <EditorialCheckCard
          check={check}
          seriesId="ser-1"
          seriesConfig={null}
          seriesResetNonce={1}
          onToggle={vi.fn()}
          onConfigSave={vi.fn()}
          onSeriesConfigSave={vi.fn()}
        />,
      );
      expect(screen.getByLabelText('Minimum shared signals to flag').value).toBe('2');
    });

    it('sends ONLY the changed field as a partial (so the page can compose multi-field edits)', () => {
      const twoFieldCheck = {
        ...check,
        config: { minSharedSignals: 2, maxFindings: 10 },
        configFields: [
          { key: 'minSharedSignals', label: 'Minimum shared signals to flag', type: 'number', min: 1, max: 5, step: 1 },
          { key: 'maxFindings', label: 'Max findings', type: 'number', min: 1, max: 50, step: 1 },
        ],
      };
      const onSeriesConfigSave = vi.fn();
      render(
        <EditorialCheckCard
          check={twoFieldCheck}
          seriesId="ser-1"
          seriesConfig={{ maxFindings: 20 }} // an existing override on the OTHER field
          onToggle={vi.fn()}
          onConfigSave={vi.fn()}
          onSeriesConfigSave={onSeriesConfigSave}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: /override for this series/i }));
      const input = screen.getByLabelText('Minimum shared signals to flag');
      fireEvent.change(input, { target: { value: '4' } });
      fireEvent.blur(input);
      // The card sends ONLY the edited key — NOT a full snapshot that would carry a
      // stale maxFindings and clobber the other field's pending/persisted value.
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

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
});

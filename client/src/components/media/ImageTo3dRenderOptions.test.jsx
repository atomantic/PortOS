import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ImageTo3dRenderOptions from './ImageTo3dRenderOptions';

const setup = (props = {}) => render(
  <ImageTo3dRenderOptions
    steps=""
    onStepsChange={vi.fn()}
    seed=""
    onSeedChange={vi.fn()}
    keyBackground
    onKeyBackgroundChange={vi.fn()}
    {...props}
  />,
);

describe('ImageTo3dRenderOptions', () => {
  it('enables the Quality control by default', () => {
    setup();
    expect(screen.getByLabelText('Quality')).toBeEnabled();
    expect(screen.queryByText(/no step control/i)).toBeNull();
  });

  // A target whose runner drops `steps` (Pixal3D's upstream CLI has no per-phase step
  // override) must not be offered a control that silently does nothing.
  it('disables the Quality control and says why when steps are unsupported', () => {
    setup({ stepsSupported: false, steps: '24' });
    const quality = screen.getByLabelText('Quality');
    expect(quality).toBeDisabled();
    expect(screen.getByText(/no step control/i)).toBeInTheDocument();
    // Forced to the pipeline default rather than showing a value that won't apply.
    expect(quality).toHaveValue('');
  });

  it('leaves Seed and the keying toggle usable when only steps are unsupported', () => {
    setup({ stepsSupported: false });
    expect(screen.getByLabelText('Seed')).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: /key out flat backdrop/i })).toBeEnabled();
  });

  // Off by default now: keying writes an alpha channel, which makes the pipeline skip
  // its own learned matte (#4684). The control has to say what it is FOR, or nobody
  // can tell when the non-default is the right choice.
  it('says what the keying toggle is for, since it is no longer the common path', () => {
    setup({ keyBackground: false });
    const keying = screen.getByRole('checkbox', { name: /key out flat backdrop/i });
    expect(keying).not.toBeChecked();
    expect(keying.closest('label')).toHaveAttribute('title', expect.stringMatching(/chroma backdrop/i));
  });

  it('disables everything when the whole form is disabled', () => {
    setup({ disabled: true });
    expect(screen.getByLabelText('Quality')).toBeDisabled();
    expect(screen.getByLabelText('Seed')).toBeDisabled();
    // Both checkboxes, not just the keying one — `disabled` must reach every control.
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
  });
});

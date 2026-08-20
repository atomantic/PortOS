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
    expect(screen.getByRole('checkbox')).toBeEnabled();
  });

  it('disables everything when the whole form is disabled', () => {
    setup({ disabled: true });
    expect(screen.getByLabelText('Quality')).toBeDisabled();
    expect(screen.getByLabelText('Seed')).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});

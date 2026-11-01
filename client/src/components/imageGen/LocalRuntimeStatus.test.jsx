import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import LocalRuntimeStatus from './LocalRuntimeStatus';

vi.mock('./Flux2InstallModal', () => ({ default: () => null }));
vi.mock('../install/RuntimeInstallModal', () => ({ default: ({ open, installUrlBase, onClose, onComplete }) => open ? (
  <div data-testid="installer">
    {installUrlBase}
    <button onClick={onComplete}>Finish fixture install</button>
    <button onClick={onClose}>Close fixture install</button>
  </div>
) : null }));

describe('MOSS runtime actions', () => {

  it('opens the isolated FLUX.3 installer and refreshes readiness on completion', () => {
    const onRefresh = vi.fn();
    render(<LocalRuntimeStatus runtime={{ readiness: 'unavailable', reason: 'Missing', remedy: { kind: 'install-flux3', label: 'Install / repair FLUX.3 runtime' } }} onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install / repair FLUX.3 runtime' }));
    expect(screen.getByTestId('installer')).toHaveTextContent('/api/image-gen/setup/flux3-install');
    fireEvent.click(screen.getByRole('button', { name: 'Finish fixture install' }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
  it('keeps runtime completion from automatically starting the separate weight download', () => {
    const onRefresh = vi.fn();
    const runtime = { modelId: 'moss', readiness: 'unavailable', reason: 'Runtime missing', remedy: { kind: 'install-moss-swift', label: 'Install MOSS Swift runtime' } };
    const view = render(<LocalRuntimeStatus runtime={runtime} onRefresh={onRefresh} />);
    expect(screen.queryByTestId('installer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Install MOSS Swift runtime' }));
    fireEvent.click(screen.getByRole('button', { name: 'Finish fixture install' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    view.rerender(<LocalRuntimeStatus runtime={{ ...runtime, reason: 'Weights missing', remedy: { kind: 'download-moss-weights', label: 'Download MOSS weights (27.2 GB)' } }} onRefresh={onRefresh} />);
    expect(screen.getByTestId('installer')).toHaveTextContent('/api/image-gen/setup/moss-install');
    fireEvent.click(screen.getByRole('button', { name: 'Close fixture install' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download MOSS weights (27.2 GB)' }));
    expect(screen.getByTestId('installer')).toHaveTextContent('/api/image-gen/setup/moss-weights');
  });
});

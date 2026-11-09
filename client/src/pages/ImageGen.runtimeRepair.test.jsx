// A self-serve runtime remedy for the model picked on the page must be one tap
// from the page itself. The readiness pill used to perform only the shared
// torch-venv install and send every other remedy to Settings, whose runtime
// panel probes the saved default model rather than this one, so the repair
// was unreachable unless the default was switched first. The model picker's
// weights badge likewise said "Available" over a runtime that failed its check.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';

import {
  imageGenModel,
  loadImageGenPage,
  renderImageGenPage,
  resetImageGenMockState,
  state,
} from '../test/imageGenPageMocks.jsx';

vi.mock('../components/install/RuntimeInstallModal', () => ({ default: ({ open, installUrlBase }) => (open ? <div data-testid="installer">{installUrlBase}</div> : null) }));

await loadImageGenPage();

const REMEDY = { kind: 'install-flux3', label: 'Install / repair example runtime', venvPath: '/tmp/venv-example' };

describe('ImageGen in-page runtime repair', () => {
  beforeEach(() => {
    resetImageGenMockState();
    state.models = [imageGenModel('example-mlx', { name: 'Example MLX', runner: 'flux3' })];
    state.settings = { imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3', modelId: 'example-mlx' } } };
    state.getImageGenStatus.mockResolvedValue({
      connected: false,
      mode: 'local',
      model: 'Example MLX',
      modelId: 'example-mlx',
      readiness: 'unavailable',
      runtime: 'flux3',
      reason: 'The isolated runtime is missing or needs repair.',
      remedy: REMEDY,
    });
  });

  it('offers the repair from the readiness pill instead of a Settings link, and opens its installer', async () => {
    await renderImageGenPage();

    const pillRepair = (await screen.findAllByRole('button', { name: REMEDY.label }))[0];
    fireEvent.click(pillRepair);
    expect(await screen.findByTestId('installer')).toHaveTextContent('/api/image-gen/setup/flux3-install');
  });

  it('marks downloaded weights as unusable while the runtime fails its check', async () => {
    await renderImageGenPage();

    const badge = (await screen.findByText(/Weights downloaded · runtime unavailable/)).parentElement;
    expect(screen.queryByText(/^Available/)).not.toBeInTheDocument();
    expect(within(badge).getByRole('button', { name: REMEDY.label })).toBeInTheDocument();
  });
});

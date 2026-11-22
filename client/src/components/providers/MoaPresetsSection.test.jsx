import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

/**
 * MoA presets on /ai/presets (#17386): the deep-linked editor builds the
 * payload the server validates (absent model = provider default, untouched
 * temperature absent), offers only enabled API providers, shows the fixed
 * text MoA adds, and the list reflects a save or delete without a refetch.
 */

const api = vi.hoisted(() => ({
  listMoaPresets: vi.fn(),
  createMoaPreset: vi.fn(),
  updateMoaPreset: vi.fn(),
  deleteMoaPreset: vi.fn(),
}));
vi.mock('../../services/apiMoaPresets', () => api);

import MoaPresetsSection from './MoaPresetsSection';

const providers = [
  { id: 'local-a', name: 'Local A', type: 'api', enabled: true, models: ['a-1', 'a-2'], defaultModel: 'a-1' },
  { id: 'hosted-b', name: 'Hosted B', type: 'api', enabled: true, models: ['b-1'], defaultModel: 'b-1' },
  { id: 'cli-c', name: 'CLI C', type: 'cli', enabled: true, models: [] },
  { id: 'off-d', name: 'Off D', type: 'api', enabled: false, models: [] },
];
const saved = {
  id: 'council', providerId: 'moa:council', name: 'Council', privacyFilter: 'off', advisorMaxTokens: 1024, enabled: true,
  referenceModels: [{ providerId: 'local-a' }, { providerId: 'hosted-b', model: 'b-1' }], aggregator: { providerId: 'hosted-b' }, refusals: [],
};

function Where() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}
const renderAt = (path) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/ai/presets" element={<><MoaPresetsSection providers={providers} /><Where /></>} />
      <Route path="/ai/presets/moa/:moaId" element={<><MoaPresetsSection providers={providers} /><Where /></>} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.listMoaPresets.mockResolvedValue({ presets: [], maxReferenceModels: 5, instructions: { advisor: 'ADVISOR TEXT', aggregator: 'AGGREGATOR TEXT' } });
});

describe('MoaPresetsSection', () => {
  it('creates a preset from /ai/presets/moa/new and lists it with its moa: id', async () => {
    api.createMoaPreset.mockResolvedValue(saved);
    renderAt('/ai/presets/moa/new');
    await screen.findByText('New MoA preset');

    const referenceSelect = screen.getByLabelText('Reference 1 provider');
    const offered = [...referenceSelect.options].map((o) => o.value);
    expect(offered).toEqual(expect.arrayContaining(['', 'local-a', 'hosted-b']));
    expect(offered).not.toContain('cli-c');
    expect(offered).not.toContain('off-d');
    expect(screen.getByRole('button', { name: 'Save preset' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Council' } });
    fireEvent.change(referenceSelect, { target: { value: 'local-a' } });
    fireEvent.change(screen.getByLabelText('Reference 2 provider'), { target: { value: 'hosted-b' } });
    fireEvent.change(screen.getByLabelText('Reference 2 model'), { target: { value: 'b-1' } });
    fireEvent.change(screen.getAllByLabelText('Temp')[0], { target: { value: '0.3' } });
    fireEvent.change(screen.getByLabelText('Aggregator provider'), { target: { value: 'hosted-b' } });
    expect(screen.getByText('ADVISOR TEXT')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save preset' }));

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/ai/presets'));
    expect(api.createMoaPreset).toHaveBeenCalledWith({
      name: 'Council', description: '',
      referenceModels: [{ providerId: 'local-a', temperature: 0.3 }, { providerId: 'hosted-b', model: 'b-1' }],
      aggregator: { providerId: 'hosted-b' }, privacyFilter: 'off', advisorMaxTokens: 1024, enabled: true,
    }, { silent: true });
    expect(await screen.findByText('Council')).toBeInTheDocument();
    expect(screen.getByText(/Aggregator \(acting, billed run\): Hosted B/)).toBeInTheDocument();
    expect(api.listMoaPresets).toHaveBeenCalledTimes(1);
  });

  it('keeps the editor open with the server refusal, and deletes after confirming', async () => {
    api.listMoaPresets.mockResolvedValue({ presets: [{ ...saved, refusals: [{ role: 'aggregator', index: 0, providerId: 'hosted-b', refusal: 'provider "hosted-b" is disabled' }] }], maxReferenceModels: 5, instructions: null });
    api.updateMoaPreset.mockRejectedValue(new Error('MoA preset cannot run'));
    api.deleteMoaPreset.mockResolvedValue({ id: 'council' });
    renderAt('/ai/presets/moa/council');
    await screen.findByText('Edit Council');
    expect(screen.getByText(/Aggregator: provider "hosted-b" is disabled/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('MoA preset cannot run');
    expect(screen.getByTestId('path')).toHaveTextContent('/ai/presets/moa/council');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteMoaPreset).toHaveBeenCalledWith('council'));
    await waitFor(() => expect(screen.queryByText('moa:council')).not.toBeInTheDocument());
  });
});

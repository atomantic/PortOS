import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThreejsModels from './ThreejsModels';

vi.mock('../services/api', () => ({
  createThreejsModel: vi.fn(),
  listThreejsModelFamilies: vi.fn(),
  listThreejsModels: vi.fn(),
}));

vi.mock('../hooks/useProviderModels', () => ({
  default: () => ({
    providers: [{ id: 'vision-api', name: 'Vision API', type: 'api', enabled: true }],
    selectedProviderId: 'vision-api',
    selectedModel: 'vision-pro',
    availableModels: ['vision-pro'],
    setSelectedProviderId: vi.fn(),
    setSelectedModel: vi.fn(),
    loading: false,
  }),
}));

vi.mock('../components/ProviderModelSelector', () => ({
  default: () => <div>Vision API / vision-pro</div>,
}));

vi.mock('../components/imageGen/GalleryImagePicker', () => ({
  default: ({ open, onSelect }) => open ? (
    <button
      type="button"
      onClick={() => onSelect({ filename: 'alternate-beacon.png', previewUrl: '/data/images/alternate-beacon.png' })}
    >
      Pick alternate beacon
    </button>
  ) : null,
}));

import { createThreejsModel, listThreejsModelFamilies, listThreejsModels } from '../services/api';

function LocationProbe() {
  return <output aria-label="Current query">{useLocation().search}</output>;
}

const FAMILY_OPTIONS = [
  { id: 'general', label: 'General (no checklist)', description: 'One general-purpose prompt.' },
  { id: 'vehicle', label: 'Vehicle', description: 'Cars, ships, aircraft.' },
];

describe('ThreejsModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listThreejsModels.mockResolvedValue([]);
    listThreejsModelFamilies.mockResolvedValue(FAMILY_OPTIONS);
  });

  it('starts a model from a gallery deep link and navigates to its workspace', async () => {
    createThreejsModel.mockResolvedValue({ id: 'threejs-example', status: 'generating' });
    render(
      <MemoryRouter initialEntries={['/media/threejs?image=example-robot.png']}>
        <Routes>
          <Route path="/media/threejs" element={<ThreejsModels />} />
          <Route path="/media/threejs/:id" element={<div>Model workspace opened</div>} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByLabelText('Model name')).toHaveValue('Example Robot');
    fireEvent.change(screen.getByLabelText(/Modeling direction/), {
      target: { value: 'Keep the antenna articulated.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Generate model' }));

    await waitFor(() => expect(createThreejsModel).toHaveBeenCalledWith({
      name: 'Example Robot',
      filename: 'example-robot.png',
      prompt: 'Keep the antenna articulated.',
      providerId: 'vision-api',
      model: 'vision-pro',
      family: 'general',
    }, { silent: true }));
    expect(await screen.findByText('Model workspace opened')).toBeInTheDocument();
  });

  it('sends the chosen subject family and shows what it narrows to', async () => {
    createThreejsModel.mockResolvedValue({ id: 'threejs-example', status: 'generating' });
    render(
      <MemoryRouter initialEntries={['/media/threejs?image=example-robot.png']}>
        <Routes>
          <Route path="/media/threejs" element={<ThreejsModels />} />
          <Route path="/media/threejs/:id" element={<div>Model workspace opened</div>} />
        </Routes>
      </MemoryRouter>,
    );

    const picker = await screen.findByLabelText(/Subject family/);
    fireEvent.change(picker, { target: { value: 'vehicle' } });
    expect(screen.getByText('Cars, ships, aircraft.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate model' }));

    await waitFor(() => expect(createThreejsModel).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'vehicle' }),
      { silent: true },
    ));
  });

  it('hides the family picker rather than showing an empty select when the fetch fails', async () => {
    // Creation must still work — it simply gets the general-purpose prompt.
    listThreejsModelFamilies.mockRejectedValue(new Error('offline'));
    createThreejsModel.mockResolvedValue({ id: 'threejs-example', status: 'generating' });
    render(
      <MemoryRouter initialEntries={['/media/threejs?image=example-robot.png']}>
        <Routes>
          <Route path="/media/threejs" element={<ThreejsModels />} />
          <Route path="/media/threejs/:id" element={<div>Model workspace opened</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(listThreejsModelFamilies).toHaveBeenCalled());
    expect(screen.queryByLabelText(/Subject family/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Generate model' }));
    await waitFor(() => expect(createThreejsModel).toHaveBeenCalledWith(
      expect.objectContaining({ family: 'general' }),
      { silent: true },
    ));
  });

  it('keeps a newly picked gallery image in the shareable URL', async () => {
    render(
      <MemoryRouter initialEntries={['/media/threejs?image=example-robot.png']}>
        <Routes>
          <Route path="/media/threejs" element={<><ThreejsModels /><LocationProbe /></>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Change image/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick alternate beacon' }));

    await waitFor(() => {
      expect(screen.getByLabelText('Current query')).toHaveTextContent('?image=alternate-beacon.png');
      expect(screen.getByLabelText('Model name')).toHaveValue('Alternate Beacon');
    });
  });
});

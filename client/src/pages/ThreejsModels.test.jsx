import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('offers a call to action that opens the image picker when no models exist', async () => {
    render(
      <MemoryRouter initialEntries={['/media/threejs']}>
        <ThreejsModels />
      </MemoryRouter>
    );
    expect(await screen.findByText('No procedural models yet')).toBeInTheDocument();
    const cta = screen.getByRole('button', { name: 'Choose a source image' });
    fireEvent.click(cta);
    // The picker only renders while open, so its appearance proves the action
    // is wired — a conversion that dropped it would leave a dead-end block.
    expect(await screen.findByRole('button', { name: 'Pick alternate beacon' })).toBeInTheDocument();
  });

  it('shows neither the select nor an error while the taxonomy read is in flight', async () => {
    listThreejsModelFamilies.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter initialEntries={['/media/threejs?image=example-robot.png']}>
        <ThreejsModels />
      </MemoryRouter>,
    );
    // Let the model-list read settle inside act so its state update is not orphaned.
    await act(async () => {});
    expect(screen.queryByLabelText(/Subject family/)).not.toBeInTheDocument();
    expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument();
  });

  it('shows a failure with Retry instead of an empty select, and Retry restores the select', async () => {
    listThreejsModelFamilies
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(FAMILY_OPTIONS);
    render(
      <MemoryRouter initialEntries={['/media/threejs?image=example-robot.png']}>
        <ThreejsModels />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/Subject families failed to load/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Subject family/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByLabelText(/Subject family/)).toBeInTheDocument();
    expect(screen.queryByText(/failed to load/)).not.toBeInTheDocument();
    expect(listThreejsModelFamilies).toHaveBeenCalledTimes(2);
  });

  it('still creates the model with the general family when the taxonomy read failed', async () => {
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

    expect(await screen.findByText(/Subject families failed to load/)).toBeInTheDocument();
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

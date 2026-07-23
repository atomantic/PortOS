import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ThreejsModels from './ThreejsModels';

vi.mock('../services/api', () => ({
  createThreejsModel: vi.fn(),
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
  default: () => null,
}));

import { createThreejsModel, listThreejsModels } from '../services/api';

describe('ThreejsModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listThreejsModels.mockResolvedValue([]);
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
    }, { silent: true }));
    expect(await screen.findByText('Model workspace opened')).toBeInTheDocument();
  });
});

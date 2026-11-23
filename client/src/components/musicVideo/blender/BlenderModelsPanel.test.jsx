import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BlenderModelsPanel from './BlenderModelsPanel.jsx';
import { FilmApiContext } from './FilmApiContext.jsx';

vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../services/apiImageTo3d.js', () => ({
  listImageTo3dModels: vi.fn(async () => [{ id: 'a', name: 'Robot Dog', status: 'ready' }, { id: 'b', name: 'Draft', status: 'draft' }]),
}));
vi.mock('../../../services/apiThreejsModels.js', () => ({
  listThreejsModels: vi.fn(async () => [{ id: 't', name: 'Lamp', spec: {} }]),
}));

const renderPanel = (api, onChanged = vi.fn()) => {
  render(<FilmApiContext.Provider value={api}><BlenderModelsPanel projectId="p1" onChanged={onChanged} /></FilmApiContext.Provider>);
  return onChanged;
};

describe('BlenderModelsPanel', () => {
  it('lists only finished library models, adds one and shows the load snippet', async () => {
    const api = {
      listMusicVideoBlenderModels: vi.fn(async () => ({ models: [] })),
      addMusicVideoBlenderModel: vi.fn(async () => ({ snippet: 'models.load(ctx, "robot-dog")' })),
      updateMusicVideoBlenderModel: vi.fn(),
    };
    const onChanged = renderPanel(api);
    await userEvent.click(screen.getByRole('button', { name: /Add 3D model/ }));
    expect(await screen.findByText(/Robot Dog/)).toBeTruthy();
    expect(screen.queryByText(/Draft/)).toBeNull();
    expect(screen.getByText(/Lamp/)).toBeTruthy();
    await userEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]);
    expect(api.addMusicVideoBlenderModel).toHaveBeenCalledWith('p1', { kind: 'image-to-3d', id: 'a' }, { silent: true });
    expect(await screen.findByLabelText('Snippet to load the model')).toHaveTextContent('robot-dog');
    expect(onChanged).toHaveBeenCalled();
  });

  it('offers Update copy only for a copy whose source changed, and updates on request', async () => {
    const api = {
      listMusicVideoBlenderModels: vi.fn(async () => ({ models: [{ slug: 'old', updateAvailable: true }, { slug: 'same', updateAvailable: false }] })),
      addMusicVideoBlenderModel: vi.fn(),
      updateMusicVideoBlenderModel: vi.fn(async () => ({ snippet: 's' })),
    };
    renderPanel(api);
    const update = await screen.findByRole('button', { name: /Update copy/ });
    expect(screen.getAllByRole('button', { name: /Update copy/ })).toHaveLength(1);
    await userEvent.click(update);
    await waitFor(() => expect(api.updateMusicVideoBlenderModel).toHaveBeenCalledWith('p1', 'old', { silent: true }));
  });
});

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const propose = vi.fn();
const saveWorld = vi.fn(async () => ({}));
vi.mock('../../../services/apiMusicVideo.js', () => ({ proposeMusicVideoPrevizEdit: (...args) => propose(...args) }));
vi.mock('../../../services/apiCatalog.js', () => ({ saveCatalogWorld: (...args) => saveWorld(...args) }));
vi.mock('../../../hooks/useProviderModels.js', () => ({ default: () => ({ providers: [], selectedProviderId: 'example-api', selectedModel: '', availableModels: [], loading: false,
  setSelectedProviderId: () => {}, setSelectedModel: () => {} }) }));
vi.mock('../../ProviderModelSelector.jsx', () => ({ default: () => null }));
vi.mock('../../catalog/WorldMapView', () => ({ default: () => <div>map preview</div>, fitWorldView: () => ({ cx: 0, cz: 0, size: 200 }) }));
const { default: PrevizAi } = await import('./PrevizAi.jsx');

const project = {
  id: 'p', concept: { subjects: [{ id: 'ada', kind: 'character', name: 'Ada' }] },
  cameras: [{ id: 'vhs', name: 'VHS' }], scenes: [{ sceneId: 'a' }],
};
const previz = { cuts: [{ id: 'c1', sceneId: 'a', holderSubjectId: 'ada' }, { id: 'c2', sceneId: null }], tracks: [] };
const world = { version: 1, seed: 1, sets: [], paths: [] };

describe('PrevizAi', () => {
  // Catches a proposal saving without review, an unticked part being applied, or cut edits replacing the untouched cuts.
  it('applies only the parts the director keeps', async () => {
    propose.mockResolvedValue({ sentPrompt: 'full', promptAdditions: [], summary: 'Moved things.', dropped: ['pawnColors: names someone not in the cast'],
      proposal: { world: { ...world, sets: [{ id: 's1', ingredientId: 'env', position: [0, 0], rotationDegrees: 0 }] }, cuts: [{ id: 'c1', turnToAim: true }], cameraStyles: { vhs: 'handheld' } } });
    const onSavePreviz = vi.fn();
    const onSaveCameras = vi.fn();
    render(<PrevizAi project={project} world={world} worldId="w1" places={{}} previz={previz} onSavePreviz={onSavePreviz} onSaveCameras={onSaveCameras} />);
    fireEvent.change(screen.getByLabelText('What to change in the previz'), { target: { value: 'Turn to Ada' } });
    fireEvent.click(screen.getByRole('button', { name: /Propose changes/ }));
    expect(await screen.findByText('Moved things.')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('pawnColors');
    expect(screen.getByText('Shot 1: turns to them')).toBeTruthy();
    expect(onSavePreviz).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('Apply World map'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 parts' }));
    await waitFor(() => expect(onSavePreviz).toHaveBeenCalledWith({ cuts: [{ ...previz.cuts[0], turnToAim: true }, previz.cuts[1]] }));
    expect(saveWorld).not.toHaveBeenCalled();
    expect(onSaveCameras).toHaveBeenCalledWith([{ id: 'vhs', name: 'VHS', previzStyle: 'handheld' }]);
    expect(propose.mock.calls[0][1]).toMatchObject({ providerId: 'example-api', instruction: 'Turn to Ada' });
  });
});

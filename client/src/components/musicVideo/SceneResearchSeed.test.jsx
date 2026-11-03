import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SceneResearchSeed from './SceneResearchSeed.jsx';

const handlers = vi.hoisted(() => new Map());
vi.mock('../../services/socket', () => ({ default: { on: (event, handler) => handlers.set(event, handler), off: (event) => handlers.delete(event) } }));
vi.mock('../../hooks/useProviderModels.js', () => ({ default: () => ({ providers: [], selectedProviderId: 'example-api', selectedModel: '', availableModels: [], loading: false,
  setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn() }) }));
vi.mock('../ProviderModelSelector.jsx', () => ({ default: () => null }));
const start = vi.hoisted(() => vi.fn(async () => ({ status: 'running', sentPrompt: 'Search…', promptAdditions: [] })));
vi.mock('../../services/apiMusicVideo.js', () => ({ startMusicVideoSceneResearch: start }));

const project = { id: 'mv-1' };
const photo = { id: 'mvr-research-a1', imageId: 'upload-a.png', subject: 'Example Breed', pageUrl: 'https://commons.example.org/wiki/File:A.jpg' };

describe('a shot\'s Research and seed step', () => {
  // Uniquely catches a research result that never reaches the open shot, or a drop that leaves the photo in the shot's own reference picks.
  it('starts the agent, applies the saved photos when it settles, and drops one from the shot and its picks', async () => {
    const onEditLocal = vi.fn();
    const onSave = vi.fn();
    const scene = { sceneId: 's1', frameReferenceIds: ['set'] };
    const { rerender } = render(<SceneResearchSeed project={project} scene={scene} onEditLocal={onEditLocal} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Research and seed/ }));
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Example Breed' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Find photos/ })); });
    expect(start).toHaveBeenCalledWith('mv-1', 's1', expect.objectContaining({ subject: 'Example Breed', count: 3, providerId: 'example-api' }), { silent: true });

    const saved = { ...scene, researchReferences: [photo], frameReferenceIds: [photo.id, 'set'] };
    act(() => handlers.get('music-video:research-seed')({ projectId: 'mv-1', sceneId: 's1', status: 'done', added: 1, project: { scenes: [saved] } }));
    expect(onEditLocal).toHaveBeenCalledWith('s1', { researchReferences: [photo], frameReferenceIds: [photo.id, 'set'] });
    expect(screen.getByRole('status').textContent).toContain('Added 1 photo');

    rerender(<SceneResearchSeed project={project} scene={saved} onEditLocal={onEditLocal} onSave={onSave} />);
    expect(screen.getByRole('link', { name: /commons.example.org/ }).getAttribute('href')).toBe(photo.pageUrl);
    fireEvent.click(screen.getByRole('button', { name: 'Drop research photo of Example Breed' }));
    expect(onSave).toHaveBeenCalledWith('s1', { researchReferences: [], frameReferenceIds: ['set'] });
  });
});

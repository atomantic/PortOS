import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SceneClipReferences from './SceneClipReferences.jsx';
import { getFalVideoModel } from '../../lib/falVideoModels.js';
import { getRunwayVideoModel } from '../../lib/runwayVideoModels.js';

const project = { visualSpec: { references: [
  { id: 'person', imageId: 'person.png', role: 'character', label: 'Rider', condition: true },
  { id: 'bike', imageId: 'bike.png', role: 'prop', label: 'Bike' },
] } };
const scene = { sceneId: 's1', referenceImageId: 'start.png', frameReferenceIds: ['person'] };

describe('clip references', () => {
  it('offers references on Runway Seedance and warns they unpin the opening frame', () => {
    render(<SceneClipReferences project={project} scene={scene} backend="runway" model={getRunwayVideoModel('seedance2_5')} onEditLocal={vi.fn()} onSave={vi.fn()} onSaveState={vi.fn()} />);
    expect(screen.getByText(/can send up to 16 additional image references/)).toBeTruthy();
    expect(screen.getByText(/start frame is a guide/)).toBeTruthy();
    expect(screen.getByText(/Remove every reference to pin the opening frame/)).toBeTruthy();
  });

  it('warns that listed references stay behind while the LTX box is off', () => {
    render(<SceneClipReferences project={project} scene={scene} backend="local" model={{ id: 'ltx', runtime: 'ltx25' }} ltxReferencesOff onEditLocal={vi.fn()} onSave={vi.fn()} onSaveState={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('These references are not sent with this clip. Turn on Use LTX reference images to send them.');
  });

  it('has nothing to warn about when no reference is listed', () => {
    render(<SceneClipReferences project={project} scene={{ ...scene, clipReferenceIds: [] }} backend="local" model={{ id: 'wan' }} onEditLocal={vi.fn()} onSave={vi.fn()} onSaveState={vi.fn()} />);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByText(/does not use additional image references/)).toBeTruthy();
  });

  it('says a Runway end frame holds the references back', () => {
    render(<SceneClipReferences project={project} scene={scene} backend="runway" model={getRunwayVideoModel('seedance2_5')} capacityOverride={0} endFrameBlocksReferences onEditLocal={vi.fn()} onSave={vi.fn()} onSaveState={vi.fn()} />);
    expect(screen.getByText(/cannot combine an end frame with image references/)).toBeTruthy();
  });

  it('lets the director add a prop to a clip without editing its frame choices', async () => {
    const onSave = vi.fn().mockResolvedValue(true);
    const onSaveState = vi.fn();
    render(<SceneClipReferences project={project} scene={scene} backend="grok" onEditLocal={vi.fn()} onSave={onSave} onSaveState={onSaveState} />);
    expect(screen.getByText('Auto: cast from Frames')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bike' }));
    expect(onSave).toHaveBeenCalledWith('s1', { clipReferenceIds: ['person', 'bike'] });
    await waitFor(() => expect(onSaveState).toHaveBeenLastCalledWith('saved'));
  });

  it('shows selections as not sent on an unsupported model and identifies loose start frames', () => {
    const selected = { ...scene, clipReferenceIds: ['person', 'bike'] };
    const props = { project, scene: selected, onEditLocal: vi.fn(), onSave: vi.fn(), onSaveState: vi.fn() };
    const { rerender } = render(<SceneClipReferences {...props} backend="local" model={{ id: 'ltx' }} />);
    expect(screen.getByText(/does not use additional image references/)).toBeTruthy();
    expect(screen.getByText('Rider · not sent')).toBeTruthy();
    rerender(<SceneClipReferences {...props} backend="fal" model={getFalVideoModel('bytedance/seedance-2.5/reference-to-video')} />);
    expect(screen.getByText(/does not pin the opening frame/)).toBeTruthy();
    expect(screen.queryByText('Rider · not sent')).toBeNull();
  });

  it('notes that a local model without audio conditioning renders without the song', () => {
    const songProject = { ...project, videoSettings: { generationMode: 'suppliedAudio' } };
    const props = { project: songProject, scene, onEditLocal: vi.fn(), onSave: vi.fn(), onSaveState: vi.fn() };
    const { rerender } = render(<SceneClipReferences {...props} backend="local" model={{ id: 'omni', runtime: 'fastvideo', fastvideoFamily: 'fasth3omni' }} />);
    expect(screen.getByText(/does not hear the song/)).toBeTruthy();
    rerender(<SceneClipReferences {...props} backend="local" model={{ id: 'ltx', runtime: 'ltx25', supportedModes: ['image', 'a2v'] }} />);
    expect(screen.queryByText(/does not hear the song/)).toBeNull();
  });
});

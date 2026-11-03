import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CameoRosterPanel from './CameoRosterPanel.jsx';
import SceneCameoLink from './SceneCameoLink.jsx';
import { createMusicVideoCameos, linkMusicVideoCameoShots, updateMusicVideoCameo } from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({
  createMusicVideoCameos: vi.fn(), updateMusicVideoCameo: vi.fn(), deleteMusicVideoCameo: vi.fn(),
  addMusicVideoCameoReferences: vi.fn(), removeMusicVideoCameoReference: vi.fn(), addMusicVideoCameoVariant: vi.fn(),
  updateMusicVideoCameoVariant: vi.fn(), deleteMusicVideoCameoVariant: vi.fn(), linkMusicVideoCameoShots: vi.fn(),
  unlinkMusicVideoCameoShots: vi.fn(), setMusicVideoCameoStillFromShot: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));

const cameo = { cameoId: 'mvcam-1', name: 'Example Dog', label: '', research: { status: 'unverified' }, references: [], stillImageId: null, variants: [] };
const project = {
  id: 'mv-1',
  cameos: [cameo],
  scenes: [
    { sceneId: 's1', order: 0, cameoId: 'mvcam-1', referenceImageId: null, takes: [] },
    { sceneId: 's2', order: 1, referenceImageId: null, takes: [] },
  ],
};
const answer = { cameos: [cameo], scenes: project.scenes, updatedAt: 'now' };

beforeEach(() => {
  vi.clearAllMocks();
  createMusicVideoCameos.mockResolvedValue(answer);
  updateMusicVideoCameo.mockResolvedValue(answer);
  linkMusicVideoCameoShots.mockResolvedValue(answer);
});

describe('music video cameos', () => {
  // Uniquely catches a pasted roll call losing its aliases, or the board not hearing the answer.
  it('adds a pasted roll call with on-screen labels and reports what each cameo still needs', async () => {
    const onApply = vi.fn();
    render(<MemoryRouter><CameoRosterPanel project={project} onApply={onApply} /></MemoryRouter>);
    expect(screen.getByText(/1 shot · needs research, photos, still/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Add cameos, one per line/), { target: { value: 'Cockapoo\nCockapoo | Spoodle\nCavapoo | Cavoodle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(createMusicVideoCameos).toHaveBeenCalledWith('mv-1',
      [{ name: 'Cockapoo' }, { name: 'Cavapoo', label: 'Cavoodle' }], { silent: true }));
    expect(onApply).toHaveBeenCalledWith(answer);
  });

  // Uniquely catches the open cameo not being addressable, or its research status not saving.
  it('opens a cameo from the list into its editor and saves research status', async () => {
    render(<MemoryRouter initialEntries={['/music-video/mv-1/cast-sets?cameo=mvcam-1']}><CameoRosterPanel project={project} onApply={vi.fn()} /></MemoryRouter>);
    const editor = screen.getByRole('group', { name: 'Example Dog' });
    fireEvent.change(within(editor).getByLabelText('Research'), { target: { value: 'verified' } });
    await waitFor(() => expect(updateMusicVideoCameo).toHaveBeenCalledWith('mv-1', 'mvcam-1', { research: { status: 'verified' } }, { silent: true }));
  });

  // Uniquely catches the shot editor picker linking the wrong shot or dropping the answer.
  it('links a shot to a cameo from the shot editor', async () => {
    const onApplyCameos = vi.fn();
    render(<SceneCameoLink project={project} scene={project.scenes[1]} onApplyCameos={onApplyCameos} />);
    fireEvent.change(screen.getByLabelText('Cameo'), { target: { value: 'mvcam-1' } });
    await waitFor(() => expect(linkMusicVideoCameoShots).toHaveBeenCalledWith('mv-1', 'mvcam-1', { sceneIds: ['s2'], variantId: null }, { silent: true }));
    expect(onApplyCameos).toHaveBeenCalledWith(answer);
  });
});

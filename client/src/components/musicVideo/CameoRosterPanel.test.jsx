import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CameoRosterPanel from './CameoRosterPanel.jsx';
import SceneCameoLink from './SceneCameoLink.jsx';
import toast from '../ui/Toast';
import { createMusicVideoCameos, linkMusicVideoCameoShots, removeMusicVideoCameoReference, updateMusicVideoCameo } from '../../services/apiMusicVideo.js';

vi.mock('../../services/apiMusicVideo.js', () => ({
  createMusicVideoCameos: vi.fn(), updateMusicVideoCameo: vi.fn(), deleteMusicVideoCameo: vi.fn(),
  addMusicVideoCameoReferences: vi.fn(), removeMusicVideoCameoReference: vi.fn(), addMusicVideoCameoVariant: vi.fn(),
  updateMusicVideoCameoVariant: vi.fn(), deleteMusicVideoCameoVariant: vi.fn(), linkMusicVideoCameoShots: vi.fn(),
  unlinkMusicVideoCameoShots: vi.fn(), setMusicVideoCameoStillFromShot: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

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

const photoRoster = () => ({
  id: 'mv-1',
  scenes: [],
  cameos: [
    { cameoId: 'mvcam-a', name: 'Example Dog', label: '', research: { status: 'verified' }, stillImageId: null, variants: [],
      references: [
        { imageId: 'a1.png', source: 'research', pageUrl: 'https://example.com/a1' },
        { imageId: 'a2.png', source: 'upload' },
      ] },
    { cameoId: 'mvcam-b', name: 'Example Cat', label: '', research: { status: 'verified' }, stillImageId: 'b1.png', variants: [],
      references: [{ imageId: 'b1.png', source: 'research', sourceUrl: 'https://example.com/b1.jpg' }] },
    { cameoId: 'mvcam-c', name: 'Example Bird', label: '', research: { status: 'verified' }, stillImageId: null, variants: [], references: [] },
  ],
});
// The real page applies each answer to the project, which is what moves the summary and the grid.
function StatefulPanel({ entry = '/music-video/mv-1/cast-sets?cameoView=photos', start = photoRoster() }) {
  const [current, setCurrent] = useState(start);
  return (
    <MemoryRouter initialEntries={[entry]}>
      <CameoRosterPanel project={current} onApply={(next) => setCurrent((prev) => ({ ...prev, ...next }))} />
    </MemoryRouter>
  );
}
const withoutReference = (roster, imageId) => ({
  cameos: roster.cameos.map((c) => ({ ...c, references: c.references.filter((r) => r.imageId !== imageId) })),
  scenes: [],
  updatedAt: 'now',
});

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

describe('reviewing a roster of cameo photos', () => {
  // Uniquely catches the review not reaching every cameo, losing a source link, or ignoring the roster's filters.
  it('shows every photo grouped by cameo with its source, and honors the search and filters', () => {
    render(<StatefulPanel entry="/music-video/mv-1/cast-sets" />);
    expect(screen.queryByAltText('Example Dog photo 1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review photos' }));

    expect(screen.getByText('3 photos across 3 cameos')).toBeTruthy();
    const dog = within(screen.getByRole('region', { name: 'Example Dog' }));
    expect(dog.getByAltText('Example Dog photo 1').getAttribute('src')).toBe('/data/image-thumbnails/a1.webp');
    expect(dog.getByRole('link', { name: 'Source of Example Dog photo 1' }).getAttribute('href')).toBe('https://example.com/a1');
    expect(dog.queryByRole('link', { name: 'Source of Example Dog photo 2' })).toBeNull();
    expect(dog.getByText('Upload')).toBeTruthy();
    // A photo with only its image file's address still names where it came from.
    expect(screen.getByRole('link', { name: 'Source of Example Cat photo 1' }).getAttribute('href')).toBe('https://example.com/b1.jpg');
    expect(within(screen.getByRole('region', { name: 'Example Cat' })).getByText('Still')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Search cameos'), { target: { value: 'cat' } });
    expect(screen.getByText('1 photo across 1 cameo')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Example Dog' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Search cameos'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Needs photos' }));
    expect(within(screen.getByRole('region', { name: 'Example Bird' })).getByText('No photos yet.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Example Cat' })).toBeNull();
  });

  // Uniquely catches a removal that saves without reaching the grid or the summary, or that strands keyboard focus.
  it('removes a photo from the grid, updates the summary and keeps the keyboard place', async () => {
    const start = photoRoster();
    removeMusicVideoCameoReference.mockResolvedValue(withoutReference(start, 'b1.png'));
    render(<StatefulPanel start={start} />);
    expect(screen.getByText(/3 photos · 1 need photos · 2 need a still · 0 linked shots/)).toBeTruthy();

    const remove = screen.getByRole('button', { name: 'Remove Example Cat photo 1' });
    remove.focus();
    fireEvent.click(remove);

    await waitFor(() => expect(screen.queryByAltText('Example Cat photo 1')).toBeNull());
    expect(removeMusicVideoCameoReference).toHaveBeenCalledWith('mv-1', 'mvcam-b', 'b1.png', { silent: true });
    expect(screen.getByText(/2 photos · 2 need photos · 2 need a still · 0 linked shots/)).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Example Cat' })).getByText('No photos yet.')).toBeTruthy();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Remove Example Dog photo 2');
  });

  // Uniquely catches overlapping removals: a late answer holding the older roster would resurrect a removed photo.
  it('runs quick removals in order so an older answer cannot bring a photo back', async () => {
    const start = photoRoster();
    let finishFirst;
    removeMusicVideoCameoReference.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }));
    removeMusicVideoCameoReference.mockResolvedValueOnce(withoutReference(withoutReference(start, 'a1.png'), 'a2.png'));
    render(<StatefulPanel start={start} />);

    const first = screen.getByRole('button', { name: 'Remove Example Dog photo 1' });
    fireEvent.click(first);
    fireEvent.click(first);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Example Dog photo 2' }));
    await waitFor(() => expect(removeMusicVideoCameoReference).toHaveBeenCalledTimes(1));

    finishFirst(withoutReference(start, 'a1.png'));
    await waitFor(() => expect(removeMusicVideoCameoReference).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Example Dog' })).getByText('No photos yet.')).toBeTruthy());
  });

  // Uniquely catches a failed removal dropping the photo or going unreported.
  it('keeps the photo and says so when a removal fails', async () => {
    removeMusicVideoCameoReference.mockRejectedValueOnce(new Error('Example failure'));
    render(<StatefulPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Example Dog photo 1' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Example failure'));
    expect(screen.getByAltText('Example Dog photo 1')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove Example Dog photo 1' }).getAttribute('aria-disabled')).toBeNull());
  });

  // Uniquely catches a roster with photos but no stills going back to a list of blanks.
  it('falls back to the first photo as the list thumbnail until a still is picked', () => {
    render(<StatefulPanel entry="/music-video/mv-1/cast-sets" />);
    const row = (name) => screen.getByRole('button', { name: new RegExp(name) });
    expect(row('Example Dog').querySelector('img').getAttribute('src')).toBe('/data/image-thumbnails/a1.webp');
    expect(row('Example Cat').querySelector('img').getAttribute('src')).toBe('/data/image-thumbnails/b1.webp');
    expect(within(row('Example Bird')).getByText('No still')).toBeTruthy();
  });
});

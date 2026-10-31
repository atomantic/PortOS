import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import SceneFrames from './SceneFrames.jsx';

vi.mock('../../services/apiImageVideo.js', () => ({ previewImagePrompt: vi.fn(async (body) => ({ sentPrompt: `${body.prompt}\nSinger stands at the "rail" mark, waving`, promptAdditions: [{ id: 'greybox-figure-0', label: 'Greybox figure 1', text: 'Singer stands at the "rail" mark, waving' }] })) }));

const scene = { sceneId: 's1', referenceImageId: 'start.png', endImageId: 'end.png', framePrompt: 'Door opens', endFramePrompt: 'Door shut', takes: [] };
const frames = (props) => render(<SceneFrames scene={scene} index={0} endFrames onEditLocal={vi.fn()} onSave={vi.fn()} {...props} />);

describe('older Casting look (#14154)', () => {
  const guide = (mediaKey, age) => ({ mediaKey, kind: 'reference', library: { variant: { age }, guide: true } });
  const project = { id: 'mv-example', concept: { subjects: [
    { ingredientId: 'cat-lead', name: 'Example Lead' }, { ingredientId: 'cat-other', name: 'Example Other' },
  ] } };
  const castMedia = { 'cat-lead': [guide('face-new.png', 7)], 'cat-other': [guide('other.png', 30)] };

  // Uniquely catches an older guide with no mark, another cast member marked, a take with no snapshot marked, or a locked shot re-rendering itself.
  it('marks the selected frame and re-renders it once, and holds that re-render while the still is locked', () => {
    const onGenerateFrame = vi.fn();
    const older = {
      sceneId: 's1', referenceImageId: 'start.png', endImageId: 'end.png', framePrompt: 'Door', endFramePrompt: 'Shut',
      characterVariant: { ingredientId: 'cat-lead', age: 7 },
      takes: [
        { takeId: 'old', kind: 'image', assetId: 'start.png', castInputs: { ingredientId: 'cat-lead', guides: ['face-old.png'], sheets: [] } },
        { takeId: 'end', kind: 'endImage', assetId: 'end.png' },
      ],
    };
    const props = { project, castMedia, onGenerateFrame, onGenerateEndFrame: vi.fn(), onEditLocal: vi.fn(), onSave: vi.fn() };
    const { rerender } = render(<SceneFrames {...props} scene={older} index={0} endFrames />);
    expect(onGenerateFrame).not.toHaveBeenCalled();
    expect(screen.getAllByText(/Older look:/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Re-render start frame' }));
    expect(onGenerateFrame).toHaveBeenCalledTimes(1);
    expect(onGenerateFrame.mock.calls[0][1]).toEqual({ referenceImageId: null, replaceSelection: true });

    rerender(<SceneFrames {...props} scene={older} index={0} endFrames stillLocked />);
    expect(screen.getByText(/Older look:/)).toBeTruthy();
    const locked = screen.getByRole('button', { name: 'Re-render start frame' });
    expect(locked.disabled).toBe(true);
    fireEvent.click(locked);
    expect(onGenerateFrame).toHaveBeenCalledTimes(1);

    const current = {
      sceneId: 's2', referenceImageId: 'other.png', framePrompt: 'Harbor',
      characterVariant: { ingredientId: 'cat-other', age: 30 },
      takes: [{ takeId: 't2', kind: 'image', assetId: 'other.png', castInputs: { ingredientId: 'cat-other', guides: ['other.png'], sheets: [] } }],
    };
    rerender(<SceneFrames {...props} scene={current} index={1} />);
    expect(screen.queryByText(/Older look:/)).toBeNull();
    rerender(<SceneFrames {...props} scene={{ ...older, endImageId: null, takes: [{ takeId: 'legacy', kind: 'image', assetId: 'start.png' }] }} index={0} />);
    expect(screen.queryByText(/Older look:/)).toBeNull();
  });
});

describe('Swap start and end', () => {
  // Uniquely catches the one-tap swap missing from a shot with both frames, offered with one frame, or open while its video is locked.
  it('swaps a shot with both frames in one tap, and is held while the video is locked', () => {
    const onSwapFrames = vi.fn();
    const { unmount } = frames({ onSwapFrames });
    fireEvent.click(screen.getByRole('button', { name: 'Swap start and end' }));
    expect(onSwapFrames).toHaveBeenCalledTimes(1);
    unmount();
    frames({ onSwapFrames, clipLocked: true });
    expect(screen.getByRole('button', { name: 'Swap start and end' }).disabled).toBe(true);
  });

  it('is not offered until both frames exist', () => {
    render(<SceneFrames scene={{ ...scene, endImageId: null }} index={0} endFrames onEditLocal={vi.fn()} onSave={vi.fn()} onSwapFrames={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Swap start and end' })).toBeNull();
  });
});

// Catches hidden layouts, missing figure chips, or a removed camera still being renderable.
it('shows the selected greybox capture, inspectable figure additions and a missing-camera error', async () => {
  const project = { id: 'mv-example', concept: { subjects: [{ id: 'rink', kind: 'place', ingredientId: 'cat-rink', name: 'Example Rink' }] } };
  const selected = { ...scene, setReference: { subjectId: 'rink', greyboxShotId: 'wide' } };
  const greyboxPlaces = { 'cat-rink': { ingredient: { type: 'place', payload: { greybox: {
    anchors: [{ id: 'rail', label: 'Singer' }], shots: [{ id: 'wide', label: 'Wide', figures: [{ anchorId: 'rail', pose: 'waving' }] }],
  } } }, media: [{ kind: 'reference', mediaKey: 'layout.png', role: 'greybox-shot:wide' }] } };
  const props = { project, scene: selected, greyboxPlaces, index: 0, onEditLocal: vi.fn(), onSave: vi.fn() };
  const { rerender } = render(<SceneFrames {...props} />);
  const capture = screen.getByRole('img', { name: 'Example Rink · Wide' });
  expect(capture.getAttribute('src')).toBe('/data/image-thumbnails/layout.webp');
  // The thumbnail falls back to the capture itself; only that failing flags it missing.
  fireEvent.error(capture);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(capture.getAttribute('src')).toContain('layout.png');
  fireEvent.error(capture);
  expect(screen.getByRole('alert').textContent).toMatch(/capture file could not be loaded/);
  fireEvent.click(await screen.findByRole('button', { name: '+ Greybox figure 1' }));
  expect(screen.getByText('Singer stands at the "rail" mark, waving')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show full prompt' }));
  expect(screen.getByText(/Door opens[\s\S]*Singer stands/)).toBeTruthy();
  expect(screen.getByRole('textbox', { name: 'Reference frame prompt' }).value).toBe('Door opens');
  rerender(<SceneFrames {...props} greyboxPlaces={{ 'cat-rink': { ...greyboxPlaces['cat-rink'], ingredient: { type: 'place', payload: { greybox: { shots: [] } } } } }} />);
  expect(screen.getByRole('alert').textContent).toMatch(/removed/);
  expect(screen.getByRole('button', { name: 'New frame take' }).disabled).toBe(true);
});

// Catches a failed selection save changing the visible reference or leaving generation enabled during the write.
it('waits for a greybox selection to save and keeps the previous selection on failure', async () => {
  let finish;
  const onSave = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  const onEditLocal = vi.fn();
  const project = { id: 'mv-example', concept: { subjects: [{ id: 'rink', kind: 'place', ingredientId: 'cat-rink', name: 'Example Rink' }] } };
  render(<SceneFrames project={project} scene={scene} index={0} onEditLocal={onEditLocal} onSave={onSave} />);
  fireEvent.change(screen.getByRole('combobox', { name: 'Set' }), { target: { value: 'rink' } });
  expect(onSave).toHaveBeenCalledWith('s1', { setReference: { subjectId: 'rink' } });
  expect(onEditLocal).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'New frame take' }).disabled).toBe(true);
  finish(false);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not saved/));
  expect(onEditLocal).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: 'Set' }).value).toBe('');
});

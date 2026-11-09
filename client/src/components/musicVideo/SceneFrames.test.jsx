import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import SceneFrames from './SceneFrames.jsx';

vi.mock('../../services/apiImageVideo.js', () => ({ previewImagePrompt: vi.fn(async (body) => ({ sentPrompt: `${body.prompt}\nSinger stands at the "rail" mark, waving`, promptAdditions: [{ id: 'greybox-figure-0', label: 'Greybox figure 1', text: 'Singer stands at the "rail" mark, waving' }] })) }));

const scene = { sceneId: 's1', referenceImageId: 'start.png', endImageId: 'end.png', framePrompt: 'Door opens', endFramePrompt: 'Door shut', takes: [] };
// A remembered frame service would add a Model control beside From.
beforeEach(() => localStorage.clear());
const frames = (props) => render(<SceneFrames scene={scene} index={0} endFrames onEditLocal={vi.fn()} onSave={vi.fn()} {...props} />);

it('edits and saves each frame prompt on blur', () => {
  const onSave = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState(scene);
    return <SceneFrames scene={draft} index={0} endFrames onSave={onSave}
      onEditLocal={(_id, patch) => setDraft(current => ({ ...current, ...patch }))} />;
  }
  render(<Harness />);
  const start = screen.getByRole('textbox', { name: 'Start frame prompt' });
  fireEvent.change(start, { target: { value: 'The door opens\ninto a garden' } });
  fireEvent.blur(start);
  expect(onSave).toHaveBeenLastCalledWith('s1', { framePrompt: 'The door opens\ninto a garden' });

  const end = screen.getByRole('textbox', { name: 'End frame prompt' });
  fireEvent.change(end, { target: { value: '' } });
  fireEvent.blur(end);
  expect(onSave).toHaveBeenLastCalledWith('s1', { endFramePrompt: null });
});

// The list depends on this render's source frame, not just the number of chips.
it('names the references Codex would omit for each frame and updates when the source changes', () => {
  const references = Array.from({ length: 6 }, (_, i) => ({
    id: `r${i}`, imageId: `ref-${i}.png`, label: `Reference ${i}`, role: 'character',
  }));
  const project = { id: 'mv-example', visualSpec: { references } };
  frames({ project, scene: { ...scene, frameReferenceIds: references.map(ref => ref.id) } });

  let notices = screen.getAllByText(/If this frame uses Codex/);
  expect(notices[0].textContent).toContain('Reference 5');
  expect(notices[0].textContent).not.toContain('Reference 4');
  expect(notices[1].textContent).toContain('Reference 4, Reference 5');

  fireEvent.click(screen.getAllByRole('button', { name: 'Refine' })[0]);
  notices = screen.getAllByText(/If this frame uses Codex/);
  expect(notices[1].textContent).toContain('Reference 4, Reference 5');

  fireEvent.change(screen.getAllByRole('combobox', { name: 'From' })[0], { target: { value: 'start' } });
  notices = screen.getAllByText(/If this frame uses Codex/);
  expect(notices[0].textContent).toContain('Reference 4, Reference 5');
});

it('keeps an automatic storyboard panel in the Codex allowance when naming omissions', () => {
  const references = Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`, imageId: `ref-${i}.png`, label: `Reference ${i}`, role: 'character', condition: true,
  }));
  const project = { id: 'mv-example', visualSpec: { references } };
  frames({ project, scene: { ...scene, panelArt: 'panel.png' } });
  const notice = screen.getAllByText(/If this frame uses Codex/)[0].textContent;
  expect(notice).toContain('Reference 4');
  expect(notice).not.toContain('Storyboard panel');
});

it('does not flag references already covered by the source frame', () => {
  const references = [
    { id: 'a', imageId: 'start.png', label: 'A', role: 'character' },
    { id: 'b', imageId: 'start.png', label: 'B', role: 'character' },
  ];
  frames({ project: { id: 'mv-example', visualSpec: { references } },
    scene: { ...scene, frameReferenceIds: references.map(ref => ref.id) } });
  expect(screen.queryByText(/If this frame uses Codex/)).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Refine' })[0]);
  expect(screen.queryByText(/If this frame uses Codex/)).toBeNull();
});

it('shows mood-board images that will not fit after shot references', () => {
  const references = Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`, imageId: `ref-${i}.png`, label: `Reference ${i}`, role: 'character',
  }));
  const project = { id: 'mv-example', visualSpec: { references }, styleReferences: [{ imageId: 'style.png', caption: 'soft light' }] };
  frames({ project, scene: { ...scene, frameReferenceIds: references.map(ref => ref.id) } });
  expect(screen.getAllByText(/If this frame uses Codex/)[0].textContent).toContain('mood-board image style.png');
});

describe('older Casting look (#14154)', () => {
  const guide = (mediaKey, age) => ({ mediaKey, kind: 'reference', library: { variant: { age }, guide: true } });
  const project = { id: 'mv-example', concept: { subjects: [
    { ingredientId: 'cat-lead', name: 'Example Lead' }, { ingredientId: 'cat-other', name: 'Example Other' },
  ] } };
  const castMedia = { 'cat-lead': [guide('face-new.png', 7)], 'cat-other': [guide('other.png', 30)] };

  // A changed Casting look can be re-rendered, but an in-flight frame cannot be submitted twice.
  it('marks the selected frame and holds re-render while generation is in flight', () => {
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
    // The info icon is what tells a director that only Re-render swaps the selected frame.
    fireEvent.click(screen.getByRole('button', { name: 'New take vs Re-render' }));
    expect(screen.getByRole('tooltip').textContent).toMatch(/stays selected[\s\S]*Re-render:.*swaps it in/);
    fireEvent.click(screen.getByRole('button', { name: 'Re-render start frame' }));
    expect(onGenerateFrame).toHaveBeenCalledTimes(1);
    expect(onGenerateFrame.mock.calls[0][1]).toEqual({ referenceImageId: null, replaceSelection: true });

    rerender(<SceneFrames {...props} scene={older} index={0} endFrames generatingFrame />);
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
  it('swaps both frames in one tap and holds the action during take work', () => {
    const onSwapFrames = vi.fn();
    const { unmount } = frames({ onSwapFrames });
    fireEvent.click(screen.getByRole('button', { name: 'Swap start and end' }));
    expect(onSwapFrames).toHaveBeenCalledTimes(1);
    unmount();
    frames({ onSwapFrames, takeBusy: true });
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
  expect(screen.getByRole('textbox', { name: 'Frame prompt' }).value).toBe('Door opens');
  expect(screen.getByRole('checkbox', { name: 'Greybox layout' }).checked).toBe(true);
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
  // The greybox card stays folded away until its checkbox under References opens it.
  expect(screen.queryByRole('combobox', { name: 'Set' })).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Greybox layout' }));
  fireEvent.change(screen.getByRole('combobox', { name: 'Set' }), { target: { value: 'rink' } });
  expect(onSave).toHaveBeenCalledWith('s1', { setReference: { subjectId: 'rink' } });
  expect(onEditLocal).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'New frame take' }).disabled).toBe(true);
  finish(false);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not saved/));
  expect(onEditLocal).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: 'Set' }).value).toBe('');
});

// Catches the Greybox layout checkbox hiding a greybox that still reaches the renders.
it('turns a shot\'s greybox reference off from its checkbox', async () => {
  const onSave = vi.fn(async () => true);
  const project = { id: 'mv-example', concept: { subjects: [{ id: 'rink', kind: 'place', ingredientId: 'cat-rink', name: 'Example Rink' }] } };
  render(<SceneFrames project={project} scene={{ ...scene, setReference: { subjectId: 'rink' } }} index={0} onEditLocal={vi.fn()} onSave={onSave} />);
  expect(screen.getByRole('combobox', { name: 'Set' }).value).toBe('rink');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Greybox layout' }));
  expect(onSave).toHaveBeenCalledWith('s1', { setReference: null });
  await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Greybox layout' }).disabled).toBe(false));
});

it('Use end frame off hides the end frame and keeps its selection for switching back on', () => {
  const onSave = vi.fn();
  function Harness() {
    const [draft, setDraft] = useState(scene);
    return <SceneFrames scene={draft} index={0} endFrames endFrameToggle onSave={onSave}
      onEditLocal={(_id, patch) => setDraft(current => ({ ...current, ...patch }))} />;
  }
  render(<Harness />);
  const toggle = screen.getByRole('checkbox', { name: 'Use end frame' });
  expect(toggle.checked).toBe(true);
  fireEvent.click(toggle);
  expect(onSave).toHaveBeenLastCalledWith('s1', { endFrameOff: true });
  expect(screen.queryByRole('textbox', { name: 'End frame prompt' })).toBeNull();
  expect(screen.queryByRole('group', { name: 'Start and end frames' })).toBeNull();

  fireEvent.click(screen.getByRole('checkbox', { name: 'Use end frame' }));
  expect(onSave).toHaveBeenLastCalledWith('s1', { endFrameOff: null });
  expect(screen.getByRole('textbox', { name: 'End frame prompt' }).value).toBe('Door shut');
});

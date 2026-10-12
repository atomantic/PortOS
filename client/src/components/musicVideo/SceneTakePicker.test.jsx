import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const pool = [
  { kind: 'image', assetId: 'mine.png', sceneId: 's8', prompt: 'Film strip held to the lamp', clipIds: [] },
  { kind: 'image', assetId: 'other.png', sceneId: 's12', prompt: 'Splicer close-up', clipIds: ['clip-12'] },
  { kind: 'image', assetId: 'floor.png', sceneId: null, prompt: 'Reel on the floor', clipIds: [] },
  { kind: 'video', assetId: 'clip-12', sceneId: 's12', sourceImageId: 'other.png' },
];
vi.mock('../../services/apiMusicVideo.js', () => ({ getMusicVideoMediaPool: vi.fn(async () => ({ items: pool })) }));
const { default: SceneTakePicker } = await import('./SceneTakePicker.jsx');

describe('Swap from unused', () => {
  // Uniquely catches the picker offering the wrong kind or group, a shot-number search missing, or the partner clip dropped.
  it('groups unused stills by where they came from, finds a shot by number, and uses a still with its clip', async () => {
    const onPlace = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<SceneTakePicker open projectId="mv-1" scene={{ sceneId: 's8' }} kind="image" onClose={onClose} onPlace={onPlace}
      shotNumbers={new Map([['s8', 8], ['s12', 12]])} />);
    expect(await screen.findByRole('tab', { name: /This shot/ })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));

    fireEvent.click(screen.getByRole('tab', { name: /Other shots/ }));
    fireEvent.change(screen.getByLabelText('Search prompts or shot number'), { target: { value: '#12' } });
    fireEvent.click(screen.getByRole('button', { name: /still from shot 12/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Use still + its clip' }));
    expect(onPlace).toHaveBeenCalledWith({ kind: 'image', assetId: 'other.png', withAssetId: 'clip-12' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('tab', { name: /Floor/ }));
    fireEvent.change(screen.getByLabelText('Search prompts or shot number'), { target: { value: 'reel' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
});

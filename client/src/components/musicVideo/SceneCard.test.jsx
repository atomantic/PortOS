import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../../hooks/useVideoFileSrc.js', () => ({ useVideoFileSrc: () => ({}) }));
import SceneCard from './SceneCard.jsx';

describe('code shot (#10297)', () => {
  it('offers no frame or clip generation for a code shot in a layered composition', () => {
    const scene = { sceneId: 's1', visualLayer: 'code', startSec: 0, endSec: 5, takes: [] };
    const { rerender } = render(<SceneCard scene={scene} index={0} layered onEditLocal={() => {}} onSave={() => {}} />);
    expect(screen.getByTestId('code-shot-note').textContent).toMatch(/needs no frame or clip/);
    // A composed render has no code to run, so it says the shot will be black there.
    expect(screen.getByTestId('code-shot-note').textContent).toMatch(/composed render shows it as a black frame/);
    expect(screen.queryByRole('button', { name: 'Generate frame' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Generate video' })).toBeNull();
    rerender(<SceneCard scene={scene} index={0} layered documentComposition onEditLocal={() => {}} onSave={() => {}} />);
    expect(screen.getByTestId('code-shot-note').textContent).not.toMatch(/black frame/);
    // A plain render plays footage, so the generation controls come back.
    rerender(<SceneCard scene={scene} index={0} layered={false} onEditLocal={() => {}} onSave={() => {}} />);
    expect(screen.queryByTestId('code-shot-note')).toBeNull();
    expect(screen.getByRole('button', { name: 'Generate frame' })).toBeTruthy();
  });
});

describe('performance speaker save boundary', () => {
  it('keeps paid generation disabled until the speaker edit is saved, including a failed save', async () => {
    let settle;
    const onSave = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    function Harness() {
      const [scene, setScene] = useState({ sceneId: 's1', shotMode: 'performance', startSec: 0, endSec: 5, referenceImageId: 'frame.png', takes: [] });
      return <SceneCard scene={scene} index={0} lipSyncBackend="fal" songDurationSec={30}
        onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
    }
    render(<Harness />);
    const input = screen.getByLabelText('Speaker / singer');
    const generate = screen.getByRole('button', { name: 'Generate video' });
    expect(generate.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'Example Singer' } });
    expect(generate.disabled).toBe(true);
    fireEvent.blur(input);
    expect(onSave).toHaveBeenCalledWith('s1', { performanceSpeaker: 'Example Singer' });
    expect(generate.disabled).toBe(true);
    settle(false);
    await waitFor(() => expect(generate.disabled).toBe(true));
    fireEvent.blur(input);
    settle(true);
    await waitFor(() => expect(generate.disabled).toBe(false));
  });
});

describe('persisted render failure chip (#10154)', () => {
  const failedScene = (lane) => ({ sceneId: 's1', startSec: 0, endSec: 5, referenceImageId: 'frame.png', takes: [],
    lastFailure: { lane, error: 'CUDA out of memory', at: '2026-10-05T00:00:00.000Z' } });

  it('shows "Frame failed: <reason>" with a Retry that re-runs the failed lane, and hides while retrying', () => {
    const onGenerateFrame = vi.fn();
    const onGenerateVideo = vi.fn();
    const props = { index: 0, onEditLocal: vi.fn(), onSave: vi.fn(), onGenerateFrame, onGenerateVideo };
    const { rerender } = render(<SceneCard scene={failedScene('image')} {...props} />);
    expect(screen.getByText(/Frame failed: CUDA out of memory/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onGenerateFrame).toHaveBeenCalledWith(expect.objectContaining({ sceneId: 's1' }));
    expect(onGenerateVideo).not.toHaveBeenCalled();

    rerender(<SceneCard scene={failedScene('image')} generatingFrame {...props} />);
    expect(screen.queryByText(/Frame failed/)).toBeNull();

    rerender(<SceneCard scene={failedScene('video')} {...props} />);
    expect(screen.getByText(/Video failed: CUDA out of memory/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onGenerateVideo).toHaveBeenCalledTimes(1);
  });
});

describe('lyric type per shot (#10583)', () => {
  it('lets a composition-document shot pick its lyric zone and style, and clears back to the defaults', () => {
    const onSave = vi.fn();
    const scene = { sceneId: 's1', startSec: 0, endSec: 5, takes: [], textZone: 'upper-right' };
    const { rerender } = render(<SceneCard scene={scene} index={0} layered onEditLocal={() => {}} onSave={onSave} />);
    // Only a composition document draws the shared lyric type.
    expect(screen.queryByLabelText('Lyrics')).toBeNull();
    rerender(<SceneCard scene={scene} index={0} layered documentComposition onEditLocal={() => {}} onSave={onSave} />);
    expect(screen.getByLabelText('Lyrics').value).toBe('upper-right');
    for (const [label, value] of [['Upper centre', 'upper'], ['Lower centre', 'lower']]) {
      expect(screen.getByRole('option', { name: label }).value).toBe(value);
      fireEvent.change(screen.getByLabelText('Lyrics'), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText('Lyrics'), { target: { value: 'none' } });
    fireEvent.change(screen.getByLabelText('Lyric style'), { target: { value: 'stamp' } });
    fireEvent.change(screen.getByLabelText('Lyrics'), { target: { value: '' } });
    expect(onSave.mock.calls).toEqual([['s1', { textZone: 'upper' }], ['s1', { textZone: 'lower' }], ['s1', { textZone: 'none' }], ['s1', { lyricRole: 'stamp' }], ['s1', { textZone: null }]]);
  });
});

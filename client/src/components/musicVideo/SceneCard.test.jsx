import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
vi.mock('../../hooks/useVideoFileSrc.js', () => ({ useVideoFileSrc: () => ({}) }));
import SceneCard from './SceneCard.jsx';
import { GROK_VIDEO_DURATIONS } from '../../lib/grokVideoClip.js';

const GROK_MAX = GROK_VIDEO_DURATIONS.at(-1);
// A card opens on the last Render on pick, so each test starts from the project setting.
beforeEach(() => localStorage.clear());

describe('code shot (#10297)', () => {
  it('offers no frame or clip generation for a code shot in a layered composition', () => {
    const scene = { sceneId: 's1', visualLayer: 'code', startSec: 0, endSec: 5, takes: [] };
    const { rerender } = render(<SceneCard scene={scene} index={0} layered onEditLocal={() => {}} onSave={() => {}} />);
    expect(screen.getByTestId('code-shot-note').textContent).toMatch(/needs no frame or clip/);
    // A composed render has no code to run, so it says the shot will be black there.
    expect(screen.getByTestId('code-shot-note').textContent).toMatch(/composed render shows it as a black frame/);
    expect(screen.queryByRole('button', { name: 'Generate frame' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Render' })).toBeNull();
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
    const generate = screen.getByRole('button', { name: 'Render' });
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

describe('music-driven performance', () => {
  it('switches a shot between cutaway, lip-sync and music-driven, and plans the music-driven take on the audio-to-video model', () => {
    const onSave = vi.fn();
    function Harness() {
      const [scene, setScene] = useState({ sceneId: 's1', shotMode: 'cutaway', startSec: 10, endSec: 13.5, referenceImageId: 'frame.png', takes: [] });
      return <SceneCard scene={scene} index={0} lipSyncBackend="fal" songDurationSec={60} falVideoSettings={{}}
        onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
    }
    render(<Harness />);
    const shot = screen.getByLabelText('Shot');
    fireEvent.change(shot, { target: { value: 'music' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { shotMode: 'performance', performanceStyle: 'music' });
    expect(shot.value).toBe('music');
    // The shot's own 3.5s, not lip-sync's 5s minimum window.
    expect(screen.getByTestId('performance-plan').textContent).toMatch(/^Music-driven via fal\.ai OmniHuman v1\.5 \(audio-driven person\) \(fal-ai\/bytedance\/omnihuman\/v1\.5\) · song 0:10–0:13 · est\. \$0\.56 \(3\.5s at 1080p\)/);
    fireEvent.change(shot, { target: { value: 'performance' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { shotMode: 'performance', performanceStyle: null });
    expect(screen.getByTestId('performance-plan').textContent).toMatch(/^Lip-sync via/);
    fireEvent.change(shot, { target: { value: 'cutaway' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { shotMode: 'cutaway' });
  });
});

describe('failed video retry behind the speaker save gate (#11040)', () => {
  function Harness({ onSave, onGenerateVideo, onGenerateFrame = vi.fn(), lastFailure }) {
    const [scene, setScene] = useState({ sceneId: 's1', shotMode: 'performance', startSec: 0, endSec: 5, referenceImageId: 'frame.png', takes: [], lastFailure });
    return <SceneCard scene={scene} index={0} lipSyncBackend="fal" songDurationSec={30}
      onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave}
      onGenerateVideo={onGenerateVideo} onGenerateFrame={onGenerateFrame} />;
  }
  const videoFailure = { lane: 'video', error: 'Example failure', at: '2026-10-05T00:00:00.000Z' };

  it('refuses the video Retry while the speaker edit is dirty, saving, or failed to save, then recovers', async () => {
    let settle;
    const onSave = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    const onGenerateVideo = vi.fn();
    render(<Harness onSave={onSave} onGenerateVideo={onGenerateVideo} lastFailure={videoFailure} />);
    const input = screen.getByLabelText('Speaker / singer');
    const retry = screen.getByRole('button', { name: 'Retry' });
    const generate = screen.getByRole('button', { name: 'Render' });
    expect(retry.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'Example Singer' } });
    expect([generate.disabled, retry.disabled]).toEqual([true, true]);
    fireEvent.click(retry);
    fireEvent.blur(input);
    expect([generate.disabled, retry.disabled]).toEqual([true, true]);
    fireEvent.click(retry);
    settle(false);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect([generate.disabled, retry.disabled]).toEqual([true, true]);
    fireEvent.click(retry);
    expect(retry.title).toBe(generate.title);
    expect(onGenerateVideo).not.toHaveBeenCalled();
    fireEvent.blur(input);
    settle(true);
    await waitFor(() => expect(retry.disabled).toBe(false));
    fireEvent.click(retry);
    expect(onGenerateVideo).toHaveBeenCalledTimes(1);
  });

  it('leaves the frame Retry available while the speaker edit is unsaved', () => {
    const onGenerateFrame = vi.fn();
    const onGenerateVideo = vi.fn();
    render(<Harness onSave={vi.fn()} onGenerateVideo={onGenerateVideo} onGenerateFrame={onGenerateFrame}
      lastFailure={{ ...videoFailure, lane: 'image' }} />);
    fireEvent.change(screen.getByLabelText('Speaker / singer'), { target: { value: 'Example Singer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onGenerateFrame).toHaveBeenCalledTimes(1);
    expect(onGenerateVideo).not.toHaveBeenCalled();
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

describe('planned camera move (#10589)', () => {
  function Harness({ initial, onSave }) {
    const [scene, setScene] = useState(initial);
    return <SceneCard scene={scene} index={0} layered onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
  }

  it('picks a catalog move, its speed and beat, and clears it', () => {
    const onSave = vi.fn();
    render(<Harness initial={{ sceneId: 's1', visualLayer: 'still', startSec: 0, endSec: 5, takes: [] }} onSave={onSave} />);
    const select = screen.getByLabelText('Camera');
    expect(select.value).toBe('');
    expect(screen.getByLabelText('Move').disabled).toBe(false);
    fireEvent.change(select, { target: { value: 'whip-pan' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { camera: { move: 'whip-pan' } });
    expect(screen.getByLabelText('Move').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: 'fast' } });
    fireEvent.click(screen.getByLabelText('On beat'));
    expect(onSave).toHaveBeenLastCalledWith('s1', { camera: { move: 'whip-pan', speed: 'fast', onBeat: true } });
    fireEvent.change(select, { target: { value: '' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { camera: null });
  });

  it('asks why a static camera holds, and offers no camera on a title card', () => {
    const onSave = vi.fn();
    const { unmount } = render(<Harness initial={{ sceneId: 's1', startSec: 0, endSec: 5, takes: [], camera: { move: 'slow-dolly-in' } }} onSave={onSave} />);
    expect(screen.queryByLabelText('Why it holds')).toBeNull();
    fireEvent.change(screen.getByLabelText('Camera'), { target: { value: 'locked-off' } });
    const reason = screen.getByLabelText('Why it holds');
    fireEvent.change(reason, { target: { value: ' the dancer fills the frame ' } });
    fireEvent.blur(reason);
    expect(onSave).toHaveBeenLastCalledWith('s1', { camera: { move: 'locked-off', reason: 'the dancer fills the frame' } });
    unmount();
    render(<SceneCard scene={{ sceneId: 's2', visualLayer: 'card', startSec: 0, endSec: 5, takes: [] }} index={0} layered onEditLocal={() => {}} onSave={() => {}} />);
    expect(screen.queryByLabelText('Camera')).toBeNull();
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

describe('move buttons (#10785)', () => {
  const scene = { sceneId: 's1', startSec: 0, endSec: 5, takes: [] };
  it('disables Move earlier/later on a document composition and explains why', () => {
    const onMove = vi.fn();
    const props = { scene, index: 1, isLast: false, onMove, onEditLocal: () => {}, onSave: () => {} };
    const { rerender } = render(<SceneCard {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Shot actions' }));
    expect(screen.getByRole('menuitem', { name: /Move earlier/ }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('menuitem', { name: /Move later/ }));
    expect(onMove).toHaveBeenCalledWith(1, 1);
    rerender(<SceneCard {...props} documentComposition />);
    fireEvent.click(screen.getByRole('button', { name: 'Shot actions' }));
    expect(screen.getByRole('menuitem', { name: /Move earlier/ }).disabled).toBe(true);
    expect(screen.getByRole('menuitem', { name: /Move later/ }).disabled).toBe(true);
    expect(screen.getByText(/comes from the composition document/)).toBeTruthy();
  });
});

describe('Merge with next (#10810)', () => {
  const scene = { sceneId: 's1', startSec: 0, endSec: 4, takes: [] };
  const props = { index: 0, expanded: true, onEditLocal: vi.fn(), onSave: vi.fn() };

  it('merges into the next scene, and hides when last, in a document composition, or past the backend limit', () => {
    const onMergeNext = vi.fn();
    const { rerender } = render(<SceneCard scene={scene} {...props} onMergeNext={onMergeNext} nextEndSec={8} lipSyncBackend="grok" />);
    fireEvent.click(screen.getByRole('button', { name: /Merge with next/ }));
    expect(onMergeNext).toHaveBeenCalledWith('s1', 'grok');
    rerender(<SceneCard scene={scene} {...props} onMergeNext={onMergeNext} nextEndSec={19} lipSyncBackend="grok" />);
    expect(screen.queryByRole('button', { name: /Merge with next/ })).toBeNull();
    rerender(<SceneCard scene={scene} {...props} onMergeNext={onMergeNext} nextEndSec={8} isLast />);
    expect(screen.queryByRole('button', { name: /Merge with next/ })).toBeNull();
    rerender(<SceneCard scene={scene} {...props} onMergeNext={onMergeNext} nextEndSec={8} documentComposition />);
    expect(screen.queryByRole('button', { name: /Merge with next/ })).toBeNull();
  });
});

describe('scene timing and provider presentation (#11046)', () => {
  const scene = { sceneId: 'timing', startSec: 10, endSec: 12, referenceImageId: 'frame.png', takes: [] };
  const props = { index: 0, expanded: true, onEditLocal: vi.fn(), onSave: vi.fn() };

  it('shows the supported song window, edit offset and saved resolution cost, including a zero offset and unknown song duration', () => {
    const performance = { ...scene, shotMode: 'performance' };
    const { rerender } = render(<SceneCard {...props} scene={performance} lipSyncBackend="fal" songDurationSec={30} />);
    const plan = () => screen.getByTestId('performance-plan').textContent;
    expect(plan()).toContain('Lip-sync via fal.ai MiniMax H3 lip-sync (minimax/h3-max/lip-sync/image-to-video)');
    expect(plan()).toContain('song 0:08–0:13');
    expect(plan()).toContain('shot starts 1.52s into the take');
    expect(plan()).toContain('est. $0.81 (5.05s at 1080P)');
    expect(screen.getByRole('button', { name: 'Render' }).title).toContain('est. $0.81');
    rerender(<SceneCard {...props} scene={{ ...performance, startSec: 0, endSec: 6 }} lipSyncBackend="fal"
      falVideoSettings={{ falLipSyncResolution: '768P' }} songDurationSec={null} />);
    expect(plan()).toContain('song 0:00–0:06');
    expect(plan()).not.toContain('shot starts');
    expect(plan()).toContain('est. $0.48 (6s at 768P)');
    expect(screen.getByRole('button', { name: 'Render' }).disabled).toBe(false);
    rerender(<SceneCard {...props} scene={{ ...performance, startSec: 0, endSec: 6 }} lipSyncBackend="fal" />);
    expect(screen.getByRole('button', { name: 'Render' }).disabled).toBe(false);
    rerender(<SceneCard {...props} scene={performance} lipSyncBackend="fal" songDurationSec={11} />);
    expect(screen.getByText('The performance shot runs past the end of the song.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Render' }).disabled).toBe(true);
  });

  it('blocks unsupported performance generation and keeps the blocker on the generation control', () => {
    render(<SceneCard {...props} scene={{ ...scene, shotMode: 'performance' }} lipSyncBackend="grok" />);
    const blocker = screen.getByText(/Grok video is cutaway-only/);
    expect(blocker.closest('[role="alert"]')).toBeTruthy();
    expect(screen.queryByTestId('performance-plan')).toBeNull();
    const generate = screen.getByRole('button', { name: 'Render' });
    expect(generate.disabled).toBe(true);
    expect(generate.title).toBe(blocker.textContent);
  });

  it('shows the fal cutaway model and cost, preserves unknown model pricing, and distinguishes layer from render mode', () => {
    const { rerender } = render(<SceneCard {...props} scene={scene} lipSyncBackend="fal" />);
    expect(screen.getByTestId('fal-cutaway-plan').textContent).toContain('fal.ai renders a 6s clip on MiniMax Hailuo-02 Standard (image)');
    expect(screen.getByTestId('fal-cutaway-plan').textContent).toContain('est. $0.27 (6s at 768P)');
    rerender(<SceneCard {...props} scene={scene} lipSyncBackend="fal" falVideoSettings={{ falModelId: 'example/unpriced' }} />);
    expect(screen.getByTestId('fal-cutaway-plan').textContent).toContain('fal.ai renders a clip on example/unpriced');
    expect(screen.getByTestId('fal-cutaway-plan').textContent).toContain('cost unknown — billed to your fal.ai account');
    rerender(<SceneCard {...props} scene={{ ...scene, visualLayer: 'still', shotMode: 'performance' }} lipSyncBackend="fal" layered />);
    expect(screen.queryByTestId('fal-cutaway-plan')).toBeNull();
    expect(screen.queryByTestId('performance-plan')).toBeNull();
    rerender(<SceneCard {...props} scene={{ ...scene, visualLayer: 'still', shotMode: 'performance' }} lipSyncBackend="fal" />);
    expect(screen.queryByTestId('fal-cutaway-plan')).toBeNull();
    expect(screen.getByRole('button', { name: 'Render' }).disabled).toBe(false);
  });

  it('warns about uncovered Grok time and splits with the original scene/backend arguments only beyond the epsilon', () => {
    const onSplit = vi.fn();
    const { rerender } = render(<SceneCard {...props} scene={{ ...scene, startSec: 0, endSec: 18 }} lipSyncBackend="grok" onSplit={onSplit} />);
    expect(screen.getByText(/Grok renders a 15s clip for this 18.0s cutaway/).textContent).toContain('3.0s uncovered; split the scene rather than loop it');
    fireEvent.click(screen.getByRole('button', { name: 'Split on lyric boundaries' }));
    expect(onSplit).toHaveBeenCalledWith('timing', 'grok');
    rerender(<SceneCard {...props} scene={{ ...scene, startSec: 0, endSec: GROK_MAX + 1e-6 }} lipSyncBackend="grok" onSplit={onSplit} />);
    expect(screen.queryByRole('button', { name: 'Split on lyric boundaries' })).toBeNull();
    rerender(<SceneCard {...props} scene={{ ...scene, startSec: 0, endSec: GROK_MAX + 2e-6 }} lipSyncBackend="grok" onSplit={onSplit} />);
    expect(screen.getByRole('button', { name: 'Split on lyric boundaries' })).toBeTruthy();
    rerender(<SceneCard {...props} scene={{ ...scene, endSec: null }} lipSyncBackend="grok" onSplit={onSplit} />);
    expect(screen.queryByText(/Grok renders/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Split on lyric boundaries' })).toBeNull();
  });

  it('merges at the provider limit including its epsilon, requires the next span for bounded providers, and preserves default-backend arguments', () => {
    const onMergeNext = vi.fn();
    const current = { ...scene, startSec: 0, endSec: 4 };
    const { rerender } = render(<SceneCard {...props} scene={current} lipSyncBackend="grok" nextEndSec={GROK_MAX + 1e-6} onMergeNext={onMergeNext} />);
    fireEvent.click(screen.getByRole('button', { name: 'Merge with next' }));
    expect(onMergeNext).toHaveBeenLastCalledWith('timing', 'grok');
    rerender(<SceneCard {...props} scene={current} lipSyncBackend="grok" nextEndSec={GROK_MAX + 2e-6} onMergeNext={onMergeNext} />);
    expect(screen.queryByRole('button', { name: 'Merge with next' })).toBeNull();
    rerender(<SceneCard {...props} scene={current} lipSyncBackend="grok" onMergeNext={onMergeNext} />);
    expect(screen.queryByRole('button', { name: 'Merge with next' })).toBeNull();
    rerender(<SceneCard {...props} scene={current} onMergeNext={onMergeNext} />);
    fireEvent.click(screen.getByRole('button', { name: 'Merge with next' }));
    expect(onMergeNext).toHaveBeenLastCalledWith('timing', null);
  });
});

describe('Render follows the shot locks', () => {
  // Uniquely catches Render staying live on a shot whose still is unlocked, or whose video is locked.
  it('needs the still locked to render, and refuses a locked video until it is unlocked', async () => {
    const { ShotLockContext } = await import('./ShotLock.jsx');
    const scene = { sceneId: 's1', prompt: 'She spins the reel', referenceImageId: 'still.png', videoHistoryId: 'clip-1', startSec: 0, endSec: 4, takes: [] };
    const onGenerateVideo = vi.fn();
    const card = (still, clip) => (
      <ShotLockContext.Provider value={{ locks: { s1: still }, clips: { s1: clip }, toggle: () => {}, busy: false }}>
        <SceneCard scene={scene} index={0} expanded onEditLocal={() => {}} onSave={() => {}} onGenerateVideo={onGenerateVideo} falVideoSettings={{ backend: 'local' }} />
      </ShotLockContext.Provider>
    );
    const { rerender } = render(card('open', 'open'));
    expect(screen.getByRole('button', { name: 'Render again' })).toHaveProperty('title', 'Lock the still first');
    // On a phone there is no tooltip: the reason and the lock it needs sit under Render.
    const refusal = screen.getByTestId('render-refusal');
    expect(refusal.textContent).toContain('Lock the still first');
    expect(refusal.querySelector('button')).toBeTruthy();
    rerender(card('locked', 'locked'));
    expect(screen.getByRole('button', { name: 'Render again' }).disabled).toBe(true);
    expect(screen.getByRole('button', { name: 'Render again' }).title).toMatch(/^Video locked/);
    rerender(card('locked', 'open'));
    // The corner lock shows only its icon on a phone; its label stays the button's name.
    expect(screen.getByRole('button', { name: 'Lock video' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Render again' }));
    expect(onGenerateVideo).toHaveBeenCalledWith(scene, { card: expect.objectContaining({ prompt: scene.prompt }) });
  });
});

describe('start and end frames', () => {
  // Uniquely catches a frame's prompt or Render hiding away from its picture, a frame reference not reaching the render, or the Render section not saying which renderer ends on the end frame.
  it('shows each frame with its prompt and Render, renders from a picked frame, and shows the tapped frame\'s takes', () => {
    const scene = { sceneId: 's1', prompt: 'She looks into the lens', referenceImageId: 'start.png', endImageId: 'end.png', endFramePrompt: 'Head thrown back', startSec: 0, endSec: 4,
      takes: [{ takeId: 't1', kind: 'image', assetId: 'start.png', status: 'selected' }, { takeId: 't2', kind: 'endImage', assetId: 'end.png', status: 'selected' }] };
    const onGenerateFrame = vi.fn();
    const onGenerateEndFrame = vi.fn();
    render(<SceneCard scene={scene} index={0} expanded onEditLocal={() => {}} onSave={() => {}} onGenerateFrame={onGenerateFrame} onGenerateEndFrame={onGenerateEndFrame}
      onPlacePoolItem={() => {}} falVideoSettings={{ backend: 'local' }} />);
    const pair = screen.getByRole('group', { name: 'Start and end frames' });
    expect(within(pair).getByLabelText('Reference frame prompt')).toBeTruthy();
    expect(within(pair).getByLabelText('End frame prompt').value).toBe('Head thrown back');

    // The end frame renders from the start frame unless another frame is picked; the start frame from its prompt.
    fireEvent.click(within(pair).getByRole('button', { name: 'New end frame take' }));
    expect(onGenerateEndFrame).toHaveBeenLastCalledWith(scene, { referenceImageId: 'start.png' });
    fireEvent.change(screen.getByLabelText('From', { selector: '#mv-scene-s1-start-from' }), { target: { value: 'end' } });
    fireEvent.click(within(pair).getByRole('button', { name: 'New frame take' }));
    expect(onGenerateFrame).toHaveBeenLastCalledWith(scene, { referenceImageId: 'end.png' });

    expect(screen.getByRole('list', { name: /^Frame takes/ })).toBeTruthy();
    fireEvent.click(within(pair).getByRole('button', { name: 'End frame' }));
    expect(screen.getByRole('list', { name: /^End frame takes/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear scene 1 end frame' })).toBeTruthy();

    expect(screen.getByTestId('end-frame-plan').textContent).toMatch(/animates from the start frame only/);
    const pick = screen.getByLabelText('Render on');
    expect(within(pick).getByRole('option', { name: /Kling v3 Pro.*ends on end frame/ })).toBeTruthy();
    fireEvent.change(pick, { target: { value: 'fal:fal-ai/kling-video/v3/pro/image-to-video' } });
    expect(screen.getByTestId('end-frame-plan').textContent).toBe('The clip ends on the end frame.');
  });
});

describe('Render on remembers the last pick', () => {
  // Uniquely catches a new card falling back to the project setting (a paid fal render) after the director picked local.
  it('opens the next card on the last pick made on this device, and falls back where the shot cannot use it', () => {
    const scene = { sceneId: 's1', prompt: 'She turns away', referenceImageId: 'start.png', startSec: 0, endSec: 4,
      takes: [{ takeId: 't1', kind: 'image', assetId: 'start.png', status: 'selected' }] };
    const saved = { backend: 'fal' };
    const first = render(<SceneCard scene={scene} index={0} expanded onEditLocal={() => {}} onSave={() => {}} falVideoSettings={saved} />);
    expect(screen.getByLabelText('Render on').value).toBe('');
    fireEvent.change(screen.getByLabelText('Render on'), { target: { value: 'local' } });
    first.unmount();

    const second = render(<SceneCard scene={{ ...scene, sceneId: 's2' }} index={1} expanded onEditLocal={() => {}} onSave={() => {}} falVideoSettings={saved} />);
    expect(screen.getByLabelText('Render on').value).toBe('local');
    fireEvent.change(screen.getByLabelText('Render on'), { target: { value: 'grok' } });
    second.unmount();

    // Grok renders cutaways only, so a lip-synced shot opens on the project setting.
    render(<SceneCard scene={{ ...scene, sceneId: 's3', shotMode: 'performance' }} index={2} expanded onEditLocal={() => {}} onSave={() => {}} falVideoSettings={saved} />);
    expect(screen.getByLabelText('Render on').value).toBe('');
  });
});

describe('frame fit for an off-shape clip', () => {
  // Uniquely catches the fit choice hiding on a 3:2 clip in a 16:9 video (or
  // cluttering a matching one), and the pick not reaching the saved shot.
  it('offers zoom to fill or keep ratio once the clip reads 3:2, and saves the pick', () => {
    const scene = { sceneId: 's1', prompt: 'Memory footage', referenceImageId: 'still.png', videoHistoryId: 'clip-1', startSec: 0, endSec: 4, takes: [] };
    const onSave = vi.fn();
    const onEditLocal = vi.fn();
    const { container } = render(<SceneCard scene={scene} index={0} expanded onEditLocal={onEditLocal} onSave={onSave} />);
    const video = container.querySelector('video');
    const load = (width, height) => {
      Object.defineProperty(video, 'duration', { value: 4, configurable: true });
      Object.defineProperty(video, 'videoWidth', { value: width, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: height, configurable: true });
      fireEvent.loadedMetadata(video);
    };
    load(1024, 576);
    expect(screen.queryByLabelText('Not 16:9')).toBeNull();
    load(768, 512);
    const pick = screen.getByLabelText('Not 16:9');
    expect(pick.value).toBe('fill');
    fireEvent.change(pick, { target: { value: 'vhs' } });
    expect(onSave).toHaveBeenCalledWith('s1', { frameFit: 'vhs' });
    expect(onEditLocal).toHaveBeenCalledWith('s1', { frameFit: 'vhs' });
  });
});

describe('Sent to the model', () => {
  // Uniquely catches the card's Render sending anything other than what the card shows, or dropping the Song audio toggle.
  it('shows the prompt Render sends and hands it, with the song audio pick, to the render', () => {
    const scene = { sceneId: 's1', prompt: 'She shakes her head', referenceImageId: 'start.png', startSec: 0, endSec: 4,
      takes: [{ takeId: 't1', kind: 'image', assetId: 'start.png', status: 'selected' }] };
    const onGenerateVideo = vi.fn();
    const models = [{ id: 'ltx25_example', name: 'LTX-2.5 Example', runtime: 'ltx25', supportedModes: ['image', 'a2v'] }];
    render(<SceneCard scene={scene} index={0} expanded onEditLocal={() => {}} onSave={() => {}} onGenerateVideo={onGenerateVideo}
      videoModels={models} falVideoSettings={{ backend: 'local', modelId: 'ltx25_example' }} />);
    const inputs = screen.getByTestId('render-inputs');
    expect(within(inputs).getByText('She shakes her head')).toBeTruthy();
    fireEvent.click(within(inputs).getByLabelText('Song audio'));
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect(onGenerateVideo).toHaveBeenCalledWith(scene, expect.objectContaining({ card: { prompt: 'She shakes her head', songAudio: true } }));
  });
});

// Uniquely catches the glitch picker saving the wrong field or failing to clear it.
describe('VHS glitch transitions', () => {
  it('sets a glitch on the cut out of a shot and clears it with Off', () => {
    const onSave = vi.fn();
    function Harness() {
      const [scene, setScene] = useState({ sceneId: 's1', startSec: 0, endSec: 4, takes: [] });
      return <SceneCard scene={scene} index={0} onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
    }
    render(<Harness />);
    const out = screen.getByLabelText('Glitch out');
    fireEvent.change(out, { target: { value: 'vhs-glitch' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { transitionOut: 'vhs-glitch' });
    expect(out.value).toBe('vhs-glitch');
    fireEvent.change(out, { target: { value: '' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { transitionOut: null });
    expect(screen.getByLabelText('Glitch in').value).toBe('');
  });
});

// Uniquely catches the picture picker saving the wrong layer or effect fields, or offering the effect where the render ignores it.
describe('image effect picker', () => {
  it('turns a shot into a still playing camera flash develop, sets its develop length, and back to a clip', () => {
    const onSave = vi.fn();
    function Harness({ layered = true }) {
      const [scene, setScene] = useState({ sceneId: 's1', startSec: 0, endSec: 4, referenceImageId: 'burger.png', takes: [] });
      return <SceneCard scene={scene} index={0} layered={layered} onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
    }
    const { unmount } = render(<Harness />);
    const picture = screen.getByLabelText('Picture');
    fireEvent.change(picture, { target: { value: 'flash-develop' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { visualLayer: 'still', imageEffect: 'flash-develop', imageEffectSec: 3 });
    fireEvent.change(screen.getByLabelText('Develops in'), { target: { value: '6' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { imageEffectSec: 6 });
    expect(screen.getByText('The shot ends at 4.0s, before the photo finishes developing.')).toBeTruthy();
    fireEvent.change(picture, { target: { value: 'clip' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { visualLayer: 'footage', imageEffect: null });
    unmount();
    render(<Harness layered={false} />);
    expect(screen.queryByLabelText('Picture')).toBeNull();
  });
});

// Uniquely catches an effect shot still showing its old clip and video controls, or an end-frame effect saving the wrong fields.
describe('a still picture in the clip column', () => {
  it('previews the still playing its effect instead of the old clip, and an end-frame effect asks for its end frame', () => {
    const onSave = vi.fn();
    function Harness() {
      const [scene, setScene] = useState({ sceneId: 's1', startSec: 0, endSec: 3, referenceImageId: 'start.png', videoHistoryId: 'clip-1', takes: [] });
      return <SceneCard scene={scene} index={0} layered onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
    }
    const { container } = render(<Harness />);
    expect(container.querySelector('section[aria-label="Render"] video')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Picture'), { target: { value: 'flash-develop' } });
    expect(screen.getByTestId('scene-picture-preview')).toBeTruthy();
    expect(container.querySelector('section[aria-label="Render"] video')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Render/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Picture'), { target: { value: 'end-glitch' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { visualLayer: 'still', imageEffect: 'end-glitch', imageEffectSec: null });
    expect(screen.getByText(/Needs an end frame/)).toBeTruthy();
    const change = screen.getByLabelText('Changes at');
    expect([...change.options].map((o) => o.textContent)).toEqual(['Middle', '0.5s', '1s', '1.5s', '2s']);
    fireEvent.change(change, { target: { value: '1' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { imageEffectSec: 1 });
  });
});

import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
vi.mock('../../services/apiRunwayCatalog.js', async (importOriginal) => ({ ...await importOriginal(), loadRunwayCatalog: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../hooks/useFilmLookPresets.js', () => ({ default: () => ({ presets: [], loaded: true, save: vi.fn(), remove: vi.fn() }) }));
vi.mock('../../hooks/useVideoFileSrc.js', () => ({ useVideoFileSrc: vi.fn(() => ({})) }));
vi.mock('../../services/apiMusicVideo.js', async (importOriginal) => ({ ...(await importOriginal()), getMusicVideoMediaPool: vi.fn(async () => ({ items: [] })) }));
vi.mock('../../services/api', async (importOriginal) => ({ ...(await importOriginal()), listTracks: vi.fn(async () => []) }));
import SceneCard from './SceneCard.jsx';
import { GROK_VIDEO_DURATIONS } from '../../lib/grokVideoClip.js';
import { useVideoFileSrc } from '../../hooks/useVideoFileSrc.js';

const GROK_MAX = GROK_VIDEO_DURATIONS.at(-1);
// The editor shows the still or the clip, one at a time.
const show = (name) => fireEvent.click(within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name }));
// A card opens on the last Render on pick, so each test starts from the project setting.
beforeEach(() => {
  localStorage.clear();
  useVideoFileSrc.mockReturnValue({});
});

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
  it('switches a shot between cutaway, lip-sync and music-driven, and plans the music-driven take on the default music-driven model', () => {
    const onSave = vi.fn();
    function Harness() {
      const [scene, setScene] = useState({ sceneId: 's1', shotMode: 'cutaway', startSec: 10, endSec: 13.5, referenceImageId: 'frame.png', takes: [] });
      return <SceneCard scene={scene} index={0} lipSyncBackend="fal" songDurationSec={60} falVideoSettings={{}}
        onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
    }
    render(<Harness />);
    // The header reads the shot's precise run time, then where it sits in the song.
    expect(screen.getByText(/^3\.50s · 0:10\.00–0:13\.50/)).toBeTruthy();
    const shot = screen.getByLabelText('Shot');
    fireEvent.change(shot, { target: { value: 'music' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { shotMode: 'performance', performanceStyle: 'music' });
    expect(shot.value).toBe('music');
    // H3 Max reference by default: the song window pads to exactly its 5s shortest billed clip.
    expect(screen.getByTestId('performance-plan').textContent).toMatch(/^Music-driven via fal\.ai MiniMax H3 Max \(reference\) \(minimax\/h3-max\/reference-to-video\) · song 0:09–0:14 · shot starts 0\.75s into the take · est\. \$0\.40 \(5s at 768P\)/);
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
  function Harness({ initial, onSave, documentComposition = false }) {
    const [scene, setScene] = useState(initial);
    return <SceneCard scene={scene} index={0} layered documentComposition={documentComposition} onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
  }

  it('picks a catalog move, its speed and beat, and clears it', () => {
    const onSave = vi.fn();
    render(<Harness initial={{ sceneId: 's1', visualLayer: 'still', startSec: 0, endSec: 5, takes: [] }} onSave={onSave} documentComposition />);
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

  // Uniquely catches a composed render's still Move locked behind a planned camera it no longer follows.
  it('keeps a composed still\'s Move in the director\'s hands with a camera planned', () => {
    render(<Harness initial={{ sceneId: 's1', visualLayer: 'still', stillMove: 'hold', startSec: 0, endSec: 5, takes: [], camera: { move: 'handheld' } }} onSave={vi.fn()} />);
    expect(screen.getByLabelText('Move').disabled).toBe(false);
    expect(screen.getByLabelText('Move').value).toBe('hold');
  });

  it('puts a footage shot\'s camera beside its motion prompt and shows the text it adds', () => {
    render(<Harness initial={{ sceneId: 's1', visualLayer: 'footage', prompt: 'a hand turns the dial', startSec: 0, endSec: 5, takes: [] }} onSave={vi.fn()} />);
    // With no still yet the editor opens on the Still; the camera sits with the clip's motion prompt.
    expect(screen.getByRole('button', { name: 'Still' }).getAttribute('aria-pressed')).toBe('true');
    show('Clip');
    const camera = screen.getByLabelText('Camera');
    expect(screen.queryByTestId('camera-adds')).toBeNull();
    fireEvent.change(camera, { target: { value: 'slow-dolly-in' } });
    const adds = screen.getByTestId('camera-adds').textContent.replace(/^Adds to the prompt: /, '');
    expect(adds.length).toBeGreaterThan(0);
    // The same text is what Sent to the model lists as its Camera move addition.
    fireEvent.click(within(screen.getByTestId('render-inputs')).getByRole('button', { name: '+ Camera move' }));
    expect(screen.getByTestId('render-inputs').textContent).toContain(adds);
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
  it('lets a shot pick where its lyrics sit, their style and size whenever the render draws lyrics', () => {
    const onSave = vi.fn();
    const scene = { sceneId: 's1', startSec: 0, endSec: 5, takes: [], textZone: 'upper-right' };
    const composed = { composition: { mode: 'composed', textCues: [] }, lyricCues: [{ text: 'a sung line', startSec: 1, endSec: 3 }] };
    const { rerender } = render(<SceneCard scene={scene} index={0} layered project={{ composition: { mode: 'composed', textCues: [] } }} onEditLocal={() => {}} onSave={onSave} />);
    // A composed render with no timed lyrics draws none, so there is nothing to place.
    expect(screen.queryByLabelText('Lyrics')).toBeNull();
    rerender(<SceneCard scene={scene} index={0} layered project={composed} onEditLocal={() => {}} onSave={onSave} />);
    expect(screen.getByLabelText('Lyrics').value).toBe('upper-right');
    for (const [label, value] of [['Bottom', 'lower'], ['Bottom right', 'lower-right'], ['Top left', 'upper-left']]) {
      expect(screen.getByRole('option', { name: label }).value).toBe(value);
      fireEvent.change(screen.getByLabelText('Lyrics'), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText('Lyric style'), { target: { value: 'stamp' } });
    fireEvent.change(screen.getByLabelText('Lyric size'), { target: { value: 'small' } });
    fireEvent.change(screen.getByLabelText('Lyrics'), { target: { value: '' } });
    expect(onSave.mock.calls).toEqual([['s1', { textZone: 'lower' }], ['s1', { textZone: 'lower-right' }], ['s1', { textZone: 'upper-left' }],
      ['s1', { lyricRole: 'stamp' }], ['s1', { lyricSize: 'small' }], ['s1', { textZone: null }]]);
    // A composition document always draws the lyric type.
    rerender(<SceneCard scene={scene} index={0} layered documentComposition onEditLocal={() => {}} onSave={onSave} />);
    expect(screen.getByLabelText('Lyrics')).toBeTruthy();
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
    show('Clip');
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

// Uniquely catches Merge over previous showing on the first shot, past the backend limit, or calling with the wrong shot.
describe('Merge over previous', () => {
  const scene = { sceneId: 's2', startSec: 4, endSec: 8, takes: [] };
  const props = { index: 1, expanded: true, onEditLocal: vi.fn(), onSave: vi.fn() };

  it('merges this shot over the previous one, and hides when first, in a document composition, or past the backend limit', () => {
    const onMergePrevious = vi.fn();
    const { rerender } = render(<SceneCard scene={scene} {...props} onMergePrevious={onMergePrevious} prevStartSec={0} lipSyncBackend="grok" />);
    show('Clip');
    fireEvent.click(screen.getByRole('button', { name: 'Merge over previous' }));
    expect(onMergePrevious).toHaveBeenCalledWith('s2', 'grok');
    rerender(<SceneCard scene={{ ...scene, endSec: 19 }} {...props} onMergePrevious={onMergePrevious} prevStartSec={0} lipSyncBackend="grok" />);
    expect(screen.queryByRole('button', { name: 'Merge over previous' })).toBeNull();
    rerender(<SceneCard scene={scene} {...props} index={0} onMergePrevious={onMergePrevious} prevStartSec={0} />);
    expect(screen.queryByRole('button', { name: 'Merge over previous' })).toBeNull();
    rerender(<SceneCard scene={scene} {...props} onMergePrevious={onMergePrevious} prevStartSec={0} documentComposition />);
    expect(screen.queryByRole('button', { name: 'Merge over previous' })).toBeNull();
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

describe('Render', () => {
  it('renders directly and offers no lock action', () => {
    const scene = { sceneId: 's1', prompt: 'She spins the reel', referenceImageId: 'still.png', videoHistoryId: 'clip-1', startSec: 0, endSec: 4, takes: [] };
    const onGenerateVideo = vi.fn();
    const onGenerateFrame = vi.fn();
    render(<SceneCard scene={scene} index={0} expanded onEditLocal={() => {}} onSave={() => {}} onGenerateVideo={onGenerateVideo}
      onGenerateFrame={onGenerateFrame} onPlacePoolItem={vi.fn()} falVideoSettings={{ backend: 'local' }} />);
    expect(screen.queryByTestId('render-refusal')).toBeNull();
    expect(screen.queryByRole('button', { name: /unlock|lock video/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Render again' }));
    expect(onGenerateVideo).toHaveBeenCalledWith(scene, { card: expect.objectContaining({ prompt: scene.prompt }) });
    show('Still');
    expect(screen.getByRole('button', { name: 'Swap start frame from unused' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'New frame take' }));
    expect(onGenerateFrame).toHaveBeenCalledWith(scene, { referenceImageId: null });
  });
});

describe('motion prompt from the storyboard panel', () => {
  // Uniquely catches a panel-linked shot asking for a typed prompt, or a typed prompt never handing back to the panel.
  it('renders from the panel direction until the director types their own, and links back in one tap', async () => {
    const scene = { sceneId: 's1', panelId: 'p1', visualIntent: 'She laces her skates', referenceImageId: 'still.png', videoHistoryId: 'clip-1', startSec: 0, endSec: 4, takes: [] };
    const onGenerateVideo = vi.fn();
    const onSave = vi.fn();
    const card = (shot) => (
        <SceneCard scene={shot} index={0} expanded project={{ id: 'mv-example', scenes: [shot] }} onEditLocal={() => {}} onSave={onSave} onGenerateVideo={onGenerateVideo} falVideoSettings={{ backend: 'local' }} />
    );
    const { rerender } = render(card(scene));
    const box = screen.getAllByLabelText('Shot prompt').find((el) => el.value);
    expect(box.value).toBe('She laces her skates');
    expect(screen.getByTestId('prompt-from-storyboard')).toBeTruthy();
    // Blurring the panel's words keeps the shot linked rather than copying them.
    fireEvent.blur(box);
    expect(onSave).toHaveBeenLastCalledWith('s1', { prompt: '' });
    fireEvent.click(screen.getByRole('button', { name: 'Render again' }));
    expect(onGenerateVideo).toHaveBeenCalledWith(scene, { card: expect.objectContaining({ prompt: 'She laces her skates' }) });
    rerender(card({ ...scene, prompt: 'She stands up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use storyboard direction' }));
    expect(onSave).toHaveBeenLastCalledWith('s1', { prompt: '' });
  });
});

describe('clip from the storyboard panel', () => {
  // Uniquely catches the tap animating the sketch instead of rendering the shot's real still first.
  it('renders the still first with the card lane to animate it, and keeps Still only one tap away', async () => {
    const scene = { sceneId: 's1', prompt: 'She laces her skates', panelId: 'p1', panelArt: 'panel.png', startSec: 0, endSec: 4, takes: [] };
    const onGenerateVideo = vi.fn();
    const onGenerateFrame = vi.fn();
    render(
        <SceneCard scene={scene} index={0} expanded project={{ id: 'mv-example', scenes: [scene] }} onEditLocal={() => {}} onSave={() => {}} onGenerateVideo={onGenerateVideo} onGenerateFrame={onGenerateFrame}
          lipSyncBackend="grok" falVideoSettings={{ backend: 'grok' }} />
    );
    expect(screen.queryByRole('button', { name: 'Render' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clip from storyboard' }));
    expect(onGenerateFrame).toHaveBeenLastCalledWith(scene, { thenClip: { backend: 'grok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Still only' }));
    expect(onGenerateFrame).toHaveBeenLastCalledWith(scene);
    expect(onGenerateVideo).not.toHaveBeenCalled();
  });
});

describe('start and end frames', () => {
  // Uniquely catches a frame's prompt, Render, Swap or takes hiding away from its picture, a frame reference not reaching the render, or the Render section not saying which renderer ends on the end frame.
  it('shows each frame with its prompt, Render, Swap and takes, and renders from a picked frame', async () => {
    const scene = { sceneId: 's1', prompt: 'She looks into the lens', referenceImageId: 'start.png', endImageId: 'end.png', endFramePrompt: 'Head thrown back', startSec: 0, endSec: 4,
      takes: [{ takeId: 't1', kind: 'image', assetId: 'start.png', status: 'selected' }, { takeId: 't2', kind: 'endImage', assetId: 'end.png', status: 'selected' }] };
    const onGenerateFrame = vi.fn();
    const onGenerateEndFrame = vi.fn();
    render(<SceneCard scene={scene} index={0} expanded onEditLocal={() => {}} onSave={() => {}} onGenerateFrame={onGenerateFrame} onGenerateEndFrame={onGenerateEndFrame}
      onPlacePoolItem={() => {}} falVideoSettings={{ backend: 'local' }} />);
    show('Frames');
    const pair = screen.getByRole('group', { name: 'Start and end frames' });
    expect(within(pair).getByLabelText('Reference frame prompt')).toBeTruthy();
    expect(within(pair).getByLabelText('End frame prompt').value).toBe('Head thrown back');
    // Each frame swaps from the unused stills on its own, without tapping it first.
    fireEvent.click(within(pair).getByRole('button', { name: 'Swap end frame from unused' }));
    expect(await screen.findByRole('dialog', { name: /^Swap end frame for/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(within(pair).getByRole('button', { name: 'Swap start frame from unused' })).toBeTruthy();

    // The end frame renders from the start frame unless another frame is picked; the start frame from its prompt.
    fireEvent.click(within(pair).getByRole('button', { name: 'New end frame take' }));
    expect(onGenerateEndFrame).toHaveBeenLastCalledWith(scene, { referenceImageId: 'start.png' });
    fireEvent.change(screen.getByLabelText('From', { selector: '#mv-scene-s1-start-from' }), { target: { value: 'end' } });
    fireEvent.click(within(pair).getByRole('button', { name: 'New frame take' }));
    expect(onGenerateFrame).toHaveBeenLastCalledWith(scene, { referenceImageId: 'end.png' });

    // Both frames' takes show at once, each under its own frame.
    expect(within(pair).getByRole('list', { name: /^Frame takes/ })).toBeTruthy();
    expect(within(pair).getByRole('list', { name: /^End frame takes/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear scene 1 end frame' })).toBeTruthy();

    show('Clip');
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

describe('low-res clip', () => {
  // Uniquely catches a grok 480p clip (720x416) reaching the final render with
  // no sign on the shot that it will be soft at 1080p (#14491).
  it('flags a clip under 720p and stays quiet for a 720p one', () => {
    const scene = { sceneId: 's1', prompt: 'Memory footage', referenceImageId: 'still.png', videoHistoryId: 'clip-1', startSec: 0, endSec: 4, takes: [] };
    const { container } = render(<SceneCard scene={scene} index={0} expanded onEditLocal={vi.fn()} onSave={vi.fn()} />);
    const video = container.querySelector('video');
    const load = (width, height) => {
      Object.defineProperty(video, 'duration', { value: 4, configurable: true });
      Object.defineProperty(video, 'videoWidth', { value: width, configurable: true });
      Object.defineProperty(video, 'videoHeight', { value: height, configurable: true });
      fireEvent.loadedMetadata(video);
    };
    load(1280, 720);
    expect(screen.queryByTestId('clip-low-res')).toBeNull();
    load(720, 416);
    expect(screen.getByTestId('clip-low-res').textContent).toContain('720×416, under 720p');
  });
});

describe('clip playback and coverage', () => {
  const scene = { sceneId: 's1', referenceImageId: 'still.png', videoHistoryId: 'clip-1', beatAligned: true,
    startSec: 1.234, endSec: 10, loop: false, takes: [] };
  const metadata = (video, sec, width = 768, height = 512) => {
    Object.defineProperties(video, {
      duration: { value: sec, configurable: true },
      videoWidth: { value: width, configurable: true },
      videoHeight: { value: height, configurable: true },
    });
    fireEvent.loadedMetadata(video);
  };
  const coverage = () => screen.queryByText(/Shot runs .* but its clip is/);

  it('clears both coverage warnings when the director holds the last frame, and restores them when cleared', () => {
    const onSave = vi.fn();
    function Harness() {
      const [current, setCurrent] = useState(scene);
      return <SceneCard scene={current} index={0} expanded
        onEditLocal={(_id, patch) => setCurrent((value) => ({ ...value, ...patch }))} onSave={onSave} />;
    }
    const { container } = render(<Harness />);
    metadata(container.querySelector('video'), 4);
    expect(coverage()).toBeTruthy();
    expect(screen.getByText('Clip too short')).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/Hold last frame/));
    expect(onSave).toHaveBeenLastCalledWith('s1', { holdLastFrame: true });
    expect(coverage()).toBeNull();
    expect(screen.queryByText('Clip too short')).toBeNull();
    fireEvent.click(screen.getByLabelText(/Hold last frame/));
    expect(coverage()).toBeTruthy();
    expect(screen.getByText('Clip too short')).toBeTruthy();
  });

  it('measures the selected performance take from its in-point and offers no ineffective loop repair', () => {
    const trimmed = { ...scene, startSec: 0, endSec: 3, loop: true, takes: [
      { kind: 'video', assetId: 'clip-1', shotInstruction: { shotMode: 'performance', edit: { inSec: 2, outSec: 4 } } },
    ] };
    const props = { index: 0, expanded: true, lipSyncBackend: 'fal', songDurationSec: 30, onEditLocal: vi.fn(), onSave: vi.fn() };
    const { container, rerender } = render(<SceneCard {...props} scene={trimmed} />);
    metadata(container.querySelector('video'), 4);
    rerender(<SceneCard {...props} scene={{ ...trimmed, shotMode: 'performance' }} />);
    expect(coverage().textContent).toContain('clip is 2.0s');
    expect(screen.getByText('Clip too short')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Loop clip' })).toBeNull();
  });

  // Catches coverage based on raw file length, a stale clip's measurement, or a trim
  // save that loses millisecond rounding; also pins metadata lifetime across hidden previews.
  it('measures adjusted playback, retains it while hidden, invalidates a replacement, and trims the shot', () => {
    const onSave = vi.fn();
    const onEditLocal = vi.fn();
    const props = { index: 0, expanded: true, layered: true, onSave, onEditLocal };
    const adjusted = { ...scene, speedFps: 8, offsetFrames: 12 };
    const { container, rerender } = render(<SceneCard {...props} scene={adjusted} />);
    expect(coverage()).toBeNull();
    metadata(container.querySelector('video'), NaN);
    expect(coverage()).toBeNull();
    metadata(container.querySelector('video'), 4.567);
    expect(container.querySelector('video').playbackRate).toBeCloseTo(32 / 24);
    // The render rounds the 3.05025s source window to 3.050s before display.
    expect(coverage().textContent).toContain('clip is 3.0s');
    expect(screen.getByLabelText('Not 16:9')).toBeTruthy();
    rerender(<SceneCard {...props} scene={{ ...adjusted, visualLayer: 'still' }} />);
    expect(container.querySelector('section[aria-label="Render"] video')).toBeNull();
    expect(coverage()).toBeTruthy();
    rerender(<SceneCard {...props} scene={{ ...adjusted, videoHistoryId: 'clip-2' }} />);
    expect(coverage()).toBeNull();
    expect(screen.queryByLabelText('Not 16:9')).toBeNull();
    metadata(container.querySelector('video'), 4.567);
    fireEvent.click(screen.getByRole('button', { name: 'Trim to clip' }));
    expect(onEditLocal).toHaveBeenLastCalledWith('s1', { endSec: 4.284 });
    expect(onSave).toHaveBeenLastCalledWith('s1', { endSec: 4.284 });
    // Negative offset delays the clip rather than cutting its beginning.
    rerender(<SceneCard {...props} scene={{ ...adjusted, videoHistoryId: 'clip-2', offsetFrames: -12 }} />);
    expect(coverage().textContent).toContain('clip is 3.9s');
  });

  // Catches a changed tolerance, legacy absent-loop scenes no longer looping,
  // or a reversed shot being offered a loop the renderer cannot use.
  it('warns only beyond the tolerance, preserves legacy looping, and treats reverse as one pass', () => {
    const onSave = vi.fn();
    const props = { index: 0, expanded: true, onSave, onEditLocal: vi.fn() };
    const bounded = { ...scene, startSec: 0, endSec: 4.25 };
    const { container, rerender } = render(<SceneCard {...props} scene={bounded} />);
    metadata(container.querySelector('video'), 4);
    expect(coverage()).toBeNull();
    rerender(<SceneCard {...props} scene={{ ...bounded, endSec: 4.251 }} />);
    expect(coverage()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Loop clip' }));
    expect(onSave).toHaveBeenLastCalledWith('s1', { loop: true });
    rerender(<SceneCard {...props} scene={{ ...bounded, endSec: 6, loop: undefined }} />);
    expect(coverage()).toBeNull();
    expect(screen.getByLabelText('Loop clip')).toBeChecked();
    rerender(<SceneCard {...props} scene={{ ...bounded, endSec: 6, loop: undefined, reverse: true }} />);
    expect(coverage()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Loop clip' })).toBeNull();
    expect(screen.getByLabelText('Loop clip')).toBeDisabled();
    expect(screen.getByText('Reversed in the player')).toBeTruthy();
  });

  // Catches reconstructed URLs replacing imported filenames, native controls
  // losing their playback ownership, or the lightbox opening before pause.
  it('keeps the resolved container and fallback, and pauses before opening the clip lightbox', () => {
    useVideoFileSrc.mockReturnValue({ src: '/data/videos/imported.webm' });
    const onOpenPreview = vi.fn();
    const props = { scene, index: 1, expanded: true, onEditLocal: vi.fn(), onSave: vi.fn(), onOpenPreview };
    const { container, rerender } = render(<SceneCard {...props} />);
    const video = container.querySelector('video');
    expect(video.getAttribute('src')).toBe('/data/videos/imported.webm');
    expect(video.controls).toBe(true);
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {
      expect(onOpenPreview).not.toHaveBeenCalled();
    });
    fireEvent.click(video);
    expect(onOpenPreview).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'View scene 2 clip full size' }));
    expect(pause).toHaveBeenCalledOnce();
    expect(onOpenPreview).toHaveBeenCalledWith('video:clip-1');
    useVideoFileSrc.mockReturnValue({ src: null });
    rerender(<SceneCard {...props} scene={{ ...scene, videoHistoryId: 'clip-2' }} />);
    expect(video.getAttribute('src')).toBe('/data/videos/clip-2.mp4');
  });

  // Catches source trim losing its scene argument or becoming enabled during
  // take/render work after the preview moves out of SceneCard.
  it('trims the source at the chosen frame and preserves every busy gate', async () => {
    const onTrimClip = vi.fn();
    const props = { scene, index: 0, expanded: true, onEditLocal: vi.fn(), onSave: vi.fn(), onTrimClip };
    const { container, rerender } = render(<SceneCard {...props} />);
    const video = container.querySelector('video');
    vi.spyOn(video, 'pause').mockImplementation(() => {});
    expect(screen.getByRole('button', { name: 'Start clip here' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start clip here' }));
    expect(onTrimClip).toHaveBeenCalledWith(scene, 1 / 24);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start clip here' })).toBeEnabled());
    rerender(<SceneCard {...props} takeBusy />);
    expect(screen.getByRole('button', { name: 'Next frame' })).toBeDisabled();
    rerender(<SceneCard {...props} generatingVideo />);
    expect(screen.getByRole('button', { name: 'Next frame' })).toBeDisabled();
    rerender(<SceneCard {...props} />);
    expect(screen.getByRole('button', { name: 'Next frame' })).toBeEnabled();
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

// Uniquely catches a Whole sung line take priced or sent for the shot alone, and the
// render target naming the project's cutaway model for a lip-sync shot.
describe('Whole sung line', () => {
  it('re-plans and prices the take over the full line, sends it with Render, and names the lip-sync model', () => {
    const scene = { sceneId: 's19', prompt: '', shotMode: 'performance', referenceImageId: 'start.png', startSec: 40.5, endSec: 42.8,
      takes: [{ takeId: 't1', kind: 'image', assetId: 'start.png', status: 'selected' }] };
    const project = { id: 'p1', lyricCues: [{ text: 'the whole line', startSec: 39.2, endSec: 45.6 }] };
    const onGenerateVideo = vi.fn();
    render(<SceneCard scene={scene} project={project} index={0} expanded onEditLocal={() => {}} onSave={() => {}} onGenerateVideo={onGenerateVideo}
      lipSyncBackend="fal" songDurationSec={60} falVideoSettings={{ backend: 'fal' }} />);
    expect(screen.getByLabelText('Render on').textContent).toContain('Project setting · fal.ai · MiniMax H3 Max lip-sync');
    expect(screen.getByLabelText('Render on').textContent).not.toContain('Hailuo');
    const plan = () => screen.getByTestId('performance-plan').textContent;
    expect(plan()).toContain('est. $0.81 (5.05s at 1080P)');
    fireEvent.click(within(screen.getByTestId('render-inputs')).getByLabelText('Whole sung line'));
    expect(within(screen.getByTestId('render-inputs')).getByText('· Song 0:39.2–0:45.6')).toBeTruthy();
    expect(plan()).toContain('shot starts 1.30s into the take');
    expect(plan()).toContain('est. $1.02 (6.4s at 1080P)');
    fireEvent.click(screen.getByRole('button', { name: 'Render' }));
    expect(onGenerateVideo).toHaveBeenCalledWith(scene, expect.objectContaining({ card: expect.objectContaining({ wholeLine: true }) }));
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
    const out = screen.getByLabelText('Effect out');
    fireEvent.change(out, { target: { value: 'vhs-glitch' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { transitionOut: 'vhs-glitch' });
    expect(out.value).toBe('vhs-glitch');
    fireEvent.change(out, { target: { value: '' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { transitionOut: null });
    expect(screen.getByLabelText('Effect in').value).toBe('');
  });
});

// Uniquely catches the in-shot glitch control saving the wrong shape, losing a
// slider move, or leaving an empty list behind when the last glitch goes.
describe('In-shot glitches', () => {
  it('adds a color block glitch halfway through, moves it on release and removes it', () => {
    const onSave = vi.fn();
    function Harness() {
      const [scene, setScene] = useState({ sceneId: 's1', startSec: 10, endSec: 14, takes: [] });
      return <SceneCard scene={scene} index={0} onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /Add effect/ }));
    expect(onSave).toHaveBeenLastCalledWith('s1', { glitches: [{ atSec: 2, style: 'color-block' }] });
    const slider = screen.getByLabelText(/^at /);
    fireEvent.change(slider, { target: { value: '2.5' } });
    fireEvent.pointerUp(slider);
    expect(onSave).toHaveBeenLastCalledWith('s1', { glitches: [{ atSec: 2.5, style: 'color-block' }] });
    fireEvent.change(screen.getByLabelText('Effect 1 length'), { target: { value: '0.5' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { glitches: [{ atSec: 2.5, style: 'color-block', lengthSec: 0.5 }] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove effect 1' }));
    expect(onSave).toHaveBeenLastCalledWith('s1', { glitches: null });
  });

  // Uniquely catches strength, repeats or a leak's color/edge saving a default
  // as a stored value (an old effect would then read as changed) or not at all.
  it('sets strength, repeats and a leak\'s color and edge, storing defaults as absent fields', () => {
    const onSave = vi.fn();
    function Harness() {
      const [scene, setScene] = useState({ sceneId: 's1', startSec: 0, endSec: 12, takes: [], glitches: [{ atSec: 1, style: 'gate-jump' }] });
      return <SceneCard scene={scene} index={0} onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
    }
    render(<Harness />);
    const strength = screen.getByLabelText(/Effect 1 strength/);
    fireEvent.change(strength, { target: { value: '0.5' } });
    fireEvent.pointerUp(strength);
    expect(onSave).toHaveBeenLastCalledWith('s1', { glitches: [{ atSec: 1, style: 'gate-jump', strength: 0.5 }] });
    fireEvent.change(screen.getByLabelText('Effect 1 repeats'), { target: { value: '8' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { glitches: [{ atSec: 1, style: 'gate-jump', strength: 0.5, count: 8, everySec: 1 }] });
    fireEvent.change(screen.getByLabelText('Effect 1 repeats every'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('Effect 1 repeats'), { target: { value: '' } });
    fireEvent.change(strength, { target: { value: '1' } });
    fireEvent.pointerUp(strength);
    expect(onSave).toHaveBeenLastCalledWith('s1', { glitches: [{ atSec: 1, style: 'gate-jump' }] });
    // Only a light leak offers a color and an edge.
    expect(screen.queryByLabelText('Effect 1 leak edge')).toBeNull();
    fireEvent.change(screen.getByLabelText('Effect 1 style'), { target: { value: 'light-leak' } });
    fireEvent.change(screen.getByLabelText('Effect 1 leak edge'), { target: { value: 'bottom' } });
    const color = screen.getByLabelText('Effect 1 leak color');
    fireEvent.change(color, { target: { value: '#00ff00' } });
    fireEvent.blur(color);
    expect(onSave).toHaveBeenLastCalledWith('s1', { glitches: [{ atSec: 1, style: 'light-leak', edge: 'bottom', color: '#00ff00' }] });
  });

  it('adds the home-movie events: a half-strength gate jump through the shot and one soft leak, no shutter', () => {
    const onSave = vi.fn();
    render(<SceneCard scene={{ sceneId: 's1', startSec: 0, endSec: 12, takes: [] }} index={0} onEditLocal={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: /Home-movie events/ }));
    const { glitches } = onSave.mock.lastCall[1];
    expect(glitches).toEqual([
      { atSec: 0.5, style: 'gate-jump', strength: 0.5, count: 4, everySec: 3 },
      { atSec: 7.208, style: 'light-leak', strength: 0.6, color: '#ffb36b', edge: 'right' },
    ]);
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

describe('clip speed and offset by hand', () => {
  function Harness({ initial, onSave }) {
    const [scene, setScene] = useState(initial);
    return <SceneCard scene={scene} index={0} expanded onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
  }

  // Uniquely catches the steppers saving something other than whole fps/frames, a zero not clearing,
  // or the inline clip ignoring the speed it will render at.
  it('steps speed in fps and offset in frames, saves them as shot settings, and plays the clip at that speed', () => {
    const onSave = vi.fn();
    const { container } = render(<Harness initial={{ sceneId: 's1', prompt: 'she dances', videoHistoryId: 'clip-1', startSec: 0, endSec: 4, takes: [] }} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Play the clip one fps faster' }));
    fireEvent.click(screen.getByRole('button', { name: 'Play the clip one fps faster' }));
    expect(onSave).toHaveBeenLastCalledWith('s1', { speedFps: 2 });
    expect(screen.getByText('26 fps (1.08×)')).toBeTruthy();
    expect(container.querySelector('video').playbackRate).toBeCloseTo(26 / 24);
    fireEvent.click(screen.getByRole('button', { name: 'Start the clip one frame later' }));
    expect(onSave).toHaveBeenLastCalledWith('s1', { offsetFrames: -1 });
    expect(screen.getByText('clip starts 1 frame later')).toBeTruthy();
    const offset = screen.getByLabelText('Offset');
    fireEvent.change(offset, { target: { value: '0' } });
    fireEvent.blur(offset);
    expect(onSave).toHaveBeenLastCalledWith('s1', { offsetFrames: null });
    expect(screen.getByText('on the cut')).toBeTruthy();
    // An emptied field is no change, not zero: the speed stays at +2.
    const speed = screen.getByLabelText('Speed');
    const saves = onSave.mock.calls.length;
    fireEvent.change(speed, { target: { value: '' } });
    fireEvent.blur(speed);
    expect(onSave).toHaveBeenCalledTimes(saves);
    expect(speed.value).toBe('2');
  });

  it('remains editable for a video with a legacy lock', async () => {
    render(
        <SceneCard scene={{ sceneId: 's1', videoHistoryId: 'clip-1', startSec: 0, endSec: 4, speedFps: 2, takes: [] }} index={0} expanded onEditLocal={() => {}} onSave={() => {}} />
    );
    expect(screen.getByRole('button', { name: 'Play the clip one fps faster' }).disabled).toBe(false);
    expect(screen.getByLabelText('Speed').value).toBe('2');
  });
});

// Uniquely catches the cut effect picker saving the wrong shape, losing its
// settings on Cut, or ignoring the transition the storyboard plans.
describe('How a shot hands over to the next', () => {
  function Harness({ initial = {}, project = null, isLast = false, onSave }) {
    const [scene, setScene] = useState({ sceneId: 's1', startSec: 0, endSec: 4, takes: [], ...initial });
    return <SceneCard scene={scene} index={0} isLast={isLast} project={project} onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
  }

  it('picks an effect with defaults, changes its settings and keeps them on Cut', () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    const picker = screen.getByLabelText('Into next shot');
    fireEvent.change(picker, { target: { value: 'beat-toggle' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { cutEffect: { style: 'beat-toggle', enabled: true, overlapSec: 1, rate: 'beat' } });
    fireEvent.change(screen.getByLabelText('Beat toggle speed'), { target: { value: 'half' } });
    fireEvent.change(screen.getByLabelText('Into next shot length'), { target: { value: '2' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { cutEffect: { style: 'beat-toggle', enabled: true, overlapSec: 2, rate: 'half' } });
    fireEvent.change(picker, { target: { value: 'dissolve' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { cutEffect: { style: 'dissolve', enabled: true, overlapSec: 2, rate: 'half' } });
    expect(screen.queryByLabelText('Beat toggle speed')).toBeNull();
    fireEvent.change(picker, { target: { value: '' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { cutEffect: { style: 'dissolve', enabled: false, overlapSec: 2, rate: 'half' } });
    expect(picker.value).toBe('');
  });

  it('shows the storyboard\'s planned Dissolve until a pick, and offers only a fade to black on the last shot', () => {
    const onSave = vi.fn();
    const project = { productionReview: { draft: { storyboard: [{ sceneId: 's1', transition: 'Slow dissolve into the dream' }] } } };
    const { unmount } = render(<Harness project={project} onSave={onSave} />);
    expect(screen.getByLabelText('Into next shot').value).toBe('dissolve');
    fireEvent.change(screen.getByLabelText('Into next shot'), { target: { value: '' } });
    expect(onSave).toHaveBeenLastCalledWith('s1', { cutEffect: { style: 'dissolve', enabled: false, overlapSec: 1, rate: 'beat' } });
    unmount();
    render(<Harness isLast onSave={onSave} />);
    const end = screen.getByLabelText('At the end');
    expect([...end.options].map((o) => o.text)).toEqual(['Cut', 'Fade to black']);
  });
});

describe('finalizing a shot\'s takes', () => {
  const take = (takeId, kind, assetId, status = 'candidate') => ({ takeId, kind, assetId, status, source: 'generated', note: null });
  const scene = { sceneId: 's1', referenceImageId: 'a.png', videoHistoryId: 'v1', startSec: 0, endSec: 4,
    takes: [take('t1', 'image', 'a.png'), take('t2', 'image', 'b.png'), take('t3', 'video', 'v1'), take('t4', 'video', 'v2'), take('t5', 'video', 'v3', 'rejected')] };

  // Uniquely catches the take in use reading like any other, and Reject unused firing without its confirm.
  it('badges the take in use, and rejects the unused ones after one confirm', () => {
    const onRejectUnusedTakes = vi.fn();
    render(<SceneCard scene={scene} index={0} expanded onEditLocal={() => {}} onSave={() => {}} onRejectUnusedTakes={onRejectUnusedTakes} />);
    expect(screen.getAllByText('In use').length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: 'Reject unused (2)' }));
    expect(onRejectUnusedTakes).not.toHaveBeenCalled();
    expect(screen.getByText('Reject 2 unused takes from this shot? Other shots can still use them.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reject 2' }));
    expect(onRejectUnusedTakes).toHaveBeenCalledWith(scene);
    expect(screen.queryByRole('button', { name: 'Reject 2' })).toBeNull();
  });

  it('offers nothing when every take is in use or rejected', () => {
    render(<SceneCard scene={{ ...scene, takes: scene.takes.filter((t) => ['t1', 't3', 't5'].includes(t.takeId)) }} index={0} expanded
      onEditLocal={() => {}} onSave={() => {}} onRejectUnusedTakes={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Reject unused/ })).toBeNull();
  });
});

describe('reverse a shot\'s clip', () => {
  // Uniquely catches Reverse saving the wrong shape, staying on a lip-sync shot, or leaving Loop clip on.
  it('saves Reverse as a shot setting, turns off looping, and is not offered on a lip-sync shot', () => {
    const onSave = vi.fn();
    function Harness({ initial }) {
      const [scene, setScene] = useState(initial);
      return <SceneCard scene={scene} index={0} expanded onEditLocal={(_id, patch) => setScene((current) => ({ ...current, ...patch }))} onSave={onSave} />;
    }
    const { unmount } = render(<Harness initial={{ sceneId: 's1', videoHistoryId: 'clip-1', startSec: 0, endSec: 4, takes: [] }} />);
    fireEvent.click(screen.getByLabelText(/^Reverse/));
    expect(onSave).toHaveBeenLastCalledWith('s1', { reverse: true });
    expect(screen.getByText('Reversed in the player')).toBeTruthy();
    expect(screen.getByLabelText('Loop clip').disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/^Reverse/));
    expect(onSave).toHaveBeenLastCalledWith('s1', { reverse: null });
    unmount();
    render(<Harness initial={{ sceneId: 's2', videoHistoryId: 'clip-1', shotMode: 'performance', startSec: 0, endSec: 4, takes: [] }} />);
    expect(screen.queryByLabelText(/^Reverse/)).toBeNull();
  });
});

describe('shot timing in frames', () => {
  // Uniquely catches the shot's times shown without the 24 fps frame numbers the director counts in.
  it('shows frame numbers beside the header times and the Start and End fields', () => {
    const scene = { sceneId: 's1', startSec: 50.25, endSec: 52.125, takes: [] };
    render(<SceneCard scene={scene} index={0} onEditLocal={() => {}} onSave={() => {}} />);
    expect(screen.getByText(/1\.88s · .* · fr 1206–1251/)).toBeTruthy();
    expect(screen.getByText('fr 1206')).toBeTruthy();
    expect(screen.getByText('fr 1251')).toBeTruthy();
  });
});

describe('shot editor groups', () => {
  // Uniquely catches a group header not saying what is set, or the cold open's Sound group showing on a shot in the song.
  it('names what each group sets and offers Sound only before the song', async () => {
    // On a phone the groups start closed, each header naming what it sets.
    vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: false });
    const props = { index: 0, expanded: true, onEditLocal: () => {}, onSave: () => {} };
    const header = (testId) => screen.getByTestId(testId).querySelector('button').textContent;
    const { unmount } = render(<SceneCard {...props} scene={{ sceneId: 's1', preMusic: { durationSec: 3 }, takes: [], transitionOut: 'vhs-tracking' }} />);
    await act(async () => {});
    expect(header('shot-group-timing')).toMatch(/before the song · 3\.00s/);
    expect(header('shot-group-sound')).toMatch(/silen/i);
    expect(header('shot-group-effects')).not.toMatch(/none/);
    expect(header('shot-group-type')).toMatch(/Cutaway/);
    unmount();
    render(<SceneCard {...props} scene={{ sceneId: 's2', startSec: 1, endSec: 3, takes: [] }} />);
    expect(header('shot-group-timing')).toMatch(/1\.00–3\.00s/);
    expect(screen.queryByTestId('shot-group-sound')).toBeNull();
    expect(header('shot-group-effects')).toMatch(/none/);
    window.matchMedia.mockRestore();
  });
});

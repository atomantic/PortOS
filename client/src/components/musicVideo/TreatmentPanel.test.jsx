/**
 * Treatment panel (#8980) rendered with the real useMusicVideoTreatment hook
 * over a mocked API: the Apply review keeps hand-edited prompts unless the
 * director ticks them (and then sends the reviewed fingerprint), a stale
 * treatment blocks Apply until it is rebased, compile is an explicit action,
 * and quick successive edits each carry the revision the previous one returned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, renderHook, screen, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoProject: vi.fn(),
  updateMusicVideoTreatment: vi.fn(),
  compileMusicVideoTreatment: vi.fn(),
  previewMusicVideoTreatmentApply: vi.fn(),
  applyMusicVideoTreatment: vi.fn(),
  reviewMusicVideoTreatmentProof: vi.fn(),
}));
vi.mock('../../hooks/useProviderModels.js', () => ({
  default: () => ({
    providers: [], selectedProviderId: '', selectedModel: '', availableModels: [],
    setSelectedProviderId: vi.fn(), setSelectedModel: vi.fn(),
  }),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

import * as api from '../../services/apiMusicVideo.js';
import useMusicVideoTreatment from '../../hooks/useMusicVideoTreatment.js';
import TreatmentPanel from './TreatmentPanel.jsx';

const TREATMENT = {
  version: 1,
  revision: 3,
  brief: { audience: '', destination: '', aspectRatio: null, emotion: '', premise: '', hookObjective: '', mustHave: '', avoid: '', referenceNotes: [] },
  arc: {
    rationale: 'Example arc',
    lyricInterpretation: null,
    beats: [{ id: 'beat-1', role: 'opening', sectionIndexes: [0], label: 'Intro', startSec: 0, endSec: 8, energy: 0.3, objective: 'Hook', rationale: '' }],
    motifs: [{ id: 'm1', name: 'Red umbrella', description: '', evolution: '', rationale: '' }],
    balance: { performance: 20, cutaway: 60, graphic: 20, rationale: '' },
  },
  shotDirections: [],
  proofs: [],
  capabilityGaps: [{ id: 'lip-sync', detail: 'No source-audio lip-sync is available.' }],
  basis: {},
  compiledAt: '2026-01-01T00:00:00.000Z',
  compiledWith: { source: 'deterministic', providerId: null, model: null },
  appliedRevision: null,
  appliedAt: null,
};
const PROJECT = {
  id: 'mv-1', name: 'Example', audioAnalysis: { sections: [] }, treatment: TREATMENT,
  scenes: [
    { sceneId: 's1', label: 'Intro · 1/2', prompt: 'my own motion', framePrompt: 'my own frame', referenceImageId: 'picked.png' },
    { sceneId: 's2', label: 'Intro · 2/2', prompt: '', framePrompt: null },
  ],
};
const PREVIEW = {
  revision: 3,
  stale: [],
  blocked: false,
  scenes: [
    { sceneId: 's1', label: 'Intro · 1/2', directionChanged: true, prompt: 'manual', fields: { framePrompt: 'manual', prompt: 'manual' }, promptFingerprint: 'fp-s1', current: { framePrompt: 'my own frame', prompt: 'my own motion' }, suggested: { framePrompt: 'train window', prompt: 'push in' }, keepsSelection: true },
    { sceneId: 's2', label: 'Intro · 2/2', directionChanged: true, prompt: 'fill', fields: { framePrompt: 'fill', prompt: 'fill' }, promptFingerprint: 'fp-s2', current: { framePrompt: '', prompt: '' }, suggested: { framePrompt: 'rain', prompt: 'drift' }, keepsSelection: false, renderFields: { shotMode: 'performance' } },
  ],
  missingSceneIds: [],
  unmappedSceneIds: [],
  textCueCandidates: 0,
};

function Harness({ initial = PROJECT }) {
  const [project, setProject] = useState(initial);
  const treatment = useMusicVideoTreatment({
    project,
    onProjectPatch: (_id, patch) => setProject((p) => ({ ...p, ...patch })),
    replaceProject: setProject,
  });
  return (
    <>
      <TreatmentPanel project={project} treatment={treatment} />
      <output data-testid="applied">{String(project.treatment?.appliedRevision ?? 'none')}</output>
    </>
  );
}

beforeEach(() => { vi.clearAllMocks(); });

describe('TreatmentPanel apply review', () => {
  it('keeps a hand-edited prompt by default and overwrites it only with the reviewed fingerprint', async () => {
    api.previewMusicVideoTreatmentApply.mockResolvedValue(PREVIEW);
    api.applyMusicVideoTreatment.mockImplementation(async () => ({
      project: { ...PROJECT, treatment: { ...TREATMENT, appliedRevision: 3 } },
      result: { directed: 2, promptsWritten: ['s1', 's2'], promptsKept: [], conflicted: [], textCuesAdded: 0 },
    }));
    render(<Harness />);
    fireEvent.click(screen.getByText('Review changes before applying'));
    expect(await screen.findByText(/2 of 2 scenes would change/)).toBeTruthy();
    expect(screen.getByText(/your edited prompts are kept/)).toBeTruthy();
    expect(screen.getByText(/selected takes kept/)).toBeTruthy();
    expect(screen.getByText(/becomes a lip-synced performance shot/)).toBeTruthy();
    // Both hand-edited fields the tick would replace are shown, not just one.
    expect(screen.getByText('Frame prompt — yours: my own frame')).toBeTruthy();
    expect(screen.getByText('Motion prompt — treatment: push in')).toBeTruthy();

    fireEvent.click(screen.getByLabelText(/Use the treatment's prompts for this scene/));
    fireEvent.click(screen.getByText('Apply treatment'));
    await waitFor(() => expect(api.applyMusicVideoTreatment).toHaveBeenCalledWith(
      'mv-1',
      { revision: 3, overwrite: [{ sceneId: 's1', promptFingerprint: 'fp-s1' }], addTextCues: false },
      { silent: true },
    ));
    await waitFor(() => expect(screen.getByTestId('applied').textContent).toBe('3'));
  });

  it('blocks Apply on a stale input until the director keeps the treatment for the current inputs', async () => {
    api.previewMusicVideoTreatmentApply
      .mockResolvedValueOnce({ ...PREVIEW, blocked: true, stale: [{ input: 'visualSpec', blocking: true, message: 'The visual spec changed since this treatment was compiled.' }] })
      .mockResolvedValueOnce(PREVIEW);
    api.updateMusicVideoTreatment.mockResolvedValue({ treatment: { ...TREATMENT, revision: 4 } });
    render(<Harness />);
    fireEvent.click(screen.getByText('Review changes before applying'));
    expect(await screen.findByText(/visual spec changed/)).toBeTruthy();
    expect(screen.getByText('Apply treatment').closest('button').disabled).toBe(true);

    fireEvent.click(screen.getByText('Keep this treatment for the current inputs'));
    await waitFor(() => expect(api.updateMusicVideoTreatment).toHaveBeenCalledWith('mv-1', { rebase: true, baseRevision: 3 }, { silent: true }));
    await waitFor(() => expect(screen.getByText('Apply treatment').closest('button').disabled).toBe(false));
    expect(api.applyMusicVideoTreatment).not.toHaveBeenCalled();
  });
});

describe('useMusicVideoTreatment across a project switch', () => {
  it('never hands a write still in flight for one project its revision to the next project', async () => {
    let resolveA;
    api.updateMusicVideoTreatment
      .mockImplementationOnce(() => new Promise((resolve) => { resolveA = resolve; }))
      .mockResolvedValueOnce({ treatment: { ...TREATMENT, revision: 8 } });
    const projectA = { ...PROJECT, id: 'mv-a', treatment: { ...TREATMENT, revision: 3 } };
    const projectB = { ...PROJECT, id: 'mv-b', treatment: { ...TREATMENT, revision: 7 } };
    const { result, rerender } = renderHook(({ project }) => useMusicVideoTreatment({ project, onProjectPatch: vi.fn(), replaceProject: vi.fn() }), {
      initialProps: { project: projectA },
    });
    let pendingA;
    act(() => { pendingA = result.current.save({ brief: { audience: 'a' } }); });
    await waitFor(() => expect(api.updateMusicVideoTreatment).toHaveBeenCalledTimes(1));
    rerender({ project: projectB });
    await act(async () => { resolveA({ treatment: { ...TREATMENT, revision: 9 } }); await pendingA; });
    await act(async () => { await result.current.save({ brief: { audience: 'b' } }); });
    expect(api.updateMusicVideoTreatment.mock.calls.map(([id, body]) => [id, body.baseRevision])).toEqual([
      ['mv-a', 3],
      ['mv-b', 7],
    ]);
  });
});

describe('TreatmentPanel edits and compile', () => {
  it('compiles only on an explicit click, and not before the song is analyzed', async () => {
    api.compileMusicVideoTreatment.mockResolvedValue({ treatment: { ...TREATMENT, revision: 4 }, aiUsed: false, aiSkippedReason: 'not-requested' });
    const { unmount } = render(<Harness initial={{ ...PROJECT, audioAnalysis: null }} />);
    expect(screen.getByText('Draft without AI').closest('button').disabled).toBe(true);
    unmount();

    render(<Harness />);
    expect(api.compileMusicVideoTreatment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Draft without AI'));
    await waitFor(() => expect(api.compileMusicVideoTreatment).toHaveBeenCalledWith('mv-1', { baseRevision: 3, useAi: false }, { silent: true }));
  });

  it('re-sends only the editable fields of existing reference notes', async () => {
    api.updateMusicVideoTreatment.mockResolvedValue({ treatment: { ...TREATMENT, revision: 4 } });
    const stored = { id: 'mvn-1', note: 'grainy 16mm', url: 'https://example.com/a', source: 'user', addedAt: '2026-01-01T00:00:00.000Z' };
    render(<Harness initial={{ ...PROJECT, treatment: { ...TREATMENT, brief: { ...TREATMENT.brief, referenceNotes: [stored] } } }} />);
    fireEvent.change(screen.getByLabelText('Reference note'), { target: { value: 'hand-drawn overlays' } });
    fireEvent.click(screen.getByText('Add note'));
    await waitFor(() => expect(api.updateMusicVideoTreatment).toHaveBeenCalledTimes(1));
    expect(api.updateMusicVideoTreatment.mock.calls[0][1].brief.referenceNotes).toEqual([
      { id: 'mvn-1', note: 'grainy 16mm', url: 'https://example.com/a' },
      { note: 'hand-drawn overlays', url: null },
    ]);
  });

  it('serializes quick brief edits so each carries the revision the previous save returned', async () => {
    let revision = 3;
    api.updateMusicVideoTreatment.mockImplementation(async (_id, body) => {
      revision += 1;
      return { treatment: { ...TREATMENT, revision, brief: { ...TREATMENT.brief, ...body.brief } } };
    });
    render(<Harness />);
    const audience = screen.getByLabelText('Audience');
    const emotion = screen.getByLabelText('Desired emotion');
    await act(async () => {
      fireEvent.change(audience, { target: { value: 'night owls' } });
      fireEvent.blur(audience);
      fireEvent.change(emotion, { target: { value: 'restless hope' } });
      fireEvent.blur(emotion);
    });
    await waitFor(() => expect(api.updateMusicVideoTreatment).toHaveBeenCalledTimes(2));
    expect(api.updateMusicVideoTreatment.mock.calls.map(([, body]) => [body.baseRevision, body.brief])).toEqual([
      [3, { audience: 'night owls' }],
      [4, { emotion: 'restless hope' }],
    ]);
  });
});

it('shows union totals and explicit exceptions before Apply, and pins a director-selected medium', async () => {
  const planned = {
    ...PROJECT,
    productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 20 },
    audioAnalysis: { durationSec: 100, sections: [] },
    scenes: [
      { ...PROJECT.scenes[0], startSec: 0, endSec: 15 },
      { ...PROJECT.scenes[1], startSec: 10, endSec: 20 },
    ],
    treatment: {
      ...TREATMENT,
      shotDirections: ['s1', 's2'].map((sceneId) => ({
        sceneId, medium: 'generated-footage', mediumRationale: 'Visible payoff', mediumPinned: false,
        mode: 'cutaway', route: 'generated', typographyRole: 'none', negativeSpace: 'none',
      })),
    },
  };
  api.updateMusicVideoTreatment.mockImplementation(async (_id, patch) => ({
    treatment: {
      ...planned.treatment, revision: 4,
      shotDirections: planned.treatment.shotDirections.map((d) => d.sceneId === 's1' ? { ...d, ...patch.shotDirections[0] } : d),
    },
  }));
  render(<Harness initial={planned} />);
  expect(screen.getByText(/generated video 20 \/ 20 seconds/)).toBeTruthy();
  expect(screen.getByText('Generated-footage exceptions')).toBeTruthy();
  expect(screen.getByText(/Planning only: Apply saves direction/)).toBeTruthy();
  expect(api.applyMusicVideoTreatment).not.toHaveBeenCalled();
  fireEvent.change(screen.getAllByLabelText('Planned medium')[0], { target: { value: 'still' } });
  await waitFor(() => expect(api.updateMusicVideoTreatment).toHaveBeenCalledWith(
    'mv-1',
    { baseRevision: 3, shotDirections: [{ sceneId: 's1', medium: 'still', mediumPinned: true }] },
    { silent: true },
  ));
  await waitFor(() => expect(screen.getAllByLabelText('Keep medium on recompile')[0].checked).toBe(true));
  expect(screen.getByText(/generated video 10 \/ 20 seconds/)).toBeTruthy();
});

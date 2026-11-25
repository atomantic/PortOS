import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const musicVideoSequenceTake = vi.fn();
vi.mock('../../services/apiMusicVideo.js', () => ({ musicVideoSequenceTake: (...args) => musicVideoSequenceTake(...args) }));
vi.mock('../ui/Toast');

const { default: SequenceTakePanel } = await import('./SequenceTakePanel.jsx');

const H3 = 'minimax/h3-max/reference-to-video';
const project = {
  id: 'p1', videoSettings: { falModelId: H3 },
  scenes: [0, 1, 2, 3].map((n) => ({ sceneId: `s${n}`, label: `Shot ${n}`, order: n, startSec: n * 2, endSec: n * 2 + 2, referenceImageId: `f${n}.png` })),
};
const shotName = (scene) => scene.label;
const planFor = (body) => ({
  dryRun: true, modelId: H3, modelLabel: 'MiniMax H3 Max (reference)', sceneIds: body.sceneIds, runSec: 4, seconds: 5, resolution: '768P',
  estimatedCostUsd: 0.4, prompt: 'Shot 1 (0-2.5s): Image 1. a\nHard cut.\nShot 2 (2.5-5s): Image 2. b', promptOverride: false,
  promptAdditions: [{ id: 'sequence-take', label: 'One take, hard cuts', text: 'One take of 2 shots' }],
  references: [{ kind: 'frame' }, { kind: 'frame' }], omittedReferences: 0, maxReferences: 9,
});

beforeEach(() => { musicVideoSequenceTake.mockReset(); });

const open = () => fireEvent.click(screen.getByText('Render shots as one take'));

// Uniquely catches a render offered before its price is shown, a stale preview
// surviving an edit to the run, and a render sending a different run than priced.
it('shows the price before the render, drops the preview when the run changes, and renders the priced run', async () => {
  musicVideoSequenceTake.mockImplementation(async (_id, body) => (body.dryRun ? planFor(body) : { ...planFor(body), dryRun: false, jobId: 'j1' }));
  render(<SequenceTakePanel project={project} shotName={shotName} />);
  open();
  expect(screen.queryByRole('button', { name: /Render as one take/ })).toBeNull();
  expect(screen.getByText('Covers: Shot 0 → Shot 1')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Shots'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview prompt and price' }));
  await screen.findByTestId('sequence-take-plan');
  expect(musicVideoSequenceTake).toHaveBeenLastCalledWith('p1', { sceneIds: ['s0', 's1', 's2'], modelId: H3, dryRun: true }, { silent: true });
  expect(screen.getByTestId('sequence-take-plan').textContent).toContain('est. $0.40');

  fireEvent.change(screen.getByLabelText('From shot'), { target: { value: 's1' } });
  expect(screen.queryByTestId('sequence-take-plan')).toBeNull();
  expect(screen.queryByRole('button', { name: /Render as one take/ })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Preview prompt and price' }));
  const renderButton = await screen.findByRole('button', { name: 'Render as one take ($0.40)' });
  fireEvent.click(renderButton);
  await waitFor(() => expect(musicVideoSequenceTake).toHaveBeenCalledTimes(3));
  expect(musicVideoSequenceTake).toHaveBeenLastCalledWith('p1', { sceneIds: ['s1', 's2'], modelId: H3, dryRun: false }, { silent: true });
  await waitFor(() => expect(screen.queryByTestId('sequence-take-plan')).toBeNull());
});

it('ignores a preview that answers after the run was edited, and shows a refusal inline', async () => {
  let answer;
  musicVideoSequenceTake.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
  render(<SequenceTakePanel project={project} shotName={shotName} />);
  open();
  fireEvent.click(screen.getByRole('button', { name: 'Preview prompt and price' }));
  fireEvent.change(screen.getByLabelText(/^Prompt/), { target: { value: 'My own prompt' } });
  await act(async () => answer(planFor({ sceneIds: ['s0', 's1'] })));
  expect(screen.queryByTestId('sequence-take-plan')).toBeNull();

  musicVideoSequenceTake.mockRejectedValueOnce(new Error('These shots run 20s; MiniMax H3 Max (reference) renders at most 15s in one take.'));
  fireEvent.click(screen.getByRole('button', { name: 'Preview prompt and price' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/at most 15s/);
  expect(musicVideoSequenceTake).toHaveBeenLastCalledWith('p1', { sceneIds: ['s0', 's1'], modelId: H3, prompt: 'My own prompt', dryRun: true }, { silent: true });
});

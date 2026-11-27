import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { finalApprovalPatch } from '../../../../server/lib/musicVideo/musicVideoFinalApproval.js';

const upgradeMusicVideoShots = vi.fn();
vi.mock('../../services/apiMusicVideo.js', () => ({ upgradeMusicVideoShots: (...args) => upgradeMusicVideoShots(...args) }));
vi.mock('../ui/Toast');
vi.mock('../media/RealesrganInstallButton', () => ({ default: () => <button type="button">Install Real-ESRGAN</button> }));

const { default: FinalUpgradePanel } = await import('./FinalUpgradePanel.jsx');

const shot = (n, tier = 'draft') => ({
  sceneId: `s${n}`, label: `Shot ${n}`, startSec: n * 2, endSec: n * 2 + 2, prompt: `shot ${n}`, referenceImageId: `f${n}.png`,
  videoHistoryId: `v${n}`, takes: [{ takeId: `t${n}`, kind: 'video', assetId: `v${n}`, tier, status: 'candidate' }],
});
const approve = (scene) => ({ ...scene, ...finalApprovalPatch(scene, true).patch });
const shotName = (scene) => scene.label;

const planFor = (body) => ({
  dryRun: true, method: body.method, totalCostUsd: body.method === 'upscale' ? 0 : 1.5,
  shots: [
    { sceneId: 's0', status: 'ready', method: body.method, costUsd: body.method === 'upscale' ? 0 : 1.5, ...(body.method === 'rerender' ? { resolution: '1080p' } : {}) },
  ],
});

beforeEach(() => { upgradeMusicVideoShots.mockReset(); });

const openPanel = () => fireEvent.click(screen.getByRole('button', { name: /Upgrade drafts to final/ }));

// Uniquely catches an upgrade offered before its price arrives, a price that answers the wrong
// method, and a run that is not the plan the director was shown.
it('prices each method with a dry run before the upgrade runs, then reports each shot', async () => {
  upgradeMusicVideoShots.mockImplementation(async (_id, body) => (body.dryRun ? planFor(body)
    : { ...planFor(body), dryRun: false, results: [{ sceneId: 's0', ok: true, method: body.method, takeId: 'up' }] }));
  const project = { id: 'p1', videoSettings: { backend: 'fal' }, scenes: [approve(shot(0)), shot(1), shot(2, 'final')] };
  render(<FinalUpgradePanel project={project} shotName={shotName} onApprove={vi.fn()} />);
  expect(screen.getByTestId('final-tier-counts').textContent).toContain('2 draft · 1 approved · 1 final');
  openPanel();

  expect(screen.getByTestId('final-upgrade-run').disabled).toBe(true);
  expect(screen.getByTestId('final-upgrade-run').textContent).toContain('pricing…');
  await waitFor(() => expect(screen.getByTestId('final-upgrade-run').textContent).toBe('Upgrade approved (1) · no provider cost'));
  expect(upgradeMusicVideoShots).toHaveBeenLastCalledWith('p1', { method: 'upscale', upscaleMethod: 'lanczos', dryRun: true }, { silent: true });

  fireEvent.click(screen.getByLabelText(/Re-render at final/));
  await waitFor(() => expect(screen.getByTestId('final-upgrade-run').textContent).toBe('Upgrade approved (1) · $1.50'));
  expect(upgradeMusicVideoShots).toHaveBeenLastCalledWith('p1', { method: 'rerender', dryRun: true }, { silent: true });
  expect(screen.getByTestId('final-upgrade-plan').textContent).toContain('Shot 0: re-render at 1080p · $1.50');

  fireEvent.click(screen.getByTestId('final-upgrade-run'));
  await screen.findByTestId('final-upgrade-results');
  expect(upgradeMusicVideoShots).toHaveBeenLastCalledWith('p1', { method: 'rerender' }, { silent: true });
  expect(screen.getByTestId('final-upgrade-results').textContent).toContain('Shot 0: final render queued; it lands beside the draft');
});

it('bulk-approves the unticked drafts and clears the ticked ones, never touching a final clip', async () => {
  upgradeMusicVideoShots.mockResolvedValue(planFor({ method: 'upscale' }));
  const onApprove = vi.fn().mockResolvedValue(true);
  const project = { id: 'p1', videoSettings: {}, scenes: [approve(shot(0)), shot(1), shot(2, 'final')] };
  render(<FinalUpgradePanel project={project} shotName={shotName} onApprove={onApprove} />);
  openPanel();
  await screen.findByTestId('final-upgrade-plan');
  expect(screen.queryByLabelText('Shot 2')).toBeNull();
  expect(screen.getByLabelText('Shot 0').checked).toBe(true);
  expect(screen.getByLabelText('Shot 1').checked).toBe(false);

  fireEvent.click(screen.getByRole('button', { name: 'Approve all drafts (2)' }));
  expect(onApprove).toHaveBeenLastCalledWith(['s1'], true);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Clear approvals' }).closest('fieldset').disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Clear approvals' }));
  expect(onApprove).toHaveBeenLastCalledWith(['s0'], false);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Clear approvals' }).closest('fieldset').disabled).toBe(false));
});

it('stays hidden until a shot has a clip, and asks for a tick before pricing anything', () => {
  const { rerender } = render(<FinalUpgradePanel project={{ id: 'p1', scenes: [{ sceneId: 's0' }] }} shotName={shotName} onApprove={vi.fn()} />);
  expect(screen.queryByTestId('final-upgrade-panel')).toBeNull();
  rerender(<FinalUpgradePanel project={{ id: 'p1', scenes: [shot(0)] }} shotName={shotName} onApprove={vi.fn()} />);
  openPanel();
  expect(screen.getByText('Tick at least one draft shot to upgrade it.')).toBeTruthy();
  expect(screen.queryByTestId('final-upgrade-run')).toBeNull();
  expect(upgradeMusicVideoShots).not.toHaveBeenCalled();
});

it('drops the plan when an approval stops matching, so a stale price is never offered', async () => {
  upgradeMusicVideoShots.mockResolvedValue(planFor({ method: 'upscale' }));
  const approved = approve(shot(0));
  const { rerender } = render(<FinalUpgradePanel project={{ id: 'p1', scenes: [approved] }} shotName={shotName} onApprove={vi.fn()} />);
  openPanel();
  await screen.findByTestId('final-upgrade-plan');
  // The prompt changed after approval: the tick no longer counts and the plan goes with it.
  rerender(<FinalUpgradePanel project={{ id: 'p1', scenes: [{ ...approved, prompt: 'a new prompt' }] }} shotName={shotName} onApprove={vi.fn()} />);
  expect(screen.queryByTestId('final-upgrade-plan')).toBeNull();
  expect(screen.queryByTestId('final-upgrade-run')).toBeNull();
});

// #19985: an upscale upgrade can run the opt-in local Real-ESRGAN lane; the dry run reports its
// readiness, offers the install in place, and a run reports queued shots rather than selected ones.
it('plans and queues a Real-ESRGAN upscale, offering the install while it is missing', async () => {
  let installed = false;
  upgradeMusicVideoShots.mockImplementation(async (_id, body) => {
    const ready = body.upscaleMethod !== 'realesrgan' || installed;
    const plan = {
      dryRun: true, method: 'upscale', upscaleMethod: body.upscaleMethod, totalCostUsd: 0,
      upscalerReason: ready ? null : 'Real-ESRGAN (ncnn Vulkan) is not installed on this machine.',
      shots: [ready
        ? { sceneId: 's0', status: 'ready', method: 'upscale', upscaleMethod: body.upscaleMethod, costUsd: 0 }
        : { sceneId: 's0', status: 'upscaler-not-ready', upscaleMethod: body.upscaleMethod }],
    };
    return body.dryRun ? plan : { ...plan, dryRun: false, results: [{ sceneId: 's0', ok: true, method: 'upscale', jobId: 'job-up', queued: true }] };
  });
  const project = { id: 'p1', videoSettings: {}, scenes: [approve(shot(0))] };
  const view = render(<FinalUpgradePanel project={project} shotName={shotName} onApprove={vi.fn()} />);
  openPanel();
  await screen.findByTestId('final-upgrade-plan');
  fireEvent.change(screen.getByLabelText('Upscaler'), { target: { value: 'realesrgan' } });
  await waitFor(() => expect(upgradeMusicVideoShots).toHaveBeenLastCalledWith('p1', { method: 'upscale', upscaleMethod: 'realesrgan', dryRun: true }, { silent: true }));
  expect(await screen.findByText(/not installed on this machine/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Install Real-ESRGAN' })).toBeTruthy();
  expect(screen.getByTestId('final-upgrade-plan').textContent).toContain('Shot 0: the upscaler is not installed');
  expect(screen.getByTestId('final-upgrade-run').disabled).toBe(true);

  installed = true;
  view.rerender(<FinalUpgradePanel project={{ ...project, videoSettings: { refreshed: true } }} shotName={shotName} onApprove={vi.fn()} />);
  await waitFor(() => expect(screen.getByTestId('final-upgrade-plan').textContent).toContain('Shot 0: upscale 2x with Real-ESRGAN'));
  fireEvent.click(screen.getByTestId('final-upgrade-run'));
  await screen.findByTestId('final-upgrade-results');
  expect(upgradeMusicVideoShots).toHaveBeenLastCalledWith('p1', { method: 'upscale', upscaleMethod: 'realesrgan' }, { silent: true });
  expect(screen.getByTestId('final-upgrade-results').textContent).toContain('Shot 0: Real-ESRGAN upscale queued; the final take is selected when it lands');
});

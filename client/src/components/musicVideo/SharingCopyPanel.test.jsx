import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SharingCopyPanel from './SharingCopyPanel.jsx';

const { api, sse } = vi.hoisted(() => ({ api: {
  get: vi.fn(), prepare: vi.fn(), cancel: vi.fn(),
}, sse: { latest: null, latestUrl: null, closed: false, isOpen: true } }));
vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoSharingCopy: api.get, prepareMusicVideoSharingCopy: api.prepare,
  musicVideoSharingCopyDownloadUrl: id => `/api/music-video/${id}/sharing-copy/download`,
}));
vi.mock('../../services/apiMediaJobs.js', () => ({ cancelMediaJob: api.cancel }));
vi.mock('../../hooks/useSseProgress.js', () => ({ useSseProgress: () => sse, isTerminalSseFrame: frame => ['complete', 'error', 'canceled'].includes(frame?.type) }));
vi.mock('../ui/Toast', () => ({ default: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(sse, { latest: null, latestUrl: null, closed: false, isOpen: true });
  api.get.mockResolvedValue({ copy: null, jobId: null });
  api.prepare.mockResolvedValue({ jobId: 'job-example' });
  api.cancel.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

it('prepares once, reports the encode stage, and exposes a private download with measured size', async () => {
  const view = render(<SharingCopyPanel projectId="mv-example" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prepare sharing copy' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Prepare sharing copy' }));
  await screen.findByRole('button', { name: 'Creating sharing copy…' });
  expect(api.prepare).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Creating sharing copy…' })).toBeDisabled();
  sse.latest = { type: 'status', message: 'Encoding sharing copy (pass 2 of 2)' };
  view.rerender(<SharingCopyPanel projectId="mv-example" />);
  await screen.findByText('Encoding sharing copy (pass 2 of 2)');
  sse.latest = { type: 'complete', result: { width: 1280, height: 720, fps: 60, bytes: 90_000_000 } };
  view.rerender(<SharingCopyPanel projectId="mv-example" />);
  const download = await screen.findByRole('link', { name: 'Download sharing copy' });
  expect(download).toHaveAttribute('href', '/api/music-video/mv-example/sharing-copy/download');
  expect(screen.getByText(/1,280 × 720.*90,000,000 bytes/)).toBeInTheDocument();
});

it('reattaches after reload, keeps cancellation pending until settlement, and shows cancellation refusal', async () => {
  api.get.mockResolvedValue({ copy: null, jobId: 'job-recovered' });
  api.cancel.mockRejectedValueOnce(new Error('Job is already finishing'));
  const view = render(<SharingCopyPanel projectId="mv-example" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel export' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('already finishing');
  expect(api.cancel).toHaveBeenCalledWith('job-recovered', { silent: true });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel export' }));
  expect(await screen.findByRole('button', { name: 'Cancelling…' })).toBeDisabled();
  expect(screen.queryByRole('link', { name: 'Download sharing copy' })).not.toBeInTheDocument();
  sse.latest = { type: 'canceled' };
  view.rerender(<SharingCopyPanel projectId="mv-example" />);
  expect(await screen.findByRole('button', { name: 'Prepare sharing copy' })).toBeEnabled();
});

it('isolates a delayed lookup when navigating to another final render', async () => {
  let resolveOld;
  api.get.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
  const view = render(<SharingCopyPanel key="old" projectId="mv-old" />);
  view.rerender(<SharingCopyPanel key="new" projectId="mv-new" />);
  await screen.findByRole('button', { name: 'Prepare sharing copy' });
  resolveOld({ copy: { bytes: 10, width: 10, height: 10, fps: 10 }, jobId: 'old-job' });
  await waitFor(() => expect(screen.queryByRole('link', { name: 'Download sharing copy' })).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: 'Cancel export' })).not.toBeInTheDocument();
});

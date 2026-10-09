import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

vi.mock('../../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn(), emit: vi.fn() } }));
vi.mock('../../services/apiCodeAnimation', () => ({ getCodeAnimationAcceptance: vi.fn(), acceptCodeAnimationOutput: vi.fn() }));
import * as api from '../../services/apiCodeAnimation';
import ProductionAcceptance from './ProductionAcceptance';

const dim = (status, extra = {}) => ({ status, verified: [], unverified: [], findings: [], ...extra });
const evidence = { technical: dim('verified', { verified: ['frame-size'] }), visual: dim('partial', { verified: ['visual-motion'], unverified: [{ dimension: 'semantic-visual', reason: 'No reviewer ran.' }] }), temporal: dim('verified', { verified: ['timing'] }), sound: dim('unverified', { unverified: [{ dimension: 'hearing', reason: 'No listening review ran.' }] }) };
const run = (id, overrides = {}) => ({
  runId: id, status: 'completed', createdAt: new Date().toISOString(), accepted: false, acceptable: true,
  settings: { requested: { providerId: 'example', model: 'example-model', effort: 'high' }, effective: { providerId: 'example', model: 'example-model', effort: 'high' }, renderer: null },
  budgets: { iterations: 8, tokens: 1000, renderSeconds: 60 }, spend: { repairs: 2, tokens: 300, renderMs: 4000, elapsedMs: 9000, diskBytes: 2048 },
  verdict: { status: 'pass' }, reviewer: null, evidence, findings: [{ kind: 'event-without-change', severity: 'warning', detail: 'Quiet beat.', atSeconds: 1.5 }],
  repairs: [], frames: [], pilots: [], output: { path: `/data/videos/${id}.mp4` }, error: null, ...overrides,
});
const frozen = { runId: 'aaaaaaaa-1', videoId: 'video-1', revisionId: 'rev-1', path: '/data/videos/a.mp4', acceptedAt: new Date().toISOString(), sourceHash: 's'.repeat(64), renderHash: 'r'.repeat(64), audioHash: null, evidence, fresh: true, stale: [] };
const Location = () => <p data-testid="search">{useLocation().search}</p>;
const renderIt = props => render(<MemoryRouter initialEntries={['/p']}><Routes><Route path="/p" element={<><ProductionAcceptance projectId="p1" onProject={vi.fn()} onDownloadSource={vi.fn()} {...props} /><Location /></>} /></Routes></MemoryRouter>);
beforeEach(() => vi.resetAllMocks());

describe('Production acceptance', () => {
  it('keeps accepted playback beside a stale warning and a failed newer run', async () => {
    api.getCodeAnimationAcceptance.mockResolvedValue({
      accepted: { ...frozen, fresh: false, stale: [{ dimension: 'source', reason: 'The source files changed after it was accepted.' }] },
      runs: [run('bbbbbbbb-2', { status: 'failed', acceptable: false, verdict: { status: 'fail' } }), run('aaaaaaaa-1', { accepted: true })],
    });
    renderIt();
    expect(await screen.findByLabelText('Accepted final video')).toHaveAttribute('src', '/data/videos/a.mp4');
    expect(screen.getByRole('alert')).toHaveTextContent('The source files changed after it was accepted.');
    expect(screen.getByText(/Run bbbbbbbb · failed · verdict fail/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept output of run bbbbbbbb/ })).not.toBeInTheDocument();
    expect(screen.getAllByText(/Unverified: No listening review ran\./).length).toBeGreaterThan(0);
  });

  it('compares two runs from the URL, showing effective route and budgets, and promotes one explicitly', async () => {
    const user = userEvent.setup();
    const low = run('cccccccc-3', { settings: { requested: { providerId: 'example', model: 'example-model', effort: 'low' }, effective: { providerId: 'example', model: 'example-model', effort: 'low' }, renderer: null }, spend: { repairs: 5, tokens: 900, renderMs: 4000, elapsedMs: 9000, diskBytes: 2048 } });
    api.getCodeAnimationAcceptance.mockResolvedValue({ accepted: null, runs: [run('dddddddd-4'), low] });
    api.acceptCodeAnimationOutput.mockResolvedValue({ id: 'p1', acceptedOutput: { ...frozen, runId: 'cccccccc-3' } });
    renderIt();
    await user.click(await screen.findByLabelText(/Run dddddddd/));
    await user.click(screen.getByLabelText(/Run cccccccc/));
    expect(new URLSearchParams(screen.getByTestId('search').textContent).get('compare')).toBe('dddddddd-4,cccccccc-3');
    const columns = screen.getAllByRole('article');
    expect(columns).toHaveLength(2);
    expect(within(columns[0]).getByText(/2 repairs · 300 tokens/)).toBeInTheDocument();
    expect(within(columns[1]).getByText(/5 repairs · 900 tokens/)).toBeInTheDocument();
    // Model effort is labelled as an authoring budget, never as render samples or a repair count.
    expect(within(columns[1]).getByText(/low \(authoring reasoning budget\)/)).toBeInTheDocument();
    expect(within(columns[0]).getByLabelText('Timestamped findings')).toHaveTextContent('1.5s');
    await user.click(screen.getByRole('button', { name: /Accept output of run cccccccc/ }));
    expect(api.acceptCodeAnimationOutput).toHaveBeenCalledWith('p1', 'cccccccc-3', { silent: true });
  });
  it('applies committed acceptance immediately and keeps playback plus a sync retry when the refresh fails', async () => {
    const user = userEvent.setup();
    const onProject = vi.fn();
    api.getCodeAnimationAcceptance.mockResolvedValueOnce({ accepted: null, runs: [run(frozen.runId)] })
      .mockRejectedValueOnce(new Error('Synthetic read failure'));
    const project = { id: 'p1', acceptedOutput: frozen, acceptanceProjection: { decisionId: 'decision-1', status: 'pending' } };
    api.acceptCodeAnimationOutput.mockResolvedValue(project);
    renderIt({ onProject });
    await user.click(await screen.findByRole('button', { name: /Accept output of run/ }));
    expect(onProject).toHaveBeenCalledWith(project);
    expect(await screen.findByLabelText('Accepted final video')).toHaveAttribute('src', frozen.path);
    expect(screen.getByRole('status')).toHaveTextContent('Acceptance saved. Media History synchronization is pending');
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic read failure');
    expect(screen.queryByText(/This video is in Media History/)).not.toBeInTheDocument();
    api.getCodeAnimationAcceptance.mockResolvedValue({ accepted: frozen, runs: [run(frozen.runId, { accepted: true })], acceptanceProjection: { decisionId: 'decision-1', status: 'synced' } });
    await user.click(screen.getByRole('button', { name: 'Retry Media History sync' }));
    expect(await screen.findByText(/This video is in Media History/)).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(api.acceptCodeAnimationOutput).toHaveBeenCalledTimes(1);
  });

});
